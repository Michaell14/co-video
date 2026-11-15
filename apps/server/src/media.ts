/**
 * Media assets: resumable uploads and range downloads.
 *
 *   <project>/media/<assetId>.part   bytes received so far (upload in progress)
 *   <project>/media/<assetId>        the finished asset
 *   <project>/media/<assetId>.json   { size, type, completedAt }
 *   <project>/unreferenced.json      { <assetId>: when it was first found to be referred to by
 *                                    nothing }, kept by the sweep of unused media (sweep.ts)
 *
 * An asset is complete exactly when the extension-less file exists: renaming `.part` to it is
 * the atomic commit of an upload. (Asset ids cannot contain dots, so the three names never clash.)
 */
import { createWriteStream, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, readdir, rename, stat, truncate, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { canEdit, PROJECT_DELETED } from '@tandem/core';
import type { Role } from '@tandem/core';
import { HttpError, parseIntHeader, sendEmpty, streamFile } from './http';
import type { ProjectStore } from './projects';
import {
  assertValidId,
  atomicWrite,
  atomicWriteSync,
  errorCode,
  fileSize,
  isNotFound,
  isValidId,
  readFileIfExists,
} from './util';

/** Asset ids are never reused for different bytes, so a finished asset can be cached forever. */
const ASSET_CACHE_CONTROL = 'private, max-age=31536000, immutable';
const FALLBACK_TYPE = 'application/octet-stream';
const BODY_TOO_LARGE = 'request body is larger than the rest of the declared Upload-Length';
/** `type/subtype` plus simple parameters, e.g. `video/mp4; codecs="avc1.640028, mp4a.40.2"`. */
const CONTENT_TYPE_RE = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w-]+=(?:"[\w .,+-]*"|[\w.+-]+))*$/;
/**
 * The types an asset is served as: what a browser plays or paints and nothing else. Anything it
 * would lay out as a document (HTML, SVG, PDF, plain text) could pose as a page of this server
 * under its own address, script or no script.
 */
const MEDIA_TYPE_RE = /^(?:video\/[\w.+-]+|audio\/[\w.+-]+|image\/(?:png|jpeg|webp|avif|gif))(?:\s*;|$)/i;

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
 * How a stored asset is labelled for whoever fetches it. Media keeps its type. Everything else
 * (the editor reads a LUT or an SVG from the bytes, whatever they are called) becomes an opaque
 * download, so that opening its URL in a tab saves a file instead of showing one.
 */
export function assetHeaders(storedType: string): Record<string, string> {
  return MEDIA_TYPE_RE.test(storedType)
    ? { 'Content-Type': storedType }
    : { 'Content-Type': FALLBACK_TYPE, 'Content-Disposition': 'attachment' };
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

interface ActiveUpload {
  abort(): void;
  done: Promise<void>;
}

/** A finished asset as it lies on disk. */
export interface StoredAsset {
  assetId: string;
  /** When the file was last written: the moment its upload ended. Milliseconds since the epoch. */
  uploadedAt: number;
}

export class MediaStore {
  /** The request currently allowed to modify an asset, by `projectId/assetId`. */
  private readonly active = new Map<string, ActiveUpload>();
  private readonly inFlight = new Set<Promise<void>>();
  /** The downloads under way, by project: they are cut off when their project is deleted. */
  private readonly serving = new Map<string, Set<ServerResponse>>();

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

  /**
   * Delete what is left of uploads nobody came back to: the `.part` files of a project that have
   * not been written to since `before`. Returns how many were deleted. Finished assets are never
   * touched, whether or not anything still refers to them, and neither is an upload in progress.
   * A client that does come back finds nothing stored and starts over, as it does for a new asset.
   */
  async sweepAbandonedUploads(projectId: string, before: number): Promise<number> {
    const dir = join(this.projects.dir(projectId), 'media');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
    let removed = 0;
    for (const name of names) {
      const assetId = name.endsWith('.part') ? name.slice(0, -'.part'.length) : '';
      const key = `${projectId}/${assetId}`;
      if (!isValidId(assetId) || this.active.has(key)) continue;
      // Held like an upload would hold it, so a request for the asset waits until we are done.
      const release = await this.lock(key, () => undefined);
      try {
        if (this.projects.isDeleted(projectId)) return removed;
        const part = join(dir, name);
        const info = await stat(part).catch(() => null);
        if (info?.isFile() && info.mtimeMs < before) {
          await unlink(part);
          removed++;
        }
      } finally {
        release();
      }
    }
    return removed;
  }

  /**
   * Stop everything that is touching the media of a project that is being deleted: uploads and
   * downloads under way are cut off. Resolves when none is left that could still write there.
   * That none begins afterwards is the caller's doing, who recorded the project as deleted first:
   * a request that gets its turn at an asset from then on refuses itself.
   */
  async drop(projectId: string): Promise<void> {
    for (const res of this.serving.get(projectId) ?? []) res.destroy();
    const prefix = `${projectId}/`;
    for (;;) {
      const holders = [...this.active].flatMap(([key, holder]) => (key.startsWith(prefix) ? [holder] : []));
      if (holders.length === 0) break;
      for (const holder of holders) holder.abort();
      await Promise.all(holders.map((holder) => holder.done));
    }
  }

  /** The finished assets of a project. Uploads in progress are not among them. */
  async finished(projectId: string): Promise<StoredAsset[]> {
    const dir = join(this.projects.dir(projectId), 'media');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    const stored: StoredAsset[] = [];
    // A finished asset is the one name without a dot (see the top of this file).
    for (const assetId of names.filter(isValidId)) {
      const info = await stat(join(dir, assetId)).catch(() => null);
      if (info?.isFile()) stored.push({ assetId, uploadedAt: info.mtimeMs });
    }
    return stored;
  }

  private unreferencedPath(projectId: string): string {
    return join(this.projects.dir(projectId), 'unreferenced.json');
  }

  /**
   * The assets of a project that a sweep found to be referred to by nothing, and when each was
   * first found so. A file that cannot be read says nothing, which starts every count anew.
   *
   * These notes are read and written within the caller's own turn of the event loop, like the
   * removal they lead to (`removeNow`). A sweep reads them, looks at the document and deletes in
   * one go, and the document has a note forgotten the moment it refers to the asset again
   * (`forgetUnreferenced`): neither ever goes by what the other is about to change.
   */
  unreferenced(projectId: string): Map<string, number> {
    const since = new Map<string, number>();
    const path = this.unreferencedPath(projectId);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [assetId, at] of Object.entries(parsed)) {
          if (isValidId(assetId) && typeof at === 'number' && Number.isFinite(at)) since.set(assetId, at);
        }
      }
    } catch {
      // Not there, or not to be read: nothing is noted.
    }
    return since;
  }

  /** Keep what `unreferenced` answers from now on. With nothing to keep, the file goes. */
  noteUnreferenced(projectId: string, since: ReadonlyMap<string, number>): void {
    const path = this.unreferencedPath(projectId);
    if (since.size > 0) {
      atomicWriteSync(path, JSON.stringify(Object.fromEntries(since)));
      return;
    }
    try {
      unlinkSync(path);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /**
   * Forget what was noted about assets of a project, because its document has just had to do
   * with them: it refers to them again, or did for a moment. The time for which nothing has
   * referred to them starts anew with the next sweep that finds it so.
   */
  forgetUnreferenced(projectId: string, assetIds: readonly string[]): void {
    const since = this.unreferenced(projectId);
    let forgotten = false;
    for (const assetId of assetIds) forgotten = since.delete(assetId) || forgotten;
    if (forgotten) this.noteUnreferenced(projectId, since);
  }

  /**
   * Delete a finished asset here and now, in the caller's own turn of the event loop: whoever
   * has just made sure that nothing refers to the file must not give anything the time to start
   * referring to it before it is gone. Returns false, with nothing deleted, while a request holds
   * the asset (it is being uploaded, confirmed or removed): there is a next time.
   */
  removeNow(projectId: string, assetId: string): boolean {
    if (this.active.has(`${projectId}/${assetId}`)) return false;
    const paths = this.paths(projectId, assetId);
    for (const path of [paths.file, paths.meta]) {
      try {
        unlinkSync(path);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    return true;
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
        // `?probe` is how an uploader asks "where do I resume from?": nothing stored yet is then
        // an answer (offset 0), not an error.
        return this.head(res, paths, new URL(req.url ?? '/', 'http://localhost').searchParams.has('probe'));
      case 'GET':
        return this.get(req, res, projectId, paths);
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
  private async head(res: ServerResponse, paths: AssetPaths, probe = false): Promise<void> {
    const size = await fileSize(paths.file);
    if (size !== null) {
      sendEmpty(res, 200, {
        'Upload-Offset': size,
        'Upload-Complete': '1',
        'Content-Length': size,
        ...assetHeaders(await this.storedType(paths)),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      return;
    }
    const partial = await fileSize(paths.part);
    if (partial === null && !probe) throw new HttpError(404, 'asset not found');
    sendEmpty(res, 200, {
      'Upload-Offset': partial ?? 0,
      'Upload-Complete': '0',
      'Cache-Control': 'no-store',
    });
  }

  private async get(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    paths: AssetPaths,
  ): Promise<void> {
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
      // Deleted while the file was being opened: nothing of the project is handed out any more.
      // From here to the note of this download, by which a deletion finds it, nothing is awaited.
      this.assertThere(projectId);
      res.writeHead(range ? 206 : 200, {
        ...assetHeaders(type),
        'Content-Length': length,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': ASSET_CACHE_CONTROL,
        // Uploads are user content. If someone opens an asset URL directly, whatever the browser
        // does show (a player, a picture) must not count as a page of this origin.
        'Content-Security-Policy': 'sandbox',
      });
      if (length === 0) {
        res.end();
        return;
      }
      streaming = true; // streamFile closes the handle
      const downloads = this.serving.get(projectId) ?? new Set<ServerResponse>();
      this.serving.set(projectId, downloads.add(res));
      try {
        await streamFile(res, handle, { start, end });
      } finally {
        downloads.delete(res);
        if (downloads.size === 0 && this.serving.get(projectId) === downloads) this.serving.delete(projectId);
      }
    } finally {
      if (!streaming) await handle.close();
    }
  }

  /**
   * Refuse to go on for a project that was deleted since the request was let in, while it waited
   * for its turn at an asset or for a file to open: the directory is going or gone, nothing may
   * put a file there again, and nothing of it is handed out any more.
   */
  private assertThere(projectId: string): void {
    if (this.projects.isDeleted(projectId)) throw new HttpError(410, PROJECT_DELETED);
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
      this.assertThere(projectId);
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
      this.assertThere(projectId);
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
