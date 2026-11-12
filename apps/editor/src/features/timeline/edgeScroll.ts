/**
 * Edge auto-scroll for timeline drags. While the pointer is in a strip along an edge of the
 * timeline, or past it, the view scrolls that way and the drag is run again so that what is being
 * dragged keeps up with the view. Time scrolls at the left and right edge; the lanes scroll at the
 * top and bottom edge when there are more tracks than fit.
 */
import { sequenceEnd, type Project } from '@tandem/core';
import { useUI } from '../../state/ui';

/** Width of the strip along each edge that scrolls, in CSS pixels. */
export const EDGE_ZONE = 32;
/** Pixels per second at the edge itself. */
const EDGE_SPEED = 720;
const MAX_SPEED = 2400;
/** A drag that begins inside a strip has to head for that edge by this much before it scrolls. */
const ARM_DISTANCE = 6;
/** Longest time one step may account for, so a stalled frame does not turn into a jump. */
const MAX_STEP_MS = 64;

/**
 * Scroll speed in pixels per second (negative is towards the start) for a pointer at `at` over a
 * view that spans `start`…`end` along one axis. Zero away from the edges; it eases in through the
 * strip and keeps growing with the distance past the edge.
 */
export function edgeSpeed(at: number, start: number, end: number): number {
  const zone = Math.min(EDGE_ZONE, (end - start) / 4);
  if (zone <= 0) return 0;
  const depth = Math.max(start + zone - at, at - (end - zone));
  if (depth <= 0) return 0;
  const t = depth / zone;
  const speed = Math.min(MAX_SPEED, t <= 1 ? EDGE_SPEED * t * t : EDGE_SPEED * t);
  return at < start + zone ? -speed : speed;
}

/** The furthest a drag scrolls the view in time: half a viewport of empty time past the last clip. */
export function scrollLimit(project: Project, ppf: number, width: number): number {
  return Math.max(0, sequenceEnd(project) * ppf - width / 2);
}

/** One direction a view scrolls in: time, or the stack of lanes. */
export interface EdgeAxis {
  /** The two edges of the view in client coordinates, or null when it is not on screen. */
  bounds: () => { start: number; end: number } | null;
  /** How far the view is scrolled. */
  position: () => number;
  /** The furthest a drag scrolls it. The view is never moved back when it is already past this. */
  limit: () => number;
  scrollTo: (position: number) => void;
}

/** Time: scrolled through the UI state, between the left and right edge of `view`. */
export function timeAxis(view: () => HTMLElement | null, project: () => Project): EdgeAxis {
  return {
    bounds: () => {
      const r = view()?.getBoundingClientRect();
      return r ? { start: r.left, end: r.right } : null;
    },
    position: () => useUI.getState().scrollX,
    limit: () => scrollLimit(project(), useUI.getState().ppf, view()?.clientWidth ?? 0),
    scrollTo: (scrollX) => useUI.getState().set({ scrollX }),
  };
}

/**
 * The lanes: scrolled by the element they overflow, between its top and bottom edge. `tail` is
 * the height of what lies under the last lane and is no lane. A drag stops short of it, with the
 * end of the last lane at the bottom edge: scrolled any further, that room would come up under a
 * pointer held on the last lane, and being past the last lane means something else to a drag
 * than being on it.
 */
export function laneAxis(body: () => HTMLElement | null, tail = 0): EdgeAxis {
  return {
    bounds: () => {
      const r = body()?.getBoundingClientRect();
      return r ? { start: r.top, end: r.bottom } : null;
    },
    position: () => body()?.scrollTop ?? 0,
    limit: () => {
      const el = body();
      return el ? Math.max(0, el.scrollHeight - el.clientHeight - tail) : 0;
    },
    scrollTo: (top) => {
      const el = body();
      if (el) el.scrollTop = top;
    },
  };
}

interface Tracked {
  axis: EdgeAxis;
  /** Where the pointer is along this axis, or null while the drag does not scroll it. */
  at: number | null;
  /** Where the pointer came in, for as long as it has stayed inside the strip it came in at. */
  guard: number | null;
  /** Fraction of a pixel carried over, so slow speeds add up instead of rounding to nothing. */
  carry: number;
}

export class EdgeScroller {
  private raf = 0;
  private last = 0;
  private readonly axes: Tracked[];

  /** `onScroll` is called after the view has moved, to run the drag again where the pointer is. */
  constructor(
    axes: EdgeAxis[],
    private readonly onScroll: () => void,
  ) {
    this.axes = axes.map((axis) => ({ axis, at: null, guard: null, carry: 0 }));
  }

  /**
   * Report the pointer position of the drag in progress, one coordinate for each axis. Null (or
   * nothing) for an axis means the drag does not scroll it as things stand. The first position
   * reported for an axis is where the pointer came in.
   */
  track(...at: (number | null)[]): void {
    this.axes.forEach((a, i) => {
      const v = at[i] ?? null;
      if (v === null) {
        a.at = a.guard = null;
        return;
      }
      if (a.at === null) a.guard = v;
      a.at = v;
      // Grabbing something that lies at the edge must not send the view off: only a pointer that
      // has moved on towards that edge, or has been away from it and come back, scrolls.
      if (this.rawSpeed(a) === 0) a.guard = null;
    });
    if (!this.raf && this.axes.some((a) => this.speed(a) !== 0)) {
      this.last = performance.now();
      for (const a of this.axes) a.carry = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** The drag is over (or cancelled): stop scrolling and forget the pointer. */
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const a of this.axes) a.at = a.guard = null;
  }

  private rawSpeed(a: Tracked): number {
    const b = a.axis.bounds();
    return b && a.at !== null ? edgeSpeed(a.at, b.start, b.end) : 0;
  }

  private speed(a: Tracked): number {
    const speed = this.rawSpeed(a);
    if (speed === 0 || a.guard === null || a.at === null) return speed;
    const towards = speed < 0 ? a.guard - a.at : a.at - a.guard;
    return towards >= ARM_DISTANCE ? speed : 0;
  }

  /**
   * Move one axis by what `seconds` at its present speed come to. Returns whether the view moved,
   * and whether there is more to come: false away from the edge, and against the start of the
   * view or its limit, where nothing changes until the pointer moves again.
   */
  private step(a: Tracked, seconds: number): { moved: boolean; live: boolean } {
    const speed = this.speed(a);
    if (speed === 0) return { moved: false, live: false };
    const move = speed * seconds + a.carry;
    const whole = Math.trunc(move);
    a.carry = move - whole;
    if (whole === 0) return { moved: false, live: true };
    const from = a.axis.position();
    const to = Math.max(0, Math.min(from + whole, Math.max(from, a.axis.limit())));
    if (to !== from) a.axis.scrollTo(to);
    // What the view did is read back: one that is as far as it goes may not take the whole step.
    const moved = a.axis.position() !== from;
    if (!moved) a.carry = 0;
    return { moved, live: moved };
  }

  private readonly tick = (now: number): void => {
    const seconds = Math.min(MAX_STEP_MS, Math.max(0, now - this.last)) / 1000;
    this.last = now;
    let moved = false;
    let live = false;
    for (const a of this.axes) {
      const s = this.step(a, seconds);
      moved ||= s.moved;
      live ||= s.live;
    }
    if (!live) {
      this.raf = 0;
      return;
    }
    // `raf` still names this step, so a `track` from inside the drag does not start a second loop.
    if (moved) this.onScroll();
    // The drag may have ended in `onScroll`.
    this.raf = this.axes.some((a) => a.at !== null) ? requestAnimationFrame(this.tick) : 0;
  };
}
