import { describe, expect, it } from 'vitest';
import { applyEdits, emptyProject, makeTrack } from '@tandem/core';
import { clipWidth, GROUP_GAP, LANE_GAP, layoutLanes, tickInterval } from '../src/features/timeline/layout';

describe('ruler ticks', () => {
  it('fall on whole frames at every zoom level, for the usual frame rates', () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      for (let ppf = 0.01; ppf < 120; ppf *= 1.3) {
        const { major, minor } = tickInterval(ppf, fps);
        expect(Number.isInteger(major)).toBe(true);
        // Below a second a tick that is not on a frame marks nothing that can be cut at.
        if (major < fps) expect((major / minor) % 1).toBe(0);
      }
    }
  });

  it('show every frame once frames are wide enough to tell apart', () => {
    expect(tickInterval(30, 30)).toEqual({ major: 5, minor: 5 });
    expect(tickInterval(60, 30)).toEqual({ major: 2, minor: 2 });
    expect(tickInterval(120, 30)).toEqual({ major: 1, minor: 1 });
  });

  it('keep labels about a hundred pixels apart', () => {
    for (const ppf of [0.05, 0.4, 3, 12]) {
      const { major } = tickInterval(ppf, 30);
      expect(major * ppf).toBeGreaterThanOrEqual(96);
      expect(major * ppf).toBeLessThan(400);
    }
  });
});

describe('clipWidth', () => {
  it('stops a pixel short of the next clip and never vanishes', () => {
    expect(clipWidth(120, 3)).toBe(359);
    expect(clipWidth(1, 0.05)).toBe(2);
  });
});

describe('layoutLanes', () => {
  const v1 = makeTrack('video', 0);
  const a1 = makeTrack('audio', 0);
  const a2 = makeTrack('audio', 1);
  const project = applyEdits(
    emptyProject(),
    [v1, a1, a2].map((track) => ({ op: 'addTrack', track })),
  );

  it('stacks the lanes at the heights of their tracks, picture over sound', () => {
    const { lanes } = layoutLanes(project);
    expect(lanes.map((l) => [l.label, l.height])).toEqual([
      ['V1', v1.height],
      ['A1', a1.height],
      ['A2', a2.height],
    ]);
    expect(lanes[1].top).toBe(lanes[0].top + v1.height + LANE_GAP + GROUP_GAP);
    expect(lanes[2].top).toBe(lanes[1].top + a1.height + LANE_GAP);
  });

  it('draws a track at the height someone chose to look at it, and moves the lanes below along', () => {
    const plain = layoutLanes(project);
    const own = layoutLanes(project, { [a1.id]: a1.height + 40 });
    expect(own.lanes.map((l) => l.height)).toEqual([v1.height, a1.height + 40, a2.height]);
    expect(own.lanes[1].top).toBe(plain.lanes[1].top);
    expect(own.lanes[2].top).toBe(plain.lanes[2].top + 40);
    expect(own.height).toBe(plain.height + 40);
    // The track itself is as it was, and without a height of one's own the layout is the plain one.
    expect(own.lanes[1].track).toBe(project.tracks[a1.id]);
    expect(layoutLanes(project, null)).toEqual(plain);
    expect(layoutLanes(project, {})).toEqual(plain);
  });
});
