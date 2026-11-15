/** Local, per-user interface state. Nothing in here is synced to collaborators. */
import { create } from 'zustand';
import type { Clip, Grade, EffectInstance, ID, Project } from '@tandem/core';

export type Tool = 'select' | 'blade' | 'slip' | 'hand';
export type Workspace = 'edit' | 'color' | 'audio';
export type LibraryTab = 'media' | 'text' | 'effects' | 'transitions';
export type DialogId =
  'export' | 'share' | 'shortcuts' | 'versions' | 'palette' | 'project' | 'profile' | null;

/** Copied attributes. A copy can hold the look of a picture clip, the sound of an audio clip, or both. */
export interface AttributeClipboard {
  /** Frame rate of the project they were copied in: the fades are counted in its frames. */
  fps: number;
  look: {
    effects: EffectInstance[];
    grade: Grade | null;
    transform: Pick<
      Clip,
      | 'x'
      | 'y'
      | 'scaleX'
      | 'scaleY'
      | 'rotation'
      | 'opacity'
      | 'blend'
      | 'cropL'
      | 'cropT'
      | 'cropR'
      | 'cropB'
    >;
  } | null;
  sound: Pick<Clip, 'volume' | 'pan' | 'fadeIn' | 'fadeOut'> | null;
}

/** What the source monitor keeps of a file between two looks at it, in seconds into the file. */
export interface SourceMarks {
  in: number;
  /** Null while no out point is marked: the file then runs to its end. */
  out: number | null;
  /** Where the file was being watched when the monitor last left it; null until it has. */
  at: number | null;
}

export interface UIState {
  selection: ID[];
  selectedTransition: { clipId: ID; side: 'in' | 'out' } | null;
  tool: Tool;
  snapping: boolean;
  rippleMode: boolean;
  linkedSelection: boolean;
  /**
   * Markers and review comments move with the clips when a ripple edit takes time out of the
   * sequence or puts it in. One switch for both: it is named after the markers it began with.
   */
  markersFollow: boolean;
  /** The transition the `Add default transition` command applies: the last one the user chose. */
  defaultTransition: string;
  /** Timeline zoom: pixels per frame. */
  ppf: number;
  scrollX: number;
  workspace: Workspace;
  libraryTab: LibraryTab;
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
  /**
   * The heights someone who may not edit a project has given its tracks, for themselves: by
   * project, then by track. Whoever may edit sets the height of the track itself.
   */
  laneHeights: Record<string, Record<ID, number>>;
  commentsOpen: boolean;
  /** Uncommitted result of a drag in progress; shown instead of the real project. */
  preview: Project | null;
  /** Frame position of the active snap, for the indicator line. */
  snapLine: number | null;
  dialog: DialogId;
  showSafeAreas: boolean;
  showGrid: boolean;
  showStats: boolean;
  viewerZoom: 'fit' | number;
  /** Awareness client id of the collaborator whose playhead we mirror. */
  following: number | null;
  clipboard: Clip[];
  /** Frame rate of the project the clipboard was copied in: its clips count in those frames. */
  clipboardFps: number;
  attributes: AttributeClipboard | null;
  /** Asset shown in the source monitor, or null for the programme. */
  sourceAsset: ID | null;
  /** Match frame: the source monitor holds this asset at `time` seconds instead of playing it. */
  sourceCue: { assetId: ID; time: number } | null;
  /**
   * The marks and the position of each file the source monitor has shown, so that closing the
   * monitor or looking at another file loses neither. The user's own, like the playhead.
   */
  sourceMarks: Record<ID, SourceMarks>;
  /** Asset the media pool is asked to bring into view; the pool clears it once it has. */
  revealAsset: ID | null;
  /** Effects just added by hand, for the inspector to bring into view; it clears them once it has looked. */
  revealEffects: ID[];
  /** The files selected in the media pool, in the order they were picked. */
  poolSelection: ID[];
  scopes: { waveform: boolean; parade: boolean; vectorscope: boolean; histogram: boolean };
  /** A voiceover is being recorded: where on the timeline it began, and when. */
  recording: { startFrame: number; startedAt: number } | null;
  /**
   * The title that is being typed into on the picture. `at` is where in the window the caret was
   * asked for; without it all of the text starts out selected, to be typed over.
   */
  typing: { clip: ID; at: { x: number; y: number } | null } | null;

  select: (ids: ID[], additive?: boolean) => void;
  toggleSelect: (id: ID) => void;
  clearSelection: () => void;
  set: (patch: Partial<UIState>) => void;
}

/** What is kept from one visit to the next. */
export type Prefs = Pick<
  UIState,
  | 'snapping'
  | 'linkedSelection'
  | 'markersFollow'
  | 'defaultTransition'
  | 'leftWidth'
  | 'rightWidth'
  | 'timelineHeight'
  | 'laneHeights'
  | 'scopes'
>;

/** The transition `Add default transition` starts out with. */
export const FIRST_TRANSITION = 'crossDissolve';

/** A size a splitter can have left behind, in pixels: the layout fits it to the window later. */
const PANEL_SIZE = { min: 1, max: 10_000 };
/** The heights a track can be dragged to, in pixels. */
export const LANE_HEIGHT = { min: 26, max: 220 };
/** How many projects keep lane heights of their own. The ones set longest ago make room. */
const LANE_HEIGHT_PROJECTS = 50;
/** What a project or a track can be called by. */
const STORED_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The heights kept by project, as far as what is stored can be trusted: see `readPrefs`. */
function readLaneHeights(stored: unknown): Prefs['laneHeights'] {
  const projects: [string, Record<ID, number>][] = [];
  for (const [project, tracks] of Object.entries(isRecord(stored) ? stored : {})) {
    const heights = Object.entries(isRecord(tracks) ? tracks : {}).filter(
      (entry): entry is [ID, number] =>
        STORED_ID.test(entry[0]) &&
        typeof entry[1] === 'number' &&
        entry[1] >= LANE_HEIGHT.min &&
        entry[1] <= LANE_HEIGHT.max,
    );
    if (STORED_ID.test(project) && heights.length) projects.push([project, Object.fromEntries(heights)]);
  }
  return Object.fromEntries(projects.slice(-LANE_HEIGHT_PROJECTS));
}

/**
 * `all` with the height one track of a project is to be drawn at for this person. What was kept
 * for tracks the project no longer has goes with the change, and the project counts as the one
 * set last.
 */
export function withLaneHeight(
  all: Prefs['laneHeights'],
  project: string,
  tracks: Readonly<Record<ID, unknown>>,
  track: ID,
  height: number,
): Prefs['laneHeights'] {
  const { [project]: before = {}, ...others } = all;
  if (before[track] === height) return all;
  const kept = Object.entries(before).filter(([id]) => Object.hasOwn(tracks, id));
  return {
    ...Object.fromEntries(Object.entries(others).slice(1 - LANE_HEIGHT_PROJECTS)),
    [project]: { ...Object.fromEntries(kept), [track]: height },
  };
}

/**
 * The lane heights to store from a tab that holds `mine` and last read or wrote `known`, when
 * storage holds `stored` by now. Another tab can have kept heights for the project it shows since
 * then. Those stay: only the projects whose heights were set in this tab are written over them.
 */
export function laneHeightsToStore(
  known: Prefs['laneHeights'],
  mine: Prefs['laneHeights'],
  stored: Prefs['laneHeights'],
): Prefs['laneHeights'] {
  const here = Object.entries(mine).filter(([project, heights]) => heights !== known[project]);
  const own = new Set(here.map(([project]) => project));
  const there = Object.entries(stored).filter(([project]) => !own.has(project));
  return Object.fromEntries([...there, ...here].slice(-LANE_HEIGHT_PROJECTS));
}

/**
 * The stored preferences as they are written, without the lane heights kept for `project`: null
 * when they hold none for it, and there is nothing to write.
 */
export function withoutLaneHeights(stored: string | null, project: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stored ?? 'null');
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.laneHeights) || !Object.hasOwn(raw.laneHeights, project)) return null;
  const others = Object.entries(raw.laneHeights).filter(([id]) => id !== project);
  return JSON.stringify({ ...raw, laneHeights: Object.fromEntries(others) });
}

/**
 * The stored preferences, as far as they can be trusted. The entry outlives the version that
 * wrote it and can be edited or damaged, so each field is taken only with the right type and a
 * finite, plausible value, and is otherwise the one a first visit starts from. One bad field
 * does not cost the others.
 */
export function readPrefs(stored: string | null): Prefs {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stored ?? '{}');
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: a first visit */
  }
  const flag = (value: unknown, initial: boolean): boolean => (typeof value === 'boolean' ? value : initial);
  const size = (value: unknown, initial: number): number =>
    typeof value === 'number' && value >= PANEL_SIZE.min && value <= PANEL_SIZE.max ? value : initial;
  // The name of a transition; whether there still is one by that name is checked where it is used.
  const name = (value: unknown, initial: string): string =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : initial;
  const scopes = (raw.scopes && typeof raw.scopes === 'object' ? raw.scopes : {}) as Record<string, unknown>;
  return {
    snapping: flag(raw.snapping, true),
    linkedSelection: flag(raw.linkedSelection, true),
    markersFollow: flag(raw.markersFollow, true),
    defaultTransition: name(raw.defaultTransition, FIRST_TRANSITION),
    leftWidth: size(raw.leftWidth, 320),
    rightWidth: size(raw.rightWidth, 316),
    timelineHeight: size(raw.timelineHeight, 320),
    laneHeights: readLaneHeights(raw.laneHeights),
    scopes: {
      waveform: flag(scopes.waveform, true),
      parade: flag(scopes.parade, true),
      vectorscope: flag(scopes.vectorscope, true),
      histogram: flag(scopes.histogram, false),
    },
  };
}

const PREFS_KEY = 'tandem.ui.v1';

const persisted = readPrefs(
  (() => {
    try {
      return localStorage.getItem(PREFS_KEY);
    } catch {
      return null;
    }
  })(),
);

export const useUI = create<UIState>((set, get) => ({
  selection: [],
  selectedTransition: null,
  tool: 'select',
  snapping: persisted.snapping,
  rippleMode: false,
  linkedSelection: persisted.linkedSelection,
  markersFollow: persisted.markersFollow,
  defaultTransition: persisted.defaultTransition,
  ppf: 4,
  scrollX: 0,
  workspace: 'edit',
  libraryTab: 'media',
  leftWidth: persisted.leftWidth,
  rightWidth: persisted.rightWidth,
  timelineHeight: persisted.timelineHeight,
  laneHeights: persisted.laneHeights,
  commentsOpen: false,
  preview: null,
  snapLine: null,
  dialog: null,
  showSafeAreas: false,
  showGrid: false,
  showStats: false,
  viewerZoom: 'fit',
  following: null,
  clipboard: [],
  clipboardFps: 0,
  attributes: null,
  sourceAsset: null,
  sourceCue: null,
  sourceMarks: {},
  revealAsset: null,
  revealEffects: [],
  poolSelection: [],
  recording: null,
  typing: null,
  scopes: persisted.scopes,

  select: (ids, additive) =>
    set((s) => ({
      selection: additive ? Array.from(new Set([...s.selection, ...ids])) : ids,
      selectedTransition: null,
    })),
  toggleSelect: (id) => {
    const cur = get().selection;
    set({
      selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
      selectedTransition: null,
    });
  },
  clearSelection: () => {
    if (get().selection.length || get().selectedTransition) set({ selection: [], selectedTransition: null });
  },
  set: (patch) => set(patch),
}));

// Persist a few layout preferences.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** The lane heights as this tab last read or wrote them: see `laneHeightsToStore`. */
let knownHeights = persisted.laneHeights;
useUI.subscribe((s) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const stored = readPrefs(localStorage.getItem(PREFS_KEY)).laneHeights;
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          snapping: s.snapping,
          linkedSelection: s.linkedSelection,
          markersFollow: s.markersFollow,
          defaultTransition: s.defaultTransition,
          leftWidth: s.leftWidth,
          rightWidth: s.rightWidth,
          timelineHeight: s.timelineHeight,
          laneHeights: laneHeightsToStore(knownHeights, s.laneHeights, stored),
          scopes: s.scopes,
        }),
      );
      knownHeights = s.laneHeights;
    } catch {
      /* ignore */
    }
  }, 400);
});

/**
 * Let go of the lane heights kept for a project that has been deleted from this device. They leave
 * what is stored here and now, not with the next save: that one keeps what it finds stored for
 * every project this tab did not size, and the heights may well be from another tab.
 */
export function forgetLaneHeights(project: string): void {
  try {
    const without = withoutLaneHeights(localStorage.getItem(PREFS_KEY), project);
    if (without !== null) localStorage.setItem(PREFS_KEY, without);
  } catch {
    /* storage that cannot be read or written is not kept up to date either */
  }
  const { laneHeights, set } = useUI.getState();
  if (!Object.hasOwn(laneHeights, project)) return;
  set({ laneHeights: Object.fromEntries(Object.entries(laneHeights).filter(([id]) => id !== project)) });
}

export const MIN_PPF = 0.004;
export const MAX_PPF = 60;
export const clampPpf = (v: number): number => Math.min(MAX_PPF, Math.max(MIN_PPF, v));
