/**
 * Speed ramps: the clock of a clip whose speed varies.
 *
 * A ramp is a list of points on the clip's media: at second `m` of the media the speed is `v`.
 * Between two points the speed eases from one to the other, and beyond the outermost points it
 * holds. "Stream time" is the time at which the media, played along the ramp, reaches a given
 * second. A clip on a ramp is a window on that stream: it opens where the stream reaches the clip's
 * `sourceIn` and is `duration` frames long.
 *
 * The three maps below use additions, subtractions, multiplications, divisions and comparisons
 * only, in one fixed order, so every engine and every collaborator computes the same number from
 * the same ramp.
 */
import { RAMP_GAP, RAMP_MAX, RAMP_MEDIA, RAMP_MIN, RAMP_POINTS } from './defaults';
import type { RampPoint } from './types';
import { clamp, memoByRef } from './util';

/** A ramp laid out for the maps: one entry per point, and one per segment between two points. */
export interface RampTable {
  /** Number of points. */
  n: number;
  /** Media second of each point. */
  m: Float64Array;
  /** Speed at each point. */
  v: Float64Array;
  /** Stream time at which each point is reached. */
  tau: Float64Array;
  /** Seconds the segment after each point takes: its media over the mean of its two speeds. */
  d: Float64Array;
}

/**
 * The table of a ramp, built once for each array. The store hands back the same array for as long
 * as the field is unchanged, so the picture, the sound and the editor share one table.
 */
export const rampTable: (ramp: readonly RampPoint[]) => RampTable = memoByRef(
  (ramp: readonly RampPoint[]): RampTable => {
    const n = ramp.length;
    const m = new Float64Array(n);
    const v = new Float64Array(n);
    const tau = new Float64Array(n);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      m[i] = ramp[i].m;
      v[i] = ramp[i].v;
    }
    tau[0] = m[0] / v[0];
    for (let i = 0; i + 1 < n; i++) {
      d[i] = (2 * (m[i + 1] - m[i])) / (v[i] + v[i + 1]);
      tau[i + 1] = tau[i] + d[i];
    }
    return { n, m, v, tau, d };
  },
);

/** The segment `x` lies in: the last point of `at` that is not after it, short of the last point. */
function segment(at: Float64Array, n: number, x: number): number {
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The second of media the stream has reached at stream time `tau`. */
export function streamToMedia(t: RampTable, tau: number): number {
  const { m, v, d } = t;
  const last = t.n - 1;
  if (tau <= t.tau[0]) return m[0] + (tau - t.tau[0]) * v[0];
  if (tau >= t.tau[last]) return m[last] + (tau - t.tau[last]) * v[last];
  const i = segment(t.tau, t.n, tau);
  const x = (tau - t.tau[i]) / d[i];
  const a = v[i];
  const b = v[i + 1];
  return m[i] + d[i] * (a * x + (b - a) * x * x * x * (1 - x / 2));
}

/** The speed of the stream at stream time `tau`. */
export function streamSpeed(t: RampTable, tau: number): number {
  const { v, d } = t;
  const last = t.n - 1;
  if (tau <= t.tau[0]) return v[0];
  if (tau >= t.tau[last]) return v[last];
  const i = segment(t.tau, t.n, tau);
  const x = (tau - t.tau[i]) / d[i];
  const a = v[i];
  const b = v[i + 1];
  return a + (b - a) * x * x * (3 - 2 * x);
}

/**
 * The stream time at which second `media` is reached: the inverse of `streamToMedia`. Inside an
 * ease it is found by Newton's method, held between two bounds so that it cannot leave the segment,
 * and ended when a step no longer moves it. That takes some twenty steps, and all sixty-four when
 * `media` is a point of the ramp itself, so callers keep the answer (see `streamIn`) and nothing
 * asks once a frame or once a sample.
 */
export function mediaToStream(t: RampTable, media: number): number {
  const { m, v, d } = t;
  const last = t.n - 1;
  if (media <= m[0]) return t.tau[0] + (media - m[0]) / v[0];
  if (media >= m[last]) return t.tau[last] + (media - m[last]) / v[last];
  const i = segment(m, t.n, media);
  const a = v[i];
  const b = v[i + 1];
  const y = (media - m[i]) / d[i];
  let lo = 0;
  let hi = 1;
  let x = y / ((a + b) / 2);
  for (let k = 0; k < 64; k++) {
    const g = a * x + (b - a) * x * x * x * (1 - x / 2) - y;
    if (g > 0) hi = x;
    else lo = x;
    const s = a + (b - a) * x * x * (3 - 2 * x);
    let nx = x - g / s;
    if (!(nx > lo && nx < hi)) nx = (lo + hi) / 2;
    if (nx === x) break;
    x = nx;
  }
  return t.tau[i] + x * d[i];
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const round3 = (x: number): number => Math.round(x * 1e3) / 1e3;

/**
 * The points of `sorted` that are far enough from the one kept before them, up to the most a ramp
 * holds. Places are kept to the microsecond, and two points a millisecond apart on that grid must
 * not fall to the last bits of a subtraction: the gap is taken with half a microsecond to spare.
 */
function spaced<T extends RampPoint>(sorted: readonly T[]): T[] {
  const out: T[] = [];
  for (const q of sorted) {
    if (out.length && q.m - out[out.length - 1].m < RAMP_GAP - 5e-7) continue;
    out.push(q);
    if (out.length === RAMP_POINTS) break;
  }
  return out;
}

/**
 * Points as an operation writes them: places rounded to the microsecond and speeds to the
 * thousandth, both inside their ranges, in order of place, none closer than `RAMP_GAP` to the one
 * kept before it and no more than `RAMP_POINTS` of them. Two people who apply the same shape write
 * the same bytes. Null when fewer than two points are left: that is one speed, not a ramp.
 */
export function tidyRamp(points: readonly RampPoint[]): RampPoint[] | null {
  const pts: RampPoint[] = [];
  for (const q of points) {
    if (!Number.isFinite(q.m) || !Number.isFinite(q.v)) continue;
    pts.push({
      m: round6(clamp(q.m, -RAMP_MEDIA, RAMP_MEDIA)),
      v: round3(clamp(q.v, RAMP_MIN, RAMP_MAX)),
    });
  }
  pts.sort((a, b) => a.m - b.m);
  const out = spaced(pts);
  return out.length >= 2 ? out : null;
}

/** Most items of a stored ramp that are looked at. A ramp holds `RAMP_POINTS`; the rest is not one. */
const MAX_READ = 4096;

const isPoint = (q: unknown): q is RampPoint =>
  typeof q === 'object' &&
  q !== null &&
  !Array.isArray(q) &&
  Number.isFinite((q as RampPoint).m) &&
  Number.isFinite((q as RampPoint).v);

/**
 * The store's reader for `clip.ramp`: a well-formed ramp, null for no ramp, or undefined for a
 * value that is not a ramp at all. It keeps what `tidyRamp` keeps, without rounding: with places
 * and speeds inside their ranges and no two points closer than `RAMP_GAP`, every segment takes a
 * finite time that is not zero, the speed never reaches zero and the clock runs one way. A list
 * that is well-formed already is handed back as it is, so the table made for it is found again.
 */
export function conformRamp(value: unknown): RampPoint[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  let asIs = value.length <= RAMP_POINTS;
  let pts: RampPoint[] = [];
  const count = Math.min(value.length, MAX_READ);
  for (let i = 0; i < count; i++) {
    const q: unknown = value[i];
    if (!isPoint(q)) {
      asIs = false;
      continue;
    }
    const m = clamp(q.m, -RAMP_MEDIA, RAMP_MEDIA);
    const v = clamp(q.v, RAMP_MIN, RAMP_MAX);
    if (m === q.m && v === q.v && Object.keys(q).length === 2) pts.push(q);
    else {
      asIs = false;
      pts.push({ m, v });
    }
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].m >= pts[i - 1].m) continue;
    pts = pts.slice().sort((a, b) => a.m - b.m);
    asIs = false;
    break;
  }
  const out = spaced(pts);
  if (out.length < 2) return null;
  return asIs && out.length === value.length ? (value as RampPoint[]) : out;
}

/**
 * `ramp` with every point `seconds` further along the media, for a clip that plays the same curve
 * from another place in its file. The same array when the shift rounds to nothing. A shift that
 * would carry a point past `RAMP_MEDIA` stops there, so that the ramp stays whole.
 */
export function shiftRamp(ramp: RampPoint[], seconds: number): RampPoint[] {
  const s = round6(clamp(seconds, -RAMP_MEDIA - ramp[0].m, RAMP_MEDIA - ramp[ramp.length - 1].m));
  if (s === 0 || !Number.isFinite(s)) return ramp;
  return ramp.map((q) => ({ m: round6(q.m + s), v: q.v }));
}

const keyOf = memoByRef((ramp: readonly RampPoint[]): string => ramp.map((q) => `${q.m}@${q.v}`).join(' '));

/** A string that is equal for equal ramps and for no others, made once for each array. Empty for no ramp. */
export const rampKey = (ramp: RampPoint[] | null): string => (ramp ? keyOf(ramp) : '');

export type RampShape = 'rampUp' | 'rampDown' | 'montage' | 'hero' | 'bullet' | 'flashIn' | 'flashOut';

/**
 * The ready-made ramps, each as points of [fraction of the stretch in play order, speed]. A shape
 * keeps the stretch of media a clip plays and changes how long it takes: an ease from speed `a` to
 * speed `b` over `L` seconds of media takes `2L / (a + b)`.
 */
export const RAMP_SHAPES: Record<RampShape, readonly (readonly [number, number])[]> = {
  rampUp: [
    [0, 0.5],
    [1, 2],
  ],
  rampDown: [
    [0, 2],
    [1, 0.5],
  ],
  montage: [
    [0, 1],
    [0.2, 4],
    [0.45, 0.5],
    [0.7, 0.5],
    [0.9, 4],
    [1, 1],
  ],
  hero: [
    [0, 1],
    [0.25, 4],
    [0.4, 0.3],
    [0.6, 0.3],
    [0.75, 4],
    [1, 1],
  ],
  bullet: [
    [0, 5],
    [0.42, 5],
    [0.5, 0.25],
    [0.58, 5],
    [1, 5],
  ],
  flashIn: [
    [0, 5],
    [0.35, 1],
    [1, 1],
  ],
  flashOut: [
    [0, 1],
    [0.65, 1],
    [1, 5],
  ],
};

export const RAMP_SHAPE_NAMES: Record<RampShape, string> = {
  rampUp: 'Ramp up',
  rampDown: 'Ramp down',
  montage: 'Montage',
  hero: 'Hero',
  bullet: 'Bullet',
  flashIn: 'Flash in',
  flashOut: 'Flash out',
};

/**
 * A shape laid over the media from second `a` to second `b`. For a clip that plays backwards the
 * fractions count down from `b`, so the shape is the one seen in play order. Null when the stretch
 * is too short to hold every point of the shape `RAMP_GAP` apart: half a shape is another shape.
 */
export function shapeRamp(shape: RampShape, a: number, b: number, reverse: boolean): RampPoint[] | null {
  const points = RAMP_SHAPES[shape];
  const ramp = tidyRamp(points.map(([f, v]) => ({ m: reverse ? b - f * (b - a) : a + f * (b - a), v })));
  return ramp && ramp.length === points.length ? ramp : null;
}

/**
 * Two points at one speed, at seconds `a` and `b` of the media: the ramp a clip at that speed
 * starts from when points are about to be dragged. The speed is brought inside the range of a
 * ramp. Null when the two are closer than `RAMP_GAP`.
 */
export function flatRamp(a: number, b: number, v: number): RampPoint[] | null {
  return tidyRamp([
    { m: a, v },
    { m: b, v },
  ]);
}

/**
 * The shape a ramp is, if any: as many points, the same speeds, and each point at the shape's
 * fraction of the ramp's own extent to within a thousandth (counted down from the top for a clip
 * that plays backwards). A trim, a split or a slip does not write the ramp, so a shape is still
 * found on the pieces.
 */
export function shapeOf(ramp: RampPoint[], reverse: boolean): RampShape | null {
  const n = ramp.length;
  const lo = ramp[0].m;
  const extent = ramp[n - 1].m - lo;
  for (const shape of Object.keys(RAMP_SHAPES) as RampShape[]) {
    const points = RAMP_SHAPES[shape];
    if (points.length !== n) continue;
    const fits = points.every(([f, v], i) => {
      const q = reverse ? ramp[n - 1 - i] : ramp[i];
      const at = (q.m - lo) / extent;
      return q.v === v && Math.abs((reverse ? 1 - at : at) - f) <= 1e-3;
    });
    if (fits) return shape;
  }
  return null;
}

/**
 * For drawing a ramp: places and speeds along its curve from second `from` to second `to` of the
 * media, in order, with `per` samples to each ease. The first is at `from` and the last at `to`.
 */
export function rampCurve(ramp: RampPoint[], from: number, to: number, per = 16): RampPoint[] {
  const t = rampTable(ramp);
  const at = (m: number): RampPoint => ({ m, v: streamSpeed(t, mediaToStream(t, m)) });
  const out: RampPoint[] = [at(from)];
  for (let i = 0; i + 1 < t.n; i++) {
    if (t.m[i + 1] <= from) continue;
    if (t.m[i] >= to) break;
    const a = t.v[i];
    const b = t.v[i + 1];
    for (let k = 0; k < per; k++) {
      const x = k / per;
      const m = t.m[i] + t.d[i] * (a * x + (b - a) * x * x * x * (1 - x / 2));
      if (m > from && m < to) out.push({ m, v: a + (b - a) * x * x * (3 - 2 * x) });
    }
  }
  const end = t.m[t.n - 1];
  if (end > from && end < to) out.push({ m: end, v: t.v[t.n - 1] });
  if (to > from) out.push(at(to));
  return out;
}
