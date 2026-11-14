/* Design-system primitives. Small, dependency-free and keyboard friendly. */
import { Check, ChevronDown } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useDrag } from './dnd';
import {
  focusables,
  isTextEntry,
  isTopLayer,
  layerOpen,
  placePopover,
  placeTip,
  spendKeys,
  trapTab,
  typeAhead,
  useLayer,
  usingKeyboard,
  type PopoverPlace,
} from './layers';
import { isDoublePress, isDrag, type Press } from './press';
import { isSliderKey, sliderKey } from './slider';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Where in the page an event happened. One sent to the window itself happened at no node: it is
 * inside nothing, and `contains` does not take a window for an answer.
 */
const nodeOf = (target: EventTarget | null): Node | null => (target instanceof Node ? target : null);

/** The element an event happened at, when that is `root` or something inside it. */
function within(root: Element, target: EventTarget | null): Element | null {
  return target instanceof Element && root.contains(target) ? target : null;
}

// ──────────────────────────────────────────────────────────────── kbd ──

const KEY_LABELS: Record<string, string> = {
  mod: isMac ? '⌘' : 'Ctrl',
  shift: isMac ? '⇧' : 'Shift',
  alt: isMac ? '⌥' : 'Alt',
  ctrl: isMac ? '⌃' : 'Ctrl',
  space: 'Space',
  delete: isMac ? '⌫' : 'Del',
  backspace: '⌫',
  enter: '↵',
  escape: 'Esc',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  home: 'Home',
  end: 'End',
  equal: '+',
  minus: '−',
  backslash: '\\',
  comma: ',',
  period: '.',
  slash: '/',
  quote: "'",
};

/** Render a shortcut such as `mod+shift+z`. */
export function Kbd({ keys }: { keys: string }) {
  const parts = keys.split('+').map((k) => KEY_LABELS[k] ?? k.toUpperCase());
  return (
    <span className="kbd-group">
      {parts.map((p, i) => (
        <kbd className="kbd" key={i}>
          {p}
        </kbd>
      ))}
    </span>
  );
}

// ──────────────────────────────────────────────────────────── tooltip ──

interface TipState {
  text: ReactNode;
  keys?: string;
  /** The element the tip belongs to, in viewport coordinates. */
  anchor: DOMRect;
  place: 'top' | 'bottom';
}

let showTip: (t: TipState | null) => void = () => {};
let tipTimer: ReturnType<typeof setTimeout> | undefined;
/** Whether a tip is on the screen, and not only waiting to be. */
let tipShown = false;
let lastTipAt = 0;

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    showTip = setTip;
    return () => {
      showTip = () => {};
    };
  }, []);
  // Placed once its size is known, so a tip beside a window edge is moved in rather than cut off.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const { left, top } = placeTip(
      tip.anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      tip.place,
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);
  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" role="tooltip">
      <span>{tip.text}</span>
      {tip.keys && <Kbd keys={tip.keys} />}
    </div>,
    document.body,
  );
}

let unwatchTip = () => {};
/** The element whose tip, waiting or showing, the keyboard asked for by arriving there. */
let keyboardTip: Element | null = null;

/**
 * Follow the element a tooltip belongs to for as long as its tip is waiting or showing. The
 * pointer leaving is not the only way a tip stops being true, and the others send no
 * pointerleave: the element is taken out of the page under a pointer that stays where it is (a
 * tab switched from the keyboard), it scrolls away, or the person turns to the keyboard or to
 * another window. `arrived` is a tip asked for by the keyboard arriving at the element.
 */
function watchTip(anchor: Element, arrived: boolean): void {
  // The pointer coming over the element the keyboard was brought to leaves the tip the
  // keyboard's. It need not have moved for that: scrolled into view, the element may come to
  // lie under a pointer that was resting there.
  const byKeyboard = arrived || keyboardTip === anchor;
  unwatchTip();
  keyboardTip = byKeyboard ? anchor : null;
  const removed = new MutationObserver(() => {
    if (!anchor.isConnected) hideTip();
  });
  removed.observe(document.body, { childList: true, subtree: true });
  const onScroll = (e: Event) => {
    // The window scrolls everything in it.
    if (nodeOf(e.target)?.contains(anchor) ?? true) hideTip();
  };
  const watchScroll = () => window.addEventListener('scroll', onScroll, true);
  // The keyboard arriving at an element scrolls it into view, and the page is told of that
  // scroll with its next frame, ahead of the frame's own callbacks. That scroll is how the
  // element came to be where the tip will point: only the ones after it take the tip away.
  const settled = byKeyboard ? requestAnimationFrame(watchScroll) : 0;
  if (!byKeyboard) watchScroll();
  const onKey = (e: KeyboardEvent) => {
    // Escape pressed on a tip the keyboard brought up asks for the tip to go, and that is all
    // the press does, however long it is held. Passed on, it would drop the editor's selection,
    // and with the selection often the very control the keyboard is on. In a dialog or a menu
    // the key stays theirs: they close for it, and what the tip was on goes with them.
    if (e.key === 'Escape' && byKeyboard && tipShown && !layerOpen()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      spendKeys();
    }
    hideTip();
  };
  // The timeline moves its content under the wheel without scrolling anything.
  window.addEventListener('wheel', hideTip, { capture: true, passive: true });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', hideTip);
  unwatchTip = () => {
    keyboardTip = null;
    removed.disconnect();
    cancelAnimationFrame(settled);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('wheel', hideTip, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', hideTip);
    unwatchTip = () => {};
  };
}

/** Hide any visible tooltip (call from your own pointer-down handler when it replaces the tip's). */
export function hideTip(): void {
  clearTimeout(tipTimer);
  unwatchTip();
  tipShown = false;
  showTip(null);
}

/**
 * Props to spread on any element to give it a tooltip. It shows for the pointer resting on the
 * element and for the keyboard arriving at it: for many icon buttons it is the only label there
 * is to see. Any key pressed afterwards takes it away again (`watchTip`), Escape included.
 */
export function tip(text: ReactNode, keys?: string, place: 'top' | 'bottom' = 'bottom') {
  const show = (anchor: Element, arrived: boolean) => {
    clearTimeout(tipTimer);
    watchTip(anchor, arrived);
    // After the first tooltip, neighbours appear instantly — scanning a toolbar should feel fluid.
    const delay = performance.now() - lastTipAt < 400 ? 0 : 450;
    tipTimer = setTimeout(() => {
      tipShown = true;
      // Measured as the tip appears: the element may have been scrolled into view since the tip
      // was asked for.
      showTip({ text, keys, anchor: anchor.getBoundingClientRect(), place });
    }, delay);
  };
  const leave = () => {
    hideTip();
    lastTipAt = performance.now();
  };
  return {
    onPointerEnter: (e: React.PointerEvent) => {
      // Something carried across the page is on its way to where it will be dropped: what it
      // passes over on the way is not being asked about.
      if (e.pointerType === 'touch' || useDrag.getState().payload) return;
      show(e.currentTarget, false);
    },
    onPointerLeave: leave,
    onPointerDown: hideTip,
    // The capturing handlers, so that an element's own `onFocus` and `onBlur` stay its own
    // whichever is spread last.
    onFocusCapture: (e: React.FocusEvent) => {
      // Focus that a press of the pointer left behind is not a question (a text field shows it
      // as visible all the same), and neither is focus on something inside the element.
      const asked =
        e.target === e.currentTarget && usingKeyboard() && e.currentTarget.matches(':focus-visible');
      if (asked) show(e.currentTarget, true);
    },
    onBlurCapture: (e: React.FocusEvent) => {
      if (e.target === e.currentTarget) leave();
    },
  };
}

// ──────────────────────────────────────────────────────────── buttons ──

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  icon?: ReactNode;
  /** What the button's own press began is still under way; see `whileBusy`. */
  busy?: boolean;
}

/** A press on a busy button is nobody's: not its own, and not that of whatever it stands in. */
const swallow: MouseEventHandler = (e) => {
  e.preventDefault();
  e.stopPropagation();
};

/**
 * What a button carries for as long as what its own press began is under way, in place of being
 * switched off for that time. Switched off it would drop the keyboard: a browser takes focus from
 * a control as it is disabled, and the next Tab starts again from the top of the dialog or the
 * page. A busy button stays where it is and says that it is at work. It only does not act: Enter
 * and Space press a button as the pointer does, and none of them reaches `onClick`.
 *
 * `Button` takes this as its `busy`. A button of another kind (a card pressed as a whole) spreads
 * the result itself.
 */
export function whileBusy<T extends Element>(busy: boolean | undefined, onClick?: MouseEventHandler<T>) {
  return busy ? { 'aria-disabled': true, 'aria-busy': true, onClick: swallow } : { onClick };
}

export function Button({
  variant = 'default',
  size = 'md',
  block,
  icon,
  busy,
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  // Switched off for a reason of its own, it is simply off: nobody is waiting on it.
  const working = !!busy && !rest.disabled;
  return (
    <button
      type="button"
      className={cx(
        'btn',
        variant !== 'default' && `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        block && 'btn--block',
        className,
      )}
      // The spinner stands where the icon was, or in place of the words where there is no icon:
      // either way the button keeps its width (ui.css).
      data-busy={working ? (icon ? 'icon' : 'label') : undefined}
      {...rest}
      {...whileBusy(working, onClick)}
    >
      {working ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  keys?: string;
  active?: boolean;
  small?: boolean;
  tipPlace?: 'top' | 'bottom';
}

export function IconButton({
  label,
  keys,
  active,
  small,
  tipPlace,
  className,
  children,
  ...rest
}: IconButtonProps) {
  const t = tip(label, keys, tipPlace);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-active={active ? 'true' : undefined}
      className={cx('icon-btn', small && 'icon-btn--sm', className)}
      {...rest}
      onPointerEnter={t.onPointerEnter}
      onPointerLeave={t.onPointerLeave}
      onPointerDown={(e) => {
        t.onPointerDown();
        rest.onPointerDown?.(e);
      }}
      onFocusCapture={t.onFocusCapture}
      onBlurCapture={t.onBlurCapture}
    >
      {children}
    </button>
  );
}

// ───────────────────────────────────────────────────────────── labels ──

/** The id of the text that names the controls of the row they are in. */
const LabelCtx = createContext<string | undefined>(undefined);

/**
 * A label and the controls it names: a row of a property panel or of a form. The kit's fields,
 * sliders, selects, switches and segmented controls inside it take their accessible name from its
 * `LabelText`, unless they are given one of their own.
 */
export function Labelled({ className, children }: { className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <LabelCtx.Provider value={id}>
      <div className={className}>{children}</div>
    </LabelCtx.Provider>
  );
}

/**
 * The words of a `Labelled` row's label. Only the words: a button that shares the label's place
 * (a keyframe toggle) stays outside, or its own name would be read as part of every control's.
 */
export function LabelText({ children }: { children: ReactNode }) {
  return <span id={useContext(LabelCtx)}>{children}</span>;
}

/** `aria-label` and `aria-labelledby` for a control: its own name if it has one, else the row's. */
function useName(own: string | undefined, ...parts: (string | false | undefined)[]) {
  const row = useContext(LabelCtx);
  if (own || !row) return { 'aria-label': own };
  return { 'aria-labelledby': [row, ...parts].filter(Boolean).join(' ') };
}

// ───────────────────────────────────────────────────────────── slider ──

export interface GestureProps {
  /** Called once when an interaction begins. */
  onStart?: () => void;
  /** Called once when it ends. */
  onEnd?: () => void;
}

interface SliderProps extends GestureProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Value restored on double-click, and by Delete from the keyboard. */
  defaultValue?: number;
  /** Draw the fill from this value instead of from the minimum (bipolar controls). */
  origin?: number;
  disabled?: boolean;
  /** What the slider sets. In a `Labelled` row it need not be given: the row's label says it. */
  ariaLabel?: string;
  /** The value as it is read out (`L20`, `+3.5 dB`), where the bare number would say too little. */
  valueText?: (value: number) => string;
}

/** Half the thumb's width (`.slider__thumb` in ui.css). */
const SLIDER_INSET = 5.5;

/**
 * A run of key presses on a slider is one interaction, as one drag is, and whoever writes the
 * value makes one undo step of it: `onStart` comes before its first press, `onEnd` once the keys
 * have rested this long, the slider has lost the keyboard or it has been taken away.
 */
export const KEY_RUN_MS = 600;

/**
 * What ends each run of key presses under way, by the thumb the run is on. Any key that is not
 * the slider's own is the keyboard doing something else, and the run is over: a shortcut may
 * select another clip and leave the slider in place, working that clip, or make an edit of its
 * own. Neither that edit nor the presses after it belong in the undo step the run began.
 */
const keyRuns = new Map<() => void, EventTarget>();

if (typeof window !== 'undefined') {
  // Added as the module loads, so it hears of a key ahead of whoever acts on it, and of the keys
  // that someone takes before they reach the slider.
  window.addEventListener(
    'keydown',
    (e) => {
      for (const [end, thumb] of keyRuns) if (e.target !== thumb || !isSliderKey(e)) end();
    },
    true,
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onStart,
  onEnd,
  defaultValue,
  origin,
  disabled,
  ariaLabel,
  valueText,
}: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  // The latest press: whether it was the second of a double-click, and whether it became a drag.
  const press = useRef<(Press & { second: boolean; dragged: boolean }) | null>(null);
  const name = useName(ariaLabel);
  // The timer that ends the run of key presses under way.
  const run = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ended = useRef(onEnd);
  useLayoutEffect(() => {
    ended.current = onEnd;
  });
  const endRun = useCallback(() => {
    if (run.current === null) return;
    clearTimeout(run.current);
    run.current = null;
    keyRuns.delete(endRun);
    ended.current?.();
  }, []);
  // What the last key press asked for, for as long as the value has not moved since. Whoever
  // takes the value may round it, and a press that rounds away leaves the slider where it was:
  // the next press goes on from what was asked, or a slider of whole numbers would never move.
  const asked = useRef<number | null>(null);
  useLayoutEffect(() => {
    asked.current = null;
  }, [value]);
  // A slider taken away in the middle of a run has ended it.
  useEffect(() => endRun, [endRun]);
  const span = max - min || 1;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / span));
  // The thumb stays inside the slider's own box, so its centre travels between the two insets.
  const at = (f: number) => `calc(${SLIDER_INSET}px + ${f} * (100% - ${2 * SLIDER_INSET}px))`;
  const fromX = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const travel = Math.max(1, r.width - 2 * SLIDER_INSET);
    let v = min + ((clientX - r.left - SLIDER_INSET) / travel) * span;
    if (step) v = Math.round(v / step) * step;
    return Math.min(max, Math.max(min, v));
  };
  const o = origin ?? min;
  const a = frac(Math.min(o, value));
  const b = frac(Math.max(o, value));
  return (
    <div
      ref={ref}
      className="slider"
      data-active={active}
      style={disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const prev = press.current;
        const next = { time: e.timeStamp, x: e.clientX, y: e.clientY };
        const second = defaultValue !== undefined && !!prev && !prev.second && isDoublePress(prev, next);
        press.current = { ...next, second, dragged: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        endRun();
        // The second press of a double-click asks for the reset that follows it: jumping to the
        // pointer again would put a second step between the old value and the default. It changes
        // nothing unless it turns into a drag, which carries on the step the first press began.
        if (second) return;
        onStart?.();
        onChange(fromX(e.clientX));
      }}
      onPointerMove={(e) => {
        const held = press.current;
        if (!active || !held) return;
        held.dragged ||= isDrag(held, e.clientX, e.clientY);
        if (held.second && !held.dragged) return;
        onChange(fromX(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!active) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setActive(false);
        onEnd?.();
      }}
      onDoubleClick={() => {
        // The browser goes by the timing of the presses alone: one that became a drag has set a
        // value and is not asking for the default.
        if (defaultValue === undefined || press.current?.dragged) return;
        // No onStart: the reset belongs to the undo step the first press of the double-click began.
        onChange(defaultValue);
        onEnd?.();
      }}
    >
      <div className="slider__track">
        <div
          className="slider__fill"
          style={{ left: a === 0 ? 0 : at(a), right: b === 1 ? 0 : `calc(100% - ${at(b)})` }}
        />
      </div>
      {origin !== undefined && origin > min && origin < max && (
        <div className="slider__center" style={{ left: at(frac(origin)) }} />
      )}
      {/* The thumb is the slider for the keyboard and for assistive technology. The pointer works
          the whole control and never lands on the thumb itself (ui.css), so a press does not
          leave the keyboard here: the arrow keys stay the editor's for someone using the mouse. */}
      <div
        className="slider__thumb"
        style={{ left: at(frac(value)) }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        {...name}
        aria-valuemin={min}
        aria-valuemax={max}
        // A value beyond the range is shown at the end it lies past: the position can say no more.
        aria-valuenow={Number(Math.min(max, Math.max(min, value)).toPrecision(6))}
        aria-valuetext={valueText?.(value)}
        aria-disabled={disabled || undefined}
        onBlur={() => {
          asked.current = null;
          endRun();
        }}
        onKeyDown={(e) => {
          // With these the same keys are the editor's shortcuts.
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const from = asked.current ?? value;
          const next = sliderKey(e.key, e.shiftKey, from, { min, max, step, defaultValue });
          if (next === undefined) return;
          // The slider's keys are its own while it has the keyboard, also where one of them has
          // nothing to do: Delete must not go on to delete the selected clips.
          e.preventDefault();
          e.stopPropagation();
          // Nothing to do: no default to go back to, or the slider is where the key would put it
          // (a step past the end of the range). Writing that again would begin an undo step for
          // nothing, and where the value shown stands in for one beyond the range, replace it.
          if (next === null || next === from) return;
          if (run.current === null) {
            onStart?.();
            keyRuns.set(endRun, e.currentTarget);
          } else clearTimeout(run.current);
          run.current = setTimeout(endRun, KEY_RUN_MS);
          asked.current = next;
          onChange(next);
        }}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────── typed entries ──

/**
 * Fields holding text that is not applied yet. Each is told of every press, to settle on it:
 * where the press was, or `null` for one that was nowhere in the page.
 */
const pendingEntries = new Set<(pressed: Node | null) => void>();

if (typeof window !== 'undefined') {
  // Added as the module loads, so it runs ahead of every listener a component adds: nothing may
  // act on a press (select another clip, close the layer the field is in) before the entry that
  // press ends has been applied.
  window.addEventListener(
    'pointerdown',
    (e) => {
      for (const settle of pendingEntries) settle(nodeOf(e.target));
    },
    true,
  );
}

/**
 * Text typed into `field`, applied when the field is left. Losing focus is too late for a press
 * elsewhere: the press can change what the field stands for (it selects another clip) or take the
 * field away before focus moves, so the entry is applied the moment the press begins, while the
 * field still stands for what the text was typed for. It is applied by the field as it is then,
 * not as it was when the typing began: its handlers write on top of the values they were rendered
 * with, and those may have changed in the meantime. An entry whose field goes away for any other
 * reason goes with it, because what it was typed for is gone.
 */
function useEntry(field: RefObject<HTMLElement | null>, apply: (text: string) => void) {
  const [text, setText] = useState<string | null>(null);
  // Readable in the same tick it changes: Enter and Escape blur the field from inside their own
  // handler, and that blur must see what they just decided.
  const typed = useRef<string | null>(null);
  const edit = (next: string | null) => {
    typed.current = next;
    setText(next);
  };
  const commit = () => {
    const entered = typed.current;
    if (entered === null) return;
    edit(null);
    apply(entered);
  };
  const latest = useRef(commit);
  useLayoutEffect(() => {
    latest.current = commit;
  });
  const pending = text !== null;
  useLayoutEffect(() => {
    if (!pending) return;
    const settle = (pressed: Node | null) => {
      if (!field.current?.contains(pressed)) latest.current();
    };
    pendingEntries.add(settle);
    return () => void pendingEntries.delete(settle);
  }, [pending, field]);
  return { text, edit, commit };
}

// ─────────────────────────────────────────────────────── number field ──

interface NumberFieldProps extends GestureProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** Change per pixel of horizontal drag (and per arrow key press). */
  step?: number;
  precision?: number;
  suffix?: string;
  prefix?: ReactNode;
  /** Display scale: shows value × scale (e.g. 100 for percentages). */
  scale?: number;
  defaultValue?: number;
  disabled?: boolean;
  style?: CSSProperties;
  mixed?: boolean;
  ariaLabel?: string;
}

/** A numeric input you can drag sideways to scrub, like every pro creative tool. */
export function NumberField({
  value,
  onChange,
  onStart,
  onEnd,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  suffix,
  prefix,
  scale = 1,
  defaultValue,
  disabled,
  style,
  mixed,
  ariaLabel,
}: NumberFieldProps) {
  const [scrubbing, setScrubbing] = useState(false);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A letter before the number (W and H, X and Y) tells two fields of one row apart.
  const prefixId = useId();
  const name = useName(ariaLabel, typeof prefix === 'string' && prefixId);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const shown = mixed ? '—' : (value * scale).toFixed(precision);
  const entry = useEntry(inputRef, (text) => {
    const n = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(n)) return;
    onStart?.();
    onChange(clampV(n / scale));
    onEnd?.();
  });

  return (
    <div
      className="field num"
      data-scrubbing={scrubbing}
      style={{ ...style, ...(disabled ? { opacity: 0.4, pointerEvents: 'none' } : null) }}
    >
      {prefix && (
        <span className="field__prefix" id={prefixId}>
          {prefix}
        </span>
      )}
      <input
        ref={inputRef}
        {...name}
        value={entry.text ?? shown}
        data-dirty={entry.text !== null ? '' : undefined}
        inputMode="decimal"
        spellCheck={false}
        onChange={(e) => entry.edit(e.target.value)}
        onBlur={entry.commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            entry.commit();
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            entry.edit(null);
            inputRef.current?.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            entry.edit(null);
            onStart?.();
            onChange(clampV(value + dir * step * mult));
            onEnd?.();
          }
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || document.activeElement === inputRef.current) return;
          e.preventDefault();
          drag.current = { x: e.clientX, v: value, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          if (!d.moved) {
            if (Math.abs(dx) < 3) return;
            d.moved = true;
            setScrubbing(true);
            onStart?.();
          }
          const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
          onChange(clampV(d.v + dx * step * mult));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (!d) return;
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (d.moved) {
            setScrubbing(false);
            onEnd?.();
          } else {
            inputRef.current?.focus();
            inputRef.current?.select();
          }
        }}
        onDoubleClick={() => {
          if (defaultValue === undefined) return;
          inputRef.current?.blur();
          onStart?.();
          onChange(defaultValue);
          onEnd?.();
        }}
      />
      {suffix && <span className="field__affix">{suffix}</span>}
    </div>
  );
}

// ───────────────────────────────────────────────────────── text field ──

interface TextFieldProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  autoFocus?: boolean;
  onEnter?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  prefix?: ReactNode;
  style?: CSSProperties;
  rows?: number;
  ariaLabel?: string;
  type?: string;
  readOnly?: boolean;
  /** What was entered cannot be used: the field says so until it changes. */
  invalid?: boolean;
  /** Id of the text that explains the field, or what is wrong with its content. */
  describedBy?: string;
}

export function TextField({
  value,
  onChange,
  placeholder,
  multiline,
  autoFocus,
  onEnter,
  onFocus,
  onBlur,
  prefix,
  style,
  rows = 3,
  ariaLabel,
  type,
  readOnly,
  invalid,
  describedBy,
}: TextFieldProps) {
  const name = useName(ariaLabel);
  const stop = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) onEnter?.();
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    e.stopPropagation();
  };
  return (
    <div
      className={cx('field', multiline && 'field--area')}
      style={style}
      data-invalid={invalid ? '' : undefined}
    >
      {prefix && <span className="field__prefix">{prefix}</span>}
      {multiline ? (
        <textarea
          {...name}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={value}
          rows={rows}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={stop}
          onFocus={onFocus}
          onBlur={onBlur}
          spellCheck={false}
          readOnly={readOnly}
        />
      ) : (
        <input
          {...name}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          type={type}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={stop}
          onFocus={onFocus}
          onBlur={onBlur}
          spellCheck={false}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────── popover ──

interface PopoverProps {
  anchor: DOMRect | { x: number; y: number } | null;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  side?: 'bottom' | 'top' | 'right';
  className?: string;
  style?: CSSProperties;
  /** Match the anchor's width (dropdown selects). */
  matchWidth?: boolean;
  /** The control that opened it: pressing it again closes the popover, and focus returns to it. */
  trigger?: RefObject<HTMLElement | null>;
}

export function Popover(props: PopoverProps) {
  return props.anchor ? <PopoverPanel {...props} anchor={props.anchor} /> : null;
}

/** The entries of a menu or listbox that can be chosen. */
const MENU_ITEM = ':is([role="menuitem"], [role="menuitemradio"], [role="option"]):not(:disabled)';
const menuItems = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(MENU_ITEM));
const itemLabel = (el: HTMLElement) =>
  el.getAttribute('aria-label') ?? el.querySelector('.menu-item__label')?.textContent ?? el.textContent ?? '';
/** How long a pause ends a word typed to jump to an entry. */
const TYPE_AHEAD_MS = 700;

function PopoverPanel({
  anchor,
  onClose,
  children,
  align = 'start',
  side = 'bottom',
  className,
  style,
  matchWidth,
  trigger,
}: PopoverProps & { anchor: DOMRect | { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPlace | null>(null);
  const typed = useRef({ text: '', at: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const control = 'width' in anchor;
    setPos(
      placePopover(
        control ? anchor : { left: anchor.x, top: anchor.y, width: 0, height: 0 },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { side, align, control },
      ),
    );
  }, [anchor, align, side]);

  // While it is open a popover owns the keyboard: nothing reaches the page's shortcuts behind it.
  useLayer(
    ref,
    false,
    (e) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === 'Escape') {
        // A field holding an edit that is not applied yet takes Escape first, to drop that edit.
        if (within(el, e.target)?.matches('[data-dirty]')) return;
        e.stopPropagation();
        onClose();
        return;
      }
      const items = menuItems(el);
      if (e.key === 'Tab') {
        e.stopPropagation();
        // A menu is left with Tab, which lands on the control that opened it; a panel of fields
        // keeps Tab to itself.
        if (items.length) {
          e.preventDefault();
          onClose();
        } else trapTab(el, e);
        return;
      }
      // Text typed into one of the popover's own fields is that field's business, and so are the
      // keys of a slider in it.
      const target = within(el, e.target);
      if (target && (isTextEntry(target) || target.matches('[role="slider"]'))) return;
      e.stopPropagation();
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const focus = (i: number) => {
        e.preventDefault();
        items[(i + items.length) % items.length].focus();
      };
      const inRow = current >= 0 && !!items[current].closest('.menu-swatches');
      if (e.key === 'ArrowDown') focus(current + 1);
      else if (e.key === 'ArrowUp') focus(current < 0 ? -1 : current - 1);
      else if (e.key === 'ArrowRight' && inRow) focus(current + 1);
      else if (e.key === 'ArrowLeft' && inRow) focus(current - 1);
      else if (e.key === 'Home' || e.key === 'PageUp') focus(0);
      else if (e.key === 'End' || e.key === 'PageDown') focus(-1);
      else if (e.key === 'Enter' || e.key === ' ') {
        // Pressing the highlighted entry is the browser's doing.
        if (current < 0) e.preventDefault();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const text = e.timeStamp - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + e.key : e.key;
        typed.current = { text, at: e.timeStamp };
        const match = typeAhead(items.map(itemLabel), text, current);
        if (match >= 0) focus(match);
      }
    },
    trigger,
  );

  const live = useRef(onClose);
  useLayoutEffect(() => {
    live.current = onClose;
  });
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      const target = nodeOf(e.target);
      // The trigger closes its own popover, and a layer opened on top is not "outside".
      if (!el || el.contains(target) || trigger?.current?.contains(target) || !isTopLayer(el)) return;
      live.current();
    };
    const onBlur = () => live.current();
    // Capture phase so the click that closes a menu does not also trigger what is underneath.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [trigger]);

  // Focus moves in once the popover is placed (it cannot take focus while hidden): to the current
  // option of a select, to the first entry of a menu opened from the keyboard, to the first field
  // of a panel, and otherwise to the popover itself so that the arrow keys start from the top.
  const placed = pos !== null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !placed || el.contains(document.activeElement)) return;
    const items = menuItems(el);
    const chosen = items.find((i) => i.getAttribute('aria-selected') === 'true');
    const target = chosen ?? (items.length ? (usingKeyboard() ? items[0] : el) : (focusables(el)[0] ?? el));
    target.focus({ preventScroll: target === el });
  }, [placed]);

  const width = matchWidth && 'width' in anchor ? anchor.width : undefined;
  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      className={cx('popover', className)}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
        ['--origin' as string]: pos?.origin,
        minWidth: width,
        maxHeight: pos?.maxHeight,
        ...style,
      }}
      onContextMenu={(e) => e.preventDefault()}
      // One highlight for pointer and keyboard alike: the entry under the pointer takes focus.
      onPointerMove={(e) => {
        const item = (e.target as HTMLElement).closest<HTMLElement>(MENU_ITEM);
        if (item && item !== document.activeElement) item.focus({ preventScroll: true });
      }}
      onPointerLeave={() => {
        const el = ref.current;
        if (el && menuItems(el).includes(document.activeElement as HTMLElement)) {
          el.focus({ preventScroll: true });
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────────── menu ──

export type MenuEntry =
  | {
      label: string;
      icon?: ReactNode;
      keys?: string;
      onSelect?: () => void;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
    }
  | 'separator'
  | { heading: string }
  /** A row of colour chips, for choosing one of a small palette without a line per colour. */
  | { swatches: { color: string; label: string; checked?: boolean; onSelect: () => void }[] }
  | false
  | null
  | undefined;

export function MenuList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const hasCheck = items.some((i) => i && typeof i === 'object' && 'label' in i && i.checked !== undefined);
  // One entry with an icon gives every entry the column, so that the labels line up.
  const hasIcon = items.some((i) => i && typeof i === 'object' && 'label' in i && i.icon);
  return (
    <div role="menu">
      {items.map((item, i) => {
        if (!item) return null;
        if (item === 'separator') return <div key={i} className="menu-sep" />;
        if ('heading' in item) {
          return (
            <div key={i} className="menu-label">
              {item.heading}
            </div>
          );
        }
        if ('swatches' in item) {
          return (
            <div key={i} className="menu-swatches" role="group">
              {item.swatches.map((sw) => (
                <button
                  key={sw.color}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={!!sw.checked}
                  aria-label={sw.label}
                  title={sw.label}
                  className="menu-swatch"
                  style={{ background: sw.color }}
                  onClick={() => {
                    onClose();
                    sw.onSelect();
                  }}
                />
              ))}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={cx('menu-item', item.danger && 'menu-item--danger')}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {hasCheck && <span className="menu-item__check">{item.checked && <Check />}</span>}
            {item.icon || (hasIcon && <span className="menu-item__icon" />)}
            <span className="menu-item__label">{item.label}</span>
            {item.keys && <Kbd keys={item.keys} />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Handlers for the button of a menu or select. A press toggles its list, and the arrow keys open
 * it, as Enter and Space do, for someone working it from the keyboard. After a press with the
 * pointer the arrow keys stay the editor's shortcuts, where those are live (not under a dialog),
 * until the person leaves the control or opens it with a key: looking into a list with the
 * pointer and then stepping through the timeline is not asking for the list again.
 */
function useListButton(
  button: RefObject<HTMLElement | null>,
  anchor: DOMRect | null,
  setAnchor: (anchor: DOMRect | null) => void,
) {
  const open = !!anchor;
  const pressed = useRef(false);
  // The control is left when focus goes from the button to anything but its own list, or does
  // not come back to the button when that list closes.
  useEffect(() => {
    if (!open && document.activeElement !== button.current) pressed.current = false;
  }, [button, open]);
  return {
    onPointerDown: () => {
      pressed.current = true;
    },
    onBlur: () => {
      if (!open) pressed.current = false;
    },
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      // A click that no pointer made comes from Enter or Space.
      if (e.detail === 0) pressed.current = false;
      setAnchor(open ? null : e.currentTarget.getBoundingClientRect());
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      if (pressed.current && !layerOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      setAnchor(e.currentTarget.getBoundingClientRect());
    },
  };
}

/** A button that opens a menu. */
export function MenuButton({
  items,
  children,
  align = 'start',
  className,
  label,
}: {
  items: MenuEntry[] | (() => MenuEntry[]);
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
  label?: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const handlers = useListButton(button, anchor, setAnchor);
  const t = label ? tip(label) : null;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        className={className}
        data-active={anchor ? 'true' : undefined}
        {...handlers}
        onPointerEnter={t?.onPointerEnter}
        onPointerLeave={t?.onPointerLeave}
        onPointerDown={() => {
          handlers.onPointerDown();
          t?.onPointerDown();
        }}
        onFocusCapture={t?.onFocusCapture}
        onBlurCapture={t?.onBlurCapture}
      >
        {children}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} align={align} trigger={button}>
          <MenuList items={typeof items === 'function' ? items() : items} onClose={close} />
        </Popover>
      )}
    </>
  );
}

// Context menu: one global instance, opened imperatively.
let openCtx: (state: { x: number; y: number; items: MenuEntry[] } | null) => void = () => {};

export function openContextMenu(
  e: { clientX: number; clientY: number; preventDefault: () => void },
  items: MenuEntry[],
): void {
  e.preventDefault();
  openCtx({ x: e.clientX, y: e.clientY, items });
}

export function ContextMenuLayer() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  useEffect(() => {
    openCtx = setState;
    return () => {
      openCtx = () => {};
    };
  }, []);
  const close = useCallback(() => setState(null), []);
  if (!state) return null;
  return (
    <Popover anchor={{ x: state.x, y: state.y }} onClose={close}>
      <MenuList items={state.items} onClose={close} />
    </Popover>
  );
}

// ───────────────────────────────────────────────────────────── select ──

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  group?: string;
  style?: CSSProperties;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  placeholder,
  style,
  ariaLabel,
}: {
  value: T | null | undefined;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const handlers = useListButton(button, anchor, setAnchor);
  const current = options.find((o) => o.value === value);
  // The button is read as what it sets and what that is set to: a name alone would take the
  // place of the value, which is all the button shows. Its own name, where it has one, is the
  // first part (an element may name itself by its `aria-label`), else the label of its row.
  const row = useContext(LabelCtx);
  const id = useId();
  const valueId = useId();
  const named = ariaLabel ? id : row;
  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        id={id}
        className="select"
        style={style}
        aria-label={ariaLabel}
        aria-labelledby={named && `${named} ${valueId}`}
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        {...handlers}
      >
        <span id={valueId} style={current?.style}>
          {current?.label ?? placeholder ?? '—'}
        </span>
        <ChevronDown />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} matchWidth trigger={button}>
          <div role="listbox" aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : row}>
            {options.map((o) => {
              const heading = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <div key={String(o.value)}>
                  {heading && <div className="menu-label">{heading}</div>}
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={o.value === value}
                    className="menu-item"
                    onClick={() => {
                      close();
                      onChange(o.value);
                    }}
                  >
                    <span className="menu-item__check">{o.value === value && <Check />}</span>
                    <span className="menu-item__label" style={o.style}>
                      {o.label}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </Popover>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────── switch / segmented ──

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  const name = useName(label);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      {...name}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  block,
  ariaLabel,
}: {
  value: T;
  /** An option without a `label` is an icon alone: its `tip` is then its name as well. */
  options: { value: T; label?: ReactNode; icon?: ReactNode; tip?: string; keys?: string }[];
  onChange: (v: T) => void;
  block?: boolean;
  /** What is being chosen. In a `Labelled` row it need not be given: the row's label says it. */
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const name = useName(ariaLabel);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value, options.length]);
  return (
    <div ref={ref} className={cx('seg', block && 'seg--block')} role="group" {...name}>
      {thumb && (
        <div
          className="seg__thumb"
          style={{ width: thumb.w, transform: `translateX(${thumb.x - 2}px)`, left: 2 }}
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg__item"
          aria-label={o.label === undefined ? o.tip : undefined}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          {...(o.tip ? tip(o.tip, o.keys) : null)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── colour ──

export function ColorField({
  value,
  onChange,
  onStart,
  onEnd,
}: { value: string; onChange: (v: string) => void } & GestureProps) {
  const hexRef = useRef<HTMLInputElement>(null);
  const entry = useEntry(hexRef, (hex) => {
    let v = hex.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return;
    if (v.length === 4) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
    onStart?.();
    onChange(v.toLowerCase());
    onEnd?.();
  });
  const picker = useRef<HTMLInputElement>(null);
  // In a labelled row each of the two inputs is read as the row's label and its own name (an
  // element may name itself by its `aria-label`): a panel holds more than one colour.
  const row = useContext(LabelCtx);
  const pickerId = useId();
  const hexId = useId();
  const started = useRef(false);
  const live = useRef(onEnd);
  useLayoutEffect(() => {
    live.current = onEnd;
  });
  // One pick is one gesture, however far the pointer travels inside the picker. It ends when
  // the browser reports the final colour: the native `change` event, which fires once when the
  // picker closes. React's onChange cannot tell, because it fires on every `input` event.
  useEffect(() => {
    const el = picker.current;
    if (!el) return;
    const end = () => {
      if (!started.current) return;
      started.current = false;
      live.current?.();
    };
    el.addEventListener('change', end);
    el.addEventListener('blur', end);
    return () => {
      el.removeEventListener('change', end);
      el.removeEventListener('blur', end);
    };
  }, []);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flex: 1 }}>
      <div className="swatch" style={{ background: value }}>
        <input
          ref={picker}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          id={pickerId}
          aria-label="Pick colour"
          aria-labelledby={row && `${row} ${pickerId}`}
          onChange={(e) => {
            if (!started.current) {
              started.current = true;
              onStart?.();
            }
            onChange(e.target.value);
          }}
        />
      </div>
      <div className="field" style={{ flex: 1 }}>
        <input
          ref={hexRef}
          className="mono"
          id={hexId}
          aria-label="Hex colour"
          aria-labelledby={row && `${row} ${hexId}`}
          value={entry.text ?? value.toUpperCase()}
          data-dirty={entry.text !== null ? '' : undefined}
          spellCheck={false}
          onChange={(e) => entry.edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') entry.edit(null);
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLElement).blur();
            e.stopPropagation();
          }}
          onBlur={entry.commit}
        />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── dialog ──

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
  narrow,
  icon,
  solid,
  describedBy,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** A short question rather than a form. */
  narrow?: boolean;
  icon?: ReactNode;
  /** Dim the page with a flat colour instead of a live blur (for long-running, GPU-heavy work). */
  solid?: boolean;
  /** Id of the element that says what the dialog is about, when the title alone does not. */
  describedBy?: string;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Modal: the page behind is inert, Tab stays inside and focus returns to where it was.
  useLayer(backdrop, true, (e) => {
    const el = panel.current;
    if (!el) return;
    if (e.key === 'Tab') trapTab(el, e);
    // A field holding an edit that is not applied yet takes Escape first, to drop that edit.
    else if (e.key === 'Escape' && !(e.target instanceof Element && e.target.matches('[data-dirty]'))) {
      e.stopPropagation();
      onClose();
    }
  });

  // Focus starts on the first control of the content, not on the close button in the header.
  // Content without a control takes it itself, so that the keys that scroll act on it.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || el.contains(document.activeElement)) return;
    const first = [body.current, foot.current].flatMap((part) => (part ? focusables(part) : []))[0];
    (first ?? body.current)?.focus();
    if (!el.contains(document.activeElement)) el.focus();
  }, []);

  // Content that scrolls and holds no control is a stop for Tab itself: nothing else in it could
  // have focus, and without focus there the keyboard cannot scroll it.
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setScrolls(el.scrollHeight > el.clientHeight && focusables(el).length === 0),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return createPortal(
    <div
      ref={backdrop}
      className={cx('dialog-backdrop', solid && 'dialog-backdrop--solid')}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={cx('dialog', wide && 'dialog--wide', narrow && 'dialog--narrow')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        <div className="dialog__head">
          {icon && <span className="dialog__icon">{icon}</span>}
          <div className="dialog__title" id={titleId}>
            {title}
          </div>
          <IconButton label="Close" keys="escape" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </IconButton>
        </div>
        <div className="dialog__body" ref={body} tabIndex={scrolls ? 0 : -1}>
          {children}
        </div>
        {footer && (
          <div className="dialog__foot" ref={foot}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ───────────────────────────────────────────────────────────── toasts ──

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

let pushToast: (t: Toast) => void = () => {};
let toastId = 0;

export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  pushToast({ id: ++toastId, kind, text, action });
}

/** Time a toast is given to fade out before it is taken away (`toast-out` in ui.css is shorter). */
const TOAST_EXIT_MS = 120;

/**
 * How long a toast stays. One that offers something to press has to be read, decided on and
 * reached: it gets about twice the time of one that only says something.
 */
function toastLife(t: Pick<Toast, 'kind' | 'action'>): number {
  if (t.action) return 9000;
  return t.kind === 'error' ? 7000 : 4000;
}

function ToastCard({
  toast: t,
  leaving,
  dismiss,
}: {
  toast: Toast;
  leaving: boolean;
  dismiss: (id: number) => void;
}) {
  // Its time does not run while the pointer rests on it or the keyboard is on its button: it
  // must not go from under someone who is reading it or about to press.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const left = useRef(toastLife(t));
  useEffect(() => {
    if (held) return;
    const since = performance.now();
    const timer = setTimeout(() => dismiss(t.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= performance.now() - since;
    };
  }, [held, dismiss, t.id]);
  return (
    <div
      className="toast"
      data-kind={t.kind}
      data-leaving={leaving ? '' : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {t.kind === 'error' ? (
          <path d="M12 8v5m0 3.5v.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        ) : t.kind === 'success' ? (
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        ) : (
          <path d="M12 11v6m0-9.5v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
        )}
      </svg>
      <span>{t.text}</span>
      {t.action && (
        <button
          className="toast__action"
          onClick={() => {
            t.action!.run();
            dismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      )}
    </div>
  );
}

export function ToastLayer() {
  const [list, setList] = useState<(Toast & { leaving?: boolean })[]>([]);
  const dismiss = useCallback((id: number) => {
    setList((l) => l.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), TOAST_EXIT_MS);
  }, []);
  useEffect(() => {
    pushToast = (t) => setList((l) => [...l.slice(-3), t]);
    return () => {
      pushToast = () => {};
    };
  }, []);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <ToastCard key={t.id} toast={t} leaving={!!t.leaving} dismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}

// ──────────────────────────────────────────────────────────── helpers ──

/** Collapsible section state shared across mounts, keyed by id. */
const collapsed = new Map<string, boolean>();
const CollapseCtx = createContext(0);

export function useCollapsed(id: string, initial = false): [boolean, () => void] {
  useContext(CollapseCtx);
  const [, force] = useState(0);
  const value = collapsed.get(id) ?? initial;
  return [
    value,
    () => {
      collapsed.set(id, !value);
      force((n) => n + 1);
    },
  ];
}
