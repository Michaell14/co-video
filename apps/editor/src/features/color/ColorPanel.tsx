import {
  ClipboardCopy,
  ClipboardPaste,
  Eye,
  EyeOff,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
  Palette,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  clipEnd,
  DEFAULT_GRADE,
  FLAT_CURVE,
  IDENTITY_CURVE,
  INPUT_COLOR_SPACES,
  resolveInputSpace,
  trackLabel,
  tracksOf,
  clipsOnTrack,
  type Clip,
  type CurvePoint,
  type Grade,
  type InputColorSpace,
  type Project,
  type Wheel,
} from '@tandem/core';
import { sampleCurve } from '@tandem/engine';
import { useLiveProject, useSession, useThrottledFrame } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { beginGesture, commit, patchClips } from '../../state/props';
import { useUI } from '../../state/ui';
import { Button, IconButton, NumberField, Select, Slider, tip, toast } from '../../ui/core';
import { isDoublePress, type Press } from '../../ui/press';
import { Row } from '../inspector/controls';
import { ProjectSettingsForm } from '../inspector/ProjectSettings';
import './color.css';

type Tab = 'wheels' | 'curves' | 'hdr' | 'lut';

/** The clip the Colour workspace is working on: the selection, or else whatever is under the playhead. */
function useActiveClip(project: Project): Clip | null {
  const selection = useUI((s) => s.selection);
  const frame = useThrottledFrame(6);
  return useMemo(() => {
    for (const id of selection) {
      const c = project.clips[id];
      if (c && c.type !== 'audio') return c;
    }
    const { video } = tracksOf(project);
    for (let i = video.length - 1; i >= 0; i--) {
      if (video[i].hidden) continue;
      for (const c of clipsOnTrack(project, video[i].id)) {
        if (c.start > frame) break;
        if (frame < clipEnd(c) && c.enabled) return c;
      }
    }
    return null;
  }, [project, selection, frame]);
}

export function ColorPanel() {
  const session = useSession();
  const project = useLiveProject((p) => p);
  const clip = useActiveClip(project);
  const attributes = useUI((s) => s.attributes);
  // The clip under the playhead is shown whether or not its track is locked; a lock keeps every
  // control off it all the same.
  const track = clip ? project.tracks[clip.trackId] : undefined;
  const locked = !!track?.locked;
  const [tab, setTab] = useState<Tab>('wheels');
  const tabsRef = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el) setInk({ x: el.offsetLeft, w: el.offsetWidth });
  }, [tab]);

  const grade = clip?.grade ?? DEFAULT_GRADE;
  const set = (patch: Partial<Grade>, merge = true) => {
    if (!clip) return;
    patchClips([clip.id], (c) => ({ grade: { ...(c.grade ?? DEFAULT_GRADE), ...patch } }), merge);
  };

  return (
    <>
      <div className="panel__head">
        <div className="tabs" role="tablist" ref={tabsRef}>
          {(
            [
              ['wheels', 'Wheels'],
              ['curves', 'Curves'],
              ['hdr', 'HDR'],
              ['lut', 'LUT & Input'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
          <div className="tabs__ink" style={{ width: ink.w, transform: `translateX(${ink.x}px)` }} />
        </div>
        <span className="panel__spacer" />
        <IconButton
          small
          label={grade.enabled ? 'Bypass grade' : 'Enable grade'}
          disabled={!clip?.grade || locked}
          active={!!clip?.grade && !grade.enabled}
          onClick={() => set({ enabled: !grade.enabled }, false)}
        >
          {grade.enabled ? <Eye /> : <EyeOff />}
        </IconButton>
        <IconButton
          small
          label="Copy grade"
          disabled={!clip}
          onClick={() => clip && cmd.copyAttributes(clip.id)}
        >
          <ClipboardCopy />
        </IconButton>
        <IconButton
          small
          label="Paste grade"
          disabled={!clip || !attributes || locked}
          onClick={() => clip && cmd.pasteAttributes('grade', [clip.id])}
        >
          <ClipboardPaste />
        </IconButton>
        <IconButton
          small
          label="Reset grade"
          disabled={!clip?.grade || locked}
          onClick={() => clip && patchClips([clip.id], { grade: null })}
        >
          <RotateCcw />
        </IconButton>
      </div>
      <div className="panel__body color" data-readonly={!session.canEdit || locked}>
        {!clip ? (
          <div className="empty">
            <Palette />
            <b>Nothing to grade here</b>
            Move the playhead over a clip, or select one in the timeline.
          </div>
        ) : (
          <>
            <button
              className="color__clip"
              onClick={() => useUI.getState().select([clip.id])}
              {...tip('Click to select this clip')}
            >
              <i style={{ background: 'var(--accent)' }} />
              <span>{clip.name || clip.type}</span>
              {!grade.enabled && <span className="badge badge--amber">Bypassed</span>}
            </button>
            {locked && track && (
              <div className="color__locked">
                <Lock />
                <span>
                  {track.name || trackLabel(project, track)} is locked. Unlock the track to grade this clip.
                </span>
              </div>
            )}
            {tab === 'wheels' && <WheelsTab grade={grade} set={set} />}
            {tab === 'curves' && <CurvesTab grade={grade} set={set} />}
            {tab === 'hdr' && <HdrTab grade={grade} set={set} hdr={project.settings.colorMode !== 'sdr'} />}
            {tab === 'lut' && <LutTab grade={grade} set={set} project={project} clip={clip} />}
          </>
        )}
      </div>
    </>
  );
}

type SetGrade = (patch: Partial<Grade>, merge?: boolean) => void;

// ──────────────────────────────────────────────────────────────── wheels ──

const PHI = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
/** Largest colour offset a wheel can express when the puck is at the rim. */
const WHEEL_RANGE = 0.5;

function wheelToPuck(w: Wheel): { x: number; y: number } {
  // Inverse of the projection below (the three cosines form a tight frame with bound 3/2).
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < 3; i++) {
    cx += w[i] * Math.sin(PHI[i]);
    cy += w[i] * -Math.cos(PHI[i]);
  }
  const k = 2 / 3 / WHEEL_RANGE;
  return { x: cx * k, y: cy * k };
}

function puckToWheel(x: number, y: number, master: number): Wheel {
  const r = Math.min(1, Math.hypot(x, y));
  const a = Math.atan2(x, -y); // clockwise from the top, matching the conic gradient
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return [
    round(r * WHEEL_RANGE * Math.cos(a - PHI[0])),
    round(r * WHEEL_RANGE * Math.cos(a - PHI[1])),
    round(r * WHEEL_RANGE * Math.cos(a - PHI[2])),
    master,
  ];
}

/**
 * A channel value in at most four characters (`0`, `.25`, `-.25`, `1.5`): three of them have to
 * fit side by side under one wheel, also when all three are negative.
 */
function readout(v: number): string {
  const r = Math.round(v * 100) / 100;
  if (r === 0) return '0';
  const a = Math.abs(r);
  return (r < 0 ? '-' : '') + (a < 1 ? a.toFixed(2).slice(1) : a.toFixed(1));
}

function ColorWheel({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: Wheel;
  onChange: (w: Wheel, merge: boolean) => void;
  hint: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [active, setActive] = useState(false);
  const puck = wheelToPuck(value);
  const neutral = value.every((v) => v === 0);
  return (
    <div className="wheel" data-active={active}>
      <div className="wheel__head">
        <span {...tip(hint)}>{label}</span>
        <button
          className="wheel__reset"
          onClick={() => onChange([0, 0, 0, 0], false)}
          disabled={neutral}
          aria-label={`Reset ${label}`}
        >
          <RotateCcw />
        </button>
      </div>
      <div
        ref={ref}
        className="wheel__disc"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: puck.x, py: puck.y };
          setActive(true);
          beginGesture();
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const size = ref.current!.clientWidth / 2;
          // Relative, damped motion: a whole wheel radius of travel takes a deliberate drag.
          const gain = (e.shiftKey ? 0.15 : 0.5) / size;
          let x = d.px + (e.clientX - d.x) * gain;
          let y = d.py + (e.clientY - d.y) * gain;
          const r = Math.hypot(x, y);
          if (r > 1) {
            x /= r;
            y /= r;
          }
          onChange(puckToWheel(x, y, value[3]), true);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          drag.current = null;
          setActive(false);
        }}
        onDoubleClick={() => onChange([0, 0, 0, value[3]], false)}
      >
        <div className="wheel__cross" />
        <div className="wheel__puck" style={{ left: `${50 + puck.x * 46}%`, top: `${50 + puck.y * 46}%` }} />
      </div>
      <div className="wheel__master">
        <Slider
          value={value[3]}
          min={-1}
          max={1}
          origin={0}
          defaultValue={0}
          onStart={beginGesture}
          onChange={(m) => onChange([value[0], value[1], value[2], Math.round(m * 1000) / 1000], true)}
        />
      </div>
      <div className="wheel__read mono">
        <span style={{ color: '#ff7a7a' }}>{readout(value[0] + value[3])}</span>
        <span style={{ color: '#6ee787' }}>{readout(value[1] + value[3])}</span>
        <span style={{ color: '#7fb0ff' }}>{readout(value[2] + value[3])}</span>
      </div>
    </div>
  );
}

function GradeSlider({
  label,
  value,
  min,
  max,
  def,
  onChange,
  precision = 2,
  unit,
  gradient,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  def: number;
  onChange: (v: number) => void;
  precision?: number;
  unit?: string;
  gradient?: string;
}) {
  return (
    <div
      className="gslider"
      style={gradient ? ({ ['--track' as string]: gradient } as React.CSSProperties) : undefined}
      data-tinted={!!gradient}
    >
      <span className="gslider__label">{label}</span>
      <Slider
        value={value}
        min={min}
        max={max}
        origin={min < 0 ? 0 : def}
        defaultValue={def}
        onStart={beginGesture}
        onChange={onChange}
      />
      <NumberField
        value={value}
        onChange={onChange}
        onStart={beginGesture}
        min={min}
        max={max}
        step={(max - min) / 400}
        precision={precision}
        suffix={unit}
        defaultValue={def}
        ariaLabel={label}
        style={{ flex: '0 0 58px' }}
      />
    </div>
  );
}

function WheelsTab({ grade, set }: { grade: Grade; set: SetGrade }) {
  return (
    <div className="color__scroll">
      <div className="wheels">
        <ColorWheel
          label="Lift"
          hint="Shadows: raises or tints the darkest tones"
          value={grade.lift}
          onChange={(lift, m) => set({ lift }, m)}
        />
        <ColorWheel
          label="Gamma"
          hint="Mid-tones"
          value={grade.gamma}
          onChange={(gamma, m) => set({ gamma }, m)}
        />
        <ColorWheel
          label="Gain"
          hint="Highlights: scales the brightest tones"
          value={grade.gain}
          onChange={(gain, m) => set({ gain }, m)}
        />
        <ColorWheel
          label="Offset"
          hint="Shifts the whole image"
          value={grade.offset}
          onChange={(offset, m) => set({ offset }, m)}
        />
      </div>
      <div className="gsliders">
        <GradeSlider
          label="Temp"
          value={grade.temperature}
          min={-1}
          max={1}
          def={0}
          onChange={(temperature) => set({ temperature })}
          gradient="linear-gradient(90deg,#4f9dff,#e9e9ee,#ffb347)"
        />
        <GradeSlider
          label="Tint"
          value={grade.tint}
          min={-1}
          max={1}
          def={0}
          onChange={(tint) => set({ tint })}
          gradient="linear-gradient(90deg,#51cf66,#e9e9ee,#e05df5)"
        />
        <GradeSlider
          label="Exposure"
          value={grade.exposure}
          min={-5}
          max={5}
          def={0}
          onChange={(exposure) => set({ exposure })}
          unit="EV"
        />
        <GradeSlider
          label="Contrast"
          value={grade.contrast}
          min={-1}
          max={1}
          def={0}
          onChange={(contrast) => set({ contrast })}
        />
        <GradeSlider
          label="Pivot"
          value={grade.pivot}
          min={0.1}
          max={0.9}
          def={0.435}
          onChange={(pivot) => set({ pivot })}
        />
        <GradeSlider
          label="Highlights"
          value={grade.highlights}
          min={-1}
          max={1}
          def={0}
          onChange={(highlights) => set({ highlights })}
        />
        <GradeSlider
          label="Shadows"
          value={grade.shadows}
          min={-1}
          max={1}
          def={0}
          onChange={(shadows) => set({ shadows })}
        />
        <GradeSlider
          label="Whites"
          value={grade.whites}
          min={-1}
          max={1}
          def={0}
          onChange={(whites) => set({ whites })}
        />
        <GradeSlider
          label="Blacks"
          value={grade.blacks}
          min={-1}
          max={1}
          def={0}
          onChange={(blacks) => set({ blacks })}
        />
        <GradeSlider
          label="Saturation"
          value={grade.saturation}
          min={0}
          max={2}
          def={1}
          onChange={(saturation) => set({ saturation })}
          gradient="linear-gradient(90deg,#8a8a8a,#ff5d8f)"
        />
        <GradeSlider
          label="Vibrance"
          value={grade.vibrance}
          min={-1}
          max={1}
          def={0}
          onChange={(vibrance) => set({ vibrance })}
        />
        <GradeSlider
          label="Hue"
          value={grade.hue}
          min={-180}
          max={180}
          def={0}
          precision={0}
          unit="°"
          onChange={(hue) => set({ hue })}
          gradient="linear-gradient(90deg,#22d3ee,#4f6bff,#e05df5,#ff5d5d,#ffd43b,#51cf66,#22d3ee)"
        />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── curves ──

type CurveId = 'm' | 'r' | 'g' | 'b' | 'hueSat' | 'hueHue' | 'lumSat';

const CURVES: { id: CurveId; label: string; color: string; group: 'tone' | 'hue'; hint: string }[] = [
  { id: 'm', label: 'Master', color: '#f2f2f4', group: 'tone', hint: 'All channels' },
  { id: 'r', label: 'R', color: '#ff6b6b', group: 'tone', hint: 'Red' },
  { id: 'g', label: 'G', color: '#51cf66', group: 'tone', hint: 'Green' },
  { id: 'b', label: 'B', color: '#5aa2ff', group: 'tone', hint: 'Blue' },
  {
    id: 'hueSat',
    label: 'Hue → Sat',
    color: '#f2f2f4',
    group: 'hue',
    hint: 'Saturate or mute individual hues',
  },
  { id: 'hueHue', label: 'Hue → Hue', color: '#f2f2f4', group: 'hue', hint: 'Shift individual hues' },
  { id: 'lumSat', label: 'Luma → Sat', color: '#f2f2f4', group: 'hue', hint: 'Saturation by brightness' },
];

function getCurve(g: Grade, id: CurveId): CurvePoint[] {
  return id === 'hueSat' ? g.hueSat : id === 'hueHue' ? g.hueHue : id === 'lumSat' ? g.lumSat : g.curves[id];
}

function CurvesTab({ grade, set }: { grade: Grade; set: SetGrade }) {
  const [id, setId] = useState<CurveId>('m');
  const def = CURVES.find((c) => c.id === id)!;
  const points = getCurve(grade, id);
  const neutral = def.group === 'tone' ? IDENTITY_CURVE : FLAT_CURVE;
  const write = (pts: CurvePoint[], merge = true) => {
    if (id === 'hueSat' || id === 'hueHue' || id === 'lumSat') set({ [id]: pts } as Partial<Grade>, merge);
    else set({ curves: { ...grade.curves, [id]: pts } }, merge);
  };
  return (
    <div className="color__scroll color__scroll--fill">
      <div className="curve__tabs">
        {CURVES.map((c) => {
          const edited =
            JSON.stringify(getCurve(grade, c.id)) !==
            JSON.stringify(c.group === 'tone' ? IDENTITY_CURVE : FLAT_CURVE);
          return (
            <button
              key={c.id}
              className="chip"
              aria-pressed={id === c.id}
              onClick={() => setId(c.id)}
              {...tip(c.hint)}
            >
              {c.group === 'tone' && c.id !== 'm' && (
                <i
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: c.color,
                    display: 'inline-block',
                  }}
                />
              )}
              {c.label}
              {edited && <b className="curve__dot" />}
            </button>
          );
        })}
      </div>
      <CurveEditor
        points={points}
        color={def.color}
        hue={id === 'hueSat' || id === 'hueHue'}
        flat={def.group === 'hue'}
        onChange={write}
      />
      <div className="curve__foot">
        <span>Click to add a point · drag to shape · double-click a point to remove it</span>
        <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => write(neutral, false)}>
          Reset curve
        </Button>
      </div>
    </div>
  );
}

function CurveEditor({
  points,
  color,
  hue,
  flat,
  onChange,
}: {
  points: CurvePoint[];
  color: string;
  hue: boolean;
  flat: boolean;
  onChange: (pts: CurvePoint[], merge?: boolean) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const S = 256;
  const sorted = useMemo(() => [...points].sort((a, b) => a[0] - b[0]), [points]);
  const path = useMemo(() => {
    const samples = sampleCurve(sorted, 129);
    let d = '';
    for (let i = 0; i < samples.length; i++)
      d += `${i === 0 ? 'M' : 'L'}${((i / 128) * S).toFixed(2)} ${((1 - Math.min(1, Math.max(0, samples[i]))) * S).toFixed(2)}`;
    return d;
  }, [sorted]);

  const at = (e: { clientX: number; clientY: number }): CurvePoint => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
  };

  return (
    <svg
      ref={ref}
      className="curve"
      viewBox={`0 0 ${S} ${S}`}
      preserveAspectRatio="none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const p = at(e);
        // Grab an existing point if the pointer is close to one; otherwise add a new one.
        const r = ref.current!.getBoundingClientRect();
        let idx = sorted.findIndex((q) => Math.hypot((q[0] - p[0]) * r.width, (q[1] - p[1]) * r.height) < 12);
        beginGesture();
        let next = sorted;
        if (idx < 0) {
          next = [...sorted, p].sort((a, b) => a[0] - b[0]);
          idx = next.indexOf(p);
          onChange(next);
        }
        drag.current = idx;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const i = drag.current;
        if (i === null) return;
        const p = at(e);
        const next = sorted.map((q) => [q[0], q[1]] as CurvePoint);
        // End points stay pinned to their side; inner points cannot cross their neighbours.
        const lo = i === 0 ? 0 : next[i - 1][0] + 0.004;
        const hi = i === next.length - 1 ? 1 : next[i + 1][0] - 0.004;
        next[i] = [
          i === 0 && !flat
            ? Math.min(p[0], hi)
            : i === next.length - 1 && !flat
              ? Math.max(p[0], lo)
              : Math.min(hi, Math.max(lo, p[0])),
          p[1],
        ];
        if (flat && (i === 0 || i === next.length - 1)) {
          next[i][0] = i === 0 ? 0 : 1;
          // Hue wraps around, so the two ends move together.
          if (hue) next[i === 0 ? next.length - 1 : 0][1] = p[1];
        }
        onChange(next);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        drag.current = null;
      }}
      onDoubleClick={(e) => {
        const p = at(e);
        const r = ref.current!.getBoundingClientRect();
        const idx = sorted.findIndex(
          (q) => Math.hypot((q[0] - p[0]) * r.width, (q[1] - p[1]) * r.height) < 12,
        );
        if (idx > 0 && idx < sorted.length - 1)
          onChange(
            sorted.filter((_, i) => i !== idx),
            false,
          );
      }}
    >
      <defs>
        <linearGradient id="hue-bg" x1="0" x2="1" y1="0" y2="0">
          {['#ff4d4d', '#ffd43b', '#51cf66', '#22d3ee', '#4f6bff', '#e05df5', '#ff4d4d'].map((c, i) => (
            <stop key={i} offset={i / 6} stopColor={c} stopOpacity="0.22" />
          ))}
        </linearGradient>
      </defs>
      <rect width={S} height={S} fill={hue ? 'url(#hue-bg)' : 'transparent'} />
      <g className="curve__grid">
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v}>
            <line x1={v * S} y1={0} x2={v * S} y2={S} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={v * S} x2={S} y2={v * S} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {flat ? (
          <line
            className="curve__ref"
            x1={0}
            y1={S / 2}
            x2={S}
            y2={S / 2}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <line className="curve__ref" x1={0} y1={S} x2={S} y2={0} vectorEffect="non-scaling-stroke" />
        )}
      </g>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
      {sorted.map((p, i) => {
        // The graph is stretched to its box, which would turn a circle into an oval. A line of no
        // length with round ends and a stroke that does not scale is a round dot at any shape.
        const at = { x1: p[0] * S, y1: (1 - p[1]) * S, x2: p[0] * S, y2: (1 - p[1]) * S };
        return (
          <g key={i} className="curve__pt">
            <line {...at} stroke={color} vectorEffect="non-scaling-stroke" />
            <line {...at} className="curve__pt-fill" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────── HDR ──

const ZONES: { key: keyof Grade['zones']; label: string; stops: string }[] = [
  { key: 'black', label: 'Black', stops: '−6' },
  { key: 'shadow', label: 'Shadow', stops: '−3' },
  { key: 'mid', label: 'Mid', stops: '0' },
  { key: 'light', label: 'Light', stops: '+2' },
  { key: 'highlight', label: 'Highlight', stops: '+4' },
  { key: 'specular', label: 'Specular', stops: '+6' },
];

function HdrTab({ grade, set, hdr }: { grade: Grade; set: SetGrade; hdr: boolean }) {
  return (
    <div className="color__scroll">
      <div className="color__note">
        <b>Tonal zones</b>
        Each fader is an exposure offset in stops applied in linear light to one band of scene luminance,
        centred on the stop shown beneath it (relative to mid-grey). Use them to shape highlights and shadows
        independently — essential on HDR timelines, useful on any.
      </div>
      <div className="zones">
        {ZONES.map((z) => (
          <div key={z.key} className="zone">
            <div className="zone__val mono">
              {grade.zones[z.key] > 0 ? '+' : ''}
              {grade.zones[z.key].toFixed(2)}
            </div>
            <VFader
              value={grade.zones[z.key]}
              min={-4}
              max={4}
              onChange={(v) => set({ zones: { ...grade.zones, [z.key]: Math.round(v * 100) / 100 } })}
            />
            <div className="zone__label">{z.label}</div>
            <div className="zone__stops mono">{z.stops}</div>
          </div>
        ))}
      </div>
      <div className="color__note" style={{ marginTop: 14 }}>
        <b>Timeline colour</b>
        {hdr
          ? 'This is an HDR timeline: the working space is Rec.2020 and values above diffuse white are preserved through every effect and into export.'
          : 'This is an SDR timeline. Switch the project to HDR to grade and deliver in Rec.2100 PQ or HLG.'}
      </div>
      <ProjectSettingsForm />
    </div>
  );
}

function VFader({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastPress = useRef<Press | null>(null);
  const [active, setActive] = useState(false);
  const pct = ((value - min) / (max - min)) * 100;
  const from = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(max, Math.max(min, max - ((clientY - r.top) / r.height) * (max - min)));
  };
  return (
    <div
      ref={ref}
      className="vfader"
      data-active={active}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const press = { time: e.timeStamp, x: e.clientX, y: e.clientY };
        const second = isDoublePress(lastPress.current, press);
        lastPress.current = second ? null : press;
        // The second press of a double-click only asks for the reset that follows: it neither
        // jumps the fader again nor opens another undo step.
        if (second) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        beginGesture();
        onChange(from(e.clientY));
      }}
      onPointerMove={(e) => active && onChange(from(e.clientY))}
      onPointerUp={(e) => {
        if (!active) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setActive(false);
      }}
      onDoubleClick={() => onChange(0)}
    >
      <div className="vfader__track" />
      <div className="vfader__zero" />
      <div
        className="vfader__fill"
        style={{ bottom: `${Math.min(50, pct)}%`, height: `${Math.abs(pct - 50)}%` }}
      />
      <div className="vfader__thumb" style={{ bottom: `${pct}%` }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────── LUT & input ──

function LutTab({
  grade,
  set,
  project,
  clip,
}: {
  grade: Grade;
  set: SetGrade;
  project: Project;
  clip: Clip;
}) {
  const luts = Object.values(project.assets).filter((a) => a.kind === 'lut');
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
  const detected = resolveInputSpace(asset ? { inputColorSpace: 'auto', color: asset.color } : undefined);
  return (
    <div className="color__scroll">
      <div className="color__group">Look-up table</div>
      <Row label="LUT">
        <Select
          value={grade.lutId ?? 'none'}
          options={[
            { value: 'none', label: 'None' },
            ...luts.map((l) => ({ value: l.id, label: l.name.replace(/\.cube$/i, '') })),
          ]}
          onChange={(v) => set({ lutId: v === 'none' ? null : v }, false)}
        />
        <IconButton
          label="Import .cube LUT"
          onClick={async () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.cube';
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              const [a] = await cmd.importFiles([file]);
              if (a) set({ lutId: a.id }, false);
            };
            input.click();
          }}
        >
          <Plus />
        </IconButton>
        {grade.lutId && (
          <IconButton label="Remove LUT" onClick={() => set({ lutId: null }, false)}>
            <Trash2 />
          </IconButton>
        )}
      </Row>
      <Row label="Intensity">
        <Slider
          value={grade.lutIntensity}
          min={0}
          max={1}
          defaultValue={1}
          onStart={beginGesture}
          onChange={(lutIntensity) => set({ lutIntensity })}
          disabled={!grade.lutId}
        />
        <NumberField
          value={grade.lutIntensity}
          onChange={(lutIntensity) => set({ lutIntensity })}
          onStart={beginGesture}
          min={0}
          max={1}
          step={0.005}
          scale={100}
          precision={0}
          suffix="%"
          disabled={!grade.lutId}
        />
      </Row>
      <p className="form__hint">
        LUTs are applied after the grade, in the timeline’s display encoding. 3D .cube files up to 129³ are
        supported.
      </p>

      <div className="color__group" style={{ marginTop: 18 }}>
        Source colour space
      </div>
      {asset && (asset.kind === 'video' || asset.kind === 'image') ? (
        <>
          <Row label="Interpret as">
            <Select<InputColorSpace>
              value={asset.inputColorSpace}
              options={[
                { value: 'auto', label: `Auto — ${INPUT_COLOR_SPACES[detected].label}` },
                ...(Object.keys(INPUT_COLOR_SPACES) as Exclude<InputColorSpace, 'auto'>[]).map((k) => ({
                  value: k as InputColorSpace,
                  label: INPUT_COLOR_SPACES[k].label,
                  group:
                    k === 'slog3' || k === 'logc3' || k === 'vlog'
                      ? 'Camera log'
                      : k.startsWith('rec2020')
                        ? 'HDR'
                        : 'Standard',
                })),
              ]}
              onChange={(inputColorSpace) => {
                commit([{ op: 'updateAsset', id: asset.id, patch: { inputColorSpace } }]);
                toast(
                  `${asset.name} is now interpreted as ${inputColorSpace === 'auto' ? INPUT_COLOR_SPACES[detected].label : INPUT_COLOR_SPACES[inputColorSpace].label}`,
                  'info',
                );
              }}
            />
          </Row>
          <p className="form__hint">
            Applies to every clip that uses <b>{asset.name}</b>. Log footage is linearised with the camera’s
            published transfer function and gamut, then mapped into the timeline — rolled off on SDR
            timelines, kept at full range on HDR ones.
            {asset.hdr && ' This file is tagged as HDR.'}
          </p>
        </>
      ) : (
        <p className="form__hint">Generated clips (text, shapes, solids) are authored in sRGB.</p>
      )}
    </div>
  );
}
