import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import {
  PRESENCE_IGNORED,
  PRESENCE_TOO_FAST,
  WS_MSG_AWARENESS,
  WS_MSG_CONTROL,
  WS_MSG_SYNC,
  docFullMessage,
  type ControlMessage,
} from '@tandem/core';
import { PATIENT_RETRY_MS, SyncProvider, TAKEN_AFTER_MS, withoutOwn } from '../src/session/sync';

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
  /** How many sockets were made: one per attempt to connect. */
  static made = 0;
  readyState = 0;
  binaryType = '';
  /** Bytes handed to the socket that have not left for the server yet. */
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.made++;
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

  private deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.slice().buffer });
  }

  /** Deliver an awareness update the way the server would. */
  receive(bytes: Uint8Array): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, WS_MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, bytes);
    this.deliver(encoding.toUint8Array(enc));
  }

  /** Deliver one of the server's own messages. */
  control(message: ControlMessage): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, WS_MSG_CONTROL);
    encoding.writeVarString(enc, JSON.stringify(message));
    this.deliver(encoding.toUint8Array(enc));
  }

  /** Deliver the server's copy of the document: the answer that makes a connection synced. */
  document(server: Y.Doc): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, WS_MSG_SYNC);
    syncProtocol.writeSyncStep2(enc, server);
    this.deliver(encoding.toUint8Array(enc));
  }

  /** The server, or the network, ends the connection. */
  shut(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
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

describe('SyncProvider and a server that will not take what it is sent', () => {
  const TOO_BIG = 1009;
  const full = docFullMessage('project');
  let doc: Y.Doc;
  let server: Y.Doc;
  let provider: SyncProvider;
  const turnedAway = vi.fn<(said: string | null) => void>();
  const taken = vi.fn<() => void>();
  const presenceIgnored = vi.fn<(reason: string) => void>();
  /** The socket of the latest attempt, opened. */
  const connected = (): FakeSocket => {
    const socket = FakeSocket.last;
    socket.open();
    return socket;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // The middle of the spread a delay is drawn from, so that every wait is its nominal length.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.made = 0;
    doc = new Y.Doc();
    server = new Y.Doc();
    provider = new SyncProvider('ws://test/ws/p/project', doc, {
      onTurnedAway: turnedAway,
      onTaken: taken,
      onPresenceIgnored: presenceIgnored,
    });
  });

  afterEach(() => {
    provider.destroy();
    doc.destroy();
    server.destroy();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps the reason the server gave for the close, and a notice about presence is not one', () => {
    const socket = connected();
    socket.control({ type: 'error', message: PRESENCE_IGNORED + PRESENCE_TOO_FAST });
    expect(presenceIgnored).toHaveBeenCalledExactlyOnceWith(PRESENCE_TOO_FAST);
    expect(turnedAway).not.toHaveBeenCalled();
    expect(provider.patient).toBe(false);

    socket.control({ type: 'error', message: full });
    socket.control({ type: 'error', message: PRESENCE_IGNORED + 'it is larger than 262144 bytes' });
    socket.shut(TOO_BIG);
    expect(turnedAway).toHaveBeenCalledExactlyOnceWith(full);
    expect(presenceIgnored).toHaveBeenCalledTimes(2);
  });

  it('tries again once a minute after such a close, not at once', () => {
    connected().shut(TOO_BIG);
    expect(provider.patient).toBe(true);
    expect(FakeSocket.made).toBe(1);
    // The usual retry would have come within a second, and never later than a quarter of a minute.
    vi.advanceTimersByTime(PATIENT_RETRY_MS - 1);
    expect(FakeSocket.made).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.made).toBe(2);

    // The next connection is told nothing before it is closed: a message over the size the server reads.
    connected().shut(TOO_BIG);
    expect(turnedAway.mock.calls).toEqual([[null], [null]]);
    vi.advanceTimersByTime(PATIENT_RETRY_MS - 1);
    expect(FakeSocket.made).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.made).toBe(3);
  });

  it('does not carry a reason over from the connection before', () => {
    const first = connected();
    first.control({ type: 'error', message: full });
    first.shut(TOO_BIG);
    vi.advanceTimersByTime(PATIENT_RETRY_MS);
    connected().shut(TOO_BIG);
    expect(turnedAway.mock.calls).toEqual([[full], [null]]);
  });

  it('counts what it had for the server as taken once a connection has the document and stays open', () => {
    connected().shut(TOO_BIG);
    vi.advanceTimersByTime(PATIENT_RETRY_MS);
    const socket = connected();
    socket.document(server);
    // Its own changes are still on their way out: nothing is known yet.
    socket.bufferedAmount = 4096;
    vi.advanceTimersByTime(TAKEN_AFTER_MS);
    expect(taken).not.toHaveBeenCalled();
    expect(provider.patient).toBe(true);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(TAKEN_AFTER_MS);
    expect(taken).toHaveBeenCalledOnce();
    expect(provider.patient).toBe(false);

    // From here on a lost connection is an ordinary one again, and is made again within a second.
    socket.shut(1006);
    expect(turnedAway).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made).toBe(3);
  });

  it('does not count it as taken when the server closes again before that', () => {
    connected().shut(TOO_BIG);
    vi.advanceTimersByTime(PATIENT_RETRY_MS);
    const socket = connected();
    socket.document(server);
    vi.advanceTimersByTime(TAKEN_AFTER_MS - 1);
    socket.control({ type: 'error', message: full });
    socket.shut(TOO_BIG);
    vi.advanceTimersByTime(TAKEN_AFTER_MS);
    expect(taken).not.toHaveBeenCalled();
    expect(provider.patient).toBe(true);
    expect(turnedAway.mock.calls).toEqual([[null], [full]]);
  });

  it('waits as long when it is told from outside that knocking has no prospect', () => {
    // The socket never opens: the server refuses the upgrade, and the next attempt follows at once.
    FakeSocket.last.shut(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made).toBe(2);
    provider.patient = true;
    FakeSocket.last.shut(1006);
    const made = FakeSocket.made;
    vi.advanceTimersByTime(PATIENT_RETRY_MS - 1);
    expect(FakeSocket.made).toBe(made);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.made).toBe(made + 1);
    // A connection that opens and holds ends the waiting.
    const socket = connected();
    socket.document(server);
    vi.advanceTimersByTime(TAKEN_AFTER_MS);
    expect(taken).toHaveBeenCalledOnce();
    expect(provider.patient).toBe(false);
  });
});
