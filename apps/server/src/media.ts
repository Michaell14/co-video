/**
 * Media assets: resumable uploads and range downloads.
 *
 *   <project>/media/<assetId>.part   bytes received so far (upload in progress)
 *   <project>/media/<assetId>        the finished asset
 *   <project>/media/<assetId>.json   { size, type, completedAt }
 *
 * An asset is complete exactly when the extension-less file exists: renaming `.part` to it is
 * the atomic commit of an upload. (Asset ids cannot contain dots, so the three names never clash.)
 */
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, truncate, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { canEdit } from '@tandem/core';
import type { Role } from '@tandem/core';
import { HttpError, parseIntHeader, sendEmpty, streamFile } from './http';
import type { ProjectStore } from './projects';
import { assertValidId, atomicWrite, errorCode, isNotFound, readFileIfExists } from './util';

/** Asset ids are never reused for different bytes, so a finished asset can be cached forever. */
const ASSET_CACHE_CONTROL = 'private, max-age=31536000, immutable';
const FALLBACK_TYPE = 'application/octet-stream';
const BODY_TOO_LARGE = 'request body is larger than the rest of the declared Upload-Length';
/** `type/subtype` plus simple parameters, e.g. `video/mp4; codecs="avc1.640028, mp4a.40.2"`. */
const CONTENT_TYPE_RE = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w-]+=(?:"[\w .,+-]*"|[\w.+-]+))*$/;

interface AssetPaths {
  dir: string;
  file: string;
  part: string;
  meta: string;
}

/** The uploader's Content-Type is echoed to every downloader, so only well-formed values are kept. */
export function sanitizeContentType(value: unknown): string {
  return typeof value === 'string' && value.length <= 255 && CONTENT_TYPE_RE.test(value)
    ? value
    : FALLBACK_TYPE;
}

/**
 * Interpret a `Range` header for a resource of `size` bytes.
 * `null` means "serve the whole thing": no header, a unit other than bytes, several ranges
 * (not supported — answering 200 is what RFC 9110 prescribes for a range we choose to ignore)
 * or a syntactically invalid value.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    // "-n": the last n bytes
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? Infinity : Number(match[2]);
  if (end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** Size of a regular file, or `null` if it does not exist. */
async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

interface ActiveUpload {
  abort(): void;
  done: Promise<void>;
}

export class MediaStore {
  /** The request currently allowed to modify an asset, by `projectId/assetId`. */
  private readonly active = new Map<string, ActiveUpload>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly projects: ProjectStore,
    private readonly maxUploadBytes: number,
  ) {}

  private paths(projectId: string, assetId: string): AssetPaths {
    assertValidId(assetId, 'asset id');
    const dir = join(this.projects.dir(projectId), 'media');
    const file = join(dir, assetId);
    return { dir, file, part: `${file}.part`, meta: `${file}.json` };
  }

  /** Handle `HEAD|GET|PUT|DELETE /api/projects/:id/media/:assetId` for an authenticated caller. */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    assetId: string,
    role: Role,
  ): Promise<void> {
    const job = this.dispatch(req, res, projectId, assetId, role);
    const settled = job.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
    return job;
  }

  /** Resolves once no request is touching the media files any more (used on shutdown). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    assetId: string,
    role: Role,
  ): Promise<void> {
    const paths = this.paths(projectId, assetId);
    const key = `${projectId}/${assetId}`;
    switch (req.method) {
      case 'HEAD':
        return this.head(res, paths);
      case 'GET':
        return this.get(req, res, paths);
      case 'PUT':
      case 'DELETE':
        if (!canEdit(role)) throw new HttpError(403, `role "${role}" cannot change media`);
        return req.method === 'PUT'
          ? this.put(req, res, projectId, key, paths)
          : this.remove(res, projectId, key, paths);
      default:
        throw new HttpError(405, 'method not allowed', { Allow: 'GET, HEAD, PUT, DELETE, OPTIONS' });
    }
  }

  private async storedType(paths: AssetPaths): Promise<string> {
    try {
      const raw = await readFileIfExists(paths.meta);
      return raw
        ? sanitizeContentType((JSON.parse(raw.toString('utf8')) as { type?: unknown }).type)
        : FALLBACK_TYPE;
    } catch {
      return FALLBACK_TYPE;
    }
  }

  /** Upload progress. It changes from one request to the next, hence `no-store`. */
  private async head(res: ServerResponse, paths: AssetPaths): Promise<void> {
    const size = await fileSize(paths.file);
    if (size !== null) {
      sendEmpty(res, 200, {
        'Upload-Offset': size,
        'Upload-Complete': '1',
        'Content-Length': size,
        'Content-Type': await this.storedType(paths),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      return;
    }
    const partial = await fileSize(paths.part);
    if (partial === null) throw new HttpError(404, 'asset not found');
    sendEmpty(res, 200, { 'Upload-Offset': partial, 'Upload-Complete': '0', 'Cache-Control': 'no-store' });
  }

  private async get(req: IncomingMessage, res: ServerResponse, paths: AssetPaths): Promise<void> {
    // Open first and take the size from the handle, so the headers always describe the very
    // file we are about to stream even if the asset is deleted at the same moment.
    let handle: FileHandle;
    try {
      handle = await open(paths.file, 'r');
    } catch (err) {
      if (isNotFound(err)) throw new HttpError(404, 'asset not found (or its upload is not complete)');
      throw err;
    }
    let streaming = false;
    try {
      const { size } = await handle.stat();
      const type = await this.storedType(paths);
      const range = parseRange(req.headers.range, size);
      if (range === 'unsatisfiable') {
        throw new HttpError(416, 'requested range not satisfiable', {
          'Content-Range': `bytes */${size}`,
          'Accept-Ranges': 'bytes',
        });
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = end - start + 1;
      res.writeHead(range ? 206 : 200, {
        'Content-Type': type,
        'Content-Length': length,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': ASSET_CACHE_CONTROL,
        // Uploads are user content. If someone opens an asset URL directly, the browser must treat
        // it as an opaque, script-less document rather than as a page of this origin.
        'Content-Security-Policy': 'sandbox',
      });
      if (length === 0) {
        res.end();
        return;
      }
      streaming = true; // streamFile closes the handle
      await streamFile(res, handle, { start, end });
    } finally {
      if (!streaming) await handle.close();
    }
  }

  /**
   * Become the one request allowed to modify an asset. A request that already holds that right is
   * aborted and waited for: after a network drop the client retries long before the server notices
   * the dead connection, and the retry must not be locked out by its own ghost.
   */
  private async lock(key: string, abort: () => void): Promise<() => void> {
    for (let holder = this.active.get(key); holder; holder = this.active.get(key)) {
      holder.abort();
      await holder.done;
    }
    let finish!: () => void;
    const entry: ActiveUpload = { abort, done: new Promise<void>((resolve) => (finish = resolve)) };
    this.active.set(key, entry);
    return () => {
      if (this.active.get(key) === entry) this.active.delete(key);
      finish();
    };
  }

  private async put(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    key: string,
    paths: AssetPaths,
  ): Promise<void> {
    const total = parseIntHeader(req.headers['upload-length']);
    const offset = parseIntHeader(req.headers['upload-offset']);
    if (total === null) throw new HttpError(400, 'Upload-Length header must be a non-negative integer');
    if (offset === null) throw new HttpError(400, 'Upload-Offset header must be a non-negative integer');
    if (total > this.maxUploadBytes) {
      throw new HttpError(413, `asset is larger than the upload limit of ${this.maxUploadBytes} bytes`);
    }

    const release = await this.lock(key, () => req.destroy());
    try {
      const finished = await fileSize(paths.file);
      if (finished !== null) {
        // Already complete (e.g. the client never saw our final 204): confirm, do not rewrite.
        sendEmpty(res, 204, { 'Upload-Offset': finished, 'Upload-Complete': '1' });
        return;
      }

      const stored = (await fileSize(paths.part)) ?? 0;
      if (offset !== stored) {
        throw new HttpError(409, `Upload-Offset is ${offset} but ${stored} bytes are stored`, {
          'Upload-Offset': String(stored),
          'Upload-Complete': '0',
        });
      }
      if (stored > total) throw new HttpError(400, 'Upload-Length is smaller than the bytes already stored');
      const remaining = total - stored;
      // Absent with chunked transfer encoding; then the guard below enforces the limit instead.
      const declared = parseIntHeader(req.headers['content-length']);
      if (declared !== null && declared > remaining) throw new HttpError(400, BODY_TOO_LARGE);

      await mkdir(paths.dir, { recursive: true });
      if (req.destroyed) {
        // Aborted while we were waiting (the client left, or a newer request for this asset took
        // over): there is no body to read any more and nobody to answer.
        res.destroy();
        return;
      }
      let received = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > remaining) {
            callback(new HttpError(400, BODY_TOO_LARGE));
            return;
          }
          callback(null, chunk);
        },
      });
      // `req.pipe()` rather than putting `req` into the pipeline: pipeline() destroys its source
      // when the disk fails, and with the socket gone the client would never get the status code.
      // The price is handling a vanished client ourselves: flush what did arrive, then stop.
      const onClose = (): void => {
        // 'close' without a preceding 'end' = the request was cut short (or aborted by a newer
        // one). pipe() will never end the guard in that case, so do it here.
        if (!req.readableEnded) guard.end();
      };
      req.once('close', onClose);
      req.pipe(guard);
      try {
        // `flush` fsyncs before closing: a 204 means the chunk survives a power cut.
        await pipeline(guard, createWriteStream(paths.part, { flags: 'a', flush: true }));
      } catch (err) {
        // Nothing of a rejected request is kept; the client's view of the offset stays correct.
        await truncate(paths.part, stored).catch(() => undefined);
        if (errorCode(err) === 'ENOSPC' || errorCode(err) === 'EDQUOT') {
          throw new HttpError(507, 'the server is out of disk space');
        }
        throw err;
      } finally {
        req.off('close', onClose);
      }
      // The connection died mid-body: nobody to answer, but everything received is on disk and
      // the client can carry on from there (HEAD tells it where).
      if (!req.readableEnded) return;

      const size = stored + received;
      const complete = size === total;
      if (complete) {
        const meta = {
          size,
          type: sanitizeContentType(req.headers['content-type']),
          completedAt: Date.now(),
        };
        await atomicWrite(paths.meta, JSON.stringify(meta));
        await rename(paths.part, paths.file);
        this.projects.touch(projectId);
      }
      sendEmpty(res, 204, { 'Upload-Offset': size, 'Upload-Complete': complete ? '1' : '0' });
    } finally {
      release();
    }
  }

  private async remove(
    res: ServerResponse,
    projectId: string,
    key: string,
    paths: AssetPaths,
  ): Promise<void> {
    const release = await this.lock(key, () => undefined);
    try {
      for (const path of [paths.part, paths.file, paths.meta]) {
        await unlink(path).catch((err: unknown) => {
          if (!isNotFound(err)) throw err;
        });
      }
      this.projects.touch(projectId);
      sendEmpty(res, 204);
    } finally {
      release();
    }
  }
}
