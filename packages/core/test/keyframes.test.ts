import { describe, expect, it } from 'vitest';
import {
  ProjectStore,
  applyEasing,
  conformEasing,
  cubicBezier,
  evalKeyframes,
  makeClip,
  setKeyframeEasing,
  shiftKeyframes,
  tracksOf,
  upsertKeyframe,
} from '../src';
import type { Easing, Keyframe } from '../src';
import { connect } from './helpers';

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

  it('solves curves whose handles sit on the edge of the segment', () => {
    // x(t) is flat at one end of these, which is where Newton's method stalls.
    expect(cubicBezier(1, 0, 1, 1, 0.98)).toBeCloseTo(0.8189, 3);
    expect(cubicBezier(0, 0, 0, 1, 0.02)).toBeCloseTo(0.1811, 3);
    expect(cubicBezier(0, 1, 0, 1, 0.001)).toBeCloseTo(0.271, 3);
    expect(cubicBezier(1, 0, 1, 0, 0.999)).toBeCloseTo(0.729, 3);
  });

  it('matches a brute-force solution for any handles inside the segment', () => {
    const reference = (x1: number, y1: number, x2: number, y2: number, x: number): number => {
      const at = (a: number, b: number, t: number) =>
        3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (at(x1, x2, mid) < x) lo = mid;
        else hi = mid;
      }
      return at(y1, y2, (lo + hi) / 2);
    };
    const xs = [0, 0.1, 0.25, 0.42, 0.58, 0.9, 1];
    const ys = [-0.5, 0, 0.3, 1, 1.6];
    let worst = 0;
    for (const x1 of xs)
      for (const x2 of xs)
        for (const y1 of ys)
          for (const y2 of ys)
            for (let x = 0.01; x < 1; x += 0.049) {
              worst = Math.max(
                worst,
                Math.abs(cubicBezier(x1, y1, x2, y2, x) - reference(x1, y1, x2, y2, x)),
              );
            }
    expect(worst).toBeLessThan(1e-3);
  });

  it('sets the interpolation of one keyframe: presets, hold and custom curves', () => {
    const clip = makeClip('video', 't', {
      duration: 100,
      keyframes: {
        x: [
          { t: 0, v: 0, e: 'easeInOut' },
          { t: 20, v: 100, e: 'easeInOut' },
          { t: 40, v: 0, e: 'easeInOut' },
        ],
      },
    });
    const at = (e: Easing, t: number): number =>
      evalKeyframes({ ...clip, ...setKeyframeEasing(clip, 'x', 0, e) }.keyframes.x, t);
    expect(at('linear', 5)).toBeCloseTo(25);
    expect(at('hold', 5)).toBe(0);
    expect(at('hold', 19)).toBe(0);
    expect(at('hold', 20)).toBe(100);
    expect(at('easeIn', 10)).toBeLessThan(40);
    expect(at('easeOut', 10)).toBeGreaterThan(60);
    expect(at('easeInOut', 10)).toBeCloseTo(50, 3);
    expect(at('easeInOut', 5)).toBeLessThan(25);
    expect(at('ease', 10)).toBeGreaterThan(70);
    expect(at([0, 0, 1, 1], 5)).toBeCloseTo(25, 3);
    // An overshooting curve goes past the target and comes back.
    expect(at([0.3, 1.8, 0.6, 1], 10)).toBeGreaterThan(100);
    // Only the chosen keyframe changes; the segment after it keeps its own easing.
    const patch = setKeyframeEasing(clip, 'x', 0, 'hold');
    expect(patch.keyframes!.x.map((k) => k.e)).toEqual(['hold', 'easeInOut', 'easeInOut']);
    expect(patch.keyframes!.x[1]).toBe(clip.keyframes.x[1]);
    expect(evalKeyframes(patch.keyframes!.x, 30)).toBeCloseTo(50, 3);

    // Nothing to do: no such property, no keyframe at that frame, or the easing is already set.
    expect(setKeyframeEasing(clip, 'y', 0, 'linear')).toEqual({});
    expect(setKeyframeEasing(clip, 'x', 7, 'linear')).toEqual({});
    expect(setKeyframeEasing(clip, 'x', 0, 'easeInOut')).toEqual({});
    const curved = { ...clip, ...setKeyframeEasing(clip, 'x', 0, [0.2, 0, 0.4, 1]) };
    expect(setKeyframeEasing(curved, 'x', 0, [0.2, 0, 0.4, 1])).toEqual({});
  });

  it('keeps easings well-formed, whatever is asked for', () => {
    expect(conformEasing('hold')).toBe('hold');
    expect(conformEasing([0.2, -1, 0.8, 2])).toEqual([0.2, -1, 0.8, 2]);
    // Time handles outside the segment would make the curve fold back on itself.
    expect(conformEasing([-0.5, 0, 1.5, 1])).toEqual([0, 0, 1, 1]);
    for (const bad of ['bouncy', 5, null, undefined, [0, 0, 1], [0, 0, 1, NaN], [0, 0, 1, '1'], {}])
      expect(conformEasing(bad)).toBe('linear');
    const clip = makeClip('video', 't', { keyframes: { x: [{ t: 0, v: 0, e: 'linear' }] } });
    const odd = setKeyframeEasing(clip, 'x', 0, [2, 0, -1, 1]);
    expect(odd.keyframes!.x[0].e).toEqual([1, 0, 0, 1]);
  });

  it('syncs an easing change to collaborators', () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const clip = makeClip('video', tracksOf(a.get()).video[0].id, {
      duration: 50,
      keyframes: {
        opacity: [
          { t: 0, v: 0, e: 'easeInOut' },
          { t: 10, v: 1, e: 'easeInOut' },
        ],
      },
    });
    a.commit([{ op: 'addClip', clip }]);
    a.commit([
      { op: 'updateClip', id: clip.id, patch: setKeyframeEasing(clip, 'opacity', 0, [0.1, 0.9, 0.2, 1]) },
    ]);
    expect(b.get().clips[clip.id].keyframes.opacity[0].e).toEqual([0.1, 0.9, 0.2, 1]);
    a.commit([{ op: 'updateClip', id: clip.id, patch: setKeyframeEasing(clip, 'opacity', 0, 'hold') }]);
    expect(evalKeyframes(b.get().clips[clip.id].keyframes.opacity, 9)).toBe(0);
    a.undo();
    expect(b.get().clips[clip.id].keyframes.opacity[0].e).toEqual([0.1, 0.9, 0.2, 1]);
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
