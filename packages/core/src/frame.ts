/**
 * Frame resolution: turn "the project at frame N" into an ordered list of layers with every
 * animated value evaluated. This is the contract between the model and the renderer — the
 * compositor never looks at keyframes, tracks or transitions windows itself.
 */
import { animated } from './keyframes';
import { clipEnd, clipsOnTrack, findIndexAtOrBefore, sourceTimeAt, tracksOf } from './query';
import { IDENTITY_ANIM, textAnimAt, type AnimModifiers } from './textAnim';
import { easeProgress, getTransitionDef } from './transitions';
import type { Clip, Project, Track, Transition } from './types';
import { clamp, dbToGain } from './util';

export interface VisualState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  cropL: number;
  cropT: number;
  cropR: number;
  cropB: number;
}

export interface ClipLayer {
  clip: Clip;
  track: Track;
  /** Frame relative to the clip start. May fall outside 0…duration inside transition handles. */
  localFrame: number;
  /** Seconds into the source media (clamped to the asset when it is known). */
  sourceTime: number;
  v: VisualState;
  anim: AnimModifiers;
}

export type Layer =
  | { kind: 'clip'; layer: ClipLayer }
  | {
      kind: 'transition';
      a: ClipLayer | null;
      b: ClipLayer | null;
      transition: Transition;
      /** Eased progress, 0…1. */
      progress: number;
      seed: number;
    };

export interface FrameDesc {
  frame: number;
  layers: Layer[];
}

/** Stable pseudo-random 0…1 derived from an id, so stochastic looks are identical for every peer. */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function visualStateAt(clip: Clip, localFrame: number): VisualState {
  const k = clip.keyframes;
  // Fast path: most clips have no keyframes at all.
  let any = false;
  for (const _ in k) {
    any = true;
    break;
  }
  if (!any) {
    return {
      x: clip.x,
      y: clip.y,
      scaleX: clip.scaleX,
      scaleY: clip.scaleY,
      rotation: clip.rotation,
      opacity: clip.opacity,
      cropL: clip.cropL,
      cropT: clip.cropT,
      cropR: clip.cropR,
      cropB: clip.cropB,
    };
  }
  return {
    x: animated(clip, 'x', localFrame, clip.x),
    y: animated(clip, 'y', localFrame, clip.y),
    scaleX: animated(clip, 'scaleX', localFrame, clip.scaleX),
    scaleY: animated(clip, 'scaleY', localFrame, clip.scaleY),
    rotation: animated(clip, 'rotation', localFrame, clip.rotation),
    opacity: clamp(animated(clip, 'opacity', localFrame, clip.opacity), 0, 1),
    cropL: animated(clip, 'cropL', localFrame, clip.cropL),
    cropT: animated(clip, 'cropT', localFrame, clip.cropT),
    cropR: animated(clip, 'cropR', localFrame, clip.cropR),
    cropB: animated(clip, 'cropB', localFrame, clip.cropB),
  };
}

function layerFor(p: Project, clip: Clip, track: Track, frame: number): ClipLayer {
  const localFrame = frame - clip.start;
  let sourceTime = sourceTimeAt(clip, localFrame, p);
  const asset = clip.assetId ? p.assets[clip.assetId] : undefined;
  if (asset && asset.duration > 0) sourceTime = clamp(sourceTime, 0, Math.max(0, asset.duration - 1e-3));
  else if (sourceTime < 0) sourceTime = 0;
  return {
    clip,
    track,
    localFrame,
    sourceTime,
    v: visualStateAt(clip, localFrame),
    anim: clip.text ? textAnimAt(clip, clamp(localFrame, 0, clip.duration)) : IDENTITY_ANIM,
  };
}

/** Length of the two-sided transition on the cut between `a` and `b`, and how much precedes the cut. */
export function cutTransitionWindow(a: Clip, b: Clip): { duration: number; before: number } | null {
  if (!b.transIn || clipEnd(a) !== b.start) return null;
  const duration = clamp(Math.round(b.transIn.duration), 1, Math.max(1, Math.min(a.duration, b.duration)));
  return { duration, before: Math.floor(duration / 2) };
}

function resolveTrack(p: Project, track: Track, frame: number): Layer | null {
  const all = clipsOnTrack(p, track.id);
  if (!all.length) return null;
  const idx = findIndexAtOrBefore(all, frame);

  // Find the enabled clip covering `frame`, plus its enabled neighbours.
  let cur: Clip | null = null;
  let curIdx = -1;
  for (let i = idx; i >= 0; i--) {
    const c = all[i];
    if (c.enabled && frame < clipEnd(c)) {
      cur = c;
      curIdx = i;
      break;
    }
    if (frame - c.start > 100000) break;
  }
  const prevEnabled = (from: number): Clip | null => {
    for (let i = from - 1; i >= 0; i--) if (all[i].enabled) return all[i];
    return null;
  };
  const nextEnabled = (from: number): Clip | null => {
    for (let i = from + 1; i < all.length; i++) if (all[i].enabled) return all[i];
    return null;
  };

  if (!cur) return null;

  const mk = (a: Clip | null, b: Clip | null, t: Transition, raw: number, seedId: string): Layer => {
    const def = getTransitionDef(t.type);
    return {
      kind: 'transition',
      a: a ? layerFor(p, a, track, frame) : null,
      b: b ? layerFor(p, b, track, frame) : null,
      transition: t,
      progress: easeProgress(def?.ease ?? 'linear', raw),
      seed: seedOf(seedId),
    };
  };

  // Incoming two-sided transition (this clip is B).
  const prev = prevEnabled(curIdx);
  if (prev && cur.transIn) {
    const w = cutTransitionWindow(prev, cur);
    if (w && frame < cur.start + (w.duration - w.before)) {
      const winStart = cur.start - w.before;
      return mk(prev, cur, cur.transIn, (frame - winStart + 1) / (w.duration + 1), cur.id);
    }
  }
  // Outgoing two-sided transition (this clip is A).
  const next = nextEnabled(curIdx);
  let outgoingCut = false;
  if (next && next.transIn) {
    const w = cutTransitionWindow(cur, next);
    if (w) {
      outgoingCut = true;
      const winStart = next.start - w.before;
      if (frame >= winStart)
        return mk(cur, next, next.transIn, (frame - winStart + 1) / (w.duration + 1), next.id);
    }
  }
  // One-sided fades from / to nothing.
  const local = frame - cur.start;
  if (cur.transIn && !(prev && clipEnd(prev) === cur.start)) {
    const d = clamp(Math.round(cur.transIn.duration), 1, cur.duration);
    if (local < d) return mk(null, cur, cur.transIn, (local + 1) / (d + 1), cur.id);
  }
  if (cur.transOut && !outgoingCut) {
    const d = clamp(Math.round(cur.transOut.duration), 1, cur.duration);
    const into = local - (cur.duration - d);
    if (into >= 0) return mk(cur, null, cur.transOut, (into + 1) / (d + 1), cur.id + 'o');
  }
  return { kind: 'clip', layer: layerFor(p, cur, track, frame) };
}

/** Everything visible at `frame`, bottom layer first. */
export function resolveFrame(p: Project, frame: number): FrameDesc {
  const layers: Layer[] = [];
  for (const track of tracksOf(p).video) {
    if (track.hidden) continue;
    const layer = resolveTrack(p, track, frame);
    if (layer) layers.push(layer);
  }
  return { frame, layers };
}

/** Asset ids needed to draw a frame (used for pre-loading). */
export function assetsInFrame(desc: FrameDesc): string[] {
  const out: string[] = [];
  const add = (l: ClipLayer | null) => {
    if (l?.clip.assetId) out.push(l.clip.assetId);
    if (l?.clip.grade?.lutId) out.push(l.clip.grade.lutId);
  };
  for (const l of desc.layers) {
    if (l.kind === 'clip') add(l.layer);
    else {
      add(l.a);
      add(l.b);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── audio ──

/** Equal-power fade curve. */
export const fadeCurve = (t: number): number => Math.sin((clamp(t, 0, 1) * Math.PI) / 2);

/** Linear gain of an audio clip at a clip-local frame: volume (incl. keyframes) × fades. */
export function clipGainAt(clip: Clip, localFrame: number): number {
  if (clip.audioMuted || !clip.enabled) return 0;
  let g = dbToGain(animated(clip, 'volume', localFrame, clip.volume));
  if (clip.fadeIn > 0 && localFrame < clip.fadeIn) g *= fadeCurve(localFrame / clip.fadeIn);
  const remaining = clip.duration - localFrame;
  if (clip.fadeOut > 0 && remaining < clip.fadeOut) g *= fadeCurve(remaining / clip.fadeOut);
  return g;
}

/** Frames at which a clip's gain envelope changes slope; used to build audio automation curves. */
export function gainBreakpoints(clip: Clip): number[] {
  const pts = new Set<number>([0, clip.duration]);
  if (clip.fadeIn > 0) pts.add(Math.min(clip.fadeIn, clip.duration));
  if (clip.fadeOut > 0) pts.add(Math.max(0, clip.duration - clip.fadeOut));
  for (const k of clip.keyframes.volume ?? []) if (k.t > 0 && k.t < clip.duration) pts.add(k.t);
  return Array.from(pts).sort((a, b) => a - b);
}
