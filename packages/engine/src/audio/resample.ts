/**
 * Band-limited resampling for the mixer.
 *
 * Sound whose sample rate differs from the output's, or that plays at another speed, has to be read
 * between its samples. Reading it there by drawing a line between the two neighbours dulls the
 * treble (-1.5 dB at 10 kHz for 44.1 kHz material in a 48 kHz mix) and mirrors what lies above half
 * the lower rate back into the audible band. Here each output sample is instead a sum over the
 * source samples around its position, weighted by a Kaiser-windowed sinc. Up to 0.82 of half the
 * lower of the two rates the level is kept (18 kHz for 44.1 kHz material), and from half that rate
 * on everything is more than 90 dB down, so that neither images nor aliases come through.
 *
 * An output sample depends only on its own index and on the source samples around it, never on the
 * samples made before it. Rendered in pieces (an export does it four seconds at a time, a preview
 * one decoded buffer at a time) the result is therefore the same as rendered in one go.
 */

/** Zero crossings of the sinc on each side of its centre, counted at the lower of the two rates. */
const LOBES = 32;
/**
 * Played several times faster, a kernel of that many lobes would span thousands of source samples.
 * Beyond `MAX_HALF` source samples a side it loses lobes instead, down to `MIN_LOBES`: the band it
 * passes narrows, what it keeps out stays out.
 */
const MIN_LOBES = 8;
const MAX_HALF = 128;
/** The most source samples per output sample at which the kernel still has all its lobes. */
export const FULL_KERNEL_STEP = MAX_HALF / LOBES;
/** Kaiser window parameter for a stop band 92 dB down. */
const BETA = 9.18;
/**
 * Width of the band between flat and silent, as a fraction of the lower Nyquist frequency, for a
 * kernel of `LOBES` lobes. It ends at that frequency, so the cut-off sits half of it lower.
 */
const TRANSITION = 0.183;
/** Positions between two source samples for which taps are stored; others are interpolated. */
const PHASES = 512;
const MIN_PHASES = 32;

interface Kernel {
  /** Source samples the kernel spans on each side of the position read. */
  half: number;
  taps: number;
  phases: number;
  /** `phases` rows of `taps` weights, and for each the difference to the row of the next phase. */
  coef: Float64Array;
  delta: Float64Array;
}

/** Modified Bessel function of the first kind, order zero. */
function bessel(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; term > sum * 1e-17; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/**
 * Reading a source at more than one of its samples per output sample is a conversion to a lower
 * rate: the band that may pass shrinks and the kernel grows with it. `scale` is that lower rate
 * over the source's, 1 when the source is the slower of the two.
 */
const scaleOf = (step: number): number => Math.min(1, 1 / step);
const lobesOf = (scale: number): number => Math.max(MIN_LOBES, Math.min(LOBES, Math.floor(MAX_HALF * scale)));

/**
 * How many source samples before and after a position its output sample is made from, reading at
 * `step` source samples per output sample.
 */
export function resampleReach(step: number): number {
  const scale = scaleOf(step);
  return Math.ceil(lobesOf(scale) / scale);
}

function buildKernel(scale: number): Kernel {
  const lobes = lobesOf(scale);
  const cutoff = 1 - (TRANSITION * LOBES) / lobes / 2;
  const half = Math.ceil(lobes / scale);
  const taps = 2 * half;
  // A stretched kernel changes less from one source sample to the next and needs fewer phases.
  const phases = Math.max(MIN_PHASES, Math.ceil(PHASES * scale));
  const norm = bessel(BETA);
  const weight = (z: number): number => {
    const r = z / lobes;
    if (r <= -1 || r >= 1) return 0;
    const x = Math.PI * cutoff * z;
    return (x === 0 ? 1 : Math.sin(x) / x) * (bessel(BETA * Math.sqrt(1 - r * r)) / norm);
  };
  const row = (phase: number): Float64Array => {
    const out = new Float64Array(taps);
    let sum = 0;
    for (let t = 0; t < taps; t++) sum += out[t] = weight(scale * (phase / phases + half - 1 - t));
    // Every phase passes a steady level unchanged; left as computed they would differ by the
    // window's ripple and print the pattern of the phases on the signal.
    for (let t = 0; t < taps; t++) out[t] /= sum;
    return out;
  };
  const coef = new Float64Array(phases * taps);
  const delta = new Float64Array(phases * taps);
  let cur = row(0);
  for (let p = 0; p < phases; p++) {
    const next = row(p + 1);
    coef.set(cur, p * taps);
    for (let t = 0; t < taps; t++) delta[p * taps + t] = next[t] - cur[t];
    cur = next;
  }
  return { half, taps, phases, coef, delta };
}

const kernels = new Map<number, Kernel>();

/** The kernel for reading a source at `step` of its samples per output sample. */
function kernelFor(step: number): Kernel {
  const scale = scaleOf(step);
  let k = kernels.get(scale);
  // Every conversion at normal speed or slower shares one kernel and each faster speed has its
  // own, so a handful covers a project. The one used longest ago makes room; it is quick to make
  // again.
  if (k) kernels.delete(scale);
  else {
    if (kernels.size >= 6) kernels.delete(kernels.keys().next().value!);
    k = buildKernel(scale);
  }
  kernels.set(scale, k);
  return k;
}

/** Output samples `first`, `first + 1`, … of one stream, per channel. */
export interface Resampled {
  first: number;
  data: Float32Array<ArrayBuffer>[];
}

/**
 * One run of consecutive source samples, read at evenly spaced positions: output sample `i` is the
 * source at `origin + i * step`, in source samples counted from the first one pushed. Source
 * samples arrive in pieces; each piece returns the output that it completes.
 */
export class Resampler {
  private readonly kernel: Kernel;
  private window: Float32Array[];
  /** Index in the source of the first sample held in `window`, and of the sample after the last. */
  private base = 0;
  private end = 0;
  private next: number;

  /**
   * `first` and `last` bound the output wanted (`last` exclusive). Output that lies further from
   * the source than the kernel reaches is silence and is not produced.
   */
  constructor(
    readonly channels: number,
    private readonly origin: number,
    private readonly step: number,
    first: number,
    private readonly last: number,
  ) {
    this.kernel = kernelFor(step);
    this.window = Array.from({ length: channels }, () => new Float32Array(0));
    this.next = Math.max(first, this.before(-this.kernel.half));
  }

  /** True once all the output wanted has been produced: further source samples change nothing. */
  get done(): boolean {
    return this.next >= this.last;
  }

  private at(i: number): number {
    return this.origin + i * this.step;
  }

  /** The first output sample that reads the source at `position` or after it. */
  private before(position: number): number {
    let i = Math.ceil((position - this.origin) / this.step);
    while (this.at(i - 1) >= position) i--;
    while (this.at(i) < position) i++;
    return i;
  }

  /** Add the source samples that follow the ones given so far, one array per channel. */
  push(data: readonly Float32Array[]): Resampled | null {
    if (this.done) return null;
    const length = data[0].length;
    // Samples in front of the next position's reach are finished with.
    const from = Math.min(
      this.end,
      Math.max(this.base, Math.floor(this.at(this.next)) - this.kernel.half + 1),
    );
    const kept = this.end - from;
    this.window = this.window.map((held, c) => {
      const joined = new Float32Array(kept + length);
      joined.set(held.subarray(from - this.base, this.end - this.base));
      joined.set(data[c], kept);
      return joined;
    });
    this.base = from;
    this.end += length;
    // Only positions whose whole reach has arrived: what follows may still change the others.
    return this.produce(Math.min(this.last, this.before(this.end - this.kernel.half)));
  }

  /** The source has ended: the rest of the output it reaches, with silence after its last sample. */
  finish(): Resampled | null {
    if (this.done) return null;
    const out = this.produce(Math.min(this.last, this.before(this.end + this.kernel.half - 1)));
    this.next = this.last;
    return out;
  }

  private produce(until: number): Resampled | null {
    const first = this.next;
    const count = until - first;
    if (count <= 0) return null;
    const { half, taps, phases, coef, delta } = this.kernel;
    const { window, base, origin, step } = this;
    const held = this.end - base;
    const data = Array.from({ length: this.channels }, () => new Float32Array(count));
    for (let k = 0; k < count; k++) {
      const u = origin + (first + k) * step;
      const whole = Math.floor(u);
      const phase = (u - whole) * phases;
      // Rounding can carry a position just below a whole sample onto the row after the last.
      const p = Math.min(phases - 1, Math.floor(phase));
      const w = phase - p;
      const row = p * taps;
      const start = whole - half + 1 - base;
      const lo = Math.max(0, -start);
      const hi = Math.min(taps, held - start);
      // This loop is nearly all the work there is. Two channels at a time share each weight;
      // stereo, which is most sound, is then one pass.
      let c = 0;
      for (; c + 1 < window.length; c += 2) {
        const left = window[c];
        const right = window[c + 1];
        let l = 0;
        let r = 0;
        for (let t = lo; t < hi; t++) {
          const weight = coef[row + t] + w * delta[row + t];
          l += left[start + t] * weight;
          r += right[start + t] * weight;
        }
        data[c][k] = l;
        data[c + 1][k] = r;
      }
      if (c < window.length) {
        const src = window[c];
        let acc = 0;
        for (let t = lo; t < hi; t++) acc += src[start + t] * (coef[row + t] + w * delta[row + t]);
        data[c][k] = acc;
      }
    }
    this.next = until;
    return { first, data };
  }
}
