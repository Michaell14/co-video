/** Where the editor app lives. Same origin in production; override with VITE_EDITOR_URL in dev. */
export const EDITOR_URL: string = import.meta.env.VITE_EDITOR_URL ?? '/app/';

export const GITHUB_URL = 'https://github.com/michaell14/co-video';
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;
