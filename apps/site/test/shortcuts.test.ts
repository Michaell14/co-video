/**
 * The timeline section shows a strip of keyboard shortcuts. The site is not built from the
 * editor's packages, so the strip's list (src/lib/shortcuts.ts) is a copy and nothing but this
 * keeps it true: every key and label is held to the editor's command catalogue, the list its own
 * shortcut sheet is drawn from.
 */
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../editor/src/state/shortcuts';
import { NAMED_KEYS, SHORTCUTS } from '../src/lib/shortcuts';

const CATALOGUE = 'apps/editor/src/state/shortcuts.ts';
const STRIP = 'apps/site/src/lib/shortcuts.ts';

/** The title of the command behind every chord the editor binds. */
const bound = new Map(
  COMMANDS.flatMap((command) => (command.keys ?? []).map((chord) => [chord, command.title] as const)),
);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

const single = SHORTCUTS.filter((shortcut) => shortcut.chords.length === 1);
const groups = SHORTCUTS.filter((shortcut) => shortcut.chords.length > 1);

describe('shortcut strip of the timeline section', () => {
  it('only shows keys the editor binds', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const chord of SHORTCUTS.flatMap((shortcut) => shortcut.chords)) {
      expect(bound.has(chord), `${STRIP} shows '${chord}', which ${CATALOGUE} does not bind`).toBe(true);
    }
  });

  it('labels a chord with the title of its command', () => {
    for (const { chords, label } of single) {
      expect(label, `label of '${chords[0]}' in ${STRIP}; the title is in ${CATALOGUE}`).toBe(
        bound.get(chords[0]),
      );
    }
  });

  // Several keys under one label (J K L) have no single title to copy. Their label may at least
  // only use words that the titles of their commands use.
  it('labels a group of keys in the words of their commands', () => {
    for (const { chords, label } of groups) {
      const titles = chords.map((chord) => bound.get(chord) ?? '');
      const known = new Set(titles.flatMap(words));
      for (const word of words(label)) {
        expect(
          known.has(word),
          `'${word}' in the label '${label}' (${STRIP}) is in none of: ${titles.join(', ')}`,
        ).toBe(true);
      }
    }
  });

  // The strip sets the keys of an entry side by side, so `mod+a` next to `mod+b` would read as
  // one chord of four keys.
  it('groups plain keys only', () => {
    for (const { chords, label } of groups) {
      for (const chord of chords) {
        expect(chord, `'${label}' in ${STRIP} groups a chord with a modifier`).not.toContain('+');
      }
    }
  });

  it('can draw every key it names', () => {
    const named: readonly string[] = NAMED_KEYS;
    for (const key of SHORTCUTS.flatMap((shortcut) => shortcut.chords).flatMap((chord) => chord.split('+'))) {
      expect(key.length === 1 || named.includes(key), `'${key}' is not in NAMED_KEYS of ${STRIP}`).toBe(true);
    }
  });

  it('names each job once', () => {
    const labels = SHORTCUTS.map((shortcut) => shortcut.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
