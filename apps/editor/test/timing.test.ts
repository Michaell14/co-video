import { describe, expect, it } from 'vitest';
import {
  addAssetToTimeline,
  applyEdits,
  ASSET_DEFAULTS,
  clipEnd,
  emptyProject,
  makeClip,
  makeTrack,
  RAMP_SHAPES,
  setRamp,
  setSpeed,
  shapeRamp,
  sourceTimeAt,
  type Clip,
  type Edit,
  type Project,
  type RampChange,
  type RampPoint,
  type RampShape,
  type Track,
} from '@tandem/core';
import { markerEdits } from '../src/state/edits';
import {
  addPointChange,
  durationEdits,
  makeRoomEdits,
  moveEdits,
  rampGroups,
  rampLead,
  retimeComments,
  retimeEach,
  retimeRefusal,
  reverseEdits,
  shapeChange,
  speedCutShort,
  speedEach,
  speedEdits,
  speedGesture,
  speedGestureCutShort,
  speedRippleEdits,
  speedStepped,
  type Retime,
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
    // Three changes of speed, not one gesture that returns: the sound keeps its pitch from the first on.
    const sound = c.pairs[1][1];
    expect(p.clips).toEqual({ ...c.p.clips, [sound]: { ...c.p.clips[sound], keepPitch: true } });
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

/** One level speed for a clip from `from` to `to` seconds of its media: a ramp that is as simple as a speed. */
const level = (id: string, v: number, from = 0, to = 4): RampChange => ({
  ramps: {
    [id]: [
      { m: from, v },
      { m: to, v },
    ],
  },
});

const off = (id: string): RampChange => ({ ramps: { [id]: null } });

/** The change that puts the link groups of `ids` on a ready-made shape. */
function shaped(p: Project, ids: string[], shape: RampShape | 'none' | 'custom'): RampChange {
  const change = shapeChange(p, rampGroups(p, ids), shape);
  if (!change) throw new Error(`no room for ${shape}`);
  return change;
}

/** A ramp gesture the way a graph of points drives it: every step commits, and says what it asked for. */
function ramper(start: Project, ids: string[], options?: SpeedGestureOptions) {
  let gesture: SpeedGesture | null = null;
  const state = { p: start, gestures: 0 };
  return {
    state,
    to(step: Retime | number): Clip[] {
      const g = speedGesture(gesture, state.p, ids, { ...options, ramp: true });
      if (g !== gesture) state.gestures++;
      state.p = applyEdits(state.p, speedEdits(g, state.p, step));
      gesture = speedStepped(g, state.p, step);
      return ids.map((id) => state.p.clips[id]);
    },
    meanwhile(edits: Edit[]): void {
      state.p = applyEdits(state.p, edits);
    },
    gesture: (): SpeedGesture | null => gesture,
  };
}

/**
 * How far apart two clips are, in seconds of their media, on the frames of the timeline they
 * share: the most over those frames, or null when they share none.
 */
function apart(p: Project, a: Clip, b: Clip): number | null {
  const from = Math.max(a.start, b.start);
  const to = Math.min(clipEnd(a), clipEnd(b));
  if (to <= from) return null;
  let most = 0;
  for (let f = from; f < to; f++) {
    most = Math.max(most, Math.abs(sourceTimeAt(a, f - a.start, p) - sourceTimeAt(b, f - b.start, p)));
  }
  return most;
}

/** The clips that lie over another on their track. */
function overlapping(p: Project): string[] {
  const out: string[] = [];
  for (const t of Object.values(p.tracks)) {
    const list = Object.values(p.clips)
      .filter((c) => c.trackId === t.id)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < clipEnd(list[i - 1])) out.push(`${list[i - 1].start}+${list[i - 1].duration}`);
    }
  }
  return out;
}

/** A picture on V1 from frame 90 and its sound on A1, which begins 32 frames before it: a J cut. */
function jCut() {
  const f = fixture();
  const v = add(f.p, f.v1, 90, 120, { linkId: 'L', sourceIn: 2 });
  const a = add(v.p, f.a1, 58, 152, { linkId: 'L', sourceIn: 2 - 32 / 30 });
  return { ...f, p: a.p, picture: v.clip, sound: a.clip };
}

describe('the clips a ramp is set on', () => {
  it('are whole groups of linked clips, whatever was selected', () => {
    const c = cut();
    const [picture, sound] = c.pairs[0];
    expect(rampGroups(c.p, [picture])).toEqual([[sound, picture].sort()]);
    expect(rampGroups(c.p, [sound, picture, c.pairs[2][1]]).map((g) => g.length)).toEqual([2, 2]);
    // The music has no partner, and a title has no speed to ramp.
    expect(rampGroups(c.p, [c.bed.id, c.title.id])).toEqual([[c.bed.id]]);
    expect(rampGroups(c.p, ['gone'])).toEqual([]);
  });

  it('take their ramp from the picture, and from the first clip where there is none', () => {
    const c = cut();
    expect(rampLead(c.p, c.pairs[1])).toBe(c.pairs[1][0]);
    expect(rampLead(c.p, [...c.pairs[1]].reverse())).toBe(c.pairs[1][0]);
    expect(rampLead(c.p, [c.bed.id])).toBe(c.bed.id);
    const f = fixture();
    const late = add(f.p, f.a1, 50, 60, { linkId: 'S' });
    const early = add(late.p, f.a1, 0, 40, { linkId: 'S' });
    expect(rampLead(early.p, [late.clip.id, early.clip.id])).toBe(early.clip.id);
  });

  it('get a shape over the stretch of media each plays', () => {
    const c = cut();
    const second = add(c.p, c.v2, 0, 60, { sourceIn: 3, reverse: true });
    const groups = rampGroups(second.p, [c.pairs[0][1], second.clip.id]);
    const change = shapeChange(second.p, groups, 'flashIn');
    // One second to five for the pair, named for its picture; three to five, counted down, for the other.
    expect(change).toEqual({
      ramps: {
        [c.pairs[0][0]]: shapeRamp('flashIn', 1, 5, false),
        [second.clip.id]: shapeRamp('flashIn', 3, 5, true),
      },
    });
    expect(shapeChange(second.p, groups, 'none')).toEqual({
      ramps: { [c.pairs[0][0]]: null, [second.clip.id]: null },
    });
  });

  it('get a level ramp at their own speed to start from, as near as a ramp can be to it', () => {
    const f = fixture();
    const at = (speed: number) => add(f.p, f.v1, 0, 30, { speed, sourceIn: 2 });
    const points = (c: { p: Project; clip: Clip }): RampPoint[] | null | undefined =>
      shapeChange(c.p, [[c.clip.id]], 'custom')?.ramps[c.clip.id];
    expect(points(at(2))).toEqual([
      { m: 2, v: 2 },
      { m: 4, v: 2 },
    ]);
    // Twenty times as fast and a twentieth as fast are beyond what a ramp runs at.
    expect(points(at(20))?.map((q) => q.v)).toEqual([10, 10]);
    expect(points(at(0.05))?.map((q) => q.v)).toEqual([0.1, 0.1]);
    // A clip that is on a ramp keeps the very ramp it has.
    const ramp = shapeRamp('hero', 2, 3, false);
    const ramped = add(f.p, f.v1, 0, 30, { ramp, sourceIn: 2 });
    expect(points(ramped)).toBe(ramp);
  });

  it('keep the ramp they have when it is the shape asked for, however often it is asked for', () => {
    const c = cut();
    const ids = c.pairs[0];
    const once = applyEdits(c.p, retimeEach(c.p, ids, shaped(c.p, ids, 'bullet')));
    const ramp = once.clips[ids[0]].ramp;
    // 27 whole frames cover a little less than the four seconds the shape was laid over.
    expect(once.clips[ids[0]].duration).toBe(27);
    expect(shapeChange(once, rampGroups(once, ids), 'bullet')?.ramps[ids[0]]).toBe(ramp);
    expect(applyEdits(once, retimeEach(once, ids, shaped(once, ids, 'bullet')))).toEqual(once);
    // Another shape is laid over what the clip now covers: from second 1 to just short of second 5.
    const other = shapeChange(once, rampGroups(once, ids), 'rampUp')?.ramps[ids[0]];
    expect(other).toEqual([
      { m: 1, v: 0.5 },
      { m: 4.920952, v: 2 },
    ]);
  });

  it('are refused a shape that the media they play is too short to hold, and are not taken off their ramp instead', () => {
    const f = fixture();
    // One frame at a quarter of the speed is 8 ms of media. Bullet has points 12.5 ms apart at the least.
    const tiny = add(f.p, f.v1, 0, 1, { speed: 0.25 });
    expect(shapeChange(tiny.p, [[tiny.clip.id]], 'bullet')).toBeNull();
    // Two points fit, 8 ms apart.
    expect(shapeChange(tiny.p, [[tiny.clip.id]], 'rampUp')?.ramps[tiny.clip.id]).toHaveLength(2);
    // Under a millisecond no two points of any ramp fit.
    const less = applyEdits(f.p, [{ op: 'settings', patch: { fpsNum: 60, fpsDen: 1 } }]);
    const frame = add(less, f.v1, 0, 1, { speed: 0.05 });
    for (const shape of [...(Object.keys(RAMP_SHAPES) as RampShape[]), 'custom'] as const) {
      expect(shapeChange(frame.p, [[frame.clip.id]], shape), shape).toBeNull();
    }
    expect(shapeChange(frame.p, [[frame.clip.id]], 'none')).toEqual({ ramps: { [frame.clip.id]: null } });
    // One clip that is too short refuses the shape for all that were asked.
    const other = add(tiny.p, f.v1, 30, 60);
    expect(shapeChange(other.p, [[other.clip.id], [tiny.clip.id]], 'bullet')).toBeNull();
  });
});

describe('a point added to a ramp', () => {
  it('goes where the playhead shows the clip, on the curve as it runs', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { sourceIn: 1 });
    const up = applyEdits(a.p, retimeEach(a.p, [a.clip.id], shaped(a.p, [a.clip.id], 'rampUp')));
    const clip = up.clips[a.clip.id];
    expect(clip.ramp).toEqual([
      { m: 1, v: 0.5 },
      { m: 5, v: 2 },
    ]);
    // Frame 48 of the clip shows 2.25 s of its media, where the speed has eased up to 125%.
    expect(sourceTimeAt(clip, 48, up)).toBeCloseTo(2.25, 9);
    expect(addPointChange(up, [clip.id], 48)).toEqual({
      m: 2.25,
      change: {
        ramps: {
          [clip.id]: [
            { m: 1, v: 0.5 },
            { m: 2.25, v: 1.25 },
            { m: 5, v: 2 },
          ],
        },
      },
    });
  });

  it('goes into the middle of the widest gap when the playhead is elsewhere, or on a point', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { sourceIn: 1, ramp: shapeRamp('flashIn', 1, 5, false) });
    // Flash in has points at 1 s, 2.4 s and 5 s: the widest gap is the last.
    const away = addPointChange(a.p, [a.clip.id], 500);
    expect(away).toMatchObject({ m: 3.7 });
    // The clip begins on its first point.
    expect(addPointChange(a.p, [a.clip.id], 0)).toEqual(away);
  });

  it('makes three points at its own speed of a clip that has no ramp, and leaves its length', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { sourceIn: 1, speed: 2 });
    const added = addPointChange(a.p, [a.clip.id], 30);
    expect(added).toEqual({
      m: 3,
      change: {
        ramps: {
          [a.clip.id]: [
            { m: 1, v: 2 },
            { m: 3, v: 2 },
            { m: 9, v: 2 },
          ],
        },
      },
    });
    if ('refused' in added) throw new Error(added.refused);
    const p = applyEdits(a.p, retimeEach(a.p, [a.clip.id], added.change));
    expect(p.clips[a.clip.id]).toEqual({ ...a.clip, ramp: added.change.ramps[a.clip.id] });
  });

  it('is refused when the ramp is full, and when no point fits between two others', () => {
    const f = fixture();
    const full = Array.from({ length: 32 }, (_, i) => ({ m: 1 + i * 0.1, v: 1 + (i % 2) }));
    const a = add(f.p, f.v1, 0, 120, { sourceIn: 1, ramp: full });
    expect(addPointChange(a.p, [a.clip.id], 500)).toEqual({ refused: 'A ramp holds at most 32 points.' });
    // One frame at 60 a second and a tenth of the speed is 1.7 ms of media: two points a millisecond
    // apart leave no place a millisecond from both.
    const fast = applyEdits(f.p, [{ op: 'settings', patch: { fpsNum: 60, fpsDen: 1 } }]);
    const slow = [
      { m: 1, v: 0.1 },
      { m: 1.0015, v: 0.1 },
    ];
    const tight = add(fast, f.v1, 0, 1, { sourceIn: 1, ramp: slow });
    for (const frame of [0, 500]) {
      expect(addPointChange(tight.p, [tight.clip.id], frame)).toEqual({
        refused: 'This clip is too short for a speed ramp.',
      });
    }
  });
});

describe('a ramp gesture', () => {
  it('works every step out from where it began', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { fadeIn: 100, keyframes: { x: [{ t: 60, v: 1, e: 'linear' }] } });
    const b = add(a.p, f.v1, 120, 120);
    const drag = ramper(b.p, [a.clip.id]);
    // Level at 70%: the clip would grow to 171 frames, and the next clip holds it at 120.
    expect(drag.to(level(a.clip.id, 0.7))[0]).toMatchObject({ duration: 120, speed: 1 });
    expect(drag.state.p.clips[a.clip.id].ramp).toEqual([
      { m: 0, v: 0.7 },
      { m: 4, v: 0.7 },
    ]);
    // Level at 400%: 30 frames, with the fade cut to fit and the keyframe moved in.
    const fast = drag.to(level(a.clip.id, 4))[0];
    expect(fast).toMatchObject({ duration: 30, fadeIn: 30 });
    expect(fast.keyframes.x[0].t).toBe(15);
    // A shape: five times as fast but for a moment in the middle.
    expect(drag.to(shaped(b.p, [a.clip.id], 'bullet'))[0]).toMatchObject({ duration: 27, fadeIn: 27 });
    // Without a ramp again the clip is what it was, fade and keyframe included.
    expect(drag.to(off(a.clip.id))[0]).toEqual(a.clip);
    expect(drag.state.gestures).toBe(1);
  });

  it('differs from setting one ramp after the other, which loses the tail', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const slowed = applyEdits(b.p, retimeEach(b.p, [a.clip.id], level(a.clip.id, 0.7)));
    const back = applyEdits(slowed, retimeEach(slowed, [a.clip.id], off(a.clip.id)));
    expect(back.clips[a.clip.id].duration).toBe(84);
  });

  it('gives the same result as one setRamp for the ramp it ends on', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { reverse: true });
    const b = add(a.p, f.v1, 120, 120);
    const drag = ramper(b.p, [a.clip.id]);
    // Cut short while it plays backwards, the clip has given up the bottom of its range.
    expect(drag.to(level(a.clip.id, 0.5))[0].sourceIn).toBeCloseTo(2);
    const bullet = shapeChange(b.p, [[a.clip.id]], 'bullet');
    expect(drag.to(bullet!)[0]).toEqual(applyEdits(b.p, setRamp(b.p, [a.clip.id], bullet!)).clips[a.clip.id]);
  });

  it('goes on while other things in the project are edited', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const title = makeClip('text', f.v2.id, { start: 0, duration: 60 });
    const drag = ramper(applyEdits(b.p, [{ op: 'addClip', clip: title }]), [a.clip.id]);
    for (const speed of [0.9, 0.8, 0.7, 0.8, 0.9, null]) {
      drag.to(speed === null ? off(a.clip.id) : level(a.clip.id, speed));
      const opacity = (speed ?? 1) / 2;
      drag.meanwhile([
        { op: 'updateClip', id: title.id, patch: { opacity, start: Math.round(opacity * 20) } },
        { op: 'updateTrack', id: f.v1.id, patch: { name: `Main ${opacity}` } },
        { op: 'updateClip', id: a.clip.id, patch: { opacity } },
      ]);
    }
    expect(drag.state.p.clips[a.clip.id]).toEqual({ ...a.clip, opacity: 0.5 });
    expect(drag.state.gestures).toBe(1);
  });

  it('is held by the next clip where that clip is now, not where it was', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    const drag = ramper(b.p, [a.clip.id]);
    expect(drag.to(level(a.clip.id, 0.5))[0].duration).toBe(120);
    drag.meanwhile([{ op: 'updateClip', id: b.clip.id, patch: { start: 200 } }]);
    expect(drag.to(level(a.clip.id, 0.5))[0].duration).toBe(200);
    expect(drag.to(level(a.clip.id, 2))[0].duration).toBe(60);
    drag.meanwhile([{ op: 'updateClip', id: b.clip.id, patch: { start: 90 } }]);
    expect(drag.to(off(a.clip.id))[0].duration).toBe(90);
    expect(drag.state.gestures).toBe(1);
  });

  it('starts over once the clip has been re-timed under it, or somebody else has changed its ramp', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const drag = ramper(a.p, [a.clip.id]);
    drag.to(level(a.clip.id, 2));
    // An undo, or somebody's trim: the clip is no longer what the last step left.
    drag.meanwhile([{ op: 'updateClip', id: a.clip.id, patch: { ramp: null, duration: 90 } }]);
    expect(drag.to(level(a.clip.id, 0.5, 0, 3))[0]).toMatchObject({ duration: 180 });
    expect(drag.state.gestures).toBe(2);
    // Somebody else drags another point of the same ramp: the length is as it was, the ramp is not.
    const theirs = [
      { m: 0, v: 0.5 },
      { m: 1.5, v: 0.5 },
      { m: 3, v: 0.5 },
    ];
    drag.meanwhile([{ op: 'updateClip', id: a.clip.id, patch: { ramp: theirs } }]);
    drag.to(off(a.clip.id));
    expect(drag.state.gestures).toBe(3);
    // It went back to one speed from the ramp it then found, not from the one before.
    expect(drag.state.p.clips[a.clip.id]).toMatchObject({ ramp: null, duration: 90 });
  });

  it('covers the clips it began with and everything linked to them, and no others', () => {
    const c = cut();
    const [picture, sound] = c.pairs[0];
    const g = speedGesture(null, c.p, [picture], { ramp: true });
    expect(Object.keys(g.from).sort()).toEqual([picture, sound].sort());
    const step = shaped(c.p, [picture], 'rampUp');
    const p = applyEdits(c.p, speedEdits(g, c.p, step));
    const stepped = speedStepped(g, p, step);
    expect(stepped.last).toBe(step);
    expect(speedGesture(stepped, p, [picture], { ramp: true })).toBe(stepped);
    expect(speedGesture(stepped, p, [picture, c.pairs[1][0]], { ramp: true })).not.toBe(stepped);
    expect(
      speedGesture(stepped, applyEdits(p, [{ op: 'removeClip', id: sound }]), [picture], { ramp: true }),
    ).not.toBe(stepped);
    // A gesture that was made for a speed did not look at the linked clips: a ramp needs one that did.
    const plain = speedGesture(null, c.p, [picture]);
    expect(Object.keys(plain.from)).toEqual([picture]);
    expect(speedGesture(plain, c.p, [picture], { ramp: true })).not.toBe(plain);
  });

  it('takes the linked sound along when only the picture was asked for, in step at every step, and leaves both as it found them', () => {
    const j = jCut();
    const drag = ramper(j.p, [j.picture.id]);
    const starts: Record<string, number> = {};
    for (const shape of Object.keys(RAMP_SHAPES) as RampShape[]) {
      drag.to(shaped(j.p, [j.picture.id], shape));
      const [picture, sound] = [drag.state.p.clips[j.picture.id], drag.state.p.clips[j.sound.id]];
      expect(sound.ramp, shape).toEqual(picture.ramp);
      expect(apart(drag.state.p, picture, sound), shape).toBeLessThan(1e-9);
      expect(clipEnd(sound), shape).toBe(clipEnd(picture));
      starts[shape] = sound.start;
    }
    // The 32 frames of sound before the picture take as long as the speed the ramp begins at makes
    // them: 64 frames at 50%, 16 at 200%, 6 at 500%.
    expect(starts).toEqual({
      rampUp: 26,
      rampDown: 74,
      montage: 58,
      hero: 58,
      bullet: 84,
      flashIn: 84,
      flashOut: 58,
    });
    drag.to(off(j.picture.id));
    expect(drag.state.p.clips[j.sound.id]).toEqual(j.sound);
    expect(drag.state.p.clips[j.picture.id]).toEqual(j.picture);
    expect(drag.state.gestures).toBe(1);
  });

  it('puts a sound that an earlier step moved back where it stood when a step leaves the ramp as it was found', () => {
    const j = jCut();
    const found = applyEdits(j.p, retimeEach(j.p, [j.picture.id], shaped(j.p, [j.picture.id], 'rampDown')));
    const drag = ramper(found, [j.picture.id]);
    drag.to(shaped(found, [j.picture.id], 'flashIn'));
    expect(drag.state.p.clips[j.sound.id].start).not.toBe(found.clips[j.sound.id].start);
    expect(drag.state.p.clips[j.sound.id].sourceIn).not.toBe(found.clips[j.sound.id].sourceIn);
    // The ramp the gesture found, given again as points: nothing but the clips as they were.
    drag.to({ ramps: { [j.picture.id]: found.clips[j.picture.id].ramp!.map((q) => ({ ...q })) } });
    expect(drag.state.p).toEqual(found);
    expect(drag.state.gestures).toBe(1);
  });

  it('comes back to the letter also where a clip was not where its picture would put it', () => {
    // One frame of a sound, left beside the sound that follows it when its picture was put on a
    // ramp: it is not in step with the picture, and its in point is on no microsecond.
    const ramp = [
      { m: 3.792744, v: 0.191 },
      { m: 3.931711, v: 3.733 },
      { m: 5.095754, v: 0.103 },
      { m: 7.571867, v: 0.553 },
      { m: 8.261437, v: 1.814 },
      { m: 9.025924, v: 2.521 },
    ];
    const f = fixture();
    const v = add(f.p, f.v1, 141, 376, { linkId: 'L', sourceIn: 2.2666666666666666, ramp });
    const a = add(v.p, f.a1, 234, 1, { linkId: 'L', sourceIn: 3.5, ramp, keepPitch: true });
    const found = add(a.p, f.a1, 235, 21).p;
    // Setting the ramp the picture has works the sound out again, a third of a microsecond away.
    const again = applyEdits(found, retimeEach(found, [v.clip.id], { ramps: { [v.clip.id]: ramp } }));
    expect(again.clips[a.clip.id].sourceIn).not.toBe(3.5);
    expect(again.clips[a.clip.id].sourceIn).toBeCloseTo(3.5, 6);
    for (const ripple of [false, true]) {
      const drag = ramper(found, [v.clip.id], { ripple, markers: true });
      drag.to(shaped(found, [v.clip.id], 'bullet'));
      drag.to(shaped(found, [v.clip.id], 'montage'));
      expect(drag.state.p.clips[a.clip.id]).not.toEqual(found.clips[a.clip.id]);
      // The way back, with the points as a graph would hand them over: copies, not the array.
      drag.to({ ramps: { [v.clip.id]: ramp.map((q) => ({ ...q })) } });
      expect(drag.state.p).toEqual(found);
      expect(drag.state.gestures).toBe(1);
    }
  });

  it('puts a sound back where the gesture found it at a step that sets one speed on both', () => {
    const j = jCut();
    const both = [j.picture.id, j.sound.id];
    const drag = ramper(j.p, both);
    drag.to(shaped(j.p, both, 'bullet'));
    expect(drag.state.p.clips[j.sound.id].start).toBe(84);
    // One speed moves no start, and the sound is not left where the ramp had taken it.
    drag.to(2);
    expect(drag.state.p).toEqual(applyEdits(j.p, setSpeed(j.p, both, 2)));
    expect(drag.state.p.clips[j.sound.id]).toMatchObject({ start: 58, duration: 76, speed: 2 });
    expect(drag.state.gestures).toBe(1);
  });

  it('leaves a linked clip as it found it at a step that sets one speed on the other alone', () => {
    const c = cut();
    const [picture, sound] = c.pairs[2];
    const drag = ramper(c.p, [picture]);
    drag.to(shaped(c.p, [picture], 'bullet'));
    expect(drag.state.p.clips[sound]).toMatchObject({ duration: 27, keepPitch: true });
    // One speed for a clip that is on no ramp is for that clip alone, as it always was: the sound
    // is not left on the ramp of the step before.
    drag.to(2);
    expect(drag.state.p).toEqual(applyEdits(c.p, setSpeed(c.p, [picture], 2)));
    expect(drag.state.p.clips[sound]).toEqual(c.p.clips[sound]);
    drag.to(off(picture));
    expect(drag.state.p).toEqual(c.p);
    expect(drag.state.gestures).toBe(1);
  });

  it('starts over when somebody else has moved a clip that follows another meanwhile', () => {
    const j = jCut();
    const drag = ramper(j.p, [j.picture.id]);
    drag.to(shaped(j.p, [j.picture.id], 'rampUp'));
    const sound = drag.state.p.clips[j.sound.id];
    drag.meanwhile([{ op: 'updateClip', id: sound.id, patch: { start: sound.start + 200 } }]);
    drag.to(off(j.picture.id));
    expect(drag.state.gestures).toBe(2);
    // Their move stands: the sound no longer shares a frame with the picture, and went back by itself.
    expect(drag.state.p.clips[sound.id].start).toBe(sound.start + 200);
  });
});

describe('a sound that begins after its picture, on a ramp', () => {
  /** A picture from frame 100 to 400 and its sound from 190 on, with or without neighbours on the sound track. */
  function late(before: boolean, after: boolean) {
    const f = fixture();
    const v = add(f.p, f.v1, 100, 300, { linkId: 'L' });
    const a = add(v.p, f.a1, 190, 210, { linkId: 'L', sourceIn: 3 });
    let p = a.p;
    if (before) p = add(p, f.a1, 100, 90).p;
    if (after) {
      p = add(p, f.v1, 400, 100, { linkId: 'M' }).p;
      p = add(p, f.a1, 400, 100, { linkId: 'M' }).p;
    }
    return { ...f, p, picture: v.clip, sound: a.clip };
  }

  it('begins on the same word wherever the ramp takes it, with and without ripple editing', () => {
    for (const ripple of [false, true]) {
      const s = late(false, true);
      const drag = ramper(s.p, [s.picture.id], { ripple });
      // Five times as fast to begin with: the word 90 frames in comes after 18.
      drag.to(shaped(s.p, [s.picture.id], 'bullet'));
      expect(layout(drag.state.p, s.v1), `${ripple}`).toEqual(
        ripple ? ['100+69', '169+100'] : ['100+69', '400+100'],
      );
      expect(layout(drag.state.p, s.a1), `${ripple}`).toEqual(
        ripple ? ['118+51', '169+100'] : ['118+51', '400+100'],
      );
      // Half as fast to begin with: it comes after 117.
      drag.to(shaped(s.p, [s.picture.id], 'rampUp'));
      expect(layout(drag.state.p, s.v1), `${ripple}`).toEqual(
        ripple ? ['100+240', '340+100'] : ['100+240', '400+100'],
      );
      expect(layout(drag.state.p, s.a1), `${ripple}`).toEqual(
        ripple ? ['217+123', '340+100'] : ['217+123', '400+100'],
      );
      drag.to(off(s.picture.id));
      expect(drag.state.p).toEqual(s.p);
      expect(drag.state.gestures).toBe(1);
    }
  });

  it('stays in step with its picture, lies over nothing and comes back exactly, whatever stands around it', () => {
    for (const before of [false, true]) {
      for (const after of [false, true]) {
        for (const ripple of [false, true]) {
          const s = late(before, after);
          const label = `${before ? 'a clip before, ' : ''}${after ? 'clips after, ' : ''}${ripple ? 'ripple' : 'no ripple'}`;
          const drag = ramper(s.p, [s.picture.id], { ripple, markers: true });
          for (const shape of ['bullet', 'rampUp', 'hero', 'flashOut'] as const) {
            drag.to(shaped(s.p, [s.picture.id], shape));
            const [picture, sound] = [drag.state.p.clips[s.picture.id], drag.state.p.clips[s.sound.id]];
            expect(overlapping(drag.state.p), `${label}, ${shape}`).toEqual([]);
            // Where the clip before it leaves it no frame under its picture, one frame of it is left.
            const gap = apart(drag.state.p, picture, sound);
            if (gap === null) expect([before, shape, sound.duration], label).toEqual([true, 'bullet', 1]);
            else expect(gap, `${label}, ${shape}`).toBeLessThan(1e-9);
          }
          drag.to(off(s.picture.id));
          expect(drag.state.p, label).toEqual(s.p);
          expect(drag.state.gestures, label).toBe(1);
        }
      }
    }
  });
});

describe('a change of ramp under ripple editing', () => {
  it('moves what follows by the frames the ramp gives up, or takes, on every track', () => {
    const c = cut();
    // Ramp up plays four seconds of media in 3.2: 96 frames for 120.
    const up = speedRippleEdits(c.p, c.pairs[0], shaped(c.p, c.pairs[0], 'rampUp'));
    expect(up.refused).toBeNull();
    let p = applyEdits(c.p, [...up.edits, ...markerEdits(c.p, up.edits, up.spans)]);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+96', '96+120', '216+120']);
    expect(layout(p, c.v2)).toEqual(['276+45']);
    expect(layout(p, c.a2)).toEqual(['0+360']);
    expect(p.clips[c.pairs[0][0]]).toMatchObject({
      speed: 1,
      sourceIn: 1,
      ramp: shapeRamp('rampUp', 1, 5, false),
    });
    expect(up.spans).toEqual([{ from: 96, by: -24 }]);
    expect(markers(p)).toEqual([96, 216]);
    // Level at half the speed, it plays all it played before, in twice the time.
    const slow = speedRippleEdits(c.p, c.pairs[0], level(c.pairs[0][0], 0.5, 1, 5));
    p = applyEdits(c.p, [...slow.edits, ...markerEdits(c.p, slow.edits, slow.spans)]);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+240', '240+120', '360+120']);
    expect(layout(p, c.v2)).toEqual(['420+45']);
    expect(slow.spans).toEqual([{ from: 120, by: 120 }]);
    expect(markers(p)).toEqual([240, 360]);
  });

  it('has the length each shape gives the same four seconds', () => {
    const c = cut();
    const lengths: Record<string, number> = {};
    for (const shape of Object.keys(RAMP_SHAPES) as RampShape[]) {
      const r = speedRippleEdits(c.p, c.pairs[0], shaped(c.p, c.pairs[0], shape));
      const p = applyEdits(c.p, r.edits);
      const [picture, sound] = c.pairs[0].map((id) => p.clips[id]);
      lengths[shape] = picture.duration;
      expect(sound.duration, shape).toBe(picture.duration);
      // What follows begins where the pair now ends, on both tracks.
      expect(layout(p, c.v1)[1], shape).toBe(`${picture.duration}+120`);
      expect(layout(p, c.a1)[1], shape).toBe(`${picture.duration}+120`);
      expect(r.spans, shape).toEqual([{ from: Math.min(120, picture.duration), by: picture.duration - 120 }]);
    }
    expect(lengths).toEqual({
      rampUp: 96,
      rampDown: 96,
      montage: 98,
      hero: 121,
      bullet: 27,
      flashIn: 92,
      flashOut: 92,
    });
  });

  it('closes exactly the frames a faster ramp gives up, not a gap that was there before', () => {
    const c = cut();
    const gapped = applyEdits(
      c.p,
      [...c.pairs[1], ...c.pairs[2], c.title.id].map((id): Edit => ({
        op: 'updateClip',
        id,
        patch: { start: c.p.clips[id].start + 30 },
      })),
    );
    const r = speedRippleEdits(gapped, c.pairs[0], shaped(gapped, c.pairs[0], 'bullet'));
    const p = applyEdits(gapped, r.edits);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+27', '57+120', '177+120']);
    expect(layout(p, c.v2)).toEqual(['237+45']);
    expect(r.spans).toEqual([{ from: 27, by: -93 }]);
  });

  it('keeps a reversed clip on its source range, and ripples by the same frames', () => {
    const c = cut();
    const reversed = applyEdits(
      c.p,
      c.pairs[0].map((id): Edit => ({ op: 'updateClip', id, patch: { reverse: true } })),
    );
    const change = shaped(reversed, c.pairs[0], 'rampUp');
    // The shape is the one seen in play order: slow at the top of the range, where the clip begins.
    expect(change).toEqual({ ramps: { [c.pairs[0][0]]: shapeRamp('rampUp', 1, 5, true) } });
    const p = applyEdits(reversed, speedRippleEdits(reversed, c.pairs[0], change).edits);
    expect(p.clips[c.pairs[0][0]]).toMatchObject({ duration: 96, sourceIn: 1, reverse: true });
    expect(apart(p, p.clips[c.pairs[0][0]], p.clips[c.pairs[0][1]])).toBeLessThan(1e-9);
    expect(layout(p, c.v1)).toEqual(['0+96', '96+120', '216+120']);
  });

  it('ripples once for a split edit, by the change of the picture, and leaves no hole in it', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 100, { linkId: 'L' });
    const a = add(v.p, f.a1, 0, 130, { linkId: 'L' });
    const nextV = add(a.p, f.v1, 100, 60);
    const nextA = add(nextV.p, f.a1, 130, 60);
    const ids = [a.clip.id, v.clip.id];
    // Slower, the sound still runs on under the next shot, and stops at the sound that follows.
    const slow = applyEdits(nextA.p, speedRippleEdits(nextA.p, ids, level(v.clip.id, 0.5)).edits);
    expect(layout(slow, f.v1)).toEqual(['0+200', '200+60']);
    expect(layout(slow, f.a1)).toEqual(['0+230', '230+60']);
    // Ramp up ends at 200%: the 30 frames of sound after the picture take 15.
    const r = speedRippleEdits(nextA.p, ids, shaped(nextA.p, ids, 'rampUp'));
    const fast = applyEdits(nextA.p, r.edits);
    expect(layout(fast, f.v1)).toEqual(['0+80', '80+60']);
    expect(layout(fast, f.a1)).toEqual(['0+95', '110+60']);
    expect(r.spans).toEqual([{ from: 80, by: -20 }]);
    expect(apart(fast, fast.clips[v.clip.id], fast.clips[a.clip.id])).toBeLessThan(1e-9);
    // Asked of the picture alone, the answer is the same: the ramp is the sound's as well.
    expect(
      applyEdits(nextA.p, speedRippleEdits(nextA.p, [v.clip.id], shaped(nextA.p, ids, 'rampUp')).edits),
    ).toEqual(fast);
  });

  it('leaves no hole when the linked sound is shorter than the frames the picture gives up', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L' });
    const blip = add(v.p, f.a1, 0, 40, { linkId: 'L' });
    const nextV = add(blip.p, f.v1, 120, 120, { linkId: 'M' });
    const nextA = add(nextV.p, f.a1, 120, 120, { linkId: 'M' });
    const marked = applyEdits(nextA.p, [
      { op: 'setMarker', marker: { id: 'in', frame: 20, name: 'in', color: '#fff', note: '' } },
      { op: 'setMarker', marker: { id: 'next', frame: 120, name: 'next', color: '#fff', note: '' } },
    ]);
    const r = speedRippleEdits(marked, [v.clip.id], shaped(marked, [v.clip.id], 'bullet'));
    expect(r.refused).toBeNull();
    const p = applyEdits(marked, [...r.edits, ...markerEdits(marked, r.edits, r.spans)]);
    // Five times as fast where the sound is: its 40 frames take 8.
    expect(layout(p, f.v1)).toEqual(['0+27', '27+120']);
    expect(layout(p, f.a1)).toEqual(['0+8', '27+120']);
    expect(r.spans).toEqual([{ from: 27, by: -93 }]);
    expect(markers(p)).toEqual([20, 27]);
  });

  it('sets the ramp all the same when the ripple is refused, and says why nothing followed', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L' });
    const blip = add(v.p, f.a1, 0, 40, { linkId: 'L' });
    const nextV = add(blip.p, f.v1, 120, 120, { linkId: 'M' });
    // The sound of the next shot begins under this picture and cannot come up with its own.
    const nextA = add(nextV.p, f.a1, 40, 200, { linkId: 'M' });
    const change = shaped(nextA.p, [v.clip.id], 'bullet');
    const r = speedRippleEdits(nextA.p, [v.clip.id], change);
    expect(r.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    expect(r.spans).toEqual([]);
    const p = applyEdits(nextA.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0+27', '120+120']);
    expect(layout(p, f.a1)).toEqual(['0+8', '40+200']);
    // It is what the change does without ripple editing.
    expect(p).toEqual(applyEdits(nextA.p, retimeEach(nextA.p, [v.clip.id], change)));
    expect(p.clips[blip.clip.id].ramp).toEqual(p.clips[v.clip.id].ramp);
  });

  it('changes each of several selected clips, never lays one over another, and updates each clip once', () => {
    const c = cut();
    const ids = [...c.pairs[0], c.pairs[1][0]];
    const r = speedRippleEdits(c.p, ids, shaped(c.p, ids, 'rampUp'));
    const p = applyEdits(c.p, [...r.edits, ...markerEdits(c.p, r.edits, r.spans)]);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+96', '96+96', '192+120']);
    expect(markers(p)).toEqual([96, 192]);
    expect(overlapping(p)).toEqual([]);
    const updated = r.edits.map((e) => (e.op === 'updateClip' ? e.id : e.op));
    expect(updated.sort()).toEqual([...c.pairs.flat(), c.title.id].sort());
  });

  it('leaves clips without a speed out, and does nothing when the ramp is the one the clips have', () => {
    const c = cut();
    expect(speedRippleEdits(c.p, [c.title.id], shaped(c.p, c.pairs[0], 'hero'))).toEqual({
      edits: [],
      refused: null,
      spans: [],
    });
    const change = shaped(c.p, c.pairs[0], 'hero');
    const hero = applyEdits(c.p, speedRippleEdits(c.p, c.pairs[0], change).edits);
    const again = speedRippleEdits(hero, c.pairs[0], change);
    expect(again.spans).toEqual([]);
    expect(applyEdits(hero, again.edits)).toEqual(hero);
    // Custom on a clip that is on a ramp asks for the ramp it has.
    expect(
      applyEdits(hero, speedRippleEdits(hero, c.pairs[0], shaped(hero, c.pairs[0], 'custom')).edits),
    ).toEqual(hero);
  });

  it('brings a clip back to its one speed over the media it plays, to within the frames the ramp rounded away', () => {
    const c = cut();
    for (const shape of Object.keys(RAMP_SHAPES) as RampShape[]) {
      const on = applyEdits(c.p, speedRippleEdits(c.p, c.pairs[0], shaped(c.p, c.pairs[0], shape)).edits);
      const back = applyEdits(on, speedRippleEdits(on, c.pairs[0], shaped(on, c.pairs[0], 'none')).edits);
      const picture = back.clips[c.pairs[0][0]];
      expect(picture, shape).toMatchObject({ ramp: null, speed: 1, sourceIn: 1 });
      expect(Math.abs(picture.duration - 120), shape).toBeLessThanOrEqual(3);
      for (const t of [c.v1, c.a1]) expect(layout(back, t)[1], shape).toBe(`${picture.duration}+120`);
    }
  });
});

describe('a change of ramp that the next clip cuts short', () => {
  it('is reported with the length the clip would have, and can be given its room afterwards', () => {
    const c = cut();
    const change = level(c.pairs[0][0], 0.5, 1, 5);
    // Asked of the picture alone: its sound is cut short with it.
    const short = speedCutShort(c.p, [c.pairs[0][0]], change);
    expect(short).toEqual(c.pairs[0].map((id) => ({ id, duration: 120, natural: 240 })));
    const slowed = applyEdits(c.p, retimeEach(c.p, [c.pairs[0][0]], change));
    const r = makeRoomEdits(slowed, Object.fromEntries(short.map((s) => [s.id, s.natural])));
    expect(r.refused).toBeNull();
    const p = applyEdits(slowed, [...r.edits, ...markerEdits(slowed, r.edits, r.spans)]);
    // The same timeline as setting the ramp with ripple editing on.
    expect(p.clips).toEqual(applyEdits(c.p, speedRippleEdits(c.p, c.pairs[0], change).edits).clips);
    expect(markers(p)).toEqual([240, 360]);
  });

  it('gets the end of its ramp back with the room', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { sourceIn: 1 });
    const b = add(a.p, f.v1, 120, 120);
    // From 100% down to 25% over its four seconds: 192 frames, and the slow end is what is cut off.
    const change: Retime = {
      ramps: {
        [a.clip.id]: [
          { m: 1, v: 1 },
          { m: 5, v: 0.25 },
        ],
      },
    };
    const whole = applyEdits(a.p, retimeEach(a.p, [a.clip.id], change)).clips[a.clip.id];
    expect(whole.duration).toBe(192);
    const short = speedCutShort(b.p, [a.clip.id], change);
    expect(short).toEqual([{ id: a.clip.id, duration: 120, natural: 192 }]);
    const cutOff = applyEdits(b.p, retimeEach(b.p, [a.clip.id], change));
    const held = cutOff.clips[a.clip.id];
    expect(sourceTimeAt(held, 119, cutOff)).toBeLessThan(4.2);
    const roomy = applyEdits(cutOff, makeRoomEdits(cutOff, { [a.clip.id]: 192 }).edits);
    const given = roomy.clips[a.clip.id];
    expect(given).toEqual(whole);
    expect(sourceTimeAt(given, 191, roomy)).toBe(sourceTimeAt(whole, 191, a.p));
    expect(sourceTimeAt(given, 191, roomy)).toBeGreaterThan(4.99);
    expect(layout(roomy, f.v1)).toEqual(['0+192', '192+120']);
    expect(roomy.clips).toEqual(applyEdits(b.p, speedRippleEdits(b.p, [a.clip.id], change).edits).clips);
  });

  it('gives a reversed clip back the bottom of its range that was cut off', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120, { sourceIn: 1, reverse: true });
    const b = add(a.p, f.v1, 120, 120);
    const change = level(a.clip.id, 0.5, 1, 5);
    const slowed = applyEdits(b.p, retimeEach(b.p, [a.clip.id], change));
    // It plays from the top down, so what no longer fits is the low end.
    expect(slowed.clips[a.clip.id].sourceIn).toBeCloseTo(3);
    const short = speedCutShort(b.p, [a.clip.id], change);
    const p = applyEdits(slowed, makeRoomEdits(slowed, { [a.clip.id]: short[0].natural }).edits);
    expect(p.clips[a.clip.id].duration).toBe(240);
    expect(p.clips[a.clip.id].sourceIn).toBeCloseTo(1, 9);
    // The first frame is the one it was, and the last is the bottom of the range again.
    expect(sourceTimeAt(p.clips[a.clip.id], 0, p)).toBeCloseTo(
      sourceTimeAt(slowed.clips[a.clip.id], 0, slowed),
      9,
    );
    expect(sourceTimeAt(p.clips[a.clip.id], 239, p)).toBeCloseTo(1, 9);
  });

  it('knows the length of each of several clips as if it alone were changed, and makes room for all', () => {
    const c = cut();
    const ids = [c.pairs[0][0], c.pairs[1][0]];
    const change: Retime = {
      ramps: { ...level(ids[0], 0.5, 1, 5).ramps, ...level(ids[1], 0.5, 1, 5).ramps },
    };
    // The first pair, let run on to its 240 frames, is not found lying over the second.
    const short = speedCutShort(c.p, ids, change);
    expect(short.map((s) => [s.duration, s.natural])).toEqual(Array(4).fill([120, 240]));
    expect(short.map((s) => s.id).sort()).toEqual([...c.pairs[0], ...c.pairs[1]].sort());
    const slowed = applyEdits(c.p, retimeEach(c.p, ids, change));
    const room = makeRoomEdits(slowed, Object.fromEntries(short.map((s) => [s.id, s.natural])));
    const p = applyEdits(slowed, room.edits);
    for (const t of [c.v1, c.a1]) expect(layout(p, t)).toEqual(['0+240', '240+240', '480+120']);
    expect(p.clips).toEqual(applyEdits(c.p, speedRippleEdits(c.p, ids, change).edits).clips);
  });

  it('reports nothing when the clip has room, gets shorter, or is the last on its track', () => {
    const c = cut();
    expect(speedCutShort(c.p, c.pairs[0], shaped(c.p, c.pairs[0], 'bullet'))).toEqual([]);
    expect(speedCutShort(c.p, c.pairs[2], level(c.pairs[2][0], 0.5, 1, 5))).toEqual([]);
    expect(speedCutShort(c.p, [c.title.id], level(c.pairs[0][0], 0.5, 1, 5))).toEqual([]);
  });

  it('is known for a gesture too, from where the gesture began', () => {
    const c = cut();
    const drag = ramper(c.p, [c.pairs[0][0]]);
    const slow = level(c.pairs[0][0], 0.5, 1, 5);
    drag.to(level(c.pairs[0][0], 0.8, 1, 5));
    drag.to(slow);
    const byId = (short: { id: string }[]) => [...short].sort((x, y) => (x.id < y.id ? -1 : 1));
    const left = speedGestureCutShort(drag.gesture()!, drag.state.p);
    expect(left).toHaveLength(2);
    expect(byId(left)).toEqual(byId(speedCutShort(c.p, c.pairs[0], slow)));
    drag.to(shaped(c.p, c.pairs[0], 'flashIn'));
    expect(speedGestureCutShort(drag.gesture()!, drag.state.p)).toEqual([]);
  });

  it('offers no room to a sound that was left as one frame beside the place its picture takes it to', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 300, { linkId: 'L' });
    const a = add(v.p, f.a1, 30, 10, { linkId: 'L', sourceIn: 1 });
    const other = add(a.p, f.a1, 40, 60);
    const change = shaped(other.p, [v.clip.id], 'rampUp');
    // Half as fast to begin with, the sound's word comes where the next sound stands.
    const p = applyEdits(other.p, retimeEach(other.p, [v.clip.id], change));
    expect(layout(p, f.a1)).toEqual(['39+1', '40+60']);
    expect(speedCutShort(other.p, [v.clip.id], change)).toEqual([]);
    const drag = ramper(other.p, [v.clip.id]);
    drag.to(change);
    expect(drag.state.p).toEqual(p);
    expect(speedGestureCutShort(drag.gesture()!, drag.state.p)).toEqual([]);
  });
});

describe('a ramp gesture under ripple editing', () => {
  it('moves what follows with every step and leaves nothing behind on the way back', () => {
    const c = cut();
    const lead = c.pairs[0][0];
    const drag = ramper(c.p, [lead], { ripple: true, markers: true });
    drag.to(level(lead, 0.7, 1, 5));
    for (const t of [c.v1, c.a1]) expect(layout(drag.state.p, t)).toEqual(['0+171', '171+120', '291+120']);
    expect(markers(drag.state.p)).toEqual([171, 291]);
    drag.to(level(lead, 0.5, 1, 5));
    expect(layout(drag.state.p, c.v1)).toEqual(['0+240', '240+120', '360+120']);
    expect(layout(drag.state.p, c.v2)).toEqual(['420+45']);
    expect(markers(drag.state.p)).toEqual([240, 360]);
    drag.to(shaped(c.p, [lead], 'bullet'));
    for (const t of [c.v1, c.a1]) expect(layout(drag.state.p, t)).toEqual(['0+27', '27+120', '147+120']);
    expect(markers(drag.state.p)).toEqual([27, 147]);
    drag.to(off(lead));
    expect(drag.state.p).toEqual(c.p);
    expect(drag.state.gestures).toBe(1);
  });

  it('writes a clip that the ramp placed with its start, moved or not, and no other start that stays', () => {
    const c = cut();
    const [picture, sound] = c.pairs[0];
    const g = speedGesture(null, c.p, [picture], { ripple: true, ramp: true });
    const patches = new Map(
      speedEdits(g, c.p, shaped(c.p, [picture], 'bullet')).flatMap((e) =>
        e.op === 'updateClip' ? [[e.id, e.patch] as const] : [],
      ),
    );
    // The sound was placed by its picture: where it stands is part of what the ramp made of it.
    expect(patches.get(sound)).toMatchObject({ start: 0, duration: 27, sourceIn: 1 });
    expect(patches.get(picture)).toMatchObject({ duration: 27, sourceIn: 1 });
    expect(patches.get(picture)).not.toHaveProperty('start');
    // What follows moved, and the music, which lies across, has no edit at all.
    expect(patches.get(c.pairs[1][0])).toEqual({ start: 27 });
    expect(patches.has(c.bed.id)).toBe(false);
    // A speed places no clip by another: only what moves has its start written.
    const plain = speedGesture(null, c.p, c.pairs[0], { ripple: true });
    for (const e of speedEdits(plain, c.p, 2)) {
      if (e.op === 'updateClip' && c.pairs[0].includes(e.id)) expect(e.patch).not.toHaveProperty('start');
    }
  });

  it('ends where one change of ramp under ripple editing ends', () => {
    const c = cut();
    const lead = c.pairs[1][0];
    const drag = ramper(c.p, [lead], { ripple: true });
    const last = shaped(c.p, [lead], 'montage');
    for (const step of [
      level(lead, 0.9, 1, 5),
      shaped(c.p, [lead], 'bullet'),
      level(lead, 0.25, 1, 5),
      last,
    ]) {
      drag.to(step);
    }
    expect(drag.state.p.clips).toEqual(applyEdits(c.p, speedRippleEdits(c.p, [lead], last).edits).clips);
    // The markers were not asked to follow.
    expect(markers(drag.state.p)).toEqual([120, 240]);
  });

  it('comes back exactly from a split edit whose sound it moved, with everything that followed', () => {
    const j = jCut();
    const nextV = add(j.p, j.v1, 210, 100, { linkId: 'M' });
    const nextA = add(nextV.p, j.a1, 210, 100, { linkId: 'M' });
    const start = applyEdits(nextA.p, [
      { op: 'setMarker', marker: { id: 'next', frame: 210, name: 'next', color: '#fff', note: '' } },
    ]);
    const drag = ramper(start, [j.picture.id], { ripple: true, markers: true });
    for (const shape of Object.keys(RAMP_SHAPES) as RampShape[]) {
      drag.to(shaped(start, [j.picture.id], shape));
      const [picture, sound] = [drag.state.p.clips[j.picture.id], drag.state.p.clips[j.sound.id]];
      expect(apart(drag.state.p, picture, sound), shape).toBeLessThan(1e-9);
      expect(overlapping(drag.state.p), shape).toEqual([]);
      // The next shot, its sound and the marker on it stay against the end of the picture.
      expect(layout(drag.state.p, j.v1)[1], shape).toBe(`${clipEnd(picture)}+100`);
      expect(layout(drag.state.p, j.a1)[1], shape).toBe(`${clipEnd(picture)}+100`);
      expect(markers(drag.state.p), shape).toEqual([clipEnd(picture)]);
    }
    drag.to(off(j.picture.id));
    expect(drag.state.p).toEqual(start);
    expect(drag.state.gestures).toBe(1);
  });

  it('starts over, without undoing it, once somebody has moved a clip or a marker meanwhile', () => {
    const c = cut();
    const lead = c.pairs[0][0];
    const drag = ramper(c.p, [lead], { ripple: true, markers: true });
    drag.to(level(lead, 0.5, 1, 5));
    drag.meanwhile([{ op: 'updateClip', id: c.title.id, patch: { start: 500 } }]);
    drag.to(off(lead));
    expect(drag.state.gestures).toBe(2);
    // The clip goes back to its one speed and what follows comes up with it, the title from where
    // it was put.
    expect(layout(drag.state.p, c.v1)).toEqual(['0+120', '120+120', '240+120']);
    expect(layout(drag.state.p, c.v2)).toEqual(['380+45']);
    drag.meanwhile([{ op: 'setMarker', marker: { ...drag.state.p.markers.third, frame: 10 } }]);
    drag.to(level(lead, 0.5, 1, 5));
    expect(drag.state.gestures).toBe(3);
    expect(markers(drag.state.p)).toEqual([10, 240]);
  });
});

describe('one speed for clips that are on a ramp', () => {
  /** Two sync clips back to back, the first on Bullet: 27 frames for its four seconds. */
  function ramped() {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L', sourceIn: 1 });
    const a = add(v.p, f.a1, 0, 120, { linkId: 'L', sourceIn: 1 });
    const nextV = add(a.p, f.v1, 120, 120, { linkId: 'M' });
    const nextA = add(nextV.p, f.a1, 120, 120, { linkId: 'M' });
    const change = shaped(nextA.p, [v.clip.id], 'bullet');
    const p = applyEdits(nextA.p, speedRippleEdits(nextA.p, [v.clip.id], change).edits);
    return { ...f, p, picture: v.clip.id, sound: a.clip.id };
  }

  it('takes the clips linked to it off the ramp with it, whichever was asked for', () => {
    const r = ramped();
    expect(layout(r.p, r.v1)).toEqual(['0+27', '27+120']);
    // Without ripple editing both stop at the next clip, and both are known to be cut short.
    const plain = applyEdits(r.p, speedEach(r.p, [r.picture], 0.5));
    for (const t of [r.v1, r.a1]) expect(layout(plain, t)).toEqual(['0+27', '27+120']);
    for (const id of [r.picture, r.sound]) expect(plain.clips[id]).toMatchObject({ speed: 0.5, ramp: null });
    expect(speedCutShort(r.p, [r.picture], 0.5)).toEqual(
      [r.picture, r.sound].map((id) => ({ id, duration: 27, natural: 235 })),
    );
    // With it the sound makes room with its picture, though only the picture was asked for.
    const rippled = speedRippleEdits(r.p, [r.picture], 1);
    expect(rippled.refused).toBeNull();
    expect(rippled.spans).toEqual([{ from: 27, by: 91 }]);
    const p = applyEdits(r.p, rippled.edits);
    for (const t of [r.v1, r.a1]) expect(layout(p, t)).toEqual(['0+118', '118+120']);
    expect(apart(p, p.clips[r.picture], p.clips[r.sound])).toBeLessThan(1e-9);
    // Room made afterwards gives the same.
    const short = speedCutShort(r.p, [r.picture], 1);
    const held = applyEdits(r.p, speedEach(r.p, [r.picture], 1));
    const roomy = applyEdits(
      held,
      makeRoomEdits(held, Object.fromEntries(short.map((s) => [s.id, s.natural]))).edits,
    );
    expect(roomy.clips).toEqual(p.clips);
  });

  it('is worked out from where a gesture began for every clip it reaches', () => {
    const r = ramped();
    const scrub = scrubber(r.p, [r.picture]);
    for (const speed of [2, 0.5, 0.25, 1]) scrub.to(speed);
    expect(scrub.state.gestures).toBe(1);
    expect(scrub.state.p).toEqual(applyEdits(r.p, speedEach(r.p, [r.picture], 1)));
    // Under ripple editing as well, with the sound that was not asked for.
    const rippled = scrubber(r.p, [r.picture], { ripple: true });
    for (const speed of [2, 0.5, 0.25, 1]) rippled.to(speed);
    expect(rippled.state.gestures).toBe(1);
    expect(rippled.state.p).toEqual(applyEdits(r.p, speedRippleEdits(r.p, [r.picture], 1).edits));
  });

  it('does not count a sound whose head the clip before it cut as cut short', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 100, 300, { linkId: 'L' });
    const a = add(v.p, f.a1, 190, 210, { linkId: 'L', sourceIn: 3 });
    const up = applyEdits(a.p, retimeEach(a.p, [v.clip.id], shaped(a.p, [v.clip.id], 'rampUp')));
    expect(layout(up, f.a1)).toEqual(['217+123']);
    // A clip moves in before the sound, right up to it. At one speed again the sound's word comes
    // 27 frames sooner, where that clip now stands.
    const before = add(up, f.a1, 100, 117);
    const p = applyEdits(before.p, speedEach(before.p, [v.clip.id], 1));
    expect(layout(p, f.v1)).toEqual(['100+300']);
    expect(layout(p, f.a1)).toEqual(['100+117', '217+183']);
    expect(apart(p, p.clips[v.clip.id], p.clips[a.clip.id])).toBeLessThan(1e-9);
    expect(speedCutShort(before.p, [v.clip.id], 1)).toEqual([]);
    // With clips right after both, each is short of what is left of it: 300 frames of the picture,
    // and of the sound the 183 that the clip before it leaves.
    const nextV = add(before.p, f.v1, 340, 60);
    const nextA = add(nextV.p, f.a1, 340, 60);
    const short = speedCutShort(nextA.p, [v.clip.id], 1);
    expect(short).toEqual([
      { id: v.clip.id, duration: 240, natural: 300 },
      { id: a.clip.id, duration: 123, natural: 183 },
    ]);
    const held = applyEdits(nextA.p, speedEach(nextA.p, [v.clip.id], 1));
    const roomy = applyEdits(
      held,
      makeRoomEdits(held, Object.fromEntries(short.map((c) => [c.id, c.natural]))).edits,
    );
    expect(layout(roomy, f.v1)).toEqual(['100+300', '400+60']);
    expect(layout(roomy, f.a1)).toEqual(['100+117', '217+183', '400+60']);
    expect(apart(roomy, roomy.clips[v.clip.id], roomy.clips[a.clip.id])).toBeLessThan(1e-9);
  });
});

describe('a change that would have to reach a clip on a locked track', () => {
  /** A sync clip whose sound is on a locked track, and a title. */
  function locked(ramp: boolean) {
    const c = cut();
    const [picture, sound] = c.pairs[0];
    const on = ramp ? applyEdits(c.p, retimeEach(c.p, [picture], shaped(c.p, [picture], 'rampUp'))) : c.p;
    const p = applyEdits(on, [{ op: 'updateTrack', id: c.a1.id, patch: { locked: true } }]);
    return { ...c, p, picture, sound };
  }
  const RAMP = 'Unlock A1 to ramp this clip: what is linked to it has to follow.';
  const SPEED = "Unlock A1 to change this clip's speed: what is linked to it has to follow.";

  it('is refused whole for a ramp, with ripple editing and without, in a gesture and outside one', () => {
    for (const ramp of [false, true]) {
      const l = locked(ramp);
      const change = shaped(l.p, [l.picture], 'bullet');
      expect(retimeRefusal(l.p, [l.picture], change)).toBe(RAMP);
      expect(retimeEach(l.p, [l.picture], change)).toEqual([]);
      expect(speedCutShort(l.p, [l.picture], change)).toEqual([]);
      expect(speedRippleEdits(l.p, [l.picture], change)).toEqual({ edits: [], refused: RAMP, spans: [] });
      for (const ripple of [false, true]) {
        const g = speedGesture(null, l.p, [l.picture], { ripple, markers: true, ramp: true });
        expect(speedEdits(g, l.p, change)).toEqual([]);
        const slow = level(l.picture, 0.5, 1, 5);
        expect(speedGestureCutShort(speedStepped(g, l.p, slow), l.p)).toEqual([]);
      }
      // Another clip that was asked for with it is not changed either.
      expect(
        retimeEach(l.p, [l.pairs[2][0], l.picture], shaped(l.p, [l.pairs[2][0], l.picture], 'bullet')),
      ).toEqual([]);
    }
  });

  it('is refused whole for one speed on a clip that is on a ramp', () => {
    const l = locked(true);
    expect(retimeRefusal(l.p, [l.picture], 2)).toBe(SPEED);
    expect(retimeRefusal(l.p, [l.picture], { speed: 1, reverse: true })).toBe(SPEED);
    expect(speedEach(l.p, [l.picture], 2)).toEqual([]);
    expect(speedEach(l.p, [l.picture, l.pairs[2][0]], 2)).toEqual([]);
    expect(speedCutShort(l.p, [l.picture], 0.5)).toEqual([]);
    expect(speedRippleEdits(l.p, [l.picture], 2)).toEqual({ edits: [], refused: SPEED, spans: [] });
    for (const ripple of [false, true]) {
      const g = speedGesture(null, l.p, [l.picture], { ripple });
      expect(speedEdits(g, l.p, 2)).toEqual([]);
      // Nothing was changed, so nothing is found cut short when the gesture ends, told its step or not.
      expect(speedGestureCutShort(speedStepped(g, l.p), l.p)).toEqual([]);
      expect(speedGestureCutShort(speedStepped(g, l.p, 0.5), l.p)).toEqual([]);
    }
    // The core operation itself would have written to the locked track.
    expect(setSpeed(l.p, [l.picture], 2).map((e) => (e.op === 'updateClip' ? e.id : e.op))).toContain(
      l.sound,
    );
  });

  it('names the track by the name it was given', () => {
    const l = locked(true);
    const named = applyEdits(l.p, [{ op: 'updateTrack', id: l.a1.id, patch: { name: 'Dialogue' } }]);
    expect(retimeRefusal(named, [l.picture], 2)).toBe(
      "Unlock Dialogue to change this clip's speed: what is linked to it has to follow.",
    );
  });

  it('is not in the way of a speed for a clip that is on no ramp: its partner stays as it is, as before', () => {
    const l = locked(false);
    expect(retimeRefusal(l.p, [l.picture], 2)).toBeNull();
    expect(speedEach(l.p, [l.picture], 2)).toEqual(setSpeed(l.p, [l.picture], 2));
    expect(speedEach(l.p, [l.picture], 2).map((e) => (e.op === 'updateClip' ? e.id : e.op))).toEqual([
      l.picture,
    ]);
    // Nor of a ramp for clips that have nothing on that track.
    expect(retimeRefusal(l.p, [l.bed.id], shaped(l.p, [l.bed.id], 'hero'))).toBeNull();
  });
});

describe('sound whose speed a gesture changes', () => {
  it('keeps its pitch from then on, and is as it was when the gesture comes back', () => {
    const c = cut();
    const [picture, sound] = c.pairs[0];
    const scrub = scrubber(c.p, c.pairs[0]);
    scrub.to(2);
    expect(scrub.state.p.clips[sound].keepPitch).toBe(true);
    expect(scrub.state.p.clips[picture].keepPitch).toBeNull();
    scrub.to(0.5);
    expect(scrub.state.p.clips[sound].keepPitch).toBe(true);
    scrub.to(1);
    expect(scrub.state.p.clips[sound]).toEqual(c.p.clips[sound]);
    expect(scrub.state.p.clips[sound].keepPitch).toBeNull();
    // A choice that was made stays made, through the gesture and after it.
    const chosen = applyEdits(c.p, [{ op: 'updateClip', id: sound, patch: { keepPitch: false } }]);
    const again = scrubber(chosen, c.pairs[0]);
    again.to(2);
    expect(again.state.p.clips[sound].keepPitch).toBe(false);
    // And a ramp does the same as a speed.
    const drag = ramper(c.p, [picture]);
    drag.to(shaped(c.p, [picture], 'hero'));
    expect(drag.state.p.clips[sound].keepPitch).toBe(true);
    drag.to(off(picture));
    expect(drag.state.p.clips[sound].keepPitch).toBeNull();
  });

  it('is served by a gesture that is not told its steps, as the speed slider drives it', () => {
    const c = cut();
    const g = speedGesture(null, c.p, c.pairs[0]);
    expect(g.last).toBeNull();
    const p = applyEdits(c.p, speedEdits(g, c.p, 0.5));
    const untold = speedStepped(g, p);
    expect(untold.last).toBeNull();
    expect(speedStepped(g, p, 0.5).last).toEqual({ speed: 0.5 });
    // What it left cut short is worked out from the speed the clips now have.
    expect(speedGestureCutShort(untold, p)).toEqual(speedCutShort(c.p, c.pairs[0], 0.5));
    expect(speedGestureCutShort(speedStepped(g, p, 0.5), p)).toEqual(speedCutShort(c.p, c.pairs[0], 0.5));
    expect(speedGesture(untold, p, c.pairs[0])).toBe(untold);
  });
});
