/** The command catalogue: one list drives keyboard shortcuts, the palette and the cheat sheet. */
import { secondsToFrame } from '@tandem/core';
import { currentSession } from '../session/hooks';
import { cmd } from './commands';
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
  { id: 'shuttle-back', title: 'Shuttle backwards', group: 'Playback', keys: ['j'], run: () => cmd.shuttle(-1) },
  { id: 'shuttle-stop', title: 'Stop', group: 'Playback', keys: ['k'], run: () => cmd.shuttle(0) },
  { id: 'shuttle-fwd', title: 'Shuttle forwards', group: 'Playback', keys: ['l'], run: () => cmd.shuttle(1) },
  { id: 'step-back', title: 'Step back one frame', group: 'Playback', keys: ['arrowleft'], run: () => cmd.step(-1), repeat: true },
  { id: 'step-fwd', title: 'Step forward one frame', group: 'Playback', keys: ['arrowright'], run: () => cmd.step(1), repeat: true },
  { id: 'jump-back', title: 'Jump back one second', group: 'Playback', keys: ['shift+arrowleft'], run: () => cmd.step(-fps()), repeat: true },
  { id: 'jump-fwd', title: 'Jump forward one second', group: 'Playback', keys: ['shift+arrowright'], run: () => cmd.step(fps()), repeat: true },
  { id: 'prev-edit', title: 'Go to previous edit', group: 'Playback', keys: ['arrowup'], run: () => cmd.prevEdit(), repeat: true },
  { id: 'next-edit', title: 'Go to next edit', group: 'Playback', keys: ['arrowdown'], run: () => cmd.nextEdit(), repeat: true },
  { id: 'go-start', title: 'Go to start', group: 'Playback', keys: ['home'], run: () => cmd.goStart() },
  { id: 'go-end', title: 'Go to end', group: 'Playback', keys: ['end'], run: () => cmd.goEnd() },
  { id: 'loop', title: 'Toggle loop playback', group: 'Playback', keys: ['mod+l'], run: () => cmd.toggleLoop() },

  // Edit
  { id: 'undo', title: 'Undo', group: 'Edit', keys: ['mod+z'], run: () => cmd.undo(), repeat: true },
  { id: 'redo', title: 'Redo', group: 'Edit', keys: ['mod+shift+z', 'mod+y'], run: () => cmd.redo(), repeat: true },
  { id: 'cut', title: 'Cut', group: 'Edit', keys: ['mod+x'], run: () => cmd.cut() },
  { id: 'copy', title: 'Copy', group: 'Edit', keys: ['mod+c'], run: () => cmd.copy() },
  { id: 'paste', title: 'Paste at playhead', group: 'Edit', keys: ['mod+v'], run: () => cmd.paste() },
  { id: 'duplicate', title: 'Duplicate', group: 'Edit', keys: ['mod+d'], run: () => cmd.duplicate() },
  { id: 'copy-attrs', title: 'Copy attributes', group: 'Edit', keys: ['mod+alt+c'], run: () => cmd.copyAttributes() },
  { id: 'paste-attrs', title: 'Paste attributes', group: 'Edit', keys: ['mod+alt+v'], run: () => cmd.pasteAttributes('all') },
  { id: 'select-all', title: 'Select all', group: 'Edit', keys: ['mod+a'], run: () => cmd.selectAll() },
  { id: 'deselect', title: 'Deselect all', group: 'Edit', keys: ['escape'], run: () => cmd.deselect() },
  { id: 'delete', title: 'Delete', group: 'Edit', keys: ['delete', 'backspace'], run: () => cmd.delete(false) },
  { id: 'ripple-delete', title: 'Ripple delete', group: 'Edit', keys: ['shift+delete', 'shift+backspace'], run: () => cmd.delete(true) },

  // Timeline
  { id: 'split', title: 'Split at playhead', group: 'Timeline', keys: ['mod+b', 's'], run: () => cmd.split() },
  { id: 'trim-start', title: 'Ripple trim start to playhead', group: 'Timeline', keys: ['q'], run: () => cmd.trimToPlayhead('start') },
  { id: 'trim-end', title: 'Ripple trim end to playhead', group: 'Timeline', keys: ['w'], run: () => cmd.trimToPlayhead('end') },
  { id: 'close-gap', title: 'Close gap at playhead', group: 'Timeline', keys: ['shift+g'], run: () => cmd.closeGapAtPlayhead() },
  { id: 'nudge-left', title: 'Nudge selection left', group: 'Timeline', keys: ['comma'], run: () => cmd.nudge(-1), repeat: true },
  { id: 'nudge-right', title: 'Nudge selection right', group: 'Timeline', keys: ['period'], run: () => cmd.nudge(1), repeat: true },
  { id: 'nudge-left-10', title: 'Nudge selection left 10 frames', group: 'Timeline', keys: ['shift+comma'], run: () => cmd.nudge(-10), repeat: true },
  { id: 'nudge-right-10', title: 'Nudge selection right 10 frames', group: 'Timeline', keys: ['shift+period'], run: () => cmd.nudge(10), repeat: true },
  { id: 'nudge-up', title: 'Move selection up a track', group: 'Timeline', keys: ['alt+arrowup'], run: () => cmd.nudgeTrack(1) },
  { id: 'nudge-down', title: 'Move selection down a track', group: 'Timeline', keys: ['alt+arrowdown'], run: () => cmd.nudgeTrack(-1) },
  { id: 'enable', title: 'Enable / disable clip', group: 'Timeline', keys: ['d'], run: () => cmd.toggleEnabled() },
  { id: 'link', title: 'Link clips', group: 'Timeline', keys: ['mod+g'], run: () => cmd.link() },
  { id: 'unlink', title: 'Unlink clips', group: 'Timeline', keys: ['mod+shift+g'], run: () => cmd.unlink() },
  { id: 'snapping', title: 'Toggle snapping', group: 'Timeline', keys: ['n'], run: () => ui().set({ snapping: !ui().snapping }) },
  { id: 'ripple-mode', title: 'Toggle ripple editing', group: 'Timeline', keys: ['r'], run: () => ui().set({ rippleMode: !ui().rippleMode }) },
  { id: 'linked-selection', title: 'Toggle linked selection', group: 'Timeline', keys: ['mod+shift+l'], run: () => ui().set({ linkedSelection: !ui().linkedSelection }) },
  { id: 'add-video-track', title: 'Add video track', group: 'Timeline', run: () => cmd.addTrack('video') },
  { id: 'add-audio-track', title: 'Add audio track', group: 'Timeline', run: () => cmd.addTrack('audio') },

  // Markers & range
  { id: 'marker', title: 'Add / remove marker', group: 'Markers', keys: ['m'], run: () => cmd.addMarker() },
  { id: 'mark-in', title: 'Mark in', group: 'Markers', keys: ['i'], run: () => cmd.markIn() },
  { id: 'mark-out', title: 'Mark out', group: 'Markers', keys: ['o'], run: () => cmd.markOut() },
  { id: 'clear-range', title: 'Clear in / out', group: 'Markers', keys: ['alt+x'], run: () => cmd.clearRange() },

  // Tools
  { id: 'tool-select', title: 'Selection tool', group: 'Tools', keys: ['v', 'a'], run: () => cmd.setTool('select') },
  { id: 'tool-blade', title: 'Blade tool', group: 'Tools', keys: ['b', 'c'], run: () => cmd.setTool('blade') },
  { id: 'tool-slip', title: 'Slip tool', group: 'Tools', keys: ['y'], run: () => cmd.setTool('slip') },
  { id: 'tool-hand', title: 'Hand tool', group: 'Tools', keys: ['h'], run: () => cmd.setTool('hand') },

  // View
  { id: 'zoom-in', title: 'Zoom in timeline', group: 'View', keys: ['equal', 'mod+equal'], run: () => cmd.zoom(1.4), repeat: true },
  { id: 'zoom-out', title: 'Zoom out timeline', group: 'View', keys: ['minus', 'mod+minus'], run: () => cmd.zoom(1 / 1.4), repeat: true },
  { id: 'zoom-fit', title: 'Fit timeline to window', group: 'View', keys: ['shift+z'], run: () => cmd.zoomFit() },
  { id: 'ws-edit', title: 'Edit workspace', group: 'View', keys: ['shift+1'], run: () => ui().set({ workspace: 'edit' }) },
  { id: 'ws-color', title: 'Color workspace', group: 'View', keys: ['shift+2'], run: () => ui().set({ workspace: 'color' }) },
  { id: 'ws-audio', title: 'Audio workspace', group: 'View', keys: ['shift+3'], run: () => ui().set({ workspace: 'audio' }) },
  { id: 'palette', title: 'Command palette', group: 'View', keys: ['mod+k', 'mod+shift+p'], run: () => ui().set({ dialog: 'palette' }) },
  { id: 'shortcuts', title: 'Keyboard shortcuts', group: 'View', keys: ['shift+slash'], run: () => ui().set({ dialog: 'shortcuts' }) },
  { id: 'comments', title: 'Toggle comments', group: 'View', keys: ['shift+c'], run: () => ui().set({ commentsOpen: !ui().commentsOpen }) },
  { id: 'safe-areas', title: 'Toggle safe areas', group: 'View', keys: ['shift+quote'], run: () => ui().set({ showSafeAreas: !ui().showSafeAreas }) },
  { id: 'stats', title: 'Toggle performance stats', group: 'View', run: () => ui().set({ showStats: !ui().showStats }) },

  // Insert
  { id: 'add-text', title: 'Add text', group: 'Insert', keys: ['t'], run: () => cmd.addText() },
  { id: 'add-shape', title: 'Add rectangle', group: 'Insert', run: () => cmd.addShape({ kind: 'rect' }) },
  { id: 'add-solid', title: 'Add solid colour', group: 'Insert', run: () => cmd.addSolid() },
  { id: 'add-adjustment', title: 'Add adjustment layer', group: 'Insert', run: () => cmd.addAdjustment() },

  // File
  { id: 'import', title: 'Import media…', group: 'File', keys: ['mod+i'], run: () => void cmd.importMedia() },
  { id: 'export', title: 'Export…', group: 'File', keys: ['mod+e'], run: () => ui().set({ dialog: 'export' }) },
  { id: 'share', title: 'Share…', group: 'File', run: () => ui().set({ dialog: 'share' }) },
  { id: 'save-file', title: 'Save project file', group: 'File', keys: ['mod+s'], run: () => cmd.saveProjectFile() },
  { id: 'open-file', title: 'Open project file…', group: 'File', keys: ['mod+o'], run: () => void cmd.openProjectFile() },
  { id: 'still', title: 'Export current frame as PNG', group: 'File', keys: ['mod+shift+e'], run: () => void cmd.captureStill() },
  { id: 'export-srt', title: 'Export captions (.srt)', group: 'File', run: () => cmd.exportSubtitles() },
  { id: 'versions', title: 'Version history…', group: 'File', run: () => ui().set({ dialog: 'versions' }) },
  { id: 'project-settings', title: 'Project settings…', group: 'File', run: () => ui().set({ dialog: 'project' }) },
];

const KEY_NAMES: Record<string, string> = {
  ' ': 'space',
  '=': 'equal',
  '+': 'equal',
  '-': 'minus',
  _: 'minus',
  ',': 'comma',
  '<': 'comma',
  '.': 'period',
  '>': 'period',
  '/': 'slash',
  '?': 'slash',
  '\\': 'backslash',
  "'": 'quote',
  '"': 'quote',
  '!': '1',
  '@': '2',
  '#': '3',
};

/** Canonical string for a keyboard event, e.g. `mod+shift+z`. */
export function eventKeys(e: KeyboardEvent): string {
  let key = KEY_NAMES[e.key] ?? e.key.toLowerCase();
  // Shifted digits arrive as symbols on most layouts; fall back to the physical key.
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

const index = new Map<string, Command>();
for (const c of COMMANDS) for (const k of c.keys ?? []) index.set(k, c);

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** Global key handler. Returns true when the event was consumed. */
export function handleKey(e: KeyboardEvent): boolean {
  if (isTyping(e.target)) return false;
  if (useUI.getState().dialog && useUI.getState().dialog !== 'palette') return false;
  const c = index.get(eventKeys(e));
  if (!c) return false;
  if (e.repeat && !c.repeat) {
    e.preventDefault();
    return true;
  }
  e.preventDefault();
  c.run();
  return true;
}
