/**
 * Session: everything that exists while one project is open — the CRDT documents, their local
 * persistence, the network connection, presence, media storage and the player.
 */
import { IndexeddbPersistence } from 'y-indexeddb';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  canComment,
  canEdit,
  framesToSeconds,
  newId,
  ProjectStore,
  ReviewStore,
  sequenceEnd,
  type Asset,
  type Edit,
  type PresenceState,
  type PresenceUser,
  type Project,
  type Role,
} from '@tandem/core';
import { Player, probeFile, proxySize, type MediaResolver } from '@tandem/engine';
import { useUI } from '../state/ui';
import { toast } from '../ui/core';
import { api, serverAvailable, wsBase } from './api';
import { TimelineMedia } from '../features/timeline/mediaCache';
import { MediaStore, moveProjectMedia } from './mediaStore';
import { idbName, whenSynced } from './projects';
import { getUser, registry, setUser } from './registry';
import { SyncProvider, type SyncStatus } from './sync';

type Listener = () => void;

export interface SessionMeta {
  role: Role;
  status: SyncStatus;
  /** A collaboration server is reachable. */
  online: boolean;
  /** The project is shared (has a server-side room). */
  shared: boolean;
  /** Remote state has been merged at least once since connecting. */
  synced: boolean;
  player: Player | null;
  user: PresenceUser;
  denied: boolean;
  /** Preview from proxy media where it exists (a per-device preference). */
  proxies: boolean;
}

const PROXY_PREF = 'tandem.proxies';

function readProxyPref(): boolean {
  try {
    return localStorage.getItem(PROXY_PREF) !== '0';
  } catch {
    return true;
  }
}

export class Session {
  readonly doc = new Y.Doc();
  readonly reviewDoc = new Y.Doc();
  readonly store: ProjectStore;
  readonly review: ReviewStore;
  readonly awareness: Awareness;
  readonly media: MediaStore;
  /** Filmstrip and waveform caches for the timeline. */
  readonly thumbs: TimelineMedia;
  token: string | null = null;

  private meta: SessionMeta;
  private listeners = new Set<Listener>();
  private idb: IndexeddbPersistence[] = [];
  private providers: SyncProvider[] = [];
  private unsubs: (() => void)[] = [];
  private registryTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: Partial<PresenceState> = {};
  private mediaTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private constructor(readonly id: string) {
    this.store = new ProjectStore(this.doc);
    this.review = new ReviewStore(this.reviewDoc);
    this.awareness = new Awareness(this.doc);
    this.media = new MediaStore(id);
    this.thumbs = new TimelineMedia(this.previewResolver());
    this.meta = { role: 'owner', status: 'offline', online: false, shared: false, synced: false, player: null, user: getUser(), denied: false, proxies: readProxyPref() };
  }

  /** Where the player and the timeline thumbnails read media: proxies allowed. */
  private previewResolver(): MediaResolver {
    return this.media.resolver(
      (assetId) => !!this.store.get().assets[assetId]?.uploaded,
      // HDR sources are decoded at full bit depth; an 8-bit proxy would throw that away.
      (assetId) => this.meta.proxies && !this.store.get().assets[assetId]?.hdr,
    );
  }

  /** Where exports and stills read media: always the originals. */
  exportResolver(): MediaResolver {
    return this.media.resolver((assetId) => !!this.store.get().assets[assetId]?.uploaded);
  }

  // ─────────────────────────────────────────────────────────────── proxies ──

  /** Whether a proxy would help: a local SDR video noticeably larger than a preview. */
  canProxy(asset: Asset): boolean {
    return asset.kind === 'video' && !asset.hdr && this.media.get(asset.id).local && proxySize(asset.width, asset.height) !== null;
  }

  async createProxy(assetId: string): Promise<boolean> {
    const asset = this.store.get().assets[assetId];
    if (!asset || !this.canProxy(asset)) return false;
    return this.media.buildProxy(assetId);
  }

  /** Queue proxies for every asset that would benefit and has none. Returns how many were queued. */
  createProxies(): number {
    let n = 0;
    for (const asset of Object.values(this.store.get().assets)) {
      const st = this.media.get(asset.id);
      if (!this.canProxy(asset) || st.proxy || st.proxying !== null) continue;
      void this.media.buildProxy(asset.id);
      n++;
    }
    return n;
  }

  setProxies(on: boolean): void {
    if (on === this.meta.proxies) return;
    try {
      localStorage.setItem(PROXY_PREF, on ? '1' : '0');
    } catch {
      // Private mode: the choice lasts for this session only.
    }
    this.setMeta({ proxies: on });
    for (const id of Object.keys(this.store.get().assets)) if (this.media.get(id).proxy) this.refreshMedia(id);
  }

  private refreshMedia(assetId: string): void {
    this.meta.player?.refreshAsset(assetId);
    this.thumbs.refresh(assetId);
  }

  // ───────────────────────────────────────────────────────────── lifecycle ──

  static async open(id: string, urlToken: string | null): Promise<Session> {
    const session = new Session(id);
    await session.init(urlToken);
    return session;
  }

  private async init(urlToken: string | null): Promise<void> {
    const pIdb = new IndexeddbPersistence(idbName(this.id, 'project'), this.doc);
    const rIdb = new IndexeddbPersistence(idbName(this.id, 'review'), this.reviewDoc);
    this.idb = [pIdb, rIdb];
    await Promise.all([whenSynced(pIdb), whenSynced(rIdb)]);

    const entry = registry.get(this.id);
    this.token = urlToken ?? entry?.token ?? null;
    if (urlToken && urlToken !== entry?.token) registry.upsert({ id: this.id, token: urlToken });

    // Only a document we know (loaded from this device, with content) may decide what is orphaned.
    await this.media.init(Object.keys(this.store.get().assets), !this.store.isEmpty());
    this.media.onUploaded = (assetId) => {
      if (this.store.get().assets[assetId]) {
        this.store.commit([{ op: 'updateAsset', id: assetId, patch: { uploaded: true } }], { undoable: false });
      }
    };
    this.media.onLocal = (assetId) => this.refreshMedia(assetId);
    this.media.onProxy = (assetId) => {
      if (this.meta.proxies) this.refreshMedia(assetId);
    };

    this.awareness.setLocalState({
      user: this.meta.user,
      role: this.meta.role,
      playhead: 0,
      playing: false,
      selection: [],
      cursor: null,
      dragging: null,
      page: 'edit',
    } satisfies PresenceState);

    this.unsubs.push(
      this.store.subscribe(() => {
        this.pushProjectToPlayer();
        this.scheduleRegistry();
        this.scheduleMediaSync();
      }),
      useUI.subscribe((s, prev) => {
        if (s.preview !== prev.preview) this.pushProjectToPlayer();
        if (s.selection !== prev.selection) this.setPresence({ selection: s.selection });
        if (s.workspace !== prev.workspace) this.setPresence({ page: s.workspace });
      }),
    );

    const online = await serverAvailable();
    this.setMeta({ online });
    if (online && this.token) await this.connect();
    else if (!entry && !this.token) {
      // Unknown project, no way to fetch it.
      if (this.store.isEmpty()) this.setMeta({ denied: true });
    }
    this.scheduleRegistry();
    this.scheduleMediaSync();
  }

  private async connect(): Promise<void> {
    const token = this.token;
    if (!token || this.providers.length) return;
    try {
      const info = await api.projectInfo(this.id, token);
      this.setMeta({ role: info.role, shared: true });
    } catch (err) {
      console.warn('[session] project not reachable on server', err);
      if (this.store.isEmpty()) this.setMeta({ denied: true });
      return;
    }
    this.awareness.setLocalStateField('role', this.meta.role);
    this.media.setRemote({ projectId: this.id, token, canWrite: canEdit(this.meta.role) });
    const q = `?t=${encodeURIComponent(token)}`;
    const project = new SyncProvider(`${wsBase()}/ws/${this.id}/project${q}`, this.doc, {
      awareness: this.awareness,
      onStatus: (status) => this.setMeta({ status, synced: status === 'connected' ? this.meta.synced : false }),
      onSynced: () => {
        this.setMeta({ synced: true });
        this.scheduleMediaSync();
      },
      onControl: (msg) => {
        if (msg.type === 'hello' && msg.role && msg.role !== this.meta.role) {
          this.setMeta({ role: msg.role });
          this.awareness.setLocalStateField('role', msg.role);
        }
      },
      onDenied: () => {
        if (this.store.isEmpty()) this.setMeta({ denied: true });
      },
    });
    const review = new SyncProvider(`${wsBase()}/ws/${this.id}/review${q}`, this.reviewDoc);
    this.providers = [project, review];
  }

  /**
   * Publish a local-only project to the collaboration server. The server assigns a new id, so the
   * project (documents and media) is moved under it. Returns the new id to navigate to.
   */
  async publish(): Promise<string> {
    if (this.meta.shared) return this.id;
    if (!(await serverAvailable(true))) throw new Error('No collaboration server is reachable.');
    const name = this.store.get().settings.name;
    const { id, token } = await api.createProject(name);
    for (const [kind, doc] of [
      ['project', this.doc],
      ['review', this.reviewDoc],
    ] as const) {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      const idb = new IndexeddbPersistence(idbName(id, kind), copy);
      await whenSynced(idb);
      await new Promise((r) => setTimeout(r, 80));
      await idb.destroy();
      copy.destroy();
    }
    await moveProjectMedia(this.id, id);
    const s = this.store.get().settings;
    registry.upsert({ id, name, token, width: s.width, height: s.height, fps: s.fpsNum / s.fpsDen });
    return id;
  }

  async inviteLink(role: Role): Promise<string> {
    if (!this.token) throw new Error('This project is not shared.');
    const { token } = await api.invite(this.id, this.token, role);
    const url = new URL(location.href);
    url.hash = `#/p/${this.id}?t=${encodeURIComponent(token)}`;
    return url.toString();
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    if (this.registryTimer) clearTimeout(this.registryTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    this.flushRegistry();
    this.meta.player?.dispose();
    for (const p of this.providers) p.destroy();
    this.awareness.destroy();
    for (const i of this.idb) void i.destroy();
    this.media.destroy();
    this.thumbs.dispose();
    this.store.destroy();
    this.review.destroy();
    this.doc.destroy();
    this.reviewDoc.destroy();
    this.listeners.clear();
  }

  // ──────────────────────────────────────────────────────────────── meta ──

  getMeta = (): SessionMeta => this.meta;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private setMeta(patch: Partial<SessionMeta>): void {
    this.meta = { ...this.meta, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
  }

  get canEdit(): boolean {
    return canEdit(this.meta.role);
  }

  get canComment(): boolean {
    return canComment(this.meta.role);
  }

  get player(): Player | null {
    return this.meta.player;
  }

  renameUser(name: string, color?: string): void {
    const user = { ...this.meta.user, name: name.trim() || this.meta.user.name, color: color ?? this.meta.user.color };
    setUser(user);
    this.setMeta({ user });
    this.awareness.setLocalStateField('user', user);
  }

  // ────────────────────────────────────────────────────────────── player ──

  /** The project as it should currently be drawn (including an in-flight drag preview). */
  effectiveProject(): Project {
    return useUI.getState().preview ?? this.store.get();
  }

  attachCanvas(canvas: HTMLCanvasElement): Player {
    this.meta.player?.dispose();
    const player = new Player(canvas, this.effectiveProject(), this.previewResolver());
    let last = -1;
    player.onFrame((frame) => {
      // Presence updates are throttled; a frame-accurate playhead is not needed by peers.
      if (frame !== last) {
        last = frame;
        this.setPresence({ playhead: frame });
      }
    });
    player.subscribe(() => this.setPresence({ playing: player.getState().playing }));
    this.setMeta({ player });
    return player;
  }

  detachCanvas(): void {
    this.meta.player?.dispose();
    this.setMeta({ player: null });
  }

  private pushProjectToPlayer(): void {
    this.meta.player?.setProject(this.effectiveProject());
  }

  // ──────────────────────────────────────────────────────────── presence ──

  /** Merge fields into our presence. Coalesced to ~12 updates a second. */
  setPresence(patch: Partial<PresenceState>): void {
    Object.assign(this.pendingPresence, patch);
    if (this.presenceTimer || this.destroyed) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const cur = this.awareness.getLocalState() as PresenceState | null;
      if (!cur) return;
      const next = { ...cur, ...this.pendingPresence };
      this.pendingPresence = {};
      this.awareness.setLocalState(next);
    }, 80);
  }

  // ─────────────────────────────────────────────────────────────── media ──

  /** Import files into the media pool. Returns the created assets. */
  async importFiles(files: File[], folderId: string | null = null): Promise<Asset[]> {
    if (!this.canEdit) {
      toast('You have view-only access to this project.', 'error');
      return [];
    }
    const created: Asset[] = [];
    for (const file of files) {
      try {
        const probe = await probeFile(file);
        const asset: Asset = {
          ...probe.asset,
          id: newId(),
          folderId,
          createdAt: Date.now(),
          createdBy: this.meta.user.name,
          uploaded: false,
        };
        await this.media.import(asset.id, file);
        created.push(asset);
        for (const w of probe.warnings) toast(w, 'error');
      } catch (err) {
        toast(err instanceof Error ? err.message : `Could not import ${file.name}`, 'error');
      }
    }
    if (created.length) {
      this.store.commit(created.map((asset) => ({ op: 'addAsset' as const, asset })));
      this.scheduleMediaSync();
    }
    return created;
  }

  /**
   * Swap the file behind an asset (relink offline media, or replace a shot with a new version).
   * The new file becomes a new asset and every clip is repointed in the same undo step, so
   * collaborators fetch the new media instead of keeping a stale copy under the old id.
   */
  async replaceAsset(assetId: string, file: File): Promise<Asset | null> {
    const old = this.store.get().assets[assetId];
    if (!old) return null;
    if (!this.canEdit) {
      toast('You have view-only access to this project.', 'error');
      return null;
    }
    try {
      const probe = await probeFile(file);
      if (probe.asset.kind !== old.kind) {
        toast(`"${file.name}" is ${probe.asset.kind}, but "${old.name}" is ${old.kind}.`, 'error');
        return null;
      }
      const asset: Asset = {
        ...probe.asset,
        id: newId(),
        folderId: old.folderId,
        createdAt: Date.now(),
        createdBy: this.meta.user.name,
        uploaded: false,
      };
      await this.media.import(asset.id, file);
      const p = this.store.get();
      const edits: Edit[] = [{ op: 'addAsset', asset }];
      for (const c of Object.values(p.clips)) {
        if (c.assetId === assetId) edits.push({ op: 'updateClip', id: c.id, patch: { assetId: asset.id } });
        else if (c.grade?.lutId === assetId) edits.push({ op: 'updateClip', id: c.id, patch: { grade: { ...c.grade, lutId: asset.id } } });
      }
      edits.push({ op: 'removeAsset', id: assetId });
      this.store.commit(edits);
      this.scheduleMediaSync();
      for (const w of probe.warnings) toast(w, 'error');
      if (old.duration > 0 && asset.duration > 0 && asset.duration < old.duration - 0.05) {
        toast('The new file is shorter than the old one; clips that run past its end will hold the last frame.');
      }
      return asset;
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not import ${file.name}`, 'error');
      return null;
    }
  }

  private scheduleMediaSync(): void {
    if (this.mediaTimer || this.destroyed) return;
    this.mediaTimer = setTimeout(() => {
      this.mediaTimer = null;
      void this.syncMedia();
    }, 500);
  }

  /** Upload what only we have; fetch what only the server has. */
  private async syncMedia(): Promise<void> {
    if (!this.meta.shared || this.destroyed) return;
    const assets = Object.values(this.store.get().assets);
    for (const a of assets) {
      const st = this.media.get(a.id);
      if (st.local && !a.uploaded && this.canEdit && st.uploading === null && !st.error) {
        void this.media.upload(a.id, a.mime);
      } else if (!st.local && a.uploaded && st.downloading === null && !st.error) {
        // Stills and LUTs are fetched whole by the engine anyway; cache timed media up to 4 GB.
        if (a.size < 4 * 1024 ** 3) void this.media.download(a.id);
      }
    }
  }

  // ──────────────────────────────────────────────────────────── registry ──

  private scheduleRegistry(): void {
    if (this.registryTimer || this.destroyed) return;
    this.registryTimer = setTimeout(() => {
      this.registryTimer = null;
      this.flushRegistry();
    }, 1500);
  }

  private flushRegistry(): void {
    const p = this.store.get();
    if (this.store.isEmpty()) return;
    const s = p.settings;
    const firstThumb = Object.values(p.assets).find((a) => a.thumb)?.thumb ?? null;
    registry.upsert({
      id: this.id,
      name: s.name,
      width: s.width,
      height: s.height,
      fps: s.fpsNum / s.fpsDen,
      duration: framesToSeconds(sequenceEnd(p), s),
      thumb: firstThumb,
      updatedAt: Date.now(),
      token: this.token,
    });
  }
}
