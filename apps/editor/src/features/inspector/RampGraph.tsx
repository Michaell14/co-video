/**
 * The speed ramp of a clip as a graph: speed, bottom to top, over the media the clip plays, left
 * to right in the order it plays it. Points are dragged, added and removed here, and worked from
 * the keyboard like the points of a colour curve. The graph writes nothing itself: it says what
 * the points should be, and whoever shows it plans the change.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  clamp,
  RAMP_POINTS,
  RAMP_SHAPE_NAMES,
  RAMP_SHAPES,
  type Clip,
  type Project,
  type RampPoint,
  type RampShape,
} from '@tandem/core';
import { usePlayer } from '../../session/hooks';
import { tip, toast } from '../../ui/core';
import { isDrag, type Press } from '../../ui/press';
import {
  acrossOf,
  addPoint,
  besideOf,
  curvePath,
  describePoint,
  dragPoint,
  frameShowing,
  hitPoint,
  isFull,
  keyMove,
  mediaAcross,
  mediaShown,
  pointAt,
  removePoint,
  secondMarks,
  shapePath,
  shownPoints,
  SPEED_LINES,
  upOf,
  type RampRange,
  type Shown,
} from './rampPoints';
import { isShortcut, keepKey, useKeyRun } from './sliderKeys';
import './ramp.css';

/** The graph's own measure. It is stretched to the box it is given. */
const WIDTH = 1000;
const HEIGHT = 100;
const MARKS_HEIGHT = 5;

/** What a ramp chip sets: no ramp, one to shape by hand, or a ready-made shape. */
export type RampChoice = RampShape | 'none' | 'custom';

const ICON = { width: 20, height: 12 };
const SHAPES = Object.keys(RAMP_SHAPES) as RampShape[];

/** The chips that put a clip on a ramp: each ready-made shape with a small drawing of its curve. */
export function RampChips({
  pressed,
  onPick,
}: {
  pressed: RampChoice;
  onPick: (choice: RampChoice) => void;
}) {
  return (
    <div className="ramp__chips" role="group" aria-label="Ramp shape">
      <button className="chip" aria-pressed={pressed === 'none'} onClick={() => onPick('none')}>
        None
      </button>
      <button className="chip" aria-pressed={pressed === 'custom'} onClick={() => onPick('custom')}>
        Custom
      </button>
      {SHAPES.map((shape) => (
        <button key={shape} className="chip" aria-pressed={pressed === shape} onClick={() => onPick(shape)}>
          <svg
            className="ramp__shape"
            viewBox={`0 0 ${ICON.width} ${ICON.height}`}
            width={ICON.width}
            height={ICON.height}
            aria-hidden="true"
          >
            <path d={shapePath(shape, ICON)} />
          </svg>
          {RAMP_SHAPE_NAMES[shape]}
        </button>
      ))}
    </div>
  );
}

export interface RampGraphProps {
  /** The clip whose ramp is shown: the one the ramp of its group of linked clips is named for. */
  clip: Clip;
  project: Project;
  /** The stretch of media the graph runs across. */
  range: RampRange;
  /** The chosen point, by its place in seconds of the media. */
  chosen: number | null;
  onChoose: (m: number | null) => void;
  /** A drag of a point, or a run of key presses on one, is about to begin. */
  onStart: () => void;
  /** The points the ramp should have, at every move of that drag and every press of that run. */
  onChange: (points: RampPoint[]) => void;
  /** The drag or the run is over. */
  onEnd: () => void;
  /** The points after one was added or removed: a step of its own. */
  onSet: (points: RampPoint[]) => void;
  /** Take the playhead to a frame of the timeline. */
  onSeek: (frame: number) => void;
  /**
   * A point to hand the keyboard to, by its place; a new object each time it is asked for. With
   * `gone`, only once no point stands at that place any more: the point beside one that is being
   * removed.
   */
  focus: { m: number; gone?: number } | null;
  /** Shown, and not to be worked. */
  inert: boolean;
}

/** A press that is under way: on a point, which a drag then moves, or beside them, which scrubs. */
type Held =
  | {
      on: 'point';
      press: Press;
      /** The point as the press found it: what the drag is measured from. */
      from: RampPoint;
      /** The place the point was last found at, and the place the drag last asked for it. */
      at: number;
      asked: number;
      /**
       * The second of media under the playhead as the press found it, for the point to snap to. The
       * drag changes what the clip shows on that frame; the moment that was parked on stays.
       */
      playhead: number | null;
      dragged: boolean;
    }
  | { on: 'graph' };

export function RampGraph(props: RampGraphProps) {
  const { clip, project, range, chosen, onChoose, onStart, onChange, onEnd, onSet, onSeek, focus, inert } =
    props;
  const player = usePlayer();
  const surface = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const held = useRef<Held | null>(null);
  // What the handlers of a drag read: the ramp as it is by the time the pointer moves again.
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  });

  const points = useMemo(() => clip.ramp ?? [], [clip.ramp]);
  const shown = useMemo(() => shownPoints(points, range), [points, range]);
  const path = useMemo(
    () => (points.length < 2 ? '' : curvePath(points, range, { width: WIDTH, height: HEIGHT })),
    [points, range],
  );
  const marks = secondMarks(clip, project, range);

  // A run of key presses is one gesture, like one drag: it begins with its first press and is
  // over when the keys have rested.
  const running = useRef(false);
  const run = useKeyRun(() => {
    running.current = false;
    live.current.onEnd();
  });

  // The playhead follows the player without the panel being drawn again for every frame.
  const place = useCallback(() => {
    const el = head.current;
    if (!el || !player) return;
    const { clip, project, range } = live.current;
    const m = mediaShown(clip, player.getFrame(), project);
    el.style.visibility = m === null ? 'hidden' : 'visible';
    if (m !== null) el.style.transform = `translateX(${(clamp(acrossOf(m, range), 0, 1) * 100).toFixed(3)}%)`;
  }, [player]);
  useEffect(() => player?.onFrame(place), [player, place]);
  useLayoutEffect(place);

  // The keyboard goes to a point that was asked for, once it is drawn: one that was added, or the
  // one beside a point that Delete was pressed on, when that point is in fact gone.
  const wanted = useRef<{ m: number; gone?: number } | null>(null);
  useLayoutEffect(() => {
    if (focus) wanted.current = focus;
  }, [focus]);
  useLayoutEffect(() => {
    const want = wanted.current;
    if (!want) return;
    wanted.current = null;
    if (want.gone !== undefined && pointAt(points, want.gone) >= 0) return;
    const i = pointAt(points, want.m);
    const key = i < 0 ? null : surface.current?.querySelector<SVGElement>(`[data-point="${i}"]`);
    if (!key) return;
    key.focus();
    // The point may be drawn by what drew the one before it, which had the keyboard already.
    live.current.onChoose(points[i].m);
  });

  const size = (): DOMRect => box.current!.getBoundingClientRect();
  const hit = (e: { clientX: number; clientY: number }): Shown | null => {
    const r = size();
    return hitPoint(shown, e.clientX - r.left, e.clientY - r.top, r);
  };
  const mediaUnder = (e: { clientX: number }): number => {
    const r = size();
    return mediaAcross(clamp((e.clientX - r.left) / r.width, 0, 1), range);
  };

  const release = (e: PointerEvent<HTMLDivElement>) => {
    const was = held.current;
    held.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (was?.on === 'point') onEnd();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const on = hit(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!on) {
      // Beside the points a press is about the playhead: it goes to that moment of the clip.
      held.current = { on: 'graph' };
      onSeek(frameShowing(clip, mediaUnder(e), project));
      return;
    }
    held.current = {
      on: 'point',
      press: { time: e.timeStamp, x: e.clientX, y: e.clientY },
      from: { m: on.m, v: on.v },
      at: on.m,
      asked: on.m,
      playhead: player ? mediaShown(clip, player.getFrame(), project) : null,
      dragged: false,
    };
    onChoose(on.m);
    onStart();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const h = held.current;
    if (!h) return;
    if (h.on === 'graph') {
      onSeek(frameShowing(clip, mediaUnder(e), project));
      return;
    }
    // A press that has not left its spot is a click, perhaps the first of two.
    h.dragged ||= isDrag(h.press, e.clientX, e.clientY);
    if (!h.dragged) return;
    const now = live.current;
    const ramp = now.clip.ramp;
    // Somebody else may have changed the ramp since the last move. The point being dragged is the
    // one that stands where this drag last put it, or where it stood before a step that was not
    // made (a clip that had to follow is on a locked track). Every other point is theirs to have
    // moved, added or removed. When it is at neither place, they removed it, and the drag is over.
    const put = ramp ? pointAt(ramp, h.asked) : -1;
    const i = ramp && put < 0 ? pointAt(ramp, h.at) : put;
    if (!ramp || i < 0) {
      release(e);
      return;
    }
    h.at = ramp[i].m;
    const next = dragPoint(ramp, i, h.from, e.clientX - h.press.x, e.clientY - h.press.y, size(), now.range, {
      playhead: h.playhead,
      free: e.shiftKey,
    });
    if (next === ramp) return;
    h.asked = next[i].m;
    onChange(next);
    onChoose(next[i].m);
  };

  const onDoubleClick = (e: { clientX: number; clientY: number }) => {
    const on = hit(e);
    if (on) {
      const next = removePoint(points, on.index);
      if (next) onSet(next);
      return;
    }
    if (isFull(points)) {
      toast(`A ramp holds at most ${RAMP_POINTS} points.`, 'info');
      return;
    }
    const added = addPoint(points, mediaUnder(e), range);
    if (!added) return;
    onSet(added.points);
    onChoose(added.points[added.index].m);
  };

  /**
   * A key pressed on a point. The arrows, the Page keys, Home and End move it (see `keyMove`),
   * Delete removes it and Enter takes the playhead to it. Each of them stays with the point, also
   * where it has nothing to do: Delete must not go on to delete the clip.
   */
  const onPointKey = (e: KeyboardEvent, s: Shown) => {
    if (isShortcut(e)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      keepKey(e);
      const next = removePoint(points, s.index);
      if (!next) return;
      run.rest();
      const beside = besideOf(shown, s.index);
      wanted.current = beside && { m: beside.m, gone: s.m };
      onSet(next);
      return;
    }
    if (e.key === 'Enter') {
      keepKey(e);
      onSeek(frameShowing(clip, s.m, project));
      return;
    }
    const next = keyMove(e.key, e.shiftKey, points, s.index, range);
    if (next === undefined) return;
    keepKey(e);
    if (next === points) return;
    run.press();
    if (!running.current) {
      running.current = true;
      onStart();
    }
    onChange(next);
    onChoose(next[s.index].m);
  };

  const chosenIndex = chosen === null ? -1 : pointAt(points, chosen);

  return (
    <div
      ref={surface}
      className="ramp__plot"
      role="group"
      aria-label="Speed ramp"
      inert={inert}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onDoubleClick={onDoubleClick}
    >
      <div className="ramp__scale" aria-hidden="true">
        {SPEED_LINES.map((v) => (
          <span key={v} style={{ bottom: `${upOf(v) * 100}%` }}>
            {Math.round(v * 100)}%
          </span>
        ))}
      </div>
      <div ref={box} className="ramp__box">
        <svg className="ramp__graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
          <g className="ramp__grid">
            {SPEED_LINES.slice(1, -1).map((v) => (
              <line
                key={v}
                className={v === 1 ? 'ramp__full' : undefined}
                x1={0}
                x2={WIDTH}
                y1={(1 - upOf(v)) * HEIGHT}
                y2={(1 - upOf(v)) * HEIGHT}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
          <path className="ramp__curve" d={path} vectorEffect="non-scaling-stroke" />
          {shown.map((s, n) => {
            // The graph is stretched to its box, which would turn a circle into an oval. A line of
            // no length with round ends and a stroke that does not scale is a round dot at any shape.
            const at = { x1: s.x * WIDTH, x2: s.x * WIDTH, y1: (1 - s.y) * HEIGHT, y2: (1 - s.y) * HEIGHT };
            return (
              <g key={s.index} className="ramp__pt" data-chosen={s.index === chosenIndex || undefined}>
                {/* The point for the keyboard and for assistive technology, and the ring it wears
                    there. The pointer never lands on it (ramp.css): a press takes hold of the dot
                    and leaves the keyboard where it was. */}
                <line
                  {...at}
                  className="ramp__pt-key"
                  vectorEffect="non-scaling-stroke"
                  data-point={s.index}
                  role="slider"
                  tabIndex={0}
                  aria-label={`Ramp point ${n + 1} of ${shown.length}`}
                  aria-valuemin={10}
                  aria-valuemax={1000}
                  aria-valuenow={Math.round(s.v * 100)}
                  aria-valuetext={describePoint(s, range)}
                  onFocus={() => onChoose(s.m)}
                  onBlur={run.rest}
                  onKeyDown={(e) => onPointKey(e, s)}
                />
                <line {...at} className="ramp__pt-edge" vectorEffect="non-scaling-stroke" />
                <line {...at} className="ramp__pt-fill" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
        <div ref={head} className="ramp__head" />
      </div>
      <svg
        className="ramp__marks"
        viewBox={`0 0 ${WIDTH} ${MARKS_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        {...tip(
          marks.step === 1
            ? 'Each mark is a second of the clip'
            : `Each mark is ${marks.step} seconds of the clip`,
        )}
      >
        {marks.at.map((x) => (
          <line
            key={x}
            x1={x * WIDTH}
            x2={x * WIDTH}
            y1={0}
            y2={MARKS_HEIGHT}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}
