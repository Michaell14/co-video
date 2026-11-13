/**
 * The timeline section shows a strip of keyboard shortcuts. The site does not depend on the
 * editor's packages, so nothing but this keeps the strip true: it reads the editor's command
 * catalogue and holds every key and label of the strip (src/lib/shortcuts.ts) to it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAMED_KEYS, SHORTCUTS } from '../src/lib/shortcuts';

const CATALOGUE = 'apps/editor/src/state/shortcuts.ts';
const STRIP = 'apps/site/src/lib/shortcuts.ts';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The title of the command behind every chord the editor binds. */
function editorShortcuts(): Map<string, string> {
  const source = readFileSync(join(root, CATALOGUE), 'utf8');
  const start = source.indexOf('export const COMMANDS');
  if (start < 0) throw new Error(`${CATALOGUE} does not export COMMANDS`);
  const bound = new Map<string, string>();
  for (const entry of source
    .slice(start, source.indexOf('\n];', start))
    .split(/\bid: '/)
    .slice(1)) {
    const title = /\btitle: (?:'([^']*)'|"([^"]*)")/.exec(entry);
    const keys = /\bkeys: \[([^\]]*)\]/.exec(entry)?.[1] ?? '';
    if (!title)
      throw new Error(`${CATALOGUE}: no title on the command '${entry.slice(0, entry.indexOf("'"))}`);
    for (const chord of keys.matchAll(/'([^']+)'/g)) bound.set(chord[1], title[1] ?? title[2]);
  }
  return bound;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

describe('shortcut strip of the timeline section', () => {
  const bound = editorShortcuts();

  it('finds the editor’s catalogue', () => {
    expect(bound.size).toBeGreaterThan(100);
    expect(bound.get('space')).toBe('Play / Pause');
  });

  it('only shows keys the editor binds', () => {
    for (const shortcut of SHORTCUTS) {
      for (const chord of shortcut.chords) {
        expect(bound.has(chord), `${STRIP} shows '${chord}', which ${CATALOGUE} does not bind`).toBe(true);
      }
    }
  });

  it('labels a chord with the title of its command', () => {
    for (const shortcut of SHORTCUTS.filter((s) => s.chords.length === 1)) {
      const [chord] = shortcut.chords;
      expect(shortcut.label, `label of '${chord}' in ${STRIP}; the title is in ${CATALOGUE}`).toBe(
        bound.get(chord),
      );
    }
  });

  // Several keys under one label (J K L) have no single title to copy. Their label may at least
  // only use words that the titles of their commands use.
  it('labels a group of keys in the words of their commands', () => {
    for (const shortcut of SHORTCUTS.filter((s) => s.chords.length > 1)) {
      const titles = shortcut.chords.map((chord) => bound.get(chord) ?? '');
      const known = new Set(titles.flatMap(words));
      for (const word of words(shortcut.label)) {
        expect(
          known.has(word),
          `'${word}' in the label '${shortcut.label}' (${STRIP}) is in none of: ${titles.join(', ')}`,
        ).toBe(true);
      }
    }
  });

  it('can draw every key it names', () => {
    const named: readonly string[] = NAMED_KEYS;
    for (const key of SHORTCUTS.flatMap((s) => s.chords).flatMap((chord) => chord.split('+'))) {
      expect(key.length === 1 || named.includes(key), `'${key}' is not in NAMED_KEYS of ${STRIP}`).toBe(true);
    }
  });

  it('names each job once', () => {
    const labels = SHORTCUTS.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
