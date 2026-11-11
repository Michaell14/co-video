/**
 * ProjectStore — the bridge between the collaborative Yjs document and the immutable `Project`
 * snapshot that the rest of the app reads.
 *
 * Document layout (all top-level Y.Maps):
 *   meta      { schema }
 *   settings  flat ProjectSettings fields
 *   assets    id → Y.Map(flat Asset fields)
 *   tracks    id → Y.Map(flat Track fields)
 *   clips     id → Y.Map(flat Clip fields)       ← per-field last-writer-wins merging
 *   folders   id → JSON
 *   markers   id → JSON
 *
 * Clips are stored flat and keyed by id with a `trackId` field, so two people can move, trim and
 * grade the same clip concurrently and every field converges independently.
 */
import * as Y from 'yjs';
import {
  ASSET_DEFAULTS,
  CLIP_DEFAULTS,
  DEFAULT_GRADE,
  DEFAULT_SETTINGS,
  DEFAULT_SHAPE,
  DEFAULT_TEXT,
  DEFAULT_TRACK_HEIGHT,
  SCHEMA_VERSION,
  starterTracks,
} from './defaults';
import type { Asset, Clip, Edit, Folder, ID, Marker, Project, ProjectSettings, Track } from './types';
import { deepEqual } from './util';

type Listener = () => void;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Coerce arbitrary JSON from the wire into a well-formed entity using `defaults` as the type guide. */
function conform<T extends object>(defaults: T, json: Record<string, unknown>): T {
  if (!json || typeof json !== 'object') return { ...defaults };
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const key of Object.keys(defaults)) {
    const d = (defaults as Record<string, unknown>)[key];
    const v = json[key];
    if (v === undefined) continue;
    if (typeof d === 'number') {
      if (isNum(v)) out[key] = v;
    } else if (typeof d === 'boolean') {
      if (typeof v === 'boolean') out[key] = v;
    } else if (typeof d === 'string') {
      if (typeof v === 'string') out[key] = v;
    } else if (Array.isArray(d)) {
      if (Array.isArray(v)) out[key] = v;
    } else {
      // null-able or object valued: accept null or objects/strings as-is.
      if (v === null || typeof v === 'object' || typeof v === 'string') out[key] = v;
    }
  }
  return out as T;
}

function readClip(id: ID, json: Record<string, unknown>): Clip | null {
  if (typeof json.trackId !== 'string' || typeof json.type !== 'string') return null;
  const clip = conform(CLIP_DEFAULTS, json) as Clip;
  clip.id = id;
  clip.trackId = json.trackId;
  clip.type = json.type as Clip['type'];
  clip.start = Math.max(0, Math.round(clip.start));
  clip.duration = Math.max(1, Math.round(clip.duration));
  clip.speed = clip.speed > 0 ? clip.speed : 1;
  if (clip.grade) clip.grade = { ...DEFAULT_GRADE, ...clip.grade };
  if (clip.text) clip.text = { ...DEFAULT_TEXT, ...clip.text };
  if (clip.shape) clip.shape = { ...DEFAULT_SHAPE, ...clip.shape };
  if (typeof clip.keyframes !== 'object' || clip.keyframes === null) clip.keyframes = {};
  return clip;
}

function readTrack(id: ID, json: Record<string, unknown>): Track | null {
  if (json.kind !== 'video' && json.kind !== 'audio') return null;
  const base: Omit<Track, 'id' | 'kind'> = {
    name: '',
    order: 0,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    height: DEFAULT_TRACK_HEIGHT[json.kind],
    volume: 0,
    pan: 0,
    eq: null,
    compressor: null,
  };
  return { ...conform(base, json), id, kind: json.kind };
}

function readAsset(id: ID, json: Record<string, unknown>): Asset | null {
  if (typeof json.kind !== 'string') return null;
  const asset = conform(ASSET_DEFAULTS, json);
  return {
    ...asset,
    id,
    kind: json.kind as Asset['kind'],
    name: typeof json.name === 'string' ? json.name : 'Untitled',
    // A poster is an inline image. Anything else (a remote URL a peer slipped in) would make every
    // collaborator's browser call out to it.
    thumb:
      typeof asset.thumb === 'string' && /^data:image\/(png|jpeg|webp|avif);/.test(asset.thumb)
        ? asset.thumb
        : null,
  };
}

export interface CommitOptions {
  /** Merge into the previous undo step (use for continuous gestures such as slider drags). */
  merge?: boolean;
  /** Set false for bookkeeping writes that should never appear in undo history. */
  undoable?: boolean;
}

export class ProjectStore {
  readonly doc: Y.Doc;
  readonly undoManager: Y.UndoManager;
  /** Transaction origin for undoable local edits. */
  readonly origin = { tandem: 'local' };
  /** Transaction origin for local writes that bypass undo. */
  readonly systemOrigin = { tandem: 'system' };

  private project: Project;
  private listeners = new Set<Listener>();
  private metaListeners = new Set<Listener>();
  /** Bumps whenever the undo / redo stacks change. */
  undoVersion = 0;
  private dirty = false;
  private readonly ySettings: Y.Map<unknown>;
  private readonly yAssets: Y.Map<Y.Map<unknown>>;
  private readonly yTracks: Y.Map<Y.Map<unknown>>;
  private readonly yClips: Y.Map<Y.Map<unknown>>;
  private readonly yFolders: Y.Map<Folder>;
  private readonly yMarkers: Y.Map<Marker>;
  private readonly yMeta: Y.Map<unknown>;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.yMeta = doc.getMap('meta');
    this.ySettings = doc.getMap('settings');
    this.yAssets = doc.getMap('assets');
    this.yTracks = doc.getMap('tracks');
    this.yClips = doc.getMap('clips');
    this.yFolders = doc.getMap('folders');
    this.yMarkers = doc.getMap('markers');

    this.project = this.readAll();

    this.ySettings.observe(() => {
      this.project = { ...this.project, settings: this.readSettings() };
      this.dirty = true;
    });
    this.observeEntities(this.yAssets, 'assets', readAsset);
    this.observeEntities(this.yTracks, 'tracks', readTrack);
    this.observeEntities(this.yClips, 'clips', readClip);
    this.yFolders.observe(() => {
      this.project = { ...this.project, folders: this.yFolders.toJSON() as Record<ID, Folder> };
      this.dirty = true;
    });
    this.yMarkers.observe(() => {
      this.project = { ...this.project, markers: this.yMarkers.toJSON() as Record<ID, Marker> };
      this.dirty = true;
    });
    doc.on('afterTransaction', this.flush);

    this.undoManager = new Y.UndoManager(
      [this.ySettings, this.yAssets, this.yTracks, this.yClips, this.yFolders, this.yMarkers],
      { trackedOrigins: new Set([this.origin]), captureTimeout: 1e12 },
    );
    this.undoManager.on('stack-item-added', this.emitMeta);
    this.undoManager.on('stack-item-popped', this.emitMeta);
    this.undoManager.on('stack-cleared', this.emitMeta);
  }

  // ───────────────────────────────────────────────────────────── reading ──

  get(): Project {
    return this.project;
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** True when the document has never been initialised (no tracks and no settings). */
  isEmpty(): boolean {
    return this.yTracks.size === 0 && this.ySettings.size === 0 && this.yClips.size === 0;
  }

  /** Give a brand new document its settings and starter tracks. No-op on existing projects. */
  initIfEmpty(settings: Partial<ProjectSettings> = {}): void {
    if (!this.isEmpty()) return;
    this.doc.transact(() => {
      this.yMeta.set('schema', SCHEMA_VERSION);
      const s = { ...DEFAULT_SETTINGS, ...settings };
      for (const [k, v] of Object.entries(s)) this.ySettings.set(k, v);
      for (const t of starterTracks())
        this.writeEntity(this.yTracks, t as unknown as Record<string, unknown>);
    }, this.systemOrigin);
  }

  // ───────────────────────────────────────────────────────────── writing ──

  commit(edits: Edit[], opts: CommitOptions = {}): void {
    if (!edits.length) return;
    const undoable = opts.undoable !== false;
    if (undoable && !opts.merge) this.undoManager.stopCapturing();
    this.doc.transact(
      () => {
        for (const e of edits) this.apply(e);
      },
      undoable ? this.origin : this.systemOrigin,
    );
  }

  /** Force the next commit to start a new undo step even if it is flagged `merge`. */
  beginGesture(): void {
    this.undoManager.stopCapturing();
  }

  undo(): void {
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.redo();
  }

  get canUndo(): boolean {
    return this.undoManager.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.undoManager.redoStack.length > 0;
  }

  /** Replace the entire project (file import, version restore). Undoable. */
  replaceAll(next: Project): void {
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      for (const m of [
        this.ySettings,
        this.yAssets,
        this.yTracks,
        this.yClips,
        this.yFolders,
        this.yMarkers,
      ]) {
        for (const k of Array.from(m.keys())) m.delete(k);
      }
      for (const [k, v] of Object.entries(next.settings)) this.ySettings.set(k, v);
      for (const a of Object.values(next.assets))
        this.writeEntity(this.yAssets, a as unknown as Record<string, unknown>);
      for (const t of Object.values(next.tracks))
        this.writeEntity(this.yTracks, t as unknown as Record<string, unknown>);
      for (const c of Object.values(next.clips))
        this.writeEntity(this.yClips, c as unknown as Record<string, unknown>, CLIP_DEFAULTS);
      for (const f of Object.values(next.folders)) this.yFolders.set(f.id, f);
      for (const m of Object.values(next.markers)) this.yMarkers.set(m.id, m);
    }, this.origin);
  }

  destroy(): void {
    this.doc.off('afterTransaction', this.flush);
    this.undoManager.destroy();
    this.listeners.clear();
    this.metaListeners.clear();
  }

  // ──────────────────────────────────────────────────────────── internals ──

  private flush = (): void => {
    if (!this.dirty) return;
    this.dirty = false;
    for (const fn of Array.from(this.listeners)) fn();
  };

  private emitMeta = (): void => {
    this.undoVersion++;
    for (const fn of Array.from(this.metaListeners)) fn();
  };

  /** Subscribe to undo / redo availability changes. Pair with `undoVersion` as the snapshot. */
  subscribeUndo = (fn: Listener): (() => void) => {
    this.metaListeners.add(fn);
    return () => this.metaListeners.delete(fn);
  };

  private readSettings(): ProjectSettings {
    return conform(DEFAULT_SETTINGS, this.ySettings.toJSON());
  }

  private readAll(): Project {
    const read = <T>(
      map: Y.Map<Y.Map<unknown>>,
      reader: (id: ID, json: Record<string, unknown>) => T | null,
    ) => {
      const out: Record<ID, T> = {};
      map.forEach((value, id) => {
        if (!(value instanceof Y.Map)) return;
        const e = reader(id, value.toJSON());
        if (e) out[id] = e;
      });
      return out;
    };
    return {
      settings: this.readSettings(),
      assets: read(this.yAssets, readAsset),
      tracks: read(this.yTracks, readTrack),
      clips: read(this.yClips, readClip),
      folders: this.yFolders.toJSON() as Record<ID, Folder>,
      markers: this.yMarkers.toJSON() as Record<ID, Marker>,
    };
  }

  private observeEntities<T>(
    map: Y.Map<Y.Map<unknown>>,
    key: 'assets' | 'tracks' | 'clips',
    reader: (id: ID, json: Record<string, unknown>) => T | null,
  ): void {
    map.observeDeep((events) => {
      const touched = new Set<ID>();
      for (const ev of events) {
        if (ev.target === map) {
          for (const id of ev.changes.keys.keys()) touched.add(id);
        } else if (ev.path.length > 0) {
          touched.add(String(ev.path[0]));
        }
      }
      if (!touched.size) return;
      const next: Record<ID, unknown> = { ...(this.project[key] as Record<ID, unknown>) };
      for (const id of touched) {
        const value = map.get(id);
        const entity = value instanceof Y.Map ? reader(id, value.toJSON()) : null;
        if (entity) next[id] = entity;
        else delete next[id];
      }
      this.project = { ...this.project, [key]: next };
      this.dirty = true;
    });
  }

  private writeEntity(
    map: Y.Map<Y.Map<unknown>>,
    entity: Record<string, unknown>,
    skipDefaults?: Record<string, unknown>,
  ): void {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(entity)) {
      if (k === 'id' || v === undefined) continue;
      if (skipDefaults && k in skipDefaults && deepEqual(skipDefaults[k], v)) continue;
      m.set(k, v);
    }
    map.set(entity.id as string, m);
  }

  private patchEntity(
    map: Y.Map<Y.Map<unknown>>,
    id: ID,
    patch: Record<string, unknown>,
    defaults?: Record<string, unknown>,
  ): void {
    const m = map.get(id);
    if (!m) return;
    // Compare against the live Y.Map (not the snapshot) so several edits to one entity inside a
    // single transaction compose correctly.
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || v === undefined) continue;
      const cur = m.has(k) ? m.get(k) : defaults?.[k];
      if (!deepEqual(cur, v)) m.set(k, v);
    }
  }

  private apply(e: Edit): void {
    switch (e.op) {
      case 'settings':
        for (const [k, v] of Object.entries(e.patch)) {
          if (v !== undefined && !deepEqual(this.ySettings.get(k), v)) this.ySettings.set(k, v);
        }
        break;
      case 'addAsset':
        this.writeEntity(this.yAssets, e.asset as unknown as Record<string, unknown>);
        break;
      case 'updateAsset':
        this.patchEntity(this.yAssets, e.id, e.patch);
        break;
      case 'removeAsset':
        this.yAssets.delete(e.id);
        break;
      case 'addFolder':
        this.yFolders.set(e.folder.id, e.folder);
        break;
      case 'updateFolder': {
        const cur = this.yFolders.get(e.id);
        if (cur) this.yFolders.set(e.id, { ...cur, ...e.patch });
        break;
      }
      case 'removeFolder':
        this.yFolders.delete(e.id);
        break;
      case 'addTrack':
        this.writeEntity(this.yTracks, e.track as unknown as Record<string, unknown>);
        break;
      case 'updateTrack':
        this.patchEntity(this.yTracks, e.id, e.patch);
        break;
      case 'removeTrack':
        this.yTracks.delete(e.id);
        break;
      case 'addClip':
        this.writeEntity(this.yClips, e.clip as unknown as Record<string, unknown>, CLIP_DEFAULTS);
        break;
      case 'updateClip':
        this.patchEntity(this.yClips, e.id, e.patch, CLIP_DEFAULTS);
        break;
      case 'removeClip':
        this.yClips.delete(e.id);
        break;
      case 'setMarker':
        this.yMarkers.set(e.marker.id, e.marker);
        break;
      case 'removeMarker':
        this.yMarkers.delete(e.id);
        break;
    }
  }
}

/** Apply edits to a plain snapshot. Used for drag previews and in tests; mirrors `ProjectStore.apply`. */
export function applyEdits(project: Project, edits: Edit[]): Project {
  if (!edits.length) return project;
  let { settings, assets, folders, tracks, clips, markers } = project;
  const own = <T>(src: Readonly<Record<ID, T>>, original: Readonly<Record<ID, T>>): Record<ID, T> =>
    src === original ? { ...src } : (src as Record<ID, T>);
  for (const e of edits) {
    switch (e.op) {
      case 'settings':
        settings = { ...settings, ...e.patch };
        break;
      case 'addAsset':
        assets = own(assets, project.assets);
        (assets as Record<ID, Asset>)[e.asset.id] = e.asset;
        break;
      case 'updateAsset':
        if (assets[e.id]) {
          assets = own(assets, project.assets);
          (assets as Record<ID, Asset>)[e.id] = { ...assets[e.id], ...e.patch };
        }
        break;
      case 'removeAsset':
        assets = own(assets, project.assets);
        delete (assets as Record<ID, Asset>)[e.id];
        break;
      case 'addFolder':
        folders = own(folders, project.folders);
        (folders as Record<ID, Folder>)[e.folder.id] = e.folder;
        break;
      case 'updateFolder':
        if (folders[e.id]) {
          folders = own(folders, project.folders);
          (folders as Record<ID, Folder>)[e.id] = { ...folders[e.id], ...e.patch };
        }
        break;
      case 'removeFolder':
        folders = own(folders, project.folders);
        delete (folders as Record<ID, Folder>)[e.id];
        break;
      case 'addTrack':
        tracks = own(tracks, project.tracks);
        (tracks as Record<ID, Track>)[e.track.id] = e.track;
        break;
      case 'updateTrack':
        if (tracks[e.id]) {
          tracks = own(tracks, project.tracks);
          (tracks as Record<ID, Track>)[e.id] = { ...tracks[e.id], ...e.patch };
        }
        break;
      case 'removeTrack':
        tracks = own(tracks, project.tracks);
        delete (tracks as Record<ID, Track>)[e.id];
        break;
      case 'addClip':
        clips = own(clips, project.clips);
        (clips as Record<ID, Clip>)[e.clip.id] = e.clip;
        break;
      case 'updateClip':
        if (clips[e.id]) {
          clips = own(clips, project.clips);
          (clips as Record<ID, Clip>)[e.id] = { ...clips[e.id], ...e.patch };
        }
        break;
      case 'removeClip':
        clips = own(clips, project.clips);
        delete (clips as Record<ID, Clip>)[e.id];
        break;
      case 'setMarker':
        markers = own(markers, project.markers);
        (markers as Record<ID, Marker>)[e.marker.id] = e.marker;
        break;
      case 'removeMarker':
        markers = own(markers, project.markers);
        delete (markers as Record<ID, Marker>)[e.id];
        break;
    }
  }
  return { settings, assets, folders, tracks, clips, markers };
}

/** Serialise a project to a portable JSON file. */
export function serializeProject(project: Project): string {
  return JSON.stringify({ format: 'tandem-project', schema: SCHEMA_VERSION, project }, null, 0);
}

export function parseProjectFile(text: string): Project | null {
  try {
    const data = JSON.parse(text);
    if (data?.format !== 'tandem-project' || !data.project) return null;
    const p = data.project as Project;
    const clips: Record<ID, Clip> = {};
    for (const [id, c] of Object.entries(p.clips ?? {})) {
      const r = readClip(id, c as unknown as Record<string, unknown>);
      if (r) clips[id] = r;
    }
    const tracks: Record<ID, Track> = {};
    for (const [id, t] of Object.entries(p.tracks ?? {})) {
      const r = readTrack(id, t as unknown as Record<string, unknown>);
      if (r) tracks[id] = r;
    }
    const assets: Record<ID, Asset> = {};
    for (const [id, a] of Object.entries(p.assets ?? {})) {
      const r = readAsset(id, a as unknown as Record<string, unknown>);
      if (r) assets[id] = r;
    }
    return {
      settings: conform(DEFAULT_SETTINGS, (p.settings ?? {}) as unknown as Record<string, unknown>),
      assets,
      tracks,
      clips,
      folders: p.folders ?? {},
      markers: p.markers ?? {},
    };
  } catch {
    return null;
  }
}
