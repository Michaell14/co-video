/** The command catalogue: one list drives keyboard shortcuts, the palette and the cheat sheet. */
import { secondsToFrame } from '@tandem/core';
import { currentSession } from '../session/hooks';
import { layerOpen } from '../ui/layers';
import { cmd } from './commands';
import { eventKeys } from './keys';
import { useUI } from './ui';

export interface Command {
  id: string;
  title: string;
  group: 'Playback' | 'Edit' | 'Timeline' | 'Tools' | 'View' | 'File' | 'Insert' | 'Markers';
  /** One or more shortcuts, e.g. `mod+shift+z`. */
  keys?: string[];
  run: () => void;
  /** Fire repeatedly while the key is held. */
  repeat?: boolean;
}

const ui = () => useUI.getState();
const fps = () => {
  const s = currentSession()?.store.get().settings;
  return s ? Math.round(secondsToFrame(1, s)) : 30;
};

export const COMMANDS: Command[] = [
  // Playback
  { id: 'play', title: 'Play / Pause', group: 'Playback', keys: ['space'], run: () => cmd.togglePlay() },
  {
    id: 'shuttle-back',
    title: 'Shuttle backwards',
    group: 'Playback',
    keys: ['j'],
    run: () => cmd.shuttle(-1),
  },
  { id: 'shuttle-stop', title: 'Stop', group: 'Playback', keys: ['k'], run: () => cmd.shuttle(0) },
  { id: 'shuttle-fwd', title: 'Shuttle forwards', group: 'Playback', keys: ['l'], run: () => cmd.shuttle(1) },
  {
    id: 'step-back',
    title: 'Step back one frame',
    group: 'Playback',
    keys: ['arrowleft'],
    run: () => cmd.step(-1),
    repeat: true,
  },
  {
    id: 'step-fwd',
    title: 'Step forward one frame',
    group: 'Playback',
    keys: ['arrowright'],
    run: () => cmd.step(1),
    repeat: true,
  },
  {
    id: 'jump-back',
    title: 'Jump back one second',
    group: 'Playback',
    keys: ['shift+arrowleft'],
    run: () => cmd.step(-fps()),
    repeat: true,
  },
  {
    id: 'jump-fwd',
    title: 'Jump forward one second',
    group: 'Playback',
    keys: ['shift+arrowright'],
    run: () => cmd.step(fps()),
    repeat: true,
  },
  {
    id: 'prev-edit',
    title: 'Go to previous edit',
    group: 'Playback',
    keys: ['arrowup'],
    run: () => cmd.prevEdit(),
    repeat: true,
  },
  {
    id: 'next-edit',
    title: 'Go to next edit',
    group: 'Playback',
    keys: ['arrowdown'],
    run: () => cmd.nextEdit(),
    repeat: true,
  },
  { id: 'go-start', title: 'Go to start', group: 'Playback', keys: ['home'], run: () => cmd.goStart() },
  { id: 'go-end', title: 'Go to end', group: 'Playback', keys: ['end'], run: () => cmd.goEnd() },
  {
    id: 'loop',
    title: 'Toggle loop playback',
    group: 'Playback',
    keys: ['mod+l'],
    run: () => cmd.toggleLoop(),
  },
  {
    id: 'match-frame',
    title: 'Match frame (open the source at the playhead)',
    group: 'Playback',
    keys: ['f'],
    run: () => cmd.matchFrame(),
  },

  // Edit
  { id: 'undo', title: 'Undo', group: 'Edit', keys: ['mod+z'], run: () => cmd.undo(), repeat: true },
  {
    id: 'redo',
    title: 'Redo',
    group: 'Edit',
    keys: ['mod+shift+z', 'mod+y'],
    run: () => cmd.redo(),
    repeat: true,
  },
  { id: 'cut', title: 'Cut', group: 'Edit', keys: ['mod+x'], run: () => cmd.cut() },
  { id: 'copy', title: 'Copy', group: 'Edit', keys: ['mod+c'], run: () => cmd.copy() },
  { id: 'paste', title: 'Paste at playhead', group: 'Edit', keys: ['mod+v'], run: () => cmd.paste() },
  {
    id: 'paste-insert',
    title: 'Paste insert at playhead',
    group: 'Edit',
    keys: ['mod+shift+v'],
    run: () => cmd.pasteInsert(),
  },
  { id: 'duplicate', title: 'Duplicate', group: 'Edit', keys: ['mod+d'], run: () => cmd.duplicate() },
  {
    id: 'copy-attrs',
    title: 'Copy attributes',
    group: 'Edit',
    keys: ['mod+alt+c'],
    run: () => cmd.copyAttributes(),
  },
  {
    id: 'paste-attrs',
    title: 'Paste attributes',
    group: 'Edit',
    keys: ['mod+alt+v'],
    run: () => cmd.pasteAttributes('all'),
  },
  {
    id: 'paste-grade',
    title: 'Paste attributes: grade only',
    group: 'Edit',
    run: () => cmd.pasteAttributes('grade'),
  },
  {
    id: 'paste-effects',
    title: 'Paste attributes: effects only',
    group: 'Edit',
    run: () => cmd.pasteAttributes('effects'),
  },
  {
    id: 'paste-transform',
    title: 'Paste attributes: transform and crop only',
    group: 'Edit',
    run: () => cmd.pasteAttributes('transform'),
  },
  {
    id: 'paste-sound',
    title: 'Paste attributes: volume, pan and fades only',
    group: 'Edit',
    run: () => cmd.pasteAttributes('sound'),
  },
  { id: 'select-all', title: 'Select all', group: 'Edit', keys: ['mod+a'], run: () => cmd.selectAll() },
  {
    id: 'select-right',
    title: 'Select all clips to the right of the playhead',
    group: 'Edit',
    keys: ['shift+end'],
    run: () => cmd.selectBeside('right'),
  },
  {
    id: 'select-left',
    title: 'Select all clips to the left of the playhead',
    group: 'Edit',
    keys: ['shift+home'],
    run: () => cmd.selectBeside('left'),
  },
  {
    id: 'select-under',
    title: 'Select clip under playhead',
    group: 'Edit',
    keys: ['shift+v'],
    run: () => cmd.selectUnderPlayhead(),
  },
  {
    id: 'select-next',
    title: 'Select next clip',
    group: 'Edit',
    keys: ['mod+arrowdown'],
    run: () => cmd.selectClip(1),
    repeat: true,
  },
  {
    id: 'select-prev',
    title: 'Select previous clip',
    group: 'Edit',
    keys: ['mod+arrowup'],
    run: () => cmd.selectClip(-1),
    repeat: true,
  },
  {
    id: 'select-next-add',
    title: 'Add next clip to selection',
    group: 'Edit',
    keys: ['mod+shift+arrowdown'],
    run: () => cmd.selectClip(1, true),
    repeat: true,
  },
  {
    id: 'select-prev-add',
    title: 'Add previous clip to selection',
    group: 'Edit',
    keys: ['mod+shift+arrowup'],
    run: () => cmd.selectClip(-1, true),
    repeat: true,
  },
  { id: 'deselect', title: 'Deselect all', group: 'Edit', keys: ['escape'], run: () => cmd.deselect() },
  {
    id: 'delete',
    title: 'Delete',
    group: 'Edit',
    keys: ['delete', 'backspace'],
    run: () => cmd.delete(false),
  },
  {
    id: 'ripple-delete',
    title: 'Ripple delete',
    group: 'Edit',
    keys: ['shift+delete', 'shift+backspace'],
    run: () => cmd.delete(true),
  },

  // Timeline
  {
    id: 'split',
    title: 'Split at playhead',
    group: 'Timeline',
    keys: ['mod+b', 's'],
    run: () => cmd.split(),
  },
  {
    id: 'normalize-14',
    title: 'Normalize loudness to −14 LUFS (streaming)',
    group: 'Timeline',
    keys: [],
    run: () => void cmd.normalizeLoudness(-14),
  },
  {
    id: 'normalize-16',
    title: 'Normalize loudness to −16 LUFS (podcast)',
    group: 'Timeline',
    keys: [],
    run: () => void cmd.normalizeLoudness(-16),
  },
  {
    id: 'normalize-23',
    title: 'Normalize loudness to −23 LUFS (broadcast)',
    group: 'Timeline',
    keys: [],
    run: () => void cmd.normalizeLoudness(-23),
  },
  {
    id: 'voiceover',
    title: 'Record voiceover (start / stop)',
    group: 'Timeline',
    keys: ['shift+r'],
    run: () => void cmd.toggleVoiceover(),
  },
  {
    id: 'freeze-frame',
    title: 'Freeze frame at playhead',
    group: 'Timeline',
    keys: ['shift+f'],
    run: () => cmd.freezeFrame(),
  },
  {
    id: 'trim-start',
    title: 'Ripple trim start to playhead',
    group: 'Timeline',
    keys: ['q'],
    run: () => cmd.trimToPlayhead('start'),
  },
  {
    id: 'trim-end',
    title: 'Ripple trim end to playhead',
    group: 'Timeline',
    keys: ['w'],
    run: () => cmd.trimToPlayhead('end'),
  },
  {
    id: 'trim-edge-left',
    title: 'Trim nearest edge left',
    group: 'Timeline',
    keys: ['mod+arrowleft'],
    run: () => cmd.trimEdge(-1),
    repeat: true,
  },
  {
    id: 'trim-edge-right',
    title: 'Trim nearest edge right',
    group: 'Timeline',
    keys: ['mod+arrowright'],
    run: () => cmd.trimEdge(1),
    repeat: true,
  },
  {
    id: 'trim-edge-left-5',
    title: 'Trim nearest edge left 5 frames',
    group: 'Timeline',
    keys: ['mod+shift+arrowleft'],
    run: () => cmd.trimEdge(-5),
    repeat: true,
  },
  {
    id: 'trim-edge-right-5',
    title: 'Trim nearest edge right 5 frames',
    group: 'Timeline',
    keys: ['mod+shift+arrowright'],
    run: () => cmd.trimEdge(5),
    repeat: true,
  },
  {
    id: 'extend-edit',
    title: 'Extend edit to playhead',
    group: 'Timeline',
    keys: ['e'],
    run: () => cmd.extendEdit(),
  },
  {
    id: 'default-transition',
    title: 'Add default transition',
    group: 'Timeline',
    keys: ['shift+d'],
    run: () => cmd.addDefaultTransition(),
  },
  {
    id: 'close-gap',
    title: 'Close gap at playhead',
    group: 'Timeline',
    keys: ['shift+g'],
    run: () => cmd.closeGapAtPlayhead(),
  },
  {
    id: 'nudge-left',
    title: 'Nudge selection left',
    group: 'Timeline',
    keys: ['comma'],
    run: () => cmd.nudge(-1),
    repeat: true,
  },
  {
    id: 'nudge-right',
    title: 'Nudge selection right',
    group: 'Timeline',
    keys: ['period'],
    run: () => cmd.nudge(1),
    repeat: true,
  },
  {
    id: 'nudge-left-10',
    title: 'Nudge selection left 10 frames',
    group: 'Timeline',
    keys: ['shift+comma'],
    run: () => cmd.nudge(-10),
    repeat: true,
  },
  {
    id: 'nudge-right-10',
    title: 'Nudge selection right 10 frames',
    group: 'Timeline',
    keys: ['shift+period'],
    run: () => cmd.nudge(10),
    repeat: true,
  },
  {
    id: 'nudge-up',
    title: 'Move selection up a track',
    group: 'Timeline',
    keys: ['alt+arrowup'],
    run: () => cmd.nudgeTrack(1),
  },
  {
    id: 'nudge-down',
    title: 'Move selection down a track',
    group: 'Timeline',
    keys: ['alt+arrowdown'],
    run: () => cmd.nudgeTrack(-1),
  },
  {
    id: 'enable',
    title: 'Enable / disable clip',
    group: 'Timeline',
    keys: ['d'],
    run: () => cmd.toggleEnabled(),
  },
  { id: 'link', title: 'Link clips', group: 'Timeline', keys: ['mod+g'], run: () => cmd.link() },
  { id: 'unlink', title: 'Unlink clips', group: 'Timeline', keys: ['mod+shift+g'], run: () => cmd.unlink() },
  {
    id: 'snapping',
    title: 'Toggle snapping',
    group: 'Timeline',
    keys: ['n'],
    run: () => ui().set({ snapping: !ui().snapping }),
  },
  {
    id: 'ripple-mode',
    title: 'Toggle ripple editing',
    group: 'Timeline',
    keys: ['r'],
    run: () => ui().set({ rippleMode: !ui().rippleMode }),
  },
  {
    id: 'linked-selection',
    title: 'Toggle linked selection',
    group: 'Timeline',
    keys: ['mod+shift+l'],
    run: () => ui().set({ linkedSelection: !ui().linkedSelection }),
  },
  { id: 'add-video-track', title: 'Add video track', group: 'Timeline', run: () => cmd.addTrack('video') },
  { id: 'add-audio-track', title: 'Add audio track', group: 'Timeline', run: () => cmd.addTrack('audio') },

  // Markers & range
  { id: 'marker', title: 'Add / remove marker', group: 'Markers', keys: ['m'], run: () => cmd.addMarker() },
  {
    id: 'next-marker',
    title: 'Go to next marker',
    group: 'Markers',
    keys: ['shift+m'],
    run: () => cmd.goToMarker(1),
    repeat: true,
  },
  {
    id: 'prev-marker',
    title: 'Go to previous marker',
    group: 'Markers',
    keys: ['mod+shift+m', 'alt+m'],
    run: () => cmd.goToMarker(-1),
    repeat: true,
  },
  { id: 'mark-in', title: 'Mark in', group: 'Markers', keys: ['i'], run: () => cmd.markIn() },
  { id: 'mark-out', title: 'Mark out', group: 'Markers', keys: ['o'], run: () => cmd.markOut() },
  { id: 'mark-clip', title: 'Mark clip', group: 'Markers', keys: ['x'], run: () => cmd.markClip() },
  { id: 'go-in', title: 'Go to in', group: 'Markers', keys: ['shift+i'], run: () => cmd.goToRange('in') },
  { id: 'go-out', title: 'Go to out', group: 'Markers', keys: ['shift+o'], run: () => cmd.goToRange('out') },
  {
    id: 'clear-range',
    title: 'Clear in / out',
    group: 'Markers',
    keys: ['alt+x'],
    run: () => cmd.clearRange(),
  },
  {
    id: 'markers-follow',
    title: 'Toggle markers follow ripple edits',
    group: 'Markers',
    run: () => cmd.toggleMarkersFollow(),
  },

  // Tools
  {
    id: 'tool-select',
    title: 'Selection tool',
    group: 'Tools',
    keys: ['v', 'a'],
    run: () => cmd.setTool('select'),
  },
  {
    id: 'tool-blade',
    title: 'Blade tool',
    group: 'Tools',
    keys: ['b', 'c'],
    run: () => cmd.setTool('blade'),
  },
  { id: 'tool-slip', title: 'Slip tool', group: 'Tools', keys: ['y'], run: () => cmd.setTool('slip') },
  { id: 'tool-hand', title: 'Hand tool', group: 'Tools', keys: ['h'], run: () => cmd.setTool('hand') },

  // View
  {
    id: 'zoom-in',
    title: 'Zoom in timeline',
    group: 'View',
    keys: ['equal', 'mod+equal', 'shift+equal', 'mod+shift+equal'],
    run: () => cmd.zoom(1.4),
    repeat: true,
  },
  {
    id: 'zoom-out',
    title: 'Zoom out timeline',
    group: 'View',
    keys: ['minus', 'mod+minus'],
    run: () => cmd.zoom(1 / 1.4),
    repeat: true,
  },
  {
    id: 'zoom-fit',
    title: 'Fit timeline to window',
    group: 'View',
    keys: ['shift+z'],
    run: () => cmd.zoomFit(),
  },
  {
    id: 'zoom-selection',
    title: 'Zoom timeline to selection',
    group: 'View',
    keys: ['z'],
    run: () => cmd.zoomToSelection(),
  },
  {
    id: 'reveal-in-pool',
    title: 'Reveal in media pool',
    group: 'View',
    run: () => cmd.revealInPool(),
  },
  {
    id: 'ws-edit',
    title: 'Edit workspace',
    group: 'View',
    keys: ['shift+1'],
    run: () => ui().set({ workspace: 'edit' }),
  },
  {
    id: 'ws-color',
    title: 'Colour workspace',
    group: 'View',
    keys: ['shift+2'],
    run: () => ui().set({ workspace: 'color' }),
  },
  {
    id: 'ws-audio',
    title: 'Audio workspace',
    group: 'View',
    keys: ['shift+3'],
    run: () => ui().set({ workspace: 'audio' }),
  },
  {
    id: 'palette',
    title: 'Command palette',
    group: 'View',
    keys: ['mod+k', 'mod+shift+p'],
    run: () => ui().set({ dialog: 'palette' }),
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    group: 'View',
    keys: ['shift+slash'],
    run: () => ui().set({ dialog: 'shortcuts' }),
  },
  {
    id: 'comments',
    title: 'Toggle comments',
    group: 'View',
    keys: ['shift+c'],
    run: () => ui().set({ commentsOpen: !ui().commentsOpen }),
  },
  {
    id: 'safe-areas',
    title: 'Toggle safe areas',
    group: 'View',
    keys: ['shift+quote'],
    run: () => ui().set({ showSafeAreas: !ui().showSafeAreas }),
  },
  {
    id: 'stats',
    title: 'Toggle performance stats',
    group: 'View',
    run: () => ui().set({ showStats: !ui().showStats }),
  },

  // Insert
  { id: 'add-text', title: 'Add text', group: 'Insert', keys: ['t'], run: () => cmd.addTitle() },
  { id: 'add-shape', title: 'Add rectangle', group: 'Insert', run: () => cmd.addShape({ kind: 'rect' }) },
  { id: 'add-solid', title: 'Add solid colour', group: 'Insert', run: () => cmd.addSolid() },
  { id: 'add-adjustment', title: 'Add adjustment layer', group: 'Insert', run: () => cmd.addAdjustment() },

  // File
  { id: 'import', title: 'Import media…', group: 'File', keys: ['mod+i'], run: () => void cmd.importMedia() },
  {
    id: 'create-proxies',
    title: 'Create proxies for large media',
    group: 'File',
    keys: [],
    run: () => cmd.createProxies(),
  },
  {
    id: 'toggle-proxies',
    title: 'Toggle preview from proxies',
    group: 'File',
    keys: [],
    run: () => cmd.toggleProxies(),
  },
  { id: 'sample', title: 'Load sample project', group: 'File', run: () => void cmd.loadSample() },
  {
    id: 'export',
    title: 'Export…',
    group: 'File',
    keys: ['mod+e'],
    run: () => ui().set({ dialog: 'export' }),
  },
  { id: 'share', title: 'Share…', group: 'File', run: () => ui().set({ dialog: 'share' }) },
  {
    id: 'save-file',
    title: 'Save project file',
    group: 'File',
    keys: ['mod+s'],
    run: () => cmd.saveProjectFile(),
  },
  {
    id: 'open-file',
    title: 'Open project file…',
    group: 'File',
    keys: ['mod+o'],
    run: () => void cmd.openProjectFile(),
  },
  {
    id: 'replace-file',
    title: 'Replace this project with a project file…',
    group: 'File',
    run: () => void cmd.replaceWithProjectFile(),
  },
  {
    id: 'still',
    title: 'Export current frame as PNG',
    group: 'File',
    keys: ['mod+shift+e'],
    run: () => void cmd.captureStill(),
  },
  { id: 'export-srt', title: 'Export captions (.srt)', group: 'File', run: () => cmd.exportSubtitles() },
  { id: 'export-edl', title: 'Export edit decision list (.edl)', group: 'File', run: () => cmd.exportEdl() },
  { id: 'versions', title: 'Version history…', group: 'File', run: () => ui().set({ dialog: 'versions' }) },
  {
    id: 'project-settings',
    title: 'Project settings…',
    group: 'File',
    run: () => ui().set({ dialog: 'project' }),
  },
];

const index = new Map<string, Command>();
for (const c of COMMANDS) for (const k of c.keys ?? []) index.set(k, c);

/** The shortcut a menu entry or a tooltip shows for the command `id`: its first one, if it has any. */
export function shortcutOf(id: string): string | undefined {
  return COMMANDS.find((c) => c.id === id)?.keys?.[0];
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  );
}

/** The keys that carry focus from one control to another: Tab, and the keys that step through a list. */
const FOCUS_KEYS = new Set([
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/**
 * Follow how the focused control came by its focus: `true` from the function returned while the
 * keyboard brought it there (Tab, an arrow key in a tab list or a menu), `false` once a press of
 * the pointer has. `:focus-visible` cannot be asked instead: in Chromium any key press, the very
 * Space in question included, turns it on for a button that a click left focused.
 *
 * Focus also arrives without having been brought: a menu, a dialog or the palette closes on Escape
 * or Enter and hands it back, or the window comes to the front again. The control it returns to is
 * then what it was the last time it had the focus, so a button that was clicked before the palette
 * opened is not operated by the Space that follows, and one that was reached with Tab still is.
 */
export function watchFocus(target: Pick<Window, 'addEventListener'>): () => boolean {
  // What focus that arrives now follows from: a key that moves it, a press of the pointer, or
  // neither of them.
  let cause: 'key' | 'pointer' | null = null;
  let focused: object | null = null;
  let byKeyboard = false;
  const brought = new WeakMap<object, boolean>();
  const note = (keyboard: boolean): void => {
    byKeyboard = keyboard;
    if (focused) brought.set(focused, keyboard);
  };
  target.addEventListener(
    'keydown',
    (e) => {
      // With Ctrl, Alt or the command key these keys switch tabs and windows, or are shortcuts.
      const moves = FOCUS_KEYS.has(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey;
      cause = moves ? 'key' : null;
    },
    true,
  );
  target.addEventListener(
    'pointerdown',
    () => {
      cause = 'pointer';
      // Also when the press lands on the control that already has focus, and so moves none.
      note(false);
    },
    true,
  );
  target.addEventListener(
    'blur',
    (e) => {
      // The window itself, not a control in it: whatever was pressed last, here or elsewhere, it
      // is not what gives the focus back when the window returns.
      if (e.target === target) cause = null;
    },
    true,
  );
  target.addEventListener(
    'focusin',
    (e) => {
      focused = e.target;
      const before = focused ? brought.get(focused) : undefined;
      note(cause === 'key' || (cause === null && before === true));
    },
    true,
  );
  return () => byKeyboard;
}

const focusedByKeyboard = typeof window === 'undefined' ? () => false : watchFocus(window);

/**
 * Whether Space belongs to the control it was pressed on. A button, switch, tab or option that the
 * keyboard has brought focus to is operated with Space, like anywhere else. One that only kept the
 * focus of the click that last pressed it is not being operated: there Space stays the transport's.
 */
export function spaceOperates(target: EventTarget | null, byKeyboard = focusedByKeyboard()): boolean {
  const el = target as Element | null;
  if (!byKeyboard || typeof el?.matches !== 'function') return false;
  return el.matches('button, [role=switch], [role=tab], [role=option]');
}

/** Global key handler. Returns true when the event was consumed. */
export function handleKey(e: KeyboardEvent): boolean {
  if (isTyping(e.target)) return false;
  // Nothing here acts behind a dialog, the palette or an open menu, whether or not it is one the
  // UI state knows about (confirmations are not) and wherever focus is at that moment.
  if (useUI.getState().dialog || layerOpen()) return false;
  const keys = eventKeys(e);
  if (keys === 'space' && spaceOperates(e.target)) return false;
  const c = index.get(keys);
  if (!c) return false;
  if (e.repeat && !c.repeat) {
    e.preventDefault();
    return true;
  }
  e.preventDefault();
  c.run();
  return true;
}
