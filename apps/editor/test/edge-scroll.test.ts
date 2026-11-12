import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEdits, emptyProject, makeClip, makeTrack } from '@tandem/core';
import { EDGE_ZONE, EdgeScroller, edgeSpeed, scrollLimit } from '../src/features/timeline/edgeScroll';
import { useUI } from '../src/state/ui';

describe('edgeSpeed', () => {
  const left = 100;
  const right = 900;

  it('is zero away from the edges', () => {
    expect(edgeSpeed(500, left, right)).toBe(0);
    expect(edgeSpeed(left + EDGE_ZONE, left, right)).toBe(0);
    expect(edgeSpeed(right - EDGE_ZONE, left, right)).toBe(0);
  });

  it('points towards the edge the pointer is at', () => {
    expect(edgeSpeed(left + 4, left, right)).toBeLessThan(0);
    expect(edgeSpeed(right - 4, left, right)).toBeGreaterThan(0);
  });

  it('grows through the strip and on past the edge, up to a ceiling', () => {
    const inside = edgeSpeed(right - 20, left, right);
    const atEdge = edgeSpeed(right, left, right);
    const past = edgeSpeed(right + 40, left, right);
    expect(inside).toBeGreaterThan(0);
    expect(atEdge).toBeGreaterThan(inside);
    expect(past).toBeGreaterThan(atEdge);
    expect(edgeSpeed(right + 100_000, left, right)).toBe(edgeSpeed(right + 200_000, left, right));
    expect(edgeSpeed(left - 40, left, right)).toBe(-past);
  });

  it('never claims more than a quarter of a narrow view per side', () => {
    expect(edgeSpeed(40, 0, 80)).toBe(0);
    expect(edgeSpeed(0, 0, 0)).toBe(0);
  });
});

describe('scrollLimit', () => {
  it('leaves half a viewport of empty time after the last clip', () => {
    const track = makeTrack('video', 0);
    const p = applyEdits(emptyProject(), [
      { op: 'addTrack', track },
      { op: 'addClip', clip: makeClip('text', track.id, { start: 0, duration: 300 }) },
    ]);
    expect(scrollLimit(p, 4, 1000)).toBe(700);
    expect(scrollLimit(emptyProject(), 4, 1000)).toBe(0);
  });
});

describe('EdgeScroller', () => {
  let frames: ((now: number) => void)[] = [];
  let now = 0;
  /** Run the animation frames requested so far, `ms` apart. */
  const run = (count: number, ms = 16): void => {
    for (let i = 0; i < count; i++) {
      const due = frames;
      frames = [];
      now += ms;
      for (const fn of due) fn(now);
    }
  };

  beforeEach(() => {
    frames = [];
    now = 1000;
    vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => frames.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = [];
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    useUI.getState().set({ scrollX: 500 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const make = (limit = 10_000) => {
    const onScroll = vi.fn();
    const scroller = new EdgeScroller({
      bounds: () => ({ left: 100, right: 900 }),
      limit: () => limit,
      onScroll,
    });
    return { scroller, onScroll };
  };

  it('scrolls while the pointer rests at the right edge and re-runs the drag each step', () => {
    const { scroller, onScroll } = make();
    scroller.track(500);
    scroller.track(895);
    run(10);
    const reached = useUI.getState().scrollX;
    expect(reached).toBeGreaterThan(500);
    expect(Number.isInteger(reached)).toBe(true);
    expect(onScroll.mock.calls.length).toBeGreaterThan(0);
    run(10);
    expect(useUI.getState().scrollX).toBeGreaterThan(reached);
  });

  it('scrolls back at the left edge and stops at frame zero', () => {
    const { scroller } = make();
    useUI.getState().set({ scrollX: 30 });
    scroller.track(500);
    scroller.track(60);
    run(400);
    expect(useUI.getState().scrollX).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('stops for good when the drag ends', () => {
    const { scroller, onScroll } = make();
    scroller.track(500);
    scroller.track(895);
    run(5);
    scroller.stop();
    const at = useUI.getState().scrollX;
    const calls = onScroll.mock.calls.length;
    run(20);
    expect(useUI.getState().scrollX).toBe(at);
    expect(onScroll.mock.calls.length).toBe(calls);
    expect(frames).toHaveLength(0);
  });

  it('stops when the pointer leaves the strip, and starts again when it comes back', () => {
    const { scroller } = make();
    scroller.track(500);
    scroller.track(895);
    run(5);
    scroller.track(500);
    run(2);
    const at = useUI.getState().scrollX;
    run(20);
    expect(useUI.getState().scrollX).toBe(at);
    scroller.track(895);
    run(5);
    expect(useUI.getState().scrollX).toBeGreaterThan(at);
  });

  it('does not scroll past the limit, and never pulls a view back that is already beyond it', () => {
    const { scroller } = make(520);
    scroller.track(500);
    scroller.track(950);
    run(100);
    expect(useUI.getState().scrollX).toBe(520);
    useUI.getState().set({ scrollX: 800 });
    scroller.track(951);
    run(20);
    expect(useUI.getState().scrollX).toBe(800);
  });

  it('leaves the view alone when a drag begins at the edge and stays put', () => {
    const { scroller } = make();
    scroller.track(890);
    scroller.track(888);
    scroller.track(893);
    run(30);
    expect(useUI.getState().scrollX).toBe(500);
  });

  it('scrolls once such a drag heads for the edge', () => {
    const { scroller } = make();
    scroller.track(890);
    scroller.track(898);
    run(30);
    expect(useUI.getState().scrollX).toBeGreaterThan(500);
  });

  it('keeps to one loop when the drag reports the pointer from inside a step', () => {
    const onScroll = vi.fn();
    const scroller: EdgeScroller = new EdgeScroller({
      bounds: () => ({ left: 100, right: 900 }),
      limit: () => 10_000,
      onScroll: () => {
        onScroll();
        scroller.track(895);
      },
    });
    scroller.track(500);
    scroller.track(895);
    run(10);
    expect(frames.length).toBeLessThanOrEqual(1);
    expect(onScroll.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('survives the drag ending inside a step', () => {
    const scroller: EdgeScroller = new EdgeScroller({
      bounds: () => ({ left: 100, right: 900 }),
      limit: () => 10_000,
      onScroll: () => scroller.stop(),
    });
    scroller.track(500);
    scroller.track(895);
    run(10);
    expect(frames).toHaveLength(0);
  });
});
