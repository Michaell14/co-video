/** Building blocks for property panels: collapsible sections and keyframe-aware rows. */
import { ChevronDown, ChevronLeft, ChevronRight, Diamond } from 'lucide-react';
import type { ReactNode } from 'react';
import { animated, baseValue, clearKeyframes, nearestKeyframe, toggleKeyframe, type Clip, type ParamDef, type ParamValue } from '@tandem/core';
import { cmd } from '../../state/commands';
import { beginGesture, localFrameOf, patchClips, setClipValues } from '../../state/props';
import { ColorField, NumberField, Select, Slider, Switch, tip, useCollapsed } from '../../ui/core';

export function Section({ id, title, children, actions, defaultCollapsed }: { id: string; title: ReactNode; children: ReactNode; actions?: ReactNode; defaultCollapsed?: boolean }) {
  const [collapsed, toggle] = useCollapsed(id, defaultCollapsed);
  return (
    <div className="section" data-collapsed={collapsed}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button className="section__head" onClick={toggle} aria-expanded={!collapsed}>
          <ChevronDown className="section__chev" />
          <span className="section__title">{title}</span>
        </button>
        {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 6 }}>{actions}</div>}
      </div>
      {!collapsed && <div className="section__body">{children}</div>}
    </div>
  );
}

export function Row({ label, children, stack }: { label: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={stack ? 'row row--stack' : 'row'}>
      <div className="row__label">{label}</div>
      <div className="row__ctrl">{children}</div>
    </div>
  );
}

/** Current (animated) value of a numeric property on a clip at the playhead. */
export function valueOf(clip: Clip, path: string, fallback = 0): number {
  const base = baseValue(clip, path) ?? fallback;
  return animated(clip, path, localFrameOf(clip), base);
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
  animatable?: boolean;
  /** Bumping this forces a re-read while the playhead moves over animated values. */
  frame?: number;
}

/** A numeric clip property with keyframe toggle, scrubbable field and optional slider. */
export function NumericRow({ clips, path, label, min = -Infinity, max = Infinity, step = 0.01, scale = 1, precision = 2, suffix, defaultValue, slider, origin, animatable = true }: NumericRowProps) {
  const first = clips[0];
  if (!first) return null;
  const ids = clips.map((c) => c.id);
  const v = valueOf(first, path, defaultValue ?? 0);
  const mixed = clips.some((c) => Math.abs(valueOf(c, path, defaultValue ?? 0) - v) > 1e-6);
  const kfs = first.keyframes[path];
  const isAnimated = !!kfs && kfs.length > 0;
  const lf = localFrameOf(first);
  const onKey = isAnimated && kfs.some((k) => k.t === lf);
  const set = (val: number) => setClipValues(ids, { [path]: val });
  return (
    <div className="row">
      <div className="row__label">
        {animatable && (
          <button
            className="kf"
            data-animated={isAnimated}
            aria-label={`Toggle keyframe for ${label}`}
            aria-pressed={onKey}
            onClick={() => patchClips(ids, (c) => toggleKeyframe(c, path, localFrameOf(c), valueOf(c, path, defaultValue ?? 0)))}
            onContextMenu={(e) => {
              e.preventDefault();
              patchClips(ids, (c) => clearKeyframes(c, path, valueOf(c, path, defaultValue ?? 0)));
            }}
            {...tip(isAnimated ? (onKey ? 'Remove keyframe · right-click clears all' : 'Add keyframe here · right-click clears all') : 'Animate: add a keyframe')}
          >
            <Diamond fill={onKey ? 'currentColor' : 'none'} strokeWidth={2.5} />
          </button>
        )}
        <span>{label}</span>
      </div>
      <div className="row__ctrl">
        {slider && Number.isFinite(min) && Number.isFinite(max) && (
          <Slider value={Math.min(max, Math.max(min, v))} min={min} max={max} onChange={set} onStart={beginGesture} defaultValue={defaultValue} origin={origin} />
        )}
        <NumberField value={v} onChange={set} onStart={beginGesture} min={min} max={max} step={step} scale={scale} precision={precision} suffix={suffix} defaultValue={defaultValue} mixed={mixed} ariaLabel={label} />
        {isAnimated && (
          <span className="kfnav">
            <button
              aria-label="Previous keyframe"
              onClick={() => {
                const k = nearestKeyframe(kfs, lf, -1);
                if (k) cmd.seek(first.start + k.t);
              }}
            >
              <ChevronLeft />
            </button>
            <button
              aria-label="Next keyframe"
              onClick={() => {
                const k = nearestKeyframe(kfs, lf, 1);
                if (k) cmd.seek(first.start + k.t);
              }}
            >
              <ChevronRight />
            </button>
          </span>
        )}
      </div>
    </div>
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
          <Slider value={v} min={min} max={max} onChange={onNumber} onStart={beginGesture} defaultValue={def.default} origin={min < 0 ? 0 : undefined} />
          <NumberField value={v} onChange={onNumber} onStart={beginGesture} min={min} max={max} step={step} precision={step >= 1 ? 0 : 2} suffix={def.type === 'angle' ? '°' : def.unit} defaultValue={def.default} />
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
          <ColorField value={typeof value === 'string' ? value : def.default} onChange={(v) => onValue(v, true)} onStart={beginGesture} />
        </Row>
      );
    case 'select':
      return (
        <Row label={def.label}>
          <Select value={typeof value === 'string' ? value : def.default} options={def.options} onChange={(v) => onValue(v)} ariaLabel={def.label} />
        </Row>
      );
    case 'point': {
      const p = Array.isArray(value) && value.length >= 2 ? value : def.default;
      return (
        <Row label={def.label}>
          <NumberField value={p[0]} onChange={(x) => onValue([x, p[1]], true)} onStart={beginGesture} min={-1} max={2} step={0.002} scale={100} precision={1} prefix="X" suffix="%" defaultValue={def.default[0]} />
          <NumberField value={p[1]} onChange={(y) => onValue([p[0], y], true)} onStart={beginGesture} min={-1} max={2} step={0.002} scale={100} precision={1} prefix="Y" suffix="%" defaultValue={def.default[1]} />
        </Row>
      );
    }
  }
}
