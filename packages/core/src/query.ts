/** Read-only selectors over a Project snapshot. Heavy ones are memoised on object identity. */
import { hasSourceTime } from './defaults';
import { mediaToStream, rampTable, streamSpeed, streamToMedia } from './ramp';
import type { Asset, Clip, ID, Project, Track } from './types';
import { clamp, memoByRef } from './util';

export const clipEnd = (c: Clip): number => c.start + c.duration;

const sortTracks = memoByRef((tracks: Project['tracks']) => {
  const all = Object.values(tracks);
  const video = all
    .filter((t) => t.kind === 'video')
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const audio = all
    .filter((t) => t.kind === 'audio')
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  return { video, audio };
});

/** Video tracks bottom → top (render order) and audio tracks top → bottom (list order). */
export const tracksOf = (p: Project): { video: Track[]; audio: Track[] } => sortTracks(p.tracks);

/** Tracks in the order they are listed in the timeline UI: top video track first, then audio. */
export function displayTracks(p: Project): Track[] {
  const { video, audio } = tracksOf(p);
  return [...video.slice().reverse(), ...audio];
}

/** Human label such as V2 or A1, falling back when the track has no custom name. */
export function trackLabel(p: Project, track: Track): string {
  const { video, audio } = tracksOf(p);
  const list = track.kind === 'video' ? video : audio;
  const idx = list.findIndex((t) => t.id === track.id);
  return `${track.kind === 'video' ? 'V' : 'A'}${idx + 1}`;
}

const groupClips = memoByRef((clips: Project['clips']) => {
  const map = new Map<ID, Clip[]>();
  for (const c of Object.values(clips)) {
    let list = map.get(c.trackId);
    if (!list) map.set(c.trackId, (list = []));
    list.push(c);
  }
  for (const list of map.values()) list.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  return map;
});

const EMPTY: Clip[] = [];

/** Clips of a track sorted by start frame. */
export const clipsOnTrack = (p: Project, trackId: ID): Clip[] => groupClips(p.clips).get(trackId) ?? EMPTY;

const computeEnd = memoByRef((clips: Project['clips']) => {
  let end = 0;
  for (const c of Object.values(clips)) end = Math.max(end, c.start + c.duration);
  return end;
});

/** Sequence length in frames (end of the last clip). */
export const sequenceEnd = (p: Project): number => computeEnd(p.clips);

/** Index of the last clip whose start is <= frame, or -1. */
export function findIndexAtOrBefore(list: readonly Clip[], frame: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= frame) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The clip covering `frame` on a track, if any. */
export function clipAt(p: Project, trackId: ID, frame: number): Clip | null {
  const list = clipsOnTrack(p, trackId);
  // Tracks are normally overlap-free, but concurrent edits can briefly produce overlaps. Prefer the
  // clip that starts latest so the result is at least deterministic for every peer.
  for (let i = findIndexAtOrBefore(list, frame); i >= 0; i--) {
    const c = list[i];
    if (frame < c.start + c.duration) return c;
    if (frame - c.start > 100000) break;
  }
  return null;
}

export function neighbors(p: Project, clip: Clip): { prev: Clip | null; next: Clip | null } {
  const list = clipsOnTrack(p, clip.trackId);
  const i = list.findIndex((c) => c.id === clip.id);
  return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}

const groupLinks = memoByRef((clips: Project['clips']) => {
  const map = new Map<ID, ID[]>();
  for (const c of Object.values(clips)) {
    if (!c.linkId) continue;
    const list = map.get(c.linkId);
    if (list) list.push(c.id);
    else map.set(c.linkId, [c.id]);
  }
  return map;
});

/** All clip ids linked with `id` (including itself). */
export function linkedIds(p: Project, id: ID): ID[] {
  const c = p.clips[id];
  if (!c) return [];
  if (!c.linkId) return [id];
  return groupLinks(p.clips).get(c.linkId)?.slice() ?? [id];
}

/** Expand a selection to include linked partners. */
export function withLinked(p: Project, ids: Iterable<ID>): ID[] {
  const out = new Set<ID>();
  for (const id of ids) for (const l of linkedIds(p, id)) out.add(l);
  return Array.from(out);
}

const streamInOf = memoByRef((clip: Clip): number =>
  mediaToStream(rampTable(clip.ramp as NonNullable<Clip['ramp']>), clip.sourceIn),
);

/**
 * The stream time at which a clip's media reaches its in point (see `timeMap`). On a ramp it takes
 * an iteration to find, and is kept for each clip object: a clip changes by being replaced.
 */
export const streamIn = (clip: Clip): number =>
  clip.ramp && !clip.freeze ? streamInOf(clip) : clip.sourceIn / clamp(clip.speed, 0.05, 100);

/**
 * Seconds of source media consumed per timeline frame (zero for a freeze frame). On a ramp there
 * is no such number: this is its mean over the clip, for callers that want one rate all the same.
 */
export const sourcePerFrame = (clip: Clip, p: Project): number =>
  clip.ramp && !clip.freeze
    ? (mediaAt(clip, clip.duration, p) - clip.sourceIn) / clip.duration
    : clip.freeze
      ? 0
      : (clip.speed * p.settings.fpsDen) / p.settings.fpsNum;

/**
 * The second of media a clip is at, `u` frames after its in point, going forwards through the
 * media whichever way the clip plays. `u` is any real number: beyond the clip the speed carries on
 * (along the ramp, then at its outermost speed), which is what a trim outwards or a transition
 * handle shows.
 */
export function mediaAt(clip: Clip, u: number, p: Project): number {
  if (clip.freeze) return clip.sourceIn;
  if (clip.ramp)
    return streamToMedia(rampTable(clip.ramp), streamIn(clip) + (u * p.settings.fpsDen) / p.settings.fpsNum);
  return clip.sourceIn + u * sourcePerFrame(clip, p);
}

/** How many frames after its in point (as a real number) a clip reaches second `m` of its media, going forwards. */
export function frameOfMedia(clip: Clip, m: number, p: Project): number {
  if (clip.ramp && !clip.freeze)
    return (
      ((mediaToStream(rampTable(clip.ramp), m) - streamIn(clip)) * p.settings.fpsNum) / p.settings.fpsDen
    );
  return (m - clip.sourceIn) / sourcePerFrame(clip, p);
}

/** The stretch of media a clip covers, in seconds: from its in point to the end of its last frame. */
export function sourceSpan(clip: Clip, p: Project): { in: number; out: number } {
  return { in: clip.sourceIn, out: mediaAt(clip, clip.duration, p) };
}

/** The speed of a clip `u` frames after its in point, counted as `mediaAt` counts. Zero for a freeze. */
export function speedAt(clip: Clip, u: number, p: Project): number {
  if (clip.freeze) return 0;
  if (clip.ramp)
    return streamSpeed(rampTable(clip.ramp), streamIn(clip) + (u * p.settings.fpsDen) / p.settings.fpsNum);
  return clip.speed;
}

/** Seconds of media a clip covers for each second it lasts. */
export function meanSpeed(clip: Clip, p: Project): number {
  if (clip.freeze) return 0;
  if (clip.ramp) return (sourcePerFrame(clip, p) * p.settings.fpsNum) / p.settings.fpsDen;
  return clip.speed;
}

/** The slowest and the fastest a clip plays over the stretch of media it covers. */
export function speedRange(clip: Clip, p: Project): { lo: number; hi: number } {
  if (clip.freeze) return { lo: 0, hi: 0 };
  if (!clip.ramp) return { lo: clip.speed, hi: clip.speed };
  // The speed moves one way between two points, so it is at its extremes on a point or at an end.
  const t = rampTable(clip.ramp);
  const { in: from, out: to } = sourceSpan(clip, p);
  const ends = [speedAt(clip, 0, p), speedAt(clip, clip.duration, p)];
  let lo = Math.min(...ends);
  let hi = Math.max(...ends);
  for (let i = 0; i < t.n; i++) {
    if (t.m[i] <= from || t.m[i] >= to) continue;
    lo = Math.min(lo, t.v[i]);
    hi = Math.max(hi, t.v[i]);
  }
  return { lo, hi };
}

/**
 * A clock of media, in seconds, for whoever plays it: where the media is at a stream time, when it
 * reaches a second, and how fast it runs there. A clip is the stretch of its stream that starts at
 * `streamIn` and lasts as long as the clip does.
 */
export interface TimeMap {
  media(tau: number): number;
  stream(m: number): number;
  speed(tau: number): number;
}

/**
 * The clock a clip plays its media by: that of its ramp, or of its one speed, brought inside the
 * range a speed can be set to.
 */
export function timeMap(clip: Clip): TimeMap {
  if (clip.ramp && !clip.freeze) {
    const t = rampTable(clip.ramp);
    return {
      media: (tau) => streamToMedia(t, tau),
      stream: (m) => mediaToStream(t, m),
      speed: (tau) => streamSpeed(t, tau),
    };
  }
  const s = clamp(clip.speed, 0.05, 100);
  return { media: (tau) => tau * s, stream: (m) => m / s, speed: () => s };
}

/**
 * Source media time (seconds) shown at a clip-local frame. Local frames outside 0…duration are
 * valid (used for transition handles) and are clamped to the asset bounds by the caller.
 */
export function sourceTimeAt(clip: Clip, localFrame: number, p: Project): number {
  if (clip.ramp && !clip.freeze)
    return mediaAt(clip, clip.reverse ? clip.duration - 1 - localFrame : localFrame, p);
  const per = sourcePerFrame(clip, p);
  if (per === 0) return clip.sourceIn;
  if (clip.reverse) return clip.sourceIn + (clip.duration - 1 - localFrame) * per;
  return clip.sourceIn + localFrame * per;
}

/** How many extra frames a clip could be extended by at its head and tail given its source media. */
export function handles(clip: Clip, asset: Asset | undefined, p: Project): { head: number; tail: number } {
  if (!hasSourceTime(clip.type) || clip.freeze || !asset || asset.duration <= 0)
    return { head: Infinity, tail: Infinity };
  if (clip.ramp) {
    // Counted on the ramp's own clock, as `retime` moves an edge, so that a trim the handles allow
    // never asks for media the file does not have.
    const t = rampTable(clip.ramp);
    const { fpsNum, fpsDen } = p.settings;
    const eps = 1e-6;
    const tauIn = streamIn(clip);
    const tauOut = tauIn + (clip.duration * fpsDen) / fpsNum;
    const before =
      clip.sourceIn > 0 ? Math.floor(((tauIn - mediaToStream(t, 0)) * fpsNum) / fpsDen + eps) : 0;
    const after = Math.max(
      0,
      Math.floor(((mediaToStream(t, asset.duration) - tauOut) * fpsNum) / fpsDen + eps),
    );
    return clip.reverse ? { head: after, tail: before } : { head: before, tail: after };
  }
  const per = sourcePerFrame(clip, p);
  const used = clip.duration * per;
  const before = Math.max(0, clip.sourceIn);
  const after = Math.max(0, asset.duration - (clip.sourceIn + used));
  const eps = 1e-6;
  const headSrc = clip.reverse ? after : before;
  const tailSrc = clip.reverse ? before : after;
  return { head: Math.floor(headSrc / per + eps), tail: Math.floor(tailSrc / per + eps) };
}

/** Frames worth snapping to: clip edges, markers, playhead, sequence start. */
export function snapPoints(p: Project, exclude: ReadonlySet<ID>, extra: number[] = []): number[] {
  const pts = new Set<number>([0, ...extra]);
  for (const c of Object.values(p.clips)) {
    if (exclude.has(c.id)) continue;
    pts.add(c.start);
    pts.add(c.start + c.duration);
  }
  for (const m of Object.values(p.markers)) pts.add(m.frame);
  return Array.from(pts).sort((a, b) => a - b);
}

/** Nearest snap point within `threshold` frames, or null. */
export function snapTo(frame: number, points: readonly number[], threshold: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid] < frame) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const best = Math.abs(a - frame) <= Math.abs(b - frame) ? a : b;
  return Math.abs(best - frame) <= threshold ? best : null;
}

/** Edit points (cuts) across the whole sequence, sorted. */
export function editPoints(p: Project): number[] {
  const pts = new Set<number>([0]);
  for (const c of Object.values(p.clips)) {
    pts.add(c.start);
    pts.add(c.start + c.duration);
  }
  return Array.from(pts).sort((a, b) => a - b);
}

/** Is the interval [start, end) free of clips on a track (ignoring `exclude`)? */
export function isRegionFree(
  p: Project,
  trackId: ID,
  start: number,
  end: number,
  exclude?: ReadonlySet<ID>,
): boolean {
  for (const c of clipsOnTrack(p, trackId)) {
    if (exclude?.has(c.id)) continue;
    if (c.start >= end) break;
    if (c.start + c.duration > start) return false;
  }
  return true;
}

/** Clips that have audible sound, honouring mute / solo. */
export function audibleTracks(p: Project): Set<ID> {
  const { audio } = tracksOf(p);
  const anySolo = audio.some((t) => t.solo);
  const out = new Set<ID>();
  for (const t of audio) {
    if (t.muted) continue;
    if (anySolo && !t.solo) continue;
    out.add(t.id);
  }
  return out;
}
