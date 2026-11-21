import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  emptyProject,
  frameOfMedia,
  makeClip,
  makeTrack,
  RAMP_GAP,
  RAMP_POINTS,
  RAMP_SHAPES,
  rampCurve,
  sourceSpan,
  sourceTimeAt,
  type Clip,
  type Project,
  type RampPoint,
  type RampShape,
} from '@tandem/core';
import {
  acrossOf,
  addPoint,
  besideOf,
  curvePath,
  describePoint,
  dragPoint,
  frameShowing,
  hitPoint,
  isFull,
  keyMove,
  mediaAcross,
  mediaShown,
  movePoint,
  pointAt,
  pointGap,
  rampRange,
  removePoint,
  secondMarks,
  shapePath,
  shownPoints,
  speedUp,
  upOf,
  type RampRange,
} from '../src/features/inspector/rampPoints';

/** A ramp over ten seconds of media: fast, then slow for a level stretch, then fast again. */
const RAMP: RampPoint[] = [
  { m: 0, v: 1 },
  { m: 2, v: 4 },
  { m: 3.5, v: 0.3 },
  { m: 5, v: 0.3 },
  { m: 7, v: 4 },
  { m: 9.5, v: 1 },
];

const track = makeTrack('video', 0);
const p: Project = applyEdits(emptyProject(), [{ op: 'addTrack', track }]);

/**
 * A clip on `RAMP` that was trimmed into the first ease and into the last: it plays the media
 * from second 1 to about second 8, so the points at 0 and at 9.5 lie beyond what it plays.
 */
function trimmed(reverse = false): Clip {
  const from = makeClip('video', track.id, { start: 100, sourceIn: 1, ramp: RAMP, reverse });
  return { ...from, duration: Math.round(frameOfMedia(from, 8, p)) };
}

const forwards = trimmed();
const backwards = trimmed(true);
const range = rampRange(forwards, p);
const mirrored = rampRange(backwards, p);
/** The graph as the panel draws it at its usual width. */
const box = { width: 260, height: 112 };

/** The speed of a ramp at second `m`, read from the curve core draws. */
const speedOn = (ramp: RampPoint[], m: number): number => rampCurve(ramp, m, m)[0].v;

const onGrid = (x: number, unit: number): boolean => Math.abs(x / unit - Math.round(x / unit)) < 1e-6;

describe('the stretch a ramp graph shows', () => {
  it('is the media the clip plays, with one frame of it to spare on either side', () => {
    expect(range.from).toBe(1);
    expect(range.to).toBe(sourceSpan(forwards, p).out);
    expect(range.to).toBeGreaterThan(7.9);
    expect(range.to).toBeLessThan(8.1);
    expect(range.before).toBeLessThan(range.from);
    expect(range.after).toBeGreaterThan(range.to);
    // A frame of the clip covers more media where it is fast: here the ends ease towards 100%.
    expect(range.from - range.before).toBeGreaterThan(1 / 30);
    expect(range.reverse).toBe(false);
    expect(mirrored).toEqual({ ...range, reverse: true });
  });

  it('runs across in play order and up by equal steps for equal ratios, both ways', () => {
    expect(acrossOf(range.from, range)).toBe(0);
    expect(acrossOf(range.to, range)).toBe(1);
    expect(acrossOf(range.from, mirrored)).toBe(1);
    expect(acrossOf(range.to, mirrored)).toBe(0);
    for (const m of [1, 2, 3.25, 6.5, range.to]) {
      expect(mediaAcross(acrossOf(m, range), range)).toBeCloseTo(m, 12);
      expect(mediaAcross(acrossOf(m, mirrored), mirrored)).toBeCloseTo(m, 12);
      expect(acrossOf(m, mirrored)).toBeCloseTo(1 - acrossOf(m, range), 12);
    }
    // A place beyond the stretch lies beyond the graph: it is not pulled onto its edge here.
    expect(acrossOf(0, range)).toBeLessThan(0);
    expect(acrossOf(9.5, mirrored)).toBeLessThan(0);

    expect(upOf(0.1)).toBe(0);
    expect(upOf(1)).toBe(0.5);
    expect(upOf(10)).toBe(1);
    expect(upOf(4) - upOf(2)).toBeCloseTo(upOf(0.5) - upOf(0.25), 12);
    for (const v of [0.1, 0.25, 1, 5.2, 10]) expect(speedUp(upOf(v))).toBeCloseTo(v, 12);
  });
});

describe('the points a ramp graph shows', () => {
  it('are those on the stretch the clip plays, from left to right', () => {
    const shown = shownPoints(RAMP, range);
    expect(shown.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(shown.map((s) => s.m)).toEqual([2, 3.5, 5, 7]);
    for (const s of shown) {
      expect(s.x).toBeCloseTo(acrossOf(s.m, range), 12);
      expect(s.y).toBeCloseTo(upOf(s.v), 12);
    }
    // Backwards the clip plays the high end first: the same points, the other way round.
    const back = shownPoints(RAMP, mirrored);
    expect(back.map((s) => s.index)).toEqual([4, 3, 2, 1]);
    back.forEach((s, i) => expect(s.x).toBeCloseTo(1 - shown[3 - i].x, 12));
    expect(back[0].x).toBeLessThan(back[1].x);
  });

  it('include a point within a frame of the stretch, on the edge, and none further out', () => {
    const near = (range.to + range.after) / 2;
    const far = range.after + 0.01;
    const low = (range.from + range.before) / 2;
    const ramp = (first: number, last: number): RampPoint[] => [
      { m: first, v: 2 },
      { m: 4, v: 0.5 },
      { m: last, v: 2 },
    ];
    const shown = shownPoints(ramp(low, near), range);
    expect(shown.map((s) => [s.index, s.x])).toEqual([
      [0, 0],
      [1, acrossOf(4, range)],
      [2, 1],
    ]);
    expect(shownPoints(ramp(range.before - 0.01, far), range).map((s) => s.index)).toEqual([1]);
    expect(shownPoints(ramp(low, near), mirrored).map((s) => [s.index, s.x])).toEqual([
      [2, 0],
      [1, acrossOf(4, mirrored)],
      [0, 1],
    ]);
  });

  it('are found again by their place, to within the least gap of a ramp', () => {
    expect(pointAt(RAMP, 3.5)).toBe(2);
    expect(pointAt(RAMP, 3.5 + RAMP_GAP / 2)).toBe(2);
    expect(pointAt(RAMP, 3.5 - RAMP_GAP * 0.99)).toBe(2);
    expect(pointAt(RAMP, 3.5 + RAMP_GAP * 1.01)).toBe(-1);
    expect(pointAt(RAMP, 4)).toBe(-1);
    // Between two points a gap apart, the nearer.
    const close = [
      { m: 1, v: 1 },
      { m: 1 + RAMP_GAP, v: 2 },
    ];
    expect(pointAt(close, 1 + RAMP_GAP * 0.4)).toBe(0);
    expect(pointAt(close, 1 + RAMP_GAP * 0.6)).toBe(1);
  });

  it('have a point beside them for the keyboard to go on to: the next the clip plays, else the one before', () => {
    for (const r of [range, mirrored]) {
      const shown = shownPoints(RAMP, r);
      expect(besideOf(shown, shown[0].index)).toBe(shown[1]);
      expect(besideOf(shown, shown[2].index)).toBe(shown[3]);
      expect(besideOf(shown, shown[3].index)).toBe(shown[2]);
      // A point that is not shown has none, and neither has the only one there is.
      expect(besideOf(shown, 0)).toBeNull();
      expect(besideOf(shown.slice(0, 1), shown[0].index)).toBeNull();
    }
  });

  it('are taken hold of within twelve pixels, the nearest first', () => {
    for (const r of [range, mirrored]) {
      const shown = shownPoints(RAMP, r);
      const at = (s: { x: number; y: number }) => [s.x * box.width, (1 - s.y) * box.height] as const;
      const [x, y] = at(shown[1]);
      expect(hitPoint(shown, x, y, box)).toBe(shown[1]);
      expect(hitPoint(shown, x + 11, y, box)).toBe(shown[1]);
      expect(hitPoint(shown, x, y - 11.5, box)).toBe(shown[1]);
      expect(hitPoint(shown, x + 9, y + 9, box)).toBeNull();
      expect(hitPoint(shown, x + 13, y, box)).toBeNull();
    }
    // Two points within reach of the pointer: the one it is nearer to.
    const pair = shownPoints(
      [
        { m: 4, v: 1 },
        { m: 4.3, v: 1 },
      ],
      range,
    );
    const between = ((pair[0].x + pair[1].x) / 2) * box.width;
    expect((pair[1].x - pair[0].x) * box.width).toBeLessThan(12);
    expect(hitPoint(pair, between - 1, 56, box)).toBe(pair[0]);
    expect(hitPoint(pair, between + 1, 56, box)).toBe(pair[1]);
  });
});

describe('moving a point of a ramp', () => {
  it('keeps its speed inside what a ramp holds and rounds what it writes', () => {
    const up = movePoint(RAMP, 2, { m: 3.5, v: 123 }, range);
    expect(up[2]).toEqual({ m: 3.5, v: 10 });
    expect(movePoint(RAMP, 2, { m: 3.5, v: 0.0001 }, range)[2]).toEqual({ m: 3.5, v: 0.1 });
    const moved = movePoint(RAMP, 2, { m: 3.1234567891, v: 1.23456789 }, range);
    expect(moved[2]).toEqual({ m: 3.123457, v: 1.235 });
    // The other points are the very objects they were.
    moved.forEach((q, i) => i !== 2 && expect(q).toBe(RAMP[i]));
    // Nothing moved: the list itself.
    expect(movePoint(RAMP, 2, { m: 3.5, v: 0.3 }, range)).toBe(RAMP);
    expect(movePoint(RAMP, 9, { m: 3.5, v: 0.3 }, range)).toBe(RAMP);
  });

  it('cannot cross the point beside it, shown or not, nor leave the stretch', () => {
    const gap = pointGap(range);
    expect(gap).toBeCloseTo((range.to - range.from) / 100, 12);
    expect(gap).toBeGreaterThan(RAMP_GAP);
    // Between two shown points.
    expect(movePoint(RAMP, 2, { m: 0, v: 0.3 }, range)[2].m).toBeCloseTo(2 + gap, 5);
    expect(movePoint(RAMP, 2, { m: 9, v: 0.3 }, range)[2].m).toBeCloseTo(5 - gap, 5);
    // The first shown point has a neighbour that is not shown, well before the stretch: the
    // stretch is what stops it. So it is for the last.
    expect(movePoint(RAMP, 1, { m: -3, v: 4 }, range)[1].m).toBe(range.from);
    expect(movePoint(RAMP, 4, { m: 12, v: 4 }, range)[4].m).toBeCloseTo(range.to, 5);
    expect(movePoint(RAMP, 4, { m: 12, v: 4 }, range)[4].m).toBeLessThanOrEqual(range.to);
    // A neighbour that is not shown, just beyond the edge, keeps its distance too.
    const hidden = [{ m: range.before - 0.02, v: 1 }, ...RAMP.slice(1)];
    expect(shownPoints(hidden, range).map((s) => s.index)).toEqual([1, 2, 3, 4]);
    const stopped = movePoint(hidden, 1, { m: -3, v: 4 }, range)[1].m;
    expect(stopped).toBeCloseTo(Math.max(range.from, hidden[0].m + gap), 5);
    expect(stopped - hidden[0].m).toBeGreaterThanOrEqual(gap - 1e-6);
    for (const q of [stopped, movePoint(RAMP, 2, { m: 0, v: 0.3 }, range)[2].m]) {
      expect(onGrid(q, 1e-6)).toBe(true);
    }
    // On a stretch too short for a hundredth of it to count, the least gap of a ramp holds.
    expect(pointGap({ ...range, from: 1, to: 1.05 })).toBe(RAMP_GAP);
  });

  it('may always go back to where it was found, also where a drag would not take it', () => {
    // The last point of a shape lies a fraction of a frame beyond the stretch as often as not.
    const beyond = (range.to + range.after) / 2;
    const ramp = [...RAMP.slice(0, 4), { m: beyond, v: 4 }];
    const raised = movePoint(ramp, 4, { m: beyond, v: 6 }, range);
    expect(raised[4]).toEqual({ m: beyond, v: 6 });
    // Taken inwards it is on the stretch, and does not go further out than it was found.
    expect(movePoint(ramp, 4, { m: 7, v: 4 }, range)[4].m).toBe(7);
    expect(movePoint(ramp, 4, { m: 20, v: 4 }, range)[4].m).toBeCloseTo(beyond, 5);
    // Nearer its neighbour than the graph lets a point be taken: it stays, and moves away only.
    const tight = [...RAMP.slice(0, 2), { m: 2.01, v: 0.3 }, ...RAMP.slice(3)];
    expect(movePoint(tight, 2, { m: 2.01, v: 1 }, range)[2]).toEqual({ m: 2.01, v: 1 });
    expect(movePoint(tight, 2, { m: 2.001, v: 0.3 }, range)).toBe(tight);
    expect(movePoint(tight, 2, { m: 2.5, v: 0.3 }, range)[2].m).toBe(2.5);
  });

  it('by a drag up and back down leaves the very ramp it found, forwards and backwards', () => {
    for (const r of [range, mirrored]) {
      for (const i of [1, 2, 3, 4]) {
        let points = RAMP;
        for (const [dx, dy] of [
          [0, -9],
          [4, -31],
          [-17, -60],
          [3, 22],
          [1, 1],
          [0, 0],
        ]) {
          points = dragPoint(points, i, RAMP[i], dx, dy, box, r, { free: true });
        }
        expect(points).toEqual(RAMP);
      }
    }
    // Up is faster, by the height of the graph for a hundredfold.
    const up = dragPoint(RAMP, 2, RAMP[2], 0, -box.height / 4, box, range, { free: true });
    expect(up[2].m).toBe(3.5);
    expect(up[2].v).toBeCloseTo(0.3 * 10 ** 0.5, 3);
    expect(onGrid(up[2].v, 1e-3)).toBe(true);
    // To the right is later in the clip: further into the media forwards, back through it reversed.
    const right = dragPoint(RAMP, 2, RAMP[2], 13, 0, box, range, { free: true });
    expect(right[2].v).toBe(0.3);
    expect(right[2].m).toBeCloseTo(3.5 + (13 / box.width) * (range.to - range.from), 5);
    expect(onGrid(right[2].m, 1e-6)).toBe(true);
    const left = dragPoint(RAMP, 2, RAMP[2], 13, 0, box, mirrored, { free: true });
    expect(left[2].m).toBeCloseTo(3.5 - (13 / box.width) * (range.to - range.from), 5);
  });

  it('snaps to 100% within four pixels and to the playhead within six, and to neither with Shift held', () => {
    const toFull = (upOf(1) - upOf(0.3)) * box.height;
    for (const off of [-3.9, -1, 0, 3.9]) {
      expect(dragPoint(RAMP, 2, RAMP[2], 0, -toFull + off, box, range)[2].v).toBe(1);
      expect(dragPoint(RAMP, 2, RAMP[2], 0, -toFull + off, box, range, { free: true })[2].v).not.toBe(
        off === 0 ? 0 : 1,
      );
    }
    expect(dragPoint(RAMP, 2, RAMP[2], 0, -toFull + 5, box, range)[2].v).toBeLessThan(0.95);
    expect(dragPoint(RAMP, 2, RAMP[2], 0, -toFull - 5, box, range)[2].v).toBeGreaterThan(1.05);

    const playhead = 4.2345678;
    const toPlayhead = (acrossOf(playhead, range) - acrossOf(3.5, range)) * box.width;
    for (const off of [-5.9, -2, 5]) {
      expect(dragPoint(RAMP, 2, RAMP[2], toPlayhead + off, 0, box, range, { playhead })[2].m).toBe(4.234568);
      const loose = dragPoint(RAMP, 2, RAMP[2], toPlayhead + off, 0, box, range, { playhead, free: true });
      expect(loose[2].m).not.toBe(4.234568);
    }
    expect(dragPoint(RAMP, 2, RAMP[2], toPlayhead + 7, 0, box, range, { playhead })[2].m).toBeGreaterThan(
      4.3,
    );
    // A playhead that is off the clip is nothing to snap to, and neither snap moves a point along
    // a direction the pointer has not moved in: a point found at 102% is not pulled to 100%.
    expect(dragPoint(RAMP, 2, RAMP[2], toPlayhead + 3, 0, box, range, { playhead: null })[2].m).not.toBe(
      4.234568,
    );
    const nearly = RAMP.map((q, i) => (i === 2 ? { m: 3.5, v: 1.02 } : q));
    expect(dragPoint(nearly, 2, nearly[2], 9, 0, box, range)[2].v).toBe(1.02);
    expect(dragPoint(nearly, 2, nearly[2], 0, 1, box, range)[2].v).toBe(1);
    // The playhead beyond a neighbour: the point stops at the neighbour.
    const past = dragPoint(RAMP, 2, RAMP[2], 200, 0, box, range, { playhead: 5.01 });
    expect(past[2].m).toBeCloseTo(5 - pointGap(range), 5);
  });

  it('by the keys: a twentieth, more with Shift, double and half, the ends, a hundredth and a tenth of the stretch', () => {
    const key = (name: string, shift = false, r = range, i = 2) => keyMove(name, shift, RAMP, i, r)?.[i];
    expect(key('ArrowUp')).toEqual({ m: 3.5, v: 0.315 });
    expect(key('ArrowDown')).toEqual({ m: 3.5, v: 0.286 });
    expect(key('ArrowUp', true)).toEqual({ m: 3.5, v: 0.486 });
    expect(key('ArrowDown', true)).toEqual({ m: 3.5, v: 0.185 });
    expect(key('PageUp')).toEqual({ m: 3.5, v: 0.6 });
    expect(key('PageDown')).toEqual({ m: 3.5, v: 0.15 });
    expect(key('Home')).toEqual({ m: 3.5, v: 0.1 });
    expect(key('End')).toEqual({ m: 3.5, v: 10 });
    const step = (range.to - range.from) / 100;
    expect(key('ArrowRight')!.m).toBeCloseTo(3.5 + step, 5);
    expect(key('ArrowLeft')!.m).toBeCloseTo(3.5 - step, 5);
    expect(key('ArrowRight', true)!.m).toBeCloseTo(3.5 + 10 * step, 5);
    expect(key('ArrowRight')!.v).toBe(0.3);
    // Backwards, right is still later in the clip: earlier in the media.
    expect(key('ArrowRight', false, mirrored)!.m).toBeCloseTo(3.5 - step, 5);
    expect(key('ArrowLeft', true, mirrored)!.m).toBeCloseTo(3.5 + 10 * step, 5);
    // At a limit a key has nothing to do, and still is the point's key.
    expect(keyMove('PageUp', false, RAMP, 1, range)![1].v).toBe(8);
    const fastest = keyMove('End', false, RAMP, 1, range)!;
    expect(keyMove('ArrowUp', false, fastest, 1, range)).toBe(fastest);
    expect(keyMove('PageUp', true, fastest, 1, range)).toBe(fastest);
    const slowest = keyMove('Home', false, RAMP, 1, range)!;
    expect(keyMove('PageDown', false, slowest, 1, range)).toBe(slowest);
    let run = RAMP;
    for (let n = 0; n < 4; n++) run = keyMove('ArrowLeft', true, run, 1, range)!;
    expect(run[1].m).toBe(range.from);
    expect(keyMove('ArrowLeft', false, run, 1, range)).toBe(run);
    for (let n = 0; n < 40; n++) run = keyMove('ArrowRight', true, run, 3, range)!;
    expect(run[3].m).toBeCloseTo(7 - pointGap(range), 5);
    expect(keyMove('ArrowRight', false, run, 3, range)).toBe(run);
    // Any other key is not about a point.
    for (const name of ['Enter', 'Delete', 'a', 'Tab', ' '])
      expect(keyMove(name, false, RAMP, 2, range)).toBeUndefined();
    expect(keyMove('ArrowUp', false, RAMP, 9, range)).toBeUndefined();
  });
});

describe('adding and removing a point of a ramp', () => {
  it('adds on the curve as it runs, in its place among the others', () => {
    const added = addPoint(RAMP, 2.75, range)!;
    expect(added.index).toBe(2);
    expect(added.points).toHaveLength(7);
    expect(added.points[2].m).toBe(2.75);
    expect(added.points[2].v).toBeCloseTo(speedOn(RAMP, 2.75), 3);
    expect(onGrid(added.points[2].v, 1e-3)).toBe(true);
    expect(added.points.filter((_, i) => i !== 2)).toEqual(RAMP);
    // A place is kept to the microsecond, and on the stretch.
    expect(addPoint(RAMP, 6.12345678, range)!.points[4].m).toBe(6.123457);
    expect(addPoint(RAMP, 99, range)!.points[5].m).toBeCloseTo(range.to, 5);
  });

  it('leaves the curve as it was when the point is added on a level stretch', () => {
    const playhead = mediaShown(forwards, forwards.start + 60, p)!;
    expect(playhead).toBeGreaterThan(3.6);
    expect(playhead).toBeLessThan(4.9);
    const added = addPoint(RAMP, playhead, range)!;
    expect(added.points[added.index].v).toBe(0.3);
    for (let m = 0; m <= 9.5; m += 0.0625) {
      expect(Math.abs(speedOn(added.points, m) - speedOn(RAMP, m))).toBeLessThan(1e-9);
    }
    // On a slope the speed comes to rest at the new point: the curve around it is another.
    const sloped = addPoint(RAMP, 2.75, range)!;
    expect(Math.abs(speedOn(sloped.points, 2.4) - speedOn(RAMP, 2.4))).toBeGreaterThan(1e-3);
  });

  it('is refused within the gap of a point that is there, shown or not, and when the ramp is full', () => {
    const gap = pointGap(range);
    expect(addPoint(RAMP, 3.5 + gap * 0.9, range)).toBeNull();
    expect(addPoint(RAMP, 3.5 - gap * 0.9, range)).toBeNull();
    expect(addPoint(RAMP, 3.5 + gap * 1.1, range)).not.toBeNull();
    const hidden = [{ m: range.from - gap / 2, v: 1 }, ...RAMP.slice(1)];
    expect(shownPoints(hidden, { ...range, before: range.from }).map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(addPoint(hidden, range.from, range)).toBeNull();

    const full = Array.from({ length: RAMP_POINTS }, (_, i) => ({ m: i * 0.25, v: 1 }));
    expect(isFull(full)).toBe(true);
    expect(isFull(full.slice(1))).toBe(false);
    expect(addPoint(full, 4.1, range)).toBeNull();
    expect(addPoint(full.slice(1), 4.1, range)).not.toBeNull();
  });

  it('removes any point but not one of the last two', () => {
    expect(removePoint(RAMP, 2)).toEqual([RAMP[0], RAMP[1], RAMP[3], RAMP[4], RAMP[5]]);
    const three = RAMP.slice(0, 3);
    expect(removePoint(three, 0)).toEqual([RAMP[1], RAMP[2]]);
    expect(removePoint(three.slice(1), 0)).toBeNull();
    expect(removePoint(three.slice(1), 1)).toBeNull();
    expect(removePoint(RAMP, 6)).toBeNull();
  });
});

describe('what a ramp graph says and draws', () => {
  it('reads a point out as its speed and its place in what the clip plays', () => {
    expect(describePoint({ m: 6.8, v: 5.2 }, range)).toBe('520% at 5.80 seconds');
    expect(describePoint({ m: 2, v: 0.251 }, range)).toBe('25% at 1.00 seconds');
    // Backwards the clip begins at the high end.
    expect(describePoint({ m: range.to - 0.5, v: 1 }, mirrored)).toBe('100% at 0.50 seconds');
    // A point shown on the edge from just beyond it stands at the edge.
    expect(describePoint({ m: range.from - 0.01, v: 1 }, range)).toBe('100% at 0.00 seconds');
  });

  it('draws the curve through every point it shows, also one on the edge', () => {
    const vertices = (d: string): [number, number][] =>
      d
        .slice(1)
        .split('L')
        .map((pair) => pair.split(' ').map(Number) as [number, number]);
    const size = { width: 1000, height: 100 };
    const edge = [...RAMP.slice(0, 4), { m: (range.to + range.after) / 2, v: 6 }];
    for (const r of [range, mirrored]) {
      for (const ramp of [RAMP, edge]) {
        const path = vertices(curvePath(ramp, r, size));
        const shown = shownPoints(ramp, r);
        expect(shown.length).toBeGreaterThanOrEqual(4);
        for (const s of shown) {
          const on = path.some(
            ([x, y]) => Math.abs(x - s.x * 1000) <= 0.006 && Math.abs(y - (1 - s.y) * 100) <= 0.006,
          );
          expect(on, `point ${s.index}`).toBe(true);
        }
        // It runs from one edge of the graph to the other, and stays in it.
        const xs = path.map(([x]) => x);
        expect(Math.min(...xs)).toBe(0);
        expect(Math.max(...xs)).toBe(1000);
        for (const [, y] of path) {
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(100);
        }
      }
    }
    // Between two points it is the eased curve, not a straight line: halfway through the media
    // of an ease the speed is not the mean of its ends.
    const mid = vertices(curvePath(RAMP, range, size)).find(
      ([x]) => Math.abs(x - acrossOf(2.75, range) * 1000) < 6,
    )!;
    expect(
      Math.abs(mid[1] - (1 - upOf(speedOn(RAMP, mediaAcross(mid[0] / 1000, range)))) * 100),
    ).toBeLessThan(0.01);
  });

  it('marks the whole seconds of the clip, close together where it is slow', () => {
    const { step, at } = secondMarks(forwards, p, range);
    const seconds = forwards.duration / 30;
    expect(step).toBe(1);
    expect(at).toHaveLength(Math.ceil(seconds) - 1);
    at.forEach((x, i) => {
      expect(frameOfMedia(forwards, mediaAcross(x, range), p)).toBeCloseTo((i + 1) * 30, 6);
    });
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // More marks to the same width on the slow stretch than on the fast ends.
    const within = (lo: number, hi: number) =>
      at.filter((x) => x > acrossOf(lo, range) && x < acrossOf(hi, range)).length;
    expect(within(3.5, 5)).toBeGreaterThan(within(1, 2.5) + 1);

    // Backwards the clip's time begins at the high end of the media, on the left.
    const back = secondMarks(backwards, p, mirrored);
    expect(back.at).toHaveLength(at.length);
    back.at.forEach((x, i) => {
      const frame = backwards.duration - frameOfMedia(backwards, mediaAcross(x, mirrored), p);
      expect(frame).toBeCloseTo((i + 1) * 30, 6);
    });
    expect([...back.at].sort((a, b) => a - b)).toEqual(back.at);

    // Where every second would be too many marks, every few seconds.
    const few = secondMarks(forwards, p, range, 3);
    expect(few.step).toBe(seconds / 2 <= 3 ? 2 : 5);
    expect(few.at.length).toBeLessThanOrEqual(3);
    few.at.forEach((x, i) => {
      expect(frameOfMedia(forwards, mediaAcross(x, range), p)).toBeCloseTo((i + 1) * few.step * 30, 6);
    });
  });

  it('knows the frame that shows a place in the media, and the place a frame shows', () => {
    for (const clip of [forwards, backwards]) {
      for (const local of [0, 1, 17, 60, clip.duration - 1]) {
        const m = sourceTimeAt(clip, local, p);
        expect(mediaShown(clip, clip.start + local, p)).toBe(m);
        expect(mediaShown(clip, clip.start + local + 0.7, p)).toBe(m);
        expect(frameShowing(clip, m, p)).toBe(clip.start + local);
      }
      // Off the clip the playhead shows none of it.
      expect(mediaShown(clip, clip.start - 1, p)).toBeNull();
      expect(mediaShown(clip, clip.start + clip.duration, p)).toBeNull();
    }
    // Forwards it is the frame nearest to where the media is reached, kept on the clip.
    expect(frameShowing(forwards, 4.2, p)).toBe(forwards.start + Math.round(frameOfMedia(forwards, 4.2, p)));
    expect(frameShowing(forwards, 0, p)).toBe(forwards.start);
    expect(frameShowing(forwards, 99, p)).toBe(forwards.start + forwards.duration - 1);
    expect(frameShowing(backwards, 99, p)).toBe(backwards.start);
  });

  it('draws each ready-made shape to one scale, inside its box', () => {
    const size = { width: 20, height: 12 };
    const lows: Record<string, number> = {};
    for (const shape of Object.keys(RAMP_SHAPES) as RampShape[]) {
      const path = shapePath(shape, size)
        .slice(1)
        .split('L')
        .map((pair) => pair.split(' ').map(Number));
      expect(path[0][0]).toBe(1.5);
      expect(path[path.length - 1][0]).toBe(18.5);
      for (const [x, y] of path) {
        expect(x).toBeGreaterThanOrEqual(1.5);
        expect(x).toBeLessThanOrEqual(18.5);
        expect(y).toBeGreaterThanOrEqual(1.5);
        expect(y).toBeLessThanOrEqual(10.5);
      }
      lows[shape] = Math.max(...path.map(([, y]) => y));
    }
    // Bullet goes slowest of all and reaches the bottom; Ramp up starts at half speed, above it.
    expect(lows.bullet).toBe(10.5);
    expect(lows.rampUp).toBeLessThan(lows.bullet);
    expect(lows.flashIn).toBeLessThan(lows.rampUp);
  });
});
