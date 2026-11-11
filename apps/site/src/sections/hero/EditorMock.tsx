import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Cursor } from '../../components/Cursor';
import { createFootageRenderer } from '../../lib/footage';
import type { FootageRenderer } from '../../lib/footage';
import { useLoopActive, useRafLoop, useWidth } from '../../lib/hooks';
import { lerp, sampleTrack, timecode, wobble } from '../../lib/math';
import type { Key, Point } from '../../lib/math';
import { createMockEls, PEOPLE } from './mockEls';
import type { MockEls } from './mockEls';
import { MockBar, MockBin, MockInspector, MockViewer } from './MockPanels';
import { CUT, createMockState, DRONE, FPS, LOOP_SECONDS, sampleMock } from './mockScript';
import type { TrackId } from './mockScript';
import { MockTimeline } from './MockTimeline';
import './EditorMock.css';

/**
 * The mock is laid out at a fixed design size and scaled as one piece to fit its container, so it
 * reads like a product shot at any width. Narrow screens get a second, simpler layout.
 */
const GEOMETRY = {
  full: { width: 1280, height: 800, pps: 37, t0: 0 },
  compact: { width: 560, height: 634, pps: 23.5, t0: 1.5 },
} as const;

type Variant = keyof typeof GEOMETRY;

const COMPACT_QUERY = '(max-width: 760px)';
/** Loop time shown when motion is reduced: mid-drag, title on screen. */
const STILL_POSE = 3;
const VIEWER_FPS = 30;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Positions (in design pixels, relative to the mock) that the scripted cursors aim for. */
interface Anchors {
  lanes: Record<TrackId, Box>;
  viewer: Box;
  wheel: Box | null;
  sat: Box | null;
}

interface CursorPath {
  x: Key[];
  y: Key[];
}

/** Layout box of `el` relative to `root`, ignoring transforms (so the hero tilt can't skew it). */
function boxWithin(el: HTMLElement, root: HTMLElement): Box {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function measure(els: MockEls): Anchors | null {
  const { root, lanes, picture } = els;
  const { v3, v2, v1, a1, a2 } = lanes;
  if (!root || !picture || !v3 || !v2 || !v1 || !a1 || !a2) return null;
  const visible = (el: HTMLElement | null) => (el && el.offsetParent ? boxWithin(el, root) : null);
  return {
    lanes: {
      v3: boxWithin(v3, root),
      v2: boxWithin(v2, root),
      v1: boxWithin(v1, root),
      a1: boxWithin(a1, root),
      a2: boxWithin(a2, root),
    },
    viewer: boxWithin(picture, root),
    wheel: visible(els.wheel),
    sat: visible(els.satTrack),
  };
}

const path = (points: readonly (readonly [t: number, p: Point])[]): CursorPath => ({
  x: points.map(([t, p]) => ({ t, v: p.x })),
  y: points.map(([t, p]) => ({ t, v: p.y })),
});

const along = (p: CursorPath, t: number): Point => ({ x: sampleTrack(p.x, t), y: sampleTrack(p.y, t) });

function useCompact(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return compact;
}

export function EditorMock() {
  const reduced = useReducedMotion();
  const variant: Variant = useCompact() ? 'compact' : 'full';
  const geo = GEOMETRY[variant];

  const fit = useRef<HTMLDivElement>(null);
  const width = useWidth(fit);
  const scale = width > 0 ? width / geo.width : 0;

  const els = useMemo(createMockEls, []);
  const state = useMemo(createMockState, []);
  const anchors = useRef<Anchors | null>(null);
  const paths = useRef<{ maya: CursorPath; jonas: CursorPath; aiko: CursorPath } | null>(null);
  const renderer = useRef<FootageRenderer | null>(null);
  const last = useRef({ tc: '', cut: -1, shot: -1, viewerAt: -1 });

  const active = useLoopActive(fit) && !reduced;

  const frame = useCallback(
    (time: number) => {
      const a = anchors.current;
      const p = paths.current;
      if (!a || !p) return;
      const s = sampleMock(time, state);
      const t = time % LOOP_SECONDS;
      const { pps, t0 } = geo;
      const xOf = (sec: number) => (sec - t0) * pps;
      const prev = last.current;

      if (els.playhead) els.playhead.style.transform = `translate3d(${xOf(s.playhead)}px,0,0)`;

      const tc = timecode(s.playhead, FPS);
      if (tc !== prev.tc) {
        prev.tc = tc;
        for (const el of els.timecodes) if (el) el.textContent = tc;
      }

      // Maya's clip follows her hand (and snaps); Jonas rolls the cut between two clips.
      const drone = els.clips[DRONE.id];
      if (drone) {
        drone.style.transform = `translate3d(${(s.droneStart - DRONE.start) * pps}px,0,0)`;
        drone.dataset.held = String(s.mayaDown);
      }
      if (els.snapLine) els.snapLine.dataset.on = String(s.snapped);

      const left = els.clips[CUT.left];
      const right = els.clips[CUT.right];
      if (left && right) {
        if (s.cut !== prev.cut) {
          prev.cut = s.cut;
          const moved = s.cut - CUT.from;
          left.style.setProperty('--dur', String(s.cut - CUT.leftStart));
          right.style.setProperty('--start', String(s.cut));
          right.style.setProperty('--dur', String(CUT.rightEnd - s.cut));
          if (els.trimBadge)
            els.trimBadge.textContent = `+${String(Math.round(moved * FPS)).padStart(2, '0')}`;
        }
        left.dataset.trim = String(s.jonasDown);
      }

      // Aiko's colour wheel and saturation slider.
      if (a.wheel && els.puck) {
        const r = a.wheel.w / 2 - 7;
        els.puck.style.transform = `translate(${s.puck.x * r}px, ${s.puck.y * r}px)`;
        els.puck.dataset.held = String(s.aikoDown && s.aikoWheel > 0.99);
      }
      const satFrac = s.saturation / 2;
      if (els.satFill) els.satFill.style.transform = `scaleX(${satFrac})`;
      if (els.satThumb) els.satThumb.style.left = `${satFrac * 100}%`;
      if (els.satValue) els.satValue.textContent = s.saturation.toFixed(2);

      if (els.title) els.title.style.opacity = String(s.titleOpacity);
      if (els.lower) els.lower.style.opacity = String(s.lowerOpacity);

      // Cursors: wander along a free path, blend onto a target while working on it.
      const place = (el: HTMLDivElement | null, pos: Point, down: boolean, seed: number, calm: number) => {
        if (!el) return;
        const w = wobble(time, seed, 2.2 * (1 - calm));
        el.style.transform = `translate3d(${pos.x + w.x}px,${pos.y + w.y}px,0)`;
        el.dataset.down = String(down);
      };

      const mayaFree = along(p.maya, t);
      const mayaTarget = { x: a.lanes.v2.x + xOf(s.droneDrag) + 54, y: a.lanes.v2.y + a.lanes.v2.h * 0.6 };
      place(
        els.maya,
        { x: lerp(mayaFree.x, mayaTarget.x, s.mayaAttach), y: lerp(mayaFree.y, mayaTarget.y, s.mayaAttach) },
        s.mayaDown,
        1.7,
        s.mayaAttach,
      );

      const jonasFree = along(p.jonas, t);
      const jonasTarget = { x: a.lanes.v1.x + xOf(s.cut), y: a.lanes.v1.y + a.lanes.v1.h * 0.56 };
      place(
        els.jonas,
        {
          x: lerp(jonasFree.x, jonasTarget.x, s.jonasAttach),
          y: lerp(jonasFree.y, jonasTarget.y, s.jonasAttach),
        },
        s.jonasDown,
        4.1,
        s.jonasAttach,
      );

      if (a.wheel && a.sat) {
        const free = along(p.aiko, t);
        const r = a.wheel.w / 2 - 7;
        const wheel = {
          x: a.wheel.x + a.wheel.w / 2 + s.puck.x * r,
          y: a.wheel.y + a.wheel.h / 2 + s.puck.y * r,
        };
        const sat = { x: a.sat.x + a.sat.w * satFrac, y: a.sat.y + a.sat.h / 2 };
        const rest = Math.max(0, 1 - s.aikoWheel - s.aikoSat);
        place(
          els.aiko,
          {
            x: free.x * rest + wheel.x * s.aikoWheel + sat.x * s.aikoSat,
            y: free.y * rest + wheel.y * s.aikoWheel + sat.y * s.aikoSat,
          },
          s.aikoDown,
          6.3,
          1 - rest,
        );
      }

      // Viewer: cut to whichever shot is under the playhead; the wheel warms the grade.
      if (els.picture && s.shot !== prev.shot) els.picture.dataset.shot = String(s.shot);
      if (renderer.current && (s.shot !== prev.shot || Math.abs(time - prev.viewerAt) >= 1 / VIEWER_FPS)) {
        prev.viewerAt = time;
        renderer.current.render(time, s.shot, {
          tint: [s.puck.x * 0.45 - s.puck.y * 0.2, -s.puck.y * 0.1, -s.puck.x * 0.45 + s.puck.y * 0.3],
          saturation: s.saturation,
          flat: 0,
        });
      }
      prev.shot = s.shot;
    },
    [els, geo, state],
  );

  // The viewer's footage shader. Bound once; the layout effect above draws the first frame.
  useEffect(() => {
    const canvas = els.canvas;
    if (!canvas) return;
    const hiDpi = window.devicePixelRatio >= 2 && window.innerWidth > 1100;
    canvas.width = hiDpi ? 960 : 640;
    canvas.height = hiDpi ? 540 : 360;
    renderer.current = createFootageRenderer(canvas);
    canvas.hidden = renderer.current === null;
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [els]);

  // Measure anchors and lay out the cursors' idle paths whenever the layout variant changes.
  useEffect(() => {
    const layout = () => {
      const a = measure(els);
      if (!a) return;
      anchors.current = a;
      const { pps, t0 } = geo;
      const tl = (sec: number, track: TrackId, fy = 0.5): Point => ({
        x: a.lanes[track].x + (sec - t0) * pps,
        y: a.lanes[track].y + a.lanes[track].h * fy,
      });
      const view = (fx: number, fy: number): Point => ({
        x: a.viewer.x + a.viewer.w * fx,
        y: a.viewer.y + a.viewer.h * fy,
      });
      paths.current = {
        maya: path([
          [0, tl(21, 'v3', 0.7)],
          [6.5, tl(14.5, 'v3', 0.6)],
          [11, tl(7.5, 'v3', 0.75)],
          [13.4, tl(8.5, 'v3', 0.8)],
          [18.5, tl(19, 'v2', 0.3)],
          [LOOP_SECONDS, tl(21, 'v3', 0.7)],
        ]),
        jonas: path([
          [0, tl(21.6, 'a1', 0.5)],
          [4.6, tl(22.4, 'a1', 0.3)],
          [11.5, tl(13, 'a2', 0.45)],
          [15.6, tl(21, 'a1', 0.6)],
          [LOOP_SECONDS, tl(21.6, 'a1', 0.5)],
        ]),
        aiko: path([
          [0, view(0.82, 0.66)],
          [2.5, view(0.86, 0.58)],
          [14.2, view(0.7, 0.44)],
          [15.2, view(0.8, 0.5)],
          [LOOP_SECONDS, view(0.82, 0.66)],
        ]),
      };
      last.current = { tc: '', cut: -1, shot: -1, viewerAt: -1 };
      frame(reduced ? STILL_POSE : 0);
    };
    layout();
    // Web fonts change text metrics, which can nudge the measured boxes.
    void document.fonts.ready.then(layout);
  }, [els, geo, frame, reduced]);

  useRafLoop(frame, active);

  const style = {
    width: geo.width,
    height: geo.height,
    transform: `scale(${scale})`,
    visibility: scale > 0 ? 'visible' : 'hidden',
    '--pps': geo.pps,
    '--t0': geo.t0,
  } as CSSProperties;

  return (
    <div
      ref={fit}
      className={`mock-fit mock-fit--${variant}`}
      role="img"
      aria-label="The Tandem editor: a media bin, a viewer, a colour inspector and a five-track timeline, with three collaborators — Maya, Jonas and Aiko — editing at the same time."
    >
      <div
        className={`mk mk--${variant}`}
        style={style}
        aria-hidden="true"
        ref={(node) => {
          els.root = node;
        }}
      >
        <MockBar />
        <div className="mk-main">
          <MockBin />
          <MockViewer els={els} />
          <MockInspector els={els} />
        </div>
        <MockTimeline els={els} />
        <Cursor
          {...PEOPLE.maya}
          ref={(node) => {
            els.maya = node;
          }}
        />
        <Cursor
          {...PEOPLE.jonas}
          ref={(node) => {
            els.jonas = node;
          }}
        />
        <Cursor
          {...PEOPLE.aiko}
          className="mk-cursor-aiko"
          ref={(node) => {
            els.aiko = node;
          }}
        />
      </div>
    </div>
  );
}
