import { describe, expect, it } from 'vitest';
import {
  emptyProject,
  frameOfMedia,
  makeClip,
  mediaAt,
  sourceSpan,
  sourceTimeAt,
  type Clip,
  type Project,
  type RampPoint,
} from '@tandem/core';
import { columnPeak, columnRange, loadedEdge, tileStep, tileTime } from '../src/features/timeline/laneTimes';
import { FilmstripCache, PEAKS_PER_SECOND } from '../src/features/timeline/mediaCache';

const NTSC = { fpsNum: 30000, fpsDen: 1001 };

const clipOf = (init: Partial<Clip>): Clip => makeClip('audio', 'a1', { assetId: 'file', ...init });

/** A generator of numbers from 0 up to 1, the same ones every run. */
function random(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

/**
 * The lane canvas as it drew before there were ramps: what its filmstrip and its waveform worked
 * out for a clip, written out as it stood there, the seconds a frame takes included.
 */
const before = {
  per: (clip: Clip, p: Project): number =>
    clip.freeze ? 0 : (clip.speed * p.settings.fpsDen) / p.settings.fpsNum,
  /** The time and the thumbnail step of tile `i`, for tiles `tw` pixels wide. */
  tile(clip: Clip, p: Project, i: number, tw: number, ppf: number): { t: number; step: number } {
    const per = before.per(clip, p);
    const step = FilmstripCache.stepFor(((tw / ppf) * per) / 1);
    const local = (i * tw) / ppf;
    const t = clip.reverse ? clip.sourceIn + (clip.duration - local) * per : clip.sourceIn + local * per;
    return { t, step };
  },
  /** The media under the pixel column at `x` of a clip drawn from `x0`, and the loudest peak in it. */
  column(
    clip: Clip,
    p: Project,
    x: number,
    x0: number,
    ppf: number,
    peaks: Float32Array,
  ): { t: number; end: number; peak: number } {
    const per = before.per(clip, p);
    const secPerPx = per / ppf;
    const srcEnd = clip.sourceIn + clip.duration * per;
    const pps = PEAKS_PER_SECOND;
    const local = (x - x0) * secPerPx;
    const t = clip.reverse ? srcEnd - local - secPerPx : clip.sourceIn + local;
    const a = Math.max(0, Math.floor(t * pps));
    const b = Math.min(peaks.length - 1, Math.max(a, Math.floor((t + secPerPx) * pps)));
    let peak = 0;
    for (let i = a; i <= b; i++) if (peaks[i] > peak) peak = peaks[i];
    return { t, end: t + secPerPx, peak };
  },
  /** The pixel from which the part of the file that is not analysed yet is hatched. */
  loadedX(clip: Clip, p: Project, loaded: number, x0: number, ppf: number): number {
    const per = before.per(clip, p);
    return x0 + ((loaded - clip.sourceIn) / per) * ppf;
  },
};

describe('a clip at one speed on the lane canvas', () => {
  const rnd = random(11);
  const peaks = Float32Array.from({ length: 1500 }, () => rnd());
  const wave = { peaks, perSecond: PEAKS_PER_SECOND };
  const projects = [emptyProject(), emptyProject(NTSC)];
  const kinds: Partial<Clip>[] = [];
  for (const speed of [0.5, 1, 2.5]) {
    kinds.push({ speed }, { speed, reverse: true }, { speed, freeze: true });
  }
  /** Clips of every kind, some from before the start of their file. */
  const clips = (): Clip[] =>
    kinds.flatMap((kind) =>
      Array.from({ length: 12 }, () =>
        clipOf({
          ...kind,
          start: Math.floor(rnd() * 500),
          duration: 1 + Math.floor(rnd() * 400),
          sourceIn: rnd() < 0.15 ? -rnd() * 2 : rnd() * 9,
        }),
      ),
    );

  it('shows on each filmstrip tile the time, at the thumbnail step, that it showed before', () => {
    let checked = 0;
    for (const p of projects) {
      for (const clip of clips()) {
        const ppf = [0.37, 2, 8.25][checked % 3];
        const tw = 20 + rnd() * 120;
        for (let i = 0; i * tw <= clip.duration * ppf; i++) {
          const was = before.tile(clip, p, i, tw, ppf);
          const local = (i * tw) / ppf;
          expect(Object.is(tileTime(clip, p, local), was.t)).toBe(true);
          expect(tileStep(clip, p, local, tw / ppf)).toBe(was.step);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('draws under each waveform column the media, and the peak, that it drew before', () => {
    let checked = 0;
    for (const p of projects) {
      for (const clip of clips()) {
        const ppf = [0.37, 2, 8.25][checked % 3];
        const x0 = clip.start * ppf - rnd() * 300;
        const from = Math.floor(Math.max(0, x0));
        const to = Math.ceil(x0 + clip.duration * ppf);
        for (let x = from; x <= to; x += 1 + Math.floor(rnd() * 3)) {
          const was = before.column(clip, p, x, x0, ppf, peaks);
          const [t, end] = columnRange(clip, p, x - x0, ppf);
          expect(Object.is(t, was.t)).toBe(true);
          expect(Object.is(end, was.end)).toBe(true);
          expect(Object.is(columnPeak(clip, p, x - x0, ppf, wave), was.peak)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('hatches what is still being analysed from the pixel it hatched from before', () => {
    for (const p of projects) {
      for (const clip of clips()) {
        const [ppf, x0, loaded] = [0.5 + rnd() * 8, rnd() * 400 - 200, rnd() * 12];
        const edge = loadedEdge(clip, p, loaded);
        // Forwards, also for a clip that plays backwards: so it was.
        expect(edge.pending).toBe('after');
        expect(Object.is(x0 + edge.frame * ppf, before.loadedX(clip, p, loaded, x0, ppf))).toBe(true);
      }
    }
  });
});

describe('a clip on a speed ramp on the lane canvas', () => {
  // Slow, then fast, then very slow, then fast again, over seconds 1 to 9 of the file.
  const ramp: RampPoint[] = [
    { m: 1, v: 0.5 },
    { m: 4, v: 5 },
    { m: 7, v: 0.25 },
    { m: 9, v: 2 },
  ];
  const cases = [emptyProject(), emptyProject(NTSC)].flatMap((p) =>
    [false, true].map((reverse) => ({
      p,
      clip: clipOf({ ramp, reverse, sourceIn: 1.5, start: 40, duration: 233 }),
    })),
  );
  const D = 233;
  const PPF = 4;

  it('shows on a tile what the renderer shows at its frame', () => {
    for (const { clip, p } of cases) {
      for (let f = 0; f <= D; f++) expect(tileTime(clip, p, f)).toBe(sourceTimeAt(clip, f, p));
      for (const local of [0.25, 17.5, 101.875, 232.4]) {
        const around = [sourceTimeAt(clip, Math.floor(local), p), sourceTimeAt(clip, Math.ceil(local), p)];
        expect(tileTime(clip, p, local)).toBeGreaterThan(Math.min(...around));
        expect(tileTime(clip, p, local)).toBeLessThan(Math.max(...around));
      }
    }
  });

  it('asks a slow stretch for nearer thumbnails than a fast one, and never for nearer ones than the cache keeps', () => {
    const finest = FilmstripCache.stepFor(0);
    for (const { clip, p } of cases) {
      const frames = 6;
      const steps = Array.from({ length: Math.ceil(D / frames) }, (_, i) =>
        tileStep(clip, p, i * frames, frames),
      );
      for (const [i, step] of steps.entries()) {
        const covered = Math.abs(tileTime(clip, p, (i + 1) * frames) - tileTime(clip, p, i * frames));
        expect(step).toBe(FilmstripCache.stepFor(covered));
        expect(step).toBeGreaterThanOrEqual(finest);
      }
      // The tile that holds second 7 of the file, at a quarter of the speed, and the one at second 4.
      const tileOf = (m: number): number => {
        const u = frameOfMedia(clip, m, p);
        return Math.floor((clip.reverse ? D - 1 - u : u) / frames);
      };
      expect(steps[tileOf(7)]).toBe(finest);
      expect(steps[tileOf(4)]).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives each column the media the sound runs through under it, with nothing left out between two', () => {
    for (const { clip, p } of cases) {
      // At a zoom that divides the frame evenly, and at one that does not.
      for (const ppf of [PPF, 3.3]) {
        const columns = Array.from({ length: Math.ceil(D * ppf) }, (_, px) => columnRange(clip, p, px, ppf));
        for (const [px, [from, to]] of columns.entries()) {
          expect(to).toBeGreaterThan(from);
          if (px + 1 === columns.length) continue;
          // Where one column ends the next begins, to the last bit.
          const next = columns[px + 1];
          if (clip.reverse) expect(next[1]).toBe(from);
          else expect(next[0]).toBe(to);
        }
        // Together they are the stretch the clip plays; the last one ends with the clip, or runs
        // past its end where the clip is no whole number of pixels long.
        const span = sourceSpan(clip, p);
        const [first, last] = [columns[0], columns[columns.length - 1]];
        const [low, high] = clip.reverse ? [last[0], first[1]] : [first[0], last[1]];
        if (clip.reverse) expect(high).toBe(span.out);
        else expect(low).toBeCloseTo(span.in, 12);
        const end = clip.reverse ? low - span.in : high - span.out;
        if (ppf === PPF) expect(end).toBeCloseTo(0, 12);
        else expect(end * (clip.reverse ? -1 : 1)).toBeGreaterThan(0);
      }
      // The canvas counts a column from where the clip begins on it, which is no whole pixel.
      for (let x = 0; x < 300; x++) {
        const [here, next] = [columnRange(clip, p, x - 0.37, 3.3), columnRange(clip, p, x + 1 - 0.37, 3.3)];
        expect(clip.reverse ? next[1] - here[0] : next[0] - here[1]).toBeCloseTo(0, 12);
      }
    }
  });

  it('draws a click in the column under which the mixer plays it', () => {
    for (const { clip, p } of cases) {
      const span = sourceSpan(clip, p);
      for (let m = span.in + 0.013; m < span.out; m += 0.171) {
        const u = frameOfMedia(clip, m, p);
        const px = Math.floor((clip.reverse ? D - u : u) * PPF);
        const [from, to] = columnRange(clip, p, px, PPF);
        expect(from).toBeLessThanOrEqual(m + 1e-9);
        expect(to).toBeGreaterThanOrEqual(m - 1e-9);
        // The one peak of a file that is silent but for the click.
        const peaks = new Float32Array(2000);
        peaks[Math.floor(m * PEAKS_PER_SECOND)] = 0.8;
        const wave = { peaks, perSecond: PEAKS_PER_SECOND };
        expect(columnPeak(clip, p, px, PPF, wave)).toBeCloseTo(0.8);
        // A column is lit while its media touches the hundredth of a second the peak stands for.
        const lit = (x: number): boolean => columnPeak(clip, p, x, PPF, wave) > 0;
        const bin = [Math.floor(m * 100) / 100, (Math.floor(m * 100) + 1) / 100];
        for (let x = Math.max(0, px - 40); x < Math.min(D * PPF, px + 40); x++) {
          const [a, b] = columnRange(clip, p, x, PPF);
          if (b < bin[0] - 1e-9 || a > bin[1] + 1e-9) expect(lit(x)).toBe(false);
          if (a > bin[0] && b < bin[1]) expect(lit(x)).toBe(true);
        }
      }
    }
  });

  it('draws nothing where the clip has no file under it: before the file begins and after it ends', () => {
    const loud = { peaks: new Float32Array(602).fill(1), perSecond: PEAKS_PER_SECOND };
    // The file is six seconds long; the last two peaks are the room a waveform keeps past its end.
    loud.peaks.fill(0, 600);
    for (const p of [emptyProject(), emptyProject(NTSC)]) {
      for (const reverse of [false, true]) {
        const early = clipOf({ ramp, reverse, sourceIn: -1, start: 0, duration: 120 });
        const late = clipOf({ ramp, reverse, sourceIn: 5, start: 0, duration: 120 });
        let [silent, sounding] = [0, 0];
        for (let px = 0; px < 120 * PPF; px++) {
          for (const clip of [early, late]) {
            const [from, to] = columnRange(clip, p, px, PPF);
            const peak = columnPeak(clip, p, px, PPF, loud);
            if (to <= 0 || from >= 6.02) {
              expect(peak).toBe(0);
              silent++;
            } else if (from >= 0 && to < 6) {
              expect(peak).toBe(1);
              sounding++;
            }
          }
        }
        expect(silent).toBeGreaterThan(50);
        expect(sounding).toBeGreaterThan(50);
      }
    }
    // A clip at one speed goes on drawing the first peak before its file, as it always has.
    const plain = clipOf({ sourceIn: -1, start: 0, duration: 120 });
    expect(columnPeak(plain, emptyProject(), 0, PPF, loud)).toBe(1);
  });

  it('hatches the sound that is not analysed yet: what follows forwards, what comes first backwards', () => {
    for (const { clip, p } of cases) {
      const loaded = 6.2;
      const edge = loadedEdge(clip, p, loaded);
      const at = frameOfMedia(clip, loaded, p);
      expect(edge).toEqual(
        clip.reverse ? { frame: D - at, pending: 'before' } : { frame: at, pending: 'after' },
      );
      expect(edge.frame).toBeGreaterThan(0);
      expect(edge.frame).toBeLessThan(D);
      for (let px = 0; px < D * PPF; px++) {
        const [from, to] = columnRange(clip, p, px, PPF);
        const hatched = edge.pending === 'after' ? px / PPF >= edge.frame : (px + 1) / PPF <= edge.frame;
        const clear = edge.pending === 'after' ? (px + 1) / PPF <= edge.frame : px / PPF >= edge.frame;
        if (hatched) expect(from).toBeGreaterThanOrEqual(loaded - 1e-9);
        if (clear) expect(to).toBeLessThanOrEqual(loaded + 1e-9);
      }
    }
  });

  it('holds its one frame when it is a freeze, whatever ramp is left in the data', () => {
    const p = emptyProject();
    const still = makeClip('video', 'v1', { assetId: 'file', ramp, freeze: true, sourceIn: 3, duration: 50 });
    expect(tileTime(still, p, 12.5)).toBe(3);
    expect(columnRange(still, p, 7, PPF)).toEqual([3, 3]);
    expect(mediaAt(still, 20, p)).toBe(3);
  });
});
