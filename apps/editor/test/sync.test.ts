import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { WS_MSG_AWARENESS } from '@tandem/core';
import { SyncProvider, withoutOwn } from '../src/session/sync';

type Entry = [id: number, clock: number, state: unknown];

/** An awareness update as anyone holding a socket can write it. */
function update(entries: Entry[]): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const [id, clock, state] of entries) {
    encoding.writeVarUint(enc, id);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
  }
  return encoding.toUint8Array(enc);
}

function entries(bytes: Uint8Array): Entry[] {
  const dec = decoding.createDecoder(bytes);
  return Array.from({ length: decoding.readVarUint(dec) }, () => [
    decoding.readVarUint(dec),
    decoding.readVarUint(dec),
    JSON.parse(decoding.readVarString(dec)),
  ]);
}

describe('withoutOwn', () => {
  it('passes an update about other people through untouched', () => {
    const bytes = update([
      [1, 4, { user: 'a' }],
      [2, 9, null],
    ]);
    const { others, claim } = withoutOwn(bytes, 7);
    expect(others).toBe(bytes);
    expect(claim).toBeNull();
  });

  it('takes out what is said about this client and keeps the rest', () => {
    const bytes = update([
      [1, 4, { user: 'a' }],
      [7, 60, { user: 'forged' }],
      [2, 9, null],
    ]);
    const { others, claim } = withoutOwn(bytes, 7);
    expect(claim).toEqual({ clock: 60, gone: false });
    expect(entries(others!)).toEqual([
      [1, 4, { user: 'a' }],
      [2, 9, null],
    ]);
  });

  it('has nothing left of an update that was only about this client', () => {
    expect(withoutOwn(update([[7, 3, null]]), 7)).toEqual({ others: null, claim: { clock: 3, gone: true } });
  });

  it('goes by the latest of several claims', () => {
    const bytes = update([
      [7, 12, null],
      [7, 30, { user: 'x' }],
      [7, 5, null],
    ]);
    expect(withoutOwn(bytes, 7).claim).toEqual({ clock: 30, gone: false });
  });

  it('refuses an update that is cut short, before anything of it is used', () => {
    const bytes = update([
      [1, 4, { user: 'a' }],
      [2, 9, { user: 'b' }],
    ]);
    expect(() => withoutOwn(bytes.slice(0, bytes.length - 3), 7)).toThrow();
  });
});

/** A socket that is open as soon as the test says so, and remembers what was sent through it. */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.sent = [];
  }

  /** Deliver an awareness update the way the server would. */
  receive(bytes: Uint8Array): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, WS_MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, bytes);
    const frame = encoding.toUint8Array(enc);
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }

  /** The awareness entries sent since the socket opened. */
  announced(): Entry[] {
    return this.sent.flatMap((frame) => {
      const dec = decoding.createDecoder(frame);
      return decoding.readVarUint(dec) === WS_MSG_AWARENESS ? entries(decoding.readVarUint8Array(dec)) : [];
    });
  }
}

describe('SyncProvider and this client’s own presence', () => {
  const me = { user: { id: 'me', name: 'Owner', color: '#51cf66' }, role: 'owner', playhead: 0 };
  const forged = { user: { id: 'x', name: 'Mallory (owner)', color: '#ff0000' }, role: 'owner', playhead: 0 };
  let doc: Y.Doc;
  let awareness: Awareness;
  let provider: SyncProvider;
  let socket: FakeSocket;
  const clock = (): number => awareness.meta.get(awareness.clientID)!.clock;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    awareness.setLocalState(me);
    provider = new SyncProvider('ws://test/ws/p/project', doc, { awareness });
    socket = FakeSocket.last;
    socket.open();
  });

  afterEach(() => {
    provider.destroy();
    doc.destroy();
    vi.unstubAllGlobals();
  });

  it('does not take over a state someone else announced under its id, and says its own again', () => {
    const at = clock() + 50;
    socket.receive(
      update([
        [awareness.clientID, at, forged],
        [4242, 1, { user: { id: 'p', name: 'Peer', color: '#4dabf7' } }],
      ]),
    );
    expect(awareness.getLocalState()).toEqual(me);
    // The rest of the update still counts.
    expect(awareness.getStates().get(4242)).toMatchObject({ user: { name: 'Peer' } });
    // Everyone who heard the forgery takes this: it is later than what they were told.
    expect(socket.announced()).toEqual([[awareness.clientID, at + 1, me]]);

    // And what this client says next is still its own.
    awareness.setLocalStateField('playhead', 12);
    expect(awareness.getLocalState()).toEqual({ ...me, playhead: 12 });
  });

  it('answers when it is declared gone at the clock it is at', () => {
    const at = clock();
    socket.receive(update([[awareness.clientID, at, null]]));
    expect(awareness.getLocalState()).toEqual(me);
    expect(socket.announced()).toEqual([[awareness.clientID, at + 1, me]]);
  });

  it('says nothing when its own words come back, so that an echo cannot go round for ever', () => {
    const at = clock();
    socket.receive(update([[awareness.clientID, at, me]]));
    socket.receive(update([[awareness.clientID, at - 1, forged]]));
    socket.receive(update([[awareness.clientID, at - 1, null]]));
    expect(awareness.getLocalState()).toEqual(me);
    expect(clock()).toBe(at);
    expect(socket.announced()).toEqual([]);
  });

  it('tells a forged state apart from its own when it has left', () => {
    awareness.setLocalState(null);
    socket.sent = [];
    const at = clock() + 5;
    socket.receive(update([[awareness.clientID, at, forged]]));
    expect(awareness.getLocalState()).toBeNull();
    expect(socket.announced()).toEqual([[awareness.clientID, at + 1, null]]);
  });
});
