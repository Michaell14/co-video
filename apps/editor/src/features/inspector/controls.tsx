/** Building blocks for property panels: collapsible sections and keyframe-aware rows. */
import { ChevronDown, ChevronLeft, ChevronRight, Diamond } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  animated,
  baseValue,
  clearKeyframes,
  formatTimecode,
  fpsOf,
  nearestKeyframe,
  parseTimecode,
  setKeyframeEasing,
  toggleKeyframe,
  type Clip,
  type Easing,
  type Fps,
  type ParamDef,
  type ParamValue,
} from '@tandem/core';
import { useSession } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { beginGesture, localFrameOf, patchClips, setClipValues } from '../../state/props';
import {
  ColorField,
  Labelled,
  LabelText,
  NumberField,
  openContextMenu,
  Select,
  Slider,
  Switch,
  tip,
  useCollapsed,
} from '../../ui/core';

export function Section({
  id,
  title,
  children,
  actions,
  defaultCollapsed,
  open,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  defaultCollapsed?: boolean;
  /** Something in the section is to be shown: unfold it if it is folded. */
  open?: boolean;
}) {
  // Someone who may not edit can fold and unfold the sections and read what they hold. The
  // controls themselves are out of reach, for the keyboard as for the pointer.
  const readOnly = !useSession().canEdit;
  const [collapsed, toggle] = useCollapsed(id, defaultCollapsed);
  // A body its head has just opened settles into place. One that comes with a new selection is
  // simply there: the selection changes under a drag in the timeline, where nothing else may move.
  const [opened, setOpened] = useState(false);
  const unfold = open && collapsed ? toggle : null;
  useLayoutEffect(() => unfold?.(), [unfold]);
  return (
    <div className="section" data-collapsed={collapsed}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button
          className="section__head"
          onClick={() => {
            setOpened(collapsed);
            toggle();
          }}
          aria-expanded={!collapsed}
        >
          <ChevronDown className="section__chev" />
          <span className="section__title">{title}</span>
        </button>
        {actions && (
          <div className="section__actions" inert={readOnly}>
            {actions}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="section__body" data-opened={opened || undefined} inert={readOnly}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Row({ label, children, stack }: { label: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <Labelled className={stack ? 'row row--stack' : 'row'}>
      <div className="row__label">
        <LabelText>{label}</LabelText>
      </div>
      <div className="row__ctrl">{children}</div>
    </Labelled>
  );
}

/** Current (animated) value of a numeric property on a clip at the playhead. */
export function valueOf(clip: Clip, path: string, fallback = 0): number {
  const base = baseValue(clip, path) ?? fallback;
  return animated(clip, path, localFrameOf(clip), base);
}

const EASINGS: { value: Easing; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'hold', label: 'Hold' },
  { value: 'easeIn', label: 'Ease in' },
  { value: 'easeOut', label: 'Ease out' },
  { value: 'easeInOut', label: 'Ease in-out' },
];

/**
 * The keyframe diamond of a property row. A click adds a keyframe at the playhead or removes the
 * one there; the context menu chooses how the value travels on from that keyframe, for every
 * given clip that has one there. `paths` are properties the row drives together.
 */
export function KeyframeButton({
  clips,
  paths,
  label,
  fallback,
}: {
  clips: Clip[];
  paths: string[];
  label: string;
  /** Value of the property where a clip stores none. */
  fallback: number;
}) {
  const ids = clips.map((c) => c.id);
  const keyAt = (c: Clip) => {
    const t = localFrameOf(c);
    for (const path of paths) {
      const key = c.keyframes[path]?.find((k) => k.t === t);
      if (key) return key;
    }
    return undefined;
  };
  const isAnimated = !!clips[0].keyframes[paths[0]]?.length;
  const onKey = !!keyAt(clips[0]);
  const here = clips.map(keyAt).find(Boolean);
  /** Apply `step` to every path of every clip, as one undo step. */
  const each = (step: (c: Clip, path: string) => Partial<Clip>) =>
    patchClips(ids, (c) => {
      const patch: Partial<Clip> = {};
      for (const path of paths) Object.assign(patch, step({ ...c, ...patch }, path));
      return patch;
    });
  return (
    <button
      className="kf"
      data-animated={isAnimated}
      aria-label={`Toggle keyframe for ${label}`}
      aria-pressed={onKey}
      onClick={() => each((c, path) => toggleKeyframe(c, path, localFrameOf(c), valueOf(c, path, fallback)))}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { heading: here ? 'From this keyframe to the next' : 'No keyframe at the playhead' },
          ...EASINGS.map(({ value, label: name }) => ({
            label: name,
            checked: here?.e === value,
            disabled: !here,
            onSelect: () => each((c, path) => setKeyframeEasing(c, path, localFrameOf(c), value)),
          })),
          'separator',
          {
            label: 'Clear all keyframes',
            danger: true,
            disabled: !clips.some((c) => paths.some((path) => c.keyframes[path]?.length)),
            onSelect: () => each((c, path) => clearKeyframes(c, path, valueOf(c, path, fallback))),
          },
        ])
      }
      {...tip(
        isAnimated
          ? onKey
            ? 'Remove keyframe · right-click for interpolation'
            : 'Add keyframe here · right-click for more'
          : 'Animate: add a keyframe',
      )}
    >
      <Diamond fill={onKey ? 'currentColor' : 'none'} strokeWidth={2.5} />
    </button>
  );
}

/**
 * Steps the playhead to the keyframe before and after it on an animated property; nothing where
 * the property has no keyframes. It stands before the row's number, whose place it never changes.
 */
export function KeyframeNav({ clip, path }: { clip: Clip; path: string }) {
  const keys = clip.keyframes[path];
  if (!keys?.length) return null;
  const go = (direction: -1 | 1) => {
    const key = nearestKeyframe(keys, localFrameOf(clip), direction);
    if (key) cmd.seek(clip.start + key.t);
  };
  return (
    <span className="kfnav">
      <button aria-label="Previous keyframe" onClick={() => go(-1)}>
        <ChevronLeft />
      </button>
      <button aria-label="Next keyframe" onClick={() => go(1)}>
        <ChevronRight />
      </button>
    </span>
  );
}

/** A timecode to type into: `1:00`, a frame count, `2.5s`, or `+12` / `-12` to move by frames. */
export function TimecodeField({
  value,
  fps,
  onCommit,
  ariaLabel,
  min = 0,
  mixed,
}: {
  value: number;
  fps: Fps;
  onCommit: (frame: number) => void;
  ariaLabel: string;
  min?: number;
  /** The selection holds different values: any entry applies to all of it. */
  mixed?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  // Readable in the same tick it changes: Enter and Escape blur the field from inside their own
  // handler, and that blur must see what they just decided.
  const typed = useRef<string | null>(null);
  const edit = (next: string | null) => {
    typed.current = next;
    setText(next);
  };
  const apply = (frame: number) => {
    const next = Math.max(min, frame);
    if (next !== value || mixed) onCommit(next);
  };
  // What was typed goes to what the field stands for when it is applied, not to what it stood for
  // when the typing began: the clip may have been moved by someone else in the meantime, and
  // `+12` means twelve frames on from where it is.
  const finish = () => {
    const entered = typed.current;
    if (entered === null) return;
    edit(null);
    const parsed = parseTimecode(entered, fps);
    if (parsed) apply(parsed.relative ? value + parsed.frame : parsed.frame);
  };
  const latest = useRef(finish);
  useLayoutEffect(() => {
    latest.current = finish;
  });
  // Losing the focus is too late for a press elsewhere: the press can select other clips, or take
  // the field away, before the focus moves. The entry is applied the moment such a press begins,
  // while the field still stands for the clips the text was typed for. An entry whose field goes
  // away for any other reason goes with it, because what it was typed for is gone.
  const pending = text !== null;
  useLayoutEffect(() => {
    if (!pending) return;
    const settle = (e: PointerEvent) => {
      if (!input.current?.contains(e.target as Node)) latest.current();
    };
    window.addEventListener('pointerdown', settle, true);
    return () => window.removeEventListener('pointerdown', settle, true);
  }, [pending]);
  return (
    <div className="field">
      <input
        ref={input}
        className="mono"
        aria-label={ariaLabel}
        value={text ?? (mixed ? '—' : formatTimecode(value, fps))}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => edit(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            edit(null);
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            edit(null);
            const step = e.shiftKey ? Math.round(fpsOf(fps)) : 1;
            apply(value + (e.key === 'ArrowUp' ? step : -step));
          }
          e.stopPropagation();
        }}
      />
    </div>
  );
}

export interface NumericRowProps {
  clips: Clip[];
  path: string;
  label: string;
  min?: number;
  max?: number;
  /** Change per pixel when scrubbing the number. */
  step?: number;
  /** Multiply for display (e.g. 100 for percent). */
  scale?: number;
  precision?: number;
  suffix?: string;
  defaultValue?: number;
  /** Show a slider next to the number. */
  slider?: boolean;
  /** Slider fill origin for bipolar controls. */
  origin?: number;
  /** Limits of the number where it may go beyond the slider's `min` and `max`. */
  numberRange?: [number, number];
  animatable?: boolean;
  /** Bumping this forces a re-read while the playhead moves over animated values. */
  frame?: number;
}

/** A numeric clip property with keyframe toggle, scrubbable field and optional slider. */
export function NumericRow({
  clips,
  path,
  label,
  min = -Infinity,
  max = Infinity,
  step = 0.01,
  scale = 1,
  precision = 2,
  suffix,
  defaultValue,
  slider,
  origin,
  numberRange,
  animatable = true,
}: NumericRowProps) {
  const first = clips[0];
  if (!first) return null;
  const ids = clips.map((c) => c.id);
  const v = valueOf(first, path, defaultValue ?? 0);
  const mixed = clips.some((c) => Math.abs(valueOf(c, path, defaultValue ?? 0) - v) > 1e-6);
  const set = (val: number) => setClipValues(ids, { [path]: val });
  return (
    <Labelled className="row">
      <div className="row__label">
        {animatable && (
          <KeyframeButton clips={clips} paths={[path]} label={label} fallback={defaultValue ?? 0} />
        )}
        <LabelText>{label}</LabelText>
      </div>
      <div className="row__ctrl">
        {slider && Number.isFinite(min) && Number.isFinite(max) && (
          <Slider
            value={Math.min(max, Math.max(min, v))}
            min={min}
            max={max}
            onChange={set}
            onStart={beginGesture}
            defaultValue={defaultValue}
            origin={origin}
          />
        )}
        <KeyframeNav clip={first} path={path} />
        <NumberField
          value={v}
          onChange={set}
          onStart={beginGesture}
          min={numberRange?.[0] ?? min}
          max={numberRange?.[1] ?? max}
          step={step}
          scale={scale}
          precision={precision}
          suffix={suffix}
          defaultValue={defaultValue}
          mixed={mixed}
          ariaLabel={label}
        />
      </div>
    </Labelled>
  );
}

/** Control for one entry of an effect / transition parameter schema. */
export function ParamControl({
  def,
  value,
  onNumber,
  onValue,
  numericRow,
}: {
  def: ParamDef;
  value: ParamValue | undefined;
  /** Continuous numeric change (inside a gesture). */
  onNumber: (v: number) => void;
  /** Discrete change; `merge` marks changes that belong to a gesture already in progress. */
  onValue: (v: ParamValue, merge?: boolean) => void;
  /** When provided, numeric params render through it (to get keyframe support). */
  numericRow?: (def: Extract<ParamDef, { type: 'float' | 'angle' }>) => ReactNode;
}) {
  switch (def.type) {
    case 'float':
    case 'angle': {
      if (numericRow) return <>{numericRow(def)}</>;
      const v = typeof value === 'number' ? value : def.default;
      const min = def.type === 'angle' ? -360 : def.min;
      const max = def.type === 'angle' ? 360 : def.max;
      const step = def.type === 'angle' ? 1 : (def.step ?? 0.01);
      return (
        <Row label={def.label}>
          <Slider
            value={v}
            min={min}
            max={max}
            onChange={onNumber}
            onStart={beginGesture}
            defaultValue={def.default}
            origin={min < 0 ? 0 : undefined}
          />
          <NumberField
            value={v}
            onChange={onNumber}
            onStart={beginGesture}
            min={min}
            max={max}
            step={step}
            precision={step >= 1 ? 0 : 2}
            suffix={def.type === 'angle' ? '°' : def.unit}
            defaultValue={def.default}
          />
        </Row>
      );
    }
    case 'bool':
      return (
        <Row label={def.label}>
          <Switch checked={!!value} onChange={(v) => onValue(v)} label={def.label} />
        </Row>
      );
    case 'color':
      return (
        <Row label={def.label}>
          <ColorField
            value={typeof value === 'string' ? value : def.default}
            onChange={(v) => onValue(v, true)}
            onStart={beginGesture}
          />
        </Row>
      );
    case 'select':
      return (
        <Row label={def.label}>
          <Select
            value={typeof value === 'string' ? value : def.default}
            options={def.options}
            onChange={(v) => onValue(v)}
            ariaLabel={def.label}
          />
        </Row>
      );
    case 'point': {
      const p = Array.isArray(value) && value.length >= 2 ? value : def.default;
      return (
        <Row label={def.label}>
          <NumberField
            value={p[0]}
            onChange={(x) => onValue([x, p[1]], true)}
            onStart={beginGesture}
            min={-1}
            max={2}
            step={0.002}
            scale={100}
            precision={1}
            prefix="X"
            suffix="%"
            defaultValue={def.default[0]}
          />
          <NumberField
            value={p[1]}
            onChange={(y) => onValue([p[0], y], true)}
            onStart={beginGesture}
            min={-1}
            max={2}
            step={0.002}
            scale={100}
            precision={1}
            prefix="Y"
            suffix="%"
            defaultValue={def.default[1]}
          />
        </Row>
      );
    }
  }
}
