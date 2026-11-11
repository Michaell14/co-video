import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  clamp,
  DEFAULT_COMPRESSOR,
  DEFAULT_EQ,
  trackLabel,
  tracksOf,
  type Track,
  type TrackCompressor,
  type TrackEQ,
} from '@tandem/core';
import { usePlayer, useProject, useSession } from '../../session/hooks';
import { beginGesture, commit } from '../../state/props';
import { cx, NumberField, Slider, Switch, tip } from '../../ui/core';
import './mixer.css';

const DB_MIN = -60;
const DB_MAX = 12;
/** Fader law: more travel around unity, where mixing decisions are made. */
const dbToPos = (db: number) => Math.pow(clamp((db - DB_MIN) / (DB_MAX - DB_MIN), 0, 1), 2.2);
const posToDb = (pos: number) => DB_MIN + Math.pow(clamp(pos, 0, 1), 1 / 2.2) * (DB_MAX - DB_MIN);
const levelToPos = (level: number) => (level > 0.0005 ? dbToPos(20 * Math.log10(level)) : 0);

export function Mixer() {
  const session = useSession();
  const project = useProject((p) => p);
  const { audio } = tracksOf(project);
  return (
    <>
      <div className="panel__head">
        <SlidersHorizontal size={14} style={{ marginLeft: 8, color: 'var(--fg-3)' }} />
        <div className="panel__title">Mixer</div>
      </div>
      <div className="panel__body mixer" data-readonly={!session.canEdit}>
        <div className="mixer__strips">
          {audio.map((t) => (
            <Strip key={t.id} track={t} label={trackLabel(project, t)} />
          ))}
          <MasterStrip />
        </div>
      </div>
    </>
  );
}

function useMeter(read: () => number[]) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const peaks = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const shown: number[] = [];
    const hold: { v: number; t: number }[] = [];
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const levels = read();
      const now = performance.now();
      levels.forEach((level, i) => {
        shown[i] = level > (shown[i] ?? 0) ? level : (shown[i] ?? 0) * 0.92;
        const h = hold[i] ?? { v: 0, t: 0 };
        if (shown[i] >= h.v || now - h.t > 1200) hold[i] = { v: shown[i], t: now };
        const el = refs.current[i];
        if (el) {
          el.style.transform = `scaleY(${levelToPos(shown[i])})`;
          el.dataset.clip = String(shown[i] >= 1);
        }
        const pk = peaks.current[i];
        if (pk) pk.style.bottom = `${levelToPos(hold[i].v) * 100}%`;
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [read]);
  return { refs, peaks };
}

function Meter({ channels, read }: { channels: number; read: () => number[] }) {
  const { refs, peaks } = useMeter(read);
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

function Fader({ value, onChange }: { value: number; onChange: (db: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
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
        e.currentTarget.setPointerCapture(e.pointerId);
        setActive(true);
        beginGesture();
        onChange(from(e.clientY));
      }}
      onPointerMove={(e) => active && onChange(from(e.clientY))}
      onPointerUp={(e) => {
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
      <div className="fader__cap" style={{ bottom: `calc(${dbToPos(value)} * (100% - 16px))` }} />
    </div>
  );
}

function Strip({ track: t, label }: { track: Track; label: string }) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const update = (patch: Partial<Track>, merge = false) =>
    commit([{ op: 'updateTrack', id: t.id, patch }], merge);
  const read = useRef(() => [player?.levels().tracks[t.id] ?? 0]);
  read.current = () => [player?.levels().tracks[t.id] ?? 0];
  const reader = useRef(() => read.current()).current;
  const eq = t.eq ?? DEFAULT_EQ;
  const comp = t.compressor ?? DEFAULT_COMPRESSOR;
  const setEq = (patch: Partial<TrackEQ>, merge = true) => update({ eq: { ...eq, ...patch } }, merge);
  const setComp = (patch: Partial<TrackCompressor>, merge = true) =>
    update({ compressor: { ...comp, ...patch } }, merge);
  return (
    <div className="strip" data-muted={t.muted}>
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
        />
        <span className="mono">
          {t.pan === 0 ? 'C' : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`}
        </span>
      </div>
      <div className="strip__main">
        <Meter channels={1} read={reader} />
        <Fader value={t.volume} onChange={(volume) => update({ volume }, true)} />
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
        ariaLabel="Track volume"
      />
      <div className="strip__btns">
        <button
          className={cx('strip__btn', t.muted && 'strip__btn--mute')}
          aria-pressed={t.muted}
          onClick={() => update({ muted: !t.muted })}
          {...tip('Mute')}
        >
          M
        </button>
        <button
          className={cx('strip__btn', t.solo && 'strip__btn--solo')}
          aria-pressed={t.solo}
          onClick={() => update({ solo: !t.solo })}
          {...tip('Solo')}
        >
          S
        </button>
        <button
          className={cx('strip__btn', (eq.enabled || comp.enabled) && 'strip__btn--fx')}
          aria-pressed={open}
          onClick={() => setOpen(!open)}
          {...tip('EQ & compressor')}
        >
          FX
        </button>
      </div>
      {open && (
        <div className="strip__fx">
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
              <Slider
                value={eq[band]}
                min={-18}
                max={18}
                origin={0}
                defaultValue={0}
                onStart={beginGesture}
                onChange={(v) => setEq({ [band]: Math.round(v * 10) / 10, enabled: true })}
              />
              <em className="mono">
                {eq[band] > 0 ? '+' : ''}
                {eq[band].toFixed(1)}
              </em>
            </label>
          ))}
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
            <Slider
              value={comp.threshold}
              min={-60}
              max={0}
              defaultValue={-18}
              onStart={beginGesture}
              onChange={(v) => setComp({ threshold: Math.round(v), enabled: true })}
            />
            <em className="mono">{comp.threshold}</em>
          </label>
          <label className="strip__knob">
            <span>Ratio</span>
            <Slider
              value={comp.ratio}
              min={1}
              max={20}
              defaultValue={3}
              onStart={beginGesture}
              onChange={(v) => setComp({ ratio: Math.round(v * 10) / 10, enabled: true })}
            />
            <em className="mono">{comp.ratio.toFixed(1)}:1</em>
          </label>
          <label className="strip__knob">
            <span>Makeup</span>
            <Slider
              value={comp.makeup}
              min={0}
              max={24}
              defaultValue={0}
              onStart={beginGesture}
              onChange={(v) => setComp({ makeup: Math.round(v * 10) / 10, enabled: true })}
            />
            <em className="mono">+{comp.makeup.toFixed(1)}</em>
          </label>
        </div>
      )}
    </div>
  );
}

function MasterStrip() {
  const player = usePlayer();
  const read = useRef(() => [0, 0]);
  read.current = () => player?.levels().master ?? [0, 0];
  const reader = useRef(() => read.current()).current;
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
        <Meter channels={2} read={reader} />
      </div>
      <div className="strip__hint">Meters are post-fader peak. Red means the mix is clipping.</div>
    </div>
  );
}
