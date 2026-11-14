/** Thin client for the collaboration server's HTTP API (see @tandem/core protocol.ts). */
import type { ProjectInfo, Role, VersionInfo } from '@tandem/core';

const ENV_URL = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '');

/** Base URL of the collaboration server ('' = same origin). */
export function serverBase(): string {
  return ENV_URL ?? '';
}

export function wsBase(): string {
  const base = serverBase();
  if (base) return base.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

let health: Promise<boolean> | null = null;

/** Is a collaboration server reachable? Cached; `force` re-checks. */
export function serverAvailable(force = false): Promise<boolean> {
  if (!health || force) {
    health = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(`${serverBase()}/api/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return false;
        const body = await res.json().catch(() => null);
        return body?.ok === true;
      } catch {
        return false;
      }
    })();
  }
  return health;
}

/** The server answered, and the answer was no. (A network failure is a plain `TypeError`.) */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The answer was in the collaboration server's own words (`{ "error": … }`). An error page
     * that a proxy or a gateway in between made up carries the same kind of status, and says
     * nothing about what the server thinks of a link.
     */
    readonly answered: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A response that will be the same however often the request is repeated: the server understood
 * and said no. Timeouts and rate limits are not that, and neither is anything it failed at itself.
 */
export const isRefusal = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * The server's answer to a project that its owner deleted, to whoever still holds a link to it.
 * Unlike any other refusal this one is for good: the project does not come back under its id.
 */
export const isDeleted = (err: unknown): boolean =>
  err instanceof ApiError && err.answered && err.status === 410;

/** Ask the server; an answer that is not a yes is thrown as an `ApiError`. */
async function send(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${serverBase()}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : null),
      ...(token ? { Authorization: `Bearer ${token}` } : null),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const said = typeof body?.error === 'string' ? body.error : null;
    throw new ApiError(said ?? `Request failed (${res.status})`, res.status, said !== null);
  }
  return res;
}

async function call<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  return (await (await send(path, token, init)).json()) as T;
}

export const api = {
  createProject: (name: string) =>
    call<{ id: string; token: string }>('/api/projects', null, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  projectInfo: (id: string, token: string, signal?: AbortSignal) =>
    call<ProjectInfo>(`/api/projects/${id}`, token, { signal }),
  /**
   * Delete a project from the server, for everyone: the owner's link is the only one that may.
   * Asked a second time, the server answers as it did the first.
   */
  async deleteProject(id: string, token: string, signal?: AbortSignal): Promise<void> {
    await send(`/api/projects/${id}`, token, { method: 'DELETE', signal });
  },
  invite: (id: string, token: string, role: Role) =>
    call<{ token: string }>(`/api/projects/${id}/invites`, token, {
      method: 'POST',
      body: JSON.stringify({ role }),
    }),
  versions: (id: string, token: string) => call<VersionInfo[]>(`/api/projects/${id}/versions`, token),
  saveVersion: (id: string, token: string, name: string, author: string) =>
    call<VersionInfo>(`/api/projects/${id}/versions`, token, {
      method: 'POST',
      body: JSON.stringify({ name, author }),
    }),
  async versionData(id: string, token: string, versionId: string): Promise<Uint8Array> {
    const res = await fetch(`${serverBase()}/api/projects/${id}/versions/${versionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Could not load version (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
  /** Delete a version. One that is already gone is deleted all the same. */
  async deleteVersion(id: string, token: string, versionId: string): Promise<void> {
    await send(`/api/projects/${id}/versions/${versionId}`, token, { method: 'DELETE' });
  },
  mediaUrl: (id: string, assetId: string, token: string) =>
    `${serverBase()}/api/projects/${id}/media/${assetId}?t=${encodeURIComponent(token)}`,
};
