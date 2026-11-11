import { describe, expect, it } from 'vitest';
import { MAX_PPF } from '../src/state/ui';
import { fitView, zoomView } from '../src/state/view';

describe('zoomView', () => {
  const width = 1000;

  it('holds the playhead still while it is in view', () => {
    // Playhead at frame 100, drawn 400px into the viewport.
    const next = zoomView({ ppf: 5, scrollX: 100 }, 2, width, 100);
    expect(next.ppf).toBe(10);
    expect(100 * next.ppf - next.scrollX).toBe(400);
  });

  it('holds the middle of the viewport when the playhead is off-screen', () => {
    // Playhead at 0, view scrolled to frame 150 at 20 px/frame: the middle shows frame 175.
    const view = { ppf: 20, scrollX: 3000 };
    const next = zoomView(view, 1.4, width, 0);
    expect(next.ppf).toBeCloseTo(28);
    expect((next.scrollX + width / 2) / next.ppf).toBeCloseTo(175);
    // The frame that was at the left edge moved left, off-screen, not 860px to the right.
    expect(150 * next.ppf - next.scrollX).toBeLessThan(0);
  });

  it('also re-centres when the playhead is past the right edge', () => {
    const next = zoomView({ ppf: 2, scrollX: 0 }, 2, width, 5000);
    expect((next.scrollX + width / 2) / next.ppf).toBeCloseTo(250);
  });

  it('keeps the frame under an explicit anchor (the pointer) in place', () => {
    const next = zoomView({ ppf: 4, scrollX: 2000 }, 0.5, width, 0, 600);
    expect(((2000 + 600) / 4) * next.ppf - next.scrollX).toBeCloseTo(600);
  });

  it('never scrolls before frame zero or zooms past the limit', () => {
    expect(zoomView({ ppf: 4, scrollX: 0 }, 0.25, width, 10).scrollX).toBe(0);
    expect(zoomView({ ppf: 50, scrollX: 0 }, 10, width, 0).ppf).toBe(MAX_PPF);
  });
});

describe('fitView', () => {
  it('shows a span edge to edge with a margin either side', () => {
    const v = fitView(120, 240, 1000);
    expect(120 * v.ppf - v.scrollX).toBeCloseTo(40);
    expect(240 * v.ppf - v.scrollX).toBeCloseTo(960);
  });

  it('fits from frame zero without scrolling', () => {
    expect(fitView(0, 300, 1080)).toEqual({ ppf: 1000 / 300, scrollX: 0 });
  });

  it('copes with an empty span', () => {
    expect(fitView(50, 50, 1000).ppf).toBe(MAX_PPF);
  });
});
