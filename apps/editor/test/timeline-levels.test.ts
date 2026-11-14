import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEVELS_TAIL_MS,
  meterFall,
  watchLevels,
  type Levels,
  type Metered,
} from '../src/features/timeline/levels';

/** A player that counts how often its levels are read, and animation frames that run when told to. */
function stage() {
  const listeners = new Set<() => void>();
  const player = {
    playing: false,
    reads: 0,
    levels(): Levels {
      this.reads++;
      return { master: [0.5, 0.5], tracks: { a1: this.playing ? 0.25 : 0 } };
    },
    getState() {
      return { playing: this.playing } as ReturnType<Metered['getState']>;
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    play(on: boolean) {
      this.playing = on;
      for (const fn of listeners) fn();
    },
    watched: () => listeners.size,
  };
  let queued: (() => void)[] = [];
  let now = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => queued.push(fn));
  vi.stubGlobal('cancelAnimationFrame', () => {
    queued = [];
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  /** Run `count` animation frames, `apart` ms apart. Returns how many of them had something to run. */
  const frames = (count: number, apart = 16): number => {
    let ran = 0;
    for (let i = 0; i < count; i++) {
      now += apart;
      const run = queued;
      queued = [];
      if (run.length) ran++;
      for (const fn of run) fn();
    }
    return ran;
  };
  return { player, frames };
}

describe('the shared level meters', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('read the levels once a frame however many meters watch, and tell them all', () => {
    const { player, frames } = stage();
    const seen: number[] = [0, 0, 0];
    const stops = seen.map((_, i) => watchLevels(player, (levels) => (seen[i] = levels.tracks.a1)));
    expect(player.watched()).toBe(1);
    player.play(true);
    expect(frames(10)).toBe(10);
    expect(player.reads).toBe(10);
    expect(seen).toEqual([0.25, 0.25, 0.25]);
    for (const stop of stops) stop();
    expect(player.watched()).toBe(0);
    expect(frames(5)).toBe(0);
  });

  it('do nothing while the player is at rest, and stop a moment after it has stopped', () => {
    const { player, frames } = stage();
    let told = 0;
    let last = 1;
    const stop = watchLevels(player, (levels) => {
      told++;
      last = levels.tracks.a1;
    });
    expect(frames(20)).toBe(0);
    expect(player.reads).toBe(0);
    player.play(true);
    frames(5);
    player.play(false);
    // The meters are told of the silence for long enough to fall back, and then left alone.
    const tail = frames(500);
    expect(tail).toBeGreaterThan(LEVELS_TAIL_MS / 16 - 2);
    expect(tail).toBeLessThan(LEVELS_TAIL_MS / 16 + 2);
    expect(last).toBe(0);
    const reads = player.reads;
    expect(frames(50)).toBe(0);
    expect(player.reads).toBe(reads);
    expect(told).toBe(reads);
    // Playing again wakes them.
    player.play(true);
    expect(frames(3)).toBe(3);
    stop();
  });

  it.each([16, 33, 100, 700, 4000])(
    'bring a meter to rest after playback with frames %d ms apart',
    (apart) => {
      const { player, frames } = stage();
      // A meter as the track headers keep one, at full scale when playback stops.
      let shown = 0;
      let passed = 0;
      const stop = watchLevels(player, (levels, elapsed) => {
        shown = player.playing ? 1 : meterFall(shown, levels.tracks.a1, elapsed);
        if (!player.playing) passed += elapsed;
      });
      player.play(true);
      frames(5, apart);
      expect(shown).toBe(1);
      player.play(false);
      // Told until the time to fall back has passed, however few frames that takes.
      expect(frames(500, apart)).toBe(Math.ceil(LEVELS_TAIL_MS / apart) + 1);
      expect(passed).toBeGreaterThanOrEqual(LEVELS_TAIL_MS);
      // Quieter than this a track's meter shows an empty bar.
      expect(shown).toBeLessThan(10 ** (-48 / 20));
      expect(frames(10, apart)).toBe(0);
      stop();
    },
  );

  it('let a meter fall as fast at any frame rate, and not at all in no time', () => {
    const at60 = Array.from({ length: 30 }).reduce<number>((shown) => meterFall(shown, 0, 1000 / 60), 1);
    const at30 = Array.from({ length: 15 }).reduce<number>((shown) => meterFall(shown, 0, 1000 / 30), 1);
    expect(at60).toBeCloseTo(0.9 ** 30, 10);
    expect(at30).toBeCloseTo(at60, 10);
    expect(meterFall(0.5, 0, 0)).toBe(0.5);
    // Up at once with a louder level, and never below the level there is.
    expect(meterFall(0.2, 0.8, 16)).toBe(0.8);
    expect(meterFall(0.5, 0.49, 16)).toBe(0.49);
  });
});
