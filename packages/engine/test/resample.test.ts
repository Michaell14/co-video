import { describe, expect, it } from 'vitest';
import { FULL_KERNEL_STEP, Resampler, resampleReach } from '../src/audio/resample';

/** Everything `source` gives when read from `origin` at `step`, pushed in pieces of `piece` samples. */
function convert(
  source: Float32Array,
  step: number,
  { origin = 0, first = 0, last = Math.ceil((source.length - origin) / step), piece = 4096 } = {},
): { first: number; data: Float32Array } {
  const r = new Resampler(1, origin, step, first, last);
  const parts: Float32Array[] = [];
  let start = -1;
  const take = (out: ReturnType<Resampler['push']>) => {
    if (!out) return;
    if (start < 0) start = out.first;
    parts.push(out.data[0]);
  };
  for (let i = 0; i < source.length; i += piece) take(r.push([source.subarray(i, i + piece)]));
  take(r.finish());
  const data = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    data.set(p, o);
    o += p.length;
  }
  return { first: Math.max(start, 0), data };
}

const tone = (hz: number, rate: number, n: number, amp = 0.5): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

/** Amplitude of the `hz` component of `x`, and the level of everything else, both in dB re `amp`. */
function analyse(x: Float32Array, hz: number, rate: number, amp: number, from: number, to: number) {
  let ss = 0;
  let sc = 0;
  let cc = 0;
  let ys = 0;
  let yc = 0;
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * hz * i) / rate;
    const s = Math.sin(w);
    const c = Math.cos(w);
    ss += s * s;
    sc += s * c;
    cc += c * c;
    ys += x[i] * s;
    yc += x[i] * c;
  }
  const det = ss * cc - sc * sc;
  const a = (ys * cc - yc * sc) / det;
  const b = (yc * ss - ys * sc) / det;
  let rest = 0;
  for (let i = from; i < to; i++) {
    const w = (2 * Math.PI * hz * i) / rate;
    rest += (x[i] - a * Math.sin(w) - b * Math.cos(w)) ** 2;
  }
  return {
    gain: 20 * Math.log10(Math.hypot(a, b) / amp),
    rest: 10 * Math.log10(rest / (to - from) / ((amp * amp) / 2) + 1e-30),
  };
}

describe('Resampler', () => {
  it('converts 44.1 kHz to 48 kHz flat to 18 kHz, with images and noise more than 80 dB down', () => {
    const step = 44100 / 48000;
    for (const hz of [50, 1000, 5000, 10000, 15000, 17000, 18000]) {
      const out = convert(tone(hz, 44100, 44100), step).data;
      const { gain, rest } = analyse(out, hz, 48000, 0.5, 2000, out.length - 2000);
      expect(Math.abs(gain), `${hz} Hz gain`).toBeLessThan(0.1);
      expect(rest, `${hz} Hz residue`).toBeLessThan(-80);
    }
    // Above the pass band the level falls; the image of such a tone (44.1 kHz minus it) stays out.
    for (const hz of [20000, 21000, 22000]) {
      const out = convert(tone(hz, 44100, 44100), step).data;
      const image = analyse(out, 44100 - hz, 48000, 0.5, 2000, out.length - 2000);
      expect(image.gain, `image of ${hz} Hz`).toBeLessThan(-80);
    }
  });

  it('keeps what lies above the lower Nyquist frequency out when the rate goes down', () => {
    // 48 kHz to 44.1 kHz: 23 kHz would fold back to 21.1 kHz. Double speed: 15 kHz to 18 kHz.
    for (const [step, hz, alias] of [
      [48000 / 44100, 23000, 44100 - 23000],
      [2, 15000 * 2, 48000 - 15000 * 2],
      [4.3, 20000, 20000 - 48000 / 4.3],
    ]) {
      const out = convert(tone(hz, 48000, 96000), step).data;
      const rate = 48000 / step;
      let peak = 0;
      for (let i = 2000; i < out.length - 2000; i++) peak = Math.max(peak, Math.abs(out[i]));
      expect(20 * Math.log10(peak / 0.5 + 1e-30), `${hz} Hz at step ${step}`).toBeLessThan(-80);
      expect(analyse(out, alias, rate, 0.5, 2000, out.length - 2000).gain).toBeLessThan(-80);
    }
    // What lies in the band that remains is kept: 5 kHz at double speed.
    const kept = analyse(convert(tone(5000, 48000, 96000), 2).data, 5000, 24000, 0.5, 2000, 40000);
    expect(Math.abs(kept.gain)).toBeLessThan(0.1);
    expect(kept.rest).toBeLessThan(-80);
  });

  it('gives the same samples however the source is cut into pieces, and wherever the output starts', () => {
    let seed = 7;
    const noise = Float32Array.from({ length: 30000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed % 20001) / 10000 - 1;
    });
    for (const step of [44100 / 48000, 0.5, 1.37, 3]) {
      const whole = convert(noise, step, { piece: 30000 });
      for (const piece of [1, 7, 1024, 4801]) {
        const cut = convert(noise, step, { piece });
        expect(cut.first).toBe(whole.first);
        expect(cut.data).toEqual(whole.data);
      }
      // The second half on its own, as the next chunk of an export renders it.
      const half = Math.floor(whole.data.length / 2);
      const late = convert(noise, step, { first: half });
      expect(late.first).toBe(half);
      expect(late.data).toEqual(whole.data.subarray(half));
    }
  });

  it('converts every channel on its own, however many there are', () => {
    const channels = [300, 700, 1900, 2300, 3100].map((hz) => tone(hz, 44100, 6000));
    const step = 44100 / 48000;
    const alone = channels.map((x) => convert(x, step).data);
    for (const count of [1, 2, 3, 5]) {
      const r = new Resampler(count, 0, step, 0, Math.ceil(6000 / step));
      const head = r.push(channels.slice(0, count).map((x) => x.subarray(0, 2500)))!;
      const tail = r.push(channels.slice(0, count).map((x) => x.subarray(2500)))!;
      const rest = r.finish()!;
      expect(head.first).toBe(0);
      for (let c = 0; c < count; c++) {
        const joined = new Float32Array([...head.data[c], ...tail.data[c], ...rest.data[c]]);
        expect(joined, `channel ${c} of ${count}`).toEqual(alone[c]);
      }
    }
  });

  it('puts a click where it belongs', () => {
    const click = new Float32Array(4000);
    click[1234] = 1;
    for (const [step, origin] of [
      [44100 / 48000, 0],
      [48000 / 44100, 0.37],
      [0.25, -3.5],
      [2, 100],
    ]) {
      const { first, data } = convert(click, step, { origin });
      let peak = 0;
      for (let i = 1; i < data.length; i++) if (Math.abs(data[i]) > Math.abs(data[peak])) peak = i;
      expect(Math.abs(first + peak - (1234 - origin) / step), `step ${step}`).toBeLessThanOrEqual(0.5);
    }
  });

  it('passes a steady level through unchanged at every position between samples', () => {
    const level = new Float32Array(3000).fill(0.25);
    for (const step of [44100 / 48000, 0.731, 1.9, 6.5]) {
      const { data } = convert(level, step);
      for (let i = 400; i < data.length - 400; i++) expect(Math.abs(data[i] - 0.25)).toBeLessThan(1e-6);
    }
  });

  it('reaches further into the source the faster it is read, within bounds', () => {
    expect(resampleReach(44100 / 48000)).toBe(32);
    expect(resampleReach(0.25)).toBe(32);
    expect(resampleReach(2)).toBe(64);
    expect(resampleReach(4)).toBe(128);
    // From here on the kernel gives up lobes instead of growing with the speed.
    expect(FULL_KERNEL_STEP).toBe(4);
    expect(resampleReach(8)).toBe(128);
    expect(resampleReach(16)).toBe(128);
    expect(resampleReach(100)).toBe(800);
  });

  it('reads silence outside the source instead of repeating its edge', () => {
    const step = 44100 / 48000;
    const { first, data } = convert(new Float32Array(500).fill(1), step, { origin: -200, last: 2000 });
    // The source begins at output sample 200 / step = 218 and ends at 700 / step = 762; the
    // kernel reaches 32 source samples further on each side.
    expect(first).toBeGreaterThan(218 - 40);
    expect(first + data.length).toBeLessThan(762 + 40);
    expect(Math.abs(data[0])).toBeLessThan(0.01);
    expect(Math.abs(data[data.length - 1])).toBeLessThan(0.01);
    expect(Math.abs(data[490 - first] - 1)).toBeLessThan(0.01);
  });
});
