/**
 * Speed that keeps its pitch.
 *
 * Sound read faster or slower between its samples (see `resample.ts`) changes its pitch with its
 * speed. Here the sound is instead cut into short grains, twenty milliseconds under a Hann window,
 * that are played unchanged, one every ten milliseconds of the stream, each taken from the place
 * in the file that the time map gives for its moment. Played faster, grains are taken further
 * apart than they are long and parts of the file are left out; played slower, they overlap in the
 * file and parts are heard twice. Two grains that do not meet in step cancel or double where they
 * overlap, so each grain may lie a few milliseconds off its place, where it best continues the
 * grain before it (WSOLA: waveform-similarity overlap-add).
 *
 * Left to itself that chain of choices runs from wherever it began, and the same stretch of a file
 * would come out differently after a seek, in the next chunk of an export or in the right half of
 * a split. So the stream is made in blocks of two hundred grains, and the first grain of every
 * block, its anchor, lies exactly on the map. The chain starts anew at each anchor, and what it
 * is off by when it arrives at the next one is taken out again along the block, most of it where
 * that is heard least. A sample of the stream therefore depends on its own index, on the map and
 * on the source of its own block, and on nothing else: not on where reading began, on how the
 * source arrived, or on what was made before it.
 */
import type { Resampled } from './resample';

/** Grains from one anchor to the next: two seconds of stream. */
const GRAINS = 200;
/**
 * How much of a perfect match a grain gives up for lying on its place instead of at the end of
 * the range searched: among places that continue the sound alike, the nearest is taken. The grain
 * before an anchor is drawn harder, since whatever it is off by has to be taken out again.
 */
const PULL = 0.05;
const PULL_ANCHOR = 0.3;
/** Samples to a page of source kept. */
const PAGE = 256;
/** Places in a file beyond this many samples are not told apart: no file is that long. */
const FAR = 2 ** 50;

/** The measures of the grains at a sample rate, in samples. */
export interface GrainMeasures {
  /** From one grain's centre to the next, in the stream; a grain is two of these long. */
  hop: number;
  /** How far from its place on the map a grain is looked for, each way. */
  search: number;
  /** Stream samples from one anchor to the next. */
  block: number;
  /** Source samples a grain can need before the place the map gives it, and from that place on. */
  back: number;
  ahead: number;
}

export function grainMeasures(rate: number): GrainMeasures {
  const hop = Math.max(1, Math.round(rate / 100));
  const search = Math.max(1, Math.round(0.0075 * rate));
  // Before its place: the grain itself, moved by the search and again by what is taken out towards
  // the anchor. After it: the stretch that follows the grain in the file, which the next grain is
  // compared with.
  return { hop, search, block: GRAINS * hop, back: hop + 2 * search, ahead: 2 * hop + search };
}

/** The source sample that the map gives stream sample `n`. */
function placeOf(rate: number, media: (tau: number) => number, n: number): number {
  const at = rate * media(n / rate);
  if (at > -FAR && at < FAR) return Math.round(at);
  return at >= FAR ? FAR : at <= -FAR ? -FAR : 0;
}

/**
 * The source samples `[lo, hi)` that stream samples `[n0, n1)` are made from: all that the blocks
 * they lie in can read.
 */
export function stretchSpan(
  rate: number,
  media: (tau: number) => number,
  n0: number,
  n1: number,
): [lo: number, hi: number] {
  const { block, back, ahead } = grainMeasures(rate);
  const first = Math.floor(n0 / block) * block;
  const last = (Math.floor((n1 - 1) / block) + 1) * block;
  return [placeOf(rate, media, first) - back, placeOf(rate, media, last) + ahead];
}

/**
 * Source samples by their index in the file, for as long as they are needed. Only what is written
 * is held, in pages; everything else reads as silence, which is what lies before a file, after
 * it, and in its gaps.
 */
export class Kept {
  private readonly pages = new Map<number, Float32Array[]>();
  private readonly spare: Float32Array[][] = [];

  constructor(readonly channels: number) {}

  /** Bytes of sound held. */
  get bytes(): number {
    return this.pages.size * this.channels * PAGE * Float32Array.BYTES_PER_ELEMENT;
  }

  /** Keep samples `[from, to)` of `data`, whose first sample is source sample `index`. */
  write(index: number, data: readonly Float32Array[], from: number, to: number): void {
    for (let i = from; i < to;) {
      const number = Math.floor((index + i) / PAGE);
      const offset = index + i - number * PAGE;
      const count = Math.min(to - i, PAGE - offset);
      let page = this.pages.get(number);
      if (!page) {
        page = this.spare.pop() ?? Array.from({ length: this.channels }, () => new Float32Array(PAGE));
        this.pages.set(number, page);
      }
      for (let c = 0; c < this.channels; c++) page[c].set(data[c].subarray(i, i + count), offset);
      i += count;
    }
  }

  /** `count` samples of channel `c` from source sample `at` on, into `out`. */
  read(c: number, at: number, count: number, out: Float32Array): void {
    for (let i = 0; i < count;) {
      const number = Math.floor((at + i) / PAGE);
      const offset = at + i - number * PAGE;
      const n = Math.min(count - i, PAGE - offset);
      const page = this.pages.get(number);
      if (page) out.set(page[c].subarray(offset, offset + n), i);
      else out.fill(0, i, i + n);
      i += n;
    }
  }

  /** Let go of what lies before source sample `below`. Pages are written in ascending order. */
  drop(below: number): void {
    for (const [number, page] of this.pages) {
      if ((number + 1) * PAGE > below) break;
      this.pages.delete(number);
      for (const samples of page) samples.fill(0);
      this.spare.push(page);
    }
  }
}

/**
 * One stretch of a file's sound on the stream's clock, at its own pitch. Stream sample `n` is
 * heard at `n / rate` seconds of the stream, where the file is at `media(n / rate)` seconds.
 * Source samples go in by their index in the file, in ascending order; the stream comes out a
 * block at a time, as soon as the source the block reads has arrived.
 */
export class Stretcher {
  private readonly hop: number;
  private readonly search: number;
  private readonly back: number;
  private readonly ahead: number;
  /** The coarse search compares sums of this many samples: sound up to 6 kHz places a grain. */
  private readonly dec: number;
  private readonly window: Float64Array;
  private readonly kept: Kept;
  /** Source samples before this one are settled: given, or never to come and silent. */
  private known = -Infinity;
  private over = false;

  /** The block being chained, the last one wanted, and how many of its grains have a place. */
  private block: number;
  private readonly lastBlock: number;
  private placed = 0;
  /** Of the block's grains: offset from the map as chained, likeness to the grain before, energy. */
  private readonly chained = new Int32Array(GRAINS + 1);
  private readonly likeness = new Float64Array(GRAINS + 1);
  private readonly energy = new Float64Array(GRAINS + 1);
  private readonly ease = new Float64Array(GRAINS + 1);
  private readonly offset = new Int32Array(GRAINS + 1);

  /** Where the map puts the grains from `firstGrain` on, worked out as they are first asked for. */
  private readonly centres: number[] = [];
  private firstGrain: number;
  /** The first grain that may still need source samples that have not been given. */
  private wanting: number;
  private readonly lastGrain: number;

  private readonly before: Float64Array;
  private readonly around: Float64Array;
  private readonly beforeCoarse: Float64Array;
  private readonly aroundCoarse: Float64Array;
  private readonly level: Float64Array;
  private readonly one: Float32Array;
  private readonly other: Float32Array;

  /** `first` and `last` bound the stream samples wanted (`last` exclusive). */
  constructor(
    readonly channels: number,
    readonly rate: number,
    private readonly media: (tau: number) => number,
    private readonly first: number,
    private readonly last: number,
  ) {
    const { hop, search, block, back, ahead } = grainMeasures(rate);
    this.hop = hop;
    this.search = search;
    this.back = back;
    this.ahead = ahead;
    this.dec = Math.max(1, Math.round(rate / 12000));
    this.window = Float64Array.from(
      { length: 2 * hop },
      (_, i) => 0.5 * (1 + Math.cos((Math.PI * (i - hop)) / hop)),
    );
    this.kept = new Kept(channels);
    this.block = Math.floor(first / block);
    this.lastBlock = Math.floor((last - 1) / block);
    this.firstGrain = this.wanting = this.block * GRAINS;
    this.lastGrain = (this.lastBlock + 1) * GRAINS;
    const coarse = Math.floor((2 * hop) / this.dec);
    this.before = new Float64Array(2 * hop);
    this.around = new Float64Array(2 * search + 2 * hop);
    this.beforeCoarse = new Float64Array(coarse);
    this.aroundCoarse = new Float64Array(Math.floor((2 * search) / this.dec) + 2 + coarse);
    this.level = new Float64Array(hop);
    this.one = new Float32Array(2 * hop + 2 * search);
    this.other = new Float32Array(hop);
  }

  /** Bytes of source held. */
  get held(): number {
    return this.kept.bytes;
  }

  /** The source samples `[lo, hi)` that stream samples `[n0, n1)` are made from. */
  span(n0: number, n1: number): [lo: number, hi: number] {
    return stretchSpan(this.rate, this.media, n0, n1);
  }

  /** The source sample on which the map puts grain `k`. */
  private centre(k: number): number {
    for (let next = this.firstGrain + this.centres.length; next <= k; next++)
      this.centres.push(placeOf(this.rate, this.media, next * this.hop));
    return this.centres[k - this.firstGrain];
  }

  /**
   * Source samples from `index` on, one array per channel. What lies between the end of the
   * samples given before and `index` is a gap in the file. Samples given twice count the first
   * time.
   */
  push(index: number, data: readonly Float32Array[]): void {
    if (this.over) return;
    const end = index + data[0].length;
    for (let at = Math.max(index, this.known); at < end;) {
      while (this.wanting <= this.lastGrain && this.centre(this.wanting) + this.ahead <= at) this.wanting++;
      if (this.wanting > this.lastGrain) break;
      // Only what a grain can read is kept: played fast, that is less than the file has.
      const from = Math.max(at, this.centre(this.wanting) - this.back);
      if (from >= end) break;
      at = Math.min(end, this.centre(this.wanting) + this.ahead);
      this.kept.write(index, data, from - index, at - index);
    }
    this.known = Math.max(this.known, end);
  }

  /** The source has ended: what the stream reads beyond it is silence. */
  finish(): void {
    this.over = true;
  }

  /**
   * The next block of the stream, or the part of it that is wanted, once all the source it reads
   * is settled; null until then, and when everything wanted has been given.
   */
  take(): Resampled | null {
    if (this.block > this.lastBlock) return null;
    const k0 = this.block * GRAINS;
    while (this.placed < GRAINS) {
      const i = this.placed + 1;
      if (!this.over && this.centre(k0 + i) + this.ahead > this.known) return null;
      this.place(k0, i);
      this.placed = i;
    }
    const out = this.render(k0);
    this.block++;
    this.placed = 0;
    this.centres.splice(0, GRAINS);
    this.firstGrain += GRAINS;
    this.wanting = Math.max(this.wanting, this.firstGrain);
    this.kept.drop(this.block > this.lastBlock ? Infinity : this.centre(this.firstGrain) - this.back);
    return out;
  }

  /** The mean of the channels over `count` source samples from `at` on: what grains are placed by. */
  private mono(at: number, count: number, out: Float64Array): void {
    const samples = this.one;
    this.kept.read(0, at, count, samples);
    for (let n = 0; n < count; n++) out[n] = samples[n];
    for (let c = 1; c < this.channels; c++) {
      this.kept.read(c, at, count, samples);
      for (let n = 0; n < count; n++) out[n] += samples[n];
    }
    if (this.channels > 1) for (let n = 0; n < count; n++) out[n] /= this.channels;
  }

  /**
   * Give grain `i` of the block that begins with grain `k0` its place in the chain: where the
   * source goes on from the grain before it, if that lies within the search range of where the
   * map wants it, and otherwise the place in that range at which the source is most like that
   * continuation.
   */
  private place(k0: number, i: number): void {
    const { hop, search, dec, chained, before, around } = this;
    const length = 2 * hop;
    const centre = this.centre(k0 + i);
    // The grain before as chained, and from its centre on the grain that would follow it in the
    // file: what this grain is compared with.
    const from = this.centre(k0 + i - 1) + chained[i - 1];
    this.mono(from, length, before);
    let energy = 0;
    for (let n = 0; n < length; n++) energy += before[n] * before[n];
    this.energy[i] = energy;
    const natural = from + hop - centre;
    // The grain before an anchor is always searched for: the nearer to the map it ends up, the
    // less has to be taken out again.
    if (i < GRAINS && Math.abs(natural) <= search) {
      chained[i] = natural;
      this.likeness[i] = 1;
      return;
    }
    // `around[n]` is source sample `lowest + n`; a grain at offset `d` begins at `d + search`.
    const lowest = centre - search - hop;
    this.mono(lowest, 2 * search + length, around);
    let low = -search;
    let high = search;
    let pull = PULL_ANCHOR;
    let best = 0;
    if (i < GRAINS) {
      // First on sums of `dec` samples, at every place that begins on a multiple of `dec` in the
      // file, so that the places compared do not depend on where the grain before happens to lie.
      const { beforeCoarse, aroundCoarse } = this;
      const count = Math.floor(length / dec);
      let coarseEnergy = 0;
      for (let m = 0; m < count; m++) {
        let sum = 0;
        for (let s = 0; s < dec; s++) sum += before[m * dec + s];
        beforeCoarse[m] = sum;
        coarseEnergy += sum * sum;
      }
      const j0 = Math.ceil(lowest / dec);
      const j1 = Math.floor((centre + search - hop) / dec);
      for (let m = 0; m < j1 - j0 + count; m++) {
        let sum = 0;
        for (let s = 0; s < dec; s++) sum += around[(j0 + m) * dec - lowest + s];
        aroundCoarse[m] = sum;
      }
      let top = -Infinity;
      for (let j = j0; j <= j1; j++) {
        let dot = 0;
        let own = 0;
        for (let m = 0; m < count; m++) {
          const v = aroundCoarse[j - j0 + m];
          dot += beforeCoarse[m] * v;
          own += v * v;
        }
        const d = j * dec + hop - centre;
        const score = dot / Math.sqrt(coarseEnergy * own + 1e-12) - PULL * (d / search) ** 2;
        if (score > top) {
          top = score;
          best = d;
        }
      }
      // Then every place around the best of those, on the samples themselves.
      low = Math.max(-search, best - dec);
      high = Math.min(search, best + dec);
      pull = PULL;
    }
    let top = -Infinity;
    let alike = 0;
    for (let d = low; d <= high; d++) {
      let dot = 0;
      let own = 0;
      for (let n = 0; n < length; n++) {
        const v = around[d + search + n];
        dot += before[n] * v;
        own += v * v;
      }
      const match = dot / Math.sqrt(energy * own + 1e-12);
      const score = match - pull * (d / search) ** 2;
      if (score > top) {
        top = score;
        best = d;
        alike = match;
      }
    }
    chained[i] = best;
    this.likeness[i] = alike;
  }

  /** The stream samples of the block whose grains have all been chained. */
  private render(k0: number): Resampled {
    const { hop, chained, likeness, energy, ease, offset, window, level, one, other } = this;
    // The chain arrives at the next anchor off by `rest`, and the anchor lies on the map. Each
    // grain gives up a share of that, and the shares are largest where the grains are quiet or
    // unlike each other anyway: there a slip of a few samples between two grains is not heard.
    const rest = chained[GRAINS];
    let mean = 0;
    for (let i = 1; i <= GRAINS; i++) mean += energy[i] / GRAINS;
    let total = 0;
    for (let i = 1; i <= GRAINS; i++) {
      const tonal = energy[i] * Math.max(0, likeness[i]) ** 2;
      total += ease[i] = 1 / (tonal + 1e-3 * mean + 1e-12);
    }
    let sum = 0;
    offset[0] = 0;
    for (let i = 1; i < GRAINS; i++) {
      sum += ease[i];
      offset[i] = chained[i] - Math.round((rest * sum) / total);
    }
    offset[GRAINS] = 0;

    const begin = Math.max(this.first, k0 * hop);
    const end = Math.min(this.last, (k0 + GRAINS) * hop);
    const data = Array.from({ length: this.channels }, () => new Float32Array(end - begin));
    for (let h = Math.floor(begin / hop) - k0; h < GRAINS && (k0 + h) * hop < end; h++) {
      // Between the centres of two grains the stream is the one fading out and the next fading in.
      const n0 = (k0 + h) * hop;
      const i0 = Math.max(0, begin - n0);
      const i1 = Math.min(hop, end - n0);
      const leaving = this.centre(k0 + h) + offset[h];
      const coming = this.centre(k0 + h + 1) + offset[h + 1] - hop;
      // Two grains that follow one another in the file add up to the file. Two that are unlike
      // each other add up in power, not in level, and half-way between their centres, where each
      // is at half, that is 3 dB less than either: noise would flutter at the rate of the grains.
      // So their sum is brought to the level that two sounds as alike as these two give.
      const alike = coming === leaving ? 1 : Math.min(1, Math.max(0, likeness[h + 1]));
      if (alike < 1)
        for (let i = i0; i < i1; i++) {
          const falling = window[hop + i];
          const rising = window[i];
          level[i] = Math.sqrt(falling * falling + rising * rising + 2 * alike * falling * rising);
        }
      for (let c = 0; c < this.channels; c++) {
        this.kept.read(c, leaving + i0, i1 - i0, one);
        this.kept.read(c, coming + i0, i1 - i0, other);
        const out = data[c];
        if (alike < 1)
          for (let i = i0; i < i1; i++)
            out[n0 + i - begin] = (window[hop + i] * one[i - i0] + window[i] * other[i - i0]) / level[i];
        else
          for (let i = i0; i < i1; i++)
            out[n0 + i - begin] = window[hop + i] * one[i - i0] + window[i] * other[i - i0];
      }
    }
    return { first: begin, data };
  }
}
