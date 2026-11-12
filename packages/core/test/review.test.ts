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
    sync();
    a.remove(id);
    b.reply(id, { ...ben, text: 'too late' });
    sync();
    for (const s of [a, b]) {
      expect(s.get().map((c) => c.text)).toEqual(['Keep me']);
      expect(s.get()[0].replies.map((r) => r.text)).toEqual(['kept']);
    }
    expect(Array.from(a.doc.getMap('commentFields').keys())).toEqual([]);
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
    });
    // A colour is a colour: nothing that could make the panel fetch something.
    const colours = Object.fromEntries(s.get().map((c) => [c.id, c.authorColor]));
    expect(colours).toEqual({ bad: '#64748b', remote: '#64748b', short: '#ff00aa', odd: '#64748b' });
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
