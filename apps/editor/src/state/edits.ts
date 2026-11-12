/**
 * Edit planning that sits between the commands and the core operations: which clips a command may
 * touch, and the multi-step edits the commands assemble. Pure functions of the project, so they
 * can be tested without a browser.
 */
import {
  adjacentNext,
  applyEdits,
  clamp,
  clipEnd,
  deleteRange,
  displayTracks,
  isRegionFree,
  openGap,
  pasteClips,
  rippleCloseGap,
  sourceTimeAt,
  trackLabel,
  tracksOf,
  type Clip,
  type Edit,
  type ID,
  type OpResult,
  type Project,
  type RippleResult,
} from '@tandem/core';

/** The ids that name a clip on a track that is not locked. A lock protects a track from every edit. */
export function unlocked(p: Project, ids: Iterable<ID>): ID[] {
  const out: ID[] = [];
  for (const id of ids) {
    const c = p.clips[id];
    if (c && !p.tracks[c.trackId]?.locked) out.push(id);
  }
  return out;
}

const unlockedTracks = (p: Project): ID[] =>
  Object.values(p.tracks)
    .filter((t) => !t.locked)
    .map((t) => t.id);

/**
 * Copies of the given clips, placed straight after the last of them. Where something is already
 * there, room is made first by pushing everything from that point on later, on every unlocked
 * track, so that the copies overwrite nothing and what follows stays in sync.
 */
export function duplicateClips(p: Project, ids: ID[]): OpResult {
  const clips = unlocked(p, ids).map((id) => p.clips[id]);
  if (!clips.length) return { edits: [], created: [] };
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map(clipEnd));
  const by = end - start;
  const free = clips.every((c) => isRegionFree(p, c.trackId, c.start + by, clipEnd(c) + by));
  const room = free ? [] : openGap(p, unlockedTracks(p), end, by);
  const copies = pasteClips(room.length ? applyEdits(p, room) : p, clips, end);
  return { edits: [...room, ...copies.edits], created: copies.created };
}

/**
 * Close the gap under `frame` wherever an unlocked track has one. Closing it on one track carries
 * the others along, so each track is looked at as the ones before it have left the timeline.
 * `refused` is set only when there was a gap and none of them could be closed.
 */
export function closeGapsAt(p: Project, frame: number): RippleResult {
  const edits: Edit[] = [];
  let working = p;
  let refused: string | null = null;
  for (const t of displayTracks(p)) {
    if (t.locked) continue;
    const r = rippleCloseGap(working, t.id, frame);
    refused ??= r.refused;
    if (!r.edits.length) continue;
    edits.push(...r.edits);
    working = applyEdits(working, r.edits);
  }
  return { edits, refused: edits.length ? null : refused };
}

/**
 * Take the frames `start`…`end` out of every unlocked track and close the time they occupied. A
 * locked track stays as it is, so the edit is refused when that would leave half of a linked pair
 * behind: its partner is about to be cut into or moved.
 */
export function rippleDeleteRange(p: Project, start: number, end: number): RippleResult {
  if (end <= start) return { edits: [], refused: null };
  const moving = new Set<ID>();
  for (const c of Object.values(p.clips)) {
    if (c.linkId && clipEnd(c) > start && !p.tracks[c.trackId]?.locked) moving.add(c.linkId);
  }
  for (const c of Object.values(p.clips)) {
    const track = p.tracks[c.trackId];
    if (c.linkId && track?.locked && moving.has(c.linkId)) {
      const name = track.name || trackLabel(p, track);
      return { edits: [], refused: `Unlock ${name} to ripple: a linked clip on it has to move too.` };
    }
  }
  return { edits: deleteRange(p, unlockedTracks(p), start, end, true), refused: null };
}

/**
 * Where a transition dropped on one side of a clip belongs. A clip's own `out` transition fades it
 * to nothing, so on a cut, where the next clip follows without a gap, the transition is the next
 * clip's `in`: the form that mixes the two.
 */
export function transitionTarget(
  p: Project,
  clipId: ID,
  side: 'in' | 'out',
): { clipId: ID; side: 'in' | 'out' } {
  const clip = p.clips[clipId];
  const next = clip && side === 'out' ? adjacentNext(p, clip) : null;
  return next && next.type !== 'audio' ? { clipId: next.id, side: 'in' } : { clipId, side };
}

/**
 * The clip a match frame at `frame` is about and the source time it shows there: the first of
 * `preferred` that has media under the frame, else the top-most picture, else the first sound.
 */
export function matchFrameAt(
  p: Project,
  frame: number,
  preferred: ID[] = [],
): { clip: Clip; time: number } | null {
  const under = (c: Clip | undefined): c is Clip =>
    !!c && !!c.assetId && !!p.assets[c.assetId] && c.start <= frame && frame < clipEnd(c);
  const { video, audio } = tracksOf(p);
  const order = new Map(
    [...video]
      .reverse()
      .concat(audio)
      .map((t, i) => [t.id, i]),
  );
  // Left to itself it goes by what is on screen: a disabled clip or a hidden track is not.
  const candidates = Object.values(p.clips)
    .filter((c) => under(c) && c.enabled && order.has(c.trackId) && !p.tracks[c.trackId].hidden)
    .sort((a, b) => order.get(a.trackId)! - order.get(b.trackId)!);
  const clip = preferred.map((id) => p.clips[id]).find(under) ?? candidates[0];
  if (!clip) return null;
  const length = p.assets[clip.assetId!].duration;
  const time = sourceTimeAt(clip, frame - clip.start, p);
  return { clip, time: length > 0 ? clamp(time, 0, length) : 0 };
}

/**
 * Clips on unlocked tracks to one side of `frame`. The clip under the frame belongs to both sides:
 * `right` is everything still to play from there, `left` everything that has started by then.
 */
export function clipsBeside(p: Project, frame: number, side: 'left' | 'right'): ID[] {
  const ids = Object.values(p.clips)
    .filter((c) => (side === 'right' ? clipEnd(c) > frame : c.start < frame))
    .sort((a, b) => a.start - b.start)
    .map((c) => c.id);
  return unlocked(p, ids);
}

/** The frame of the nearest marker after (`1`) or before (`-1`) `frame`, if there is one. */
export function markerBeside(p: Project, frame: number, dir: 1 | -1): number | null {
  let best: number | null = null;
  for (const m of Object.values(p.markers)) {
    if (dir === 1 ? m.frame <= frame : m.frame >= frame) continue;
    if (best === null || (dir === 1 ? m.frame < best : m.frame > best)) best = m.frame;
  }
  return best;
}

/**
 * What can be pasted into `p` from copied clips: a clip whose media is not in this project's pool
 * (it was copied in another project, or the media was removed since) would arrive permanently
 * offline with nothing to relink, so it is left out. A grade pointing at a missing LUT loses only
 * the LUT.
 */
export function pasteable(p: Project, items: Clip[]): { clips: Clip[]; missing: number } {
  const clips: Clip[] = [];
  for (const c of items) {
    if (c.assetId && !p.assets[c.assetId]) continue;
    const lut = c.grade?.lutId;
    clips.push(lut && !p.assets[lut] && c.grade ? { ...c, grade: { ...c.grade, lutId: null } } : c);
  }
  return { clips, missing: items.length - clips.length };
}
