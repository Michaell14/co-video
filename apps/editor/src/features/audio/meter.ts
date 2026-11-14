/** What one channel of a mixer meter shows: a bar that follows the level, and the mark of its last peak. */
import { meterFall } from '../timeline/levels';

/** How long the peak mark stays where the bar last rose to, before it comes down to the bar. */
export const PEAK_HOLD_MS = 1200;

export interface MeterChannel {
  /** The level the bar stands at. */
  shown: number;
  /** The level the peak mark stands at. */
  peak: number;
  /** Milliseconds the mark has been held there. */
  held: number;
}

export const AT_REST: MeterChannel = { shown: 0, peak: 0, held: 0 };

/**
 * The channel `elapsed` milliseconds on, with `level` read. The bar rises at once and falls the
 * way the track headers' meters do. The mark is held where the bar last rose to, and when its time
 * is up it comes down to the bar and stays on it until the bar rises again. It is not held a
 * second time on the way down: the levels are read for a moment after playback has stopped
 * (`LEVELS_TAIL_MS`, which is longer than the hold), and at the end of that moment the mark has to
 * be at rest with the bar, however few frames were drawn in it.
 */
export function meterStep(was: MeterChannel, level: number, elapsed: number): MeterChannel {
  const shown = meterFall(was.shown, level, elapsed);
  if (shown >= was.peak) return { shown, peak: shown, held: 0 };
  const held = was.held + elapsed;
  return { shown, peak: held > PEAK_HOLD_MS ? shown : was.peak, held };
}
