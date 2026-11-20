import { describe, expect, it } from 'vitest';
import {
  RAMP_GAP,
  RAMP_MAX,
  RAMP_MEDIA,
  RAMP_MIN,
  RAMP_POINTS,
  RAMP_SHAPES,
  RAMP_SHAPE_NAMES,
  conformRamp,
  flatRamp,
  mediaToStream,
  rampCurve,
  rampKey,
  rampTable,
  shapeOf,
  shapeRamp,
  shiftRamp,
  streamSpeed,
  streamToMedia,
  tidyRamp,
} from '../src';
import type { RampPoint, RampShape } from '../src';
import { random, randomRamp } from './helpers';

const SHAPES = Object.keys(RAMP_SHAPES) as RampShape[];

/** The hardest ramp the reader lets through: as many points as fit, as close as allowed, from slowest to fastest and back. */
const jagged = (): RampPoint[] =>
  Array.from({ length: RAMP_POINTS }, (_, i) => ({ m: 2 + i * RAMP_GAP, v: i % 2 ? RAMP_MAX : RAMP_MIN }));

describe('the clock of a ramp', () => {
  it('finds the stream time of a second of media, and from there the second again', () => {
    const rnd = random(12345);
    let worst = 0;
    let worstBack = 0;
    for (let r = 0; r < 2000; r++) {
      const ramp = randomRamp(rnd);
      const t = rampTable(ramp);
      const from = ramp[0].m - 1;
      const extent = ramp[ramp.length - 1].m - ramp[0].m + 2;
      for (let k = 0; k < 60; k++) {
        const m = from + (extent * k) / 59;
        const tau = mediaToStream(t, m);
        worst = Math.max(worst, Math.abs(streamToMedia(t, tau) - m));
        worstBack = Math.max(worstBack, Math.abs(mediaToStream(t, streamToMedia(t, tau)) - tau));
      }
      // On a point itself, where a shape puts the in point of its clip.
      for (const q of ramp) worst = Math.max(worst, Math.abs(streamToMedia(t, mediaToStream(t, q.m)) - q.m));
    }
    expect(worst).toBeLessThan(1e-12);
    expect(worstBack).toBeLessThan(1e-12);

    const t = rampTable(jagged());
    let hard = 0;
    for (let k = 0; k <= 5000; k++) {
      const m = 1.99 + (0.051 * k) / 5000;
      hard = Math.max(hard, Math.abs(streamToMedia(t, mediaToStream(t, m)) - m));
    }
    expect(hard).toBeLessThan(1e-12);
  });

  it('never runs backwards', () => {
    const rnd = random(99);
    let samples = 0;
    for (let r = 0; r < 200; r++) {
      const ramp = randomRamp(rnd);
      const t = rampTable(ramp);
      const from = ramp[0].m - 1;
      const extent = ramp[ramp.length - 1].m - ramp[0].m + 2;
      let before = -Infinity;
      let mediaBefore = -Infinity;
      for (let k = 0; k < 70; k++) {
        const tau = mediaToStream(t, from + (extent * k) / 69);
        expect(tau).toBeGreaterThan(before);
        before = tau;
        const m = streamToMedia(t, t.tau[0] - 1 + ((t.tau[t.n - 1] - t.tau[0] + 2) * k) / 69);
        expect(m).toBeGreaterThan(mediaBefore);
        mediaBefore = m;
        samples++;
      }
    }
    expect(samples).toBe(14000);

    const t = rampTable(jagged());
    let before = -Infinity;
    for (let k = 0; k <= 5000; k++) {
      const tau = mediaToStream(t, 1.99 + (0.051 * k) / 5000);
      expect(tau).toBeGreaterThan(before);
      before = tau;
    }
  });

  it('has no step in place or in speed at a point, nor where it goes on at the outermost speed', () => {
    const rnd = random(7);
    for (let r = 0; r < 300; r++) {
      const ramp = randomRamp(rnd);
      const t = rampTable(ramp);
      for (let i = 0; i < t.n; i++) {
        // A millionth of the shortest ease there is, either side of the point.
        const h = 1e-10;
        const [left, at, right] = [t.tau[i] - h, t.tau[i], t.tau[i] + h];
        expect(Math.abs(streamToMedia(t, at) - t.m[i])).toBeLessThan(1e-12);
        expect(Math.abs(streamToMedia(t, left) - t.m[i])).toBeLessThan(1e-8);
        expect(Math.abs(streamToMedia(t, right) - t.m[i])).toBeLessThan(1e-8);
        // The speed is the slope of the media over stream time, and it is the point's from both sides.
        expect(streamSpeed(t, at)).toBe(t.v[i]);
        expect(Math.abs(streamSpeed(t, left) - t.v[i])).toBeLessThan(1e-9);
        expect(Math.abs(streamSpeed(t, right) - t.v[i])).toBeLessThan(1e-9);
      }
      // Beyond the points: the outermost speeds, and a straight line.
      expect(streamSpeed(t, t.tau[0] - 50)).toBe(t.v[0]);
      expect(streamSpeed(t, t.tau[t.n - 1] + 50)).toBe(t.v[t.n - 1]);
      expect(streamToMedia(t, t.tau[0] - 3)).toBeCloseTo(t.m[0] - 3 * t.v[0], 9);
      expect(streamToMedia(t, t.tau[t.n - 1] + 3)).toBeCloseTo(t.m[t.n - 1] + 3 * t.v[t.n - 1], 9);
    }
  });

  it('measures the slope it reports', () => {
    // Eases of two seconds and more, so that a difference quotient is good to a billionth.
    const ramp = tidyRamp([
      { m: 0, v: 1 },
      { m: 3, v: 2 },
      { m: 6, v: 0.8 },
      { m: 9, v: 1.5 },
    ])!;
    const t = rampTable(ramp);
    const h = 3e-5;
    for (let i = 0; i < t.n; i++) {
      const at = streamToMedia(t, t.tau[i]);
      const left = (at - streamToMedia(t, t.tau[i] - h)) / h;
      const right = (streamToMedia(t, t.tau[i] + h) - at) / h;
      expect(Math.abs(left - right)).toBeLessThan(1e-9);
      expect(Math.abs(left - t.v[i])).toBeLessThan(1e-9);
    }
    for (let k = 0; k < 400; k++) {
      const tau = t.tau[0] - 1 + ((t.tau[t.n - 1] - t.tau[0] + 2) * k) / 399;
      const slope = (streamToMedia(t, tau + h) - streamToMedia(t, tau - h)) / (2 * h);
      expect(Math.abs(slope - streamSpeed(t, tau))).toBeLessThan(1e-9);
    }
  });

  it('takes an ease from one speed to another the media over their mean', () => {
    const rnd = random(31);
    for (let r = 0; r < 500; r++) {
      const ramp = randomRamp(rnd);
      const t = rampTable(ramp);
      for (let i = 0; i + 1 < ramp.length; i++) {
        const took = mediaToStream(t, ramp[i + 1].m) - mediaToStream(t, ramp[i].m);
        expect(Math.abs(took - (2 * (ramp[i + 1].m - ramp[i].m)) / (ramp[i].v + ramp[i + 1].v))).toBeLessThan(
          1e-12,
        );
      }
    }
    // Ten seconds of media from 100% up to 300%: the mean is 200%, so five seconds.
    const t = rampTable([
      { m: 0, v: 1 },
      { m: 10, v: 3 },
    ]);
    expect(mediaToStream(t, 10) - mediaToStream(t, 0)).toBe(5);
    // Half way through the time it is at the mean speed.
    expect(streamSpeed(t, 2.5)).toBe(2);
  });

  it('covers the media that its speed adds up to', () => {
    /** Simpson's rule. */
    const integral = (f: (x: number) => number, lo: number, hi: number, steps: number): number => {
      const h = (hi - lo) / steps;
      let sum = f(lo) + f(hi);
      for (let k = 1; k < steps; k++) sum += (k % 2 ? 4 : 2) * f(lo + k * h);
      return (sum * h) / 3;
    };
    const rnd = random(5);
    let worst = 0;
    for (let r = 0; r < 200; r++) {
      const ramp = randomRamp(rnd);
      const t = rampTable(ramp);
      const from = t.tau[0] - 0.5 + rnd() * 2;
      // Five seconds of stream, summed piece by piece between the points it passes.
      const cuts = [from, ...Array.from(t.tau).filter((tau) => tau > from && tau < from + 5), from + 5];
      let covered = 0;
      for (let i = 0; i + 1 < cuts.length; i++) {
        covered += integral((tau) => streamSpeed(t, tau), cuts[i], cuts[i + 1], 200);
      }
      worst = Math.max(worst, Math.abs(streamToMedia(t, from + 5) - streamToMedia(t, from) - covered));
    }
    expect(worst).toBeLessThan(1e-8);
  });

  it('is laid out once for each ramp', () => {
    const ramp = shapeRamp('hero', 2, 12, false)!;
    expect(rampTable(ramp)).toBe(rampTable(ramp));
    expect(rampTable(ramp.slice())).not.toBe(rampTable(ramp));
    expect(rampTable(ramp).n).toBe(6);
    expect(Array.from(rampTable(ramp).m)).toEqual(ramp.map((q) => q.m));
  });
});

describe('points as they are written', () => {
  it('rounds, clamps and orders them', () => {
    expect(
      tidyRamp([
        { m: 4.00000049, v: 2.0004 },
        { m: 1.2345678, v: 0.01 },
        { m: 9, v: 250 },
      ]),
    ).toEqual([
      { m: 1.234568, v: 0.1 },
      { m: 4, v: 2 },
      { m: 9, v: 10 },
    ]);
    expect(
      tidyRamp([
        { m: -1e9, v: 1 },
        { m: 1e9, v: 1 },
      ]),
    ).toEqual([
      { m: -RAMP_MEDIA, v: 1 },
      { m: RAMP_MEDIA, v: 1 },
    ]);
  });

  it('drops a point that is too close to the one before it, and what is not a number', () => {
    expect(
      tidyRamp([
        { m: 1, v: 1 },
        { m: 1.0004, v: 5 },
        { m: 1.001, v: 3 },
        { m: 1.0019, v: 7 },
        { m: NaN, v: 1 },
        { m: 2, v: Infinity },
        { m: 3, v: 2 },
      ]),
    ).toEqual([
      { m: 1, v: 1 },
      { m: 1.001, v: 3 },
      { m: 3, v: 2 },
    ]);
    // Exactly the least gap apart is far enough, wherever on the axis the two stand.
    for (const at of [0, 2, 17.3, 4000.123, -250000.5]) {
      const pair = tidyRamp([
        { m: at, v: 1 },
        { m: at + RAMP_GAP, v: 2 },
      ]);
      expect(pair).toHaveLength(2);
      expect(conformRamp(pair)).toBe(pair);
    }
  });

  it('keeps no more points than a ramp holds, and needs two', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ m: i, v: 1 + (i % 3) }));
    const kept = tidyRamp(many)!;
    expect(kept).toHaveLength(RAMP_POINTS);
    expect(kept).toEqual(many.slice(0, 32));
    expect(tidyRamp([{ m: 1, v: 2 }])).toBeNull();
    expect(tidyRamp([])).toBeNull();
    expect(
      tidyRamp([
        { m: 1, v: 2 },
        { m: 1.0002, v: 3 },
      ]),
    ).toBeNull();
  });

  it('is what the reader hands back untouched', () => {
    const rnd = random(2024);
    for (let r = 0; r < 300; r++) {
      const ramp = randomRamp(rnd);
      expect(tidyRamp(ramp)).toEqual(ramp);
      expect(conformRamp(ramp)).toBe(ramp);
    }
    for (const shape of SHAPES) {
      const ramp = shapeRamp(shape, 3.21, 9.87, false)!;
      expect(conformRamp(ramp)).toBe(ramp);
    }
  });
});

describe('a ramp read from a document', () => {
  it('is null for no ramp, and nothing for what is not a list', () => {
    expect(conformRamp(null)).toBeNull();
    for (const junk of [undefined, 5, 'ramp', true, {}, { m: 1, v: 1 }])
      expect(conformRamp(junk)).toBeUndefined();
  });

  it('keeps the points that are points, inside their ranges and in order', () => {
    expect(
      conformRamp([
        { m: 5, v: 1e308 },
        null,
        'x',
        [1, 2],
        { m: '1', v: 2 },
        { m: 2, v: -3 },
        { m: NaN, v: 1 },
        { m: 1e308, v: 0 },
        { m: 3.5, v: 2.5, e: 'hold' },
      ]),
    ).toEqual([
      { m: 2, v: RAMP_MIN },
      { m: 3.5, v: 2.5 },
      { m: 5, v: RAMP_MAX },
      { m: RAMP_MEDIA, v: RAMP_MIN },
    ]);
  });

  it('is null when fewer than two points are left', () => {
    expect(conformRamp([])).toBeNull();
    expect(conformRamp([{ m: 1, v: 1 }])).toBeNull();
    expect(conformRamp([null, 7, { m: 1, v: 1 }, { m: 1, v: 4 }])).toBeNull();
    expect(
      conformRamp([
        { m: 1e308, v: 1 },
        { m: 2e307, v: 2 },
      ]),
    ).toBeNull();
  });

  it('looks at a bounded number of items and keeps as many points as a ramp holds', () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => ({ m: 100_000 - i, v: 1 + (i % 9) }));
    const read = conformRamp(huge)!;
    expect(read).toHaveLength(RAMP_POINTS);
    for (let i = 1; i < read.length; i++) expect(read[i].m - read[i - 1].m).toBeGreaterThanOrEqual(RAMP_GAP);
    // Whatever it keeps, the clock of it is finite and runs forwards.
    const t = rampTable(read);
    for (const m of [-RAMP_MEDIA, 0, 95_000.5, RAMP_MEDIA]) {
      expect(Number.isFinite(mediaToStream(t, m))).toBe(true);
      expect(Math.abs(streamToMedia(t, mediaToStream(t, m)) - m)).toBeLessThan(1e-6);
    }
  });

  it('does not round, so that what an older or a newer build wrote plays as written', () => {
    const fine = [
      { m: 1.23456789012, v: 0.123456 },
      { m: 2.5, v: 9.87654321 },
    ];
    expect(conformRamp(fine)).toBe(fine);
  });
});

describe('moving a ramp along the media', () => {
  it('moves every point, to the microsecond', () => {
    const ramp = shapeRamp('bullet', 5, 15, false)!;
    const moved = shiftRamp(ramp, -3.8000004);
    expect(moved.map((q) => q.v)).toEqual(ramp.map((q) => q.v));
    moved.forEach((q, i) => expect(q.m).toBe(Math.round((ramp[i].m - 3.8) * 1e6) / 1e6));
    expect(conformRamp(moved)).toBe(moved);
    expect(shapeOf(moved, false)).toBe('bullet');
  });

  it('hands back the same ramp for a shift that comes to nothing', () => {
    const ramp = shapeRamp('hero', 5, 15, false)!;
    for (const by of [0, -0, 4e-7, -4.9e-7, 1e-15, NaN]) expect(shiftRamp(ramp, by)).toBe(ramp);
    expect(shiftRamp(ramp, 6e-7)).not.toBe(ramp);
  });

  it('stops where a point would leave the axis, and stays a ramp', () => {
    const ramp = shapeRamp('montage', 5, 15, false)!;
    for (const by of [1e9, -1e9, 1e300, -Infinity]) {
      const moved = shiftRamp(ramp, by);
      expect(conformRamp(moved)).toBe(moved);
      expect(moved).toHaveLength(ramp.length);
      expect(Math.abs(by > 0 ? moved[moved.length - 1].m : moved[0].m)).toBe(RAMP_MEDIA);
    }
  });
});

describe('the ready-made shapes', () => {
  it('have a name each', () => {
    expect(SHAPES.map((s) => RAMP_SHAPE_NAMES[s])).toEqual([
      'Ramp up',
      'Ramp down',
      'Montage',
      'Hero',
      'Bullet',
      'Flash in',
      'Flash out',
    ]);
  });

  it('are laid over a stretch of media in play order', () => {
    for (const shape of SHAPES) {
      const points = RAMP_SHAPES[shape];
      const forwards = shapeRamp(shape, 5, 15, false)!;
      expect(forwards).toEqual(points.map(([f, v]) => ({ m: Math.round((5 + f * 10) * 1e6) / 1e6, v })));
      // Played backwards the clip meets the top of its stretch first, so the shape lies the other way on the media.
      const backwards = shapeRamp(shape, 5, 15, true)!;
      expect(backwards).toEqual(
        points.map(([f, v]) => ({ m: Math.round((15 - f * 10) * 1e6) / 1e6, v })).reverse(),
      );
      expect(forwards[0].m).toBe(5);
      expect(forwards[forwards.length - 1].m).toBe(15);
    }
    expect(shapeRamp('rampUp', 5, 15, true)).toEqual(shapeRamp('rampDown', 5, 15, false));
  });

  it('are found again on a ramp, whichever way the clip plays, and are not seen where there is none', () => {
    const rnd = random(8);
    for (let r = 0; r < 200; r++) {
      const a = Math.round(rnd() * 50 * 1e6) / 1e6;
      const b = a + 0.05 + rnd() * 60;
      for (const shape of SHAPES) {
        expect(shapeOf(shapeRamp(shape, a, b, false)!, false)).toBe(shape);
        expect(shapeOf(shapeRamp(shape, a, b, true)!, true)).toBe(shape);
        expect(shapeOf(shiftRamp(shapeRamp(shape, a, b, false)!, rnd() * 9 - 4), false)).toBe(shape);
      }
    }
    // Seen the other way round, a shape is its mirror: another shape, itself, or none.
    const mirror = (shape: RampShape) => shapeOf(shapeRamp(shape, 2, 8, false)!, true);
    expect(SHAPES.map(mirror)).toEqual(['rampDown', 'rampUp', null, 'hero', 'bullet', 'flashOut', 'flashIn']);
    const hero = shapeRamp('hero', 2, 12, false)!;
    // A point dragged, a speed changed, a point added or taken away: no shape.
    expect(
      shapeOf(
        hero.map((q, i) => (i === 2 ? { ...q, m: q.m + 0.2 } : q)),
        false,
      ),
    ).toBeNull();
    expect(
      shapeOf(
        hero.map((q, i) => (i === 2 ? { ...q, v: 0.35 } : q)),
        false,
      ),
    ).toBeNull();
    expect(shapeOf(hero.slice(1), false)).toBeNull();
    expect(shapeOf(flatRamp(2, 12, 1)!, false)).toBeNull();
    expect(
      shapeOf(
        tidyRamp([
          { m: 1, v: 1 },
          { m: 3, v: 5.2 },
          { m: 4.5, v: 0.4 },
        ])!,
        false,
      ),
    ).toBeNull();
  });

  it('do not fit on a stretch too short to hold their points apart', () => {
    for (const shape of SHAPES) {
      expect(shapeRamp(shape, 5, 5, false)).toBeNull();
      expect(shapeRamp(shape, 5, 5.0005, false)).toBeNull();
      expect(shapeRamp(shape, 5, 5.1, false)).toHaveLength(RAMP_SHAPES[shape].length);
    }
    // The slow middle of "Bullet" is 8% of the stretch from the points beside it.
    expect(shapeRamp('bullet', 5, 5.012, false)).toBeNull();
    expect(shapeRamp('bullet', 5, 5.013, false)).toHaveLength(5);
    expect(shapeRamp('rampUp', 5, 5.001, false)).toHaveLength(2);
  });

  it('start from two points at the speed the clip had', () => {
    expect(flatRamp(2, 12, 1.5)).toEqual([
      { m: 2, v: 1.5 },
      { m: 12, v: 1.5 },
    ]);
    // A ramp runs between 10% and 1000%.
    expect(flatRamp(2, 12, 40)!.map((q) => q.v)).toEqual([10, 10]);
    expect(flatRamp(2, 12, 0.05)!.map((q) => q.v)).toEqual([0.1, 0.1]);
    expect(flatRamp(2, 2.0001, 1)).toBeNull();
    const t = rampTable(flatRamp(2, 12, 2)!);
    expect(mediaToStream(t, 12) - mediaToStream(t, 2)).toBe(5);
    expect(streamToMedia(t, mediaToStream(t, 2) + 1.25)).toBe(4.5);
  });
});

describe('a ramp as a key and as a curve', () => {
  it('has one key for equal ramps and another for any other', () => {
    const ramp = shapeRamp('flashOut', 1, 7, false)!;
    expect(rampKey(ramp)).toBe(rampKey(ramp.map((q) => ({ ...q }))));
    expect(rampKey(null)).toBe('');
    const keys = new Set(SHAPES.map((s) => rampKey(shapeRamp(s, 1, 7, false))));
    keys.add(rampKey(shiftRamp(ramp, 1e-6)));
    keys.add(rampKey(ramp.map((q, i) => (i ? q : { ...q, v: 1.001 }))));
    keys.add(rampKey(null));
    expect(keys.size).toBe(SHAPES.length + 3);
  });

  it('draws the speed over the media between two seconds', () => {
    const ramp = shapeRamp('hero', 2, 12, false)!;
    const t = rampTable(ramp);
    const curve = rampCurve(ramp, 3.3, 10.4, 12);
    expect(curve[0].m).toBe(3.3);
    expect(curve[curve.length - 1].m).toBe(10.4);
    for (let i = 1; i < curve.length; i++) expect(curve[i].m).toBeGreaterThan(curve[i - 1].m);
    for (const q of curve) {
      expect(Math.abs(q.v - streamSpeed(t, mediaToStream(t, q.m)))).toBeLessThan(1e-9);
      expect(q.v).toBeGreaterThanOrEqual(0.3);
      expect(q.v).toBeLessThanOrEqual(4);
    }
    // Every point of the ramp inside the range is on the curve, and each ease is sampled.
    for (const q of ramp.slice(1, -1)) expect(curve).toContainEqual(q);
    expect(curve.length).toBeGreaterThan(12 * 3);
    // Past the points the line is flat at the outermost speeds.
    const whole = rampCurve(ramp, 0, 14);
    expect(whole[0]).toEqual({ m: 0, v: 1 });
    expect(whole[whole.length - 1]).toEqual({ m: 14, v: 1 });
    expect(whole).toContainEqual(ramp[0]);
    expect(whole).toContainEqual(ramp[ramp.length - 1]);
    expect(rampCurve(ramp, 20, 30)).toEqual([
      { m: 20, v: 1 },
      { m: 30, v: 1 },
    ]);
  });
});
