import { RotateCcw } from 'lucide-react';
import { animate, useInView, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Reveal } from '../components/Reveal';
import { SectionHead } from '../components/SectionHead';
import { loadStills } from '../lib/footage';
import { useSeen } from '../lib/hooks';
import { ColorWheel } from './color/ColorWheel';
import { createGrader, drawScope, mixGrade, NEUTRAL } from './color/grade';
import type { GradeParams, Grader, ScopeMode } from './color/grade';
import './Color.css';

const LOOKS: { name: string; params: GradeParams }[] = [
  { name: 'Ungraded', params: NEUTRAL },
  {
    name: 'Teal & amber',
    params: {
      lift: { x: -0.42, y: 0.4 },
      gamma: { x: -0.06, y: 0.06 },
      gain: { x: 0.36, y: -0.3 },
      exposure: 0.1,
      contrast: 1.4,
      saturation: 1.4,
      temperature: -0.05,
    },
  },
  {
    name: 'Bleach bypass',
    params: {
      ...NEUTRAL,
      lift: { x: -0.1, y: 0.2 },
      exposure: 0.1,
      contrast: 1.7,
      saturation: 0.5,
      temperature: -0.1,
    },
  },
  {
    name: 'Day for night',
    params: {
      lift: { x: -0.5, y: 0.45 },
      gamma: { x: -0.3, y: 0.28 },
      gain: { x: -0.1, y: 0.1 },
      exposure: -0.75,
      contrast: 1.5,
      saturation: 0.8,
      temperature: -0.55,
    },
  },
];

const AUTOPLAY_LOOK = 1;

interface SliderDef {
  key: 'exposure' | 'contrast' | 'saturation' | 'temperature';
  label: string;
  min: number;
  max: number;
  format: (v: number) => string;
}

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;

const SLIDERS: SliderDef[] = [
  { key: 'exposure', label: 'Exposure', min: -1.5, max: 1.5, format: signed },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 2, format: (v) => v.toFixed(2) },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, format: (v) => v.toFixed(2) },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, format: signed },
];

const FACTS = [
  {
    term: '16-bit float, end to end',
    text: 'Every layer is composited in float, so a stack of grades and effects does not clip or band on its way through.',
  },
  {
    term: 'Wheels, curves and zones',
    text: 'Lift, gamma, gain and offset wheels, RGB curves, hue-vs-sat curves and HDR zone controls.',
  },
  {
    term: 'Log in, LUTs on top',
    text: 'S-Log3, LogC3 and V-Log inputs, so you grade from the camera’s own curve. 3D LUTs load from .cube files.',
  },
  {
    term: 'Scopes that tell the truth',
    text: 'Waveform, RGB parade, vectorscope and histogram, drawn from the frame in the viewer.',
  },
  {
    term: 'HDR timelines',
    text: 'Work in Rec.2100 PQ or HLG and export HDR10, where your browser can encode it.',
  },
];

export function Color() {
  const reduced = useReducedMotion();
  const section = useRef<HTMLElement>(null);
  const picture = useRef<HTMLCanvasElement>(null);
  const scope = useRef<HTMLCanvasElement>(null);
  const grader = useRef<Grader | null>(null);

  const near = useSeen(section, '500px');
  const inView = useInView(picture, { once: true, margin: '0px 0px -30% 0px' });

  const [params, setParams] = useState<GradeParams>(NEUTRAL);
  const [look, setLook] = useState<number | null>(0);
  const [mode, setMode] = useState<ScopeMode>('parade');
  const [compare, setCompare] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unsupported'>('loading');
  const touched = useRef(false);
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);

  // Set up WebGL only once the section is close, on the flat frame the footage shader rendered.
  useEffect(() => {
    if (!near) return;
    let alive = true;
    void loadStills().then((stills) => {
      if (!alive || !picture.current) return;
      grader.current = createGrader(picture.current, stills.flat);
      setStatus(grader.current ? 'ready' : 'unsupported');
    });
    return () => {
      alive = false;
      grader.current?.dispose();
      grader.current = null;
    };
  }, [near]);

  // Render on demand: nothing here runs unless a control (or a look animation) changed something.
  useEffect(() => {
    if (status !== 'ready' || !grader.current) return;
    const pixels = grader.current.render(params, compare ? 1 : 0);
    if (scope.current) drawScope(scope.current, pixels, mode);
  }, [params, compare, mode, status]);

  const applyLook = useCallback(
    (index: number) => {
      setLook(index);
      const from = latest.current;
      const to = LOOKS[index].params;
      if (reduced) {
        setParams(to);
        return;
      }
      animate(0, 1, {
        duration: 0.9,
        ease: [0.16, 1, 0.3, 1],
        onUpdate: (u) => setParams(mixGrade(from, to, u)),
      });
    },
    [reduced],
  );

  // First time it scrolls into view, grade it in front of the visitor.
  useEffect(() => {
    if (!inView || status !== 'ready' || touched.current) return;
    const timer = window.setTimeout(() => {
      if (!touched.current) applyLook(AUTOPLAY_LOOK);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [inView, status, applyLook]);

  const edit = (patch: Partial<GradeParams>) => {
    touched.current = true;
    setLook(null);
    setParams((prev) => ({ ...prev, ...patch }));
  };

  const pickLook = (index: number) => {
    touched.current = true;
    applyLook(index);
  };

  return (
    <section className="section section--tint" id="color" aria-labelledby="color-title" ref={section}>
      <div className="container">
        <SectionHead
          index="04"
          eyebrow="Colour & HDR"
          id="color-title"
          title={
            <>
              A grading suite, not a <em>filter drawer.</em>
            </>
          }
          lead="Tandem works in 16-bit float from the first decode to the final encode, with the wheels, curves and scopes a colourist expects. Try the wheels: this is a real shader, grading in your browser right now."
        />

        <Reveal>
          <div className="grade" data-status={status}>
            <div className="grade__view">
              <figure className="grade__picture">
                <canvas
                  ref={picture}
                  aria-label="Stand-in footage of a coastline at sunset, graded live by the controls beside it."
                  role="img"
                />
                {status === 'unsupported' && (
                  <p className="grade__fallback">
                    WebGL isn’t available here, so the grade can’t run. The editor needs it too.
                  </p>
                )}
                <button
                  type="button"
                  className="grade__compare"
                  aria-pressed={compare}
                  onClick={() => setCompare((v) => !v)}
                >
                  {compare ? 'Showing source' : 'Show source'}
                </button>
                <figcaption className="grade__badge mono">
                  {compare ? 'SOURCE · FLAT' : 'GRADED · LIVE'}
                </figcaption>
              </figure>

              <div className="scope">
                <div className="scope__head">
                  <div className="scope__modes" role="group" aria-label="Scope type">
                    <button type="button" aria-pressed={mode === 'parade'} onClick={() => setMode('parade')}>
                      RGB parade
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === 'waveform'}
                      onClick={() => setMode('waveform')}
                    >
                      Waveform
                    </button>
                  </div>
                  <span className="scope__note mono">from the graded pixels</span>
                </div>
                <div className="scope__screen">
                  <span className="scope__scale mono" aria-hidden="true">
                    <i>100</i>
                    <i>50</i>
                    <i>0</i>
                  </span>
                  <canvas
                    ref={scope}
                    width={384}
                    height={160}
                    role="img"
                    aria-label={`Live ${mode === 'parade' ? 'RGB parade' : 'luma waveform'} of the graded picture.`}
                  />
                </div>
              </div>
            </div>

            <div className="grade__controls">
              <div className="looks" role="group" aria-label="Looks">
                {LOOKS.map((item, i) => (
                  <button key={item.name} type="button" aria-pressed={look === i} onClick={() => pickLook(i)}>
                    {item.name}
                  </button>
                ))}
              </div>

              <div className="wheels">
                <ColorWheel
                  label="Lift"
                  hint="shadows"
                  value={params.lift}
                  onChange={(lift) => edit({ lift })}
                />
                <ColorWheel
                  label="Gamma"
                  hint="midtones"
                  value={params.gamma}
                  onChange={(gamma) => edit({ gamma })}
                />
                <ColorWheel
                  label="Gain"
                  hint="highlights"
                  value={params.gain}
                  onChange={(gain) => edit({ gain })}
                />
              </div>

              <div className="sliders">
                {SLIDERS.map((slider) => {
                  const value = params[slider.key];
                  const fill = ((value - slider.min) / (slider.max - slider.min)) * 100;
                  return (
                    <label key={slider.key} className="slider">
                      <span className="slider__label">{slider.label}</span>
                      <input
                        type="range"
                        min={slider.min}
                        max={slider.max}
                        step={0.01}
                        value={value}
                        style={{ '--fill': `${fill}%` } as CSSProperties}
                        onChange={(e) => edit({ [slider.key]: Number(e.target.value) })}
                      />
                      <output className="slider__value mono">{slider.format(value)}</output>
                    </label>
                  );
                })}
              </div>
              <div className="grade__foot">
                <p className="grade__tip">Drag a wheel. Double-click it to reset.</p>
                <button
                  type="button"
                  className="grade__reset"
                  onClick={() => pickLook(0)}
                  disabled={look === 0}
                >
                  <RotateCcw size="0.9em" aria-hidden="true" />
                  Reset all
                </button>
              </div>
            </div>
          </div>
        </Reveal>

        <dl className="color-facts">
          {FACTS.map((fact, i) => (
            <Reveal key={fact.term} delay={0.05 * i} className="color-fact">
              <dt>{fact.term}</dt>
              <dd>{fact.text}</dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
