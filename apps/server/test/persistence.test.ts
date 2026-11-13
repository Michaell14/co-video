/**
 * DocStore against the failure modes a graceful shutdown never exercises: the process dying with
 * updates only in the log, and a log whose last record was cut short.
 */
import { appendFile, mkdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  COMPACT_LOG_BYTES,
  DocStore,
  DocumentTooLargeError,
  encodeLogRecords,
  readLogRecords,
} from '../src/persistence';
import { crc32, crc32Fallback } from '../src/util';
import { removeTempDirs, tempDir } from './helpers';

afterAll(removeTempDirs);

/** A document wired to a store the way a room does it. */
async function openDoc(dir: string): Promise<{ doc: Y.Doc; store: DocStore }> {
  const doc = new Y.Doc();
  const store = await DocStore.open(dir, 'project', doc);
  doc.on('update', (update: Uint8Array) => store.append(update));
  return { doc, store };
}

const sizeOf = async (path: string): Promise<number> => (await stat(path)).size;

describe('log records', () => {
  it('round-trips updates and stops at damage', () => {
    const updates = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4]), new Uint8Array(1000).fill(7)];
    const log = encodeLogRecords(updates);
    expect([...readLogRecords(log)].map((r) => r.update)).toEqual(updates);
    expect([...readLogRecords(log)].at(-1)?.end).toBe(log.byteLength);

    // Cut anywhere inside the last record: the first two survive, the rest is ignored.
    for (const cut of [1, 5, 500, 1007]) {
      const records = [...readLogRecords(log.subarray(0, log.byteLength - cut))];
      expect(records.map((r) => r.update)).toEqual(updates.slice(0, 2));
    }

    // A flipped bit fails the checksum; nothing at or after that record is trusted.
    const corrupt = Buffer.from(log);
    corrupt[8] ^= 0xff; // first payload byte of the first record
    expect([...readLogRecords(corrupt)]).toEqual([]);

    // Zero-filled tail (preallocated blocks after a crash) is not a record.
    expect([...readLogRecords(Buffer.concat([log, Buffer.alloc(64)]))]).toHaveLength(3);
  });

  it('computes standard CRC-32 with or without zlib.crc32', () => {
    const check = Buffer.from('123456789');
    expect(crc32Fallback(check)).toBe(0xcbf43926);
    expect(crc32(check)).toBe(0xcbf43926);
    expect(crc32Fallback(new Uint8Array(0))).toBe(0);
  });
});

describe('DocStore', () => {
  it('recovers from the log alone when the process dies without a clean close', async () => {
    const dir = await tempDir();
    const first = await openDoc(dir);
    first.doc.getMap('m').set('a', 1);
    first.doc.getText('t').insert(0, 'hello');
    await first.store.flush();
    first.doc.getMap('m').set('b', 2);
    await first.store.flush();

    // No close(): everything lives in the log, there is no snapshot yet.
    expect(await sizeOf(join(dir, 'project.log'))).toBeGreaterThan(0);
    await expect(stat(join(dir, 'project.snapshot'))).rejects.toThrow();

    const second = await openDoc(dir);
    expect(second.doc.getMap('m').toJSON()).toEqual({ a: 1, b: 2 });
    expect(second.doc.getText('t').toString()).toBe('hello');
    await second.store.close();
    await first.store.close();
  });

  it('writes updates within the debounce window without an explicit flush', async () => {
    const dir = await tempDir();
    const { doc, store } = await openDoc(dir);
    doc.getMap('m').set('k', 'v');
    expect(await sizeOf(join(dir, 'project.log'))).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await sizeOf(join(dir, 'project.log'))).toBeGreaterThan(0);
    await store.close();
  });

  it('tolerates a truncated final record and keeps appending cleanly after it', async () => {
    const dir = await tempDir();
    const logPath = join(dir, 'project.log');
    const first = await openDoc(dir);
    first.doc.getMap('m').set('kept', true);
    await first.store.flush();
    const goodBytes = await sizeOf(logPath);

    // A crash halfway through an append: a record header promising more bytes than follow.
    const lost = new Y.Doc();
    lost.getMap('m').set('lost', true);
    const torn = encodeLogRecords([Y.encodeStateAsUpdate(lost)]);
    await appendFile(logPath, torn.subarray(0, torn.byteLength - 3));

    const second = await openDoc(dir);
    expect(second.doc.getMap('m').toJSON()).toEqual({ kept: true });
    // The damaged tail is cut off so that new records are not appended behind garbage.
    expect(await sizeOf(logPath)).toBe(goodBytes);
    second.doc.getMap('m').set('after', 1);
    await second.store.flush();

    // Crash again; a third process must see both the old and the new update.
    const third = await openDoc(dir);
    expect(third.doc.getMap('m').toJSON()).toEqual({ kept: true, after: 1 });
    await third.store.close();
    await second.store.close();
    await first.store.close();
  });

  it('compacts into a snapshot on close and loads snapshot + later log', async () => {
    const dir = await tempDir();
    const first = await openDoc(dir);
    first.doc.getMap('m').set('a', 1);
    await first.store.close();
    expect(await sizeOf(join(dir, 'project.log'))).toBe(0);
    const snapshot = await readFile(join(dir, 'project.snapshot'));
    const fromSnapshot = new Y.Doc();
    Y.applyUpdate(fromSnapshot, snapshot);
    expect(fromSnapshot.getMap('m').toJSON()).toEqual({ a: 1 });

    const second = await openDoc(dir);
    second.doc.getMap('m').set('b', 2);
    await second.store.flush(); // snapshot has a, log has b

    const third = await openDoc(dir);
    expect(third.doc.getMap('m').toJSON()).toEqual({ a: 1, b: 2 });
    await third.store.close();
    await second.store.close();
  });

  it('does not lose updates queued right before close', async () => {
    const dir = await tempDir();
    const first = await openDoc(dir);
    for (let i = 0; i < 50; i++) first.doc.getArray<number>('a').push([i]);
    await first.store.close(); // nothing was flushed explicitly

    const second = await openDoc(dir);
    expect(second.doc.getArray('a').toJSON()).toEqual(Array.from({ length: 50 }, (_, i) => i));
    await second.store.close();
  });

  it('compacts once the log outgrows the threshold', async () => {
    const dir = await tempDir();
    const { doc, store } = await openDoc(dir);
    doc.getMap('m').set('small', 1);
    await store.flush();
    expect(await sizeOf(join(dir, 'project.log'))).toBeGreaterThan(0);

    doc.getMap('m').set('big', 'x'.repeat(COMPACT_LOG_BYTES + 1));
    doc.getMap('m').set('queued-during-compaction', true);
    await store.flush();
    expect(await sizeOf(join(dir, 'project.log'))).toBe(0);
    expect(await sizeOf(join(dir, 'project.snapshot'))).toBeGreaterThan(COMPACT_LOG_BYTES);

    doc.getMap('m').set('after', 2);
    await store.flush();
    expect(await sizeOf(join(dir, 'project.log'))).toBeGreaterThan(0);

    // "Crash" and reload: snapshot + the one record written after it.
    const reloaded = await openDoc(dir);
    const map = reloaded.doc.getMap('m');
    expect([...map.keys()].sort()).toEqual(['after', 'big', 'queued-during-compaction', 'small']);
    expect((map.get('big') as string).length).toBe(COMPACT_LOG_BYTES + 1);
    await reloaded.store.close();
    await store.close();
  });

  it('does not read files that hold more than it is set up to load', async () => {
    const dir = await tempDir();
    const snapshotPath = join(dir, 'project.snapshot');
    const logPath = join(dir, 'project.log');
    const first = await openDoc(dir);
    first.doc.getMap('m').set('big', 'x'.repeat(50_000));
    await first.store.close();
    const snapshot = await readFile(snapshotPath);
    expect(snapshot.byteLength).toBeGreaterThan(50_000);

    const reserved: number[] = [];
    const open = (maxBytes: number): Promise<{ doc: Y.Doc; store: DocStore }> => {
      const doc = new Y.Doc();
      return DocStore.open(dir, 'project', doc, { maxBytes, reserveBytes: (n) => reserved.push(n) }).then(
        (store) => ({ doc, store }),
      );
    };

    await expect(open(snapshot.byteLength - 1)).rejects.toThrow(DocumentTooLargeError);
    expect(reserved).toEqual([]);
    const exact = await open(snapshot.byteLength);
    expect(reserved).toEqual([snapshot.byteLength]);
    expect((exact.doc.getMap('m').get('big') as string).length).toBe(50_000);
    await exact.store.close();

    // The log may hold as much again as the snapshot, and what one compaction lets through.
    const filler = new Y.Doc();
    filler.getMap('m').set('more', 'y'.repeat(snapshot.byteLength + COMPACT_LOG_BYTES));
    await writeFile(logPath, encodeLogRecords([Y.encodeStateAsUpdate(filler)]));
    await expect(open(snapshot.byteLength)).rejects.toThrow(/project\.log holds \d+ bytes/);
    // Refusing changes nothing on disk: with a higher limit everything is there.
    expect(await readFile(snapshotPath)).toEqual(snapshot);
    const generous = await open(2 * snapshot.byteLength + COMPACT_LOG_BYTES);
    expect([...generous.doc.getMap('m').keys()].sort()).toEqual(['big', 'more']);
    await generous.store.close();
  });

  it('weighs the snapshot and every update in the log before it applies them', async () => {
    const dir = await tempDir();
    const first = await openDoc(dir);
    first.doc.transact(() => {
      for (let i = 0; i < 3000; i++) first.doc.getMap('m').set(`k${i}`, i);
    });
    await first.store.close();
    // Later updates, still in the log, that overwrite some of it.
    const second = await openDoc(dir);
    second.doc.transact(() => {
      for (let i = 0; i < 500; i++) second.doc.getMap('m').set(`k${i}`, -i);
    });
    await second.store.flush();
    const held = (doc: Y.Doc): number => {
      let structs = 0;
      for (const client of doc.store.clients.values()) structs += client.length;
      return structs;
    };

    // No room for the snapshot: nothing is applied.
    const none = new Y.Doc();
    await expect(DocStore.open(dir, 'project', none, { maxStructs: 2999 })).rejects.toThrow(
      /project\.snapshot holds 3000 structs, and at most 2999 are loaded/,
    );
    expect(held(none)).toBe(0);
    // Room for the snapshot but not for the log: loading stops in front of the update that is too much.
    const half = new Y.Doc();
    await expect(DocStore.open(dir, 'project', half, { maxStructs: 3499 })).rejects.toThrow(
      /project\.log holds 3500 structs, and at most 3499 are loaded/,
    );
    expect(held(half)).toBe(3000);

    const doc = new Y.Doc();
    const reserved: { structs: number; heldThen: number }[] = [];
    const store = await DocStore.open(dir, 'project', doc, {
      maxStructs: 3500,
      reserveStructs: (structs) => reserved.push({ structs, heldThen: held(doc) }),
    });
    expect(reserved).toEqual([
      { structs: 3000, heldThen: 0 },
      { structs: 500, heldThen: 3000 },
    ]);
    expect(held(doc)).toBeLessThanOrEqual(3500);
    expect(doc.getMap('m').get('k7')).toBe(-7);
    await store.close();
    await second.store.close();
  });

  it('does not take a long log of small edits for a large document', async () => {
    const dir = await tempDir();
    const first = await openDoc(dir);
    for (let i = 0; i < 100; i++) first.doc.getMap('m').set(`k${i}`, i);
    await first.store.close();
    // A slider dragged back and forth: twenty thousand edits to one field, never compacted
    // because the process died first. Each is a struct in the log, and next to none remain.
    const second = await openDoc(dir);
    for (let i = 0; i < 20_000; i++) second.doc.getMap('m').set('opacity', i);
    await second.store.flush();
    expect(await sizeOf(join(dir, 'project.log'))).toBeGreaterThan(20_000 * 8);

    const doc = new Y.Doc();
    let reserved = 0;
    let most = 0;
    const store = await DocStore.open(dir, 'project', doc, {
      maxStructs: 6000,
      reserveStructs: (structs) => {
        reserved += structs;
        most = Math.max(most, reserved);
      },
    });
    expect(doc.getMap('m').get('opacity')).toBe(19_999);
    let held = 0;
    for (const client of doc.store.clients.values()) held += client.length;
    expect(held).toBeLessThan(300);
    // What was reserved along the way never ran far ahead of what the document held.
    expect(most).toBeLessThan(6000);
    expect(reserved).toBeLessThan(held + 4097);
    await store.close();
    await second.store.close();
  });

  it('loads nothing when the caller has no room for the document', async () => {
    const dir = await tempDir();
    const first = await openDoc(dir);
    first.doc.getMap('m').set('a', 1);
    await first.store.close();

    for (const limits of [
      {
        reserveBytes: () => {
          throw new Error('no room');
        },
      },
      {
        reserveStructs: () => {
          throw new Error('no room');
        },
      },
    ]) {
      const doc = new Y.Doc();
      await expect(DocStore.open(dir, 'project', doc, limits)).rejects.toThrow('no room');
      expect(doc.store.clients.size).toBe(0);
    }
    const again = await openDoc(dir);
    expect(again.doc.getMap('m').toJSON()).toEqual({ a: 1 });
    await again.store.close();
  });

  it('never grows the log past what it would load again', async () => {
    const dir = await tempDir();
    const logPath = join(dir, 'project.log');
    const maxBytes = 200_000;
    const doc = new Y.Doc();
    const store = await DocStore.open(dir, 'project', doc, { maxBytes });
    doc.on('update', (update: Uint8Array) => store.append(update));

    // Updates that replace each other add up to more than the document ever holds. With no
    // snapshot to be had (something is in the way of its temp file), they stay queued rather
    // than go into a log that the next start would refuse to read.
    await mkdir(join(dir, 'project.snapshot.tmp'));
    for (let round = 0; round < 8; round++) doc.getMap('m').set('take', `${round}`.repeat(190_000));
    await expect(store.flush()).rejects.toThrow();
    expect(await sizeOf(logPath)).toBeLessThanOrEqual(maxBytes + COMPACT_LOG_BYTES);

    await rmdir(join(dir, 'project.snapshot.tmp'));
    await store.flush();
    await store.close();
    const reloaded = new Y.Doc();
    const again = await DocStore.open(dir, 'project', reloaded, { maxBytes });
    expect(reloaded.getMap('m').get('take')).toBe('7'.repeat(190_000));
    await again.close();
  });

  it('does not read a snapshot and a log that together hold more than could ever be kept', async () => {
    const dir = await tempDir();
    const first = await openDoc(dir);
    first.doc.getMap('m').set('big', 'x'.repeat(50_000));
    await first.store.close();
    // More of it in the log, where a process that died left it.
    const second = await openDoc(dir);
    second.doc.getMap('m').set('more', 'y'.repeat(30_000));
    await second.store.flush();
    const stored = (await sizeOf(join(dir, 'project.snapshot'))) + (await sizeOf(join(dir, 'project.log')));

    // Each file is within what is loaded of it. Together they are more than the caller holds
    // of all documents, so there is no point in asking it for room.
    const reserved: number[] = [];
    const open = (maxStoredBytes: number): Promise<DocStore> =>
      DocStore.open(dir, 'project', new Y.Doc(), {
        maxBytes: 60_000,
        maxStoredBytes,
        reserveBytes: (bytes) => reserved.push(bytes),
      });
    await expect(open(stored - 1)).rejects.toThrow(DocumentTooLargeError);
    await expect(open(stored - 1)).rejects.toThrow(
      new RegExp(
        `project\\.snapshot and \\S+project\\.log hold ${stored} bytes, and at most ${stored - 1} are loaded`,
      ),
    );
    expect(reserved).toEqual([]);
    const exact = await open(stored);
    expect(reserved).toEqual([stored]);
    await exact.close();
    await second.store.close();
  });

  it('compacts rather than let the snapshot and the log together outgrow what it would load again', async () => {
    const dir = await tempDir();
    const limits = { maxBytes: 400_000, maxStoredBytes: 400_000 };
    const doc = new Y.Doc();
    const store = await DocStore.open(dir, 'project', doc, limits);
    doc.on('update', (update: Uint8Array) => store.append(update));

    // One field written over and over: the document stays as small as it is, while every one of
    // the updates goes to the log.
    for (let round = 0; round < 12; round++) {
      doc.getMap('m').set('take', `${round % 10}`.repeat(100_000));
      await store.flush();
      const snapshotBytes = await sizeOf(join(dir, 'project.snapshot')).catch(() => 0);
      expect(snapshotBytes + (await sizeOf(join(dir, 'project.log')))).toBeLessThanOrEqual(400_000);
    }

    // The process dies here. What it left behind loads again under the same limits.
    const reloaded = new Y.Doc();
    const again = await DocStore.open(dir, 'project', reloaded, limits);
    expect(reloaded.getMap('m').get('take')).toBe('1'.repeat(100_000));
    await again.close();
    await store.close();
  });

  it('refuses to load a corrupt snapshot rather than starting empty', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'project.snapshot'), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x07]));
    await expect(openDoc(dir)).rejects.toThrow();
    // The damaged file is left exactly as it was for someone to look at.
    expect(await readFile(join(dir, 'project.snapshot'))).toEqual(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x07]),
    );
  });
});
