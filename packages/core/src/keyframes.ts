import type { Clip, Easing, Keyframe } from './types';
import { clamp } from './util';

/** Solve a CSS-style cubic bezier (P0 = 0,0  P3 = 1,1) for y at x. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const yAt = (t: number): number => ((ay * t + by) * t + cy) * t;
  const tolerance = 1e-7;
  // Newton–Raphson settles in a few steps on ordinary curves.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = xAt(t) - x;
    if (Math.abs(err) < tolerance) {
      if (t >= 0 && t <= 1) return yAt(t);
      break;
    }
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  // It stalls where the curve runs flat in x (a handle at x1 = 1 or x2 = 0) and can leave 0…1.
  // x(t) rises monotonically for handles inside 0…1, so bisection always closes in.
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 48; i++) {
    const err = xAt(t) - x;
    if (Math.abs(err) < tolerance) break;
    if (err < 0) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return yAt(t);
}

export const EASING_BEZIERS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

const EASING_NAMES: Record<Extract<Easing, string>, true> = {
  linear: true,
  hold: true,
  ease: true,
  easeIn: true,
  easeOut: true,
  easeInOut: true,
};

/**
 * A well-formed easing from a value that may be anything: a preset name, or a bezier
 * `[x1, y1, x2, y2]` whose time handles stay inside the segment (outside 0…1 the curve would fold
 * back on itself). Anything else interpolates linearly. A well-formed curve is returned as it is.
 */
export function conformEasing(e: unknown): Easing {
  if (typeof e === 'string') return Object.hasOwn(EASING_NAMES, e) ? (e as Easing) : 'linear';
  if (!Array.isArray(e) || e.length !== 4 || !e.every(Number.isFinite)) return 'linear';
  const [x1, y1, x2, y2] = e as [number, number, number, number];
  const inside = x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1;
  return inside ? (e as [number, number, number, number]) : [clamp(x1, 0, 1), y1, clamp(x2, 0, 1), y2];
}

export function applyEasing(e: Easing, t: number): number {
  if (e === 'linear') return t;
  if (e === 'hold') return 0;
  const bz = typeof e === 'string' ? EASING_BEZIERS[e] : e;
  if (!bz) return t;
  return cubicBezier(bz[0], bz[1], bz[2], bz[3], t);
}

/** Evaluate a sorted keyframe list at clip-local frame `t`. */
export function evalKeyframes(kfs: readonly Keyframe[], t: number): number {
  const n = kfs.length;
  if (n === 0) return 0;
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[n - 1];
  if (t >= last.t) return last.v;
  // Binary search for the segment containing t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo];
  const b = kfs[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = applyEasing(a.e, (t - a.t) / span);
  return a.v + (b.v - a.v) * u;
}

/** Animated numeric clip properties that live directly on the clip. */
export const ANIMATABLE_CLIP_PROPS = [
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
  'cropL',
  'cropT',
  'cropR',
  'cropB',
  'volume',
  'pan',
] as const;

export type AnimatableClipProp = (typeof ANIMATABLE_CLIP_PROPS)[number];

/** Keyframe path of an effect parameter. */
export const fxPath = (effectId: string, param: string): string => `fx:${effectId}:${param}`;

/** Read a numeric property at a clip-local frame, honouring keyframes. */
export function animated(clip: Clip, path: string, localFrame: number, fallback: number): number {
  const kfs = clip.keyframes[path];
  if (kfs && kfs.length) return evalKeyframes(kfs, localFrame);
  return fallback;
}

export function hasKeyframes(clip: Clip, path: string): boolean {
  const k = clip.keyframes[path];
  return !!k && k.length > 0;
}

/** Insert or replace a keyframe, keeping the list sorted. Returns a new list. */
export function upsertKeyframe(kfs: readonly Keyframe[] | undefined, kf: Keyframe): Keyframe[] {
  const out = (kfs ?? []).filter((k) => k.t !== kf.t);
  out.push(kf);
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function removeKeyframeAt(kfs: readonly Keyframe[] | undefined, t: number): Keyframe[] {
  return (kfs ?? []).filter((k) => k.t !== t);
}

/** Shift / crop keyframes when a clip's head moves by `delta` frames (positive = head trimmed in). */
export function shiftKeyframes(
  keyframes: Record<string, Keyframe[]>,
  delta: number,
): Record<string, Keyframe[]> {
  if (delta === 0) return keyframes;
  const out: Record<string, Keyframe[]> = {};
  for (const [path, kfs] of Object.entries(keyframes)) {
    out[path] = kfs.map((k) => ({ ...k, t: k.t - delta }));
  }
  return out;
}

/** Stretch keyframe times, e.g. after a speed change. */
export function scaleKeyframes(
  keyframes: Record<string, Keyframe[]>,
  factor: number,
): Record<string, Keyframe[]> {
  if (factor === 1) return keyframes;
  const out: Record<string, Keyframe[]> = {};
  for (const [path, kfs] of Object.entries(keyframes)) {
    out[path] = kfs.map((k) => ({ ...k, t: Math.round(k.t * factor) }));
  }
  return out;
}

export function nearestKeyframe(
  kfs: readonly Keyframe[] | undefined,
  t: number,
  dir: -1 | 1,
): Keyframe | null {
  if (!kfs) return null;
  let best: Keyframe | null = null;
  for (const k of kfs) {
    if (dir === 1 && k.t > t && (!best || k.t < best.t)) best = k;
    if (dir === -1 && k.t < t && (!best || k.t > best.t)) best = k;
  }
  return best;
}
