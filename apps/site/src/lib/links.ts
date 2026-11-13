/**
 * Where the editor's own dev server listens (`port` in apps/editor/vite.config.ts). It serves the
 * editor from its root, so in dev the site links there instead of to `/app/` on its own origin.
 */
const EDITOR_DEV_URL = 'http://localhost:5173/';

/**
 * Where the editor app lives: `/app/` on the same origin once built, the editor's dev server in
 * dev. Set VITE_EDITOR_URL when the editor is somewhere else, such as on another dev port.
 */
export const EDITOR_URL: string =
  import.meta.env.VITE_EDITOR_URL ?? (import.meta.env.DEV ? EDITOR_DEV_URL : '/app/');

export const GITHUB_URL = 'https://github.com/michaell14/co-video';
/** `HEAD` follows the default branch, whatever it is called. */
export const LICENSE_URL = `${GITHUB_URL}/blob/HEAD/LICENSE`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
