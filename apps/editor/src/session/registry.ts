/** The list of projects this browser knows about, plus the local user's identity. */
import { colorForId, newId, randomUserName, type PresenceUser } from '@tandem/core';

export interface ProjectEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Capability token for the collaboration server, if the project is shared. */
  token: string | null;
  /** Poster frame, small data URL. */
  thumb: string | null;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

const KEY = 'tandem.projects.v1';
const USER_KEY = 'tandem.user.v1';

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: ProjectEntry[] | null = null;

function read(): ProjectEntry[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as ProjectEntry[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: ProjectEntry[]): void {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or disabled: keep working in memory */
  }
  for (const fn of Array.from(listeners)) fn();
}

export const registry = {
  list: (): ProjectEntry[] =>
    read()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt),
  get: (id: string): ProjectEntry | undefined => read().find((p) => p.id === id),
  upsert(entry: Partial<ProjectEntry> & { id: string }): ProjectEntry {
    const list = read().slice();
    const i = list.findIndex((p) => p.id === entry.id);
    const now = Date.now();
    const base: ProjectEntry =
      i >= 0
        ? list[i]
        : {
            id: entry.id,
            name: 'Untitled project',
            createdAt: now,
            updatedAt: now,
            token: null,
            thumb: null,
            width: 1920,
            height: 1080,
            fps: 30,
            duration: 0,
          };
    const next = { ...base, ...entry };
    if (i >= 0) list[i] = next;
    else list.push(next);
    write(list);
    return next;
  },
  remove(id: string): void {
    write(read().filter((p) => p.id !== id));
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  snapshot: (): ProjectEntry[] => read(),
};

if (typeof window !== 'undefined') {
  // Keep tabs in step with each other.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      cache = null;
      for (const fn of Array.from(listeners)) fn();
    }
  });
}

export function getUser(): PresenceUser {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) {
      const u = JSON.parse(raw) as PresenceUser;
      if (u?.id && u.name) return u;
    }
  } catch {
    /* fall through */
  }
  const id = newId(10);
  const user = { id, name: randomUserName(), color: colorForId(id) };
  setUser(user);
  return user;
}

export function setUser(user: PresenceUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}
