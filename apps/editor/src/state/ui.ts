/** Local, per-user interface state. Nothing in here is synced to collaborators. */
import { create } from 'zustand';
import type { Clip, Grade, EffectInstance, ID, Project } from '@tandem/core';

export type Tool = 'select' | 'blade' | 'slip' | 'hand';
export type Workspace = 'edit' | 'color' | 'audio';
export type LibraryTab = 'media' | 'text' | 'effects' | 'transitions';
export type DialogId =
  'export' | 'share' | 'shortcuts' | 'versions' | 'palette' | 'project' | 'profile' | null;

export interface AttributeClipboard {
  effects: EffectInstance[];
  grade: Grade | null;
  transform: Pick<
    Clip,
    'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity' | 'blend' | 'cropL' | 'cropT' | 'cropR' | 'cropB'
  >;
}

export interface UIState {
  selection: ID[];
  selectedTransition: { clipId: ID; side: 'in' | 'out' } | null;
  tool: Tool;
  snapping: boolean;
  rippleMode: boolean;
  linkedSelection: boolean;
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
  attributes: AttributeClipboard | null;
  /** Asset shown in the source monitor, or null for the programme. */
  sourceAsset: ID | null;
  /** Match frame: the source monitor holds this asset at `time` seconds instead of playing it. */
  sourceCue: { assetId: ID; time: number } | null;
  /** Asset the media pool is asked to bring into view; the pool clears it once it has. */
  revealAsset: ID | null;
  scopes: { waveform: boolean; parade: boolean; vectorscope: boolean; histogram: boolean };
  /** A voiceover is being recorded: where on the timeline it began, and when. */
  recording: { startFrame: number; startedAt: number } | null;

  select: (ids: ID[], additive?: boolean) => void;
  toggleSelect: (id: ID) => void;
  clearSelection: () => void;
  set: (patch: Partial<UIState>) => void;
}

const persisted = (() => {
  try {
    return JSON.parse(localStorage.getItem('tandem.ui.v1') ?? '{}') as Partial<UIState>;
  } catch {
    return {};
  }
})();

export const useUI = create<UIState>((set, get) => ({
  selection: [],
  selectedTransition: null,
  tool: 'select',
  snapping: persisted.snapping ?? true,
  rippleMode: false,
  linkedSelection: persisted.linkedSelection ?? true,
  ppf: 4,
  scrollX: 0,
  workspace: 'edit',
  libraryTab: 'media',
  leftWidth: persisted.leftWidth ?? 320,
  rightWidth: persisted.rightWidth ?? 316,
  timelineHeight: persisted.timelineHeight ?? 320,
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
  attributes: null,
  sourceAsset: null,
  sourceCue: null,
  revealAsset: null,
  recording: null,
  scopes: persisted.scopes ?? { waveform: true, parade: true, vectorscope: true, histogram: false },

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
