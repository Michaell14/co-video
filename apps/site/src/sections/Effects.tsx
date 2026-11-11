import { Blend, Captions, Layers2, Shapes, Type } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { Reveal } from '../components/Reveal';
import { SectionHead } from '../components/SectionHead';
import { loadStills } from '../lib/footage';
import { useLoopActive } from '../lib/hooks';
import './Effects.css';

type EffectId = 'glow' | 'vhs' | 'chroma' | 'pixel' | 'duotone' | 'blur' | 'grain' | 'glitch';

const TILES: { id: EffectId; name: string; note: string; shot: number }[] = [
  { id: 'glow', name: 'Glow', note: 'Bloom on the highlights', shot: 0 },
  { id: 'vhs', name: 'VHS', note: 'Scanlines, bleed, tracking', shot: 1 },
  { id: 'chroma', name: 'Chromatic Aberration', note: 'Lens fringing', shot: 3 },
  { id: 'pixel', name: 'Pixelate', note: 'Animated block size', shot: 4 },
  { id: 'duotone', name: 'Duotone', note: 'Two-colour map', shot: 1 },
  { id: 'blur', name: 'Gaussian Blur', note: 'Rack focus', shot: 3 },
  { id: 'grain', name: 'Film Grain', note: 'Animated grain', shot: 0 },
  { id: 'glitch', name: 'Glitch', note: 'Slice displacement', shot: 4 },
];

const PIXEL_STEPS = [30, 24, 18, 13, 9, 13, 18, 24];

/** Pixelate, done honestly: draw the still into a tiny canvas and scale it up without smoothing. */
function PixelCanvas({ shot, animate }: { shot: number; animate: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);

  const draw = useCallback((columns: number) => {
    const el = canvas.current;
    const img = image.current;
    if (!el || !img) return;
    el.width = columns;
    el.height = Math.round((columns * 9) / 16);
    el.getContext('2d')?.drawImage(img, 0, 0, el.width, el.height);
  }, []);

  useEffect(() => {
    let alive = true;
    void loadStills().then((stills) => {
      const img = new Image();
      img.onload = () => {
        if (!alive) return;
        image.current = img;
        draw(PIXEL_STEPS[0]);
      };
      img.src = stills.urls[shot];
    });
    return () => {
      alive = false;
    };
  }, [shot, draw]);

  useEffect(() => {
    if (!animate) {
      draw(PIXEL_STEPS[0]);
      return;
    }
    let step = 0;
    const timer = window.setInterval(() => {
      step = (step + 1) % PIXEL_STEPS.length;
      draw(PIXEL_STEPS[step]);
    }, 150);
    return () => window.clearInterval(timer);
  }, [animate, draw]);

  return <canvas ref={canvas} className="fx__pixels" width={PIXEL_STEPS[0]} height={17} />;
}

/** The layers that fake each effect. See Effects.css for what each one does. */
function EffectLayers({ id, shot, hovered }: { id: EffectId; shot: number; hovered: boolean }) {
  switch (id) {
    case 'glow':
      return (
        <>
          <span className="fx__img" />
          <span className="fx__img fx__bloom" />
        </>
      );
    case 'vhs':
      return (
        <>
          <span className="fx__channels">
            <span className="fx__img fx__ch fx__ch--r" />
            <span className="fx__img fx__ch fx__ch--g" />
            <span className="fx__img fx__ch fx__ch--b" />
          </span>
          <span className="fx__scanlines" />
          <span className="fx__tracking" />
        </>
      );
    case 'chroma':
      return (
        <span className="fx__channels">
          <span className="fx__img fx__ch fx__ch--r" />
          <span className="fx__img fx__ch fx__ch--g" />
          <span className="fx__img fx__ch fx__ch--b" />
        </span>
      );
    case 'pixel':
      return <PixelCanvas shot={shot} animate={hovered} />;
    case 'duotone':
      return (
        <>
          <span className="fx__img" />
          <span className="fx__duo fx__duo--highlights" />
          <span className="fx__duo fx__duo--shadows" />
        </>
      );
    case 'blur':
      return <span className="fx__img" />;
    case 'grain':
      return (
        <>
          <span className="fx__img" />
          <span className="fx__noise" />
        </>
      );
    case 'glitch':
      return (
        <>
          <span className="fx__img" />
          <span className="fx__img fx__slice fx__slice--a" />
          <span className="fx__img fx__slice fx__slice--b" />
        </>
      );
  }
}

function EffectTile({ id, name, note, shot }: (typeof TILES)[number]) {
  const [hovered, setHovered] = useState(false);

  // Hovering wipes between the source (left of the pointer) and the effect (right of it).
  const onMove = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--split', `${((e.clientX - r.left) / r.width) * 100}%`);
  };

  return (
    <figure
      className="fx"
      data-fx={id}
      style={{ '--img': `var(--still-${shot})` } as CSSProperties}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerMove={onMove}
    >
      <div className="fx__frame">
        <EffectLayers id={id} shot={shot} hovered={hovered} />
        <span className="fx__img fx__source" />
        <span className="fx__divider" />
      </div>
      <figcaption className="fx__caption">
        <span className="fx__name">{name}</span>
        <span className="fx__note">{note}</span>
      </figcaption>
    </figure>
  );
}

const TRANSITIONS = [
  { id: 'dissolve', name: 'Cross Dissolve' },
  { id: 'wipe', name: 'Linear Wipe' },
  { id: 'push', name: 'Push' },
  { id: 'zoom', name: 'Cross Zoom' },
];

const ALSO = [
  { icon: Blend, text: 'Blend modes' },
  { icon: Shapes, text: 'Masks and shapes' },
  { icon: Type, text: 'Text with animation presets' },
  { icon: Layers2, text: 'Adjustment layers' },
  { icon: Captions, text: 'Subtitles, SRT and VTT in and out' },
];

/** Every effect in the editor's catalogue, for the ticker. */
const CATALOGUE = [
  'Brightness & Contrast',
  'Exposure',
  'Hue & Saturation',
  'Vibrance',
  'Temperature & Tint',
  'Levels',
  'Invert',
  'Colorize',
  'Duotone',
  'Black & White',
  'Sepia',
  'Posterize',
  'Threshold',
  'Color Overlay',
  'Gaussian Blur',
  'Directional Blur',
  'Zoom Blur',
  'Sharpen',
  'Clarity',
  'Tilt-Shift',
  'Glow',
  'Vignette',
  'Light Leak',
  'Film Grain',
  'Chromatic Aberration',
  'RGB Split',
  'Glitch',
  'Pixelate',
  'Halftone',
  'Edge Detect',
  'Emboss',
  'Outline',
  'Drop Shadow',
  'Round Corners',
  'VHS',
  'Scanlines',
  'CRT Monitor',
  'Static Noise',
  'Old Film',
  'Mirror',
  'Kaleidoscope',
  'Lens Distortion',
  'Wave',
  'Swirl',
  'Bulge / Pinch',
  'Tile',
  'Camera Shake',
  'Chroma Key',
  'Luma Key',
  'Letterbox',
];

function Ticker({ hidden }: { hidden?: boolean }) {
  return (
    <ul className="fx-ticker__row" aria-hidden={hidden}>
      {CATALOGUE.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
}

export function Effects() {
  const ref = useRef<HTMLElement>(null);
  const active = useLoopActive(ref);

  return (
    <section className="section" id="effects" aria-labelledby="effects-title" ref={ref} data-active={active}>
      <div className="container">
        <SectionHead
          index="03"
          eyebrow="Effects & transitions"
          id="effects-title"
          title={
            <>
              50 effects. <em>None of them</em> wait for a render.
            </>
          }
          lead="Every effect and transition is a shader running on your GPU, stacked and keyframed on the clip or on an adjustment layer. What you scrub through is the finished frame."
        />

        <div className="fx-grid">
          {TILES.map((tile, i) => (
            <Reveal key={tile.id} delay={0.04 * i}>
              <EffectTile {...tile} />
            </Reveal>
          ))}
        </div>
        <Reveal as="p" className="fx-footnote">
          These tiles are CSS stand-ins for the real shaders, on shader-generated footage. Hover one to wipe
          against the source.
        </Reveal>

        <div className="tr">
          <Reveal className="tr__copy">
            <h3 className="h3">25 transitions</h3>
            <p>
              Drop one on a cut and drag its edges to set the length. Dissolves, wipes, pushes, zooms and a
              few louder ones.
            </p>
          </Reveal>
          <ul className="tr__grid">
            {TRANSITIONS.map((transition, i) => (
              <Reveal as="li" key={transition.id} delay={0.05 * i}>
                <div className="tr__tile" data-tr={transition.id} aria-hidden="true">
                  <span className="tr__a" />
                  <span className="tr__b" />
                </div>
                <span className="tr__name">{transition.name}</span>
              </Reveal>
            ))}
          </ul>
        </div>

        <Reveal>
          <ul className="chips fx-also">
            {ALSO.map((item) => (
              <li key={item.text}>
                <item.icon size="1rem" strokeWidth={1.8} aria-hidden="true" />
                {item.text}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>

      <Reveal className="fx-ticker">
        <div className="fx-ticker__track">
          <Ticker />
          <Ticker hidden />
        </div>
      </Reveal>
    </section>
  );
}
