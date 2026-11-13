/**
 * WebSocket sync provider speaking the y-websocket wire protocol, with capability-token auth,
 * automatic reconnection and awareness (presence) relay.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';
import {
  PRESENCE_IGNORED,
  WS_CLOSE_TOO_BIG,
  WS_CLOSE_TRY_AGAIN_LATER,
  WS_MSG_AWARENESS,
  WS_MSG_CONTROL,
  WS_MSG_SYNC,
  type ControlMessage,
} from '@tandem/core';

export type SyncStatus = 'offline' | 'connecting' | 'connected';

interface Options {
  awareness?: awarenessProtocol.Awareness;
  onStatus?: (status: SyncStatus) => void;
  onControl?: (msg: ControlMessage) => void;
  onSynced?: () => void;
  /**
   * Called each time the socket fails to open once it has failed a few times in a row. The server
   * is turning the connection away, and a browser is not told why: the token may be bad or the
   * project gone (401 / 404), the server may be at capacity (429 / 503), or it may hold more of the
   * document than it loads (507).
   */
  onRefused?: () => void;
  /** Called when the server ends an open connection to make room in a full project (close code 1013). */
  onDisplaced?: () => void;
  /**
   * Called when the server ends the connection over what this client sent it (close code 1009): the
   * document has no room for it, the server no memory, or it was more than one message may carry.
   * `said` is the reason the server gave before closing, `null` when it gave none. The same thing
   * would be sent again by the next connection, so from here on the provider tries only now and then.
   */
  onTurnedAway?: (said: string | null) => void;
  /**
   * Called when a connection made after `onTurnedAway`, or while `patient` was set, has been given
   * the document and was still open a while after everything this client had for it had left.
   */
  onTaken?: () => void;
  /** Called with the reason when the server says it passed over a presence update of this client. */
  onPresenceIgnored?: (reason: string) => void;
}

/** How long a connection waits before it tries again when trying at once has no prospect. */
export const PATIENT_RETRY_MS = 60_000;
/**
 * How long a connection has to stay open, with nothing left to send, before what it offered counts
 * as taken. The server refuses within one round trip of the message that is too much for it.
 */
export const TAKEN_AFTER_MS = 5000;

/** What an awareness update said about one client: at which clock, and whether it said "gone". */
export interface Claim {
  clock: number;
  gone: boolean;
}

/**
 * Take what an awareness update says about the client `own` out of it. Returns the update for
 * everyone else (`null` when nothing is left) and the claim made about `own`, if there was one.
 */
export function withoutOwn(
  update: Uint8Array,
  own: number,
): { others: Uint8Array | null; claim: Claim | null } {
  const dec = decoding.createDecoder(update);
  const count = decoding.readVarUint(dec);
  const kept: [id: number, clock: number, state: string][] = [];
  let claim: Claim | null = null;
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    const state = decoding.readVarString(dec);
    if (id !== own) kept.push([id, clock, state]);
    else if (!claim || clock > claim.clock) claim = { clock, gone: state === 'null' };
  }
  if (!claim) return { others: update, claim };
  if (kept.length === 0) return { others: null, claim };
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, kept.length);
  for (const [id, clock, state] of kept) {
    encoding.writeVarUint(enc, id);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, state);
  }
  return { others: encoding.toUint8Array(enc), claim };
}

export class SyncProvider {
  status: SyncStatus = 'offline';
  synced = false;
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private opened = false;
  /** What the server said was wrong, on the connection that is open or was open last. */
  private said: string | null = null;
  private takenTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Trying again at once has no prospect: the server will not take what this client holds, or will
   * not load the document at all. Set by a close with code 1009, or from outside when the reason
   * for a refused connection is known. It lasts until a connection has held (see `onTaken`).
   */
  patient = false;

  constructor(
    private readonly url: string,
    private readonly doc: Y.Doc,
    private readonly opts: Options = {},
  ) {
    doc.on('update', this.onDocUpdate);
    opts.awareness?.on('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('pagehide', this.onPageHide);
    }
    this.connect();
  }

  private setStatus(s: SyncStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private connect(): void {
    if (this.destroyed || this.ws) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.schedule();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.opened = false;
    this.said = null;

    ws.onopen = () => {
      this.opened = true;
      this.retry = 0;
      this.setStatus('connected');
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, WS_MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      ws.send(encoding.toUint8Array(enc));
      const aw = this.opts.awareness;
      if (aw && aw.getLocalState() !== null) {
        // Bump our awareness clock: peers discard a state they have already seen at this clock,
        // which would leave us invisible after a reconnect until the next presence change.
        aw.setLocalState(aw.getLocalState());
        const e2 = encoding.createEncoder();
        encoding.writeVarUint(e2, WS_MSG_AWARENESS);
        encoding.writeVarUint8Array(e2, awarenessProtocol.encodeAwarenessUpdate(aw, [aw.clientID]));
        ws.send(encoding.toUint8Array(e2));
      }
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      try {
        this.handle(new Uint8Array(ev.data));
      } catch (err) {
        console.warn('[sync] bad message', err);
      }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.synced = false;
      const aw = this.opts.awareness;
      if (aw) {
        const others = Array.from(aw.getStates().keys()).filter((id) => id !== aw.clientID);
        awarenessProtocol.removeAwarenessStates(aw, others, this);
      }
      this.setStatus('offline');
      if (this.takenTimer) clearTimeout(this.takenTimer);
      this.takenTimer = null;
      if (this.opened && ev.code === WS_CLOSE_TRY_AGAIN_LATER) this.opts.onDisplaced?.();
      if (this.opened && ev.code === WS_CLOSE_TOO_BIG) {
        this.patient = true;
        this.opts.onTurnedAway?.(this.said);
      }
      // A socket that never opens means the server refuses the upgrade.
      if (!this.opened && this.retry >= 2) this.opts.onRefused?.();
      this.schedule();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(data: Uint8Array): void {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === WS_MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, WS_MSG_SYNC);
      const msgType = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.ws?.send(encoding.toUint8Array(enc));
      if (msgType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.opts.onSynced?.();
        if (this.patient) this.watchTaken();
      }
    } else if (type === WS_MSG_AWARENESS) {
      const aw = this.opts.awareness;
      if (aw) {
        // On the wire anyone can speak about any client. What this client shows of itself is its
        // own to say: taken from the room, it would announce someone else's words from then on.
        const { others, claim } = withoutOwn(decoding.readVarUint8Array(dec), aw.clientID);
        if (others) awarenessProtocol.applyAwarenessUpdate(aw, others, this);
        if (claim) this.answer(aw, claim);
      }
    } else if (type === WS_MSG_CONTROL) {
      let msg: ControlMessage | null;
      try {
        msg = JSON.parse(decoding.readVarString(dec)) as ControlMessage | null;
      } catch {
        msg = null;
      }
      // A control frame that cannot be read says nothing.
      if (typeof msg !== 'object' || msg === null) return;
      if (msg.type === 'error' && typeof msg.message === 'string') {
        // An error is either a notice about presence, after which the connection goes on, or the
        // reason for the close that follows it.
        if (msg.message.startsWith(PRESENCE_IGNORED)) {
          this.opts.onPresenceIgnored?.(msg.message.slice(PRESENCE_IGNORED.length));
        } else this.said = msg.message;
      }
      this.opts.onControl?.(msg);
    }
  }

  /**
   * After a refusal, the connection counts as holding once it has the document and, a while after
   * the last of what this client had for the server has left, is still open.
   */
  private watchTaken(): void {
    const ws = this.ws;
    if (this.takenTimer) clearTimeout(this.takenTimer);
    this.takenTimer = setTimeout(() => {
      this.takenTimer = null;
      if (this.ws !== ws || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 0) {
        this.watchTaken();
        return;
      }
      this.patient = false;
      this.opts.onTaken?.();
    }, TAKEN_AFTER_MS);
  }

  /**
   * Someone else spoke for this client. Whoever heard them now shows what they said, at the clock
   * they said it with, and would take nothing older from us: so our own state goes out again at a
   * later clock. Only a clock we have not reached, or a "gone" at the one we are at, can be that. A
   * state at a clock we have been at may be our own words coming back, and answering those would
   * never end.
   */
  private answer(aw: awarenessProtocol.Awareness, claim: Claim): void {
    const mine = aw.meta.get(aw.clientID);
    const state = aw.getLocalState();
    if (!mine) return;
    const ahead = claim.clock > mine.clock;
    if (!ahead && !(claim.clock === mine.clock && claim.gone && state !== null)) return;
    if (ahead) aw.meta.set(aw.clientID, { ...mine, clock: claim.clock });
    aw.setLocalState(state);
  }

  private schedule(): void {
    if (this.destroyed || this.timer) return;
    const base = this.patient ? PATIENT_RETRY_MS : Math.min(15000, 600 * Math.pow(1.8, this.retry));
    this.retry++;
    const delay = base * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private onOnline = (): void => {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.retry = 0;
    this.connect();
  };

  private onPageHide = (): void => {
    const aw = this.opts.awareness;
    if (aw) awarenessProtocol.removeAwarenessStates(aw, [aw.clientID], 'unload');
  };

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, WS_MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.ws.send(encoding.toUint8Array(enc));
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.opts.awareness) return;
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, WS_MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.opts.awareness, changed));
    this.ws.send(encoding.toUint8Array(enc));
  };

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.takenTimer) clearTimeout(this.takenTimer);
    this.doc.off('update', this.onDocUpdate);
    this.opts.awareness?.off('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('pagehide', this.onPageHide);
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.setStatus('offline');
  }
}
