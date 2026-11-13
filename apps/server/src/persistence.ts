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
import { RECOUNT_AFTER_STRUCTS, measureUpdate, weigh, weightOf } from './updateSize';
import { atomicWrite, crc32, fileSize, readFileIfExists } from './util';

const RECORD_HEADER_BYTES = 8;
/** Updates are written at most this long after they were applied (the brief allows up to 200 ms). */
const FLUSH_DELAY_MS = 100;
/** Back-off before retrying after a failed write (disk full, I/O error). */
const RETRY_DELAY_MS = 1000;
/** Compact once the log is larger than this. */
export const COMPACT_LOG_BYTES = 1024 * 1024;

/** The files of a document hold more than the server is set up to load. */
export class DocumentTooLargeError extends Error {
  constructor(paths: string[], size: number, limit: number, unit: 'bytes' | 'structs') {
    const hold = paths.length > 1 ? 'hold' : 'holds';
    super(`${paths.join(' and ')} ${hold} ${size} ${unit}, and at most ${limit} are loaded`);
    this.name = 'DocumentTooLargeError';
  }
}

export interface DocStoreLimits {
  /**
   * Largest snapshot that is loaded. The log may hold this much again plus one compaction's
   * worth: it collects every update taken since the snapshot, also ones that replaced each other.
   */
  maxBytes?: number;
  /**
   * Most the snapshot and the log may hold together: what the caller could hold of one document
   * if it held nothing else. Files beyond it will not fit however long the caller waits.
   */
  maxStoredBytes?: number;
  /** Most the stored document may weigh in structs (see updateSize.ts): they are what costs memory. */
  maxStructs?: number;
  /**
   * Called with the size of the stored files before any of them is read, and with the weight of
   * the snapshot and of each update in the log right before it is applied (now and then with a
   * negative amount, when a recount finds the document lighter than the sum of its updates).
   * Throwing stops the load there, which is how a caller keeps several loads within one budget.
   */
  reserveBytes?: (bytes: number) => void;
  reserveStructs?: (structs: number) => void;
}

/** The two files of a document, and how much each holds. */
export interface StoredDoc {
  snapshotPath: string;
  logPath: string;
  snapshotBytes: number;
  logBytes: number;
}

/** What is stored of a document, by the size of its files: nothing of them is read. */
export async function storedDoc(dir: string, kind: DocKind): Promise<StoredDoc> {
  const snapshotPath = join(dir, `${kind}.snapshot`);
  const logPath = join(dir, `${kind}.log`);
  return {
    snapshotPath,
    logPath,
    snapshotBytes: (await fileSize(snapshotPath)) ?? 0,
    logBytes: (await fileSize(logPath)) ?? 0,
  };
}

/** How large a log `DocStore.open` reads next to a snapshot of at most `maxBytes`. */
const maxLogBytesFor = (maxBytes: number): number => maxBytes + COMPACT_LOG_BYTES;

/**
 * Why files of these sizes are more than `limits` let `DocStore.open` read, or `null` when their
 * size is no reason to refuse them. Their weight in structs only shows when they are read.
 */
export function tooLargeToOpen(stored: StoredDoc, limits: DocStoreLimits): DocumentTooLargeError | null {
  const { snapshotPath, logPath, snapshotBytes, logBytes } = stored;
  const maxBytes = limits.maxBytes ?? Infinity;
  const maxLogBytes = maxLogBytesFor(maxBytes);
  const maxStoredBytes = limits.maxStoredBytes ?? Infinity;
  if (snapshotBytes > maxBytes) {
    return new DocumentTooLargeError([snapshotPath], snapshotBytes, maxBytes, 'bytes');
  }
  if (logBytes > maxLogBytes) {
    return new DocumentTooLargeError([logPath], logBytes, maxLogBytes, 'bytes');
  }
  if (snapshotBytes + logBytes > maxStoredBytes) {
    return new DocumentTooLargeError(
      [snapshotPath, logPath],
      snapshotBytes + logBytes,
      maxStoredBytes,
      'bytes',
    );
  }
  return null;
}

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
  /** What `pending` will take up in the log. */
  private pendingBytes = 0;
  /** Told the exact encoded size of the document each time a snapshot of it is taken. */
  onSnapshot: ((bytes: number) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** All disk work runs through this chain, one operation at a time. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly doc: Y.Doc,
    private readonly snapshotPath: string,
    private readonly log: FileHandle,
    /** Size of the snapshot file. */
    private snapshotBytes: number,
    /** Bytes of valid records currently in the log file. */
    private logBytes: number,
    /**
     * The log is never grown past the first, nor the two files together past the second, so that
     * `open()` accepts whatever a crash leaves behind.
     */
    private readonly maxLogBytes: number,
    private readonly maxStoredBytes: number,
  ) {}

  /**
   * Load the persisted state into `doc` (which should be empty) and return a store that will
   * persist further updates handed to `append()`.
   *
   * A snapshot that cannot be decoded makes this throw: starting from an empty document would
   * later overwrite the damaged file with that emptiness, turning a recoverable problem into
   * data loss. A damaged log *tail*, on the other hand, is expected after a crash and is cut off.
   *
   * Files larger than `limits` allow are not read, and loading stops before the update that
   * would make the document heavier than they allow (DocumentTooLargeError; `doc` is then left
   * half loaded and must be discarded). A document costs many times its size in memory, and one
   * that is too large to hold must not take the documents of every other project down with it.
   */
  static async open(dir: string, kind: DocKind, doc: Y.Doc, limits: DocStoreLimits = {}): Promise<DocStore> {
    const stored = await storedDoc(dir, kind);
    const { snapshotPath, logPath, snapshotBytes } = stored;
    const tooLarge = tooLargeToOpen(stored, limits);
    if (tooLarge) throw tooLarge;
    const maxLogBytes = maxLogBytesFor(limits.maxBytes ?? Infinity);
    const maxStoredBytes = limits.maxStoredBytes ?? Infinity;
    limits.reserveBytes?.(snapshotBytes + stored.logBytes);

    const snapshot = await readFileIfExists(snapshotPath);
    const log = await readFileIfExists(logPath);

    // Nothing is awaited from here until the document is complete, so whoever keeps count of
    // the documents in memory sees every load either not at all or in full.
    const maxStructs = limits.maxStructs ?? Infinity;
    let structs = 0;
    let sinceCount = 0;
    /** Make sure there is room for an update before it is applied. */
    const weighIn = (update: Uint8Array, path: string): void => {
      let weight = 0;
      try {
        weight = weightOf(measureUpdate(update, doc));
      } catch {
        // Not something the walk can follow. Whether it is an update at all is for Yjs to say.
      }
      if (sinceCount + weight > RECOUNT_AFTER_STRUCTS) {
        // A log of thousands of edits to one field weighs thousands of structs and leaves a few.
        const held = weigh(doc);
        limits.reserveStructs?.(held - structs);
        structs = held;
        sinceCount = 0;
      }
      if (structs + weight > maxStructs) {
        throw new DocumentTooLargeError([path], structs + weight, maxStructs, 'structs');
      }
      limits.reserveStructs?.(weight);
      structs += weight;
      sinceCount += weight;
    };

    if (snapshot) {
      const state = new Uint8Array(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
      weighIn(state, snapshotPath);
      Y.applyUpdate(doc, state);
    }

    let validBytes = 0;
    if (log) {
      for (const { update, end } of readLogRecords(log)) {
        weighIn(update, logPath);
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
    return new DocStore(doc, snapshotPath, handle, snapshotBytes, validBytes, maxLogBytes, maxStoredBytes);
  }

  /** Queue an update (as emitted by the document's `update` event) for writing. */
  append(update: Uint8Array): void {
    if (this.closed) return;
    this.pending.push(update);
    this.pendingBytes += RECORD_HEADER_BYTES + update.byteLength;
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
    // A batch the log has no room for goes straight into a snapshot, which covers it just as well.
    const roomInLog = Math.min(this.maxLogBytes, this.maxStoredBytes - this.snapshotBytes);
    if (this.logBytes + this.pendingBytes > roomInLog) {
      await this.compact();
      return;
    }
    await this.appendPending();
    if (this.logBytes > COMPACT_LOG_BYTES) await this.compact();
  }

  /** Append all queued updates to the log as one write + fdatasync (group commit). */
  private async appendPending(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    const batchBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const records = encodeLogRecords(batch);
    try {
      await this.log.appendFile(records);
      await this.log.datasync();
      this.logBytes += records.byteLength;
    } catch (err) {
      // Put the batch back for a retry, and cut off whatever part of it reached the file so the
      // retry does not end up behind a torn record.
      this.pending = batch.concat(this.pending);
      this.pendingBytes += batchBytes;
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
    const coveredBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const state = Y.encodeStateAsUpdate(this.doc);
    this.onSnapshot?.(state.byteLength);
    try {
      await atomicWrite(this.snapshotPath, state);
    } catch (err) {
      this.pending = covered.concat(this.pending);
      this.pendingBytes += coveredBytes;
      throw err;
    }
    this.snapshotBytes = state.byteLength;
    // From here on a failure costs nothing but disk space: the snapshot already holds everything.
    await this.log.truncate(0);
    this.logBytes = 0;
  }
}
