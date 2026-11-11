/**
 * File-based persistence for one Yjs document.
 *
 *   <dir>/<kind>.snapshot   full state (`Y.encodeStateAsUpdate`), replaced atomically
 *   <dir>/<kind>.log        append-only incremental updates received since that snapshot
 *
 * Log record:  u32be payload length | u32be CRC-32 of payload | payload (one Yjs update)
 *
 * Loading applies the snapshot and then replays the log. Updates are appended in small batches
 * as they arrive; once the log grows past ~1 MiB (and whenever the store is closed) the document
 * is compacted: a fresh snapshot is written and the log is emptied.
 *
 * Yjs updates are idempotent and commutative, which keeps the crash story simple: replaying an
 * update that is already contained in the snapshot is harmless, so "new snapshot + old log" (a
 * crash between the two steps of a compaction) loads to exactly the same document.
 */
import { open, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import type { DocKind } from '@tandem/core';
import { atomicWrite, crc32, readFileIfExists } from './util';

const RECORD_HEADER_BYTES = 8;
/** Updates are written at most this long after they were applied (the brief allows up to 200 ms). */
const FLUSH_DELAY_MS = 100;
/** Back-off before retrying after a failed write (disk full, I/O error). */
const RETRY_DELAY_MS = 1000;
/** Compact once the log is larger than this. */
export const COMPACT_LOG_BYTES = 1024 * 1024;

/** Frame updates as log records. */
export function encodeLogRecords(updates: readonly Uint8Array[]): Buffer {
  let total = 0;
  for (const update of updates) total += RECORD_HEADER_BYTES + update.byteLength;
  const out = Buffer.allocUnsafe(total);
  let pos = 0;
  for (const update of updates) {
    out.writeUInt32BE(update.byteLength, pos);
    out.writeUInt32BE(crc32(update), pos + 4);
    out.set(update, pos + RECORD_HEADER_BYTES);
    pos += RECORD_HEADER_BYTES + update.byteLength;
  }
  return out;
}

/**
 * Walk the records of a log. Stops silently at the first record that is incomplete or fails its
 * checksum: that is what a crash in the middle of an append leaves behind, and since the framing
 * after a damaged record cannot be trusted, nothing beyond it is read.
 * `end` is the offset just past the yielded record, i.e. the length of the valid prefix so far.
 */
export function* readLogRecords(log: Uint8Array): Generator<{ update: Uint8Array; end: number }> {
  const view = new DataView(log.buffer, log.byteOffset, log.byteLength);
  let pos = 0;
  while (pos + RECORD_HEADER_BYTES <= log.byteLength) {
    const length = view.getUint32(pos);
    const end = pos + RECORD_HEADER_BYTES + length;
    if (length === 0 || end > log.byteLength) return;
    // A plain Uint8Array view (not a Buffer, whose slice() semantics differ) is what Yjs expects.
    const update = new Uint8Array(log.buffer, log.byteOffset + pos + RECORD_HEADER_BYTES, length);
    if (crc32(update) !== view.getUint32(pos + 4)) return;
    yield { update, end };
    pos = end;
  }
}

export class DocStore {
  /** Updates applied to the document but not yet written to the log. */
  private pending: Uint8Array[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** All disk work runs through this chain, one operation at a time. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly doc: Y.Doc,
    private readonly snapshotPath: string,
    private readonly log: FileHandle,
    /** Bytes of valid records currently in the log file. */
    private logBytes: number,
  ) {}

  /**
   * Load the persisted state into `doc` (which should be empty) and return a store that will
   * persist further updates handed to `append()`.
   *
   * A snapshot that cannot be decoded makes this throw: starting from an empty document would
   * later overwrite the damaged file with that emptiness, turning a recoverable problem into
   * data loss. A damaged log *tail*, on the other hand, is expected after a crash and is cut off.
   */
  static async open(dir: string, kind: DocKind, doc: Y.Doc): Promise<DocStore> {
    const snapshotPath = join(dir, `${kind}.snapshot`);
    const logPath = join(dir, `${kind}.log`);

    const snapshot = await readFileIfExists(snapshotPath);
    if (snapshot)
      Y.applyUpdate(doc, new Uint8Array(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength));

    let validBytes = 0;
    const log = await readFileIfExists(logPath);
    if (log) {
      for (const { update, end } of readLogRecords(log)) {
        try {
          Y.applyUpdate(doc, update);
        } catch {
          break; // checksum matched but Yjs rejects it: treat like any other damaged record
        }
        validBytes = end;
      }
      if (validBytes < log.byteLength) {
        console.warn(
          `[tandem] ${logPath}: dropping ${log.byteLength - validBytes} trailing bytes that do not form a complete record`,
        );
        // New records must follow the last good one, otherwise the next load would misread them.
        await truncate(logPath, validBytes);
      }
    }

    // O_APPEND: every write lands at the current end of the file, also right after a truncate.
    const handle = await open(logPath, 'a');
    return new DocStore(doc, snapshotPath, handle, validBytes);
  }

  /** Queue an update (as emitted by the document's `update` event) for writing. */
  append(update: Uint8Array): void {
    if (this.closed) return;
    this.pending.push(update);
    this.schedule(FLUSH_DELAY_MS);
  }

  /** Write everything queued so far. Resolves once it is on disk. */
  flush(): Promise<void> {
    if (this.closed) return this.chain;
    return this.enqueue(() => this.writePending());
  }

  /**
   * Final persist: fold everything into a fresh snapshot, empty the log, release the file handle.
   * No update handed to `append()` before this call is lost.
   */
  async close(): Promise<void> {
    if (this.closed) return this.chain;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.enqueue(async () => {
      try {
        if (this.pending.length > 0 || this.logBytes > 0) {
          try {
            await this.compact();
          } catch (err) {
            // The snapshot could not be written; the log alone still preserves everything.
            console.error(`[tandem] compaction of ${this.snapshotPath} failed, keeping the log:`, err);
            await this.appendPending();
          }
        }
      } finally {
        await this.log.close();
      }
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.chain.then(op);
    // Keep the chain usable after a failure; the caller of `enqueue` still sees the rejection.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((err: unknown) => {
        console.error(`[tandem] could not persist updates for ${this.snapshotPath}:`, err);
        // The updates are still queued (see appendPending); try again shortly.
        this.schedule(RETRY_DELAY_MS);
      });
    }, delayMs);
  }

  private async writePending(): Promise<void> {
    await this.appendPending();
    if (this.logBytes > COMPACT_LOG_BYTES) await this.compact();
  }

  /** Append all queued updates to the log as one write + fdatasync (group commit). */
  private async appendPending(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const records = encodeLogRecords(batch);
    try {
      await this.log.appendFile(records);
      await this.log.datasync();
      this.logBytes += records.byteLength;
    } catch (err) {
      // Put the batch back for a retry, and cut off whatever part of it reached the file so the
      // retry does not end up behind a torn record.
      this.pending = batch.concat(this.pending);
      await this.log.truncate(this.logBytes).catch(() => undefined);
      throw err;
    }
  }

  /** Write a full snapshot, then empty the log. */
  private async compact(): Promise<void> {
    // Taken synchronously, so the snapshot contains every update applied so far — including the
    // ones still queued, which therefore no longer need to reach the log. Updates that arrive
    // while we are writing are queued as usual and appended after the truncate.
    const covered = this.pending;
    this.pending = [];
    const state = Y.encodeStateAsUpdate(this.doc);
    try {
      await atomicWrite(this.snapshotPath, state);
    } catch (err) {
      this.pending = covered.concat(this.pending);
      throw err;
    }
    // From here on a failure costs nothing but disk space: the snapshot already holds everything.
    await this.log.truncate(0);
    this.logBytes = 0;
  }
}
