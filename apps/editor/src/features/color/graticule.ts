/** Where the level marks of a waveform scope and their labels go. */

/** The size the graticule's labels are set in, and the least distance between two of their baselines. */
export const LABEL_PX = 9;
const LABEL_GAP = LABEL_PX + 1;

/** The line of a level (0 at the bottom of the scope, 1 at its top) in a scope `height` pixels high. */
export const levelLine = (level: number, height: number): number =>
  Math.round((1 - level) * (height - 1)) + 0.5;

/**
 * The baseline of the label of each level, or null for a label that is left out. A label sits on
 * its line, or just inside the scope where the line is its edge. `levels` come with the ones to
 * keep first: a label that would print over one before it in the list is left out, and its line
 * alone marks the level. A scope is as low as 60 pixels, and the marks of an HDR scope crowd
 * towards its top, where a grade is read against them.
 */
export function labelBaselines(levels: number[], height: number): (number | null)[] {
  const taken: number[] = [];
  return levels.map((level) => {
    const baseline = Math.min(height - 3, Math.max(LABEL_PX, levelLine(level, height) - 2));
    if (taken.some((other) => Math.abs(other - baseline) < LABEL_GAP)) return null;
    taken.push(baseline);
    return baseline;
  });
}
