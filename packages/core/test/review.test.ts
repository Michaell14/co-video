import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ReviewStore, initials } from '../src';

const ana = { authorId: 'u1', authorName: 'Ana', authorColor: '#ff5d5d' };
const ben = { authorId: 'u2', authorName: 'Ben', authorColor: '#51cf66' };

/** Two reviewers who only exchange updates when `sync()` is called, like one of them being offline. */
function reviewers() {
  const a = new ReviewStore();
  const b = new ReviewStore();
  const sync = () => {
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
  };
  return { a, b, sync };
}

describe('ReviewStore merging', () => {
  it('keeps both replies when two people answer the same comment at once', () => {
    const { a, b, sync } = reviewers();
    const id = a.add({ ...ana, frame: 10, text: 'Too long?', x: null, y: null });
    sync();
    a.reply(id, { ...ana, text: 'reply from A' });
    b.reply(id, { ...ben, text: 'reply from B' });
    a.reply(id, { ...ana, text: 'second from A' });
    sync();
    const texts = a.get()[0].replies.map((r) => r.text);
    expect(texts.slice().sort()).toEqual(['reply from A', 'reply from B', 'second from A']);
    // Both sides list them in the same order.
    expect(b.get()[0].replies).toEqual(a.get()[0].replies);
    expect(new Set(a.get()[0].replies.map((r) => r.id)).size).toBe(3);
  });

  it('keeps a resolve and a concurrent reply, whichever side wins the race', () => {
    for (const resolver of ['a', 'b'] as const) {
      const { a, b, sync } = reviewers();
      const id = a.add({ ...ana, frame: 10, text: 'Fix the colour', x: 0.2, y: 0.8 });
      sync();
      const [one, two] = resolver === 'a' ? [a, b] : [b, a];
      one.update(id, { resolved: true });
      two.reply(id, { ...ben, text: 'Done' });
      sync();
      for (const s of [a, b]) {
        const c = s.get()[0];
        expect(c.resolved).toBe(true);
        expect(c.replies.map((r) => r.text)).toEqual(['Done']);
        expect([c.x, c.y]).toEqual([0.2, 0.8]);
      }
    }
  });

  it('merges concurrent edits to different fields and settles on one value for the same field', () => {
    const { a, b, sync } = reviewers();
    const id = a.add({ ...ana, frame: 10, text: 'Draft', x: null, y: null });
    sync();
    a.update(id, { text: 'Final wording' });
    b.update(id, { frame: 48, resolved: true });
    sync();
    for (const s of [a, b]) {
      expect(s.get()[0]).toMatchObject({ text: 'Final wording', frame: 48, resolved: true });
    }
    a.update(id, { text: 'From A' });
    b.update(id, { text: 'From B' });
    sync();
    expect(a.get()[0].text).toBe(b.get()[0].text);
    expect(['From A', 'From B']).toContain(a.get()[0].text);
  });

  it('reads comments written as one value and merges new replies and edits onto them', () => {
    const { a, b, sync } = reviewers();
    // What earlier versions stored: the whole comment, replies included, under one key.
    a.doc.getMap('comments').set('old', {
      id: 'old',
      frame: 30,
      text: 'From last week',
      ...ana,
      createdAt: 1000,
      resolved: true,
      x: null,
      y: null,
      replies: [{ id: 'r1', text: 'Agreed', ...ben, createdAt: 2000 }],
    });
    sync();
    expect(b.get()).toEqual([
      {
        id: 'old',
        frame: 30,
        text: 'From last week',
        ...ana,
        createdAt: 1000,
        resolved: true,
        x: null,
        y: null,
        replies: [{ id: 'r1', text: 'Agreed', ...ben, createdAt: 2000 }],
      },
    ]);

    a.reply('old', { ...ana, text: 'Reopening this' });
    b.update('old', { resolved: false });
    b.reply('old', { ...ben, text: 'Why?' });
    sync();
    for (const s of [a, b]) {
      const c = s.get()[0];
      expect(c.resolved).toBe(false);
      expect(c.replies[0].text).toBe('Agreed');
      expect(c.replies.map((r) => r.text).sort()).toEqual(['Agreed', 'Reopening this', 'Why?']);
    }
    expect(a.get()).toEqual(b.get());
    // The stored comment itself was left as it was.
    expect((a.doc.getMap('comments').get('old') as { replies: unknown[] }).replies).toHaveLength(1);
  });

  it('removes a comment together with its replies and edits, even against a concurrent reply', () => {
    const { a, b, sync } = reviewers();
    const id = a.add({ ...ana, frame: 10, text: 'Remove me', x: null, y: null });
    const other = a.add({ ...ana, frame: 20, text: 'Keep me', x: null, y: null });
    a.reply(id, { ...ana, text: 'one' });
    a.reply(other, { ...ana, text: 'kept' });
    a.update(id, { resolved: true });
    a.move(
      new Map([
        [id, 15],
        [other, 25],
      ]),
    );
    sync();
    a.remove(id);
    b.reply(id, { ...ben, text: 'too late' });
    sync();
    for (const s of [a, b]) {
      expect(s.get().map((c) => c.text)).toEqual(['Keep me']);
      expect(s.get()[0].replies.map((r) => r.text)).toEqual(['kept']);
      expect(Array.from(s.doc.getMap('commentFields').keys())).toEqual([]);
      expect(s.doc.getArray('commentFrames').toArray()).toEqual([[other, 25]]);
    }
  });

  it('notifies once per change and ignores edits to comments that do not exist', () => {
    const s = new ReviewStore();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    const id = s.add({ ...ana, frame: 10, text: 'Hi', x: null, y: null });
    expect(calls).toBe(1);
    s.update(id, { text: 'Hello', resolved: true, frame: 12 });
    expect(calls).toBe(2);
    // Nothing changes, so nothing is written or announced.
    s.update(id, { text: 'Hello', resolved: true });
    s.update('missing', { resolved: true });
    s.reply('missing', { ...ben, text: 'anyone?' });
    expect(calls).toBe(2);
    s.reply(id, { ...ben, text: 'Hey' });
    expect(calls).toBe(3);
    s.remove(id);
    expect(calls).toBe(4);
    expect(s.get()).toEqual([]);
    off();
    s.destroy();
    s.doc.getMap('comments').set('late', { text: 'x', frame: 0 });
    expect(calls).toBe(4);
    expect(s.get()).toEqual([]);
  });

  it('moves several comments as one change and writes nothing but the frames that differ', () => {
    const { a, b, sync } = reviewers();
    const first = a.add({ ...ana, frame: 10, text: 'First', x: null, y: null });
    const second = a.add({ ...ben, frame: 20, text: 'Second', x: 0.5, y: 0.5 });
    const third = a.add({ ...ana, frame: 30, text: 'Third', x: null, y: null });
    sync();
    let calls = 0;
    a.subscribe(() => calls++);
    let updates = 0;
    a.doc.on('update', () => updates++);
    a.move(
      new Map([
        [first, 40],
        [second, 5],
        [third, 30],
        ['missing', 7],
      ]),
    );
    expect([calls, updates]).toEqual([1, 1]);
    // The list is in the order of the frames again.
    expect(a.get().map((c) => [c.text, c.frame])).toEqual([
      ['Second', 5],
      ['Third', 30],
      ['First', 40],
    ]);
    // Where they went is in the list of moves. Nothing of a comment was given a key.
    expect(a.doc.getArray('commentFrames').toArray()).toEqual([
      [first, 40],
      [second, 5],
    ]);
    expect(Array.from(a.doc.getMap('commentFields').keys())).toEqual([]);
    a.move(new Map());
    a.move(new Map([[first, 40]]));
    expect([calls, updates]).toEqual([1, 1]);
    // Someone who resolves and answers at that moment keeps both, and the author is who it was.
    b.update(second, { resolved: true });
    b.reply(second, { ...ana, text: 'Done' });
    sync();
    for (const s of [a, b]) {
      expect(s.get()[0]).toMatchObject({ id: second, frame: 5, resolved: true, authorName: 'Ben', x: 0.5 });
      expect(s.get()[0].replies.map((r) => r.text)).toEqual(['Done']);
    }
  });
});

/** How many structs a document holds: what a server counts a document's size in. */
const structs = (doc: Y.Doc): number => Y.decodeUpdate(Y.encodeStateAsUpdate(doc)).structs.length;

describe('ReviewStore frames', () => {
  const frames = (s: ReviewStore): Record<string, number> =>
    Object.fromEntries(s.get().map((c) => [c.text, c.frame]));

  it('moves comments any number of times without the document growing with each move', () => {
    const a = new ReviewStore();
    // What everyone else holds, the server among them: the document as its updates make it.
    const held = new Y.Doc();
    a.doc.on('update', (update: Uint8Array) => Y.applyUpdate(held, update));
    const ids = Array.from({ length: 100 }, (_, i) =>
      a.add({ ...ana, frame: 100 + i * 10, text: `Note ${i}`, x: null, y: null }),
    );
    const posted = structs(held);
    expect(posted).toBe(100);
    // Edits that move time, one after the other: each moves the comments from some frame on.
    const move = (round: number): void => {
      const from = (round * 37) % 100;
      a.move(new Map(a.get().flatMap((c, i) => (i >= from ? [[c.id, c.frame + (round % 2 ? 3 : -2)]] : []))));
    };
    for (let round = 0; round < 400; round++) move(round);
    // The entries that stand are in a few stretches of the list, far fewer than there are comments.
    const settled = { structs: structs(held), bytes: Y.encodeStateAsUpdate(held).byteLength };
    expect(settled.structs).toBeLessThan(posted + 20);
    // A key for each frame would leave a struct behind for every comment a move moves: some
    // 20,000 for these. The list holds no more after them than before.
    for (let round = 400; round < 800; round++) move(round);
    expect(structs(held)).toBeLessThanOrEqual(settled.structs);
    expect(Y.encodeStateAsUpdate(held).byteLength).toBeLessThan(settled.bytes + 100);
    // And what is held reads as what was written.
    expect(new ReviewStore(held).get()).toEqual(a.get());
    expect(a.get()).toHaveLength(ids.length);
  });

  it('settles on one frame for a comment that two people move at the same moment', () => {
    for (const first of ['a', 'b'] as const) {
      const { a, b } = reviewers();
      const both = a.add({ ...ana, frame: 10, text: 'Both', x: null, y: null });
      const one = a.add({ ...ana, frame: 20, text: 'One', x: null, y: null });
      const other = a.add({ ...ana, frame: 30, text: 'Other', x: null, y: null });
      const sync = () => {
        const [from, to] = first === 'a' ? [a, b] : [b, a];
        Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
        Y.applyUpdate(from.doc, Y.encodeStateAsUpdate(to.doc, Y.encodeStateVector(from.doc)));
      };
      sync();
      a.move(
        new Map([
          [both, 110],
          [one, 120],
        ]),
      );
      a.move(new Map([[both, 115]]));
      b.move(
        new Map([
          [both, 210],
          [other, 230],
        ]),
      );
      sync();
      expect(frames(a)).toEqual(frames(b));
      // What only one of them moved is where that one put it.
      expect(frames(a)).toMatchObject({ One: 120, Other: 230 });
      expect([115, 210]).toContain(frames(a).Both);
      // The next move of it leaves a single entry, for everyone.
      b.move(new Map([[both, 300]]));
      sync();
      for (const s of [a, b]) {
        expect(frames(s)).toEqual({ Both: 300, One: 120, Other: 230 });
        const entries = s.doc.getArray<[string, number]>('commentFrames').toArray();
        expect(entries.filter(([id]) => id === both)).toEqual([[both, 300]]);
        expect(entries).toHaveLength(3);
      }
    }
  });

  it('writes the frames of many updates in one transaction as a single move', () => {
    const { a, b, sync } = reviewers();
    const ids = Array.from({ length: 40 }, (_, i) =>
      a.add({ ...ana, frame: i * 10, text: `Note ${i}`, x: null, y: null }),
    );
    a.move(new Map(ids.slice(20).map((id, i) => [id, 205 + i * 10])));
    sync();
    const before = structs(a.doc);
    let calls = 0;
    a.subscribe(() => calls++);
    let updates = 0;
    a.doc.on('update', () => updates++);
    // The way a change of frame rate re-times them: each by itself, all in one transaction.
    a.doc.transact(() => {
      for (const c of a.get()) a.update(c.id, { frame: c.frame * 2 });
      a.update(ids[1], { text: 'Reworded', frame: 21 });
    });
    expect([calls, updates]).toEqual([1, 2]);
    expect(a.get().map((c) => c.frame)).toEqual([
      0,
      21,
      ...ids.slice(2, 20).map((_, i) => (i + 2) * 20),
      ...ids.slice(20).map((_, i) => 410 + i * 20),
    ]);
    expect(a.get()[1].text).toBe('Reworded');
    // One struct for what was appended and one for the key of the text: the entries that were
    // replaced are deleted, and take up no more than they did.
    expect(structs(a.doc)).toBeLessThanOrEqual(before + 2);
    expect(a.doc.getArray('commentFrames')).toHaveLength(39);
    sync();
    expect(b.get()).toEqual(a.get());
    // A move after an update, in the same transaction, has the last word.
    a.doc.transact(() => {
      a.update(ids[0], { frame: 5 });
      a.move(new Map([[ids[0], 7]]));
    });
    expect(a.get()[0]).toMatchObject({ id: ids[0], frame: 7 });
  });

  it('reads a frame that has a key from before the list, until the comment is moved', () => {
    const { a, b, sync } = reviewers();
    const id = a.add({ ...ana, frame: 10, text: 'Re-timed last year', x: null, y: null });
    const other = a.add({ ...ben, frame: 20, text: 'Never moved', x: null, y: null });
    a.doc.getMap('commentFields').set(`${id}/frame`, 24);
    sync();
    for (const s of [a, b]) expect(frames(s)).toEqual({ 'Re-timed last year': 24, 'Never moved': 20 });
    // Nothing is written to put it where it is already.
    let updates = 0;
    b.doc.on('update', () => updates++);
    b.update(id, { frame: 24 });
    b.move(new Map([[other, 20]]));
    expect(updates).toBe(0);
    b.update(id, { frame: 48 });
    expect(updates).toBe(1);
    sync();
    for (const s of [a, b]) expect(frames(s)).toEqual({ 'Re-timed last year': 48, 'Never moved': 20 });
    a.remove(id);
    sync();
    expect(Array.from(b.doc.getMap('commentFields').keys())).toEqual([]);
    expect(b.doc.getArray('commentFrames')).toHaveLength(0);
  });
});

describe('ReviewStore with hostile data', () => {
  it('normalises whatever a commenter writes so the panel can always render it', () => {
    const s = new ReviewStore();
    const comments = s.doc.getMap('comments');
    s.doc.transact(() => {
      comments.set('bad', {
        text: 'x',
        frame: 0,
        authorName: 5,
        authorColor: { r: 1 },
        createdAt: 'yesterday',
        resolved: 'yes',
        x: 'left',
        y: NaN,
        replies: [
          null,
          'reply',
          { id: 7, text: 'no id' },
          { id: 'r0', text: 9 },
          { id: 'r1', text: 'ok', authorName: null, createdAt: {} },
        ],
      });
      comments.set('remote', { text: 'y', frame: 5, authorColor: 'url(https://tracker.example/p.png)' });
      comments.set('short', { text: 'z', frame: 9, authorColor: '#F0A' });
      comments.set('odd', { text: 'z', frame: 9, authorColor: '#f0a1b' });
      comments.set('nan', { text: 'x', frame: NaN });
      comments.set('noText', { frame: 3 });
      comments.set('null', null);
      comments.set('list', ['text', 0]);
      s.doc.getMap('commentFields').set('bad/text', 42);
      s.doc.getMap('commentFields').set('bad/frame', 'soon');
      s.doc.getMap('commentFields').set('bad/resolved', 1);
      s.doc.getMap('commentReplies').set('bad/r2', null);
      s.doc.getMap('commentReplies').set('bad/r3', { text: 'later', authorId: 3 });
      s.doc.getMap('commentReplies').set('noslash', { text: 'lost' });
      s.doc
        .getArray('commentFrames')
        .push(['bad', ['bad'], ['bad', 'soon'], [7, 3], null, { bad: 4 }, ['short', 12], ['short', NaN]]);
    });
    // A colour is a colour: nothing that could make the panel fetch something.
    const colours = Object.fromEntries(s.get().map((c) => [c.id, c.authorColor]));
    expect(colours).toEqual({ bad: '#64748b', remote: '#64748b', short: '#ff00aa', odd: '#64748b' });
    // A frame is a number, wherever it is written.
    expect(s.get().map((c) => [c.id, c.frame])).toEqual([
      ['bad', 0],
      ['remote', 5],
      ['odd', 9],
      ['short', 12],
    ]);
    expect(s.get().slice(0, 1)).toEqual([
      {
        id: 'bad',
        frame: 0,
        text: 'x',
        authorId: '',
        authorName: 'Unknown',
        authorColor: '#64748b',
        createdAt: 0,
        resolved: false,
        x: null,
        y: null,
        replies: [
          { id: 'r1', text: 'ok', authorId: '', authorName: 'Unknown', authorColor: '#64748b', createdAt: 0 },
          {
            id: 'r3',
            text: 'later',
            authorId: '',
            authorName: 'Unknown',
            authorColor: '#64748b',
            createdAt: 0,
          },
        ],
      },
    ]);
    // What the comments panel does with each entry.
    for (const c of s.get()) {
      expect(initials(c.authorName)).toBe('UN');
      for (const r of c.replies) expect(typeof r.id).toBe('string');
    }
  });
});
