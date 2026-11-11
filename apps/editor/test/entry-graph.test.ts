/**
 * The home screen has to stay light: it must not statically import the render engine (and with it
 * the demuxers and codecs glue), which belongs to the lazily loaded editor chunk.
 *
 * This walks the static import graph from the entry point, so a stray `import { x } from
 * '@tandem/engine'` in a module the home screen reaches fails here instead of quietly tripling
 * the first download.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEAVY = ['@tandem/engine', 'mediabunny'];

function resolveLocal(from: string, spec: string): string | null {
  const base = normalize(join(dirname(from), spec));
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const file = base + ext;
    if (existsSync(file) && !file.endsWith('.css') && /\.tsx?$/.test(file)) return file;
  }
  return null;
}

/** Module specifiers a file imports at load time (type-only imports and `import()` excluded). */
function staticImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)([^'"]*?from\s+)?['"]([^'"]+)['"]/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const clause = m[1] ?? '';
    const named = /\{([^}]*)\}/.exec(clause);
    const hasDefault = /^\s*[\w$]+\s*(,|from)/.test(clause) || /\*\s+as\s+/.test(clause);
    const names = named
      ? named[1]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [];
    if (named && !hasDefault && names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    out.push(m[2]);
  }
  return out;
}

function heavyChains(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      if (HEAVY.includes(spec))
        found.push([...chain, file, spec].map((f) => f.replace(root + '/', '')).join(' → '));
      else if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        if (next) walk(next, [...chain, file]);
      }
    }
  };
  walk(entry, []);
  return found;
}

describe('entry bundle', () => {
  it('does not statically pull the engine into the home screen', () => {
    expect(heavyChains(join(root, 'src/main.tsx'))).toEqual([]);
  });

  it('the check itself can see a heavy import', () => {
    // The editor is allowed to (and does) import the engine; if this finds nothing, the walker is broken.
    expect(heavyChains(join(root, 'src/features/editor/Editor.tsx')).length).toBeGreaterThan(0);
  });
});
