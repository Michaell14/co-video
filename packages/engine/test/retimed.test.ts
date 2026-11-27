import { describe, expect, it } from 'vitest';
import type { WrappedAudioBuffer } from 'mediabunny';
import { Resampler, reachNear } from '../src/audio/resample';
import { Reader, Retimed, readSpan, type Sounding, type TimeMap } from '../src/audio/retimed';
import type { SoundTrouble } from '../src/audio/sound';

const RATE = 48000;
const BLOCK = 4096;
/** The furthest a kernel of the reader's reaches (see `kernelNear`). */
const REACH = 1723;

/** One speed throughout: second `at` of the file plays at second 0 of the stream. */
const steady = (speed: number, at = 0): TimeMap => ({
  media: (tau) => at + speed * tau,
  stream: (m) => (m - at) / speed,
  speed: () => speed,
});

/**
 * A ramp: at second `m` of the file the speed is `v`; between two points it eases from the one
 * speed to the other in time, and outside the points it holds. Second `at` of the file plays at
 * second 0 of the stream.
 */
function ramp(points: { m: number; v: number }[], at: number): TimeMap {
  const n = points.length;
  const clock = [0];
  const took: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    took.push((2 * (points[i + 1].m - points[i].m)) / (points[i].v + points[i + 1].v));
    clock.push(clock[i] + took[i]);
  }
  const segment = (t: number): number => {
    let i = 0;
    while (i + 2 < n && clock[i + 1] <= t) i++;
    return i;
  };
  const mediaOf = (t: number): number => {
    if (t <= 0) return points[0].m + t * points[0].v;
    if (t >= clock[n - 1]) return points[n - 1].m + (t - clock[n - 1]) * points[n - 1].v;
    const i = segment(t);
    const u = (t - clock[i]) / took[i];
    const rise = (points[i + 1].v - points[i].v) * took[i] * (u * u * u - (u * u * u * u) / 2);
    return points[i].m + points[i].v * (t - clock[i]) + rise;
  };
  const speedOf = (t: number): number => {
    if (t <= 0) return points[0].v;
    if (t >= clock[n - 1]) return points[n - 1].v;
    const i = segment(t);
    const u = (t - clock[i]) / took[i];
    return points[i].v + (points[i + 1].v - points[i].v) * (3 * u * u - 2 * u * u * u);
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
  return {
    media: (tau) => mediaOf(base + tau),
    stream: (m) => clockOf(m) - base,
    speed: (tau) => speedOf(base + tau),
  };
}

const tone = (hz: number, n: number, amp = 0.5, rate = RATE): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

function noise(n: number, seed = 7): Float32Array {
  return Float32Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 20001) / 20000 - 0.5;
  });
}

/** Stream samples `[n0, n1)` of a file read along `map`, its samples pushed in pieces of `piece`. */
function along(
  channels: Float32Array[],
  map: TimeMap,
  n0: number,
  n1: number,
  piece = 4096,
  rate = RATE,
): Float32Array[] {
  const reader = new Reader(channels.length, rate, map, n0, n1);
  const out = channels.map(() => new Float32Array(n1 - n0));
  let given = n0;
  const take = () => {
    for (let got = reader.take(); got; got = reader.take()) {
      expect(got.first).toBe(given);
      got.data.forEach((samples, c) => out[c].set(samples, got.first - n0));
      given += got.data[0].length;
    }
  };
  const [lo, hi] = readSpan(rate, map.media, n0, n1);
  const end = Math.min(channels[0].length, hi);
  for (let i = Math.max(0, lo); i < end; i += piece) {
    reader.push(
      i,
      channels.map((x) => x.subarray(i, Math.min(end, i + piece))),
    );
    take();
  }
  reader.finish();
  take();
  expect(given).toBe(n1);
  return out;
}

const db = (power: number): number => 10 * Math.log10(power + 1e-30);

describe('Reader', () => {
  it('reads a tone along a ramp as the tone at every moment’s own place, with nothing else above −90 dB', () => {
    for (const [from, to, seconds, tones, bound] of [
      [0.25, 4, 6, [1000, 3000], -90],
      [4, 0.25, 6, [1000, 3000], -90],
      [0.5, 2, 4, [1000, 3000], -90],
      [1, 10, 8, [1000], -80],
      [10, 1, 8, [1000], -80],
    ] as const) {
      const map = ramp(
        [
          { m: 1, v: from },
          { m: 1 + seconds, v: to },
        ],
        0.5,
      );
      const n = Math.floor(map.stream(1.5 + seconds) * RATE);
      for (const hz of tones) {
        const out = along([tone(hz, Math.ceil((seconds + 2.5) * RATE))], map, 0, n)[0];
        let rest = 0;
        for (let i = 2000; i < n - 2000; i++)
          rest += (out[i] - 0.5 * Math.sin(2 * Math.PI * hz * map.media(i / RATE))) ** 2;
        expect(db(rest / (n - 4000) / 0.125), `${hz} Hz, ${from}x to ${to}x`).toBeLessThan(bound);
      }
    }
  });

  it('keeps out what the speed lifts above half the sample rate', () => {
    // 3 kHz played ten times as fast is 30 kHz, which would fold back to 18 kHz.
    const out = along([tone(3000, 12 * RATE)], steady(10, 0.5), 0, RATE)[0];
    let peak = 0;
    for (let i = 2000; i < out.length - 2000; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(20 * Math.log10(peak / 0.5 + 1e-30)).toBeLessThan(-80);
    // 1 kHz becomes 10 kHz and is kept.
    const kept = along([tone(1000, 12 * RATE)], steady(10, 0.5), 0, RATE)[0];
    let rest = 0;
    for (let i = 2000; i < RATE - 2000; i++)
      rest += (kept[i] - 0.5 * Math.sin(2 * Math.PI * 1000 * (0.5 + (10 * i) / RATE))) ** 2;
    expect(db(rest / (RATE - 4000) / 0.125)).toBeLessThan(-80);
  });

  it('gives the same samples however the source is cut into pieces, and wherever reading starts', () => {
    const source = [noise(70000), noise(70000, 99)];
    const map = ramp(
      [
        { m: 0.2, v: 0.4 },
        { m: 0.5, v: 3 },
        { m: 0.9, v: 1 },
        { m: 1.2, v: 7 },
      ],
      0.05,
    );
    const n = Math.floor(map.stream(1.4) * RATE);
    const whole = along(source, map, 0, n, 70000);
    for (const piece of [1, 7, 1024, 4801])
      expect(along(source, map, 0, n, piece), `pieces of ${piece}`).toEqual(whole);
    for (const start of [1, 4097, Math.floor(n / 2), n - 300]) {
      const late = along(source, map, start, n, 1024);
      expect(late, `from ${start}`).toEqual(whole.map((samples) => samples.subarray(start)));
    }
    // A stretch from the middle on its own, as a read after a seek makes it.
    const piece = along(source, map, 10000, 23456, 333);
    expect(piece).toEqual(whole.map((samples) => samples.subarray(10000, 23456)));
  });

  it('puts a click where the map says, to within half a sample', () => {
    const map = ramp(
      [
        { m: 0.1, v: 0.5 },
        { m: 0.4, v: 2 },
        { m: 0.7, v: 0.8 },
      ],
      0.02,
    );
    const n = Math.floor(map.stream(0.9) * RATE);
    for (const at of [3001, 9000, 14321, 22222, 30000, 40001]) {
      const click = new Float32Array(48000);
      click[at] = 1;
      const out = along([click], map, 0, n)[0];
      let peak = 0;
      for (let i = 1; i < n; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
      expect(Math.abs(peak - map.stream(at / RATE) * RATE), `sample ${at}`).toBeLessThanOrEqual(0.5);
    }
  });

  it('passes a steady level through a ramp unchanged, and at normal speed gives the file itself', () => {
    const resting = ramp(
      [
        { m: 1, v: 0.5 },
        { m: 2, v: 1 },
        { m: 3, v: 1 },
        { m: 4, v: 3 },
      ],
      0.5,
    );
    const level = along(
      [new Float32Array(6 * RATE).fill(0.25)],
      resting,
      0,
      Math.floor(resting.stream(4.5) * RATE),
    )[0];
    for (let i = 0; i < level.length; i++) expect(Math.abs(level[i] - 0.25)).toBeLessThan(1e-6);
    // Through the kernel a tone keeps its level to within the ripple of the pass band: 104 dB
    // under the tone, which for a tone a fifth of full scale is a millionth.
    for (const hz of [100, 440, 1000, 5000, 15000]) {
      const source = tone(hz, 3 * RATE, 0.15);
      const out = along([source], steady(1, 0.25), 0, 2 * RATE)[0];
      let worst = 0;
      for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - source[i + RATE / 4]));
      expect(worst, `${hz} Hz`).toBeLessThan(1e-6);
      expect(worst / 0.15, `${hz} Hz`).toBeLessThan(6e-6);
    }
  });

  it('gives at one speed what the conversion of a clip at that speed gives', () => {
    const source = Float32Array.from(
      tone(1000, RATE),
      (v, i) => v + 0.5 * Math.sin((2 * Math.PI * 3000 * i) / RATE),
    );
    for (const step of [0.25, 44100 / 48000, 1.37, 3]) {
      const count = Math.floor((RATE - 4000) / step);
      const resampler = new Resampler(1, 2000, step, 0, count);
      const converted = new Float32Array(count);
      for (const out of [resampler.push([source]), resampler.finish()])
        if (out) converted.set(out.data[0], out.first);
      const read = along([source], steady(step, 2000 / RATE), 0, count)[0];
      let worst = 0;
      for (let i = 0; i < count; i++) worst = Math.max(worst, Math.abs(read[i] - converted[i]));
      // The same kernel at normal speed and slower: the last bit of a sample at most. Faster, the
      // reader's kernel is the next wider one, and the two differ by the ripple of their pass bands.
      expect(worst, `step ${step}`).toBeLessThan(step > 1 ? 1e-5 : 1e-7);
    }
  });

  it('makes no jump at a point of the ramp', () => {
    const map = ramp(
      [
        { m: 1, v: 0.5 },
        { m: 2, v: 2 },
        { m: 2.5, v: 2 },
        { m: 3.5, v: 0.7 },
        { m: 4, v: 4 },
      ],
      0.5,
    );
    const n = Math.floor(map.stream(4.5) * RATE);
    for (const hz of [440, 1000, 3000]) {
      const out = along([tone(hz, 6 * RATE)], map, 0, n)[0];
      let worst = 0;
      for (let i = 2000; i < n - 2000; i++) {
        // The steepest a clean tone of the pitch heard at this moment can climb in one sample.
        const steepest = (0.5 * 2 * Math.PI * hz * map.speed(i / RATE)) / RATE;
        worst = Math.max(worst, Math.abs(out[i] - out[i - 1]) / steepest);
      }
      expect(worst, `${hz} Hz`).toBeLessThanOrEqual(1.02);
    }
  });

  it('reads silence outside the file and in its gaps', () => {
    const map = steady(1.5, -0.01);
    const source = new Float32Array(3000).fill(1);
    const reader = new Reader(1, RATE, map, 0, 6000);
    const out = new Float32Array(6000);
    const take = () => {
      for (let got = reader.take(); got; got = reader.take()) out.set(got.data[0], got.first);
    };
    // The file begins at stream sample 320; its samples 1000 to 2000 are missing.
    reader.push(0, [source.subarray(0, 1000)]);
    take();
    reader.push(2000, [source.subarray(2000)]);
    take();
    reader.finish();
    take();
    const place = (sample: number) => Math.round(map.stream(sample / RATE) * RATE);
    for (let n = 0; n < place(0) - 40; n++) expect(out[n]).toBe(0);
    expect(Math.abs(out[place(500)] - 1)).toBeLessThan(1e-3);
    for (let n = place(1000) + 40; n < place(2000) - 40; n++) expect(out[n]).toBe(0);
    expect(Math.abs(out[place(2500)] - 1)).toBeLessThan(1e-3);
    for (let n = place(3000) + 40; n < 6000; n++) expect(out[n]).toBe(0);
  });

  it('reads a second of stereo at ten times the speed in well under a tenth of a second', () => {
    const source = [tone(440, 22 * RATE), tone(997, 22 * RATE)];
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const t0 = performance.now();
      along(source, steady(10, 0.5), 0, 2 * RATE);
      best = Math.min(best, (performance.now() - t0) / 2);
    }
    expect(best).toBeLessThan(80);
  });
});

/** A decoded buffer, and the buffer `Retimed` is to hand on: only what the mixer reads of one. */
function buffer(channels: Float32Array[], rate: number): AudioBuffer {
  return {
    length: channels[0].length,
    sampleRate: rate,
    numberOfChannels: channels.length,
    duration: channels[0].length / rate,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

/**
 * A decoder's buffers of `piece` samples over `channels`. The file's sample `at` is their first;
 * `nudge` moves the time of buffer `b` by so many samples.
 */
function decoded(
  channels: Float32Array[],
  { rate = RATE, piece = 1024, start = 0, at = 0, nudge = (_b: number): number => 0 } = {},
): WrappedAudioBuffer[] {
  const out: WrappedAudioBuffer[] = [];
  for (let i = 0, b = 0; i < channels[0].length; i += piece, b++) {
    const part = channels.map((x) => x.subarray(i, i + piece));
    out.push({
      buffer: buffer(part, rate),
      timestamp: start + (at + i + nudge(b)) / rate,
      duration: part[0].length / rate,
    });
  }
  return out;
}

/** A file's sound over `all` that answers as `Sound` does, and counts what is asked of it. */
function soundOver(
  all: WrappedAudioBuffer[],
  rate: number | null = all[0].buffer.sampleRate,
  troubles: SoundTrouble[] = [],
) {
  const stats = { asked: [] as [number, number][], open: 0, pulled: 0 };
  const sound: Sounding = {
    rate,
    buffers(from, to, report) {
      stats.asked.push([from!, to!]);
      stats.open++;
      return (async function* () {
        try {
          for (const trouble of troubles) report(trouble);
          // The buffer that holds `from`, then every one that starts before `to`.
          const first = Math.max(
            0,
            all.findLastIndex((wb) => wb.timestamp <= from!),
          );
          for (let i = first; i < all.length && all[i].timestamp < to!; i++) {
            stats.pulled++;
            yield all[i];
          }
        } finally {
          stats.open--;
        }
      })();
    },
  };
  return { sound, stats };
}

/**
 * A file's sound as `Sound` gives it where the decoder it begins with hands over to the browser's
 * own: the first decode gives `few` buffers of `before`, from the one that holds what was asked
 * for, and then `after` from where those end. Once a buffer of `after` has been given every decode
 * gives `after` alone, unless the decoder is one that begins every decode like that (`always`).
 * `rate` is that of the buffer given last. Before its first buffer the decode of ask `ask`
 * reports `lost(ask)` and waits for `wait(ask)`.
 */
function handingOver(
  before: WrappedAudioBuffer[],
  after: WrappedAudioBuffer[],
  few: number,
  {
    always = false,
    rate = null as number | null,
    lost = (_ask: number): SoundTrouble[] => [],
    wait = async (_ask: number): Promise<void> => {},
  } = {},
) {
  const stats = { asked: [] as [number, number][], open: 0, most: 0, pulled: 0 };
  let handed = false;
  const sound: Sounding = {
    get rate() {
      return rate;
    },
    buffers(from, to, report) {
      const ask = stats.asked.push([from!, to!]) - 1;
      stats.most = Math.max(stats.most, ++stats.open);
      const give = function* (all: WrappedAudioBuffer[], pos: number, count: number, end: number) {
        const first = Math.max(
          0,
          all.findLastIndex((wb) => wb.timestamp <= pos),
        );
        for (const wb of all.slice(first, first + count)) {
          if (wb.timestamp >= to!) return;
          // What a decoder gives again on its way to where the one before it stopped is left out.
          if (wb.timestamp >= end - 1e-3) yield wb;
        }
      };
      return (async function* () {
        try {
          for (const trouble of lost(ask)) report(trouble);
          await wait(ask);
          let end = -Infinity;
          if (always || !handed)
            for (const wb of give(before, from!, few, end)) {
              stats.pulled++;
              rate = wb.buffer.sampleRate;
              end = wb.timestamp + wb.duration;
              yield wb;
            }
          for (const wb of give(after, Math.max(from!, end), Infinity, end)) {
            stats.pulled++;
            handed = true;
            rate = wb.buffer.sampleRate;
            yield wb;
          }
        } finally {
          stats.open--;
        }
      })();
    },
  };
  return { sound, stats };
}

/** `sound`, asked no more than `most` times: a read that asked without end would not fail but hang. */
function askedAtMost(sound: Sounding, most: number): Sounding {
  let asks = 0;
  return {
    get rate() {
      return sound.rate;
    },
    buffers(from, to, report) {
      if (++asks > most) throw new Error(`asked more than ${most} times`);
      return sound.buffers(from, to, report);
    },
  };
}

/** The buffers of one read, and the stream samples they hold by their index in the stream. */
async function read(retimed: Retimed, from: number, to: number) {
  const blocks: WrappedAudioBuffer[] = [];
  for await (const wb of retimed.buffers(from, to)) blocks.push(wb);
  return { blocks, ...streamOf(blocks) };
}

function streamOf(blocks: WrappedAudioBuffer[]) {
  const rate = blocks[0]?.buffer.sampleRate ?? RATE;
  const first = blocks.length ? Math.round(blocks[0].timestamp * rate) : 0;
  const channels = blocks[0]?.buffer.numberOfChannels ?? 0;
  const data = Array.from({ length: channels }, () => new Float32Array(blocks.length * BLOCK));
  blocks.forEach((wb, b) => {
    for (let c = 0; c < channels; c++) data[c].set(wb.buffer.getChannelData(c), b * BLOCK);
  });
  /** Stream samples `[n0, n1)` of channel `c`. */
  const samples = (n0: number, n1: number, c = 0) => data[c].subarray(n0 - first, n1 - first);
  return { first, data, samples };
}

/** What a block is, for comparing reads: where it lies and every sample in it. */
const told = (blocks: WrappedAudioBuffer[]) =>
  blocks.map((wb) => ({
    timestamp: wb.timestamp,
    duration: wb.duration,
    rate: wb.buffer.sampleRate,
    data: Array.from({ length: wb.buffer.numberOfChannels }, (_, c) => wb.buffer.getChannelData(c)),
  }));

const sixPoints = [
  { m: 1, v: 1 },
  { m: 3, v: 3 },
  { m: 4.5, v: 0.5 },
  { m: 6, v: 0.5 },
  { m: 8, v: 2 },
  { m: 10, v: 1 },
];

describe('Retimed', () => {
  /** Twelve seconds of a file in stereo: noise on a tone, so that every sample is its own. */
  const file = [noise(12 * RATE, 3), noise(12 * RATE, 11)];
  const hum = tone(220, 12 * RATE, 0.3);
  for (const samples of file) for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * samples[i] + hum[i];

  it('gives buffers of 4096 samples on the stream’s own grid, the ones that cover what was asked for', async () => {
    for (const keepPitch of [false, true]) {
      const { sound, stats } = soundOver(decoded(file));
      const retimed = new Retimed(sound, 0, steady(1.5, 0.25), keepPitch, buffer);
      expect(retimed.rate).toBe(RATE);
      const { blocks } = await read(retimed, 0.3, 1.7);
      // Second 0.3 is stream sample 14 400, in buffer 3; second 1.7 ends with sample 81 599, in buffer 19.
      expect(blocks.map((wb) => wb.timestamp)).toEqual(
        Array.from({ length: 17 }, (_, i) => ((3 + i) * BLOCK) / RATE),
      );
      for (const wb of blocks) {
        expect(wb.duration).toBe(BLOCK / RATE);
        expect(wb.buffer.length).toBe(BLOCK);
        expect(wb.buffer.sampleRate).toBe(RATE);
        expect(wb.buffer.numberOfChannels).toBe(2);
      }
      // One decode, of what those buffers are made from and two samples more each way.
      expect(stats.asked).toHaveLength(1);
      expect(stats.open).toBe(0);
      const place = (n: number) => RATE * (0.25 + (1.5 * n) / RATE);
      const [from, to] = keepPitch
        ? // The block of grains that holds them runs from stream sample 0 to 96 000; a grain reads
          // 25 ms before its place (a hop and twice the search) and 27.5 ms from it on.
          [Math.round(place(0)) - 1200, Math.round(place(96000)) + 1320]
        : // The first and the last sample's places, and the widest kernel's reach around them.
          [Math.floor(place(3 * BLOCK)) - REACH + 1, Math.floor(place(20 * BLOCK - 1)) + REACH + 1];
      expect(stats.asked[0][0]).toBeCloseTo((from - 2) / RATE, 9);
      expect(stats.asked[0][1]).toBeCloseTo((to + 2) / RATE, 9);
    }
    expect(REACH).toBe(reachNear(Infinity));
  });

  it('reads the same samples from the middle as from the start, however the file is cut into buffers', async () => {
    for (const keepPitch of [false, true]) {
      for (const map of [steady(1.3, 0.5), steady(0.6, 0.5), ramp(sixPoints, 0.5)]) {
        const whole = await read(
          new Retimed(soundOver(decoded(file)).sound, 0, map, keepPitch, buffer),
          0,
          6,
        );
        for (const [from, to, piece] of [
          [2.2, 3.1, 1024],
          [3.999, 4.001, 333],
          [0.7, 5.2, 4801],
          [4.5, 6, 97],
        ]) {
          const part = await read(
            new Retimed(soundOver(decoded(file, { piece })).sound, 0, map, keepPitch, buffer),
            from,
            to,
          );
          expect(part.blocks.length).toBeGreaterThan(0);
          for (const wb of part.blocks) {
            const same = whole.blocks.find((other) => other.timestamp === wb.timestamp)!;
            expect(told([wb]), `${from} to ${to}, keep pitch ${keepPitch}`).toEqual(told([same]));
          }
        }
      }
    }
  });

  it('places a decode’s buffers one behind the other when their times round now up and now down', async () => {
    const rate = 44100;
    const source = [noise(4 * rate, 5)];
    // Each buffer's time lies half a sample off, a hair to one side and then to the other: taken
    // at its word, every other buffer would lie a sample further on.
    const nudge = (b: number) => 0.5 + (b % 2 ? 1e-6 : -1e-6);
    const exact = decoded(source, { rate });
    const offGrid = decoded(source, { rate, nudge });
    const atTheirWord = offGrid.map((wb) => Math.round(wb.timestamp * rate));
    expect(atTheirWord.filter((index, b) => index === b * 1024 + 1).length).toBeGreaterThan(50);
    expect(atTheirWord.filter((index, b) => index === b * 1024).length).toBeGreaterThan(50);
    for (const keepPitch of [false, true]) {
      // Whichever buffer a read begins with: an even one, an odd one, the file's first.
      for (const map of [
        steady(1, 0),
        steady(1.7, 0.1),
        steady(0.9, 0.5),
        ramp(sixPoints.slice(0, 3), 0.2),
      ]) {
        const straight = await read(new Retimed(soundOver(exact).sound, 0, map, keepPitch, buffer), 0.1, 1.5);
        const nudged = await read(new Retimed(soundOver(offGrid).sound, 0, map, keepPitch, buffer), 0.1, 1.5);
        expect(told(nudged.blocks)).toEqual(told(straight.blocks));
      }
    }
    // With pitch kept at normal speed the stream is the file: no hole and no sample twice.
    const plain = await read(new Retimed(soundOver(offGrid).sound, 0, steady(1, 0), true, buffer), 0, 3);
    expect(plain.samples(0, 3 * rate)).toEqual(source[0].subarray(0, 3 * rate));
  });

  it('leaves a real gap in the file a gap, and reads it as silence', async () => {
    const source = [noise(4 * RATE, 5)];
    for (const gap of [10, 37, 30000]) {
      // The second half of the file comes `gap` samples late.
      const cut = 2 * RATE;
      const late = [
        ...decoded([source[0].subarray(0, cut)]),
        ...decoded([source[0].subarray(cut)], { at: cut + gap }),
      ];
      const spelt = new Float32Array(source[0].length + gap);
      spelt.set(source[0].subarray(0, cut));
      spelt.set(source[0].subarray(cut), cut + gap);
      for (const keepPitch of [false, true]) {
        for (const map of [steady(1, 0), steady(1.7, 0.1)]) {
          const gapped = await read(new Retimed(soundOver(late).sound, 0, map, keepPitch, buffer), 0, 2.4);
          const whole = await read(
            new Retimed(soundOver(decoded([spelt])).sound, 0, map, keepPitch, buffer),
            0,
            2.4,
          );
          expect(told(gapped.blocks), `a gap of ${gap}`).toEqual(told(whole.blocks));
        }
      }
      const plain = await read(new Retimed(soundOver(late).sound, 0, steady(1, 0), true, buffer), 0, 3);
      expect(plain.samples(0, cut)).toEqual(source[0].subarray(0, cut));
      expect(plain.samples(cut, cut + gap)).toEqual(new Float32Array(gap));
      expect(plain.samples(cut + gap, 3 * RATE)).toEqual(source[0].subarray(cut, 3 * RATE - gap));
    }
  });

  it('gives the same buffers when the file’s sample rate is not known beforehand, or is another', async () => {
    for (const keepPitch of [false, true]) {
      for (const [from, to] of [
        [0.3, 1.7],
        [2.5, 4.6],
      ]) {
        const map = ramp(sixPoints, 0.5);
        const known = soundOver(decoded(file));
        const right = await read(new Retimed(known.sound, 0, map, keepPitch, buffer), from, to);
        expect(right.blocks.length).toBeGreaterThan(10);
        expect(known.stats.asked).toHaveLength(1);

        const unknown = soundOver(decoded(file), null);
        const learnt = await read(new Retimed(unknown.sound, 0, map, keepPitch, buffer), from, to);
        expect(told(learnt.blocks)).toEqual(told(right.blocks));
        // Asked once, from early enough for any rate: more than the right rate needs.
        expect(unknown.stats.asked).toHaveLength(1);
        expect(unknown.stats.asked[0][0]).toBeLessThan(known.stats.asked[0][0]);
        expect(unknown.stats.asked[0][1]).toBeGreaterThan(known.stats.asked[0][1]);

        for (const wrong of [24000, 44100, 96000]) {
          const mistaken = soundOver(decoded(file), wrong);
          const corrected = await read(new Retimed(mistaken.sound, 0, map, keepPitch, buffer), from, to);
          expect(told(corrected.blocks), `taken for ${wrong} Hz`).toEqual(told(right.blocks));
          // At half the rate a read reaches further in seconds and has asked for enough. At twice
          // the rate it has not, and asks once more, for what the rate it has now seen needs.
          // Between the two it depends on where the buffers of either rate happen to begin.
          const asks = mistaken.stats.asked.length;
          if (wrong === 24000) expect(asks).toBe(1);
          if (wrong === 96000) expect(asks).toBe(2);
          if (asks === 1) {
            expect(mistaken.stats.asked[0][0]).toBeLessThanOrEqual(known.stats.asked[0][0]);
            expect(mistaken.stats.asked[0][1]).toBeGreaterThanOrEqual(known.stats.asked[0][1]);
          } else expect(mistaken.stats.asked).toEqual([mistaken.stats.asked[0], known.stats.asked[0]]);
          expect(mistaken.stats.open).toBe(0);
        }
      }
    }
  });

  it('asks again for a file at a lower rate than an unknown rate is allowed for', async () => {
    // At 4 kHz a buffer of the stream is a second long, and the one that holds second 4 begins
    // at second 3.07: earlier than a read that does not know the rate has asked for.
    const rate = 4000;
    const low = [tone(150, 12 * rate, 0.5, rate)];
    for (const keepPitch of [false, true]) {
      const known = soundOver(decoded(low, { rate }));
      const right = await read(new Retimed(known.sound, 0, steady(1.5, 0.5), keepPitch, buffer), 4, 4.05);
      const unknown = soundOver(decoded(low, { rate }), null);
      const learnt = await read(new Retimed(unknown.sound, 0, steady(1.5, 0.5), keepPitch, buffer), 4, 4.05);
      expect(right.blocks.map((wb) => wb.timestamp)).toEqual([(3 * BLOCK) / rate]);
      expect(told(learnt.blocks)).toEqual(told(right.blocks));
      // With pitch kept the two seconds allowed for a block of grains cover it all the same.
      expect(unknown.stats.asked).toHaveLength(keepPitch ? 1 : 2);
      if (!keepPitch) expect(unknown.stats.asked[1]).toEqual(known.stats.asked[0]);
      expect(unknown.stats.open).toBe(0);
    }
  });

  it('gives nothing for a range that is not finite, and does not ask the file', async () => {
    for (const keepPitch of [false, true]) {
      const { sound, stats } = soundOver(decoded(file));
      const retimed = new Retimed(sound, 0, steady(2, 0), keepPitch, buffer);
      for (const [from, to] of [
        [0, Infinity],
        [-Infinity, 1],
        [NaN, 1],
        [0, NaN],
        [Infinity, Infinity],
        [1, 1],
        [2, 1],
      ]) {
        expect((await read(retimed, from, to)).blocks).toEqual([]);
      }
      expect(stats.asked).toEqual([]);
    }
  });

  it('passes on sound that would not decode, at the second of the stream where it would have played', async () => {
    const map = ramp(sixPoints, 0.5);
    const start = 0.021;
    const troubles: SoundTrouble[] = [
      { lost: 'stretch', from: start + 2.5, cause: 'bad packet' },
      { lost: 'rest', from: start + 7, cause: 'worse' },
    ];
    for (const keepPitch of [false, true]) {
      const { sound } = soundOver(decoded(file, { start }), RATE, troubles);
      const heard: SoundTrouble[] = [];
      const retimed = new Retimed(sound, start, map, keepPitch, buffer);
      for await (const wb of retimed.buffers(0, 2, (trouble) => heard.push(trouble))) void wb;
      expect(heard).toHaveLength(2);
      expect(heard[0].lost).toBe('stretch');
      expect(heard[0].cause).toBe('bad packet');
      expect(heard[0].from).toBeCloseTo(map.stream(2.5), 9);
      expect(heard[1]).toEqual({ lost: 'rest', from: map.stream(7), cause: 'worse' });
      expect(map.media(heard[0].from)).toBeCloseTo(2.5, 9);
    }
  });

  it('takes the file’s time zero into account', async () => {
    // The same sound in a file whose timestamps begin at 21 ms: the same stream.
    for (const keepPitch of [false, true]) {
      const map = steady(1.3, 0.5);
      const {
        sound: unmoved,
        stats: { asked },
      } = soundOver(decoded(file));
      const plain = await read(new Retimed(unmoved, 0, map, keepPitch, buffer), 1, 2);
      const { sound, stats } = soundOver(decoded(file, { start: 0.021 }));
      const offset = await read(new Retimed(sound, 0.021, map, keepPitch, buffer), 1, 2);
      expect(told(offset.blocks)).toEqual(told(plain.blocks));
      expect(stats.asked[0][0]).toBeCloseTo(asked[0][0] + 0.021, 9);
      expect(stats.asked[0][1]).toBeCloseTo(asked[0][1] + 0.021, 9);
    }
  });

  it('ends one series of buffers and begins another where the decoded rate changes, both in place', async () => {
    // A second of the file at 48 kHz, then a second at 24 kHz; a click in the middle of each.
    const first = noise(RATE, 5).map((v) => 0.01 * v);
    const second = noise(RATE / 2, 6).map((v) => 0.01 * v);
    first[RATE / 2] = 1;
    second[RATE / 4] = 1;
    const all = [...decoded([first]), ...decoded([second], { rate: RATE / 2, at: RATE / 2 })];

    const map = steady(1.25, 0);
    const blocks: WrappedAudioBuffer[] = [];
    for await (const wb of new Retimed(soundOver(all).sound, 0, map, false, buffer).buffers(0, 1.6))
      blocks.push(wb);
    const fast = blocks.filter((wb) => wb.buffer.sampleRate === RATE);
    const slow = blocks.filter((wb) => wb.buffer.sampleRate === RATE / 2);
    expect(blocks).toEqual([...fast, ...slow]);
    // Each series lies on the grid of its own rate and abuts.
    expect(fast.map((wb) => wb.timestamp)).toEqual(fast.map((_, i) => (i * BLOCK) / RATE));
    expect(slow.map((wb) => Math.round((wb.timestamp * RATE) / 2 / BLOCK))).toEqual(
      slow.map((_, i) => 4 + i),
    );
    expect(slow.at(-1)!.timestamp + slow.at(-1)!.duration).toBeGreaterThanOrEqual(1.6);
    const peakOf = (series: WrappedAudioBuffer[]) => {
      const { first: at, data } = streamOf(series);
      let peak = 0;
      for (let i = 1; i < data[0].length; i++) if (Math.abs(data[0][i]) > Math.abs(data[0][peak])) peak = i;
      return at + peak;
    };
    expect(Math.abs(peakOf(fast) - map.stream(0.5) * RATE)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(peakOf(slow) - (map.stream(1.5) * RATE) / 2)).toBeLessThanOrEqual(0.5);
    // The first series ends where its sound does, the second is silent until its sound begins.
    const ends = Math.round(map.stream(1) * RATE);
    const tail = streamOf(fast);
    expect(tail.first + tail.data[0].length).toBeLessThan(ends + REACH + BLOCK);
    for (let n = ends + 40; n < tail.first + tail.data[0].length; n++)
      expect(tail.data[0][n - tail.first]).toBe(0);
    const head = streamOf(slow);
    for (let n = head.first; n < ends / 2 - 40; n++) expect(head.data[0][n - head.first]).toBe(0);

    // With pitch kept at normal speed each series is its part of the file to the sample.
    const kept: WrappedAudioBuffer[] = [];
    for await (const wb of new Retimed(soundOver(all).sound, 0, steady(1, 0), true, buffer).buffers(0, 2))
      kept.push(wb);
    const one = streamOf(kept.filter((wb) => wb.buffer.sampleRate === RATE));
    const two = streamOf(kept.filter((wb) => wb.buffer.sampleRate === RATE / 2));
    expect(one.samples(0, RATE)).toEqual(first);
    for (let n = RATE; n < one.first + one.data[0].length; n++) expect(one.data[0][n - one.first]).toBe(0);
    expect(two.samples(RATE / 2, RATE)).toEqual(second);
    for (let n = two.first; n < RATE / 2; n++) expect(two.data[0][n - two.first]).toBe(0);

    // And at another speed each click is within 10 ms of its place, in its own series.
    const stretched: WrappedAudioBuffer[] = [];
    for await (const wb of new Retimed(soundOver(all).sound, 0, steady(0.8, 0), true, buffer).buffers(0, 2.5))
      stretched.push(wb);
    const before = stretched.filter((wb) => wb.buffer.sampleRate === RATE);
    const after = stretched.filter((wb) => wb.buffer.sampleRate === RATE / 2);
    expect(stretched).toEqual([...before, ...after]);
    expect(Math.abs(peakOf(before) / RATE - 0.5 / 0.8)).toBeLessThan(0.01);
    expect(Math.abs(peakOf(after) / (RATE / 2) - 1.5 / 0.8)).toBeLessThan(0.01);
  });

  it('ends the read where the sound changes only after all that was asked for', async () => {
    // With pitch kept a read decodes on to the anchor that follows its grains: seconds 0.2 to 1.1
    // of the stream end at second 1.65 of this file, and are made from the file up to second 3
    // and 27.5 ms. The sound changes at second 3.01, in the last buffer the read takes in.
    const map = steady(1.5, 0);
    const cut = 3.01 * RATE;
    const before = decoded([file[0].subarray(0, cut)]);
    const changes = {
      'half the rate': decoded([noise(RATE, 6)], { rate: RATE / 2, at: cut / 2 }),
      'two channels': decoded([noise(RATE, 6), noise(RATE, 8)], { at: cut }),
    };
    const alone = await read(new Retimed(soundOver(before).sound, 0, map, true, buffer), 0.2, 1.1);
    expect(alone.blocks.map((wb) => Math.round((wb.timestamp * RATE) / BLOCK))).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const [what, after] of Object.entries(changes)) {
      const { sound, stats } = soundOver([...before, ...after]);
      const changed = await read(new Retimed(sound, 0, map, true, buffer), 0.2, 1.1);
      // The buffer in which it changes was decoded, and nothing of it is in the stream.
      expect(stats.pulled, what).toBe(before.length + 1);
      expect(told(changed.blocks), what).toEqual(told(alone.blocks));
      expect(stats.open, what).toBe(0);
    }
  });

  /** Twelve seconds of sound as a decoder gives them at `rate`: noise on a tone. */
  const soundAt = (rate: number, seed: number): Float32Array =>
    noise(12 * rate, seed).map((v, i) => 0.2 * v + 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate));
  /**
   * What the decoder a file begins with gives, and what the browser's own gives for the same
   * packets: at another rate, or with another number of channels.
   */
  const handOvers: Record<string, [before: WrappedAudioBuffer[], after: WrappedAudioBuffer[]]> = {
    '22.05 to 44.1 kHz': [
      decoded([soundAt(22050, 21)], { rate: 22050 }),
      decoded([soundAt(44100, 22)], { rate: 44100, piece: 2048 }),
    ],
    '48 to 24 kHz': [decoded([file[0]]), decoded([soundAt(24000, 23)], { rate: 24000, piece: 512 })],
    'one channel to two': [decoded([file[1]]), decoded(file)],
  };
  /** Whether each buffer is the one after the buffer before it, on the grid of one rate. */
  const inOrder = (blocks: WrappedAudioBuffer[]) => {
    const index = (wb: WrappedAudioBuffer) => Math.round((wb.timestamp * wb.buffer.sampleRate) / BLOCK);
    return blocks.every(
      (wb, i) =>
        i === 0 ||
        (wb.buffer.sampleRate === blocks[0].buffer.sampleRate && index(wb) === index(blocks[i - 1]) + 1),
    );
  };

  it('begins anew where the decoder hands over to another format before a buffer is given, and reads as every later read does', async () => {
    for (const [what, [before, after]] of Object.entries(handOvers)) {
      for (const keepPitch of [false, true]) {
        for (const map of [steady(0.5, 0), steady(1.5, 0.25), ramp(sixPoints, 0.5)]) {
          // From the file's first buffer, which a decoder can give before it fails on the next,
          // and from part-way in, where it has given the three it had under way.
          for (const [from, to, few] of [
            [0, 1.2, 1],
            [2.3, 3.4, 3],
          ]) {
            const note = `${what}, keep pitch ${keepPitch}, from ${from}`;
            const plain = soundOver(after);
            const later = await read(new Retimed(plain.sound, 0, map, keepPitch, buffer), from, to);
            const page = handingOver(before, after, few);
            const retimed = new Retimed(page.sound, 0, map, keepPitch, buffer);
            const first = await read(retimed, from, to);
            // Asked twice, the second time for what the format it has now seen needs, with the
            // first decode closed before that.
            expect(page.stats.asked, note).toHaveLength(2);
            expect(page.stats.asked[1], note).toEqual(plain.stats.asked[0]);
            expect(page.stats.most, note).toBe(1);
            expect(page.stats.open, note).toBe(0);
            // One series in the format of every later read, and the very buffers of one.
            expect(first.blocks.length, note).toBeGreaterThan(5);
            expect(inOrder(first.blocks), note).toBe(true);
            expect(told(first.blocks), note).toEqual(told(later.blocks));
            const again = await read(retimed, from, to);
            expect(page.stats.asked, note).toHaveLength(3);
            expect(told(again.blocks), note).toEqual(told(first.blocks));
          }
        }
      }
    }
  });

  it('asks for the rate it sees before it begins anew, when the rate it was told is another', async () => {
    const [before, after] = handOvers['22.05 to 44.1 kHz'];
    for (const keepPitch of [false, true]) {
      const map = steady(1.5, 0.25);
      const later = await read(new Retimed(soundOver(after).sound, 0, map, keepPitch, buffer), 2.3, 3.4);
      // Taken for 96 kHz: too little is asked for 22.05 kHz, and then the format changes.
      const page = handingOver(before, after, 3, { rate: 96000 });
      const first = await read(new Retimed(page.sound, 0, map, keepPitch, buffer), 2.3, 3.4);
      expect(page.stats.asked).toHaveLength(3);
      expect(page.stats.most).toBe(1);
      expect(page.stats.open).toBe(0);
      expect(told(first.blocks)).toEqual(told(later.blocks));
    }
  });

  it('gives two series where a buffer was given before the decoder handed over', async () => {
    const [before, after] = handOvers['48 to 24 kHz'];
    // Half a second of the file from the first decoder: with pitch following speed buffers of the
    // stream have been given by then, and with pitch kept the first block of grains is complete.
    const few = 24;
    const cut = before[few - 1].timestamp + before[few - 1].duration;
    const joined = [...before.slice(0, few), ...after.filter((wb) => wb.timestamp >= cut - 1e-3)];
    for (const keepPitch of [false, true]) {
      const map = steady(keepPitch ? 0.2 : 1.5, 0);
      const page = handingOver(before, after, few);
      const { blocks } = await read(new Retimed(page.sound, 0, map, keepPitch, buffer), 0, 4);
      expect(page.stats.asked).toHaveLength(1);
      expect(page.stats.open).toBe(0);
      const fast = blocks.filter((wb) => wb.buffer.sampleRate === RATE);
      const slow = blocks.filter((wb) => wb.buffer.sampleRate === RATE / 2);
      expect(fast.length).toBeGreaterThan(0);
      expect(slow.length).toBeGreaterThan(0);
      expect(blocks).toEqual([...fast, ...slow]);
      // The second series begins before the last buffer of the first: no single ascending order.
      expect(slow[0].timestamp).toBeLessThan(fast.at(-1)!.timestamp);
      // As the sound of a file that changes there is read, its rate not known beforehand either.
      const joint = soundOver(joined, null);
      const same = await read(new Retimed(joint.sound, 0, map, keepPitch, buffer), 0, 4);
      expect(joint.stats.asked).toEqual(page.stats.asked);
      expect(told(blocks)).toEqual(told(same.blocks));
    }
  });

  it('gives two series where the read begins before the file and the first decoder gave the first of its sound', async () => {
    // A voice that converts asks from a kernel's reach before what it plays. For a clip that
    // starts on its file's first sample the read then begins in the buffer in front of the file,
    // and that one is complete, and given, with the first of the file's sound: as much of it as a
    // kernel reaches where pitch follows speed, 27.5 ms where it is kept. The same read from
    // second 0 has a whole buffer of the stream to make first, and begins anew (see above).
    const from = -0.001;
    const format = (wb: WrappedAudioBuffer) => `${wb.buffer.sampleRate}/${wb.buffer.numberOfChannels}`;
    for (const [what, [before, after]] of Object.entries(handOvers)) {
      const { sampleRate: rate, numberOfChannels } = before[0].buffer;
      // The packet a decoder gives in front of the file's sound: it ends on the first sample.
      const front = decoded(
        Array.from({ length: numberOfChannels }, () => new Float32Array(1024)),
        { rate, at: -1024 },
      );
      for (const keepPitch of [false, true]) {
        for (const map of [steady(0.5, 0), steady(1.5, 0), ramp(sixPoints, 0)]) {
          const note = `${what}, keep pitch ${keepPitch}`;
          const later = await read(new Retimed(soundOver(after).sound, 0, map, keepPitch, buffer), from, 1.2);
          // Nothing of the file's sound from the first decoder: no buffer is complete yet.
          const silent = handingOver([...front, ...before], after, 1);
          const anew = await read(new Retimed(silent.sound, 0, map, keepPitch, buffer), from, 1.2);
          expect(silent.stats.asked, note).toHaveLength(2);
          expect(told(anew.blocks), note).toEqual(told(later.blocks));
          // Two packets of it, 43 ms at 48 kHz: the buffer in front of the file has been given.
          const page = handingOver(before, after, 2);
          const { blocks } = await read(new Retimed(page.sound, 0, map, keepPitch, buffer), from, 1.2);
          expect(page.stats.asked, note).toHaveLength(1);
          expect(page.stats.open, note).toBe(0);
          const one = blocks.filter((wb) => format(wb) === format(before[0]));
          const two = blocks.filter((wb) => format(wb) === format(after[0]));
          expect(one[0].timestamp, note).toBe(-BLOCK / rate);
          expect(two.length, note).toBeGreaterThan(5);
          expect(blocks, note).toEqual([...one, ...two]);
          // As the sound of a file that changes there is read.
          const cut = before[1].timestamp + before[1].duration;
          const joint = soundOver(
            [...before.slice(0, 2), ...after.filter((wb) => wb.timestamp >= cut - 1e-3)],
            null,
          );
          const same = await read(new Retimed(joint.sound, 0, map, keepPitch, buffer), from, 1.2);
          expect(joint.stats.asked, note).toEqual(page.stats.asked);
          expect(told(blocks), note).toEqual(told(same.blocks));
        }
      }
    }
  });

  it('gives two series, having begun anew once, where the sound changes in the same place however often it is decoded', async () => {
    for (const [what, [before, after]] of Object.entries(handOvers)) {
      // The file itself changes format two and a half seconds in.
      const count = Math.round(2.5 / before[0].duration);
      const cut = before[count - 1].timestamp + before[count - 1].duration;
      const joined = [...before.slice(0, count), ...after.filter((wb) => wb.timestamp >= cut - 1e-3)];
      for (const keepPitch of [false, true]) {
        for (const map of [steady(0.5, 0), steady(1.5, 0.25), ramp(sixPoints, 0.5)]) {
          const note = `${what}, keep pitch ${keepPitch}`;
          // A read that begins just before the change has given nothing when it meets it.
          const from = map.stream(cut + 0.01);
          const file = soundOver(joined);
          const once = askedAtMost(file.sound, 4);
          const { blocks } = await read(new Retimed(once, 0, map, keepPitch, buffer), from, from + 1.2);
          // Once anew for the change, and once more where that ask was not sized for the rate
          // the file begins with: the last ask is then the first again.
          const asks = file.stats.asked;
          expect(asks.length, note).toBeGreaterThanOrEqual(2);
          expect(asks.length, note).toBeLessThanOrEqual(3);
          if (asks.length === 3) expect(asks[2], note).toEqual(asks[0]);
          expect(file.stats.open, note).toBe(0);
          const format = (wb: WrappedAudioBuffer) => `${wb.buffer.sampleRate}/${wb.buffer.numberOfChannels}`;
          const one = blocks.filter((wb) => format(wb) === format(before[0]));
          const two = blocks.filter((wb) => format(wb) === format(after[0]));
          expect(one.length, note).toBeGreaterThan(0);
          expect(two.length, note).toBeGreaterThan(5);
          expect(blocks, note).toEqual([...one, ...two]);
          expect(inOrder(one) && inOrder(two), note).toBe(true);
          // The buffers of a read that had given some when it came to the change, and so read on.
          const early = soundOver(joined);
          const whole = await read(
            new Retimed(early.sound, 0, map, keepPitch, buffer),
            from - 2.5,
            from + 1.2,
          );
          expect(early.stats.asked, note).toHaveLength(1);
          expect(whole.blocks.length, note).toBeGreaterThan(blocks.length + 5);
          // In every sample that was asked for. Behind those, the last buffer of the second
          // series holds as much as the ask reached, and an ask sized for its rate reaches further.
          const wanted = (wb: WrappedAudioBuffer) => {
            const rate = wb.buffer.sampleRate;
            const at = Math.round(wb.timestamp * rate);
            const [lo, hi] = [Math.floor(from * rate) - at, Math.ceil((from + 1.2) * rate) - at];
            return told([wb]).map((block) => ({
              ...block,
              data: block.data.map((samples) => samples.subarray(Math.max(0, lo), Math.min(BLOCK, hi))),
            }));
          };
          for (const wb of blocks) {
            const same = whole.blocks.find(
              (other) => format(other) === format(wb) && other.timestamp === wb.timestamp,
            )!;
            expect(wanted(wb), note).toEqual(wanted(same));
          }
        }
      }
    }
  });

  it('comes to an end with a decoder that changes format a few buffers into every decode', async () => {
    const [before, after] = handOvers['22.05 to 44.1 kHz'];
    for (const keepPitch of [false, true]) {
      const page = handingOver(before, after, 2, { always: true });
      const retimed = new Retimed(askedAtMost(page.sound, 8), 0, steady(1.5, 0.25), keepPitch, buffer);
      const first = await read(retimed, 2.3, 3.4);
      // Anew once, and before and after that once more for a rate the ask was not sized for:
      // four asks at most. This read did not know the rate, and its first ask allowed for any.
      expect(page.stats.asked).toHaveLength(3);
      // With pitch following speed the two buffers of the first format reach into the first
      // buffer of the stream. With pitch kept they lie a block of grains before it.
      const slow = first.blocks.filter((wb) => wb.buffer.sampleRate === 22050);
      const fast = first.blocks.filter((wb) => wb.buffer.sampleRate === 44100);
      expect(slow).toHaveLength(keepPitch ? 0 : 1);
      expect(fast.length).toBeGreaterThan(10);
      expect(first.blocks).toEqual([...slow, ...fast]);
      // A read that knows the rate the file ends on gives the same.
      const second = await read(retimed, 2.3, 3.4);
      expect(page.stats.asked).toHaveLength(7);
      expect(page.stats.asked.slice(5)).toEqual(page.stats.asked.slice(1, 3));
      expect(told(second.blocks)).toEqual(told(first.blocks));
      expect(page.stats.most).toBe(1);
      expect(page.stats.open).toBe(0);
    }
  });

  it('tells once of sound that would not decode, by the decode its buffers are made from', async () => {
    const [before, after] = handOvers['22.05 to 44.1 kHz'];
    const map = steady(1.5, 0.25);
    const stretch: SoundTrouble = { lost: 'stretch', from: 4.2, cause: 'bad packet' };
    const other: SoundTrouble = { lost: 'stretch', from: 4.4, cause: 'another' };
    const heardOf = async (sound: Sounding, keepPitch: boolean) => {
      const events: (SoundTrouble | 'buffer')[] = [];
      const retimed = new Retimed(sound, 0, map, keepPitch, buffer);
      for await (const wb of retimed.buffers(2.3, 3.4, (trouble) => events.push(trouble))) {
        void wb;
        events.push('buffer');
      }
      return events;
    };
    const there = { ...stretch, from: map.stream(4.2) };
    for (const keepPitch of [false, true]) {
      // Both decoders lose the stretch: it is told once, before the first buffer.
      const both = await heardOf(handingOver(before, after, 3, { lost: () => [stretch] }).sound, keepPitch);
      expect(both.filter((event) => event !== 'buffer')).toEqual([there]);
      expect(both[0]).toEqual(there);
      // The decoder that was given up lost it, and the one the buffers are made from did not.
      const first = await heardOf(
        handingOver(before, after, 3, { lost: (ask) => (ask === 0 ? [stretch] : []) }).sound,
        keepPitch,
      );
      expect(first.every((event) => event === 'buffer')).toBe(true);
      expect(first.length).toBeGreaterThan(5);
      // Each loses something of its own: what the second lost is told, and only that.
      const each = await heardOf(
        handingOver(before, after, 3, { lost: (ask) => [ask === 0 ? stretch : other] }).sound,
        keepPitch,
      );
      expect(each.filter((event) => event !== 'buffer')).toEqual([{ ...other, from: map.stream(4.4) }]);
      // A read that asks again for the rate it sees tells once as well.
      const mistaken = soundOver(after, 96000, [stretch]);
      const resized = await heardOf(mistaken.sound, keepPitch);
      expect(mistaken.stats.asked).toHaveLength(2);
      expect(resized.filter((event) => event !== 'buffer')).toEqual([there]);
    }
  });

  it('tells of what a decode lost before the decode failed, and of what is lost once buffers are given as it is lost', async () => {
    const all = decoded(file);
    const early: SoundTrouble = { lost: 'stretch', from: 0.4, cause: 'bad packet' };
    const late: SoundTrouble = { lost: 'stretch', from: 1.9, cause: 'worse' };
    const map = steady(1.5, 0.25);
    for (const keepPitch of [false, true]) {
      const failing: Sounding = {
        rate: RATE,
        async *buffers(_from, _to, report) {
          report(early);
          yield all[0];
          throw new Error('the file went away');
        },
      };
      const heard: SoundTrouble[] = [];
      const gone = new Retimed(failing, 0, map, keepPitch, buffer).buffers(0, 1, (trouble) =>
        heard.push(trouble),
      );
      await expect(gone.next()).rejects.toThrow('the file went away');
      expect(heard).toEqual([{ ...early, from: map.stream(0.4) }]);

      // Sound lost a second and a half into the file: the buffers before it have been given.
      const events: (SoundTrouble | 'buffer')[] = [];
      const losing: Sounding = {
        rate: RATE,
        async *buffers(from, to, report) {
          for (const wb of all) {
            if (wb.timestamp + wb.duration <= from! || wb.timestamp >= to!) continue;
            if (wb === all[90]) report(late);
            yield wb;
          }
        },
      };
      const retimed = new Retimed(losing, 0, steady(keepPitch ? 0.2 : 1.5, 0), keepPitch, buffer);
      for await (const wb of retimed.buffers(0, 12, (trouble) => events.push(trouble))) {
        void wb;
        events.push('buffer');
      }
      const at = events.findIndex((event) => event !== 'buffer');
      expect(at).toBeGreaterThan(0);
      expect(events.filter((event) => event !== 'buffer')).toHaveLength(1);
      expect(events.length - at).toBeGreaterThan(1);
    }
  });

  it('ends whichever decode is open when the read is ended while it begins anew, or right after', async () => {
    const [before, after] = handOvers['22.05 to 44.1 kHz'];
    for (const keepPitch of [false, true]) {
      // The second decode waits before its first buffer: the read is ended while it does.
      let waiting = () => {};
      let letGo = () => {};
      const asked = new Promise<void>((resolve) => (waiting = resolve));
      const gate = new Promise<void>((resolve) => (letGo = resolve));
      const held = handingOver(before, after, 3, {
        wait: async (ask) => {
          if (ask === 0) return;
          waiting();
          await gate;
        },
      });
      const buffers = new Retimed(held.sound, 0, steady(1.5, 0.25), keepPitch, buffer).buffers(2.3, 3.4);
      const first = buffers.next();
      await asked;
      expect(held.stats.asked).toHaveLength(2);
      expect(held.stats.open).toBe(1);
      const ended = buffers.return();
      letGo();
      await Promise.all([first, ended]);
      expect(held.stats.open).toBe(0);
      expect(held.stats.most).toBe(1);
      expect((await buffers.next()).done).toBe(true);
      expect(held.stats.asked).toHaveLength(2);

      // After the first buffer of the read begun anew: the second decode is the one open.
      const page = handingOver(before, after, 3);
      const again = new Retimed(page.sound, 0, steady(1.5, 0.25), keepPitch, buffer).buffers(2.3, 6);
      expect((await again.next()).done).toBe(false);
      expect(page.stats.asked).toHaveLength(2);
      expect(page.stats.open).toBe(1);
      await again.return();
      expect(page.stats.open).toBe(0);
    }
  });

  it('gives the page a turn between the buffers of a decode it gives up and of the one that follows', async () => {
    const [before, after] = handOvers['48 to 24 kHz'];
    for (const keepPitch of [false, true]) {
      const page = handingOver(before, after, 3);
      let busy = false;
      let turns = 0;
      let overlaps = 0;
      const turn = async () => {
        busy = true;
        await new Promise((done) => setTimeout(done, 0));
        busy = false;
        turns++;
      };
      const inner: Sounding = {
        get rate() {
          return page.sound.rate;
        },
        async *buffers(from, to, report) {
          for await (const wb of page.sound.buffers(from, to, report)) {
            if (busy) overlaps++;
            yield wb;
          }
        },
      };
      const retimed = new Retimed(inner, 0, steady(1.5, 0.25), keepPitch, buffer, turn);
      for await (const wb of retimed.buffers(2.3, 2.6)) {
        if (busy) overlaps++;
        void wb;
      }
      expect(page.stats.asked).toHaveLength(2);
      expect(overlaps).toBe(0);
      // After every decoded buffer of both decodes but the one that completes the read.
      expect(turns).toBe(page.stats.pulled - 1);
    }
  });

  it('reads silence before the file where the stream begins earlier, and counts stream samples below zero', async () => {
    const source = [file[0].subarray(0, 4 * RATE)];
    // Second 0 of the file plays at second 0.25 of the stream.
    const late = await read(
      new Retimed(soundOver(decoded(source)).sound, 0, steady(1, -0.25), true, buffer),
      0,
      1,
    );
    expect(late.first).toBe(0);
    expect(late.samples(0, RATE / 4)).toEqual(new Float32Array(RATE / 4));
    expect(late.samples(RATE / 4, RATE)).toEqual(source[0].subarray(0, (3 * RATE) / 4));
    const smooth = [tone(440, 4 * RATE)];
    const through = await read(
      new Retimed(soundOver(decoded(smooth)).sound, 0, steady(1, -0.25), false, buffer),
      0,
      1,
    );
    for (let n = 0; n < RATE / 4 - 40; n++) expect(through.data[0][n]).toBe(0);
    for (let n = RATE / 4 + 40; n < RATE; n++)
      expect(Math.abs(through.data[0][n] - smooth[0][n - RATE / 4])).toBeLessThan(1e-4);

    // Second 0.25 of the file plays at second 0 of the stream: what lies before it has negative
    // stream time, and buffers that begin before zero.
    const early = await read(
      new Retimed(soundOver(decoded(source)).sound, 0, steady(1, 0.25), true, buffer),
      -0.3,
      0.3,
    );
    expect(early.blocks[0].timestamp).toBe((-4 * BLOCK) / RATE);
    expect(early.blocks.map((wb) => Math.round((wb.timestamp * RATE) / BLOCK))).toEqual([
      -4, -3, -2, -1, 0, 1, 2, 3,
    ]);
    expect(early.samples(-RATE / 4, 3 * BLOCK)).toEqual(source[0].subarray(0, RATE / 4 + 3 * BLOCK));
    expect(early.samples(-4 * BLOCK, -RATE / 4)).toEqual(new Float32Array(4 * BLOCK - RATE / 4));
  });

  it('gives buffers of silence where the file has ended, and nothing where it gives nothing', async () => {
    const short = [file[0].subarray(0, RATE)];
    for (const keepPitch of [false, true]) {
      const past = await read(
        new Retimed(soundOver(decoded(short)).sound, 0, steady(1, 0), keepPitch, buffer),
        0.5,
        3,
      );
      expect(past.blocks).toHaveLength(
        Math.floor((3 * RATE - 1) / BLOCK) - Math.floor((0.5 * RATE) / BLOCK) + 1,
      );
      for (let n = RATE + 40; n < 3 * RATE; n++) expect(past.data[0][n - past.first]).toBe(0);
      const none: Sounding = {
        rate: RATE,
        async *buffers() {},
      };
      expect((await read(new Retimed(none, 0, steady(1, 0), keepPitch, buffer), 0, 1)).blocks).toEqual([]);
    }
  });

  it('comes to an end, with nothing but numbers, on a map that is no map', async () => {
    const maps: Record<string, TimeMap> = {
      'no number': { media: () => NaN, stream: () => NaN, speed: () => NaN },
      'no end': { media: () => Infinity, stream: () => Infinity, speed: () => Infinity },
      'standing still': { media: () => 1, stream: () => 0, speed: () => 0 },
      backwards: { media: (tau) => 3 - tau, stream: (m) => 3 - m, speed: () => -1 },
      'beyond any file': { media: (tau) => 1e300 * tau, stream: (m) => m / 1e300, speed: () => 1e300 },
    };
    for (const [name, map] of Object.entries(maps)) {
      for (const keepPitch of [false, true]) {
        const { sound, stats } = soundOver(decoded([file[0]]));
        const { blocks } = await read(new Retimed(sound, 0, map, keepPitch, buffer), 0.5, 3);
        for (const wb of blocks)
          expect(wb.buffer.getChannelData(0).every(Number.isFinite), `${name}, keep pitch ${keepPitch}`).toBe(
            true,
          );
        expect(stats.open).toBe(0);
      }
    }
  });

  it('gives the page a turn between decoded buffers, and waits for it', async () => {
    for (const keepPitch of [false, true]) {
      const { sound, stats } = soundOver(decoded(file));
      let busy = false;
      let turns = 0;
      let overlaps = 0;
      const turn = async () => {
        busy = true;
        await new Promise((done) => setTimeout(done, 0));
        busy = false;
        turns++;
      };
      const inner: Sounding = {
        rate: RATE,
        async *buffers(from, to, report) {
          for await (const wb of sound.buffers(from, to, report)) {
            if (busy) overlaps++;
            yield wb;
          }
        },
      };
      const retimed = new Retimed(inner, 0, steady(1.5, 0.25), keepPitch, buffer, turn);
      for await (const wb of retimed.buffers(0.3, 0.6)) {
        if (busy) overlaps++;
        void wb;
      }
      expect(overlaps).toBe(0);
      expect(stats.pulled).toBeGreaterThan(10);
      // After every decoded buffer but the one that completes the read.
      expect(turns).toBe(stats.pulled - 1);
    }
  });

  it('ends the decode when the read is ended', async () => {
    for (const keepPitch of [false, true]) {
      const { sound, stats } = soundOver(decoded(file));
      const buffers = new Retimed(sound, 0, steady(1.5, 0.25), keepPitch, buffer).buffers(0, 6);
      expect((await buffers.next()).done).toBe(false);
      expect(stats.open).toBe(1);
      await buffers.return();
      expect(stats.open).toBe(0);
      expect((await buffers.next()).done).toBe(true);
      // And a read that is run to its end has ended it by itself.
      const whole = soundOver(decoded(file));
      await read(new Retimed(whole.sound, 0, steady(1.5, 0.25), keepPitch, buffer), 0, 1);
      expect(whole.stats.open).toBe(0);
      expect(whole.stats.pulled).toBeLessThan(decoded(file).length);
    }
  });
});
