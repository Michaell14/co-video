/**
 * Presence of one room: who is here and what each of them shows (name, cursor, selection).
 *
 * The wire format is y-protocols awareness: an update lists (client id, clock, JSON state) and
 * says `null` for "gone". Between peers every client may speak about every id. With a server in
 * the middle that is neither needed nor safe, because the server stores what it is told, sends
 * it to every member and hands it to every newcomer. So the room takes from a connection only
 * what is its own to say:
 *
 *   - A connection speaks for one presence entry, the one of the client id it announced first.
 *   - A client id belongs to the link (the token) it was first announced with. A connection
 *     takes an entry over only when it was opened with that link: a tab that reconnects keeps
 *     its id, be it while its old socket lingers until the next heartbeat or after it was gone
 *     for a while. Nobody else gets the id, also not once its holder has left or let the entry
 *     lapse, or whoever asked first in that moment could keep its owner out of the room's presence.
 *   - `null` is believed only from the holder. Clients also say it about peers their own copy
 *     timed out; the room notices by itself who left (socket closed, or 30 s without renewal).
 *   - A state is a JSON object of bounded size and depth, and `role` in it is the role of the
 *     token, whatever the client wrote there.
 *   - Updates are metered per connection, in number and in bytes, and in number per link. What
 *     the connections of one link show is bounded when taken together, and so is what the room
 *     holds: a hundred sockets opened with one link are not a hundred participants.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { WS_MSG_AWARENESS } from '@tandem/core';
import type { Role } from '@tandem/core';
import { Allowance } from './limits';

/**
 * Presence is a handful of flat fields. The bound matters because a state is stored parsed and
 * written back out for every broadcast and every new connection, and `JSON.stringify` overflows
 * the stack on nesting that `JSON.parse` accepts without complaint.
 */
const MAX_STATE_DEPTH = 32;
/** The editor sends at most 12.5 presence updates a second, and two at once when it reconnects. */
const UPDATES_PER_SECOND = 20;
const UPDATE_BURST = 40;
/**
 * The connections made with one link share this many times the allowance of a single one. A
 * link is given to several people, and ten of them moving their pointers at the same moment is
 * a busy room.
 */
const LINK_ALLOWANCES = 10;
/**
 * A room keeps as much presence as this many links may show. All of it is sent to everyone who
 * joins, so it is kept small next to the document.
 */
const ROOM_LINKS = 4;
/** Of how many ids whose holder has left a room remembers the link. */
const MAX_REMEMBERED = 1024;

type State = Record<string, unknown>;

interface Entry {
  id: number;
  clock: number;
  state: State | null;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

/** What the room needs to know about a connection to keep its presence. */
export interface PresenceMember {
  readonly role: Role;
  /** The token the connection was opened with: an entry stays among the connections of one link. */
  readonly link: string;
}

export interface PresenceListener {
  /** These entries have a new state. Every member but `origin` should hear of it. */
  changed(ids: number[], origin: PresenceMember | null): void;
  /** These entries are gone. `frame` says so and has to reach every member but `origin`. */
  removed(ids: number[], frame: Uint8Array, origin: PresenceMember | null): void;
}

export interface PresenceLimits {
  /**
   * Largest update that is looked at. It is also the most the connections made with one link
   * may show between them, and the room keeps ROOM_LINKS times as much in all.
   */
  maxBytes: number;
  /** Most entries one update may list: as many as the room has places. */
  maxEntries: number;
}

/** What the connections made with one link have between them. */
interface Share {
  /** How many of them are in the room. */
  seats: number;
  /** Size of what they show, taken together. */
  stored: number;
  updates: Allowance;
}

interface Seat {
  /** The entry this connection speaks for, from the moment it announced one. */
  id: number | undefined;
  /** Size of the update its entry was last set by; 0 while the entry shows nothing. */
  stored: number;
  share: Share;
  updates: Allowance;
  bytes: Allowance;
}

/** How deeply arrays and objects nest in a JSON text. Brackets inside strings are text, not structure. */
function jsonDepth(json: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      deepest = Math.max(deepest, ++depth);
    } else if (char === ']' || char === '}') {
      depth--;
    }
  }
  return deepest;
}

/**
 * The entries of an awareness update, or `null` when it lists more than `maxEntries`. Throws
 * unless every state is one the room could store and send on. The whole update is read before
 * any of it is acted on, so an update that is broken halfway leaves nothing behind.
 */
function decodeEntries(update: Uint8Array, maxEntries: number): Entry[] | null {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > maxEntries) return null;
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const json = decoding.readVarString(decoder);
    if (jsonDepth(json) > MAX_STATE_DEPTH) throw new Error('awareness state is nested too deeply');
    const state: unknown = JSON.parse(json);
    if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
      throw new Error('awareness state is neither an object nor null');
    }
    entries.push({ id, clock, state: state as State | null });
  }
  return entries;
}

function encodeEntries(entries: Entry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const { id, clock, state } of entries) {
    encoding.writeVarUint(encoder, id);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}

export class RoomPresence {
  private readonly awareness: awarenessProtocol.Awareness;
  private readonly seats = new Map<PresenceMember, Seat>();
  private readonly shares = new Map<string, Share>();
  /** Which connection speaks for which entry. */
  private readonly holders = new Map<number, PresenceMember>();
  /** The link of entries whose holder has left, oldest first. */
  private readonly left = new Map<number, string>();
  /** Size of what all entries show, taken together. */
  private stored = 0;

  constructor(
    doc: Y.Doc,
    private readonly limits: PresenceLimits,
    private readonly listener: PresenceListener,
  ) {
    // Destroyed together with `doc`, which also stops the timer that expires stale entries.
    this.awareness = new awarenessProtocol.Awareness(doc);
    // The server takes part in the document, not in presence: it has no cursor to show.
    this.awareness.setLocalState(null);
    this.awareness.on('update', this.onUpdate);
  }

  /** How many entries the room holds, and how many client ids it remembers a clock for. */
  get size(): { entries: number; clocks: number } {
    return { entries: this.awareness.getStates().size, clocks: this.awareness.meta.size };
  }

  /** The entries that show something right now: what a newcomer has to be told. */
  get present(): number[] {
    return [...this.awareness.getStates().keys()];
  }

  join(member: PresenceMember, now = Date.now()): void {
    const { maxBytes } = this.limits;
    let share = this.shares.get(member.link);
    if (!share) {
      share = {
        seats: 0,
        stored: 0,
        updates: new Allowance(LINK_ALLOWANCES * UPDATES_PER_SECOND, LINK_ALLOWANCES * UPDATE_BURST, now),
      };
      this.shares.set(member.link, share);
    }
    share.seats++;
    this.seats.set(member, {
      id: undefined,
      stored: 0,
      share,
      updates: new Allowance(UPDATES_PER_SECOND, UPDATE_BURST, now),
      // Twice the largest update per second: the editor's usual rate with a selection of several
      // hundred clips, and one update a second for the largest state there can be.
      bytes: new Allowance(2 * maxBytes, 2 * maxBytes, now),
    });
  }

  /**
   * Forget a connection. Its entry goes with it, and the remaining members are told. The id is
   * kept for the link: the same tab may be back.
   */
  leave(member: PresenceMember): void {
    const seat = this.seats.get(member);
    if (!seat) return;
    if (seat.id !== undefined) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [seat.id], null);
      this.holders.delete(seat.id);
      this.remember(seat.id, member.link);
    }
    this.seats.delete(member);
    if (--seat.share.seats === 0) this.shares.delete(member.link);
  }

  /** Stop listening. The awareness instance itself goes away with the document. */
  close(): void {
    this.awareness.off('update', this.onUpdate);
  }

  /**
   * Take the awareness update a member sent. Returns why some or all of it was not taken, or
   * `null` when everything was (entries about other members' departures are dropped without a
   * word, since honest clients send them). Throws on an update that cannot be decoded.
   */
  receive(member: PresenceMember, update: Uint8Array, now = Date.now()): string | null {
    const seat = this.seats.get(member);
    if (!seat) return null;
    const { maxBytes, maxEntries } = this.limits;
    const size = update.byteLength;
    if (size > maxBytes) return `it is larger than ${maxBytes} bytes`;
    // Once a connection has its entry, this is known before anything is parsed: updates there
    // is no room for cost next to nothing, however many connections keep sending them.
    const full = seat.id === undefined ? null : this.noRoomFor(seat, size);
    if (full) return full;
    const { share } = seat;
    if (!seat.updates.has(1, now) || !seat.bytes.has(size, now) || !share.updates.has(1, now)) {
      return 'updates are arriving faster than they are relayed';
    }
    seat.updates.spend(1);
    seat.bytes.spend(size);
    share.updates.spend(1);

    const entries = decodeEntries(update, maxEntries);
    if (!entries) return `it lists more than ${maxEntries} entries`;

    let refused: string | null = null;
    const taken: Entry[] = [];
    for (const entry of entries) {
      // The id of the room's own awareness instance: y-protocols would treat a state for it as
      // the server's own, renew it for ever and let nobody remove it.
      if (entry.id === this.awareness.clientID) continue;
      const holder = this.holders.get(entry.id);
      if (entry.state === null) {
        // Only where there is a state to take away: y-protocols would note the clock of any
        // other removal, and nothing would ever tell the room to forget it again.
        if (holder === member && this.awareness.getStates().has(entry.id)) taken.push(entry);
        continue;
      }
      if (holder !== member) {
        const link = holder ? holder.link : this.left.get(entry.id);
        if (link !== undefined && link !== member.link) {
          refused = 'the entry belongs to another participant';
          continue;
        }
        if (seat.id !== undefined) {
          refused = 'a connection can announce one presence entry';
          continue;
        }
        // What the entry shows right now goes on the books of whoever speaks for it from here on.
        const previous = holder && this.seats.get(holder);
        if (previous) {
          seat.stored = previous.stored;
          previous.stored = 0;
          previous.id = undefined;
        }
        this.left.delete(entry.id);
        this.holders.set(entry.id, member);
        seat.id = entry.id;
      }
      // y-protocols takes a state only at a later clock than the one it knows. One it would
      // pass over must not be booked in place of the one that stays.
      if (entry.clock <= (this.awareness.meta.get(entry.id)?.clock ?? 0)) continue;
      const noRoom = this.noRoomFor(seat, size);
      if (noRoom) {
        refused = noRoom;
        continue;
      }
      this.book(seat, size);
      entry.state.role = member.role;
      taken.push(entry);
    }
    if (taken.length > 0) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, encodeEntries(taken), member);
    }
    return refused;
  }

  /** A frame with the current state of those of `ids` the room still knows, or `null` for none. */
  frame(ids: Iterable<number>): Uint8Array | null {
    const known = [...ids].filter((id) => this.awareness.meta.has(id));
    if (known.length === 0) return null;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, WS_MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, known));
    return encoding.toUint8Array(encoder);
  }

  /**
   * Why the state in an update of `size` bytes cannot take the place of what `seat` shows now,
   * or `null` when it can. An update is counted in full, whatever else it lists.
   */
  private noRoomFor(seat: Seat, size: number): string | null {
    const { maxBytes } = this.limits;
    if (seat.share.stored - seat.stored + size > maxBytes) {
      return `the connections made with this link already show as much as one link may, ${maxBytes} bytes`;
    }
    if (this.stored - seat.stored + size > ROOM_LINKS * maxBytes) {
      return `the room already holds as much presence as it keeps, ${ROOM_LINKS * maxBytes} bytes`;
    }
    return null;
  }

  /** Put the size of what `seat` shows on the books; 0 once it shows nothing. */
  private book(seat: Seat, size: number): void {
    const more = size - seat.stored;
    seat.stored = size;
    seat.share.stored += more;
    this.stored += more;
  }

  /** Keep `id` for the connections of `link`, now that the one who spoke for it has left. */
  private remember(id: number, link: string): void {
    this.left.set(id, link);
    if (this.left.size <= MAX_REMEMBERED) return;
    // The link that left the most behind makes room. Flooding the room with ids therefore costs
    // a link its own, and not the one someone with another link is about to come back to.
    const counts = new Map<string, number>();
    let most = link;
    for (const other of this.left.values()) {
      const count = (counts.get(other) ?? 0) + 1;
      counts.set(other, count);
      if (count > (counts.get(most) ?? 0)) most = other;
    }
    for (const [oldest, other] of this.left) {
      if (other !== most) continue;
      this.left.delete(oldest);
      break;
    }
  }

  private readonly onUpdate = ({ added, updated, removed }: AwarenessChange, origin: unknown): void => {
    const from = this.seats.has(origin as PresenceMember) ? (origin as PresenceMember) : null;
    const changed = [...added, ...updated];
    if (changed.length > 0) this.listener.changed(changed, from);
    if (removed.length === 0) return;
    // Encoded while the clocks are still known: a removal names the clock it applies to.
    const frame = this.frame(removed);
    if (frame) this.listener.removed(removed, frame, from);
    for (const id of removed) {
      // Only what the entry showed is gone. The id stays with its holder, who may renew it late.
      const holder = this.holders.get(id);
      const seat = holder && this.seats.get(holder);
      if (seat) this.book(seat, 0);
      // y-protocols keeps the clock of every id it has ever seen. In a room that lives for weeks
      // that is one entry per connection there ever was, so the room forgets with the state.
      this.awareness.meta.delete(id);
    }
  };
}
