import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  CaseUpper,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Link2,
  Palette,
  RotateCcw,
  Sparkles,
  Trash2,
  Unlink2,
  SlidersHorizontal,
  Diamond,
} from 'lucide-react';
import { useState } from 'react';
import {
  clipEnd,
  DEFAULT_MASK,
  DEFAULT_SHAPE,
  DEFAULT_TEXT,
  formatTimecode,
  fxPath,
  getEffectDef,
  getTransitionDef,
  maxTransitionDuration,
  removeEffect,
  setEffectParam,
  TEXT_ANIMATIONS,
  TRANSITIONS,
  type BlendMode,
  type Clip,
  type FitMode,
  type Mask,
  type Project,
  type ShapeProps,
  type TextProps,
  type Transition,
  toggleKeyframe,
} from '@tandem/core';
import { isNeutralGrade } from '@tandem/engine';
import { FONTS, fontByFamily } from '../../fonts';
import { currentSession, useLiveProject, useSession, useThrottledFrame } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { beginGesture, localFrameOf, patchClips, setClipValues } from '../../state/props';
import { useUI } from '../../state/ui';
import { Button, ColorField, IconButton, NumberField, Segmented, Select, Slider, Switch, TextField, tip } from '../../ui/core';
import { NumericRow, ParamControl, Row, Section, valueOf } from './controls';
import { ProjectSettingsForm } from './ProjectSettings';
import './inspector.css';

const BLEND_MODES: { value: BlendMode; label: string; group: string }[] = [
  { value: 'normal', label: 'Normal', group: 'Normal' },
  { value: 'darken', label: 'Darken', group: 'Darken' },
  { value: 'multiply', label: 'Multiply', group: 'Darken' },
  { value: 'color-burn', label: 'Color Burn', group: 'Darken' },
  { value: 'subtract', label: 'Subtract', group: 'Darken' },
  { value: 'lighten', label: 'Lighten', group: 'Lighten' },
  { value: 'screen', label: 'Screen', group: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge', group: 'Lighten' },
  { value: 'add', label: 'Add', group: 'Lighten' },
  { value: 'overlay', label: 'Overlay', group: 'Contrast' },
  { value: 'soft-light', label: 'Soft Light', group: 'Contrast' },
  { value: 'hard-light', label: 'Hard Light', group: 'Contrast' },
  { value: 'difference', label: 'Difference', group: 'Inversion' },
  { value: 'exclusion', label: 'Exclusion', group: 'Inversion' },
  { value: 'hue', label: 'Hue', group: 'Component' },
  { value: 'saturation', label: 'Saturation', group: 'Component' },
  { value: 'color', label: 'Color', group: 'Component' },
  { value: 'luminosity', label: 'Luminosity', group: 'Component' },
];

export function Inspector() {
  const session = useSession();
  const project = useLiveProject((p) => p);
  const selection = useUI((s) => s.selection);
  const selTrans = useUI((s) => s.selectedTransition);
  // Re-read animated values as the playhead moves.
  useThrottledFrame(10);
  const clips = selection.map((id) => project.clips[id]).filter(Boolean);
  const readOnly = !session.canEdit;

  let title = 'Project';
  let body: React.ReactNode;
  if (selTrans && project.clips[selTrans.clipId]) {
    title = 'Transition';
    body = <TransitionInspector project={project} clip={project.clips[selTrans.clipId]} side={selTrans.side} />;
  } else if (clips.length) {
    title = clips.length === 1 ? clips[0].name || labelFor(clips[0]) : `${clips.length} clips`;
    body = <ClipInspector project={project} clips={clips} />;
  } else {
    body = (
      <div className="insp__project">
        <ProjectSettingsForm />
        <p className="form__hint">Select a clip to see its properties. Hold Shift to select several and edit them together.</p>
      </div>
    );
  }

  return (
    <>
      <div className="panel__head">
        <SlidersHorizontal size={14} style={{ marginLeft: 8, color: 'var(--fg-3)' }} />
        <div className="panel__title insp__title">{title}</div>
        {clips.length === 1 && !selTrans && <span className="badge">{clips[0].type}</span>}
        <span className="panel__spacer" />
        {readOnly && <span className="badge badge--amber">Read only</span>}
      </div>
      <div className="panel__body" data-readonly={readOnly}>
        {body}
      </div>
    </>
  );
}

const labelFor = (c: Clip) => (c.type === 'text' ? 'Text' : c.type[0].toUpperCase() + c.type.slice(1));

// ───────────────────────────────────────────────────────────────── clips ──

function ClipInspector({ project, clips }: { project: Project; clips: Clip[] }) {
  const visual = clips.filter((c) => c.type !== 'audio');
  const media = clips.filter((c) => c.type === 'video' || c.type === 'image');
  const audio = clips.filter((c) => c.type === 'audio');
  const timed = clips.filter((c) => (c.type === 'video' || c.type === 'audio') && !c.freeze);
  const transformable = visual.filter((c) => c.type !== 'adjustment');
  const first = clips[0];
  const s = project.settings;
  return (
    <div className="rows">
      <div className="insp__timing mono">
        <span {...tip('Start')}>{formatTimecode(first.start, s)}</span>
        <i />
        <span {...tip('End')}>{formatTimecode(clipEnd(first), s)}</span>
        <b {...tip('Duration')}>{formatTimecode(first.duration, s)}</b>
      </div>
      {first.type === 'text' && first.text && clips.length === 1 && <TextSection clip={first} />}
      {first.type === 'shape' && first.shape && clips.length === 1 && <ShapeSection clip={first} />}
      {first.type === 'solid' && clips.length === 1 && <SolidSection clip={first} />}
      {transformable.length > 0 && <TransformSection clips={transformable} project={project} />}
      {visual.length > 0 && <CompositeSection clips={visual} />}
      {media.length > 0 && <CropSection clips={media} />}
      {visual.length > 0 && <MaskSection clips={visual} />}
      {timed.length > 0 && <SpeedSection clips={timed} project={project} />}
      {audio.length > 0 && <AudioSection clips={audio} project={project} />}
      {visual.length > 0 && <ColorSummary clips={visual} />}
      {visual.length === 1 && <EffectsSection clip={visual[0]} />}
    </div>
  );
}

function TransformSection({ clips, project }: { clips: Clip[]; project: Project }) {
  const ids = clips.map((c) => c.id);
  const [linked, setLinked] = useState(true);
  const first = clips[0];
  const { width, height } = project.settings;
  const reset = () => patchClips(ids, (c) => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, keyframes: stripKeys(c, ['x', 'y', 'scaleX', 'scaleY', 'rotation']) }));
  return (
    <Section
      id="transform"
      title="Transform"
      actions={
        <IconButton small label="Reset transform" onClick={reset}>
          <RotateCcw />
        </IconButton>
      }
    >
      <NumericRow clips={clips} path="x" label="Position X" scale={width} step={1 / width} precision={0} suffix="px" defaultValue={0} />
      <NumericRow clips={clips} path="y" label="Position Y" scale={height} step={1 / height} precision={0} suffix="px" defaultValue={0} />
      {linked ? (
        <LinkedScale clips={clips} onUnlink={() => setLinked(false)} />
      ) : (
        <>
          <NumericRow clips={clips} path="scaleX" label="Scale X" scale={100} step={0.005} precision={1} suffix="%" defaultValue={1} slider min={0} max={4} />
          <NumericRow clips={clips} path="scaleY" label="Scale Y" scale={100} step={0.005} precision={1} suffix="%" defaultValue={1} slider min={0} max={4} />
          <Row label="">
            <Button size="sm" variant="ghost" icon={<Link2 />} onClick={() => setLinked(true)}>
              Link scale
            </Button>
          </Row>
        </>
      )}
      <NumericRow clips={clips} path="rotation" label="Rotation" step={0.25} precision={1} suffix="°" defaultValue={0} slider min={-180} max={180} origin={0} />
      {(first.type === 'video' || first.type === 'image') && (
        <Row label="Fit">
          <Select<FitMode>
            value={first.fit}
            options={[
              { value: 'contain', label: 'Fit inside frame' },
              { value: 'cover', label: 'Fill frame (crop)' },
              { value: 'stretch', label: 'Stretch to frame' },
              { value: 'none', label: 'Original size' },
            ]}
            onChange={(fit) => patchClips(ids, { fit })}
          />
        </Row>
      )}
      <Row label="Flip">
        <IconButton label="Flip horizontally" active={first.flipH} onClick={() => patchClips(ids, { flipH: !first.flipH })}>
          <FlipHorizontal2 />
        </IconButton>
        <IconButton label="Flip vertically" active={first.flipV} onClick={() => patchClips(ids, { flipV: !first.flipV })}>
          <FlipVertical2 />
        </IconButton>
      </Row>
    </Section>
  );
}

/** Uniform scale: one control drives both axes (each keeps its own sign, so flips survive). */
function LinkedScale({ clips, onUnlink }: { clips: Clip[]; onUnlink: () => void }) {
  const ids = clips.map((c) => c.id);
  const first = clips[0];
  const v = Math.abs(valueOf(first, 'scaleX', 1));
  const animatedNow = !!first.keyframes.scaleX?.length;
  const lf = localFrameOf(first);
  const onKey = animatedNow && first.keyframes.scaleX.some((k) => k.t === lf);
  const set = (val: number) => {
    const p = currentSession()?.store.get();
    if (!p) return;
    for (const id of ids) {
      const c = p.clips[id];
      if (c) setClipValues([id], { scaleX: Math.sign(c.scaleX || 1) * val, scaleY: Math.sign(c.scaleY || 1) * val });
    }
  };
  return (
    <div className="row">
      <div className="row__label">
        <button
          className="kf"
          data-animated={animatedNow}
          aria-label="Toggle keyframe for Scale"
          aria-pressed={onKey}
          onClick={() =>
            patchClips(ids, (c) => {
              const a = toggleKeyframe(c, 'scaleX', localFrameOf(c), valueOf(c, 'scaleX', 1));
              return { ...a, ...toggleKeyframe({ ...c, ...a }, 'scaleY', localFrameOf(c), valueOf(c, 'scaleY', 1)) };
            })
          }
          {...tip(animatedNow ? 'Add / remove keyframe' : 'Animate: add a keyframe')}
        >
          <Diamond fill={onKey ? 'currentColor' : 'none'} strokeWidth={2.5} />
        </button>
        <span>Scale</span>
      </div>
      <div className="row__ctrl">
        <Slider value={Math.min(4, v)} min={0} max={4} onChange={set} onStart={beginGesture} defaultValue={1} />
        <NumberField value={v} onChange={set} onStart={beginGesture} min={0} max={50} step={0.005} scale={100} precision={1} suffix="%" defaultValue={1} ariaLabel="Scale" />
        <button className="insp__link" onClick={onUnlink} aria-label="Unlink scale axes" {...tip('Scale X and Y separately')}>
          <Unlink2 />
        </button>
      </div>
    </div>
  );
}

function CompositeSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id);
  return (
    <Section id="composite" title="Opacity & Blend">
      <NumericRow clips={clips} path="opacity" label="Opacity" scale={100} step={0.005} precision={0} suffix="%" defaultValue={1} slider min={0} max={1} />
      {clips[0].type !== 'adjustment' && (
        <Row label="Blend mode">
          <Select<BlendMode> value={clips[0].blend} options={BLEND_MODES} onChange={(blend) => patchClips(ids, { blend })} />
        </Row>
      )}
    </Section>
  );
}

function CropSection({ clips }: { clips: Clip[] }) {
  const p = { scale: 100, step: 0.002, precision: 1, suffix: '%', defaultValue: 0, slider: true, min: 0, max: 1 } as const;
  return (
    <Section id="crop" title="Crop" defaultCollapsed>
      <NumericRow clips={clips} path="cropL" label="Left" {...p} />
      <NumericRow clips={clips} path="cropR" label="Right" {...p} />
      <NumericRow clips={clips} path="cropT" label="Top" {...p} />
      <NumericRow clips={clips} path="cropB" label="Bottom" {...p} />
    </Section>
  );
}

function MaskSection({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id);
  const mask = clips[0].mask;
  const set = (patch: Partial<Mask>, merge = true) => patchClips(ids, (c) => ({ mask: { ...(c.mask ?? DEFAULT_MASK), ...patch } }), merge);
  const num = (key: keyof Mask, label: string, min: number, max: number, scale = 100, suffix = '%') => (
    <Row label={label}>
      <Slider value={(mask?.[key] as number) ?? 0} min={min} max={max} onChange={(v) => set({ [key]: v })} onStart={beginGesture} defaultValue={DEFAULT_MASK[key] as number} />
      <NumberField value={(mask?.[key] as number) ?? 0} onChange={(v) => set({ [key]: v })} onStart={beginGesture} min={min} max={max} step={(max - min) / 400} scale={scale} precision={scale === 1 ? 0 : 0} suffix={suffix} />
    </Row>
  );
  return (
    <Section id="mask" title="Mask" defaultCollapsed>
      <Row label="Shape">
        <Segmented
          block
          value={mask ? mask.type : 'none'}
          options={[
            { value: 'none', label: 'None' },
            { value: 'rect', label: 'Rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
          ]}
          onChange={(v) => patchClips(ids, (c) => ({ mask: v === 'none' ? null : { ...(c.mask ?? DEFAULT_MASK), type: v } }))}
        />
      </Row>
      {mask && (
        <>
          {num('x', 'Centre X', 0, 1)}
          {num('y', 'Centre Y', 0, 1)}
          {num('w', 'Width', 0, 2)}
          {num('h', 'Height', 0, 2)}
          {num('rotation', 'Rotation', -180, 180, 1, '°')}
          {num('feather', 'Feather', 0, 0.5)}
          {mask.type === 'rect' && num('radius', 'Roundness', 0, 1)}
          <Row label="Invert">
            <Switch checked={mask.invert} onChange={(invert) => set({ invert }, false)} label="Invert mask" />
          </Row>
        </>
      )}
    </Section>
  );
}

function SpeedSection({ clips, project }: { clips: Clip[]; project: Project }) {
  const first = clips[0];
  const [draft, setDraft] = useState<number | null>(null);
  const speed = draft ?? first.speed;
  return (
    <Section id="speed" title="Speed" defaultCollapsed={first.speed === 1 && !first.reverse}>
      <Row label="Speed">
        <Slider value={Math.log2(speed)} min={-3} max={4} onChange={(v) => setDraft(Math.round(Math.pow(2, v) * 100) / 100)} onEnd={() => { if (draft !== null) cmd.setSpeed(draft); setDraft(null); }} origin={0} defaultValue={0} />
        <NumberField value={speed} onChange={(v) => cmd.setSpeed(v)} min={0.05} max={100} step={0.01} scale={100} precision={0} suffix="%" defaultValue={1} />
      </Row>
      <Row label="Presets">
        {[0.25, 0.5, 1, 2, 4].map((v) => (
          <button key={v} className="chip" aria-pressed={first.speed === v} onClick={() => cmd.setSpeed(v)}>
            {v}×
          </button>
        ))}
      </Row>
      <Row label="Reverse">
        <Switch checked={first.reverse} onChange={(r) => cmd.setSpeed(first.speed, r)} label="Reverse" />
      </Row>
      <Row label="Duration">
        <span className="mono insp__read">{formatTimecode(first.duration, project.settings)}</span>
      </Row>
    </Section>
  );
}

function AudioSection({ clips, project }: { clips: Clip[]; project: Project }) {
  const ids = clips.map((c) => c.id);
  const first = clips[0];
  const fps = project.settings.fpsNum / project.settings.fpsDen;
  const fade = (key: 'fadeIn' | 'fadeOut', label: string) => (
    <Row label={label}>
      <Slider value={first[key] / fps} min={0} max={Math.min(10, first.duration / fps)} onChange={(v) => patchClips(ids, (c) => ({ [key]: Math.min(c.duration, Math.round(v * fps)) }), true)} onStart={beginGesture} defaultValue={0} />
      <NumberField value={first[key] / fps} onChange={(v) => patchClips(ids, (c) => ({ [key]: Math.min(c.duration, Math.max(0, Math.round(v * fps))) }), true)} onStart={beginGesture} min={0} max={first.duration / fps} step={0.02} precision={2} suffix="s" defaultValue={0} />
    </Row>
  );
  return (
    <Section id="audio" title="Audio">
      <NumericRow clips={clips} path="volume" label="Volume" step={0.1} precision={1} suffix="dB" defaultValue={0} slider min={-48} max={12} origin={0} />
      <NumericRow clips={clips} path="pan" label="Pan" step={0.01} precision={2} defaultValue={0} slider min={-1} max={1} origin={0} />
      {fade('fadeIn', 'Fade in')}
      {fade('fadeOut', 'Fade out')}
      <Row label="Mute">
        <Switch checked={first.audioMuted} onChange={(audioMuted) => patchClips(ids, { audioMuted })} label="Mute clip" />
      </Row>
    </Section>
  );
}

function ColorSummary({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id);
  const first = clips[0];
  const active = !!first.grade && first.grade.enabled && !isNeutralGrade(first.grade);
  return (
    <Section id="colorsum" title="Color">
      <Row label="Grade">
        <span className="insp__read">{active ? 'Graded' : 'No grade'}</span>
        <span style={{ flex: 1 }} />
        {first.grade && (
          <Switch checked={first.grade.enabled} onChange={(enabled) => patchClips(ids, (c) => (c.grade ? { grade: { ...c.grade, enabled } } : {}))} label="Enable grade" />
        )}
      </Row>
      <Button block icon={<Palette />} onClick={() => useUI.getState().set({ workspace: 'color' })}>
        Open in Color workspace
      </Button>
    </Section>
  );
}

// ─────────────────────────────────────────────────────────────── effects ──

function EffectsSection({ clip }: { clip: Clip }) {
  const ids = [clip.id];
  const move = (i: number, dir: -1 | 1) => {
    const list = clip.effects.slice();
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    patchClips(ids, { effects: list });
  };
  return (
    <Section
      id="effects"
      title={
        <>
          Effects {clip.effects.length > 0 && <span className="badge badge--accent" style={{ marginLeft: 4 }}>{clip.effects.length}</span>}
        </>
      }
      actions={
        <IconButton small label="Browse effects" onClick={() => useUI.getState().set({ workspace: 'edit', libraryTab: 'effects' })}>
          <Sparkles />
        </IconButton>
      }
    >
      {clip.effects.length === 0 && (
        <div className="insp__empty">
          Drag an effect from the library onto a clip, or
          <button className="insp__linkbtn" onClick={() => useUI.getState().set({ workspace: 'edit', libraryTab: 'effects' })}>
            browse effects
          </button>
          .
        </div>
      )}
      {clip.effects.map((fx, i) => {
        const def = getEffectDef(fx.type);
        return (
          <div key={fx.id} className="fxitem" data-off={!fx.enabled}>
            <div className="fxitem__head">
              <Switch checked={fx.enabled} onChange={(enabled) => patchClips(ids, (c) => ({ effects: c.effects.map((e) => (e.id === fx.id ? { ...e, enabled } : e)) }))} label={`Enable ${def?.name ?? fx.type}`} />
              <span className="fxitem__name">{def?.name ?? fx.type}</span>
              <IconButton small label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </IconButton>
              <IconButton small label="Move down" disabled={i === clip.effects.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown />
              </IconButton>
              <IconButton small label="Remove effect" onClick={() => patchClips(ids, (c) => removeEffect(c, fx.id))}>
                <Trash2 />
              </IconButton>
            </div>
            {def && fx.enabled && (
              <div className="fxitem__body">
                {def.params.map((p) => (
                  <ParamControl
                    key={p.key}
                    def={p}
                    value={fx.params[p.key]}
                    onNumber={() => {}}
                    onValue={(v, merge) => patchClips(ids, (c) => setEffectParam(c, fx.id, p.key, v), merge)}
                    numericRow={(d) => (
                      <NumericRow
                        clips={[clip]}
                        path={fxPath(fx.id, d.key)}
                        label={d.label}
                        min={d.type === 'angle' ? -360 : d.min}
                        max={d.type === 'angle' ? 360 : d.max}
                        step={d.type === 'angle' ? 1 : (d.step ?? 0.01)}
                        precision={d.type === 'angle' || (d.type === 'float' && (d.step ?? 0.01) >= 1) ? 0 : 2}
                        suffix={d.type === 'angle' ? '°' : d.unit}
                        defaultValue={d.default}
                        slider
                        origin={d.type === 'angle' || d.min < 0 ? 0 : undefined}
                      />
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────── text ──

function TextSection({ clip }: { clip: Clip }) {
  const t = clip.text!;
  const ids = [clip.id];
  const set = (patch: Partial<TextProps>, merge = false) => patchClips(ids, (c) => ({ text: { ...(c.text ?? DEFAULT_TEXT), ...patch } }), merge);
  const font = fontByFamily(t.font) ?? FONTS[0];
  const num = (label: string, value: number, apply: (v: number) => Partial<TextProps>, min: number, max: number, opts: { scale?: number; suffix?: string; precision?: number; def?: number } = {}) => (
    <Row label={label}>
      <Slider value={value} min={min} max={max} onChange={(v) => set(apply(v), true)} onStart={beginGesture} defaultValue={opts.def} />
      <NumberField value={value} onChange={(v) => set(apply(v), true)} onStart={beginGesture} min={min} max={max} step={(max - min) / 300} scale={opts.scale ?? 1} precision={opts.precision ?? 2} suffix={opts.suffix} defaultValue={opts.def} />
    </Row>
  );
  return (
    <>
      <Section id="text" title="Text">
        <TextField value={t.content} onChange={(content) => set({ content }, true)} onFocus={beginGesture} multiline rows={3} ariaLabel="Text content" placeholder="Type something" />
        <Row label="Font">
          <Select
            value={font.family}
            options={FONTS.map((f) => ({ value: f.family, label: f.label, group: f.category, style: { fontFamily: `"${f.family}"` } }))}
            onChange={(family) => {
              const next = fontByFamily(family)!;
              set({ font: family, weight: next.weights.includes(t.weight) ? t.weight : next.weights.reduce((a, b) => (Math.abs(b - t.weight) < Math.abs(a - t.weight) ? b : a)) });
            }}
          />
        </Row>
        <Row label="Weight">
          <Select value={t.weight} options={font.weights.map((w) => ({ value: w, label: WEIGHT_NAMES[w] ?? String(w) }))} onChange={(weight) => set({ weight })} />
          <IconButton label="Italic" active={t.italic} onClick={() => set({ italic: !t.italic })}>
            <Italic />
          </IconButton>
          <IconButton label="Uppercase" active={t.uppercase} onClick={() => set({ uppercase: !t.uppercase })}>
            <CaseUpper />
          </IconButton>
        </Row>
        {num('Size', t.size, (size) => ({ size }), 0.01, 0.5, { scale: 1000, precision: 0, def: DEFAULT_TEXT.size })}
        <Row label="Align">
          <Segmented
            value={t.align}
            options={[
              { value: 'left', icon: <AlignLeft />, tip: 'Align left' },
              { value: 'center', icon: <AlignCenter />, tip: 'Align centre' },
              { value: 'right', icon: <AlignRight />, tip: 'Align right' },
            ]}
            onChange={(align) => set({ align })}
          />
        </Row>
        <Row label="Colour">
          <ColorField value={t.color.slice(0, 7)} onChange={(color) => set({ color }, true)} onStart={beginGesture} />
        </Row>
        {num('Line height', t.lineHeight, (lineHeight) => ({ lineHeight }), 0.7, 2.5, { def: DEFAULT_TEXT.lineHeight })}
        {num('Tracking', t.letterSpacing, (letterSpacing) => ({ letterSpacing }), -0.1, 0.6, { scale: 100, precision: 0, def: 0 })}
        <Row label="Wrap width">
          <Switch checked={t.boxWidth !== null} onChange={(on) => set({ boxWidth: on ? 0.8 : null })} label="Wrap text" />
          {t.boxWidth !== null && (
            <NumberField value={t.boxWidth} onChange={(boxWidth) => set({ boxWidth }, true)} onStart={beginGesture} min={0.05} max={1} step={0.002} scale={100} precision={0} suffix="%" />
          )}
        </Row>
      </Section>
      <Section id="text-style" title="Text style" defaultCollapsed>
        <Row label="Gradient">
          <Switch checked={t.gradient.enabled} onChange={(enabled) => set({ gradient: { ...t.gradient, enabled } })} label="Gradient fill" />
        </Row>
        {t.gradient.enabled && (
          <>
            <Row label="From">
              <ColorField value={t.gradient.from} onChange={(from) => set({ gradient: { ...t.gradient, from } }, true)} onStart={beginGesture} />
            </Row>
            <Row label="To">
              <ColorField value={t.gradient.to} onChange={(to) => set({ gradient: { ...t.gradient, to } }, true)} onStart={beginGesture} />
            </Row>
            {num('Angle', t.gradient.angle, (angle) => ({ gradient: { ...t.gradient, angle } }), 0, 360, { precision: 0, suffix: '°' })}
          </>
        )}
        <Row label="Outline">
          <Switch checked={t.stroke.enabled} onChange={(enabled) => set({ stroke: { ...t.stroke, enabled } })} label="Outline" />
        </Row>
        {t.stroke.enabled && (
          <>
            <Row label="Colour">
              <ColorField value={t.stroke.color} onChange={(color) => set({ stroke: { ...t.stroke, color } }, true)} onStart={beginGesture} />
            </Row>
            {num('Width', t.stroke.width, (width) => ({ stroke: { ...t.stroke, width } }), 0, 0.3, { scale: 100, precision: 1 })}
          </>
        )}
        <Row label="Shadow">
          <Switch checked={t.shadow.enabled} onChange={(enabled) => set({ shadow: { ...t.shadow, enabled } })} label="Shadow" />
        </Row>
        {t.shadow.enabled && (
          <>
            <Row label="Colour">
              <ColorField value={t.shadow.color} onChange={(color) => set({ shadow: { ...t.shadow, color } }, true)} onStart={beginGesture} />
            </Row>
            {num('Opacity', t.shadow.opacity, (opacity) => ({ shadow: { ...t.shadow, opacity } }), 0, 1, { scale: 100, precision: 0, suffix: '%' })}
            {num('Blur', t.shadow.blur, (blur) => ({ shadow: { ...t.shadow, blur } }), 0, 1, { scale: 100, precision: 0 })}
            {num('Offset X', t.shadow.x, (x) => ({ shadow: { ...t.shadow, x } }), -0.5, 0.5, { scale: 100, precision: 0 })}
            {num('Offset Y', t.shadow.y, (y) => ({ shadow: { ...t.shadow, y } }), -0.5, 0.5, { scale: 100, precision: 0 })}
          </>
        )}
        <Row label="Background">
          <Switch checked={t.bg.enabled} onChange={(enabled) => set({ bg: { ...t.bg, enabled } })} label="Background box" />
        </Row>
        {t.bg.enabled && (
          <>
            <Row label="Colour">
              <ColorField value={t.bg.color} onChange={(color) => set({ bg: { ...t.bg, color } }, true)} onStart={beginGesture} />
            </Row>
            {num('Opacity', t.bg.opacity, (opacity) => ({ bg: { ...t.bg, opacity } }), 0, 1, { scale: 100, precision: 0, suffix: '%' })}
            {num('Padding X', t.bg.padX, (padX) => ({ bg: { ...t.bg, padX } }), 0, 2, { scale: 100, precision: 0 })}
            {num('Padding Y', t.bg.padY, (padY) => ({ bg: { ...t.bg, padY } }), 0, 2, { scale: 100, precision: 0 })}
            {num('Corners', t.bg.radius, (radius) => ({ bg: { ...t.bg, radius } }), 0, 1.5, { scale: 100, precision: 0 })}
          </>
        )}
      </Section>
      <Section id="text-anim" title="Animation">
        <Row label="In">
          <Select value={t.animIn.type} options={TEXT_ANIMATIONS.map((a) => ({ value: a.id, label: a.name }))} onChange={(type) => set({ animIn: { ...t.animIn, type } })} />
          <NumberField value={t.animIn.duration} onChange={(d) => set({ animIn: { ...t.animIn, duration: Math.round(d) } }, true)} onStart={beginGesture} min={1} max={clip.duration} step={0.25} precision={0} suffix="f" />
        </Row>
        <Row label="Out">
          <Select value={t.animOut.type} options={TEXT_ANIMATIONS.map((a) => ({ value: a.id, label: a.name }))} onChange={(type) => set({ animOut: { ...t.animOut, type } })} />
          <NumberField value={t.animOut.duration} onChange={(d) => set({ animOut: { ...t.animOut, duration: Math.round(d) } }, true)} onStart={beginGesture} min={1} max={clip.duration} step={0.25} precision={0} suffix="f" />
        </Row>
      </Section>
    </>
  );
}

const WEIGHT_NAMES: Record<number, string> = { 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extrabold', 900: 'Black' };

function ShapeSection({ clip }: { clip: Clip }) {
  const sh = clip.shape!;
  const ids = [clip.id];
  const set = (patch: Partial<ShapeProps>, merge = false) => patchClips(ids, (c) => ({ shape: { ...(c.shape ?? DEFAULT_SHAPE), ...patch } }), merge);
  const open = sh.kind === 'line' || sh.kind === 'arrow';
  const num = (label: string, key: 'w' | 'h' | 'strokeWidth' | 'radius' | 'sides', min: number, max: number, scale = 100, precision = 0) => (
    <Row label={label}>
      <Slider value={sh[key]} min={min} max={max} onChange={(v) => set({ [key]: key === 'sides' ? Math.round(v) : v }, true)} onStart={beginGesture} />
      <NumberField value={sh[key]} onChange={(v) => set({ [key]: key === 'sides' ? Math.round(v) : v }, true)} onStart={beginGesture} min={min} max={max} step={(max - min) / 300} scale={scale} precision={precision} />
    </Row>
  );
  return (
    <Section id="shape" title="Shape">
      <Row label="Type">
        <Select
          value={sh.kind}
          options={[
            { value: 'rect', label: 'Rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
            { value: 'triangle', label: 'Triangle' },
            { value: 'star', label: 'Star' },
            { value: 'polygon', label: 'Polygon' },
            { value: 'line', label: 'Line' },
            { value: 'arrow', label: 'Arrow' },
          ]}
          onChange={(kind) => set({ kind })}
        />
      </Row>
      {num('Width', 'w', 0.01, 1.5)}
      {num('Height', 'h', 0.01, 1.5)}
      {!open && (
        <>
          <Row label="Fill">
            <Switch checked={sh.fillEnabled} onChange={(fillEnabled) => set({ fillEnabled })} label="Fill" />
            {sh.fillEnabled && !sh.gradient.enabled && <ColorField value={sh.fill} onChange={(fill) => set({ fill }, true)} onStart={beginGesture} />}
          </Row>
          <Row label="Gradient">
            <Switch checked={sh.gradient.enabled} onChange={(enabled) => set({ gradient: { ...sh.gradient, enabled } })} label="Gradient fill" />
          </Row>
          {sh.gradient.enabled && (
            <>
              <Row label="From">
                <ColorField value={sh.gradient.from} onChange={(from) => set({ gradient: { ...sh.gradient, from } }, true)} onStart={beginGesture} />
              </Row>
              <Row label="To">
                <ColorField value={sh.gradient.to} onChange={(to) => set({ gradient: { ...sh.gradient, to } }, true)} onStart={beginGesture} />
              </Row>
            </>
          )}
        </>
      )}
      <Row label="Stroke">
        <ColorField value={sh.stroke} onChange={(stroke) => set({ stroke }, true)} onStart={beginGesture} />
      </Row>
      {num('Stroke width', 'strokeWidth', 0, 0.08, 1000, 0)}
      {sh.kind === 'rect' && num('Corners', 'radius', 0, 1)}
      {(sh.kind === 'star' || sh.kind === 'polygon') && num('Points', 'sides', 3, 16, 1, 0)}
    </Section>
  );
}

function SolidSection({ clip }: { clip: Clip }) {
  const sh = clip.shape ?? DEFAULT_SHAPE;
  const ids = [clip.id];
  const set = (patch: Partial<ShapeProps>, merge = false) => patchClips(ids, (c) => ({ shape: { ...(c.shape ?? DEFAULT_SHAPE), ...patch } }), merge);
  return (
    <Section id="solid" title="Solid">
      <Row label="Colour">
        <ColorField value={sh.fill} onChange={(fill) => set({ fill }, true)} onStart={beginGesture} />
      </Row>
      <Row label="Gradient">
        <Switch checked={sh.gradient.enabled} onChange={(enabled) => set({ gradient: { ...sh.gradient, enabled } })} label="Gradient" />
      </Row>
      {sh.gradient.enabled && (
        <>
          <Row label="From">
            <ColorField value={sh.gradient.from} onChange={(from) => set({ gradient: { ...sh.gradient, from } }, true)} onStart={beginGesture} />
          </Row>
          <Row label="To">
            <ColorField value={sh.gradient.to} onChange={(to) => set({ gradient: { ...sh.gradient, to } }, true)} onStart={beginGesture} />
          </Row>
          <Row label="Angle">
            <Slider value={sh.gradient.angle} min={0} max={360} onChange={(angle) => set({ gradient: { ...sh.gradient, angle } }, true)} onStart={beginGesture} />
          </Row>
        </>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────── transition ──

function TransitionInspector({ project, clip, side }: { project: Project; clip: Clip; side: 'in' | 'out' }) {
  const t = side === 'in' ? clip.transIn : clip.transOut;
  if (!t) {
    return <div className="insp__empty" style={{ padding: 16 }}>This transition was removed.</div>;
  }
  const def = getTransitionDef(t.type);
  const fps = project.settings.fpsNum / project.settings.fpsDen;
  const max = maxTransitionDuration(project, clip, side);
  const write = (next: Transition, merge = false) => patchClips([clip.id], side === 'in' ? { transIn: next } : { transOut: next }, merge);
  return (
    <div className="rows">
      <Section id="transition" title={def?.name ?? t.type}>
        <Row label="Type">
          <Select
            value={t.type}
            options={TRANSITIONS.map((x) => ({ value: x.id, label: x.name, group: x.category[0].toUpperCase() + x.category.slice(1) }))}
            onChange={(type) => {
              const nd = getTransitionDef(type);
              const params: Transition['params'] = {};
              for (const p of nd?.params ?? []) params[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
              write({ type, duration: t.duration, params });
            }}
          />
        </Row>
        <Row label="Duration">
          <Slider value={t.duration} min={1} max={max} step={1} onChange={(d) => write({ ...t, duration: Math.round(d) }, true)} onStart={beginGesture} />
          <NumberField value={t.duration / fps} onChange={(s) => write({ ...t, duration: Math.min(max, Math.max(1, Math.round(s * fps))) }, true)} onStart={beginGesture} min={1 / fps} max={max / fps} step={0.02} precision={2} suffix="s" />
        </Row>
        {def?.params.map((p) => (
          <ParamControl
            key={p.key}
            def={p}
            value={t.params[p.key]}
            onNumber={(v) => write({ ...t, params: { ...t.params, [p.key]: v } }, true)}
            onValue={(v, merge) => write({ ...t, params: { ...t.params, [p.key]: v } }, merge)}
          />
        ))}
        <Button
          variant="danger"
          icon={<Trash2 />}
          onClick={() => {
            patchClips([clip.id], side === 'in' ? { transIn: null } : { transOut: null });
            useUI.getState().set({ selectedTransition: null, selection: [clip.id] });
          }}
        >
          Remove transition
        </Button>
      </Section>
      <p className="form__hint" style={{ padding: '0 12px' }}>
        {def?.description} Drag the transition’s edge in the timeline to change its length.
      </p>
    </div>
  );
}

function stripKeys(c: Clip, paths: string[]): Clip['keyframes'] {
  const out: Clip['keyframes'] = {};
  for (const [k, v] of Object.entries(c.keyframes)) if (!paths.includes(k)) out[k] = v;
  return out;
}


