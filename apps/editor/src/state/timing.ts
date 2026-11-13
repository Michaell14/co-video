/**
 * Timing edits made by number rather than by dragging in the timeline: speed, direction, length and
 * position. Pure functions of the project, so they can be tested without a browser.
 */
import {
  applyEdits,
  clipEnd,
  clipsOnTrack,
  deepEqual,
  hasSourceTime,
  neighbors,
  placeClips,
  retime,
  rippleTrim,
  setSpeed,
  trimClips,
  type Clip,
  type Comment,
  type Edit,
  type ID,
  type Marker,
  type Project,
} from '@tandem/core';
import { markerEdits, trimSpans, type Rippled, type RippleSpan } from './edits';

/** What a change of speed can alter on a clip. */
type Timing = Pick<Clip, 'speed' | 'duration' | 'sourceIn' | 'fadeIn' | 'fadeOut' | 'keyframes'>;

const timingOf = ({ speed, duration, sourceIn, fadeIn, fadeOut, keyframes }: Clip): Timing => ({
  speed,
  duration,
  sourceIn,
  fadeIn,
  fadeOut,
  keyframes,
});

const speedable = (c: Clip | undefined): c is Clip => !!c && hasSourceTime(c.type) && !c.freeze;

/** The clips among `ids` that have a speed, grouped the way they are linked. */
function speedGroups(p: Project, ids: ID[]): ID[][] {
  const groups = new Map<string, ID[]>();
  for (const id of new Set(ids)) {
    const c = p.clips[id];
    if (!speedable(c)) continue;
    const key = c.linkId ? `link:${c.linkId}` : `clip:${id}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  return [...groups.values()];
}

/**
 * The clip updates of a run of steps, gathered into one update for each clip. Every step of a
 * ripple moves all that follows it, so the steps of a large selection add up to many times more
 * updates than there are clips, and each of them would be written to the project and sent to
 * everyone in it.
 */
function clipUpdates() {
  const patches = new Map<ID, Partial<Clip>>();
  return {
    add(step: Edit[]): void {
      for (const e of step) {
        if (e.op !== 'updateClip') continue;
        const patch = patches.get(e.id);
        if (patch) Object.assign(patch, e.patch);
        else patches.set(e.id, { ...e.patch });
      }
    },
    edits: (): Edit[] => Array.from(patches, ([id, patch]) => ({ op: 'updateClip', id, patch })),
  };
}

/**
 * `setSpeed` for several clips, each named once. Each stops at the clip after it, also when that
 * clip is having its speed set too: a change of speed moves no clip's start, which is all the clip
 * before it stops at, so no answer depends on another.
 */
export function speedEach(p: Project, ids: ID[], speed: number, reverse?: boolean): Edit[] {
  return setSpeed(p, ids, speed, reverse);
}

/** How long each of `ids` is at `speed` when nothing stands in its way. */
function naturalLengths(p: Project, ids: ID[], speed: number, reverse?: boolean): Map<ID, number> {
  const lengths = new Map<ID, number>();
  for (const id of ids) {
    const clip = p.clips[id];
    if (!clip) continue;
    // `setSpeed` stops a clip at the one after it. In a project of its own it has nothing to stop at.
    for (const e of setSpeed({ ...p, clips: { [id]: clip } }, [id], speed, reverse)) {
      if (e.op === 'updateClip' && e.patch.duration !== undefined) lengths.set(e.id, e.patch.duration);
    }
  }
  return lengths;
}

/**
 * The clips of a group of linked clips whose change of length says how far what follows them
 * moves: the picture. What comes after a split edit stays against the picture, and the sound,
 * which changes by more or by less, stops at the next clip as it does without ripple editing. A
 * group that is sound alone goes by all of it.
 */
function deciding(p: Project, group: ID[]): ID[] {
  const picture = group.filter((id) => p.clips[id].type !== 'audio');
  return picture.length ? picture : group;
}

/**
 * What a group of linked clips does to every other clip under ripple editing when its clips go to
 * the lengths `length` gives: the ripple of a trim of their ends by the largest change among those
 * that decide (see `deciding`). It is planned on stand-ins without media, because how long these
 * clips can be is a matter of their new speed, which the caller works out, and not of the handles
 * they have at the old one.
 */
function rippleAfter(p: Project, group: ID[], length: (id: ID) => number): Rippled {
  const lead = deciding(p, group);
  const delta = Math.max(...lead.map((id) => length(id) - p.clips[id].duration));
  if (delta === 0) return { edits: [], refused: null, spans: [] };
  // A trim moves every end by the same frames, so it goes no further than its shortest clip has
  // frames to give. Sound that was cut shorter than what the picture now gives up would hold the
  // whole ripple to its own length, and leave a hole after the picture. It stays out of the trim
  // and stands in at the length it is headed for, out of the way of what moves up behind it.
  const trimmed = group.filter((id) => p.clips[id].duration + delta >= 1);
  const clips = { ...p.clips };
  for (const id of group) {
    const c = clips[id];
    const duration = trimmed.includes(id) ? c.duration : Math.min(c.duration, length(id));
    clips[id] = { ...c, assetId: null, duration };
  }
  const own = new Set(group);
  const r = rippleTrim({ ...p, clips }, trimmed, 'end', delta);
  return {
    edits: r.edits.filter((e) => !(e.op === 'updateClip' && own.has(e.id))),
    refused: r.refused,
    // Time is taken out, or put in, where the clips that decide end.
    spans: r.edits.length ? trimSpans(p, lead, 'end', delta) : [],
  };
}

/**
 * Set the speed of clips with ripple editing on. What follows moves by as many frames as the clips
 * become longer or shorter, on every track that can follow, as after a ripple trim of their ends:
 * a slowed clip plays all it played before instead of stopping at the next clip, and a faster one
 * leaves no hole. Linked clips ripple once (see `deciding`). Where the ripple is refused the speed
 * is set all the same, the way it is without ripple editing, and `refused` says why what follows
 * stayed where it is.
 */
export function speedRippleEdits(p: Project, ids: ID[], speed: number, reverse?: boolean): Rippled {
  const updates = clipUpdates();
  const spans: RippleSpan[] = [];
  let refused: string | null = null;
  let working = p;
  for (const group of speedGroups(p, ids)) {
    const natural = naturalLengths(working, group, speed, reverse);
    const ripple = rippleAfter(working, group, (id) => natural.get(id) ?? working.clips[id].duration);
    refused ??= ripple.refused;
    const moved = applyEdits(working, ripple.edits);
    const set = speedEach(moved, group, speed, reverse);
    updates.add(ripple.edits);
    updates.add(set);
    spans.push(...ripple.spans);
    working = applyEdits(moved, set);
  }
  return { edits: updates.edits(), refused, spans };
}

/** A clip that a change of speed left shorter than it plays at that speed: the next clip is in its way. */
export interface CutShort {
  id: ID;
  /** The length it was left with, in frames. */
  duration: number;
  /** The length it has when nothing is in its way. */
  natural: number;
}

/** The clips among `ids` that setting `speed` without a ripple cuts short. */
export function speedCutShort(p: Project, ids: ID[], speed: number, reverse?: boolean): CutShort[] {
  const natural = naturalLengths(
    p,
    ids.filter((id) => speedable(p.clips[id])),
    speed,
    reverse,
  );
  const short: CutShort[] = [];
  for (const e of speedEach(p, ids, speed, reverse)) {
    if (e.op !== 'updateClip' || e.patch.duration === undefined) continue;
    const full = natural.get(e.id) ?? e.patch.duration;
    if (e.patch.duration < full) short.push({ id: e.id, duration: e.patch.duration, natural: full });
  }
  return short;
}

/**
 * The clips a gesture has left cut short, once it has ended: the same as `speedCutShort` for the
 * speed it ended on, worked out from where the gesture began.
 */
export function speedGestureCutShort(g: SpeedGesture, p: Project): CutShort[] {
  const clips = { ...p.clips };
  const ids = Object.keys(g.from).filter((id) => clips[id]);
  for (const id of ids) clips[id] = { ...clips[id], ...g.from[id] };
  const short: CutShort[] = [];
  for (const id of ids) {
    const now = p.clips[id];
    const natural = naturalLengths({ ...p, clips }, [id], now.speed).get(id) ?? now.duration;
    if (now.duration < natural) short.push({ id, duration: now.duration, natural });
  }
  return short;
}

/**
 * Let a clip run on to `length` frames, or as far as the clip after it allows. The length is the
 * one its speed gives it, and it is not checked against the media the way a trim is: placed whole,
 * a clip whose media is not a whole number of frames long already runs a fraction of a frame past
 * the end of it, and a trim would stop a frame or two short of the room that was made.
 */
function lengthened(p: Project, id: ID, length: number): Edit[] {
  const c = p.clips[id];
  const { next } = neighbors(p, c);
  const end = Math.min(c.start + length, next?.start ?? Infinity);
  return end > clipEnd(c) ? [{ op: 'updateClip', id, patch: retime(c, c.start, end, p) }] : [];
}

/**
 * Give clips that a change of speed cut short the length they play at that speed (`wants`, by clip)
 * after all, by moving what follows out of their way on every track that can follow. It leaves the
 * timeline the change of speed leaves under ripple editing.
 */
export function makeRoomEdits(p: Project, wants: Readonly<Record<ID, number>>): Rippled {
  const updates = clipUpdates();
  const spans: RippleSpan[] = [];
  let refused: string | null = null;
  let working = p;
  for (const group of speedGroups(p, Object.keys(wants))) {
    const ripple = rippleAfter(working, group, (id) => wants[id]);
    refused ??= ripple.refused;
    if (ripple.refused) continue;
    const moved = applyEdits(working, ripple.edits);
    const grown = group.flatMap((id) => lengthened(moved, id, wants[id]));
    updates.add(ripple.edits);
    updates.add(grown);
    spans.push(...ripple.spans);
    working = applyEdits(moved, grown);
  }
  const edits = updates.edits();
  return { edits, refused: edits.length ? null : refused, spans };
}

/** Start frames of clips, or frames of markers, by id. */
type Frames = Record<ID, number>;

const startsOf = (clips: Project['clips']): Frames =>
  Object.fromEntries(Object.values(clips).map((c) => [c.id, c.start]));

const framesOf = (markers: Project['markers']): Frames =>
  Object.fromEntries(Object.values(markers).map((m) => [m.id, m.frame]));

/** Where a gesture that ripples found, or left, everything its ripple can move. */
interface Placed {
  clips: Frames;
  /** Null when the markers do not follow ripple edits. */
  markers: Frames | null;
}

const placedIn = (p: Project, markers: boolean): Placed => ({
  clips: startsOf(p.clips),
  markers: markers ? framesOf(p.markers) : null,
});

/**
 * A change of speed made in many small steps: a scrub of the number, a drag of the slider. A new
 * speed changes a clip's length, the next clip can cut that short, and going back does not undo
 * the cut. So no step builds on the one before. Each is `setSpeed` for the clips as the gesture
 * found them, in the project as it is at that moment: dragging down to 70% and back up leaves the
 * clips exactly as they were, whatever else is edited meanwhile, by whoever.
 */
export interface SpeedGesture {
  /** The clips the speed is set on. */
  ids: ID[];
  /** The timing of those that have a speed, as the gesture found it. */
  from: Record<ID, Timing>;
  /** The same, as the gesture's last step left it. */
  left: Record<ID, Timing>;
  /**
   * Set when the gesture ripples: every step moves what follows the clips, so the gesture also
   * keeps where every clip (and marker) was when it began and after its last step, and each step
   * is planned on the timeline as it was found.
   */
  ripple: { from: Placed; left: Placed } | null;
}

export interface SpeedGestureOptions {
  /** Ripple editing is on: what follows the clips moves with their ends. */
  ripple?: boolean;
  /** Markers follow ripple edits. */
  markers?: boolean;
}

/**
 * The gesture to take the next step with: `g` while it is still about the clips `ids` and nothing
 * else has re-timed one of them since its last step (an undo, somebody's trim), a new one
 * otherwise. Where it began no longer describes a clip that was re-timed under it. A gesture that
 * ripples starts anew as well when anything has moved, come or gone on the timeline since its last
 * step: putting things back where it found them would undo what somebody else did meanwhile.
 */
export function speedGesture(
  g: SpeedGesture | null,
  p: Project,
  ids: ID[],
  { ripple = false, markers = false }: SpeedGestureOptions = {},
): SpeedGesture {
  const asLeft = (id: ID) => !!p.clips[id] && deepEqual(timingOf(p.clips[id]), g?.left[id]);
  const placed = ripple ? placedIn(p, markers) : null;
  if (
    g &&
    deepEqual(g.ids, ids) &&
    Object.keys(g.from).every(asLeft) &&
    deepEqual(g.ripple?.left ?? null, placed)
  )
    return g;
  const from: Record<ID, Timing> = {};
  for (const id of ids) {
    const c = p.clips[id];
    if (speedable(c)) from[id] = timingOf(c);
  }
  return { ids, from, left: from, ripple: placed && { from: placed, left: placed } };
}

/**
 * One step of a gesture in the project as it is now. Each patch also restores whatever an earlier
 * step changed and this one does not (a fade it shortened, a source range it moved). A gesture
 * that ripples plans the step on the timeline as it found it, and the edits are what takes the
 * project from where the last step left it to that plan.
 */
export function speedEdits(g: SpeedGesture, p: Project, speed: number): Edit[] {
  const clips = { ...p.clips };
  for (const [id, from] of Object.entries(g.from)) if (clips[id]) clips[id] = { ...clips[id], ...from };
  if (!g.ripple) {
    return speedEach({ ...p, clips }, g.ids, speed).map((e) =>
      e.op === 'updateClip' ? { ...e, patch: { ...g.from[e.id], ...e.patch } } : e,
    );
  }
  const { from } = g.ripple;
  for (const [id, start] of Object.entries(from.clips)) if (clips[id]) clips[id] = { ...clips[id], start };
  const markers: Record<ID, Marker> = { ...p.markers };
  for (const [id, frame] of Object.entries(from.markers ?? {})) {
    if (markers[id]) markers[id] = { ...markers[id], frame };
  }
  const found: Project = { ...p, clips, markers };
  const plan = speedRippleEdits(found, g.ids, speed);
  const follow = from.markers ? markerEdits(found, plan.edits, plan.spans) : [];
  const planned = applyEdits(found, [...plan.edits, ...follow]);
  const edits: Edit[] = [];
  for (const c of Object.values(planned.clips)) {
    const now = p.clips[c.id];
    const patch: Partial<Clip> = g.from[c.id] ? timingOf(c) : {};
    if (now.start !== c.start) patch.start = c.start;
    if (Object.keys(patch).length) edits.push({ op: 'updateClip', id: c.id, patch });
  }
  for (const m of Object.values(planned.markers)) {
    if (p.markers[m.id].frame !== m.frame) edits.push({ op: 'setMarker', marker: m });
  }
  return edits;
}

/** `g` after its step has been committed and `p` is what came of it. */
export function speedStepped(g: SpeedGesture, p: Project): SpeedGesture {
  const left: Record<ID, Timing> = {};
  for (const id of Object.keys(g.from)) if (p.clips[id]) left[id] = timingOf(p.clips[id]);
  const ripple = g.ripple && { from: g.ripple.from, left: placedIn(p, !!g.ripple.from.markers) };
  return { ...g, left, ripple };
}

/** Play the given clips backwards or forwards. Nothing but the direction changes. */
export function reverseEdits(p: Project, ids: ID[], reverse: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const id of ids) {
    const c = p.clips[id];
    if (c && hasSourceTime(c.type) && !c.freeze && c.reverse !== reverse)
      edits.push({ op: 'updateClip', id, patch: { reverse } });
  }
  return edits;
}

export interface DurationResult extends Rippled {
  /** True when some clip could not reach the length asked for (its media or a neighbour ends first). */
  limited: boolean;
}

/**
 * Give clips an exact length by moving their end. Each entry of `groups` is a clip followed by the
 * clips that are trimmed with it (its linked partners): the first one gets `duration`, the others
 * the same change. Goes through the trim operations, so a clip stops at the end of its media and,
 * unless `ripple` moves them along, at the next clip.
 */
export function durationEdits(p: Project, groups: ID[][], duration: number, ripple: boolean): DurationResult {
  const want = Math.max(1, Math.round(duration));
  const edits: Edit[] = [];
  const spans: RippleSpan[] = [];
  const done = new Set<ID>();
  const leads: ID[] = [];
  let working = p;
  let refused: string | null = null;
  for (const group of groups) {
    const lead = working.clips[group[0]];
    if (!lead || done.has(lead.id)) continue;
    for (const id of group) done.add(id);
    leads.push(lead.id);
    const delta = want - lead.duration;
    if (delta === 0) continue;
    let step: Edit[];
    if (ripple) {
      const r = rippleTrim(working, group, 'end', delta);
      refused ??= r.refused;
      step = r.edits;
    } else step = trimClips(working, group, 'end', delta);
    if (!step.length) continue;
    const after = applyEdits(working, step);
    // The trim stops where the media or the ripple does, so the frames it moved are read back.
    if (ripple)
      spans.push(...trimSpans(working, group, 'end', after.clips[lead.id].duration - lead.duration));
    edits.push(...step);
    working = after;
  }
  const limited = leads.some((id) => working.clips[id]?.duration !== want);
  return { edits, refused: edits.length ? null : refused, spans, limited };
}

export interface MoveResult {
  edits: Edit[];
  /** True when clips in the way kept the move short of the place asked for. */
  limited: boolean;
}

/**
 * Move clips together so that the earliest of them starts at `start`. A move by number never lands
 * on another clip: where the place asked for is taken, the clips go towards it as far as the first
 * clip in their way.
 */
export function moveEdits(p: Project, ids: ID[], start: number): MoveResult {
  const clips = ids.map((id) => p.clips[id]).filter((c): c is Clip => !!c);
  if (!clips.length) return { edits: [], limited: false };
  const moving = new Set(clips.map((c) => c.id));
  const first = Math.min(...clips.map((c) => c.start));
  const wanted = Math.max(0, Math.round(start)) - first;
  if (wanted === 0) return { edits: [], limited: false };

  const others = (c: Clip) => clipsOnTrack(p, c.trackId).filter((o) => !moving.has(o.id));
  const free = clips.every((c) =>
    others(c).every((o) => clipEnd(o) <= c.start + wanted || o.start >= clipEnd(c) + wanted),
  );
  let by = wanted;
  if (!free) {
    // Slide towards the target until the first clip on the way is touched.
    let room = Math.abs(wanted);
    for (const c of clips) {
      for (const o of others(c)) {
        if (wanted > 0 && o.start >= clipEnd(c)) room = Math.min(room, o.start - clipEnd(c));
        if (wanted < 0 && clipEnd(o) <= c.start) room = Math.min(room, c.start - clipEnd(o));
      }
    }
    by = Math.sign(wanted) * room;
  }
  const edits = by
    ? placeClips(
        p,
        clips.map((c) => ({ id: c.id, start: c.start + by, trackId: c.trackId })),
      )
    : [];
  return { edits, limited: by !== wanted };
}

/** Comment frames a frame-rate change moved, as `[before, after]`, so the way back is exact. */
export type Moved = Record<ID, [number, number]>;

/**
 * Where each comment sits once the frame rate has changed by the factor `k`, as `[before, after]`
 * for the ones that move. `back` is what the change now being taken back moved: a comment that
 * still stands where that left it returns to the frame it came from, because rounding twice could
 * put it one frame off.
 */
export function retimeComments(
  comments: readonly Pick<Comment, 'id' | 'frame'>[],
  k: number,
  back: Moved = {},
): Moved {
  const moved: Moved = {};
  for (const c of comments) {
    const was = back[c.id];
    const to = was && was[1] === c.frame ? was[0] : Math.round(c.frame * k);
    if (to !== c.frame) moved[c.id] = [c.frame, to];
  }
  return moved;
}
