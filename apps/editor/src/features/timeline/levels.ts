/**
 * The audio level meters of a player, read once per animation frame however many meters show them.
 * Reading the levels asks the analyser of every audio track and of both master channels, so a
 * meter that read them for itself would make that cost grow with the square of the track count.
 */
import type { Player } from '@tandem/engine';

export type Levels = ReturnType<Player['levels']>;
type Listener = (levels: Levels) => void;

/** The part of a player the meters need. */
export type Metered = Pick<Player, 'levels' | 'getState' | 'subscribe'>;

/**
 * How long the meters go on being told after playback has stopped. The levels are silence by then:
 * the time is for the meters to fall back and for a peak that is held to let go.
 */
export const LEVELS_TAIL_MS = 1500;

interface Watch {
  listeners: Set<Listener>;
  frame: number;
  stop: () => void;
}

const watches = new WeakMap<Metered, Watch>();

/**
 * Call `fn` with the player's levels on every animation frame while it plays, and for a moment
 * after it stops. All watchers of one player share one loop and one reading, and nothing runs
 * while the player is at rest. Returns the function that stops the watching.
 */
export function watchLevels(player: Metered, fn: Listener): () => void {
  let watch = watches.get(player);
  if (!watch) {
    const listeners = new Set<Listener>();
    let quietSince: number | null = null;
    const tick = () => {
      const now = performance.now();
      if (player.getState().playing) quietSince = null;
      else quietSince ??= now;
      const levels = player.levels();
      for (const listener of Array.from(listeners)) listener(levels);
      created.frame = now - (quietSince ?? now) < LEVELS_TAIL_MS ? requestAnimationFrame(tick) : 0;
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
