/** Moving and removing keyframes on the timeline, where a clip shows all of its paths as one row of marks. */
import { removeKeyframeAt, writeProp, type Clip, type Keyframe } from '@tandem/core';

/** The times, in frames from the clip's start, at which the clip has a keyframe on any path. */
export function keyframeTimes(clip: Clip): number[] {
  const times = new Set<number>();
  for (const list of Object.values(clip.keyframes)) {
    for (const k of list) if (k.t >= 0 && k.t <= clip.duration) times.add(k.t);
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * How far the keyframes at `t` can be moved in time: up to the frame after the mark before and the
 * frame before the mark after, whichever paths those are on, and not out of the clip. Two marks
 * never change places and never become one, which would join keys that were made apart.
 */
export function keyframeRange(clip: Clip, t: number): { min: number; max: number } {
  let min = 0;
  let max = Math.max(0, clip.duration - 1);
  for (const other of keyframeTimes(clip)) {
    if (other < t) min = Math.max(min, other + 1);
    if (other > t) max = Math.min(max, other - 1);
  }
  return { min: Math.min(min, t), max: Math.max(max, t) };
}

/**
 * The patch that moves every keyframe the clip has at `from` to `to`, on all of its paths. `to` is
 * a time `keyframeRange` allows. Empty when nothing moves.
 */
export function moveKeyframes(clip: Clip, from: number, to: number): Partial<Clip> {
  if (to === from) return {};
  const keyframes: Record<string, Keyframe[]> = {};
  let moved = false;
  for (const [path, list] of Object.entries(clip.keyframes)) {
    keyframes[path] = list.map((k) => (k.t === from ? { ...k, t: to } : k));
    moved ||= list.some((k) => k.t === from);
  }
  return moved ? { keyframes } : {};
}

/**
 * The patch that removes every keyframe the clip has at `t`. A path that is left without any
 * keeps the value its last keyframe had, so that what was seen and heard there stays.
 */
export function removeKeyframes(clip: Clip, t: number): Partial<Clip> {
  let working = clip;
  const patch: Partial<Clip> = {};
  for (const [path, list] of Object.entries(clip.keyframes)) {
    const key = list.find((k) => k.t === t);
    if (!key) continue;
    const keyframes = { ...working.keyframes };
    const left = removeKeyframeAt(list, t);
    if (left.length) keyframes[path] = left;
    else delete keyframes[path];
    const step: Partial<Clip> = { keyframes };
    if (!left.length) Object.assign(step, writeProp({ ...working, keyframes }, path, key.v, t));
    Object.assign(patch, step);
    working = { ...working, ...step };
  }
  return patch;
}
