/**
 * MediaStore: where a project's media bytes live.
 *
 *  - Imported files are copied into the Origin Private File System so they survive reloads and are
 *    read with fast random access.
 *  - When the project is shared, originals upload to the collaboration server in resumable chunks.
 *  - Collaborators stream media straight from the server (HTTP range requests) and cache it into
 *    their own OPFS in the background, so the first frame shows in a moment and scrubbing gets fast.
 */
import type { MediaLocation, MediaResolver } from '@tandem/engine';
import { api, isRefusal, serverBase } from './api';

export interface MediaStatus {
  /** A full local copy exists. */
  local: boolean;
  /**
   * The local copy is an imported file held by this tab only: `saving` while it is being written to
   * the device, `failed` when that could not be done, so it is gone after a reload. `null` once it
   * is stored.
   */
  unsaved: 'saving' | 'failed' | null;
  /** 0…1 while uploading, otherwise null. */
  uploading: number | null;
  /** 0…1 while downloading, otherwise null. */
  downloading: number | null;
  /** A preview proxy exists on this device. */
  proxy: boolean;
  /** 0…1 while a proxy is being made, otherwise null. */
  proxying: number | null;
  /** Why the last upload or download stopped. Cleared when it is tried again. */
  transferError: string | null;
  /** Why the last proxy could not be made. Cleared when one is made again. */
  proxyError: string | null;
}

const EMPTY: MediaStatus = {
  local: false,
  unsaved: null,
  uploading: null,
  downloading: null,
  proxy: false,
  proxying: null,
  transferError: null,
  proxyError: null,
};
const PROXY_SUFFIX = '.proxy';
const CHUNK = 8 * 1024 * 1024;

type Listener = () => void;

/**
 * How an upload or download ended. `retry` is trouble that passes by itself (the connection
 * dropped, the server was busy); `failed` needs something to change first (the server said no).
 */
export type TransferResult = 'done' | 'retry' | 'failed';

class TransferRefused extends Error {}

/** How writing an imported file to the device ended. */
export type SaveResult = 'saved' | 'no-space' | 'failed';

/** An imported file that only this page has: the device holds no copy of it, or not yet. */
interface Unsaved {
  file: File;
  done: Promise<SaveResult>;
  cancel: AbortController;
  /** The copy is still being written. Once it is not and the entry is still here, it failed. */
  saving: boolean;
}

/**
 * Imported files the device has no copy of, by project and asset: the copy is still being written,
 * or it could not be made. Kept outside the store because both outlive it. Leaving a project must
 * not cut a copy short, and coming back to it has to find the file that is only in memory: a file
 * that could not be saved stays usable for as long as the page does.
 */
const unsaved = new Map<string, Unsaved>();
/** Copies are written one after the other; in parallel they only compete for the same disk. */
let saveQueue: Promise<unknown> = Promise.resolve();

const unsavedPrefix = (projectId: string): string => `${projectId}/`;

if (typeof window !== 'undefined') {
  // Imports are in the pool before they are on the device. Until a copy is written this tab is all
  // it has, so closing the tab asks first, whichever screen is showing by then. A copy that failed
  // was reported when it did, and waiting would not bring it back.
  window.addEventListener('beforeunload', (e) => {
    for (const held of unsaved.values()) if (held.saving) e.preventDefault();
  });
}

async function saveToDevice(
  dir: Promise<FileSystemDirectoryHandle | null>,
  assetId: string,
  file: File,
  signal: AbortSignal,
): Promise<SaveResult> {
  const target = await dir;
  if (!target || signal.aborted) return 'failed';
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota !== undefined && usage !== undefined && file.size > quota - usage) return 'no-space';
    const handle = await target.getFileHandle(assetId, { create: true });
    // The stream writes to a temporary file that replaces the real one on close, and piping
    // aborts it when anything goes wrong: a failed copy never leaves a truncated file behind.
    await file.stream().pipeTo(await handle.createWritable(), { signal });
    return 'saved';
  } catch (err) {
    await target.removeEntry(assetId).catch(() => {});
    return (err as Error)?.name === 'QuotaExceededError' ? 'no-space' : 'failed';
  }
}

export interface RemoteAccess {
  projectId: string;
  token: string;
  canWrite: boolean;
}

export class MediaStore {
  private readonly files = new Map<string, File>();
  private readonly status = new Map<string, MediaStatus>();
  private readonly listeners = new Set<Listener>();
  private dir: Promise<FileSystemDirectoryHandle | null> | null = null;
  private remote: RemoteAccess | null = null;
  private readonly uploads = new Map<string, AbortController>();
  private readonly downloads = new Map<string, AbortController>();
  private readonly proxies = new Map<string, File>();
  private readonly proxyJobs = new Map<string, AbortController>();
  /** Proxy jobs run one at a time: each one already uses every core the encoder can get. */
  private proxyQueue: Promise<unknown> = Promise.resolve();
  private destroyed = false;
  private version = 0;

  /** Called when an asset becomes available locally (so decoders can switch to the fast path). */
  onLocal: (assetId: string) => void = () => {};
  /** Called when an upload completes. */
  onUploaded: (assetId: string) => void = () => {};
  /** Called when an asset's proxy appears or goes away. */
  onProxy: (assetId: string) => void = () => {};

  constructor(private readonly projectId: string) {}

  setRemote(remote: RemoteAccess | null): void {
    this.remote = remote;
  }

  // ───────────────────────────────────────────────────────────── status ──

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  get(assetId: string): MediaStatus {
    return this.status.get(assetId) ?? EMPTY;
  }

  private patch(assetId: string, p: Partial<MediaStatus>): void {
    this.status.set(assetId, { ...this.get(assetId), ...p });
    this.version++;
    for (const fn of Array.from(this.listeners)) fn();
  }

  // ─────────────────────────────────────────────────────────────── OPFS ──

  private directory(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.dir) {
      this.dir = (async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const app = await root.getDirectoryHandle('tandem', { create: true });
          return await app.getDirectoryHandle(this.projectId, { create: true });
        } catch {
          return null;
        }
      })();
    }
    return this.dir;
  }

  /** The copy of an asset stored on this device, if it is complete. */
  private async readStored(assetId: string): Promise<File | null> {
    const dir = await this.directory();
    if (!dir) return null;
    try {
      const file = await (await dir.getFileHandle(assetId)).getFile();
      return file.size === 0 ? null : file;
    } catch {
      return null;
    }
  }

  private async readLocal(assetId: string): Promise<File | null> {
    const mem = this.files.get(assetId);
    if (mem) return mem;
    const held = unsaved.get(this.saveKey(assetId));
    if (held) {
      this.follow(assetId, held);
      return held.file;
    }
    const file = await this.readStored(assetId);
    if (!file) return null;
    this.files.set(assetId, file);
    if (!this.get(assetId).local) this.patch(assetId, { local: true });
    return file;
  }

  /**
   * Scan OPFS so `local` flags are right before anything asks. With `prune`, files that belong to no
   * asset (removed in an earlier session, or a download that never finished) are deleted so removed
   * footage does not keep occupying the disk.
   */
  async init(assetIds: string[], prune = false): Promise<void> {
    await Promise.all(assetIds.flatMap((id) => [this.readLocal(id), this.readProxy(id)]));
    void navigator.storage?.persist?.().catch(() => false);
    if (prune) void this.prune(new Set(assetIds));
  }

  private async prune(keep: ReadonlySet<string>): Promise<void> {
    const dir = await this.directory();
    if (!dir) return;
    try {
      const stale: string[] = [];
      const entries = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
      for await (const name of entries) {
        // `<id>` and `<id>.proxy`, plus what an unfinished write leaves beside them: the browser's
        // `.crswap` file, or a `.part` from versions that wrote downloads to one first.
        let id = name;
        const partial = /\.(part|crswap)$/.exec(id);
        if (partial) id = id.slice(0, partial.index);
        const proxy = id.endsWith(PROXY_SUFFIX);
        if (proxy) id = id.slice(0, -PROXY_SUFFIX.length);
        const busy = proxy
          ? this.proxyJobs.has(id)
          : this.downloads.has(id) || !!unsaved.get(this.saveKey(id))?.saving;
        // An asset imported since the scan began is not in `keep` yet, but it is ours.
        const wanted = keep.has(id) || this.files.has(id);
        if (!wanted || (partial && !busy)) stale.push(name);
      }
      for (const name of stale) await dir.removeEntry(name).catch(() => {});
    } catch {
      // Listing is best-effort; nothing depends on it.
    }
  }

  private saveKey(assetId: string): string {
    return unsavedPrefix(this.projectId) + assetId;
  }

  /**
   * Take in a freshly imported file. It is usable from memory as soon as this returns; the copy
   * that survives a reload is written in the background, and the promise tells how that went.
   */
  import(assetId: string, file: File): Promise<SaveResult> {
    const key = this.saveKey(assetId);
    const cancel = new AbortController();
    const dir = this.directory();
    const done = saveQueue.then(() => saveToDevice(dir, assetId, file, cancel.signal));
    saveQueue = done;
    const held: Unsaved = { file, done, cancel, saving: true };
    unsaved.set(key, held);
    void done.then((result) => {
      held.saving = false;
      // A file the device could not take stays where a later visit to the project finds it.
      if (result === 'saved' && unsaved.get(key) === held) unsaved.delete(key);
    });
    this.follow(assetId, held);
    return done;
  }

  /** The copies of this project's imported files that are still being written to the device. */
  private writing(): Unsaved[] {
    const prefix = unsavedPrefix(this.projectId);
    return Array.from(unsaved)
      .filter(([key, held]) => held.saving && key.startsWith(prefix))
      .map(([, held]) => held);
  }

  /** An imported file of this project is still being written to the device. */
  get saving(): boolean {
    return this.writing().length > 0;
  }

  /** Resolves once none is: every copy has by then landed on the device, or failed and said so. */
  async savesSettled(): Promise<void> {
    for (let writing = this.writing(); writing.length; writing = this.writing())
      await Promise.all(writing.map((held) => held.done));
  }

  /** Serve an asset from a file only this page has, and note how its save ends if one is running. */
  private follow(assetId: string, held: Unsaved): void {
    this.files.set(assetId, held.file);
    this.patch(assetId, { local: true, unsaved: held.saving ? 'saving' : 'failed' });
    if (!held.saving) return;
    void held.done.then(async (result) => {
      // Read back from the device so memory no longer pins the user's original file.
      const stored = result === 'saved' ? await this.readStored(assetId) : null;
      // Removed or replaced while the copy was being written: nothing left to report on.
      if (this.files.get(assetId) !== held.file) return;
      if (stored) this.files.set(assetId, stored);
      this.patch(assetId, { unsaved: stored ? null : 'failed' });
    });
  }

  async remove(assetId: string): Promise<void> {
    this.uploads.get(assetId)?.abort();
    this.downloads.get(assetId)?.abort();
    this.proxyJobs.get(assetId)?.abort();
    const key = this.saveKey(assetId);
    unsaved.get(key)?.cancel.abort();
    unsaved.delete(key);
    this.files.delete(assetId);
    this.proxies.delete(assetId);
    this.status.delete(assetId);
    const dir = await this.directory();
    await dir?.removeEntry(assetId).catch(() => {});
    await dir?.removeEntry(assetId + PROXY_SUFFIX).catch(() => {});
  }

  // ───────────────────────────────────────────────────────────── proxies ──

  private async readProxy(assetId: string): Promise<File | null> {
    const mem = this.proxies.get(assetId);
    if (mem) return mem;
    const dir = await this.directory();
    if (!dir) return null;
    try {
      const file = await (await dir.getFileHandle(assetId + PROXY_SUFFIX)).getFile();
      if (file.size === 0) return null;
      this.proxies.set(assetId, file);
      if (!this.get(assetId).proxy) this.patch(assetId, { proxy: true });
      return file;
    } catch {
      return null;
    }
  }

  /**
   * Make a preview proxy for a video asset from its local original. Jobs are queued; the returned
   * promise resolves true once this one's proxy exists.
   */
  buildProxy(assetId: string): Promise<boolean> {
    if (this.proxyJobs.has(assetId) || this.destroyed) return Promise.resolve(false);
    const ctrl = new AbortController();
    this.proxyJobs.set(assetId, ctrl);
    this.patch(assetId, { proxying: 0, proxyError: null });
    const job = this.proxyQueue.then(() => this.runProxy(assetId, ctrl));
    this.proxyQueue = job.catch(() => false);
    return job;
  }

  private async runProxy(assetId: string, ctrl: AbortController): Promise<boolean> {
    const name = assetId + PROXY_SUFFIX;
    const dir = await this.directory();
    try {
      // Loaded on demand: this module is also used by the home screen, which must stay light.
      const { createProxy, ProxyCancelled } = await import('@tandem/engine');
      if (ctrl.signal.aborted) throw new ProxyCancelled();
      const source = await this.readLocal(assetId);
      if (!dir || !source) throw new Error('The original file has to be on this device to make a proxy.');
      const handle = await dir.getFileHandle(name, { create: true });
      // Written in place: the stream only replaces the file when it is closed, so there is no
      // half-made proxy to be found, and nothing to copy afterwards.
      const writable = await handle.createWritable();
      let last = 0;
      try {
        await createProxy(source, writable, {
          signal: ctrl.signal,
          onProgress: (f) => {
            const now = performance.now();
            if (now - last < 200) return;
            last = now;
            this.patch(assetId, { proxying: f });
          },
        });
        await writable.close();
      } catch (err) {
        await writable.abort().catch(() => {});
        throw err;
      }
      this.proxies.set(assetId, await handle.getFile());
      this.patch(assetId, { proxying: null, proxy: true });
      this.onProxy(assetId);
      return true;
    } catch (err) {
      // What is left is the empty file the stream was opened on, unless an earlier proxy is still there.
      if (!this.proxies.has(assetId)) await dir?.removeEntry(name).catch(() => {});
      if ((err as Error)?.name === 'ProxyCancelled' || ctrl.signal.aborted)
        this.patch(assetId, { proxying: null });
      else
        this.patch(assetId, {
          proxying: null,
          proxyError: err instanceof Error ? err.message : 'Could not make a proxy',
        });
      return false;
    } finally {
      this.proxyJobs.delete(assetId);
    }
  }

  cancelProxy(assetId: string): void {
    this.proxyJobs.get(assetId)?.abort();
  }

  async removeProxy(assetId: string): Promise<void> {
    this.proxyJobs.get(assetId)?.abort();
    if (!this.proxies.delete(assetId) && !this.get(assetId).proxy) return;
    this.patch(assetId, { proxy: false });
    // Decoders must let go of the file before it disappears.
    this.onProxy(assetId);
    const dir = await this.directory();
    await dir?.removeEntry(assetId + PROXY_SUFFIX).catch(() => {});
  }

  /** Bytes used by this project's local media. */
  async usage(): Promise<number> {
    let total = 0;
    for (const f of this.files.values()) total += f.size;
    return total;
  }

  // ─────────────────────────────────────────────────────────── resolver ──

  /**
   * `uploaded(assetId)` tells whether the server has the complete file. `useProxy` (preview only;
   * never pass it for an export) says whether a proxy may stand in for the picture.
   */
  resolver(uploaded: (assetId: string) => boolean, useProxy?: (assetId: string) => boolean): MediaResolver {
    return async (assetId): Promise<MediaLocation | null> => {
      const local = await this.readLocal(assetId);
      if (local) {
        const proxy = useProxy?.(assetId) ? await this.readProxy(assetId) : null;
        return proxy ? { blob: local, proxy } : { blob: local };
      }
      if (this.remote && uploaded(assetId)) {
        return { url: api.mediaUrl(this.remote.projectId, assetId, this.remote.token) };
      }
      return null;
    };
  }

  // ───────────────────────────────────────────────────────────── upload ──

  /** Whether uploads and downloads have a server to talk to. */
  get connected(): boolean {
    return this.remote !== null;
  }

  private transferFailed(assetId: string, err: unknown, what: 'Upload' | 'Download'): TransferResult {
    // `fetch` reports a lost connection as a bare TypeError whose text says nothing to a user.
    const lost = !(err instanceof Error) || err instanceof TypeError;
    this.patch(assetId, { transferError: lost ? `${what} interrupted` : err.message });
    return err instanceof TransferRefused ? 'failed' : 'retry';
  }

  /** Upload an asset to the server, resuming from wherever a previous attempt stopped. */
  async upload(assetId: string, mime: string): Promise<TransferResult> {
    const remote = this.remote;
    if (!remote || !remote.canWrite || this.uploads.has(assetId) || this.destroyed) return 'retry';
    const file = await this.readLocal(assetId);
    if (!file) return 'retry';
    const ctrl = new AbortController();
    this.uploads.set(assetId, ctrl);
    const url = `${serverBase()}/api/projects/${remote.projectId}/media/${assetId}`;
    const auth = { Authorization: `Bearer ${remote.token}` };
    try {
      this.patch(assetId, { uploading: 0, transferError: null });
      let offset = 0;
      const head = await fetch(`${url}?probe`, { method: 'HEAD', headers: auth, signal: ctrl.signal });
      if (head.ok) {
        if (head.headers.get('Upload-Complete') === '1') {
          this.patch(assetId, { uploading: null });
          this.onUploaded(assetId);
          return 'done';
        }
        offset = Number(head.headers.get('Upload-Offset') ?? 0) || 0;
      }
      if (offset > file.size) offset = 0;
      let attempts = 0;
      while (offset < file.size || file.size === 0) {
        const end = Math.min(file.size, offset + CHUNK);
        const res = await fetch(url, {
          method: 'PUT',
          headers: {
            ...auth,
            'Upload-Offset': String(offset),
            'Upload-Length': String(file.size),
            'Content-Type': mime || 'application/octet-stream',
          },
          body: file.slice(offset, end),
          signal: ctrl.signal,
        });
        if (res.status === 409) {
          // The server has a different idea of where we are: follow it.
          offset = Number(res.headers.get('Upload-Offset') ?? 0) || 0;
          if (++attempts > 5) throw new Error('Upload kept desynchronising');
          continue;
        }
        if (!res.ok) {
          const message = `Upload failed (${res.status})`;
          throw isRefusal(res.status) ? new TransferRefused(message) : new Error(message);
        }
        offset = Number(res.headers.get('Upload-Offset') ?? end) || end;
        this.patch(assetId, { uploading: file.size ? offset / file.size : 1 });
        if (res.headers.get('Upload-Complete') === '1' || file.size === 0) break;
      }
      this.patch(assetId, { uploading: null });
      this.onUploaded(assetId);
      return 'done';
    } catch (err) {
      this.patch(assetId, { uploading: null });
      return ctrl.signal.aborted ? 'retry' : this.transferFailed(assetId, err, 'Upload');
    } finally {
      this.uploads.delete(assetId);
    }
  }

  /**
   * Ask the server whether it holds the whole of an asset's file. `null` when it could not be
   * asked, or gave no answer to go by.
   */
  async held(assetId: string, signal?: AbortSignal): Promise<boolean | null> {
    const remote = this.remote;
    if (!remote || this.destroyed) return null;
    try {
      // The same question an upload starts with: answered for a file that is not there, too.
      const url = `${serverBase()}/api/projects/${remote.projectId}/media/${assetId}?probe`;
      const auth = { Authorization: `Bearer ${remote.token}` };
      const res = await fetch(url, { method: 'HEAD', headers: auth, signal });
      if (res.ok) return res.headers.get('Upload-Complete') === '1';
      return isRefusal(res.status) ? false : null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────── download ──

  /** Cache a server-hosted asset into OPFS. Safe to call repeatedly. */
  async download(assetId: string): Promise<TransferResult> {
    const remote = this.remote;
    if (!remote || this.downloads.has(assetId) || this.destroyed) return 'retry';
    if (await this.readLocal(assetId)) return 'done';
    const dir = await this.directory();
    if (!dir) return 'failed';
    const ctrl = new AbortController();
    this.downloads.set(assetId, ctrl);
    let writable: FileSystemWritableFileStream | null = null;
    try {
      this.patch(assetId, { downloading: 0, transferError: null });
      const res = await fetch(api.mediaUrl(remote.projectId, assetId, remote.token), { signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const message = `Download failed (${res.status})`;
        throw isRefusal(res.status) ? new TransferRefused(message) : new Error(message);
      }
      const total = Number(res.headers.get('Content-Length') ?? 0);
      const handle = await dir.getFileHandle(assetId, { create: true });
      // Written in place: until the stream is closed the file reads as empty, which `readStored`
      // treats as absent, so a partial download is never mistaken for the asset.
      writable = await handle.createWritable();
      const reader = res.body.getReader();
      let got = 0;
      let lastReport = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        got += value.byteLength;
        const now = performance.now();
        if (total && now - lastReport > 200) {
          lastReport = now;
          this.patch(assetId, { downloading: got / total });
        }
      }
      await writable.close();
      this.files.set(assetId, await handle.getFile());
      this.patch(assetId, { downloading: null, local: true });
      this.onLocal(assetId);
      return 'done';
    } catch (err) {
      // Let go of the temporary file first; the entry cannot be removed while the stream holds it.
      await writable?.abort().catch(() => {});
      await dir.removeEntry(assetId).catch(() => {});
      this.patch(assetId, { downloading: null });
      return ctrl.signal.aborted ? 'retry' : this.transferFailed(assetId, err, 'Download');
    } finally {
      this.downloads.delete(assetId);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const c of this.uploads.values()) c.abort();
    for (const c of this.downloads.values()) c.abort();
    for (const c of this.proxyJobs.values()) c.abort();
    this.listeners.clear();
  }
}

/** Delete all locally stored media for a project. */
export async function deleteProjectMedia(projectId: string): Promise<void> {
  // Files held for a later visit to the project have nothing left to be held for.
  const prefix = unsavedPrefix(projectId);
  for (const key of Array.from(unsaved.keys())) if (key.startsWith(prefix)) unsaved.delete(key);
  try {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('tandem', { create: true });
    await app.removeEntry(projectId, { recursive: true });
  } catch {
    /* nothing stored */
  }
}

/**
 * Copy the locally stored originals of the given assets from one project to another (a project
 * file opened as a new project brings along the media its source has on this device). What cannot
 * be copied, for want of space or because it is not there, is simply offline in the new project.
 */
export async function copyProjectMedia(fromId: string, toId: string, assetIds: string[]): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('tandem', { create: true });
    const from = await app.getDirectoryHandle(fromId);
    const to = await app.getDirectoryHandle(toId, { create: true });
    for (const id of assetIds) {
      try {
        const file = await (await from.getFileHandle(id)).getFile();
        if (file.size === 0) continue;
        const dest = await to.getFileHandle(id, { create: true });
        await file.stream().pipeTo(await dest.createWritable());
      } catch {
        await to.removeEntry(id).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[media] could not copy project media', err);
  }
}

/**
 * Move a project's media on this device under a new project id (used when publishing). An import
 * still being copied to the device is not waited for; a caller that wants it moved too waits for
 * `MediaStore.savesSettled` first.
 */
export async function moveProjectMedia(fromId: string, toId: string): Promise<void> {
  await moveStoredMedia(fromId, toId);
  // Files the device could not keep exist in this page only. They change address with the rest,
  // so the project still has them under its new id and can upload them from there.
  const prefix = unsavedPrefix(fromId);
  for (const [key, held] of Array.from(unsaved)) {
    if (!key.startsWith(prefix)) continue;
    unsaved.delete(key);
    unsaved.set(unsavedPrefix(toId) + key.slice(prefix.length), held);
  }
}

async function moveStoredMedia(fromId: string, toId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('tandem', { create: true });
    const from = await app.getDirectoryHandle(fromId).catch(() => null);
    if (!from) return;
    const to = await app.getDirectoryHandle(toId, { create: true });
    const entries = (from as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind !== 'file') continue;
      const file = handle as FileSystemFileHandle & {
        move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void>;
      };
      try {
        if (!file.move) throw new Error('no move');
        await file.move(to, name);
      } catch {
        // No atomic move in this browser: copy the bytes instead.
        const dest = await to.getFileHandle(name, { create: true });
        const writable = await dest.createWritable();
        await (await file.getFile()).stream().pipeTo(writable);
      }
    }
    await app.removeEntry(fromId, { recursive: true }).catch(() => {});
  } catch (err) {
    console.warn('[media] could not move project media', err);
  }
}
