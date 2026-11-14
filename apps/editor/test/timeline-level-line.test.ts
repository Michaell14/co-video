import { describe, expect, it } from 'vitest';
import { makeClip, type Clip } from '@tandem/core';
import {
  clipBody,
  levelAt,
  levelCurve,
  levelDragged,
  levelHit,
  levelPatch,
  levelText,
} from '../src/features/timeline/levelLine';

const sound = (init: Partial<Clip> = {}): Clip =>
  makeClip('audio', 'a1', { start: 0, duration: 300, volume: 0, ...init });

/** A lane of the default height: a 17 px label strip over a 35 px body, 31 px of which the line uses. */
const body = clipBody(52);
/** Where the line runs for a level in decibels, in that body. */
const yOf = (db: number): number => body.top + 2 + 31 * (1 - (db + 48) / 60);

describe('the level line of a sound clip', () => {
  it('runs in the body under the label strip, from −48 dB at the bottom to +12 dB at the top', () => {
    expect(body).toEqual({ top: 17, height: 35 });
    expect(clipBody(30)).toEqual({ top: 0, height: 30 });
    expect(levelCurve(sound(), body)(150)).toBeCloseTo(yOf(0));
    expect(levelCurve(sound({ volume: 12 }), body)(150)).toBeCloseTo(19);
    expect(levelCurve(sound({ volume: -48 }), body)(150)).toBeCloseTo(50);
    expect(levelCurve(sound({ volume: -60 }), body)(150)).toBeCloseTo(50);
    // A fade takes it down, and a clip that is switched off still shows the level it is set to.
    expect(levelCurve(sound({ fadeIn: 30 }), body)(0)).toBeCloseTo(50);
    expect(levelCurve(sound({ enabled: false }), body)(150)).toBeCloseTo(yOf(0));
  });

  it('is taken hold of within a few pixels, and nowhere else on the clip', () => {
    const clip = sound({ volume: -6 });
    const at = yOf(-6);
    expect(levelHit(clip, 100.4, at, body, 4)).toEqual({ t: 100, key: null });
    expect(levelHit(clip, 100, at + 3, body, 4)).toEqual({ t: 100, key: null });
    expect(levelHit(clip, 100, at - 3, body, 4)).toEqual({ t: 100, key: null });
    expect(levelHit(clip, 100, at + 4.5, body, 4)).toBeNull();
    expect(levelHit(clip, 100, at - 4.5, body, 4)).toBeNull();
    expect(levelHit(clip, -1, at, body, 4)).toBeNull();
    expect(levelHit(clip, 301, at, body, 4)).toBeNull();
    // The last frame a keyframe can stand on is the last frame of the clip.
    expect(levelHit(clip, 300, at, body, 4)).toEqual({ t: 299, key: null });
    // Not on a picture, and not where the body is too low for the line to be drawn.
    expect(levelHit(makeClip('video', 'v1', { duration: 300 }), 100, at, body, 4)).toBeNull();
    expect(levelHit(clip, 100, 10, clipBody(16), 4)).toBeNull();
  });

  it('is found on the steep side of a fade, where it passes the pointer between two heights', () => {
    // Over a fade of two frames at a pixel a frame the line climbs the whole body in two pixels.
    const clip = sound({ fadeIn: 2 });
    expect(levelHit(clip, 1, 40, body, 1)).toEqual({ t: 1, key: null });
    expect(levelHit(clip, 20, 40, body, 1)).toBeNull();
  });

  it('gives a keyframe on the line the larger reach', () => {
    const key = (t: number, v: number) => ({ t, v, e: 'linear' as const });
    const clip = sound({ keyframes: { volume: [key(60, 0), key(120, -24)] } });
    expect(levelHit(clip, 60, yOf(0), body, 4)).toEqual({ t: 60, key: 60 });
    expect(levelHit(clip, 61, yOf(0) + 3, body, 4)).toEqual({ t: 60, key: 60 });
    expect(levelHit(clip, 119, yOf(-24) - 2, body, 4)).toEqual({ t: 120, key: 120 });
    // Between the two the line is under the pointer, and no keyframe.
    expect(levelHit(clip, 90, yOf(-12), body, 4)).toEqual({ t: 90, key: null });
    expect(levelAt(clip, 90)).toBeCloseTo(-12);
    expect(levelAt(sound({ volume: -3 }), 90)).toBe(-3);
  });

  it('is dragged over what the body shows, in tenths of a decibel', () => {
    // 60 dB over 31 px.
    expect(levelDragged(0, 10, body)).toBe(-19.4);
    expect(levelDragged(0, -3, body)).toBe(5.8);
    expect(levelDragged(-6, 0, body)).toBe(-6);
    expect(levelDragged(0, 100, body)).toBe(-48);
    expect(levelDragged(0, -100, body)).toBe(12);
    // A level below what the body shows is dragged from where its line is drawn: the floor.
    expect(levelDragged(-60, -31, body)).toBe(12);
  });

  it('sets the level of the whole clip, or of one keyframe, which it makes where there is none', () => {
    const clip = sound({
      keyframes: { volume: [{ t: 60, v: 0, e: 'hold' }], pan: [{ t: 0, v: 1, e: 'linear' }] },
    });
    expect(levelPatch(sound(), null, -9)).toEqual({ volume: -9 });
    expect(levelPatch(clip, 60, -9).keyframes).toEqual({
      volume: [{ t: 60, v: -9, e: 'hold' }],
      pan: [{ t: 0, v: 1, e: 'linear' }],
    });
    expect(levelPatch(clip, 20, -3).keyframes?.volume).toEqual([
      { t: 20, v: -3, e: 'easeInOut' },
      { t: 60, v: 0, e: 'hold' },
    ]);
    expect(levelPatch(sound(), 20, -3).keyframes).toEqual({ volume: [{ t: 20, v: -3, e: 'easeInOut' }] });
  });

  it('is said with its sign', () => {
    expect([levelText(0), levelText(4.25), levelText(-19.4)]).toEqual(['0.0 dB', '+4.3 dB', '−19.4 dB']);
  });
});
