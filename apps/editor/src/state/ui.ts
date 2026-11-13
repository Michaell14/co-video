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

export interface UIState {
  selection: ID[];
  selectedTransition: { clipId: ID; side: 'in' | 'out' } | null;
  tool: Tool;
  snapping: boolean;
  rippleMode: boolean;
  linkedSelection: boolean;
  /** Markers move with the clips when a ripple edit takes time out of the sequence or puts it in. */
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
  /** Asset the media pool is asked to bring into view; the pool clears it once it has. */
  revealAsset: ID | null;
  /** Effects just added by hand, for the inspector to bring into view; it clears them once it has looked. */
  revealEffects: ID[];
  /** The files selected in the media pool, in the order they were picked. */
  poolSelection: ID[];
  scopes: { waveform: boolean; parade: boolean; vectorscope: boolean; histogram: boolean };
  /** A voiceover is being recorded: where on the timeline it began, and when. */
  recording: { startFrame: number; startedAt: number } | null;

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
  | 'scopes'
>;

/** The transition `Add default transition` starts out with. */
export const FIRST_TRANSITION = 'crossDissolve';

/** A size a splitter can have left behind, in pixels: the layout fits it to the window later. */
const PANEL_SIZE = { min: 1, max: 10_000 };

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
    scopes: {
      waveform: flag(scopes.waveform, true),
      parade: flag(scopes.parade, true),
      vectorscope: flag(scopes.vectorscope, true),
      histogram: flag(scopes.histogram, false),
    },
  };
}

const persisted = readPrefs(
  (() => {
    try {
      return localStorage.getItem('tandem.ui.v1');
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
  revealAsset: null,
  revealEffects: [],
  poolSelection: [],
  recording: null,
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
useUI.subscribe((s) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        'tandem.ui.v1',
        JSON.stringify({
          snapping: s.snapping,
          linkedSelection: s.linkedSelection,
          markersFollow: s.markersFollow,
          defaultTransition: s.defaultTransition,
          leftWidth: s.leftWidth,
          rightWidth: s.rightWidth,
          timelineHeight: s.timelineHeight,
          scopes: s.scopes,
        }),
      );
    } catch {
      /* ignore */
    }
  }, 400);
});

export const MIN_PPF = 0.004;
export const MAX_PPF = 60;
export const clampPpf = (v: number): number => Math.min(MAX_PPF, Math.max(MIN_PPF, v));
