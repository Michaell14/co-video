import { afterEach, describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { Role } from '@tandem/core';
import { RoomPresence } from '../src/presence';
import type { PresenceLimits, PresenceMember } from '../src/presence';

interface Entry {
  id: number;
  clock: number;
  state: unknown;
}

/** An awareness update as a client encodes it (without the frame around it). */
function update(entries: Entry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const { id, clock, state } of entries) {
    encoding.writeVarUint(encoder, id);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}

/** The entries of a frame the room sends out. */
function entriesOf(frame: Uint8Array): Entry[] {
  const outer = decoding.createDecoder(frame);
  decoding.readVarUint(outer); // message type
  const decoder = decoding.createDecoder(decoding.readVarUint8Array(outer));
  return Array.from({ length: decoding.readVarUint(decoder) }, () => ({
    id: decoding.readVarUint(decoder),
    clock: decoding.readVarUint(decoder),
    state: JSON.parse(decoding.readVarString(decoder)) as unknown,
  }));
}

const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

function room(limits: Partial<PresenceLimits> = {}) {
  const doc = new Y.Doc();
  docs.push(doc);
  const changed: number[][] = [];
  const removed: Entry[][] = [];
  const presence = new RoomPresence(
    doc,
    { maxBytes: 4096, maxEntries: 8, ...limits },
    {
      changed: (ids) => changed.push(ids),
      removed: (_ids, frame) => removed.push(entriesOf(frame)),
    },
  );
  const member = (role: Role, link: string = role): PresenceMember => {
    const joined = { role, link };
    presence.join(joined);
    return joined;
  };
  /** Everyone present, as a newcomer is told. */
  const everyone = (): Entry[] => {
    const frame = presence.frame(presence.present);
    return frame ? entriesOf(frame) : [];
  };
  return { doc, presence, member, everyone, changed, removed };
}

/** An update with one entry that is exactly `bytes` long. */
function sized(id: number, clock: number, bytes: number): Uint8Array {
  const padded = (pad: number): Uint8Array => update([{ id, clock, state: { pad: 'x'.repeat(pad) } }]);
  // A longer state takes more bytes to say how long it is, so the padding is found, not computed.
  let pad = Math.max(0, bytes - padded(0).byteLength);
  while (pad > 0 && padded(pad).byteLength > bytes) pad--;
  const made = padded(pad);
  expect(made.byteLength).toBe(bytes);
  return made;
}

/**
 * What the room's own timer does to entries that were not renewed for thirty seconds. Done by
 * hand: y-protocols reads the time in a way that fake timers do not reach.
 */
function lapse(presence: RoomPresence, ids: number[]): void {
  const { awareness } = presence as unknown as { awareness: awarenessProtocol.Awareness };
  awarenessProtocol.removeAwarenessStates(awareness, ids, 'timeout');
}

describe('presence of a room', () => {
  it('keeps one entry per connection, with the role of its token', () => {
    const { presence, member, everyone, changed } = room();
    const viewer = member('viewer');

    expect(
      presence.receive(viewer, update([{ id: 7, clock: 1, state: { user: 'Vera', role: 'owner' } }])),
    ).toBeNull();
    expect(everyone()).toEqual([{ id: 7, clock: 1, state: { user: 'Vera', role: 'viewer' } }]);
    expect(changed).toEqual([[7]]);

    // More ids from the same connection are made-up participants.
    const refusal = presence.receive(
      viewer,
      update([
        { id: 7, clock: 2, state: { user: 'Vera', playhead: 3 } },
        { id: 8, clock: 1, state: { user: 'Ghost' } },
      ]),
    );
    expect(refusal).toMatch(/one presence entry/);
    expect(everyone()).toEqual([{ id: 7, clock: 2, state: { user: 'Vera', playhead: 3, role: 'viewer' } }]);
    for (let id = 100; id < 110; id++) {
      expect(presence.receive(viewer, update([{ id, clock: 1, state: {} }]))).toMatch(/one presence entry/);
    }
    expect(presence.size).toEqual({ entries: 1, clocks: 2 });
  });

  it('remembers nothing about ids that are only ever said to be gone', () => {
    const { presence, member, changed, removed } = room({ maxEntries: 1000, maxBytes: 64 * 1024 });
    const viewer = member('viewer');
    const idle = presence.size;
    let now = 0;
    // y-protocols would keep a clock for each of these ids for as long as the room lives.
    for (let frame = 0; frame < 500; frame++) {
      const unseen = Array.from({ length: 1000 }, (_, i) => ({
        id: 1_000_000 + frame * 1000 + i,
        clock: 1,
        state: null,
      }));
      // Spread over time, so that the allowance for updates is not what stops them.
      expect(presence.receive(viewer, update(unseen), (now += 1000))).toBeNull();
    }
    expect(presence.size).toEqual(idle);
    expect(changed).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('forgets the clock of an entry together with the entry', () => {
    const { presence, member, removed } = room();
    const idle = presence.size;
    let now = 0;
    // A room lives for as long as someone is in it, and every reconnect comes with a new id.
    for (let id = 1; id <= 200; id++) {
      const tab = member('editor');
      presence.receive(tab, update([{ id, clock: 1, state: { user: 'Ed' } }]), (now += 1000));
      if (id % 2) presence.leave(tab);
      else presence.receive(tab, update([{ id, clock: 2, state: null }]), (now += 1000));
      // Said once more by a connection that shows nothing any longer, it leaves nothing either.
      if (id % 4 === 0) presence.receive(tab, update([{ id, clock: 3, state: null }]), (now += 1000));
      if (id % 8 === 0) presence.leave(tab);
    }
    expect(presence.size).toEqual(idle);
    expect(removed).toHaveLength(200);
    // A removal goes out with the clock it applies to, or clients would not act on it.
    expect(removed[0]).toEqual([{ id: 1, clock: 1, state: null }]);
    expect(removed[1]).toEqual([{ id: 2, clock: 2, state: null }]);
  });

  it('lets nobody speak for the entry of a connection made with another link', () => {
    const { presence, member, everyone } = room();
    const editor = member('editor');
    const viewer = member('viewer');
    presence.receive(editor, update([{ id: 5, clock: 3, state: { user: 'Ed' } }]));

    expect(presence.receive(viewer, update([{ id: 5, clock: 9, state: { user: 'Not Ed' } }]))).toMatch(
      /belongs to another participant/,
    );
    // Saying that someone else is gone is what honest clients do when their own copy timed a
    // peer out. It is not held against them, and it is not acted on either.
    expect(presence.receive(viewer, update([{ id: 5, clock: 3, state: null }]))).toBeNull();
    expect(everyone()).toEqual([{ id: 5, clock: 3, state: { user: 'Ed', role: 'editor' } }]);

    // The editor is still there when the viewer goes, and can still update and remove its entry.
    presence.leave(viewer);
    expect(everyone()).toHaveLength(1);
    presence.receive(editor, update([{ id: 5, clock: 4, state: { user: 'Ed', playhead: 9 } }]));
    expect(everyone()).toEqual([{ id: 5, clock: 4, state: { user: 'Ed', playhead: 9, role: 'editor' } }]);
    presence.receive(editor, update([{ id: 5, clock: 5, state: null }]));
    expect(everyone()).toEqual([]);
  });

  it('hands an entry over to a connection made with the same link, and to nobody else', () => {
    const { presence, member, everyone, removed } = room();
    // A tab reconnects after a network drop. The server still counts its old socket as alive.
    const before = member('editor', 'link-a');
    presence.receive(before, update([{ id: 5, clock: 3, state: { user: 'Ed' } }]));
    const after = member('editor', 'link-a');
    expect(
      presence.receive(after, update([{ id: 5, clock: 4, state: { user: 'Ed', playhead: 2 } }])),
    ).toBeNull();
    // When the old socket is finally given up, the entry stays: it is the new connection's now.
    presence.leave(before);
    expect(removed).toEqual([]);
    expect(everyone()).toEqual([{ id: 5, clock: 4, state: { user: 'Ed', playhead: 2, role: 'editor' } }]);

    const other = member('viewer', 'link-b');
    expect(presence.receive(other, update([{ id: 5, clock: 5, state: { user: 'V' } }]))).toMatch(
      /another participant/,
    );
    expect(everyone()).toEqual([{ id: 5, clock: 4, state: { user: 'Ed', playhead: 2, role: 'editor' } }]);
  });

  it('keeps an id for the link it came with after the connection has gone', () => {
    const { presence, member, everyone } = room();
    const editor = member('editor', 'link-a');
    const viewer = member('viewer', 'link-b');
    presence.receive(editor, update([{ id: 5, clock: 3, state: { user: 'Ed' } }]));

    // The editor's connection drops. Everyone is told that entry 5 is gone, the viewer included,
    // who must not be able to have it now and keep the editor out when the tab is back.
    presence.leave(editor);
    expect(everyone()).toEqual([]);
    expect(presence.receive(viewer, update([{ id: 5, clock: 1000, state: { user: 'Not Ed' } }]))).toMatch(
      /another participant/,
    );
    expect(everyone()).toEqual([]);

    const back = member('editor', 'link-a');
    expect(presence.receive(back, update([{ id: 5, clock: 4, state: { user: 'Ed' } }]))).toBeNull();
    expect(everyone()).toEqual([{ id: 5, clock: 4, state: { user: 'Ed', role: 'editor' } }]);
    // The viewer has lost nothing by trying: its own entry is still its to announce.
    expect(presence.receive(viewer, update([{ id: 6, clock: 1, state: { user: 'Vera' } }]))).toBeNull();
    expect(everyone()).toHaveLength(2);
  });

  it('keeps an id with its connection when the entry was not renewed in time', () => {
    const { presence, member, everyone, removed } = room();
    const idle = presence.size;
    const editor = member('editor', 'link-a');
    const viewer = member('viewer', 'link-b');
    presence.receive(editor, update([{ id: 5, clock: 3, state: { user: 'Ed' } }]));
    presence.receive(viewer, update([{ id: 6, clock: 1, state: { user: 'Vera' } }]));

    // A tab in the background renews late. The room lets the entry lapse after thirty seconds
    // and says so to everyone, while the connection it came from is still there.
    lapse(presence, [5, 6]);
    expect(removed).toEqual([
      [
        { id: 5, clock: 3, state: null },
        { id: 6, clock: 1, state: null },
      ],
    ]);
    expect(everyone()).toEqual([]);
    expect(presence.size).toEqual(idle);

    expect(presence.receive(viewer, update([{ id: 5, clock: 500, state: { user: 'Not Ed' } }]))).toMatch(
      /another participant/,
    );
    expect(presence.receive(editor, update([{ id: 5, clock: 4, state: { user: 'Ed' } }]))).toBeNull();
    expect(everyone()).toEqual([{ id: 5, clock: 4, state: { user: 'Ed', role: 'editor' } }]);
    // One entry per connection holds for as long as the connection does.
    expect(presence.receive(viewer, update([{ id: 7, clock: 1, state: { user: 'Vera' } }]))).toMatch(
      /one presence entry/,
    );
    expect(presence.receive(viewer, update([{ id: 6, clock: 2, state: { user: 'Vera' } }]))).toBeNull();
    expect(everyone()).toHaveLength(2);
  });

  it('remembers the ids of those who left without end, but not without bound', () => {
    const { presence, member, everyone } = room();
    let now = 0;
    const visit = (link: string, id: number): void => {
      const tab = member('viewer', link);
      presence.receive(tab, update([{ id, clock: 1, state: {} }]), (now += 1000));
      presence.leave(tab);
    };
    const taken = (link: string, id: number): boolean => {
      const tab = member('viewer', link);
      const refusal = presence.receive(tab, update([{ id, clock: 2, state: {} }]), (now += 1000));
      presence.leave(tab);
      return refusal === null;
    };

    visit('link-a', 1);
    visit('link-a', 2);
    // One link coming and going under ever new ids pushes out its own oldest ones…
    for (let id = 1000; id < 3000; id++) visit('link-b', id);
    expect(taken('link-c', 1000)).toBe(true);
    expect(taken('link-c', 2999)).toBe(false);
    // …and not what somebody with another link may come back to.
    expect(taken('link-c', 1)).toBe(false);
    expect(taken('link-c', 2)).toBe(false);
    expect(taken('link-a', 1)).toBe(true);
    expect(everyone()).toEqual([]);
  });

  it('meters updates per connection, in number and in bytes', () => {
    const { presence, member, everyone } = room({ maxBytes: 1000 });
    const editor = member('editor');
    const big = (clock: number): Uint8Array => update([{ id: 1, clock, state: { pad: 'x'.repeat(880) } }]);
    const small = (clock: number): Uint8Array => update([{ id: 1, clock, state: { n: clock } }]);
    const start = Date.now();

    expect(
      presence.receive(editor, update([{ id: 1, clock: 1, state: { pad: 'x'.repeat(1000) } }]), start),
    ).toMatch(/larger than 1000 bytes/);
    // Two updates of the largest size at once, then one more for every half second that passes.
    expect(presence.receive(editor, big(1), start)).toBeNull();
    expect(presence.receive(editor, big(2), start)).toBeNull();
    expect(presence.receive(editor, big(3), start)).toMatch(/faster than they are relayed/);
    expect(presence.receive(editor, big(4), start + 500)).toBeNull();

    // Small updates: forty at once (a reconnect sends two), then twenty a second.
    const later = start + 60_000;
    let taken = 0;
    for (let i = 0; i < 100; i++) if (presence.receive(editor, small(10 + i), later) === null) taken++;
    expect(taken).toBe(40);
    taken = 0;
    for (let i = 0; i < 100; i++)
      if (presence.receive(editor, small(200 + i), later + 1000) === null) taken++;
    expect(taken).toBe(20);
    // What was refused is not half applied: the last state taken is the one everyone sees.
    expect(everyone()).toEqual([{ id: 1, clock: 219, state: { n: 219, role: 'editor' } }]);

    // Another connection has an allowance of its own.
    const viewer = member('viewer');
    expect(presence.receive(viewer, update([{ id: 2, clock: 1, state: {} }]), later + 1000)).toBeNull();
  });

  it('meters the connections made with one link together as well', () => {
    const { presence, member } = room({ maxEntries: 100 });
    const start = Date.now();
    // Sixty sockets opened with one link, each within what a connection may send.
    const tabs = Array.from({ length: 60 }, () => member('viewer', 'link-v'));
    let taken = 0;
    for (let round = 1; round <= 20; round++) {
      tabs.forEach((tab, i) => {
        if (presence.receive(tab, update([{ id: 100 + i, clock: round, state: {} }]), start) === null)
          taken++;
      });
    }
    // Ten times what one connection may send at once, not sixty times.
    expect(taken).toBe(400);
    taken = 0;
    tabs.forEach((tab, i) => {
      if (presence.receive(tab, update([{ id: 100 + i, clock: 50, state: {} }]), start + 1000) === null) {
        taken++;
      }
    });
    expect(taken).toBe(60);

    // Someone with another link is not held up by them.
    const editor = member('editor', 'link-e');
    expect(presence.receive(editor, update([{ id: 1, clock: 1, state: {} }]), start)).toBeNull();
  });

  it('holds what the connections of one link show together to the size of one update', () => {
    const { presence, member, everyone } = room({ maxBytes: 1000, maxEntries: 100 });
    let now = 0;
    const later = (): number => (now += 10_000);
    const tabs = Array.from({ length: 5 }, () => member('viewer', 'link-v'));

    // Three sockets with 300 bytes each are within it, a fourth is not, whatever its size…
    for (let i = 0; i < 3; i++) expect(presence.receive(tabs[i], sized(10 + i, 1, 300), later())).toBeNull();
    expect(presence.receive(tabs[3], sized(13, 1, 300), later())).toMatch(
      /as much as one link may, 1000 bytes/,
    );
    expect(presence.receive(tabs[3], sized(13, 2, 101), later())).toMatch(/as much as one link may/);
    expect(presence.receive(tabs[3], sized(13, 3, 100), later())).toBeNull();
    expect(everyone().map((entry) => entry.id)).toEqual([10, 11, 12, 13]);
    // …and so is one of the three growing, while it may change and shrink as it likes.
    expect(presence.receive(tabs[0], sized(10, 2, 301), later())).toMatch(/as much as one link may/);
    expect(presence.receive(tabs[0], sized(10, 3, 300), later())).toBeNull();
    expect(presence.receive(tabs[0], sized(10, 4, 200), later())).toBeNull();
    expect(presence.receive(tabs[3], sized(13, 4, 200), later())).toBeNull();

    // A state at a clock that is not taken leaves the books as they are: the entry it would
    // have replaced is still the one that is shown.
    expect(presence.receive(tabs[1], sized(11, 1, 50), later())).toBeNull();
    expect(presence.receive(tabs[4], sized(14, 1, 100), later())).toMatch(/as much as one link may/);

    // What a connection showed is free again when it is gone, said to be gone, or taken over.
    presence.leave(tabs[1]);
    expect(presence.receive(tabs[4], sized(14, 2, 300), later())).toBeNull();
    presence.receive(tabs[2], update([{ id: 12, clock: 2, state: null }]), later());
    expect(presence.receive(tabs[0], sized(10, 5, 500), later())).toBeNull();
    const again = member('viewer', 'link-v');
    expect(presence.receive(again, sized(14, 3, 300), later())).toBeNull();
    presence.leave(tabs[4]);
    expect(everyone().map((entry) => entry.id)).toEqual([10, 13, 14]);
    expect(presence.receive(tabs[2], sized(12, 3, 50), later())).toMatch(/as much as one link may/);

    // Someone with another link has a share of their own.
    const editor = member('editor', 'link-e');
    expect(presence.receive(editor, sized(1, 1, 1000), later())).toBeNull();
  });

  it('holds what a room shows in all to four times that', () => {
    const { presence, member, everyone } = room({ maxBytes: 1000 });
    let now = 0;
    const later = (): number => (now += 10_000);
    const members = Array.from({ length: 5 }, (_, i) => member('editor', `link-${i}`));
    for (let i = 0; i < 4; i++)
      expect(presence.receive(members[i], sized(i + 1, 1, 1000), later())).toBeNull();
    expect(presence.receive(members[4], sized(5, 1, 100), later())).toMatch(
      /the room already holds as much presence as it keeps, 4000 bytes/,
    );
    // Nobody who is in loses by it.
    expect(presence.receive(members[0], sized(1, 2, 1000), later())).toBeNull();
    expect(presence.receive(members[1], sized(2, 2, 900), later())).toBeNull();
    expect(presence.receive(members[4], sized(5, 2, 100), later())).toBeNull();
    expect(everyone()).toHaveLength(5);
  });

  it('gives back what an entry held when it was not renewed', () => {
    const { presence, member, everyone } = room({ maxBytes: 1000 });
    const first = member('viewer', 'link-v');
    const second = member('viewer', 'link-v');
    expect(presence.receive(first, sized(1, 1, 900))).toBeNull();
    expect(presence.receive(second, sized(2, 1, 900))).toMatch(/as much as one link may/);
    lapse(presence, [1]);
    expect(everyone()).toEqual([]);
    expect(presence.receive(second, sized(2, 2, 900))).toBeNull();
    expect(presence.receive(first, sized(1, 2, 900))).toMatch(/as much as one link may/);
  });

  it('does not read an update that lists more entries than the room has places', () => {
    const { presence, member, everyone } = room({ maxEntries: 8 });
    const viewer = member('viewer');
    const many = Array.from({ length: 9 }, (_, i) => ({ id: 50 + i, clock: 1, state: i === 0 ? {} : null }));
    expect(presence.receive(viewer, update(many))).toMatch(/more than 8 entries/);
    expect(everyone()).toEqual([]);
    expect(presence.receive(viewer, update(many.slice(0, 8)))).toBeNull();
    expect(everyone()).toHaveLength(1);
  });

  it('throws on an update it could not store and send on, and keeps no part of it', () => {
    const { presence, member, everyone } = room();
    const viewer = member('viewer');
    const frame = (states: string[]): Uint8Array => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, states.length);
      states.forEach((state, i) => {
        encoding.writeVarUint(encoder, 70 + i);
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarString(encoder, state);
      });
      return encoding.toUint8Array(encoder);
    };
    const deep = '{"a":' + '['.repeat(40) + ']'.repeat(40) + '}';
    for (const broken of [deep, '{not json', '[]', '"text"', '7']) {
      expect(() => presence.receive(viewer, frame(['{"user":"Vera"}', broken]))).toThrow();
      expect(everyone()).toEqual([]);
    }
    expect(() => presence.receive(viewer, Uint8Array.from([3, 1, 1]))).toThrow();
    // It still has its one entry to announce.
    expect(presence.receive(viewer, frame(['{"user":"Vera"}']))).toBeNull();
    expect(everyone()).toHaveLength(1);
  });

  it('takes no state for the id of its own awareness instance', () => {
    const { doc, presence, member, everyone } = room();
    const viewer = member('viewer');
    // y-protocols would renew such a state for ever and let nobody remove it.
    expect(
      presence.receive(viewer, update([{ id: doc.clientID, clock: 50, state: { user: 'Server' } }])),
    ).toBeNull();
    expect(everyone()).toEqual([]);
    expect(presence.receive(viewer, update([{ id: 3, clock: 1, state: { user: 'Vera' } }]))).toBeNull();
    expect(everyone()).toHaveLength(1);
  });

  it('lets a connection whose first announcement did not count try again', () => {
    const { presence, member, everyone } = room();
    const idle = presence.size;
    // y-protocols only takes a state whose clock is ahead of the one it knows, and it starts at 0.
    const early = member('editor');
    expect(presence.receive(early, update([{ id: 9, clock: 0, state: { user: 'Ed' } }]))).toBeNull();
    expect(everyone()).toEqual([]);
    expect(presence.receive(early, update([{ id: 9, clock: 1, state: { user: 'Ed' } }]))).toBeNull();
    expect(everyone()).toEqual([{ id: 9, clock: 1, state: { user: 'Ed', role: 'editor' } }]);
    presence.leave(early);
    expect(presence.size).toEqual(idle);
  });
});
