/**
 * Realtime rooms: one Yjs document + awareness instance per (project, doc), shared by every
 * WebSocket connected to `/ws/:projectId/:doc`.
 *
 * Wire format (same as y-websocket): each binary message is `varUint(type)` followed by
 *   0 WS_MSG_SYNC       a y-protocols/sync message (step 1, step 2 or update)
 *   1 WS_MSG_AWARENESS  varUint8Array(awareness update)
 *   2 WS_MSG_CONTROL    varString(JSON ControlMessage), server → client only
 *
 * What a connection may make a room hold and send is bounded throughout (see limits.ts): the
 * size of a message by role, the weight of the document, one presence entry per connection, and
 * one document copy at a time on its way to a client. The document comes first: presence is sent
 * to a client once it has the document, and never while it is behind.
 */
import type { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  NO_DOC_MEMORY,
  PRESENCE_IGNORED,
  WS_CLOSE_TOO_BIG,
  WS_CLOSE_TRY_AGAIN_LATER,
  WS_MSG_CONTROL,
  WS_MSG_AWARENESS,
  WS_MSG_SYNC,
  canWriteDoc,
  docFullMessage,
} from '@tandem/core';
import type { ControlMessage, DocAvailability, DocKind, Role } from '@tandem/core';
import { HttpError } from './http';
import { Budget, LOAD_HEADROOM, STRUCT_BYTES } from './limits';
import type { Limits } from './limits';
import { DocStore, DocumentTooLargeError, storedDoc, tooLargeToOpen } from './persistence';
import type { DocStoreLimits, StoredDoc } from './persistence';
import { RoomPresence } from './presence';
import type { PresenceMember } from './presence';
import { RECOUNT_AFTER_STRUCTS, measureUpdate, sameSetAside, setAside, weigh, weightOf } from './updateSize';
import { delay } from './util';

const MIB = 1024 * 1024;
/** How often every connection is asked for a sign of life. */
export const DEFAULT_HEARTBEAT_MS = 30_000;
/**
 * For how many heartbeats a connection counts as alive after the last of what it was being sent
 * left our hands. From there on it is in the buffers of the two machines, and the ping that waits
 * behind it is answered when the client has read that far.
 */
const HEARTBEATS_OF_GRACE = 2;
/** How long an empty room stays in memory, so a page reload does not pay for a reload from disk. */
export const DEFAULT_ROOM_IDLE_MS = 30_000;
/** How many sockets one room accepts unless configured otherwise. */
export const DEFAULT_MAX_CONNECTIONS_PER_ROOM = 100;
/**
 * What any connection may send in one message, whatever its role: the state vector that asks
 * for the document, or a presence update. Only a connection that may write the document gets to
 * send messages as large as the document may be.
 */
const MIN_PAYLOAD_BYTES = MIB;
/** Room for the type and length prefixes around the largest update a message can carry. */
const MESSAGE_OVERHEAD_BYTES = 16;
/**
 * A client that cannot keep up has its messages pile up in our memory. Past the document limit
 * twice over plus this, a fresh copy of the document is cheaper than what is queued, so the
 * connection is dropped; when it reconnects, the sync handshake brings it up to date in one message.
 */
const BACKLOG_ALLOWANCE_BYTES = 32 * MIB;
/**
 * While more than this is queued for a client, presence is not added to the queue. Presence is
 * a stream of latest states: a client that is behind gets one update with the current ones once
 * it has caught up, so no amount of presence can push a slow member over its backlog limit or
 * stand between it and the document.
 */
const PRESENCE_HOLD_BYTES = 256 * 1024;
/** At most one notice of each kind per connection in this interval. */
const NOTICE_INTERVAL_MS = 1000;
/** A refusal that repeats with every reconnect is logged once in this interval. */
const COMPLAINT_INTERVAL_MS = 10 * 60 * 1000;
/** Of how many documents it is remembered that reading them found them too large to load. */
const MAX_REMEMBERED_TOO_LARGE = 1024;
/** On shutdown, how long clients get to complete the close handshake before sockets are destroyed. */
const CLOSE_GRACE_MS = 1000;

const CLOSE_MALFORMED = 1007;
const CLOSE_RESTARTING = 1012;

/** Who makes way for whom in a full room. */
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

const DOC_LIMIT_SETTING: Record<DocKind, string> = {
  project: 'MAX_PROJECT_DOC_BYTES',
  review: 'MAX_REVIEW_DOC_BYTES',
};

export const isDocKind = (value: unknown): value is DocKind => value === 'project' || value === 'review';

/** The limit of a kind of document, and the settings it comes from, for a log line. */
function limitInWords(kind: DocKind, limits: Limits): string {
  const bytes = limits.maxDocBytes[kind];
  return (
    `A ${kind} document may hold ${bytes} bytes and ${Math.floor(bytes / STRUCT_BYTES)} structs, and is ` +
    `loaded up to ${LOAD_HEADROOM} times that (${DOC_LIMIT_SETTING[kind]}, and at most 1/${LOAD_HEADROOM} of ` +
    `MAX_OPEN_DOC_BYTES, which is ${limits.maxOpenDocBytes})`
  );
}

/**
 * How much of a stored document of `kind` is loaded on a server that holds `openDocBytes` of them
 * in all. Never more than would fit if nothing else were loaded: what is refused as too large for
 * this stays refused, and what is turned away for want of room does get in with time.
 */
function loadLimits(
  kind: DocKind,
  limits: Limits,
  openDocBytes: number,
): Required<Pick<DocStoreLimits, 'maxBytes' | 'maxStoredBytes' | 'maxStructs'>> {
  const maxBytes = LOAD_HEADROOM * limits.maxDocBytes[kind];
  return {
    maxBytes: Math.min(maxBytes, openDocBytes),
    maxStoredBytes: openDocBytes,
    maxStructs: Math.min(Math.floor(maxBytes / STRUCT_BYTES), Math.floor(openDocBytes / STRUCT_BYTES)),
  };
}

/** The files of a document as they were when it was found too large: the same files will be again. */
const sizesOf = (stored: StoredDoc): string => `${stored.snapshotBytes}+${stored.logBytes}`;

function controlFrame(message: ControlMessage): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MSG_CONTROL);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}

function syncStep1Frame(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function syncStep2Frame(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MSG_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

function updateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MSG_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** A plain Uint8Array view of whatever `ws` handed us (no copy for the common single-Buffer case). */
function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) data = Buffer.concat(data);
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** One WebSocket in a room. */
class Connection implements PresenceMember {
  /** Cleared when a ping goes out, set again by the pong. */
  alive = true;
  /** How much had arrived from the client at the last heartbeat. */
  private received = 0;
  /** When a heartbeat last found something for the client still on its way out. */
  private sendingAt = -Infinity;
  /** Set once the server gave up on the connection; nothing it sends afterwards is looked at. */
  rejected = false;
  /** State vector of a request for the document that is not answered yet. Only the latest counts. */
  syncRequest: Uint8Array | undefined;
  /** Size of the document copy that is on its way to this client; 0 when none is. */
  syncBytes = 0;
  /**
   * Presence entries whose latest state this client has yet to be sent: everyone who was here
   * when it joined, until it has the document, and whatever changed while it was behind.
   */
  private readonly heldPresence = new Set<number>();
  /** True once the first copy of the document has left for this client. */
  private hasDocument = false;
  private readonly lastNotice = new Map<ControlMessage['type'], number>();

  constructor(
    readonly ws: WebSocket,
    /** The socket `ws` runs on. */
    private readonly socket: Duplex,
    readonly role: Role,
    readonly canWrite: boolean,
    readonly link: string,
    private readonly maxBacklogBytes: number,
    /** A frame with the current state of the given presence entries, if any still exist. */
    private readonly presenceFrame: (ids: Iterable<number>) => Uint8Array | null,
  ) {}

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * End the connection when its socket has taken nothing of what is waiting to be sent for
   * `idleMs`. A socket reports itself idle only after that long without anything read from it and
   * without the write that is under way having moved on, so a client that reads slowly is left
   * alone and one that has stopped reading is not.
   */
  watchForStall(idleMs: number): void {
    const { socket, ws } = this;
    if (!(socket instanceof Socket)) return;
    socket.setTimeout(idleMs);
    socket.on('timeout', () => {
      if (ws.bufferedAmount > 0) ws.terminate();
    });
  }

  /**
   * One heartbeat: says whether the connection gave a sign of life since the one before, and asks
   * for the next. A pong is one, and so is anything else that came in. But a ping waits its turn
   * behind what is being sent, and its answer behind what the client is sending, and a large
   * document on a slow link takes longer than a heartbeat either way. So a connection that is
   * still being sent something counts as alive too (`watchForStall` ends it when the client has
   * stopped taking it), and goes on doing so for `grace` after the last of it left.
   */
  beat(now: number, grace: number): boolean {
    const received = this.socket instanceof Socket ? this.socket.bytesRead : 0;
    if (this.ws.bufferedAmount > 0) this.sendingAt = now;
    const alive = this.alive || received > this.received || now - this.sendingAt < grace;
    this.received = received;
    this.alive = false;
    if (alive && this.open) this.ws.ping();
    return alive;
  }

  /** Queue a frame. `sent` runs once it has left for the client, and never if it did not. */
  send(frame: Uint8Array, sent?: () => void): void {
    if (!this.open) return;
    if (this.ws.bufferedAmount > this.maxBacklogBytes) {
      this.ws.terminate();
      return;
    }
    this.ws.send(frame, { binary: true }, (err) => {
      if (err) {
        this.ws.terminate();
        return;
      }
      sent?.();
      this.releaseHeldPresence();
    });
  }

  /** Whether presence has to wait: for the document, or for the client to catch up. */
  private get holdsPresence(): boolean {
    return !this.hasDocument || this.ws.bufferedAmount > PRESENCE_HOLD_BYTES;
  }

  /** The client is to be told the state of these presence entries when its turn for presence comes. */
  owePresence(ids: Iterable<number>): void {
    for (const id of ids) this.heldPresence.add(id);
  }

  /** Pass on the new state of some presence entries, now or once the client has caught up. */
  relayPresence(ids: number[], frame: Uint8Array): void {
    if (this.holdsPresence) this.owePresence(ids);
    else this.send(frame);
  }

  /**
   * Say that some presence entries are gone, which also settles what was still owed about them.
   * A client that has not been told about anyone yet has nothing to be told here either.
   */
  dropPresence(ids: number[], frame: Uint8Array): void {
    for (const id of ids) this.heldPresence.delete(id);
    if (this.hasDocument) this.send(frame);
  }

  /** The first copy of the document has left for the client: presence may follow. */
  documentSent(): void {
    this.hasDocument = true;
  }

  private releaseHeldPresence(): void {
    if (this.heldPresence.size === 0 || this.holdsPresence) return;
    const frame = this.presenceFrame(this.heldPresence);
    this.heldPresence.clear();
    if (frame) this.send(frame);
  }

  /** Tell the client (rate limited per kind of notice) that the server did not take something it sent. */
  notify(message: ControlMessage): void {
    const now = Date.now();
    if (now - (this.lastNotice.get(message.type) ?? 0) < NOTICE_INTERVAL_MS) return;
    this.lastNotice.set(message.type, now);
    this.send(controlFrame(message));
  }

  /** Say why, then close. Nothing the client sends from here on is looked at. */
  turnAway(code: number, reason: string): void {
    this.rejected = true;
    this.send(controlFrame({ type: 'error', message: reason }));
    this.ws.close(code, reason);
  }
}

export interface RoomHooks {
  /** Directory holding the project's snapshot and log files. */
  projectDir(projectId: string): string;
  /** A document of the project changed. Called for every update, so it must be cheap. */
  onDocChanged(projectId: string): void;
  /** Store `state` as an automatic version of the project. */
  saveAutoVersion(projectId: string, state: Uint8Array): Promise<void>;
}

export interface RoomManagerOptions extends RoomHooks {
  /** Interval of automatic versions for `project` documents; `0` disables them. */
  autoSnapshotMs: number;
  /** How long a room without connections stays loaded. */
  roomIdleMs: number;
  /** Interval at which connections are checked for a sign of life. */
  heartbeatMs: number;
  limits: Limits;
}

export class Room {
  private readonly conns = new Set<Connection>();
  private readonly presence: RoomPresence;
  /** Holders (an upgrade in progress, an HTTP handler) that keep the room loaded without a socket. */
  private pins = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private autoTimer: NodeJS.Timeout | undefined;
  /** True while the document holds changes that no version (named or automatic) captured yet. */
  private unsnapshotted = false;
  private autoVersion: Promise<void> = Promise.resolve();
  private destroying: Promise<void> | undefined;
  /** Encoded size the document may reach, and the structs that go with it. */
  private readonly maxBytes: number;
  private readonly maxStructs: number;
  /**
   * What the document weighs, as charged to the budget of all loaded documents: its encoded size
   * as last measured plus the updates taken since, and its structs as last counted plus the
   * weight of the updates taken since.
   */
  private bytes: number;
  private structs: number;
  /** True while both figures are measurements, i.e. until the next update is taken. */
  private weighed = false;
  private structsSinceCount = 0;
  /** How many updates have changed the document since it was loaded. */
  private changes = 0;

  private constructor(
    readonly projectId: string,
    readonly kind: DocKind,
    private readonly store: DocStore,
    private readonly manager: RoomManager,
    private readonly opts: RoomManagerOptions,
    readonly doc: Y.Doc,
    loaded: { bytes: number; structs: number },
  ) {
    this.maxBytes = opts.limits.maxDocBytes[kind];
    this.maxStructs = Math.floor(this.maxBytes / STRUCT_BYTES);
    this.bytes = loaded.bytes;
    this.structs = loaded.structs;
    this.setWeight(loaded.bytes, weigh(doc));
    this.weighed = false; // the bytes are those of the files, which is more than the document
    this.store.onSnapshot = (bytes) => this.setWeight(bytes, weigh(this.doc));

    this.presence = new RoomPresence(
      doc,
      { maxBytes: opts.limits.maxPresenceBytes, maxEntries: opts.limits.maxConnectionsPerRoom },
      {
        changed: (ids, origin) => {
          const frame = this.presence.frame(ids);
          if (!frame) return;
          for (const conn of this.conns) if (conn !== origin) conn.relayPresence(ids, frame);
        },
        removed: (ids, frame, origin) => {
          for (const conn of this.conns) if (conn !== origin) conn.dropPresence(ids, frame);
        },
      },
    );
    this.doc.on('update', this.onDocUpdate);
    if (kind === 'project' && opts.autoSnapshotMs > 0) {
      this.autoTimer = setInterval(() => void this.takeAutoVersion(), opts.autoSnapshotMs);
      this.autoTimer.unref();
    }
    this.scheduleUnload();
  }

  static async load(
    projectId: string,
    kind: DocKind,
    manager: RoomManager,
    opts: RoomManagerOptions,
  ): Promise<Room> {
    const doc = new Y.Doc({ gc: true });
    const { openDocs } = manager;
    const held = { bytes: 0, structs: 0 };
    // Only ever asked for what would fit if nothing else were loaded (the store refuses a
    // document beyond that as too large), so being turned away here does pass with time.
    const reserve = (budget: Budget, amount: number): void => {
      if (!budget.fits(amount)) {
        manager.complain(
          'open documents',
          `not loading another document: the ones in memory have reached MAX_OPEN_DOC_BYTES (${openDocs.bytes.limit})`,
        );
        throw new HttpError(503, 'the server has too many documents open, try again later');
      }
      budget.add(amount);
    };
    try {
      const store = await DocStore.open(opts.projectDir(projectId), kind, doc, {
        ...loadLimits(kind, opts.limits, openDocs.bytes.limit),
        reserveBytes: (bytes) => {
          reserve(openDocs.bytes, bytes);
          held.bytes = bytes;
        },
        reserveStructs: (structs) => {
          reserve(openDocs.structs, structs);
          held.structs += structs;
        },
      });
      return new Room(projectId, kind, store, manager, opts, doc, held);
    } catch (err) {
      openDocs.bytes.add(-held.bytes);
      openDocs.structs.add(-held.structs);
      doc.destroy(); // also stops the timer of an awareness instance, had one been made
      if (err instanceof DocumentTooLargeError) {
        manager.complain(
          `${projectId}/${kind}`,
          `not loading the ${kind} document of project ${projectId}: ${err.message}. ${limitInWords(kind, opts.limits)}`,
        );
        manager.foundTooLarge(projectId, kind, await storedDoc(opts.projectDir(projectId), kind));
        throw new HttpError(507, `the ${kind} document of this project is larger than this server accepts`);
      }
      throw err;
    }
  }

  get closed(): boolean {
    return this.destroying !== undefined;
  }

  get idle(): boolean {
    return this.conns.size === 0 && this.pins === 0;
  }

  /** Keep the room loaded until the matching `release()`. */
  retain(): void {
    this.pins++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  release(): void {
    this.pins--;
    this.scheduleUnload();
  }

  private scheduleUnload(): void {
    if (this.closed || !this.idle || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.manager.unload(this);
    }, this.opts.roomIdleMs);
    this.idleTimer.unref();
  }

  /** Full state of the document, and a note that this state is now captured by a version. */
  snapshotForVersion(): Uint8Array {
    this.unsnapshotted = false;
    return Y.encodeStateAsUpdate(this.doc);
  }

  // ──────────────────────────────────────────────────────── document weight ──

  private setWeight(bytes: number, structs: number): void {
    const { openDocs } = this.manager;
    openDocs.bytes.add(bytes - this.bytes);
    openDocs.structs.add(structs - this.structs);
    this.bytes = bytes;
    this.structs = structs;
    this.weighed = true;
    this.structsSinceCount = 0;
  }

  /**
   * Put an update on the books, or say why it cannot be taken. Has to be settled before the
   * update is applied: Yjs cannot take one back out.
   */
  private reserve(bytes: number, structs: number): string | null {
    const full = docFullMessage(this.kind);
    if (bytes > this.maxBytes) return full;
    const { openDocs } = this.manager;
    const fitsDocument = (): boolean =>
      this.bytes + bytes <= this.maxBytes && this.structs + structs <= this.maxStructs;
    const fitsServer = (): boolean => openDocs.bytes.fits(bytes) && openDocs.structs.fits(structs);
    // The figures on the books err on the high side. Before they turn anyone away, find out
    // what the document really weighs (the size costs an encoding of it, hence only now).
    if (!this.weighed && !(fitsDocument() && fitsServer())) {
      this.setWeight(Y.encodeStateAsUpdate(this.doc).byteLength, weigh(this.doc));
    }
    if (!fitsDocument()) {
      this.manager.complain(
        `${this.projectId}/${this.kind} full`,
        `the ${this.kind} document of project ${this.projectId} is full and takes no more changes. ${limitInWords(this.kind, this.opts.limits)}`,
      );
      return full;
    }
    if (!fitsServer()) {
      this.manager.complain(
        'open documents',
        `refusing changes to documents: the ones in memory have reached MAX_OPEN_DOC_BYTES (${openDocs.bytes.limit})`,
      );
      return NO_DOC_MEMORY;
    }
    this.book(bytes, structs);
    return null;
  }

  private book(bytes: number, structs: number): void {
    const { openDocs } = this.manager;
    openDocs.bytes.add(bytes);
    openDocs.structs.add(structs);
    this.bytes += bytes;
    this.structs += structs;
    this.structsSinceCount += structs;
    this.weighed = false;
  }

  /** Replace the struct count on the books by the real one, if `now` or once enough has built up. */
  private recount(now: boolean): void {
    if (!now && this.structsSinceCount < RECOUNT_AFTER_STRUCTS) return;
    const structs = weigh(this.doc);
    this.manager.openDocs.structs.add(structs - this.structs);
    this.structs = structs;
    this.structsSinceCount = 0;
  }

  // ───────────────────────────────────────────────────────────── members ──

  private get full(): boolean {
    return this.conns.size >= this.opts.limits.maxConnectionsPerRoom;
  }

  /**
   * The connection that makes way when a full room takes someone with `role`: one whose role
   * ranks below theirs, the lowest there is, and of those the most recent.
   */
  private yielding(role: Role): Connection | undefined {
    let found: Connection | undefined;
    for (const conn of this.conns) {
      if (RANK[conn.role] < RANK[role] && (!found || RANK[conn.role] <= RANK[found.role])) found = conn;
    }
    return found;
  }

  /**
   * Whether one more connection with `role` fits in. A full room still takes someone as long as
   * a connection of a lesser role can give up its place: otherwise a single viewer link would be
   * enough to keep the editors out of their project, or a comment link the owner out of the review.
   * Asking changes nothing. The place is only taken in connect(), by a socket that did join.
   */
  hasRoomFor(role: Role): boolean {
    return !this.full || this.yielding(role) !== undefined;
  }

  /**
   * Attach a freshly upgraded socket. It is greeted and asked for what it has; who else is here
   * it is told after the document, which it gets when it asks. In a full room it takes the place
   * hasRoomFor() found for it.
   */
  connect(ws: WebSocket, socket: Duplex, role: Role, link: string, registry: Set<Connection>): void {
    if (this.closed) {
      ws.close(CLOSE_RESTARTING, 'room is restarting');
      return;
    }
    const conn = new Connection(
      ws,
      socket,
      role,
      canWriteDoc(role, this.kind),
      link,
      2 * this.maxBytes + BACKLOG_ALLOWANCE_BYTES,
      (ids) => this.presence.frame(ids),
    );
    const displaced = this.full ? this.yielding(role) : undefined;
    if (displaced) {
      // The place is free now, not when the peer gets round to answering the close frame.
      displaced.rejected = true;
      this.disconnect(displaced);
      displaced.ws.close(WS_CLOSE_TRY_AGAIN_LATER, 'room is full');
    }
    this.conns.add(conn);
    registry.add(conn);
    this.presence.join(conn);
    conn.watchForStall(this.opts.heartbeatMs);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;

    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('pong', () => {
      conn.alive = true;
    });
    // `ws` always emits 'close' after 'error'; the listener only keeps the error from being thrown.
    ws.on('error', () => undefined);
    ws.on('close', () => {
      registry.delete(conn);
      this.disconnect(conn);
    });

    conn.send(controlFrame({ type: 'hello', role }));
    conn.send(syncStep1Frame(this.doc));
    conn.owePresence(this.presence.present);
  }

  private disconnect(conn: Connection): void {
    if (!this.conns.delete(conn)) return;
    conn.syncRequest = undefined;
    this.manager.syncNoLongerWanted(conn);
    this.syncDelivered(conn);
    // Tells the remaining clients that its presence entry is gone.
    if (!this.closed) this.presence.leave(conn);
    this.scheduleUnload();
  }

  // ──────────────────────────────────────────────────────────── messages ──

  private onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    // Frames still in flight when a shutdown starts are applied (and persisted) as usual; only once
    // the room is writing its final state is nothing accepted any more.
    if (this.closed || conn.rejected) return;
    try {
      if (!isBinary) throw new Error('text frames are not part of the protocol');
      const decoder = decoding.createDecoder(toUint8Array(data));
      switch (decoding.readVarUint(decoder)) {
        case WS_MSG_SYNC:
          this.onSyncMessage(conn, decoder);
          break;
        case WS_MSG_AWARENESS: {
          // Presence is relayed for every role: viewers should show up in the avatar stack too.
          // Presence that is not taken never costs the connection: the document matters more.
          const refused = this.presence.receive(conn, decoding.readVarUint8Array(decoder));
          if (refused) conn.notify({ type: 'error', message: PRESENCE_IGNORED + refused });
          break;
        }
        default:
          // Unknown frame types are ignored so newer clients can talk to an older server.
          break;
      }
    } catch (err) {
      this.dropMalformed(conn, err);
    }
  }

  /**
   * A frame we cannot decode leaves this client's view of the document in doubt. Dropping the
   * connection is the safe reaction: on reconnect the sync handshake restores a known state.
   */
  private dropMalformed(conn: Connection, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[tandem] closing a ${this.kind} connection of ${this.projectId} after a malformed message: ${reason}`,
    );
    conn.turnAway(CLOSE_MALFORMED, 'malformed message');
  }

  private onSyncMessage(conn: Connection, decoder: decoding.Decoder): void {
    // Look at the sync sub-type ourselves instead of handing the frame to
    // `syncProtocol.readSyncMessage`: that is where the role check has to happen, and
    // readSyncMessage would also swallow (and only log) updates that fail to decode.
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case syncProtocol.messageYjsSyncStep1: {
        // Always answered, whatever the role: this is how read-only clients receive the document.
        const stateVector = decoding.readVarUint8Array(decoder);
        Y.decodeStateVector(stateVector); // throws now rather than when the answer is due
        conn.syncRequest = stateVector;
        this.sync(conn);
        break;
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        const update = decoding.readVarUint8Array(decoder);
        if (!conn.canWrite) {
          // Dropped: neither applied nor broadcast. Every client answers our step 1 with a step 2,
          // usually an empty one, so that alone is no reason to complain. A step 2 that carries
          // structs (first varUint = number of clients with new structs) or any incremental
          // update is an attempted edit, and the client is told that it did not happen.
          if (type === syncProtocol.messageYjsUpdate || (update.byteLength > 0 && update[0] !== 0)) {
            conn.notify({
              type: 'readonly',
              role: conn.role,
              message: `role "${conn.role}" cannot edit the ${this.kind} document`,
            });
          }
          break;
        }
        const structs = weightOf(measureUpdate(update, this.doc));
        // An update that adds no struct is taken as it is. Every client sends one in the
        // handshake: nothing new, and all the deletions it knows of, which we know as well.
        const refusal = structs > 0 ? this.reserve(update.byteLength, structs) : null;
        if (refusal) {
          // What this client holds and we do not take would be missing under everything it
          // sends next, so the connection ends here; the document stays as the others have it.
          conn.turnAway(WS_CLOSE_TOO_BIG, refusal);
          break;
        }
        const changesBefore = this.changes;
        const waiting = setAside(this.doc);
        // The connection is the transaction origin, so onDocUpdate can skip echoing it back.
        Y.applyUpdate(this.doc, update, conn);
        // Deletions that were news after all leave their few bytes in the document.
        if (structs === 0 && this.changes !== changesBefore) this.book(update.byteLength, 0);
        // What Yjs sets aside for later was weighed against the document as it is now and will
        // be applied to it as it is then: count again, for the worst case.
        this.recount(!sameSetAside(waiting, setAside(this.doc)));
        break;
      }
      default:
        throw new Error(`unknown sync message type ${type}`);
    }
  }

  /**
   * Answer a request for the document, unless the answer to an earlier one is still on its way:
   * then the request waits, and only the latest one counts. A client that asks again and again
   * without reading therefore holds one copy of the document, not one per request, and each
   * answer costs one encoding of the document, not one per request either.
   */
  private sync(conn: Connection): void {
    if (!this.trySync(conn)) this.manager.syncWhenThereIsRoom(conn, this);
  }

  /**
   * Send the document copy `conn` is waiting for, if there is one to send. `false` means that the
   * copies already on their way to clients leave no room for another: ask again when one arrived.
   */
  trySync(conn: Connection): boolean {
    const stateVector = conn.syncRequest;
    if (stateVector === undefined || conn.syncBytes > 0 || !conn.open || this.closed) return true;
    const { syncBacklog } = this.manager;
    // The copy is at most the whole document. One at a time is always possible.
    if (syncBacklog.used > 0 && !syncBacklog.fits(this.bytes)) return false;
    conn.syncRequest = undefined;
    const frame = syncStep2Frame(this.doc, stateVector);
    conn.syncBytes = frame.byteLength;
    syncBacklog.add(frame.byteLength);
    conn.send(frame, () => {
      conn.documentSent();
      this.syncDelivered(conn);
      this.sync(conn);
    });
    return true;
  }

  /** The copy that was on its way to `conn` has left our memory, one way or the other. */
  private syncDelivered(conn: Connection): void {
    if (conn.syncBytes === 0) return;
    this.manager.syncBacklog.add(-conn.syncBytes);
    conn.syncBytes = 0;
    this.manager.syncNextInLine();
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    this.changes++;
    this.store.append(update);
    this.unsnapshotted = true;
    this.opts.onDocChanged(this.projectId);
    const frame = updateFrame(update);
    for (const conn of this.conns) if (conn !== origin) conn.send(frame);
  };

  /** Take an automatic version if the document changed since the last version. Never rejects. */
  private takeAutoVersion(): Promise<void> {
    // Chained, so that destroy() also waits for a version the timer started a moment earlier.
    this.autoVersion = this.autoVersion.then(async () => {
      if (!this.unsnapshotted || this.opts.autoSnapshotMs <= 0 || this.kind !== 'project') return;
      const state = this.snapshotForVersion();
      try {
        await this.opts.saveAutoVersion(this.projectId, state);
      } catch (err) {
        this.unsnapshotted = true; // try again at the next tick
        console.error(`[tandem] automatic version of project ${this.projectId} failed:`, err);
      }
    });
    return this.autoVersion;
  }

  /**
   * Final persist and teardown. Idempotent. After this resolves every update the room ever
   * applied is in its snapshot file.
   */
  destroy(): Promise<void> {
    this.destroying ??= (async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.autoTimer) clearInterval(this.autoTimer);
      this.doc.off('update', this.onDocUpdate);
      this.presence.close();
      for (const conn of this.conns) conn.ws.terminate();
      try {
        // Capture the end of an editing session as a version, so it can be returned to after
        // the next session changed things.
        await this.takeAutoVersion();
        await this.store.close();
      } finally {
        this.doc.destroy(); // destroys the awareness instance (and its interval) as well
        this.store.onSnapshot = undefined;
        this.setWeight(0, 0);
      }
    })();
    return this.destroying;
  }
}

export class RoomManager {
  /** One per message size limit: `ws` fixes the largest message it reads when it takes a socket. */
  private readonly socketServers = new Map<number, WebSocketServer>();
  /** Loaded (or loading) rooms by `projectId/kind`. */
  private readonly rooms = new Map<string, Promise<Room>>();
  /** Rooms that left `rooms` but are still writing their final state. A reload must wait for them. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly connections = new Set<Connection>();
  /** Connections whose document copy waits for others to arrive first, in the order they asked. */
  private readonly syncQueue = new Map<Connection, Room>();
  private readonly complaints = new Map<string, number>();
  /**
   * Documents that were read and found to weigh more than is loaded, by `projectId/kind`, with the
   * size their files had. Files of a size that is fine can still hold too many structs, and only
   * reading them tells: so that `availability` need not, what the read showed is kept for as long
   * as the files stay the size they were.
   */
  private readonly tooLarge = new Map<string, string>();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;
  /** What all loaded documents weigh together. */
  readonly openDocs: { bytes: Budget; structs: Budget };
  /** Document copies that are queued for clients and have not left for them yet. */
  readonly syncBacklog: Budget;

  constructor(private readonly opts: RoomManagerOptions) {
    const { maxOpenDocBytes, maxSyncBacklogBytes } = opts.limits;
    this.openDocs = {
      bytes: new Budget(maxOpenDocBytes),
      structs: new Budget(Math.floor(maxOpenDocBytes / STRUCT_BYTES)),
    };
    this.syncBacklog = new Budget(maxSyncBacklogBytes);
    this.heartbeat = setInterval(() => this.checkConnections(), opts.heartbeatMs);
    this.heartbeat.unref();
  }

  private checkConnections(): void {
    const now = Date.now();
    const grace = HEARTBEATS_OF_GRACE * this.opts.heartbeatMs;
    for (const conn of this.connections) {
      if (!conn.beat(now, grace)) conn.ws.terminate();
    }
  }

  /** Log `message`, unless the same thing was logged about `subject` a moment ago. */
  complain(subject: string, message: string): void {
    const now = Date.now();
    if (now - (this.complaints.get(subject) ?? -Infinity) < COMPLAINT_INTERVAL_MS) return;
    for (const [key, at] of this.complaints) {
      if (now - at >= COMPLAINT_INTERVAL_MS) this.complaints.delete(key);
    }
    this.complaints.set(subject, now);
    console.warn(`[tandem] ${message}`);
  }

  /** A load of this document got as far as reading it, and it weighs more than is loaded. */
  foundTooLarge(projectId: string, kind: DocKind, stored: StoredDoc): void {
    const key = `${projectId}/${kind}`;
    // Insertion order is age: a document that keeps being asked for stays, the longest forgotten goes.
    this.tooLarge.delete(key);
    this.tooLarge.set(key, sizesOf(stored));
    if (this.tooLarge.size > MAX_REMEMBERED_TOO_LARGE) {
      this.tooLarge.delete(this.tooLarge.keys().next().value as string);
    }
  }

  /**
   * Whether a connection to this document would find it loaded or loadable right now, told from
   * the size of its files: nothing is read, and nothing is loaded for the asking. This is what a
   * client cannot learn from a refused upgrade, of which a browser only reports that it failed.
   */
  async availability(projectId: string, kind: DocKind): Promise<DocAvailability> {
    const key = `${projectId}/${kind}`;
    const loading = this.rooms.get(key);
    if (loading) {
      try {
        await loading;
        return 'ok';
      } catch {
        // The load that was under way failed: its files say why, as they do for the next one.
      }
    }
    const stored = await storedDoc(this.opts.projectDir(projectId), kind);
    const limits = loadLimits(kind, this.opts.limits, this.openDocs.bytes.limit);
    if (tooLargeToOpen(stored, limits) || this.tooLarge.get(key) === sizesOf(stored)) return 'too-large';
    return this.openDocs.bytes.fits(stored.snapshotBytes + stored.logBytes) ? 'ok' : 'busy';
  }

  /** Remember that `conn` waits for its copy of the document until others have arrived. */
  syncWhenThereIsRoom(conn: Connection, room: Room): void {
    this.syncQueue.set(conn, room);
  }

  syncNoLongerWanted(conn: Connection): void {
    this.syncQueue.delete(conn);
  }

  /** A document copy has arrived: serve those who waited for the room, first come first served. */
  syncNextInLine(): void {
    for (const [conn, room] of this.syncQueue) {
      if (!room.trySync(conn)) break;
      this.syncQueue.delete(conn);
    }
  }

  private load(projectId: string, kind: DocKind): Promise<Room> {
    const key = `${projectId}/${kind}`;
    let room = this.rooms.get(key);
    if (!room) {
      const previous = this.closing.get(key);
      room = (async () => {
        // Never read the files while an earlier incarnation of the room is still writing them.
        if (previous) await previous;
        return Room.load(projectId, kind, this, this.opts);
      })();
      this.rooms.set(key, room);
      const loading = room;
      room.catch(() => {
        // Do not cache the failure; the next attempt gets a fresh try.
        if (this.rooms.get(key) === loading) this.rooms.delete(key);
      });
    }
    return room;
  }

  /**
   * The room for a document, loaded from disk if necessary and pinned in memory.
   * The caller must `release()` it (attaching a socket first keeps it alive beyond that).
   */
  async acquire(projectId: string, kind: DocKind): Promise<Room> {
    for (;;) {
      if (this.closed) throw new HttpError(503, 'server is shutting down');
      const room = await this.load(projectId, kind);
      // The room may have been unloaded between the lookup and this continuation; ask again.
      if (room.closed) continue;
      room.retain();
      return room;
    }
  }

  /** Run `fn` against a loaded room (used by HTTP handlers that need the live document). */
  async withRoom<T>(projectId: string, kind: DocKind, fn: (room: Room) => T): Promise<T> {
    const room = await this.acquire(projectId, kind);
    try {
      return fn(room);
    } finally {
      room.release();
    }
  }

  /**
   * The WebSocket server for connections of `role` to a `kind` document. Whoever may write the
   * document may send messages as large as it may get; everyone else only as much as reading
   * takes. `ws` refuses a larger message when its header arrives (close code 1009), before any
   * of it is held in memory.
   */
  private socketServer(kind: DocKind, role: Role): WebSocketServer {
    const { maxDocBytes, maxPresenceBytes } = this.opts.limits;
    const maxPayload =
      Math.max(MIN_PAYLOAD_BYTES, maxPresenceBytes, canWriteDoc(role, kind) ? maxDocBytes[kind] : 0) +
      MESSAGE_OVERHEAD_BYTES;
    let server = this.socketServers.get(maxPayload);
    if (!server) {
      server = new WebSocketServer({ noServer: true, maxPayload });
      this.socketServers.set(maxPayload, server);
    }
    return server;
  }

  /**
   * Complete the WebSocket handshake for an already authenticated request and join the room.
   * The room is loaded *before* the upgrade completes, so the client's first frames cannot
   * arrive while nobody is listening. `link` is the token the request was authenticated with.
   */
  async accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    projectId: string,
    kind: DocKind,
    role: Role,
    link: string,
  ): Promise<void> {
    const room = await this.acquire(projectId, kind);
    try {
      if (socket.destroyed) return; // the client gave up while we were loading
      // Nothing is awaited between this check and connect(), so concurrent upgrades cannot
      // overshoot the limit together. Nobody is displaced yet: the handshake below can still be
      // refused, and a connection that never joins must not cost anyone their place.
      if (!room.hasRoomFor(role)) throw new HttpError(503, 'this project has too many open connections');
      // The callback runs synchronously inside handleUpgrade, i.e. before the pin is released.
      this.socketServer(kind, role).handleUpgrade(req, socket, head, (ws) => {
        try {
          room.connect(ws, socket, role, link, this.connections);
        } catch (err) {
          // The handshake is done, so this can no longer be answered with an HTTP status.
          console.error(`[tandem] could not attach a connection to ${projectId}/${kind}:`, err);
          ws.terminate();
        }
      });
    } finally {
      room.release();
    }
  }

  /** Called by a room's idle timer: persist it and drop it from memory, unless it got busy again. */
  unload(room: Room): void {
    if (!room.idle || room.closed) return;
    const key = `${room.projectId}/${room.kind}`;
    this.rooms.delete(key);
    const done = room
      .destroy()
      .catch((err: unknown) => console.error(`[tandem] could not persist ${key}:`, err))
      .finally(() => {
        if (this.closing.get(key) === done) this.closing.delete(key);
      });
    this.closing.set(key, done);
  }

  /** Disconnect everyone and write every loaded document to disk. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);

    // Sockets first, so no update can slip in behind a room's final write.
    for (const conn of this.connections) conn.ws.close(1001, 'server is shutting down');
    const deadline = Date.now() + CLOSE_GRACE_MS;
    while (this.connections.size > 0 && Date.now() < deadline) await delay(20);
    for (const conn of this.connections) conn.ws.terminate();

    const loaded = await Promise.allSettled(this.rooms.values());
    this.rooms.clear();
    const results = await Promise.allSettled(
      loaded.flatMap((result) => (result.status === 'fulfilled' ? [result.value.destroy()] : [])),
    );
    for (const result of results) {
      if (result.status === 'rejected')
        console.error('[tandem] could not persist a document on shutdown:', result.reason);
    }
    await Promise.allSettled(this.closing.values());
    await Promise.all(
      [...this.socketServers.values()].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
}
