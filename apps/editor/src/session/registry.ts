/** The list of projects this browser knows about, plus the local user's identity. */
import { colorForId, newId, randomUserName, type PresenceUser, type Role } from '@tandem/core';
import { claimedRole, isRole, outranks } from './access';
import { readUser } from './presence';

export interface ProjectEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Capability token for the collaboration server, if the project is shared. */
  token: string | null;
  /** What `token` allows, as the server last confirmed it. Absent in entries from before it was kept. */
  role?: Role;
  /** Poster frame, small data URL. */
  thumb: string | null;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

/**
 * A link the server refused. It is not offered again by itself, and it is not thrown away either:
 * a server can be wrong for a while (started without its data, reached through the wrong proxy),
 * and an owner link cannot be issued a second time.
 */
export interface LinkAside {
  token: string;
  role: Role;
  refusedAt: number;
}

const KEY = 'tandem.projects.v1';
const ASIDE_KEY = 'tandem.links-aside.v1';
const USER_KEY = 'tandem.user.v1';
/** A name is a label on a card. One of any length from a shared document would fill the storage. */
export const MAX_ENTRY_NAME = 200;
/** A poster is a thumbnail of a few kilobytes; anything much larger is not one. */
export const MAX_ENTRY_THUMB = 64 * 1024;

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: ProjectEntry[] | null = null;
let asideCache: Map<string, LinkAside> | null = null;
/** Whether storage holds the list as this tab knows it. */
let saved = true;
let onUnsaved: () => void = () => {};

const isEntry = (v: unknown): v is ProjectEntry =>
  typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string';

function read(): ProjectEntry[] {
  if (cache) return cache;
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    cache = Array.isArray(list) ? list.filter(isEntry) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function put(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the list. When storage has no room for it, it is kept without its posters, which is what
 * takes the room and which the next visit to a project makes again. When even that fails the list
 * lives on in this tab only, and that is said: `link` marks a write that adds a link, which is
 * never allowed to go missing unnoticed.
 */
function write(list: ProjectEntry[], link = false): void {
  cache = list;
  const kept =
    put(KEY, list) ||
    put(
      KEY,
      list.map((p) => ({ ...p, thumb: null })),
    );
  const tell = !kept && (saved || link);
  saved = kept;
  for (const fn of Array.from(listeners)) fn();
  if (tell) onUnsaved();
}

function readAside(): Map<string, LinkAside> {
  if (asideCache) return asideCache;
  asideCache = new Map();
  try {
    const all: unknown = JSON.parse(localStorage.getItem(ASIDE_KEY) ?? '{}');
    if (typeof all === 'object' && all !== null && !Array.isArray(all)) {
      for (const [id, link] of Object.entries(all as Record<string, Partial<LinkAside> | null>)) {
        if (typeof link?.token !== 'string' || !link.token) continue;
        const role = isRole(link.role) ? link.role : (claimedRole(link.token) ?? 'viewer');
        asideCache.set(id, { token: link.token, role, refusedAt: Number(link.refusedAt) || 0 });
      }
    }
  } catch {
    /* nothing readable was kept */
  }
  return asideCache;
}

function writeAside(all: Map<string, LinkAside>): boolean {
  if (!put(ASIDE_KEY, Object.fromEntries(all))) return false;
  asideCache = all;
  return true;
}

/** Whether a thumbnail from a project is one the list can carry as a card's poster. */
export const isPoster = (thumb: unknown): thumb is string =>
  typeof thumb === 'string' && thumb.startsWith('data:image/') && thumb.length <= MAX_ENTRY_THUMB;

/** The first `max` characters of a label, never ending on half of one. */
function clip(label: unknown, max: number): string {
  const text = String(label).slice(0, max);
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
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
    // Both come from the project document, which anyone with edit access writes.
    next.name = clip(next.name, MAX_ENTRY_NAME);
    next.thumb = isPoster(next.thumb) ? next.thumb : null;
    if (i >= 0) list[i] = next;
    else list.push(next);
    write(list, !!entry.token && entry.token !== base.token);
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
  /**
   * False while the list could not be written to this browser's storage: what was added or changed
   * since then is known to this tab only, and is gone when it closes. Subscribers hear of a change.
   */
  saved: (): boolean => saved,
  /** Have `fn` called when the list stops being saved, and each time a new link fails to be. */
  whenUnsaved(fn: () => void): void {
    onUnsaved = fn;
  },

  /** The link the server refused for a project, if one is kept for it. */
  linkAside: (id: string): LinkAside | null => readAside().get(id) ?? null,
  /**
   * Take a project's link out of its entry and keep it aside: the project is a local one from now
   * on, and the link waits to be tried again. Returns false, and leaves the entry as it is, when
   * the link could not be stored aside; it is never dropped to make an entry look right.
   */
  setLinkAside(id: string): boolean {
    const entry = registry.get(id);
    if (!entry?.token) return registry.linkAside(id) !== null;
    const role = entry.role ?? claimedRole(entry.token) ?? 'viewer';
    const before = registry.linkAside(id);
    // Of two refused links, the one that allows more is the one worth trying again.
    if (!before || !outranks(before.role, role)) {
      const link: LinkAside = { token: entry.token, role, refusedAt: Date.now() };
      if (!writeAside(new Map(readAside()).set(id, link))) return false;
    }
    registry.upsert({ id, token: null, role: undefined });
    return true;
  },
  /**
   * The way back: the server takes the link again and the project's entry carries one once more,
   * so the copy kept aside has done its work. It goes only once that entry is in storage. While
   * the list cannot be saved the entry's link lives in this tab alone, and the copy aside is all
   * that would be left of it on the device after a reload.
   */
  releaseLinkAside(id: string): void {
    if (saved && registry.get(id)?.token) registry.dropLinkAside(id);
  },
  /** Forget the link kept aside for a project, kept elsewhere or not: the person let go of it. */
  dropLinkAside(id: string): void {
    if (!readAside().has(id)) return;
    const rest = new Map(readAside());
    rest.delete(id);
    writeAside(rest);
  },
};

if (typeof window !== 'undefined') {
  // Keep tabs in step with each other.
  window.addEventListener('storage', (e) => {
    if (e.key === ASIDE_KEY) asideCache = null;
    if (e.key !== KEY) return;
    // What this tab could not save is in no other tab's list: it must not go with the old cache.
    const unsaved = saved ? [] : (cache ?? []);
    cache = null;
    const mine = unsaved.filter((p) => !registry.get(p.id));
    if (mine.length) write([...read(), ...mine]);
    else for (const fn of Array.from(listeners)) fn();
  });
}

export function getUser(): PresenceUser {
  try {
    const raw = localStorage.getItem(USER_KEY);
    // Read like anyone else's: the name and colour are drawn the same way.
    const user = raw ? readUser(JSON.parse(raw)) : null;
    if (user) return user;
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
