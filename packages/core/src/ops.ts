/**
 * Editing operations.
 *
 * Every function here is pure: it inspects a Project snapshot and returns the list of atomic `Edit`s
 * that perform the operation. Callers either commit them to the ProjectStore (one undo step, synced to
 * collaborators) or run them through `applyEdits` to render a live preview while dragging.
 */
import { CLIP_TYPE_COLORS, DEFAULT_SHAPE, DEFAULT_TEXT, hasSourceTime, makeClip, makeTrack } from './defaults';
import { newId } from './ids';
import { scaleKeyframes, shiftKeyframes, upsertKeyframe } from './keyframes';
import {
  clipEnd,
  clipsOnTrack,
  handles,
  isRegionFree,
  neighbors,
  sourcePerFrame,
  tracksOf,
} from './query';
import { applyEdits } from './store';
import { secondsToFrame } from './time';
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
import { clamp } from './util';

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
    const patch = retime(clip, s, e, p);
    if (s !== clip.start) {
      patch.transIn = null;
      patch.fadeIn = 0;
    }
    if (e !== end) {
      patch.transOut = null;
      patch.fadeOut = 0;
    }
    if (i === 0) edits.push({ op: 'updateClip', id: clip.id, patch });
    else edits.push({ op: 'addClip', clip: { ...clip, ...patch, id: newId(), linkId: null } });
  });
  return edits;
}

/** Make room on a track: everything overlapping `regions` (except `exclude`) is overwritten. */
export function clearRegions(p: Project, trackId: ID, regions: Span[], exclude: ReadonlySet<ID> = new Set()): Edit[] {
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
  for (const trackId of new Set(trackIds)) {
    for (const c of clipsOnTrack(p, trackId)) {
      const end = clipEnd(c);
      if (end <= frame) continue;
      if (c.start >= frame) {
        edits.push({ op: 'updateClip', id: c.id, patch: { start: c.start + length } });
      } else {
        const right: Clip = {
          ...c,
          ...retime(c, frame, end, p),
          id: newId(),
          linkId: null,
          transIn: null,
          fadeIn: 0,
        };
        right.start = frame + length;
        edits.push({ op: 'updateClip', id: c.id, patch: { ...retime(c, c.start, frame, p), transOut: null, fadeOut: 0 } });
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

  const wantVideo = (asset.kind === 'video' && asset.hasVideo && opts.only !== 'audio') || asset.kind === 'image';
  const wantAudio = (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)) && opts.only !== 'video';
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
export function addGenerator(p: Project, type: 'text' | 'shape' | 'solid' | 'adjustment', opts: AddGeneratorOptions): OpResult {
  const edits: Edit[] = [];
  const start = Math.max(0, Math.round(opts.frame));
  const duration = Math.max(1, Math.round(opts.duration ?? secondsToFrame(DEFAULT_STILL_SECONDS, p.settings)));
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
  const names: Record<string, string> = { text: 'Text', shape: 'Shape', solid: 'Solid', adjustment: 'Adjustment layer' };
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

/** Allowed range for a trim delta (frames) applied to the same edge of several clips at once. */
export function trimRange(p: Project, ids: ID[], edge: Edge, ripple: boolean): { min: number; max: number } {
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

/** Trim one edge of the given clips by `delta` frames (positive = later). */
export function trimClips(p: Project, ids: ID[], edge: Edge, delta: number, ripple = false): Edit[] {
  const range = trimRange(p, ids, edge, ripple);
  const d = clamp(Math.round(delta), range.min, range.max);
  if (d === 0) return [];
  const edits: Edit[] = [];
  const set = new Set(ids);
  let rippleFrom = Infinity;
  const tracks = new Set<ID>();
  for (const id of ids) {
    const c = p.clips[id];
    if (!c) continue;
    tracks.add(c.trackId);
    if (edge === 'start') {
      const patch = retime(c, c.start + d, clipEnd(c), p);
      if (ripple) patch.start = c.start;
      edits.push({ op: 'updateClip', id, patch });
      rippleFrom = Math.min(rippleFrom, clipEnd(c));
    } else {
      edits.push({ op: 'updateClip', id, patch: retime(c, c.start, clipEnd(c) + d, p) });
      rippleFrom = Math.min(rippleFrom, clipEnd(c));
    }
  }
  if (ripple && rippleFrom !== Infinity) {
    edits.push(...rippleShift(p, tracks, rippleFrom, edge === 'start' ? -d : d, set));
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
      id: newId(),
      linkId,
      transIn: null,
      fadeIn: 0,
    };
    edits.push({
      op: 'updateClip',
      id,
      patch: { ...retime(c, c.start, frame, p), transOut: null, fadeOut: 0 },
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
  const edits: Edit[] = ids.filter((id) => p.clips[id]).map((id) => ({ op: 'removeClip', id }) as Edit);
  if (!ripple) return edits;
  const removed = new Set(ids);
  const byTrack = new Map<ID, Clip[]>();
  for (const id of ids) {
    const c = p.clips[id];
    if (!c) continue;
    const list = byTrack.get(c.trackId) ?? [];
    list.push(c);
    byTrack.set(c.trackId, list);
  }
  for (const [trackId, gone] of byTrack) {
    const spans = mergeSpans(gone.map((c) => [c.start, clipEnd(c)] as Span));
    for (const c of clipsOnTrack(p, trackId)) {
      if (removed.has(c.id)) continue;
      let shift = 0;
      for (const [s, e] of spans) if (e <= c.start) shift += e - s;
      if (shift) edits.push({ op: 'updateClip', id: c.id, patch: { start: c.start - shift } });
    }
  }
  return edits;
}

/** Close the empty gap under `frame` on a track by pulling later clips left. */
export function closeGap(p: Project, trackId: ID, frame: number): Edit[] {
  const list = clipsOnTrack(p, trackId);
  let prevEnd = 0;
  for (const c of list) {
    if (c.start > frame) {
      const gap = c.start - prevEnd;
      return gap > 0 ? rippleShift(p, [trackId], c.start, -gap) : [];
    }
    if (clipEnd(c) > frame) return [];
    prevEnd = clipEnd(c);
  }
  return [];
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

// ───────────────────────────────────────────────────────────────── speed ──

export function setSpeed(p: Project, ids: ID[], speed: number, reverse?: boolean): Edit[] {
  const sp = clamp(speed, 0.05, 100);
  const edits: Edit[] = [];
  const set = new Set(ids);
  for (const id of ids) {
    const c = p.clips[id];
    if (!c || !hasSourceTime(c.type)) continue;
    let duration = Math.max(1, Math.round((c.duration * c.speed) / sp));
    const { next } = neighbors(p, c);
    if (next && !set.has(next.id)) duration = Math.min(duration, Math.max(1, next.start - c.start));
    const patch: Partial<Clip> = { speed: sp, duration };
    if (reverse !== undefined) patch.reverse = reverse;
    if (Object.keys(c.keyframes).length) patch.keyframes = scaleKeyframes(c.keyframes, duration / c.duration);
    if (c.fadeIn > duration) patch.fadeIn = duration;
    if (c.fadeOut > duration) patch.fadeOut = duration;
    edits.push({ op: 'updateClip', id, patch });
  }
  return edits;
}

// ───────────────────────────────────────────────────────── copy & paste ──

export function pasteClips(p: Project, items: Clip[], frame: number): OpResult {
  if (!items.length) return { edits: [], created: [] };
  const minStart = Math.min(...items.map((c) => c.start));
  const linkMap = new Map<ID, ID>();
  const { video, audio } = tracksOf(p);
  const edits: Edit[] = [];
  let working = p;
  const clips: Clip[] = [];
  for (const src of items) {
    const kind = trackKindFor(src.type);
    let track: Track | undefined = working.tracks[src.trackId];
    if (!track || track.kind !== kind || track.locked) {
      track = (kind === 'video' ? video : audio).find((t) => !t.locked);
    }
    if (!track) {
      track = makeTrack(kind, nextOrder(working, kind));
      edits.push({ op: 'addTrack', track });
      working = { ...working, tracks: { ...working.tracks, [track.id]: track } };
    }
    let linkId: ID | null = null;
    if (src.linkId) {
      linkId = linkMap.get(src.linkId) ?? newId();
      linkMap.set(src.linkId, linkId);
    }
    clips.push({ ...src, id: newId(), trackId: track.id, start: Math.max(0, frame + (src.start - minStart)), linkId });
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
  return ids.filter((id) => p.clips[id]?.linkId).map((id) => ({ op: 'updateClip', id, patch: { linkId: null } }) as Edit);
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
  const value = t ? { ...t, duration: clamp(Math.round(t.duration), 1, maxTransitionDuration(p, c, side)) } : null;
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
      keyframes: { ...clip.keyframes, [path]: upsertKeyframe(kfs, { t, v: value, e: existing?.e ?? 'easeInOut' }) },
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

export function setKeyframeEasing(clip: Clip, path: string, t: number, e: Easing): Partial<Clip> {
  const kfs = clip.keyframes[path];
  if (!kfs) return {};
  return { keyframes: { ...clip.keyframes, [path]: kfs.map((k): Keyframe => (k.t === t ? { ...k, e } : k)) } };
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

/** Re-time the entire sequence for a new frame rate, preserving real-time positions. */
export function changeFrameRate(p: Project, fpsNum: number, fpsDen: number): Edit[] {
  const old = p.settings.fpsNum / p.settings.fpsDen;
  const next = fpsNum / fpsDen;
  const k = next / old;
  const edits: Edit[] = [{ op: 'settings', patch: { fpsNum, fpsDen } }];
  if (Math.abs(k - 1) < 1e-9) return edits;
  const r = (v: number) => Math.round(v * k);
  for (const c of Object.values(p.clips)) {
    const start = r(c.start);
    const end = Math.max(start + 1, r(clipEnd(c)));
    edits.push({
      op: 'updateClip',
      id: c.id,
      patch: {
        start,
        duration: end - start,
        fadeIn: r(c.fadeIn),
        fadeOut: r(c.fadeOut),
        keyframes: scaleKeyframes(c.keyframes, k),
        transIn: c.transIn ? { ...c.transIn, duration: Math.max(1, r(c.transIn.duration)) } : null,
        transOut: c.transOut ? { ...c.transOut, duration: Math.max(1, r(c.transOut.duration)) } : null,
        text: c.text
          ? {
              ...c.text,
              animIn: { ...c.text.animIn, duration: r(c.text.animIn.duration) },
              animOut: { ...c.text.animOut, duration: r(c.text.animOut.duration) },
            }
          : null,
      },
    });
  }
  for (const m of Object.values(p.markers)) edits.push({ op: 'setMarker', marker: { ...m, frame: r(m.frame) } });
  return edits;
}

/** Default chip colour for a clip. */
export const clipColor = (c: Clip): string => c.label ?? CLIP_TYPE_COLORS[c.type];
