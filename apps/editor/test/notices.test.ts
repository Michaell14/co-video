import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THIRD_PARTY_NOTICES.txt is written by hand, and what it has to name changes whenever a
 * dependency is added: every package that ends up in the editor, the website or the server,
 * followed through its own dependencies, with the licence its `package.json` declares.
 */
const APPS = join(dirname(fileURLToPath(import.meta.url)), '../..');
const NOTICES = readFileSync(join(APPS, 'editor/public/THIRD_PARTY_NOTICES.txt'), 'utf8');

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

/** Name → licence of everything `app` is built from. Type declarations are not part of a build. */
function shipped(app: string): Map<string, string> {
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
  const root = join(APPS, app);
  for (const dep of Object.keys(manifest(root).dependencies ?? {})) walk(root, dep);
  return found;
}

describe('third-party notices', () => {
  for (const app of ['editor', 'site', 'server']) {
    it(`name everything the ${app} is built from, with its licence`, () => {
      const missing = [...shipped(app)]
        .map(([name, licence]) => `${name} (${licence})`)
        .filter((entry) => !NOTICES.includes(entry));
      expect(missing).toEqual([]);
    });
  }

  it('carry the text of every licence they name', () => {
    const list = NOTICES.slice(0, NOTICES.indexOf('SIL OPEN FONT LICENSE, Version 1.1'));
    const named = new Set([...list.matchAll(/^\S.* \(([A-Za-z0-9.-]+)\)(?:, in: .*)?$/gm)].map((m) => m[1]));
    expect([...named].sort()).toEqual(['0BSD', 'Apache-2.0', 'ISC', 'MIT', 'MPL-2.0', 'OFL-1.1']);
    for (const text of [
      'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007',
      'Apache License\n                           Version 2.0, January 2004',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'Permission to use, copy, modify, and/or distribute this software for any',
      'Mozilla Public License Version 2.0',
    ]) {
      expect(NOTICES).toContain(text);
    }
  });
});
