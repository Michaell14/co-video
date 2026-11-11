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
import { api, serverBase } from './api';

export interface MediaStatus {
  /** A full local copy exists. */
  local: boolean;
  /** 0…1 while uploading, otherwise null. */
  uploading: number | null;
  /** 0…1 while downloading, otherwise null. */
  downloading: number | null;
  /** A preview proxy exists on this device. */
  proxy: boolean;
  /** 0…1 while a proxy is being made, otherwise null. */
  proxying: number | null;
  error: string | null;
}

const EMPTY: MediaStatus = { local: false, uploading: null, downloading: null, proxy: false, proxying: null, error: null };
const PROXY_SUFFIX = '.proxy';
const CHUNK = 8 * 1024 * 1024;

type Listener = () => void;

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

  private async readLocal(assetId: string): Promise<File | null> {
    const mem = this.files.get(assetId);
    if (mem) return mem;
    const dir = await this.directory();
    if (!dir) return null;
    try {
      const handle = await dir.getFileHandle(assetId);
      const file = await handle.getFile();
      if (file.size === 0) return null;
      this.files.set(assetId, file);
      if (!this.get(assetId).local) this.patch(assetId, { local: true });
      return file;
    } catch {
      return null;
    }
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
        // `<id>`, `<id>.part` (download), `<id>.proxy`, `<id>.proxy.part` (proxy being written).
        let id = name;
        const part = id.endsWith('.part');
        if (part) id = id.slice(0, -5);
        const proxy = id.endsWith(PROXY_SUFFIX);
        if (proxy) id = id.slice(0, -PROXY_SUFFIX.length);
        const busy = proxy ? this.proxyJobs.has(id) : this.downloads.has(id);
        if (!keep.has(id) || (part && !busy)) stale.push(name);
      }
      for (const name of stale) await dir.removeEntry(name).catch(() => {});
    } catch {
      // Listing is best-effort; nothing depends on it.
    }
  }

  /** Store a freshly imported file. Usable immediately; the durable copy is written in the background. */
  async import(assetId: string, file: File): Promise<void> {
    this.files.set(assetId, file);
    this.patch(assetId, { local: true, error: null });
    const dir = await this.directory();
    if (!dir) return;
    try {
      const handle = await dir.getFileHandle(assetId, { create: true });
      const writable = await handle.createWritable();
      await file.stream().pipeTo(writable);
      // Re-read through OPFS so the in-memory reference no longer pins the user's original file.
      this.files.set(assetId, await handle.getFile());
    } catch (err) {
      console.warn('[media] could not persist to OPFS; keeping in memory for this session', err);
    }
  }

  async remove(assetId: string): Promise<void> {
    this.uploads.get(assetId)?.abort();
    this.downloads.get(assetId)?.abort();
    this.proxyJobs.get(assetId)?.abort();
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
    this.patch(assetId, { proxying: 0, error: null });
    const job = this.proxyQueue.then(() => this.runProxy(assetId, ctrl));
    this.proxyQueue = job.catch(() => false);
    return job;
  }

  private async runProxy(assetId: string, ctrl: AbortController): Promise<boolean> {
    const partName = `${assetId}${PROXY_SUFFIX}.part`;
    const dir = await this.directory();
    try {
      // Loaded on demand: this module is also used by the home screen, which must stay light.
      const { createProxy, ProxyCancelled } = await import('@tandem/engine');
      if (ctrl.signal.aborted) throw new ProxyCancelled();
      const source = await this.readLocal(assetId);
      if (!dir || !source) throw new Error('The original file has to be on this device to make a proxy.');
      const part = await dir.getFileHandle(partName, { create: true });
      const writable = await part.createWritable();
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
      // OPFS has no atomic rename everywhere; copy the finished part into place.
      const final = await dir.getFileHandle(assetId + PROXY_SUFFIX, { create: true });
      const out = await final.createWritable();
      await (await part.getFile()).stream().pipeTo(out);
      await dir.removeEntry(partName).catch(() => {});
      this.proxies.set(assetId, await final.getFile());
      this.patch(assetId, { proxying: null, proxy: true });
      this.onProxy(assetId);
      return true;
    } catch (err) {
      await dir?.removeEntry(partName).catch(() => {});
      if ((err as Error)?.name === 'ProxyCancelled' || ctrl.signal.aborted) this.patch(assetId, { proxying: null });
      else this.patch(assetId, { proxying: null, error: err instanceof Error ? err.message : 'Could not make a proxy' });
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

  /** Upload an asset to the server, resuming from wherever a previous attempt stopped. */
  async upload(assetId: string, mime: string): Promise<boolean> {
    const remote = this.remote;
    if (!remote || !remote.canWrite || this.uploads.has(assetId) || this.destroyed) return false;
    const file = await this.readLocal(assetId);
    if (!file) return false;
    const ctrl = new AbortController();
    this.uploads.set(assetId, ctrl);
    const url = `${serverBase()}/api/projects/${remote.projectId}/media/${assetId}`;
    const auth = { Authorization: `Bearer ${remote.token}` };
    try {
      this.patch(assetId, { uploading: 0, error: null });
      let offset = 0;
      const head = await fetch(`${url}?probe`, { method: 'HEAD', headers: auth, signal: ctrl.signal });
      if (head.ok) {
        if (head.headers.get('Upload-Complete') === '1') {
          this.patch(assetId, { uploading: null });
          this.onUploaded(assetId);
          return true;
        }
        offset = Number(head.headers.get('Upload-Offset') ?? 0) || 0;
      }
      if (offset > file.size) offset = 0;
      let attempts = 0;
      while (offset < file.size || file.size === 0) {
        const end = Math.min(file.size, offset + CHUNK);
        const res = await fetch(url, {
          method: 'PUT',
          headers: { ...auth, 'Upload-Offset': String(offset), 'Upload-Length': String(file.size), 'Content-Type': mime || 'application/octet-stream' },
          body: file.slice(offset, end),
          signal: ctrl.signal,
        });
        if (res.status === 409) {
          // The server has a different idea of where we are: follow it.
          offset = Number(res.headers.get('Upload-Offset') ?? 0) || 0;
          if (++attempts > 5) throw new Error('Upload kept desynchronising');
          continue;
        }
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        offset = Number(res.headers.get('Upload-Offset') ?? end) || end;
        this.patch(assetId, { uploading: file.size ? offset / file.size : 1 });
        if (res.headers.get('Upload-Complete') === '1' || file.size === 0) break;
      }
      this.patch(assetId, { uploading: null });
      this.onUploaded(assetId);
      return true;
    } catch (err) {
      if (ctrl.signal.aborted) this.patch(assetId, { uploading: null });
      else this.patch(assetId, { uploading: null, error: err instanceof Error ? err.message : 'Upload failed' });
      return false;
    } finally {
      this.uploads.delete(assetId);
    }
  }

  // ─────────────────────────────────────────────────────────── download ──

  /** Cache a server-hosted asset into OPFS. Safe to call repeatedly. */
  async download(assetId: string): Promise<boolean> {
    const remote = this.remote;
    if (!remote || this.downloads.has(assetId) || this.destroyed) return false;
    if (await this.readLocal(assetId)) return true;
    const dir = await this.directory();
    if (!dir) return false;
    const ctrl = new AbortController();
    this.downloads.set(assetId, ctrl);
    const partName = `${assetId}.part`;
    try {
      this.patch(assetId, { downloading: 0, error: null });
      const res = await fetch(api.mediaUrl(remote.projectId, assetId, remote.token), { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
      const total = Number(res.headers.get('Content-Length') ?? 0);
      const part = await dir.getFileHandle(partName, { create: true });
      const writable = await part.createWritable();
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
      // OPFS has no atomic rename everywhere; copy the finished part into place.
      const done = await part.getFile();
      const final = await dir.getFileHandle(assetId, { create: true });
      const out = await final.createWritable();
      await done.stream().pipeTo(out);
      await dir.removeEntry(partName).catch(() => {});
      this.files.set(assetId, await final.getFile());
      this.patch(assetId, { downloading: null, local: true });
      this.onLocal(assetId);
      return true;
    } catch (err) {
      await dir.removeEntry(partName).catch(() => {});
      if (ctrl.signal.aborted) this.patch(assetId, { downloading: null });
      else this.patch(assetId, { downloading: null, error: err instanceof Error ? err.message : 'Download failed' });
      return false;
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
  try {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('tandem', { create: true });
    await app.removeEntry(projectId, { recursive: true });
  } catch {
    /* nothing stored */
  }
}

/** Move a project's locally stored media under a new project id (used when publishing). */
export async function moveProjectMedia(fromId: string, toId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('tandem', { create: true });
    const from = await app.getDirectoryHandle(fromId).catch(() => null);
    if (!from) return;
    const to = await app.getDirectoryHandle(toId, { create: true });
    const entries = (from as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind !== 'file') continue;
      const file = handle as FileSystemFileHandle & { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> };
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
