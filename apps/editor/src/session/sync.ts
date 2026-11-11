/**
 * WebSocket sync provider speaking the y-websocket wire protocol, with capability-token auth,
 * automatic reconnection and awareness (presence) relay.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';
import { WS_MSG_AWARENESS, WS_MSG_CONTROL, WS_MSG_SYNC, type ControlMessage } from '@tandem/core';

export type SyncStatus = 'offline' | 'connecting' | 'connected';

interface Options {
  awareness?: awarenessProtocol.Awareness;
  onStatus?: (status: SyncStatus) => void;
  onControl?: (msg: ControlMessage) => void;
  onSynced?: () => void;
  /** Called when the server rejects the connection outright (bad token, unknown project). */
  onDenied?: () => void;
}

export class SyncProvider {
  status: SyncStatus = 'offline';
  synced = false;
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private opened = false;

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
        encoding.writeVarUint8Array(e2, awarenessProtocol.encodeAwarenessUpdate(aw, [this.doc.clientID]));
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

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.synced = false;
      const aw = this.opts.awareness;
      if (aw) {
        const others = Array.from(aw.getStates().keys()).filter((id) => id !== this.doc.clientID);
        awarenessProtocol.removeAwarenessStates(aw, others, this);
      }
      this.setStatus('offline');
      // A socket that never opened usually means the server refused the upgrade (401 / 404).
      if (!this.opened && this.retry >= 2) this.opts.onDenied?.();
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
      }
    } else if (type === WS_MSG_AWARENESS) {
      if (this.opts.awareness) {
        awarenessProtocol.applyAwarenessUpdate(this.opts.awareness, decoding.readVarUint8Array(dec), this);
      }
    } else if (type === WS_MSG_CONTROL) {
      try {
        this.opts.onControl?.(JSON.parse(decoding.readVarString(dec)) as ControlMessage);
      } catch {
        /* ignore malformed control frames */
      }
    }
  }

  private schedule(): void {
    if (this.destroyed || this.timer) return;
    const delay = Math.min(15000, 600 * Math.pow(1.8, this.retry++)) * (0.75 + Math.random() * 0.5);
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
    if (aw) awarenessProtocol.removeAwarenessStates(aw, [this.doc.clientID], 'unload');
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
