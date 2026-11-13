/**
 * The keyboard for the panels' own slider-like controls (colour wheels, curve points, faders):
 * the keys and the undo step of the kit's `Slider`, for controls that draw themselves.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { beginGesture } from '../../state/props';
import { KEY_RUN_MS } from '../../ui/core';
import { sliderKey, type SliderRange } from '../../ui/slider';

export interface KeyRun {
  /** Call before a key press writes: the first press of a run opens the undo step. */
  press: () => void;
  /** The control has lost the keyboard: the next press begins a new run. */
  rest: () => void;
}

/**
 * A run of key presses on one control is one interaction, as one drag is: the presses that follow
 * each other within `KEY_RUN_MS` are written as merged commits into the undo step the first of
 * them opened.
 */
export function useKeyRun(): KeyRun {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rest = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const press = useCallback(() => {
    if (timer.current === null) beginGesture();
    else clearTimeout(timer.current);
    timer.current = setTimeout(() => (timer.current = null), KEY_RUN_MS);
  }, []);
  useEffect(() => rest, [rest]);
  return { press, rest };
}

/** With these the same keys are the editor's shortcuts, not the control's. */
export const isShortcut = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey || e.altKey;

/**
 * A key the control answers stays with it, also where it has nothing to do: an arrow must not go
 * on to step the playhead, nor Delete to remove the selected clips.
 */
export function keepKey(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

interface SliderKeys extends SliderRange {
  value: number;
  /** Writes the value a key asked for; it belongs to the undo step of the run of presses. */
  onChange: (value: number) => void;
  label: string;
  /** The value as it is read out. */
  valueText: string;
}

/**
 * What makes the handle of a vertical fader a slider for the keyboard and for assistive
 * technology. The pointer works the fader as a whole and never lands on the handle (it takes no
 * pointer events), so a press does not leave the keyboard there: the arrow keys stay the editor's
 * for someone using the mouse.
 */
export function useFaderKeys({ value, onChange, label, valueText, ...range }: SliderKeys) {
  const run = useKeyRun();
  return {
    role: 'slider',
    tabIndex: 0,
    'aria-label': label,
    'aria-orientation': 'vertical',
    'aria-valuemin': range.min,
    'aria-valuemax': range.max,
    'aria-valuenow': value,
    'aria-valuetext': valueText,
    onBlur: run.rest,
    onKeyDown: (e: KeyboardEvent) => {
      if (isShortcut(e)) return;
      const next = sliderKey(e.key, e.shiftKey, value, range);
      if (next === undefined) return;
      keepKey(e);
      if (next === null) return;
      run.press();
      onChange(next);
    },
  } as const;
}
