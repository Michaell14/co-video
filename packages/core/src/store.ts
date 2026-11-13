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
import { getEffectDef, type ParamDef } from './effects';
import { conformEasing } from './keyframes';
import { overlappingPairs, separateClips } from './overlaps';
import { clipAtRate, fpsOf, sameRate } from './time';
import { getTransitionDef } from './transitions';
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
import { clamp, deepEqual, hexColor } from './util';

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
const boolOrNull: Reader = (v) => (v === null || typeof v === 'boolean' ? v : undefined);
/** Every colour in the model goes through `hexColor`, which says why. */
const color: Reader = (v) => hexColor(v) ?? undefined;

/**
 * A number that an audio node, a canvas or a font has to accept. Past these ranges nothing sounds
 * or looks any different, and some of them throw: a gain of 1e39 dB is not a finite number of
 * anything, and a canvas cannot be 1e308 pixels wide.
 */
const within =
  (lo: number, hi: number): Reader =>
  (v) =>
    isNum(v) ? clamp(v, lo, hi) : undefined;

const decibels = within(-60, 24);
const balance = within(-1, 1);
const fraction = within(0, 1);
/** Lengths of a title or a shape, in units of the type size or of the frame. */
const extent = within(0, 100);

/**
 * A font family goes into a CSS font shorthand between double quotes. A name that could end the
 * quotes early makes the whole shorthand something that is not a font.
 */
const fontFamily: Reader = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= 100 && !/["'\\\u0000-\u001f\u007f]/.test(v)
    ? v
    : undefined;

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

/**
 * Parameter values of an effect or transition. `defs` is its schema when the type is a known one:
 * it says which of the strings are colours.
 */
function readParams(v: unknown, defs: readonly ParamDef[] = []): Record<string, ParamValue> {
  if (!isObj(v)) return {};
  const entries = Object.entries(v);
  const good = entries.filter(
    (entry): entry is [string, ParamValue] => isSafeId(entry[0]) && isParam(entry[1]),
  );
  let params = good.length === entries.length ? (v as Record<string, ParamValue>) : Object.fromEntries(good);
  for (const d of defs) {
    if (d.type !== 'color' || !Object.hasOwn(params, d.key)) continue;
    const hex = hexColor(params[d.key]) ?? d.default;
    if (hex === params[d.key]) continue;
    if (params === v) params = { ...params };
    params[d.key] = hex;
  }
  return params;
}

function readEffect(e: unknown): EffectInstance | undefined {
  if (!isObj(e) || typeof e.id !== 'string' || typeof e.type !== 'string') return undefined;
  const params = readParams(e.params, getEffectDef(e.type)?.params);
  const enabled = e.enabled !== false;
  if (enabled === e.enabled && params === e.params && Object.keys(e).length === 4)
    return e as unknown as EffectInstance;
  return { id: e.id, type: e.type, enabled, params };
}

const readEffects: Reader = (v) => (Array.isArray(v) ? conformList(v, readEffect) : undefined);

const readTransition: Reader = (v) => {
  if (v === null) return null;
  if (!isObj(v) || typeof v.type !== 'string' || !isNum(v.duration)) return undefined;
  const params = readParams(v.params, getTransitionDef(v.type)?.params);
  const duration = Math.max(1, v.duration);
  if (duration === v.duration && params === v.params && Object.keys(v).length === 3) return v;
  const t: Transition = { type: v.type, duration, params };
  return t;
};

function readKeyframe(k: unknown, range?: Reader): Keyframe | undefined {
  if (!isObj(k) || !isNum(k.t) || !isNum(k.v)) return undefined;
  const e = conformEasing(k.e);
  const v = range ? (range(k.v) as number) : k.v;
  return e === k.e && v === k.v && Object.keys(k).length === 3
    ? (k as unknown as Keyframe)
    : { t: k.t, v, e };
}

/** An animated property keeps to the range of the property itself. */
const KEYFRAME_RANGES: Record<string, Reader | undefined> = { volume: decibels, pan: balance };

const readKeyframes: Reader = (v) => {
  if (!isObj(v)) return undefined;
  const out: Record<string, Keyframe[]> = {};
  let asIs = true;
  for (const [path, list] of Object.entries(v)) {
    if (!isSafeId(path) || !Array.isArray(list)) {
      asIs = false;
      continue;
    }
    const range = Object.hasOwn(KEYFRAME_RANGES, path) ? KEYFRAME_RANGES[path] : undefined;
    // Evaluation binary-searches the list, so it has to arrive in time order.
    out[path] = inOrder(
      conformList(list, (k) => readKeyframe(k, range)),
      (k) => k.t,
    );
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
  label: nullable(color),
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
  volume: decibels,
  pan: balance,
  mask: nullable(shaped(DEFAULT_MASK, { type: oneOf({ rect: true, ellipse: true }) })),
  keyframes: readKeyframes,
  transIn: readTransition,
  transOut: readTransition,
  text: nullable(
    shaped(DEFAULT_TEXT, {
      font: fontFamily,
      size: extent,
      // CSS knows the weights 1 to 1000 and no others.
      weight: (v) => (isNum(v) ? clamp(Math.round(v), 1, 1000) : undefined),
      color,
      align: oneOf({ left: true, center: true, right: true }),
      lineHeight: extent,
      letterSpacing: within(-1, 100),
      boxWidth: nullable(extent),
      gradient: shaped(DEFAULT_TEXT.gradient, { from: color, to: color }),
      stroke: shaped(DEFAULT_TEXT.stroke, { color, width: extent }),
      shadow: shaped(DEFAULT_TEXT.shadow, {
        color,
        blur: extent,
        x: within(-100, 100),
        y: within(-100, 100),
        opacity: fraction,
      }),
      bg: shaped(DEFAULT_TEXT.bg, { color, opacity: fraction, padX: extent, padY: extent, radius: extent }),
    }),
  ),
  shape: nullable(
    shaped(DEFAULT_SHAPE, {
      kind: oneOf(SHAPE_KINDS),
      w: extent,
      h: extent,
      fill: color,
      gradient: shaped(DEFAULT_SHAPE.gradient, { from: color, to: color }),
      stroke: color,
      strokeWidth: extent,
      radius: fraction,
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

const hertz = within(20, 20000);
const eqGain = within(-24, 24);

const TRACK_READERS: Readers<Omit<Track, 'id' | 'kind'>> = {
  volume: decibels,
  pan: balance,
  eq: nullable(
    shaped(DEFAULT_EQ, {
      low: eqGain,
      mid: eqGain,
      high: eqGain,
      lowFreq: hertz,
      midFreq: hertz,
      highFreq: hertz,
    }),
  ),
  // The ranges of a Web Audio compressor; its makeup gain is an ordinary gain.
  compressor: nullable(
    shaped(DEFAULT_COMPRESSOR, {
      threshold: within(-100, 0),
      ratio: within(1, 20),
      attack: fraction,
      release: fraction,
      knee: within(0, 40),
      makeup: eqGain,
    }),
  ),
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
    color: hexColor(json.color) ?? MARKER_COLORS[0],
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
  background: color,
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

/** Where an undo step keeps the frame rate it was recorded at. */
const STEP_RATE = 'tandem.fps';
/**
 * Where an undo step keeps the last value it wrote under each key of each map. The document does
 * not keep a value once someone else has replaced it.
 */
const STEP_VALUES = 'tandem.values';
/** Where an undo step keeps how far through this client's writes its values have been noted. */
const STEP_NOTED = 'tandem.noted';
/**
 * Where an undo step keeps the place it left each clip in that it moved or trimmed: both where the
 * clip starts and how long it is, though the step wrote only one of the two (see `atStepRate`).
 */
const STEP_PLACES = 'tandem.places';
/**
 * Where an undo step keeps which clips shared frames in the project as it was before the step, the
 * project the step gives back when it is taken (see `makeRoom`).
 */
const STEP_SHARED = 'tandem.shared';

type UndoStep = Y.UndoManager['undoStack'][number];
/** A map that holds single values: the settings, the markers, the folders, or one asset, track or clip. */
type ValueMap = Y.Map<unknown>;
type StepValues = Map<ValueMap, Map<string, unknown>>;
type Place = Pick<Clip, 'start' | 'duration'>;
type StepPlaces = Map<ID, Place>;

/** One name for two clips, whichever comes first. */
const pairOf = (a: Clip, b: Clip): string => (a.id < b.id ? `${a.id} ${b.id}` : `${b.id} ${a.id}`);

/** Every two clips of `p` that share frames on a track, by `pairOf`. */
const sharedFrames = (p: Project): ReadonlySet<string> =>
  new Set(overlappingPairs(p).map(([a, b]) => pairOf(a, b)));

/**
 * Calls `f` with every value under a key of a map that `set` names, one value at a time. Values
 * that one client wrote under a key one after the other are kept as a single item once they are
 * all deleted; such an item is taken apart here, for as long as the transaction lasts. One that
 * has been restored stays whole: its copy is in as many parts, and the two are linked part by part.
 */
function eachValue(tr: Y.Transaction, set: UndoStep['insertions'], f: (item: Y.Item) => void): void {
  Y.iterateDeletedStructs(tr, set, (item) => {
    if (!(item instanceof Y.Item) || item.parentSub === null) return;
    // What is split off comes next in the iteration.
    if (item.deleted && item.redone === null && item.length > 1)
      Y.getItemCleanStart(tr, Y.createID(item.id.client, item.id.clock + 1));
    f(item);
  });
}

/**
 * Point `was` at `now`, the value that stands in for it, the way the undo manager links a value to
 * the copy it restores it as. Like such a copy, `now` is then kept for as long as the document is
 * open: once deleted it would otherwise be collected, and the link would lead nowhere.
 */
function standsFor(now: Y.Item, was: Y.Item): void {
  was.redone = now.id;
  for (let item: Y.Item | null = now; item !== null && !item.keep; item = (item.parent as ValueMap)._item) {
    item.keep = true;
  }
}

/** The fields that say where a clip is. A change of frame rate writes them whether they change or not. */
const PLACEMENT: ReadonlySet<string> = new Set(['start', 'duration']);

/** What an undo or redo wrote: the fields of each clip (`true` for a clip put there whole) and the markers. */
interface StepWrites {
  clips: Map<ID, Set<string> | true>;
  markers: Set<ID>;
}

const noWrites = (): StepWrites => ({ clips: new Map(), markers: new Set() });

/**
 * The fields of `c` that `stale` picks, taken to a frame rate `k` times the one they are at. The
 * rest of the clip is at that rate already. A length is worked out from both ends of a clip, which
 * only holds while the start is at the same rate as the length; a length that is stale on its own
 * is taken across by itself.
 */
function retimed(c: Clip, k: number, stale: (key: string) => boolean): Record<string, unknown> {
  const patch = Object.fromEntries(Object.entries(clipAtRate(c, k)).filter(([key]) => stale(key)));
  if ('duration' in patch && !('start' in patch)) patch.duration = Math.max(1, Math.round(c.duration * k));
  return patch;
}

/**
 * An undo has put back where `c` starts or how long it is, as the step found it at its own frame
 * rate, and not the other of the two: that one stands at the present rate, `k` times the step's.
 * Taken across each on its own, the two would be rounded apart, and the clip would come back a
 * frame short of its neighbour or a frame into it.
 *
 * `left` is the place the step left the clip in, at the step's rate. While the half that was not
 * put back is still what `left` comes to at the present rate, nobody has set it since, and at the
 * step's rate it is what `left` says. The clip is returned with its whole place at that rate, so
 * that both ends are taken across together, the way a change of rate takes them. Null when the
 * other half is not known at the step's rate.
 */
function atStepRate(c: Clip, restored: ReadonlySet<string>, left: Place | undefined, k: number): Clip | null {
  if (!left || restored.has('start') === restored.has('duration')) return null;
  const other = restored.has('start') ? 'duration' : 'start';
  return clipAtRate({ ...c, ...left }, k)[other] === c[other] ? { ...c, [other]: left[other] } : null;
}

export interface CommitOptions {
  /** Merge into the previous undo step (use for continuous gestures such as slider drags). */
  merge?: boolean;
  /** Set false for bookkeeping writes that should never appear in undo history. */
  undoable?: boolean;
}

/** What one call of `undo` or `redo` came to. */
export interface StepOutcome {
  /** Whether a step was taken back (or made again). */
  changed: boolean;
  /**
   * How many steps were passed over on the way because nothing of them was left to take back:
   * someone else has since changed or removed everything they had touched. They are gone from the
   * history, and the step after them was taken instead.
   */
  dropped: number;
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
  /**
   * The frame rate as of the last transaction that ended. While one is being wound up this is
   * still the rate it began at, and that is the rate its undo step is stamped with.
   */
  private rate: number;
  /** What the undo or redo in progress has written, noted as it happens for `settle`. */
  private written = noWrites();
  /** The step the undo or redo in progress has been filed as, once it has changed something. */
  private filed: UndoStep | null = null;
  /** The project as the last edit, undo or redo of this session found it. */
  private before: Project;
  /** Whether the step the undo manager took last changed anything. */
  private stepStood = false;
  /** Set while `step` has the undo stacks rearranged: nobody is told of them in that state. */
  private stepping = false;
  /** Values that `prepare` has pointed at what stands in for them, for one step only. */
  private readonly lent: Y.Item[] = [];
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
    this.rate = fpsOf(this.project.settings);

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
    this.undoManager.on('stack-item-added', ({ stackItem, origin }) => {
      stackItem.meta.set(STEP_RATE, this.rate);
      stackItem.meta.set(STEP_SHARED, sharedFrames(this.before));
      this.noteValues(stackItem);
      if (origin === this.undoManager) this.filed = stackItem;
      this.emitMeta();
    });
    this.undoManager.on('stack-item-updated', ({ stackItem }) => this.noteValues(stackItem));
    this.undoManager.on('stack-item-popped', ({ stackItem, type }) => {
      this.settle(stackItem, type);
      this.emitMeta();
    });
    this.undoManager.on('stack-cleared', this.emitMeta);
    // What an undo or redo writes is noted field by field: `settle` goes by that and no more.
    this.yClips.observeDeep((events, tr) => {
      if (tr.origin !== this.undoManager) return;
      const { clips } = this.written;
      for (const ev of events) {
        if (ev.target === this.yClips) {
          for (const id of ev.changes.keys.keys()) clips.set(id, true);
          continue;
        }
        const id = String(ev.path[0]);
        const fields = clips.get(id) ?? new Set<string>();
        if (fields === true) continue;
        for (const key of ev.changes.keys.keys()) fields.add(key);
        clips.set(id, fields);
      }
    });
    this.yMarkers.observe((event, tr) => {
      if (tr.origin === this.undoManager) for (const id of event.keysChanged) this.written.markers.add(id);
    });
    // Listeners run in the order they were added: the undo manager's has stamped the step by now.
    doc.on('afterTransaction', this.noteRate);
    this.before = this.project;
    doc.on('beforeTransaction', this.noteBefore);
  }

  // ───────────────────────────────────────────────────────────── reading ──

  get(): Project {
    return this.project;
  }

  /**
   * The clips that are in the document but not in the snapshot, because their track is missing.
   * Nothing renders or edits them; they are listed so that they can be shown and given a track
   * again. Each is the clip as it would read on a track: move it with an `updateClip` of `trackId`,
   * or drop it with `removeClip`. Their frame numbers follow the project's frame rate.
   *
   * The list is made on each call, and subscribers are not told when only hidden clips change.
   */
  hiddenClips(): Clip[] {
    const { tracks } = this.project;
    return Array.from(this.allClips.values()).filter((c) => !Object.hasOwn(tracks, c.trackId));
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
    // A step is recorded at one frame rate (see `retime`). A gesture that is still going when
    // the rate changes under it goes on in a step of its own.
    const step = this.undoManager.undoStack.at(-1);
    const merge = opts.merge && step && sameRate(this.rate / step.meta.get(STEP_RATE));
    if (undoable && !merge) this.undoManager.stopCapturing();
    this.doc.transact(
      () => {
        const k = this.rateChange(edits);
        for (const e of edits) this.apply(e, !sameRate(k));
        if (!sameRate(k)) this.retimeHiddenClips(k);
      },
      undoable ? this.origin : this.systemOrigin,
    );
  }

  /** Force the next commit to start a new undo step even if it is flagged `merge`. */
  beginGesture(): void {
    this.undoManager.stopCapturing();
  }

  /**
   * Take back the last step that still has something to take back. Steps whose every change someone
   * else has since replaced or removed are passed over, and the outcome says how many.
   */
  undo(): StepOutcome {
    return this.step('undo');
  }

  /** Make the last undone step again, passing over steps like `undo` does. */
  redo(): StepOutcome {
    return this.step('redo');
  }

  /**
   * Edits never leave two clips on the same frames of a track, but two people can each put one
   * there at the same moment, and both edits arrive. Of every two such clips the one with the
   * greater id gives way and moves to a free track (see `separateClips`), outside the undo history.
   *
   * It is moved by one session and no other, or two would each add a track for it where a new
   * track is needed: by one of those that last wrote where the clip is (its track, its start or
   * its length), and of these the one with the greatest client id. Every session works that out
   * alike, so each can call this when changes from others have come in and settled, and only that
   * one moves the clip. A session that placed nothing, a viewer among them, never writes.
   *
   * `here` names the sessions that are in the project now and may edit, this one among them, by
   * client id. A session that has left is then passed over, and the clip does not wait for it.
   * Without `here` the clip stays where it is when the session it falls to is gone.
   *
   * Returns the number of clips this session moved.
   */
  resolveOverlaps(here?: Iterable<number>): number {
    const present = here && new Set(here);
    const mine = new Set<ID>();
    for (const [a, b] of overlappingPairs(this.project)) {
      const id = a.id > b.id ? a.id : b.id;
      if (this.moverOf(id, present) === this.doc.clientID) mine.add(id);
    }
    const edits = separateClips(this.project, mine);
    this.commit(edits, { undoable: false });
    return edits.filter((e) => e.op === 'updateClip').length;
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
    this.doc.off('afterTransaction', this.noteRate);
    this.doc.off('beforeTransaction', this.noteBefore);
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

  private noteRate = (): void => {
    this.rate = fpsOf(this.project.settings);
  };

  private noteBefore = (tr: Y.Transaction): void => {
    if (tr.origin === this.origin || tr.origin === this.undoManager) this.before = this.project;
  };

  private emitMeta = (): void => {
    if (this.stepping) return;
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

  /** Take steps off the undo or the redo stack until one of them leaves something changed. */
  private step(type: 'undo' | 'redo'): StepOutcome {
    const um = this.undoManager;
    const from = type === 'undo' ? um.undoStack : um.redoStack;
    const to = type === 'undo' ? um.redoStack : um.undoStack;
    let changed = false;
    let dropped = 0;
    this.stepping = true;
    try {
      while (!changed && from.length > 0) {
        this.prepare(from[from.length - 1]);
        // Left to itself the undo manager goes straight on to the next step when one comes to
        // nothing, and that one has not been looked at yet. So it is given one step at a time. The
        // others wait at the bottom of the other stack, where it still finds them when it asks
        // which values its own steps have deleted.
        const waiting = from.splice(0, from.length - 1);
        to.splice(0, 0, ...waiting);
        this.stepStood = false;
        this.filed = null;
        try {
          if (type === 'undo') um.undo();
          else um.redo();
        } finally {
          from.splice(0, 0, ...to.splice(0, waiting.length));
          for (const item of this.lent.splice(0)) item.redone = null;
        }
        if (this.stepStood) changed = true;
        else dropped++;
      }
    } finally {
      this.stepping = false;
    }
    if (changed || dropped) this.emitMeta();
    return { changed, dropped };
  }

  /**
   * The last value the step has written under each key, read off the document while it still holds
   * them all: a transaction's own values are intact until the transaction is wound up. A step grows
   * with every commit of a gesture, and only what has been added since the last time is read. With
   * a value that places a clip goes the whole place the clip is left in.
   */
  private noteValues(step: UndoStep): void {
    let values = step.meta.get(STEP_VALUES) as StepValues | undefined;
    if (!values) step.meta.set(STEP_VALUES, (values = new Map()));
    let places = step.meta.get(STEP_PLACES) as StepPlaces | undefined;
    if (!places) step.meta.set(STEP_PLACES, (places = new Map()));
    const client = this.doc.clientID;
    const structs = this.doc.store.clients.get(client);
    if (!structs) return;
    const noted = (step.meta.get(STEP_NOTED) as number | undefined) ?? 0;
    step.meta.set(STEP_NOTED, Y.getState(this.doc.store, client));
    for (const { clock, len } of step.insertions.clients.get(client) ?? []) {
      const from = Math.max(clock, noted);
      if (from >= clock + len) continue;
      for (
        let i = Y.findIndexSS(structs, from);
        i < structs.length && structs[i].id.clock < clock + len;
        i++
      ) {
        const item = structs[i];
        if (!(item instanceof Y.Item) || item.parentSub === null) continue;
        if (!(item.content instanceof Y.ContentAny)) continue;
        const parent = item.parent as ValueMap;
        let keys = values.get(parent);
        if (!keys) values.set(parent, (keys = new Map()));
        const last = Math.min(item.id.clock + item.length, clock + len) - item.id.clock - 1;
        keys.set(item.parentSub, item.content.getContent()[last]);
        if (!PLACEMENT.has(item.parentSub) || parent._item?.parent !== this.yClips) continue;
        const clip = this.allClips.get(parent._item.parentSub as ID);
        if (clip) places.set(clip.id, { start: clip.start, duration: clip.duration });
      }
    }
  }

  /**
   * The undo manager takes a step back by looking at what stands under each key now, and three
   * things mislead it. They are put right before it looks.
   *
   * - A value the step wrote may since have been written again by someone else without being
   *   changed: a change of frame rate writes the place of every clip, moved or not, and what it
   *   does alter is the same value at another rate. The undo manager would take any such write
   *   for a change of mind and leave the step with nothing to take back. So the step's value is
   *   pointed at the one that stands in for it, the way the undo manager links its own
   *   restorations, and the step is taken back from there. (Not for a step that set the frame
   *   rate itself: once someone else has set another, there is nothing of it to take back.)
   *   Where the step's value has been taken back and made again since, it is the last copy of it
   *   that is pointed there, and only until the step is done (`lent`): a copy may yet have to be
   *   put back by the step that removed it, and a pointer on it says that this has been done.
   * - An entry the step changed, a marker or a folder, may since have been deleted by someone
   *   else. Finding nobody's value in the way, the undo manager would put the old entry back and
   *   so undo that person's deletion. The old value is counted among those the step made and
   *   removed itself, which are never put back.
   * - It finds its way from a value, and from the clip or track the value belongs to, to the copy
   *   it once restored that as, and on from there. A copy that was deleted again long ago may
   *   have been collected, and the undo manager falls over what is left of it (`unlinkCollected`).
   */
  private prepare(step: UndoStep): void {
    const values = step.meta.get(STEP_VALUES) as StepValues | undefined;
    const setsRate = this.setsRate(step);
    const k = fpsOf(this.project.settings) / step.meta.get(STEP_RATE);
    /** The keys under which the step's value is gone and nothing has come in its place. */
    const gone = new Map<ValueMap, Set<string>>();
    const retired = Y.createDeleteSet();
    this.doc.transact((tr) => {
      eachValue(tr, step.insertions, (mine) => {
        if (!mine.deleted || Y.isDeleted(step.deletions, mine.id)) return;
        const map = mine.parent as ValueMap;
        const key = mine.parentSub as string;
        // Where the undo manager looks for the step's value: at the last copy it was restored as.
        const last = this.latest(tr, mine);
        if (!last?.deleted) return;
        const own = values?.get(map);
        const same = (is: unknown): boolean => this.sameValue(map, key, own?.get(key), is, k);
        // On from there to the value that stands now, for as long as each one on the way reads as
        // the step's own. There can be several: what stands in for a length is written again when
        // an undo of this session puts the clip somewhere else (`atStepRate`).
        let now = last;
        while (now.deleted) {
          const next = now.right;
          if (!next) {
            gone.set(map, (gone.get(map) ?? new Set()).add(key));
            return;
          }
          if (setsRate || !own?.has(key) || !(next.content instanceof Y.ContentAny)) return;
          if (!next.content.getContent().every(same)) return;
          const copy = this.latest(tr, next);
          if (!copy) return;
          now = copy;
        }
        standsFor(now, last);
        if (last !== mine) this.lent.push(last);
      });
      eachValue(tr, step.deletions, (was) => {
        this.unlinkCollected(was);
        if (!gone.get(was.parent as ValueMap)?.has(was.parentSub as string)) return;
        if (!(was.content instanceof Y.ContentAny) || Y.isDeleted(step.insertions, was.id)) return;
        const ranges = retired.clients.get(was.id.client) ?? [];
        ranges.push({ clock: was.id.clock, len: 1 });
        retired.clients.set(was.id.client, ranges);
      });
    });
    if (retired.clients.size) step.insertions = Y.mergeDeleteSets([step.insertions, retired]);
  }

  /** Whether the step wrote the frame rate. */
  private setsRate(step: UndoStep): boolean {
    const values = step.meta.get(STEP_VALUES) as StepValues | undefined;
    return values?.get(this.ySettings)?.has('fpsNum') ?? false;
  }

  /**
   * Take off the links to restored copies that lead to nothing any more, wherever the undo manager
   * would follow one to put `was` back: from the map `was` is a value of, and from the values that
   * came after `was` under its key. What such a link started from has no copy then.
   */
  private unlinkCollected(was: Y.Item): void {
    const copyOf = (item: Y.Item): Y.Item | Y.GC | null =>
      item.redone === null ? null : Y.getItem(this.doc.store, item.redone);
    for (let holder = (was.parent as ValueMap)._item; holder !== null && holder.redone !== null;) {
      const copy = copyOf(holder);
      if (copy instanceof Y.Item && copy.content instanceof Y.ContentType) holder = copy;
      else holder.redone = null;
    }
    for (let at: Y.Item | null = was; at !== null;) {
      const copy = copyOf(at);
      if (copy instanceof Y.Item) at = copy;
      else if (copy) at.redone = null;
      else at = at.right;
    }
  }

  /**
   * Whether `is` is the value `was` under the same key, as `was` reads at a frame rate `k` times
   * the one it was written at.
   */
  private sameValue(map: ValueMap, key: string, was: unknown, is: unknown, k: number): boolean {
    if (deepEqual(was, is)) return true;
    if (sameRate(k)) return false;
    if (map === this.yMarkers) {
      const marker = readMarker(key, was);
      if (!marker) return false;
      return deepEqual(
        readMarker(key, { ...marker, frame: Math.round(marker.frame * k) }),
        readMarker(key, is),
      );
    }
    if (map._item?.parent !== this.yClips) return false;
    const holding = (value: unknown): Clip | null =>
      readClip('', { trackId: '', type: 'video', [key]: value });
    const before = holding(was);
    const after = holding(is);
    if (!before || !after) return false;
    // A length is re-timed from both ends of its clip, and comes out a frame either side of this.
    if (key === 'duration') return Math.abs(after.duration - before.duration * k) <= 1;
    const there: Partial<Clip> = clipAtRate(before, k);
    return key in there && deepEqual(there[key as keyof Clip], after[key as keyof Clip]);
  }

  /**
   * The session a clip that has to give way is moved by: the one with the greatest client id of
   * those that last wrote one of the fields that place it, counting only those `present` names.
   */
  private moverOf(id: ID, present?: ReadonlySet<number>): number | null {
    const fields = this.yClips.get(id)?._map;
    let mover: number | null = null;
    for (const key of ['trackId', 'start', 'duration']) {
      const client = fields?.get(key)?.id.client;
      if (client === undefined || (present && !present.has(client))) continue;
      if (mover === null || client > mover) mover = client;
    }
    return mover;
  }

  /** The factor by which `edits` change the frame rate, all their settings taken together. */
  private rateChange(edits: Edit[]): number {
    let next: Json | null = null;
    for (const e of edits) {
      if (e.op !== 'settings') continue;
      next ??= this.ySettings.toJSON();
      for (const [k, v] of Object.entries(e.patch)) if (v !== undefined) next[k] = v;
    }
    return next ? fpsOf(readSettings(next)) / fpsOf(this.project.settings) : 1;
  }

  /**
   * A new frame rate comes with the edits that re-time the sequence (`changeFrameRate`), and those
   * are made from the snapshot. The clips the snapshot leaves out are re-timed here, inside the
   * same transaction: by the same ratio, from what they were before it, and as part of the same
   * undo step. A clip that gets its track back is then where it was in real time.
   */
  private retimeHiddenClips(k: number): void {
    for (const c of this.hiddenClips()) {
      this.patchEntity(this.yClips, c.id, clipAtRate(c, k), CLIP_DEFAULTS, PLACEMENT);
    }
  }

  /**
   * The undo manager has taken a step back, or made one again, and filed that as a step of its
   * own. It works value by value and knows nothing of what the values mean, which leaves three
   * things to do:
   *
   * - `mend`: put back what it took away without putting anything in its place;
   * - `retime`: bring what the step wrote to the frame rate the document has by now;
   * - `makeRoom`: move a clip that came back onto frames someone else's clip has taken since.
   *
   * All of it is written to the document like any edit, so everyone receives it, and made part of
   * the filed step: one press of undo is one step, for whoever takes it back and for whoever keeps
   * notes on it.
   */
  private settle(step: UndoStep, type: 'undo' | 'redo'): void {
    const written = this.written;
    this.written = noWrites();
    // Stamped with the rate the undo or redo began at.
    const filed = this.filed;
    this.filed = null;
    // The undo manager also reports a step whose every restoration fell into something that is
    // deleted. Nothing changed then, and nothing was filed.
    if (!filed) return;
    this.stepStood = true;
    const stack = type === 'undo' ? this.undoManager.redoStack : this.undoManager.undoStack;
    this.mend(step, filed);
    // To the present rate, which may be one of the values just mended: from the rate of what the
    // step put back, and from that of all the rest.
    const now = fpsOf(this.project.settings);
    const back = now / step.meta.get(STEP_RATE);
    const rest = now / filed.meta.get(STEP_RATE);
    if (!sameRate(back) || !sameRate(rest)) this.retime(step, back, rest, written);
    this.makeRoom(step, filed, written, !sameRate(back), !sameRate(rest));
    for (const extra of stack.splice(stack.indexOf(filed) + 1)) {
      // A value the step put back and one of the above then replaced is the same value in another
      // form. The undo manager is told so, the way it notes its own restorations: an earlier step
      // that has to take that value away again then finds the one that stands in for it.
      this.doc.transact((tr) => {
        Y.iterateDeletedStructs(tr, extra.deletions, (was) => {
          if (!(was instanceof Y.Item) || !was.right || !Y.isDeleted(filed.insertions, was.id)) return;
          // A copy of several values that had been kept as one item is itself one item. Only its
          // last part was ever the value under the key; that part is split off and comes next.
          if (was.length > 1) Y.getItemCleanStart(tr, was.lastId);
          else standsFor(was.right, was);
        });
      });
      filed.insertions = Y.mergeDeleteSets([filed.insertions, extra.insertions]);
      filed.deletions = Y.mergeDeleteSets([filed.deletions, extra.deletions]);
      this.noteValues(filed);
    }
  }

  /** What stands for `item` now: undo and redo put a copy in the place of a value they restore. */
  private latest(tr: Y.Transaction, item: Y.Item): Y.Item | null {
    let at = item;
    while (at.redone !== null) {
      const next = Y.getItemCleanStart(tr, at.redone);
      if (!(next instanceof Y.Item)) return null;
      at = next;
    }
    return at;
  }

  /**
   * The map `item` is a value of, as the document has it now: an asset, a track or a clip that was
   * deleted and has come back is another map than it was. Null when it is not in the document.
   */
  private mapNow(tr: Y.Transaction, item: Y.Item): Y.Map<unknown> | null {
    const map = item.parent as Y.Map<unknown>;
    if (map._item === null) return map;
    const holder = this.latest(tr, map._item);
    if (!holder || holder.deleted || !(holder.content instanceof Y.ContentType)) return null;
    return holder.content.type as Y.Map<unknown>;
  }

  /**
   * A step replaced values, and taking it back means: where its own value still stood, the value
   * from before stands again. The undo manager does not do that where someone wrote the same
   * value (a setting, a marker, a folder, a field of an entity) at the same moment, without having
   * seen the step, and lost to it. It takes the step's value away and, finding that other write in
   * between, puts nothing in its place: a clip without a start, a project without a name. The
   * value from before is put back here. (What the other person wrote is not kept anywhere.)
   */
  private mend(step: UndoStep, filed: UndoStep): void {
    const putBack: { map: Y.Map<unknown>; key: string; value: unknown; was: Y.ID }[] = [];
    this.doc.transact((tr) => {
      /** The last value the step itself wrote under each key: what there was to take back. */
      const own = new Map<ValueMap, Map<string, Y.Item>>();
      eachValue(tr, step.insertions, (item) => {
        if (Y.isDeleted(step.deletions, item.id)) return;
        const parent = item.parent as ValueMap;
        let keys = own.get(parent);
        if (!keys) own.set(parent, (keys = new Map()));
        keys.set(item.parentSub as string, item);
      });
      // The values the step replaced or removed.
      eachValue(tr, step.deletions, (was) => {
        if (was.redone !== null || !(was.content instanceof Y.ContentAny)) return;
        if (Y.isDeleted(step.insertions, was.id)) return;
        const map = this.mapNow(tr, was);
        if (!map) return;
        const key = was.parentSub as string;
        const head = map._map.get(key);
        if (head && !head.deleted) return;
        const mine = own.get(was.parent as ValueMap)?.get(key);
        const last = mine && this.latest(tr, mine);
        // The step's value stood until just now, or the step had removed the entry with all it held.
        const stood = mine ? !!last && Y.isDeleted(filed.deletions, last.id) : map !== was.parent;
        if (stood) putBack.push({ map, key, value: was.content.getContent()[0], was: was.id });
      });
    });
    if (!putBack.length) return;
    this.doc.transact((tr) => {
      for (const { map, key, value, was } of putBack) {
        const head = map._map.get(key);
        if (head && !head.deleted) continue;
        map.set(key, value);
        // As the undo manager notes its own restorations, so that an earlier step finds this one.
        const replaced = Y.getItemCleanStart(tr, was);
        if (replaced.length > 1) Y.getItemCleanStart(tr, Y.createID(was.client, was.clock + 1));
        standsFor(map._map.get(key) as Y.Item, replaced);
      }
    }, this.origin);
  }

  /**
   * Undo and redo put values back as they were written, and a frame number is only right at the
   * frame rate it was written at. A step can leave two things at another rate than the document's:
   *
   * - what it put back, when the rate is no longer the one the step was recorded at: a deleted
   *   track that returns with its clips after someone else changed the rate;
   * - what it left alone, when the step is itself a change of rate: the clip someone else has
   *   added or moved since, which was never part of it.
   *
   * Both are re-timed here: the first by `back`, the second by `rest`. Where a clip is has two
   * halves, and a step that put back only one of them takes the clip across by both wherever the
   * other is known at the step's rate (`atStepRate`).
   */
  private retime(step: UndoStep, back: number, rest: number, written: StepWrites): void {
    const { markers } = this.project;
    // A step that changed the rate left its clips at the rate it set, not at the one it began at.
    const places = this.setsRate(step) ? undefined : (step.meta.get(STEP_PLACES) as StepPlaces | undefined);
    this.doc.transact(() => {
      if (!sameRate(back)) {
        for (const [id, fields] of written.clips) {
          const c = this.allClips.get(id);
          if (!c) continue;
          const placed = fields === true ? null : atStepRate(c, fields, places?.get(id), back);
          const stale = (key: string): boolean =>
            fields === true || fields.has(key) || (!!placed && PLACEMENT.has(key));
          this.patchEntity(this.yClips, id, retimed(placed ?? c, back, stale), CLIP_DEFAULTS);
        }
        for (const id of written.markers) {
          if (!Object.hasOwn(markers, id)) continue;
          const frame = Math.round(markers[id].frame * back);
          if (frame !== markers[id].frame) this.yMarkers.set(id, { ...markers[id], frame });
        }
      }
      if (!sameRate(rest)) {
        // A change of rate writes where every clip is and where every marker is, so a place the
        // step did not put back is one that somebody has set since, at the rate that is being
        // left. It is re-timed and written here in the same way, changed or not: taking the step
        // the other way then puts back exactly what that person had set. For the other fields the
        // step holds only what the change altered: one that reads the same at both rates (taking
        // it from this rate to the other would not alter it) is one the change never touched, and
        // it stays exactly as it is.
        for (const c of this.allClips.values()) {
          const fields = written.clips.get(c.id);
          if (fields === true) continue;
          const unmoved: Partial<Clip> = clipAtRate(c, 1 / rest);
          const patch = retimed(
            c,
            rest,
            (key) =>
              !fields?.has(key) &&
              (PLACEMENT.has(key) || !deepEqual(unmoved[key as keyof Clip], c[key as keyof Clip])),
          );
          this.patchEntity(this.yClips, c.id, patch, CLIP_DEFAULTS, PLACEMENT);
        }
        for (const m of Object.values(markers)) {
          if (!written.markers.has(m.id))
            this.yMarkers.set(m.id, { ...m, frame: Math.round(m.frame * rest) });
        }
      }
    }, this.origin);
  }

  /**
   * A clip the step placed may have come back to frames where someone else has put a clip since.
   * It gives way and goes to a free track, as a clip pasted where there is no room does.
   *
   * Only where the step made two clips meet that were not together before. Two that shared frames
   * in the project the step gives back are what it is there to give back: for someone who works
   * alone those are the only clips an undo can bring together, and every undo returns exactly
   * what there was. Two that shared frames just before the step are none of its business either.
   *
   * And two clips that both came back are another matter when they came back as they were: whole,
   * or with a change of rate (`rateStep`). A change of rate can round two very short clips onto
   * one frame, and taking the step the other way has to give exactly that again. The same rounding
   * is at work when what the step put back had to be brought to another rate (`fromOtherRate`): a
   * clip of one frame that begins where the next one does is how the change of rate itself would
   * have left the two.
   */
  private makeRoom(
    step: UndoStep,
    filed: UndoStep,
    written: StepWrites,
    fromOtherRate: boolean,
    rateStep: boolean,
  ): void {
    const placed = (id: ID): boolean => {
      const fields = written.clips.get(id);
      return fields === true || !!(fields?.has('start') || fields?.has('duration') || fields?.has('trackId'));
    };
    const whole = (id: ID): boolean => written.clips.get(id) === true;
    const pairs = (written.clips.size ? overlappingPairs(this.project) : []).filter(
      ([a, b]) =>
        (placed(a.id) || placed(b.id)) &&
        !(placed(a.id) && placed(b.id) && (rateStep || (whole(a.id) && whole(b.id)))) &&
        !(fromOtherRate && a.start === b.start && Math.min(a.duration, b.duration) === 1),
    );
    if (!pairs.length) return;
    const given = step.meta.get(STEP_SHARED) as ReadonlySet<string>;
    const before = filed.meta.get(STEP_SHARED) as ReadonlySet<string>;
    const moving: ID[] = [];
    for (const [a, b] of pairs) {
      const pair = pairOf(a, b);
      if (!given.has(pair) && !before.has(pair)) moving.push(placed(b.id) ? b.id : a.id);
    }
    const edits = separateClips(this.project, moving);
    if (!edits.length) return;
    this.doc.transact(() => {
      for (const e of edits) this.apply(e, false);
    }, this.origin);
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

  /** Write the fields of `patch` that differ from what the entity holds, and those in `always`. */
  private patchEntity(
    map: Y.Map<Y.Map<unknown>>,
    id: ID,
    patch: Record<string, unknown>,
    defaults?: Record<string, unknown>,
    always?: ReadonlySet<string>,
  ): void {
    const m = map.get(id);
    if (!m) return;
    // Compare against the live Y.Map (not the snapshot) so several edits to one entity inside a
    // single transaction compose correctly.
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || v === undefined) continue;
      const cur = m.has(k) ? m.get(k) : defaults?.[k];
      if (always?.has(k) || !deepEqual(cur, v)) m.set(k, v);
    }
  }

  /**
   * `retiming` says that the commit changes the frame rate. Where its clips are is then written
   * whether the numbers change or not. Two people who change the rate at the same moment both
   * write every clip, and one of them wins each clip whole; and the undo step holds the place of
   * every clip, so taking the change back never has to guess which numbers it had left alone.
   */
  private apply(e: Edit, retiming: boolean): void {
    switch (e.op) {
      case 'settings': {
        const { fpsNum, fpsDen, ...rest } = e.patch;
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined && !deepEqual(this.ySettings.get(k), v)) this.ySettings.set(k, v);
        }
        // The frame rate is one value under two keys. A change writes both, so that of two people
        // who change it at the same moment one wins it whole.
        const rate = {
          fpsNum: fpsNum ?? this.ySettings.get('fpsNum'),
          fpsDen: fpsDen ?? this.ySettings.get('fpsDen'),
        };
        if (Object.entries(rate).some(([k, v]) => v !== this.ySettings.get(k))) {
          for (const [k, v] of Object.entries(rate)) if (v !== undefined) this.ySettings.set(k, v);
        }
        break;
      }
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
        this.patchEntity(this.yClips, e.id, e.patch, CLIP_DEFAULTS, retiming ? PLACEMENT : undefined);
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
