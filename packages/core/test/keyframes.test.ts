import { describe, expect, it } from 'vitest';
import { cubicBezier, evalKeyframes, upsertKeyframe, shiftKeyframes, applyEasing } from '../src';
import type { Keyframe } from '../src';

describe('keyframes', () => {
  const kfs: Keyframe[] = [
    { t: 0, v: 0, e: 'linear' },
    { t: 10, v: 100, e: 'hold' },
    { t: 20, v: 50, e: 'easeInOut' },
    { t: 30, v: 0, e: 'linear' },
  ];

  it('clamps outside the keyed range', () => {
    expect(evalKeyframes(kfs, -5)).toBe(0);
    expect(evalKeyframes(kfs, 99)).toBe(0);
  });

  it('interpolates linearly', () => {
    expect(evalKeyframes(kfs, 5)).toBeCloseTo(50);
  });

  it('holds', () => {
    expect(evalKeyframes(kfs, 15)).toBe(100);
    expect(evalKeyframes(kfs, 19.9)).toBe(100);
    expect(evalKeyframes(kfs, 20)).toBe(50);
  });

  it('eases symmetrically', () => {
    expect(evalKeyframes(kfs, 25)).toBeCloseTo(25, 1);
    expect(evalKeyframes(kfs, 22)).toBeGreaterThan(40);
  });

  it('bezier solver hits the endpoints and is monotonic', () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, 0)).toBe(0);
    expect(cubicBezier(0.42, 0, 0.58, 1, 1)).toBe(1);
    let prev = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      const y = cubicBezier(0.42, 0, 0.58, 1, x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
    expect(applyEasing([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 3);
  });

  it('upserts sorted and replaces same-time keys', () => {
    let list = upsertKeyframe([], { t: 10, v: 1, e: 'linear' });
    list = upsertKeyframe(list, { t: 0, v: 0, e: 'linear' });
    list = upsertKeyframe(list, { t: 10, v: 5, e: 'linear' });
    expect(list.map((k) => [k.t, k.v])).toEqual([
      [0, 0],
      [10, 5],
    ]);
  });

  it('shifts when the clip head is trimmed', () => {
    const out = shiftKeyframes({ x: kfs }, 10);
    expect(out.x.map((k) => k.t)).toEqual([-10, 0, 10, 20]);
    // Value at the new local frame 0 equals the old value at 10.
    expect(evalKeyframes(out.x, 0)).toBe(evalKeyframes(kfs, 10));
  });
});
