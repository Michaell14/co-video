import { displayTracks, type Project, type Track } from '@tandem/core';

export const HEADER_W = 156;
export const RULER_H = 30;
export const LANE_GAP = 2;
/** Extra space between the video and audio groups. */
export const GROUP_GAP = 8;
/** Empty room under the last lane, for dropping below it and for dragging a clip out past it. */
export const LANES_TAIL = 24;
export const LABEL_H = 17;
/** How much of a clip's colour its label strip keeps; the rest is black, so the name reads on it. */
export const LABEL_TINT = 0.62;
/** A clip no wider than this, in CSS pixels, has no room for its name. */
export const LABEL_MIN_W = 44;
/** Below this width a clip is a sliver: it gets tighter corners and no grips. */
export const NARROW_W = 16;

/** The width a clip is drawn at: a pixel short of its length, so that neighbours do not touch. */
export const clipWidth = (duration: number, ppf: number): number => Math.max(2, duration * ppf - 1);

export interface Lane {
  track: Track;
  top: number;
  height: number;
}

/** Vertical layout of track lanes, top to bottom as displayed. */
export function layoutLanes(project: Project): { lanes: Lane[]; height: number } {
  const lanes: Lane[] = [];
  let y = 4;
  let prevKind: string | null = null;
  for (const track of displayTracks(project)) {
    if (prevKind && prevKind !== track.kind) y += GROUP_GAP;
    lanes.push({ track, top: y, height: track.height });
    y += track.height + LANE_GAP;
    prevKind = track.kind;
  }
  return { lanes, height: y + LANES_TAIL };
}

export function laneAt(lanes: Lane[], y: number): Lane | null {
  for (const l of lanes) if (y >= l.top - LANE_GAP / 2 && y < l.top + l.height + LANE_GAP / 2) return l;
  return null;
}

/** Ruler tick spacing: returns major interval in frames and number of minor subdivisions. */
export function tickInterval(ppf: number, fps: number): { major: number; minor: number } {
  const f = Math.max(1, Math.round(fps));
  const candidates = [
    1,
    2,
    5,
    10,
    f / 2,
    f,
    2 * f,
    5 * f,
    10 * f,
    15 * f,
    30 * f,
    60 * f,
    120 * f,
    300 * f,
    600 * f,
    1800 * f,
    3600 * f,
  ]
    .map((v) => Math.round(v))
    .filter((v, i, a) => v >= 1 && a.indexOf(v) === i)
    .sort((a, b) => a - b);
  const want = 96;
  for (const c of candidates) {
    if (c * ppf >= want) {
      // Below a second the small ticks have to fall on whole frames: the most of them that do.
      const minor =
        c >= f
          ? c % (5 * f) === 0
            ? 5
            : c === f
              ? Math.min(f, 5)
              : 4
          : ([5, 4, 3, 2].find((n) => c % n === 0) ?? 1);
      return { major: c, minor };
    }
  }
  return { major: candidates[candidates.length - 1] * 2, minor: 4 };
}
