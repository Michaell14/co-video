/**
 * The effects section names every effect in the editor, counts them in its heading and counts the
 * transitions in its copy. The site does not depend on the editor's packages, so nothing but this
 * keeps those in step with the catalogue itself: it reads both sources and compares. Whoever adds
 * an effect or a transition meets this test first, so each failure says what to edit.
 *
 * The feature list of README.md gives the same two counts by hand, and is held to them here too.
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

const SECTION = 'apps/site/src/sections/Effects.tsx';
const effects = catalogueNames('packages/core/src/effects.ts', 'EFFECTS');
const transitions = catalogueNames('packages/core/src/transitions.ts', 'TRANSITIONS');

describe('effects section', () => {
  const section = read(SECTION);

  it('finds the catalogue', () => {
    expect(effects.length).toBeGreaterThan(20);
    expect(transitions.length).toBeGreaterThan(10);
    expect(new Set(effects).size).toBe(effects.length);
  });

  it('lists every effect in the ticker under the name the editor shows', () => {
    const ticker = /const CATALOGUE = \[([^\]]+)\]/.exec(section)?.[1] ?? '';
    const listed = [...ticker.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(
      listed,
      `CATALOGUE in ${SECTION} has to name the entries of EFFECTS in packages/core/src/effects.ts, in the same order`,
    ).toEqual(effects);
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
    expect(section, `the heading in ${SECTION} counts the effects from its own list`).toContain(
      '{CATALOGUE.length} effects.',
    );
    expect(
      section,
      `packages/core/src/transitions.ts has ${transitions.length} transitions; ${SECTION} has to say so`,
    ).toContain(`>${transitions.length} transitions<`);
  });
});

describe('README', () => {
  const features = read('README.md');

  it('counts the effects and the transitions there are', () => {
    expect(
      features,
      `packages/core/src/effects.ts has ${effects.length} effects; the feature list in README.md has to say so`,
    ).toContain(`- **${effects.length} GPU effects**`);
    expect(
      features,
      `packages/core/src/transitions.ts has ${transitions.length} transitions; the feature list in README.md has to say so`,
    ).toContain(`- **${transitions.length} transitions**`);
  });
});
