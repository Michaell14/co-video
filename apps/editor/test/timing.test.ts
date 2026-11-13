import { describe, expect, it } from 'vitest';
import {
  addAssetToTimeline,
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
import { markerEdits } from '../src/state/edits';
import {
  durationEdits,
  makeRoomEdits,
  moveEdits,
  retimeComments,
  reverseEdits,
  speedCutShort,
  speedEach,
  speedEdits,
  speedGesture,
  speedGestureCutShort,
  speedRippleEdits,
  speedStepped,
  type SpeedGesture,
  type SpeedGestureOptions,
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
function scrubber(start: Project, ids: string[], options?: SpeedGestureOptions) {
  let gesture: SpeedGesture | null = null;
  const state = { p: start, gestures: 0 };
  return {
    state,
    to(speed: number): Clip[] {
      const g = speedGesture(gesture, state.p, ids, options);
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

/** Three sync clips back to back on V1 and A1, music under them on A2 and a title over the third. */
function cut() {
  const f = fixture();
  const a2 = makeTrack('audio', 1);
  let p = applyEdits(f.p, [{ op: 'addTrack', track: a2 }]);
  const pairs: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const init = { linkId: `L${i}`, sourceIn: 1 };
    const v = add(p, f.v1, i * 120, 120, init);
    const a = add(v.p, f.a1, i * 120, 120, init);
    p = a.p;
    pairs.push([v.clip.id, a.clip.id]);
  }
  const bed = add(p, a2, 0, 360, { assetId: null });
  const title = makeClip('text', f.v2.id, { start: 300, duration: 45 });
  p = applyEdits(bed.p, [
    { op: 'addClip', clip: title },
    { op: 'setMarker', marker: { id: 'second', frame: 120, name: 'second', color: '#fff', note: '' } },
    { op: 'setMarker', marker: { id: 'third', frame: 240, name: 'third', color: '#fff', note: '' } },
  ]);
  return { ...f, a2, p, pairs, bed: bed.clip, title };
}

const markers = (p: Project): number[] =>
  Object.values(p.markers)
    .map((m) => m.frame)
    .sort((a, b) => a - b);

describe('a change of speed under ripple editing', () => {
  it('lets a slowed clip play all it played before and moves what follows along, on every track', () => {
    const c = cut();
    const r = speedRippleEdits(c.p, c.pairs[0], 0.5);
    expect(r.refused).toBeNull();
    const p = applyEdits(c.p, [...r.edits, ...markerEdits(c.p, r.edits, r.spans)]);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+240', '240+120', '360+120']);
    // The title is still 60 frames into the third shot; the music, which lies across, stays.
    expect(layout(p, c.v2)).toEqual(['420+45']);
    expect(layout(p, c.a2)).toEqual(['0+360']);
    expect(p.clips[c.pairs[0][0]]).toMatchObject({ speed: 0.5, sourceIn: 1 });
    expect(r.spans).toEqual([{ from: 120, by: 120 }]);
    expect(markers(p)).toEqual([240, 360]);
  });

  it('closes exactly the frames a faster clip gives up, not a gap that was there before', () => {
    const c = cut();
    // The second pair starts 30 frames after the first ends.
    const gapped = applyEdits(
      c.p,
      [...c.pairs[1], ...c.pairs[2], c.title.id].map((id): Edit => ({
        op: 'updateClip',
        id,
        patch: { start: c.p.clips[id].start + 30 },
      })),
    );
    const r = speedRippleEdits(gapped, c.pairs[0], 2);
    const p = applyEdits(gapped, r.edits);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+60', '90+120', '210+120']);
    expect(layout(p, c.v2)).toEqual(['270+45']);
    expect(r.spans).toEqual([{ from: 60, by: -60 }]);
  });

  it('takes the timeline back to where it was when the speed goes back', () => {
    const c = cut();
    let p = applyEdits(c.p, speedRippleEdits(c.p, c.pairs[1], 0.5).edits);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+120', '120+240', '360+120']);
    p = applyEdits(p, speedRippleEdits(p, c.pairs[1], 4).edits);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+120', '120+30', '150+120']);
    p = applyEdits(p, speedRippleEdits(p, c.pairs[1], 1).edits);
    expect(p.clips).toEqual(c.p.clips);
  });

  it('keeps a reversed clip on its source range, and ripples by the same frames', () => {
    const c = cut();
    const reversed = applyEdits(
      c.p,
      c.pairs[0].map((id): Edit => ({ op: 'updateClip', id, patch: { reverse: true } })),
    );
    const p = applyEdits(reversed, speedRippleEdits(reversed, c.pairs[0], 0.5).edits);
    expect(p.clips[c.pairs[0][0]]).toMatchObject({ speed: 0.5, duration: 240, sourceIn: 1, reverse: true });
    expect(layout(p, c.v1)).toEqual(['0+240', '240+120', '360+120']);
  });

  it('ripples once for a split edit, by the change of the picture, and leaves no hole in it', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 100, { linkId: 'L' });
    const a = add(v.p, f.a1, 0, 130, { linkId: 'L' });
    const nextV = add(a.p, f.v1, 100, 60);
    const nextA = add(nextV.p, f.a1, 130, 60);
    const ids = [a.clip.id, v.clip.id];
    // The sound still runs 30 frames on under the next shot, and stops at the sound that follows.
    const slow = applyEdits(nextA.p, speedRippleEdits(nextA.p, ids, 0.5).edits);
    expect(layout(slow, f.v1)).toEqual(['0+200', '200+60']);
    expect(layout(slow, f.a1)).toEqual(['0+230', '230+60']);
    const fast = applyEdits(nextA.p, speedRippleEdits(nextA.p, ids, 2).edits);
    expect(layout(fast, f.v1)).toEqual(['0+50', '50+60']);
    expect(layout(fast, f.a1)).toEqual(['0+65', '80+60']);
    // The other way round, with the picture the longer of the two.
    const longer = applyEdits(nextA.p, [
      { op: 'updateClip', id: v.clip.id, patch: { duration: 130 } },
      { op: 'updateClip', id: nextV.clip.id, patch: { start: 130 } },
      { op: 'updateClip', id: a.clip.id, patch: { duration: 100 } },
      { op: 'updateClip', id: nextA.clip.id, patch: { start: 100 } },
    ]);
    const faster = applyEdits(longer, speedRippleEdits(longer, ids, 2).edits);
    expect(layout(faster, f.v1)).toEqual(['0+65', '65+60']);
    expect(layout(faster, f.a1)).toEqual(['0+35', '35+60']);
  });

  it('leaves no hole when the linked sound is shorter than the frames the picture gives up', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L' });
    const blip = add(v.p, f.a1, 0, 40, { linkId: 'L' });
    const nextV = add(blip.p, f.v1, 120, 120, { linkId: 'M' });
    const nextA = add(nextV.p, f.a1, 120, 120, { linkId: 'M' });
    const marked = applyEdits(nextA.p, [
      { op: 'setMarker', marker: { id: 'in', frame: 30, name: 'in', color: '#fff', note: '' } },
      { op: 'setMarker', marker: { id: 'next', frame: 120, name: 'next', color: '#fff', note: '' } },
    ]);
    for (const [speed, length, sound] of [
      [2, 60, 20],
      [4, 30, 10],
    ]) {
      const r = speedRippleEdits(marked, [v.clip.id, blip.clip.id], speed);
      expect(r.refused).toBeNull();
      const p = applyEdits(marked, [...r.edits, ...markerEdits(marked, r.edits, r.spans)]);
      // The picture decides how far the next shot comes up; the sound only gets shorter.
      expect(layout(p, f.v1)).toEqual([`0+${length}`, `${length}+120`]);
      expect(layout(p, f.a1)).toEqual([`0+${sound}`, `${length}+120`]);
      // Time went out of the end of the picture, so the marker inside the shot stays inside it.
      expect(r.spans).toEqual([{ from: length, by: length - 120 }]);
      expect(markers(p)).toEqual([30, length]);
    }
  });

  it('is refused when the sound of the next shot begins under the picture and cannot come up with it', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L' });
    const blip = add(v.p, f.a1, 0, 40, { linkId: 'L' });
    const nextV = add(blip.p, f.v1, 120, 120, { linkId: 'M' });
    const nextA = add(nextV.p, f.a1, 40, 200, { linkId: 'M' });
    const r = speedRippleEdits(nextA.p, [v.clip.id, blip.clip.id], 2);
    expect(r.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    expect(r.spans).toEqual([]);
    // The speed is set as it is without ripple editing, and neither clip is cut down for it.
    const p = applyEdits(nextA.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0+60', '120+120']);
    expect(layout(p, f.a1)).toEqual(['0+20', '40+200']);
  });

  it('changes each of several selected clips and never lays one over another', () => {
    const c = cut();
    const r = speedRippleEdits(c.p, [...c.pairs[0], ...c.pairs[1]], 0.5);
    const p = applyEdits(c.p, [...r.edits, ...markerEdits(c.p, r.edits, r.spans)]);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+240', '240+240', '480+120']);
    expect(markers(p)).toEqual([240, 480]);
  });

  it('updates each clip once, however many of the selected clips moved it on the way', () => {
    const c = cut();
    const all = c.pairs.flat();
    const r = speedRippleEdits(c.p, all, 0.5);
    const updated = r.edits.map((e) => (e.op === 'updateClip' ? e.id : e.op));
    // The six sync clips and the title; the music lies across every cut and stays.
    expect(updated.sort()).toEqual([...all, c.title.id].sort());
    const p = applyEdits(c.p, r.edits);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+240', '240+240', '480+240']);
    expect(layout(p, c.v2)).toEqual(['540+45']);
    // Room made afterwards for the same clips is asked for the same way.
    const slowed = applyEdits(c.p, speedEach(c.p, all, 0.5));
    const short = speedCutShort(c.p, all, 0.5);
    const room = makeRoomEdits(slowed, Object.fromEntries(short.map((s) => [s.id, s.natural])));
    expect(room.edits).toHaveLength(7);
    expect(applyEdits(slowed, room.edits).clips).toEqual(p.clips);
  });

  it('sets the speed all the same when the ripple is refused, and says why nothing followed', () => {
    const c = cut();
    // Only the picture: its sound, and the sound after it, cannot be parted from their pictures.
    const r = speedRippleEdits(c.p, [c.pairs[0][0]], 2);
    expect(r.refused).toMatch(/^Cannot ripple here/);
    const p = applyEdits(c.p, r.edits);
    expect(layout(p, c.v1)).toEqual(['0+60', '120+120', '240+120']);
    expect(layout(p, c.a1)).toEqual(['0+120', '120+120', '240+120']);
    expect(r.spans).toEqual([]);
  });

  it('leaves clips without a speed out, and does nothing to time when the speed is unchanged', () => {
    const c = cut();
    expect(speedRippleEdits(c.p, [c.title.id], 2)).toEqual({ edits: [], refused: null, spans: [] });
    const same = speedRippleEdits(c.p, c.pairs[0], 1, true);
    expect(same.spans).toEqual([]);
    const p = applyEdits(c.p, same.edits);
    expect(p.clips[c.pairs[0][0]]).toMatchObject({ reverse: true, duration: 120 });
    expect(layout(p, c.v1)).toEqual(['0+120', '120+120', '240+120']);
  });
});

describe('a change of speed for several clips at once', () => {
  it('never lays one selected clip over the next: each stops at the clip after it', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const both = [a.clip.id, b.clip.id];
    const p = applyEdits(b.p, speedEach(b.p, both, 0.5));
    expect(layout(p, f.v1)).toEqual(['0+120', '120+240']);
    // The operation itself says the same, asked about both at once.
    expect(applyEdits(b.p, setSpeed(b.p, both, 0.5)).clips).toEqual(p.clips);
    expect(p.clips[a.clip.id].speed).toBe(0.5);
    expect(speedCutShort(b.p, both, 0.5)).toEqual([{ id: a.clip.id, duration: 120, natural: 240 }]);
    // Faster, both simply shrink where they are.
    expect(layout(applyEdits(b.p, speedEach(b.p, both, 2)), f.v1)).toEqual(['0+60', '120+60']);
  });

  it('is the operation itself for one clip, and for clips that are not neighbours', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L' });
    const s = add(v.p, f.a1, 0, 120, { linkId: 'L' });
    const ids = [v.clip.id, s.clip.id];
    expect(applyEdits(s.p, speedEach(s.p, ids, 0.25, true)).clips).toEqual(
      applyEdits(s.p, setSpeed(s.p, ids, 0.25, true)).clips,
    );
    expect(speedEach(s.p, ['gone'], 2)).toEqual([]);
  });

  it('asks about every clip once, in the project as it is, whatever the order they come in', () => {
    const f = fixture();
    let p = f.p;
    const ids: string[] = [];
    // Twelve clips back to back, two gaps among them, some at another speed or played backwards.
    for (let i = 0; i < 12; i++) {
      const init = { speed: i % 3 === 0 ? 2 : 1, reverse: i % 4 === 1, sourceIn: 2 };
      const c = add(p, f.v1, i * 50 + (i > 5 ? 20 : 0) + (i > 8 ? 35 : 0), 50, init);
      p = c.p;
      ids.push(c.clip.id);
    }
    for (const speed of [0.25, 0.5, 2]) {
      const edits = speedEach(p, [...ids, ids[3]], speed);
      expect(edits).toEqual(ids.flatMap((id) => setSpeed(p, [id], speed)));
      expect(applyEdits(p, speedEach(p, [...ids].reverse(), speed)).clips).toEqual(
        applyEdits(p, edits).clips,
      );
    }
    const slowed = applyEdits(p, speedEach(p, ids, 0.25));
    expect(layout(slowed, f.v1)).toEqual([
      ...['0+50', '50+50', '100+50', '150+50', '200+50', '250+70'],
      ...['320+50', '370+50', '420+85', '505+50', '555+50', '605+200'],
    ]);
  });

  it('holds for a gesture and under ripple editing as well', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const both = [a.clip.id, b.clip.id];
    const scrub = scrubber(b.p, both);
    scrub.to(0.5);
    expect(layout(scrub.state.p, f.v1)).toEqual(['0+120', '120+240']);
    scrub.to(1);
    expect(scrub.state.p.clips).toEqual(b.p.clips);
    const rippled = applyEdits(b.p, speedRippleEdits(b.p, both, 0.5).edits);
    expect(layout(rippled, f.v1)).toEqual(['0+240', '240+240']);
  });
});

describe('a change of speed that the next clip cuts short', () => {
  it('is reported with the length the clip would have, and can be given its room afterwards', () => {
    const c = cut();
    const short = speedCutShort(c.p, c.pairs[0], 0.5);
    expect(short).toEqual(c.pairs[0].map((id) => ({ id, duration: 120, natural: 240 })));
    const slowed = applyEdits(c.p, setSpeed(c.p, c.pairs[0], 0.5));
    const r = makeRoomEdits(slowed, Object.fromEntries(short.map((s) => [s.id, s.natural])));
    expect(r.refused).toBeNull();
    const p = applyEdits(slowed, [...r.edits, ...markerEdits(slowed, r.edits, r.spans)]);
    // The same timeline as setting the speed with ripple editing on.
    expect(p.clips).toEqual(applyEdits(c.p, speedRippleEdits(c.p, c.pairs[0], 0.5).edits).clips);
    expect(markers(p)).toEqual([240, 360]);
  });

  it('fills the room it makes also when the media is not a whole number of frames long', () => {
    // Placed whole, 4.02 s of media is 121 frames at 30 fps, and 4 s is 96 at 23.976: both a
    // fraction of a frame more than there is, which a trim to the end of the media would not give.
    for (const [duration, fpsNum, fpsDen] of [
      [4.02, 30, 1],
      [4.03, 30, 1],
      [4, 24000, 1001],
    ]) {
      const f = fixture();
      const asset = { ...f.p.assets.asset1, id: 'odd', duration, hasVideo: true, hasAudio: true };
      let p = applyEdits(f.p, [
        { op: 'settings', patch: { fpsNum, fpsDen } },
        { op: 'addAsset', asset },
      ]);
      const first = addAssetToTimeline(p, asset, { frame: 0 });
      p = applyEdits(p, first.edits);
      const length = p.clips[first.created[0]].duration;
      p = applyEdits(p, addAssetToTimeline(p, asset, { frame: length }).edits);
      for (const speed of [0.5, 0.25]) {
        const short = speedCutShort(p, first.created, speed);
        expect(short.map((c) => c.natural)).toEqual([length / speed, length / speed]);
        const slowed = applyEdits(p, speedEach(p, first.created, speed));
        const r = makeRoomEdits(slowed, Object.fromEntries(short.map((c) => [c.id, c.natural])));
        const roomy = applyEdits(slowed, r.edits);
        // No frame of black or silence between the slowed clip and the next, on either track.
        for (const t of [f.v1, f.a1]) {
          expect(layout(roomy, t)).toEqual([`0+${length / speed}`, `${length / speed}+${length}`]);
        }
        expect(roomy.clips).toEqual(applyEdits(p, speedRippleEdits(p, first.created, speed).edits).clips);
      }
    }
  });

  it('gives a reversed clip back the part of its range that was cut off', () => {
    const c = cut();
    const reversed = applyEdits(
      c.p,
      c.pairs[0].map((id): Edit => ({ op: 'updateClip', id, patch: { reverse: true } })),
    );
    const slowed = applyEdits(reversed, setSpeed(reversed, c.pairs[0], 0.5));
    expect(slowed.clips[c.pairs[0][0]].sourceIn).toBeCloseTo(3);
    const wants = Object.fromEntries(c.pairs[0].map((id) => [id, 240]));
    const p = applyEdits(slowed, makeRoomEdits(slowed, wants).edits);
    expect(p.clips[c.pairs[0][0]].duration).toBe(240);
    expect(p.clips[c.pairs[0][0]].sourceIn).toBeCloseTo(1);
  });

  it('reports nothing when the clip has room, gets faster, or is the last on its track', () => {
    const c = cut();
    expect(speedCutShort(c.p, c.pairs[0], 2)).toEqual([]);
    expect(speedCutShort(c.p, c.pairs[2], 0.5)).toEqual([]);
    expect(speedCutShort(c.p, [c.title.id], 0.5)).toEqual([]);
  });

  it('is known for a gesture too, from where the gesture began', () => {
    const c = cut();
    const scrub = scrubber(c.p, c.pairs[0]);
    let gesture = speedGesture(null, c.p, c.pairs[0]);
    for (const speed of [0.8, 0.5]) {
      scrub.to(speed);
      gesture = speedStepped(gesture, scrub.state.p);
    }
    expect(speedGestureCutShort(gesture, scrub.state.p)).toEqual(speedCutShort(c.p, c.pairs[0], 0.5));
    scrub.to(2);
    expect(speedGestureCutShort(speedStepped(gesture, scrub.state.p), scrub.state.p)).toEqual([]);
  });

  it('says why when no room can be made, and changes nothing', () => {
    const c = cut();
    // The sound is locked: the pictures after the slowed one cannot leave their sound behind.
    const locked = applyEdits(c.p, [{ op: 'updateTrack', id: c.a1.id, patch: { locked: true } }]);
    const slowed = applyEdits(locked, setSpeed(locked, [c.pairs[0][0]], 0.5));
    const r = makeRoomEdits(slowed, { [c.pairs[0][0]]: 240 });
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Unlock A1 to ripple: a linked clip on it has to move too.');
  });
});

describe('a speed gesture under ripple editing', () => {
  it('moves what follows with every step and leaves nothing behind on the way back', () => {
    const c = cut();
    const scrub = scrubber(c.p, c.pairs[0], { ripple: true, markers: true });
    scrub.to(0.7);
    expect(layout(scrub.state.p, c.v1)).toEqual(['0+171', '171+120', '291+120']);
    expect(markers(scrub.state.p)).toEqual([171, 291]);
    scrub.to(0.5);
    expect(layout(scrub.state.p, c.v1)).toEqual(['0+240', '240+120', '360+120']);
    expect(layout(scrub.state.p, c.v2)).toEqual(['420+45']);
    expect(markers(scrub.state.p)).toEqual([240, 360]);
    scrub.to(2);
    for (const t of [c.v1, c.a1]) expect(layout(scrub.state.p, t)).toEqual(['0+60', '60+120', '180+120']);
    expect(markers(scrub.state.p)).toEqual([60, 180]);
    scrub.to(1);
    expect(scrub.state.p).toEqual(c.p);
    expect(scrub.state.gestures).toBe(1);
  });

  it('ends where one change of speed under ripple editing ends', () => {
    const c = cut();
    const scrub = scrubber(c.p, c.pairs[1], { ripple: true });
    for (const speed of [0.9, 0.6, 3, 0.25]) scrub.to(speed);
    expect(scrub.state.p.clips).toEqual(applyEdits(c.p, speedRippleEdits(c.p, c.pairs[1], 0.25).edits).clips);
    // The markers were not asked to follow.
    expect(markers(scrub.state.p)).toEqual([120, 240]);
  });

  it('goes on while things that do not move on the timeline are edited', () => {
    const c = cut();
    const scrub = scrubber(c.p, c.pairs[0], { ripple: true, markers: true });
    scrub.to(0.5);
    scrub.meanwhile([
      { op: 'updateClip', id: c.title.id, patch: { opacity: 0.5 } },
      { op: 'updateTrack', id: c.v1.id, patch: { name: 'Main' } },
    ]);
    scrub.to(1);
    expect(scrub.state.gestures).toBe(1);
    expect(layout(scrub.state.p, c.v2)).toEqual(['300+45']);
    expect(scrub.state.p.clips[c.title.id].opacity).toBe(0.5);
  });

  it('starts over, without undoing it, once somebody has moved a clip or a marker meanwhile', () => {
    const c = cut();
    const scrub = scrubber(c.p, c.pairs[0], { ripple: true, markers: true });
    scrub.to(0.5);
    // The title was at 420 after that step; a collaborator moves it to 500.
    scrub.meanwhile([{ op: 'updateClip', id: c.title.id, patch: { start: 500 } }]);
    scrub.to(1);
    expect(scrub.state.gestures).toBe(2);
    expect(layout(scrub.state.p, c.v1)).toEqual(['0+120', '120+120', '240+120']);
    expect(layout(scrub.state.p, c.v2)).toEqual(['380+45']);
    scrub.meanwhile([{ op: 'setMarker', marker: { ...scrub.state.p.markers.third, frame: 10 } }]);
    scrub.to(0.5);
    expect(scrub.state.gestures).toBe(3);
    expect(markers(scrub.state.p)).toEqual([10, 240]);
  });

  it('is a gesture of its own kind: switching ripple editing starts a new one', () => {
    const c = cut();
    const g = speedGesture(null, c.p, c.pairs[0], { ripple: true });
    const p = applyEdits(c.p, speedEdits(g, c.p, 0.5));
    const stepped = speedStepped(g, p);
    expect(speedGesture(stepped, p, c.pairs[0], { ripple: true })).toBe(stepped);
    expect(speedGesture(stepped, p, c.pairs[0])).not.toBe(stepped);
    expect(speedGesture(stepped, p, c.pairs[0], { ripple: true, markers: true })).not.toBe(stepped);
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
      spans: [],
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
