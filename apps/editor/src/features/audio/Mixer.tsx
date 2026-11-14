import { SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clamp,
  DEFAULT_COMPRESSOR,
  DEFAULT_EQ,
  trackLabel,
  tracksOf,
  type ID,
  type Track,
  type TrackCompressor,
  type TrackEQ,
} from '@tandem/core';
import { usePlayer, useProject, useSession, useSessionMeta } from '../../session/hooks';
import { beginGesture, commit } from '../../state/props';
import { cx, IconButton, NumberField, Slider, Switch, tip } from '../../ui/core';
import { isDoublePress, type Press } from '../../ui/press';
import { useFaderKeys } from '../inspector/sliderKeys';
import { watchLevels, type Levels } from '../timeline/levels';
import { AT_REST, meterStep, type MeterChannel } from './meter';
import './mixer.css';

const DB_MIN = -60;
const DB_MAX = 12;
/** Fader law: more travel around unity, where mixing decisions are made. */
const dbToPos = (db: number) => Math.pow(clamp((db - DB_MIN) / (DB_MAX - DB_MIN), 0, 1), 2.2);
const posToDb = (pos: number) => DB_MIN + Math.pow(clamp(pos, 0, 1), 1 / 2.2) * (DB_MAX - DB_MIN);
const levelToPos = (level: number) => (level > 0.0005 ? dbToPos(20 * Math.log10(level)) : 0);

/** A gain as it is shown and read out, with a real minus sign: `+3.5 dB`, `−9.0 dB`. */
const decibels = (db: number): string => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`;

/** A pan position as the strip shows it: `C`, `L20`, `R100`. */
const panText = (pan: number): string =>
  pan === 0 ? 'C' : pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`;

export function Mixer() {
  const readOnly = !useSession().canEdit;
  // Access can change while the panel is open.
  useSessionMeta();
  const project = useProject((p) => p);
  const { audio } = tracksOf(project);
  const [fx, setFx] = useState<ID | null>(null);
  const fxTrack = audio.find((t) => t.id === fx);
  return (
    <>
      <div className="panel__head">
        <SlidersHorizontal size={14} style={{ marginLeft: 8, color: 'var(--fg-3)' }} />
        <div className="panel__title">Mixer</div>
        <span className="panel__spacer" />
        {readOnly && <span className="badge badge--amber">Read only</span>}
      </div>
      <div className="panel__body mixer">
        <div className="mixer__strips">
          {audio.map((t) => (
            <Strip
              key={t.id}
              track={t}
              label={trackLabel(project, t)}
              fxOpen={t.id === fx}
              onFx={() => setFx(t.id === fx ? null : t.id)}
              readOnly={readOnly}
            />
          ))}
          <MasterStrip />
        </div>
        {fxTrack && (
          <TrackFx
            key={fxTrack.id}
            track={fxTrack}
            label={trackLabel(project, fxTrack)}
            onClose={() => setFx(null)}
            readOnly={readOnly}
          />
        )}
      </div>
    </>
  );
}

/** The levels a meter shows, one for each of its channels, out of everything the player reports. */
type Channels = (levels: Levels) => number[];

/**
 * The bars and peak marks of a meter, moved without rendering. All meters of the mixer and of the
 * track headers are told the same reading by one loop, which runs while the player plays and until
 * the meters have come to rest after it: a strip that read the levels for itself would ask the
 * analyser of every track once more per frame, and go on asking with nothing playing.
 */
function useMeter(pick: Channels) {
  const player = usePlayer();
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const peaks = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    if (!player) return;
    const channels: MeterChannel[] = [];
    return watchLevels(player, (levels, elapsed) => {
      pick(levels).forEach((level, i) => {
        const channel = (channels[i] = meterStep(channels[i] ?? AT_REST, level, elapsed));
        const el = refs.current[i];
        if (el) {
          el.style.transform = `scaleY(${levelToPos(channel.shown)})`;
          el.dataset.clip = String(channel.shown >= 1);
        }
        const pk = peaks.current[i];
        if (pk) pk.style.bottom = `${levelToPos(channel.peak) * 100}%`;
      });
    });
  }, [player, pick]);
  return { refs, peaks };
}

function Meter({ channels, pick }: { channels: number; pick: Channels }) {
  const { refs, peaks } = useMeter(pick);
  return (
    <div className="meter">
      {Array.from({ length: channels }, (_, i) => (
        <div key={i} className="meter__ch">
          <div className="meter__bar" ref={(el) => void (refs.current[i] = el)} />
          <div className="meter__peak" ref={(el) => void (peaks.current[i] = el)} />
        </div>
      ))}
    </div>
  );
}

function Fader({ label, value, onChange }: { label: string; value: number; onChange: (db: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastPress = useRef<Press | null>(null);
  const [active, setActive] = useState(false);
  const keys = useFaderKeys({
    value,
    min: DB_MIN,
    max: DB_MAX,
    step: 0.5,
    defaultValue: 0,
    onChange,
    label,
    valueText: decibels(value),
  });
  const from = (y: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.round(posToDb(1 - (y - r.top - 8) / (r.height - 16)) * 10) / 10;
  };
  return (
    <div
      ref={ref}
      className="fader"
      data-active={active}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const press = { time: e.timeStamp, x: e.clientX, y: e.clientY };
        const second = isDoublePress(lastPress.current, press);
        lastPress.current = second ? null : press;
        // The second press of a double-click only asks for the reset to 0 dB that follows: it
        // neither jumps the fader again nor opens another undo step.
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
      <div className="fader__scale">
        {[12, 6, 0, -6, -12, -24, -48].map((db) => (
          <span
            key={db}
            style={{ bottom: `calc(8px + ${dbToPos(db)} * (100% - 16px))` }}
            data-zero={db === 0}
          >
            {db > 0 ? `+${db}` : db}
          </span>
        ))}
      </div>
      <div className="fader__track" />
      <div className="fader__cap" style={{ bottom: `calc(${dbToPos(value)} * (100% - 16px))` }} {...keys} />
    </div>
  );
}

function Strip({
  track: t,
  label,
  fxOpen,
  onFx,
  readOnly,
}: {
  track: Track;
  label: string;
  fxOpen: boolean;
  onFx: () => void;
  readOnly: boolean;
}) {
  // What the strip's controls are called: by the track's name, or by its place where it has none.
  const name = t.name || label;
  const update = (patch: Partial<Track>, merge = false) =>
    commit([{ op: 'updateTrack', id: t.id, patch }], merge);
  const level = useCallback((levels: Levels) => [levels.tracks[t.id] ?? 0], [t.id]);
  return (
    <div className="strip" data-muted={t.muted} inert={readOnly}>
      <div className="strip__name">
        <span className="th__tag mono">{label}</span>
        <span>{t.name}</span>
      </div>
      <div className="strip__pan">
        <Slider
          value={t.pan}
          min={-1}
          max={1}
          origin={0}
          defaultValue={0}
          onStart={beginGesture}
          onChange={(pan) => update({ pan: Math.round(pan * 100) / 100 }, true)}
          ariaLabel={`Pan, ${name}`}
          valueText={panText}
        />
        <span className="mono">{panText(t.pan)}</span>
      </div>
      <div className="strip__main">
        <Meter channels={1} pick={level} />
        <Fader label={`Volume, ${name}`} value={t.volume} onChange={(volume) => update({ volume }, true)} />
      </div>
      <NumberField
        value={t.volume}
        onChange={(volume) => update({ volume }, true)}
        onStart={beginGesture}
        min={DB_MIN}
        max={DB_MAX}
        step={0.1}
        precision={1}
        suffix="dB"
        defaultValue={0}
        ariaLabel={`Volume, ${name}`}
      />
      <div className="strip__btns">
        {/* The letters are what a mixer shows. Read out, each button says what it does, and to which track. */}
        <button
          className={cx('strip__btn', t.muted && 'strip__btn--mute')}
          aria-label={`Mute, ${name}`}
          aria-pressed={t.muted}
          onClick={() => update({ muted: !t.muted })}
          {...tip('Mute')}
        >
          M
        </button>
        <button
          className={cx('strip__btn', t.solo && 'strip__btn--solo')}
          aria-label={`Solo, ${name}`}
          aria-pressed={t.solo}
          onClick={() => update({ solo: !t.solo })}
          {...tip('Solo')}
        >
          S
        </button>
        <button
          className={cx(
            'strip__btn',
            (t.eq?.enabled || t.compressor?.enabled) && 'strip__btn--fx',
            fxOpen && 'strip__btn--open',
          )}
          aria-label={`EQ and compressor, ${name}`}
          aria-pressed={fxOpen}
          onClick={onFx}
          {...tip('EQ & compressor')}
        >
          FX
        </button>
      </div>
    </div>
  );
}

/**
 * EQ and compressor of one track, in a drawer under the strips. They are kept out of the strip so
 * that every fader has the same travel and the scales line up, whichever track is being worked on.
 */
function TrackFx({
  track: t,
  label,
  onClose,
  readOnly,
}: {
  track: Track;
  label: string;
  onClose: () => void;
  readOnly: boolean;
}) {
  const update = (patch: Partial<Track>, merge: boolean) =>
    commit([{ op: 'updateTrack', id: t.id, patch }], merge);
  const eq = t.eq ?? DEFAULT_EQ;
  const comp = t.compressor ?? DEFAULT_COMPRESSOR;
  const setEq = (patch: Partial<TrackEQ>, merge = true) => update({ eq: { ...eq, ...patch } }, merge);
  const setComp = (patch: Partial<TrackCompressor>, merge = true) =>
    update({ compressor: { ...comp, ...patch } }, merge);
  const ref = useRef<HTMLDivElement>(null);
  // In a short panel the drawer opens below the fold: bring it into view, so that pressing FX
  // visibly does something.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div
      ref={ref}
      className="mixer__fx"
      role="group"
      aria-label={`EQ and compressor for ${label}`}
      inert={readOnly}
    >
      <div className="mixer__fxhead">
        <span className="th__tag mono">{label}</span>
        <span>{t.name ? `${t.name} · EQ & compressor` : 'EQ & compressor'}</span>
        <IconButton small label="Close" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="mixer__fxcols">
        <div className="mixer__fxcol">
          <div className="strip__fxhead">
            EQ{' '}
            <Switch
              checked={eq.enabled}
              onChange={(enabled) => setEq({ enabled }, false)}
              label="Enable EQ"
            />
          </div>
          {(['high', 'mid', 'low'] as const).map((band) => (
            <label key={band} className="strip__knob">
              <span>{band[0].toUpperCase() + band.slice(1)}</span>
              <em className="mono">
                {eq[band] > 0 ? '+' : ''}
                {eq[band].toFixed(1)}
              </em>
              <Slider
                value={eq[band]}
                min={-18}
                max={18}
                origin={0}
                defaultValue={0}
                onStart={beginGesture}
                onChange={(v) => setEq({ [band]: Math.round(v * 10) / 10, enabled: true })}
                ariaLabel={`EQ ${band}`}
                valueText={decibels}
              />
            </label>
          ))}
        </div>
        <div className="mixer__fxcol">
          <div className="strip__fxhead">
            Comp{' '}
            <Switch
              checked={comp.enabled}
              onChange={(enabled) => setComp({ enabled }, false)}
              label="Enable compressor"
            />
          </div>
          <label className="strip__knob">
            <span>Thresh</span>
            <em className="mono">{comp.threshold}</em>
            <Slider
              value={comp.threshold}
              min={-60}
              max={0}
              defaultValue={-18}
              onStart={beginGesture}
              onChange={(v) => setComp({ threshold: Math.round(v), enabled: true })}
              ariaLabel="Compressor threshold"
              valueText={(v) => `${v < 0 ? '−' : ''}${Math.abs(Math.round(v))} dB`}
            />
          </label>
          <label className="strip__knob">
            <span>Ratio</span>
            <em className="mono">{comp.ratio.toFixed(1)}:1</em>
            <Slider
              value={comp.ratio}
              min={1}
              max={20}
              defaultValue={3}
              onStart={beginGesture}
              onChange={(v) => setComp({ ratio: Math.round(v * 10) / 10, enabled: true })}
              ariaLabel="Compressor ratio"
              valueText={(v) => `${v.toFixed(1)} to 1`}
            />
          </label>
          <label className="strip__knob">
            <span>Makeup</span>
            <em className="mono">+{comp.makeup.toFixed(1)}</em>
            <Slider
              value={comp.makeup}
              min={0}
              max={24}
              defaultValue={0}
              onStart={beginGesture}
              onChange={(v) => setComp({ makeup: Math.round(v * 10) / 10, enabled: true })}
              ariaLabel="Compressor make-up gain"
              valueText={decibels}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

const masterLevels: Channels = (levels) => levels.master;

function MasterStrip() {
  return (
    <div className="strip strip--master">
      <div className="strip__name">
        <span className="th__tag mono" style={{ color: 'var(--accent)' }}>
          MIX
        </span>
        <span>Master</span>
      </div>
      <div className="strip__pan" />
      <div className="strip__main">
        <Meter channels={2} pick={masterLevels} />
      </div>
      <div className="strip__hint">Meters are post-fader peak. Red means the mix is clipping.</div>
    </div>
  );
}
