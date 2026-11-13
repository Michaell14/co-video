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
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
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
  type ID,
  type InputColorSpace,
  type Project,
  type Wheel,
} from '@tandem/core';
import { sampleCurve } from '@tandem/engine';
import { usePlayer, useProject, useSession, useSessionMeta } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { beginGesture, commit, patchClips } from '../../state/props';
import { useUI } from '../../state/ui';
import { Button, IconButton, NumberField, Select, Slider, tip, toast } from '../../ui/core';
import { usingKeyboard } from '../../ui/layers';
import { isDoublePress, type Press } from '../../ui/press';
import { sliderKey } from '../../ui/slider';
import { onTabListKey } from '../editor/tabs';
import { Row } from '../inspector/controls';
import { useLiveSelect } from '../inspector/live';
import { ProjectSettingsForm } from '../inspector/ProjectSettings';
import { isShortcut, keepKey, useFaderKeys, useKeyRun } from '../inspector/sliderKeys';
import './color.css';

type Tab = 'wheels' | 'curves' | 'hdr' | 'lut';

const TABS: { id: Tab; label: string }[] = [
  { id: 'wheels', label: 'Wheels' },
  { id: 'curves', label: 'Curves' },
  { id: 'hdr', label: 'HDR' },
  { id: 'lut', label: 'LUT & Input' },
];

/** The clip to grade: the first picture clip of the selection, or else whatever is under `frame`. */
function activeClip(project: Project, selection: readonly ID[], frame: number): Clip | null {
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
}

/**
 * The clip the Colour workspace is working on. The panel is told only when that clip changes or
 * becomes another one: the playhead passes over it and other clips are edited without the wheels
 * and sliders being drawn again.
 */
function useActiveClip(): Clip | null {
  const session = useSession();
  const player = usePlayer();
  const selection = useUI((s) => s.selection);
  const frame = useRef<number | null>(null);
  frame.current ??= Math.floor(player?.getFrame() ?? 0);
  const subscribe = useCallback(
    (notify: () => void) => {
      frame.current = Math.floor(player?.getFrame() ?? 0);
      const offs = [
        session.store.subscribe(notify),
        useUI.subscribe((ui, before) => {
          if (ui.preview !== before.preview) notify();
        }),
        player?.onFrame((f) => {
          frame.current = Math.floor(f);
          notify();
        }),
      ];
      return () => offs.forEach((off) => off?.());
    },
    [session, player],
  );
  return useSyncExternalStore(subscribe, () =>
    activeClip(useUI.getState().preview ?? session.store.get(), selection, frame.current ?? 0),
  );
}

export function ColorPanel() {
  const readOnly = !useSession().canEdit;
  // Access can change while the panel is open.
  useSessionMeta();
  const clip = useActiveClip();
  const attributes = useUI((s) => s.attributes);
  // With the clip among several selected ones, a pasted grade goes onto all of them.
  const withSelection = useUI((s) => !!clip && s.selection.length > 1 && s.selection.includes(clip.id));
  // The clip under the playhead is shown whether or not its track is locked; a lock keeps every
  // control off it all the same.
  const track = useLiveSelect((p) => (clip ? p.tracks[clip.trackId] : undefined));
  const trackName = useLiveSelect((p) => (track ? track.name || trackLabel(p, track) : ''));
  const locked = !!track?.locked;
  const [tab, setTab] = useState<Tab>('wheels');
  const tabsRef = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState({ x: 0, w: 0 });
  const id = useId();
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el) setInk({ x: el.offsetLeft, w: el.offsetWidth });
  }, [tab]);

  const grade = clip?.grade ?? DEFAULT_GRADE;
  const set = (patch: Partial<Grade>, merge = true) => {
    if (!clip) return;
    patchClips([clip.id], (c) => ({ grade: { ...(c.grade ?? DEFAULT_GRADE), ...patch } }), merge);
  };
  const frozen = readOnly || locked;

  return (
    <>
      <div className="panel__head">
        <div
          className="tabs"
          role="tablist"
          aria-label="Grading tools"
          ref={tabsRef}
          onKeyDown={(e) => onTabListKey(e, (i) => setTab(TABS[i].id))}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`${id}-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${id}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              className="tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
          <div className="tabs__ink" style={{ width: ink.w, transform: `translateX(${ink.x}px)` }} />
        </div>
        <span className="panel__spacer" />
        {/* Someone who may not edit has no use for the grade's actions: in their place the panel
            says what the Inspector and the Mixer say, in the same words. */}
        {readOnly ? (
          <span className="badge badge--amber color__access">Read only</span>
        ) : (
          <>
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
              label={withSelection ? 'Paste grade onto the selected clips' : 'Paste grade'}
              disabled={!clip || !attributes?.look || locked}
              onClick={() => clip && cmd.pasteAttributes('grade', withSelection ? undefined : [clip.id])}
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
          </>
        )}
      </div>
      <div className="panel__body color" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
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
            {locked && (
              <div className="color__locked">
                <Lock />
                <span>{trackName} is locked. Unlock the track to grade this clip.</span>
              </div>
            )}
            {tab === 'wheels' && <WheelsTab grade={grade} set={set} frozen={frozen} />}
            {tab === 'curves' && <CurvesTab grade={grade} set={set} frozen={frozen} />}
            {tab === 'hdr' && <HdrTab grade={grade} set={set} frozen={frozen} />}
            {tab === 'lut' && <LutTab grade={grade} set={set} clip={clip} frozen={frozen} />}
          </>
        )}
      </div>
    </>
  );
}

/** What every tab of the panel is given. `frozen` puts its controls out of reach: no edit access, or a locked track. */
interface TabProps {
  grade: Grade;
  set: SetGrade;
  frozen: boolean;
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
  // Rounded to what is worth storing, and never a negative zero: a neutral wheel is all zeroes.
  const round = (v: number) => Math.round(v * 10000) / 10000 || 0;
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

/** The hues of the wheel, clockwise from the top, as the puck's direction is read out. */
const HUES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];

/** Where the puck stands, in words: `32% toward cyan`. */
function describePuck({ x, y }: { x: number; y: number }): string {
  const amount = Math.round(Math.min(1, Math.hypot(x, y)) * 100);
  if (amount === 0) return 'Neutral';
  const turn = (Math.atan2(x, -y) / (Math.PI * 2) + 1) % 1;
  return `${amount}% toward ${HUES[Math.round(turn * 6) % 6]}`;
}

/**
 * Where a key takes the puck. The arrows move it across the wheel, a hundredth of the wheel's
 * width at a time and ten with Shift. Page Up, Page Down, Home and End work on how far out it is,
 * along the hue it is on: more, less, none, all. Delete puts it back in the middle. `null` is a
 * key that has nothing to do where the puck stands, `undefined` one that is not the wheel's.
 */
function puckKey(
  key: string,
  shift: boolean,
  { x, y }: { x: number; y: number },
): { x: number; y: number } | null | undefined {
  const across = { min: -1, max: 1, defaultValue: 0 };
  if (key === 'ArrowLeft' || key === 'ArrowRight') return { x: sliderKey(key, shift, x, across)!, y };
  // Up is towards the top of the wheel, where the puck's own axis counts downwards.
  if (key === 'ArrowUp' || key === 'ArrowDown') return { x, y: -sliderKey(key, shift, -y, across)! };
  if (key === 'Delete' || key === 'Backspace') return x || y ? { x: 0, y: 0 } : null;
  const r = Math.hypot(x, y);
  const out = sliderKey(key, shift, r, { min: 0, max: 1 });
  if (out === undefined || out === null) return out;
  // In the middle the puck is on no hue, so there is no way out for it to take.
  if (r === 0 || out === r) return null;
  return { x: (x / r) * out, y: (y / r) * out };
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
  const run = useKeyRun();
  const puck = wheelToPuck(value);
  const neutral = value.every((v) => v === 0);
  const move = (x: number, y: number) => {
    const r = Math.max(1, Math.hypot(x, y));
    onChange(puckToWheel(x / r, y / r, value[3]), true);
  };
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
          run.rest();
          beginGesture();
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const size = ref.current!.clientWidth / 2;
          // Relative, damped motion: a whole wheel radius of travel takes a deliberate drag.
          const gain = (e.shiftKey ? 0.15 : 0.5) / size;
          move(d.px + (e.clientX - d.x) * gain, d.py + (e.clientY - d.y) * gain);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          drag.current = null;
          setActive(false);
        }}
        onDoubleClick={() => onChange([0, 0, 0, value[3]], false)}
      >
        <div className="wheel__cross" />
        {/* The puck is the wheel for the keyboard and for assistive technology. The pointer works
            the disc and never lands on the puck (color.css), so a drag does not leave the keyboard
            here: the arrow keys stay the editor's for someone using the mouse. */}
        <div
          className="wheel__puck"
          style={{ left: `${50 + puck.x * 46}%`, top: `${50 + puck.y * 46}%` }}
          role="slider"
          tabIndex={0}
          aria-label={`${label} colour balance`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, Math.hypot(puck.x, puck.y)) * 100)}
          aria-valuetext={describePuck(puck)}
          onBlur={run.rest}
          onKeyDown={(e) => {
            if (isShortcut(e)) return;
            const to = puckKey(e.key, e.shiftKey, puck);
            if (to === undefined) return;
            keepKey(e);
            if (to === null) return;
            run.press();
            move(to.x, to.y);
          }}
        />
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
          ariaLabel={`${label} master`}
          valueText={(m) => m.toFixed(2)}
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
        ariaLabel={label}
        valueText={(v) => `${v.toFixed(precision)}${unit ? ` ${unit}` : ''}`}
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

function WheelsTab({ grade, set, frozen }: TabProps) {
  return (
    <div className="color__scroll" inert={frozen}>
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

/** The least distance, in the curve's own units, between a point and the one beside it. */
const POINT_GAP = 0.004;

/**
 * The points of a curve after point `i` of `sorted` has been taken to `to`. End points stay on
 * their side and inner points do not cross their neighbours. A curve over hue comes round to
 * where it began, so its two ends are one point: they keep to the edges and move together.
 */
function movePoint(
  sorted: CurvePoint[],
  i: number,
  to: CurvePoint,
  { flat, hue }: { flat: boolean; hue: boolean },
): CurvePoint[] {
  const next = sorted.map((q) => [q[0], q[1]] as CurvePoint);
  const last = next.length - 1;
  const lo = i === 0 ? 0 : next[i - 1][0] + POINT_GAP;
  const hi = i === last ? 1 : next[i + 1][0] - POINT_GAP;
  const x =
    i === 0 && !flat
      ? Math.min(to[0], hi)
      : i === last && !flat
        ? Math.max(to[0], lo)
        : Math.min(hi, Math.max(lo, to[0]));
  next[i] = [x, to[1]];
  if (flat && (i === 0 || i === last)) {
    next[i][0] = i === 0 ? 0 : 1;
    if (hue) next[i === 0 ? last : 0][1] = to[1];
  }
  return next;
}

/** A new point for `sorted`: on the curve as it runs now, in the middle of its widest stretch. */
function pointBetween(sorted: CurvePoint[]): CurvePoint {
  let at = 0;
  for (let i = 1; i < sorted.length - 1; i++)
    if (sorted[i + 1][0] - sorted[i][0] > sorted[at + 1][0] - sorted[at][0]) at = i;
  const x = Math.round(((sorted[at][0] + sorted[at + 1][0]) / 2) * 1000) / 1000;
  const samples = sampleCurve(sorted, 1001);
  return [x, Math.round(Math.min(1, Math.max(0, samples[Math.round(x * 1000)])) * 1000) / 1000];
}

const samePoints = (a: CurvePoint[], b: CurvePoint[]): boolean =>
  a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

function CurvesTab({ grade, set, frozen }: TabProps) {
  const [id, setId] = useState<CurveId>('m');
  const def = CURVES.find((c) => c.id === id)!;
  const points = getCurve(grade, id);
  const neutral = def.group === 'tone' ? IDENTITY_CURVE : FLAT_CURVE;
  const write = (pts: CurvePoint[], merge = true) => {
    if (id === 'hueSat' || id === 'hueHue' || id === 'lumSat') set({ [id]: pts } as Partial<Grade>, merge);
    else set({ curves: { ...grade.curves, [id]: pts } }, merge);
  };
  // The point the keyboard has just added, to hand it the keyboard once it is drawn.
  const [added, setAdded] = useState<{ index: number } | null>(null);
  const add = () => {
    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    if (sorted.length < 2) return;
    const point = pointBetween(sorted);
    const next = [...sorted, point].sort((a, b) => a[0] - b[0]);
    write(next, false);
    if (usingKeyboard()) setAdded({ index: next.indexOf(point) });
  };
  return (
    <div className="color__scroll color__scroll--fill" inert={frozen}>
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
        name={curveName(def)}
        points={points}
        color={def.color}
        hue={id === 'hueSat' || id === 'hueHue'}
        flat={def.group === 'hue'}
        onChange={write}
        focusPoint={added}
      />
      <div className="curve__foot">
        <span>Click to add a point · drag to shape · double-click a point to remove it</span>
        <span className="curve__actions">
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={add}>
            Add point
          </Button>
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => write(neutral, false)}>
            Reset curve
          </Button>
        </span>
      </div>
    </div>
  );
}

/** What a curve is called where its chip only shows a letter. */
const curveName = (c: (typeof CURVES)[number]): string => (c.label.length === 1 ? c.hint : c.label);

/** A share of the graph's width or height, as it is read out. */
const percent = (v: number): string => `${Math.round(v * 100)}%`;

/** Where a point stands, in words. A curve over hue is read from its middle line, up or down. */
function describePoint([x, y]: CurvePoint, { flat, hue }: { flat: boolean; hue: boolean }): string {
  if (!flat) return `Input ${percent(x)}, output ${percent(y)}`;
  const offset = Math.round((y - 0.5) * 200);
  const from = hue ? `Hue ${Math.round(x * 360)}°` : `Brightness ${percent(x)}`;
  return `${from}, ${offset > 0 ? '+' : offset < 0 ? '−' : ''}${Math.abs(offset)}%`;
}

function CurveEditor({
  name,
  points,
  color,
  hue,
  flat,
  onChange,
  focusPoint,
}: {
  name: string;
  points: CurvePoint[];
  color: string;
  hue: boolean;
  flat: boolean;
  onChange: (pts: CurvePoint[], merge?: boolean) => void;
  /** A point to hand the keyboard to; a new object each time it is asked for. */
  focusPoint: { index: number } | null;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const run = useKeyRun();
  const S = 256;
  const sorted = useMemo(() => [...points].sort((a, b) => a[0] - b[0]), [points]);
  const path = useMemo(() => {
    const samples = sampleCurve(sorted, 129);
    let d = '';
    for (let i = 0; i < samples.length; i++)
      d += `${i === 0 ? 'M' : 'L'}${((i / 128) * S).toFixed(2)} ${((1 - Math.min(1, Math.max(0, samples[i]))) * S).toFixed(2)}`;
    return d;
  }, [sorted]);
  useLayoutEffect(() => {
    if (focusPoint) ref.current?.querySelector<SVGElement>(`[data-point="${focusPoint.index}"]`)?.focus();
  }, [focusPoint]);

  const at = (e: { clientX: number; clientY: number }): CurvePoint => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
  };

  /**
   * A key pressed on point `i`. The arrows move it a hundredth of the graph at a time, ten with
   * Shift; Page Up, Page Down, Home and End take it up and down. Delete removes it, unless it is
   * one of the two ends, which a curve cannot be without.
   */
  const onPointKey = (e: KeyboardEvent, i: number) => {
    if (isShortcut(e)) return;
    const [x, y] = sorted[i];
    const range = { min: 0, max: 1, step: 0.01 };
    let next: CurvePoint[] | null;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      next = i > 0 && i < sorted.length - 1 ? sorted.filter((_, j) => j !== i) : null;
    } else {
      const sideways = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const to = sliderKey(e.key, e.shiftKey, sideways ? x : y, range);
      if (to === undefined) return;
      next = to === null ? null : movePoint(sorted, i, sideways ? [to, y] : [x, to], { flat, hue });
    }
    keepKey(e);
    if (!next || samePoints(next, sorted)) return;
    run.press();
    onChange(next);
  };

  return (
    <svg
      ref={ref}
      className="curve"
      viewBox={`0 0 ${S} ${S}`}
      preserveAspectRatio="none"
      role="group"
      aria-label={`${name} curve`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const p = at(e);
        // Grab an existing point if the pointer is close to one; otherwise add a new one.
        const r = ref.current!.getBoundingClientRect();
        let idx = sorted.findIndex((q) => Math.hypot((q[0] - p[0]) * r.width, (q[1] - p[1]) * r.height) < 12);
        run.rest();
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
        onChange(movePoint(sorted, i, at(e), { flat, hue }));
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
            {/* The point for the keyboard and for assistive technology, and the ring it wears
                there. The pointer never lands on it (color.css): a drag takes hold of the dot. */}
            <line
              {...at}
              className="curve__pt-key"
              vectorEffect="non-scaling-stroke"
              data-point={i}
              role="slider"
              tabIndex={0}
              aria-label={`Point ${i + 1} of ${sorted.length}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(p[1] * 100)}
              aria-valuetext={describePoint(p, { flat, hue })}
              onBlur={run.rest}
              onKeyDown={(e) => onPointKey(e, i)}
            />
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

/** A zone's offset as it is shown above its fader and read out: `+0.50`. */
const stops = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;

function HdrTab({ grade, set, frozen }: TabProps) {
  const hdr = useProject((p) => p.settings.colorMode !== 'sdr');
  return (
    <div className="color__scroll" inert={frozen}>
      <div className="color__note">
        <b>Tonal zones</b>
        Each fader is an exposure offset in stops applied in linear light to one band of scene luminance,
        centred on the stop shown beneath it (relative to mid-grey). Use them to shape highlights and shadows
        independently — essential on HDR timelines, useful on any.
      </div>
      <div className="zones">
        {ZONES.map((z) => (
          <div key={z.key} className="zone">
            <div className="zone__val mono">{stops(grade.zones[z.key])}</div>
            <VFader
              label={`${z.label} zone`}
              valueText={`${stops(grade.zones[z.key])} stops`}
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
  label,
  valueText,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  valueText: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastPress = useRef<Press | null>(null);
  const [active, setActive] = useState(false);
  const keys = useFaderKeys({ value, min, max, step: 0.05, defaultValue: 0, onChange, label, valueText });
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
      <div className="vfader__thumb" style={{ bottom: `${pct}%` }} {...keys} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────── LUT & input ──

function LutTab({ grade, set, clip, frozen }: TabProps & { clip: Clip }) {
  const assets = useProject((p) => p.assets);
  const luts = Object.values(assets).filter((a) => a.kind === 'lut');
  const asset = clip.assetId ? assets[clip.assetId] : undefined;
  const detected = resolveInputSpace(asset ? { inputColorSpace: 'auto', color: asset.color } : undefined);
  return (
    <div className="color__scroll" inert={frozen}>
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
