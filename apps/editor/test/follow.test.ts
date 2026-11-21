import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  applyEdits,
  ASSET_DEFAULTS,
  clipEnd,
  CommentMover,
  emptyProject,
  freezeFrame,
  GESTURE_REST_MS,
  makeClip,
  makeTrack,
  ProjectStore,
  ReviewStore,
  type Clip,
  type Edit,
  type Project,
  type Track,
} from '@tandem/core';
import {
  closeGapAt,
  duplicateClips,
  markerEdits,
  openGapAt,
  rippleDeleteClips,
  rippleDeleteRange,
  rippleFollower,
  rippleTrimToFrame,
  trimEdge,
  type RippleSpan,
} from '../src/state/edits';
import { asRipple, commitEdits, withMarkers } from '../src/state/follow';
import {
  durationEdits,
  makeRoomEdits,
  shapeChange,
  speedEach,
  speedEdits,
  speedGesture,
  speedRippleEdits,
  speedStepped,
  type Retime,
  type SpeedGesture,
  type SpeedGestureOptions,
} from '../src/state/timing';
import { useUI } from '../src/state/ui';

function add(p: Project, track: Track, start: number, duration: number, init: Partial<Clip> = {}) {
  const clip = makeClip(track.kind === 'audio' ? 'audio' : 'video', track.id, {
    assetId: 'asset1',
    start,
    duration,
    ...init,
  });
  return { p: applyEdits(p, [{ op: 'addClip', clip }]), clip };
}

/**
 * Three shots of four seconds on V1 from a ten-second file, a title over the first of them on V2
 * and, with `bed`, music under all three on A1.
 */
function cut(bed = true) {
  const v1 = makeTrack('video', 0);
  const v2 = makeTrack('video', 1);
  const a1 = makeTrack('audio', 0);
  const p = applyEdits(emptyProject(), [
    { op: 'addTrack', track: v1 },
    { op: 'addTrack', track: v2 },
    { op: 'addTrack', track: a1 },
    {
      op: 'addAsset',
      asset: { ...ASSET_DEFAULTS, id: 'asset1', name: 'clip.mp4', kind: 'video', duration: 10 },
    },
  ]);
  const dusk = add(p, v1, 0, 120);
  const fractal = add(dusk.p, v1, 120, 120);
  const aurora = add(fractal.p, v1, 240, 120);
  const title = add(aurora.p, v2, 18, 90, { assetId: null });
  const music = bed ? add(title.p, a1, 0, 360, { assetId: null }).p : title.p;
  return {
    p: music,
    v1,
    v2,
    a1,
    dusk: dusk.clip,
    fractal: fractal.clip,
    aurora: aurora.clip,
    title: title.clip,
  };
}

const layout = (p: Project, t: Track): string[] =>
  Object.values(p.clips)
    .filter((c) => c.trackId === t.id)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.start}-${clipEnd(c)}`);

const marker = (id: string, frame: number): Edit => ({
  op: 'setMarker',
  marker: { id, frame, name: id, color: '#fff', note: '' },
});

type Rippled = { edits: Edit[]; spans: RippleSpan[] };

/**
 * Where a comment at each of `frames` goes when the ripple `r` goes through `p`. A marker put on
 * the same frame has to end on the same frame: one rule for both.
 */
function followed(p: Project, r: Rippled, frames: number[]): number[] {
  const to = frames.map(rippleFollower(p, r.edits, r.spans));
  const marked = applyEdits(
    p,
    frames.map((f) => marker(`at${f}`, f)),
  );
  const after = applyEdits(marked, [...r.edits, ...markerEdits(marked, r.edits, r.spans)]);
  expect(frames.map((f) => after.markers[`at${f}`].frame)).toEqual(to);
  return to;
}

describe('where a comment goes under each kind of ripple', () => {
  it('a ripple delete of a shot: before stays, inside goes to the cut, after comes up', () => {
    const c = cut();
    const r = rippleDeleteClips(c.p, [c.fractal.id]);
    expect(layout(applyEdits(c.p, r.edits), c.v1)).toEqual(['0-120', '120-240']);
    // 30 is on the first shot under the title, 400 is past the end of everything.
    expect(followed(c.p, r, [30, 119, 120, 180, 239, 240, 250, 400])).toEqual([
      30, 119, 120, 120, 120, 120, 130, 280,
    ]);
  });

  it('a ripple delete of a marked range across two shots', () => {
    const c = cut();
    const r = rippleDeleteRange(c.p, 100, 160);
    expect(layout(applyEdits(c.p, r.edits), c.v1)).toEqual(['0-100', '100-180', '180-300']);
    expect(followed(c.p, r, [50, 100, 130, 159, 160, 200, 300, 400])).toEqual([
      50, 100, 100, 100, 100, 140, 240, 340,
    ]);
  });

  it('a ripple trim of a tail and of a head', () => {
    const c = cut();
    const tail = trimEdge(c.p, [c.fractal.id], 'end', -30, true);
    expect(layout(applyEdits(c.p, tail.edits), c.v1)).toEqual(['0-120', '120-210', '210-330']);
    expect(followed(c.p, tail, [100, 150, 210, 220, 240, 250])).toEqual([100, 150, 210, 210, 210, 220]);
    const head = trimEdge(c.p, [c.fractal.id], 'start', 20, true);
    expect(layout(applyEdits(c.p, head.edits), c.v1)).toEqual(['0-120', '120-220', '220-340']);
    expect(followed(c.p, head, [100, 120, 130, 150, 250])).toEqual([100, 120, 120, 130, 230]);
    // A tail that is let out puts time in where the clip ended.
    const longer = trimEdge(c.p, [c.fractal.id], 'end', 15, true);
    expect(followed(c.p, longer, [150, 239, 240, 250])).toEqual([150, 239, 255, 265]);
  });

  it('a trim of either side to the playhead', () => {
    const c = cut();
    const head = rippleTrimToFrame(c.p, [c.fractal.id], 'start', 150);
    expect(layout(applyEdits(c.p, head.edits), c.v1)).toEqual(['0-120', '120-210', '210-330']);
    expect(followed(c.p, head, [60, 130, 150, 200, 250])).toEqual([60, 120, 120, 170, 220]);
    const tail = rippleTrimToFrame(c.p, [c.fractal.id], 'end', 150);
    expect(layout(applyEdits(c.p, tail.edits), c.v1)).toEqual(['0-120', '120-150', '150-270']);
    expect(followed(c.p, tail, [60, 130, 150, 200, 250])).toEqual([60, 130, 150, 150, 160]);
  });

  it('a gap that is closed: empty time goes to where the gap began', () => {
    const c = cut(false);
    const open = applyEdits(c.p, [{ op: 'removeClip', id: c.fractal.id }]);
    const r = closeGapAt(open, 150);
    expect(layout(applyEdits(open, r.edits), c.v1)).toEqual(['0-120', '120-240']);
    expect(followed(open, r, [60, 120, 150, 239, 240, 250])).toEqual([60, 120, 120, 120, 120, 130]);
  });

  it('an insert at a cut and in the middle of a shot, as a paste or a drop with room makes it', () => {
    const c = cut();
    const atCut = openGapAt(c.p, 120, 60);
    expect(layout(applyEdits(c.p, atCut.edits), c.v1)).toEqual(['0-120', '180-300', '300-420']);
    // What stands on the frame the room opens at moves with the clip that began there.
    expect(followed(c.p, atCut, [119, 120, 250, 400])).toEqual([119, 180, 310, 460]);
    const inShot = openGapAt(c.p, 180, 60);
    expect(layout(applyEdits(c.p, inShot.edits), c.v1)).toEqual(['0-120', '120-180', '240-300', '300-420']);
    expect(followed(c.p, inShot, [150, 179, 180, 200, 250])).toEqual([150, 179, 240, 260, 310]);
  });

  it('a duplicate that pushes what follows, and a freeze frame', () => {
    const c = cut();
    const copy = duplicateClips(c.p, [c.dusk.id]);
    expect(layout(applyEdits(c.p, copy.edits), c.v1)).toEqual(['0-120', '120-240', '240-360', '360-480']);
    expect(followed(c.p, copy, [60, 130, 250])).toEqual([60, 250, 370]);
    const hold = freezeFrame(c.p, c.fractal.id, 150, 60);
    const frozen = { edits: hold.edits, spans: [{ from: 150, by: 60 }] };
    expect(layout(applyEdits(c.p, hold.edits), c.v1)).toEqual([
      '0-120',
      '120-150',
      '150-210',
      '210-300',
      '300-420',
    ]);
    expect(followed(c.p, frozen, [130, 150, 200, 250])).toEqual([130, 210, 260, 310]);
  });

  it('a change of speed and of length with ripple editing, and room made after one without', () => {
    const c = cut();
    const faster = speedRippleEdits(c.p, [c.fractal.id], 2);
    expect(layout(applyEdits(c.p, faster.edits), c.v1)).toEqual(['0-120', '120-180', '180-300']);
    expect(followed(c.p, faster, [100, 150, 200, 250])).toEqual([100, 150, 180, 190]);
    const slower = speedRippleEdits(c.p, [c.fractal.id], 0.5);
    expect(layout(applyEdits(c.p, slower.edits), c.v1)).toEqual(['0-120', '120-360', '360-480']);
    expect(followed(c.p, slower, [150, 250])).toEqual([150, 370]);

    const shorter = durationEdits(c.p, [[c.fractal.id]], 90, true);
    expect(layout(applyEdits(c.p, shorter.edits), c.v1)).toEqual(['0-120', '120-210', '210-330']);
    expect(followed(c.p, shorter, [150, 220, 250])).toEqual([150, 210, 220]);

    const held = applyEdits(c.p, speedEach(c.p, [c.fractal.id], 0.5));
    expect(layout(held, c.v1)).toEqual(['0-120', '120-240', '240-360']);
    const room = makeRoomEdits(held, { [c.fractal.id]: 240 });
    expect(layout(applyEdits(held, room.edits), c.v1)).toEqual(['0-120', '120-360', '360-480']);
    expect(followed(held, room, [150, 250])).toEqual([150, 370]);
  });

  it('stays on the shot when only the titles above it close up, and goes by the title where there is no shot', () => {
    const c = cut(false);
    const later = add(c.p, c.v2, 300, 45, { assetId: null });
    const r = rippleDeleteClips(later.p, [c.title.id]);
    expect(layout(applyEdits(later.p, r.edits), c.v2)).toEqual(['210-255']);
    // 310 is on the third shot, under the title that moved: the shot did not.
    expect(followed(later.p, r, [30, 130, 310])).toEqual([30, 130, 310]);
    // With no shot below, the comment on the title goes with the title, and one on empty time
    // with the time that was taken out.
    const bare = applyEdits(later.p, [{ op: 'removeClip', id: c.aurora.id }]);
    const alone = rippleDeleteClips(bare, [c.title.id]);
    expect(followed(bare, alone, [250, 310, 400])).toEqual([160, 220, 310]);
  });
});

/** One person: the project and the review beside it, as a session holds them. */
interface Seat {
  store: ProjectStore;
  review: ReviewStore;
}

const seat = (): Seat => ({ store: new ProjectStore(), review: new ReviewStore() });

/** Two documents that hear of each other's changes as they are made. */
function connect(a: Y.Doc, b: Y.Doc): void {
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
}

const ben = { authorId: 'u2', authorName: 'Ben', authorColor: '#51cf66' };

const note = (s: Seat, frame: number, text: string): string =>
  s.review.add({ ...ben, frame, text, x: null, y: null });

/** Where each comment stands, by its text, in the order the panel lists them. */
const notes = (s: Seat): [string, number][] => s.review.get().map((c) => [c.text, c.frame]);

const markers = (s: Seat): number[] =>
  Object.values(s.store.get().markers)
    .map((m) => m.frame)
    .sort((a, b) => a - b);

describe('a ripple that is committed', () => {
  afterEach(() => useUI.getState().set({ markersFollow: true }));

  it('takes markers and comments along as one undo step, for the other person too', () => {
    const owner = seat();
    const guest = seat();
    const c = cut();
    owner.store.replaceAll(applyEdits(c.p, [marker('third', 240)]));
    connect(owner.store.doc, guest.store.doc);
    connect(owner.review.doc, guest.review.doc);
    note(guest, 250, 'on the third shot');
    note(guest, 60, 'on the first shot');
    note(guest, 130, 'on the second shot');

    const p = owner.store.get();
    commitEdits(owner, withMarkers(p, rippleDeleteClips(p, [c.dusk.id])));
    for (const s of [owner, guest]) {
      expect(layout(s.store.get(), c.v1)).toEqual(['0-120', '120-240']);
      expect(markers(s)).toEqual([120]);
      // The two that stood on shots are still on them, and the list is in the order of the frames.
      expect(notes(s)).toEqual([
        ['on the first shot', 0],
        ['on the second shot', 10],
        ['on the third shot', 130],
      ]);
    }
    expect(owner.store.undo()).toEqual({ changed: true, dropped: 0 });
    for (const s of [owner, guest]) {
      expect(layout(s.store.get(), c.v1)).toEqual(['0-120', '120-240', '240-360']);
      expect(markers(s)).toEqual([240]);
      expect(notes(s)).toEqual([
        ['on the first shot', 60],
        ['on the second shot', 130],
        ['on the third shot', 250],
      ]);
    }
    owner.store.redo();
    expect(notes(guest).map(([, frame]) => frame)).toEqual([0, 10, 130]);
    expect(markers(guest)).toEqual([120]);
  });

  it('moves neither markers nor comments while the switch is off', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(applyEdits(c.p, [marker('third', 240)]));
    note(s, 250, 'on the third shot');
    useUI.getState().set({ markersFollow: false });
    const p = s.store.get();
    const r = rippleDeleteClips(p, [c.dusk.id]);
    expect(withMarkers(p, r)).toBe(r.edits);
    commitEdits(s, withMarkers(p, r));
    expect(layout(s.store.get(), c.v1)).toEqual(['0-120', '120-240']);
    expect(markers(s)).toEqual([240]);
    expect(notes(s)).toEqual([['on the third shot', 250]]);
    s.store.undo();
    expect(notes(s)).toEqual([['on the third shot', 250]]);

    // Switched on again, both follow.
    useUI.getState().set({ markersFollow: true });
    commitEdits(s, withMarkers(s.store.get(), rippleDeleteClips(s.store.get(), [c.dusk.id])));
    expect(markers(s)).toEqual([120]);
    expect(notes(s)).toEqual([['on the third shot', 130]]);
  });

  it('carries what goes into the room of an insert in the same step', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(applyEdits(c.p, [marker('second', 120)]));
    note(s, 130, 'on the second shot');
    const steps = s.store.undoManager.undoStack.length;
    const p = s.store.get();
    const room = openGapAt(p, 120, 60);
    const pasted = makeClip('video', c.v1.id, { assetId: 'asset1', start: 120, duration: 60 });
    commitEdits(s, withMarkers(p, room, [{ op: 'addClip', clip: pasted }]));
    expect(layout(s.store.get(), c.v1)).toEqual(['0-120', '120-180', '180-300', '300-420']);
    expect(markers(s)).toEqual([180]);
    expect(notes(s)).toEqual([['on the second shot', 190]]);
    expect(s.store.undoManager.undoStack.length).toBe(steps + 1);
    s.store.undo();
    expect(layout(s.store.get(), c.v1)).toEqual(['0-120', '120-240', '240-360']);
    expect(notes(s)).toEqual([['on the second shot', 130]]);
  });

  it('is told apart by the list that was marked, not by a copy of it', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(c.p);
    note(s, 250, 'on the third shot');
    const p = s.store.get();
    const r = rippleDeleteClips(p, [c.dusk.id]);
    commitEdits(s, [...asRipple(r.edits, rippleFollower(p, r.edits, r.spans))]);
    expect(layout(s.store.get(), c.v1)).toEqual(['0-120', '120-240']);
    expect(notes(s)).toEqual([['on the third shot', 250]]);
  });
});

/** A speed gesture the way the inspector drives it: every step commits into the gesture's undo step. */
function scrubber(s: Seat, ids: string[], options: SpeedGestureOptions) {
  let gesture: SpeedGesture | null = null;
  return (speed: number): void => {
    const g = speedGesture(gesture, s.store.get(), ids, options);
    if (g !== gesture) s.store.beginGesture();
    const edits = speedEdits(g, s.store.get(), speed);
    if (edits.length) commitEdits(s, edits, { merge: true });
    gesture = speedStepped(g, s.store.get());
  };
}

describe('a speed gesture under ripple editing', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  /** The pointer holds still for a moment: the gesture writes the comments where it has them. */
  const rest = (): void => void vi.advanceTimersByTime(GESTURE_REST_MS);

  it('takes the comments to where each step leaves the shots, and back when it ends where it began', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(applyEdits(c.p, [marker('third', 240)]));
    note(s, 30, 'on the first shot');
    note(s, 250, 'on the third shot');
    const steps = s.store.undoManager.undoStack.length;
    const to = scrubber(s, [c.fractal.id], { ripple: true, markers: true });
    for (const [speed, third] of [
      [2, 180],
      [4, 150],
      [0.5, 360],
      [1, 240],
      [2, 180],
    ]) {
      to(speed);
      rest();
      expect(s.store.get().clips[c.aurora.id].start).toBe(third);
      expect(markers(s)).toEqual([third]);
      expect(notes(s)).toEqual([
        ['on the first shot', 30],
        ['on the third shot', third + 10],
      ]);
    }
    // The whole drag is one step, comments included.
    expect(s.store.undoManager.undoStack.length).toBe(steps + 1);
    s.store.undo();
    expect(s.store.get().clips[c.aurora.id].start).toBe(240);
    expect(notes(s).map(([, frame]) => frame)).toEqual([30, 250]);
    s.store.redo();
    expect(notes(s).map(([, frame]) => frame)).toEqual([30, 190]);
  });

  it('writes the comments with the first step of a drag and once it rests, however many steps it takes', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(c.p);
    note(s, 250, 'on the third shot');
    let written = 0;
    s.review.doc.on('update', () => written++);
    const to = scrubber(s, [c.fractal.id], { ripple: true, markers: true });
    for (let percent = 101; percent <= 200; percent++) to(percent / 100);
    expect(s.store.get().clips[c.aurora.id].start).toBe(180);
    expect([written, notes(s)[0][1]]).toEqual([1, 249]);
    rest();
    expect([written, notes(s)[0][1]]).toEqual([2, 190]);
    // Taken back at once after more steps, the drag still returns the comment to where it found it.
    to(4);
    s.store.undo();
    expect(notes(s)).toEqual([['on the third shot', 250]]);
    rest();
    expect(notes(s)).toEqual([['on the third shot', 250]]);
  });

  it('keeps the comments with the markers when media lands, or a step is undone and redone, mid-drag', () => {
    const landed = (s: Seat): void =>
      s.store.commit([
        {
          op: 'addAsset',
          asset: { ...ASSET_DEFAULTS, id: 'asset2', name: 'b-roll.mp4', kind: 'video', duration: 5 },
        },
      ]);
    const redone = (s: Seat): void => {
      s.store.undo();
      s.store.redo();
    };
    for (const between of [landed, redone]) {
      const s = seat();
      const c = cut();
      s.store.replaceAll(applyEdits(c.p, [marker('third', 250), marker('late', 400)]));
      note(s, 250, 'on the third shot');
      note(s, 400, 'after the cut');
      const steps = s.store.undoManager.undoStack.length;
      const to = scrubber(s, [c.fractal.id], { ripple: true, markers: true });
      to(1.25);
      to(1.5);
      rest();
      expect(markers(s)).toEqual([210, 360]);
      expect(notes(s).map(([, frame]) => frame)).toEqual([210, 360]);
      // Neither moves a clip or a marker, so the drag goes on as the same gesture. What follows is
      // recorded in another undo step than what came before.
      between(s);
      to(1.75);
      to(2.5);
      to(2);
      rest();
      expect(s.store.undoManager.undoStack.length).toBe(steps + 2);
      expect(s.store.get().clips[c.aurora.id].start).toBe(180);
      expect(markers(s)).toEqual([190, 340]);
      expect(notes(s).map(([, frame]) => frame)).toEqual([190, 340]);
      // Each of the two steps takes back its part of the drag, comments included.
      s.store.undo();
      expect(markers(s)).toEqual([210, 360]);
      expect(notes(s).map(([, frame]) => frame)).toEqual([210, 360]);
      s.store.undo();
      expect(markers(s)).toEqual([250, 400]);
      expect(notes(s).map(([, frame]) => frame)).toEqual([250, 400]);
      s.store.redo();
      s.store.redo();
      expect(markers(s)).toEqual([190, 340]);
      expect(notes(s).map(([, frame]) => frame)).toEqual([190, 340]);
    }
  });

  it('takes a comment the other person makes or moves meanwhile on from the shot they put it on, for both', () => {
    const owner = seat();
    const guest = seat();
    const c = cut();
    owner.store.replaceAll(c.p);
    connect(owner.store.doc, guest.store.doc);
    connect(owner.review.doc, guest.review.doc);
    note(guest, 60, 'on the first shot');
    note(guest, 250, 'on the third shot');
    const steps = owner.store.undoManager.undoStack.length;
    const to = scrubber(owner, [c.fractal.id], { ripple: true, markers: true });
    const id = (text: string): string => guest.review.get().find((n) => n.text === text)!.id;
    const both = (expected: Record<string, number>): void => {
      for (const s of [owner, guest]) expect(Object.fromEntries(notes(s))).toEqual(expected);
    };

    to(0.5);
    rest();
    // Slower still, and before the drag has rested: the second shot runs from 120 to 320 and the
    // third begins at 320. The guest pins notes on the picture as it is now, on the third shot, on
    // the second, and on the part of the second that only the slower speed gives it, puts the
    // note from the first shot on the third, and deletes one.
    to(0.6);
    expect(owner.store.get().clips[c.aurora.id].start).toBe(320);
    note(guest, 330, 'new on the third');
    note(guest, 150, 'new on the second');
    note(guest, 300, 'new late in the second');
    guest.review.move(new Map([[id('on the first shot'), 340]]));
    guest.review.remove(id('on the third shot'));

    for (const [speed, second, third, late] of [
      // The second shot is 300 frames long, then 150: the late note's time is taken out, and it
      // goes to the cut. At 240 frames that time is put back, and the note with it.
      [0.4, 420, 420, 300],
      [0.8, 270, 270, 270],
      [0.5, 360, 360, 300],
    ]) {
      to(speed);
      rest();
      expect(clipEnd(owner.store.get().clips[c.fractal.id])).toBe(second);
      expect(guest.store.get().clips[c.aurora.id].start).toBe(third);
      both({
        'new on the second': 150,
        'new late in the second': late,
        'new on the third': third + 10,
        'on the first shot': third + 20,
      });
    }

    // Still one step, which takes each note back to where it was found or put.
    expect(owner.store.undoManager.undoStack.length).toBe(steps + 1);
    owner.store.undo();
    expect(layout(guest.store.get(), c.v1)).toEqual(['0-120', '120-240', '240-360']);
    both({
      'new on the second': 150,
      'new late in the second': 300,
      'new on the third': 330,
      'on the first shot': 340,
    });
    owner.store.redo();
    both({
      'new on the second': 150,
      'new late in the second': 300,
      'new on the third': 370,
      'on the first shot': 380,
    });
  });

  it('leaves the comments alone when comments and markers do not follow', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(applyEdits(c.p, [marker('third', 240)]));
    note(s, 250, 'on the third shot');
    const to = scrubber(s, [c.fractal.id], { ripple: true, markers: false });
    to(2);
    rest();
    expect(s.store.get().clips[c.aurora.id].start).toBe(180);
    expect(markers(s)).toEqual([240]);
    expect(notes(s)).toEqual([['on the third shot', 250]]);
  });
});

/** One level speed over the four seconds a shot plays: a ramp whose length is that of the speed. */
const level = (id: string, v: number): Retime => ({
  ramps: {
    [id]: [
      { m: 0, v },
      { m: 4, v },
    ],
  },
});

/**
 * A ramp gesture the way a graph of points drives it: every step commits into the gesture's undo
 * step. With `told`, the gesture is told what each step asked for.
 */
function ramper(s: Seat, ids: string[], options: SpeedGestureOptions, told = true) {
  let gesture: SpeedGesture | null = null;
  return (step: Retime): void => {
    const g = speedGesture(gesture, s.store.get(), ids, { ...options, ramp: true });
    if (g !== gesture) s.store.beginGesture();
    const edits = speedEdits(g, s.store.get(), step);
    if (edits.length) commitEdits(s, edits, { merge: true });
    gesture = told ? speedStepped(g, s.store.get(), step) : speedStepped(g, s.store.get());
  };
}

describe('a ramp gesture under ripple editing', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const rest = (): void => void vi.advanceTimersByTime(GESTURE_REST_MS);

  it('takes the comments to where each step leaves the shots, and back when it ends where it began', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(applyEdits(c.p, [marker('third', 240)]));
    note(s, 30, 'on the first shot');
    note(s, 250, 'on the third shot');
    const steps = s.store.undoManager.undoStack.length;
    const to = ramper(s, [c.fractal.id], { ripple: true, markers: true });
    const bullet = shapeChange(c.p, [[c.fractal.id]], 'bullet');
    for (const [step, third] of [
      [level(c.fractal.id, 2), 180],
      [bullet!, 147],
      [level(c.fractal.id, 0.5), 360],
      [{ ramps: { [c.fractal.id]: null } }, 240],
      [level(c.fractal.id, 2), 180],
    ] as const) {
      to(step);
      rest();
      expect(s.store.get().clips[c.aurora.id].start).toBe(third);
      expect(markers(s)).toEqual([third]);
      expect(notes(s)).toEqual([
        ['on the first shot', 30],
        ['on the third shot', third + 10],
      ]);
    }
    // The whole drag is one step, comments included.
    expect(s.store.undoManager.undoStack.length).toBe(steps + 1);
    s.store.undo();
    expect(s.store.get().clips[c.fractal.id]).toEqual(c.fractal);
    expect(s.store.get().clips[c.aurora.id].start).toBe(240);
    expect(notes(s).map(([, frame]) => frame)).toEqual([30, 250]);
    s.store.redo();
    expect(notes(s).map(([, frame]) => frame)).toEqual([30, 190]);
  });

  it('writes the comments with the first step of a drag and once it rests, however many steps it takes', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(c.p);
    note(s, 250, 'on the third shot');
    let written = 0;
    s.review.doc.on('update', () => written++);
    const to = ramper(s, [c.fractal.id], { ripple: true, markers: true });
    for (let percent = 101; percent <= 200; percent++) to(level(c.fractal.id, percent / 100));
    expect(s.store.get().clips[c.aurora.id].start).toBe(180);
    expect([written, notes(s)[0][1]]).toEqual([1, 249]);
    rest();
    expect([written, notes(s)[0][1]]).toEqual([2, 190]);
    to(level(c.fractal.id, 4));
    s.store.undo();
    expect(notes(s)).toEqual([['on the third shot', 250]]);
    rest();
    expect(notes(s)).toEqual([['on the third shot', 250]]);
  });

  it('names each step by the very change the step before it asked for', () => {
    const s = seat();
    const c = cut();
    s.store.replaceAll(c.p);
    note(s, 250, 'on the third shot');
    const commit = vi.spyOn(CommentMover.prototype, 'commit');
    const to = ramper(s, [c.fractal.id], { ripple: true, markers: true });
    const asked = [level(c.fractal.id, 2), level(c.fractal.id, 2), shapeChange(c.p, [[c.fractal.id]], 'hero')!];
    for (const step of asked) to(step);
    const gestures = commit.mock.calls.map(([, opts]) => opts.gesture);
    expect(gestures).toHaveLength(3);
    // One gesture through all three, and each step knows the one before it as it was given: two
    // steps that ask for equal ramps are still two steps.
    expect(new Set(gestures.map((g) => g?.of)).size).toBe(1);
    expect(gestures[1]?.last).toBe(asked[0]);
    expect(gestures[2]?.last).toBe(asked[1]);
    expect(gestures[2]?.last).not.toBe(asked[0]);
    // Before its first step a gesture has made no change: what it names leaves the clips as found.
    expect(gestures[0]?.last).toEqual({ ramps: { [c.fractal.id]: null } });
    // Asked where a step takes what stood at a frame as an earlier one left it: at 200% the third
    // shot began at 180, and under Hero it begins at 241.
    expect(gestures[2]?.since(asked[1], 190)).toBe(251);
    expect(gestures[2]?.since(asked[1], 30)).toBe(30);
  });

  for (const told of [true, false]) {
    it(`takes a comment the other person makes or moves meanwhile on from the shot they put it on${told ? '' : ', also when it is not told its steps'}`, () => {
      const owner = seat();
      const guest = seat();
      const c = cut();
      owner.store.replaceAll(c.p);
      connect(owner.store.doc, guest.store.doc);
      connect(owner.review.doc, guest.review.doc);
      note(guest, 60, 'on the first shot');
      note(guest, 250, 'on the third shot');
      const steps = owner.store.undoManager.undoStack.length;
      const drag = ramper(owner, [c.fractal.id], { ripple: true, markers: true }, told);
      const to = (v: number): void => drag(level(c.fractal.id, v));
      const id = (text: string): string => guest.review.get().find((n) => n.text === text)!.id;
      const both = (expected: Record<string, number>): void => {
        for (const s of [owner, guest]) expect(Object.fromEntries(notes(s))).toEqual(expected);
      };

      to(0.5);
      rest();
      // Slower still, and before the drag has rested: the second shot runs from 120 to 320 and the
      // third begins at 320. The guest pins notes on the picture as it is now.
      to(0.6);
      expect(owner.store.get().clips[c.aurora.id].start).toBe(320);
      note(guest, 330, 'new on the third');
      note(guest, 150, 'new on the second');
      note(guest, 300, 'new late in the second');
      guest.review.move(new Map([[id('on the first shot'), 340]]));
      guest.review.remove(id('on the third shot'));

      for (const [v, second, third, late] of [
        [0.4, 420, 420, 300],
        [0.8, 270, 270, 270],
        [0.5, 360, 360, 300],
      ]) {
        to(v);
        rest();
        expect(clipEnd(owner.store.get().clips[c.fractal.id])).toBe(second);
        expect(guest.store.get().clips[c.aurora.id].start).toBe(third);
        both({
          'new on the second': 150,
          'new late in the second': late,
          'new on the third': third + 10,
          'on the first shot': third + 20,
        });
      }

      expect(owner.store.undoManager.undoStack.length).toBe(steps + 1);
      owner.store.undo();
      expect(layout(guest.store.get(), c.v1)).toEqual(['0-120', '120-240', '240-360']);
      both({
        'new on the second': 150,
        'new late in the second': 300,
        'new on the third': 330,
        'on the first shot': 340,
      });
    });
  }
});
