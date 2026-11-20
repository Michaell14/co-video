import { describe, expect, it } from 'vitest';
import { Stretcher, grainMeasures, stretchSpan } from '../src/audio/stretch';

const RATE = 48000;

/** Stream samples `[n0, n1)` of a file stretched along `media`, its samples pushed in pieces of `piece`. */
function stretch(
  channels: Float32Array[],
  media: (tau: number) => number,
  n0: number,
  n1: number,
  { piece = 4096, rate = RATE } = {},
): Float32Array[] {
  const stretcher = new Stretcher(channels.length, rate, media, n0, n1);
  const out = channels.map(() => new Float32Array(n1 - n0));
  let given = n0;
  const take = () => {
    for (let got = stretcher.take(); got; got = stretcher.take()) {
      // Blocks abut: each begins on the sample after the last of the one before.
      expect(got.first).toBe(given);
      got.data.forEach((samples, c) => out[c].set(samples, got.first - n0));
      given += got.data[0].length;
    }
  };
  const [lo, hi] = stretchSpan(rate, media, n0, n1);
  const end = Math.min(channels[0].length, hi);
  for (let i = Math.max(0, lo); i < end; i += piece) {
    stretcher.push(
      i,
      channels.map((x) => x.subarray(i, Math.min(end, i + piece))),
    );
    take();
  }
  stretcher.finish();
  take();
  expect(given).toBe(n1);
  expect(stretcher.take()).toBeNull();
  return out;
}

/** One speed throughout: second `at` of the file plays at second 0 of the stream. */
const steady =
  (speed: number, at = 0.25) =>
  (tau: number): number =>
    at + speed * tau;

/**
 * A ramp: at second `m` of the file the speed is `v`; between two points it eases from the one
 * speed to the other in time, and outside the points it holds. Second `at` of the file plays at
 * second 0 of the stream.
 */
function ramp(points: { m: number; v: number }[], at: number) {
  const n = points.length;
  const clock = [0];
  const took: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    took.push((2 * (points[i + 1].m - points[i].m)) / (points[i].v + points[i + 1].v));
    clock.push(clock[i] + took[i]);
  }
  const mediaOf = (t: number): number => {
    if (t <= 0) return points[0].m + t * points[0].v;
    if (t >= clock[n - 1]) return points[n - 1].m + (t - clock[n - 1]) * points[n - 1].v;
    let i = 0;
    while (i + 2 < n && clock[i + 1] <= t) i++;
    const u = (t - clock[i]) / took[i];
    const rise = (points[i + 1].v - points[i].v) * took[i] * (u * u * u - (u * u * u * u) / 2);
    return points[i].m + points[i].v * (t - clock[i]) + rise;
  };
  const clockOf = (m: number): number => {
    if (m <= points[0].m) return (m - points[0].m) / points[0].v;
    if (m >= points[n - 1].m) return clock[n - 1] + (m - points[n - 1].m) / points[n - 1].v;
    let lo = 0;
    let hi = clock[n - 1];
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2;
      if (mediaOf(mid) < m) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const base = clockOf(at);
  return { media: (tau: number) => mediaOf(base + tau), stream: (m: number) => clockOf(m) - base };
}

/** Speeds 1, 3, 0.5, 0.5, 2 and 1 at seconds 1, 3, 4.5, 6, 8 and 10 of the file, from second 0.5 on. */
const sixPoints = ramp(
  [
    { m: 1, v: 1 },
    { m: 3, v: 3 },
    { m: 4.5, v: 0.5 },
    { m: 6, v: 0.5 },
    { m: 8, v: 2 },
    { m: 10, v: 1 },
  ],
  0.5,
);

// ── signals: everything is generated, from a generator of its own ──────────────────────────────

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function tone(hz: number, seconds: number, amp = 0.5, rate = RATE): Float32Array {
  return Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate),
  );
}

/** A tone with its harmonics up to `top` Hz, the h-th at 1/h. */
function harmonic(f0: number, seconds: number, top = 8000, amp = 0.3): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let h = 1; h * f0 <= top; h++) {
    const w = (2 * Math.PI * h * f0) / RATE;
    for (let i = 0; i < out.length; i++) out[i] += (amp / h) * Math.sin(w * i + h * 0.7);
  }
  return out;
}

/** The energy of one of the clicks of `clicks`. */
function clickEnergy(): number {
  let energy = 0;
  for (let i = 0; i < RATE / 1000; i++) energy += (0.8 * Math.exp(-i / (RATE / 4000))) ** 2;
  return energy;
}

/** Clicks of a millisecond at the given seconds, over noise 60 dB down. */
function clicks(seconds: number, times: number[]): Float32Array {
  const rnd = random(7);
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.001 * (rnd() * 2 - 1);
  for (const t of times) {
    const n = Math.round(t * RATE);
    for (let i = 0; i < RATE / 1000 && n + i < out.length; i++)
      out[n + i] += 0.8 * Math.exp(-i / (RATE / 4000)) * (i % 2 ? -1 : 1);
  }
  return out;
}

/** Bursts of noise that die away in `ms` milliseconds, at the given seconds, over noise 60 dB down. */
function bursts(seconds: number, times: number[], ms: number): Float32Array {
  const rnd = random(3);
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.001 * (rnd() * 2 - 1);
  for (const t of times) {
    const n = Math.round(t * RATE);
    for (let i = 0; i < (ms * 4 * RATE) / 1000 && n + i < out.length; i++)
      out[n + i] += 0.8 * Math.exp(-i / ((ms * RATE) / 1000)) * (rnd() * 2 - 1);
  }
  return out;
}

/** Noise between `lo` and `hi` Hz, at a level of 0.1. */
function noise(seconds: number, lo: number, hi: number, seed: number): Float32Array {
  const rnd = random(seed);
  const out = new Float32Array(Math.round(RATE * seconds));
  const aLo = Math.exp((-2 * Math.PI * lo) / RATE);
  const aHi = Math.exp((-2 * Math.PI * hi) / RATE);
  let y1 = 0;
  let y2 = 0;
  let energy = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rnd() * 2 - 1;
    y1 = aHi * y1 + (1 - aHi) * w;
    y2 = aLo * y2 + (1 - aLo) * w;
    out[i] = y1 - y2;
    energy += out[i] * out[i];
  }
  const gain = 0.1 / Math.sqrt(energy / out.length);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

/**
 * Something with the structure of speech: a train of pulses whose pitch moves between 95 and
 * 190 Hz, through three moving resonances, in syllables with unvoiced bursts and pauses.
 */
function speechLike(seconds: number, rate = RATE, seed = 11): Float32Array {
  const rnd = random(seed);
  const n = Math.round(rate * seconds);
  const pulses = new Float32Array(n);
  const voiced = new Uint8Array(n);
  let i = 0;
  let phase = 0;
  while (i < n) {
    if (rnd() < 0.6) {
      const length = Math.round(rate * (0.04 + 0.07 * rnd()));
      const a = 0.25 + 0.25 * rnd();
      for (let k = 0; k < length && i < n; k++, i++)
        pulses[i] = a * (rnd() * 2 - 1) * Math.sin((Math.PI * k) / length);
    }
    const length = Math.round(rate * (0.12 + 0.25 * rnd()));
    const from = 95 + 95 * rnd();
    const to = Math.max(85, from * (0.8 + 0.4 * rnd()));
    for (let k = 0; k < length && i < n; k++, i++) {
      phase += (from + ((to - from) * k) / length) / rate;
      if (phase >= 1) {
        phase -= 1;
        pulses[i] = Math.min(1, k / (0.01 * rate), (length - k) / (0.02 * rate));
      }
      voiced[i] = 1;
    }
    if (rnd() < 0.5) i += Math.round(rate * (0.03 + 0.2 * rnd()));
  }
  const out = new Float32Array(n);
  for (const [centre, width, gain] of [
    [500, 80, 1],
    [1500, 110, 0.6],
    [2600, 160, 0.3],
  ]) {
    let y1 = 0;
    let y2 = 0;
    const drift = 0.3 + rnd();
    const r = Math.exp((-Math.PI * width) / rate);
    for (let k = 0; k < n; k++) {
      const f = centre * (1 + 0.25 * Math.sin((2 * Math.PI * drift * k) / rate + centre));
      const y =
        pulses[k] * (voiced[k] ? 1 : 0.4) + 2 * r * Math.cos((2 * Math.PI * f) / rate) * y1 - r * r * y2;
      y2 = y1;
      y1 = y;
      out[k] += gain * y * 0.12;
    }
  }
  return out;
}

/** Chords of harmonic tones that change every half second, with a drum hit on every beat. */
function musicLike(seconds: number, rate = RATE, seed = 5): Float32Array {
  const rnd = random(seed);
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  const chords = [
    [110, 164.81, 220, 277.18],
    [98, 146.83, 196, 246.94],
    [130.81, 196, 261.63, 329.63],
    [87.31, 130.81, 174.61, 220],
  ];
  const beat = Math.round(rate / 2);
  for (let s = 0; s * beat < n; s++) {
    for (const f of chords[s % chords.length])
      for (let h = 1; h <= 6; h++) {
        const w = (2 * Math.PI * f * h) / rate;
        for (let k = 0; k < beat && s * beat + k < n; k++)
          out[s * beat + k] +=
            (0.05 / h) * Math.min(1, k / (0.005 * rate)) * Math.exp(-k / (0.6 * rate)) * Math.sin(w * k);
      }
    for (let k = 0; k < 0.08 * rate && s * beat + k < n; k++) {
      out[s * beat + k] += 0.4 * Math.exp(-k / (0.02 * rate)) * Math.sin((2 * Math.PI * 60 * k) / rate);
      out[s * beat + k] += 0.25 * Math.exp(-k / (0.004 * rate)) * (rnd() * 2 - 1);
    }
  }
  return out;
}

/** Fifty seconds of each, made once: the longest stretch any test here plays. */
let made: { speech: Float32Array; music: Float32Array } | null = null;
const signals = () => (made ??= { speech: speechLike(51), music: musicLike(51) });

// ── measures ───────────────────────────────────────────────────────────────────────────────────

const db = (amplitude: number): number => 20 * Math.log10(Math.max(amplitude, 1e-12));

/** A moving average of width `w` (odd) around each sample, taken twice. */
function smooth(a: Float64Array, w: number): Float64Array {
  const once = (src: Float64Array) => {
    const out = new Float64Array(src.length);
    const half = (w - 1) / 2;
    let sum = 0;
    for (let i = 0; i < src.length + half; i++) {
      if (i < src.length) sum += src[i];
      if (i - w >= 0) sum -= src[i - w];
      if (i - half >= 0) out[i - half] = sum / w;
    }
    return out;
  };
  return once(once(a));
}

/**
 * A tone of nominal frequency `hz` in `y`: its mean frequency, its level, how far the level dips
 * under its mean, and what is left once a tone of slowly moving level and phase is taken out, the
 * first and last tenth of a second aside.
 */
function analyseTone(y: Float32Array, hz: number, rate = RATE) {
  const n = y.length;
  const inPhase = new Float64Array(n);
  const quadrature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = (2 * Math.PI * hz * i) / rate;
    inPhase[i] = y[i] * Math.cos(p);
    quadrature[i] = -y[i] * Math.sin(p);
  }
  // Averaged over a whole number of periods: three, or six milliseconds if that is longer.
  const period = rate / hz;
  let w = Math.round(Math.max(3, Math.ceil((0.006 * rate) / period)) * period);
  if (w % 2 === 0) w++;
  const a = smooth(inPhase, w);
  const b = smooth(quadrature, w);
  const m = Math.round(0.1 * rate);
  let turns = 0;
  let before = 0;
  let first = 0;
  let last = 0;
  let lowest = Infinity;
  let sum = 0;
  let rest = 0;
  let signal = 0;
  for (let i = m; i < n - m; i++) {
    let phase = Math.atan2(b[i], a[i]);
    if (i > m) {
      while (phase + turns - before > Math.PI) turns -= 2 * Math.PI;
      while (phase + turns - before < -Math.PI) turns += 2 * Math.PI;
    }
    phase += turns;
    if (i === m) first = phase;
    last = before = phase;
    const level = 2 * Math.hypot(a[i], b[i]);
    lowest = Math.min(lowest, level);
    sum += level;
    const p = (2 * Math.PI * hz * i) / rate;
    const model = 2 * (a[i] * Math.cos(p) - b[i] * Math.sin(p));
    rest += (y[i] - model) ** 2;
    signal += model * model;
  }
  const count = n - 2 * m;
  const mean = sum / count;
  return {
    hz: hz + ((last - first) / (2 * Math.PI)) * (rate / (count - 1)),
    level: db(mean),
    dip: db(lowest / mean),
    residue: 10 * Math.log10(rest / signal + 1e-30),
  };
}

/**
 * Clicks expected at stream samples `at`: where the strongest of each lands (ms from its place),
 * how many copies there are (peaks within 12 dB of the strongest, 1.5 ms apart or more), how wide
 * the stretch is that holds 90 % of the energy found within 40 ms either way, and that energy
 * against `energy` in dB.
 */
function analyseClicks(y: Float32Array, at: number[], energy: number) {
  const half = Math.round(0.04 * RATE);
  return at.map((place) => {
    const a = Math.round(place) - half;
    const b = Math.round(place) + half;
    let peak = 0;
    let where = 0;
    let total = 0;
    for (let i = a; i < b; i++) {
      const v = Math.abs(y[i]);
      total += v * v;
      if (v > peak) {
        peak = v;
        where = i;
      }
    }
    let copies = 0;
    let last = -Infinity;
    for (let i = a; i < b; i++) {
      if (Math.abs(y[i]) < peak / 4) continue;
      if (i - last > Math.round(0.0015 * RATE)) copies++;
      last = i;
    }
    let lo = a;
    let hi = b - 1;
    let cut = 0;
    while (lo < hi) {
      const l = y[lo] * y[lo];
      const h = y[hi] * y[hi];
      if (cut + Math.min(l, h) > 0.1 * total) break;
      if (l <= h) {
        cut += l;
        lo++;
      } else {
        cut += h;
        hi--;
      }
    }
    return {
      late: ((where - place) / RATE) * 1000,
      copies,
      span: ((hi - lo + 1) / RATE) * 1000,
      energy: 10 * Math.log10(total / energy + 1e-30),
      peak,
    };
  });
}

/**
 * The power of `y` around `hz`, the first and last second aside: taken over a fifth of a second
 * at a time under a Hann window, which tells apart what lies 100 Hz from a tone and still holds a
 * tone that sits a fraction of a hertz off.
 */
function powerAround(y: Float32Array, hz: number): number {
  const length = RATE / 5;
  let power = 0;
  let count = 0;
  for (let at = RATE; at + length <= y.length - RATE; at += length / 2, count++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < length; i++) {
      const v = y[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length));
      const p = (2 * Math.PI * hz * i) / RATE;
      re += v * Math.cos(p);
      im += v * Math.sin(p);
    }
    power += re * re + im * im;
  }
  return power / count;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const most = (values: number[]): number => Math.max(...values.map(Math.abs));

/** Clicks or bursts every 0.4173 s of a file that plays for `seconds` at `speed`. */
function everySoOften(seconds: number, speed: number) {
  const length = seconds * speed + 3;
  const times: number[] = [];
  for (let t = 0.731; t < length - 1; t += 0.4173) times.push(t);
  // Where each lands in the stream, those in its first and last tenth of a second aside.
  const at = times
    .map((t) => ((t - 0.25) / speed) * RATE)
    .filter((n) => n > 0.1 * RATE && n < (seconds - 0.1) * RATE);
  return { length, times, at };
}

/**
 * A file in stereo that says where each grain of a stretch was taken from: a count of its own
 * samples is added to one channel and taken from the other, far too quiet to move a grain (the
 * two are placed by their mean, which is the signal).
 */
function counted(signal: Float32Array): Float32Array[] {
  const left = new Float32Array(signal.length);
  const right = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const count = ((i % 4096) - 2048) / 65536;
    left[i] = signal[i] + count;
    right[i] = signal[i] - count;
  }
  return [left, right];
}

/**
 * Where each grain of `seconds` of such a file stretched along `media` lies from its place on the
 * map, in source samples, read off the stream itself: at the centre of a grain the stream is the
 * file's sample there.
 */
function grainOffsets(
  file: Float32Array[],
  media: (tau: number) => number,
  seconds: number,
  rate = RATE,
): number[] {
  const out = stretch(file, media, 0, seconds * rate, { rate });
  const { hop } = grainMeasures(rate);
  const offsets: number[] = [];
  for (let k = 0; k * hop < seconds * rate; k++) {
    const sample = Math.round(((out[0][k * hop] - out[1][k * hop]) / 2) * 65536) + 2048;
    const centre = Math.round(rate * media((k * hop) / rate));
    offsets.push(((((sample - centre) % 4096) + 4096 + 2048) % 4096) - 2048);
  }
  return offsets;
}

describe('Stretcher', () => {
  it('gives the file itself wherever the speed is exactly 1', () => {
    // A ramp that comes down to normal speed, rests there for seven seconds of the file and
    // slows down: every block of grains that lies in the rest is the file, sample for sample.
    const { media, stream } = ramp(
      [
        { m: 1, v: 2 },
        { m: 2, v: 1 },
        { m: 9, v: 1 },
        { m: 10, v: 0.5 },
      ],
      0.5,
    );
    const source = signals().speech.subarray(0, 12 * RATE);
    const n = Math.floor(stream(10.5) * RATE);
    const out = stretch([source], media, 0, n)[0];
    const { block } = grainMeasures(RATE);
    let blocks = 0;
    for (let j = Math.ceil((stream(2) * RATE) / block); (j + 1) * block <= stream(9) * RATE; j++, blocks++) {
      const shift = Math.round(RATE * media((j * block) / RATE)) - j * block;
      expect(out.subarray(j * block, (j + 1) * block), `block ${j}`).toEqual(
        source.subarray(j * block + shift, (j + 1) * block + shift),
      );
    }
    expect(blocks).toBeGreaterThanOrEqual(2);

    // At one speed of exactly 1 the whole stream is the file: 44.1 kHz, stereo.
    const rate = 44100;
    const stereo = [speechLike(5, rate), musicLike(5, rate)];
    const same = stretch(stereo, steady(1, 0.3), 0, 4 * rate, { rate });
    stereo.forEach((channel, c) => expect(same[c]).toEqual(channel.subarray(0.3 * rate, 4.3 * rate)));
  });

  it('keeps a tone’s frequency and level at every speed', () => {
    for (const hz of [220, 440, 997]) {
      for (const speed of [0.5, 0.8, 1.25, 2]) {
        const out = stretch([tone(hz, 16 * speed + 2)], steady(speed, 0.5), 0, 16 * RATE)[0];
        const found = analyseTone(out, hz);
        const what = `${hz} Hz at ${speed}x`;
        expect(Math.abs(found.hz - hz), what).toBeLessThan(0.3 + 0.0011 * hz);
        expect(Math.abs(found.level - db(0.5)), what).toBeLessThan(0.1);
        expect(found.dip, what).toBeGreaterThan(-0.2);
        expect(found.residue, what).toBeLessThan(-40);
      }
    }
    // Higher up a grain can only be placed to the sample: a tenth of a per cent.
    for (const speed of [0.5, 0.8, 1.25, 2]) {
      const found = analyseTone(
        stretch([tone(3001, 16 * speed + 2)], steady(speed, 0.5), 0, 16 * RATE)[0],
        3001,
      );
      expect(Math.abs(found.hz - 3001) / 3001, `3001 Hz at ${speed}x`).toBeLessThan(0.0011);
    }
  });

  it('keeps a tone at 44.1 kHz and in stereo as well', () => {
    const rate = 44100;
    for (const speed of [0.8, 1.25]) {
      const source = [tone(440, 8 * speed + 2, 0.5, rate), tone(440, 8 * speed + 2, 0.25, rate)];
      const out = stretch(source, steady(speed, 0.5), 0, 8 * rate, { rate });
      [0.5, 0.25].forEach((amp, c) => {
        const found = analyseTone(out[c], 440, rate);
        expect(Math.abs(found.hz - 440)).toBeLessThan(0.3 + 0.0011 * 440);
        expect(Math.abs(found.level - db(amp))).toBeLessThan(0.1);
        expect(found.dip).toBeGreaterThan(-0.2);
        expect(found.residue).toBeLessThan(-40);
      });
    }
  });

  it('gives exactly the samples asked for, in blocks that abut', () => {
    const source = [signals().speech.subarray(0, 12 * RATE)];
    const { block, hop, search } = grainMeasures(RATE);
    expect([hop, search, block]).toEqual([480, 360, 96000]);
    expect(grainMeasures(44100)).toEqual({ hop: 441, search: 331, block: 88200, back: 1103, ahead: 1213 });
    for (const [n0, n1] of [
      [0, 1],
      [0, block],
      [block - 1, block + 1],
      [12345, 250001],
      [-30000, 70000],
      [-2 * block, -block],
      [3 * block, 3 * block + 4096],
    ]) {
      // `stretch` checks that the pieces follow one another and end at `n1`.
      const out = stretch(source, steady(1.3, 0.5), n0, n1)[0];
      expect(out.length).toBe(n1 - n0);
    }
    // A stretcher asks for what the blocks of its samples read, and no more of the file than that.
    const stretcher = new Stretcher(1, RATE, steady(2, 1), 100000, 100001);
    expect(stretcher.span(100000, 100001)).toEqual([RATE + 2 * block - 1200, RATE + 4 * block + 1320]);
    expect(stretchSpan(RATE, steady(2, 1), 100000, 100001)).toEqual(stretcher.span(100000, 100001));
    expect(stretchSpan(RATE, steady(2, 1), 0, 2 * block + 1)).toEqual([RATE - 1200, RATE + 6 * block + 1320]);
  });

  it('makes the same samples wherever a read begins and ends', () => {
    const { speech, music } = signals();
    const source = [speech, music];
    const rnd = random(99);
    const seconds = 12;
    for (const speed of [0.5, 1.3, 2, 4]) {
      const whole = stretch(source, steady(speed), 0, seconds * RATE);
      for (let trial = 0; trial < 40; trial++) {
        const n0 = Math.floor(rnd() * (seconds - 2) * RATE);
        const n1 = n0 + 1 + Math.floor(rnd() * 1.5 * RATE);
        // A stretcher of its own for every piece: nothing is carried over.
        const piece = stretch(source, steady(speed), n0, n1);
        piece.forEach((samples, c) =>
          expect(samples, `${speed}x, ${n0} to ${n1}`).toEqual(whole[c].subarray(n0, n1)),
        );
      }
    }
    const end = Math.floor(sixPoints.stream(11.5) * RATE);
    const whole = stretch(source, sixPoints.media, 0, end);
    for (let trial = 0; trial < 30; trial++) {
      const n0 = Math.floor(rnd() * (end - RATE));
      const n1 = n0 + 1 + Math.floor(rnd() * RATE);
      const piece = stretch(source, sixPoints.media, n0, n1);
      piece.forEach((samples, c) =>
        expect(samples, `ramp, ${n0} to ${n1}`).toEqual(whole[c].subarray(n0, n1)),
      );
    }
  });

  it('makes the same samples however the file arrives', () => {
    const { speech, music } = signals();
    const source = [speech.subarray(0, 6 * RATE), music.subarray(0, 6 * RATE)];
    for (const media of [steady(1.3), steady(0.5), sixPoints.media]) {
      const whole = stretch(source, media, 0, 3 * RATE, { piece: 6 * RATE });
      for (const piece of [1, 7, 1024, 4801])
        expect(stretch(source, media, 0, 3 * RATE, { piece }), `pieces of ${piece}`).toEqual(whole);
    }
  });

  it('keeps every grain within 15 ms of its place on the map, and every anchor on it', () => {
    const { speech, music } = signals();
    const { search } = grainMeasures(RATE);
    for (const [name, signal] of [
      ['speech', speech],
      ['music', music],
    ] as const) {
      const file = counted(signal);
      for (const speed of [0.5, 0.8, 1.25, 2, 4]) {
        const offsets = grainOffsets(file, steady(speed), 12);
        const what = `${name} at ${speed}x`;
        expect(offsets.length).toBe(1200);
        expect(most(offsets), what).toBeLessThanOrEqual(2 * search);
        expect((most(offsets) / RATE) * 1000, what).toBeLessThanOrEqual(15);
        for (let k = 0; k < offsets.length; k += 200) expect(offsets[k], what).toBe(0);
        // Grains do move: this is not a measure that reads nothing.
        expect(most(offsets), what).toBeGreaterThan(search / 2);
      }
    }
  });

  it('does so at 44.1 kHz, where the grains are 441 samples apart', () => {
    const rate = 44100;
    const { hop, search } = grainMeasures(rate);
    for (const [name, signal] of [
      ['speech', speechLike(19, rate)],
      ['music', musicLike(19, rate)],
    ] as const) {
      const file = counted(signal);
      for (const speed of [0.8, 2]) {
        const offsets = grainOffsets(file, steady(speed), 8, rate);
        const what = `${name} at ${speed}x`;
        expect(offsets.length).toBe((8 * rate) / hop);
        expect(most(offsets), what).toBeLessThanOrEqual(2 * search);
        expect((most(offsets) / rate) * 1000, what).toBeLessThanOrEqual(15.02);
        for (let k = 0; k < offsets.length; k += 200) expect(offsets[k], what).toBe(0);
        expect(most(offsets), what).toBeGreaterThan(search / 2);
      }
    }
  });

  it('puts bursts of noise where the map says for a minute on end, the last as the first', () => {
    const speed = 1.37;
    const seconds = 60;
    const rnd = random(21);
    const source = new Float32Array(Math.round((seconds * speed + 3) * RATE));
    const length = Math.round(0.03 * RATE);
    const times: number[] = [];
    // A burst of 30 ms on every second of the file.
    for (let t = 1; t < seconds * speed + 2; t++) {
      times.push(t);
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < length; i++) {
        const w = rnd() * 2 - 1;
        y1 = 0.6 * y1 + 0.4 * w;
        y2 = 0.97 * y2 + 0.03 * w;
        source[Math.round(t * RATE) - length / 2 + i] =
          (y1 - y2) * 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
      }
    }
    const out = stretch([source], steady(speed), 0, seconds * RATE)[0];
    const late: number[] = [];
    for (const t of times) {
      const place = ((t - 0.25) / speed) * RATE;
      if (place < 0.1 * RATE || place > (seconds - 0.1) * RATE) continue;
      // Where the burst's energy lies in the stream, against where the map puts its middle.
      let energy = 0;
      let moment = 0;
      for (let i = Math.round(place - 0.05 * RATE); i < Math.round(place + 0.05 * RATE); i++) {
        energy += out[i] * out[i];
        moment += out[i] * out[i] * i;
      }
      late.push(((moment / energy - place) / RATE) * 1000);
    }
    expect(late.length).toBe(82);
    expect(most(late)).toBeLessThan(15);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean(late.slice(-10)) - mean(late.slice(0, 10)))).toBeLessThan(3);
  });

  it('keeps every click when sound is slowed down, as a few copies close to its place', () => {
    for (const [speed, within] of [
      [0.5, 22],
      [0.75, 12],
    ]) {
      const { length, times, at } = everySoOften(30, speed);
      const out = stretch([clicks(length, times)], steady(speed), 0, 30 * RATE)[0];
      const found = analyseClicks(out, at, clickEnergy());
      expect(found.length).toBeGreaterThan(30);
      // None lost: every one is there at a quarter of its height or more.
      expect(Math.min(...found.map((click) => click.peak)), `${speed}x`).toBeGreaterThanOrEqual(0.2);
      expect(most(found.map((click) => click.late)), `${speed}x`).toBeLessThan(within);
      expect(Math.max(...found.map((click) => click.copies)), `${speed}x`).toBeLessThanOrEqual(3);
      expect(Math.max(...found.map((click) => click.span)), `${speed}x`).toBeLessThan(35);
    }
  });

  it('puts the clicks that survive speeding up within 10 ms of their place, and loses fewer than six in ten', () => {
    for (const speed of [1.5, 2]) {
      const { length, times, at } = everySoOften(30, speed);
      const out = stretch([clicks(length, times)], steady(speed), 0, 30 * RATE)[0];
      const found = analyseClicks(out, at, clickEnergy());
      const present = found.filter((click) => click.peak >= 0.2);
      expect(found.length).toBeGreaterThan(100);
      // A click of a millisecond that falls between two grains taken 15 or 20 ms apart is not
      // played: a third of them at 1.5x, under half at 2x. A stated limit of the method.
      expect(1 - present.length / found.length, `${speed}x`).toBeLessThan(0.6);
      expect(most(present.map((click) => click.late)), `${speed}x`).toBeLessThan(10);
      expect(Math.max(...present.map((click) => click.copies)), `${speed}x`).toBe(1);
    }
  });

  it('keeps every burst that takes 8 ms to die away when sound is sped up, once and in its place', () => {
    for (const speed of [1.5, 2]) {
      const { length, times, at } = everySoOften(30, speed);
      const source = bursts(length, times, 8);
      let energy = 0;
      for (let i = -480; i < 0.04 * RATE; i++) energy += source[Math.round(times[3] * RATE) + i] ** 2;
      const found = analyseClicks(stretch([source], steady(speed), 0, 30 * RATE)[0], at, energy);
      expect(found.length).toBeGreaterThan(100);
      expect(Math.min(...found.map((burst) => burst.peak)), `${speed}x`).toBeGreaterThanOrEqual(0.1);
      expect(Math.max(...found.map((burst) => burst.copies)), `${speed}x`).toBe(1);
      expect(most(found.map((burst) => burst.late)), `${speed}x`).toBeLessThan(10);
      expect(most(found.map((burst) => burst.energy)), `${speed}x`).toBeLessThan(18);
      expect(Math.abs(median(found.map((burst) => burst.energy))), `${speed}x`).toBeLessThan(4);
    }
  });

  it('keeps the level of noise to within 1.2 dB, and its flutter at the rate of the grains under 2.5 dB', () => {
    // Two grains that do not carry on from one another add up in power, not in level: half-way
    // between their centres that is up to 3 dB less than either. Nothing makes up for it, so
    // steady noise comes out 0.3 to 0.9 dB low and 0.5 to 1.9 dB quieter between two grains than
    // at their centres. A stated limit of the method; the two tests below say what it buys.
    const { hop } = grainMeasures(RATE);
    for (const [lo, hi] of [
      [3000, 9000],
      [200, 6000],
    ]) {
      for (const speed of [0.5, 0.8, 1.25, 2]) {
        const source = noise(20 * speed + 3, lo, hi, 5);
        let before = 0;
        for (let i = RATE; i < source.length - RATE; i++) before += source[i] * source[i];
        before /= source.length - 2 * RATE;
        const out = stretch([source], steady(speed, 0.5), 0, 20 * RATE)[0];
        // The power at each tenth of the way from one grain's centre to the next, over all grains.
        const tenths = new Float64Array(10);
        let after = 0;
        for (let i = RATE; i < out.length - RATE; i++) {
          tenths[Math.floor(((i % hop) / hop) * 10)] += out[i] * out[i];
          after += out[i] * out[i];
        }
        after /= out.length - 2 * RATE;
        const what = `${lo} to ${hi} Hz at ${speed}x`;
        expect(Math.abs(10 * Math.log10(after / before)), what).toBeLessThan(1.2);
        expect(10 * Math.log10(Math.max(...tenths) / Math.min(...tenths)), what).toBeLessThan(2.5);
      }
    }
  });

  it('puts nothing at the rate of the grains on a tone that sounds under noise as loud as itself', () => {
    // Why the sum of two unlike grains is not brought up to the level of either: that would be
    // one gain for all that sounds in them. Where a tone and noise sound together it cannot tell
    // them apart, and the tone, which added up already, would be raised half-way between the
    // grains: components at their rate, 100 Hz either side of it, 30 dB under the tone at twice
    // the speed. As it is they lie 44 dB under it or lower.
    for (const speed of [0.5, 0.8, 1.25, 2]) {
      const seconds = 14;
      const hiss = noise(seconds * speed + 3, 3000, 9000, 5);
      // A tone at 0.3 has a level of 0.212, the noise one of 0.1.
      const source = tone(440, seconds * speed + 3, 0.3).map((v, i) => v + 2.12 * hiss[i]);
      const out = stretch([source], steady(speed, 0.5), 0, seconds * RATE)[0];
      const carrier = powerAround(out, 440);
      expect(Math.abs(10 * Math.log10(carrier / powerAround(source, 440))), `${speed}x`).toBeLessThan(0.5);
      for (const hz of [340, 540])
        expect(10 * Math.log10(powerAround(out, hz) / carrier), `${hz} Hz at ${speed}x`).toBeLessThan(-40);
    }
  });

  it('never goes above the highest sample of the file', () => {
    // A sample of the stream is two samples of the file, one of each grain, in shares that add up
    // to one: it is no larger than the larger of the two. Sound that fills its file to full
    // scale stays within full scale, and nothing after the stretcher would hold it back.
    const rnd = random(9);
    const white = Float32Array.from({ length: 24 * RATE }, () => 2 * rnd() - 1);
    // Loud and dense, as a finished mix is: the music and noise, pressed against full scale.
    const { music } = signals();
    const largest = (samples: Float32Array) => samples.reduce((most, v) => Math.max(most, Math.abs(v)), 0);
    const top = largest(music);
    const pressed = white.map((v, i) => Math.tanh(3 * (music[i] / top + 0.3 * v)));
    const full = largest(pressed);
    const mix = pressed.map((v) => v / full);
    const maps = [
      ...[0.5, 0.8, 1.25, 2].map((speed) => ({ how: `${speed}x`, media: steady(speed), end: 10 * RATE })),
      { how: 'the ramp', media: sixPoints.media, end: Math.floor(sixPoints.stream(11.5) * RATE) },
    ];
    for (const [name, source] of [
      ['white noise', white],
      ['a loud mix', mix],
    ] as const) {
      const highest = largest(source);
      expect(highest, name).toBeGreaterThan(0.9999);
      for (const { how, media, end } of maps) {
        const peak = largest(stretch([source], media, 0, end)[0]);
        expect(peak, `${name} at ${how}`).toBeLessThanOrEqual(highest);
        // And it comes that high: the stream is not merely quieter than the file.
        expect(peak, `${name} at ${how}`).toBeGreaterThan(0.99 * highest);
      }
    }
  });

  it('places neighbouring grains where they agree', () => {
    const { speech } = signals();
    const file = counted(speech);
    const { hop } = grainMeasures(RATE);
    for (const [speed, atLeast] of [
      [0.5, 0.94],
      [2, 0.9],
    ]) {
      const media = steady(speed);
      const offsets = grainOffsets(file, media, 24);
      // How alike two neighbours are where the one fades into the other, weighted by how loud
      // they are there: 1 where the second goes on exactly as the first would have.
      let alike = 0;
      let weight = 0;
      for (let k = 1; k < offsets.length; k++) {
        const one = Math.round(RATE * media(((k - 1) * hop) / RATE)) + offsets[k - 1];
        const other = Math.round(RATE * media((k * hop) / RATE)) + offsets[k] - hop;
        let dot = 0;
        let e1 = 0;
        let e2 = 0;
        for (let i = 0; i < hop; i++) {
          dot += speech[one + i] * speech[other + i];
          e1 += speech[one + i] ** 2;
          e2 += speech[other + i] ** 2;
        }
        alike += dot;
        weight += Math.sqrt(e1 * e2);
      }
      expect(alike / weight, `${speed}x`).toBeGreaterThanOrEqual(atLeast);
    }
  });

  it('keeps pitch and place along a ramp', () => {
    const end = Math.floor(sixPoints.stream(11.5) * RATE);
    const found = analyseTone(stretch([tone(440, 13)], sixPoints.media, 0, end)[0], 440);
    expect(Math.abs(found.hz - 440)).toBeLessThan(1);
    expect(found.residue).toBeLessThan(-40);
    expect(found.dip).toBeGreaterThan(-0.2);

    const times: number[] = [];
    for (let t = 0.731; t < 11.4; t += 0.2173) times.push(t);
    const out = stretch([clicks(13, times)], sixPoints.media, 0, end)[0];
    const at = times
      .map((t) => sixPoints.stream(t) * RATE)
      .filter((n) => n > 0.1 * RATE && n < end - 0.1 * RATE);
    const present = analyseClicks(out, at, clickEnergy()).filter((click) => click.peak >= 0.2);
    expect(at.length).toBeGreaterThanOrEqual(45);
    // The ones lost fall between grains where the ramp runs at two and three times the speed.
    expect(present.length).toBeGreaterThan(0.5 * at.length);
    expect(most(present.map((click) => click.late))).toBeLessThan(12);
  });

  it('does something sound at the ends of what it serves: a tenth of the speed, and ten times', () => {
    for (const speed of [0.1, 0.25, 6, 10]) {
      const found = analyseTone(
        stretch([tone(440, 10 * speed + 3)], steady(speed, 0.5), 0, 10 * RATE)[0],
        440,
      );
      expect(found.dip, `${speed}x`).toBeGreaterThan(-0.2);
      expect(found.residue, `${speed}x`).toBeLessThan(-40);
      expect(Math.abs(found.hz - 440), `${speed}x`).toBeLessThan(0.3 + 0.0011 * 440);
    }
    // A low note with its harmonics, where a grain holds only a few periods.
    for (const speed of [0.5, 2]) {
      const found = analyseTone(
        stretch([harmonic(110, 12 * speed + 2, 4000)], steady(speed, 0.5), 0, 12 * RATE)[0],
        110,
      );
      expect(Math.abs(found.hz - 110), `harmonic tone at ${speed}x`).toBeLessThan(0.3 + 0.0011 * 110);
    }
  });

  it('makes silence of silence, and of what lies beyond the file and in its gaps', () => {
    const quiet = stretch([new Float32Array(8 * RATE)], steady(1.7), 0, 4 * RATE)[0];
    expect(quiet).toEqual(new Float32Array(4 * RATE));

    // A file of three seconds played twice as fast: after 1.375 s of stream it has ended.
    const { hop, search } = grainMeasures(RATE);
    const short = [tone(440, 3)];
    const out = stretch(short, steady(2), 0, 4 * RATE)[0];
    const ends = ((3 - 0.25) / 2) * RATE;
    let level = 0;
    for (let n = 0.5 * RATE; n < RATE; n++) level = Math.max(level, Math.abs(out[n]));
    expect(level).toBeGreaterThan(0.45);
    // Nothing of it is repeated to fill what follows: silence from one grain after its end.
    for (let n = Math.ceil(ends) + hop + search; n < out.length; n++) expect(out[n]).toBe(0);

    // The same file with its second second missing gives what the file with silence there gives.
    const whole = tone(440, 3);
    const spelt = Float32Array.from(whole, (v, i) => (i >= RATE && i < 2 * RATE ? 0 : v));
    for (const media of [steady(0.8), steady(2), steady(1, 0)]) {
      const stretcher = new Stretcher(1, RATE, media, 0, 3 * RATE);
      const gapped = new Float32Array(3 * RATE);
      const take = () => {
        for (let got = stretcher.take(); got; got = stretcher.take()) gapped.set(got.data[0], got.first);
      };
      for (let i = 0; i < RATE; i += 1000) stretcher.push(i, [whole.subarray(i, i + 1000)]);
      take();
      for (let i = 2 * RATE; i < 3 * RATE; i += 1000) stretcher.push(i, [whole.subarray(i, i + 1000)]);
      stretcher.finish();
      take();
      expect(gapped).toEqual(stretch([spelt], media, 0, 3 * RATE)[0]);
    }
    // At normal speed that is the file with a second of silence in it.
    expect(stretch([spelt], steady(1, 0), 0, 3 * RATE)[0]).toEqual(spelt);
  });

  it('counts samples given twice the first time only', () => {
    const source = [signals().speech.subarray(0, 3 * RATE)];
    const stretcher = new Stretcher(1, RATE, steady(1, 0), 0, 2 * RATE);
    const out = new Float32Array(2 * RATE);
    stretcher.push(0, [source[0].subarray(0, 50000)]);
    // A buffer that begins a hundred samples before the last one ended, with other sound in them.
    const again = source[0].slice(49900, 3 * RATE);
    again.fill(1, 0, 100);
    stretcher.push(49900, [again]);
    stretcher.finish();
    for (let got = stretcher.take(); got; got = stretcher.take()) out.set(got.data[0], got.first);
    expect(out).toEqual(source[0].subarray(0, 2 * RATE));
  });

  it('keeps the channels apart, and places their grains together', () => {
    // A click in the left channel only, over a tone in both: the right channel never hears it.
    const speed = 0.75;
    const { length, times, at } = everySoOften(10, speed);
    const bed = tone(233, length, 0.1);
    const left = clicks(length, times).map((v, i) => v + bed[i]);
    const out = stretch([left, bed], steady(speed), 0, 10 * RATE);
    const found = analyseClicks(out[0], at, clickEnergy());
    expect(Math.min(...found.map((click) => click.peak))).toBeGreaterThan(0.2);
    let loudest = 0;
    for (const v of out[1]) loudest = Math.max(loudest, Math.abs(v));
    expect(loudest).toBeLessThan(0.11);

    // A tone in both channels a quarter of a period apart stays a quarter of a period apart:
    // the two squared add up to the level squared at every sample.
    for (const rate of [RATE, 44100]) {
      const n = Math.round(12 * rate);
      const sine = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 330 * i) / rate));
      const cosine = Float32Array.from(
        { length: n },
        (_, i) => 0.5 * Math.cos((2 * Math.PI * 330 * i) / rate),
      );
      for (const speed of [0.6, 1.9]) {
        const [a, b] = stretch([sine, cosine], steady(speed), 0, 4 * rate, { rate });
        let off = 0;
        for (let i = 0; i < a.length; i++) off = Math.max(off, Math.abs(Math.hypot(a[i], b[i]) - 0.5));
        expect(off, `${speed}x at ${rate} Hz`).toBeLessThan(0.01);
      }
    }
  });

  it('holds one block’s grains of the file, not the file', () => {
    const { hop, search, block } = grainMeasures(RATE);
    // All that the 201 grains of a block can read, in stereo: 4.05 MB.
    const windows = 201 * (3 * hop + 3 * search) * 2 * 4;
    expect(windows).toBe(4052160);
    for (const [speed, atMost] of [
      // Ten times as fast a block spans 20 s of the file, 7.7 MB; its grains read half of that.
      [10, 1.15 * windows],
      // At normal speed and slower the grains overlap: the block's own stretch of the file.
      [1, 2 * block * 2 * 4 * 0.55],
      [0.1, 0.2 * block * 2 * 4],
    ]) {
      const seconds = 6;
      const source = [tone(440, seconds * speed + 3), tone(660, seconds * speed + 3)];
      const media = steady(speed);
      const stretcher = new Stretcher(2, RATE, media, 0, seconds * RATE);
      const [lo, hi] = stretcher.span(0, seconds * RATE);
      let held = 0;
      let given = 0;
      for (let i = Math.max(0, lo); i < Math.min(source[0].length, hi); i += 1024) {
        stretcher.push(
          i,
          source.map((x) => x.subarray(i, i + 1024)),
        );
        held = Math.max(held, stretcher.held);
        for (let got = stretcher.take(); got; got = stretcher.take()) given += got.data[0].length;
      }
      expect(given).toBe(seconds * RATE);
      expect(held, `${speed}x`).toBeLessThan(atMost);
      expect(held, `${speed}x`).toBeGreaterThan(0);
      // And lets go of it all when the last sample wanted has been given.
      expect(stretcher.held).toBe(0);
    }
  });

  it('stretches a second of stereo in well under a twentieth of a second, the first block included', () => {
    const { speech, music } = signals();
    const repeated = (signal: Float32Array, n: number) =>
      Float32Array.from({ length: n }, (_, i) => signal[i % signal.length]);
    for (const speed of [0.25, 0.5, 0.8, 1.25, 2, 4, 10]) {
      const seconds = 8;
      const n = Math.round((seconds * speed + 3) * RATE);
      const source = [repeated(speech, n), repeated(music, n)];
      let best = Infinity;
      for (let rep = 0; rep < 3; rep++) {
        const t0 = performance.now();
        stretch(source, steady(speed), 0, seconds * RATE);
        best = Math.min(best, (performance.now() - t0) / seconds);
      }
      expect(best, `${speed}x`).toBeLessThan(40);

      // After a seek: the block the playhead is in, from nothing, once its stretch of the file is there.
      const media = steady(speed);
      const n0 = 4 * RATE + 1234;
      const [lo, hi] = stretchSpan(RATE, media, n0, n0 + 4096);
      let first = Infinity;
      for (let rep = 0; rep < 3; rep++) {
        const stretcher = new Stretcher(2, RATE, media, n0, n0 + 4096);
        const t0 = performance.now();
        stretcher.push(
          lo,
          source.map((x) => x.subarray(lo, hi)),
        );
        expect(stretcher.take()!.data[0].length).toBe(4096);
        first = Math.min(first, performance.now() - t0);
      }
      expect(first, `first block at ${speed}x`).toBeLessThan(60);
    }
  });
});
