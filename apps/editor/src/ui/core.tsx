/* Design-system primitives. Small, dependency-free and keyboard friendly. */
import { Check, ChevronDown } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

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
  x: number;
  y: number;
  place: 'top' | 'bottom';
}

let showTip: (t: TipState | null) => void = () => {};
let tipTimer: ReturnType<typeof setTimeout> | undefined;
let lastTipAt = 0;

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  useEffect(() => {
    showTip = setTip;
    return () => {
      showTip = () => {};
    };
  }, []);
  if (!tip) return null;
  const style: CSSProperties = {
    left: tip.x,
    top: tip.y,
    transform: `translate(-50%, ${tip.place === 'top' ? '-100%' : '0'})`,
  };
  return createPortal(
    <div className="tooltip" style={style} role="tooltip">
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
      tipTimer = setTimeout(() => {
        const x = Math.min(window.innerWidth - 80, Math.max(80, r.left + r.width / 2));
        const wantTop = place === 'top' || r.bottom + 40 > window.innerHeight;
        showTip({ text, keys, x, y: wantTop ? r.top - 7 : r.bottom + 7, place: wantTop ? 'top' : 'bottom' });
      }, delay);
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

export function Button({ variant = 'default', size = 'md', block, icon, className, children, ...rest }: ButtonProps) {
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

export function IconButton({ label, keys, active, small, tipPlace, className, children, ...rest }: IconButtonProps) {
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

export function Slider({ value, min, max, step, onChange, onStart, onEnd, defaultValue, origin, disabled }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const span = max - min || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100));
  const fromX = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    let v = min + ((clientX - r.left) / r.width) * span;
    if (step) v = Math.round(v / step) * step;
    return Math.min(max, Math.max(min, v));
  };
  const o = origin ?? min;
  const a = pct(Math.min(o, value));
  const b = pct(Math.max(o, value));
  return (
    <div
      ref={ref}
      className="slider"
      data-active={active}
      style={disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        onStart?.();
        onChange(fromX(e.clientX));
      }}
      onPointerMove={(e) => {
        if (active) onChange(fromX(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!active) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setActive(false);
        onEnd?.();
      }}
      onDoubleClick={() => {
        if (defaultValue === undefined) return;
        onStart?.();
        onChange(defaultValue);
        onEnd?.();
      }}
    >
      <div className="slider__track">
        <div className="slider__fill" style={{ left: `${a}%`, width: `${b - a}%` }} />
      </div>
      {origin !== undefined && origin > min && origin < max && <div className="slider__center" style={{ left: `${pct(origin)}%` }} />}
      <div className="slider__thumb" style={{ left: `${pct(value)}%` }} />
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
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const shown = mixed ? '—' : (value * scale).toFixed(precision);

  const commitText = () => {
    if (editing === null) return;
    const n = parseFloat(editing.replace(',', '.'));
    setEditing(null);
    if (Number.isFinite(n)) {
      onStart?.();
      onChange(clampV(n / scale));
      onEnd?.();
    }
  };

  return (
    <div className="field num" data-scrubbing={scrubbing} style={{ ...style, ...(disabled ? { opacity: 0.4, pointerEvents: 'none' } : null) }}>
      {prefix && <span className="field__prefix">{prefix}</span>}
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        value={editing ?? shown}
        inputMode="decimal"
        spellCheck={false}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitText();
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            setEditing(null);
            inputRef.current?.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const dir = e.key === 'ArrowUp' ? 1 : -1;
            setEditing(null);
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

export function TextField({ value, onChange, placeholder, multiline, autoFocus, onEnter, onFocus, onBlur, prefix, style, rows = 3, ariaLabel, type, readOnly }: TextFieldProps) {
  const stop = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) onEnter?.();
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    e.stopPropagation();
  };
  return (
    <div className={cx('field', multiline && 'field--area')} style={style}>
      {prefix && <span className="field__prefix">{prefix}</span>}
      {multiline ? (
        <textarea aria-label={ariaLabel} value={value} rows={rows} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={stop} onFocus={onFocus} onBlur={onBlur} spellCheck={false} readOnly={readOnly} />
      ) : (
        <input aria-label={ariaLabel} type={type} value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={stop} onFocus={onFocus} onBlur={onBlur} spellCheck={false} readOnly={readOnly} />
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
}

export function Popover({ anchor, onClose, children, align = 'start', side = 'bottom', className, style, matchWidth }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
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
      left = align === 'end' ? rect.right - w : align === 'center' ? rect.left + rect.width / 2 - w / 2 : rect.left;
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

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase so the click that closes a menu does not also trigger what is underneath.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  if (!anchor) return null;
  const width = matchWidth && 'width' in anchor ? anchor.width : undefined;
  return createPortal(
    <div
      ref={ref}
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
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
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
  const close = useCallback(() => setAnchor(null), []);
  const t = label ? tip(label) : null;
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        className={className}
        data-active={anchor ? 'true' : undefined}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
        onPointerEnter={t?.onPointerEnter}
        onPointerLeave={t?.onPointerLeave}
        onPointerDown={t?.onPointerDown}
      >
        {children}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} align={align}>
          <MenuList items={typeof items === 'function' ? items() : items} onClose={close} />
        </Popover>
      )}
    </>
  );
}

// Context menu: one global instance, opened imperatively.
let openCtx: (state: { x: number; y: number; items: MenuEntry[] } | null) => void = () => {};

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuEntry[]): void {
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
  const close = useCallback(() => setAnchor(null), []);
  const current = options.find((o) => o.value === value);
  let lastGroup: string | undefined;
  return (
    <>
      <button
        type="button"
        className="select"
        style={style}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        <span style={current?.style}>{current?.label ?? placeholder ?? '—'}</span>
        <ChevronDown />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} matchWidth>
          <div role="listbox">
            {options.map((o) => {
              const heading = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <div key={String(o.value)}>
                  {heading && <div className="menu-label">{heading}</div>}
                  <button
                    type="button"
                    role="option"
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

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
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
      {thumb && <div className="seg__thumb" style={{ width: thumb.w, transform: `translateX(${thumb.x - 2}px)`, left: 2 }} />}
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

export function ColorField({ value, onChange, onStart, onEnd }: { value: string; onChange: (v: string) => void } & GestureProps) {
  const [text, setText] = useState<string | null>(null);
  const started = useRef(false);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flex: 1 }}>
      <div className="swatch" style={{ background: value }}>
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          aria-label="Pick colour"
          onInput={(e) => {
            if (!started.current) {
              started.current = true;
              onStart?.();
            }
            onChange((e.target as HTMLInputElement).value);
          }}
          onBlur={() => {
            if (started.current) {
              started.current = false;
              onEnd?.();
            }
          }}
          onChange={() => {
            if (started.current) {
              started.current = false;
              onEnd?.();
            }
          }}
        />
      </div>
      <div className="field" style={{ flex: 1 }}>
        <input
          className="mono"
          aria-label="Hex colour"
          value={text ?? value.toUpperCase()}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLElement).blur();
            e.stopPropagation();
          }}
          onBlur={() => {
            if (text !== null) {
              let v = text.trim();
              if (!v.startsWith('#')) v = `#${v}`;
              if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
                if (v.length === 4) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
                onStart?.();
                onChange(v.toLowerCase());
                onEnd?.();
              }
              setText(null);
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
  icon,
  solid,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: ReactNode;
  /** Dim the page with a flat colour instead of a live blur (for long-running, GPU-heavy work). */
  solid?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      className={cx('dialog-backdrop', solid && 'dialog-backdrop--solid')}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={cx('dialog', wide && 'dialog--wide')} role="dialog" aria-modal="true">
        <div className="dialog__head">
          {icon}
          <div className="dialog__title">{title}</div>
          <IconButton label="Close" keys="escape" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </IconButton>
        </div>
        <div className="dialog__body">{children}</div>
        {footer && <div className="dialog__foot">{footer}</div>}
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
