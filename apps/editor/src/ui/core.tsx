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
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  focusables,
  isTextEntry,
  isTopLayer,
  layerOpen,
  placeTip,
  trapTab,
  typeAhead,
  useLayer,
  usingKeyboard,
} from './layers';
import { isDoublePress, isDrag, type Press } from './press';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
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

/** Hide any visible tooltip (call from your own pointer-down handler when it replaces the tip's). */
export function hideTip(): void {
  clearTimeout(tipTimer);
  showTip(null);
}

/** Props to spread on any element to give it a tooltip. */
export function tip(text: ReactNode, keys?: string, place: 'top' | 'bottom' = 'bottom') {
  return {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      clearTimeout(tipTimer);
      // After the first tooltip, neighbours appear instantly — scanning a toolbar should feel fluid.
      const delay = performance.now() - lastTipAt < 400 ? 0 : 450;
      tipTimer = setTimeout(() => showTip({ text, keys, anchor: r, place }), delay);
    },
    onPointerLeave: () => {
      clearTimeout(tipTimer);
      showTip(null);
      lastTipAt = performance.now();
    },
    onPointerDown: () => {
      clearTimeout(tipTimer);
      showTip(null);
    },
  };
}

// ──────────────────────────────────────────────────────────── buttons ──

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  block,
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
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
      {...rest}
    >
      {icon}
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
    >
      {children}
    </button>
  );
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
  /** Value restored on double-click. */
  defaultValue?: number;
  /** Draw the fill from this value instead of from the minimum (bipolar controls). */
  origin?: number;
  disabled?: boolean;
}

/** Half the thumb's width (`.slider__thumb` in ui.css). */
const SLIDER_INSET = 5.5;

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
}: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  // The latest press: whether it was the second of a double-click, and whether it became a drag.
  const press = useRef<(Press & { second: boolean; dragged: boolean }) | null>(null);
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
      <div className="slider__thumb" style={{ left: at(frac(value)) }} />
    </div>
  );
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
  const [editing, setEditing] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The text being typed, readable in the same tick it changes: Enter and Escape blur the field
  // from inside their own handler, and that blur must see what they just decided.
  const typed = useRef<string | null>(null);
  const edit = (text: string | null) => {
    typed.current = text;
    setEditing(text);
  };
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const shown = mixed ? '—' : (value * scale).toFixed(precision);

  const commitText = () => {
    const text = typed.current;
    if (text === null) return;
    edit(null);
    const n = parseFloat(text.replace(',', '.'));
    if (Number.isFinite(n)) {
      onStart?.();
      onChange(clampV(n / scale));
      onEnd?.();
    }
  };

  return (
    <div
      className="field num"
      data-scrubbing={scrubbing}
      style={{ ...style, ...(disabled ? { opacity: 0.4, pointerEvents: 'none' } : null) }}
    >
      {prefix && <span className="field__prefix">{prefix}</span>}
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        value={editing ?? shown}
        data-dirty={editing !== null ? '' : undefined}
        inputMode="decimal"
        spellCheck={false}
        onChange={(e) => edit(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitText();
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            edit(null);
            inputRef.current?.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            edit(null);
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
}: TextFieldProps) {
  const stop = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) onEnter?.();
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    e.stopPropagation();
  };
  return (
    <div className={cx('field', multiline && 'field--area')} style={style}>
      {prefix && <span className="field__prefix">{prefix}</span>}
      {multiline ? (
        <textarea
          aria-label={ariaLabel}
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
          aria-label={ariaLabel}
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
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const typed = useRef({ text: '', at: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = 'width' in anchor ? anchor : new DOMRect(anchor.x, anchor.y, 0, 0);
    let left: number;
    let top: number;
    let originY = 'top';
    if (side === 'right') {
      left = rect.right + 6;
      top = rect.top;
      if (left + w > vw - 8) left = rect.left - w - 6;
    } else {
      left =
        align === 'end'
          ? rect.right - w
          : align === 'center'
            ? rect.left + rect.width / 2 - w / 2
            : rect.left;
      top = side === 'top' ? rect.top - h - 6 : rect.bottom + 6;
      if (side === 'bottom' && top + h > vh - 8 && rect.top - h - 6 > 8) {
        top = rect.top - h - 6;
        originY = 'bottom';
      } else if (side === 'top') originY = 'bottom';
    }
    left = Math.min(vw - w - 8, Math.max(8, left));
    top = Math.min(vh - h - 8, Math.max(8, top));
    setPos({ left, top, origin: `${originY} ${align === 'end' ? 'right' : 'left'}` });
  }, [anchor, align, side]);

  // While it is open a popover owns the keyboard: nothing reaches the page's shortcuts behind it.
  useLayer(
    ref,
    false,
    (e) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === 'Escape') {
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
      // Text typed into one of the popover's own fields is that field's business.
      if (el.contains(e.target as Node) && isTextEntry(e.target)) return;
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
      const target = e.target as Node;
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
            {item.icon}
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
  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="select"
        style={style}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        {...handlers}
      >
        <span style={current?.style}>{current?.label ?? placeholder ?? '—'}</span>
        <ChevronDown />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} matchWidth trigger={button}>
          <div role="listbox" aria-label={ariaLabel}>
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
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
}: {
  value: T;
  options: { value: T; label?: ReactNode; icon?: ReactNode; tip?: string; keys?: string }[];
  onChange: (v: T) => void;
  block?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value, options.length]);
  return (
    <div ref={ref} className={cx('seg', block && 'seg--block')} role="group">
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
  const [text, setText] = useState<string | null>(null);
  // Mirrors `text` for the blur that Enter and Escape cause from inside their own handler.
  const typed = useRef<string | null>(null);
  const edit = (hex: string | null) => {
    typed.current = hex;
    setText(hex);
  };
  const picker = useRef<HTMLInputElement>(null);
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
          aria-label="Pick colour"
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
          className="mono"
          aria-label="Hex colour"
          value={text ?? value.toUpperCase()}
          data-dirty={text !== null ? '' : undefined}
          spellCheck={false}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') edit(null);
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLElement).blur();
            e.stopPropagation();
          }}
          onBlur={() => {
            const hex = typed.current;
            if (hex === null) return;
            edit(null);
            let v = hex.trim();
            if (!v.startsWith('#')) v = `#${v}`;
            if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
              if (v.length === 4) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
              onStart?.();
              onChange(v.toLowerCase());
              onEnd?.();
            }
          }}
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
    else if (e.key === 'Escape' && !(e.target as Element).matches?.('[data-dirty]')) {
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
          {icon}
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

export function ToastLayer() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      setList((l) => [...l.slice(-3), t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.kind === 'error' ? 7000 : 4000);
    };
    return () => {
      pushToast = () => {};
    };
  }, []);
  return createPortal(
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind}>
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
                setList((l) => l.filter((x) => x.id !== t.id));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
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
