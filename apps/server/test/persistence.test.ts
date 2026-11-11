/**
 * DocStore against the failure modes a graceful shutdown never exercises: the process dying with
 * updates only in the log, and a log whose last record was cut short.
 */
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { COMPACT_LOG_BYTES, DocStore, encodeLogRecords, readLogRecords } from '../src/persistence';
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
