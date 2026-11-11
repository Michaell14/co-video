import { Check, Eye, MessageSquare, Type } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { Avatar } from '../../components/Avatar';
import { Cursor } from '../../components/Cursor';
import { Waveform } from '../../components/Waveform';
import { useLoopActive, useRafLoop } from '../../lib/hooks';
import { clamp, inSpans, lerp, sampleTrack, timecode, wobble } from '../../lib/math';
import type { Key, Point } from '../../lib/math';
import './MultiplayerDemo.css';

const DURATION = 20; // seconds of timeline shown
const LOOP = 12; // seconds per scripted loop
const SNAP_POINTS = [7, 13];
const SNAP_RANGE = 0.35;
const NUDGE = 0.25;

const MAYA = { name: 'Maya', color: '#ff5d5d' };
const JONAS = { name: 'Jonas', color: '#22d3ee' };
const AIKO = { name: 'Aiko', color: '#ff9f43' };
const YOU = { name: 'You', color: '#c6f84f' };

/** Clips the visitor can move. Each keeps to its own stretch of the lane, so nothing can collide. */
const USER_CLIPS = [
  {
    id: 'title',
    lane: 0,
    start: 11.2,
    dur: 4.2,
    min: 10.2,
    max: 15.8,
    kind: 'text',
    name: 'Title · LOW TIDE',
    seed: 0,
  },
  { id: 'vo', lane: 2, start: 0.8, dur: 6, min: 0, max: 4, kind: 'audio', name: 'VO_take3.wav', seed: 11 },
  {
    id: 'sfx',
    lane: 2,
    start: 11.4,
    dur: 5,
    min: 10.2,
    max: 15,
    kind: 'audio',
    name: 'Waves_ambience.wav',
    seed: 29,
  },
] as const;

type UserClipId = (typeof USER_CLIPS)[number]['id'];

const INITIAL_STARTS: Record<UserClipId, number> = { title: 11.2, vo: 0.8, sfx: 11.4 };

/* ---- The scripted half of the session ---- */

const MAYA_CLIP = { start: 2.2, dur: 4.2, to: 5.4 };
const JONAS_CLIP = { start: 7, end: 13, trimmedEnd: 11.8 };

const MAYA_START: Key[] = [
  { t: 0, v: MAYA_CLIP.start },
  { t: 1.2, v: MAYA_CLIP.start },
  { t: 3, v: MAYA_CLIP.to },
  { t: 6.8, v: MAYA_CLIP.to },
  { t: 8.6, v: MAYA_CLIP.start },
  { t: LOOP, v: MAYA_CLIP.start },
];
const MAYA_ATTACH: Key[] = [
  { t: 0, v: 0 },
  { t: 1.0, v: 1 },
  { t: 3.3, v: 1 },
  { t: 4.2, v: 0 },
  { t: 5.6, v: 0 },
  { t: 6.6, v: 1 },
  { t: 8.9, v: 1 },
  { t: 9.8, v: 0 },
  { t: LOOP, v: 0 },
];
const MAYA_DOWN = [
  [1.1, 3.1],
  [6.7, 8.7],
] as const;

const JONAS_END: Key[] = [
  { t: 0, v: JONAS_CLIP.end },
  { t: 3.2, v: JONAS_CLIP.end },
  { t: 5, v: JONAS_CLIP.trimmedEnd },
  { t: 9.4, v: JONAS_CLIP.trimmedEnd },
  { t: 10.8, v: JONAS_CLIP.end },
  { t: LOOP, v: JONAS_CLIP.end },
];
const JONAS_ATTACH: Key[] = [
  { t: 0, v: 0 },
  { t: 2.0, v: 0 },
  { t: 3.0, v: 1 },
  { t: 5.3, v: 1 },
  { t: 6.2, v: 0 },
  { t: 8.3, v: 0 },
  { t: 9.2, v: 1 },
  { t: 11.1, v: 1 },
  { t: 11.9, v: 0 },
  { t: LOOP, v: 0 },
];
const JONAS_DOWN = [
  [3.1, 5.1],
  [9.3, 10.9],
] as const;

/** Stages of the comment thread, by loop time. */
const THREAD_STAGES = [
  { from: 1.5, stage: 1 }, // Aiko asks
  { from: 5.6, stage: 2 }, // Jonas replies
  { from: 7.6, stage: 3 }, // resolved
  { from: 9.2, stage: 0 }, // gone
];
const COMMENT_AT = 11.9;

/** Where the lanes sit inside the stage, in pixels; the scripted cursors are placed from this. */
interface Metrics {
  lanesX: number;
  lanesW: number;
  laneY: number[];
  laneH: number;
}

const pct = (seconds: number): string => `${(seconds / DURATION) * 100}%`;

export function MultiplayerDemo() {
  const reduced = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const metrics = useRef<Metrics | null>(null);

  const mayaCursor = useRef<HTMLDivElement>(null);
  const jonasCursor = useRef<HTMLDivElement>(null);
  const youCursor = useRef<HTMLDivElement>(null);
  const mayaClip = useRef<HTMLDivElement>(null);
  const jonasClip = useRef<HTMLDivElement>(null);
  const mayaHead = useRef<HTMLDivElement>(null);
  const youHead = useRef<HTMLDivElement>(null);
  const youHeadLabel = useRef<HTMLSpanElement>(null);

  const [starts, setStarts] = useState(INITIAL_STARTS);
  const [held, setHeld] = useState<UserClipId | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [following, setFollowing] = useState(false);
  const [thread, setThread] = useState(0);
  const [inside, setInside] = useState(false);

  const drag = useRef<{ id: UserClipId; originX: number; originStart: number } | null>(null);
  const pointer = useRef<Point | null>(null);
  const live = useRef({ following: false, youAt: 9, mayaAt: 4, thread: 0 });
  useEffect(() => {
    live.current.following = following;
  }, [following]);

  const active = useLoopActive(stage) && !reduced;

  const measure = useCallback(() => {
    const s = stage.current;
    const l = lanes.current;
    if (!s || !l) return;
    const sr = s.getBoundingClientRect();
    const lr = l.getBoundingClientRect();
    const rows = Array.from(l.querySelectorAll<HTMLElement>('.mp-lane')).map((el) =>
      el.getBoundingClientRect(),
    );
    if (rows.length === 0) return;
    metrics.current = {
      lanesX: lr.left - sr.left,
      lanesW: lr.width,
      laneY: rows.map((r) => r.top - sr.top),
      laneH: rows[0].height,
    };
  }, []);

  const frame = useCallback((time: number) => {
    const m = metrics.current;
    if (!m) return;
    const t = time % LOOP;
    const xOf = (sec: number) => m.lanesX + (sec / DURATION) * m.lanesW;
    const laneMid = (lane: number, fy = 0.55) => m.laneY[lane] + m.laneH * fy;

    // Maya drags a clip back and forth on V2.
    const mayaStart = sampleTrack(MAYA_START, t);
    const mayaDown = inSpans(MAYA_DOWN, t);
    if (mayaClip.current) {
      mayaClip.current.style.transform = `translate3d(${((mayaStart - MAYA_CLIP.start) / DURATION) * m.lanesW}px,0,0)`;
      mayaClip.current.dataset.held = String(mayaDown);
    }

    // Jonas trims the tail of a clip on V1, then puts it back.
    const jonasEnd = sampleTrack(JONAS_END, t);
    const jonasDown = inSpans(JONAS_DOWN, t);
    if (jonasClip.current) {
      jonasClip.current.style.width = pct(jonasEnd - JONAS_CLIP.start);
      jonasClip.current.dataset.trim = String(jonasDown);
    }

    const place = (
      el: HTMLDivElement | null,
      free: Point,
      target: Point,
      attach: number,
      down: boolean,
      seed: number,
    ) => {
      if (!el) return;
      const w = wobble(time, seed, 2.5 * (1 - attach));
      el.style.transform = `translate3d(${lerp(free.x, target.x, attach) + w.x}px,${lerp(free.y, target.y, attach) + w.y}px,0)`;
      el.dataset.down = String(down);
    };
    place(
      mayaCursor.current,
      { x: m.lanesX + m.lanesW * (0.5 + 0.08 * Math.sin(time * 0.5)), y: m.laneY[0] - m.laneH * 0.3 },
      { x: xOf(mayaStart) + Math.min(46, m.lanesW * 0.08), y: laneMid(0) },
      sampleTrack(MAYA_ATTACH, t),
      mayaDown,
      1.3,
    );
    place(
      jonasCursor.current,
      { x: m.lanesX + m.lanesW * (0.86 + 0.04 * Math.sin(time * 0.4)), y: laneMid(2, 0.4) },
      { x: xOf(jonasEnd), y: laneMid(1) },
      sampleTrack(JONAS_ATTACH, t),
      jonasDown,
      3.9,
    );

    // Playheads: Maya's sweeps; yours skims under your pointer, or locks to hers in follow mode.
    const state = live.current;
    state.mayaAt = 10 + 6.2 * Math.sin((time / LOOP) * Math.PI * 2 - 1.2);
    const pointerSec = pointer.current
      ? clamp(((pointer.current.x - m.lanesX) / m.lanesW) * DURATION, 0, DURATION)
      : 9;
    const goal = state.following ? state.mayaAt : pointerSec;
    state.youAt = lerp(state.youAt, goal, state.following ? 0.2 : 0.35);
    if (mayaHead.current)
      mayaHead.current.style.transform = `translate3d(${(state.mayaAt / DURATION) * m.lanesW}px,0,0)`;
    if (youHead.current)
      youHead.current.style.transform = `translate3d(${(state.youAt / DURATION) * m.lanesW}px,0,0)`;
    if (youHeadLabel.current) youHeadLabel.current.textContent = timecode(state.youAt).slice(3);

    let next = 0;
    for (const step of THREAD_STAGES) if (t >= step.from) next = step.stage;
    if (next !== state.thread) {
      state.thread = next;
      setThread(next);
    }
  }, []);

  useEffect(() => {
    measure();
    frame(reduced ? 6 : 0);
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      measure();
      if (reduced) frame(6);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, frame, reduced]);

  useRafLoop(frame, active);

  /* ---- The visitor ---- */

  const moveYou = (e: PointerEvent<HTMLDivElement>) => {
    const s = stage.current;
    if (!s) return;
    const r = s.getBoundingClientRect();
    const p = { x: clamp(e.clientX - r.left, 0, r.width), y: clamp(e.clientY - r.top, 0, r.height) };
    pointer.current = p;
    if (youCursor.current) youCursor.current.style.transform = `translate3d(${p.x}px,${p.y}px,0)`;
  };

  const onStageMove = (e: PointerEvent<HTMLDivElement>) => {
    moveYou(e);
    const d = drag.current;
    const m = metrics.current;
    if (!d || !m) return;
    const clip = USER_CLIPS.find((c) => c.id === d.id);
    if (!clip) return;
    let start = d.originStart + ((e.clientX - d.originX) / m.lanesW) * DURATION;
    let snapped: number | null = null;
    for (const point of SNAP_POINTS) {
      if (Math.abs(start - point) < SNAP_RANGE) {
        start = point;
        snapped = point;
      } else if (Math.abs(start + clip.dur - point) < SNAP_RANGE) {
        start = point - clip.dur;
        snapped = point;
      }
    }
    start = clamp(start, clip.min, clip.max);
    setSnapAt(snapped !== null && (start === snapped || start + clip.dur === snapped) ? snapped : null);
    setStarts((prev) => (prev[d.id] === start ? prev : { ...prev, [d.id]: start }));
  };

  const endDrag = () => {
    drag.current = null;
    setHeld(null);
    setSnapAt(null);
  };

  const onStageLeave = () => {
    if (drag.current) return;
    pointer.current = null;
    setInside(false);
    if (youCursor.current) youCursor.current.style.transform = '';
  };

  const onClipDown = (e: PointerEvent<HTMLButtonElement>, id: UserClipId) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, originX: e.clientX, originStart: starts[id] };
    setHeld(id);
  };

  const onClipKey = (e: KeyboardEvent<HTMLButtonElement>, id: UserClipId) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const clip = USER_CLIPS.find((c) => c.id === id);
    if (!clip) return;
    const delta = e.key === 'ArrowLeft' ? -NUDGE : NUDGE;
    setStarts((prev) => ({ ...prev, [id]: clamp(prev[id] + delta, clip.min, clip.max) }));
  };

  return (
    <div
      className="mp"
      role="group"
      aria-label="Interactive demo: a shared timeline with two scripted collaborators"
      data-following={following}
      data-active={active}
    >
      <div className="mp__bar">
        <div className="mp__people">
          <button
            type="button"
            className="mp__person mp__person--button"
            aria-pressed={following}
            onClick={() => setFollowing((v) => !v)}
          >
            <Avatar {...MAYA} size="1.5rem" />
            <span>Maya</span>
            <span className="mp__role">editor</span>
          </button>
          <span className="mp__person">
            <Avatar {...JONAS} size="1.5rem" />
            <span>Jonas</span>
            <span className="mp__role">editor</span>
          </span>
          <span className="mp__person mp__person--quiet">
            <Avatar {...AIKO} size="1.5rem" />
            <span>Aiko</span>
            <span className="mp__role">commenter</span>
          </span>
          <span className="mp__person">
            <Avatar {...YOU} size="1.5rem" />
            <span>You</span>
          </span>
        </div>
        <button
          type="button"
          className="mp__follow"
          aria-pressed={following}
          onClick={() => setFollowing((v) => !v)}
        >
          <Eye size="1em" aria-hidden="true" />
          {following ? 'Following Maya · stop' : 'Follow Maya'}
        </button>
      </div>

      <div
        ref={stage}
        className="mp__stage"
        data-inside={inside}
        onPointerMove={onStageMove}
        onPointerEnter={() => setInside(true)}
        onPointerLeave={onStageLeave}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="mp__timeline">
          <div className="mp__ruler" aria-hidden="true">
            {[0, 4, 8, 12, 16].map((sec) => (
              <span key={sec} className="mono" style={{ left: pct(sec) }}>
                {timecode(sec).slice(3)}
              </span>
            ))}
            <span className="mp__pin" data-live={thread > 0 && thread < 3} style={{ left: pct(COMMENT_AT) }}>
              {thread === 3 ? (
                <Check size="0.7em" strokeWidth={3.5} />
              ) : (
                <MessageSquare size="0.65em" strokeWidth={2.6} />
              )}
            </span>
          </div>

          <div className="mp__lanes" ref={lanes}>
            <div className="mp-lane" data-label="V2">
              <div
                ref={mayaClip}
                className="mp-clip mp-clip--video"
                style={
                  {
                    left: pct(MAYA_CLIP.start),
                    width: pct(MAYA_CLIP.dur),
                    '--owner': MAYA.color,
                  } as CSSProperties
                }
              >
                <span className="mp-clip__strip" style={{ backgroundImage: 'var(--still-4)' }} />
                <span className="mp-clip__label">Drone_04.mov</span>
              </div>
            </div>
            <div className="mp-lane" data-label="V1">
              <div className="mp-clip mp-clip--video" style={{ left: pct(0), width: pct(7) }}>
                <span className="mp-clip__strip" style={{ backgroundImage: 'var(--still-0)' }} />
                <span className="mp-clip__label">Shore_A001.mov</span>
              </div>
              <div
                ref={jonasClip}
                className="mp-clip mp-clip--video"
                style={
                  {
                    left: pct(JONAS_CLIP.start),
                    width: pct(JONAS_CLIP.end - JONAS_CLIP.start),
                    '--owner': JONAS.color,
                  } as CSSProperties
                }
              >
                <span className="mp-clip__strip" style={{ backgroundImage: 'var(--still-2)' }} />
                <span className="mp-clip__label">Mist_A012.mov</span>
                <span className="mp-clip__edge" />
              </div>
              <div className="mp-clip mp-clip--video" style={{ left: pct(13), width: pct(7) }}>
                <span className="mp-clip__strip" style={{ backgroundImage: 'var(--still-3)' }} />
                <span className="mp-clip__label">Golden_B003.mov</span>
              </div>
            </div>
            <div className="mp-lane" data-label="A1" />

            {/* Clips the visitor can drag. They sit above the lanes so they can be real buttons. */}
            {USER_CLIPS.map((clip) => (
              <button
                key={clip.id}
                type="button"
                className={`mp-clip mp-clip--${clip.kind} mp-clip--yours`}
                data-lane={clip.lane}
                data-held={held === clip.id}
                style={{ left: pct(starts[clip.id]), width: pct(clip.dur) }}
                aria-label={`${clip.name}, starts at ${starts[clip.id].toFixed(2)} seconds. Drag, or use the left and right arrow keys, to move it.`}
                onPointerDown={(e) => onClipDown(e, clip.id)}
                onKeyDown={(e) => onClipKey(e, clip.id)}
              >
                {clip.kind === 'audio' && (
                  <Waveform className="mp-clip__wave" seed={clip.seed} bars={Math.round(clip.dur * 9)} />
                )}
                <span className="mp-clip__label">
                  {clip.kind === 'text' && <Type size="0.9em" strokeWidth={2.4} aria-hidden="true" />}
                  {clip.name}
                </span>
              </button>
            ))}

            <div
              className="mp__snap"
              data-on={snapAt !== null}
              style={{ left: pct(snapAt ?? SNAP_POINTS[0]) }}
              aria-hidden="true"
            />

            <div
              ref={mayaHead}
              className="mp-head"
              style={{ '--head': MAYA.color } as CSSProperties}
              aria-hidden="true"
            >
              <span className="mp-head__flag">M</span>
            </div>
            <div
              ref={youHead}
              className="mp-head mp-head--you"
              style={{ '--head': YOU.color } as CSSProperties}
              aria-hidden="true"
            >
              <span className="mp-head__flag mono" ref={youHeadLabel}>
                00:09:00
              </span>
            </div>
          </div>
        </div>

        {/* Time-coded comments, in a side panel so they never cover the clips you can drag. */}
        <aside className="mp-comments" aria-hidden="true">
          <p className="mp-comments__head">
            <MessageSquare size="0.95em" />
            Comments
            <span className="mp-comments__count mono">
              {thread === 0 ? '0 open' : thread === 3 ? 'resolved' : '1 open'}
            </span>
          </p>
          <AnimatePresence mode="popLayout">
            {thread > 0 ? (
              <motion.div
                key="thread"
                className="mp-thread"
                initial={{ opacity: 0, y: 10, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="mp-thread__msg">
                  <Avatar {...AIKO} size="1.375rem" />
                  <p>
                    <span className="mp-thread__who">
                      Aiko <span className="mono">{timecode(COMMENT_AT).slice(3)}</span>
                    </span>
                    Can this shot end a second sooner?
                  </p>
                </div>
                <AnimatePresence initial={false}>
                  {thread >= 2 && (
                    <motion.div
                      className="mp-thread__msg"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <Avatar {...JONAS} size="1.375rem" />
                      <p>
                        <span className="mp-thread__who">Jonas</span>
                        Trimmed. Have a look.
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="mp-thread__foot" data-resolved={thread === 3}>
                  {thread === 3 ? (
                    <>
                      <Check size="1em" strokeWidth={3} /> Resolved
                    </>
                  ) : thread === 1 ? (
                    <>
                      <span className="mp-thread__typing">
                        <i />
                        <i />
                        <i />
                      </span>
                      Jonas is replying
                    </>
                  ) : (
                    'Reply…'
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.p
                key="empty"
                className="mp-comments__empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                Nothing open. Comments are pinned to a frame on the timeline.
              </motion.p>
            )}
          </AnimatePresence>
        </aside>

        <Cursor ref={mayaCursor} {...MAYA} />
        <Cursor ref={jonasCursor} {...JONAS} />
        <Cursor ref={youCursor} {...YOU} className="mp__you" down={held !== null} />
      </div>
    </div>
  );
}
