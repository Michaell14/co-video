/** Small filesystem / concurrency helpers shared by the server modules. */
import { open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as zlib from 'node:zlib';

/**
 * The one and only shape an id may have (projects, assets, versions).
 *
 * This is the path-traversal guard: ids end up as file and directory names, so nothing that
 * could contain a separator, a dot or a NUL byte may ever get past it.
 */
export const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const isValidId = (value: unknown): value is string => typeof value === 'string' && ID_RE.test(value);

/** Throws on anything that is not a well-formed id. Used right where paths are built (defence in depth). */
export function assertValidId(value: unknown, what = 'id'): asserts value is string {
  if (!isValidId(value)) throw new Error(`refusing to build a path from an invalid ${what}`);
}

export const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;

export const isNotFound = (err: unknown): boolean => {
  const code = errorCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** True for the errors a stream reports when the peer simply went away mid-transfer. */
export const isClientAbort = (err: unknown): boolean => {
  const code = errorCode(err);
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'EPIPE';
};

/** `readFile` that resolves to `null` when the file does not exist. */
export async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Size of a regular file, or `null` if it does not exist. */
export async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Best-effort fsync of a directory so a rename inside it survives power loss (not supported on Windows). */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* not supported on this platform / filesystem */
  }
}

/**
 * Replace `path` atomically: readers see either the old or the new content, never a partial file.
 * The temp file is fsynced before the rename so a crash cannot leave an empty file behind.
 *
 * Callers must serialise writes to the same path (the temp name is fixed on purpose, so a
 * leftover from a crash is simply overwritten by the next write instead of piling up).
 */
export async function atomicWrite(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.datasync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  await syncDir(dirname(path));
}

/** Runs async jobs one at a time per key (e.g. per project), in arrival order. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(job);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Table-driven CRC-32 (IEEE), for Node versions that predate `zlib.crc32` (< 20.15 / < 22.2). */
export function crc32Fallback(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC-32 (IEEE) of `data` as an unsigned 32-bit integer. */
export const crc32: (data: Uint8Array) => number =
  typeof zlib.crc32 === 'function' ? (data) => zlib.crc32(data) : crc32Fallback;
