import { describe, expect, it } from 'vitest';
import { AT_REST, meterStep, PEAK_HOLD_MS, type MeterChannel } from '../src/features/audio/meter';
import { LEVELS_TAIL_MS, meterFall } from '../src/features/timeline/levels';

/** The bottom of the mixer's scale, −60 dB: a level under it shows as nothing. */
const FLOOR = 0.001;

/** The channel after frames `apart` ms from each other, each reading `level`. */
function run(from: MeterChannel, level: number, apart: number[]): MeterChannel {
  return apart.reduce((channel, elapsed) => meterStep(channel, level, elapsed), from);
}

const frames = (count: number, apart = 1000 / 60): number[] => Array.from({ length: count }, () => apart);

describe('a channel of the mixer’s meters', () => {
  it('rises with the level at once and falls the way the track headers’ meters do', () => {
    const up = meterStep(AT_REST, 0.8, 16);
    expect(up).toEqual({ shown: 0.8, peak: 0.8, held: 0 });
    const down = meterStep(up, 0.1, 16);
    expect(down.shown).toBe(meterFall(0.8, 0.1, 16));
    expect(down.shown).toBeLessThan(0.8);
    expect(down.shown).toBeGreaterThan(0.1);
  });

  it('holds the mark of a peak while the bar falls, then lets it down to the bar', () => {
    const peak = meterStep(AT_REST, 0.8, 16);
    const held = run(peak, 0, frames(60));
    expect(held.peak).toBe(0.8);
    expect(held.shown).toBeLessThan(0.01);
    // Its time up, the mark is on the bar, and stays on it as the bar goes on falling.
    const released = run(held, 0, frames(13));
    expect(released.held).toBeGreaterThan(PEAK_HOLD_MS);
    expect(released.peak).toBe(released.shown);
    const later = meterStep(released, 0, 16);
    expect(later.peak).toBe(later.shown);
    expect(later.shown).toBeLessThan(released.shown);
  });

  it('holds a new peak from the moment the bar rises to it', () => {
    const quiet = run(meterStep(AT_REST, 0.8, 16), 0.05, frames(90));
    expect(quiet.peak).toBe(quiet.shown);
    const loud = meterStep(quiet, 0.5, 16);
    expect(loud).toEqual({ shown: 0.5, peak: 0.5, held: 0 });
    expect(run(loud, 0.05, frames(30)).peak).toBe(0.5);
  });

  it('is at rest when the levels stop being read after playback, however few frames were drawn', () => {
    const clipping = meterStep(AT_REST, 2, 16);
    for (const tail of [frames(Math.ceil(LEVELS_TAIL_MS / (1000 / 60))), [700, 800], [LEVELS_TAIL_MS]]) {
      const end = run(clipping, 0, tail);
      expect(end.shown).toBeLessThan(FLOOR);
      expect(end.peak).toBe(end.shown);
    }
  });
});
