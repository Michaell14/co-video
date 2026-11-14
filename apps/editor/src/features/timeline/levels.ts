/**
 * The audio level meters of a player, read once per animation frame however many meters show them.
 * Reading the levels asks the analyser of every audio track and of both master channels, so a
 * meter that read them for itself would make that cost grow with the square of the track count.
 */
import type { Player } from '@tandem/engine';

export type Levels = ReturnType<Player['levels']>;
/** Told the levels, and how many milliseconds have passed since it was last told them. */
type Listener = (levels: Levels, elapsed: number) => void;

/** The part of a player the meters need. */
export type Metered = Pick<Player, 'levels' | 'getState' | 'subscribe'>;

/**
 * How long the meters go on being told after playback has stopped. The levels are silence by then:
 * the time is for the meters to fall back and for a peak that is held to let go.
 */
export const LEVELS_TAIL_MS = 1500;

/** What a falling meter keeps of its reading over one frame at sixty a second. */
const FALL = 0.9;
const FALL_MS = 1000 / 60;

/**
 * What a meter shows next: a louder level at once, a quieter one only after falling to it, the way
 * meters are meant to move. The fall goes by the time that has passed and not by the frames drawn
 * in it. However few those are (a busy page, a slow display), a meter falls as fast, and the time
 * it is told for after playback has stopped brings it to rest from full scale.
 */
export function meterFall(shown: number, level: number, elapsed: number): number {
  return Math.max(level, shown * FALL ** (elapsed / FALL_MS));
}

interface Watch {
  listeners: Set<Listener>;
  frame: number;
  stop: () => void;
}

const watches = new WeakMap<Metered, Watch>();

/**
 * Call `fn` with the player's levels on every animation frame while it plays, and for a moment
 * after it stops: until LEVELS_TAIL_MS have passed, however few frames are drawn in that time.
 * All watchers of one player share one loop and one reading, and nothing runs while the player is
 * at rest. Returns the function that stops the watching.
 */
export function watchLevels(player: Metered, fn: Listener): () => void {
  let watch = watches.get(player);
  if (!watch) {
    const listeners = new Set<Listener>();
    let quietSince: number | null = null;
    /** When the watchers were last told, while the loop runs. */
    let told: number | null = null;
    const tick = () => {
      const now = performance.now();
      if (player.getState().playing) quietSince = null;
      else quietSince ??= now;
      const levels = player.levels();
      const elapsed = now - (told ?? now);
      for (const listener of Array.from(listeners)) listener(levels, elapsed);
      const more = now - (quietSince ?? now) < LEVELS_TAIL_MS;
      told = more ? now : null;
      created.frame = more ? requestAnimationFrame(tick) : 0;
    };
    const wake = () => {
      if (!created.frame && player.getState().playing) created.frame = requestAnimationFrame(tick);
    };
    const unsubscribe = player.subscribe(wake);
    const created: Watch = {
      listeners,
      frame: 0,
      stop: () => {
        unsubscribe();
        cancelAnimationFrame(created.frame);
        created.frame = 0;
      },
    };
    watches.set(player, (watch = created));
    wake();
  }
  const { listeners, stop } = watch;
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size) return;
    stop();
    watches.delete(player);
  };
}
