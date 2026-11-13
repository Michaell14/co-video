/**
 * Presence as this client reads it and as it publishes it.
 *
 * What a participant announces is passed on by the server to everyone in the project, whatever
 * their role, and nobody vouches for its shape. So nothing of it is taken at its word:
 * `readPresence` makes a fully typed state out of whatever arrived, field by field, the way the
 * stores read the shared documents, and everything that draws a collaborator goes through it. A
 * field it cannot make sense of falls back to a harmless value; an entry without a usable identity
 * is nobody.
 */
import {
  colorForId,
  hexColor,
  type PresenceCursor,
  type PresenceState,
  type PresenceUser,
  type Role,
} from '@tandem/core';
import type { Workspace } from '../state/ui';
import { isRole } from './access';

export interface RemotePeer extends PresenceState {
  clientId: number;
}

/** What the list of peers needs of the room's awareness instance. */
interface Room {
  readonly clientID: number;
  getStates(): Map<number, unknown>;
  on(name: 'change', fn: (changes: unknown, origin: unknown) => void): void;
  off(name: 'change', fn: (changes: unknown, origin: unknown) => void): void;
}

/** As many people as a room has places for by default; more than that are not drawn. */
export const MAX_PEERS = 100;
/** Selected clips a state lists. Peers draw an outline for each, so the first hundred say enough. */
export const MAX_SELECTION = 100;
/** Dragged clips a state lists: one ghost each on every peer's timeline, several times a second. */
export const MAX_DRAGGING = 50;
/** A display name is a label on a cursor and a tooltip on an avatar. */
export const MAX_NAME = 60;

/** Longer than any id the editor makes; anything beyond it is not an id. */
const MAX_ID = 64;
/** The frame bound the project's own readers use. */
const MAX_FRAME = 100_000_000;
const UNNAMED = 'Guest';
const PAGES: Record<Workspace, true> = { edit: true, color: true, audio: true };

type Json = Record<string, unknown>;
type Drag = NonNullable<PresenceState['dragging']>[number];

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const frame = (v: number): number => Math.min(Math.max(v, 0), MAX_FRAME);
const unit = (v: number): number => Math.min(Math.max(v, 0), 1);

/** A display name: one line of bounded length, or the stand-in when there is none to show. */
export function displayName(v: unknown): string {
  if (typeof v !== 'string') return UNNAMED;
  // Cut first: the pattern must not be run over megabytes that are thrown away anyway.
  const name = v
    .slice(0, 4 * MAX_NAME)
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(name).slice(0, MAX_NAME).join('') || UNNAMED;
}

/** Who a state, or this browser's stored profile, says it is. Null without an id to tell people apart by. */
export function readUser(v: unknown): PresenceUser | null {
  if (!isObj(v) || !isId(v.id)) return null;
  // A colour ends up in style attributes, where any other string would be acted on by the browser.
  return { id: v.id, name: displayName(v.name), color: hexColor(v.color) ?? colorForId(v.id) };
}

function readCursor(v: unknown): PresenceCursor | null {
  if (!isObj(v) || !isNum(v.x)) return null;
  if (v.area === 'viewer') return isNum(v.y) ? { area: 'viewer', x: unit(v.x), y: unit(v.y) } : null;
  if (v.area === 'timeline') return isId(v.y) ? { area: 'timeline', x: frame(v.x), y: v.y } : null;
  return null;
}

function readDrag(v: unknown): Drag | null {
  if (!isObj(v) || !isId(v.id) || !isId(v.trackId) || !isNum(v.start) || !isNum(v.duration)) return null;
  return { id: v.id, trackId: v.trackId, start: frame(v.start), duration: frame(v.duration) };
}

/** The first `max` entries of a list that `read` can make something of. Anything else is no list. */
function readList<T>(v: unknown, max: number, read: (item: unknown) => T | null): T[] {
  const out: T[] = [];
  if (!Array.isArray(v)) return out;
  // A long list is cut, not refused: selecting everything in a large project is an honest one.
  for (let i = 0; i < v.length && out.length < max; i++) {
    const item = read(v[i]);
    if (item !== null) out.push(item);
  }
  return out;
}

/** The presence state in `raw`, or null when it does not say who it is about. */
export function readPresence(raw: unknown): PresenceState | null {
  if (!isObj(raw)) return null;
  const user = readUser(raw.user);
  if (!user) return null;
  const role: Role = isRole(raw.role) ? raw.role : 'viewer';
  return {
    user,
    role,
    // Following someone seeks to their playhead, so it has to be a frame.
    playhead: isNum(raw.playhead) ? frame(raw.playhead) : 0,
    playing: raw.playing === true,
    selection: readList(raw.selection, MAX_SELECTION, (id) => (isId(id) ? id : null)),
    cursor: readCursor(raw.cursor),
    dragging: raw.dragging == null ? null : readList(raw.dragging, MAX_DRAGGING, readDrag),
    page: typeof raw.page === 'string' && Object.hasOwn(PAGES, raw.page) ? raw.page : 'edit',
  };
}

/**
 * Everyone else in the room, in a stable order. `self` is this client's own entry, which is never
 * read back from the room: what this client shows of itself is what it set. `seen` remembers what
 * was made of a state, so that one person's moving pointer does not have everyone read again.
 */
export function readPeers(
  states: ReadonlyMap<number, unknown>,
  self: number,
  seen: WeakMap<object, RemotePeer | null> = new WeakMap(),
): RemotePeer[] {
  const out: RemotePeer[] = [];
  for (const clientId of Array.from(states.keys()).sort((a, b) => a - b)) {
    if (clientId === self) continue;
    const raw = states.get(clientId);
    if (!isObj(raw)) continue;
    let peer = seen.get(raw);
    if (peer === undefined) {
      const state = readPresence(raw);
      peer = state && { ...state, clientId };
      seen.set(raw, peer);
    }
    if (!peer) continue;
    out.push(peer);
    if (out.length === MAX_PEERS) break;
  }
  return out;
}

/**
 * The other people in the room, read once per change for everything that draws them. This
 * client's own cursor and playhead change many times a second and are not in the list, so they do
 * not disturb it.
 */
export class PeerList {
  private list: RemotePeer[] | null = null;
  private readonly seen = new WeakMap<object, RemotePeer | null>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly room: Room) {
    room.on('change', this.onChange);
  }

  get = (): RemotePeer[] => (this.list ??= readPeers(this.room.getStates(), this.room.clientID, this.seen));

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  destroy(): void {
    this.room.off('change', this.onChange);
    this.listeners.clear();
  }

  private readonly onChange = (_changes: unknown, origin: unknown): void => {
    // Awareness names this client's own changes so.
    if (origin === 'local') return;
    this.list = null;
    for (const fn of Array.from(this.listeners)) fn();
  };
}

/**
 * The state as it goes out. The whole state is sent again with every change, a moving pointer or
 * playhead included, so the lists in it stay short: peers only draw outlines and ghosts from them.
 */
export function published(state: PresenceState): PresenceState {
  const { selection, dragging } = state;
  if (selection.length <= MAX_SELECTION && (dragging?.length ?? 0) <= MAX_DRAGGING) return state;
  return {
    ...state,
    selection: selection.slice(0, MAX_SELECTION),
    dragging: dragging && dragging.slice(0, MAX_DRAGGING),
  };
}
