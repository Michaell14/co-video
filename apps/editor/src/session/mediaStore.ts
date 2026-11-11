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
  error: string | null;
}

const EMPTY: MediaStatus = { local: false, uploading: null, downloading: null, error: null };
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
  private destroyed = false;
  private version = 0;

  /** Called when an asset becomes available locally (so decoders can switch to the fast path). */
  onLocal: (assetId: string) => void = () => {};
  /** Called when an upload completes. */
  onUploaded: (assetId: string) => void = () => {};

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

  /** Scan OPFS so `local` flags are right before anything asks. */
  async init(assetIds: string[]): Promise<void> {
    await Promise.all(assetIds.map((id) => this.readLocal(id)));
    void navigator.storage?.persist?.().catch(() => false);
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
    this.files.delete(assetId);
    this.status.delete(assetId);
    const dir = await this.directory();
    await dir?.removeEntry(assetId).catch(() => {});
  }

  /** Bytes used by this project's local media. */
  async usage(): Promise<number> {
    let total = 0;
    for (const f of this.files.values()) total += f.size;
    return total;
  }

  // ─────────────────────────────────────────────────────────── resolver ──

  /** `uploaded(assetId)` tells whether the server has the complete file. */
  resolver(uploaded: (assetId: string) => boolean): MediaResolver {
    return async (assetId): Promise<MediaLocation | null> => {
      const local = await this.readLocal(assetId);
      if (local) return { blob: local };
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
