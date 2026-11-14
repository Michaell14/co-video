import {
  ArrowDownUp,
  AudioLines,
  ChevronsLeftRight,
  Eye,
  EyeOff,
  Film,
  Flag,
  FlagTriangleRight,
  Hand,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  Mic,
  MousePointer2,
  MoveHorizontal,
  Plus,
  Scissors,
  SquareSplitHorizontal,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  clamp,
  editPoints,
  formatTimecode,
  framesToSeconds,
  MARKER_COLORS,
  moveTrack,
  sequenceEnd,
  snapTo,
  tracksOf,
  type ID,
  type Marker,
  type Project,
  type Track,
} from '@tandem/core';
import {
  useComments,
  useLiveProject,
  usePeers,
  usePlayer,
  usePlayerState,
  useProject,
  useSession,
} from '../../session/hooks';
import { cmd, getTimelineWidth, setTimelineWidth } from '../../state/commands';
import { beginGesture, commit } from '../../state/props';
import { shortcutOf } from '../../state/shortcuts';
import { clampPpf, MAX_PPF, MIN_PPF, useUI } from '../../state/ui';
import {
  IconButton,
  openContextMenu,
  Popover,
  Slider,
  TextField,
  tip,
  Button,
  cx,
  hideTip,
} from '../../ui/core';
import { editEntry, useCanEdit } from './access';
import { canvasTheme } from './canvasTheme';
import { EdgeScroller, timeAxis } from './edgeScroll';
import { Lanes } from './Lanes';
import { HEADER_W, LABEL_H, LABEL_TINT, layoutLanes, RULER_H, tickInterval, type Lane } from './layout';
import { meterFall, watchLevels } from './levels';
import { LostClips } from './LostClips';
import './timeline.css';

/** The layout constants the stylesheet needs as well, handed to it as custom properties. */
const LAYOUT_VARS = {
  '--tl-header-w': `${HEADER_W}px`,
  '--tl-label-h': `${LABEL_H}px`,
  '--tl-label-tint': `${LABEL_TINT * 100}%`,
} as React.CSSProperties;

/**
 * The timeline. A drag in the lanes shows a new project with every move of the pointer, and each
 * of those renders this component. What it draws besides the lanes is therefore memoised and given
 * only the parts of the project it shows, which a drag leaves as they are; and nothing here reads
 * the zoom or the scroll position, which the parts that need them follow by themselves.
 */
export function Timeline() {
  const player = usePlayer();
  const live = useLiveProject((p) => p);
  const set = useUI((s) => s.set);
  const bodyRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const editable = useCanEdit();
  /**
   * How high a track is drawn is part of the project. Someone who may not change the project still
   * sets the lanes to the height they want to look at: for themselves, while the project is open.
   */
  const [ownHeights, setOwnHeights] = useState<Readonly<Record<ID, number>>>({});
  const setOwnHeight = useCallback(
    (id: ID, h: number) => setOwnHeights((all) => (all[id] === h ? all : { ...all, [id]: h })),
    [],
  );
  const heights = editable ? null : ownHeights;
  const { lanes, height } = useMemo(() => layoutLanes(live, heights), [live.tracks, heights]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = sequenceEnd(live);
  const fitted = useRef(false);

  useLayoutEffect(() => {
    const el = areaRef.current!;
    const measure = () => {
      const w = Math.max(100, el.clientWidth);
      setWidth(w);
      setTimelineWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Open with the whole sequence in view.
  useEffect(() => {
    if (fitted.current || width <= 100) return;
    fitted.current = true;
    cmd.zoomFit();
  }, [width]);

  // Wheel: ctrl/⌘ zooms around the pointer, shift (or a sideways swipe) scrolls time.
  useEffect(() => {
    const el = mainRef.current!;
    const onWheel = (e: WheelEvent) => {
      const { scrollX: sx } = useUI.getState();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        const r = areaRef.current!.getBoundingClientRect();
        // Pinch gestures arrive as small ctrl+wheel deltas; mouse wheels as large ones.
        const factor = Math.exp(
          -e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 40 ? 0.02 : 0.004),
        );
        cmd.zoom(factor, Math.max(0, e.clientX - r.left));
        return;
      }
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      const body = bodyRef.current!;
      const canScrollY = body.scrollHeight > body.clientHeight + 1;
      if (horizontal || !canScrollY) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        set({ scrollX: Math.max(0, sx + d) });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [set]);

  // Keep the playhead on screen during playback by paging the view.
  useEffect(() => {
    if (!player) return;
    return player.onFrame((f) => {
      if (!player.getState().playing) return;
      const { ppf: z, scrollX: sx } = useUI.getState();
      const x = f * z - sx;
      if (x > width - 24 || x < 0) set({ scrollX: Math.max(0, f * z - 48) });
    });
  }, [player, width, set]);

  return (
    <div className="tl" style={LAYOUT_VARS}>
      <Toolbar />
      <div className="tl__main" ref={mainRef}>
        <div className="tl__corner" style={{ width: HEADER_W, height: RULER_H }}>
          <TrackAdder />
        </div>
        <div className="tl__area" ref={areaRef}>
          <Ruler width={width} settings={live.settings} markers={live.markers} />
        </div>
        <div className="tl__body" ref={bodyRef}>
          <div className="tl__headers" style={{ width: HEADER_W, height }}>
            {lanes.map((lane) => (
              <TrackHeader key={lane.track.id} lane={lane} onOwnHeight={setOwnHeight} />
            ))}
          </div>
          <div className="tl__lanes">
            <Lanes lanes={lanes} height={height} width={width} live={live} />
          </div>
        </div>
        <Playhead left={HEADER_W} width={width} />
        <RemotePlayheads left={HEADER_W} width={width} />
        {end === 0 && Object.keys(live.assets).length === 0 && (
          <div className="tl__hint">
            <Film />
            <b>Your timeline is empty</b>
            <span>
              Import media, then drag it here — or press <kbd className="kbd">T</kbd> to start with a title.
            </span>
          </div>
        )}
        <LostClips />
      </div>
      <Scrollbar width={width} end={end} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── toolbar ──

/** How much of the sequence a zoom shows, in words: what the zoom slider's value amounts to. */
function inView(frames: number, settings: Project['settings']): string {
  const seconds = framesToSeconds(frames, settings);
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} in view`;
  if (seconds < 1) return count(Math.max(1, Math.round(frames)), 'frame');
  return seconds < 90 ? count(Math.round(seconds), 'second') : count(Math.round(seconds / 60), 'minute');
}

const Toolbar = memo(function Toolbar() {
  const editable = useCanEdit();
  const tool = useUI((s) => s.tool);
  const snapping = useUI((s) => s.snapping);
  const ripple = useUI((s) => s.rippleMode);
  const markersFollow = useUI((s) => s.markersFollow);
  const linked = useUI((s) => s.linkedSelection);
  const ppf = useUI((s) => s.ppf);
  const hasSel = useUI((s) => s.selection.length > 0 || !!s.selectedTransition);
  const set = useUI((s) => s.set);
  const settings = useProject((p) => p.settings);
  const lo = Math.log(MIN_PPF);
  const hi = Math.log(MAX_PPF);
  // A tool that edits is put down when the access to edit goes: it would do nothing in the lanes.
  useEffect(() => {
    if (!editable && (tool === 'blade' || tool === 'slip')) set({ tool: 'select' });
  }, [editable, tool, set]);
  return (
    <div className="tl__toolbar">
      <div className="tl__tools">
        <IconButton
          label="Selection tool"
          keys="v"
          tipPlace="top"
          active={tool === 'select'}
          onClick={() => set({ tool: 'select' })}
        >
          <MousePointer2 />
        </IconButton>
        <IconButton
          label="Blade tool"
          keys="b"
          tipPlace="top"
          active={tool === 'blade'}
          disabled={!editable}
          onClick={() => set({ tool: 'blade' })}
        >
          <Scissors />
        </IconButton>
        <IconButton
          label="Slip tool"
          keys="y"
          tipPlace="top"
          active={tool === 'slip'}
          disabled={!editable}
          onClick={() => set({ tool: 'slip' })}
        >
          <MoveHorizontal />
        </IconButton>
        <IconButton
          label="Hand tool"
          keys="h"
          tipPlace="top"
          active={tool === 'hand'}
          onClick={() => set({ tool: 'hand' })}
        >
          <Hand />
        </IconButton>
      </div>
      <div className="topbar__sep" />
      <IconButton
        label="Split at playhead"
        keys="mod+b"
        tipPlace="top"
        disabled={!editable}
        onClick={() => cmd.split()}
      >
        <SquareSplitHorizontal />
      </IconButton>
      <IconButton
        label="Delete"
        keys="delete"
        tipPlace="top"
        disabled={!editable || !hasSel}
        onClick={() => cmd.delete(false)}
      >
        <Trash2 />
      </IconButton>
      <IconButton
        label="Ripple delete"
        keys="shift+delete"
        tipPlace="top"
        disabled={!editable || !hasSel}
        onClick={() => cmd.delete(true)}
      >
        <ChevronsLeftRight />
      </IconButton>
      <div className="topbar__sep" />
      <IconButton
        label="Snapping"
        keys="n"
        tipPlace="top"
        active={snapping}
        onClick={() => set({ snapping: !snapping })}
      >
        <Magnet />
      </IconButton>
      <IconButton
        label="Ripple editing"
        keys="r"
        tipPlace="top"
        active={ripple}
        disabled={!editable}
        onClick={() => set({ rippleMode: !ripple })}
      >
        <ArrowDownUp style={{ transform: 'rotate(90deg)' }} />
      </IconButton>
      <IconButton
        label="Markers follow ripple edits"
        tipPlace="top"
        active={markersFollow}
        disabled={!editable}
        onClick={() => set({ markersFollow: !markersFollow })}
      >
        <FlagTriangleRight />
      </IconButton>
      <IconButton
        label="Linked selection"
        keys="mod+shift+l"
        tipPlace="top"
        active={linked}
        onClick={() => set({ linkedSelection: !linked })}
      >
        <Link2 />
      </IconButton>
      <div className="topbar__sep" />
      <IconButton
        label="Add marker"
        keys="m"
        tipPlace="top"
        disabled={!editable}
        onClick={() => cmd.addMarker()}
      >
        <Flag />
      </IconButton>
      <IconButton
        label="Add text"
        keys="t"
        tipPlace="top"
        disabled={!editable}
        onClick={() => cmd.addTitle()}
      >
        <Type />
      </IconButton>
      <VoiceoverButton editable={editable} />
      <div style={{ flex: 1 }} />
      <IconButton label="Zoom out" keys="minus" tipPlace="top" onClick={() => cmd.zoom(1 / 1.4)}>
        <ZoomOut />
      </IconButton>
      <div style={{ width: 110, display: 'flex' }}>
        <Slider
          value={Math.log(ppf)}
          min={lo}
          max={hi}
          ariaLabel="Timeline zoom"
          valueText={(v) => inView(getTimelineWidth() / Math.exp(v), settings)}
          onChange={(v) => {
            const cur = useUI.getState().ppf;
            cmd.zoom(clampPpf(Math.exp(v)) / cur);
          }}
        />
      </div>
      <IconButton label="Zoom in" keys="equal" tipPlace="top" onClick={() => cmd.zoom(1.4)}>
        <ZoomIn />
      </IconButton>
      <IconButton label="Fit timeline" keys="shift+z" tipPlace="top" onClick={() => cmd.zoomFit()}>
        <Maximize2 />
      </IconButton>
    </div>
  );
});

const TrackAdder = memo(function TrackAdder() {
  const editable = useCanEdit();
  return (
    <div className="tl__adder">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label="Add video track"
        disabled={!editable}
        onClick={() => cmd.addTrack('video')}
        {...tip('Add video track')}
      >
        <Plus />
        <Film />
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        aria-label="Add audio track"
        disabled={!editable}
        onClick={() => cmd.addTrack('audio')}
        {...tip('Add audio track')}
      >
        <Plus />
        <AudioLines />
      </button>
    </div>
  );
});

// ─────────────────────────────────────────────────────────────── ruler ──

interface RulerProps {
  width: number;
  settings: Project['settings'];
  markers: Project['markers'];
}

const Ruler = memo(function Ruler({ width, settings, markers: markerMap }: RulerProps) {
  const session = useSession();
  const editable = useCanEdit();
  const player = usePlayer();
  const range = usePlayerState().range;
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const comments = useComments();
  const [editing, setEditing] = useState<{ marker: Marker; rect: DOMRect } | null>(null);
  const scrub = useRef<
    | { kind: 'seek' }
    | { kind: 'marker'; id: string; x0: number; moved: boolean }
    | { kind: 'range'; edge: 'in' | 'out' }
    | null
  >(null);
  /** Where the pointer last was during the scrub in progress. */
  const pointer = useRef<{ clientX: number; shiftKey: boolean } | null>(null);
  /**
   * The marker under the last press. The ruler holds the pointer from the press on, so the click
   * and double-click that follow are aimed at the ruler itself and no longer say which marker.
   */
  const pressed = useRef<string | null>(null);
  /** Runs the scrub in progress again where the pointer last was. */
  const rerun = useRef<() => void>(() => {});
  const fps = settings.fpsNum / settings.fpsDen;

  const scroller = useMemo(
    () =>
      new EdgeScroller(
        [
          timeAxis(
            () => rulerRef.current,
            () => session.store.get(),
          ),
        ],
        () => rerun.current(),
      ),
    [session],
  );
  useEffect(() => () => scroller.stop(), [scroller]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(RULER_H * dpr);
    const ctx = canvas.getContext('2d')!;
    const theme = canvasTheme(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, RULER_H);
    const { major, minor } = tickInterval(ppf, fps);
    const step = major / minor;
    const first = Math.floor(scrollX / ppf / major) * major;
    const last = (scrollX + width) / ppf;
    ctx.font = '500 10px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.textBaseline = 'top';
    for (let f = first; f <= last; f += major) {
      for (let k = 0; k < minor; k++) {
        const x = Math.round((f + k * step) * ppf - scrollX) + 0.5;
        if (x < -1 || x > width + 1) continue;
        ctx.strokeStyle = k === 0 ? theme.tick : theme.tickMinor;
        ctx.beginPath();
        ctx.moveTo(x, k === 0 ? RULER_H - 11 : RULER_H - 5);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
      }
      const x = f * ppf - scrollX;
      if (x > -80 && x < width) {
        ctx.fillStyle = theme.rulerLabel;
        ctx.fillText(formatTimecode(f, settings), x + 4, 5);
      }
    }
  }, [width, ppf, scrollX, fps, settings]);

  const frameAt = (clientX: number, snapEdits: boolean): number => {
    const r = canvasRef.current!.getBoundingClientRect();
    let f = Math.max(0, Math.round((clientX - r.left + useUI.getState().scrollX) / useUI.getState().ppf));
    if (snapEdits && useUI.getState().snapping) {
      // The project as it is when the pointer asks: this component is not drawn again for clips.
      const project = session.store.get();
      const pts = [...editPoints(project), ...Object.values(project.markers).map((m) => m.frame)].sort(
        (a, b) => a - b,
      );
      const s = snapTo(f, pts, 6 / useUI.getState().ppf);
      if (s !== null) f = s;
    }
    return f;
  };

  /** Carry the scrub in progress to where the pointer is. */
  const scrubTo = (at: { clientX: number; shiftKey: boolean }) => {
    const s = scrub.current;
    if (!s) return;
    if (s.kind === 'seek') cmd.seek(frameAt(at.clientX, !at.shiftKey), false);
    else if (s.kind === 'marker' && session.canEdit) {
      // A press that barely moves is a click (or half a double-click), not a drag.
      if (!s.moved && Math.abs(at.clientX - s.x0) < 3) return;
      const m = session.store.get().markers[s.id];
      const f = frameAt(at.clientX, false);
      if (m && m.frame !== f) {
        if (!s.moved) session.store.beginGesture();
        s.moved = true;
        commit([{ op: 'setMarker', marker: { ...m, frame: f } }], true);
      }
    } else if (s.kind === 'range' && player) {
      const now = player.getState().range;
      if (!now) return;
      const f = frameAt(at.clientX, true);
      player.setRange(
        s.edge === 'in'
          ? { in: Math.min(f, now.out - 1), out: now.out }
          : { in: now.in, out: Math.max(f, now.in + 1) },
      );
    }
  };
  rerun.current = () => {
    if (pointer.current) scrubTo(pointer.current);
  };
  const endScrub = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    scrub.current = null;
    pointer.current = null;
    scroller.stop();
  };

  const editMarker = (id: string) => {
    const marker = session.store.get().markers[id];
    const el = Array.from(rulerRef.current?.querySelectorAll<HTMLElement>('[data-marker]') ?? []).find(
      (m) => m.dataset.marker === id,
    );
    if (!marker || !el || !session.canEdit) return;
    // The marker's tooltip would name it as it was before the edit, right over the editor.
    hideTip();
    setEditing({ marker, rect: el.getBoundingClientRect() });
  };

  const markers = Object.values(markerMap);
  return (
    <div
      ref={rulerRef}
      className="ruler"
      data-readonly={!editable || undefined}
      style={{ height: RULER_H }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const el = e.target as HTMLElement;
        e.currentTarget.setPointerCapture(e.pointerId);
        const mk = el.closest<HTMLElement>('[data-marker]')?.dataset.marker;
        const edge = el.closest<HTMLElement>('[data-range]')?.dataset.range as 'in' | 'out' | undefined;
        pressed.current = mk ?? null;
        if (mk) {
          scrub.current = { kind: 'marker', id: mk, x0: e.clientX, moved: false };
          cmd.seek(markerMap[mk].frame, false);
        } else if (edge) scrub.current = { kind: 'range', edge };
        else {
          scrub.current = { kind: 'seek' };
          if (player?.getState().playing) player.pause();
          cmd.seek(frameAt(e.clientX, !e.shiftKey), false);
        }
      }}
      onPointerMove={(e) => {
        if (!scrub.current) return;
        pointer.current = { clientX: e.clientX, shiftKey: e.shiftKey };
        scrubTo(pointer.current);
        scroller.track(e.clientX);
      }}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
      onDoubleClick={() => {
        if (pressed.current) editMarker(pressed.current);
      }}
      onContextMenu={(e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-marker]')?.dataset.marker;
        const marker = id ? markerMap[id] : undefined;
        // Snapped like a click on the ruler, unless that lands on a marker that is already there.
        const snapped = frameAt(e.clientX, true);
        const at = markers.some((m) => m.frame === snapped) ? frameAt(e.clientX, false) : snapped;
        // A range is marked to play it or to go to its ends, which anyone may. The rest changes
        // the project.
        const edit = editEntry(session.canEdit);
        openContextMenu(e, [
          marker ? edit({ label: 'Edit marker…', onSelect: () => editMarker(marker.id) }) : null,
          edit(
            marker
              ? {
                  label: 'Delete marker',
                  danger: true,
                  onSelect: () => commit([{ op: 'removeMarker', id: marker.id }]),
                }
              : { label: 'Add marker here', onSelect: () => cmd.addMarker(at) },
          ),
          'separator',
          { label: 'Mark in', keys: shortcutOf('mark-in'), onSelect: () => cmd.markIn() },
          { label: 'Mark out', keys: shortcutOf('mark-out'), onSelect: () => cmd.markOut() },
          { label: 'Mark clip', keys: shortcutOf('mark-clip'), onSelect: () => cmd.markClip() },
          {
            label: 'Clear in / out',
            keys: shortcutOf('clear-range'),
            onSelect: () => cmd.clearRange(),
            disabled: !range,
          },
          { label: 'Go to in', keys: shortcutOf('go-in'), onSelect: () => cmd.goToRange('in') },
          { label: 'Go to out', keys: shortcutOf('go-out'), onSelect: () => cmd.goToRange('out') },
          'separator',
          edit({
            label: 'Add default transition',
            keys: shortcutOf('default-transition'),
            onSelect: () => cmd.addDefaultTransition(),
          }),
          edit({
            label: 'Extend edit to playhead',
            keys: shortcutOf('extend-edit'),
            onSelect: () => cmd.extendEdit(),
          }),
        ]);
      }}
    >
      <canvas ref={canvasRef} style={{ width, height: RULER_H }} />
      {range && (
        <div
          className="ruler__range"
          style={{ left: range.in * ppf - scrollX, width: Math.max(2, (range.out - range.in) * ppf) }}
        >
          <i data-range="in" />
          <i data-range="out" />
        </div>
      )}
      {markers.map((m) => (
        <button
          key={m.id}
          type="button"
          className="marker"
          data-marker={m.id}
          aria-label={`Marker ${m.name}, ${formatTimecode(m.frame, settings)}${m.note ? `: ${m.note}` : ''}`}
          style={{ left: m.frame * ppf - scrollX, ['--c' as string]: m.color }}
          {...(editing?.marker.id === m.id
            ? {}
            : tip(m.note ? `${m.name} — ${m.note}` : m.name, undefined, 'top'))}
          onClick={(e) => {
            // A press of the pointer is the ruler's (it seeks, drags, and edits on the second
            // press), so only a click that no pointer made is acted on here: Enter or Space.
            if (e.detail !== 0) return;
            cmd.seek(m.frame);
            editMarker(m.id);
          }}
        >
          <svg viewBox="0 0 10 12" width="10" height="12" aria-hidden>
            <path d="M1 1h8v7L5 11 1 8z" fill="var(--c)" stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
          </svg>
        </button>
      ))}
      {comments
        .filter((c) => !c.resolved)
        .map((c) => (
          <button
            key={c.id}
            type="button"
            className="ruler__comment"
            aria-label={`Comment by ${c.authorName} at ${formatTimecode(c.frame, settings)}`}
            style={{ left: c.frame * ppf - scrollX, background: c.authorColor }}
            {...tip(`${c.authorName}: ${c.text.slice(0, 80)}`, undefined, 'top')}
            onPointerDown={(e) => {
              hideTip();
              e.stopPropagation();
            }}
            onClick={() => {
              cmd.seek(c.frame, false);
              useUI.getState().set({ commentsOpen: true });
            }}
          />
        ))}
      {editing && (
        <MarkerEditor marker={editing.marker} rect={editing.rect} onClose={() => setEditing(null)} />
      )}
    </div>
  );
});

/** What the marker colours are called, in the order of `MARKER_COLORS`. */
const MARKER_COLOR_NAMES = ['Amber', 'Red', 'Green', 'Blue', 'Purple', 'Pink', 'White'];

function MarkerEditor({ marker, rect, onClose }: { marker: Marker; rect: DOMRect; onClose: () => void }) {
  const session = useSession();
  const m = useProject((p) => p.markers[marker.id]) ?? marker;
  /**
   * Typing is one undo step for each visit to a field, as in the inspector's text fields: `typed`
   * joins a change to the step that the visit began. A colour is a step of its own.
   */
  const update = (patch: Partial<Marker>, typed = false) => {
    // Someone else may have deleted the marker while this was open: there is nothing left to edit.
    const current = session.store.get().markers[marker.id];
    if (current) commit([{ op: 'setMarker', marker: { ...current, ...patch } }], typed);
  };
  // The name field has the keyboard as the editor opens, but through the popover, which takes the
  // focus itself first: a step that began only on focus could be missed, and the first letter
  // typed would then join the step before it, which is usually the one that made the marker.
  useEffect(() => beginGesture(), []);
  return (
    <Popover anchor={rect} onClose={onClose} style={{ width: 240, padding: 8 }}>
      <div
        className="marker-ed"
        onKeyDownCapture={(e) => {
          // Enter in the name closes the editor, and focus is back on the marker before the key
          // has had its own effect, which on a button is to press it: the editor would open again.
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
        }}
      >
        <TextField
          value={m.name}
          onChange={(name) => update({ name }, true)}
          onFocus={beginGesture}
          autoFocus
          ariaLabel="Marker name"
          onEnter={onClose}
        />
        <TextField
          value={m.note}
          onChange={(note) => update({ note }, true)}
          onFocus={beginGesture}
          multiline
          rows={2}
          placeholder="Note"
          ariaLabel="Marker note"
        />
        <div className="marker-ed__foot">
          <div className="marker-ed__colors" role="radiogroup" aria-label="Marker colour">
            {MARKER_COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                className="menu-swatch"
                role="radio"
                aria-checked={m.color === c}
                aria-label={`Colour ${c}`}
                onClick={() => update({ color: c })}
                style={{ background: c }}
                {...tip(MARKER_COLOR_NAMES[i] ?? c)}
              />
            ))}
          </div>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              commit([{ op: 'removeMarker', id: marker.id }]);
              onClose();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Popover>
  );
}

// ──────────────────────────────────────────────────────────── playhead ──

const Playhead = memo(function Playhead({ left, width }: { left: number; width: number }) {
  const player = usePlayer();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!player) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const { ppf, scrollX } = useUI.getState();
      const x = Math.floor(player.getFrame()) * ppf - scrollX;
      el.style.transform = `translate3d(${left + x}px, 0, 0)`;
      el.style.visibility = x < -1 || x > width + 1 ? 'hidden' : 'visible';
    };
    place();
    const offFrame = player.onFrame(place);
    const offUi = useUI.subscribe((s, p) => {
      if (s.ppf !== p.ppf || s.scrollX !== p.scrollX) place();
    });
    return () => {
      offFrame();
      offUi();
    };
  }, [player, left, width]);
  return (
    <div ref={ref} className="playhead">
      <svg viewBox="0 0 13 14" width="13" height="14">
        <path d="M1 1h11v7.500L6.500 13 1 8.500z" />
      </svg>
    </div>
  );
});

const RemotePlayheads = memo(function RemotePlayheads({ left, width }: { left: number; width: number }) {
  const peers = usePeers();
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const following = useUI((s) => s.following);
  return (
    <>
      {peers.map((p) => {
        const x = p.playhead * ppf - scrollX;
        if (x < 0 || x > width) return null;
        return (
          <div
            key={p.clientId}
            className="playhead playhead--peer"
            data-following={following === p.clientId}
            style={{ transform: `translate3d(${left + x}px, 0, 0)`, ['--c' as string]: p.user.color }}
          >
            <span>{p.user.name}</span>
          </div>
        );
      })}
    </>
  );
});

// ────────────────────────────────────────────────────────────── headers ──

interface TrackHeaderProps {
  lane: Lane;
  /** Sets the height the track is drawn at for someone who cannot change the track itself. */
  onOwnHeight: (id: ID, height: number) => void;
}

const TrackHeader = memo(function TrackHeader({ lane, onOwnHeight }: TrackHeaderProps) {
  const session = useSession();
  const editable = useCanEdit();
  const player = usePlayer();
  const t = lane.track;
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Escape was pressed in the rename field: the blur that follows must not store what was typed. */
  const discard = useRef(false);
  const meter = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<Track>) => commit([{ op: 'updateTrack', id: t.id, patch }]);
  const label = lane.label;
  const resize = useRef<{ y: number; h: number } | null>(null);
  const nameTip = tip(t.name);
  const name = useRef<HTMLSpanElement>(null);
  /**
   * The name is a stop for Tab: the header is too narrow to show all of it. A name the keyboard is
   * on stays one until the keyboard leaves, whatever the name becomes meanwhile: a stop taken away
   * from under the keyboard drops it to the page.
   */
  const [stop, setStop] = useState(false);
  const named = renaming === null;
  const measure = useCallback(() => {
    const el = name.current;
    setStop(!!el && (el.scrollWidth > el.clientWidth || el === document.activeElement));
  }, []);
  useLayoutEffect(() => {
    measure();
    // The name is as wide as its typeface makes it, and that can arrive after the header.
    document.fonts.addEventListener('loadingdone', measure);
    return () => document.fonts.removeEventListener('loadingdone', measure);
  }, [measure, t.name, label, named]);
  // The tip quotes the name: left up while the name changes under it, it would show the old one.
  useLayoutEffect(() => {
    const el = name.current;
    if (el && (el === document.activeElement || el.matches(':hover'))) hideTip();
  }, [t.name]);
  /** Shows the whole name, where the header is too narrow for it, and nothing otherwise. */
  const whenCut =
    <E extends React.SyntheticEvent>(show: (e: E) => void) =>
    (e: E) => {
      if (e.currentTarget.scrollWidth > e.currentTarget.clientWidth) show(e);
    };

  // Live level meter for audio tracks.
  useEffect(() => {
    if (t.kind !== 'audio' || !player) return;
    let shown = 0;
    return watchLevels(player, (levels, elapsed) => {
      shown = meterFall(shown, levels.tracks[t.id] ?? 0, elapsed);
      const db = shown > 0.0005 ? 20 * Math.log10(shown) : -60;
      if (meter.current) meter.current.style.transform = `scaleX(${clamp((db + 48) / 48, 0, 1)})`;
    });
  }, [player, t.id, t.kind]);

  return (
    <div
      className="th"
      data-kind={t.kind}
      data-locked={t.locked}
      style={{ top: lane.top, height: lane.height }}
      onContextMenu={(e) => {
        // The header is drawn again only when its own track changes, so what the menu offers is
        // worked out from the project as it is when the menu is asked for.
        const project = session.store.get();
        const list = tracksOf(project)[t.kind];
        const idx = list.findIndex((x) => x.id === t.id);
        // Picture tracks stack upwards and sound tracks are listed downwards.
        const [up, down] = t.kind === 'video' ? ([1, -1] as const) : ([-1, 1] as const);
        const move = (dir: 1 | -1) => commit(moveTrack(session.store.get(), t.id, dir));
        const edit = editEntry(session.canEdit);
        openContextMenu(e, [
          edit({ label: 'Rename', onSelect: () => setRenaming(t.name || label) }),
          edit({
            label: 'Move up',
            disabled: !list[idx + up],
            onSelect: () => move(up),
          }),
          edit({
            label: 'Move down',
            disabled: !list[idx + down],
            onSelect: () => move(down),
          }),
          'separator',
          edit({ label: 'Add video track', onSelect: () => cmd.addTrack('video') }),
          edit({ label: 'Add audio track', onSelect: () => cmd.addTrack('audio') }),
          t.kind === 'video' && 'separator',
          t.kind === 'video' && {
            label: 'Export captions from this track',
            onSelect: () => cmd.exportSubtitles(t.id),
          },
          'separator',
          edit({
            label: 'Delete track',
            danger: true,
            disabled: list.length <= 1,
            onSelect: () => cmd.removeTrack(t.id),
          }),
        ]);
      }}
    >
      <div className="th__row">
        <span className="th__tag mono">{label}</span>
        {renaming !== null ? (
          <input
            className="th__rename"
            autoFocus
            aria-label="Track name"
            value={renaming}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => {
              if (!discard.current && renaming !== (t.name || label))
                update({ name: renaming.trim() === label ? '' : renaming.trim() });
              discard.current = false;
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') discard.current = true;
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLElement).blur();
            }}
          />
        ) : (
          <span
            ref={name}
            className="th__name"
            // A name that is cut off is a stop for Tab: the keyboard asks for the rest by resting
            // there, as the pointer does.
            tabIndex={stop ? 0 : undefined}
            onBlur={measure}
            onDoubleClick={() => session.canEdit && setRenaming(t.name || label)}
            {...nameTip}
            onPointerEnter={whenCut(nameTip.onPointerEnter)}
            onFocusCapture={whenCut(nameTip.onFocusCapture)}
          >
            {t.name}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {t.kind === 'video' ? (
          <IconButton
            small
            label={t.hidden ? 'Show track' : 'Hide track'}
            active={t.hidden}
            disabled={!editable}
            onClick={() => update({ hidden: !t.hidden })}
          >
            {t.hidden ? <EyeOff /> : <Eye />}
          </IconButton>
        ) : (
          <>
            <IconButton
              small
              label={t.muted ? 'Unmute track' : 'Mute track'}
              active={t.muted}
              className={cx(t.muted && 'th__mute--on')}
              disabled={!editable}
              onClick={() => update({ muted: !t.muted })}
            >
              {t.muted ? <VolumeX /> : <Volume2 />}
            </IconButton>
            <button
              type="button"
              className={cx('th__solo', t.solo && 'th__solo--on')}
              disabled={!editable}
              onClick={() => update({ solo: !t.solo })}
              aria-label="Solo track"
              aria-pressed={t.solo}
              {...tip('Solo track')}
            >
              S
            </button>
          </>
        )}
        <IconButton
          small
          label={t.locked ? 'Unlock track' : 'Lock track'}
          active={t.locked}
          disabled={!editable}
          onClick={() => update({ locked: !t.locked })}
        >
          {t.locked ? <Lock /> : <LockOpen />}
        </IconButton>
      </div>
      {t.kind === 'audio' && lane.height >= 40 && (
        <div className="th__meter">
          <div ref={meter} />
        </div>
      )}
      <div
        className="th__resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          resize.current = { y: e.clientY, h: lane.height };
          if (editable) session.store.beginGesture();
        }}
        onPointerMove={(e) => {
          if (!resize.current) return;
          const h = clamp(Math.round(resize.current.h + (e.clientY - resize.current.y)), 26, 220);
          if (editable) commit([{ op: 'updateTrack', id: t.id, patch: { height: h } }], true);
          else onOwnHeight(t.id, h);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          resize.current = null;
        }}
      />
    </div>
  );
});

// ──────────────────────────────────────────────────────────── scrollbar ──

const Scrollbar = memo(function Scrollbar({ width, end }: { width: number; end: number }) {
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const set = useUI((s) => s.set);
  const drag = useRef<{ x: number; scroll: number } | null>(null);
  // Leave half a screen of empty time past the last clip to drop things into.
  const total = Math.max(end * ppf + width * 0.5, scrollX + width);
  const thumbW = Math.max(28, (width / total) * width);
  const thumbX = (scrollX / Math.max(1, total - width)) * (width - thumbW);
  if (total <= width + 1) return <div className="tl__scroll" />;
  return (
    <div className="tl__scroll">
      <div style={{ width: HEADER_W, flex: 'none' }} />
      <div
        className="tl__scrolltrack"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          const ratio = clamp((e.clientX - r.left - thumbW / 2) / (width - thumbW), 0, 1);
          set({ scrollX: ratio * (total - width) });
        }}
      >
        <div
          className="tl__scrollthumb"
          style={{ width: thumbW, transform: `translateX(${Number.isFinite(thumbX) ? thumbX : 0}px)` }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, scroll: scrollX };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const dx = e.clientX - drag.current.x;
            set({
              scrollX: clamp(
                drag.current.scroll + (dx / (width - thumbW)) * (total - width),
                0,
                total - width,
              ),
            });
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            drag.current = null;
          }}
        />
      </div>
    </div>
  );
});

/** Starts and stops a voiceover take; while recording it shows the running time and input level. */
function VoiceoverButton({ editable }: { editable: boolean }) {
  const recording = useUI((s) => s.recording);
  const [, tick] = useState(0);
  const level = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => tick((n) => n + 1), 250);
    let raf = 0;
    const meter = () => {
      if (level.current)
        level.current.style.transform = `scaleX(${Math.min(1, cmd.voiceoverLevel() * 1.4).toFixed(3)})`;
      raf = requestAnimationFrame(meter);
    };
    raf = requestAnimationFrame(meter);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(raf);
    };
  }, [recording]);
  if (!recording) {
    return (
      <IconButton
        label="Record voiceover"
        keys="shift+r"
        tipPlace="top"
        disabled={!editable}
        onClick={() => void cmd.toggleVoiceover()}
      >
        <Mic />
      </IconButton>
    );
  }
  const secs = Math.floor((performance.now() - recording.startedAt) / 1000);
  return (
    <button
      className="rec"
      onClick={() => void cmd.toggleVoiceover()}
      aria-label="Stop recording"
      {...tip('Stop recording', 'shift+r', 'top')}
    >
      <span className="rec__dot" />
      <span className="mono">
        {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
      </span>
      <span className="rec__meter">
        <i ref={level} />
      </span>
    </button>
  );
}
