import {
  AudioLines,
  ChevronDown,
  Download,
  Maximize2,
  Pause,
  Repeat,
  RotateCcw,
  Search,
  Share2,
  SkipBack,
  SkipForward,
  Volume2,
} from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import { Avatar } from '../../components/Avatar';
import { LogoMark } from '../../components/Logo';
import { SHOTS } from '../../lib/footage';
import { seeded } from '../../lib/math';
import type { MockEls } from './mockEls';
import { PEOPLE } from './mockEls';

interface PanelProps {
  els: MockEls;
}

/** Top bar: project, workspaces, who is here, share/export. */
export const MockBar = memo(function MockBar() {
  return (
    <header className="mk-bar">
      <div className="mk-bar__left">
        <span className="mk-dots">
          <i />
          <i />
          <i />
        </span>
        <LogoMark size={20} />
        <span className="mk-bar__project">
          Low Tide — Teaser
          <ChevronDown size={12} />
        </span>
        <span className="mk-bar__sync">
          <i />
          Synced
        </span>
      </div>
      <nav className="mk-bar__pages">
        <span className="is-active">Edit</span>
        <span>Colour</span>
        <span>Audio</span>
        <span>Export</span>
      </nav>
      <div className="mk-bar__right">
        <span className="mk-avatars">
          <Avatar {...PEOPLE.maya} size={24} />
          <Avatar {...PEOPLE.jonas} size={24} />
          <Avatar {...PEOPLE.aiko} size={24} />
        </span>
        <span className="mk-btn mk-btn--accent">
          <Share2 size={12} strokeWidth={2.4} />
          Share
        </span>
        <span className="mk-btn">
          <Download size={12} strokeWidth={2.2} />
          Export
        </span>
      </div>
    </header>
  );
});

const BIN_ITEMS = [
  { shot: 0, len: '00:42' },
  { shot: 1, len: '00:18' },
  { shot: 2, len: '01:06' },
  { shot: 3, len: '00:27' },
  { shot: 4, len: '00:51' },
  { shot: 1, len: '00:33', name: 'Cliffs_A009.mov' },
];

const BIN_AUDIO = [
  { name: 'Low Tide — score.wav', len: '02:14' },
  { name: 'VO_take3.wav', len: '00:48' },
];

/** Left panel: the media bin. Thumbnails are stills rendered by the footage shader. */
export const MockBin = memo(function MockBin() {
  return (
    <aside className="mk-bin">
      <div className="mk-tabs">
        <span className="is-active">Media</span>
        <span>Effects</span>
        <span>Text</span>
        <span>Audio</span>
      </div>
      <div className="mk-search">
        <Search size={12} />
        Search media
      </div>
      <div className="mk-bin__grid">
        {BIN_ITEMS.map((item, i) => (
          <div key={i} className="mk-thumb">
            <span className="mk-thumb__img" style={{ backgroundImage: `var(--still-${item.shot})` }}>
              <span className="mk-thumb__len mono">{item.len}</span>
            </span>
            <span className="mk-thumb__name">{item.name ?? SHOTS[item.shot].name}</span>
          </div>
        ))}
      </div>
      <div className="mk-bin__list">
        {BIN_AUDIO.map((item) => (
          <div key={item.name} className="mk-row">
            <span className="mk-row__icon">
              <AudioLines size={12} />
            </span>
            <span className="mk-row__name">{item.name}</span>
            <span className="mk-row__len mono">{item.len}</span>
          </div>
        ))}
      </div>
    </aside>
  );
});

/** Centre: the program viewer. The canvas is driven by the animation loop in EditorMock. */
export const MockViewer = memo(function MockViewer({ els }: PanelProps) {
  return (
    <div className="mk-viewer">
      <div className="mk-viewer__head">
        <span>Program</span>
        <span className="mk-viewer__meta mono">3840 × 2160 · 24 fps · Rec.709</span>
        <span className="mk-viewer__fit">
          Fit
          <ChevronDown size={11} />
        </span>
      </div>
      <div className="mk-viewer__stage">
        <div
          className="mk-picture"
          data-shot="0"
          ref={(node) => {
            els.picture = node;
          }}
        >
          <canvas
            ref={(node) => {
              els.canvas = node;
            }}
          />
          <div
            className="mk-title"
            ref={(node) => {
              els.title = node;
            }}
          >
            <span className="mk-title__main">LOW TIDE</span>
            <span className="mk-title__sub">a short film</span>
          </div>
          <div
            className="mk-lower"
            ref={(node) => {
              els.lower = node;
            }}
          >
            <span className="mk-lower__name">Skerry Point</span>
            <span className="mk-lower__role mono">05:42 · LOW WATER</span>
          </div>
        </div>
      </div>
      <div className="mk-transport">
        <span
          className="mk-transport__tc mono"
          ref={(node) => {
            els.timecodes[0] = node;
          }}
        >
          00:00:03:00
        </span>
        <span className="mk-transport__keys">
          <SkipBack size={13} />
          <span className="mk-transport__play">
            <Pause size={13} fill="currentColor" />
          </span>
          <SkipForward size={13} />
        </span>
        <span className="mk-transport__right">
          <Repeat size={13} className="is-on" />
          <Volume2 size={13} />
          <Maximize2 size={12} />
          <span className="mono">00:00:34:00</span>
        </span>
      </div>
    </div>
  );
});

/** A believable RGB parade for the inspector, drawn once from seeded noise. */
function paintParade(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const rnd = seeded(7);
  const third = w / 3;
  const channels = [
    { color: 'rgba(255,90,90,0.16)', lift: 0.1 },
    { color: 'rgba(110,255,140,0.14)', lift: 0 },
    { color: 'rgba(90,150,255,0.19)', lift: -0.09 },
  ];
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  channels.forEach((channel, c) => {
    ctx.fillStyle = channel.color;
    for (let x = 0; x < third - 6; x++) {
      const u = x / third;
      // Three populations per column: bright sky, the sun's hot core, dark land and water.
      const sky = 0.66 + channel.lift - 0.16 * Math.abs(u - 0.6) + 0.03 * Math.sin(u * 11 + c);
      const sun = 0.93 - 2.4 * Math.abs(u - 0.6);
      const land = 0.14 + 0.05 * Math.sin(u * 7 + c * 2) + channel.lift * 0.3;
      for (let i = 0; i < 64; i++) {
        const pick = rnd();
        const band = pick < 0.42 ? sky : pick < 0.5 ? Math.max(sky, sun) : land;
        const spread = pick < 0.5 ? 0.1 : 0.16;
        const v = band + (rnd() + rnd() + rnd() - 1.5) * spread;
        ctx.fillRect(c * third + 3 + x, Math.round((1 - v) * h), 1, 1);
      }
    }
  });
}

const WHEELS = [
  { label: 'Lift', x: -0.1, y: 0.12 },
  { label: 'Gamma', x: 0, y: 0, live: true },
  { label: 'Gain', x: 0.06, y: -0.05 },
];

const SLIDERS = [
  { label: 'Exposure', value: '0.00', fill: 0.5 },
  { label: 'Contrast', value: '1.08', fill: 0.54 },
  { label: 'Saturation', value: '1.00', fill: 0.5, live: true },
  { label: 'Temp', value: '5600', fill: 0.46 },
  { label: 'Tint', value: '+4', fill: 0.53 },
];

/** Right panel: colour inspector with the wheel and slider Aiko's cursor works. */
export const MockInspector = memo(function MockInspector({ els }: PanelProps) {
  const scope = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (scope.current) paintParade(scope.current);
  }, []);

  return (
    <aside className="mk-insp">
      <div className="mk-tabs">
        <span className="is-active">Colour</span>
        <span>Effects</span>
        <span>Transform</span>
        <span>Audio</span>
      </div>
      <div className="mk-insp__head">
        <span>Primaries</span>
        <RotateCcw size={11} />
      </div>
      <div className="mk-wheels">
        {WHEELS.map((wheel) => (
          <div key={wheel.label} className="mk-wheel">
            <div
              className="mk-wheel__pad"
              ref={
                wheel.live
                  ? (node) => {
                      els.wheel = node;
                    }
                  : undefined
              }
            >
              <span
                className="mk-wheel__puck"
                style={{ transform: `translate(${wheel.x * 30}px, ${wheel.y * 30}px)` }}
                ref={
                  wheel.live
                    ? (node) => {
                        els.puck = node;
                      }
                    : undefined
                }
              />
            </div>
            <span className="mk-wheel__label">{wheel.label}</span>
          </div>
        ))}
      </div>
      <div className="mk-sliders">
        {SLIDERS.map((slider) => (
          <div key={slider.label} className="mk-slider">
            <span className="mk-slider__label">{slider.label}</span>
            <div
              className="mk-slider__track"
              ref={
                slider.live
                  ? (node) => {
                      els.satTrack = node;
                    }
                  : undefined
              }
            >
              <span
                className="mk-slider__fill"
                style={{ transform: `scaleX(${slider.fill})` }}
                ref={
                  slider.live
                    ? (node) => {
                        els.satFill = node;
                      }
                    : undefined
                }
              />
              <span
                className="mk-slider__thumb"
                style={{ left: `${slider.fill * 100}%` }}
                ref={
                  slider.live
                    ? (node) => {
                        els.satThumb = node;
                      }
                    : undefined
                }
              />
            </div>
            <span
              className="mk-slider__value mono"
              ref={
                slider.live
                  ? (node) => {
                      els.satValue = node;
                    }
                  : undefined
              }
            >
              {slider.value}
            </span>
          </div>
        ))}
      </div>
      <div className="mk-insp__head">
        <span>Scopes</span>
        <span className="mk-insp__hint mono">RGB parade</span>
      </div>
      <div className="mk-scope">
        <canvas ref={scope} width={236} height={78} />
      </div>
    </aside>
  );
});
