/**
 * Realtime rooms: one Yjs document + awareness instance per (project, doc), shared by every
 * WebSocket connected to `/ws/:projectId/:doc`.
 *
 * Wire format (same as y-websocket): each binary message is `varUint(type)` followed by
 *   0 WS_MSG_SYNC       a y-protocols/sync message (step 1, step 2 or update)
 *   1 WS_MSG_AWARENESS  varUint8Array(awareness update)
 *   2 WS_MSG_CONTROL    varString(JSON ControlMessage), server → client only
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { WS_MSG_AWARENESS, WS_MSG_CONTROL, WS_MSG_SYNC, canWriteDoc } from '@tandem/core';
import type { ControlMessage, DocKind, Role } from '@tandem/core';
import { HttpError } from './http';
import { DocStore } from './persistence';
import { delay } from './util';

const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
/** How long an empty room stays in memory, so a page reload does not pay for a reload from disk. */
export const DEFAULT_ROOM_IDLE_MS = 30_000;
/**
 * A client that cannot keep up has its messages pile up in our memory. Past this point we drop
 * the connection; when it reconnects, the sync handshake brings it up to date in one message.
 */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** Presence is a few hundred bytes of JSON; a megabyte of it is abuse, and viewers may send it. */
const MAX_AWARENESS_BYTES = 1024 * 1024;
/**
 * Presence is a handful of flat fields. The bound matters because a state is stored parsed and
 * written back out for every broadcast and every new connection, and `JSON.stringify` overflows
 * the stack on nesting that `JSON.parse` accepts without complaint.
 */
const MAX_AWARENESS_DEPTH = 32;
/** How many sockets one room accepts unless configured otherwise. */
export const DEFAULT_MAX_CONNECTIONS_PER_ROOM = 100;
/** At most one "your edit was dropped" notice per connection in this interval. */
const READONLY_NOTICE_INTERVAL_MS = 1000;
/** On shutdown, how long clients get to complete the close handshake before sockets are destroyed. */
const CLOSE_GRACE_MS = 1000;

export const isDocKind = (value: unknown): value is DocKind => value === 'project' || value === 'review';

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

function updateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MSG_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function awarenessFrame(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MSG_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
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
 * Throws unless every state in a client's awareness update is JSON the server can store and send
 * on. `applyAwarenessUpdate` stores entry by entry and only announces the change at the end, so
 * an update that fails halfway would leave states behind that no connection owns; checking the
 * whole update first means it is applied completely or not at all.
 */
function assertRelayableAwareness(update: Uint8Array): void {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  for (let i = 0; i < count; i++) {
    decoding.readVarUint(decoder); // client id
    decoding.readVarUint(decoder); // clock
    const state = decoding.readVarString(decoder);
    if (jsonDepth(state) > MAX_AWARENESS_DEPTH) throw new Error('awareness state is nested too deeply');
    JSON.parse(state);
  }
}

/** A plain Uint8Array view of whatever `ws` handed us (no copy for the common single-Buffer case). */
function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) data = Buffer.concat(data);
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** One WebSocket in a room. */
class Connection {
  /** Cleared when a ping goes out, set again by the pong; still false at the next ping = dead. */
  alive = true;
  /** Awareness client ids this socket announced; they are removed from the room when it closes. */
  readonly awarenessIds = new Set<number>();
  /** Set once the server gave up on the connection; nothing it sends afterwards is looked at. */
  rejected = false;
  private lastReadonlyNotice = 0;

  constructor(
    readonly ws: WebSocket,
    readonly role: Role,
    readonly canWrite: boolean,
  ) {}

  send(frame: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.ws.terminate();
      return;
    }
    this.ws.send(frame, { binary: true }, (err) => {
      if (err) this.ws.terminate();
    });
  }

  /** Tell a read-only client (rate limited) that the server ignored a change it sent. */
  notifyReadonly(doc: DocKind): void {
    const now = Date.now();
    if (now - this.lastReadonlyNotice < READONLY_NOTICE_INTERVAL_MS) return;
    this.lastReadonlyNotice = now;
    this.send(
      controlFrame({
        type: 'readonly',
        role: this.role,
        message: `role "${this.role}" cannot edit the ${doc} document`,
      }),
    );
  }
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
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
  /** How many sockets one room holds at a time. */
  maxConnectionsPerRoom: number;
}

export class Room {
  private readonly conns = new Set<Connection>();
  /** Which connection announced which awareness client id. */
  private readonly awarenessOwners = new Map<number, Connection>();
  /** Holders (an upgrade in progress, an HTTP handler) that keep the room loaded without a socket. */
  private pins = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private autoTimer: NodeJS.Timeout | undefined;
  /** True while the document holds changes that no version (named or automatic) captured yet. */
  private unsnapshotted = false;
  private autoVersion: Promise<void> = Promise.resolve();
  private destroying: Promise<void> | undefined;

  private constructor(
    readonly projectId: string,
    readonly kind: DocKind,
    private readonly store: DocStore,
    private readonly manager: RoomManager,
    private readonly opts: RoomManagerOptions,
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness,
  ) {
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
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
    const awareness = new awarenessProtocol.Awareness(doc);
    // The server takes part in the document, not in presence: it has no cursor to show.
    awareness.setLocalState(null);
    try {
      const store = await DocStore.open(opts.projectDir(projectId), kind, doc);
      return new Room(projectId, kind, store, manager, opts, doc, awareness);
    } catch (err) {
      doc.destroy(); // also stops the awareness instance's timer
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

  private get full(): boolean {
    return this.conns.size >= this.opts.maxConnectionsPerRoom;
  }

  /** The connection that makes way when a full room takes someone who may write its document. */
  private latestReadOnly(): Connection | undefined {
    return [...this.conns].reverse().find((conn) => !conn.canWrite);
  }

  /**
   * Whether one more connection with `role` fits in. A full room still takes someone who may
   * write its document, as long as a read-only connection (the most recent one) can give up its
   * place: otherwise a single viewer link would be enough to keep the editors out of their project.
   * Asking changes nothing. The place is only taken in connect(), by a socket that did join.
   */
  hasRoomFor(role: Role): boolean {
    return !this.full || (canWriteDoc(role, this.kind) && this.latestReadOnly() !== undefined);
  }

  /**
   * Attach a freshly upgraded socket. Everything it needs to catch up is sent right away. In a
   * full room it takes the place hasRoomFor() found for it.
   */
  connect(ws: WebSocket, role: Role, registry: Set<Connection>): void {
    if (this.closed) {
      ws.close(1012, 'room is restarting');
      return;
    }
    const conn = new Connection(ws, role, canWriteDoc(role, this.kind));
    const displaced = this.full && conn.canWrite ? this.latestReadOnly() : undefined;
    if (displaced) {
      // The place is free now, not when the peer gets round to answering the close frame.
      displaced.rejected = true;
      this.disconnect(displaced);
      displaced.ws.close(1013, 'room is full');
    }
    this.conns.add(conn);
    registry.add(conn);
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
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) conn.send(awarenessFrame(this.awareness, present));
  }

  private disconnect(conn: Connection): void {
    if (!this.conns.delete(conn)) return;
    if (!this.closed && conn.awarenessIds.size > 0) {
      // Triggers onAwarenessUpdate, which tells the remaining clients and forgets the owners.
      awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
    }
    this.scheduleUnload();
  }

  private onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    // Frames still in flight when a shutdown starts are applied (and persisted) as usual; only once
    // the room is writing its final state is nothing accepted any more.
    if (this.closed || conn.rejected) return;
    try {
      if (!isBinary) throw new Error('text frames are not part of the protocol');
      const bytes = toUint8Array(data);
      const decoder = decoding.createDecoder(bytes);
      switch (decoding.readVarUint(decoder)) {
        case WS_MSG_SYNC:
          this.onSyncMessage(conn, decoder);
          break;
        case WS_MSG_AWARENESS:
          // Presence is relayed for every role: viewers should show up in the avatar stack too.
          if (bytes.byteLength <= MAX_AWARENESS_BYTES) {
            const update = decoding.readVarUint8Array(decoder);
            assertRelayableAwareness(update);
            awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn);
          }
          break;
        default:
          // Unknown frame types are ignored so newer clients can talk to an older server.
          break;
      }
    } catch (err) {
      // A frame we cannot decode leaves this client's view of the document in doubt. Dropping the
      // connection is the safe reaction: on reconnect the sync handshake restores a known state.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[tandem] closing a ${this.kind} connection of ${this.projectId} after a malformed message: ${reason}`,
      );
      conn.rejected = true;
      conn.send(controlFrame({ type: 'error', message: 'malformed message' }));
      conn.ws.close(1007, 'malformed message');
    }
  }

  private onSyncMessage(conn: Connection, decoder: decoding.Decoder): void {
    // Look at the sync sub-type ourselves instead of handing the frame to
    // `syncProtocol.readSyncMessage`: that is where the role check has to happen, and
    // readSyncMessage would also swallow (and only log) updates that fail to decode.
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case syncProtocol.messageYjsSyncStep1: {
        // Always answered, whatever the role: this is how read-only clients receive the document.
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, WS_MSG_SYNC);
        syncProtocol.readSyncStep1(decoder, encoder, this.doc);
        conn.send(encoding.toUint8Array(encoder));
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
            conn.notifyReadonly(this.kind);
          }
          break;
        }
        // The connection is the transaction origin, so onDocUpdate can skip echoing it back.
        Y.applyUpdate(this.doc, update, conn);
        break;
      }
      default:
        throw new Error(`unknown sync message type ${type}`);
    }
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    this.store.append(update);
    this.unsnapshotted = true;
    this.opts.onDocChanged(this.projectId);
    const frame = updateFrame(update);
    for (const conn of this.conns) if (conn !== origin) conn.send(frame);
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: AwarenessChange,
    origin: unknown,
  ): void => {
    if (origin instanceof Connection) {
      for (const id of [...added, ...updated]) {
        const owner = this.awarenessOwners.get(id);
        if (owner === origin) continue;
        // A client that reconnects keeps its id while its old socket may linger until the next
        // heartbeat. Hand the id over, so the old socket's close does not wipe the live state.
        owner?.awarenessIds.delete(id);
        this.awarenessOwners.set(id, origin);
        origin.awarenessIds.add(id);
      }
    }
    for (const id of removed) {
      this.awarenessOwners.get(id)?.awarenessIds.delete(id);
      this.awarenessOwners.delete(id);
    }
    const frame = awarenessFrame(this.awareness, [...added, ...updated, ...removed]);
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
      this.awareness.off('update', this.onAwarenessUpdate);
      for (const conn of this.conns) conn.ws.terminate();
      try {
        // Capture the end of an editing session as a version, so it can be returned to after
        // the next session changed things.
        await this.takeAutoVersion();
        await this.store.close();
      } finally {
        this.doc.destroy(); // destroys the awareness instance (and its interval) as well
      }
    })();
    return this.destroying;
  }
}

export class RoomManager {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  /** Loaded (or loading) rooms by `projectId/kind`. */
  private readonly rooms = new Map<string, Promise<Room>>();
  /** Rooms that left `rooms` but are still writing their final state. A reload must wait for them. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly connections = new Set<Connection>();
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly opts: RoomManagerOptions) {
    this.heartbeat = setInterval(() => this.checkConnections(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private checkConnections(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.ws.terminate(); // no pong since the last ping
        continue;
      }
      conn.alive = false;
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
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
   * Complete the WebSocket handshake for an already authenticated request and join the room.
   * The room is loaded *before* the upgrade completes, so the client's first frames cannot
   * arrive while nobody is listening.
   */
  async accept(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    projectId: string,
    kind: DocKind,
    role: Role,
  ): Promise<void> {
    const room = await this.acquire(projectId, kind);
    try {
      if (socket.destroyed) return; // the client gave up while we were loading
      // Nothing is awaited between this check and connect(), so concurrent upgrades cannot
      // overshoot the limit together. Nobody is displaced yet: the handshake below can still be
      // refused, and a connection that never joins must not cost a viewer their place.
      if (!room.hasRoomFor(role)) throw new HttpError(503, 'this project has too many open connections');
      // The callback runs synchronously inside handleUpgrade, i.e. before the pin is released.
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          room.connect(ws, role, this.connections);
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
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
