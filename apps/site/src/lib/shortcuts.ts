/**
 * The shortcuts the timeline section shows off. Each chord is written as the editor's catalogue
 * writes it (apps/editor/src/state/shortcuts.ts) and is labelled with the title the editor's own
 * shortcut sheet gives that command, so what a visitor reads here is what they find in the app.
 * test/shortcuts.test.ts holds this list to the catalogue.
 */

/** Keys that are drawn as something other than their own character. */
export const NAMED_KEYS = [
  'mod',
  'shift',
  'delete',
  'space',
  'arrowleft',
  'arrowright',
  'arrowdown',
] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];

export interface Shortcut {
  /** One chord such as `mod+b`, or a few single keys that do one job between them. */
  chords: string[];
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { chords: ['j', 'k', 'l'], label: 'Shuttle' },
  { chords: ['space'], label: 'Play / Pause' },
  { chords: ['arrowleft', 'arrowright'], label: 'Step one frame' },
  { chords: ['i'], label: 'Mark in' },
  { chords: ['o'], label: 'Mark out' },
  { chords: ['x'], label: 'Mark clip' },
  { chords: ['shift+v'], label: 'Select clip under playhead' },
  { chords: ['mod+arrowdown'], label: 'Select next clip' },
  { chords: ['mod+b'], label: 'Split at playhead' },
  { chords: ['q', 'w'], label: 'Ripple trim to playhead' },
  { chords: ['e'], label: 'Extend edit to playhead' },
  { chords: ['shift+delete'], label: 'Ripple delete' },
  { chords: ['shift+d'], label: 'Add default transition' },
  { chords: ['mod+z'], label: 'Undo' },
  { chords: ['mod+k'], label: 'Command palette' },
];
