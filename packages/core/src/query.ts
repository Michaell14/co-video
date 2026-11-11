/** Read-only selectors over a Project snapshot. Heavy ones are memoised on object identity. */
import { hasSourceTime } from './defaults';
import type { Asset, Clip, ID, Project, Track } from './types';
import { memoByRef } from './util';

export const clipEnd = (c: Clip): number => c.start + c.duration;

const sortTracks = memoByRef((tracks: Project['tracks']) => {
  const all = Object.values(tracks);
  const video = all.filter((t) => t.kind === 'video').sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const audio = all.filter((t) => t.kind === 'audio').sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
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

/** All clip ids linked with `id` (including itself). */
export function linkedIds(p: Project, id: ID): ID[] {
  const c = p.clips[id];
  if (!c) return [];
  if (!c.linkId) return [id];
  const out: ID[] = [];
  for (const o of Object.values(p.clips)) if (o.linkId === c.linkId) out.push(o.id);
  return out;
}

/** Expand a selection to include linked partners. */
export function withLinked(p: Project, ids: Iterable<ID>): ID[] {
  const out = new Set<ID>();
  for (const id of ids) for (const l of linkedIds(p, id)) out.add(l);
  return Array.from(out);
}

/** Seconds of source media consumed per timeline frame (zero for a freeze frame). */
export const sourcePerFrame = (clip: Clip, p: Project): number =>
  clip.freeze ? 0 : (clip.speed * p.settings.fpsDen) / p.settings.fpsNum;

/**
 * Source media time (seconds) shown at a clip-local frame. Local frames outside 0…duration are
 * valid (used for transition handles) and are clamped to the asset bounds by the caller.
 */
export function sourceTimeAt(clip: Clip, localFrame: number, p: Project): number {
  const per = sourcePerFrame(clip, p);
  if (per === 0) return clip.sourceIn;
  if (clip.reverse) return clip.sourceIn + (clip.duration - 1 - localFrame) * per;
  return clip.sourceIn + localFrame * per;
}

/** How many extra frames a clip could be extended by at its head and tail given its source media. */
export function handles(clip: Clip, asset: Asset | undefined, p: Project): { head: number; tail: number } {
  if (!hasSourceTime(clip.type) || clip.freeze || !asset || asset.duration <= 0) return { head: Infinity, tail: Infinity };
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
export function isRegionFree(p: Project, trackId: ID, start: number, end: number, exclude?: ReadonlySet<ID>): boolean {
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
