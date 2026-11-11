/**
 * Programme loudness, ITU-R BS.1770-4 / EBU R 128.
 *
 * `LoudnessMeter` is fed PCM in arbitrary chunks and reports integrated loudness in LUFS (K-weighted,
 * gated) and the sample peak. It is what "normalise this clip to −14 LUFS" measures with.
 */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages for a given sample rate (the standard only tabulates 48 kHz). */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf modelling the acoustic effect of the head.
  const f1 = 1681.974450955533;
  const g1 = 3.999843853973347;
  const q1 = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * f1) / sampleRate);
  const vh = Math.pow(10, g1 / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const d1 = 1 + k1 / q1 + k1 * k1;
  const shelf: Biquad = {
    b0: (vh + (vb * k1) / q1 + k1 * k1) / d1,
    b1: (2 * (k1 * k1 - vh)) / d1,
    b2: (vh - (vb * k1) / q1 + k1 * k1) / d1,
    a1: (2 * (k1 * k1 - 1)) / d1,
    a2: (1 - k1 / q1 + k1 * k1) / d1,
  };
  // Stage 2: the RLB high-pass.
  const f2 = 38.13547087602444;
  const q2 = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * f2) / sampleRate);
  const d2 = 1 + k2 / q2 + k2 * k2;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d2,
    a2: (1 - k2 / q2 + k2 * k2) / d2,
  };
  return [shelf, highpass];
}

/** Channel weights: front channels count fully, surrounds 1.41 (≈ +1.5 dB), LFE not at all. */
function channelWeights(n: number): number[] {
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
  if (n === 5) return [1, 1, 1, 1.41, 1.41];
  return Array.from({ length: n }, () => 1);
}

const energyToLufs = (e: number): number => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);

export interface LoudnessResult {
  /** Integrated loudness in LUFS; −Infinity for silence. */
  lufs: number;
  /** Largest sample magnitude, in dBFS; −Infinity for silence. */
  peakDb: number;
  seconds: number;
}

export class LoudnessMeter {
  private readonly stages: [Biquad, Biquad];
  private readonly weights: number[];
  /** Filter memories: per channel, per stage, [x1, x2, y1, y2]. */
  private readonly state: Float64Array[];
  /** Samples per 100 ms step; a gating block is four steps. */
  private readonly step: number;
  private filled = 0;
  private acc = 0;
  /** Weighted mean-square energy of every completed 100 ms step. */
  private readonly steps: number[] = [];
  private peak = 0;
  private total = 0;
  private sumAll = 0;

  constructor(
    readonly sampleRate: number,
    readonly channels: number,
  ) {
    this.stages = kWeighting(sampleRate);
    this.weights = channelWeights(channels);
    this.state = Array.from({ length: channels }, () => new Float64Array(8));
    this.step = Math.max(1, Math.round(sampleRate / 10));
  }

  /** Feed planar samples: one Float32Array per channel, all the same length. */
  push(planes: readonly Float32Array[]): void {
    const n = planes[0]?.length ?? 0;
    const [s1, s2] = this.stages;
    const chans = Math.min(this.channels, planes.length);
    for (let i = 0; i < n; i++) {
      let frame = 0;
      for (let c = 0; c < chans; c++) {
        const x = planes[c][i];
        const ax = x < 0 ? -x : x;
        if (ax > this.peak) this.peak = ax;
        const st = this.state[c];
        // Direct form I, twice.
        const y1 = s1.b0 * x + s1.b1 * st[0] + s1.b2 * st[1] - s1.a1 * st[2] - s1.a2 * st[3];
        st[1] = st[0];
        st[0] = x;
        st[3] = st[2];
        st[2] = y1;
        const y2 = s2.b0 * y1 + s2.b1 * st[4] + s2.b2 * st[5] - s2.a1 * st[6] - s2.a2 * st[7];
        st[5] = st[4];
        st[4] = y1;
        st[7] = st[6];
        st[6] = y2;
        frame += this.weights[c] * y2 * y2;
      }
      this.acc += frame;
      this.sumAll += frame;
      if (++this.filled === this.step) {
        this.steps.push(this.acc / this.step);
        this.acc = 0;
        this.filled = 0;
      }
    }
    this.total += n;
  }

  result(): LoudnessResult {
    const seconds = this.total / this.sampleRate;
    const peakDb = this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
    // 400 ms blocks with 75 % overlap = every run of four consecutive 100 ms steps.
    const blocks: number[] = [];
    for (let i = 0; i + 4 <= this.steps.length; i++) {
      blocks.push((this.steps[i] + this.steps[i + 1] + this.steps[i + 2] + this.steps[i + 3]) / 4);
    }
    // Too short to gate: the plain K-weighted level is the best available answer.
    if (!blocks.length)
      return { lufs: energyToLufs(this.total ? this.sumAll / this.total : 0), peakDb, seconds };
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const audible = blocks.filter((e) => energyToLufs(e) > -70);
    if (!audible.length) return { lufs: -Infinity, peakDb, seconds };
    const relative = energyToLufs(mean(audible)) - 10;
    const gated = audible.filter((e) => energyToLufs(e) > relative);
    return { lufs: energyToLufs(mean(gated.length ? gated : audible)), peakDb, seconds };
  }
}

/**
 * Gain (dB) that brings material measured at `lufs` to `target`, held back so the sample peak stays
 * under `ceilingDb`. Returns null for silence.
 */
export function normalizationGain(measured: LoudnessResult, target: number, ceilingDb = -1): number | null {
  if (!Number.isFinite(measured.lufs)) return null;
  const wanted = target - measured.lufs;
  const headroom = Number.isFinite(measured.peakDb) ? ceilingDb - measured.peakDb : Infinity;
  return Math.min(wanted, headroom);
}
