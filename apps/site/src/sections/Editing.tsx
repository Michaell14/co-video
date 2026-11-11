import {
  AudioLines,
  ChevronsLeftRight,
  Flag,
  Gauge,
  Keyboard,
  Layers,
  Link2,
  Magnet,
  Mic,
  Play,
  Scissors,
  Search,
  Spline,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { GlowCard } from '../components/GlowCard';
import { Keycap } from '../components/Keycap';
import { Reveal } from '../components/Reveal';
import { SectionHead } from '../components/SectionHead';
import { useLoopActive } from '../lib/hooks';
import './Editing.css';

/* ---- Looping illustrations. Pure CSS; paused whenever the section is off screen. ---- */

function RippleDemo() {
  return (
    <div className="ill ill--ripple">
      <div className="ill__lane">
        <span className="ill__clip ill__clip--video" data-part="a" />
        <span className="ill__clip ill__clip--video" data-part="b" />
        <span className="ill__clip ill__clip--video" data-part="c" />
        <span className="ill__bracket" />
      </div>
      <div className="ill__lane">
        <span className="ill__clip ill__clip--audio" data-part="a" />
        <span className="ill__clip ill__clip--audio" data-part="b" />
        <span className="ill__clip ill__clip--audio" data-part="c" />
      </div>
    </div>
  );
}

function BladeDemo() {
  return (
    <div className="ill ill--blade">
      <div className="ill__lane">
        <span className="ill__clip ill__clip--video" data-part="left" />
        <span className="ill__clip ill__clip--video" data-part="right" />
      </div>
      <div className="ill__lane">
        <span className="ill__clip ill__clip--audio" data-part="left" />
        <span className="ill__clip ill__clip--audio" data-part="right" />
      </div>
      <span className="ill__blade" />
    </div>
  );
}

function SnapDemo() {
  return (
    <div className="ill ill--snap">
      <div className="ill__lane">
        <span className="ill__clip ill__clip--text" data-part="mover" />
      </div>
      <div className="ill__lane">
        <span className="ill__clip ill__clip--video" data-part="a" />
        <span className="ill__clip ill__clip--video" data-part="b" />
      </div>
      <span className="ill__guide" />
    </div>
  );
}

const CURVE = 'M20 96 C 70 96, 78 26, 140 26 S 214 84, 300 40';

function KeyframeDemo() {
  const reduced = useReducedMotion();
  return (
    <div className="ill ill--curve">
      <svg viewBox="0 0 320 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
        <path className="ill__grid" d="M20 26H300M20 61H300M20 96H300" />
        <path className="ill__tangent" d="M20 96H70M78 26H202M214 84 L300 40" />
        <path id="ill-curve-path" className="ill__curve" d={CURVE} pathLength={1} />
        {[
          [20, 96],
          [140, 26],
          [300, 40],
        ].map(([x, y]) => (
          <rect
            key={x}
            className="ill__key"
            x={x - 5}
            y={y - 5}
            width="10"
            height="10"
            transform={`rotate(45 ${x} ${y})`}
          />
        ))}
        <circle className="ill__dot" r="5" cx={reduced ? 140 : 0} cy={reduced ? 26 : 0}>
          {!reduced && (
            <animateMotion
              dur="5s"
              repeatCount="indefinite"
              calcMode="spline"
              keyPoints="0;1;0"
              keyTimes="0;0.5;1"
              keySplines="0.65 0 0.35 1;0.65 0 0.35 1"
            >
              <mpath href="#ill-curve-path" />
            </animateMotion>
          )}
        </circle>
      </svg>
    </div>
  );
}

interface Tool {
  title: string;
  body: string;
  icon: ReactNode;
  demo: ReactNode;
}

const TOOLS: Tool[] = [
  {
    title: 'Ripple, roll, slip',
    body: 'Trim an edge and everything after it closes the gap. Roll a cut, or slip a shot underneath it.',
    icon: <ChevronsLeftRight size="1.1rem" aria-hidden="true" />,
    demo: <RippleDemo />,
  },
  {
    title: 'Blade',
    body: 'Split at the playhead or wherever you click. Linked audio is cut with its picture.',
    icon: <Scissors size="1.1rem" aria-hidden="true" />,
    demo: <BladeDemo />,
  },
  {
    title: 'Snapping',
    body: 'Clip edges find cuts, markers and the playhead, so a drag lands on the frame.',
    icon: <Magnet size="1.1rem" aria-hidden="true" />,
    demo: <SnapDemo />,
  },
  {
    title: 'Keyframes',
    body: 'Animate any numeric property, with bezier easing between every pair of keys.',
    icon: <Spline size="1.1rem" aria-hidden="true" />,
    demo: <KeyframeDemo />,
  },
];

const DETAILS = [
  { icon: Layers, text: 'Unlimited video and audio tracks' },
  { icon: Link2, text: 'Linked audio and video' },
  { icon: Flag, text: 'Markers' },
  { icon: Gauge, text: 'Speed changes, reverse and freeze frames' },
  { icon: Play, text: 'J / K / L transport' },
  { icon: Zap, text: 'Proxy media for 4K and up' },
  { icon: Mic, text: 'Voiceover recording' },
  { icon: AudioLines, text: 'Loudness normalisation to LUFS' },
  { icon: WifiOff, text: 'Opens and edits offline' },
  { icon: Keyboard, text: 'A full keyboard workflow' },
  { icon: Search, text: 'Command palette' },
];

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['J', 'K', 'L'], label: 'Shuttle' },
  { keys: ['I'], label: 'Mark in' },
  { keys: ['O'], label: 'Mark out' },
  { keys: ['cmd', 'B'], label: 'Blade' },
  { keys: ['shift', 'delete'], label: 'Ripple delete' },
  { keys: ['space'], label: 'Play / pause' },
  { keys: ['left', 'right'], label: 'Step a frame' },
  { keys: ['cmd', 'Z'], label: 'Undo (yours only)' },
  { keys: ['cmd', 'K'], label: 'Command palette' },
];

function ShortcutRow({ hidden }: { hidden?: boolean }) {
  return (
    <ul className="keys__row" aria-hidden={hidden}>
      {SHORTCUTS.map((shortcut) => (
        <li key={shortcut.label} className="keys__item">
          <span className="keys__caps">
            {shortcut.keys.map((k) => (
              <Keycap key={k} k={k} />
            ))}
          </span>
          <span className="keys__label">{shortcut.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function Editing() {
  const ref = useRef<HTMLElement>(null);
  const active = useLoopActive(ref);

  return (
    <section
      className="section section--tint"
      id="features"
      aria-labelledby="features-title"
      ref={ref}
      data-active={active}
    >
      <div className="container">
        <SectionHead
          index="02"
          eyebrow="Timeline"
          id="features-title"
          title={
            <>
              A timeline that keeps up with <em>your hands.</em>
            </>
          }
          lead="The trims, tools and transport you already know from a desktop editor, frame-accurate and driven from the keyboard. It only happens to live in a browser."
        />

        <ul className="tools">
          {TOOLS.map((tool, i) => (
            <Reveal as="li" key={tool.title} delay={0.06 * i}>
              <GlowCard className="tool">
                <div className="tool__stage" aria-hidden="true">
                  {tool.demo}
                </div>
                <div className="tool__copy">
                  <h3 className="h3 tool__title">
                    <span className="tool__icon">{tool.icon}</span>
                    {tool.title}
                  </h3>
                  <p>{tool.body}</p>
                </div>
              </GlowCard>
            </Reveal>
          ))}
        </ul>

        <Reveal>
          <ul className="chips tools-also">
            {DETAILS.map((detail) => (
              <li key={detail.text}>
                <detail.icon size="1rem" strokeWidth={1.8} aria-hidden="true" />
                {detail.text}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>

      <Reveal className="keys">
        <div className="keys__track">
          <ShortcutRow />
          <ShortcutRow hidden />
        </div>
      </Reveal>
    </section>
  );
}
