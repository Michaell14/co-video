import { describe, expect, it } from 'vitest';
import { clipWidth, tickInterval } from '../src/features/timeline/layout';

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
