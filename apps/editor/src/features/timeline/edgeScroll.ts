/**
 * Edge auto-scroll for timeline drags. While the pointer is in a strip along the left or right
 * edge of the timeline, or past it, the view scrolls that way and the drag is run again so that
 * what is being dragged keeps up with the view.
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
 * Scroll speed in pixels per second (negative is towards frame zero) for a pointer at `x` over a
 * view that spans `left`…`right`. Zero away from the edges; it eases in through the strip and
 * keeps growing with the distance past the edge.
 */
export function edgeSpeed(x: number, left: number, right: number): number {
  const zone = Math.min(EDGE_ZONE, (right - left) / 4);
  if (zone <= 0) return 0;
  const depth = Math.max(left + zone - x, x - (right - zone));
  if (depth <= 0) return 0;
  const t = depth / zone;
  const speed = Math.min(MAX_SPEED, t <= 1 ? EDGE_SPEED * t * t : EDGE_SPEED * t);
  return x < left + zone ? -speed : speed;
}

/** The furthest a drag scrolls the view: half a viewport of empty time past the last clip. */
export function scrollLimit(project: Project, ppf: number, width: number): number {
  return Math.max(0, sequenceEnd(project) * ppf - width / 2);
}

export interface EdgeScrollOptions {
  /** Left and right edge of the view in client coordinates, or null when it is not on screen. */
  bounds: () => { left: number; right: number } | null;
  /** See `scrollLimit`. The view is never moved back when it is already past this. */
  limit: () => number;
  /** Called after the view has moved, to run the drag again at the pointer's last position. */
  onScroll: () => void;
}

export class EdgeScroller {
  private raf = 0;
  private x: number | null = null;
  /** Where the drag began, for as long as the pointer has stayed inside the strip it began in. */
  private guard: number | null = null;
  private last = 0;
  /** Fraction of a pixel carried over, so slow speeds add up instead of rounding to nothing. */
  private carry = 0;

  constructor(private readonly opts: EdgeScrollOptions) {}

  /** Report the pointer position of the drag in progress. The first report is where it began. */
  track(x: number): void {
    if (this.x === null) this.guard = x;
    this.x = x;
    const speed = this.rawSpeed();
    // Grabbing something that lies at the edge must not send the view off: only a pointer that
    // has moved on towards that edge, or has been away from it and come back, scrolls.
    if (speed === 0) this.guard = null;
    if (!this.raf && this.speed() !== 0) {
      this.last = performance.now();
      this.carry = 0;
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** The drag is over (or cancelled): stop scrolling and forget the pointer. */
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.x = null;
    this.guard = null;
  }

  private rawSpeed(): number {
    const b = this.opts.bounds();
    return b && this.x !== null ? edgeSpeed(this.x, b.left, b.right) : 0;
  }

  private speed(): number {
    const speed = this.rawSpeed();
    if (speed === 0 || this.guard === null || this.x === null) return speed;
    const towards = speed < 0 ? this.guard - this.x : this.x - this.guard;
    return towards >= ARM_DISTANCE ? speed : 0;
  }

  private readonly tick = (now: number): void => {
    const speed = this.speed();
    const move = (speed * Math.min(MAX_STEP_MS, Math.max(0, now - this.last))) / 1000 + this.carry;
    this.last = now;
    const whole = Math.trunc(move);
    this.carry = move - whole;
    const { scrollX, set } = useUI.getState();
    const next = Math.max(0, Math.min(scrollX + whole, Math.max(scrollX, this.opts.limit())));
    // Away from the edge, or against the start of the timeline or the limit: there is nothing
    // more to do until the pointer moves again.
    if (speed === 0 || (whole !== 0 && next === scrollX)) {
      this.raf = 0;
      return;
    }
    if (next !== scrollX) {
      set({ scrollX: next });
      // `raf` still names this step, so a `track` from inside the drag does not start a second loop.
      this.opts.onScroll();
    }
    // The drag may have ended in `onScroll`.
    this.raf = this.x !== null ? requestAnimationFrame(this.tick) : 0;
  };
}
