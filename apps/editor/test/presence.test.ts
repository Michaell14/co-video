import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { colorForId, initials, type PresenceState } from '@tandem/core';
import {
  displayName,
  MAX_DRAGGING,
  MAX_NAME,
  MAX_PEERS,
  MAX_SELECTION,
  PeerList,
  published,
  readPeers,
  readPresence,
  readUser,
} from '../src/session/presence';

const good: PresenceState = {
  user: { id: 'u1', name: 'Swift Otter', color: '#22d3ee' },
  role: 'editor',
  playhead: 48,
  playing: true,
  selection: ['c1', 'c2'],
  cursor: { area: 'timeline', x: 120, y: 't1' },
  dragging: [{ id: 'c1', start: 10, duration: 30, trackId: 't1' }],
  page: 'color',
};

/** Values no field of a presence state is meant to hold. */
const HOSTILE: unknown[] = [
  undefined,
  null,
  true,
  0,
  7,
  -1,
  NaN,
  Infinity,
  -Infinity,
  1e300,
  '',
  'x',
  'x'.repeat(1_000_000),
  'url(https://example.com/x.png)',
  '__proto__',
  'constructor',
  [],
  [7],
  [null, undefined, {}, [], 'x'.repeat(5000)],
  Array.from({ length: 20_000 }, (_, i) => `id${i}`),
  Array.from({ length: 20_000 }, (_, i) => ({ id: `c${i}`, start: i, duration: 5, trackId: 't1' })),
  {},
  { length: 3 },
  { id: 7, name: 7, color: 7 },
  { area: 'viewer', x: 'left', y: {} },
  { area: 'timeline', x: NaN, y: 7 },
  { toString: 'no' },
];

const isId = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isFrame = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Everything the interface relies on when it draws a peer, checked the hard way. */
function expectWellFormed(p: PresenceState): void {
  expect(isId(p.user.id)).toBe(true);
  expect(typeof p.user.name).toBe('string');
  expect(Array.from(p.user.name).length).toBeLessThanOrEqual(MAX_NAME);
  expect(p.user.name.trim()).not.toBe('');
  expect(p.user.color).toMatch(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/);
  expect(['owner', 'editor', 'commenter', 'viewer']).toContain(p.role);
  expect(isFrame(p.playhead)).toBe(true);
  expect(typeof p.playing).toBe('boolean');
  expect(Array.isArray(p.selection)).toBe(true);
  expect(p.selection.length).toBeLessThanOrEqual(MAX_SELECTION);
  expect(p.selection.every(isId)).toBe(true);
  if (p.cursor !== null) {
    expect(['timeline', 'viewer']).toContain(p.cursor.area);
    expect(Number.isFinite(p.cursor.x)).toBe(true);
    if (p.cursor.area === 'viewer') {
      expect(p.cursor.x).toBeGreaterThanOrEqual(0);
      expect(p.cursor.x).toBeLessThanOrEqual(1);
      expect(typeof p.cursor.y === 'number' && p.cursor.y >= 0 && p.cursor.y <= 1).toBe(true);
    } else {
      expect(isId(p.cursor.y)).toBe(true);
    }
  }
  if (p.dragging !== null) {
    expect(Array.isArray(p.dragging)).toBe(true);
    expect(p.dragging.length).toBeLessThanOrEqual(MAX_DRAGGING);
    for (const g of p.dragging) {
      expect(isId(g.id) && isId(g.trackId) && isFrame(g.start) && isFrame(g.duration)).toBe(true);
    }
  }
  expect(['edit', 'color', 'audio']).toContain(p.page);
  // What the top bar, the timeline and the viewer do with a peer.
  expect(() => {
    initials(p.user.name);
    for (const id of p.selection) id.trim();
    (p.dragging ?? []).map((g) => g.start * 2);
  }).not.toThrow();
}

describe('readPresence', () => {
  it('leaves a well-formed state as it is', () => {
    expect(readPresence(good)).toEqual(good);
    expect(readPresence(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it('takes nothing that does not say who it is about', () => {
    for (const raw of HOSTILE) expect(readPresence(raw)).toBeNull();
    for (const user of HOSTILE) expect(readPresence({ ...good, user })).toBeNull();
    for (const id of HOSTILE) {
      const state = readPresence({ ...good, user: { ...good.user, id } });
      // Any short string tells people apart, odd as it may look.
      if (isId(id)) expectWellFormed(state!);
      else expect(state).toBeNull();
    }
    expect(readPresence({ ...good, user: { name: 'No id', color: '#ffffff' } })).toBeNull();
  });

  it('makes a typed state of hostile values in every field', () => {
    const fields = ['role', 'playhead', 'playing', 'selection', 'cursor', 'dragging', 'page'] as const;
    for (const field of fields) {
      HOSTILE.forEach((value, i) => {
        const state = readPresence({ ...good, [field]: value });
        expect(state, `${field} = hostile value ${i}`).not.toBeNull();
        expectWellFormed(state!);
      });
    }
    for (const field of ['name', 'color'] as const) {
      for (const value of HOSTILE) {
        const state = readPresence({ ...good, user: { ...good.user, [field]: value } });
        expect(state).not.toBeNull();
        expectWellFormed(state!);
      }
    }
    // Every field wrong at once.
    for (const value of HOSTILE) {
      const all = Object.fromEntries(fields.map((f) => [f, value]));
      const state = readPresence({ ...all, user: { id: 'u1', name: value, color: value } });
      expectWellFormed(state!);
    }
  });

  it('reads the frame that put every editor on the crash screen', () => {
    const state = readPresence({
      user: { id: 'v', name: 12345, color: '#22d3ee' },
      role: 'viewer',
      playhead: 0,
      playing: false,
      selection: 7,
      cursor: 'x',
      dragging: 5,
      page: 'edit',
    });
    expect(state).toEqual({
      user: { id: 'v', name: 'Guest', color: '#22d3ee' },
      role: 'viewer',
      playhead: 0,
      playing: false,
      selection: [],
      cursor: null,
      dragging: [],
      page: 'edit',
    });
  });

  it('falls back field by field', () => {
    const read = (patch: object) => readPresence({ ...good, ...patch })!;
    expect(read({ role: 'admin' }).role).toBe('viewer');
    expect(read({ role: 'toString' }).role).toBe('viewer');
    expect(read({ playhead: '12' }).playhead).toBe(0);
    expect(read({ playhead: -40 }).playhead).toBe(0);
    expect(read({ playhead: 1e300 }).playhead).toBe(100_000_000);
    expect(read({ playing: 'yes' }).playing).toBe(false);
    expect(read({ page: 'nowhere' }).page).toBe('edit');
    expect(read({ page: 'audio' }).page).toBe('audio');
    expect(read({ dragging: undefined }).dragging).toBeNull();
    expect(read({ cursor: { area: 'viewer', x: 4, y: -2 } }).cursor).toEqual({ area: 'viewer', x: 1, y: 0 });
    expect(read({ cursor: { area: 'viewer', x: 0.2, y: 't1' } }).cursor).toBeNull();
    expect(read({ cursor: { area: 'timeline', x: 30, y: 0.5 } }).cursor).toBeNull();
    expect(read({ cursor: { area: 'elsewhere', x: 1, y: 1 } }).cursor).toBeNull();
  });

  it('keeps the entries of a list it can use and drops the rest', () => {
    const selection = [1, null, 'a', {}, ['b'], 'b', '', 'x'.repeat(65)];
    expect(readPresence({ ...good, selection })!.selection).toEqual(['a', 'b']);
    const drag = { id: 'c1', start: 4, duration: 9, trackId: 't1' };
    const dragging = [5, null, { id: 'c2' }, { ...drag, start: NaN }, { ...drag, trackId: 7 }, drag];
    expect(readPresence({ ...good, dragging })!.dragging).toEqual([drag]);
    // Extra fields on an entry are not carried along.
    expect(readPresence({ ...good, dragging: [{ ...drag, style: 'x' }] })!.dragging).toEqual([drag]);
  });

  it('cuts long lists instead of refusing the state', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `clip${i}`);
    const state = readPresence({
      ...good,
      selection: ids,
      dragging: ids.map((id) => ({ id, start: 0, duration: 1, trackId: 't1' })),
    })!;
    expect(state.selection).toEqual(ids.slice(0, MAX_SELECTION));
    expect(state.dragging!.map((g) => g.id)).toEqual(ids.slice(0, MAX_DRAGGING));
  });

  it('only lets a hex colour through, and derives one from the id otherwise', () => {
    const color = (v: unknown) => readPresence({ ...good, user: { ...good.user, color: v } })!.user.color;
    expect(color('#ABC')).toBe('#aabbcc');
    expect(color('#FF5D5D')).toBe('#ff5d5d');
    for (const bad of ['red', 'url(https://example.com/x.png)', '#12', 'var(--accent)', 7, null]) {
      expect(color(bad)).toBe(colorForId('u1'));
    }
  });
});

describe('displayName', () => {
  it('is one bounded line, or a stand-in', () => {
    expect(displayName('  Swift\n\tOtter  ')).toBe('Swift Otter');
    expect(displayName('   ')).toBe('Guest');
    expect(displayName(12345)).toBe('Guest');
    expect(displayName(null)).toBe('Guest');
    expect(displayName({ toString: () => 'x' })).toBe('Guest');
    expect(Array.from(displayName('n'.repeat(6_000_000)))).toHaveLength(MAX_NAME);
    // Cut between characters, not inside one.
    expect(displayName('🎬'.repeat(200))).toBe('🎬'.repeat(MAX_NAME));
  });
});

describe('readUser', () => {
  it('reads a stored profile the same way as a peer', () => {
    expect(readUser({ id: 'abc', name: 'Me', color: '#51cf66' })).toEqual({
      id: 'abc',
      name: 'Me',
      color: '#51cf66',
    });
    expect(readUser({ id: 'abc', name: 5, color: 'javascript:1' })).toEqual({
      id: 'abc',
      name: 'Guest',
      color: colorForId('abc'),
    });
    expect(readUser({ name: 'No id' })).toBeNull();
    expect(readUser('abc')).toBeNull();
  });
});

describe('readPeers', () => {
  it('lists everyone but this client, in a stable order', () => {
    const states = new Map<number, unknown>([
      [30, { ...good, user: { ...good.user, id: 'c' } }],
      [10, { ...good, user: { ...good.user, id: 'a' } }],
      [20, 'not a state'],
      [25, { ...good, user: 'nobody' }],
      [5, good],
    ]);
    const peers = readPeers(states, 5);
    expect(peers.map((p) => [p.clientId, p.user.id])).toEqual([
      [10, 'a'],
      [30, 'c'],
    ]);
  });

  it('never reads an entry for its own id, whatever the room holds under it', () => {
    const forged = { ...good, user: { id: 'x', name: 'Mallory (owner)', color: '#ff0000' }, role: 'owner' };
    expect(readPeers(new Map([[7, forged]]), 7)).toEqual([]);
  });

  it('draws no more people than a room has places', () => {
    const states = new Map<number, unknown>();
    for (let i = 0; i < 5000; i++) states.set(i + 1, { ...good, user: { ...good.user, id: `u${i}` } });
    const peers = readPeers(states, 0);
    expect(peers).toHaveLength(MAX_PEERS);
    expect(peers[0].clientId).toBe(1);
  });

  it('reads a state once for as long as it stands', () => {
    const a = { ...good };
    const b = { ...good, user: { ...good.user, id: 'b' } };
    const states = new Map<number, unknown>([
      [1, a],
      [2, b],
    ]);
    const seen = new WeakMap();
    const first = readPeers(states, 0, seen);
    states.set(2, { ...b, playhead: 99 });
    const second = readPeers(states, 0, seen);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1].playhead).toBe(99);
  });
});

describe('published', () => {
  it('sends short lists as they are', () => {
    expect(published(good)).toBe(good);
  });

  it('cuts a long selection and a long drag', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `clip${i}`);
    const out = published({
      ...good,
      selection: ids,
      dragging: ids.map((id) => ({ id, start: 0, duration: 10, trackId: 't1' })),
    });
    expect(out.selection).toEqual(ids.slice(0, MAX_SELECTION));
    expect(out.dragging).toHaveLength(MAX_DRAGGING);
    expect(JSON.stringify(out).length).toBeLessThan(8000);
    // What goes out reads back whole on the other side.
    expect(readPresence(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });
});

describe('PeerList', () => {
  const docs: Y.Doc[] = [];
  const room = (): Awareness => {
    const doc = new Y.Doc();
    docs.push(doc);
    return new Awareness(doc);
  };
  afterEach(() => {
    for (const doc of docs.splice(0)) doc.destroy();
  });

  it('is not disturbed by this client’s own cursor and playhead', () => {
    const mine = room();
    const theirs = room();
    theirs.setLocalState(good);
    applyAwarenessUpdate(mine, encodeAwarenessUpdate(theirs, [theirs.clientID]), 'remote');
    const peers = new PeerList(mine);
    let changes = 0;
    peers.subscribe(() => changes++);
    const before = peers.get();
    expect(before.map((p) => p.user.name)).toEqual(['Swift Otter']);

    mine.setLocalState({ ...good, playhead: 1 });
    mine.setLocalStateField('cursor', { area: 'viewer', x: 0.5, y: 0.5 });
    expect(changes).toBe(0);
    expect(peers.get()).toBe(before);

    theirs.setLocalStateField('playhead', 77);
    applyAwarenessUpdate(mine, encodeAwarenessUpdate(theirs, [theirs.clientID]), 'remote');
    expect(changes).toBe(1);
    expect(peers.get()).not.toBe(before);
    expect(peers.get()[0].playhead).toBe(77);
    // Between changes every reader gets the same list.
    expect(peers.get()).toBe(peers.get());

    peers.destroy();
    theirs.setLocalStateField('playhead', 78);
    applyAwarenessUpdate(mine, encodeAwarenessUpdate(theirs, [theirs.clientID]), 'remote');
    expect(changes).toBe(1);
  });
});
