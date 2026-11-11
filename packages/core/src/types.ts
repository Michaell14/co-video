/**
 * The Tandem project model.
 *
 * Everything in here is plain, immutable JSON. The collaborative source of truth is a Yjs document
 * (see `store.ts`); these types describe the read-only snapshot that the renderer and the UI consume.
 *
 * Conventions
 *  - Timeline positions and durations are integer FRAMES in the sequence timebase.
 *  - Source media offsets are SECONDS (media has its own timebase).
 *  - Spatial values are resolution independent: positions are fractions of the frame size,
 *    text sizes are fractions of the frame height. A project can be re-targeted from 1080p to 8K
 *    without touching a single clip.
 */

export type ID = string;

// ───────────────────────────────────────────────────────────────── settings ──

export type ColorMode = 'sdr' | 'hdr-pq' | 'hdr-hlg';
export type ToneMapOp = 'none' | 'reinhard' | 'hable' | 'aces' | 'bt2390';

export interface ProjectSettings {
  name: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
  background: string;
  /** Output / mastering colour space of the timeline. */
  colorMode: ColorMode;
  /** Operator used whenever HDR working values must be shown or delivered on an SDR target. */
  toneMap: ToneMapOp;
  /** Mastering display peak luminance for HDR deliveries (nits). */
  peakNits: number;
  /** Luminance of working-space 1.0 ("diffuse white") in HDR modes (nits). BT.2408 recommends 203. */
  refWhiteNits: number;
}

// ─────────────────────────────────────────────────────────────────── assets ──

export type AssetKind = 'video' | 'audio' | 'image' | 'lut';

export type InputColorSpace =
  | 'auto'
  | 'srgb'
  | 'rec709'
  | 'display-p3'
  | 'rec2020-pq'
  | 'rec2020-hlg'
  | 'linear'
  | 'slog3'
  | 'logc3'
  | 'vlog';

export interface AssetColorInfo {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  fullRange: boolean | null;
}

export interface Asset {
  id: ID;
  name: string;
  kind: AssetKind;
  size: number;
  mime: string;
  /** Seconds. 0 for stills. */
  duration: number;
  width: number;
  height: number;
  fps: number;
  rotation: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number;
  audioSampleRate: number;
  videoCodec: string | null;
  audioCodec: string | null;
  color: AssetColorInfo | null;
  hdr: boolean;
  inputColorSpace: InputColorSpace;
  folderId: ID | null;
  createdAt: number;
  createdBy: string;
  /** Tiny poster frame (data URL) so collaborators get an instant placeholder. */
  thumb: string | null;
  /** True once the full media file is available from the collaboration server. */
  uploaded: boolean;
}

export interface Folder {
  id: ID;
  name: string;
  parentId: ID | null;
}

// ─────────────────────────────────────────────────────────────────── tracks ──

export type TrackKind = 'video' | 'audio';

export interface TrackEQ {
  enabled: boolean;
  /** Gains in dB for low shelf / peaking mid / high shelf. */
  low: number;
  mid: number;
  high: number;
  lowFreq: number;
  midFreq: number;
  highFreq: number;
}

export interface TrackCompressor {
  enabled: boolean;
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
  makeup: number;
}

export interface Track {
  id: ID;
  kind: TrackKind;
  name: string;
  /** Sort key. Video: higher renders on top. Audio: lower is listed first. */
  order: number;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  hidden: boolean;
  height: number;
  /** dB */
  volume: number;
  /** -1 … 1 */
  pan: number;
  eq: TrackEQ | null;
  compressor: TrackCompressor | null;
}

// ──────────────────────────────────────────────────────────────────── clips ──

export type ClipType = 'video' | 'audio' | 'image' | 'text' | 'shape' | 'solid' | 'adjustment';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'add'
  | 'subtract'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export type FitMode = 'contain' | 'cover' | 'stretch' | 'none';

export type ParamValue = number | boolean | string | number[];

export interface EffectInstance {
  id: ID;
  type: string;
  enabled: boolean;
  params: Record<string, ParamValue>;
}

export type Easing =
  'linear' | 'hold' | 'ease' | 'easeIn' | 'easeOut' | 'easeInOut' | [number, number, number, number];

export interface Keyframe {
  /** Frame offset from the clip's start. */
  t: number;
  v: number;
  /** Interpolation used from this keyframe to the next. */
  e: Easing;
}

export interface Transition {
  type: string;
  /** Frames. */
  duration: number;
  params: Record<string, ParamValue>;
}

export type CurvePoint = [number, number];

/** [red, green, blue, master] */
export type Wheel = [number, number, number, number];

export interface GradeZones {
  /** Exposure offsets in stops per tonal zone, darkest → brightest. */
  black: number;
  shadow: number;
  mid: number;
  light: number;
  highlight: number;
  specular: number;
}

export interface Grade {
  enabled: boolean;
  exposure: number;
  contrast: number;
  pivot: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  hue: number;
  lift: Wheel;
  gamma: Wheel;
  gain: Wheel;
  offset: Wheel;
  curves: { m: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] };
  /** Hue (x, 0…1) versus saturation multiplier (y, 0…2 mapped to 0…1 with 0.5 = unchanged). */
  hueSat: CurvePoint[];
  /** Hue (x) versus hue shift (y, 0.5 = unchanged, ±0.5 = ±180°). */
  hueHue: CurvePoint[];
  /** Luma (x) versus saturation multiplier (y, 0.5 = unchanged). */
  lumSat: CurvePoint[];
  zones: GradeZones;
  /** Asset id of a `.cube` LUT applied after the grade. */
  lutId: ID | null;
  lutIntensity: number;
}

export interface Mask {
  type: 'rect' | 'ellipse';
  /** Centre, in layer space (0…1). */
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  feather: number;
  radius: number;
  invert: boolean;
}

export interface TextAnimation {
  type: string;
  /** Frames. */
  duration: number;
}

export interface TextProps {
  content: string;
  font: string;
  /** Font size as a fraction of the frame height. */
  size: number;
  weight: number;
  italic: boolean;
  uppercase: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** In em. */
  letterSpacing: number;
  /** Wrap width as a fraction of the frame width. `null` sizes to content. */
  boxWidth: number | null;
  gradient: { enabled: boolean; from: string; to: string; angle: number };
  stroke: { enabled: boolean; color: string; width: number };
  shadow: { enabled: boolean; color: string; blur: number; x: number; y: number; opacity: number };
  bg: { enabled: boolean; color: string; opacity: number; padX: number; padY: number; radius: number };
  animIn: TextAnimation;
  animOut: TextAnimation;
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'star' | 'polygon' | 'line' | 'arrow';

export interface ShapeProps {
  kind: ShapeKind;
  /** Size as fractions of the frame width / height. */
  w: number;
  h: number;
  fill: string;
  fillEnabled: boolean;
  gradient: { enabled: boolean; from: string; to: string; angle: number };
  stroke: string;
  strokeWidth: number;
  radius: number;
  sides: number;
}

export interface Clip {
  id: ID;
  trackId: ID;
  type: ClipType;
  assetId: ID | null;
  /** Timeline position, frames. */
  start: number;
  /** Timeline length, frames. */
  duration: number;
  /** Offset into the source media of the earliest source sample this clip uses, seconds. */
  sourceIn: number;
  speed: number;
  reverse: boolean;
  /** Hold the frame at `sourceIn` for the whole clip (a freeze frame). Video clips only. */
  freeze: boolean;
  name: string;
  /** Label colour (hex) or null for the type default. */
  label: string | null;
  enabled: boolean;
  /** Clips sharing a linkId move / trim / select together (e.g. a video and its audio). */
  linkId: ID | null;

  // Visual ──────────────────────────────────────────────────────────────────
  /** Position offset from frame centre, fractions of frame width / height. */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Degrees, clockwise. */
  rotation: number;
  anchorX: number;
  anchorY: number;
  /** 0 … 1 */
  opacity: number;
  blend: BlendMode;
  fit: FitMode;
  flipH: boolean;
  flipV: boolean;
  cropL: number;
  cropT: number;
  cropR: number;
  cropB: number;

  // Audio ───────────────────────────────────────────────────────────────────
  /** dB */
  volume: number;
  pan: number;
  /** Frames. */
  fadeIn: number;
  fadeOut: number;
  audioMuted: boolean;

  // Stacks ──────────────────────────────────────────────────────────────────
  effects: EffectInstance[];
  grade: Grade | null;
  mask: Mask | null;
  keyframes: Record<string, Keyframe[]>;
  transIn: Transition | null;
  transOut: Transition | null;

  // Generators ──────────────────────────────────────────────────────────────
  text: TextProps | null;
  shape: ShapeProps | null;
}

// ─────────────────────────────────────────────────────── markers & comments ──

export interface Marker {
  id: ID;
  frame: number;
  name: string;
  color: string;
  note: string;
}

export interface CommentReply {
  id: ID;
  text: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  createdAt: number;
}

export interface Comment {
  id: ID;
  frame: number;
  text: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  createdAt: number;
  resolved: boolean;
  /** Optional pin position on the viewer, 0…1. */
  x: number | null;
  y: number | null;
  replies: CommentReply[];
}

// ────────────────────────────────────────────────────────────────── project ──

export interface Project {
  settings: ProjectSettings;
  assets: Readonly<Record<ID, Asset>>;
  folders: Readonly<Record<ID, Folder>>;
  tracks: Readonly<Record<ID, Track>>;
  clips: Readonly<Record<ID, Clip>>;
  markers: Readonly<Record<ID, Marker>>;
}

/** Atomic edits. Every mutation of a project is expressed as a list of these. */
export type Edit =
  | { op: 'settings'; patch: Partial<ProjectSettings> }
  | { op: 'addAsset'; asset: Asset }
  | { op: 'updateAsset'; id: ID; patch: Partial<Asset> }
  | { op: 'removeAsset'; id: ID }
  | { op: 'addFolder'; folder: Folder }
  | { op: 'updateFolder'; id: ID; patch: Partial<Folder> }
  | { op: 'removeFolder'; id: ID }
  | { op: 'addTrack'; track: Track }
  | { op: 'updateTrack'; id: ID; patch: Partial<Track> }
  | { op: 'removeTrack'; id: ID }
  | { op: 'addClip'; clip: Clip }
  | { op: 'updateClip'; id: ID; patch: Partial<Clip> }
  | { op: 'removeClip'; id: ID }
  | { op: 'setMarker'; marker: Marker }
  | { op: 'removeMarker'; id: ID };
