import { describe, expect, it } from 'vitest';
import { nitsToPq } from '@tandem/core';
import { labelBaselines } from '../src/features/color/graticule';

/** The marks of an HDR waveform in the order the scope keeps their labels, as Scopes.tsx lists them. */
const NITS = [10000, 203, 1000, 10, 100, 4000, 1];
const pq = NITS.map((n) => nitsToPq(n));

/** The nits whose labels are drawn in a scope of that height. */
const labelled = (height: number): number[] =>
  labelBaselines(pq, height).flatMap((baseline, i) => (baseline === null ? [] : [NITS[i]]));

const apart = (height: number): number => {
  const drawn = labelBaselines(pq, height)
    .filter((b): b is number => b !== null)
    .sort((a, b) => a - b);
  return Math.min(...drawn.slice(1).map((b, i) => b - drawn[i]));
};

describe('labels of the scope graticule', () => {
  it('never prints two labels over each other, at any height the layout gives a scope', () => {
    for (const height of [60, 93, 153, 213, 320]) expect(apart(height)).toBeGreaterThanOrEqual(10);
  });

  it('keeps peak, diffuse white, 1000 and 10 nits where there is no room for all', () => {
    // 93 px is a scope in a 1280×720 window, 153 px one at 1440×900: 4k would sit on 10k in both.
    expect(labelled(93)).toEqual([10000, 203, 1000, 10, 1]);
    expect(labelled(153)).toEqual([10000, 203, 1000, 10, 100, 1]);
    expect(labelled(320)).toEqual(NITS);
  });

  it('keeps every label of an SDR scope at the heights a window gives it', () => {
    const levels = [1, 0, 0.5, 0.25, 0.75];
    for (const height of [93, 153, 213]) expect(labelBaselines(levels, height)).not.toContain(null);
    // In the lowest scope there is, 75 would print over 100: it is the one left out.
    expect(labelBaselines(levels, 60).map((b) => b !== null)).toEqual([true, true, true, true, false]);
  });

  it('holds the top and bottom labels inside the scope', () => {
    const [top, bottom] = labelBaselines([1, 0], 100);
    expect(top).toBe(9);
    expect(bottom).toBe(97);
  });
});
