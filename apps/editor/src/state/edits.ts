/**
 * Edit planning that sits between the commands and the core operations: which clips a command may
 * touch, and the multi-step edits the commands assemble. Pure functions of the project, so they
 * can be tested without a browser.
 */
import {
  adjacentNext,
  adjacentPrev,
  applyEdits,
  clamp,
  clipAt,
  clipAtRate,
  clipEnd,
  clipsOnTrack,
  deleteRange,
  displayTracks,
  handles,
  isRegionFree,
  linkedIds,
  neighbors,
  newId,
  openGap,
  pasteClips,
  placeClips,
  rippleCloseGap,
  rippleDelete,
  rippleTrim,
  rippleTrimTo,
  rollEdit,
  sameRate,
  setTransition,
  sourcePerFrame,
  sourceTimeAt,
  trackLabel,
  tracksOf,
  trimClips,
  trimRange,
  type Asset,
  type Clip,
  type Edge,
  type Edit,
  type ID,
  type Keyframe,
  type OpResult,
  type Project,
  type RippleResult,
  type Track,
  type Transition,
} from '@tandem/core';
import type { AttributeClipboard } from './ui';

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

// ─────────────────────────────────────────────── what a ripple carries along ──

/**
 * Time a ripple edit takes out of the sequence (`by` below zero) or puts into it, at `from`. In a
 * list, each span is in the frames the spans before it have left behind.
 */
export interface RippleSpan {
  from: number;
  by: number;
}

/** A ripple that also says what it did to time, for the things that are not clips: markers. */
export interface Rippled extends RippleResult {
  spans: RippleSpan[];
}

const NOT_RIPPLED: Rippled = { edits: [], refused: null, spans: [] };

/**
 * Where `frame` is once the spans have rippled through. What stood in time that was taken out
 * lands where that time began; what stood at the frame where time was put in moves along with the
 * clips that started there.
 */
export function rippledFrame(frame: number, spans: readonly RippleSpan[]): number {
  let f = frame;
  for (const s of spans) {
    if (s.by >= 0) f = f >= s.from ? f + s.by : f;
    else f = f >= s.from - s.by ? f + s.by : Math.min(f, s.from);
  }
  return f;
}

/**
 * Where the things that stand at a frame without being clips (markers, review comments) go when
 * a ripple has been through: a function from the frame before to the frame after. `p` is the
 * project before the ripple, `edits` what the ripple did to it and `spans` what it did to time.
 * Such a thing belongs to the clip it stands on, on the lowest picture track that has one there,
 * else on the first sound track that has, and goes where that clip goes: a ripple that only closes
 * up the titles on a track above leaves what stands on the shots below alone. When the edit cut
 * or removed that clip itself, or the frame is on empty time, it moves with the time the ripple
 * took out or put in.
 */
export function rippleFollower(
  p: Project,
  edits: readonly Edit[],
  spans: readonly RippleSpan[],
): (frame: number) => number {
  const moved = new Map<ID, number>();
  const cut = new Set<ID>();
  for (const e of edits) {
    if (e.op === 'removeClip') cut.add(e.id);
    if (e.op !== 'updateClip' || !p.clips[e.id]) continue;
    const before = p.clips[e.id];
    if (e.patch.duration !== undefined && e.patch.duration !== before.duration) cut.add(e.id);
    if (e.patch.start !== undefined) moved.set(e.id, e.patch.start - before.start);
  }
  const { video, audio } = tracksOf(p);
  const tracks = [...video, ...audio];
  return (frame) => {
    if (!spans.length) return frame;
    let on: Clip | null = null;
    for (const t of tracks) if ((on = clipAt(p, t.id, frame))) break;
    const to = on && !cut.has(on.id) ? frame + (moved.get(on.id) ?? 0) : rippledFrame(frame, spans);
    return Math.max(0, to);
  };
}

/**
 * Edits that take the markers along with a ripple, for the same commit as the ripple's own `edits`,
 * so that each marker stays on the shot it was put on (see `rippleFollower`).
 */
export function markerEdits(p: Project, edits: readonly Edit[], spans: readonly RippleSpan[]): Edit[] {
  const follow = rippleFollower(p, edits, spans);
  const out: Edit[] = [];
  for (const m of Object.values(p.markers)) {
    const frame = follow(m.frame);
    if (frame !== m.frame) out.push({ op: 'setMarker', marker: { ...m, frame } });
  }
  return out;
}

/** A stretch of a track that a ripple empties. */
interface Stretch {
  trackId: ID;
  start: number;
  end: number;
}

/**
 * The time a ripple closes once `removed` has been emptied, by the rule the ripple operations go
 * by: stretches that overlap in time make one hole, and it counts only where all of their tracks
 * are empty. `after` is the project with those stretches gone and nothing moved yet. Latest first,
 * so that no span shifts the frames of the next.
 */
function closedSpans(after: Project, removed: Stretch[]): RippleSpan[] {
  const spans: RippleSpan[] = [];
  const sorted = removed.slice().sort((a, b) => a.start - b.start);
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i].start;
    let end = sorted[i].end;
    const tracks = new Set<ID>([sorted[i].trackId]);
    for (i++; i < sorted.length && sorted[i].start < end; i++) {
      end = Math.max(end, sorted[i].end);
      tracks.add(sorted[i].trackId);
    }
    const kept = [...tracks]
      .flatMap((id) => clipsOnTrack(after, id))
      .filter((c) => c.start < end && clipEnd(c) > start)
      .sort((a, b) => a.start - b.start);
    let cursor = start;
    for (const c of kept) {
      if (c.start > cursor) spans.push({ from: cursor, by: cursor - c.start });
      cursor = Math.max(cursor, clipEnd(c));
    }
    if (cursor < end) spans.push({ from: cursor, by: cursor - end });
  }
  return spans.sort((a, b) => b.from - a.from);
}

/** Has frames on both sides of `frame`, so that a cut there leaves two parts. */
const straddles = (c: Clip, frame: number): boolean => c.start < frame && frame < clipEnd(c);

/** Delete clips and close the time they occupied. */
export function rippleDeleteClips(p: Project, ids: ID[]): Rippled {
  const r = rippleDelete(p, ids);
  if (!r.edits.length) return { ...r, spans: [] };
  const gone = [...new Set(ids)].map((id) => p.clips[id]).filter((c): c is Clip => !!c);
  const after = applyEdits(
    p,
    gone.map((c): Edit => ({ op: 'removeClip', id: c.id })),
  );
  const removed = gone.map((c) => ({ trackId: c.trackId, start: c.start, end: clipEnd(c) }));
  return { ...r, spans: closedSpans(after, removed) };
}

/** Cut the clips lying under `frame` back to it at one edge and close the time that takes out. */
export function rippleTrimToFrame(p: Project, ids: ID[], edge: Edge, at: number): Rippled {
  const frame = Math.round(at);
  const r = rippleTrimTo(p, ids, edge, frame);
  if (!r.edits.length) return { ...r, spans: [] };
  const cuts: Edit[] = [];
  const removed: Stretch[] = [];
  for (const id of new Set(ids)) {
    const c = p.clips[id];
    if (!c || !straddles(c, frame)) continue;
    if (edge === 'start') {
      cuts.push({ op: 'updateClip', id, patch: { start: frame, duration: clipEnd(c) - frame } });
      removed.push({ trackId: c.trackId, start: c.start, end: frame });
    } else {
      cuts.push({ op: 'updateClip', id, patch: { duration: frame - c.start } });
      removed.push({ trackId: c.trackId, start: frame, end: clipEnd(c) });
    }
  }
  return { ...r, spans: closedSpans(applyEdits(p, cuts), removed) };
}

/**
 * What a ripple trim that moved one edge of `ids` by `delta` frames (later is positive) did to
 * time. A head that is cut back gives up the frames after the clips' start, where they stay; a tail
 * gives up, or gains, the frames at their end.
 */
export function trimSpans(p: Project, ids: ID[], edge: Edge, delta: number): RippleSpan[] {
  const clips = ids.map((id) => p.clips[id]).filter((c): c is Clip => !!c);
  if (!clips.length || delta === 0) return [];
  if (edge === 'start') return [{ from: Math.min(...clips.map((c) => c.start)), by: -delta }];
  const end = Math.min(...clips.map(clipEnd));
  return [{ from: delta < 0 ? end + delta : end, by: delta }];
}

/**
 * The clip a trim to the playhead is about when no selected clip lies under it: the one at `frame`
 * on the lowest picture track that has a clip there, else on the first sound track that has. The
 * cut being watched is the picture's. A music bed or a title that happens to lie under the same
 * frame is not cut with it: it follows the ripple, or stays, like any other bystander. Null when
 * that clip begins at the frame, for then the playhead is on a cut and there is nothing to trim.
 */
export function trimReference(p: Project, frame: number): Clip | null {
  const { video, audio } = tracksOf(p);
  for (const tracks of [video, audio]) {
    for (const t of tracks) {
      const clip = t.locked ? null : clipAt(p, t.id, frame);
      if (clip) return straddles(clip, frame) ? clip : null;
    }
  }
  return null;
}

/**
 * Copies of the given clips, placed straight after the last of them. Where something is already
 * there, room is made first by pushing everything from that point on later, on every unlocked
 * track, so that the copies overwrite nothing and what follows stays in sync.
 */
export function duplicateClips(p: Project, ids: ID[]): OpResult & { spans: RippleSpan[] } {
  const clips = unlocked(p, ids).map((id) => p.clips[id]);
  if (!clips.length) return { edits: [], created: [], spans: [] };
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map(clipEnd));
  const by = end - start;
  const free = clips.every((c) => isRegionFree(p, c.trackId, c.start + by, clipEnd(c) + by));
  const room = free ? [] : openGap(p, unlockedTracks(p), end, by);
  const copies = pasteClips(room.length ? applyEdits(p, room) : p, clips, end);
  return {
    edits: [...room, ...copies.edits],
    created: copies.created,
    spans: room.length ? [{ from: end, by }] : [],
  };
}

/** Close the gap under `frame` on one track; the other tracks follow where they can. */
export function closeGapOn(p: Project, trackId: ID, frame: number): Rippled {
  const r = rippleCloseGap(p, trackId, frame);
  // The clip after the gap says how long the gap was: it is the one that moved up to close it.
  const next = clipsOnTrack(p, trackId).find((c) => c.start > frame);
  const moved = next && r.edits.find((e) => e.op === 'updateClip' && e.id === next.id);
  const to = moved?.op === 'updateClip' ? moved.patch.start : undefined;
  if (!next || to === undefined || to >= next.start) return { ...r, spans: [] };
  return { ...r, spans: [{ from: to, by: to - next.start }] };
}

/**
 * Close the gap under `frame`. One gap is closed, once: the one on the lowest picture track that
 * has a gap there, else on the first sound track, and the other tracks follow that as far as they
 * can. The same frame usually lies in a gap of another length on the tracks above (the space
 * between two titles); closing each of those too would pull what follows off the shots it belongs
 * to. `refused` is set when that gap cannot be closed.
 */
export function closeGapAt(p: Project, frame: number): Rippled {
  const { video, audio } = tracksOf(p);
  for (const t of [...video, ...audio]) {
    if (t.locked) continue;
    const r = closeGapOn(p, t.id, frame);
    if (r.edits.length || r.refused) return r;
  }
  return NOT_RIPPLED;
}

/**
 * Take the frames `start`…`end` out of every unlocked track and close the time they occupied. A
 * locked track stays as it is, so the edit is refused when that would leave half of a linked pair
 * behind: its partner is about to be cut into or moved.
 */
export function rippleDeleteRange(p: Project, start: number, end: number): Rippled {
  if (end <= start) return NOT_RIPPLED;
  const moving = new Set<ID>();
  for (const c of Object.values(p.clips)) {
    if (c.linkId && clipEnd(c) > start && !p.tracks[c.trackId]?.locked) moving.add(c.linkId);
  }
  for (const c of Object.values(p.clips)) {
    const track = p.tracks[c.trackId];
    if (c.linkId && track?.locked && moving.has(c.linkId)) {
      const name = track.name || trackLabel(p, track);
      return {
        edits: [],
        refused: `Unlock ${name} to ripple: a linked clip on it has to move too.`,
        spans: [],
      };
    }
  }
  const edits = deleteRange(p, unlockedTracks(p), start, end, true);
  return { edits, refused: null, spans: edits.length ? [{ from: start, by: start - end }] : [] };
}

/**
 * Push everything from `frame` on later by `length` frames on every unlocked track, cutting what
 * lies across it: the room an insert needs.
 */
export function openGapAt(p: Project, frame: number, length: number): { edits: Edit[]; spans: RippleSpan[] } {
  const edits = openGap(p, unlockedTracks(p), frame, length);
  return { edits, spans: [{ from: frame, by: length }] };
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
 * What can be pasted into `p` from clips copied at `fps` frames a second: a clip whose media is not
 * in this project's pool (it was copied in another project, or the media was removed since) would
 * arrive permanently offline with nothing to relink, so it is left out. A grade pointing at a
 * missing LUT loses only the LUT. Clips copied at another frame rate (the rate was changed since,
 * or they come from another project) are re-timed, so that they keep their length in real time.
 */
export function pasteable(p: Project, items: Clip[], fps?: number): { clips: Clip[]; missing: number } {
  const k = fps ? p.settings.fpsNum / p.settings.fpsDen / fps : 1;
  const clips: Clip[] = [];
  for (const item of items) {
    if (item.assetId && !p.assets[item.assetId]) continue;
    const c = sameRate(k) ? item : { ...item, ...clipAtRate(item, k) };
    const lut = c.grade?.lutId;
    clips.push(lut && !p.assets[lut] && c.grade ? { ...c, grade: { ...c.grade, lutId: null } } : c);
  }
  return { clips, missing: items.length - clips.length };
}

// ─────────────────────────────────────────────────────────── moving by track ──

/**
 * Move clips one track up (`dir` 1) or down in the timeline's listing. Picture and sound live on
 * tracks of their own kind, so only one kind moves: the picture when both are among `ids`, as in a
 * drag. The clips of that kind move together or not at all; `refused` says what is in the way.
 */
export function trackNudge(p: Project, ids: ID[], dir: 1 | -1): { edits: Edit[]; refused: string | null } {
  const clips = unlocked(p, ids).map((id) => p.clips[id]);
  const kind = clips.some((c) => c.type !== 'audio') ? 'video' : 'audio';
  const moving = clips.filter((c) => (c.type === 'audio') === (kind === 'audio'));
  if (!moving.length) return { edits: [], refused: null };
  const list = tracksOf(p)[kind];
  // Picture tracks stack upwards and sound tracks are listed downwards.
  const step = kind === 'video' ? dir : -dir;
  const targets = moving.map((c) => list[list.findIndex((t) => t.id === c.trackId) + step]);
  const where = dir === 1 ? 'above' : 'below';
  if (targets.some((t) => !t)) return { edits: [], refused: `There is no track ${where} to move to.` };
  const locked = targets.find((t) => t.locked);
  if (locked) {
    const name = locked.name || trackLabel(p, locked);
    return { edits: [], refused: `${name} is locked. Unlock it to move clips onto it.` };
  }
  const placements = moving.map((c, i) => ({ id: c.id, start: c.start, trackId: targets[i].id }));
  return { edits: placeClips(p, placements), refused: null };
}

// ──────────────────────────────────────────────────────────────── captions ──

/** The name an imported subtitle file gives its track, and the name captions are exported by. */
export const CAPTION_TRACK = 'Captions';

const isCaptionTrack = (t: Track | undefined): boolean =>
  !!t && t.kind === 'video' && /^(captions|subtitles)/i.test(t.name.trim());

export interface CaptionChoice {
  clips: Clip[];
  /**
   * Where they were taken from: the selected text clips, the track asked for, the tracks named
   * as caption tracks, or, when the project has none of those, every text clip there is.
   */
  from: 'selection' | 'track' | 'captions' | 'everything';
  /** The tracks they were taken from, when it was a track that decided. */
  tracks: Track[];
}

/**
 * The text clips a caption export writes, in order. A project's titles and lower thirds are text
 * clips too, and they are not captions: what is exported is the selection when it holds text, else
 * the track named by `trackId`, else the caption tracks (see `CAPTION_TRACK`). Only a project
 * without any of those falls back to all of its text. Of several caption tracks (a second
 * language, an earlier import) the hidden ones are left out, as long as one is showing.
 */
export function captionClips(p: Project, selection: ID[], trackId?: ID): CaptionChoice {
  const text = Object.values(p.clips)
    .filter((c) => c.type === 'text' && !!c.text && c.enabled)
    .sort((a, b) => a.start - b.start);
  const on = (tracks: Track[]): Clip[] => text.filter((c) => tracks.some((t) => t.id === c.trackId));
  const asked = trackId ? p.tracks[trackId] : undefined;
  if (asked) return { clips: on([asked]), from: 'track', tracks: [asked] };
  const chosen = new Set(selection);
  const selected = text.filter((c) => chosen.has(c.id));
  if (selected.length) return { clips: selected, from: 'selection', tracks: [] };
  const named = displayTracks(p).filter(isCaptionTrack);
  if (named.length) {
    const showing = named.filter((t) => !t.hidden);
    const tracks = showing.length ? showing : named;
    return { clips: on(tracks), from: 'captions', tracks };
  }
  return { clips: text, from: 'everything', tracks: [] };
}

// ───────────────────────────────────────────────── selecting by the keyboard ──

/** The clips at `frame`, in the order the timeline lists their tracks: top picture first, sound last. */
export function clipsAtFrame(p: Project, frame: number): Clip[] {
  const out: Clip[] = [];
  for (const t of displayTracks(p)) {
    const c = clipAt(p, t.id, frame);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The frames `Mark clip` marks, as an in point and an out point (the frame after the last): the
 * extent of the selection, else of the clip seen at `frame`. That is the top-most picture on a
 * visible track that is enabled, else the first sound: what match frame goes by.
 */
export function clipExtent(p: Project, frame: number, selection: ID[]): { in: number; out: number } | null {
  const chosen = selection.map((id) => p.clips[id]).filter((c): c is Clip => !!c);
  const clips = chosen.length
    ? chosen
    : clipsAtFrame(p, frame)
        .filter((c) => c.enabled && !p.tracks[c.trackId]?.hidden)
        .slice(0, 1);
  if (!clips.length) return null;
  return { in: Math.min(...clips.map((c) => c.start)), out: Math.max(...clips.map(clipEnd)) };
}

const sameIds = (a: readonly ID[], b: readonly ID[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * The selection `Select clip under playhead` makes: the clip at `frame` on the top-most unlocked
 * track, and, when that is what is selected already, the one on the next track down, round and
 * round. `widen` turns a clip into what selecting it selects (its linked partners come along when
 * linked selection is on), so a picture and its own sound count as one stop.
 */
export function selectionAtFrame(
  p: Project,
  frame: number,
  selection: ID[],
  widen: (id: ID) => ID[],
): ID[] | null {
  const stops: ID[][] = [];
  for (const c of clipsAtFrame(p, frame)) {
    if (p.tracks[c.trackId]?.locked) continue;
    const ids = widen(c.id);
    if (ids.length && !stops.some((s) => sameIds(s, ids))) stops.push(ids);
  }
  if (!stops.length) return null;
  return stops[(stops.findIndex((s) => sameIds(s, selection)) + 1) % stops.length];
}

/**
 * The clip `Select next clip` (`dir` 1) or `Select previous clip` goes to. With a selection it is
 * the neighbour, on the same track, of the selected clip furthest that way on the top-most track
 * that has one. Without, it is the clip at `frame` on the top-most unlocked track, else the
 * nearest one in that direction: the keys can always get hold of something.
 */
export function clipBeside(p: Project, selection: ID[], frame: number, dir: 1 | -1): Clip | null {
  const rank = new Map(displayTracks(p).map((t, i) => [t.id, i]));
  const row = (c: Clip): number => rank.get(c.trackId) ?? Infinity;
  const chosen = unlocked(p, selection).map((id) => p.clips[id]);
  if (chosen.length) {
    const top = Math.min(...chosen.map(row));
    const onTop = chosen.filter((c) => row(c) === top).sort((a, b) => a.start - b.start);
    const { prev, next } = neighbors(p, dir === 1 ? onTop[onTop.length - 1] : onTop[0]);
    return dir === 1 ? next : prev;
  }
  const free = Object.values(p.clips).filter((c) => !p.tracks[c.trackId]?.locked && rank.has(c.trackId));
  const under = free.filter((c) => c.start <= frame && frame < clipEnd(c)).sort((a, b) => row(a) - row(b));
  if (under.length) return under[0];
  const beside = free
    .filter((c) => (dir === 1 ? c.start > frame : clipEnd(c) <= frame))
    .sort((a, b) => (dir === 1 ? a.start - b.start : clipEnd(b) - clipEnd(a)) || row(a) - row(b));
  return beside[0] ?? null;
}

// ─────────────────────────────────────────────────── trimming by the keyboard ──

/**
 * The edge among the given clips that is nearest `frame`, and the clip it belongs to. An end is
 * measured from the clip's last frame, the one the playhead shows when it is parked at that end.
 */
export function nearestEdge(p: Project, ids: ID[], frame: number): { clip: Clip; edge: Edge } | null {
  let best: { clip: Clip; edge: Edge } | null = null;
  let nearest = Infinity;
  for (const id of ids) {
    const clip = p.clips[id];
    if (!clip) continue;
    const ends: [Edge, number][] = [
      ['start', Math.abs(frame - clip.start)],
      ['end', Math.abs(frame - (clipEnd(clip) - 1))],
    ];
    for (const [edge, distance] of ends) {
      if (distance >= nearest) continue;
      nearest = distance;
      best = { clip, edge };
    }
  }
  return best;
}

/** A cut as a roll moves it: the clip that ends there and the clip that begins there. */
export type Cut = [left: ID, right: ID];

/**
 * How one edge of each of `ids` is trimmed when nothing may ripple. Where another clip touches the
 * edge it is a cut, and the cut is rolled: the neighbour gives or takes the frames, so no hole
 * opens and nothing after it moves. An edge with nothing against it is `free` and trimmed alone.
 */
export function edgeCuts(p: Project, ids: ID[], edge: Edge): { cuts: Cut[]; free: ID[] } {
  const group = new Set(ids.filter((id) => p.clips[id]));
  const cuts: Cut[] = [];
  const free: ID[] = [];
  for (const id of group) {
    const c = p.clips[id];
    const other = edge === 'start' ? adjacentPrev(p, c) : adjacentNext(p, c);
    if (other && !group.has(other.id)) cuts.push(edge === 'start' ? [other.id, id] : [id, other.id]);
    else free.push(id);
  }
  return { cuts, free };
}

/**
 * How far those cuts and free edges can move together, in frames (later is positive): each clip
 * has to keep a frame, no clip can show media it does not have, and a free edge stops at the next
 * clip. Linked picture and sound get the same trim, so the tightest of the limits holds for all.
 */
export function edgeRange(p: Project, edge: Edge, cuts: Cut[], free: ID[]): { min: number; max: number } {
  let min = -Infinity;
  let max = Infinity;
  const media = (c: Clip) => handles(c, c.assetId ? p.assets[c.assetId] : undefined, p);
  for (const [left, right] of cuts) {
    const a = p.clips[left];
    const b = p.clips[right];
    min = Math.max(min, -(a.duration - 1), -media(b).head);
    max = Math.min(max, b.duration - 1, media(a).tail);
  }
  for (const id of free) {
    const range = trimRange(p, [id], edge, false);
    min = Math.max(min, range.min);
    max = Math.min(max, range.max);
  }
  return { min, max };
}

export interface EdgeTrim extends Rippled {
  /** Frames the edge moved by, later being positive. Zero when it could not move. */
  moved: number;
}

/**
 * Move one edge of `ids` (a clip and what is trimmed with it) by `delta` frames. With `ripple`
 * everything after follows; without, a cut is rolled and a free edge trimmed (see `edgeCuts`).
 */
export function trimEdge(p: Project, ids: ID[], edge: Edge, delta: number, ripple: boolean): EdgeTrim {
  const want = Math.round(delta);
  if (ripple) {
    const range = trimRange(p, ids, edge, true);
    const d = clamp(want, range.min, range.max);
    // A ripple that cannot move at all has a reason; one that only stops early is at a limit.
    if (d === 0) {
      const refused = want ? rippleTrim(p, ids, edge, want).refused : null;
      return { edits: [], refused, spans: [], moved: 0 };
    }
    const r = rippleTrim(p, ids, edge, d);
    const moved = r.edits.length ? d : 0;
    return { ...r, spans: trimSpans(p, ids, edge, moved), moved };
  }
  const { cuts, free } = edgeCuts(p, ids, edge);
  const range = edgeRange(p, edge, cuts, free);
  const d = clamp(want, range.min, range.max);
  if (d === 0) return { edits: [], refused: null, spans: [], moved: 0 };
  const edits = [
    ...cuts.flatMap(([left, right]) => rollEdit(p, left, right, d)),
    ...free.flatMap((id) => trimClips(p, [id], edge, d)),
  ];
  return { edits, refused: null, spans: [], moved: d };
}

// ───────────────────────────────────────────────────────────── transitions ──

const isPicture = (c: Clip | undefined): c is Clip => !!c && c.type !== 'audio';

/**
 * The clips a transition goes on, at their heads, when it was asked for without pointing at a
 * clip. Of the selected picture clips those that begin at a cut, so that a run of selected shots
 * gets one on every cut between them and none before the first; when none of them begins at a
 * cut, all of them. With no picture selected it is the cut nearest `frame`, and only a timeline
 * without a single cut falls back to the nearest start of a clip.
 */
export function transitionTargets(p: Project, selection: ID[], frame: number): ID[] {
  const chosen = unlocked(p, selection)
    .map((id) => p.clips[id])
    .filter(isPicture);
  if (chosen.length) {
    const cuts = chosen.filter((c) => adjacentPrev(p, c));
    return (cuts.length ? cuts : chosen).map((c) => c.id);
  }
  const free = Object.values(p.clips).filter((c) => isPicture(c) && !p.tracks[c.trackId]?.locked);
  const cuts = free.filter((c) => adjacentPrev(p, c));
  const rank = new Map(tracksOf(p).video.map((t, i) => [t.id, i]));
  const [nearest] = (cuts.length ? cuts : free).sort(
    (a, b) =>
      Math.abs(a.start - frame) - Math.abs(b.start - frame) ||
      (rank.get(a.trackId) ?? 0) - (rank.get(b.trackId) ?? 0),
  );
  return nearest ? [nearest.id] : [];
}

/** Frames of fade the sound either side of a cut gets under a picture transition. */
export const CUT_FADE = 3;

/**
 * Put the transition `t` on one side of each of `ids`, as long as the clips there allow. A
 * transition into a clip at a cut mixes two pictures while the sound still cuts hard, which clicks.
 * So where the clip's linked sound is cut at the same frame, the sound either side of that cut gets
 * a fade of `CUT_FADE` frames, unless it has a longer one already.
 */
export function transitionEdits(p: Project, ids: ID[], side: 'in' | 'out', t: Transition): Edit[] {
  const edits: Edit[] = [];
  const fades = new Map<ID, Partial<Clip>>();
  const fade = (c: Clip, key: 'fadeIn' | 'fadeOut'): void => {
    const frames = Math.min(CUT_FADE, c.duration);
    if (c[key] < frames) fades.set(c.id, { ...fades.get(c.id), [key]: frames });
  };
  for (const id of new Set(ids)) {
    const clip = p.clips[id];
    if (!clip) continue;
    edits.push(...setTransition(p, id, side, t));
    if (side !== 'in' || !adjacentPrev(p, clip)) continue;
    for (const partner of linkedIds(p, id)) {
      const sound = p.clips[partner];
      if (sound.type !== 'audio' || sound.start !== clip.start || p.tracks[sound.trackId]?.locked) continue;
      const before = adjacentPrev(p, sound);
      if (!before) continue;
      fade(before, 'fadeOut');
      fade(sound, 'fadeIn');
    }
  }
  for (const [id, patch] of fades) edits.push({ op: 'updateClip', id, patch });
  return edits;
}

// ────────────────────────────────────────────────────────────── attributes ──

/** Which of the copied attributes a paste applies. `all` is every one that fits the clip. */
export type AttributeMode = 'all' | 'grade' | 'effects' | 'transform' | 'sound';

const TRANSFORM_PATHS = [
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
  'cropL',
  'cropT',
  'cropR',
  'cropB',
] as const;

/**
 * What `Copy attributes` takes from the given clips: the look of the first picture clip among
 * them and the sound settings of the first audio clip. A sync clip selected with its sound gives
 * both, and each is pasted onto clips of its own kind.
 */
export function copiedAttributes(clips: Clip[], fps: number): AttributeClipboard | null {
  const picture = clips.find(isPicture);
  const audio = clips.find((c) => c.type === 'audio');
  if (!picture && !audio) return null;
  return {
    fps,
    look: picture
      ? {
          effects: picture.effects,
          grade: picture.grade,
          transform: {
            x: picture.x,
            y: picture.y,
            scaleX: picture.scaleX,
            scaleY: picture.scaleY,
            rotation: picture.rotation,
            opacity: picture.opacity,
            blend: picture.blend,
            cropL: picture.cropL,
            cropT: picture.cropT,
            cropR: picture.cropR,
            cropB: picture.cropB,
          },
        }
      : null,
    sound: audio
      ? { volume: audio.volume, pan: audio.pan, fadeIn: audio.fadeIn, fadeOut: audio.fadeOut }
      : null,
  };
}

/**
 * The patch that pastes the copied attributes `a` onto `clip`, or null when `mode` has nothing for
 * a clip of its kind. What is pasted are values, not animation: keyframes the clip has on a pasted
 * property are removed, since they would otherwise go on deciding what is seen and the paste would
 * appear to do nothing. A grade pointing at a LUT that is not in this project loses only the LUT,
 * and fades copied at another frame rate keep their length in real time.
 */
export function attributePatch(
  p: Project,
  clip: Clip,
  a: AttributeClipboard,
  mode: AttributeMode,
): Partial<Clip> | null {
  const wants = (part: AttributeMode): boolean => mode === 'all' || mode === part;
  const patch: Partial<Clip> = {};
  const dropped = new Set<string>();
  if (clip.type === 'audio') {
    if (!a.sound || !wants('sound')) return null;
    const k = p.settings.fpsNum / p.settings.fpsDen / a.fps;
    const frames = (n: number): number => Math.min(clip.duration, Math.round(n * (sameRate(k) ? 1 : k)));
    Object.assign(patch, {
      volume: a.sound.volume,
      pan: a.sound.pan,
      fadeIn: frames(a.sound.fadeIn),
      fadeOut: frames(a.sound.fadeOut),
    });
    for (const path of ['volume', 'pan']) dropped.add(path);
  } else {
    if (!a.look) return null;
    if (wants('grade')) {
      const lut = a.look.grade?.lutId;
      patch.grade = a.look.grade && lut && !p.assets[lut] ? { ...a.look.grade, lutId: null } : a.look.grade;
    }
    if (wants('effects')) {
      patch.effects = a.look.effects.map((e) => ({ ...e, id: newId(8) }));
      for (const path of Object.keys(clip.keyframes)) if (path.startsWith('fx:')) dropped.add(path);
    }
    if (wants('transform')) {
      Object.assign(patch, a.look.transform);
      for (const path of TRANSFORM_PATHS) dropped.add(path);
    }
  }
  if (!Object.keys(patch).length) return null;
  const keyframes: Record<string, Keyframe[]> = {};
  for (const [path, kfs] of Object.entries(clip.keyframes)) if (!dropped.has(path)) keyframes[path] = kfs;
  if (Object.keys(keyframes).length !== Object.keys(clip.keyframes).length) patch.keyframes = keyframes;
  return patch;
}

// ───────────────────────────────────────────────────────── replacing media ──

/** Whether `asset` can stand in for what `clip` shows: video for video, a still for a still, sound for sound. */
const takes = (clip: Clip, asset: Asset): boolean =>
  clip.type === 'video'
    ? asset.kind === 'video' && asset.hasVideo
    : clip.type === 'image'
      ? asset.kind === 'image'
      : clip.type === 'audio' && (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio));

const REPLACED_BY: Record<string, string> = {
  video: 'A video clip can only be replaced by a video file.',
  image: 'A still can only be replaced by another image.',
  audio: 'A sound clip can only be replaced by a file that has sound.',
};

export interface Replaced {
  edits: Edit[];
  /** The new media is shorter than the clip was, so the clip (or its sound) now ends earlier. */
  shortened: boolean;
  /** Why this clip cannot show that file. Nothing is changed then. */
  refused: string | null;
}

/** The patch that puts `asset` behind `clip` from `sourceIn` seconds on, and whether that cut the clip short. */
function swapped(p: Project, clip: Clip, asset: Asset, sourceIn: number): { patch: Partial<Clip>; shortened: boolean } {
  const before = clip.assetId ? p.assets[clip.assetId] : undefined;
  const from = clip.type === 'image' ? 0 : Math.max(0, sourceIn);
  const patch: Partial<Clip> = { assetId: asset.id, sourceIn: from };
  // A name the clip took from its media follows the media; one it was given by hand stays.
  if (!before || clip.name === before.name) patch.name = asset.name;
  const per = sourcePerFrame(clip, p);
  const room =
    clip.type === 'image' || per <= 0 || asset.duration <= 0
      ? Infinity
      : Math.floor((asset.duration - from) / per + 1e-6);
  const duration = Math.max(1, Math.min(clip.duration, room));
  if (duration === clip.duration) return { patch, shortened: false };
  patch.duration = duration;
  if (clip.fadeIn > duration) patch.fadeIn = duration;
  if (clip.fadeOut > duration) patch.fadeOut = duration;
  if (clip.transIn && clip.transIn.duration > duration) patch.transIn = { ...clip.transIn, duration };
  if (clip.transOut && clip.transOut.duration > duration) patch.transOut = { ...clip.transOut, duration };
  return { patch, shortened: true };
}

/**
 * Put another file behind a clip, where it stands: the clip keeps its place, its length, its speed,
 * its grade, effects, transform, keyframes and transitions, and shows `asset` from `sourceIn`
 * seconds on. Where the new media is shorter than the clip, the clip ends where the media does.
 * The sound that belongs to a picture (its linked audio from the same file) is replaced with it,
 * keeping the offset it had, and removed when the new file has no sound.
 */
export function replaceEdits(p: Project, clipId: ID, asset: Asset, sourceIn = 0): Replaced {
  const clip = p.clips[clipId];
  if (!clip) return { edits: [], shortened: false, refused: null };
  if (!takes(clip, asset)) {
    return { edits: [], shortened: false, refused: REPLACED_BY[clip.type] ?? 'This clip has no media to replace.' };
  }
  const own = swapped(p, clip, asset, sourceIn);
  let shortened = own.shortened;
  const edits: Edit[] = [];
  const group = linkedIds(p, clipId);
  let left = group.length;
  for (const id of clip.type === 'video' ? group : []) {
    const sound = p.clips[id];
    if (id === clipId || sound.type !== 'audio' || sound.assetId !== clip.assetId) continue;
    if (p.tracks[sound.trackId]?.locked) continue;
    if (takes(sound, asset)) {
      const part = swapped(p, sound, asset, sourceIn + (sound.sourceIn - clip.sourceIn));
      shortened ||= part.shortened;
      edits.push({ op: 'updateClip', id, patch: part.patch });
    } else {
      edits.push({ op: 'removeClip', id });
      left--;
    }
  }
  // A link group of one is not a link.
  if (clip.linkId && left === 1) own.patch.linkId = null;
  return { edits: [{ op: 'updateClip', id: clipId, patch: own.patch }, ...edits], shortened, refused: null };
}
