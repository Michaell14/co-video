import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ProjectStore,
  makeClip,
  makeEffect,
  parseProjectFile,
  serializeProject,
  tracksOf,
  ReviewStore,
} from '../src';

/** Wire two docs together like a (perfect) network would. */
function connect(a: Y.Doc, b: Y.Doc) {
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b, u, 'remote');
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a, u, 'remote');
  });
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
}

describe('ProjectStore', () => {
  it('initialises a new document once', () => {
    const s = new ProjectStore();
    s.initIfEmpty({ name: 'Demo', width: 3840, height: 2160 });
    expect(s.get().settings.width).toBe(3840);
    expect(tracksOf(s.get()).video).toHaveLength(2);
    expect(tracksOf(s.get()).audio).toHaveLength(2);
    s.initIfEmpty({ name: 'Other' });
    expect(s.get().settings.name).toBe('Demo');
    // Initialisation is not an undo step.
    expect(s.canUndo).toBe(false);
  });

  it('round-trips clips and omits default fields from the document', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const clip = makeClip('video', track.id, { start: 10, duration: 50, opacity: 0.5 });
    s.commit([{ op: 'addClip', clip }]);
    expect(s.get().clips[clip.id]).toEqual(clip);
    const stored = (s.doc.getMap('clips').get(clip.id) as Y.Map<unknown>).toJSON();
    expect(stored.opacity).toBe(0.5);
    expect('rotation' in stored).toBe(false);
  });

  it('composes several edits to one entity inside a single commit', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const clip = makeClip('video', track.id, { start: 0, duration: 50 });
    s.commit([
      { op: 'addClip', clip },
      { op: 'updateClip', id: clip.id, patch: { start: 25 } },
      { op: 'updateClip', id: clip.id, patch: { opacity: 0.25 } },
    ]);
    expect(s.get().clips[clip.id].start).toBe(25);
    expect(s.get().clips[clip.id].opacity).toBe(0.25);
  });

  it('notifies subscribers once per commit and keeps untouched clips referentially stable', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const a = makeClip('video', track.id, { start: 0, duration: 10 });
    const b = makeClip('video', track.id, { start: 10, duration: 10 });
    s.commit([
      { op: 'addClip', clip: a },
      { op: 'addClip', clip: b },
    ]);
    let calls = 0;
    s.subscribe(() => calls++);
    const before = s.get().clips[b.id];
    s.commit([
      { op: 'updateClip', id: a.id, patch: { x: 0.1 } },
      { op: 'updateClip', id: a.id, patch: { y: 0.2 } },
    ]);
    expect(calls).toBe(1);
    expect(s.get().clips[b.id]).toBe(before);
    expect(s.get().clips[a.id].x).toBe(0.1);
  });

  it('undoes and redoes, merging gesture commits into one step', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const track = tracksOf(s.get()).video[0];
    const clip = makeClip('video', track.id, { duration: 10 });
    s.commit([{ op: 'addClip', clip }]);
    s.commit([{ op: 'updateClip', id: clip.id, patch: { x: 0.1 } }]);
    for (const x of [0.2, 0.3, 0.4])
      s.commit([{ op: 'updateClip', id: clip.id, patch: { x } }], { merge: true });
    expect(s.get().clips[clip.id].x).toBe(0.4);
    s.undo();
    expect(s.get().clips[clip.id].x).toBe(0);
    s.undo();
    expect(s.get().clips[clip.id]).toBeUndefined();
    s.redo();
    s.redo();
    expect(s.get().clips[clip.id].x).toBe(0.4);
  });

  it('converges between two peers with per-field merging', () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    expect(tracksOf(b.get()).video).toHaveLength(2);

    const track = tracksOf(a.get()).video[0];
    const clip = makeClip('video', track.id, { duration: 100 });
    a.commit([{ op: 'addClip', clip }]);
    expect(b.get().clips[clip.id]).toEqual(clip);

    // Concurrent edits to different fields of the same clip both survive.
    a.commit([{ op: 'updateClip', id: clip.id, patch: { start: 40 } }]);
    b.commit([
      { op: 'updateClip', id: clip.id, patch: { opacity: 0.3, effects: [makeEffect('gaussianBlur')] } },
    ]);
    for (const s of [a, b]) {
      const c = s.get().clips[clip.id];
      expect(c.start).toBe(40);
      expect(c.opacity).toBe(0.3);
      expect(c.effects).toHaveLength(1);
    }
    expect(a.get().clips).toEqual(b.get().clips);
  });

  it("only undoes the local user's edits", () => {
    const a = new ProjectStore();
    a.initIfEmpty();
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const track = tracksOf(a.get()).video[0];
    const ca = makeClip('video', track.id, { start: 0, duration: 10 });
    const cb = makeClip('video', track.id, { start: 50, duration: 10 });
    a.commit([{ op: 'addClip', clip: ca }]);
    b.commit([{ op: 'addClip', clip: cb }]);
    a.undo();
    expect(a.get().clips[ca.id]).toBeUndefined();
    expect(a.get().clips[cb.id]).toBeDefined();
    expect(b.get().clips[ca.id]).toBeUndefined();
    expect(b.get().clips[cb.id]).toBeDefined();
  });

  it('ignores malformed remote data instead of crashing', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const evil = new Y.Map<unknown>();
    s.doc.transact(() => {
      evil.set('trackId', 'nope');
      evil.set('type', 'video');
      evil.set('start', 'banana');
      evil.set('duration', -50);
      evil.set('speed', 0);
      evil.set('effects', 'not-an-array');
      s.doc.getMap('clips').set('evil', evil);
      s.doc.getMap('clips').set('junk', 42 as never);
    });
    const c = s.get().clips.evil;
    expect(c.start).toBe(0);
    expect(c.duration).toBe(1);
    expect(c.speed).toBe(1);
    expect(c.effects).toEqual([]);
    expect(s.get().clips.junk).toBeUndefined();
  });

  it('only accepts inline images as asset posters', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const put = (id: string, thumb: unknown) => {
      const m = new Y.Map<unknown>();
      m.set('kind', 'video');
      m.set('name', id);
      m.set('thumb', thumb);
      s.doc.getMap('assets').set(id, m);
    };
    s.doc.transact(() => {
      put('ok', 'data:image/jpeg;base64,AAAA');
      put('remote', 'https://tracker.example/pixel.png');
      put('script', 'javascript:alert(1)');
      put('svg', 'data:image/svg+xml;base64,AAAA');
    });
    const a = s.get().assets;
    expect(a.ok.thumb).toBe('data:image/jpeg;base64,AAAA');
    expect(a.remote.thumb).toBeNull();
    expect(a.script.thumb).toBeNull();
    expect(a.svg.thumb).toBeNull();
  });

  it('saves and loads project files', () => {
    const s = new ProjectStore();
    s.initIfEmpty({ name: 'File test' });
    const track = tracksOf(s.get()).video[0];
    s.commit([{ op: 'addClip', clip: makeClip('text', track.id, { duration: 30 }) }]);
    const text = serializeProject(s.get());
    const loaded = parseProjectFile(text)!;
    expect(loaded.settings.name).toBe('File test');
    expect(Object.keys(loaded.clips)).toHaveLength(1);
    expect(parseProjectFile('{"nope":1}')).toBeNull();
    expect(parseProjectFile('not json')).toBeNull();

    const t = new ProjectStore();
    t.initIfEmpty();
    t.replaceAll(loaded);
    expect(t.get().settings.name).toBe('File test');
    expect(Object.keys(t.get().clips)).toHaveLength(1);
    t.undo();
    expect(Object.keys(t.get().clips)).toHaveLength(0);
  });
});

describe('ReviewStore', () => {
  it('syncs comments and replies', () => {
    const a = new ReviewStore();
    const b = new ReviewStore();
    connect(a.doc, b.doc);
    const id = a.add({
      frame: 120,
      text: 'Tighten this cut',
      authorId: 'u1',
      authorName: 'Ana',
      authorColor: '#f00',
      x: null,
      y: null,
    });
    a.add({
      frame: 10,
      text: 'Love the open',
      authorId: 'u1',
      authorName: 'Ana',
      authorColor: '#f00',
      x: 0.5,
      y: 0.5,
    });
    expect(b.get().map((c) => c.frame)).toEqual([10, 120]);
    b.reply(id, { text: 'Done', authorId: 'u2', authorName: 'Ben', authorColor: '#0f0' });
    b.update(id, { resolved: true });
    const c = a.get().find((x) => x.id === id)!;
    expect(c.replies).toHaveLength(1);
    expect(c.resolved).toBe(true);
    a.remove(id);
    expect(b.get()).toHaveLength(1);
  });
});
