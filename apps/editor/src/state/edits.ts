/**
 * Edit planning that sits between the commands and the core operations: which clips a command may
 * touch, and the multi-step edits the commands assemble. Pure functions of the project, so they
 * can be tested without a browser.
 */
import {
  applyEdits,
  clipEnd,
  displayTracks,
  isRegionFree,
  openGap,
  pasteClips,
  rippleCloseGap,
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
