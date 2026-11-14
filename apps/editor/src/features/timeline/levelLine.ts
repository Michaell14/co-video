/**
 * The level line of a sound clip: where it runs in the clip, what of it a pointer is on, and what
 * a drag on it does to the clip's volume. The lane canvas paints the line and the lanes take the
 * pointer, and both go by what is here.
 */
import {
  animated,
  clamp,
  clipGainAt,
  gainToDb,
  upsertKeyframe,
  type Clip,
  type Keyframe,
} from '@tandem/core';
import { LABEL_H } from './layout';

/** The lowest a clip's body can be for the level line to say anything, in CSS pixels. */
export const LEVEL_MIN_H = 18;
/** The levels at the bottom and at the top of a clip's body, in decibels. */
export const LEVEL_FLOOR = -48;
export const LEVEL_CEILING = 12;
/** How near the line, in CSS pixels, a pointer takes hold of it; and how near a keyframe on it. */
const LINE_REACH = 3;
const POINT_REACH = 5;
/** The line keeps this far from the top and the bottom of the body. */
const INSET = 2;

/** The part of a clip below its label strip, where its waveform is: measured from the lane's top. */
export interface ClipBody {
  top: number;
  height: number;
}

/** The body of a clip in a lane `laneHeight` high. A low lane has no label strip. */
export function clipBody(laneHeight: number): ClipBody {
  const top = laneHeight < 40 ? 0 : LABEL_H;
  return { top, height: laneHeight - top };
}

/** How far up a clip's body the level line runs for a gain: 0 at the floor, 1 at the ceiling. */
function levelHeight(gain: number): number {
  const db = clamp(gainToDb(gain), LEVEL_FLOOR, LEVEL_CEILING);
  return (db - LEVEL_FLOOR) / (LEVEL_CEILING - LEVEL_FLOOR);
}

/**
 * The line of `clip`: its height, from the lane's top, at a frame of the clip. It shows how loud
 * the clip is played, from its volume, the keyframes on it and its fades, and it shows the level
 * that is set also while the clip is switched off.
 */
export function levelCurve(clip: Clip, body: ClipBody): (frame: number) => number {
  const heard = clip.enabled && !clip.audioMuted ? clip : { ...clip, enabled: true, audioMuted: false };
  const room = body.height - INSET * 2;
  return (frame) =>
    body.top + INSET + room * (1 - levelHeight(clipGainAt(heard, clamp(frame, 0, clip.duration))));
}

export interface LevelHit {
  /** The frame of the clip the pointer is at. */
  t: number;
  /** The time of the volume keyframe the pointer is on, when it is on one. */
  key: number | null;
}

/**
 * What of the level line of `clip` is under a pointer at `frame` of the clip (fractions count) and
 * `y` pixels below the lane's top, at `ppf` pixels a frame: a keyframe on it, the line itself, or
 * nothing. A keyframe is the larger target and wins where both are in reach.
 */
export function levelHit(clip: Clip, frame: number, y: number, body: ClipBody, ppf: number): LevelHit | null {
  if (clip.type !== 'audio' || body.height < LEVEL_MIN_H) return null;
  const yAt = levelCurve(clip, body);
  let key: Keyframe | null = null;
  let nearest = POINT_REACH;
  for (const k of clip.keyframes.volume ?? []) {
    const distance = Math.hypot((k.t - frame) * ppf, yAt(k.t) - y);
    if (k.t >= 0 && k.t <= clip.duration && distance <= nearest) {
      key = k;
      nearest = distance;
    }
  }
  if (key) return { t: key.t, key: key.t };
  if (frame < 0 || frame > clip.duration) return null;
  // Where the line is steep (a fade, a quick ramp) it passes the pointer at some height between
  // those it has a reach to either side.
  const around = [frame - LINE_REACH / ppf, frame, frame + LINE_REACH / ppf].map(yAt);
  if (y < Math.min(...around) - LINE_REACH || y > Math.max(...around) + LINE_REACH) return null;
  return { t: clamp(Math.round(frame), 0, Math.max(0, clip.duration - 1)), key: null };
}

/** The volume of `clip` at its frame `t`, in decibels: what a keyframe made there would hold. */
export const levelAt = (clip: Clip, t: number): number => animated(clip, 'volume', t, clip.volume);

/**
 * The level a hold on the line has been dragged to: from `from` decibels, `dy` pixels down the
 * body. The drag covers what the body shows, floor to ceiling, in tenths of a decibel.
 */
export function levelDragged(from: number, dy: number, body: ClipBody): number {
  const perPixel = (LEVEL_CEILING - LEVEL_FLOOR) / (body.height - INSET * 2);
  const db = clamp(from, LEVEL_FLOOR, LEVEL_CEILING) - dy * perPixel;
  return clamp(Math.round(db * 10) / 10, LEVEL_FLOOR, LEVEL_CEILING);
}

/**
 * The patch that sets the level of `clip` to `db`: of the clip as a whole when `t` is null, and
 * otherwise at the volume keyframe at `t`, which is made if there is none there yet.
 */
export function levelPatch(clip: Clip, t: number | null, db: number): Partial<Clip> {
  if (t === null) return { volume: db };
  const keys = clip.keyframes.volume ?? [];
  const e = keys.find((k) => k.t === t)?.e ?? 'easeInOut';
  return { keyframes: { ...clip.keyframes, volume: upsertKeyframe(keys, { t, v: db, e }) } };
}

/** A level as it is shown beside the pointer. */
export const levelText = (db: number): string =>
  `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`;
