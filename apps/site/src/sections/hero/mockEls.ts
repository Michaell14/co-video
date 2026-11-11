import type { TrackId } from './mockScript';

/**
 * Elements the animation loop writes to directly. The mock's markup is rendered once by React;
 * after that the loop moves things with style writes, so 60 fps never touches the reconciler.
 */
export interface MockEls {
  root: HTMLDivElement | null;
  canvas: HTMLCanvasElement | null;
  picture: HTMLDivElement | null;
  title: HTMLDivElement | null;
  lower: HTMLDivElement | null;
  timecodes: (HTMLElement | null)[];
  lanes: Partial<Record<TrackId, HTMLDivElement | null>>;
  clips: Record<string, HTMLDivElement | null>;
  playhead: HTMLDivElement | null;
  snapLine: HTMLDivElement | null;
  trimBadge: HTMLSpanElement | null;
  wheel: HTMLDivElement | null;
  puck: HTMLSpanElement | null;
  satTrack: HTMLDivElement | null;
  satFill: HTMLSpanElement | null;
  satThumb: HTMLSpanElement | null;
  satValue: HTMLSpanElement | null;
  maya: HTMLDivElement | null;
  jonas: HTMLDivElement | null;
  aiko: HTMLDivElement | null;
}

export function createMockEls(): MockEls {
  return {
    root: null,
    canvas: null,
    picture: null,
    title: null,
    lower: null,
    timecodes: [],
    lanes: {},
    clips: {},
    playhead: null,
    snapLine: null,
    trimBadge: null,
    wheel: null,
    puck: null,
    satTrack: null,
    satFill: null,
    satThumb: null,
    satValue: null,
    maya: null,
    jonas: null,
    aiko: null,
  };
}

export const PEOPLE = {
  maya: { name: 'Maya', color: '#ff5d5d' },
  jonas: { name: 'Jonas', color: '#22d3ee' },
  aiko: { name: 'Aiko', color: '#ff9f43' },
} as const;
