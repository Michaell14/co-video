/**
 * A file's sound on the clock of a clip whose speed changes along the way, or that plays at
 * another speed and keeps its pitch.
 *
 * Such a clip is mixed as a clip at normal speed over a retimed copy of its file's sound: the
 * stream. Second `tau` of the stream is second `map.media(tau)` of the file. Where pitch follows
 * speed the stream is the file read between its samples, band-limited, each sample of the stream
 * at its own place on the map. Where pitch is kept it is cut into grains that play unchanged (see
 * `stretch.ts`). The stream has the sample rate of the file's decoded sound, and its sample `n`
 * lies at `n / rate` seconds counted from second 0 of the stream, whatever is asked for.
 *
 * A sample of the stream depends on its own index, on the map and on the file's samples around
 * its place, and on nothing else. Read from any point, with the file decoded in buffers of any
 * size, it is the same sample: the chunks of an export, the sound after a seek and the two halves
 * of a split clip meet without a seam because they are pieces of one stream.
 */
import type { WrappedAudioBuffer } from 'mediabunny';
import { kernelNear, reachNear, type Resampled } from './resample';
import type { Sound, SoundTrouble } from './sound';
import { Kept, Stretcher, grainMeasures, stretchSpan } from './stretch';

/** A clip's time map as the sound needs it; core's `TimeMap` has this shape. */
export interface TimeMap {
  /** The second of the file that plays at second `tau` of the stream. */
  media(tau: number): number;
  /** The second of the stream at which second `m` of the file plays. */
  stream(m: number): number;
  /** Seconds of the file per second of the stream at `tau`. */
  speed(tau: number): number;
}

/** What the mixer reads of a file's sound: `Sound`, or a stream made from one. */
export type Sounding = Pick<Sound, 'buffers' | 'rate'>;

/** Stream samples to a buffer handed on. */
const BLOCK = 4096;
/** The furthest any kernel of the reader's reaches, in source samples. */
const REACH = reachNear(Infinity);
/** Source samples the reader looks at in one piece; more than any kernel spans. */
const VIEW = 8192;
/** Stream samples the reader makes at a time, so that no single step of the work is long. */
const MOST = 4096;
/** Places in a file beyond this many samples are not told apart: no file is that long. */
const FAR = 2 ** 50;
/**
 * Source samples asked of the decoder beyond the ones read, each way. A buffer's own time is
 * rounded to a sample, and a buffer placed behind another can lie one more sample off its time.
 */
const SPARE = 2;
/** The lowest sample rate a read that does not know the file's allows for. */
const LOWEST_RATE = 8000;
/** In samples: far more than the rounding noise of a time computed in seconds, far less than a sample. */
const HALF_SAMPLE_BIAS = 1e-4;

/**
 * The source sample on which a buffer that begins at `at` samples lies. A decode that began
 * between two samples gives times exactly half-way between them, a hair to either side. Those all
 * have to fall the same way, or the same file would lie a sample further on after a seek: rounding
 * noise must not decide. So half-way rounds down, with room to spare.
 */
const sampleAt = (at: number): number => Math.floor(at + 0.5 - HALF_SAMPLE_BIAS);

/**
 * The source samples `[lo, hi)` from which the stream samples `[n0, n1)` are read along the map
 * with pitch following speed: their places, and as far to each side as a kernel reaches.
 */
export function readSpan(
  rate: number,
  media: (tau: number) => number,
  n0: number,
  n1: number,
): [lo: number, hi: number] {
  const place = (n: number) => Math.floor(Math.max(-FAR, Math.min(FAR, rate * media(n / rate))));
  return [place(n0) - REACH + 1, place(n1 - 1) + REACH + 1];
}

/**
 * The file read along a time map, pitch following speed: stream sample `n` is the source at
 * `rate * map.media(n / rate)` of its samples, worked out from `n` alone, through the kernel that
 * suits the speed there. Source samples go in by their index in the file, in ascending order.
 */
export class Reader {
  private readonly kept: Kept;
  /** Source samples before this one are settled: given, or never to come and silent. */
  private known = -Infinity;
  private over = false;
  private next: number;
  /** The source samples that can still be read: before `low` and from `high` on none are. */
  private low: number;
  private readonly high: number;
  /** Source samples `[viewFrom, viewTo)` in one piece, for the loop that sums over them. */
  private readonly view: Float32Array[];
  private viewFrom = 0;
  private viewTo = 0;

  /** `first` and `last` bound the stream samples wanted (`last` exclusive). */
  constructor(
    readonly channels: number,
    readonly rate: number,
    private readonly map: Pick<TimeMap, 'media' | 'speed'>,
    first: number,
    private readonly last: number,
  ) {
    this.kept = new Kept(channels);
    this.next = first;
    [this.low, this.high] = this.span(first, Math.max(last, first + 1));
    this.view = Array.from({ length: channels }, () => new Float32Array(VIEW));
  }

  /** The source samples `[lo, hi)` that stream samples `[n0, n1)` are made from. */
  span(n0: number, n1: number): [lo: number, hi: number] {
    return readSpan(this.rate, this.map.media, n0, n1);
  }

  /**
   * Source samples from `index` on, one array per channel. What lies between the end of the
   * samples given before and `index` is a gap in the file. Samples given twice count the first
   * time.
   */
  push(index: number, data: readonly Float32Array[]): void {
    if (this.over) return;
    const end = index + data[0].length;
    const from = Math.max(index, this.known, this.low);
    const to = Math.min(end, this.high);
    if (from < to) this.kept.write(index, data, from - index, to - index);
    this.known = Math.max(this.known, end);
  }

  /** The source has ended: what the stream reads beyond it is silence. */
  finish(): void {
    this.over = true;
  }

  /**
   * The stream samples that follow the ones taken before, as far as the source they read is
   * settled and no more than a few thousand at a time; null when there are none.
   */
  take(): Resampled | null {
    const { rate, map, view } = this;
    const first = this.next;
    const until = Math.min(this.last, first + MOST);
    let data: Float32Array<ArrayBuffer>[] | null = null;
    let n = first;
    for (; n < until; n++) {
      const tau = n / rate;
      const u = rate * map.media(tau);
      const { half, taps, phases, coef, delta } = kernelNear(map.speed(tau));
      const whole = Math.floor(u);
      if (!this.over && whole + half >= this.known) break;
      data ??= Array.from({ length: this.channels }, () => new Float32Array(until - first));
      // A place that is no place in any file is silence.
      if (!(u > -FAR && u < FAR)) continue;
      if (whole - half + 1 < this.viewFrom || whole + half >= this.viewTo) this.look(whole - half + 1);
      const phase = (u - whole) * phases;
      // Rounding can carry a position just below a whole sample onto the row after the last.
      const p = Math.min(phases - 1, Math.floor(phase));
      const w = phase - p;
      const row = p * taps;
      const start = whole - half + 1 - this.viewFrom;
      const k = n - first;
      // As in `Resampler`: two channels at a time share each weight.
      let c = 0;
      for (; c + 1 < view.length; c += 2) {
        const left = view[c];
        const right = view[c + 1];
        let l = 0;
        let r = 0;
        for (let t = 0; t < taps; t++) {
          const weight = coef[row + t] + w * delta[row + t];
          l += left[start + t] * weight;
          r += right[start + t] * weight;
        }
        data[c][k] = l;
        data[c + 1][k] = r;
      }
      if (c < view.length) {
        const src = view[c];
        let acc = 0;
        for (let t = 0; t < taps; t++) acc += src[start + t] * (coef[row + t] + w * delta[row + t]);
        data[c][k] = acc;
      }
    }
    if (!data) return null;
    this.next = n;
    // The map never runs backwards: what lies before the next sample's reach is finished with.
    if (n < this.last) {
      this.low = this.span(n, n + 1)[0];
      this.kept.drop(this.low);
    } else this.kept.drop(Infinity);
    return { first, data: n === until ? data : data.map((samples) => samples.slice(0, n - first)) };
  }

  /** Bring the source from `from` on into view, as far as it is settled. */
  private look(from: number): void {
    this.viewFrom = from;
    this.viewTo = this.over ? from + VIEW : Math.min(from + VIEW, this.known);
    for (let c = 0; c < this.channels; c++) this.kept.read(c, from, this.viewTo - from, this.view[c]);
  }
}

/** One stretch of a read in which the decoded sound keeps its sample rate and channel count. */
interface Run {
  rate: number;
  channels: number;
  retimer: Reader | Stretcher;
  /** The block that is given next, and the last one this run gives. */
  block: number;
  lastBlock: number;
  /** The block being filled, and how many of its samples are there. */
  pending: Float32Array<ArrayBuffer>[] | null;
  filled: number;
  /**
   * The buffers that follow one another: the time of the first of them, the source sample it
   * was placed on, and how many samples have followed from there.
   */
  origin: number;
  placed: number;
  counted: number;
}

/**
 * The sound of a file retimed along a clip's map, read as `Sound` is read: `buffers(from, to)`
 * gives decoded buffers in order, their times in seconds of the stream.
 */
export class Retimed implements Sounding {
  /**
   * `start` is the file's time zero in the timestamps of `sound` (the asset's `audioStart`).
   * `make` wraps the samples of one buffer, which are its to keep, in what the mixer plays.
   * `turn`, where given, is awaited between two decoded buffers: a preview lets the page draw.
   */
  constructor(
    private readonly sound: Sounding,
    private readonly start: number,
    private readonly map: TimeMap,
    private readonly keepPitch: boolean,
    private readonly make: (channels: Float32Array<ArrayBuffer>[], rate: number) => AudioBuffer,
    private readonly turn?: () => Promise<void>,
  ) {}

  /** The stream has the sample rate of the file's decoded sound. */
  get rate(): number | null {
    return this.sound.rate;
  }

  /** The blocks that cover seconds `[from, to)` of the stream at `rate`: first and last. */
  private blocks(rate: number, from: number, to: number): [first: number, last: number] {
    return [Math.floor(Math.floor(from * rate) / BLOCK), Math.floor((Math.ceil(to * rate) - 1) / BLOCK)];
  }

  /** The seconds of the file that blocks `first` to `last` of the stream at `rate` are made from. */
  private needs(rate: number, first: number, last: number): [from: number, to: number] {
    const span = this.keepPitch ? stretchSpan : readSpan;
    const [lo, hi] = span(rate, this.map.media, first * BLOCK, (last + 1) * BLOCK);
    return [(lo - SPARE) / rate, (hi + SPARE) / rate];
  }

  /**
   * The seconds of the file that cover what seconds `[from, to)` of the stream are made from at
   * any sample rate from `LOWEST_RATE` up. How far a read reaches is counted in samples, so in
   * seconds it reaches furthest at the lowest rate: a buffer of the stream is then half a second
   * long, a block of grains never more than 2.02 s, a grain's reach under 30 ms.
   */
  private needsAtAnyRate(from: number, to: number): [from: number, to: number] {
    const around = BLOCK / LOWEST_RATE + (this.keepPitch ? 2.02 : 0);
    const reach = this.keepPitch ? 0.03 : (REACH + SPARE + 1) / LOWEST_RATE;
    return [this.map.media(from - around) - reach, this.map.media(to + around) + reach];
  }

  /**
   * Seconds `[from, to)` of the stream, as the buffers that cover them: buffer `q` holds stream
   * samples `4096 q` to `4096 (q + 1)` and begins at second `4096 q / rate`, for every read alike.
   * What the stream reads outside the file, in a gap or where the file would not decode is
   * silence. `report` hears of sound that would not decode, with the second of the stream at
   * which it would have played. A range that is not finite gives nothing.
   *
   * The file is decoded once, forwards, from a little before what the first buffer reads to a
   * little after what the last one does. Where its sound changes sample rate or channel count on
   * the way, the buffers made so far are given out and another series begins at the new rate, on
   * that rate's own grid.
   */
  async *buffers(
    from: number,
    to: number,
    report?: (trouble: SoundTrouble) => void,
  ): AsyncGenerator<WrappedAudioBuffer, void, unknown> {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const tell = (trouble: SoundTrouble): void =>
      report?.({ ...trouble, from: this.map.stream(trouble.from - this.start) });
    // The rate decides which samples a buffer of the stream holds and so what has to be decoded.
    // It is the one seen in the file's buffers before, where any were. If the first buffer of
    // this read shows another, and this read did not ask for all that rate needs, it asks again.
    let rate = this.sound.rate;
    let run: Run | null = null;
    for (let asks = 0; ; asks++) {
      const asked: [number, number] =
        rate !== null && rate > 0
          ? this.needs(rate, ...this.blocks(rate, from, to))
          : this.needsAtAnyRate(from, to);
      let again = false;
      for await (const wb of this.sound.buffers(this.start + asked[0], this.start + asked[1], tell)) {
        const { sampleRate, numberOfChannels, length } = wb.buffer;
        if (!run || run.rate !== sampleRate || run.channels !== numberOfChannels) {
          const [first, last] = this.blocks(sampleRate, from, to);
          if (!run && asks === 0) {
            const [low, high] = this.needs(sampleRate, first, last);
            if (low < asked[0] || high > asked[1]) {
              rate = sampleRate;
              again = true;
              break;
            }
          }
          // A run that another follows ends where its own sound does, and the next begins where
          // its sound can first be heard. Where the two meet both give buffers, each silent
          // where it has no sound, and the mixer adds them up.
          const reach = this.reach(sampleRate);
          const at = sampleAt((wb.timestamp - this.start) * sampleRate);
          let begin = first;
          if (run) {
            const ends = this.reach(run.rate);
            const end = this.map.stream((run.placed + run.counted + ends.source) / run.rate) * run.rate;
            if (Number.isFinite(end))
              run.lastBlock = Math.min(run.lastBlock, Math.floor((end + ends.stream) / BLOCK));
            run.retimer.finish();
            yield* this.give(run);
            const starts = this.map.stream((at - reach.source) / sampleRate) * sampleRate;
            if (Number.isFinite(starts)) begin = Math.max(first, Math.floor((starts - reach.stream) / BLOCK));
          }
          // A read decodes on past the sound it gives (with pitch kept, to the anchor after it),
          // and the file's sound can change out there. Sound first heard after the last buffer
          // wanted has no buffer to give, and what follows it in the file plays later still.
          if (begin > last) return;
          run = {
            rate: sampleRate,
            channels: numberOfChannels,
            retimer: this.keepPitch
              ? new Stretcher(numberOfChannels, sampleRate, this.map.media, begin * BLOCK, (last + 1) * BLOCK)
              : new Reader(numberOfChannels, sampleRate, this.map, begin * BLOCK, (last + 1) * BLOCK),
            block: begin,
            lastBlock: last,
            pending: null,
            filled: 0,
            origin: 0,
            placed: 0,
            counted: 0,
          };
        }
        // A decoder's buffers follow one another to the sample, but each carries a time of its
        // own, rounded by itself: taken at its word, one buffer in so many would leave a hole of
        // a sample or land on the last sample of the one before. So only the first of a series
        // is placed by its time, and each one after it behind the one before, as long as its
        // time says so to within a sample and a half. One further off begins after a real gap.
        const off = (wb.timestamp - run.origin) * sampleRate - run.counted;
        if (run.counted === 0 || !(Math.abs(off) < 1.5)) {
          run.origin = wb.timestamp;
          run.placed = sampleAt((wb.timestamp - this.start) * sampleRate);
          run.counted = 0;
        }
        const channels = Array.from({ length: numberOfChannels }, (_, c) => wb.buffer.getChannelData(c));
        run.retimer.push(run.placed + run.counted, channels);
        run.counted += length;
        yield* this.give(run);
        if (run.block > run.lastBlock) return;
        await this.turn?.();
      }
      if (!again) break;
    }
    if (!run) return;
    run.retimer.finish();
    yield* this.give(run);
  }

  /**
   * How far the sound of a source sample spreads at `rate`: over which source samples around a
   * stream sample's place on the map that sample is made from, and over how many stream samples
   * to each side a grain carries what it reads.
   */
  private reach(rate: number): { source: number; stream: number } {
    if (!this.keepPitch) return { source: REACH + 1, stream: 1 };
    const { hop, ahead } = grainMeasures(rate);
    return { source: ahead + 1, stream: hop + 1 };
  }

  /** The buffers of `run` that are complete, as far as the retimer has got. */
  private *give(run: Run): Generator<WrappedAudioBuffer, void, unknown> {
    for (let out = run.retimer.take(); out; out = run.retimer.take()) {
      const length = out.data[0].length;
      for (let done = 0; done < length;) {
        if (run.block > run.lastBlock) return;
        run.pending ??= Array.from({ length: run.channels }, () => new Float32Array(BLOCK));
        const count = Math.min(length - done, BLOCK - run.filled);
        for (let c = 0; c < run.channels; c++)
          run.pending[c].set(out.data[c].subarray(done, done + count), run.filled);
        run.filled += count;
        done += count;
        if (run.filled < BLOCK) continue;
        const buffer = this.make(run.pending, run.rate);
        const timestamp = (run.block * BLOCK) / run.rate;
        run.pending = null;
        run.filled = 0;
        run.block++;
        yield { buffer, timestamp, duration: BLOCK / run.rate };
      }
    }
  }
}
