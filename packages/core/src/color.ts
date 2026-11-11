/**
 * Colour science helpers shared by the renderer (as uniforms / GLSL) and by tests.
 * Matrices are row-major 3×3 arrays of 9 numbers.
 */
import type { Asset, ColorMode, InputColorSpace } from './types';

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export type Primaries = 'rec709' | 'p3' | 'rec2020' | 'sgamut3cine' | 'awg3' | 'vgamut';

/** CIE xy chromaticities: [rx, ry, gx, gy, bx, by]. All use a D65 white point. */
const CHROMA: Record<Primaries, [number, number, number, number, number, number]> = {
  rec709: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06],
  p3: [0.68, 0.32, 0.265, 0.69, 0.15, 0.06],
  rec2020: [0.708, 0.292, 0.17, 0.797, 0.131, 0.046],
  sgamut3cine: [0.766, 0.275, 0.225, 0.8, 0.089, -0.087],
  awg3: [0.684, 0.313, 0.221, 0.848, 0.0861, -0.102],
  vgamut: [0.73, 0.28, 0.165, 0.84, 0.1, -0.03],
};

const D65: [number, number] = [0.3127, 0.329];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  return [
    A * s,
    (c * h - b * i) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    (c * d - a * f) * s,
    C * s,
    (b * g - a * h) * s,
    (a * e - b * d) * s,
  ];
}

export function mulVec3(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const xyToXYZ = (x: number, y: number): [number, number, number] => [x / y, 1, (1 - x - y) / y];

/** RGB → CIE XYZ matrix for a set of primaries. */
export function rgbToXyz(p: Primaries): Mat3 {
  const [rx, ry, gx, gy, bx, by] = CHROMA[p];
  const r = xyToXYZ(rx, ry);
  const g = xyToXYZ(gx, gy);
  const b = xyToXYZ(bx, by);
  const w = xyToXYZ(D65[0], D65[1]);
  const m: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const s = mulVec3(inv3(m), w);
  return [
    r[0] * s[0],
    g[0] * s[1],
    b[0] * s[2],
    r[1] * s[0],
    g[1] * s[1],
    b[1] * s[2],
    r[2] * s[0],
    g[2] * s[1],
    b[2] * s[2],
  ];
}

/** Matrix converting linear RGB between two sets of primaries. */
export function gamutMatrix(from: Primaries, to: Primaries): Mat3 {
  if (from === to) return IDENTITY3;
  return mul3(inv3(rgbToXyz(to)), rgbToXyz(from));
}

/** Luma weights (Y row of RGB→XYZ). */
export function lumaWeights(p: Primaries): [number, number, number] {
  const m = rgbToXyz(p);
  return [m[3], m[4], m[5]];
}

/** Column-major Float32Array for `uniformMatrix3fv`. */
export function toGlMat3(m: Mat3): Float32Array {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

// ── Transfer functions (reference implementations, mirrored in GLSL by the engine) ──

export const srgbToLinear = (v: number): number => {
  const a = Math.abs(v);
  return Math.sign(v) * (a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4));
};

export const linearToSrgb = (v: number): number => {
  const a = Math.abs(v);
  return Math.sign(v) * (a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055);
};

const PQ = { m1: 0.1593017578125, m2: 78.84375, c1: 0.8359375, c2: 18.8515625, c3: 18.6875 };

/** PQ code value (0…1) → absolute luminance in nits. */
export function pqToNits(e: number): number {
  const p = Math.pow(Math.max(e, 0), 1 / PQ.m2);
  return 10000 * Math.pow(Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p), 1 / PQ.m1);
}

export function nitsToPq(nits: number): number {
  const y = Math.pow(Math.min(Math.max(nits / 10000, 0), 1), PQ.m1);
  return Math.pow((PQ.c1 + PQ.c2 * y) / (1 + PQ.c3 * y), PQ.m2);
}

const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };

/** HLG signal → scene linear (0…1). */
export const hlgToScene = (e: number): number =>
  e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HLG.c) / HLG.a) + HLG.b) / 12;

export const sceneToHlg = (s: number): number =>
  s <= 1 / 12 ? Math.sqrt(3 * Math.max(s, 0)) : HLG.a * Math.log(12 * s - HLG.b) + HLG.c;

// ── Colour space descriptions ───────────────────────────────────────────────

export type TransferId = 'srgb' | 'pq' | 'hlg' | 'linear' | 'slog3' | 'logc3' | 'vlog';

export interface ColorSpaceDesc {
  primaries: Primaries;
  transfer: TransferId;
  label: string;
}

export const INPUT_COLOR_SPACES: Record<Exclude<InputColorSpace, 'auto'>, ColorSpaceDesc> = {
  srgb: { primaries: 'rec709', transfer: 'srgb', label: 'sRGB' },
  rec709: { primaries: 'rec709', transfer: 'srgb', label: 'Rec.709' },
  'display-p3': { primaries: 'p3', transfer: 'srgb', label: 'Display P3' },
  'rec2020-pq': { primaries: 'rec2020', transfer: 'pq', label: 'Rec.2100 PQ (HDR10)' },
  'rec2020-hlg': { primaries: 'rec2020', transfer: 'hlg', label: 'Rec.2100 HLG' },
  linear: { primaries: 'rec709', transfer: 'linear', label: 'Linear Rec.709' },
  slog3: { primaries: 'sgamut3cine', transfer: 'slog3', label: 'Sony S-Log3 / S-Gamut3.Cine' },
  logc3: { primaries: 'awg3', transfer: 'logc3', label: 'ARRI LogC3 / AWG3' },
  vlog: { primaries: 'vgamut', transfer: 'vlog', label: 'Panasonic V-Log / V-Gamut' },
};

/** Resolve an asset's effective input colour space from its override or container metadata. */
export function resolveInputSpace(
  asset: Pick<Asset, 'inputColorSpace' | 'color'> | undefined,
): Exclude<InputColorSpace, 'auto'> {
  if (!asset) return 'rec709';
  if (asset.inputColorSpace !== 'auto') return asset.inputColorSpace;
  const c = asset.color;
  if (!c) return 'rec709';
  if (c.transfer === 'pq' || c.transfer === 'smpte2084') return 'rec2020-pq';
  if (c.transfer === 'hlg' || c.transfer === 'arib-std-b67') return 'rec2020-hlg';
  if (c.primaries === 'smpte432' || c.primaries === 'p3') return 'display-p3';
  return 'rec709';
}

export const isHdrSpace = (s: Exclude<InputColorSpace, 'auto'>): boolean =>
  s === 'rec2020-pq' || s === 'rec2020-hlg';

export const isLogSpace = (s: Exclude<InputColorSpace, 'auto'>): boolean =>
  s === 'slog3' || s === 'logc3' || s === 'vlog';

/** Primaries of the timeline working space for a colour mode. */
export const workingPrimaries = (mode: ColorMode): Primaries => (mode === 'sdr' ? 'rec709' : 'rec2020');

export const isHdrMode = (mode: ColorMode): boolean => mode !== 'sdr';
