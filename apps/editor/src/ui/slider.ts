/** What the keyboard does to a slider, the same for every control that is one. */

export interface SliderRange {
  min: number;
  max: number;
  /** The grid values keep to, and the size of one step. Without it a step is a hundredth of the range. */
  step?: number;
  /** The value Delete goes back to, where there is one. */
  defaultValue?: number;
}

/**
 * The value a key asks for, starting from `from`. Left and Down, Right and Up move by one step and
 * by ten with Shift; Page Up and Page Down by a tenth of the range; Home and End go to its ends;
 * Delete, or Backspace where a keyboard has no other, goes back to the default. `null` is a key
 * that is the slider's and has nothing to do (Delete where there is no default); `undefined` is a
 * key that is not the slider's at all.
 */
export function sliderKey(
  key: string,
  shift: boolean,
  from: number,
  { min, max, step, defaultValue }: SliderRange,
): number | null | undefined {
  const span = max - min;
  const unit = step || span / 100;
  const page = Math.max(unit, span / 10);
  let by: number;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      by = unit * (shift ? 10 : 1);
      break;
    case 'ArrowLeft':
    case 'ArrowDown':
      by = -unit * (shift ? 10 : 1);
      break;
    case 'PageUp':
      by = page;
      break;
    case 'PageDown':
      by = -page;
      break;
    case 'Home':
      return min;
    case 'End':
      return max;
    case 'Delete':
    case 'Backspace':
      return defaultValue ?? null;
    default:
      return undefined;
  }
  let to = from + by;
  if (step) to = Math.round(to / step) * step;
  // Sums of fractions come out a hair off (0.1 + 0.02): not something to store or to read out.
  to = Number(to.toPrecision(12));
  // A value can lie beyond the range (typed into the field beside the slider, where more is
  // allowed). A step is relative: towards the range it is taken from where the value is, and away
  // from it there is nowhere to go. Pulled to the nearest end, "more" would come out as less.
  return Math.min(Math.max(max, from), Math.max(Math.min(min, from), to));
}

/**
 * Whether a key going down belongs to a slider that has the keyboard: one of the keys `sliderKey`
 * answers, or Shift on its way to one. With Ctrl, Alt or the command key held, the same keys are
 * the editor's shortcuts.
 */
export function isSliderKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key === 'Shift' || sliderKey(e.key, false, 0, { min: 0, max: 1 }) !== undefined;
}
