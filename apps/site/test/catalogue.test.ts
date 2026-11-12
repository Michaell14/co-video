/**
 * The effects section names every effect in the editor and counts effects and transitions in its
 * copy. The site does not depend on the editor's packages, so nothing but this keeps those in step
 * with the catalogue itself: it reads both sources and compares.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** The `name` of every entry of the exported list `list` in a catalogue source file. */
function catalogueNames(path: string, list: string): string[] {
  const source = read(path);
  const start = source.indexOf(`export const ${list}`);
  if (start < 0) throw new Error(`${path} does not export ${list}`);
  const end = source.indexOf('\n];', start);
  return [...source.slice(start, end).matchAll(/^ {4}name: '([^']+)',$/gm)].map((match) => match[1]);
}

describe('effects section', () => {
  const section = read('apps/site/src/sections/Effects.tsx');
  const effects = catalogueNames('packages/core/src/effects.ts', 'EFFECTS');
  const transitions = catalogueNames('packages/core/src/transitions.ts', 'TRANSITIONS');

  it('finds the catalogue', () => {
    expect(effects.length).toBeGreaterThan(20);
    expect(transitions.length).toBeGreaterThan(10);
    expect(new Set(effects).size).toBe(effects.length);
  });

  it('lists every effect in the ticker under the name the editor shows', () => {
    const ticker = /const CATALOGUE = \[([^\]]+)\]/.exec(section)?.[1] ?? '';
    const listed = [...ticker.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(listed).toEqual(effects);
  });

  it('names its tiles and transitions as the editor does', () => {
    const tiles = /const TILES[^=]*= \[(.+?)\n\];/s.exec(section)?.[1] ?? '';
    const tileNames = [...tiles.matchAll(/name: '([^']+)'/g)].map((match) => match[1]);
    expect(tileNames.length).toBeGreaterThan(0);
    for (const name of tileNames) expect(effects).toContain(name);

    const shown = /const TRANSITIONS = \[(.+?)\n\];/s.exec(section)?.[1] ?? '';
    const shownNames = [...shown.matchAll(/name: '([^']+)'/g)].map((match) => match[1]);
    expect(shownNames.length).toBeGreaterThan(0);
    for (const name of shownNames) expect(transitions).toContain(name);
  });

  it('counts what there is', () => {
    expect(section).toContain(`${effects.length} effects.`);
    expect(section).toContain(`${transitions.length} transitions`);
  });
});
