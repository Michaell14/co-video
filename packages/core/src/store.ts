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
  CLIP_TYPE_COLORS,
  DEFAULT_COMPRESSOR,
  DEFAULT_EQ,
  DEFAULT_GRADE,
  DEFAULT_MASK,
  DEFAULT_SETTINGS,
  DEFAULT_SHAPE,
  DEFAULT_TEXT,
  DEFAULT_TRACK_HEIGHT,
  MARKER_COLORS,
  SCHEMA_VERSION,
  starterTracks,
} from './defaults';
import { conformEasing } from './keyframes';
import type {
  Asset,
  AssetColorInfo,
  AssetKind,
  BlendMode,
  Clip,
  ColorMode,
  CurvePoint,
  Edit,
  EffectInstance,
  FitMode,
  Folder,
  ID,
  InputColorSpace,
  Keyframe,
  Marker,
  ParamValue,
  Project,
  ProjectSettings,
  ShapeKind,
  ToneMapOp,
  Track,
  Transition,
} from './types';
import { clamp, deepEqual } from './util';

type Listener = () => void;
type Json = Record<string, unknown>;

/** Turns a value from the wire into a well-formed one, or `undefined` to keep the default. */
type Reader = (v: unknown) => unknown;
type Readers<T> = { [K in keyof T]?: Reader };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Coerce arbitrary JSON from the wire into a well-formed entity using `defaults` as the type guide.
 * Numbers, booleans, strings and nested plain objects are checked against the default's own type;
 * anything else (arrays, nullable values, enumerations) has no type to go by and is only accepted
 * through a reader, so a field nobody vouched for can never reach the renderer as-is.
 *
 * A value that is already exactly well-formed is handed back as it is, here and in every reader
 * below. Nested values in the document are replaced, never mutated, so they keep their identity
 * from one read of an entity to the next and whatever caches by identity downstream keeps working.
 */
function conform<T extends object>(defaults: T, json: unknown, readers: Readers<T> = {}): T {
  if (!isObj(json)) return { ...defaults };
  const out: Json = { ...(defaults as Json) };
  const keys = Object.keys(defaults);
  let asIs = Object.keys(json).length === keys.length;
  for (const key of keys) {
    const v = json[key];
    const d = (defaults as Json)[key];
    const reader = (readers as Record<string, Reader | undefined>)[key];
    let next: unknown;
    if (v === undefined) next = undefined;
    else if (reader) next = reader(v);
    else if (typeof d === 'number') next = isNum(v) ? v : undefined;
    else if (typeof d === 'boolean') next = typeof v === 'boolean' ? v : undefined;
    else if (typeof d === 'string') next = typeof v === 'string' ? v : undefined;
    else if (isObj(d)) next = isObj(v) ? conform(d, v) : undefined;
    if (next !== undefined) out[key] = next;
    if (next === undefined || next !== v) asIs = false;
  }
  return (asIs ? json : out) as T;
}

/** Read every item of a list, dropping the ones `read` rejects. */
function conformList<T>(list: readonly unknown[], read: (item: unknown) => T | undefined): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < list.length; i++) {
    const next = read(list[i]);
    if (!out && next !== list[i]) out = list.slice(0, i) as T[];
    if (out && next !== undefined) out.push(next);
  }
  return out ?? (list as T[]);
}

/** `list` in ascending order of `key`. */
function inOrder<T>(list: T[], key: (item: T) => number): T[] {
  for (let i = 1; i < list.length; i++) {
    if (key(list[i]) < key(list[i - 1])) return list.slice().sort((a, b) => key(a) - key(b));
  }
  return list;
}

const strOrNull: Reader = (v) => (v === null || typeof v === 'string' ? v : undefined);
const numOrNull: Reader = (v) => (v === null || isNum(v) ? v : undefined);
const boolOrNull: Reader = (v) => (v === null || typeof v === 'boolean' ? v : undefined);

/** Reader for a closed set of strings, written as a record so the compiler keeps it exhaustive. */
const oneOf =
  <T extends string>(allowed: Record<T, true>): Reader =>
  (v) =>
    typeof v === 'string' && Object.hasOwn(allowed, v) ? v : undefined;

const shaped =
  <T extends object>(defaults: T, readers?: Readers<T>): Reader =>
  (v) =>
    isObj(v) ? conform(defaults, v, readers) : undefined;

const nullable =
  (reader: Reader): Reader =>
  (v) =>
    v === null ? null : reader(v);

/**
 * Entity ids arrive as map keys chosen by whoever wrote them. `__proto__` is the one key that would
 * replace a record's prototype instead of adding an entry.
 */
const isSafeId = (id: string): boolean => id !== '__proto__';

/** Longest timeline the model accepts, in frames: weeks of footage at any real frame rate. */
const MAX_FRAMES = 100_000_000;

const BLEND_MODES: Record<BlendMode, true> = {
  normal: true,
  multiply: true,
  screen: true,
  overlay: true,
  darken: true,
  lighten: true,
  'color-dodge': true,
  'color-burn': true,
  'hard-light': true,
  'soft-light': true,
  difference: true,
  exclusion: true,
  add: true,
  subtract: true,
  hue: true,
  saturation: true,
  color: true,
  luminosity: true,
};
const FIT_MODES: Record<FitMode, true> = { contain: true, cover: true, stretch: true, none: true };
const SHAPE_KINDS: Record<ShapeKind, true> = {
  rect: true,
  ellipse: true,
  triangle: true,
  star: true,
  polygon: true,
  line: true,
  arrow: true,
};
const ASSET_KINDS: Record<AssetKind, true> = { video: true, audio: true, image: true, lut: true };
const INPUT_COLOR_SPACES: Record<InputColorSpace, true> = {
  auto: true,
  srgb: true,
  rec709: true,
  'display-p3': true,
  'rec2020-pq': true,
  'rec2020-hlg': true,
  linear: true,
  slog3: true,
  logc3: true,
  vlog: true,
};
const COLOR_MODES: Record<ColorMode, true> = { sdr: true, 'hdr-pq': true, 'hdr-hlg': true };
const TONE_MAP_OPS: Record<ToneMapOp, true> = {
  none: true,
  reinhard: true,
  hable: true,
  aces: true,
  bt2390: true,
};

const isParam = (v: unknown): v is ParamValue =>
  isNum(v) || typeof v === 'boolean' || typeof v === 'string' || (Array.isArray(v) && v.every(isNum));

function readParams(v: unknown): Record<string, ParamValue> {
  if (!isObj(v)) return {};
  const entries = Object.entries(v);
  const good = entries.filter(
    (entry): entry is [string, ParamValue] => isSafeId(entry[0]) && isParam(entry[1]),
  );
  return good.length === entries.length ? (v as Record<string, ParamValue>) : Object.fromEntries(good);
}

function readEffect(e: unknown): EffectInstance | undefined {
  if (!isObj(e) || typeof e.id !== 'string' || typeof e.type !== 'string') return undefined;
  const params = readParams(e.params);
  const enabled = e.enabled !== false;
  if (enabled === e.enabled && params === e.params && Object.keys(e).length === 4)
    return e as unknown as EffectInstance;
  return { id: e.id, type: e.type, enabled, params };
}

const readEffects: Reader = (v) => (Array.isArray(v) ? conformList(v, readEffect) : undefined);

const readTransition: Reader = (v) => {
  if (v === null) return null;
  if (!isObj(v) || typeof v.type !== 'string' || !isNum(v.duration)) return undefined;
  const params = readParams(v.params);
  const duration = Math.max(1, v.duration);
  if (duration === v.duration && params === v.params && Object.keys(v).length === 3) return v;
  const t: Transition = { type: v.type, duration, params };
  return t;
};

function readKeyframe(k: unknown): Keyframe | undefined {
  if (!isObj(k) || !isNum(k.t) || !isNum(k.v)) return undefined;
  const e = conformEasing(k.e);
  return e === k.e && Object.keys(k).length === 3 ? (k as unknown as Keyframe) : { t: k.t, v: k.v, e };
}

const readKeyframes: Reader = (v) => {
  if (!isObj(v)) return undefined;
  const out: Record<string, Keyframe[]> = {};
  let asIs = true;
  for (const [path, list] of Object.entries(v)) {
    if (!isSafeId(path) || !Array.isArray(list)) {
      asIs = false;
      continue;
    }
    // Evaluation binary-searches the list, so it has to arrive in time order.
    out[path] = inOrder(conformList(list, readKeyframe), (k) => k.t);
    if (out[path] !== list) asIs = false;
  }
  return asIs ? v : out;
};

const readWheel: Reader = (v) => (Array.isArray(v) && v.length === 4 && v.every(isNum) ? v : undefined);

const isPoint = (pt: unknown): pt is CurvePoint =>
  Array.isArray(pt) && pt.length === 2 && isNum(pt[0]) && isNum(pt[1]);

const readCurve: Reader = (v) => {
  if (!Array.isArray(v)) return undefined;
  const pts = conformList(v, (pt) => (isPoint(pt) ? pt : undefined));
  // The curve baker interpolates between neighbours: it needs two points, left to right.
  return pts.length >= 2 ? inOrder(pts, (pt) => pt[0]) : undefined;
};

const CLIP_READERS: Readers<typeof CLIP_DEFAULTS> = {
  assetId: strOrNull,
  label: strOrNull,
  linkId: strOrNull,
  blend: oneOf(BLEND_MODES),
  fit: oneOf(FIT_MODES),
  effects: readEffects,
  grade: nullable(
    shaped(DEFAULT_GRADE, {
      lift: readWheel,
      gamma: readWheel,
      gain: readWheel,
      offset: readWheel,
      curves: shaped(DEFAULT_GRADE.curves, { m: readCurve, r: readCurve, g: readCurve, b: readCurve }),
      hueSat: readCurve,
      hueHue: readCurve,
      lumSat: readCurve,
      lutId: strOrNull,
    }),
  ),
  mask: nullable(shaped(DEFAULT_MASK, { type: oneOf({ rect: true, ellipse: true }) })),
  keyframes: readKeyframes,
  transIn: readTransition,
  transOut: readTransition,
  text: nullable(
    shaped(DEFAULT_TEXT, {
      align: oneOf({ left: true, center: true, right: true }),
      boxWidth: numOrNull,
    }),
  ),
  shape: nullable(
    shaped(DEFAULT_SHAPE, {
      kind: oneOf(SHAPE_KINDS),
      // The outline is drawn one vertex at a time.
      sides: (v) => (isNum(v) ? clamp(Math.round(v), 3, 64) : undefined),
    }),
  ),
};

function readClip(id: ID, json: unknown): Clip | null {
  if (!isSafeId(id) || !isObj(json) || typeof json.trackId !== 'string') return null;
  if (typeof json.type !== 'string' || !Object.hasOwn(CLIP_TYPE_COLORS, json.type)) return null;
  const clip: Clip = {
    ...conform(CLIP_DEFAULTS, json, CLIP_READERS),
    id,
    trackId: json.trackId,
    type: json.type as Clip['type'],
  };
  clip.start = clamp(Math.round(clip.start), 0, MAX_FRAMES);
  clip.duration = clamp(Math.round(clip.duration), 1, MAX_FRAMES);
  clip.speed = clip.speed > 0 ? clip.speed : 1;
  return clip;
}

const TRACK_READERS: Readers<Omit<Track, 'id' | 'kind'>> = {
  eq: nullable(shaped(DEFAULT_EQ)),
  compressor: nullable(shaped(DEFAULT_COMPRESSOR)),
};

function readTrack(id: ID, json: unknown): Track | null {
  if (!isSafeId(id) || !isObj(json)) return null;
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
  return { ...conform(base, json, TRACK_READERS), id, kind: json.kind };
}

const NO_COLOR_INFO: AssetColorInfo = { primaries: null, transfer: null, matrix: null, fullRange: null };

const ASSET_READERS: Readers<typeof ASSET_DEFAULTS> = {
  videoCodec: strOrNull,
  audioCodec: strOrNull,
  color: nullable(
    shaped(NO_COLOR_INFO, {
      primaries: strOrNull,
      transfer: strOrNull,
      matrix: strOrNull,
      fullRange: boolOrNull,
    }),
  ),
  inputColorSpace: oneOf(INPUT_COLOR_SPACES),
  folderId: strOrNull,
  // A poster is an inline image. Anything else (a remote URL a peer slipped in) would make every
  // collaborator's browser call out to it.
  thumb: (v) => (typeof v === 'string' && /^data:image\/(png|jpeg|webp|avif);/.test(v) ? v : null),
};

function readAsset(id: ID, json: unknown): Asset | null {
  if (!isSafeId(id) || !isObj(json)) return null;
  if (typeof json.kind !== 'string' || !Object.hasOwn(ASSET_KINDS, json.kind)) return null;
  return {
    ...conform(ASSET_DEFAULTS, json, ASSET_READERS),
    id,
    kind: json.kind as AssetKind,
    name: typeof json.name === 'string' ? json.name : 'Untitled',
  };
}

function readMarker(id: ID, json: unknown): Marker | null {
  if (!isSafeId(id) || !isObj(json) || !isNum(json.frame)) return null;
  return {
    id,
    frame: clamp(Math.round(json.frame), 0, MAX_FRAMES),
    name: typeof json.name === 'string' ? json.name : '',
    color: typeof json.color === 'string' ? json.color : MARKER_COLORS[0],
    note: typeof json.note === 'string' ? json.note : '',
  };
}

function readFolder(id: ID, json: unknown): Folder | null {
  if (!isSafeId(id) || !isObj(json)) return null;
  return {
    id,
    name: typeof json.name === 'string' ? json.name : '',
    parentId: typeof json.parentId === 'string' ? json.parentId : null,
  };
}

const SETTINGS_READERS: Readers<ProjectSettings> = {
  colorMode: oneOf(COLOR_MODES),
  toneMap: oneOf(TONE_MAP_OPS),
};

function readSettings(json: unknown): ProjectSettings {
  const s = { ...conform(DEFAULT_SETTINGS, json, SETTINGS_READERS) };
  // Every time conversion divides by the frame rate, and timecode counts in whole frames per second.
  const fps = s.fpsNum / s.fpsDen;
  if (!(s.fpsNum >= 1 && s.fpsDen >= 1 && fps >= 1 && fps <= 1000)) {
    s.fpsNum = DEFAULT_SETTINGS.fpsNum;
    s.fpsDen = DEFAULT_SETTINGS.fpsDen;
  }
  s.width = clamp(Math.round(s.width), 16, 16384);
  s.height = clamp(Math.round(s.height), 16, 16384);
  s.sampleRate = clamp(Math.round(s.sampleRate), 8000, 192000);
  s.peakNits = clamp(s.peakNits, 1, 10000);
  s.refWhiteNits = clamp(s.refWhiteNits, 1, 10000);
  return s;
}

/** Read a map of entities, leaving out the ones that are malformed beyond repair. */
function readRecord<T>(json: unknown, reader: (id: ID, json: unknown) => T | null): Record<ID, T> {
  const out: Record<ID, T> = {};
  if (!isObj(json)) return out;
  for (const [id, value] of Object.entries(json)) {
    const entity = reader(id, value);
    if (entity) out[id] = entity;
  }
  return out;
}

/** A copy of `record` with `changes` applied; a null change removes the entry. */
function patched<T>(record: Readonly<Record<ID, T>>, changes: Map<ID, T | null>): Record<ID, T> {
  const next = { ...record };
  for (const [id, entity] of changes) {
    if (entity) next[id] = entity;
    else delete next[id];
  }
  return next;
}

/** The clips that have a lane to sit on. `clips` itself is returned when none are missing one. */
function clipsWithTrack(clips: Record<ID, Clip>, tracks: Readonly<Record<ID, Track>>): Record<ID, Clip> {
  let out: Record<ID, Clip> | null = null;
  for (const c of Object.values(clips)) {
    if (Object.hasOwn(tracks, c.trackId)) continue;
    out ??= { ...clips };
    delete out[c.id];
  }
  return out ?? clips;
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
  /**
   * Every well-formed clip in the document. The snapshot only carries the ones whose track exists:
   * a clip can outlive its track (someone undoes "add track" after a collaborator dropped a clip on
   * it, or deletes the track while a clip is on its way there), and it comes back with the track.
   */
  private readonly allClips = new Map<ID, Clip>();
  private listeners = new Set<Listener>();
  private metaListeners = new Set<Listener>();
  /** Bumps whenever the undo / redo stacks change. */
  undoVersion = 0;
  private dirty = false;
  private readonly ySettings: Y.Map<unknown>;
  private readonly yAssets: Y.Map<Y.Map<unknown>>;
  private readonly yTracks: Y.Map<Y.Map<unknown>>;
  private readonly yClips: Y.Map<Y.Map<unknown>>;
  private readonly yFolders: Y.Map<unknown>;
  private readonly yMarkers: Y.Map<unknown>;
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
      this.project = { ...this.project, settings: readSettings(this.ySettings.toJSON()) };
      this.dirty = true;
    });
    this.observeEntities(this.yAssets, readAsset, (changes) => {
      this.project = { ...this.project, assets: patched(this.project.assets, changes) };
    });
    this.observeEntities(this.yTracks, readTrack, this.applyTrackChanges);
    this.observeEntities(this.yClips, readClip, this.applyClipChanges);
    this.observeValues(this.yFolders, 'folders', readFolder);
    this.observeValues(this.yMarkers, 'markers', readMarker);
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

  private readAll(): Project {
    const read = <T>(map: Y.Map<Y.Map<unknown>>, reader: (id: ID, json: unknown) => T | null) => {
      const out: Record<ID, T> = {};
      map.forEach((value, id) => {
        if (!(value instanceof Y.Map)) return;
        const e = reader(id, value.toJSON());
        if (e) out[id] = e;
      });
      return out;
    };
    const tracks = read(this.yTracks, readTrack);
    const clips = read(this.yClips, readClip);
    for (const c of Object.values(clips)) this.allClips.set(c.id, c);
    return {
      settings: readSettings(this.ySettings.toJSON()),
      assets: read(this.yAssets, readAsset),
      tracks,
      clips: clipsWithTrack(clips, tracks),
      folders: readRecord(this.yFolders.toJSON(), readFolder),
      markers: readRecord(this.yMarkers.toJSON(), readMarker),
    };
  }

  /** Re-read the entities a transaction touched and hand them to `apply` (null = gone or malformed). */
  private observeEntities<T>(
    map: Y.Map<Y.Map<unknown>>,
    reader: (id: ID, json: unknown) => T | null,
    apply: (changes: Map<ID, T | null>) => void,
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
      const changes = new Map<ID, T | null>();
      for (const id of touched) {
        const value = map.get(id);
        changes.set(id, value instanceof Y.Map ? reader(id, value.toJSON()) : null);
      }
      const before = this.project;
      apply(changes);
      if (this.project !== before) this.dirty = true;
    });
  }

  /** Folders and markers are whole JSON values keyed by id. */
  private observeValues<T>(
    map: Y.Map<unknown>,
    key: 'folders' | 'markers',
    reader: (id: ID, json: unknown) => T | null,
  ): void {
    map.observe((event) => {
      const changes = new Map<ID, T | null>();
      for (const id of event.keysChanged) changes.set(id, reader(id, map.get(id)));
      const current = this.project[key] as Readonly<Record<ID, T>>;
      this.project = { ...this.project, [key]: patched(current, changes) };
      this.dirty = true;
    });
  }

  private applyTrackChanges = (changes: Map<ID, Track | null>): void => {
    const before = this.project.tracks;
    const tracks = patched(before, changes);
    this.project = { ...this.project, tracks };
    let cameOrWent = false;
    for (const [id, track] of changes) if (!!track !== Object.hasOwn(before, id)) cameOrWent = true;
    if (!cameOrWent) return;
    // A track that appears brings back the clips waiting for it; one that goes takes its clips
    // out of the snapshot. Everything else keeps its identity.
    let clips: Record<ID, Clip> | null = null;
    for (const c of this.allClips.values()) {
      const show = Object.hasOwn(tracks, c.trackId);
      if (show === (this.project.clips[c.id] === c)) continue;
      clips ??= { ...this.project.clips };
      if (show) clips[c.id] = c;
      else delete clips[c.id];
    }
    if (clips) this.project = { ...this.project, clips };
  };

  private applyClipChanges = (changes: Map<ID, Clip | null>): void => {
    let clips: Record<ID, Clip> | null = null;
    for (const [id, clip] of changes) {
      if (clip) this.allClips.set(id, clip);
      else this.allClips.delete(id);
      const shown = clip && Object.hasOwn(this.project.tracks, clip.trackId) ? clip : null;
      if (!shown && !Object.hasOwn(this.project.clips, id)) continue;
      clips ??= { ...this.project.clips };
      if (shown) clips[id] = shown;
      else delete clips[id];
    }
    if (clips) this.project = { ...this.project, clips };
  };

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
        if (isObj(cur)) this.yFolders.set(e.id, { ...cur, ...e.patch });
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
    if (data?.format !== 'tandem-project' || !isObj(data.project)) return null;
    const p = data.project;
    const tracks = readRecord(p.tracks, readTrack);
    return {
      settings: readSettings(p.settings),
      assets: readRecord(p.assets, readAsset),
      tracks,
      // In a file, a clip whose track is missing can never get it back.
      clips: clipsWithTrack(readRecord(p.clips, readClip), tracks),
      folders: readRecord(p.folders, readFolder),
      markers: readRecord(p.markers, readMarker),
    };
  } catch {
    return null;
  }
}
