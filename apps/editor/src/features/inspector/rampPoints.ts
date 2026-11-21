/**
 * The arithmetic of the speed ramp graph: where a point of a ramp lies in the graph and what a
 * place in the graph means, which points are shown, what a drag or a key makes of one, and the
 * lines that are drawn. Pure functions of the clip and its ramp, so they can be tested without a
 * browser.
 *
 * The graph runs across the stretch of media its clip plays, in the order the clip plays it, and
 * up from the slowest speed a ramp holds to the fastest, with equal heights for equal ratios.
 */
import {
  clamp,
  frameOfMedia,
  mediaAt,
  mediaToStream,
  RAMP_GAP,
  RAMP_MAX,
  RAMP_MIN,
  RAMP_POINTS,
  RAMP_SHAPES,
  rampCurve,
  rampTable,
  sourceSpan,
  sourceTimeAt,
  streamSpeed,
  type Clip,
  type Project,
  type RampPoint,
  type RampShape,
} from '@tandem/core';

/** The stretch of media a graph is drawn across, in seconds of the media. */
export interface RampRange {
  /** The lowest second the clip plays. */
  from: number;
  /** The highest. */
  to: number;
  /** One frame's worth of media before the stretch: a point that far out is still shown, on the edge. */
  before: number;
  /** One frame's worth after it. */
  after: number;
  /** The clip plays backwards: the graph begins at `to`, on the left, and runs down to `from`. */
  reverse: boolean;
}

/** The size of the graph on the screen, in pixels. */
export interface Box {
  width: number;
  height: number;
}

/** The stretch of its media that `clip` plays now. */
export function rampRange(clip: Clip, p: Project): RampRange {
  const { in: from, out: to } = sourceSpan(clip, p);
  return {
    from,
    to,
    before: mediaAt(clip, -1, p),
    after: mediaAt(clip, clip.duration + 1, p),
    reverse: clip.reverse,
  };
}

const span = (r: RampRange): number => r.to - r.from;

/** How far across the graph second `m` of the media lies: 0 at the left, 1 at the right, beyond them outside it. */
export const acrossOf = (m: number, r: RampRange): number =>
  r.reverse ? (r.to - m) / span(r) : (m - r.from) / span(r);

/** The second of media at a place across the graph. */
export const mediaAcross = (x: number, r: RampRange): number =>
  r.reverse ? r.to - x * span(r) : r.from + x * span(r);

/** The powers of ten between the slowest and the fastest speed a ramp holds. */
const DECADES = Math.log10(RAMP_MAX) - Math.log10(RAMP_MIN);

/** How far up the graph a speed lies: 0 at the slowest a ramp holds, a half at 100%, 1 at the fastest. */
export const upOf = (v: number): number => (Math.log10(v) - Math.log10(RAMP_MIN)) / DECADES;

/** The speed at a height of the graph. */
export const speedUp = (y: number): number => 10 ** (y * DECADES + Math.log10(RAMP_MIN));

/** The speeds that have a line across the graph, each named. */
export const SPEED_LINES = [0.1, 0.25, 0.5, 1, 2, 4, 10] as const;

/** Places are kept to the microsecond and speeds to the thousandth, as the operations write them. */
const micro = (m: number): number => Math.round(m * 1e6) / 1e6;
const milli = (v: number): number => Math.round(v * 1e3) / 1e3;

/**
 * The least seconds of media the graph leaves between two points: a hundredth of what it shows,
 * so that two points can still be told apart and taken hold of one by one, and never less than a
 * ramp allows.
 */
export const pointGap = (r: RampRange): number => Math.max(RAMP_GAP, span(r) / 100);

/** A point of a ramp as the graph shows it. */
export interface Shown extends RampPoint {
  /** Which point of the ramp it is: a ramp also has points beyond what the clip plays. */
  index: number;
  /** Where it is drawn across the graph and up it, both from 0 to 1. */
  x: number;
  y: number;
}

/**
 * The points of a ramp that the graph shows, from left to right: those on the stretch the clip
 * plays. A length is a whole number of frames, so the last point of a shape lies a fraction of a
 * frame beyond the last frame as often as before it: a point within one frame's media of the
 * stretch is shown as well, on the edge. Points further out belong to media the clip does not
 * play. They are not shown and cannot be reached, and come back when the clip is trimmed out.
 */
export function shownPoints(points: readonly RampPoint[], r: RampRange): Shown[] {
  const shown: Shown[] = [];
  points.forEach((q, index) => {
    if (q.m < r.before || q.m > r.after) return;
    shown.push({ ...q, index, x: clamp(acrossOf(q.m, r), 0, 1), y: clamp(upOf(q.v), 0, 1) });
  });
  return r.reverse ? shown.reverse() : shown;
}

/**
 * The shown point beside point `index` of the ramp: the next one the clip plays, or the one before
 * it when there is none after. It is where the keyboard goes when that point is removed.
 */
export function besideOf(shown: readonly Shown[], index: number): Shown | null {
  const at = shown.findIndex((s) => s.index === index);
  return at < 0 ? null : (shown[at + 1] ?? shown[at - 1] ?? null);
}

/** The point of `points` that stands at second `m`, to within the least gap of a ramp: its index, or -1. */
export function pointAt(points: readonly RampPoint[], m: number): number {
  let found = -1;
  points.forEach((q, i) => {
    const off = Math.abs(q.m - m);
    if (off < RAMP_GAP && (found < 0 || off < Math.abs(points[found].m - m))) found = i;
  });
  return found;
}

/** How near a point, in pixels, a press takes hold of it. */
export const POINT_REACH = 12;

/** The shown point nearest to a place in the graph, `px` from its left and `py` from its top, if one is within reach. */
export function hitPoint(
  shown: readonly Shown[],
  px: number,
  py: number,
  box: Box,
  reach = POINT_REACH,
): Shown | null {
  let hit: Shown | null = null;
  let nearest = reach;
  for (const s of shown) {
    const off = Math.hypot(s.x * box.width - px, (1 - s.y) * box.height - py);
    if (off > nearest) continue;
    nearest = off;
    hit = s;
  }
  return hit;
}

/**
 * `points` with point `i` taken to the place and the speed of `to`, as near as it may go. The
 * speed stays inside what a ramp holds. The place stays on the stretch the graph shows and the
 * least gap from the points beside it, also from one that is not shown. `stay` is where the point
 * stood when the gesture began: it may always go back there, to the letter, also where that is
 * nearer its neighbour or further out than a drag would take it. A drag up and back down then
 * leaves the ramp it found. What is moved is rounded as the operations write it; the other points
 * are the objects they were, and so is the list when nothing moved.
 */
export function movePoint(
  points: RampPoint[],
  i: number,
  to: RampPoint,
  r: RampRange,
  stay: RampPoint = points[i],
): RampPoint[] {
  const now = points[i];
  if (!now) return points;
  const gap = pointGap(r);
  const prev: RampPoint | undefined = points[i - 1];
  const next: RampPoint | undefined = points[i + 1];
  let lo = Math.max(r.from, prev ? prev.m + gap : -Infinity);
  let hi = Math.min(r.to, next ? next.m - gap : Infinity);
  // Somebody else may have put a point there meanwhile: closer than `RAMP_GAP` to a neighbour
  // it would no longer be a point of its own.
  const open = (!prev || stay.m >= prev.m + RAMP_GAP) && (!next || stay.m <= next.m - RAMP_GAP);
  if (open) {
    lo = Math.min(lo, stay.m);
    hi = Math.max(hi, stay.m);
  }
  let m = now.m;
  if (open && to.m === stay.m) m = stay.m;
  else if (lo <= hi) {
    m = micro(clamp(to.m, lo, hi));
    // Rounding may not carry it past a limit.
    if (m < lo) m = micro(m + 1e-6);
    if (m > hi) m = micro(m - 1e-6);
  }
  const v = to.v === stay.v ? stay.v : milli(clamp(to.v, RAMP_MIN, RAMP_MAX));
  if (m === now.m && v === now.v) return points;
  return points.map((q, j) => (j === i ? { m, v } : q));
}

/** How near, in pixels, a dragged point snaps to 100% and to the playhead. */
const SNAP_SPEED = 4;
const SNAP_PLAYHEAD = 6;

export interface DragOptions {
  /** The second of media under the playhead, for a point to snap to; null when it is off the clip. */
  playhead?: number | null;
  /** No snapping: Shift is held. */
  free?: boolean;
}

/**
 * `points` after a drag has carried point `i` `dx` pixels to the right and `dy` pixels down from
 * where it stood when the drag began (`from`). Up and down is the speed, sideways the place. Along
 * a direction the pointer has moved in, the point snaps to 100% and to the playhead when it comes
 * near them. Back where the pointer went down, the point is back where it was.
 */
export function dragPoint(
  points: RampPoint[],
  i: number,
  from: RampPoint,
  dx: number,
  dy: number,
  box: Box,
  r: RampRange,
  { playhead = null, free = false }: DragOptions = {},
): RampPoint[] {
  const to: RampPoint = {
    m: dx === 0 ? from.m : mediaAcross(acrossOf(from.m, r) + dx / box.width, r),
    v: dy === 0 ? from.v : speedUp(upOf(from.v) - dy / box.height),
  };
  if (!free) {
    if (dy !== 0 && Math.abs(upOf(to.v) - upOf(1)) * box.height <= SNAP_SPEED) to.v = 1;
    if (
      dx !== 0 &&
      playhead !== null &&
      Math.abs(acrossOf(to.m, r) - acrossOf(playhead, r)) * box.width <= SNAP_PLAYHEAD
    )
      to.m = playhead;
  }
  return movePoint(points, i, to, r, from);
}

/** What one press of an arrow key does to a speed, and with Shift held: the steps of the Speed slider. */
const KEY_STEP = 1.05;
const KEY_LEAP = 1.62;

/**
 * `points` after a key pressed on point `i`. Up and Down change the speed by a twentieth, more
 * with Shift; Page Up and Page Down double and halve it; Home and End take it to the slowest and
 * the fastest a ramp holds. Left and Right move the point a hundredth of the graph, a tenth with
 * Shift, the way the clip plays. The same list when the point is as far as the key would take it,
 * and undefined for a key that moves no point.
 */
export function keyMove(
  key: string,
  shift: boolean,
  points: RampPoint[],
  i: number,
  r: RampRange,
): RampPoint[] | undefined {
  const q = points[i];
  if (!q) return undefined;
  const by = shift ? KEY_LEAP : KEY_STEP;
  const along = (shift ? 0.1 : 0.01) * span(r) * (r.reverse ? -1 : 1);
  let to: RampPoint;
  switch (key) {
    case 'ArrowUp':
      to = { m: q.m, v: q.v * by };
      break;
    case 'ArrowDown':
      to = { m: q.m, v: q.v / by };
      break;
    case 'PageUp':
      to = { m: q.m, v: q.v * 2 };
      break;
    case 'PageDown':
      to = { m: q.m, v: q.v / 2 };
      break;
    case 'Home':
      to = { m: q.m, v: RAMP_MIN };
      break;
    case 'End':
      to = { m: q.m, v: RAMP_MAX };
      break;
    case 'ArrowRight':
      to = { m: q.m + along, v: q.v };
      break;
    case 'ArrowLeft':
      to = { m: q.m - along, v: q.v };
      break;
    default:
      return undefined;
  }
  return movePoint(points, i, to, r);
}

/** Whether a ramp holds as many points as it can. */
export const isFull = (points: readonly RampPoint[]): boolean => points.length >= RAMP_POINTS;

/**
 * `points` with one more at second `m` of the media, on the curve as it runs there, and which
 * point that is. Null when the ramp is full, or when the place is within the least gap of a point
 * that is there already. On a level stretch the curve stays as it was. On a slope the speed now
 * rests at the new point, so the curve between its neighbours changes a little.
 */
export function addPoint(
  points: readonly RampPoint[],
  m: number,
  r: RampRange,
): { points: RampPoint[]; index: number } | null {
  if (points.length < 2 || isFull(points)) return null;
  const at = micro(clamp(m, r.from, r.to));
  const gap = pointGap(r);
  if (points.some((q) => Math.abs(q.m - at) < gap)) return null;
  const table = rampTable(points);
  const v = milli(clamp(streamSpeed(table, mediaToStream(table, at)), RAMP_MIN, RAMP_MAX));
  const index = points.filter((q) => q.m < at).length;
  return { points: [...points.slice(0, index), { m: at, v }, ...points.slice(index)], index };
}

/** `points` without point `i`. Null when only two are left: fewer are one speed, not a ramp. */
export function removePoint(points: readonly RampPoint[], i: number): RampPoint[] | null {
  if (points.length <= 2 || !points[i]) return null;
  return points.filter((_, j) => j !== i);
}

/**
 * A point as it is read out: its speed, and how many seconds into the media the clip plays it
 * stands, counted the way the clip plays.
 */
export function describePoint(q: RampPoint, r: RampRange): string {
  const into = clamp(r.reverse ? r.to - q.m : q.m - r.from, 0, span(r));
  return `${Math.round(q.v * 100)}% at ${into.toFixed(2)} seconds`;
}

/** How many samples of the curve are drawn to each ease between two points. */
const CURVE_SAMPLES = 24;

/**
 * The curve of a ramp across the graph, as the path of an SVG `width` by `height`. It is the curve
 * the clip plays: the speed eases from point to point and holds beyond the outermost ones. It
 * passes through every point that is shown, also one shown on the edge from just beyond it.
 */
export function curvePath(points: RampPoint[], r: RampRange, { width, height }: Box): string {
  const shown = shownPoints(points, r);
  const reach = shown.map((s) => s.m);
  const curve = rampCurve(points, Math.min(r.from, ...reach), Math.max(r.to, ...reach), CURVE_SAMPLES);
  return curve
    .map(({ m, v }, i) => {
      const x = clamp(acrossOf(m, r), 0, 1) * width;
      const y = (1 - clamp(upOf(v), 0, 1)) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join('');
}

/** The steps, in seconds, that the marks of the clip's own time can be apart. */
const TICK_STEPS = [1, 2, 5, 10, 30, 60, 300, 600, 1800, 3600];

/**
 * Where the whole seconds of the clip's own time fall across the graph, from 0 to 1: close
 * together where the clip is slow, far apart where it is fast. `step` is the seconds from one mark
 * to the next: every second, or as many as leave no more than `most` marks.
 */
export function secondMarks(clip: Clip, p: Project, r: RampRange, most = 60): { step: number; at: number[] } {
  const fps = p.settings.fpsNum / p.settings.fpsDen;
  const seconds = Math.abs(frameOfMedia(clip, r.to, p) - frameOfMedia(clip, r.from, p)) / fps;
  const step = TICK_STEPS.find((s) => seconds / s <= most) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const at: number[] = [];
  if (!Number.isFinite(seconds)) return { step, at };
  for (let s = step; s < seconds && at.length < most; s += step) {
    const u = s * fps;
    const m = mediaAt(clip, clip.reverse ? clip.duration - u : u, p);
    if (m <= r.from || m >= r.to) continue;
    at.push(acrossOf(m, r));
  }
  return { step, at };
}

/** The frame of the timeline on which the clip shows second `m` of its media: the nearest, on the clip. */
export function frameShowing(clip: Clip, m: number, p: Project): number {
  const u = Math.round(frameOfMedia(clip, m, p));
  const local = clip.reverse ? clip.duration - 1 - u : u;
  return clip.start + clamp(local, 0, clip.duration - 1);
}

/**
 * The second of its media that the clip shows on `frame` of the timeline, or null when that frame
 * is not on the clip: where the playhead stands in the graph.
 */
export function mediaShown(clip: Clip, frame: number, p: Project): number | null {
  const local = Math.floor(frame) - clip.start;
  return local < 0 || local >= clip.duration ? null : sourceTimeAt(clip, local, p);
}

const SHAPE_SPEEDS = Object.values(RAMP_SHAPES).flatMap((shape) => shape.map(([, v]) => v));
const SHAPE_LOW = Math.min(...SHAPE_SPEEDS);
const SHAPE_HIGH = Math.max(...SHAPE_SPEEDS);

/**
 * A ready-made shape as a small drawing, `width` by `height`, with `pad` left free all round for
 * the thickness of the line. All shapes are drawn to one scale, from the slowest speed any of them
 * holds to the fastest, so one that goes slower than another also dips lower.
 */
export function shapePath(shape: RampShape, { width, height }: Box, pad = 1.5): string {
  const ramp = RAMP_SHAPES[shape].map(([m, v]) => ({ m, v }));
  const up = (v: number): number => (upOf(v) - upOf(SHAPE_LOW)) / (upOf(SHAPE_HIGH) - upOf(SHAPE_LOW));
  return rampCurve(ramp, 0, 1, 8)
    .map(({ m, v }, i) => {
      const x = pad + m * (width - 2 * pad);
      const y = pad + (1 - up(v)) * (height - 2 * pad);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join('');
}
