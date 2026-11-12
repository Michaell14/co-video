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
  fpsOf,
  framesToSeconds,
  newId,
  ProjectStore,
  ReviewStore,
  sequenceEnd,
  type Asset,
  type ControlMessage,
  type DocKind,
  type Edit,
  type PresenceState,
  type PresenceUser,
  type Project,
  type Role,
} from '@tandem/core';
import { Player, probeFile, proxySize, type MediaResolver } from '@tandem/engine';
import { useUI } from '../state/ui';
import { toast } from '../ui/core';
import { chooseAccess, claimedRole, entryFate, type Verdict } from './access';
import { api, ApiError, isRefusal, serverAvailable, wsBase } from './api';
import { retimeView } from '../features/inspector/frameRate';
import { TimelineMedia } from '../features/timeline/mediaCache';
import { MediaStore, moveProjectMedia } from './mediaStore';
import { idbName, whenSynced } from './projects';
import { getUser, registry, setUser } from './registry';
import { SyncProvider, type SyncStatus } from './sync';
import { byUrgency, TransferQueue, type Transfer } from './transfers';

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
  /** The project was taken off the project list: its link was refused and nothing of it is here. */
  unlisted: boolean;
  /** The server accepts our link but has no place for us right now; we keep trying. */
  busy: boolean;
  /** Preview from proxy media where it exists (a per-device preference). */
  proxies: boolean;
}

const PROXY_PREF = 'tandem.proxies';
/** How long the server gets to say what a token is worth before the attempt counts as failed. */
const ACCESS_TIMEOUT_MS = 8000;
/** A copy thrown away twice in this time is not being repaired by reloading it; see `discardLocalCopy`. */
const DISCARD_AGAIN_MS = 60_000;
const discarded = new Map<string, number>();

const ACCESS_NAME: Record<Role, string> = {
  owner: 'owner',
  editor: 'edit',
  commenter: 'comment-only',
  viewer: 'view-only',
};

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
  /** The token this session talks to the server with. */
  token: string | null = null;
  /** Called when the local copy was thrown away and the project has to be opened afresh. */
  onReload: () => void = () => {};
  /** Called when the server has judged the link this session was opened with. */
  onLinkJudged: () => void = () => {};

  /** The token of the link this session was opened with, until the server has had its say on it. */
  private offered: string | null = null;
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
  /** Aborted when the session closes, so no request outlives it. */
  private readonly closing = new AbortController();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;
  private connecting = false;
  private probing = false;
  private reloading = false;
  /** The server rejected this link (bad token, deleted project): retrying will not help. */
  private refused = false;
  private readonly transfers: TransferQueue;
  /** Assets the server is known to hold, to notice the moment it holds one more. */
  private readonly uploaded = new Set<string>();
  private assetsSeen: Project['assets'] | null = null;

  private constructor(readonly id: string) {
    this.store = new ProjectStore(this.doc);
    this.review = new ReviewStore(this.reviewDoc);
    this.awareness = new Awareness(this.doc);
    this.media = new MediaStore(id);
    this.thumbs = new TimelineMedia(this.previewResolver());
    this.transfers = new TransferQueue((t) =>
      t.kind === 'upload'
        ? this.media.upload(t.assetId, this.store.get().assets[t.assetId]?.mime ?? '')
        : this.media.download(t.assetId),
    );
    this.meta = {
      role: 'owner',
      status: 'offline',
      online: false,
      shared: false,
      synced: false,
      player: null,
      user: getUser(),
      denied: false,
      unlisted: false,
      busy: false,
      proxies: readProxyPref(),
    };
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
    return (
      asset.kind === 'video' &&
      !asset.hdr &&
      this.media.get(asset.id).local &&
      proxySize(asset.width, asset.height) !== null
    );
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
    for (const id of Object.keys(this.store.get().assets))
      if (this.media.get(id).proxy) this.refreshMedia(id);
  }

  private refreshMedia(assetId: string): void {
    this.meta.player?.refreshAsset(assetId);
    this.thumbs.refresh(assetId);
  }

  /**
   * When the server comes to hold an asset this device has no copy of (a collaborator's upload
   * finished), the engine has to ask for it again: all it was ever told is that it is unavailable.
   */
  private noteUploads(): void {
    const assets = this.store.get().assets;
    if (assets === this.assetsSeen) return;
    const first = this.assetsSeen === null;
    this.assetsSeen = assets;
    for (const a of Object.values(assets)) {
      if (!a.uploaded || this.uploaded.has(a.id)) continue;
      this.uploaded.add(a.id);
      if (!first && !this.media.get(a.id).local) this.refreshMedia(a.id);
    }
  }

  /**
   * A frame rate changed by someone else (their edit, their undo, a version they restored) re-times
   * the project under what this device counts in frames. Its playhead, marked range and zoom follow
   * by the same ratio, as they do for whoever made the change (see features/inspector/frameRate.ts),
   * so this view stays on the same moment of the programme. Changes made here are not followed
   * twice: only transactions that came from outside count.
   */
  private followFrameRate(): void {
    let before: { fps: number; frame: number | null } | null = null;
    const onBefore = (tr: Y.Transaction): void => {
      // A document that is still empty is being loaded, not re-timed.
      before =
        tr.local || this.store.isEmpty()
          ? null
          : { fps: fpsOf(this.store.get().settings), frame: this.meta.player?.getFrame() ?? null };
    };
    // Registered after the store's own listener, so the player has the re-timed project by now. It
    // may have pulled the playhead inside a sequence of fewer frames: hence the frame from before.
    const onAfter = (tr: Y.Transaction): void => {
      if (tr.local || !before) return;
      const k = fpsOf(this.store.get().settings) / before.fps;
      if (Math.abs(k - 1) > 1e-9) retimeView(this, k, before.frame);
      before = null;
    };
    this.doc.on('beforeTransaction', onBefore);
    this.doc.on('afterTransaction', onAfter);
    this.unsubs.push(() => {
      this.doc.off('beforeTransaction', onBefore);
      this.doc.off('afterTransaction', onAfter);
    });
  }

  /**
   * A lock puts a track's clips out of reach of every edit, so they do not stay selected either:
   * not when the track is locked under them, and not as the linked partner of a clip that is free.
   * Returns true when it had to change the selection.
   */
  private keepSelectionUnlocked(): boolean {
    const p = this.store.get();
    const { selection, set } = useUI.getState();
    const free = selection.filter((id) => !p.tracks[p.clips[id]?.trackId]?.locked);
    if (free.length === selection.length) return false;
    set({ selection: free });
    return true;
  }

  // ───────────────────────────────────────────────────────────── lifecycle ──

  /**
   * Open a project. Aborting `cancel` closes the session, also while it is still opening: whatever
   * it was waiting for is then dropped instead of being carried through for a project nobody has
   * open any more.
   */
  static async open(id: string, urlToken: string | null, cancel?: AbortSignal): Promise<Session> {
    const session = new Session(id);
    cancel?.addEventListener('abort', () => session.destroy());
    await session.init(urlToken);
    return session;
  }

  private async init(urlToken: string | null): Promise<void> {
    const pIdb = new IndexeddbPersistence(idbName(this.id, 'project'), this.doc);
    const rIdb = new IndexeddbPersistence(idbName(this.id, 'review'), this.reviewDoc);
    this.idb = [pIdb, rIdb];
    await Promise.all([whenSynced(pIdb), whenSynced(rIdb)]);
    if (this.destroyed) return;

    // A link is a claim until the server confirms it. Until then the session runs on what this
    // device already knows: the stored token and the role it was last confirmed to carry.
    const entry = registry.get(this.id);
    const stored = entry?.token ?? null;
    this.offered = urlToken && urlToken !== stored ? urlToken : null;
    this.token = stored ?? (entry ? null : this.offered);
    this.meta = {
      ...this.meta,
      // Nobody but the server can vouch for a role, so one that was never confirmed counts as the
      // least: a viewer who opens a cached project offline must not get an editor's tools.
      role: stored ? (entry?.role ?? claimedRole(stored) ?? 'viewer') : this.token ? 'viewer' : 'owner',
      shared: this.token !== null,
    };

    // Only a document we know (loaded from this device, with content) may decide what is orphaned.
    await this.media.init(Object.keys(this.store.get().assets), !this.store.isEmpty());
    if (this.destroyed) return;
    this.media.onUploaded = (assetId) => {
      if (this.store.get().assets[assetId]) {
        this.store.commit([{ op: 'updateAsset', id: assetId, patch: { uploaded: true } }], {
          undoable: false,
        });
      }
    };
    this.media.onLocal = (assetId) => this.refreshMedia(assetId);
    this.media.onProxy = (assetId) => {
      if (this.meta.proxies) this.refreshMedia(assetId);
    };
    this.noteUploads();

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

    this.followFrameRate();
    this.unsubs.push(
      this.store.subscribe(() => {
        this.pushProjectToPlayer();
        this.noteUploads();
        this.keepSelectionUnlocked();
        this.scheduleRegistry();
        this.scheduleMediaSync();
      }),
      useUI.subscribe((s, prev) => {
        if (s.preview !== prev.preview) this.pushProjectToPlayer();
        if (s.selection !== prev.selection) {
          // Dropping a locked clip sets the selection again, and that round does the rest.
          if (this.keepSelectionUnlocked()) return;
          this.setPresence({ selection: s.selection });
        }
        if (s.workspace !== prev.workspace) this.setPresence({ page: s.workspace });
      }),
    );

    const online = await serverAvailable();
    if (this.destroyed) return;
    this.setMeta({ online });
    if (online && (this.token || this.offered)) await this.connect();
    else if (!entry && !this.token) {
      // Unknown project, no way to fetch it.
      if (this.store.isEmpty()) this.setMeta({ denied: true });
    }
    if (this.destroyed) return;
    // Opened with no network (or a server that was down): keep knocking.
    if (this.token && !online && this.store.isEmpty()) this.setMeta({ denied: true });
    this.scheduleReconnect();
    const onNetwork = (): void => {
      this.reconnectDelay = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.transfers.retryNow();
      if (this.token || this.offered) this.scheduleReconnect();
      else
        void serverAvailable(true).then(
          (up) => !this.destroyed && up !== this.meta.online && this.setMeta({ online: up }),
        );
    };
    window.addEventListener('online', onNetwork);
    this.unsubs.push(() => window.removeEventListener('online', onNetwork));
    this.scheduleRegistry();
    this.scheduleMediaSync();
  }

  /**
   * A shared project that is not connected yet (opened offline, or the server was unreachable)
   * retries with a growing delay until it is, or until the server refuses the link outright.
   */
  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer || this.providers.length || this.refused) return;
    if (!this.token && !this.offered) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void (async () => {
        const online = await serverAvailable(true);
        if (this.destroyed) return;
        if (online !== this.meta.online) this.setMeta({ online });
        if (online) await this.connect();
        this.reconnectDelay = Math.min(30_000, Math.max(2000, this.reconnectDelay * 1.6));
        this.scheduleReconnect();
      })();
    }, this.reconnectDelay);
  }

  private async connect(): Promise<void> {
    // One attempt at a time: the network coming back must not start a second one beside it.
    if (this.connecting || this.providers.length || this.destroyed || this.reloading) return;
    this.connecting = true;
    try {
      const access = await this.settleAccess();
      // The project may have been closed while the server was thinking.
      if (access && !this.destroyed) this.openRooms(access.token);
    } finally {
      this.connecting = false;
    }
  }

  /** Ask the server what a token allows on this project. */
  private async ask(token: string): Promise<Verdict> {
    try {
      const signal = AbortSignal.any([this.closing.signal, AbortSignal.timeout(ACCESS_TIMEOUT_MS)]);
      const info = await api.projectInfo(this.id, token, signal);
      return { token, role: info.role };
    } catch (err) {
      // Only a real refusal is final; a network failure or a busy server is asked again later.
      if (err instanceof ApiError && isRefusal(err.status)) return 'refused';
      if (!this.destroyed) console.warn('[session] project not reachable on server', err);
      return 'unreachable';
    }
  }

  /**
   * Have the server judge the stored token and the one the link offered, and settle on the better.
   * Only a token it accepted is ever stored, so a mistyped or lesser link cannot replace the access
   * this device already has, and a refused link leaves no trace in the project list.
   */
  private async settleAccess(): Promise<{ token: string; role: Role } | null> {
    const stored = registry.get(this.id)?.token ?? null;
    const [kept, link] = await Promise.all([
      stored ? this.ask(stored) : null,
      this.offered ? this.ask(this.offered) : null,
    ]);
    if (this.destroyed) return null;
    if (kept === 'unreachable' || link === 'unreachable') {
      // Nothing local to show either; a later attempt clears this.
      if (this.store.isEmpty()) this.setMeta({ denied: true });
      return null;
    }
    const { granted, offered } = chooseAccess(kept, link);
    if (this.offered) {
      this.offered = null;
      this.onLinkJudged();
    }
    if (offered === 'refused' && (granted || !this.store.isEmpty())) {
      toast(
        granted
          ? 'That link is not valid for this project. You still have the access you had before.'
          : 'That link is not valid for this project.',
        'error',
      );
    } else if (offered === 'surplus' && granted && link && link !== 'refused' && link.role !== granted.role) {
      toast(
        `You already have ${ACCESS_NAME[granted.role]} access to this project, so the ${ACCESS_NAME[link.role]} link changes nothing.`,
      );
    }
    if (!granted) {
      this.loseAccess(kept);
      return null;
    }
    this.token = granted.token;
    registry.upsert({ id: this.id, token: granted.token, role: granted.role });
    this.setMeta({ shared: true, denied: false });
    this.applyRole(granted.role);
    return granted;
  }

  /**
   * The server will not have any token we hold: stop asking, and say what that means here. What is
   * on this device is from now on a copy of its own, and whoever holds it may work on it. `stored`
   * is the server's answer about the token the project list holds, if it holds one.
   */
  private loseAccess(stored: Verdict | null): void {
    this.refused = true;
    this.token = null;
    // A refusal is final, so the link goes from the project list: kept there, every later visit
    // would offer it to the server again and end in this same message.
    const fate = entryFate(stored, { loaded: this.idb[0]?.synced === true, empty: this.store.isEmpty() });
    if (this.store.isEmpty()) {
      // With nothing here to open either, the whole entry goes.
      if (fate === 'forget') registry.remove(this.id);
      this.setMeta({ denied: true, unlisted: fate === 'forget' });
    } else if (this.meta.shared) {
      if (fate === 'unlink') registry.upsert({ id: this.id, token: null, role: undefined });
      this.setMeta({ shared: false });
      this.applyRole('owner');
      toast(
        'The collaboration server no longer accepts your link to this project. Your copy stays on this device and does not sync.',
        'error',
      );
    }
  }

  private applyRole(role: Role): void {
    if (role !== this.meta.role) this.setMeta({ role });
    this.awareness.setLocalStateField('role', role);
    if (!this.token) return;
    if (registry.get(this.id)?.role !== role) registry.upsert({ id: this.id, role });
    if (this.media.connected) {
      this.media.setRemote({ projectId: this.id, token: this.token, canWrite: canEdit(role) });
    }
  }

  private openRooms(token: string): void {
    this.media.setRemote({ projectId: this.id, token, canWrite: canEdit(this.meta.role) });
    const q = `?t=${encodeURIComponent(token)}`;
    const project = new SyncProvider(`${wsBase()}/ws/${this.id}/project${q}`, this.doc, {
      awareness: this.awareness,
      onStatus: (status) => {
        const connected = status === 'connected';
        // An open socket settles what the failed attempts before it left in doubt.
        const settled = connected ? { online: true, busy: false, denied: false } : null;
        this.setMeta({ status, synced: connected ? this.meta.synced : false, ...settled });
      },
      onSynced: () => {
        this.setMeta({ synced: true });
        this.transfers.retryNow();
        this.scheduleMediaSync();
      },
      onControl: (msg) => this.onControl('project', msg),
      onRefused: () => void this.whyRefused(),
      onDisplaced: () => {
        this.setMeta({ busy: true });
        toast(
          'This project is full, and your place went to someone who can edit it. Rejoining as soon as there is room…',
        );
      },
    });
    const review = new SyncProvider(`${wsBase()}/ws/${this.id}/review${q}`, this.reviewDoc, {
      onControl: (msg) => this.onControl('review', msg),
    });
    this.providers = [project, review];
    // Until now the engine was told that media on the server is out of reach, and it remembers.
    for (const a of Object.values(this.store.get().assets)) {
      if (a.uploaded && !this.media.get(a.id).local) this.refreshMedia(a.id);
    }
    this.scheduleMediaSync();
  }

  private closeRooms(): void {
    for (const p of this.providers) p.destroy();
    this.providers = [];
    this.media.setRemote(null);
    this.setMeta({ status: 'offline', synced: false, busy: false });
  }

  private onControl(kind: DocKind, msg: ControlMessage): void {
    if (msg.role && msg.role !== this.meta.role) this.applyRole(msg.role);
    if (msg.type === 'readonly') void this.discardLocalCopy(kind);
  }

  /**
   * The project socket keeps failing to open, and a browser cannot see why. So ask over HTTP: if
   * the link is still good, the server is at capacity (too many connections from this address, or
   * a full room) and knocking again will get us in; if it is not, the link has been withdrawn.
   */
  private async whyRefused(): Promise<void> {
    if (this.probing || this.destroyed || !this.token) return;
    this.probing = true;
    const verdict = await this.ask(this.token);
    this.probing = false;
    if (this.destroyed || !this.providers.length) return;
    if (verdict === 'refused') {
      this.closeRooms();
      // What the server refused is the token it accepted for this session: the one that is stored.
      this.loseAccess(verdict);
    } else if (verdict === 'unreachable') {
      if (this.store.isEmpty()) this.setMeta({ denied: true, online: false });
    } else if (!this.meta.busy) {
      this.setMeta({ busy: true, denied: false });
      if (!this.store.isEmpty()) toast('The collaboration server is busy. Still trying to connect…');
    }
  }

  /**
   * The server would not take changes this device made to a document it may only read: they were
   * made while the role was not known, or behind the interface's back. They live on in the local
   * copy, which now differs from what everyone else has, and a CRDT cannot take them back out. So
   * the copy is dropped and the project is opened again from the server's state.
   */
  private async discardLocalCopy(kind: DocKind): Promise<void> {
    if (this.reloading || this.destroyed) return;
    const key = `${this.id}:${kind}`;
    const again = performance.now() - (discarded.get(key) ?? -Infinity) < DISCARD_AGAIN_MS;
    discarded.set(key, performance.now());
    if (again) {
      // Reloading did not make the copy match, so doing it again would only loop.
      console.warn(`[session] the server keeps rejecting local changes to the ${kind} document`);
      return;
    }
    this.reloading = true;
    toast(
      `Changes made here were not saved: you have ${ACCESS_NAME[this.meta.role]} access. Loading the shared version…`,
      'error',
    );
    this.closeRooms();
    // Another tab holding the same database open delays the deletion; do not wait on it for ever.
    // (Reopening queues behind the deletion either way, so the stale copy is never read back.)
    const idb = this.idb[kind === 'project' ? 0 : 1];
    await Promise.race([idb.clearData(), new Promise((r) => setTimeout(r, 2000))]);
    if (!this.destroyed) this.onReload();
  }

  /**
   * Publish a local-only project to the collaboration server. The server assigns a new id, so the
   * project (documents and media) is moved under it. Returns the new id to navigate to.
   */
  async publish(): Promise<string> {
    if (this.meta.shared) return this.id;
    if (!(await serverAvailable(true))) throw new Error('No collaboration server is reachable.');
    // An import still being copied to the device is written under the id this project is about to
    // leave. Let it land first, so that it moves along with everything else.
    if (this.media.saving) {
      toast('Still saving imported media on this device. Publishing as soon as that is done…');
      await this.media.savesSettled();
      if (this.destroyed) throw new Error('The project was closed before it could be published.');
    }
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
    registry.upsert({
      id,
      name,
      token,
      role: 'owner',
      width: s.width,
      height: s.height,
      fps: s.fpsNum / s.fpsDen,
    });
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.closing.abort();
    this.transfers.stop();
    for (const u of this.unsubs) u();
    if (this.registryTimer) clearTimeout(this.registryTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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

  /**
   * The link this session was opened with is still waiting for the server's verdict. It is kept
   * nowhere on this device until then, so whoever handed it over must hold on to it.
   */
  get linkPending(): boolean {
    return this.offered !== null;
  }

  get canComment(): boolean {
    return canComment(this.meta.role);
  }

  get player(): Player | null {
    return this.meta.player;
  }

  renameUser(name: string, color?: string): void {
    const user = {
      ...this.meta.user,
      name: name.trim() || this.meta.user.name,
      color: color ?? this.meta.user.color,
    };
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
        // The file serves the asset from memory at once, so it joins the pool now instead of
        // after every file of the batch has been copied to the device. One undo step for the batch.
        this.keep(asset, file);
        this.store.commit([{ op: 'addAsset', asset }], { merge: created.length > 0 });
        created.push(asset);
        for (const w of probe.warnings) toast(w, 'error');
      } catch (err) {
        toast(err instanceof Error ? err.message : `Could not import ${file.name}`, 'error');
      }
    }
    return created;
  }

  /** Hand an imported file to the media store, and say so if the device cannot keep it. */
  private keep(asset: Asset, file: File): void {
    void this.media.import(asset.id, file).then((result) => {
      if (result === 'saved' || !this.store.get().assets[asset.id]) return;
      toast(
        (result === 'no-space'
          ? `There is no room on this device to keep “${asset.name}”.`
          : `“${asset.name}” could not be saved on this device.`) +
          ' It stays usable until this page is closed or reloaded.',
        'error',
      );
    });
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
      this.keep(asset, file);
      const p = this.store.get();
      const edits: Edit[] = [{ op: 'addAsset', asset }];
      for (const c of Object.values(p.clips)) {
        if (c.assetId === assetId) edits.push({ op: 'updateClip', id: c.id, patch: { assetId: asset.id } });
        else if (c.grade?.lutId === assetId)
          edits.push({ op: 'updateClip', id: c.id, patch: { grade: { ...c.grade, lutId: asset.id } } });
      }
      edits.push({ op: 'removeAsset', id: assetId });
      this.store.commit(edits);
      for (const w of probe.warnings) toast(w, 'error');
      if (old.duration > 0 && asset.duration > 0 && asset.duration < old.duration - 0.05) {
        toast(
          'The new file is shorter than the old one; clips that run past its end will hold the last frame.',
        );
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
      this.syncMedia();
    }, 500);
  }

  /**
   * Upload what only we have; fetch what only the server has. The queue runs a few at a time,
   * starting with what the timeline needs soonest, and tries again what fails.
   */
  private syncMedia(): void {
    if (!this.media.connected || this.destroyed) return;
    const p = this.store.get();
    const playhead = Math.floor(this.meta.player?.getFrame() ?? 0);
    const wanted: Transfer[] = [];
    for (const a of Object.values(p.assets).sort(byUrgency(p, playhead))) {
      const st = this.media.get(a.id);
      if (st.local && !a.uploaded) {
        if (this.canEdit) wanted.push({ kind: 'upload', assetId: a.id });
      } else if (!st.local && a.uploaded && a.size < 4 * 1024 ** 3) {
        // Stills and LUTs are fetched whole by the engine anyway; cache timed media up to 4 GB.
        wanted.push({ kind: 'download', assetId: a.id });
      }
    }
    this.transfers.want(wanted);
  }

  /** Try an asset's failed upload or download again now instead of when its turn comes round. */
  retryTransfer(assetId: string): void {
    this.transfers.retryNow(assetId);
    this.syncMedia();
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
    // A project reached through a link is listed once the server has accepted the link, not before.
    if (this.token && !registry.get(this.id)) return;
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
    });
  }
}
