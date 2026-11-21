/**
 * Timing edits made by number rather than by dragging in the timeline: speed, direction, length and
 * position. Pure functions of the project, so they can be tested without a browser.
 */
import {
  applyEdits,
  clipEnd,
  clipsOnTrack,
  deepEqual,
  flatRamp,
  hasSourceTime,
  linkedIds,
  mediaToStream,
  neighbors,
  placeClips,
  RAMP_GAP,
  RAMP_POINTS,
  rampTable,
  retime,
  rippleTrim,
  setRamp,
  setSpeed,
  shapeOf,
  shapeRamp,
  sourceSpan,
  sourceTimeAt,
  streamSpeed,
  tidyRamp,
  trackLabel,
  trimClips,
  withLinked,
  type Clip,
  type Comment,
  type Edit,
  type Follow,
  type GestureStep,
  type ID,
  type Marker,
  type Project,
  type RampChange,
  type RampPoint,
  type RampShape,
} from '@tandem/core';
import { markerEdits, rippleFollower, trimSpans, type Rippled, type RippleSpan } from './edits';
import { asRipple } from './follow';

/** What a change of speed can alter on a clip. */
type Timing = Pick<
  Clip,
  'speed' | 'ramp' | 'keepPitch' | 'duration' | 'sourceIn' | 'fadeIn' | 'fadeOut' | 'keyframes'
>;

const timingOf = ({
  speed,
  ramp,
  keepPitch,
  duration,
  sourceIn,
  fadeIn,
  fadeOut,
  keyframes,
}: Clip): Timing => ({
  speed,
  ramp,
  keepPitch,
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
 * A change of timing: one speed, or a speed ramp for each clip it names. Everything the planner
 * does for a change of speed (the ripple, the clip that is cut short and the room made for it, the
 * gesture that is one undo step) it does for either.
 */
export type Retime = { speed: number; reverse?: boolean } | RampChange;

const isRamp = (change: Retime): change is RampChange => 'ramps' in change;

/** A speed given as a bare number is that one speed. */
const asRetime = (change: number | Retime, reverse?: boolean): Retime =>
  typeof change === 'number' ? { speed: change, reverse } : change;

/** The order the clips of a track are listed in: by where they start, then by id. */
const byStart = (a: Clip, b: Clip): number => a.start - b.start || (a.id < b.id ? -1 : 1);

/** Every clip of the link group of `id` that has a speed, in the order of `byStart`. */
function linkGroup(p: Project, id: ID): ID[] {
  return linkedIds(p, id)
    .map((other) => p.clips[other])
    .filter(speedable)
    .sort(byStart)
    .map((c) => c.id);
}

/**
 * The whole link groups of the clips among `ids` that have a speed, whatever the linked-selection
 * switch says: a ramp is one for a picture and its sound, or the two would no longer play the same
 * moment together.
 */
export function rampGroups(p: Project, ids: ID[]): ID[][] {
  const timed = ids.filter((id) => speedable(p.clips[id]));
  return speedGroups(p, withLinked(p, timed)).map((group) => linkGroup(p, group[0]));
}

/**
 * The clip of a link group that its ramp is named for, and that the others follow: the first that
 * is not sound, else the first.
 */
export function rampLead(p: Project, group: ID[]): ID {
  const clips = group
    .map((id) => p.clips[id])
    .filter((c): c is Clip => !!c)
    .sort(byStart);
  return (clips.find((c) => c.type !== 'audio') ?? clips[0])?.id ?? group[0];
}

/**
 * The change that puts each of `groups` on a ready-made shape, laid over the stretch of media its
 * lead plays; takes it off its ramp (`none`); or makes it ready for points to be dragged
 * (`custom`): a clip at one speed gets a level ramp at that speed, as near as a ramp can be to it,
 * and a clip on a ramp keeps the one it has. So does a clip that is on the shape asked for: its
 * length was rounded to whole frames, and the shape laid again over what it now covers would be
 * another ramp, and another length, every time it is asked for. Null when a clip plays too little
 * media to hold the points: a shape that lost points would be another shape, or none.
 */
export function shapeChange(
  p: Project,
  groups: ID[][],
  shape: RampShape | 'none' | 'custom',
): RampChange | null {
  const ramps: Record<ID, RampPoint[] | null> = {};
  for (const group of groups) {
    const lead = p.clips[rampLead(p, group)];
    if (!lead) continue;
    if (shape === 'none') ramps[lead.id] = null;
    else if (lead.ramp && (shape === 'custom' || shapeOf(lead.ramp, lead.reverse) === shape)) {
      ramps[lead.id] = lead.ramp;
    } else {
      const { in: from, out: to } = sourceSpan(lead, p);
      const ramp =
        shape === 'custom' ? flatRamp(from, to, lead.speed) : shapeRamp(shape, from, to, lead.reverse);
      if (!ramp) return null;
      ramps[lead.id] = ramp;
    }
  }
  return { ramps };
}

/** What is said of a clip that plays too little media for the points of a ramp. */
export const TOO_SHORT_TO_RAMP = 'This clip is too short for a speed ramp.';

/**
 * The change that adds a point to the ramp of a group of linked clips, and where it puts it, in
 * seconds of the media: where the playhead (`frame`) shows the group's lead, or, when the playhead
 * is not on that clip or a point stands there already, in the middle of the widest gap between the
 * points over the stretch the clip plays. The point is put on the curve as it runs, so the speed
 * there is the one it was. A clip at one speed starts from a level ramp (see `shapeChange`).
 * `refused` says why no point can be added.
 */
export function addPointChange(
  p: Project,
  group: ID[],
  frame: number,
): { change: RampChange; m: number } | { refused: string } {
  const lead = p.clips[rampLead(p, group)];
  if (!speedable(lead)) return { refused: TOO_SHORT_TO_RAMP };
  const { in: from, out: to } = sourceSpan(lead, p);
  const ramp = lead.ramp ?? flatRamp(from, to, lead.speed);
  if (!ramp) return { refused: TOO_SHORT_TO_RAMP };
  if (ramp.length >= RAMP_POINTS) return { refused: `A ramp holds at most ${RAMP_POINTS} points.` };
  // Places are kept to the microsecond, and no two points stand closer than `RAMP_GAP`.
  const micro = (m: number): number => Math.round(m * 1e6) / 1e6;
  const free = (m: number): boolean => ramp.every((q) => Math.abs(q.m - m) >= RAMP_GAP);
  let m: number | null = null;
  if (frame >= lead.start && frame < clipEnd(lead)) {
    const shown = micro(sourceTimeAt(lead, frame - lead.start, p));
    if (free(shown)) m = shown;
  }
  if (m === null) {
    const stops = [from, ...ramp.map((q) => q.m).filter((at) => at > from && at < to), to];
    let widest = 0;
    for (let i = 1; i + 1 < stops.length; i++) {
      if (stops[i + 1] - stops[i] > stops[widest + 1] - stops[widest]) widest = i;
    }
    const middle = micro((stops[widest] + stops[widest + 1]) / 2);
    if (!free(middle)) return { refused: TOO_SHORT_TO_RAMP };
    m = middle;
  }
  const table = rampTable(ramp);
  const points = tidyRamp([...ramp, { m, v: streamSpeed(table, mediaToStream(table, m)) }]);
  if (!points || points.length !== ramp.length + 1) return { refused: TOO_SHORT_TO_RAMP };
  return { change: { ramps: { [lead.id]: points } }, m };
}

/**
 * The clips a change is worked out for, grouped the way they are linked. A ramp is set on whole
 * link groups, and so is one speed on a clip that is on a ramp: the clips linked to it come off
 * the ramp with it. Any other clip has its speed set by itself.
 */
function reached(p: Project, ids: ID[], change: Retime): ID[][] {
  if (isRamp(change)) return rampGroups(p, ids);
  return speedGroups(p, ids).map((group) =>
    group.some((id) => p.clips[id].ramp) ? linkGroup(p, group[0]) : group,
  );
}

/**
 * Why a change cannot be made at all: a clip it reaches is on a locked track. A lock protects a
 * track from every edit, and a clip linked to one on a ramp cannot stay behind, so nothing is
 * changed. Null when nothing is in the way.
 */
export function retimeRefusal(p: Project, ids: ID[], change: number | Retime): string | null {
  const to = asRetime(change);
  for (const id of reached(p, ids, to).flat()) {
    const track = p.tracks[p.clips[id].trackId];
    if (!track?.locked) continue;
    const name = track.name || trackLabel(p, track);
    return isRamp(to)
      ? `Unlock ${name} to ramp this clip: what is linked to it has to follow.`
      : `Unlock ${name} to change this clip's speed: what is linked to it has to follow.`;
  }
  return null;
}

/**
 * `setSpeed` for several clips, each named once. Each stops at the clip after it, also when that
 * clip is having its speed set too: a change of speed moves no clip's start, which is all the clip
 * before it stops at, so no answer depends on another.
 */
export function speedEach(p: Project, ids: ID[], speed: number, reverse?: boolean): Edit[] {
  return retimeEach(p, ids, { speed, reverse });
}

/**
 * The operation a change is: `setSpeed` or `setRamp`, in the project as it is. No edits when the
 * change is refused (see `retimeRefusal`).
 */
export function retimeEach(p: Project, ids: ID[], change: Retime): Edit[] {
  if (retimeRefusal(p, ids, change)) return [];
  return isRamp(change) ? setRamp(p, ids, change) : setSpeed(p, ids, change.speed, change.reverse);
}

/**
 * A project that holds the clips of `group` and, for each, the clip before it on its track, and
 * nothing else: all that says how a group comes out when nothing after it is in its way. A clip
 * that follows another of its group is placed by it, and is cut where the clip before it stands,
 * on the timeline as well. `setSpeed` stops a clip at the one after it and cannot be told not to;
 * here it finds none. And a group that is asked about by itself, among thousands that are asked
 * one after the other, does not have the whole timeline looked through for it.
 */
function unhindered(p: Project, group: ID[]): Project {
  const clips: Record<ID, Clip> = {};
  for (const id of group) {
    const c = p.clips[id];
    clips[id] = c;
    const { prev } = neighbors(p, c);
    if (prev) clips[prev.id] = prev;
  }
  return { ...p, clips };
}

/**
 * How a change leaves each clip it reaches from `ids` when no clip after it stands in its way:
 * the edits of the operation without its stop at the next clip. Each group of linked clips is
 * asked about by itself, as if it alone were changed: one that is let run on must not be found
 * lying in the way of the next.
 */
function unstopped(p: Project, ids: ID[], change: Retime): Edit[] {
  const edits: Edit[] = [];
  for (const group of reached(p, ids, change)) {
    if (isRamp(change)) {
      edits.push(...setRamp(unhindered(p, group), group, change, true));
    } else if (group.some((id) => p.clips[id].ramp)) {
      edits.push(...setSpeed(unhindered(p, group), group, change.speed, change.reverse));
    } else {
      for (const id of group) {
        // `setSpeed` stops a clip at the one after it. In a project of its own it has nothing to stop at.
        edits.push(...setSpeed({ ...p, clips: { [id]: p.clips[id] } }, [id], change.speed, change.reverse));
      }
    }
  }
  return edits;
}

/**
 * What each clip is left as by `edits`, by clip. Of `unstopped`: the length it has when nothing is
 * in its way and, for a clip that is placed by the one it follows, the frame it starts at.
 */
function placesIn(edits: Edit[]): Map<ID, Partial<Clip>> {
  const places = new Map<ID, Partial<Clip>>();
  for (const e of edits) if (e.op === 'updateClip') places.set(e.id, e.patch);
  return places;
}

/**
 * `p` with each clip that a change of ramp brings forward (`places`, of `unstopped`) beginning
 * where it will begin and ending where it ends now. The ripple of a change is planned around its
 * clips as they stand, and a sound that the ramp of its picture brings forward would be found in
 * the way, at the place it is leaving, of what moves up behind the picture. `p` itself when no
 * clip is brought forward.
 */
function broughtForward(p: Project, places: Map<ID, Partial<Clip>>): Project {
  let clips: Record<ID, Clip> | null = null;
  for (const [id, { start }] of places) {
    const c = p.clips[id];
    if (!c || start === undefined || start >= c.start) continue;
    clips ??= { ...p.clips };
    clips[id] = { ...c, start, duration: clipEnd(c) - start };
  }
  return clips ? { ...p, clips } : p;
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
 * Set the speed of clips, or put them on a ramp, with ripple editing on. What follows moves by as
 * many frames as the clips become longer or shorter, on every track that can follow, as after a
 * ripple trim of their ends: a slowed clip plays all it played before instead of stopping at the
 * next clip, and a faster one leaves no hole. Linked clips ripple once (see `deciding`). Where the
 * ripple is refused the change is made all the same, the way it is without ripple editing, and
 * `refused` says why what follows stayed where it is. A change that cannot be made at all (see
 * `retimeRefusal`) leaves no edits, and `refused` says why.
 */
export function speedRippleEdits(p: Project, ids: ID[], change: number | Retime, reverse?: boolean): Rippled {
  const { edits, refused, spans } = speedRipple(p, ids, asRetime(change, reverse));
  return { edits, refused, spans };
}

/** What a change of speed did to time after one group of linked clips. */
interface GroupRipple {
  /** The clips of the group that decide (see `deciding`). */
  lead: ID[];
  /** The frames it put in after them, or took out where less than 0: none where it was refused. */
  by: number;
}

/** `speedRippleEdits`, and what it did after each group, in the order of `reached`. */
function speedRipple(p: Project, ids: ID[], change: Retime): Rippled & { groups: GroupRipple[] } {
  const locked = retimeRefusal(p, ids, change);
  if (locked) return { edits: [], refused: locked, spans: [], groups: [] };
  const updates = clipUpdates();
  const spans: RippleSpan[] = [];
  const groups: GroupRipple[] = [];
  let refused: string | null = null;
  let working = p;
  for (const group of reached(p, ids, change)) {
    const free = unstopped(working, group, change);
    const places = placesIn(free);
    const natural = (id: ID): number => places.get(id)?.duration ?? working.clips[id].duration;
    const ahead = isRamp(change) ? broughtForward(working, places) : working;
    const ripple = rippleAfter(ahead, group, natural);
    refused ??= ripple.refused;
    let moved = applyEdits(working, ripple.edits);
    updates.add(ripple.edits);
    if (ahead !== working && ripple.edits.length) {
      // What follows has moved up to where a clip of the group is headed, past the place that clip
      // is leaving. Asked about there, the clip would take what now stands before it for the clip
      // before it. So the group is first put where the change takes it with nothing in its way,
      // and then asked again, to be stopped at what has come to stand after it.
      updates.add(free);
      moved = applyEdits(moved, free);
    }
    const set = retimeEach(moved, group, change);
    updates.add(set);
    spans.push(...ripple.spans);
    groups.push({ lead: deciding(working, group), by: ripple.spans[0]?.by ?? 0 });
    working = applyEdits(moved, set);
  }
  return { edits: updates.edits(), refused, spans, groups };
}

/** A clip that a change of speed left shorter than it plays at that speed: the next clip is in its way. */
export interface CutShort {
  id: ID;
  /** The length it was left with, in frames. */
  duration: number;
  /** The length it has when nothing is in its way. */
  natural: number;
  /**
   * Set when the change left a clip that is linked to this one beside the place its media now
   * plays (see `shortOf`). Room at the end of the clips does not take that clip there, so room for
   * them is made by making the change again (see `roomEdits`).
   */
  again?: Again;
}

/** The timing of a clip and where it starts: all that a change of speed or of ramp can alter on it. */
type Stood = Timing & Pick<Clip, 'start'>;

const stoodAs = (c: Clip): Stood => ({ ...timingOf(c), start: c.start });

/** A change that was made, kept so that it can be made again to the clips it names. */
export interface Again {
  change: Retime;
  /** Each clip as the change found it. */
  from: Record<ID, Stood>;
  /** Each clip as the change left it. */
  left: Record<ID, Stood>;
}

/**
 * The length a clip that was left at `start` with `duration` frames is short of, or null when it
 * is not cut short: `free` is what it is with nothing in its way. Room at its end has to be what
 * it lacks. A clip that follows another and found the next clip standing where its media now plays
 * is left as one frame of itself in another place. Room at its end would only let it run on from
 * there, out of step: it is `beside` its place.
 */
function shortOf(start: number, duration: number, free: Partial<Clip> | undefined): number | 'beside' | null {
  const natural = free?.duration;
  if (natural === undefined || duration >= natural) return null;
  return free?.start === undefined || free.start === start ? natural : 'beside';
}

/**
 * `short` as it is reported for a change that took the clips from `found` to `left`: a clip whose
 * group of linked clips holds one of `beside`, which the change left beside its place, says how the
 * change is made again.
 */
function toMakeAgain(
  found: Project,
  left: Project,
  short: CutShort[],
  beside: ID[],
  change: Retime,
): CutShort[] {
  const again: Again = { change, from: {}, left: {} };
  for (const id of beside.flatMap((one) => linkGroup(found, one))) {
    again.from[id] = stoodAs(found.clips[id]);
    again.left[id] = stoodAs(left.clips[id]);
  }
  return short.map((c) => (again.from[c.id] ? { ...c, again } : c));
}

/** The clips that making a change without a ripple cuts short: of `ids`, and of what it reaches with them. */
export function speedCutShort(p: Project, ids: ID[], change: number | Retime, reverse?: boolean): CutShort[] {
  const to = asRetime(change, reverse);
  const free = placesIn(unstopped(p, ids, to));
  const short: CutShort[] = [];
  const beside: ID[] = [];
  const edits = retimeEach(p, ids, to);
  for (const e of edits) {
    if (e.op !== 'updateClip' || e.patch.duration === undefined) continue;
    const start = e.patch.start ?? p.clips[e.id].start;
    const natural = shortOf(start, e.patch.duration, free.get(e.id));
    if (natural === 'beside') beside.push(e.id);
    else if (natural !== null) short.push({ id: e.id, duration: e.patch.duration, natural });
  }
  return short.length && beside.length ? toMakeAgain(p, applyEdits(p, edits), short, beside, to) : short;
}

/**
 * The clips a gesture has left cut short, once it has ended: the same as `speedCutShort` for the
 * step it ended on, worked out from where the gesture began. A gesture that was not told its last
 * step (see `speedStepped`) set a speed, and each clip has it. A step that was refused left no
 * clip short: it changed none.
 */
export function speedGestureCutShort(g: SpeedGesture, p: Project): CutShort[] {
  const found: Project = { ...p, clips: foundClips(g, p) };
  const ids = Object.keys(g.from).filter((id) => found.clips[id]);
  if (g.last && retimeRefusal(found, g.ids, g.last)) return [];
  // A step is worked out for the clips it was asked for: a clip that the gesture holds because it
  // is linked to one of them, and that the step did not reach, has no place here and is not short.
  const places = g.last && placesIn(unstopped(found, g.ids, g.last));
  const short: CutShort[] = [];
  const beside: ID[] = [];
  for (const id of ids) {
    const now = p.clips[id];
    // One speed takes a clip off its ramp. A clip that is on one still was not given the speed.
    if (!places && now.ramp) continue;
    const free = (places ?? placesIn(unstopped(found, [id], { speed: now.speed }))).get(id);
    const natural = shortOf(now.start, now.duration, free);
    if (natural === 'beside') beside.push(id);
    else if (natural !== null) short.push({ id, duration: now.duration, natural });
  }
  if (!short.length || !beside.length) return short;
  return toMakeAgain(found, p, short, beside, g.last ?? { speed: p.clips[beside[0]].speed });
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

/** Room that was made for clips that a change left cut short. */
export interface Room extends Rippled {
  /**
   * The project that `edits` and `spans` are a ripple of: what stands at a frame without being a
   * clip (a marker, a review comment) follows from where it stands there (see `rippleFollower`).
   */
  from: Project;
}

/**
 * Make room for the clips that a change left cut short (`short`, of `speedCutShort`): each gets
 * the length it plays with nothing in its way (see `makeRoomEdits`). Clips that say how the change
 * is made again get more than room at their end. They are put back as the change found them, and
 * the change is made to them with the ripple it has under ripple editing: a clip it left beside
 * its place is taken there by the clip it follows, once what stood there has moved. That is done
 * while they are as the change left them and the ripple is not refused; otherwise they are given
 * their room like the rest.
 */
export function roomEdits(p: Project, short: CutShort[]): Room {
  const wants = (list: CutShort[]): Record<ID, number> =>
    Object.fromEntries(list.map((c) => [c.id, c.natural]));
  const again = short.find((c) => c.again)?.again;
  const ids = Object.keys(again?.from ?? {});
  const plain = (): Room => ({ ...makeRoomEdits(p, wants(short)), from: p });
  if (!again || !ids.every((id) => p.clips[id] && deepEqual(stoodAs(p.clips[id]), again.left[id])))
    return plain();
  const clips = { ...p.clips };
  for (const id of ids) clips[id] = { ...clips[id], ...again.from[id] };
  const found: Project = { ...p, clips };
  const plan = speedRipple(found, ids, again.change);
  if (plan.refused) return plain();
  const planned = applyEdits(found, plan.edits);
  const updates = clipUpdates();
  updates.add(plan.edits.filter((e) => !(e.op === 'updateClip' && again.from[e.id])));
  // A clip that the change is made to again is written whole: the edits are read against the
  // project in which it is as the change found it.
  for (const id of ids) {
    if (!deepEqual(planned.clips[id], p.clips[id]))
      updates.add([{ op: 'updateClip', id, patch: stoodAs(planned.clips[id]) }]);
  }
  const room = makeRoomEdits(planned, wants(short.filter((c) => c.again !== again)));
  updates.add(room.edits);
  const edits = updates.edits();
  return {
    edits,
    refused: edits.length ? null : room.refused,
    spans: [...plan.spans, ...room.spans],
    from: found,
  };
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
  /** Null when comments and markers do not follow ripple edits. */
  markers: Frames | null;
}

const placedIn = (p: Project, markers: boolean): Placed => ({
  clips: startsOf(p.clips),
  markers: markers ? framesOf(p.markers) : null,
});

/**
 * A change of speed made in many small steps: a scrub of the number, a drag of the slider, a drag
 * of a point of a ramp. A new speed or ramp changes a clip's length, the next clip can cut that
 * short, and going back does not undo the cut. So no step builds on the one before. Each is
 * `setSpeed` or `setRamp` for the clips as the gesture found them, in the project as it is at that
 * moment: dragging down to 70% and back up leaves the clips exactly as they were, whatever else is
 * edited meanwhile, by whoever.
 */
export interface SpeedGesture {
  /** The clips the change is asked for. */
  ids: ID[];
  /** The timing of the clips it can reach that have a speed, as the gesture found it. */
  from: Record<ID, Timing>;
  /** The same, as the gesture's last step left it. */
  left: Record<ID, Timing>;
  /**
   * The last step, once the gesture has been told it (see `speedStepped`). A clip does not say
   * what was asked of it: the next clip may have cut it short, and a ramp is one for several clips.
   */
  last: Retime | null;
  /**
   * Set for a gesture that reaches whole groups of linked clips: where each of its clips started
   * when it began and after its last step. A change of ramp can move a clip that follows another,
   * and a gesture that returns puts it back.
   */
  starts: { from: Frames; left: Frames } | null;
  /**
   * Set when the gesture ripples: every step moves what follows the clips, so the gesture also
   * keeps where every clip (and marker) was when it began and after its last step, and each step
   * is planned on the timeline as it was found. `from` is one object through all the steps of a
   * gesture, and is what the gesture is known by where its steps are committed: where the review
   * comments were when it began is kept there (see `CommentMover`).
   */
  ripple: { from: Placed; left: Placed } | null;
}

export interface SpeedGestureOptions {
  /** Ripple editing is on: what follows the clips moves with their ends. */
  ripple?: boolean;
  /** Comments and markers follow ripple edits. */
  markers?: boolean;
  /**
   * The gesture is about to change a ramp. A ramp is set on whole groups of linked clips whatever
   * is selected, so the gesture is about all of them from the start: a linked clip it did not know
   * would be worked out anew from wherever the step before left it.
   */
  ramp?: boolean;
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
  { ripple = false, markers = false, ramp = false }: SpeedGestureOptions = {},
): SpeedGesture {
  const asLeft = (id: ID) => !!p.clips[id] && deepEqual(timingOf(p.clips[id]), g?.left[id]);
  const placed = ripple ? placedIn(p, markers) : null;
  if (
    g &&
    deepEqual(g.ids, ids) &&
    Object.keys(g.from).every(asLeft) &&
    deepEqual(g.ripple?.left ?? null, placed) &&
    (g.starts ? Object.keys(g.from).every((id) => p.clips[id].start === g.starts?.left[id]) : !ramp)
  )
    return g;
  // One speed set on a clip that is on a ramp takes the clips linked to it off the ramp as well.
  const grouped = ramp || ids.some((id) => !!p.clips[id]?.ramp);
  const from: Record<ID, Timing> = {};
  const began: Frames = {};
  // The clips it was asked for come first, as in a gesture of one speed for clips on no ramp: a
  // speed is set on each of those, and whoever reads it from the first clip reads the step's.
  for (const id of grouped ? [...ids, ...rampGroups(p, ids).flat()] : ids) {
    const c = p.clips[id];
    if (!speedable(c) || from[id]) continue;
    from[id] = timingOf(c);
    began[id] = c.start;
  }
  return {
    ids,
    from,
    left: from,
    ripple: placed && { from: placed, left: placed },
    last: null,
    starts: grouped ? { from: began, left: began } : null,
  };
}

/** The clips of `p`, with those of a gesture as it found them. */
function foundClips(g: SpeedGesture, p: Project): Record<ID, Clip> {
  const clips = { ...p.clips };
  for (const [id, from] of Object.entries(g.from)) if (clips[id]) clips[id] = { ...clips[id], ...from };
  for (const [id, start] of Object.entries(g.starts?.from ?? {})) {
    if (clips[id]) clips[id] = { ...clips[id], start };
  }
  return clips;
}

/** Whether a clip is on a locked track: no edit is made to it, by anything. */
const isLocked = (p: Project, c: Clip): boolean => !!p.tracks[c.trackId]?.locked;

/**
 * Whether a step asks for the ramps a gesture found: the way back. Setting the ramp a clip has
 * changes nothing, but worked out again, a clip that follows another can come out a millionth of
 * a second from where it was, and a drag that returns must leave no trace (see `unlessAsFound`).
 */
function isWayBack(g: SpeedGesture, change: Retime): boolean {
  if (!isRamp(change) || !g.starts) return false;
  return Object.entries(change.ramps).every(
    ([id, points]) => !g.from[id] || deepEqual(points && tidyRamp(points), g.from[id].ramp),
  );
}

/**
 * The edits of a step on the way back without those for a clip that they leave at the place and
 * the length it has in `found`: that clip is the one the gesture found, to the letter. What is
 * left are the clips that something new stands in the way of since the gesture began.
 */
function unlessAsFound(found: Project, edits: Edit[]): Edit[] {
  return edits.filter((e) => {
    if (e.op !== 'updateClip') return true;
    const c = found.clips[e.id];
    return !c || (e.patch.duration ?? c.duration) !== c.duration || (e.patch.start ?? c.start) !== c.start;
  });
}

/**
 * The change that leaves the clips of a gesture on the ramps its last step left them on: what a
 * gesture that was not told its last step (see `speedStepped`) takes that step to have been.
 */
function leftRamps(g: SpeedGesture, found: Project): RampChange {
  const ramps: Record<ID, RampPoint[] | null> = {};
  for (const group of rampGroups(found, g.ids)) {
    const lead = rampLead(found, group);
    ramps[lead] = g.left[lead]?.ramp ?? null;
  }
  return { ramps };
}

/**
 * One step of a gesture in the project as it is now. Each patch also restores whatever an earlier
 * step changed and this one does not (a fade it shortened, a source range it moved). A gesture
 * that ripples plans the step on the timeline as it found it, and the edits are what takes the
 * project from where the last step left it to that plan. Committed with `commit`, they take the
 * review comments from where the gesture found them to where the plan puts them, once the gesture
 * rests. A comment that somebody makes or moves meanwhile is taken from where it was put, on the
 * shot it was put on, by each step that follows.
 */
export function speedEdits(g: SpeedGesture, p: Project, step: number | Retime): Edit[] {
  const change = asRetime(step);
  const clips = foundClips(g, p);
  // A change that cannot be made leaves everything as the step before left it.
  if (retimeRefusal({ ...p, clips }, g.ids, change)) return [];
  if (!g.ripple) {
    const found: Project = { ...p, clips };
    const set = retimeEach(found, g.ids, change);
    const edits = (isWayBack(g, change) ? unlessAsFound(found, set) : set).map((e): Edit => {
      if (e.op !== 'updateClip') return e;
      const patch: Partial<Clip> = { ...g.from[e.id], ...e.patch };
      // A clip that an earlier step moved and this one leaves where the gesture found it.
      const start = g.starts?.from[e.id];
      if (start !== undefined && patch.start === undefined && p.clips[e.id].start !== start)
        patch.start = start;
      return { ...e, patch };
    });
    if (!g.starts) return edits;
    // A gesture that reaches whole groups can take steps that leave some of its clips alone: the
    // way back, or one speed set on clips of which only some are on a ramp. Those are as the
    // gesture found them, and are put back if an earlier step made something else of them.
    const done = new Set(edits.map((e) => (e.op === 'updateClip' ? e.id : null)));
    for (const [id, timing] of Object.entries(g.from)) {
      const now = p.clips[id];
      const start = g.starts.from[id];
      if (!now || done.has(id) || isLocked(p, now)) continue;
      if (now.start === start && deepEqual(timingOf(now), timing)) continue;
      edits.push({ op: 'updateClip', id, patch: now.start === start ? timing : { ...timing, start } });
    }
    return edits;
  }
  const { from } = g.ripple;
  for (const [id, start] of Object.entries(from.clips)) if (clips[id]) clips[id] = { ...clips[id], start };
  const markers: Record<ID, Marker> = { ...p.markers };
  for (const [id, frame] of Object.entries(from.markers ?? {})) {
    if (markers[id]) markers[id] = { ...markers[id], frame };
  }
  const found: Project = { ...p, clips, markers };
  const planOf = (to: Retime): Rippled & { groups: GroupRipple[] } => {
    const planned = speedRipple(found, g.ids, to);
    return isWayBack(g, to) ? { ...planned, edits: unlessAsFound(found, planned.edits) } : planned;
  };
  const plan = planOf(change);
  const follow = from.markers ? markerEdits(found, plan.edits, plan.spans) : [];
  const planned = applyEdits(found, [...plan.edits, ...follow]);
  // A clip that a change of ramp placed is written with its start, moved or not: its ramp, its
  // length, its in point and its place are one answer, and are written as one.
  const placed = new Set<ID>();
  for (const e of plan.edits) {
    if (e.op === 'updateClip' && e.patch.ramp !== undefined && e.patch.start !== undefined) placed.add(e.id);
  }
  const edits: Edit[] = [];
  for (const c of Object.values(planned.clips)) {
    const now = p.clips[c.id];
    // A clip the gesture holds on a locked track is one that no step of it reaches (a step that
    // would is refused), and that no ripple moves: it is as the gesture found it.
    if (isLocked(p, c)) continue;
    const patch: Partial<Clip> = g.from[c.id] ? timingOf(c) : {};
    if (now.start !== c.start || placed.has(c.id)) patch.start = c.start;
    if (Object.keys(patch).length) edits.push({ op: 'updateClip', id: c.id, patch });
  }
  for (const m of Object.values(planned.markers)) {
    if (p.markers[m.id].frame !== m.frame) edits.push({ op: 'setMarker', marker: m });
  }
  if (!from.markers) return edits;
  // A step is told apart by the change it made: each is planned on the same timeline. Asked for
  // only for a comment that came while the gesture was under way, with the very object that was
  // given as `last` then.
  const since = new Map<Retime, Follow>();
  // A gesture that was not told its last step set a speed on the clips it was asked for. A clip it
  // holds besides, because it is linked to one of them, may still have the speed it was found at.
  const asked = g.ids.map((id) => g.left[id]).find((timing) => timing);
  const last: Retime =
    g.last ?? (isRamp(change) ? leftRamps(g, found) : { speed: asked?.speed ?? change.speed });
  const gesture: GestureStep<Retime> = {
    of: from,
    last,
    since(at, frame) {
      let follow = since.get(at);
      if (!follow) since.set(at, (follow = stepFollower(found, planOf(at), planned, plan.groups)));
      return follow(frame);
    },
  };
  return asRipple(edits, rippleFollower(found, plan.edits, plan.spans), gesture);
}

/**
 * Where a step of a gesture that ripples, which left the clips at `planned` by `groups`, takes
 * what stands at a frame of the timeline as an earlier step left it, one that was planned on
 * `found` as `earlier`. By the rule of `rippleFollower`: along with the clip it stands on, and
 * where that clip has another length now, or there is none, with the time put in or taken out
 * after each group of clips since.
 */
function stepFollower(
  found: Project,
  earlier: Rippled & { groups: GroupRipple[] },
  planned: Project,
  groups: GroupRipple[],
): Follow {
  const then = applyEdits(found, earlier.edits);
  const edits: Edit[] = [];
  for (const c of Object.values(planned.clips)) {
    const was = then.clips[c.id];
    if (was && (was.start !== c.start || was.duration !== c.duration))
      edits.push({ op: 'updateClip', id: c.id, patch: { start: c.start, duration: c.duration } });
  }
  const end = (s: RippleSpan): number => (s.by < 0 ? s.from - s.by : s.from);
  const spans = groups
    .flatMap((group, i) => trimSpans(then, group.lead, 'end', group.by - (earlier.groups[i]?.by ?? 0)))
    // Latest first: then each begins at a frame of `then` that none before it has moved.
    .sort((a, b) => end(b) - end(a));
  return rippleFollower(then, edits, spans);
}

/**
 * `g` after its step has been committed and `p` is what came of it. `step` is what that step
 * asked for. A gesture that is not told sets a speed, and takes it from the clips afterwards.
 */
export function speedStepped(g: SpeedGesture, p: Project, step?: number | Retime): SpeedGesture {
  const left: Record<ID, Timing> = {};
  const stand: Frames = {};
  for (const id of Object.keys(g.from)) {
    const c = p.clips[id];
    if (!c) continue;
    left[id] = timingOf(c);
    stand[id] = c.start;
  }
  const ripple = g.ripple && { from: g.ripple.from, left: placedIn(p, !!g.ripple.from.markers) };
  const starts = g.starts && { from: g.starts.from, left: stand };
  return { ...g, left, ripple, last: step === undefined ? null : asRetime(step), starts };
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
