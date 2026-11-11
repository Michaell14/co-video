/**
 * The scripted session the hero mock plays: 20 seconds of three people working on one timeline.
 * Everything is a pure function of loop time, and every track ends where it starts, so the loop
 * is seamless (the playhead wraps, exactly like loop playback in the real editor).
 */
import { inSpans, sampleTrack } from '../../lib/math';
import type { Key, Point } from '../../lib/math';

export const LOOP_SECONDS = 20;
export const FPS = 24;
/** Timeline time under the playhead when the loop starts. */
const PLAY_FROM = 3;

export type TrackId = 'v3' | 'v2' | 'v1' | 'a1' | 'a2';

export interface Track {
  id: TrackId;
  label: string;
  kind: 'video' | 'audio';
  height: number;
}

export const TRACKS: readonly Track[] = [
  { id: 'v3', label: 'V3', kind: 'video', height: 30 },
  { id: 'v2', label: 'V2', kind: 'video', height: 44 },
  { id: 'v1', label: 'V1', kind: 'video', height: 52 },
  { id: 'a1', label: 'A1', kind: 'audio', height: 42 },
  { id: 'a2', label: 'A2', kind: 'audio', height: 42 },
];

export interface Clip {
  id: string;
  track: TrackId;
  start: number;
  dur: number;
  kind: 'video' | 'text' | 'adjustment' | 'audio';
  name: string;
  /** Index into SHOTS for video clips. */
  shot?: number;
  /** Waveform seed for audio clips. */
  seed?: number;
}

/** Where the clips Maya and Jonas work on start out. */
export const DRONE = { id: 'drone', start: 9, dur: 5, snapTo: 11.5 } as const;
/** The cut Jonas rolls: clip `left` runs leftStart…cut, clip `right` runs cut…rightEnd. */
export const CUT = { from: 18, to: 19, left: 'c', right: 'd', leftStart: 11.5, rightEnd: 24.5 } as const;

export const CLIPS: readonly Clip[] = [
  { id: 'title', track: 'v3', start: 2, dur: 4.5, kind: 'text', name: 'LOW TIDE' },
  { id: 'lower', track: 'v3', start: 19.5, dur: 4, kind: 'text', name: 'Lower third' },
  {
    id: DRONE.id,
    track: 'v2',
    start: DRONE.start,
    dur: DRONE.dur,
    kind: 'video',
    name: 'Drone_04.mov',
    shot: 4,
  },
  { id: 'grade', track: 'v2', start: 17.5, dur: 9, kind: 'adjustment', name: 'Adjustment · Teal & amber' },
  { id: 'a', track: 'v1', start: 0, dur: 6.5, kind: 'video', name: 'Shore_A001.mov', shot: 0 },
  { id: 'b', track: 'v1', start: 6.5, dur: 5, kind: 'video', name: 'Cliffs_A007.mov', shot: 1 },
  {
    id: CUT.left,
    track: 'v1',
    start: CUT.leftStart,
    dur: CUT.from - CUT.leftStart,
    kind: 'video',
    name: 'Mist_A012.mov',
    shot: 2,
  },
  {
    id: CUT.right,
    track: 'v1',
    start: CUT.from,
    dur: CUT.rightEnd - CUT.from,
    kind: 'video',
    name: 'Golden_B003.mov',
    shot: 3,
  },
  { id: 'e', track: 'v1', start: CUT.rightEnd, dur: 9, kind: 'video', name: 'Cliffs_A009.mov', shot: 1 },
  { id: 'vo1', track: 'a1', start: 1.5, dur: 7, kind: 'audio', name: 'VO_take3.wav', seed: 11 },
  { id: 'vo2', track: 'a1', start: 9.5, dur: 6.5, kind: 'audio', name: 'VO_take3.wav', seed: 23 },
  { id: 'vo3', track: 'a1', start: 18.5, dur: 8.5, kind: 'audio', name: 'VO_take5.wav', seed: 37 },
  { id: 'score', track: 'a2', start: 0, dur: 34, kind: 'audio', name: 'Low Tide — score.wav', seed: 5 },
];

/* ---- Value tracks ---- */

/** Where Maya's hand has dragged the clip to; the clip itself snaps (see sampleMock). */
const DRONE_DRAG: Key[] = [
  { t: 0, v: DRONE.start },
  { t: 2.4, v: DRONE.start },
  { t: 4.2, v: DRONE.snapTo - 0.08 },
  { t: 14.9, v: DRONE.snapTo - 0.08 },
  { t: 16.5, v: DRONE.start },
  { t: LOOP_SECONDS, v: DRONE.start },
];
const SNAP_RANGE = 0.32;

const CUT_AT: Key[] = [
  { t: 0, v: CUT.from },
  { t: 6.6, v: CUT.from },
  { t: 8.2, v: CUT.to },
  { t: 17.5, v: CUT.to },
  { t: 18.8, v: CUT.from },
  { t: LOOP_SECONDS, v: CUT.from },
];

const PUCK_X: Key[] = [
  { t: 0, v: 0 },
  { t: 4.2, v: 0 },
  { t: 5.8, v: 0.3 },
  { t: 7.1, v: 0.24 },
  { t: 8.5, v: 0.4 },
  { t: 18.0, v: 0.4 },
  { t: 19.1, v: 0 },
  { t: LOOP_SECONDS, v: 0 },
];

const PUCK_Y: Key[] = [
  { t: 0, v: 0 },
  { t: 4.2, v: 0 },
  { t: 5.8, v: -0.06 },
  { t: 7.1, v: -0.3 },
  { t: 8.5, v: -0.22 },
  { t: 18.0, v: -0.22 },
  { t: 19.1, v: 0 },
  { t: LOOP_SECONDS, v: 0 },
];

const SATURATION: Key[] = [
  { t: 0, v: 1 },
  { t: 10.3, v: 1 },
  { t: 11.8, v: 1.24 },
  { t: 16.2, v: 1.24 },
  { t: 17.2, v: 1 },
  { t: LOOP_SECONDS, v: 1 },
];

/* ---- How strongly each cursor is locked onto its target (0 = wandering, 1 = on it) ---- */

const MAYA_ATTACH: Key[] = [
  { t: 0, v: 0 },
  { t: 0.8, v: 0 },
  { t: 2.0, v: 1 },
  { t: 4.7, v: 1 },
  { t: 5.8, v: 0 },
  { t: 13.4, v: 0 },
  { t: 14.6, v: 1 },
  { t: 16.9, v: 1 },
  { t: 17.9, v: 0 },
  { t: LOOP_SECONDS, v: 0 },
];
const MAYA_DOWN = [
  [2.3, 4.5],
  [14.8, 16.7],
] as const;

const JONAS_ATTACH: Key[] = [
  { t: 0, v: 0 },
  { t: 5.0, v: 0 },
  { t: 6.2, v: 1 },
  { t: 8.6, v: 1 },
  { t: 9.6, v: 0 },
  { t: 16.2, v: 0 },
  { t: 17.2, v: 1 },
  { t: 19.1, v: 1 },
  { t: 19.9, v: 0 },
  { t: LOOP_SECONDS, v: 0 },
];
const JONAS_DOWN = [
  [6.5, 8.4],
  [17.4, 18.95],
] as const;

const AIKO_WHEEL: Key[] = [
  { t: 0, v: 0 },
  { t: 2.5, v: 0 },
  { t: 3.8, v: 1 },
  { t: 8.8, v: 1 },
  { t: 9.9, v: 0 },
  { t: 17.3, v: 0 },
  { t: 17.95, v: 1 },
  { t: 19.2, v: 1 },
  { t: 19.95, v: 0 },
  { t: LOOP_SECONDS, v: 0 },
];
const AIKO_SAT: Key[] = [
  { t: 0, v: 0 },
  { t: 8.8, v: 0 },
  { t: 9.9, v: 1 },
  { t: 12.1, v: 1 },
  { t: 13.1, v: 0 },
  { t: 15.2, v: 0 },
  { t: 16.0, v: 1 },
  { t: 17.3, v: 1 },
  { t: 17.95, v: 0 },
  { t: LOOP_SECONDS, v: 0 },
];
const AIKO_DOWN = [
  [4.1, 8.6],
  [10.2, 11.9],
  [16.1, 17.25],
  [17.98, 19.15],
] as const;

export interface MockState {
  /** Timeline time under the playhead, seconds. */
  playhead: number;
  /** Where the dragged clip would start if it followed the hand exactly. */
  droneDrag: number;
  /** Where it actually starts, after snapping. */
  droneStart: number;
  cut: number;
  /** Gamma-wheel puck, −1…1 on each axis. */
  puck: Point;
  saturation: number;
  mayaAttach: number;
  mayaDown: boolean;
  jonasAttach: number;
  jonasDown: boolean;
  aikoWheel: number;
  aikoSat: number;
  aikoDown: boolean;
  /** The held clip is within snapping range of the cut, so it sticks to it. */
  snapped: boolean;
  /** Which shot the viewer shows. */
  shot: number;
  titleOpacity: number;
  lowerOpacity: number;
}

const fadeWindow = (p: number, from: number, to: number, fade = 0.4): number =>
  Math.max(0, Math.min(1, (p - from) / fade, (to - p) / fade));

/** The whole mock at loop time `time` (seconds, any value; it is wrapped). Mutates and returns `out`. */
export function sampleMock(time: number, out: MockState): MockState {
  const t = ((time % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
  const p = PLAY_FROM + t;

  out.playhead = p;
  out.droneDrag = sampleTrack(DRONE_DRAG, t);
  const nearSnap = Math.abs(out.droneDrag - DRONE.snapTo) < SNAP_RANGE;
  out.droneStart = nearSnap ? DRONE.snapTo : out.droneDrag;
  out.cut = sampleTrack(CUT_AT, t);
  out.puck.x = sampleTrack(PUCK_X, t);
  out.puck.y = sampleTrack(PUCK_Y, t);
  out.saturation = sampleTrack(SATURATION, t);
  out.mayaAttach = sampleTrack(MAYA_ATTACH, t);
  out.mayaDown = inSpans(MAYA_DOWN, t);
  out.jonasAttach = sampleTrack(JONAS_ATTACH, t);
  out.jonasDown = inSpans(JONAS_DOWN, t);
  out.aikoWheel = sampleTrack(AIKO_WHEEL, t);
  out.aikoSat = sampleTrack(AIKO_SAT, t);
  out.aikoDown = inSpans(AIKO_DOWN, t);
  out.snapped = out.mayaDown && nearSnap;

  // The viewer shows the topmost clip under the playhead: V2's drone shot, else whatever is on V1.
  if (p >= out.droneStart && p < out.droneStart + DRONE.dur) out.shot = 4;
  else if (p < 6.5) out.shot = 0;
  else if (p < CUT.leftStart) out.shot = 1;
  else if (p < out.cut) out.shot = 2;
  else out.shot = 3;

  out.titleOpacity = fadeWindow(p, 2, 6.5);
  out.lowerOpacity = fadeWindow(p, 19.5, 23.5);
  return out;
}

export function createMockState(): MockState {
  return {
    playhead: PLAY_FROM,
    droneDrag: DRONE.start,
    droneStart: DRONE.start,
    cut: CUT.from,
    puck: { x: 0, y: 0 },
    saturation: 1,
    mayaAttach: 0,
    mayaDown: false,
    jonasAttach: 0,
    jonasDown: false,
    aikoWheel: 0,
    aikoSat: 0,
    aikoDown: false,
    snapped: false,
    shot: 0,
    titleOpacity: 1,
    lowerOpacity: 0,
  };
}
