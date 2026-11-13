import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVELS_TAIL_MS, watchLevels, type Levels, type Metered } from '../src/features/timeline/levels';

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
  /** Run `count` animation frames, 16 ms apart. Returns how many of them had something to run. */
  const frames = (count: number): number => {
    let ran = 0;
    for (let i = 0; i < count; i++) {
      now += 16;
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
});
