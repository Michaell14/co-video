import { describe, expect, it } from 'vitest';
import { makeClip, type Clip } from '@tandem/core';
import {
  keyframeRange,
  keyframeTimes,
  moveKeyframes,
  removeKeyframes,
} from '../src/features/timeline/keyframes';

const key = (t: number, v: number) => ({ t, v, e: 'easeInOut' as const });

/** A ducked music clip: the volume dips between frames 30 and 105, and the pan moves once. */
const ducked = (): Clip =>
  makeClip('audio', 'a1', {
    start: 100,
    duration: 200,
    volume: 0,
    keyframes: {
      volume: [key(30, 0), key(45, -12), key(90, -12), key(105, 0)],
      pan: [key(45, -0.5), key(150, 0.5)],
    },
  });

describe('keyframes on the timeline', () => {
  it('lists every time a path has a key at, once', () => {
    expect(keyframeTimes(ducked())).toEqual([30, 45, 90, 105, 150]);
  });

  it('moves the keys of all paths at one time together', () => {
    const clip = ducked();
    const patch = moveKeyframes(clip, 45, 60);
    expect(patch.keyframes?.volume.map((k) => k.t)).toEqual([30, 60, 90, 105]);
    expect(patch.keyframes?.pan.map((k) => k.t)).toEqual([60, 150]);
    // Values and easing travel with the key.
    expect(patch.keyframes?.volume[1]).toEqual(key(60, -12));
  });

  it('stops a key a frame short of its neighbours on any path, and inside the clip', () => {
    const clip = ducked();
    expect(keyframeRange(clip, 45)).toEqual({ min: 31, max: 89 });
    expect(moveKeyframes(clip, 45, 500).keyframes?.volume.map((k) => k.t)).toEqual([30, 89, 90, 105]);
    expect(moveKeyframes(clip, 45, -20).keyframes?.pan.map((k) => k.t)).toEqual([31, 150]);
    expect(keyframeRange(clip, 150)).toEqual({ min: 46, max: 199 });
    expect(keyframeRange(clip, 30)).toEqual({ min: 0, max: 44 });
    // Nowhere to go, or back where it was: no edit.
    expect(moveKeyframes(clip, 45, 45)).toEqual({});
  });

  it('removes the keys at a time, and a path left without any keeps its last value', () => {
    const clip = ducked();
    const patch = removeKeyframes(clip, 45);
    expect(patch.keyframes?.volume.map((k) => k.t)).toEqual([30, 90, 105]);
    expect(patch.keyframes?.pan.map((k) => k.t)).toEqual([150]);
    const last = removeKeyframes({ ...clip, ...patch }, 150);
    expect(last.keyframes?.pan).toBeUndefined();
    expect(last.pan).toBe(0.5);
    expect(removeKeyframes(clip, 7)).toEqual({});
  });
});
