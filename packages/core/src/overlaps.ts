/**
 * Clips of one track never share frames, and every edit keeps it that way. Two things can still
 * bring it about, because neither of them can know of the other clip: two people each placing a
 * clip on the same frames at the same moment, and an undo that brings a clip back to where someone
 * else has put one since. What is here finds such clips and moves them apart.
 */
import { makeTrack } from './defaults';
import { clipEnd, clipsOnTrack, tracksOf } from './query';
import type { Clip, Edit, ID, Project, Track } from './types';

/** Every two clips that share frames on a track, the one that starts first (or has the lesser id) first. */
export function overlappingPairs(p: Project): [Clip, Clip][] {
  const pairs: [Clip, Clip][] = [];
  for (const track of Object.values(p.tracks)) {
    // The clips before the one being looked at that have not ended by where it starts.
    let open: Clip[] = [];
    for (const c of clipsOnTrack(p, track.id)) {
      open = open.filter((e) => clipEnd(e) > c.start);
      for (const e of open) pairs.push([e, c]);
      open.push(c);
    }
  }
  return pairs;
}

/**
 * Whether two clips that share frames are as a change of frame rate leaves two very short ones it
 * rounds onto one frame: they begin together, and one of them is a single frame long. Nothing else
 * the rounding does makes clips meet.
 */
export const roundedTogether = (a: Clip, b: Clip): boolean =>
  a.start === b.start && Math.min(a.duration, b.duration) === 1;

/** The clips that share frames with another clip of their track. */
export function overlappingClips(p: Project): Set<ID> {
  const out = new Set<ID>();
  for (const [a, b] of overlappingPairs(p)) out.add(a.id).add(b.id);
  return out;
}

/**
 * Edits that take each of the given clips off the frames it shares with other clips of its track.
 * A clip keeps its place in time and moves to a track of the same kind that is free there: picture
 * to one above its own, so that it is not hidden under what it gave way to, sound to any. When no
 * track has room a new one is added. Clips that share frames with nothing stay where they are.
 */
export function separateClips(p: Project, ids: Iterable<ID>): Edit[] {
  const moving = new Map<ID, Clip>();
  for (const id of ids) if (Object.hasOwn(p.clips, id)) moving.set(id, p.clips[id]);
  if (!moving.size) return [];

  /** The frames taken on each track, without the clips that are free to move. */
  const taken = new Map<ID, [number, number][]>();
  const takenOn = (trackId: ID): [number, number][] => {
    let spans = taken.get(trackId);
    if (!spans) {
      spans = [];
      for (const c of clipsOnTrack(p, trackId)) if (!moving.has(c.id)) spans.push([c.start, clipEnd(c)]);
      taken.set(trackId, spans);
    }
    return spans;
  };
  const fits = (c: Clip, trackId: ID): boolean =>
    takenOn(trackId).every(([start, end]) => end <= c.start || start >= clipEnd(c));

  const lists: Record<Track['kind'], Track[]> = {
    video: tracksOf(p).video.slice(),
    audio: tracksOf(p).audio.slice(),
  };
  const edits: Edit[] = [];
  // In an order that does not depend on how the clips were handed over.
  const inOrder = Array.from(moving.values()).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  for (const c of inOrder) {
    const home = p.tracks[c.trackId];
    if (!home) continue;
    if (fits(c, home.id)) {
      takenOn(home.id).push([c.start, clipEnd(c)]);
      continue;
    }
    const list = lists[home.kind];
    const above = home.kind === 'video' ? list.findIndex((t) => t.id === home.id) + 1 : 0;
    let target = list.find((t, i) => i >= above && t.id !== home.id && !t.locked && fits(c, t.id));
    if (!target) {
      target = makeTrack(home.kind, list.length ? list[list.length - 1].order + 1 : 0);
      edits.push({ op: 'addTrack', track: target });
      list.push(target);
      taken.set(target.id, []);
    }
    takenOn(target.id).push([c.start, clipEnd(c)]);
    edits.push({ op: 'updateClip', id: c.id, patch: { trackId: target.id } });
  }
  return edits;
}
