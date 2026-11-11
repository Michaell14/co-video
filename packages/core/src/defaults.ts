import { newId } from './ids';
import type {
  Asset,
  Clip,
  ClipType,
  Grade,
  Mask,
  Project,
  ProjectSettings,
  ShapeProps,
  TextProps,
  Track,
  TrackCompressor,
  TrackEQ,
  TrackKind,
} from './types';

export const SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: ProjectSettings = {
  name: 'Untitled project',
  width: 1920,
  height: 1080,
  fpsNum: 30,
  fpsDen: 1,
  sampleRate: 48000,
  background: '#000000',
  colorMode: 'sdr',
  toneMap: 'none',
  peakNits: 1000,
  refWhiteNits: 203,
};

export const DEFAULT_TRACK_HEIGHT: Record<TrackKind, number> = { video: 64, audio: 52 };

export const DEFAULT_EQ: TrackEQ = {
  enabled: false,
  low: 0,
  mid: 0,
  high: 0,
  lowFreq: 120,
  midFreq: 1200,
  highFreq: 8000,
};

export const DEFAULT_COMPRESSOR: TrackCompressor = {
  enabled: false,
  threshold: -18,
  ratio: 3,
  attack: 0.01,
  release: 0.2,
  knee: 6,
  makeup: 0,
};

export function makeTrack(kind: TrackKind, order: number, name?: string): Track {
  return {
    id: newId(),
    kind,
    name: name ?? '',
    order,
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    height: DEFAULT_TRACK_HEIGHT[kind],
    volume: 0,
    pan: 0,
    eq: null,
    compressor: null,
  };
}

export const IDENTITY_CURVE: [number, number][] = [
  [0, 0],
  [1, 1],
];

export const FLAT_CURVE: [number, number][] = [
  [0, 0.5],
  [1, 0.5],
];

export const DEFAULT_GRADE: Grade = {
  enabled: true,
  exposure: 0,
  contrast: 0,
  pivot: 0.435,
  saturation: 1,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  hue: 0,
  lift: [0, 0, 0, 0],
  gamma: [0, 0, 0, 0],
  gain: [0, 0, 0, 0],
  offset: [0, 0, 0, 0],
  curves: { m: IDENTITY_CURVE, r: IDENTITY_CURVE, g: IDENTITY_CURVE, b: IDENTITY_CURVE },
  hueSat: FLAT_CURVE,
  hueHue: FLAT_CURVE,
  lumSat: FLAT_CURVE,
  zones: { black: 0, shadow: 0, mid: 0, light: 0, highlight: 0, specular: 0 },
  lutId: null,
  lutIntensity: 1,
};

export const DEFAULT_MASK: Mask = {
  type: 'ellipse',
  x: 0.5,
  y: 0.5,
  w: 0.6,
  h: 0.6,
  rotation: 0,
  feather: 0.05,
  radius: 0,
  invert: false,
};

export const DEFAULT_TEXT: TextProps = {
  content: 'Your text here',
  font: 'Inter',
  size: 0.09,
  weight: 700,
  italic: false,
  uppercase: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.15,
  letterSpacing: 0,
  boxWidth: null,
  gradient: { enabled: false, from: '#ffffff', to: '#8ab4ff', angle: 90 },
  stroke: { enabled: false, color: '#000000', width: 0.08 },
  shadow: { enabled: false, color: '#000000', blur: 0.15, x: 0, y: 0.06, opacity: 0.6 },
  bg: { enabled: false, color: '#000000', opacity: 0.6, padX: 0.35, padY: 0.18, radius: 0.2 },
  animIn: { type: 'none', duration: 15 },
  animOut: { type: 'none', duration: 15 },
};

export const DEFAULT_SHAPE: ShapeProps = {
  kind: 'rect',
  w: 0.3,
  h: 0.3,
  fill: '#4f8cff',
  fillEnabled: true,
  gradient: { enabled: false, from: '#4f8cff', to: '#a855f7', angle: 45 },
  stroke: '#ffffff',
  strokeWidth: 0,
  radius: 0,
  sides: 5,
};

/** Every field of a clip, with neutral values. Clips read from the doc are layered on top of this. */
export const CLIP_DEFAULTS: Omit<Clip, 'id' | 'trackId' | 'type'> = {
  assetId: null,
  start: 0,
  duration: 1,
  sourceIn: 0,
  speed: 1,
  reverse: false,
  freeze: false,
  name: '',
  label: null,
  enabled: true,
  linkId: null,
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  opacity: 1,
  blend: 'normal',
  fit: 'contain',
  flipH: false,
  flipV: false,
  cropL: 0,
  cropT: 0,
  cropR: 0,
  cropB: 0,
  volume: 0,
  pan: 0,
  fadeIn: 0,
  fadeOut: 0,
  audioMuted: false,
  effects: [],
  grade: null,
  mask: null,
  keyframes: {},
  transIn: null,
  transOut: null,
  text: null,
  shape: null,
};

export function makeClip(type: ClipType, trackId: string, init: Partial<Clip> = {}): Clip {
  return { ...CLIP_DEFAULTS, id: newId(), trackId, type, ...init };
}

export const ASSET_DEFAULTS: Omit<Asset, 'id' | 'name' | 'kind'> = {
  size: 0,
  mime: '',
  duration: 0,
  width: 0,
  height: 0,
  fps: 0,
  rotation: 0,
  hasVideo: false,
  hasAudio: false,
  audioChannels: 0,
  audioSampleRate: 0,
  videoCodec: null,
  audioCodec: null,
  color: null,
  hdr: false,
  inputColorSpace: 'auto',
  folderId: null,
  createdAt: 0,
  createdBy: '',
  thumb: null,
  uploaded: false,
};

export function emptyProject(settings: Partial<ProjectSettings> = {}): Project {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    assets: {},
    folders: {},
    tracks: {},
    clips: {},
    markers: {},
  };
}

/** A fresh project gets two video tracks and two audio tracks, like every NLE since the dawn of time. */
export function starterTracks(): Track[] {
  return [
    makeTrack('video', 0),
    makeTrack('video', 1),
    makeTrack('audio', 0),
    makeTrack('audio', 1),
  ];
}

/** Colours used for clip chips on the timeline, per type. */
export const CLIP_TYPE_COLORS: Record<ClipType, string> = {
  video: '#3b82f6',
  image: '#8b5cf6',
  audio: '#10b981',
  text: '#f59e0b',
  shape: '#ec4899',
  solid: '#64748b',
  adjustment: '#14b8a6',
};

export const LABEL_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#64748b',
];

export const MARKER_COLORS = ['#f59e0b', '#ef4444', '#10b981', '#3b82f6', '#a855f7', '#ec4899', '#e5e7eb'];

/** Whether a clip type draws pixels. */
export const isVisual = (type: ClipType): boolean => type !== 'audio';

/** Whether a clip type is backed by time-based source media. */
export const hasSourceTime = (type: ClipType): boolean => type === 'video' || type === 'audio';
