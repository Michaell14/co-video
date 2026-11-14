import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * macOS and Windows keep one name for `LostClips` and `lostClips`; Linux, where the checks run,
 * keeps two. An import of `./LostClips` is tried with one ending after another, so beside
 * `LostClips.tsx` a file `lostClips.ts` is found first on those systems and the build fails there
 * alone. No two names in a folder may therefore be told apart by the case of their letters only.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKIPPED = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report']);
/** The endings an import may leave out. */
const MODULE = /\.(mjs|cjs|js|mts|cts|ts|jsx|tsx|json)$/;

function folders(dir: string, found: string[] = []): string[] {
  found.push(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) folders(join(dir, entry.name), found);
  }
  return found;
}

/** Names in one folder that are the same once `key` has been taken of them, but are not the same. */
function clashes(key: (name: string) => string | null): string[] {
  const found: string[] = [];
  for (const dir of folders(ROOT)) {
    const seen = new Map<string, string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const mine = key(entry.name);
      if (mine === null) continue;
      const other = seen.get(mine.toLowerCase());
      if (other === undefined) seen.set(mine.toLowerCase(), mine);
      else if (other !== mine) found.push(`${relative(ROOT, dir)}: ${other} and ${mine}`);
    }
  }
  return found;
}

describe('file names', () => {
  it('no two entries of a folder differ by the case of their letters only', () => {
    expect(clashes((name) => name)).toEqual([]);
  });

  it('no two modules of a folder differ by case once their endings are left out', () => {
    expect(clashes((name) => (MODULE.test(name) ? name.replace(MODULE, '') : null))).toEqual([]);
  });
});
