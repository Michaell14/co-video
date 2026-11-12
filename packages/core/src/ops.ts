/**
 * Editing operations.
 *
 * Every function here is pure: it inspects a Project snapshot and returns the list of atomic `Edit`s
 * that perform the operation. Callers either commit them to the ProjectStore (one undo step, synced to
 * collaborators) or run them through `applyEdits` to render a live preview while dragging.
 */
import {
  CLIP_TYPE_COLORS,
  DEFAULT_SHAPE,
  DEFAULT_TEXT,
  hasSourceTime,
  makeClip,
  makeTrack,
} from './defaults';
import { newId } from './ids';
import { conformEasing, evalKeyframes, scaleKeyframes, shiftKeyframes, upsertKeyframe } from './keyframes';
import {
  clipEnd,
  clipsOnTrack,
  findIndexAtOrBefore,
  handles,
  isRegionFree,
  linkedIds,
  neighbors,
  sourcePerFrame,
  sourceTimeAt,
  trackLabel,
  tracksOf,
} from './query';
import { applyEdits } from './store';
import { clipAtRate, fpsOf, sameRate, secondsToFrame } from './time';
import type {
  Asset,
  Clip,
  ClipType,
  Easing,
  Edit,
  EffectInstance,
  ID,
  Keyframe,
  ParamValue,
  Project,
  ShapeProps,
  TextProps,
  Track,
  TrackKind,
  Transition,
} from './types';
import { clamp, deepEqual } from './util';

export interface OpResult {
  edits: Edit[];
  /** Ids of clips created by the operation, for selecting them afterwards. */
  created: ID[];
}

export const trackKindFor = (type: ClipType): TrackKind => (type === 'audio' ? 'audio' : 'video');

// ───────────────────────────────────────────────────────────────── retime ──

/** Patch that moves a clip's in/out points on the timeline while keeping its content in place. */
export function retime(clip: Clip, newStart: number, newEnd: number, p: Project): Partial<Clip> {
  const headDelta = newStart - clip.start;
  const tailDelta = clipEnd(clip) - newEnd;
  const duration = Math.max(1, newEnd - newStart);
  const patch: Partial<Clip> = { start: newStart, duration };
  if (hasSourceTime(clip.type)) {
    const per = sourcePerFrame(clip, p);
    const delta = clip.reverse ? tailDelta : headDelta;
    if (delta !== 0) patch.sourceIn = Math.max(0, clip.sourceIn + delta * per);
  }
  if (headDelta !== 0 && Object.keys(clip.keyframes).length) {
    patch.keyframes = shiftKeyframes(clip.keyframes, headDelta);
  }
  if (clip.fadeIn > duration) patch.fadeIn = duration;
  if (clip.fadeOut > duration) patch.fadeOut = duration;
  return patch;
}

type Span = [number, number];

function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s[1] > s[0]).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/**
 * What a piece of a clip gives up at an edge that a cut has just made. Nothing fades, dissolves or
 * animates across a cut: the other side of it carries straight on.
 */
function cutEdges(clip: Clip, head: boolean, tail: boolean): Partial<Clip> {
  const patch: Partial<Clip> = {};
  if (head) {
    patch.transIn = null;
    patch.fadeIn = 0;
  }
  if (tail) {
    patch.transOut = null;
    patch.fadeOut = 0;
  }
  const text = clip.text;
  if (text) {
    const dropIn = head && text.animIn.type !== 'none';
    const dropOut = tail && text.animOut.type !== 'none';
    if (dropIn || dropOut) {
      patch.text = {
        ...text,
        animIn: dropIn ? { ...text.animIn, type: 'none' } : text.animIn,
        animOut: dropOut ? { ...text.animOut, type: 'none' } : text.animOut,
      };
    }
  }
  return patch;
}

/** Edits that remove the parts of `clip` covered by `regions` (trimming, splitting or deleting it). */
function carve(p: Project, clip: Clip, regions: Span[]): Edit[] {
  const end = clipEnd(clip);
  const pieces: Span[] = [];
  let cursor = clip.start;
  for (const [rs, re] of regions) {
    if (re <= cursor) continue;
    if (rs >= end) break;
    if (rs > cursor) pieces.push([cursor, Math.min(rs, end)]);
    cursor = Math.max(cursor, re);
    if (cursor >= end) break;
  }
  if (cursor < end) pieces.push([cursor, end]);
  if (pieces.length === 1 && pieces[0][0] === clip.start && pieces[0][1] === end) return [];
  if (pieces.length === 0) return [{ op: 'removeClip', id: clip.id }];

  const edits: Edit[] = [];
  pieces.forEach(([s, e], i) => {
    const patch = { ...retime(clip, s, e, p), ...cutEdges(clip, s !== clip.start, e !== end) };
    if (i === 0) edits.push({ op: 'updateClip', id: clip.id, patch });
    else edits.push({ op: 'addClip', clip: { ...clip, ...patch, id: newId(), linkId: null } });
  });
  return edits;
}

/** Make room on a track: everything overlapping `regions` (except `exclude`) is overwritten. */
export function clearRegions(
  p: Project,
  trackId: ID,
  regions: Span[],
  exclude: ReadonlySet<ID> = new Set(),
): Edit[] {
  const merged = mergeSpans(regions);
  if (!merged.length) return [];
  const lo = merged[0][0];
  const hi = merged[merged.length - 1][1];
  const edits: Edit[] = [];
  for (const c of clipsOnTrack(p, trackId)) {
    if (exclude.has(c.id)) continue;
    if (c.start >= hi) break;
    if (clipEnd(c) <= lo) continue;
    edits.push(...carve(p, c, merged));
  }
  return edits;
}

// ──────────────────────────────────────────────────────────────── placing ──

export interface Placement {
  id: ID;
  start: number;
  trackId: ID;
}

/** Move existing clips to new positions, overwriting whatever they land on. */
export function placeClips(p: Project, placements: Placement[]): Edit[] {
  const moving = new Set(placements.map((m) => m.id));
  const regions = new Map<ID, Span[]>();
  const valid: Placement[] = [];
  for (const m of placements) {
    const c = p.clips[m.id];
    const t = p.tracks[m.trackId];
    if (!c || !t || t.kind !== trackKindFor(c.type)) continue;
    const start = Math.max(0, Math.round(m.start));
    valid.push({ ...m, start });
    const list = regions.get(m.trackId) ?? [];
    list.push([start, start + c.duration]);
    regions.set(m.trackId, list);
  }
  const edits: Edit[] = [];
  for (const [trackId, spans] of regions) edits.push(...clearRegions(p, trackId, spans, moving));
  for (const m of valid) {
    const c = p.clips[m.id];
    if (c.start !== m.start || c.trackId !== m.trackId) {
      edits.push({ op: 'updateClip', id: m.id, patch: { start: m.start, trackId: m.trackId } });
    }
  }
  return edits;
}

/** Add brand-new clips, overwriting whatever they land on. */
export function insertClips(p: Project, clips: Clip[]): OpResult {
  const regions = new Map<ID, Span[]>();
  for (const c of clips) {
    const list = regions.get(c.trackId) ?? [];
    list.push([c.start, clipEnd(c)]);
    regions.set(c.trackId, list);
  }
  const edits: Edit[] = [];
  for (const [trackId, spans] of regions) edits.push(...clearRegions(p, trackId, spans));
  for (const c of clips) edits.push({ op: 'addClip', clip: c });
  return { edits, created: clips.map((c) => c.id) };
}

/** Shift every clip that starts at or after `from` on the given tracks. */
export function rippleShift(
  p: Project,
  trackIds: Iterable<ID>,
  from: number,
  delta: number,
  exclude: ReadonlySet<ID> = new Set(),
): Edit[] {
  if (delta === 0) return [];
  const edits: Edit[] = [];
  for (const trackId of new Set(trackIds)) {
    for (const c of clipsOnTrack(p, trackId)) {
      if (exclude.has(c.id) || c.start < from) continue;
      edits.push({ op: 'updateClip', id: c.id, patch: { start: Math.max(0, c.start + delta) } });
    }
  }
  return edits;
}

/**
 * Insert edit: open a gap of `length` frames at `frame` on the given tracks, splitting any clip that
 * straddles the insertion point.
 */
export function openGap(p: Project, trackIds: Iterable<ID>, frame: number, length: number): Edit[] {
  const edits: Edit[] = [];
  // Right halves of clips that were linked stay linked to each other.
  const linkMap = new Map<ID, ID>();
  for (const trackId of new Set(trackIds)) {
    for (const c of clipsOnTrack(p, trackId)) {
      const end = clipEnd(c);
      if (end <= frame) continue;
      if (c.start >= frame) {
        edits.push({ op: 'updateClip', id: c.id, patch: { start: c.start + length } });
      } else {
        let linkId: ID | null = null;
        if (c.linkId) {
          linkId = linkMap.get(c.linkId) ?? newId();
          linkMap.set(c.linkId, linkId);
        }
        const right: Clip = {
          ...c,
          ...retime(c, frame, end, p),
          ...cutEdges(c, true, false),
          id: newId(),
          linkId,
        };
        right.start = frame + length;
        edits.push({
          op: 'updateClip',
          id: c.id,
          patch: { ...retime(c, c.start, frame, p), ...cutEdges(c, false, true) },
        });
        edits.push({ op: 'addClip', clip: right });
      }
    }
  }
  return edits;
}

// ──────────────────────────────────────────────────── creating from media ──

export const DEFAULT_STILL_SECONDS = 5;

/** First unlocked track of `kind` where [start, end) is free, bottom-most video / top-most audio first. */
export function findFreeTrack(p: Project, kind: TrackKind, start: number, end: number): Track | null {
  const list = kind === 'video' ? tracksOf(p).video : tracksOf(p).audio;
  for (const t of list) {
    if (t.locked) continue;
    if (isRegionFree(p, t.id, start, end)) return t;
  }
  return null;
}

function nextOrder(p: Project, kind: TrackKind): number {
  const list = kind === 'video' ? tracksOf(p).video : tracksOf(p).audio;
  return list.length ? list[list.length - 1].order + 1 : 0;
}

export interface AddAssetOptions {
  frame: number;
  /** Explicit targets overwrite; omitted targets pick a free track (creating one if needed). */
  videoTrackId?: ID | null;
  audioTrackId?: ID | null;
  /** Source in / out, seconds. */
  sourceIn?: number;
  sourceOut?: number;
  /** Skip the audio (or video) half of a video asset. */
  only?: 'video' | 'audio';
}

export function addAssetToTimeline(p: Project, asset: Asset, opts: AddAssetOptions): OpResult {
  const edits: Edit[] = [];
  const start = Math.max(0, Math.round(opts.frame));
  const s = p.settings;
  const srcIn = Math.max(0, opts.sourceIn ?? 0);
  const srcOut = Math.min(asset.duration || Infinity, opts.sourceOut ?? asset.duration);
  const timed = asset.kind === 'video' || asset.kind === 'audio';
  const duration = timed
    ? Math.max(1, secondsToFrame(Math.max(0, srcOut - srcIn), s))
    : Math.max(1, secondsToFrame(DEFAULT_STILL_SECONDS, s));
  const end = start + duration;

  const wantVideo =
    (asset.kind === 'video' && asset.hasVideo && opts.only !== 'audio') || asset.kind === 'image';
  const wantAudio =
    (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)) && opts.only !== 'video';
  const linkId = wantVideo && wantAudio ? newId() : null;
  const clips: Clip[] = [];
  let working = p;

  const resolveTrack = (kind: TrackKind, explicit: ID | null | undefined): ID => {
    const given = explicit ? working.tracks[explicit] : null;
    if (given && given.kind === kind && !given.locked) return given.id;
    const free = findFreeTrack(working, kind, start, end);
    if (free) return free.id;
    const track = makeTrack(kind, nextOrder(working, kind));
    edits.push({ op: 'addTrack', track });
    working = { ...working, tracks: { ...working.tracks, [track.id]: track } };
    return track.id;
  };

  if (wantVideo) {
    const trackId = resolveTrack('video', opts.videoTrackId);
    clips.push(
      makeClip(asset.kind === 'image' ? 'image' : 'video', trackId, {
        assetId: asset.id,
        name: asset.name,
        start,
        duration,
        sourceIn: timed ? srcIn : 0,
        linkId,
      }),
    );
  }
  if (wantAudio) {
    const trackId = resolveTrack('audio', opts.audioTrackId);
    clips.push(
      makeClip('audio', trackId, {
        assetId: asset.id,
        name: asset.name,
        start,
        duration,
        sourceIn: srcIn,
        linkId,
      }),
    );
  }
  const ins = insertClips(working, clips);
  return { edits: [...edits, ...ins.edits], created: ins.created };
}

export interface AddGeneratorOptions {
  frame: number;
  trackId?: ID | null;
  duration?: number;
  text?: Partial<TextProps>;
  shape?: Partial<ShapeProps>;
  init?: Partial<Clip>;
}

/** Add a text / shape / solid / adjustment clip. */
export function addGenerator(
  p: Project,
  type: 'text' | 'shape' | 'solid' | 'adjustment',
  opts: AddGeneratorOptions,
): OpResult {
  const edits: Edit[] = [];
  const start = Math.max(0, Math.round(opts.frame));
  const duration = Math.max(
    1,
    Math.round(opts.duration ?? secondsToFrame(DEFAULT_STILL_SECONDS, p.settings)),
  );
  let working = p;
  let trackId = opts.trackId && p.tracks[opts.trackId]?.kind === 'video' ? opts.trackId : null;
  if (!trackId) {
    // Generators want to sit above the picture: use the top video track when it has room there,
    // otherwise open a new track on top.
    const video = tracksOf(p).video;
    const top = video[video.length - 1];
    if (top && !top.locked && isRegionFree(p, top.id, start, start + duration)) {
      trackId = top.id;
    } else {
      const track = makeTrack('video', nextOrder(p, 'video'));
      edits.push({ op: 'addTrack', track });
      working = { ...p, tracks: { ...p.tracks, [track.id]: track } };
      trackId = track.id;
    }
  }
  const names: Record<string, string> = {
    text: 'Text',
    shape: 'Shape',
    solid: 'Solid',
    adjustment: 'Adjustment layer',
  };
  const clip = makeClip(type, trackId, {
    name: names[type],
    start,
    duration,
    fit: type === 'solid' || type === 'adjustment' ? 'stretch' : 'none',
    text: type === 'text' ? { ...DEFAULT_TEXT, ...opts.text } : null,
    shape:
      type === 'shape'
        ? { ...DEFAULT_SHAPE, ...opts.shape }
        : type === 'solid'
          ? { ...DEFAULT_SHAPE, kind: 'rect', w: 1, h: 1, fill: '#1f2937', ...opts.shape }
          : null,
    ...opts.init,
  });
  const ins = insertClips(working, [clip]);
  return { edits: [...edits, ...ins.edits], created: ins.created };
}

// ────────────────────────────────────────────────────────────────── trim ──

export type Edge = 'start' | 'end';

/** How far the source media and the neighbouring clips let one edge of several clips move. */
function handleRange(p: Project, ids: ID[], edge: Edge, ripple: boolean): { min: number; max: number } {
  let min = -Infinity;
  let max = Infinity;
  const set = new Set(ids);
  for (const id of ids) {
    const c = p.clips[id];
    if (!c) continue;
    const h = handles(c, c.assetId ? p.assets[c.assetId] : undefined, p);
    const { prev, next } = neighbors(p, c);
    if (edge === 'start') {
      let ext = h.head;
      if (!ripple) {
        const floor = prev && !set.has(prev.id) ? clipEnd(prev) : 0;
        ext = Math.min(ext, c.start - floor);
      }
      min = Math.max(min, -ext);
      max = Math.min(max, c.duration - 1);
    } else {
      let ext = h.tail;
      if (!ripple && next && !set.has(next.id)) ext = Math.min(ext, next.start - clipEnd(c));
      max = Math.min(max, ext);
      min = Math.max(min, -(c.duration - 1));
    }
  }
  if (min === -Infinity) min = -1e9;
  if (max === Infinity) max = 1e9;
  return { min, max };
}

/**
 * Allowed range for a trim delta (frames) applied to the same edge of several clips at once. With
 * `ripple` it also ends where the ripple would first be refused, so a drag stops there like at any
 * other limit instead of turning into an edit that does nothing.
 */
export function trimRange(p: Project, ids: ID[], edge: Edge, ripple: boolean): { min: number; max: number } {
  const range = handleRange(p, ids, edge, ripple);
  return ripple ? rippleTrimRange(p, ids, edge, range) : range;
}

/** Trim one edge of the given clips by `delta` frames (positive = later). */
export function trimClips(p: Project, ids: ID[], edge: Edge, delta: number, ripple = false): Edit[] {
  if (ripple) return rippleTrim(p, ids, edge, delta).edits;
  const range = handleRange(p, ids, edge, false);
  const d = clamp(Math.round(delta), range.min, range.max);
  if (d === 0) return [];
  const edits: Edit[] = [];
  for (const id of ids) {
    const c = p.clips[id];
    if (!c) continue;
    const patch =
      edge === 'start' ? retime(c, c.start + d, clipEnd(c), p) : retime(c, c.start, clipEnd(c) + d, p);
    edits.push({ op: 'updateClip', id, patch });
  }
  return edits;
}

/** Roll edit: move the cut between two adjacent clips without changing overall length. */
export function rollEdit(p: Project, leftId: ID, rightId: ID, delta: number): Edit[] {
  const a = p.clips[leftId];
  const b = p.clips[rightId];
  if (!a || !b) return [];
  const ha = handles(a, a.assetId ? p.assets[a.assetId] : undefined, p);
  const hb = handles(b, b.assetId ? p.assets[b.assetId] : undefined, p);
  const min = Math.max(-(a.duration - 1), -hb.head);
  const max = Math.min(b.duration - 1, ha.tail);
  const d = clamp(Math.round(delta), min, max);
  if (d === 0) return [];
  return [
    { op: 'updateClip', id: a.id, patch: retime(a, a.start, clipEnd(a) + d, p) },
    { op: 'updateClip', id: b.id, patch: retime(b, b.start + d, clipEnd(b), p) },
  ];
}

/** Slip: change which part of the source a clip shows without moving it. `delta` in frames. */
export function slipClips(p: Project, ids: ID[], delta: number): Edit[] {
  const edits: Edit[] = [];
  for (const id of ids) {
    const c = p.clips[id];
    if (!c || !hasSourceTime(c.type)) continue;
    const asset = c.assetId ? p.assets[c.assetId] : undefined;
    const per = sourcePerFrame(c, p);
    const used = c.duration * per;
    const maxIn = asset && asset.duration > 0 ? Math.max(0, asset.duration - used) : Infinity;
    const sourceIn = clamp(c.sourceIn + (c.reverse ? -delta : delta) * per, 0, maxIn);
    if (sourceIn !== c.sourceIn) edits.push({ op: 'updateClip', id, patch: { sourceIn } });
  }
  return edits;
}

// ───────────────────────────────────────────────────────── split / delete ──

/** Split clips at `frame`. Linked partners split together and the right halves stay linked. */
export function splitClips(p: Project, ids: ID[], frame: number): OpResult {
  const edits: Edit[] = [];
  const created: ID[] = [];
  const linkMap = new Map<ID, ID>();
  for (const id of ids) {
    const c = p.clips[id];
    if (!c) continue;
    const end = clipEnd(c);
    if (frame <= c.start || frame >= end) continue;
    let linkId: ID | null = null;
    if (c.linkId) {
      linkId = linkMap.get(c.linkId) ?? newId();
      linkMap.set(c.linkId, linkId);
    }
    const right: Clip = {
      ...c,
      ...retime(c, frame, end, p),
      ...cutEdges(c, true, false),
      id: newId(),
      linkId,
    };
    edits.push({
      op: 'updateClip',
      id,
      patch: { ...retime(c, c.start, frame, p), ...cutEdges(c, false, true) },
    });
    edits.push({ op: 'addClip', clip: right });
    created.push(right.id);
  }
  return { edits, created };
}

/** Every clip under `frame` on unlocked tracks. */
export function clipsUnderFrame(p: Project, frame: number): ID[] {
  const out: ID[] = [];
  for (const c of Object.values(p.clips)) {
    if (p.tracks[c.trackId]?.locked) continue;
    if (c.start < frame && frame < clipEnd(c)) out.push(c.id);
  }
  return out;
}

export function deleteClips(p: Project, ids: ID[], ripple = false): Edit[] {
  if (ripple) return rippleDelete(p, ids).edits;
  return ids.filter((id) => p.clips[id]).map((id) => ({ op: 'removeClip', id }) as Edit);
}

/** Close the empty gap under `frame` on a track by pulling later clips left. */
export function closeGap(p: Project, trackId: ID, frame: number): Edit[] {
  return rippleCloseGap(p, trackId, frame).edits;
}

/** Remove a time range from the given tracks (lift) and optionally close it (extract). */
export function deleteRange(p: Project, trackIds: ID[], start: number, end: number, ripple: boolean): Edit[] {
  if (end <= start) return [];
  const edits: Edit[] = [];
  for (const trackId of trackIds) edits.push(...clearRegions(p, trackId, [[start, end]]));
  if (!ripple) return edits;
  const cleared = applyEdits(p, edits);
  return [...edits, ...rippleShift(cleared, trackIds, end, start - end)];
}

// ──────────────────────────────────────────────────────────────── ripple ──
//
// A ripple takes time out of the sequence (or puts it in) and moves what comes after. Every track
// follows, not only the one being edited, so picture, sound and titles further down keep lining up.
// Two things are never allowed to happen: an overlap, and a linked pair drifting apart.
//  - A track that has no room to follow stays exactly as it is. So does a track that could move
//    but would carry one half of a linked pair away from a half that cannot.
//  - When the half that has to move sits on the track being edited, there is no way to keep the
//    pair together and the whole ripple is refused, with a reason.

export interface RippleResult {
  edits: Edit[];
  /** Why the ripple was not carried out, worded for the person editing. `null` when it went through. */
  refused: string | null;
}

/** Frames each clip moves by (negative = earlier). Clips that stay put are absent. */
type Shifts = Map<ID, number>;

/** Works out the shifts of a ripple given which tracks take part, or says why it cannot be done. */
type RipplePlan = (follows: (t: Track) => boolean) => Shifts | string;

const trackName = (p: Project, t: Track): string => t.name || trackLabel(p, t);

/** Two linked clips that `shifts` would move by different amounts, if there are any. */
function partedPair(p: Project, shifts: Shifts): [Clip, Clip] | null {
  const seen = new Map<ID, Clip>();
  for (const c of Object.values(p.clips)) {
    if (!c.linkId) continue;
    const partner = seen.get(c.linkId);
    if (!partner) seen.set(c.linkId, c);
    else if ((shifts.get(partner.id) ?? 0) !== (shifts.get(c.id) ?? 0)) return [partner, c];
  }
  return null;
}

/**
 * Run `plan` until no linked pair is parted. The `edited` tracks always take part; the others
 * follow unless they are locked and not `freed`, and one that would pull half a pair away is made
 * to stand still and the plan is redone. Returns the shifts, the plan's own reason for giving up,
 * or the linked clip that cannot keep up with a partner the edit itself moves.
 */
function follow(
  p: Project,
  edited: ReadonlySet<ID>,
  plan: RipplePlan,
  freed: ReadonlySet<ID>,
): Shifts | string | Clip {
  const still = new Set<ID>();
  for (;;) {
    const shifts = plan((t) => edited.has(t.id) || ((!t.locked || freed.has(t.id)) && !still.has(t.id)));
    if (typeof shifts === 'string') return shifts;
    const pair = partedPair(p, shifts);
    if (!pair) return shifts;
    const followers = pair.filter((c) => shifts.get(c.id) && !edited.has(c.trackId));
    if (!followers.length) {
      const [a, b] = pair;
      return Math.abs(shifts.get(a.id) ?? 0) < Math.abs(shifts.get(b.id) ?? 0) ? a : b;
    }
    for (const c of followers) still.add(c.trackId);
  }
}

/** The shifts of a ripple that keeps every linked pair together, or the reason there is none. */
function settle(p: Project, edited: ReadonlySet<ID>, plan: RipplePlan): Shifts | string {
  // A lock is only to blame when the ripple goes through without it. The clip on the locked track
  // may just as well start before the cut or have no room, and then unlocking changes nothing. So
  // the locks in the way are tried open one by one before any of them is named.
  const freed = new Set<ID>();
  let unlock: Track | undefined;
  for (;;) {
    const outcome = follow(p, edited, plan, freed);
    if (typeof outcome === 'string') return outcome;
    if (outcome instanceof Map) {
      if (!unlock) return outcome;
      return `Unlock ${trackName(p, unlock)} to ripple: a linked clip on it has to move too.`;
    }
    const track = p.tracks[outcome.trackId];
    if (!track) return 'Cannot ripple here: a linked clip would fall out of sync.';
    if (!track.locked || freed.has(track.id)) {
      return `Cannot ripple here: a linked clip on ${trackName(p, track)} would fall out of sync.`;
    }
    freed.add(track.id);
    unlock ??= track;
  }
}

function shiftEdits(p: Project, shifts: Shifts, except?: { has(id: ID): boolean }): Edit[] {
  const edits: Edit[] = [];
  for (const [id, by] of shifts) {
    if (!except?.has(id)) edits.push({ op: 'updateClip', id, patch: { start: p.clips[id].start + by } });
  }
  return edits;
}

/** A stretch of a track that an edit has just emptied. */
interface Vacated {
  trackId: ID;
  start: number;
  end: number;
}

/**
 * The time an edit leaves empty, given what it removed from each track. Stretches that overlap in
 * time make one hole, and it counts only where all of their tracks are now empty: a split edit,
 * where the sound runs on after the picture, closes by what the two have in common and stays in
 * sync.
 */
function holesIn(q: Project, removed: Vacated[]): Span[] {
  const holes: Span[] = [];
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
    const kept: Span[] = [];
    for (const trackId of tracks) {
      const list = clipsOnTrack(q, trackId);
      for (let k = Math.max(0, findIndexAtOrBefore(list, start)); k < list.length; k++) {
        if (list[k].start >= end) break;
        kept.push([list[k].start, clipEnd(list[k])]);
      }
    }
    let cursor = start;
    for (const [s, e] of mergeSpans(kept)) {
      if (s > cursor) holes.push([cursor, s]);
      cursor = Math.max(cursor, e);
    }
    if (cursor < end) holes.push([cursor, end]);
  }
  return holes;
}

/**
 * Close `holes` (ascending, not overlapping) by pulling later clips left on the tracks that take
 * part. A track whose later clips would run into its earlier ones keeps that hole: it is never
 * shifted part of the way.
 */
function closeHoles(q: Project, holes: Span[], follows: (t: Track) => boolean): Shifts {
  const shifts: Shifts = new Map();
  for (const track of Object.values(q.tracks)) {
    const list = clipsOnTrack(q, track.id);
    if (!list.length || !follows(track)) continue;
    // reach[i] is where the clips up to and including the i-th end.
    const reach: number[] = [];
    let far = 0;
    for (const c of list) reach.push((far = Math.max(far, clipEnd(c))));
    // Right to left, so the clips before a hole are still where the snapshot has them. `pulled` is
    // what the first clip after the hole has already travelled for the holes between it and this one.
    const closed: boolean[] = [];
    let first = -1;
    let pulled = 0;
    for (let h = holes.length - 1; h >= 0; h--) {
      const [from, to] = holes[h];
      const next = findIndexAtOrBefore(list, to - 1) + 1;
      if (next >= list.length) continue;
      if (next !== first) {
        first = next;
        pulled = 0;
      }
      const room = list[next].start - pulled - (next > 0 ? reach[next - 1] : 0);
      if (room < to - from) continue;
      closed[h] = true;
      pulled += to - from;
    }
    let total = 0;
    let h = 0;
    for (const c of list) {
      for (; h < holes.length && holes[h][1] <= c.start; h++) {
        if (closed[h]) total += holes[h][1] - holes[h][0];
      }
      if (total) shifts.set(c.id, -total);
    }
  }
  return shifts;
}

/** Delete clips and close the time they occupied. */
export function rippleDelete(p: Project, ids: ID[]): RippleResult {
  const gone: Clip[] = [];
  for (const id of new Set(ids)) if (p.clips[id]) gone.push(p.clips[id]);
  if (!gone.length) return { edits: [], refused: null };
  const removals = gone.map((c): Edit => ({ op: 'removeClip', id: c.id }));
  const q = applyEdits(p, removals);
  const holes = holesIn(
    q,
    gone.map((c) => ({ trackId: c.trackId, start: c.start, end: clipEnd(c) })),
  );
  const edited = new Set(gone.map((c) => c.trackId));
  const shifts = settle(q, edited, (follows) => closeHoles(q, holes, follows));
  if (typeof shifts === 'string') return { edits: [], refused: shifts };
  return { edits: [...removals, ...shiftEdits(q, shifts)], refused: null };
}

/** Close the empty gap under `frame` on a track; the other tracks follow where they can. */
export function rippleCloseGap(p: Project, trackId: ID, frame: number): RippleResult {
  let prevEnd = 0;
  for (const c of clipsOnTrack(p, trackId)) {
    if (c.start > frame) {
      if (c.start <= prevEnd) break;
      const gap: Span[] = [[prevEnd, c.start]];
      const shifts = settle(p, new Set([trackId]), (follows) => closeHoles(p, gap, follows));
      if (typeof shifts === 'string') return { edits: [], refused: shifts };
      return { edits: shiftEdits(p, shifts), refused: null };
    }
    if (clipEnd(c) > frame) break;
    prevEnd = Math.max(prevEnd, clipEnd(c));
  }
  return { edits: [], refused: null };
}

interface TrimPlan {
  patches: Map<ID, Partial<Clip>>;
  shifts: Shifts;
  refused: string | null;
}

/** Work out a ripple trim of `d` frames (already within the clips' own limits) without committing to it. */
function planRippleTrim(p: Project, ids: ID[], edge: Edge, d: number): TrimPlan {
  const patches = new Map<ID, Partial<Clip>>();
  const edited = new Set<ID>();
  let firstStart = Infinity;
  let firstEnd = Infinity;
  for (const id of ids) {
    const c = p.clips[id];
    if (!c || patches.has(id)) continue;
    // A rippled head trim leaves the clip where it is; its content slides under the in point.
    patches.set(
      id,
      edge === 'start'
        ? { ...retime(c, c.start + d, clipEnd(c), p), start: c.start }
        : retime(c, c.start, clipEnd(c) + d, p),
    );
    edited.add(c.trackId);
    firstStart = Math.min(firstStart, c.start);
    firstEnd = Math.min(firstEnd, clipEnd(c));
  }
  const by = edge === 'start' ? -d : d;
  if (!patches.size || by === 0) return { patches, shifts: new Map(), refused: null };
  // On the trimmed clips' own tracks everything after them moves. Elsewhere the ripple starts at
  // the cut itself: for a head trim, where the removed (or added) head meets what is kept.
  const cut = edge === 'end' ? firstEnd : firstStart + Math.max(d, 0);
  const startOf = (c: Clip): number => patches.get(c.id)?.start ?? c.start;
  const endOf = (c: Clip): number => startOf(c) + (patches.get(c.id)?.duration ?? c.duration);

  const result = settle(p, edited, (follows) => {
    const shifts: Shifts = new Map();
    // The content of a head-trimmed clip travels with the ripple, which is what its linked
    // partners have to match.
    if (edge === 'start') for (const id of patches.keys()) shifts.set(id, by);
    for (const track of Object.values(p.tracks)) {
      if (!follows(track)) continue;
      const own = edited.has(track.id);
      const list = clipsOnTrack(p, track.id);
      const from = own ? firstEnd : cut;
      const moves = (c: Clip): boolean => c.start >= from && !patches.has(c.id);
      let clear = true;
      if (by < 0) {
        let reach = 0;
        for (const c of list) {
          if (!moves(c)) reach = Math.max(reach, endOf(c));
          else if (c.start + by < reach) clear = false;
        }
      } else {
        // Clips pushed right, and trimmed clips that grow, must stop short of the next one that stays.
        let floor = Infinity;
        for (let i = list.length - 1; i >= 0; i--) {
          const c = list[i];
          if (moves(c)) {
            if (clipEnd(c) + by > floor) clear = false;
            continue;
          }
          if (patches.has(c.id) && endOf(c) > floor) clear = false;
          floor = Math.min(floor, startOf(c));
        }
      }
      if (clear) {
        for (const c of list) if (moves(c)) shifts.set(c.id, by);
      } else if (own) {
        return `Cannot ripple here: there is no room on ${trackName(p, track)}.`;
      }
    }
    return shifts;
  });
  return typeof result === 'string'
    ? { patches, shifts: new Map(), refused: result }
    : { patches, shifts: result, refused: null };
}

/**
 * The delta nearest `limit` that `passes`, searching from `from`, which does. Only valid where a
 * delta beyond one that fails fails too.
 */
function furthest(from: number, limit: number, passes: (d: number) => boolean): number {
  if (limit === from || passes(limit)) return limit;
  const towards = Math.sign(limit - from);
  let lo = 0;
  let hi = Math.abs(limit - from);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(from + towards * mid)) lo = mid;
    else hi = mid;
  }
  return from + towards * lo;
}

/**
 * The deltas, in ascending order and ending with `limit`, at which a ripple trim on its way to
 * `limit` changes which clips on the other tracks it has to carry along.
 */
function rippleStops(p: Project, ids: ID[], edge: Edge, limit: number): number[] {
  const stops = new Set([limit]);
  // Only cutting into a head does that: the cut travels along the other tracks, and a clip there
  // drops out of the ripple once the cut has passed its start.
  if (edge === 'start') {
    const trimmed = new Set<ID>();
    const own = new Set<ID>();
    let firstStart = Infinity;
    let firstEnd = Infinity;
    for (const id of ids) {
      const c = p.clips[id];
      if (!c) continue;
      trimmed.add(id);
      own.add(c.trackId);
      firstStart = Math.min(firstStart, c.start);
      firstEnd = Math.min(firstEnd, clipEnd(c));
    }
    // A refusal always starts from a linked clip the trim itself moves: a trimmed clip, or one after
    // them on their tracks. Its partners have to come along, with them the clips that ripple on
    // their tracks, the partners of those, and so on. A track outside that chain never decides
    // anything, and a locked one stays put whatever the trim, so neither adds stops.
    const needed = new Set<ID>();
    const need = (c: Clip): void => {
      if (c.linkId) for (const id of linkedIds(p, c.id)) needed.add(p.clips[id].trackId);
    };
    for (const trackId of own) {
      for (const c of clipsOnTrack(p, trackId)) if (trimmed.has(c.id) || c.start >= firstEnd) need(c);
    }
    // A set also hands out what is added to it while it is being walked, which follows the chain.
    for (const trackId of needed) {
      const track = p.tracks[trackId];
      if (!track || track.locked || own.has(trackId)) continue;
      const list = clipsOnTrack(p, trackId);
      for (let i = findIndexAtOrBefore(list, firstStart) + 1; i < list.length; i++) {
        need(list[i]);
        const d = list[i].start - firstStart;
        if (d < limit) stops.add(d);
      }
    }
  }
  return Array.from(stops).sort((a, b) => a - b);
}

/**
 * The part of `range` a ripple trim can be dragged through, starting from no trim at all, before
 * the ripple is refused. A longer trim may go through again further on; the range only covers what
 * a drag reaches without crossing a delta that would do nothing.
 */
function rippleTrimRange(
  p: Project,
  ids: ID[],
  edge: Edge,
  range: { min: number; max: number },
): { min: number; max: number } {
  const passes = (d: number): boolean => planRippleTrim(p, ids, edge, d).refused === null;
  // While the same clips ripple, a longer trim is refused wherever a shorter one is. So the search
  // goes from one stop to the next and ends at the first one it cannot reach.
  let max = 0;
  for (const stop of rippleStops(p, ids, edge, range.max)) {
    max = furthest(max, stop, passes);
    if (max !== stop) break;
  }
  return { min: furthest(0, range.min, passes), max };
}

/** Trim one edge of the given clips by `delta` frames and move everything after them by as much. */
export function rippleTrim(p: Project, ids: ID[], edge: Edge, delta: number): RippleResult {
  const range = handleRange(p, ids, edge, true);
  const d = clamp(Math.round(delta), range.min, range.max);
  if (d === 0) return { edits: [], refused: null };
  const plan = planRippleTrim(p, ids, edge, d);
  if (plan.refused) return { edits: [], refused: plan.refused };
  const edits: Edit[] = [];
  for (const [id, patch] of plan.patches) edits.push({ op: 'updateClip', id, patch });
  edits.push(...shiftEdits(p, plan.shifts, plan.patches));
  return { edits, refused: null };
}

/**
 * Cut the clips lying under `frame` back to it, so that they end there (`end`) or begin there
 * (`start`), and close the time that takes out of the sequence. Unlike `rippleTrim` each clip
 * loses what it has on that side of the frame, however much that is, and the hole they leave in
 * common closes once.
 */
export function rippleTrimTo(p: Project, ids: ID[], edge: Edge, frame: number): RippleResult {
  const at = Math.round(frame);
  const trims: Edit[] = [];
  const removed: Vacated[] = [];
  for (const id of new Set(ids)) {
    const c = p.clips[id];
    if (!c || at <= c.start || at >= clipEnd(c)) continue;
    if (edge === 'start') {
      trims.push({ op: 'updateClip', id, patch: retime(c, at, clipEnd(c), p) });
      removed.push({ trackId: c.trackId, start: c.start, end: at });
    } else {
      trims.push({ op: 'updateClip', id, patch: retime(c, c.start, at, p) });
      removed.push({ trackId: c.trackId, start: at, end: clipEnd(c) });
    }
  }
  if (!trims.length) return { edits: [], refused: null };
  const q = applyEdits(p, trims);
  const holes = holesIn(q, removed);
  const edited = new Set(removed.map((r) => r.trackId));
  const shifts = settle(q, edited, (follows) => closeHoles(q, holes, follows));
  if (typeof shifts === 'string') return { edits: [], refused: shifts };
  return { edits: [...trims, ...shiftEdits(q, shifts)], refused: null };
}

// ───────────────────────────────────────────────────────────────── speed ──

export function setSpeed(p: Project, ids: ID[], speed: number, reverse?: boolean): Edit[] {
  const sp = clamp(speed, 0.05, 100);
  const edits: Edit[] = [];
  const set = new Set(ids);
  for (const id of ids) {
    const c = p.clips[id];
    if (!c || !hasSourceTime(c.type) || c.freeze) continue;
    const natural = Math.max(1, Math.round((c.duration * c.speed) / sp));
    let duration = natural;
    const { next } = neighbors(p, c);
    if (next && !set.has(next.id)) duration = Math.min(duration, Math.max(1, next.start - c.start));
    const patch: Partial<Clip> = { speed: sp, duration };
    if (reverse !== undefined) patch.reverse = reverse;
    // A reversed clip plays its source range from the top down, so what no longer fits before the
    // next clip comes off the bottom of the range and the first frame stays the one it was.
    if (duration < natural && (reverse ?? c.reverse)) {
      const per = (sp * p.settings.fpsDen) / p.settings.fpsNum;
      patch.sourceIn = c.sourceIn + (natural - duration) * per;
    }
    // Keyframes follow the picture, so they stretch with the speed even when the clip is cut short.
    if (Object.keys(c.keyframes).length) patch.keyframes = scaleKeyframes(c.keyframes, c.speed / sp);
    if (c.fadeIn > duration) patch.fadeIn = duration;
    if (c.fadeOut > duration) patch.fadeOut = duration;
    edits.push({ op: 'updateClip', id, patch });
  }
  return edits;
}

// ───────────────────────────────────────────────────────── copy & paste ──

/**
 * Freeze frame: hold the picture under `frame` for `hold` frames. Everything from `frame` onwards
 * ripples right on every unlocked track (so sync is kept), and a still copy of the clip — same
 * look, no motion, no sound — fills the gap.
 */
export function freezeFrame(p: Project, clipId: ID, frame: number, hold: number): OpResult {
  const c = p.clips[clipId];
  const length = Math.max(1, Math.round(hold));
  if (!c || c.type !== 'video' || !c.assetId || frame < c.start || frame >= clipEnd(c))
    return { edits: [], created: [] };
  const sourceIn = sourceTimeAt(c, frame - c.start, p);
  const unlocked = Object.values(p.tracks)
    .filter((t) => !t.locked)
    .map((t) => t.id);
  const edits = openGap(p, unlocked, frame, length);
  const still: Clip = {
    ...c,
    id: newId(),
    start: frame,
    duration: length,
    sourceIn,
    freeze: true,
    reverse: false,
    speed: 1,
    linkId: null,
    transIn: null,
    transOut: null,
    fadeIn: 0,
    fadeOut: 0,
    // The hold shows the clip exactly as it looked at that instant.
    keyframes: {},
    ...frozenValues(c, frame - c.start),
  };
  edits.push({ op: 'addClip', clip: still });
  return { edits, created: [still.id] };
}

/** Every animated property of `clip` (its own and its effects'), evaluated at `localFrame`. */
function frozenValues(clip: Clip, localFrame: number): Partial<Clip> {
  const out: Record<string, unknown> = {};
  let effects: EffectInstance[] | null = null;
  for (const path in clip.keyframes) {
    const kfs = clip.keyframes[path];
    if (!kfs.length || baseValue(clip, path) === undefined) continue;
    const v = evalKeyframes(kfs, localFrame);
    if (path.startsWith('fx:')) {
      const [, fxId, key] = path.split(':');
      effects ??= clip.effects;
      effects = effects.map((e) => (e.id === fxId ? { ...e, params: { ...e.params, [key]: v } } : e));
    } else out[path] = v;
  }
  if (effects) out.effects = effects;
  return out as Partial<Clip>;
}

/**
 * Paste clips at `frame`, keeping their spacing. Clips go back onto the track they were copied
 * from, overwriting what is there. When that track is gone, locked or of the wrong kind, everything
 * copied from it moves together to one free track (a new one if need be), so layers that were
 * stacked stay on separate tracks and nothing else is overwritten.
 */
export function pasteClips(p: Project, items: Clip[], frame: number): OpResult {
  if (!items.length) return { edits: [], created: [] };
  const minStart = Math.min(...items.map((c) => c.start));
  const startOf = (src: Clip): number => Math.max(0, frame + (src.start - minStart));

  // Everything copied from one track travels as a lane.
  interface Lane {
    kind: TrackKind;
    /** The track the clips were copied from, when it still exists as a track of their kind. */
    home: Track | null;
    spans: Span[];
  }
  const lanes = new Map<string, Lane>();
  const laneKey = (src: Clip): string => `${trackKindFor(src.type)}:${src.trackId}`;
  for (const src of items) {
    const kind = trackKindFor(src.type);
    let lane = lanes.get(laneKey(src));
    if (!lane) {
      const track = p.tracks[src.trackId];
      lanes.set(laneKey(src), (lane = { kind, home: track?.kind === kind ? track : null, spans: [] }));
    }
    lane.spans.push([startOf(src), startOf(src) + src.duration]);
  }

  /** Lane key → the track its clips land on. */
  const targets = new Map<string, ID>();
  const displaced: [string, Lane][] = [];
  for (const [key, lane] of lanes) {
    if (lane.home && !lane.home.locked) targets.set(key, lane.home.id);
    else displaced.push([key, lane]);
  }
  // Lanes that cannot go home: those from a locked track first, in stacking order, then the ones
  // whose track is unknown, in the order they were copied.
  const rank = (lane: Lane): number => lane.home?.order ?? Infinity;
  displaced.sort(([, x], [, y]) => (rank(x) === rank(y) ? 0 : rank(x) - rank(y)));
  const taken = new Set(targets.values());

  const edits: Edit[] = [];
  let working = p;
  let below = -Infinity;
  for (const [key, lane] of displaced) {
    const video = lane.kind === 'video';
    // Picture stacks upwards: stay above the track the clips came from and the lane placed before.
    const floor = video ? Math.max(below, lane.home?.order ?? -Infinity) : -Infinity;
    let target = (video ? tracksOf(working).video : tracksOf(working).audio).find(
      (t) =>
        !t.locked &&
        !taken.has(t.id) &&
        t.order > floor &&
        lane.spans.every(([s, e]) => isRegionFree(working, t.id, s, e)),
    );
    if (!target) {
      target = makeTrack(lane.kind, nextOrder(working, lane.kind));
      edits.push({ op: 'addTrack', track: target });
      working = { ...working, tracks: { ...working.tracks, [target.id]: target } };
    }
    targets.set(key, target.id);
    taken.add(target.id);
    if (video) below = target.order;
  }

  const linkMap = new Map<ID, ID>();
  const clips: Clip[] = [];
  for (const src of items) {
    let linkId: ID | null = null;
    if (src.linkId) {
      linkId = linkMap.get(src.linkId) ?? newId();
      linkMap.set(src.linkId, linkId);
    }
    const trackId = targets.get(laneKey(src)) ?? src.trackId;
    clips.push({ ...src, id: newId(), trackId, start: startOf(src), linkId });
  }
  // A link group of one is not a link.
  const counts = new Map<ID, number>();
  for (const c of clips) if (c.linkId) counts.set(c.linkId, (counts.get(c.linkId) ?? 0) + 1);
  for (const c of clips) if (c.linkId && counts.get(c.linkId) === 1) c.linkId = null;
  const ins = insertClips(working, clips);
  return { edits: [...edits, ...ins.edits], created: ins.created };
}

// ──────────────────────────────────────────────────────────────── tracks ──

export function addTrack(p: Project, kind: TrackKind): { edits: Edit[]; trackId: ID } {
  const track = makeTrack(kind, nextOrder(p, kind));
  return { edits: [{ op: 'addTrack', track }], trackId: track.id };
}

export function removeTrack(p: Project, id: ID): Edit[] {
  if (!p.tracks[id]) return [];
  const edits: Edit[] = clipsOnTrack(p, id).map((c) => ({ op: 'removeClip', id: c.id }) as Edit);
  edits.push({ op: 'removeTrack', id });
  return edits;
}

/** Swap a track with its neighbour. `dir` = +1 moves it up in the stacking order. */
export function moveTrack(p: Project, id: ID, dir: 1 | -1): Edit[] {
  const t = p.tracks[id];
  if (!t) return [];
  const list = t.kind === 'video' ? tracksOf(p).video : tracksOf(p).audio;
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [];
  const other = list[j];
  // Orders can collide after concurrent edits; renumber the pair explicitly.
  const a = t.order === other.order ? t.order + dir : other.order;
  return [
    { op: 'updateTrack', id: t.id, patch: { order: a } },
    { op: 'updateTrack', id: other.id, patch: { order: t.order } },
  ];
}

// ─────────────────────────────────────────────────────────────── linking ──

export function linkClips(p: Project, ids: ID[]): Edit[] {
  const valid = ids.filter((id) => p.clips[id]);
  if (valid.length < 2) return [];
  const linkId = newId();
  return valid.map((id) => ({ op: 'updateClip', id, patch: { linkId } }) as Edit);
}

export function unlinkClips(p: Project, ids: ID[]): Edit[] {
  return ids
    .filter((id) => p.clips[id]?.linkId)
    .map((id) => ({ op: 'updateClip', id, patch: { linkId: null } }) as Edit);
}

// ─────────────────────────────────────────────────────────── transitions ──

/** The clip immediately before `clip` on its track if it butts up against it. */
export function adjacentPrev(p: Project, clip: Clip): Clip | null {
  const { prev } = neighbors(p, clip);
  return prev && clipEnd(prev) === clip.start ? prev : null;
}

export function adjacentNext(p: Project, clip: Clip): Clip | null {
  const { next } = neighbors(p, clip);
  return next && next.start === clipEnd(clip) ? next : null;
}

export function maxTransitionDuration(p: Project, clip: Clip, side: 'in' | 'out'): number {
  if (side === 'in') {
    const prev = adjacentPrev(p, clip);
    return prev ? Math.max(1, Math.min(clip.duration, prev.duration)) : clip.duration;
  }
  return clip.duration;
}

export function setTransition(p: Project, clipId: ID, side: 'in' | 'out', t: Transition | null): Edit[] {
  const c = p.clips[clipId];
  if (!c) return [];
  const value = t
    ? { ...t, duration: clamp(Math.round(t.duration), 1, maxTransitionDuration(p, c, side)) }
    : null;
  return [{ op: 'updateClip', id: clipId, patch: side === 'in' ? { transIn: value } : { transOut: value } }];
}

// ───────────────────────────────────────────────── properties & keyframes ──

/** Read the stored (un-animated) value of a property path. */
export function baseValue(clip: Clip, path: string): number | undefined {
  if (path.startsWith('fx:')) {
    const [, fxId, key] = path.split(':');
    const v = clip.effects.find((e) => e.id === fxId)?.params[key];
    return typeof v === 'number' ? v : undefined;
  }
  const v = (clip as unknown as Record<string, unknown>)[path];
  return typeof v === 'number' ? v : undefined;
}

function writeBase(clip: Clip, path: string, value: number): Partial<Clip> {
  if (path.startsWith('fx:')) {
    const [, fxId, key] = path.split(':');
    return {
      effects: clip.effects.map((e) => (e.id === fxId ? { ...e, params: { ...e.params, [key]: value } } : e)),
    };
  }
  return { [path]: value } as Partial<Clip>;
}

/**
 * Write a numeric property. If the property is animated a keyframe is set at `localFrame`,
 * otherwise the base value changes.
 */
export function writeProp(clip: Clip, path: string, value: number, localFrame: number): Partial<Clip> {
  const kfs = clip.keyframes[path];
  if (kfs && kfs.length) {
    const t = clamp(Math.round(localFrame), 0, Math.max(0, clip.duration - 1));
    const existing = kfs.find((k) => k.t === t);
    return {
      keyframes: {
        ...clip.keyframes,
        [path]: upsertKeyframe(kfs, { t, v: value, e: existing?.e ?? 'easeInOut' }),
      },
    };
  }
  return writeBase(clip, path, value);
}

/** Add a keyframe at `localFrame` capturing the current value, or remove the one already there. */
export function toggleKeyframe(clip: Clip, path: string, localFrame: number, current: number): Partial<Clip> {
  const t = clamp(Math.round(localFrame), 0, Math.max(0, clip.duration - 1));
  const kfs = clip.keyframes[path] ?? [];
  const keyframes = { ...clip.keyframes };
  if (kfs.some((k) => k.t === t)) {
    const rest = kfs.filter((k) => k.t !== t);
    if (rest.length) keyframes[path] = rest;
    else delete keyframes[path];
    // When the last keyframe goes, keep what the user was looking at.
    return rest.length ? { keyframes } : { keyframes, ...writeBase(clip, path, current) };
  }
  keyframes[path] = upsertKeyframe(kfs, { t, v: current, e: 'easeInOut' });
  return { keyframes };
}

export function clearKeyframes(clip: Clip, path: string, current: number): Partial<Clip> {
  const keyframes = { ...clip.keyframes };
  delete keyframes[path];
  return { keyframes, ...writeBase(clip, path, current) };
}

/**
 * Choose how the value travels from the keyframe at clip-local frame `t` to the next one: `linear`,
 * `hold` (no change until the next keyframe), `ease`, `easeIn`, `easeOut`, `easeInOut`, or a custom
 * bezier `[x1, y1, x2, y2]` as in CSS. Returns an empty patch when there is nothing to change.
 */
export function setKeyframeEasing(clip: Clip, path: string, t: number, e: Easing): Partial<Clip> {
  const kfs = clip.keyframes[path];
  const easing = conformEasing(e);
  if (!kfs || !kfs.some((k) => k.t === t && !deepEqual(k.e, easing))) return {};
  return {
    keyframes: {
      ...clip.keyframes,
      [path]: kfs.map((k): Keyframe => (k.t === t ? { ...k, e: easing } : k)),
    },
  };
}

export function setEffectParam(clip: Clip, effectId: ID, key: string, value: ParamValue): Partial<Clip> {
  return {
    effects: clip.effects.map((e): EffectInstance =>
      e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e,
    ),
  };
}

/** Removing an effect also drops its keyframes. */
export function removeEffect(clip: Clip, effectId: ID): Partial<Clip> {
  const keyframes: Record<string, Keyframe[]> = {};
  for (const [k, v] of Object.entries(clip.keyframes)) if (!k.startsWith(`fx:${effectId}:`)) keyframes[k] = v;
  return { effects: clip.effects.filter((e) => e.id !== effectId), keyframes };
}

// ───────────────────────────────────────────────────────────── conforming ──

/**
 * Re-time the entire sequence for a new frame rate, preserving real-time positions. Clips that are
 * in the document without a track (`ProjectStore.hiddenClips`) are not in the snapshot; the store
 * re-times those itself when it commits the new rate.
 */
export function changeFrameRate(p: Project, fpsNum: number, fpsDen: number): Edit[] {
  const k = fpsNum / fpsDen / fpsOf(p.settings);
  const edits: Edit[] = [{ op: 'settings', patch: { fpsNum, fpsDen } }];
  if (sameRate(k)) return edits;
  for (const c of Object.values(p.clips)) edits.push({ op: 'updateClip', id: c.id, patch: clipAtRate(c, k) });
  for (const m of Object.values(p.markers))
    edits.push({ op: 'setMarker', marker: { ...m, frame: Math.round(m.frame * k) } });
  return edits;
}

/** Default chip colour for a clip. */
export const clipColor = (c: Clip): string => c.label ?? CLIP_TYPE_COLORS[c.type];
