/**
 * The site sends its visitors to places it does not control: the editor, which is another app
 * with its own dev server and its own base path, and the repository. Where the editor is depends
 * on the editor's Vite config, which the site does not import, so this reads it and compares.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDITOR_URL, GITHUB_URL, LICENSE_URL } from '../src/lib/links';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('link to the editor', () => {
  const editor = read('apps/editor/vite.config.ts');
  const links = read('apps/site/src/lib/links.ts');

  // Tests run in dev mode. An override in the environment is the developer's own business.
  it.skipIf(import.meta.env.VITE_EDITOR_URL !== undefined)(
    'goes to the root of the editor’s own dev server in dev',
    () => {
      const port = /\bserver: \{\s*port: (\d+)/.exec(editor)?.[1];
      expect(port, 'the dev port in apps/editor/vite.config.ts').toBeDefined();
      expect(import.meta.env.DEV).toBe(true);
      expect(EDITOR_URL, 'EDITOR_DEV_URL in apps/site/src/lib/links.ts').toBe(`http://localhost:${port}/`);
      expect(editor).toMatch(/\bbase: command === 'build' \?[^\n]+: '\/'/);
    },
  );

  it('goes to the path the built editor is hosted under', () => {
    const base = /\bbase: command === 'build' \? \(process\.env\.TANDEM_BASE \?\? '([^']+)'\)/.exec(
      editor,
    )?.[1];
    expect(base, 'the build base in apps/editor/vite.config.ts').toBeDefined();
    expect(links, 'the built EDITOR_URL in apps/site/src/lib/links.ts').toContain(`: '${base}'`);
  });
});

describe('licence link', () => {
  it('follows the default branch to a file the repository has', () => {
    expect(LICENSE_URL).toBe(`${GITHUB_URL}/blob/HEAD/LICENSE`);
    expect(existsSync(join(root, 'LICENSE'))).toBe(true);
  });
});
