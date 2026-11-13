import {
  AudioLines,
  Blend,
  CircleAlert,
  FileWarning,
  Film,
  Gauge,
  Image as ImageIcon,
  Layers,
  Layers2,
  Link2,
  Shapes,
  Snowflake,
  Sparkles,
  Square,
  Type,
} from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  addAssetToTimeline,
  addGenerator,
  addTrack,
  adjacentPrev,
  applyEdits,
  clamp,
  CLIP_TYPE_COLORS,
  clipEnd,
  clipsOnTrack,
  cutTransitionWindow,
  LABEL_COLORS,
  maxTransitionDuration,
  neighbors,
  overlappingClips,
  placeClips,
  pasteClips,
  rippleCloseGap,
  rippleTrim,
  rollEdit,
  separateClips,
  slipClips,
  snapPoints,
  snapTo,
  splitClips,
  trackKindFor,
  trimClips,
  trimRange,
  withLinked,
  type Clip,
  type ClipType,
  type Edge,
  type Edit,
  type ID,
  type OpResult,
  type Project,
} from '@tandem/core';
import { usePeers, useProject, useSession, useSessionMeta } from '../../session/hooks';
import { cmd, effectiveSelection, revealFrame, withMarkers } from '../../state/commands';
import {
  edgeCuts,
  edgeRange,
  openGapAt,
  transitionTarget,
  trimSpans,
  type Cut,
  type RippleSpan,
} from '../../state/edits';
import { mediaAvailable } from '../../state/media';
import { commit } from '../../state/props';
import { shortcutOf, spaceOperates } from '../../state/shortcuts';
import { useUI } from '../../state/ui';
import { openContextMenu, toast, type MenuEntry } from '../../ui/core';
import { insideRect, onDrop, useDrag, type DragPayload } from '../../ui/dnd';
import { usingKeyboard } from '../../ui/layers';
import { describeClip, describeSelection } from './describe';
import { EdgeScroller, laneAxis, timeAxis } from './edgeScroll';
import { keyframeRange, keyframeTimes, moveKeyframes, removeKeyframes } from './keyframes';
import { drawLane } from './laneCanvas';
import {
  clipWidth,
  LABEL_MIN_W,
  LANE_GAP,
  laneAt,
  LANES_TAIL,
  layoutLanes,
  NARROW_W,
  type Lane,
} from './layout';
import { insertMove } from './moves';

const ICONS: Record<ClipType, typeof Film> = {
  video: Film,
  image: ImageIcon,
  audio: AudioLines,
  text: Type,
  shape: Shapes,
  solid: Square,
  adjustment: Layers,
};

/**
 * The nearest a fade handle at rest comes to its end of the clip, in CSS pixels. A clip without a
 * fade would have the handle on its very edge, half cut off and under the trim handle that is
 * there. While it is being dragged the handle is where the fade ends, wherever that is.
 */
const FADE_INSET = 12;
/** How far from its end of the clip the handle of a fade `length` pixels long is drawn. */
const fadeHandleAt = (length: number, dragged: boolean): number =>
  dragged ? length : Math.max(FADE_INSET, length);

type Drag =
  | {
      kind: 'move';
      ids: ID[];
      anchor: ID;
      f0: number;
      x0: number;
      y0: number;
      moved: boolean;
      reselect: boolean;
      /**
       * The track that dragging past the outermost lane opens. It is made once so its lane keeps
       * its identity, and is part of the plan only while the pointer is out there.
       */
      newTrack?: { edits: Edit[]; trackId: ID };
    }
  | {
      kind: 'trim';
      ids: ID[];
      edge: Edge;
      f0: number;
      restore: number;
      /**
       * The cuts a roll moves: the one that was taken hold of and, with linked selection on, the
       * cuts of its linked clips that lie at the same frame.
       */
      roll: Cut[] | null;
      ripple: boolean;
      /** Frames the edge is moved by as of the last pointer position, after limits and snapping. */
      delta: number;
      /** What the pointer alone asked for. */
      wanted: number;
    }
  | { kind: 'slip'; ids: ID[]; x0: number; restore: number; delta: number }
  | {
      kind: 'fade';
      id: ID;
      side: 'in' | 'out';
      f0: number;
      x0: number;
      /**
       * The length of fade, in frames, that the handle stood for where it was taken hold of. For
       * a fade shorter than `FADE_INSET` that is more than the fade itself.
       */
      from: number;
      moved: boolean;
    }
  | { kind: 'trans'; id: ID; side: 'in' | 'out'; f0: number; base: number }
  | {
      kind: 'keyframe';
      id: ID;
      /** Where the keyframes that are held stand now, in frames from the clip's start. */
      t: number;
      /** Where they stood when they were taken hold of, and the frame the pointer was at. */
      t0: number;
      f0: number;
      x0: number;
      moved: boolean;
    }
  | { kind: 'marquee'; x0: number; y0: number; keep: ID[]; moved: boolean; frame: number }
  | { kind: 'pan'; x0: number; scroll0: number };

interface Props {
  lanes: Lane[];
  height: number;
  width: number;
  live: Project;
}

/** What a drag reads from a pointer event, kept so the drag can be run again without one. */
interface Pointer {
  clientX: number;
  clientY: number;
  altKey: boolean;
  shiftKey: boolean;
  /** Ctrl or ⌘ is down: what is dropped goes in between the clips there instead of over them. */
  insert: boolean;
}

const pointerOf = (e: React.PointerEvent): Pointer => ({
  clientX: e.clientX,
  clientY: e.clientY,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
  insert: e.ctrlKey || e.metaKey,
});

/**
 * The modifier keys that are down, as the last key or pointer event anywhere in the window had
 * them. A drag from the library is run by the library and says only where the pointer is, and a
 * key pressed or let go while the pointer holds still changes what a drop will do all the same.
 */
const held = { alt: false, insert: false };
/** How many times a key or a pointer button has gone down: tells one press from the next. */
let presses = 0;
if (typeof window !== 'undefined') {
  const note = (e: KeyboardEvent | PointerEvent) => {
    held.alt = e.altKey;
    held.insert = e.ctrlKey || e.metaKey;
    if (e.type === 'keydown' || e.type === 'pointerdown') presses++;
  };
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup'] as const) {
    window.addEventListener(type, note, true);
  }
}

/**
 * How the view follows a drag that is held at its edge: not at all, along the time axis, or
 * through the lanes as well when there are more of them than fit.
 */
type Follow = 'none' | 'time' | 'both';

type DropHint = { clipId: ID; side: 'in' | 'out' | 'all' };

type AddTrack = Extract<Edit, { op: 'addTrack' }>;

/** Where something dragged in from the library would land. */
interface DropPlan {
  /** Every track this drag has opened so far, whether or not the plan still uses it. */
  tracks: AddTrack[];
  /** What to show and to commit: the clips and only the tracks they sit on. */
  edits: Edit[];
  select?: ID[];
  hint?: DropHint;
  line?: number | null;
  /** A track opened by this drag that holds all it would add, and so is worth scrolling to. */
  opened?: ID;
  /** The clip whose media the dropped file takes the place of, when the drop is that. */
  replace?: ID;
  /** What the drop does to time when it pushes clips along, for the markers that follow them. */
  spans?: RippleSpan[];
  /** What kind of drop this is, when it is not the plain one that overwrites. */
  mode?: string;
}

const isAddTrack = (e: Edit): e is AddTrack => e.op === 'addTrack';

/** Those of `cuts` that are still cuts in `p`: both clips are there and the one ends where the other begins. */
const standingCuts = (p: Project, cuts: Cut[]): Cut[] =>
  cuts.filter(([left, right]) => {
    const a = p.clips[left];
    const b = p.clips[right];
    return !!a && !!b && a.trackId === b.trackId && clipEnd(a) === b.start;
  });

export function Lanes({ lanes, height, width, live }: Props) {
  const session = useSession();
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const selection = useUI((s) => s.selection);
  const selectedTransition = useUI((s) => s.selectedTransition);
  const tool = useUI((s) => s.tool);
  const snapLine = useUI((s) => s.snapLine);
  const peers = usePeers();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /** Where the pointer last was during the drag in progress. */
  const pointer = useRef<Pointer | null>(null);
  /** Set while something from the library is dragged over the lanes: the tracks it has opened. */
  const drop = useRef<{ tracks: AddTrack[] } | null>(null);
  /** A track the drag in progress has opened and that should be in view. */
  const [opened, setOpened] = useState<ID | null>(null);
  /**
   * How far the body has been scrolled to show that track, and where it stood when last looked
   * at. The distance is kept rather than the place to go back to, so that scrolling the lanes by
   * wheel meanwhile counts: for what the pointer is over, and when the lanes go back.
   */
  const reveal = useRef<{ by: number; seen: number } | null>(null);
  /** Runs the drag in progress again where the pointer last was. */
  const rerun = useRef<() => void>(() => {});
  /** The line that shows where the blade would cut. It is placed by hand, on every pointer move. */
  const blade = useRef<HTMLDivElement>(null);
  /** Says beside the pointer what a drop will do when a modifier key makes it something else. */
  const modeTip = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  /** The fade handle that is held, and whether it has been taken anywhere yet. */
  const [fading, setFading] = useState<{ id: ID; side: 'in' | 'out'; moved: boolean } | null>(null);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const offline = useOfflineAssets(live.assets);
  useSyncExternalStore(session.thumbs.subscribeFaults, session.thumbs.getFaultsVersion);
  // Empty unless two people placed clips on the same frames at the same moment.
  const overlapping = useMemo(() => overlappingClips(live), [live.clips, live.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The clip that has the keyboard, and whether the keyboard brought it there or a press of the pointer. */
  const [focus, setFocus] = useState<{ id: ID; keyboard: boolean } | null>(null);
  /** The clip that had the keyboard last: where Tab comes back to. */
  const [lastFocus, setLastFocus] = useState<ID | null>(null);
  /** A clip that is to be given the keyboard as soon as it is drawn. */
  const wantFocus = useRef<ID | null>(null);
  /**
   * The key press (as counted by `presses`) that was made on a clip, if the last press was one:
   * where that key takes the selection, focus follows.
   */
  const carry = useRef(0);
  /** Set while focus is being moved here by script, on behalf of a key. */
  const focusing = useRef(false);
  /** What the selection is, in words, after the keyboard changed it. */
  const [said, setSaid] = useState('');

  const ui = () => useUI.getState();
  const store = () => session.store.get();
  const playhead = () => Math.floor(session.player?.getFrame() ?? 0);

  const toFrame = (clientX: number): number => {
    const r = ref.current!.getBoundingClientRect();
    return (clientX - r.left + ui().scrollX) / ui().ppf;
  };
  const toY = (clientY: number): number => clientY - ref.current!.getBoundingClientRect().top;
  /** The element the lanes scroll in when there are more of them than fit. */
  const body = (): HTMLElement | null => ref.current?.closest<HTMLElement>('.tl__body') ?? null;
  /** Take note of where the lanes stand, for when a track that was scrolled to is given up. */
  const noteScroll = () => {
    const el = body();
    if (reveal.current && el) reveal.current.seen = el.scrollTop;
  };
  /**
   * The pointer's height in the lanes as they lie without the scrolling done to show a track the
   * drag opened. Bringing that track into view moves every lane, and what the pointer is over
   * must not change because of that. Any other scrolling counts: the lanes really are elsewhere.
   */
  const laneY = (clientY: number): number => {
    noteScroll();
    return toY(clientY) - (reveal.current?.by ?? 0);
  };

  /** The part of the lanes that is on screen: the body they scroll in cuts them off above and below. */
  const viewRect = (): DOMRect | null => {
    const el = ref.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const around = body()?.getBoundingClientRect();
    if (!around) return r;
    const top = Math.max(r.top, around.top);
    return new DOMRect(r.left, top, r.width, Math.max(0, Math.min(r.bottom, around.bottom) - top));
  };

  const scroller = useMemo(
    () =>
      new EdgeScroller(
        [
          timeAxis(
            () => ref.current,
            () => useUI.getState().preview ?? session.store.get(),
          ),
          // Under the last lane lie the gap that follows every lane and the room after that.
          laneAxis(() => ref.current?.closest<HTMLElement>('.tl__body') ?? null, LANE_GAP + LANES_TAIL),
        ],
        () => rerun.current(),
      ),
    [session],
  );
  useEffect(() => () => scroller.stop(), [scroller]);

  // A track opened by the drag in progress can lie outside the scrolled view (a new audio lane is
  // added below the last one): bring it into view once it has been laid out. When the drag gives
  // the track up again, the lanes go back to where they were.
  useLayoutEffect(() => {
    const el = body();
    if (!el) return;
    if (!opened) {
      if (reveal.current) el.scrollTop = reveal.current.seen - reveal.current.by;
      reveal.current = null;
      return;
    }
    const lane = lanes.find((l) => l.track.id === opened);
    if (!lane) return;
    const from = el.scrollTop;
    let to = from;
    if (lane.top - LANE_GAP < to) to = Math.max(0, lane.top - LANE_GAP);
    else if (lane.top + lane.height + LANE_GAP > to + el.clientHeight)
      to = lane.top + lane.height + LANE_GAP - el.clientHeight;
    if (to === from) return;
    el.scrollTop = to;
    // What the body did is read back: it may not have gone all the way.
    const r = (reveal.current ??= { by: 0, seen: from });
    r.by += el.scrollTop - from;
    r.seen = el.scrollTop;
  }, [lanes, opened]);

  /** The frame the blade cuts at for a pointer at frame `f`: the playhead, when that is close by. */
  const cutFrame = (f: number): number => {
    const at = Math.round(f);
    const ph = playhead();
    return ui().snapping && Math.abs(at - ph) * ui().ppf < 8 ? ph : at;
  };

  /** Show where a press of the blade would cut the clip under the pointer, if it would cut one. */
  const showCut = (e: React.PointerEvent) => {
    const line = blade.current;
    if (!line) return;
    const p = store();
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-clip]')?.dataset.clip;
    const lane = id && p.clips[id] ? lanes.find((l) => l.track.id === p.clips[id].trackId) : null;
    if (!lane || lane.track.locked || !session.canEdit) {
      line.style.visibility = 'hidden';
      return;
    }
    const x = cutFrame(toFrame(e.clientX)) * ui().ppf - ui().scrollX;
    line.style.transform = `translate3d(${x}px, ${lane.top}px, 0)`;
    line.style.height = `${lane.height}px`;
    line.style.visibility = 'visible';
  };
  // The line stands where the pointer last was: once the lanes move under it, it says nothing true.
  useEffect(() => {
    if (blade.current) blade.current.style.visibility = 'hidden';
  }, [scrollX, ppf, lanes]);

  /**
   * Snap `edges` (already offset by the raw delta) to nearby cut points and to the playhead at
   * `head`. Returns the correction.
   */
  const snap = (
    p: Project,
    moving: ReadonlySet<ID>,
    edges: number[],
    disabled: boolean,
    head = playhead(),
  ): { adjust: number; line: number | null } => {
    if (!ui().snapping || disabled) return { adjust: 0, line: null };
    const pts = snapPoints(p, moving, [head]);
    const threshold = 8 / ui().ppf;
    let best: { adjust: number; line: number } | null = null;
    for (const e of edges) {
      const s = snapTo(e, pts, threshold);
      if (s !== null && (!best || Math.abs(s - e) < Math.abs(best.adjust))) best = { adjust: s - e, line: s };
    }
    return best ?? { adjust: 0, line: null };
  };

  /** Show beside the pointer what the drop in progress would do, or with `null` take that away. */
  const showMode = (text: string | null, at?: { clientX: number; clientY: number }) => {
    const el = modeTip.current;
    const r = ref.current?.getBoundingClientRect();
    if (!el || !r) return;
    if (text === null || !at) {
      el.style.visibility = 'hidden';
      return;
    }
    el.textContent = text;
    el.style.transform = `translate3d(${at.clientX - r.left + 14}px, ${at.clientY - r.top + 18}px, 0)`;
    el.style.visibility = 'visible';
  };

  const setPreview = (edits: Edit[] | null, line: number | null = null) => {
    if (!edits) ui().set({ preview: null, snapLine: null });
    else ui().set({ preview: edits.length ? applyEdits(store(), edits) : null, snapLine: line });
  };

  // ─────────────────────────────────────────────────────── move planning ──
  const planMove = (d: Extract<Drag, { kind: 'move' }>, e: Pointer) => {
    const base = store();
    const moving = new Set(d.ids);
    const clips = d.ids.map((id) => base.clips[id]).filter(Boolean);
    if (!clips.length)
      return {
        edits: [] as Edit[],
        commit: [] as Edit[],
        project: base,
        line: null as number | null,
        placements: [],
        opened: null as ID | null,
        spans: null as RippleSpan[] | null,
        refused: null as string | null,
      };
    let delta = Math.round(toFrame(e.clientX) - d.f0);
    const minStart = Math.min(...clips.map((c) => c.start));
    delta = Math.max(delta, -minStart);
    const edges = clips.flatMap((c) => [c.start + delta, clipEnd(c) + delta]);
    const s = snap(base, moving, edges, e.shiftKey);
    delta = Math.max(Math.round(delta + s.adjust), -minStart);

    // Vertical: move clips of the grabbed clip's kind by the same number of lanes. The pointer is
    // read against the lanes of the project as committed, not as previewed: a track this drag
    // opens pushes the lanes of the preview along, and they must not slide under the pointer.
    const anchor = base.clips[d.anchor];
    const kind = anchor ? trackKindFor(anchor.type) : 'video';
    const baseLanes = layoutLanes(base).lanes;
    const kindLanes = baseLanes.filter((l) => l.track.kind === kind);
    const y = laneY(e.clientY);
    const first = kindLanes[0];
    const last = kindLanes[kindLanes.length - 1];
    // Picture stacks upwards and sound downwards, so "past the edge" is above the top video lane
    // or below the bottom audio lane. Dragging there makes a new track, for as long as the
    // pointer stays out there.
    const beyond =
      kind === 'video'
        ? !!first && y < first.top - LANE_GAP
        : !!last && y > last.top + last.height + LANE_GAP;
    if (beyond && !d.newTrack) d.newTrack = addTrack(base, kind);
    const extra = beyond ? d.newTrack : undefined;
    const p = extra ? applyEdits(base, extra.edits) : base;
    let tracks = kindLanes.map((l) => l.track);
    if (extra) {
      const t = p.tracks[extra.trackId];
      tracks = kind === 'video' ? [t, ...tracks] : [...tracks, t];
    }
    const fromIdx = tracks.findIndex((t) => t.id === anchor?.trackId);
    const over = laneAt(baseLanes, y);
    let toIdx = fromIdx;
    if (beyond) toIdx = kind === 'video' ? 0 : tracks.length - 1;
    else if (over && over.track.kind === kind) toIdx = tracks.findIndex((t) => t.id === over.track.id);
    else if (!over && y < (first?.top ?? 0)) toIdx = 0;
    // Sound just under its last lane, not yet far enough out to open a track, still means that
    // lane. Otherwise the clip would go back to its own track for the pixel or two in between.
    else if (!over && kind === 'audio' && last && y >= last.top + last.height) toIdx = tracks.length - 1;
    let shift = toIdx - fromIdx;
    // Keep every moving clip of that kind on an existing, unlocked track.
    for (const c of clips) {
      if (trackKindFor(c.type) !== kind) continue;
      const i = tracks.findIndex((t) => t.id === c.trackId);
      shift = clamp(shift, -i, tracks.length - 1 - i);
    }
    const placements = clips.map((c) => {
      let trackId = c.trackId;
      if (trackKindFor(c.type) === kind && shift !== 0) {
        const i = tracks.findIndex((t) => t.id === c.trackId);
        const target = tracks[i + shift];
        if (target && !target.locked) trackId = target.id;
      }
      return { id: c.id, start: c.start + delta, trackId };
    });
    const used = extra && placements.some((m) => m.trackId === extra.trackId) ? extra : null;
    // With Ctrl or ⌘ the clips go in between the others, which close up where they came from.
    // Alt, which leaves a copy behind, keeps to overwriting.
    const between = e.insert && !e.altKey ? insertMove(p, placements) : null;
    const place = (on: Project): Edit[] =>
      between ? insertMove(on, placements).edits : placeClips(on, placements);
    const placed = between ? between.edits : placeClips(p, placements);
    return {
      edits: extra ? [...extra.edits, ...placed] : placed,
      // The track is only created if something actually landed on it.
      commit: used ? [...used.edits, ...placed] : extra ? place(base) : placed,
      project: used ? p : base,
      prefix: used ? used.edits : [],
      line: between ? (between.refused ? null : between.at) : s.line,
      placements: between
        ? placements.map((m) => ({
            ...m,
            start: m.start - Math.min(...placements.map((x) => x.start)) + between.at,
          }))
        : placements,
      opened: used ? used.trackId : null,
      spans: between ? between.spans : null,
      refused: between ? between.refused : null,
    };
  };

  // ─────────────────────────────────────────────────────────── pointer ──
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && tool === 'hand')) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: 'pan', x0: e.clientX, scroll0: ui().scrollX };
      return;
    }
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>('[data-clip]');
    const p = store();
    const clip = clipEl ? p.clips[clipEl.dataset.clip!] : null;
    const f = toFrame(e.clientX);
    const editable = session.canEdit;
    const locked = clip ? !!p.tracks[clip.trackId]?.locked : false;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (clip && !locked) {
      // What a gesture on this clip acts on: the clip and, with linked selection on, its partners.
      // A partner on a locked track is left out, whatever the tool.
      const group = effectiveSelection(p, [clip.id]);
      if (tool === 'blade') {
        if (!editable) return;
        commit(splitClips(p, group, cutFrame(f)).edits);
        return;
      }
      if (tool === 'slip') {
        if (!editable) return;
        ui().select(group);
        session.store.beginGesture();
        drag.current = { kind: 'slip', ids: group, x0: e.clientX, restore: playhead(), delta: 0 };
        return;
      }
      const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
      if (handle === 'trans-in' || handle === 'trans-out') {
        const side = handle === 'trans-in' ? 'in' : 'out';
        ui().set({ selectedTransition: { clipId: clip.id, side }, selection: [] });
        const t = side === 'in' ? clip.transIn : clip.transOut;
        if (editable && t && target.closest('[data-trans-edge]')) {
          session.store.beginGesture();
          drag.current = { kind: 'trans', id: clip.id, side, f0: f, base: t.duration };
        }
        return;
      }
      if (handle === 'keyframe') {
        // The keyframes at one time, on whichever properties, are one mark and move as one.
        const t = Number(target.closest<HTMLElement>('[data-handle]')!.dataset.t);
        if (editable) session.store.beginGesture();
        drag.current = { kind: 'keyframe', id: clip.id, t, t0: t, f0: f, x0: e.clientX, moved: false };
        return;
      }
      if ((handle === 'fade-in' || handle === 'fade-out') && editable) {
        const side = handle === 'fade-in' ? 'in' : 'out';
        session.store.beginGesture();
        drag.current = {
          kind: 'fade',
          id: clip.id,
          side,
          f0: f,
          x0: e.clientX,
          from: Math.max(side === 'in' ? clip.fadeIn : clip.fadeOut, FADE_INSET / ui().ppf),
          moved: false,
        };
        setFading({ id: clip.id, side, moved: false });
        return;
      }
      if ((handle === 'start' || handle === 'end') && editable) {
        if (!selectedSet.has(clip.id)) ui().select(group);
        // Ctrl/⌘ on a cut between two touching clips rolls the edit instead of trimming one side.
        // The linked clips that are cut at the same frame roll with it, so that picture and sound
        // stay cut together; one whose cut is elsewhere (a split edit) is left as it is.
        let roll: Cut[] | null = null;
        if (e.metaKey || e.ctrlKey) {
          const at = handle === 'start' ? clip.start : clipEnd(clip);
          const { cuts } = edgeCuts(p, group, handle);
          const here = cuts.filter(([, right]) => p.clips[right].start === at);
          if (here.some((cut) => cut.includes(clip.id))) roll = here;
        }
        drag.current = {
          kind: 'trim',
          ids: group,
          edge: handle,
          f0: f,
          restore: playhead(),
          roll,
          ripple: ui().rippleMode !== e.altKey,
          delta: 0,
          wanted: 0,
        };
        return;
      }
      // Body: select and maybe move.
      let reselect = false;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (selectedSet.has(clip.id)) ui().select(ui().selection.filter((id) => !group.includes(id)));
        else ui().select(group, true);
      } else if (!selectedSet.has(clip.id)) ui().select(group);
      else reselect = true;
      const ids = effectiveSelection(p, ui().selection).filter(
        (id) => !p.tracks[p.clips[id].trackId]?.locked,
      );
      if (ids.includes(clip.id) && editable) {
        drag.current = {
          kind: 'move',
          ids,
          anchor: clip.id,
          f0: f,
          x0: e.clientX,
          y0: e.clientY,
          moved: false,
          reselect,
        };
      }
      return;
    }

    // Empty space: marquee, or click to move the playhead.
    drag.current = {
      kind: 'marquee',
      x0: f * ui().ppf,
      y0: toY(e.clientY),
      keep: e.shiftKey ? ui().selection : [],
      moved: false,
      frame: Math.round(f),
    };
  };

  /**
   * Carry the drag in progress to where the pointer is. Returns how the view follows it at its
   * edges. Drags that follow the pointer in time scroll time; of those, the ones that also go
   * from lane to lane scroll the lanes.
   */
  const dragTo = (e: Pointer): Follow => {
    const d = drag.current;
    if (!d) return 'none';
    const p = store();
    switch (d.kind) {
      case 'pan':
        ui().set({ scrollX: Math.max(0, d.scroll0 - (e.clientX - d.x0)) });
        return 'none';
      case 'move': {
        if (!d.moved) {
          if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return 'none';
          d.moved = true;
        }
        const plan = planMove(d, e);
        setOpened(plan.opened);
        setPreview(plan.edits, plan.line);
        showMode(
          e.altKey ? 'Duplicate' : !e.insert ? null : plan.refused ? 'No room to insert' : 'Insert',
          e,
        );
        session.setPresence({
          dragging: plan.placements.map((m) => ({
            id: m.id,
            start: m.start,
            duration: p.clips[m.id].duration,
            trackId: m.trackId,
          })),
        });
        // A track the drag has opened is scrolled to as it is: there the edge leaves the lanes be.
        return plan.opened ? 'time' : 'both';
      }
      case 'trim': {
        d.wanted = Math.round(toFrame(e.clientX) - d.f0);
        if (d.roll) {
          const cuts = standingCuts(p, d.roll);
          if (!cuts.length) return 'time';
          const lead = cuts[0][1];
          // Every cut moves by the same amount, so the tightest of their limits holds for all.
          const range = edgeRange(p, d.edge, cuts, []);
          const wanted = clamp(d.wanted, range.min, range.max);
          // A trim shows the frame it cuts to, so the playhead follows the edge: what the edge
          // snaps to is where the playhead stood before the drag, not where the last move put it.
          const s = snap(p, new Set(cuts.flat()), [p.clips[lead].start + wanted], e.shiftKey, d.restore);
          d.delta = clamp(Math.round(wanted + s.adjust), range.min, range.max);
          setPreview(
            cuts.flatMap(([left, right]) => rollEdit(p, left, right, d.delta)),
            s.line,
          );
          const pv = ui().preview ?? p;
          if (pv.clips[lead]) session.player?.seek(pv.clips[lead].start);
          return 'time';
        }
        const first = p.clips[d.ids[0]];
        if (!first) return 'time';
        const edgeFrame = d.edge === 'start' ? first.start : clipEnd(first);
        const range = trimRange(p, d.ids, d.edge, d.ripple);
        const delta = clamp(d.wanted, range.min, range.max);
        const s = snap(p, new Set(d.ids), [edgeFrame + delta], e.shiftKey || d.ripple, d.restore);
        d.delta = clamp(Math.round(delta + s.adjust), range.min, range.max);
        const edits = trimClips(p, d.ids, d.edge, d.delta, d.ripple);
        setPreview(edits, s.line);
        // Show the frame being cut to, like a trim monitor.
        const pv = ui().preview ?? p;
        const c = pv.clips[d.ids[0]];
        if (c) session.player?.seek(d.edge === 'start' ? c.start : clipEnd(c) - 1);
        return 'time';
      }
      case 'slip': {
        d.delta = Math.round((d.x0 - e.clientX) / ui().ppf);
        setPreview(slipClips(p, d.ids, d.delta));
        const c = p.clips[d.ids[0]];
        if (c) session.player?.seek(c.start);
        return 'none';
      }
      case 'fade': {
        const c = p.clips[d.id];
        if (!c) return 'time';
        if (!d.moved) {
          // The fade ends where the handle is taken to. The handle of a short fade stands further
          // in than that fade ends, so a press that goes nowhere must not count as taking it there.
          if (Math.abs(e.clientX - d.x0) < 4) return 'none';
          d.moved = true;
          setFading({ id: d.id, side: d.side, moved: true });
        }
        const df = toFrame(e.clientX) - d.f0;
        const v = clamp(Math.round(d.side === 'in' ? d.from + df : d.from - df), 0, c.duration);
        commit(
          [{ op: 'updateClip', id: d.id, patch: d.side === 'in' ? { fadeIn: v } : { fadeOut: v } }],
          true,
        );
        return 'time';
      }
      case 'keyframe': {
        const c = p.clips[d.id];
        if (!c || !session.canEdit) return 'none';
        // A press that goes nowhere is a click on the mark, which takes the playhead to it.
        if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return 'none';
        d.moved = true;
        const range = keyframeRange(c, d.t);
        const t = clamp(d.t0 + Math.round(toFrame(e.clientX) - d.f0), range.min, range.max);
        if (t === d.t) return 'time';
        commit([{ op: 'updateClip', id: d.id, patch: moveKeyframes(c, d.t, t) }], true);
        d.t = t;
        return 'time';
      }
      case 'trans': {
        const c = p.clips[d.id];
        const t = c && (d.side === 'in' ? c.transIn : c.transOut);
        if (!c || !t) return 'time';
        const df = Math.round(toFrame(e.clientX) - d.f0);
        const twoSided = d.side === 'in' && !!adjacentPrev(p, c);
        const raw = d.side === 'in' ? d.base + df * (twoSided ? 2 : 1) : d.base - df;
        const duration = clamp(raw, 1, maxTransitionDuration(p, c, d.side));
        commit(
          [
            {
              op: 'updateClip',
              id: d.id,
              patch: d.side === 'in' ? { transIn: { ...t, duration } } : { transOut: { ...t, duration } },
            },
          ],
          true,
        );
        return 'time';
      }
      case 'marquee': {
        const x = toFrame(e.clientX) * ui().ppf;
        const y = toY(e.clientY);
        if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return 'none';
        d.moved = true;
        const box = {
          x: Math.min(x, d.x0),
          y: Math.min(y, d.y0),
          w: Math.abs(x - d.x0),
          h: Math.abs(y - d.y0),
        };
        setMarquee(box);
        const hit: ID[] = [];
        for (const lane of lanes) {
          if (lane.top + lane.height < box.y || lane.top > box.y + box.h || lane.track.locked) continue;
          for (const c of clipsOnTrack(p, lane.track.id)) {
            if (c.start * ui().ppf < box.x + box.w && clipEnd(c) * ui().ppf > box.x) hit.push(c.id);
          }
        }
        ui().select(Array.from(new Set([...d.keep, ...(ui().linkedSelection ? withLinked(p, hit) : hit)])));
        return 'both';
      }
    }
  };

  /** Carry the drag to where the pointer is and let the view follow it there. */
  const follow = (at: Pointer) => {
    const how = dragTo(at);
    if (how !== 'none') scroller.track(at.clientX, how === 'both' ? at.clientY : null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY <= r.bottom) {
      const lane = laneAt(lanes, toY(e.clientY));
      session.setPresence({ cursor: { area: 'timeline', x: toFrame(e.clientX), y: lane?.track.id ?? '' } });
    }
    if (tool === 'blade') showCut(e);
    if (!drag.current) return;
    pointer.current = pointerOf(e);
    follow(pointer.current);
  };

  const finish = (e: React.PointerEvent | null, cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    pointer.current = null;
    scroller.stop();
    noteScroll();
    setOpened(null);
    setFading(null);
    showMode(null);
    if (e) (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const p = store();
    switch (d.kind) {
      case 'move':
        if (!d.moved) {
          // A click on an already-selected clip narrows the selection to it.
          if (d.reselect && !cancelled)
            ui().select(ui().linkedSelection ? withLinked(p, [d.anchor]) : [d.anchor]);
        } else if (!cancelled && e) {
          const plan = planMove(d, pointerOf(e));
          // A track that was scrolled to and is now kept stays in view.
          if (plan.opened) reveal.current = null;
          if (plan.refused) toast(plan.refused);
          else if (plan.spans) commit(withMarkers(p, { edits: plan.commit, spans: plan.spans }));
          else if (e.altKey) {
            // Alt-drop duplicates instead of moving.
            const copies = plan.placements.map((m) => ({
              ...p.clips[m.id],
              start: m.start,
              trackId: m.trackId,
            }));
            const r = pasteClips(plan.project, copies, Math.min(...copies.map((c) => c.start)));
            commit([...(plan.prefix ?? []), ...r.edits]);
            ui().select(r.created);
          } else commit(plan.commit);
        }
        session.setPresence({ dragging: null });
        break;
      case 'trim':
        // The preview dates from the last pointer move and knows nothing of what has been
        // committed since, by a collaborator for one. So the edit is planned again, from the
        // distance the edge was dragged, on the project as it is now.
        if (!cancelled && d.roll) {
          const cuts = standingCuts(p, d.roll);
          const range = edgeRange(p, d.edge, cuts, []);
          const delta = clamp(d.delta, range.min, range.max);
          commit(cuts.flatMap(([left, right]) => rollEdit(p, left, right, delta)));
        } else if (!cancelled) {
          const range = trimRange(p, d.ids, d.edge, d.ripple);
          const delta = clamp(d.delta, range.min, range.max);
          const edits = trimClips(p, d.ids, d.edge, delta, d.ripple);
          // What a ripple does to time, the markers on the shots that move go through as well.
          commit(d.ripple ? withMarkers(p, { edits, spans: trimSpans(p, d.ids, d.edge, delta) }) : edits);
          // A ripple that could not move at all looks like a stuck handle: say what holds it.
          const held = d.ripple && delta === 0 && d.wanted !== 0;
          const refused = held ? rippleTrim(p, d.ids, d.edge, d.wanted).refused : null;
          if (refused) toast(refused);
        }
        session.player?.seek(d.restore);
        break;
      case 'slip':
        if (!cancelled) commit(slipClips(p, d.ids, d.delta));
        session.player?.seek(d.restore);
        break;
      case 'keyframe':
        if (!d.moved && !cancelled && p.clips[d.id]) cmd.seek(p.clips[d.id].start + d.t, false);
        break;
      case 'marquee':
        setMarquee(null);
        if (!d.moved && !cancelled) {
          if (!d.keep.length) ui().clearSelection();
          if (tool === 'select') cmd.seek(clamp(d.frame, 0, 1e9), false);
        }
        break;
      default:
        break;
    }
    setPreview(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.key === 'Escape' && drag.current) {
        e.stopPropagation();
        finish(null, true);
        return;
      }
      // A modifier pressed or let go while the pointer holds still: what the drop would do is
      // worked out again, as if the pointer had moved.
      if (e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta') return;
      if (drag.current?.kind === 'move' && pointer.current) {
        pointer.current = { ...pointer.current, altKey: e.altKey, insert: e.ctrlKey || e.metaKey };
        follow(pointer.current);
      } else if (drop.current) hover();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  });

  // ────────────────────────────────────────────────────────── the keyboard ──
  const clipElement = (id: ID): HTMLElement | null =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-clip]') ?? []).find(
      (el) => el.dataset.clip === id,
    ) ?? null;

  /** Select `to` (with what selecting it selects), bring it into view and give it the keyboard. */
  const goTo = (p: Project, to: Clip | null | undefined, extend: boolean) => {
    const ids = to ? effectiveSelection(p, [to.id]) : [];
    if (!to || !ids.length) return;
    ui().select(ids, extend);
    revealFrame(to.start);
    wantFocus.current = to.id;
  };

  /** The clip nearest `from` in time on the next lane that has clips, upwards (-1) or downwards. */
  const clipOnLane = (p: Project, from: Clip, dir: 1 | -1): Clip | null => {
    const at = lanes.findIndex((l) => l.track.id === from.trackId);
    for (let i = at + dir; at >= 0 && i >= 0 && i < lanes.length; i += dir) {
      if (lanes[i].track.locked) continue;
      const clips = clipsOnTrack(p, lanes[i].track.id);
      if (!clips.length) continue;
      const distance = (c: Clip) =>
        c.start <= from.start && from.start < clipEnd(c) ? -1 : Math.abs(c.start - from.start);
      return clips.reduce((best, c) => (distance(c) < distance(best) ? c : best));
    }
    return null;
  };

  /** The menu of the clip that has the keyboard, opened where the clip is. */
  const openClipMenu = (el: HTMLElement, id: ID) => {
    if (!selectedSet.has(id)) ui().select(ui().linkedSelection ? withLinked(store(), [id]) : [id]);
    const r = el.getBoundingClientRect();
    const view = viewRect() ?? r;
    const at = {
      clientX: clamp(r.left, view.left, view.right) + 8,
      clientY: clamp(r.top + r.height / 2, view.top, view.bottom),
    };
    openContextMenu({ ...at, preventDefault: () => {} }, clipMenu(store(), id, at));
  };

  /**
   * Keys on a clip that has the keyboard. Each lane is a list of its clips: the arrow keys go from
   * clip to clip and the selection goes with them, as in any list, and Enter or Space selects.
   * That holds for a clip the keyboard came to. One that only kept the focus of the press that
   * selected it leaves every key to the editor: the arrows go on stepping through frames and cuts.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    const id = el.dataset.clip;
    const p = store();
    const clip = id ? p.clips[id] : undefined;
    if (!id || !clip) return;
    // Whatever this key makes of the selection (it may be a command of the editor's), the clip
    // that is selected afterwards is the one that has the keyboard.
    carry.current = presses;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      openClipMenu(el, id);
      return;
    }
    if (!focus?.keyboard || e.altKey || e.ctrlKey || e.metaKey) return;
    const { prev, next } = neighbors(p, clip);
    const row = clipsOnTrack(p, clip.trackId);
    const go: Record<string, () => void> = {
      ArrowLeft: () => goTo(p, prev, e.shiftKey),
      ArrowRight: () => goTo(p, next, e.shiftKey),
      ArrowUp: () => goTo(p, clipOnLane(p, clip, -1), e.shiftKey),
      ArrowDown: () => goTo(p, clipOnLane(p, clip, 1), e.shiftKey),
      Home: () => goTo(p, row[0], e.shiftKey),
      End: () => goTo(p, row[row.length - 1], e.shiftKey),
      Enter: () => goTo(p, clip, e.shiftKey),
      ' ': () => {
        // Space takes a selected clip out of a selection of several, as a press with Shift does.
        // The keyboard stays on the clip it was pressed on: here focus does not follow the selection.
        const group = effectiveSelection(p, [id]);
        if (e.shiftKey && selectedSet.has(id)) {
          carry.current = 0;
          ui().select(ui().selection.filter((s) => !group.includes(s)));
        } else goTo(p, clip, e.shiftKey);
      },
    };
    if (!Object.hasOwn(go, e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    go[e.key]();
  };

  // Which clip has the keyboard. The page is listened to directly: focus that a closing menu hands
  // back arrives while React is busy taking the menu out, and its own focus events are not sent then.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onFocusIn = (e: FocusEvent) => {
      const id = (e.target as HTMLElement).dataset.clip;
      if (!id) return;
      // A clip the keyboard came to: by Tab or an arrow key, or here, following the selection.
      setFocus({ id, keyboard: focusing.current || spaceOperates(e.target) });
      setLastFocus(id);
    };
    const onFocusOut = (e: FocusEvent) => {
      if ((e.target as HTMLElement).dataset.clip) setFocus(null);
    };
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // Focus follows the selection for as long as the keyboard is in the lanes: to the clip a key
  // has just gone to, and to the one a command of the editor's selected from here.
  useLayoutEffect(() => {
    let id = wantFocus.current;
    if (!id && carry.current === presses && lastFocus) {
      const p = store();
      const from = p.clips[lastFocus];
      if (!from) id = tabStop;
      else if (selection.length && !selectedSet.has(lastFocus))
        id = selection.find((s) => p.clips[s]?.trackId === from.trackId) ?? selection[0];
    }
    const el = id ? clipElement(id) : null;
    if (!el) return;
    wantFocus.current = null;
    carry.current = 0;
    if (document.activeElement === el) return;
    focusing.current = true;
    el.focus();
    focusing.current = false;
  });

  // Say what is selected when the keyboard changed it and nothing else says so: focus on the
  // selected clip is read out by itself, and a press of the pointer is seen where it lands.
  const announced = useRef(selection);
  useEffect(() => {
    if (announced.current === selection) return;
    announced.current = selection;
    const active = document.activeElement as HTMLElement | null;
    const onClip = !!active?.dataset.clip && selectedSet.has(active.dataset.clip);
    setSaid(usingKeyboard() && !onClip ? describeSelection(store(), selection) : '');
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────── drops from the library ──
  const dropPlan = (payload: DragPayload, x: number, y: number, pinned: AddTrack[]): DropPlan | null => {
    const view = viewRect();
    if (!view || !insideRect(view, x, y)) return null;
    const none: DropPlan = { tracks: pinned, edits: [] };
    const p = store();
    // As in a move, the pointer is read against the lanes of the project as committed. A track
    // the plan opens moves the lanes of the preview, and a plan that followed them would change
    // under a pointer that has not moved: an overwrite of whichever lane slid there.
    const lane = laneAt(layoutLanes(p).lanes, laneY(y));
    const clipEl = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-clip]');
    const over = clipEl ? p.clips[clipEl.dataset.clip!] : null;
    if (payload.kind === 'effect') {
      if (!over || over.type === 'audio') return none;
      return { ...none, hint: { clipId: over.id, side: 'all' } };
    }
    if (payload.kind === 'transition') {
      if (!over || over.type === 'audio') return none;
      const mid = (over.start + over.duration / 2) * ui().ppf - ui().scrollX + view.left;
      return { ...none, hint: transitionTarget(p, over.id, x < mid ? 'in' : 'out') };
    }
    const placed = (place: (on: Project) => OpResult, line: number | null): DropPlan => {
      // Where the plan needs a new track it takes the one this drag opened before. Making a fresh
      // one at every pointer position would show a lane that is replaced with each move.
      let r = place(p);
      if (pinned.length && r.edits.some(isAddTrack)) r = place(applyEdits(p, pinned));
      const tracks = [...pinned, ...r.edits.filter(isAddTrack)];
      const rest = r.edits.filter((e) => !isAddTrack(e));
      const landed = rest.flatMap((e) =>
        e.op === 'addClip' && r.created.includes(e.clip.id) ? [e.clip.trackId] : [],
      );
      const used = tracks.filter((e) => landed.includes(e.track.id));
      // Scrolling to a new track takes the lane under the pointer out from under it, which is
      // only right when nothing lands there: when all that is added sits on new tracks.
      const apart = landed.every((id) => used.some((e) => e.track.id === id));
      return {
        tracks,
        edits: [...used, ...rest],
        select: r.created,
        line,
        opened: apart ? (used.find((e) => e.track.kind === 'video') ?? used[0])?.track.id : undefined,
      };
    };
    let frame = Math.max(0, Math.round(toFrame(x)));
    if (payload.kind === 'asset') {
      const asset = p.assets[payload.assetId];
      if (!asset || asset.kind === 'lut') {
        return over && over.type !== 'audio' ? { ...none, hint: { clipId: over.id, side: 'all' } } : none;
      }
      // With Alt over a clip of its kind the file takes that clip's place, and the clip keeps
      // everything that was done to it.
      const fits =
        !!over &&
        !p.tracks[over.trackId]?.locked &&
        (over.type === 'video'
          ? asset.kind === 'video'
          : over.type === 'image'
            ? asset.kind === 'image'
            : over.type === 'audio' && asset.kind !== 'image');
      if (held.alt && over && fits) {
        return { ...none, hint: { clipId: over.id, side: 'all' }, replace: over.id, mode: 'Replace' };
      }
      const len =
        asset.kind === 'image'
          ? Math.round(5 * (p.settings.fpsNum / p.settings.fpsDen))
          : Math.round(asset.duration * (p.settings.fpsNum / p.settings.fpsDen));
      const s = snap(p, new Set(), [frame, frame + len], false);
      frame = Math.max(0, Math.round(frame + s.adjust));
      const visual = asset.kind !== 'audio';
      const target = {
        frame,
        videoTrackId:
          visual && lane?.track.kind === 'video' && !lane.track.locked ? lane.track.id : undefined,
        audioTrackId: lane?.track.kind === 'audio' && !lane.track.locked ? lane.track.id : undefined,
      };
      if (!held.insert) return placed((on) => addAssetToTimeline(on, asset, target), s.line);
      // With Ctrl or ⌘ what is there makes way: everything from the frame on moves later by the
      // length of the clip, on every unlocked track, as for an insert from the source monitor.
      const span = { from: frame, by: Math.max(1, len) };
      const plan = placed((on) => {
        const room = openGapAt(on, span.from, span.by).edits;
        const added = addAssetToTimeline(applyEdits(on, room), asset, target);
        return { edits: [...room, ...added.edits], created: added.created };
      }, s.line);
      return { ...plan, spans: [span], mode: 'Insert' };
    }
    const s = snap(p, new Set(), [frame], false);
    frame = Math.max(0, Math.round(frame + s.adjust));
    const trackId = lane?.track.kind === 'video' && !lane.track.locked ? lane.track.id : undefined;
    return placed(
      (on) =>
        payload.kind === 'text'
          ? addGenerator(on, 'text', { frame, trackId, text: payload.text })
          : payload.kind === 'shape'
            ? addGenerator(on, 'shape', { frame, trackId, shape: payload.shape })
            : addGenerator(on, payload.type, { frame, trackId }),
      s.line,
    );
  };

  /** The library drag has left the lanes or is over: take its preview and its tracks away. */
  const endDrop = () => {
    drop.current = null;
    scroller.stop();
    noteScroll();
    setOpened(null);
    setDropHint(null);
    setPreview(null);
    showMode(null);
  };

  /**
   * Show where the thing being dragged in from the library would land right now, and let the
   * view follow the pointer at its edges. As in a move, a track the drag has opened is scrolled
   * to as it is, and the edge leaves the lanes be meanwhile.
   */
  const hover = () => {
    const s = useDrag.getState();
    const plan =
      s.payload && session.canEdit ? dropPlan(s.payload, s.x, s.y, drop.current?.tracks ?? []) : null;
    if (!plan) {
      if (drop.current) endDrop();
      return;
    }
    drop.current = { tracks: plan.tracks };
    setOpened(plan.opened ?? null);
    setDropHint(plan.hint ?? null);
    setPreview(plan.edits, plan.line ?? null);
    showMode(plan.mode ?? null, { clientX: s.x, clientY: s.y });
    scroller.track(s.x, plan.opened ? null : s.y);
  };

  const dropped = (payload: DragPayload, x: number, y: number): boolean => {
    if (!session.canEdit) return false;
    const plan = dropPlan(payload, x, y, drop.current?.tracks ?? []);
    if (!plan) return false;
    // A track that was scrolled to and is now kept stays in view.
    if (plan.opened) reveal.current = null;
    endDrop();
    if (plan.replace && payload.kind === 'asset') {
      cmd.replaceClip(plan.replace, payload.assetId);
      return true;
    }
    if (plan.hint) {
      if (payload.kind === 'effect') cmd.applyEffect(payload.type, [plan.hint.clipId]);
      else if (payload.kind === 'transition')
        cmd.applyTransition(payload.type, plan.hint.clipId, plan.hint.side === 'out' ? 'out' : 'in');
      else if (payload.kind === 'asset') {
        ui().select([plan.hint.clipId]);
        cmd.applyLut(payload.assetId);
      }
      return true;
    }
    if (plan.edits.length) {
      commit(plan.spans ? withMarkers(store(), { edits: plan.edits, spans: plan.spans }) : plan.edits);
      if (payload.kind === 'text' && plan.select?.length) cmd.editText(plan.select[0]);
      else if (plan.select) ui().select(plan.select);
    }
    return true;
  };

  // The subscriptions outlive a render, so they reach the handlers of the latest one through a
  // ref: subscribing afresh whenever the lanes change would drop the state of a drag in progress.
  const library = useRef({ hover, dropped, endDrop });
  library.current = { hover, dropped, endDrop };
  rerun.current = () => {
    if (drag.current && pointer.current) follow(pointer.current);
    else if (drop.current) hover();
  };

  useEffect(() => {
    const unsub = useDrag.subscribe(() => library.current.hover());
    const undrop = onDrop((payload, x, y) => library.current.dropped(payload, x, y));
    return () => {
      unsub();
      undrop();
      if (drop.current) library.current.endDrop();
    };
  }, [scroller]);

  // ───────────────────────────────────────────────────────────── render ──
  const peerSel = useMemo(() => {
    const m = new Map<ID, { color: string; name: string }>();
    for (const peer of peers)
      for (const id of peer.selection ?? [])
        if (!m.has(id)) m.set(id, { color: peer.user.color, name: peer.user.name });
    return m;
  }, [peers]);

  const viewL = scrollX - 300;
  const viewR = scrollX + width + 300;
  const drawn = (c: Clip): boolean => !(c.start * ppf + c.duration * ppf < viewL || c.start * ppf > viewR);
  /**
   * The one clip Tab stops at, so that the lanes are a single stop however many clips they hold:
   * the clip that had the keyboard last while it is selected or nothing else is, else a selected
   * clip, else the first one in view.
   */
  const tabStop = ((): ID | null => {
    const shown = (id: ID | null): id is ID => {
      const c = id ? live.clips[id] : undefined;
      return !!c && drawn(c) && lanes.some((l) => l.track.id === c.trackId);
    };
    const selected = selection.find(shown);
    if (shown(lastFocus) && (selectedSet.has(lastFocus) || !selected)) return lastFocus;
    if (selected) return selected;
    for (const lane of lanes) {
      const first = clipsOnTrack(live, lane.track.id).find(drawn);
      if (first) return first.id;
    }
    return null;
  })();
  const cursor =
    tool === 'blade' ? 'crosshair' : tool === 'hand' ? 'grab' : tool === 'slip' ? 'ew-resize' : undefined;

  return (
    <div
      ref={ref}
      className="lanes"
      role="group"
      aria-label="Tracks"
      data-tool={tool}
      style={{ height, cursor }}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onPointerLeave={() => {
        session.setPresence({ cursor: null });
        if (blade.current) blade.current.style.visibility = 'hidden';
      }}
      onDoubleClick={(e) => {
        // The lanes hold the pointer from the press on, so the event is aimed at them, not at the
        // clip: look up what lies under it.
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const id = hit?.closest<HTMLElement>('[data-clip]')?.dataset.clip;
        if (tool !== 'select' || !id || hit?.closest('[data-handle]')) return;
        if (store().clips[id]?.type === 'text') cmd.editText(id);
      }}
      onContextMenu={(e) => {
        const clipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-clip]');
        const id = clipEl?.dataset.clip;
        // Asked for from the keyboard, the menu opens at the clip and not where the pointer was left.
        if (clipEl && id && e.button !== 2 && !e.ctrlKey && document.activeElement === clipEl) {
          e.preventDefault();
          openClipMenu(clipEl, id);
          return;
        }
        const mark = (e.target as HTMLElement).closest<HTMLElement>('[data-handle="keyframe"]');
        if (id && mark) {
          const t = Number(mark.dataset.t);
          openContextMenu(e, [
            { label: 'Go to keyframe', onSelect: () => cmd.seek((store().clips[id]?.start ?? 0) + t, false) },
            {
              label: 'Delete keyframe',
              danger: true,
              onSelect: () => {
                const c = store().clips[id];
                if (c) commit([{ op: 'updateClip', id, patch: removeKeyframes(c, t) }]);
              },
            },
          ]);
          return;
        }
        if (id && !selectedSet.has(id)) ui().select(ui().linkedSelection ? withLinked(store(), [id]) : [id]);
        const lane = laneAt(lanes, toY(e.clientY));
        const at = Math.max(0, Math.floor(toFrame(e.clientX)));
        const where = { clientX: e.clientX, clientY: e.clientY };
        openContextMenu(e, id ? clipMenu(store(), id, where) : laneMenu(store(), lane, at));
      }}
    >
      {lanes.map((lane) => {
        const clips = clipsOnTrack(live, lane.track.id);
        return (
          <div
            key={lane.track.id}
            className="lane"
            data-kind={lane.track.kind}
            data-locked={lane.track.locked}
            data-hidden={lane.track.hidden || lane.track.muted}
            style={{ top: lane.top, height: lane.height }}
          >
            <LaneCanvas
              project={live}
              clips={clips}
              width={width}
              height={lane.height}
              scrollX={scrollX}
              ppf={ppf}
              offline={offline}
            />
            <div
              className="lane__clips"
              // A list of the lane's clips to assistive technology; a lane without any is no list.
              role={clips.length ? 'listbox' : undefined}
              aria-multiselectable={clips.length ? true : undefined}
              aria-label={
                clips.length
                  ? `Clips on ${lane.track.name ? `${lane.label}, ${lane.track.name}` : lane.label}`
                  : undefined
              }
              style={{ transform: `translate3d(${-scrollX}px, 0, 0)` }}
            >
              {clips.map((c, i) => {
                if (!drawn(c)) return null;
                const prev = i > 0 && clipEnd(clips[i - 1]) === c.start ? clips[i - 1] : null;
                const win = prev && c.transIn ? cutTransitionWindow(prev, c) : null;
                const peer = peerSel.get(c.id);
                const fault = c.assetId ? session.thumbs.fault(c.assetId) : null;
                return (
                  <ClipView
                    key={c.id}
                    clip={c}
                    ppf={ppf}
                    height={lane.height}
                    track={lane.label}
                    settings={live.settings}
                    locked={lane.track.locked}
                    tabStop={c.id === tabStop}
                    focused={focus?.id === c.id && focus.keyboard}
                    selected={selectedSet.has(c.id)}
                    transSel={selectedTransition?.clipId === c.id ? selectedTransition.side : null}
                    transBefore={win ? win.before : 0}
                    transLen={win ? win.duration : c.transIn ? Math.min(c.transIn.duration, c.duration) : 0}
                    peerColor={peer?.color ?? null}
                    peerName={peer?.name ?? null}
                    hint={dropHint?.clipId === c.id ? dropHint.side : null}
                    fading={fading?.id === c.id ? fading.side : null}
                    fadeMoved={fading?.id === c.id && fading.moved}
                    missing={!!c.assetId && (!live.assets[c.assetId] || offline.has(c.assetId))}
                    undecodable={!!fault && (c.type === 'audio' ? fault.sound : fault.picture)}
                    overlapping={overlapping.has(c.id)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Clips other people are dragging right now. */}
      {peers.flatMap((peer) =>
        (peer.dragging ?? []).map((g, i) => {
          const lane = lanes.find((l) => l.track.id === g.trackId);
          if (!lane) return null;
          return (
            <div
              // By place in the list: what a peer announces may name one clip twice.
              key={`${peer.clientId}:${i}`}
              className="peer-ghost"
              style={{
                left: g.start * ppf - scrollX,
                width: Math.max(2, g.duration * ppf),
                top: lane.top,
                height: lane.height,
                ['--c' as string]: peer.user.color,
              }}
            >
              <span>{peer.user.name}</span>
            </div>
          );
        }),
      )}
      {peers.map((peer) => {
        if (!peer.cursor || peer.cursor.area !== 'timeline') return null;
        const lane = lanes.find((l) => l.track.id === peer.cursor!.y);
        if (!lane) return null;
        return (
          <div
            key={peer.clientId}
            className="peer-cursor peer-cursor--tl"
            style={{
              left: peer.cursor.x * ppf - scrollX,
              top: lane.top + lane.height / 2,
              ['--c' as string]: peer.user.color,
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path
                d="M2 1.5l11 5.2-4.700 1.400-1.700 4.700L2 1.500z"
                fill="var(--c)"
                stroke="#0b0b0d"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
            <span>{peer.user.name}</span>
          </div>
        );
      })}

      {tool === 'blade' && <div ref={blade} className="blade" />}
      <div ref={modeTip} className="drop-mode" />
      {snapLine !== null && <div className="snapline" style={{ left: snapLine * ppf - scrollX }} />}
      {marquee && (
        <div
          className="marquee"
          style={{ left: marquee.x - scrollX, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
      <div className="sr-only" role="status">
        {said}
      </div>
    </div>
  );
}

/**
 * The assets whose file cannot be had right now (see `mediaAvailable`). The set is the same object
 * for as long as it holds the same assets: the status of the media changes with every step of an
 * upload, and the lanes are painted again only when what they show does.
 */
function useOfflineAssets(assets: Project['assets']): ReadonlySet<ID> {
  const session = useSession();
  const { shared } = useSessionMeta();
  const version = useSyncExternalStore(session.media.subscribe, session.media.getVersion);
  const last = useRef<ReadonlySet<ID>>(new Set());
  return useMemo(() => {
    const now = new Set<ID>();
    for (const a of Object.values(assets)) {
      if (a.kind !== 'lut' && !mediaAvailable(a, session.media.get(a.id), shared)) now.add(a.id);
    }
    const same = now.size === last.current.size && [...now].every((id) => last.current.has(id));
    if (!same) last.current = now;
    return last.current;
  }, [assets, shared, version, session]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ───────────────────────────────────────────────────────────────── menus ──

const LABEL_NAMES = [
  'Blue',
  'Violet',
  'Pink',
  'Red',
  'Orange',
  'Amber',
  'Lime',
  'Emerald',
  'Teal',
  'Cyan',
  'Slate',
];

/** Where on screen a menu was asked for. */
interface MenuAt {
  clientX: number;
  clientY: number;
}

/**
 * A menu entry that leads to a further menu, which opens where this one was. It opens once this
 * one has closed and handed the keyboard back, and so like any menu: with its first entry focused
 * for someone working from the keyboard.
 */
const further = (label: string, at: MenuAt, items: () => MenuEntry[]): MenuEntry => ({
  label,
  onSelect: () => setTimeout(() => openContextMenu({ ...at, preventDefault: () => {} }, items())),
});

function clipMenu(p: Project, id: ID, at: MenuAt): MenuEntry[] {
  const c = p.clips[id];
  if (!c) return [];
  const ui = useUI.getState();
  const timed = (c.type === 'video' || c.type === 'audio') && !c.freeze;
  const picture = c.type !== 'audio';
  // The copied attributes as the menu has them when it is opened, not as they were under this one.
  const attributes = (): MenuEntry[] => {
    const copied = useUI.getState().attributes;
    return [
      { label: 'Copy attributes', keys: shortcutOf('copy-attrs'), onSelect: () => cmd.copyAttributes() },
      'separator',
      { heading: 'Paste attributes' },
      {
        label: 'Everything',
        keys: shortcutOf('paste-attrs'),
        onSelect: () => cmd.pasteAttributes('all'),
        disabled: !copied,
      },
      { label: 'Grade only', onSelect: () => cmd.pasteAttributes('grade'), disabled: !copied?.look },
      { label: 'Effects only', onSelect: () => cmd.pasteAttributes('effects'), disabled: !copied?.look },
      {
        label: 'Transform and crop only',
        onSelect: () => cmd.pasteAttributes('transform'),
        disabled: !copied?.look,
      },
      c.type === 'audio'
        ? {
            label: 'Volume, pan and fades only',
            onSelect: () => cmd.pasteAttributes('sound'),
            disabled: !copied?.sound,
          }
        : null,
    ];
  };
  const range = (): MenuEntry[] => [
    { label: 'Mark clip', keys: shortcutOf('mark-clip'), onSelect: cmd.markClip },
    { label: 'Go to in', keys: shortcutOf('go-in'), onSelect: () => cmd.goToRange('in') },
    { label: 'Go to out', keys: shortcutOf('go-out'), onSelect: () => cmd.goToRange('out') },
  ];
  return [
    { label: 'Cut', keys: 'mod+x', onSelect: cmd.cut },
    { label: 'Copy', keys: 'mod+c', onSelect: cmd.copy },
    { label: 'Paste', keys: 'mod+v', onSelect: cmd.paste, disabled: !ui.clipboard.length },
    { label: 'Duplicate', keys: 'mod+d', onSelect: cmd.duplicate },
    'separator',
    { label: 'Split at playhead', keys: 'mod+b', onSelect: cmd.split },
    c.type === 'video' && !c.freeze
      ? { label: 'Freeze frame at playhead', keys: 'shift+f', onSelect: cmd.freezeFrame }
      : null,
    { label: 'Delete', keys: 'delete', onSelect: () => cmd.delete(false) },
    { label: 'Ripple delete', keys: 'shift+delete', onSelect: () => cmd.delete(true) },
    'separator',
    c.type === 'text' ? { label: 'Edit text', onSelect: () => cmd.editText(c.id) } : null,
    c.assetId && p.assets[c.assetId]
      ? { label: 'Match frame', keys: 'f', onSelect: () => cmd.matchFrame(c.id) }
      : null,
    c.assetId && p.assets[c.assetId]
      ? { label: 'Reveal in media pool', onSelect: () => cmd.revealInPool(c.id) }
      : null,
    { label: c.enabled ? 'Disable' : 'Enable', keys: 'd', onSelect: cmd.toggleEnabled },
    c.linkId
      ? { label: 'Unlink', icon: <Link2 />, keys: 'mod+shift+g', onSelect: cmd.unlink }
      : {
          label: 'Link selected',
          icon: <Link2 />,
          keys: 'mod+g',
          onSelect: cmd.link,
          disabled: ui.selection.length < 2,
        },
    timed
      ? { label: c.reverse ? 'Play forwards' : 'Reverse', onSelect: () => cmd.setSpeed(c.speed, !c.reverse) }
      : null,
    timed ? { label: 'Speed: 50%', onSelect: () => cmd.setSpeed(0.5) } : null,
    timed ? { label: 'Speed: 100%', onSelect: () => cmd.setSpeed(1) } : null,
    timed ? { label: 'Speed: 200%', onSelect: () => cmd.setSpeed(2) } : null,
    c.type === 'audio'
      ? { label: 'Normalize loudness (−14 LUFS)', onSelect: () => void cmd.normalizeLoudness(-14) }
      : null,
    // Only there for a clip that shares frames with another: two people placed them at one moment.
    overlappingClips(p).has(id)
      ? { label: 'Move to a free track', onSelect: () => commit(separateClips(p, [id])) }
      : null,
    'separator',
    picture
      ? {
          label: 'Add default transition',
          keys: shortcutOf('default-transition'),
          onSelect: cmd.addDefaultTransition,
        }
      : null,
    { label: 'Extend edit to playhead', keys: shortcutOf('extend-edit'), onSelect: cmd.extendEdit },
    // Kept a step away, so that the menu stays short enough to take in at a glance.
    further('In and out…', at, range),
    further('Attributes…', at, attributes),
    'separator',
    { heading: 'Label' },
    {
      swatches: LABEL_COLORS.map((color, i) => ({
        color,
        label: color === CLIP_TYPE_COLORS[c.type] ? `${LABEL_NAMES[i]} (default)` : LABEL_NAMES[i],
        checked: (c.label ?? CLIP_TYPE_COLORS[c.type]) === color,
        onSelect: () => cmd.updateSelected({ label: color === CLIP_TYPE_COLORS[c.type] ? null : color }),
      })),
    },
  ];
}

/** Menu for empty lane space: `lane` and `at` are the track and the frame under the pointer. */
function laneMenu(p: Project, lane: Lane | null, at: number): MenuEntry[] {
  const ui = useUI.getState();
  const gap = lane && !lane.track.locked ? rippleCloseGap(p, lane.track.id, at) : null;
  return [
    { label: 'Paste', keys: 'mod+v', onSelect: cmd.paste, disabled: !ui.clipboard.length },
    {
      label: 'Paste insert',
      keys: shortcutOf('paste-insert'),
      onSelect: cmd.pasteInsert,
      disabled: !ui.clipboard.length,
    },
    {
      label: 'Close gap here',
      // A gap that cannot be closed stays on offer: choosing it says why.
      disabled: !lane || !gap || (!gap.edits.length && !gap.refused),
      onSelect: () => lane && cmd.closeGap(lane.track.id, at),
    },
    'separator',
    { label: 'Add text', keys: 't', onSelect: () => cmd.addTitle() },
    { label: 'Add adjustment layer', onSelect: cmd.addAdjustment },
    'separator',
    { label: 'Add video track', onSelect: () => cmd.addTrack('video') },
    { label: 'Add audio track', onSelect: () => cmd.addTrack('audio') },
  ];
}

// ─────────────────────────────────────────────────────────────── canvas ──

interface LaneCanvasProps {
  project: Project;
  clips: readonly Clip[];
  width: number;
  height: number;
  scrollX: number;
  ppf: number;
  offline: ReadonlySet<ID>;
}

/**
 * Whether two renders of a lane would paint the same picture. Every commit and every tick of a
 * drag preview makes a new project and a new clip list for every lane, but the store keeps what
 * did not change identical, and the painting reads only the clips, the assets, the frame rate and
 * which of the assets are offline.
 */
function sameLanePicture(a: LaneCanvasProps, b: LaneCanvasProps): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.scrollX === b.scrollX &&
    a.ppf === b.ppf &&
    a.offline === b.offline &&
    a.project.assets === b.project.assets &&
    a.project.settings === b.project.settings &&
    a.clips.length === b.clips.length &&
    a.clips.every((c, i) => c === b.clips[i])
  );
}

const LaneCanvas = memo(function LaneCanvas({
  project,
  clips,
  width,
  height,
  scrollX,
  ppf,
  offline,
}: LaneCanvasProps) {
  const session = useSession();
  const ref = useRef<HTMLCanvasElement>(null);
  const [bump, setBump] = useState(0);
  const hasMedia = clips.some((c) => c.type === 'video' || c.type === 'image' || c.type === 'audio');

  useEffect(() => {
    const a = session.thumbs.film.subscribe(() => setBump((n) => n + 1));
    const b = session.thumbs.wave.subscribe(() => setBump((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, [session]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) drawLane(ctx, project, clips, { scrollX, ppf, width, height, dpr, offline }, session.thumbs);
  }, [project, clips, width, height, scrollX, ppf, offline, bump, session]);

  if (!hasMedia) return null;
  return <canvas ref={ref} className="lane__canvas" style={{ width, height }} />;
}, sameLanePicture);

// ───────────────────────────────────────────────────────────────── clip ──

interface ClipViewProps {
  clip: Clip;
  ppf: number;
  height: number;
  /** What the clip's track is called by its place: V1, A2. */
  track: string;
  settings: Project['settings'];
  /** The track is locked: the clip is there to be read, not to be selected. */
  locked: boolean;
  /** This is the clip Tab stops at. */
  tabStop: boolean;
  /** The keyboard is on this clip, and was brought there by the keyboard. */
  focused: boolean;
  selected: boolean;
  transSel: 'in' | 'out' | null;
  /** Frames of the incoming transition that sit before this clip's start (two-sided cuts). */
  transBefore: number;
  transLen: number;
  peerColor: string | null;
  peerName: string | null;
  hint: 'in' | 'out' | 'all' | null;
  /** The side whose fade handle is held, if one is. */
  fading: 'in' | 'out' | null;
  /** Whether that handle has been taken anywhere yet. From then on it marks the end of the fade. */
  fadeMoved: boolean;
  /** The media is not in the project any more, or its file is on neither this device nor the server. */
  missing: boolean;
  /** This browser has no decoder for what the clip shows of its media. */
  undecodable: boolean;
  /** The clip shares frames with another clip of its track. */
  overlapping: boolean;
}

const ClipView = memo(function ClipView({
  clip,
  ppf,
  height,
  track,
  settings,
  locked,
  tabStop,
  focused,
  selected,
  transSel,
  transBefore,
  transLen,
  peerColor,
  peerName,
  hint,
  fading,
  fadeMoved,
  missing,
  undecodable,
  overlapping,
}: ClipViewProps) {
  const w = clipWidth(clip.duration, ppf);
  const Icon = ICONS[clip.type];
  const color = clip.label ?? CLIP_TYPE_COLORS[clip.type];
  const roomy = w > LABEL_MIN_W;
  // The least a transition is drawn at, so it can be grabbed. On a short clip that would leave
  // nothing of the clip itself to take hold of, so there it gives way.
  const grip = Math.min(6, w * 0.3);
  const fx = clip.effects.length > 0;
  const graded = !!clip.grade && clip.grade.enabled;
  const keyTimes = useMemo(
    () => (selected ? keyframeTimes(clip) : []),
    [clip.keyframes, clip.duration, selected], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const label =
    clip.type === 'text' && clip.text ? clip.text.content.replace(/\s+/g, ' ') : clip.name || clip.type;

  return (
    <div
      className="clip"
      role="option"
      aria-label={describeClip(clip, track, settings, { offline: missing, undecodable, overlapping })}
      aria-selected={selected}
      aria-disabled={locked || undefined}
      tabIndex={tabStop ? 0 : -1}
      data-clip={clip.id}
      data-type={clip.type}
      data-selected={selected}
      data-focus={focused || undefined}
      data-disabled={!clip.enabled}
      data-hint={hint ?? undefined}
      data-missing={missing}
      data-overlap={overlapping || undefined}
      data-compact={height < 40}
      data-narrow={w < NARROW_W}
      style={{
        left: clip.start * ppf,
        width: w,
        height,
        ['--c' as string]: color,
        ['--peer' as string]: peerColor ?? 'transparent',
      }}
    >
      {roomy && (
        <div className="clip__label">
          <Icon />
          <span className="clip__name">{label}</span>
          {missing && (
            <span className="clip__chip">
              <CircleAlert />
              Offline
            </span>
          )}
          {undecodable && !missing && (
            <span className="clip__chip">
              <FileWarning />
              Unsupported
            </span>
          )}
          {overlapping && (
            <span className="clip__chip clip__chip--warn">
              <Layers2 />
              Overlap
            </span>
          )}
          {clip.linkId && <Link2 className="clip__flag" />}
          {clip.freeze && (
            <span className="clip__chip">
              <Snowflake />
              Freeze
            </span>
          )}
          {!clip.freeze && (clip.speed !== 1 || clip.reverse) && (
            <span className="clip__chip">
              <Gauge />
              {clip.reverse ? '−' : ''}
              {Math.round(clip.speed * 100)}%
            </span>
          )}
          {graded && <Blend className="clip__flag" />}
          {fx && (
            <span className="clip__chip">
              <Sparkles />
              {clip.effects.length}
            </span>
          )}
        </div>
      )}
      {clip.transIn && transLen > 0 && (
        <div
          className="clip__trans clip__trans--in"
          data-handle="trans-in"
          data-selected={transSel === 'in'}
          style={{ left: -transBefore * ppf, width: Math.max(grip, transLen * ppf) }}
        >
          <i data-trans-edge />
        </div>
      )}
      {clip.transOut && (
        <div
          className="clip__trans clip__trans--out"
          data-handle="trans-out"
          data-selected={transSel === 'out'}
          style={{ width: Math.max(grip, Math.min(clip.transOut.duration, clip.duration) * ppf) }}
        >
          <i data-trans-edge />
        </div>
      )}
      {clip.type === 'audio' && roomy && (
        <>
          <div
            className="clip__fade clip__fade--in"
            data-handle="fade-in"
            data-held={fading === 'in'}
            style={{ left: fadeHandleAt(clip.fadeIn * ppf, fading === 'in' && fadeMoved) }}
          />
          <div
            className="clip__fade clip__fade--out"
            data-handle="fade-out"
            data-held={fading === 'out'}
            style={{ right: fadeHandleAt(clip.fadeOut * ppf, fading === 'out' && fadeMoved) }}
          />
        </>
      )}
      <div className="clip__trim clip__trim--l" data-handle="start" />
      <div className="clip__trim clip__trim--r" data-handle="end" />
      {/* After the trim handles, so that a keyframe at the very edge of the clip can be taken hold of. */}
      {keyTimes.map((t) => (
        <i key={t} className="clip__kf" data-handle="keyframe" data-t={t} style={{ left: t * ppf }} />
      ))}
      {overlapping && <i className="clip__overlap" />}
      {peerColor && <span className="clip__peer">{peerName}</span>}
    </div>
  );
});

export { useProject };
