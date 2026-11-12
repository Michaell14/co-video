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
  placeClips,
  rippleTrim,
  setSpeed,
  trimClips,
  type Clip,
  type Comment,
  type Edit,
  type ID,
  type Project,
} from '@tandem/core';

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
}

/**
 * The gesture to take the next step with: `g` while it is still about the clips `ids` and nothing
 * else has re-timed one of them since its last step (an undo, somebody's trim), a new one
 * otherwise. Where it began no longer describes a clip that was re-timed under it.
 */
export function speedGesture(g: SpeedGesture | null, p: Project, ids: ID[]): SpeedGesture {
  const asLeft = (id: ID) => !!p.clips[id] && deepEqual(timingOf(p.clips[id]), g?.left[id]);
  if (g && deepEqual(g.ids, ids) && Object.keys(g.from).every(asLeft)) return g;
  const from: Record<ID, Timing> = {};
  for (const id of ids) {
    const c = p.clips[id];
    if (c && hasSourceTime(c.type) && !c.freeze) from[id] = timingOf(c);
  }
  return { ids, from, left: from };
}

/**
 * One step of a gesture in the project as it is now. Each patch also restores whatever an earlier
 * step changed and this one does not (a fade it shortened, a source range it moved).
 */
export function speedEdits(g: SpeedGesture, p: Project, speed: number): Edit[] {
  const clips = { ...p.clips };
  for (const [id, from] of Object.entries(g.from)) if (clips[id]) clips[id] = { ...clips[id], ...from };
  return setSpeed({ ...p, clips }, g.ids, speed).map((e) =>
    e.op === 'updateClip' ? { ...e, patch: { ...g.from[e.id], ...e.patch } } : e,
  );
}

/** `g` after its step has been committed and `p` is what came of it. */
export function speedStepped(g: SpeedGesture, p: Project): SpeedGesture {
  const left: Record<ID, Timing> = {};
  for (const id of Object.keys(g.from)) if (p.clips[id]) left[id] = timingOf(p.clips[id]);
  return { ...g, left };
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

export interface DurationResult {
  edits: Edit[];
  /** Ready-to-show reason when a ripple could not be made. */
  refused: string | null;
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
    edits.push(...step);
    working = applyEdits(working, step);
  }
  const limited = leads.some((id) => working.clips[id]?.duration !== want);
  return { edits, refused: edits.length ? null : refused, limited };
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
