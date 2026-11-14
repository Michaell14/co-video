/**
 * A build of the site hands out typefaces and has libraries compiled into its scripts, and their
 * licences ask that their notices travel with them. `public/THIRD_PARTY_NOTICES.txt` is that: it
 * is copied into every build and the footer links to it, so a site hosted without the editor
 * still carries it. It is the site's own list, not the editor's longer one, and it is written by
 * hand: this compares it with what the site is built from, which is `package.json` followed
 * through the dependencies of each package.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NOTICES_URL } from '../src/lib/links';
import { Footer } from '../src/sections/Footer';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'THIRD_PARTY_NOTICES.txt';
const NOTICES = readFileSync(join(SITE, 'public', FILE), 'utf8');
/** The part that names the packages; the texts of the licences follow it. */
const LIST = NOTICES.slice(0, NOTICES.indexOf('SIL OPEN FONT LICENSE, Version 1.1'));

interface Manifest {
  license?: string;
  dependencies?: Record<string, string>;
}

const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

function locate(from: string, name: string): string {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  throw new Error(`${name} is not installed (looked from ${from})`);
}

/** Name → licence of everything the site is built from. Type declarations are not part of a build. */
function shipped(): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const walk = (from: string, name: string): void => {
    if (name.startsWith('@types/') || seen.has(name)) return;
    seen.add(name);
    const dir = locate(from, name);
    const pkg = manifest(dir);
    // The project's own packages are followed, not listed.
    if (!name.startsWith('@tandem/')) found.set(name, pkg.license ?? 'no licence declared');
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dir, dep);
  };
  for (const dep of Object.keys(manifest(SITE).dependencies ?? {})) walk(SITE, dep);
  return found;
}

describe('third-party notices of the site', () => {
  /** The entries of the list: a library by its package name, a typeface by its family and its package. */
  const listed = [...LIST.matchAll(/^(?:[^:\n]+: )?(\S+) \(([A-Za-z0-9.-]+)\)$/gm)].map(
    (entry) => `${entry[1]} (${entry[2]})`,
  );

  it('name what the site is built from, with its licence, and nothing the site does not ship', () => {
    const built = [...shipped()].map(([name, licence]) => `${name} (${licence})`);
    expect(built.length).toBeGreaterThan(0);
    expect(listed.sort(), `the list in apps/site/public/${FILE}`).toEqual(built.sort());
  });

  it('carry the text of every licence they name', () => {
    /** A sentence only the text of that licence has. */
    const texts: Record<string, string> = {
      '0BSD': 'purpose with or without fee is hereby granted.\n',
      ISC: 'purpose with or without fee is hereby granted, provided that the above\ncopyright notice',
      MIT: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'OFL-1.1': 'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007',
    };
    const named = new Set(listed.map((entry) => /\(([^)]+)\)$/.exec(entry)![1]));
    expect([...named].sort()).toEqual(Object.keys(texts).sort());
    for (const licence of named) expect(NOTICES, `the text of ${licence}`).toContain(texts[licence]);
  });

  it('are linked from the footer, at the place a build of the site puts the file', () => {
    // Files in `public/` are copied to the root of the build as they are.
    expect(NOTICES_URL).toBe(`/${FILE}`);
    const footer = renderToStaticMarkup(createElement(Footer));
    expect(footer).toContain(`<a class="link" href="${NOTICES_URL}">Third-party notices</a>`);
  });
});
