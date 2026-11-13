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
  let to: number;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      to = from + unit * (shift ? 10 : 1);
      break;
    case 'ArrowLeft':
    case 'ArrowDown':
      to = from - unit * (shift ? 10 : 1);
      break;
    case 'PageUp':
      to = from + page;
      break;
    case 'PageDown':
      to = from - page;
      break;
    case 'Home':
      to = min;
      break;
    case 'End':
      to = max;
      break;
    case 'Delete':
    case 'Backspace':
      return defaultValue ?? null;
    default:
      return undefined;
  }
  if (step) to = Math.round(to / step) * step;
  // Sums of fractions come out a hair off (0.1 + 0.02): not something to store or to read out.
  return Math.min(max, Math.max(min, Number(to.toPrecision(12))));
}
