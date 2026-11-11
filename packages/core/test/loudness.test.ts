import { describe, expect, it } from 'vitest';
import { LoudnessMeter, normalizationGain } from '../src';

function sine(freq: number, dbfs: number, seconds: number, rate: number): Float32Array {
  const amp = Math.pow(10, dbfs / 20);
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function measure(planes: Float32Array[], rate: number, chunk = 4096) {
  const m = new LoudnessMeter(rate, planes.length);
  for (let i = 0; i < planes[0].length; i += chunk) m.push(planes.map((p) => p.subarray(i, i + chunk)));
  return m.result();
}

describe('BS.1770 loudness', () => {
  // EBU Tech 3341, test signals 1 and 2: a stereo 1 kHz sine at −23 / −33 dBFS reads the same in LUFS.
  it.each([
    [48000, -23],
    [48000, -33],
    [44100, -23],
    [96000, -23],
  ])('stereo 1 kHz sine at %i Hz, %i dBFS', (rate, level) => {
    const tone = sine(1000, level, 20, rate);
    const r = measure([tone, tone], rate);
    expect(r.lufs).toBeCloseTo(level, 1);
    expect(r.peakDb).toBeCloseTo(level, 1);
    expect(r.seconds).toBeCloseTo(20, 3);
  });

  it('a single channel is 3 LU quieter than the same tone in both', () => {
    const tone = sine(1000, -20, 10, 48000);
    const silent = new Float32Array(tone.length);
    expect(measure([tone, silent], 48000).lufs).toBeCloseTo(-23.01, 1);
  });

  it('gates out silence around the programme (EBU Tech 3341 test 3 pattern)', () => {
    // 10 s at −36, 60 s at −23, 10 s at −36: the quiet parts fall under the relative gate.
    const rate = 48000;
    const parts = [sine(1000, -36, 10, rate), sine(1000, -23, 60, rate), sine(1000, -36, 10, rate)];
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    expect(measure([all, all], rate).lufs).toBeCloseTo(-23, 1);
    // Digital silence either side changes nothing at all.
    const padded = new Float32Array(all.length + rate * 20);
    padded.set(all, rate * 10);
    expect(measure([padded, padded], rate).lufs).toBeCloseTo(-23, 1);
  });

  it('is independent of how the samples are chunked', () => {
    const tone = sine(440, -18, 5, 48000);
    const a = measure([tone, tone], 48000, 128);
    const b = measure([tone, tone], 48000, 48000 * 5);
    expect(a.lufs).toBeCloseTo(b.lufs, 6);
  });

  it('weights low frequencies down', () => {
    const low = measure([sine(50, -20, 10, 48000)], 48000).lufs;
    const mid = measure([sine(1000, -20, 10, 48000)], 48000).lufs;
    expect(mid - low).toBeGreaterThan(3);
    expect(mid - low).toBeLessThan(7);
  });

  it('reports silence and very short clips sensibly', () => {
    expect(measure([new Float32Array(48000)], 48000).lufs).toBe(-Infinity);
    const short = measure([sine(1000, -20, 0.2, 48000)], 48000);
    expect(short.lufs).toBeGreaterThan(-24);
    expect(short.lufs).toBeLessThan(-20);
    expect(normalizationGain(measure([new Float32Array(4800)], 48000), -14)).toBeNull();
  });

  it('normalisation gain respects the peak ceiling', () => {
    expect(normalizationGain({ lufs: -23, peakDb: -20, seconds: 1 }, -14)).toBeCloseTo(9);
    // Dynamic material: +9 dB would clip, so stop 1 dB short of full scale.
    expect(normalizationGain({ lufs: -23, peakDb: -4, seconds: 1 }, -14)).toBeCloseTo(3);
    expect(normalizationGain({ lufs: -9, peakDb: -1, seconds: 1 }, -14)).toBeCloseTo(-5);
  });
});
