import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEdits, emptyProject, makeClip, makeTrack } from '@tandem/core';
import {
  EDGE_ZONE,
  EdgeScroller,
  edgeSpeed,
  laneAxis,
  scrollLimit,
  timeAxis,
  type EdgeAxis,
} from '../src/features/timeline/edgeScroll';
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

describe('laneAxis', () => {
  /** A body 240 high around lanes that are `content` high in all, with 26 of that under the last lane. */
  const body = (content: number, scrollTop = 0) =>
    ({ scrollTop, scrollHeight: Math.max(content, 240), clientHeight: 240 }) as HTMLElement;

  it('takes a drag as far as the end of the last lane, not into the room under it', () => {
    expect(laneAxis(() => body(800), 26).limit()).toBe(534);
    // The sample as it comes: what is out of view is a part of the last lane and that room.
    expect(laneAxis(() => body(277), 26).limit()).toBe(11);
  });

  it('has nowhere to go when only that room is out of view, or nothing is', () => {
    expect(laneAxis(() => body(250), 26).limit()).toBe(0);
    expect(laneAxis(() => body(180), 26).limit()).toBe(0);
    expect(laneAxis(() => null, 26).limit()).toBe(0);
  });

  it('reads and sets how far the body is scrolled', () => {
    const el = body(800, 40);
    const axis = laneAxis(() => el, 26);
    expect(axis.position()).toBe(40);
    axis.scrollTo(90);
    expect(el.scrollTop).toBe(90);
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

  /** Time as the timeline scrolls it, in a view that spans 100…900 with `limit` as its end. */
  const time = (limit = 10_000): EdgeAxis => ({
    ...timeAxis(
      () => null,
      () => emptyProject(),
    ),
    bounds: () => ({ start: 100, end: 900 }),
    limit: () => limit,
  });

  /** Lanes in a view that spans 200…500, scrolled to `top` and able to go as far as `max`. */
  const lanes = (top: number, max: number) => {
    const state = { top, moves: 0 };
    const axis: EdgeAxis = {
      bounds: () => ({ start: 200, end: 500 }),
      position: () => state.top,
      limit: () => max,
      scrollTo: (to) => {
        state.top = to;
        state.moves++;
      },
    };
    return { axis, state };
  };

  const make = (limit = 10_000) => {
    const onScroll = vi.fn();
    const scroller = new EdgeScroller([time(limit)], onScroll);
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
    const scroller: EdgeScroller = new EdgeScroller([time()], () => {
      onScroll();
      scroller.track(895);
    });
    scroller.track(500);
    scroller.track(895);
    run(10);
    expect(frames.length).toBeLessThanOrEqual(1);
    expect(onScroll.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('survives the drag ending inside a step', () => {
    const scroller: EdgeScroller = new EdgeScroller([time()], () => scroller.stop());
    scroller.track(500);
    scroller.track(895);
    run(10);
    expect(frames).toHaveLength(0);
  });

  it('scrolls the lanes at the bottom edge, as far as they go, and back at the top', () => {
    const { axis, state } = lanes(40, 120);
    const onScroll = vi.fn();
    const scroller = new EdgeScroller([time(), axis], onScroll);
    scroller.track(500, 350);
    scroller.track(500, 495);
    run(10);
    expect(state.top).toBeGreaterThan(40);
    expect(Number.isInteger(state.top)).toBe(true);
    // Time is left alone by a pointer that is nowhere near its edges.
    expect(useUI.getState().scrollX).toBe(500);
    run(400);
    expect(state.top).toBe(120);
    expect(frames).toHaveLength(0);
    scroller.track(500, 205);
    run(400);
    expect(state.top).toBe(0);
    expect(frames).toHaveLength(0);
    expect(onScroll.mock.calls.length).toBe(state.moves);
  });

  it('runs the drag once for a step that scrolls both ways', () => {
    const { axis, state } = lanes(40, 10_000);
    const onScroll = vi.fn();
    const scroller = new EdgeScroller([time(), axis], onScroll);
    scroller.track(500, 350);
    scroller.track(895, 495);
    run(10);
    expect(useUI.getState().scrollX).toBeGreaterThan(500);
    expect(state.top).toBeGreaterThan(40);
    expect(onScroll.mock.calls.length).toBeLessThanOrEqual(10);
    expect(frames.length).toBeLessThanOrEqual(1);
  });

  it('leaves the lanes alone while the drag does not scroll them, and wants a fresh approach after', () => {
    const { axis, state } = lanes(40, 10_000);
    const scroller = new EdgeScroller([time(), axis], () => {});
    scroller.track(500, 350);
    scroller.track(500, 495);
    run(5);
    const reached = state.top;
    expect(reached).toBeGreaterThan(40);
    // A track opened by the drag is being shown: the lane axis is not reported.
    scroller.track(500, null);
    run(20);
    expect(state.top).toBe(reached);
    expect(frames).toHaveLength(0);
    // Reported again from inside the strip, the pointer has to head for the edge once more.
    scroller.track(500, 495);
    run(20);
    expect(state.top).toBe(reached);
    scroller.track(500, 502);
    run(5);
    expect(state.top).toBeGreaterThan(reached);
  });

  it('stops when the view does not take the step', () => {
    const stuck: EdgeAxis = {
      bounds: () => ({ start: 200, end: 500 }),
      position: () => 64,
      limit: () => 10_000,
      scrollTo: () => {},
    };
    const onScroll = vi.fn();
    const scroller = new EdgeScroller([stuck], onScroll);
    scroller.track(350);
    scroller.track(495);
    run(30);
    expect(onScroll).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it('does not scroll lanes that all fit', () => {
    const { axis, state } = lanes(0, 0);
    const scroller = new EdgeScroller([time(), axis], () => {});
    scroller.track(500, 350);
    scroller.track(500, 499);
    run(30);
    expect(state.moves).toBe(0);
    expect(frames).toHaveLength(0);
  });
});
