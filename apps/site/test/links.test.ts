/**
 * The site sends its visitors to places it does not control: the editor, which is another app
 * with its own dev server and its own base path, and the repository. Where the editor is depends
 * on the editor's Vite config, which the site does not import, so this reads it and compares.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_URL, LICENSE_URL } from '../src/lib/links';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const EDITOR_CONFIG = 'apps/editor/vite.config.ts';
const LINKS = 'apps/site/src/lib/links.ts';

/** The link as a dev server (`DEV`) or a build of the site works it out, with or without the override. */
async function editorUrl(env: { DEV: boolean; VITE_EDITOR_URL?: string }): Promise<string> {
  vi.resetModules();
  vi.stubEnv('DEV', env.DEV);
  vi.stubEnv('VITE_EDITOR_URL', env.VITE_EDITOR_URL);
  return (await import('../src/lib/links')).EDITOR_URL;
}

describe('link to the editor', () => {
  const editor = readFileSync(join(root, EDITOR_CONFIG), 'utf8');
  afterEach(() => vi.unstubAllEnvs());

  it('goes to the root of the editor’s own dev server in dev', async () => {
    const port = /\bserver: \{\s*port: (\d+)/.exec(editor)?.[1];
    expect(port, `the dev port in ${EDITOR_CONFIG}`).toBeDefined();
    // Its dev server has no base path: the editor is at the root there, not under /app/.
    expect(editor).toMatch(/\bbase: command === 'build' \?[^\n]+: '\/'/);
    expect(await editorUrl({ DEV: true }), `EDITOR_DEV_URL in ${LINKS}`).toBe(`http://localhost:${port}/`);
  });

  it('can count on that port: the editor’s dev server does not move to another one', () => {
    // On a port of its own choosing the editor would be where this link does not lead, and the
    // link would open whatever holds the port instead.
    expect(editor, `strictPort in ${EDITOR_CONFIG}`).toMatch(/\bserver: \{[^}]*\bstrictPort: true\b/);
  });

  it('goes to the path the built editor is hosted under in a build', async () => {
    const base = /\bbase: command === 'build' \? \(process\.env\.TANDEM_BASE \?\? '([^']+)'\)/.exec(
      editor,
    )?.[1];
    expect(base, `the build base in ${EDITOR_CONFIG}`).toBeDefined();
    expect(await editorUrl({ DEV: false }), `the built EDITOR_URL in ${LINKS}`).toBe(base);
  });

  it('goes where VITE_EDITOR_URL says, in dev and in a build', async () => {
    expect(await editorUrl({ DEV: true, VITE_EDITOR_URL: 'http://localhost:9173/' })).toBe(
      'http://localhost:9173/',
    );
    expect(await editorUrl({ DEV: false, VITE_EDITOR_URL: 'https://edit.example/' })).toBe(
      'https://edit.example/',
    );
  });
});

describe('licence link', () => {
  it('follows the default branch to a file the repository has', () => {
    expect(LICENSE_URL).toBe(`${GITHUB_URL}/blob/HEAD/LICENSE`);
    expect(existsSync(join(root, 'LICENSE'))).toBe(true);
  });
});
