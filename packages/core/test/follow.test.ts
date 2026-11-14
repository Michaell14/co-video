import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  CommentMover,
  ProjectStore,
  ReviewStore,
  changeFrameRate,
  makeClip,
  openGap,
  rippleDelete,
  tracksOf,
} from '../src';
import type { Clip, Edit, Follow } from '../src';

const ana = { authorId: 'u1', authorName: 'Ana', authorColor: '#ff5d5d' };
const ben = { authorId: 'u2', authorName: 'Ben', authorColor: '#51cf66' };

/** One person: the project, the review beside it and what moves the comments with their edits. */
interface Person {
  store: ProjectStore;
  review: ReviewStore;
  mover: CommentMover;
}

function person(project = new Y.Doc(), review = new Y.Doc()): Person {
  const store = new ProjectStore(project);
  const comments = new ReviewStore(review);
  return { store, review: comments, mover: new CommentMover(store, comments) };
}

/** Everything one document has that the other has not, both ways. */
function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'remote');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'remote');
}

/**
 * Two people on one project who hear of each other only when `sync()` is called. `first` says whose
 * changes arrive first at the other.
 */
function pair() {
  const a = person();
  const b = person();
  a.store.initIfEmpty({ name: 'Spring campaign' });
  const sync = (first: 'a' | 'b' = 'a') => {
    const [one, two] = first === 'a' ? [a, b] : [b, a];
    for (const doc of ['doc', 'review'] as const) {
      const [from, to] = doc === 'doc' ? [one.store.doc, two.store.doc] : [one.review.doc, two.review.doc];
      Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
      Y.applyUpdate(from, Y.encodeStateAsUpdate(to, Y.encodeStateVector(from)), 'remote');
    }
  };
  sync();
  return { a, b, sync };
}

/** Five shots back to back on V1, a hundred frames each. */
function cut(s: ProjectStore): Clip[] {
  const v1 = tracksOf(s.get()).video[0];
  const clips = [0, 1, 2, 3, 4].map((i) =>
    makeClip('solid', v1.id, { start: i * 100, duration: 100, name: `C${i + 1}` }),
  );
  s.commit(clips.map((clip): Edit => ({ op: 'addClip', clip })));
  return clips;
}

const starts = (s: ProjectStore, clips: Clip[]): (number | null)[] =>
  clips.map((c) => s.get().clips[c.id]?.start ?? null);

/** Where each comment stands, by its text. */
const frames = (r: ReviewStore): Record<string, number> =>
  Object.fromEntries(r.get().map((c) => [c.text, c.frame]));

const note = (r: ReviewStore, frame: number, text: string, by = ben): string =>
  r.add({ ...by, frame, text, x: null, y: null });

/** Time taken out of the sequence: `length` frames from `from` on. What stood in them goes to the cut. */
const out =
  (from: number, length: number): Follow =>
  (f) =>
    f >= from + length ? f - length : Math.min(f, from);

/** Delete a shot and close the time it took, comments included. */
function rippleOut(p: Person, clip: Clip): void {
  const now = p.store.get().clips[clip.id];
  p.mover.commit(rippleDelete(p.store.get(), [clip.id]).edits, { follow: out(now.start, now.duration) });
}

describe('comments under an edit that moves time', () => {
  it('move once, for everyone, come back with the undo and move again with the redo', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    sync();
    note(b.review, 50, 'on the first');
    note(b.review, 100, 'on the cut');
    note(b.review, 250, 'on the third');
    sync();

    rippleOut(a, clips[0]);
    expect(starts(a.store, clips)).toEqual([null, 0, 100, 200, 300]);
    expect(frames(a.review)).toEqual({ 'on the first': 0, 'on the cut': 0, 'on the third': 150 });
    // The other person has not moved anything: the frames are the ones that arrive.
    expect(frames(b.review)).toEqual({ 'on the first': 50, 'on the cut': 100, 'on the third': 250 });
    sync();
    expect(starts(b.store, clips)).toEqual([null, 0, 100, 200, 300]);
    expect(frames(b.review)).toEqual(frames(a.review));

    // One step for whoever made the edit: clips and comments return together.
    expect(a.store.undo()).toEqual({ changed: true, dropped: 0 });
    expect(a.store.canUndo).toBe(true);
    expect(starts(a.store, clips)).toEqual([0, 100, 200, 300, 400]);
    expect(frames(a.review)).toEqual({ 'on the first': 50, 'on the cut': 100, 'on the third': 250 });
    sync();
    expect(frames(b.review)).toEqual(frames(a.review));

    expect(a.store.redo()).toEqual({ changed: true, dropped: 0 });
    expect(starts(a.store, clips)).toEqual([null, 0, 100, 200, 300]);
    expect(frames(a.review)).toEqual({ 'on the first': 0, 'on the cut': 0, 'on the third': 150 });
    a.store.undo();
    expect(frames(a.review)).toEqual({ 'on the first': 50, 'on the cut': 100, 'on the third': 250 });
    sync();
    expect(frames(b.review)).toEqual(frames(a.review));
  });

  it('keep their author, text, replies and resolved state: only a frame is written', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    const id = note(b.review, 250, 'Too long?');
    b.review.reply(id, { ...ana, text: 'A little' });
    b.review.update(id, { resolved: true });
    sync();
    const before = a.review.get()[0];

    rippleOut(a, clips[0]);
    sync();
    for (const r of [a.review, b.review]) {
      expect(r.get()).toEqual([{ ...before, frame: 150 }]);
      expect(Array.from(r.doc.getMap('commentFields').keys()).sort()).toEqual([
        `${id}/frame`,
        `${id}/resolved`,
      ]);
    }
    a.store.undo();
    sync();
    expect(b.review.get()).toEqual([before]);
  });

  it('are told apart by any id, also one that an object would take for its prototype', () => {
    const a = person();
    a.store.initIfEmpty();
    const clips = cut(a.store);
    const posted = { ...ben, frame: 250, text: 'odd id', x: null, y: null, createdAt: 1, resolved: false };
    a.review.doc.getMap('comments').set('__proto__', posted);
    note(a.review, 350, 'plain');
    rippleOut(a, clips[0]);
    expect(frames(a.review)).toEqual({ 'odd id': 150, plain: 250 });
    a.store.undo();
    expect(frames(a.review)).toEqual({ 'odd id': 250, plain: 350 });
    a.store.redo();
    expect(frames(a.review)).toEqual({ 'odd id': 150, plain: 250 });
  });

  it('leave a comment where it is when the edit changes nothing in the project', () => {
    const a = person();
    a.store.initIfEmpty();
    const clips = cut(a.store);
    note(a.review, 250, 'on the third');
    const steps = a.store.undoManager.undoStack.length;
    // The clip is already there: no step is recorded, so there is nothing for the move to belong to.
    a.mover.commit([{ op: 'updateClip', id: clips[2].id, patch: { start: 200 } }], { follow: out(0, 100) });
    expect(a.store.undoManager.undoStack.length).toBe(steps);
    expect(frames(a.review)).toEqual({ 'on the third': 250 });
    a.store.undo();
    expect(frames(a.review)).toEqual({ 'on the third': 250 });
  });

  it('are one step with every commit that joins it, and a gesture plans each step from where it began', () => {
    const a = person();
    a.store.initIfEmpty();
    const clips = cut(a.store);
    note(a.review, 30, 'before');
    note(a.review, 150, 'on the second');
    note(a.review, 450, 'on the fifth');
    const move = (id: string, start: number): Edit => ({ op: 'updateClip', id, patch: { start } });

    // Two ripples in one step, each counted from what it finds.
    rippleOut(a, clips[0]);
    a.mover.commit(rippleDelete(a.store.get(), [clips[2].id]).edits, { merge: true, follow: out(100, 100) });
    expect(starts(a.store, clips)).toEqual([null, 0, null, 100, 200]);
    expect(frames(a.review)).toEqual({ before: 0, 'on the second': 50, 'on the fifth': 250 });
    a.store.undo();
    expect(starts(a.store, clips)).toEqual([0, 100, 200, 300, 400]);
    expect(frames(a.review)).toEqual({ before: 30, 'on the second': 150, 'on the fifth': 450 });

    // A drag that puts 40 frames in after the fourth shot, then 90, then none after all.
    const put =
      (by: number): Follow =>
      (f) =>
        f >= 400 ? f + by : f;
    a.store.beginGesture();
    for (const [by, at] of [
      [40, 490],
      [90, 540],
      [0, 450],
    ]) {
      a.mover.commit([move(clips[4].id, 400 + by)], { merge: true, follow: put(by), fromStepStart: true });
      expect(frames(a.review)).toEqual({ before: 30, 'on the second': 150, 'on the fifth': at });
    }
    a.mover.commit([move(clips[4].id, 460)], { merge: true, follow: put(60), fromStepStart: true });
    expect(frames(a.review)['on the fifth']).toBe(510);
    a.store.undo();
    expect(starts(a.store, clips)).toEqual([0, 100, 200, 300, 400]);
    expect(frames(a.review)).toEqual({ before: 30, 'on the second': 150, 'on the fifth': 450 });
    a.store.redo();
    expect(frames(a.review)['on the fifth']).toBe(510);
  });
});

describe('undo of an edit that moved comments, after someone else has been at them', () => {
  it('leaves a comment deleted that was deleted in between', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    const gone = note(b.review, 250, 'on the third');
    note(b.review, 350, 'on the fourth');
    sync();
    rippleOut(a, clips[0]);
    sync();
    b.review.remove(gone);
    sync();

    a.store.undo();
    sync();
    for (const r of [a.review, b.review]) expect(frames(r)).toEqual({ 'on the fourth': 350 });
    expect(Array.from(a.review.doc.getMap('commentFields').keys())).toEqual([
      `${a.review.get()[0].id}/frame`,
    ]);
    // Nor does the redo know it any more.
    a.store.redo();
    sync();
    for (const r of [a.review, b.review]) expect(frames(r)).toEqual({ 'on the fourth': 250 });
  });

  it('keeps what they wrote, answered and resolved in between', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    const reworded = note(b.review, 250, 'Draft');
    const resolved = note(b.review, 350, 'Fix the colour', ana);
    sync();
    rippleOut(a, clips[0]);
    sync();
    b.review.update(reworded, { text: 'Final wording' });
    b.review.update(resolved, { resolved: true });
    b.review.reply(resolved, { ...ben, text: 'Done' });
    sync();

    a.store.undo();
    sync();
    for (const r of [a.review, b.review]) {
      const [first, second] = r.get();
      expect(first).toMatchObject({ id: reworded, frame: 250, text: 'Final wording', resolved: false });
      expect(second).toMatchObject({ id: resolved, frame: 350, resolved: true, authorName: 'Ana' });
      expect(second.replies.map((reply) => reply.text)).toEqual(['Done']);
    }
  });

  it('does not touch a comment that was made since', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    note(b.review, 250, 'on the third');
    sync();
    rippleOut(a, clips[0]);
    sync();
    note(b.review, 150, 'made since');
    sync();

    a.store.undo();
    sync();
    for (const r of [a.review, b.review])
      expect(frames(r)).toEqual({ 'made since': 150, 'on the third': 250 });
    a.store.redo();
    sync();
    for (const r of [a.review, b.review])
      expect(frames(r)).toEqual({ 'made since': 150, 'on the third': 150 });
  });

  it('leaves a comment where a newer ripple of theirs put it, with the clip that did not go back either', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    note(b.review, 150, 'on the second');
    note(b.review, 450, 'on the fifth');
    sync();
    rippleOut(a, clips[0]);
    sync();
    // The other person takes out the third shot, which now begins at 100.
    rippleOut(b, clips[2]);
    sync();
    expect(starts(a.store, clips)).toEqual([null, 0, null, 100, 200]);
    expect(frames(a.review)).toEqual({ 'on the second': 50, 'on the fifth': 250 });

    expect(a.store.undo()).toEqual({ changed: true, dropped: 0 });
    sync();
    for (const p of [a, b]) {
      // The second shot was moved by the older step alone and returns. The fifth was moved again
      // by the newer one: its start is theirs now, and so is the frame of the comment on it.
      expect(starts(p.store, clips)).toEqual([0, 100, null, 100, 200]);
      expect(frames(p.review)).toEqual({ 'on the second': 150, 'on the fifth': 250 });
    }
    // Their own undo still takes back what they did.
    b.store.undo();
    sync();
    for (const p of [a, b]) expect(frames(p.review)).toEqual({ 'on the second': 150, 'on the fifth': 350 });
  });

  it('moves no comment for a step of which nothing was left to take back', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    note(b.review, 450, 'on the fifth');
    sync();
    // Room for 50 frames before the fifth shot: only that shot is written.
    const room = openGap(a.store.get(), [clips[4].trackId], 400, 50);
    a.mover.commit(room, { follow: (f) => (f >= 400 ? f + 50 : f) });
    sync();
    expect(frames(b.review)).toEqual({ 'on the fifth': 500 });
    b.store.commit([{ op: 'updateClip', id: clips[4].id, patch: { start: 600 } }]);
    sync();

    expect(a.store.undo()).toEqual({ changed: true, dropped: 1 });
    sync();
    // What was taken back is the step before, which made the cut. The comment stays.
    expect(Object.keys(a.store.get().clips)).toEqual([]);
    for (const p of [a, b]) expect(frames(p.review)).toEqual({ 'on the fifth': 500 });
  });

  it('reads its frames at the present rate after they changed the frame rate', () => {
    const { a, b, sync } = pair();
    const clips = cut(a.store);
    note(b.review, 250, 'on the third');
    note(b.review, 50, 'on the first');
    sync();
    rippleOut(a, clips[0]);
    sync();
    // Whoever changes the rate re-times the comments with it.
    b.store.commit(changeFrameRate(b.store.get(), 60, 1));
    b.review.move(new Map(b.review.get().map((c) => [c.id, c.frame * 2])));
    sync();
    expect(frames(a.review)).toEqual({ 'on the first': 0, 'on the third': 300 });

    a.store.undo();
    sync();
    for (const p of [a, b]) {
      expect(starts(p.store, clips)).toEqual([0, 200, 400, 600, 800]);
      expect(frames(p.review)).toEqual({ 'on the first': 100, 'on the third': 500 });
    }
    a.store.redo();
    sync();
    for (const p of [a, b]) expect(frames(p.review)).toEqual({ 'on the first': 0, 'on the third': 300 });
  });
});

describe('two people who ripple at the same moment', () => {
  for (const first of ['a', 'b'] as const) {
    it(`end with the same frames when the changes of ${first === 'a' ? 'one' : 'the other'} arrive first`, () => {
      const { a, b, sync } = pair();
      const clips = cut(a.store);
      note(b.review, 150, 'on the second');
      note(b.review, 350, 'on the fourth');
      note(b.review, 450, 'on the fifth');
      sync();

      rippleOut(a, clips[0]);
      rippleOut(b, clips[2]);
      expect(frames(a.review)).toEqual({ 'on the second': 50, 'on the fourth': 250, 'on the fifth': 350 });
      expect(frames(b.review)).toEqual({ 'on the second': 150, 'on the fourth': 250, 'on the fifth': 350 });
      sync(first);

      expect(starts(a.store, clips)).toEqual(starts(b.store, clips));
      expect(frames(a.review)).toEqual(frames(b.review));
      // Only one of them moved the comment on the second shot. The two after the third shot were
      // each given a frame by both, and one of the two stands for everyone.
      expect(frames(a.review)['on the second']).toBe(50);
      expect(frames(a.review)['on the fourth']).toBe(250);

      // Each takes their own edit back, and they still agree.
      a.store.undo();
      b.store.undo();
      sync(first);
      expect(starts(a.store, clips)).toEqual(starts(b.store, clips));
      expect(frames(a.review)).toEqual(frames(b.review));
      expect(frames(a.review)['on the second']).toBe(150);
    });
  }

  it('agree as well when they are told of every change as it is made', () => {
    const a = person();
    a.store.initIfEmpty();
    const b = person();
    for (const [one, two] of [
      [a.store.doc, b.store.doc],
      [a.review.doc, b.review.doc],
    ]) {
      one.on(
        'update',
        (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(two, u, 'remote'),
      );
      two.on(
        'update',
        (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(one, u, 'remote'),
      );
      exchange(one, two);
    }
    const clips = cut(a.store);
    note(b.review, 250, 'on the third');
    rippleOut(a, clips[0]);
    expect(frames(b.review)).toEqual({ 'on the third': 150 });
    rippleOut(b, clips[1]);
    expect(frames(a.review)).toEqual({ 'on the third': 50 });
    // The newer ripple is on top: the older step leaves the comment to it.
    a.store.undo();
    expect(frames(a.review)).toEqual({ 'on the third': 50 });
    expect(frames(b.review)).toEqual({ 'on the third': 50 });
    b.store.undo();
    expect(frames(a.review)).toEqual({ 'on the third': 150 });
    expect(frames(b.review)).toEqual({ 'on the third': 150 });
  });
});
