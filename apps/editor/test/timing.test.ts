import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  ASSET_DEFAULTS,
  clipEnd,
  emptyProject,
  makeClip,
  makeTrack,
  setSpeed,
  type Clip,
  type Edit,
  type Project,
  type Track,
} from '@tandem/core';
import {
  durationEdits,
  moveEdits,
  retimeComments,
  reverseEdits,
  speedEdits,
  speedGesture,
  speedStepped,
  type SpeedGesture,
} from '../src/state/timing';

interface Fixture {
  p: Project;
  v1: Track;
  v2: Track;
  a1: Track;
}

/** Tracks V1, V2 and A1, and a ten-second video file at the project's 30 fps. */
function fixture(): Fixture {
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
  return { p, v1, v2, a1 };
}

function add(p: Project, track: Track, start: number, duration: number, init: Partial<Clip> = {}) {
  const clip = makeClip(track.kind === 'audio' ? 'audio' : 'video', track.id, {
    assetId: 'asset1',
    start,
    duration,
    ...init,
  });
  return { p: applyEdits(p, [{ op: 'addClip', clip }]), clip };
}

const layout = (p: Project, t: Track): string[] =>
  Object.values(p.clips)
    .filter((c) => c.trackId === t.id)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.start}+${c.duration}`);

/** A speed gesture the way the inspector drives it: every step commits, and may open a new one. */
function scrubber(start: Project, ids: string[]) {
  let gesture: SpeedGesture | null = null;
  const state = { p: start, gestures: 0 };
  return {
    state,
    to(speed: number): Clip[] {
      const g = speedGesture(gesture, state.p, ids);
      if (g !== gesture) state.gestures++;
      state.p = applyEdits(state.p, speedEdits(g, state.p, speed));
      gesture = speedStepped(g, state.p);
      return ids.map((id) => state.p.clips[id]);
    },
    /** Something else edits the project between two steps. */
    meanwhile(edits: Edit[]): void {
      state.p = applyEdits(state.p, edits);
    },
  };
}

describe('a speed gesture', () => {
  it('works every step out from where it began', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { fadeIn: 100, keyframes: { x: [{ t: 60, v: 1, e: 'linear' }] } });
    const b = add(a.p, f.v1, 120, 120);
    const scrub = scrubber(b.p, [a.clip.id]);
    // Down to 70%: the clip would grow to 171 frames, and the next clip holds it at 120.
    expect(scrub.to(0.7)[0]).toMatchObject({ speed: 0.7, duration: 120 });
    // Up to 400%: 30 frames, with the fade cut to fit and the keyframe moved in.
    const fast = scrub.to(4)[0];
    expect(fast).toMatchObject({ speed: 4, duration: 30, fadeIn: 30 });
    expect(fast.keyframes.x[0].t).toBe(15);
    // Back at 100% the clip is what it was, fade and keyframe included.
    expect(scrub.to(1)[0]).toEqual(a.clip);
    expect(scrub.state.gestures).toBe(1);
  });

  it('differs from stepping through the intermediate speeds, which loses the tail', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const slowed = applyEdits(b.p, setSpeed(b.p, [a.clip.id], 0.7));
    const back = applyEdits(slowed, setSpeed(slowed, [a.clip.id], 1));
    expect(back.clips[a.clip.id].duration).toBe(84);
  });

  it('gives the same result as one setSpeed for the speed it ends on', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { reverse: true });
    const b = add(a.p, f.v1, 120, 120);
    const scrub = scrubber(b.p, [a.clip.id]);
    scrub.to(0.5);
    expect(scrub.to(2)[0]).toEqual(applyEdits(b.p, setSpeed(b.p, [a.clip.id], 2)).clips[a.clip.id]);
  });

  it('goes on while other things in the project are edited', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const title = makeClip('text', f.v2.id, { start: 0, duration: 60 });
    const scrub = scrubber(applyEdits(b.p, [{ op: 'addClip', clip: title }]), [a.clip.id]);
    for (const speed of [0.9, 0.8, 0.7, 0.8, 0.9, 1]) {
      scrub.to(speed);
      // A collaborator works on the title, renames the track and grades the very clip being scrubbed.
      scrub.meanwhile([
        { op: 'updateClip', id: title.id, patch: { opacity: speed / 2, start: Math.round(speed * 10) } },
        { op: 'updateTrack', id: f.v1.id, patch: { name: `Main ${speed}` } },
        { op: 'updateClip', id: a.clip.id, patch: { opacity: speed / 2 } },
      ]);
    }
    expect(scrub.state.p.clips[a.clip.id]).toEqual({ ...a.clip, opacity: 0.5 });
    expect(scrub.state.gestures).toBe(1);
  });

  it('is held by the next clip where that clip is now, not where it was', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const scrub = scrubber(b.p, [a.clip.id]);
    expect(scrub.to(0.5)[0].duration).toBe(120);
    scrub.meanwhile([{ op: 'updateClip', id: b.clip.id, patch: { start: 200 } }]);
    expect(scrub.to(0.5)[0].duration).toBe(200);
    expect(scrub.to(2)[0].duration).toBe(60);
    scrub.meanwhile([{ op: 'updateClip', id: b.clip.id, patch: { start: 90 } }]);
    expect(scrub.to(1)[0].duration).toBe(90);
    expect(scrub.state.gestures).toBe(1);
  });

  it('starts over once the clip has been re-timed under it', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const scrub = scrubber(a.p, [a.clip.id]);
    scrub.to(2);
    // An undo, or somebody's trim: the clip is no longer what the last step left.
    scrub.meanwhile([{ op: 'updateClip', id: a.clip.id, patch: { speed: 1, duration: 90 } }]);
    expect(scrub.to(0.5)[0]).toMatchObject({ speed: 0.5, duration: 180 });
    expect(scrub.state.gestures).toBe(2);
  });

  it('covers the clips it began with and no others', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v2, 0, 60);
    const g = speedGesture(null, b.p, [a.clip.id]);
    const p = applyEdits(b.p, speedEdits(g, b.p, 2));
    const stepped = speedStepped(g, p);
    expect(speedGesture(stepped, p, [a.clip.id])).toBe(stepped);
    expect(speedGesture(stepped, p, [a.clip.id, b.clip.id])).not.toBe(stepped);
    expect(speedGesture(stepped, applyEdits(p, [{ op: 'removeClip', id: a.clip.id }]), [])).not.toBe(stepped);
  });
});

describe('reverseEdits', () => {
  it('changes the direction and nothing else, whatever speed each clip has', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 60, { speed: 2 });
    const p = applyEdits(b.p, reverseEdits(b.p, [a.clip.id, b.clip.id], true));
    expect(p.clips[a.clip.id]).toEqual({ ...a.clip, reverse: true });
    expect(p.clips[b.clip.id]).toEqual({ ...b.clip, reverse: true });
  });

  it('leaves clips alone that have no direction or already play that way', () => {
    const f = fixture();
    const still = add(f.p, f.v1, 0, 60, { freeze: true });
    const done = add(still.p, f.v1, 60, 60, { reverse: true });
    const title = makeClip('text', f.v2.id, { start: 0, duration: 60 });
    const p = applyEdits(done.p, [{ op: 'addClip', clip: title }]);
    expect(reverseEdits(p, [still.clip.id, done.clip.id, title.id, 'gone'], true)).toEqual([]);
  });
});

describe('durationEdits', () => {
  it('stops at the next clip and says so', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 90, 60);
    const r = durationEdits(b.p, [[a.clip.id]], 200, false);
    expect(layout(applyEdits(b.p, r.edits), f.v1)).toEqual(['0+90', '90+60']);
    expect(r).toMatchObject({ limited: true, refused: null });
  });

  it('stops at the end of the media', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const r = durationEdits(a.p, [[a.clip.id]], 900, false);
    // Ten seconds of source at 30 fps.
    expect(layout(applyEdits(a.p, r.edits), f.v1)).toEqual(['0+300']);
    expect(r.limited).toBe(true);
  });

  it('shortens without moving what follows, and moves it along in ripple mode', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 60);
    const plain = durationEdits(b.p, [[a.clip.id]], 60, false);
    expect(layout(applyEdits(b.p, plain.edits), f.v1)).toEqual(['0+60', '120+60']);
    expect(plain.limited).toBe(false);
    const ripple = durationEdits(b.p, [[a.clip.id]], 60, true);
    expect(layout(applyEdits(b.p, ripple.edits), f.v1)).toEqual(['0+60', '60+60']);
    const longer = durationEdits(b.p, [[a.clip.id]], 200, true);
    expect(layout(applyEdits(b.p, longer.edits), f.v1)).toEqual(['0+200', '200+60']);
    expect(longer.limited).toBe(false);
  });

  it('gives every clip of a selection the length, each from its own', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 40);
    const c = add(b.p, f.v1, 200, 90);
    const r = durationEdits(c.p, [[a.clip.id], [b.clip.id], [c.clip.id]], 60, false);
    expect(layout(applyEdits(c.p, r.edits), f.v1)).toEqual(['0+60', '120+60', '200+60']);
    const rippled = durationEdits(c.p, [[a.clip.id], [b.clip.id], [c.clip.id]], 60, true);
    expect(layout(applyEdits(c.p, rippled.edits), f.v1)).toEqual(['0+60', '60+60', '160+60']);
  });

  it('trims a linked partner by the same amount, once', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'pair' });
    const a = add(v.p, f.a1, 0, 120, { linkId: 'pair' });
    const groups = [
      [v.clip.id, a.clip.id],
      [a.clip.id, v.clip.id],
    ];
    const r = durationEdits(a.p, groups, 45, true);
    const p = applyEdits(a.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0+45']);
    expect(layout(p, f.a1)).toEqual(['0+45']);
  });

  it('never makes a clip shorter than one frame and does nothing when the length is already right', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    expect(durationEdits(a.p, [[a.clip.id]], 60, false)).toEqual({
      edits: [],
      refused: null,
      limited: false,
    });
    const r = durationEdits(a.p, [[a.clip.id]], 0, false);
    expect(layout(applyEdits(a.p, r.edits), f.v1)).toEqual(['0+1']);
  });

  it('reports a ripple that is refused instead of half doing it', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120);
    const next = add(v.p, f.v1, 120, 60, { linkId: 'pair' });
    const partner = add(next.p, f.a1, 120, 60, { linkId: 'pair' });
    const p = applyEdits(partner.p, [{ op: 'updateTrack', id: f.a1.id, patch: { locked: true } }]);
    const r = durationEdits(p, [[v.clip.id]], 60, true);
    expect(r.edits).toEqual([]);
    expect(r.refused).toMatch(/Unlock/);
  });
});

describe('moveEdits', () => {
  it('moves to a free place, also past other clips', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 60, 60);
    const r = moveEdits(b.p, [a.clip.id], 300);
    expect(layout(applyEdits(b.p, r.edits), f.v1)).toEqual(['60+60', '300+60']);
    expect(r.limited).toBe(false);
  });

  it('stops at the first clip in the way when the place asked for is taken', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 100, 60);
    const right = moveEdits(b.p, [a.clip.id], 80);
    expect(layout(applyEdits(b.p, right.edits), f.v1)).toEqual(['40+60', '100+60']);
    expect(right.limited).toBe(true);
    const left = moveEdits(b.p, [b.clip.id], 30);
    expect(layout(applyEdits(b.p, left.edits), f.v1)).toEqual(['0+60', '60+60']);
    expect(left.limited).toBe(true);
  });

  it('does nothing when a neighbour already touches', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 60, 60);
    expect(moveEdits(b.p, [b.clip.id], 30)).toEqual({ edits: [], limited: true });
  });

  it('keeps several clips together and never overlaps anything', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.a1, 20, 60);
    const wall = add(b.p, f.a1, 200, 60);
    const p = wall.p;
    // The earliest clip is asked to start at 150; the audio clip would land on the one at 200.
    const r = moveEdits(p, [a.clip.id, b.clip.id], 150);
    const q = applyEdits(p, r.edits);
    expect(layout(q, f.v1)).toEqual(['120+60']);
    expect(layout(q, f.a1)).toEqual(['140+60', '200+60']);
    expect(r.limited).toBe(true);
    const sorted = Object.values(q.clips)
      .filter((c) => c.trackId === f.a1.id)
      .sort((x, y) => x.start - y.start);
    expect(clipEnd(sorted[0])).toBeLessThanOrEqual(sorted[1].start);
  });

  it('does not go before the start of the timeline', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 40, 60);
    const r = moveEdits(a.p, [a.clip.id], -500);
    expect(layout(applyEdits(a.p, r.edits), f.v1)).toEqual(['0+60']);
    expect(r.limited).toBe(false);
  });
});

describe('retimeComments', () => {
  const comments = [
    { id: 'a', frame: 7 },
    { id: 'b', frame: 900 },
    { id: 'c', frame: 0 },
  ];

  it('scales frames by the change of rate and reports only what moved', () => {
    expect(retimeComments(comments, 2)).toEqual({ a: [7, 14], b: [900, 1800] });
    expect(retimeComments(comments, 24 / 30)).toEqual({ a: [7, 6], b: [900, 720] });
  });

  it('takes a change back to the exact frames, where rounding alone would drift', () => {
    const there = retimeComments(comments, 24 / 30);
    const at24 = comments.map((c) => ({ id: c.id, frame: there[c.id]?.[1] ?? c.frame }));
    // 6 × 1.25 rounds to 8, not to the 7 the comment came from.
    expect(retimeComments(at24, 30 / 24).a).toEqual([6, 8]);
    expect(retimeComments(at24, 30 / 24, there)).toEqual({ a: [6, 7], b: [720, 900] });
  });

  it('scales a comment that was added or moved after the change', () => {
    const there = retimeComments(comments, 2);
    const later = [
      { id: 'a', frame: 20 },
      { id: 'new', frame: 100 },
    ];
    expect(retimeComments(later, 0.5, there)).toEqual({ a: [20, 10], new: [100, 50] });
  });
});
