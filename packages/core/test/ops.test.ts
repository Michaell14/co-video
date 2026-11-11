import { describe, expect, it } from 'vitest';
import {
  addAssetToTimeline,
  addGenerator,
  applyEdits,
  changeFrameRate,
  clipEnd,
  clipsOnTrack,
  closeGap,
  deleteClips,
  deleteRange,
  freezeFrame,
  handles,
  sourceTimeAt,
  makeTransition,
  openGap,
  pasteClips,
  placeClips,
  rollEdit,
  sequenceEnd,
  setSpeed,
  setTransition,
  slipClips,
  splitClips,
  toggleKeyframe,
  trimClips,
  trimRange,
  writeProp,
  moveTrack,
  tracksOf,
} from '../src';
import { addClip, fixture, overlaps } from './helpers';

describe('adding media', () => {
  it('creates a linked video + audio pair on free tracks', () => {
    const { p, asset, v1, a1 } = fixture();
    const r = addAssetToTimeline(p, asset, { frame: 0 });
    const q = applyEdits(p, r.edits);
    const clips = Object.values(q.clips);
    expect(clips).toHaveLength(2);
    const v = clips.find((c) => c.type === 'video')!;
    const a = clips.find((c) => c.type === 'audio')!;
    expect(v.trackId).toBe(v1.id);
    expect(a.trackId).toBe(a1.id);
    expect(v.duration).toBe(1800);
    expect(v.linkId).toBeTruthy();
    expect(v.linkId).toBe(a.linkId);
  });

  it('stacks onto another track instead of overwriting when no target is given', () => {
    const { p, asset, v2 } = fixture();
    let q = applyEdits(p, addAssetToTimeline(p, asset, { frame: 0 }).edits);
    q = applyEdits(q, addAssetToTimeline(q, asset, { frame: 100 }).edits);
    const videos = Object.values(q.clips).filter((c) => c.type === 'video');
    expect(videos.map((c) => c.trackId)).toContain(v2.id);
    // No audio track was free, so a new one must have been created.
    expect(tracksOf(q).audio).toHaveLength(2);
    expect(overlaps(q)).toEqual([]);
  });

  it('respects source in / out', () => {
    const { p, asset } = fixture();
    const q = applyEdits(p, addAssetToTimeline(p, asset, { frame: 10, sourceIn: 5, sourceOut: 7 }).edits);
    const v = Object.values(q.clips).find((c) => c.type === 'video')!;
    expect(v.start).toBe(10);
    expect(v.duration).toBe(60);
    expect(v.sourceIn).toBe(5);
  });

  it('puts generators on top', () => {
    const { p, asset, v2 } = fixture();
    let q = applyEdits(p, addAssetToTimeline(p, asset, { frame: 0 }).edits);
    q = applyEdits(q, addGenerator(q, 'text', { frame: 0 }).edits);
    const text = Object.values(q.clips).find((c) => c.type === 'text')!;
    expect(text.trackId).toBe(v2.id);
    expect(text.text?.content).toBeTruthy();
    // A second title at the same time needs a new track above.
    q = applyEdits(q, addGenerator(q, 'text', { frame: 0 }).edits);
    expect(tracksOf(q).video).toHaveLength(3);
    expect(overlaps(q)).toEqual([]);
  });
});

describe('overwrite placement', () => {
  it('trims, splits and removes underlying clips', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100);
    p = a.p;
    const b = addClip(p, f.v1.id, 100, 100);
    p = b.p;
    const c = addClip(p, f.v1.id, 200, 20);
    p = c.p;
    const mover = addClip(p, f.v2.id, 0, 150);
    p = mover.p;

    // Drop the 150-frame clip at 60 on V1: A is trimmed to 60, B is trimmed to start at 210?? no —
    // 60…210 covers the tail of A, all of B and the first 10 frames of C.
    const q = applyEdits(p, placeClips(p, [{ id: mover.clip.id, start: 60, trackId: f.v1.id }]));
    expect(overlaps(q)).toEqual([]);
    expect(q.clips[a.clip.id].duration).toBe(60);
    expect(q.clips[b.clip.id]).toBeUndefined();
    expect(q.clips[c.clip.id].start).toBe(210);
    expect(q.clips[c.clip.id].duration).toBe(10);
    // C lost its first 10 frames, so its source in point advances by 10 frames.
    expect(q.clips[c.clip.id].sourceIn).toBeCloseTo(10 / 30);
    expect(q.clips[mover.clip.id].trackId).toBe(f.v1.id);
  });

  it('splits a clip when dropping into its middle', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 300);
    p = a.p;
    const m = addClip(p, f.v2.id, 0, 50);
    p = m.p;
    const q = applyEdits(p, placeClips(p, [{ id: m.clip.id, start: 100, trackId: f.v1.id }]));
    const list = clipsOnTrack(q, f.v1.id);
    expect(list.map((c) => [c.start, c.duration])).toEqual([
      [0, 100],
      [100, 50],
      [150, 150],
    ]);
    expect(list[2].sourceIn).toBeCloseTo(150 / 30);
    expect(overlaps(q)).toEqual([]);
  });

  it('refuses to put video on an audio track', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 0, 100);
    expect(placeClips(a.p, [{ id: a.clip.id, start: 0, trackId: f.a1.id }])).toEqual([]);
  });
});

describe('trim', () => {
  it('limits by source handles and neighbours', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 100, 100, { sourceIn: 1 }); // 30 frames of head handle
    p = a.p;
    const b = addClip(p, f.v1.id, 220, 50);
    p = b.p;
    expect(trimRange(p, [a.clip.id], 'start', false)).toEqual({ min: -30, max: 99 });
    // Tail: plenty of source, but the neighbour is 20 frames away.
    expect(trimRange(p, [a.clip.id], 'end', false)).toEqual({ min: -99, max: 20 });
    // Ripple ignores the neighbour.
    expect(trimRange(p, [a.clip.id], 'end', true).max).toBeGreaterThan(20);
  });

  it('trims the head and advances the source', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 100, 100, { sourceIn: 2 });
    const q = applyEdits(a.p, trimClips(a.p, [a.clip.id], 'start', 15));
    const c = q.clips[a.clip.id];
    expect([c.start, c.duration]).toEqual([115, 85]);
    expect(c.sourceIn).toBeCloseTo(2.5);
  });

  it('ripple-trims the tail and pulls later clips', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100);
    p = a.p;
    const b = addClip(p, f.v1.id, 100, 50);
    p = b.p;
    const q = applyEdits(p, trimClips(p, [a.clip.id], 'end', -40, true));
    expect(q.clips[a.clip.id].duration).toBe(60);
    expect(q.clips[b.clip.id].start).toBe(60);
    expect(overlaps(q)).toEqual([]);
  });

  it('ripple-trims the head keeping the clip in place', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 50, 100);
    p = a.p;
    const b = addClip(p, f.v1.id, 150, 50);
    p = b.p;
    const q = applyEdits(p, trimClips(p, [a.clip.id], 'start', 30, true));
    expect(q.clips[a.clip.id].start).toBe(50);
    expect(q.clips[a.clip.id].duration).toBe(70);
    expect(q.clips[a.clip.id].sourceIn).toBeCloseTo(1);
    expect(q.clips[b.clip.id].start).toBe(120);
  });

  it('handles reversed clips', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 0, 90, { sourceIn: 10, reverse: true });
    // Trimming the head of a reversed clip removes the END of its source range.
    let q = applyEdits(a.p, trimClips(a.p, [a.clip.id], 'start', 30));
    expect(q.clips[a.clip.id].sourceIn).toBe(10);
    expect(q.clips[a.clip.id].duration).toBe(60);
    // Trimming the tail removes the START of its source range.
    q = applyEdits(a.p, trimClips(a.p, [a.clip.id], 'end', -30));
    expect(q.clips[a.clip.id].sourceIn).toBeCloseTo(11);
  });

  it('rolls an edit point', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100);
    p = a.p;
    const b = addClip(p, f.v1.id, 100, 100, { sourceIn: 5 });
    p = b.p;
    const q = applyEdits(p, rollEdit(p, a.clip.id, b.clip.id, 20));
    expect(clipEnd(q.clips[a.clip.id])).toBe(120);
    expect(q.clips[b.clip.id].start).toBe(120);
    expect(q.clips[b.clip.id].sourceIn).toBeCloseTo(5 + 20 / 30);
    expect(sequenceEnd(q)).toBe(200);
  });

  it('slips within the source', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 0, 300, { sourceIn: 1 });
    let q = applyEdits(a.p, slipClips(a.p, [a.clip.id], 30));
    expect(q.clips[a.clip.id].sourceIn).toBeCloseTo(2);
    q = applyEdits(a.p, slipClips(a.p, [a.clip.id], -9999));
    expect(q.clips[a.clip.id].sourceIn).toBe(0);
    q = applyEdits(a.p, slipClips(a.p, [a.clip.id], 99999));
    expect(q.clips[a.clip.id].sourceIn).toBeCloseTo(50);
  });
});

describe('split & delete', () => {
  it('splits linked clips together and keeps the right halves linked', () => {
    const { p, asset } = fixture();
    const q0 = applyEdits(p, addAssetToTimeline(p, asset, { frame: 0 }).edits);
    const ids = Object.keys(q0.clips);
    const r = splitClips(q0, ids, 300);
    const q = applyEdits(q0, r.edits);
    expect(Object.keys(q.clips)).toHaveLength(4);
    expect(r.created).toHaveLength(2);
    const [r1, r2] = r.created.map((id) => q.clips[id]);
    expect(r1.linkId).toBeTruthy();
    expect(r1.linkId).toBe(r2.linkId);
    expect(r1.linkId).not.toBe(q.clips[ids[0]].linkId);
    expect(r1.start).toBe(300);
    expect(r1.sourceIn).toBeCloseTo(10);
    expect(overlaps(q)).toEqual([]);
  });

  it('carries keyframes across a split', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 0, 100, {
      keyframes: {
        opacity: [
          { t: 0, v: 0, e: 'linear' },
          { t: 100, v: 1, e: 'linear' },
        ],
      },
    });
    const r = splitClips(a.p, [a.clip.id], 40);
    const q = applyEdits(a.p, r.edits);
    const right = q.clips[r.created[0]];
    expect(right.keyframes.opacity.map((k) => k.t)).toEqual([-40, 60]);
  });

  it('ignores a split outside the clip', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 10, 100);
    expect(splitClips(a.p, [a.clip.id], 10).edits).toEqual([]);
    expect(splitClips(a.p, [a.clip.id], 110).edits).toEqual([]);
  });

  it('ripple delete closes the gap on that track only', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100);
    p = a.p;
    const b = addClip(p, f.v1.id, 100, 50);
    p = b.p;
    const c = addClip(p, f.v1.id, 150, 50);
    p = c.p;
    const other = addClip(p, f.v2.id, 150, 50);
    p = other.p;
    const q = applyEdits(p, deleteClips(p, [b.clip.id], true));
    expect(q.clips[c.clip.id].start).toBe(100);
    expect(q.clips[other.clip.id].start).toBe(150);
  });

  it('closes a gap', () => {
    const f = fixture();
    let p = f.p;
    p = addClip(p, f.v1.id, 0, 100).p;
    const b = addClip(p, f.v1.id, 160, 50);
    p = b.p;
    const q = applyEdits(p, closeGap(p, f.v1.id, 120));
    expect(q.clips[b.clip.id].start).toBe(100);
    expect(closeGap(p, f.v1.id, 50)).toEqual([]);
  });

  it('extracts a range across a straddling clip', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 300);
    p = a.p;
    const q = applyEdits(p, deleteRange(p, [f.v1.id], 100, 150, true));
    const list = clipsOnTrack(q, f.v1.id);
    expect(list.map((c) => [c.start, c.duration])).toEqual([
      [0, 100],
      [100, 150],
    ]);
    expect(list[1].sourceIn).toBeCloseTo(5);
  });

  it('opens a gap for insert edits', () => {
    const f = fixture();
    let p = f.p;
    p = addClip(p, f.v1.id, 0, 100).p;
    const q = applyEdits(p, openGap(p, [f.v1.id], 40, 30));
    expect(clipsOnTrack(q, f.v1.id).map((c) => [c.start, c.duration])).toEqual([
      [0, 40],
      [70, 60],
    ]);
  });
});

describe('freeze frame', () => {
  it('holds the frame under the playhead and ripples everything after it', () => {
    const { p, asset, v2 } = fixture();
    let q = applyEdits(p, addAssetToTimeline(p, asset, { frame: 0 }).edits);
    const video = Object.values(q.clips).find((c) => c.type === 'video')!;
    const audio = Object.values(q.clips).find((c) => c.type === 'audio')!;
    // Something on another track that starts after the freeze point must move too.
    const other = addClip(q, v2.id, 400, 60);
    q = other.p;
    const end = sequenceEnd(q);

    const r = freezeFrame(q, video.id, 300, 90);
    const out = applyEdits(q, r.edits);
    const still = out.clips[r.created[0]];
    expect(still.freeze).toBe(true);
    expect(still.start).toBe(300);
    expect(still.duration).toBe(90);
    expect(still.sourceIn).toBeCloseTo(10);
    expect(still.linkId).toBeNull();
    // The hold never advances through the source, and can be trimmed without limit.
    expect(sourceTimeAt(still, 0, out)).toBeCloseTo(10);
    expect(sourceTimeAt(still, 89, out)).toBeCloseTo(10);
    expect(handles(still, asset, out)).toEqual({ head: Infinity, tail: Infinity });

    expect(out.clips[video.id].duration).toBe(300);
    expect(out.clips[audio.id].duration).toBe(300);
    const rights = Object.values(out.clips).filter((c) => c.start === 390);
    expect(rights.map((c) => c.type).sort()).toEqual(['audio', 'video']);
    // The halves after the hold continue where the picture stopped, and are still linked.
    for (const c of rights) expect(c.sourceIn).toBeCloseTo(10);
    expect(rights[0].linkId).toBeTruthy();
    expect(rights[0].linkId).toBe(rights[1].linkId);
    expect(out.clips[other.clip.id].start).toBe(490);
    expect(sequenceEnd(out)).toBe(end + 90);
    expect(overlaps(out)).toEqual([]);
  });

  it('bakes animated values into the hold and ignores speed changes', () => {
    const f = fixture();
    const { p, clip } = addClip(f.p, f.v1.id, 0, 100, {
      keyframes: { opacity: [{ t: 0, v: 0, e: 'linear' }, { t: 100, v: 1, e: 'linear' }] },
    });
    const r = freezeFrame(p, clip.id, 50, 30);
    const out = applyEdits(p, r.edits);
    const still = out.clips[r.created[0]];
    expect(still.opacity).toBeCloseTo(0.5);
    expect(still.keyframes).toEqual({});
    expect(setSpeed(out, [still.id], 2)).toEqual([]);
    expect(freezeFrame(p, clip.id, 500, 30).edits).toEqual([]);
  });
});

describe('speed, paste, transitions, keyframes', () => {
  it('changes duration with speed and stays inside the gap', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100);
    p = a.p;
    let q = applyEdits(p, setSpeed(p, [a.clip.id], 2));
    expect(q.clips[a.clip.id].duration).toBe(50);
    p = addClip(p, f.v1.id, 120, 50).p;
    q = applyEdits(p, setSpeed(p, [a.clip.id], 0.5));
    expect(q.clips[a.clip.id].duration).toBe(120);
    expect(overlaps(q)).toEqual([]);
  });

  it('pastes with fresh ids and remapped links', () => {
    const { p, asset } = fixture();
    const q0 = applyEdits(p, addAssetToTimeline(p, asset, { frame: 0, sourceOut: 2 }).edits);
    const items = Object.values(q0.clips);
    const r = pasteClips(q0, items, 200);
    const q = applyEdits(q0, r.edits);
    expect(Object.keys(q.clips)).toHaveLength(4);
    const pasted = r.created.map((id) => q.clips[id]);
    expect(pasted.every((c) => c.start === 200)).toBe(true);
    expect(pasted[0].linkId).toBe(pasted[1].linkId);
    expect(pasted[0].linkId).not.toBe(items[0].linkId);
  });

  it('clamps transition length to the shorter neighbour', () => {
    const f = fixture();
    let p = f.p;
    p = addClip(p, f.v1.id, 0, 20).p;
    const b = addClip(p, f.v1.id, 20, 100);
    p = b.p;
    const q = applyEdits(p, setTransition(p, b.clip.id, 'in', makeTransition('crossDissolve', 60)));
    expect(q.clips[b.clip.id].transIn?.duration).toBe(20);
  });

  it('writes keyframes only for animated properties', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 0, 100);
    let clip = a.clip;
    expect(writeProp(clip, 'opacity', 0.5, 10)).toEqual({ opacity: 0.5 });
    clip = { ...clip, ...toggleKeyframe(clip, 'opacity', 0, 1) };
    expect(clip.keyframes.opacity).toHaveLength(1);
    clip = { ...clip, ...writeProp(clip, 'opacity', 0.2, 50) };
    expect(clip.keyframes.opacity.map((k) => [k.t, k.v])).toEqual([
      [0, 1],
      [50, 0.2],
    ]);
    // Toggling off the last keyframe bakes the current value back into the base.
    clip = { ...clip, ...toggleKeyframe(clip, 'opacity', 0, 1) };
    clip = { ...clip, ...toggleKeyframe(clip, 'opacity', 50, 0.2) };
    expect(clip.keyframes.opacity).toBeUndefined();
    expect(clip.opacity).toBe(0.2);
  });

  it('conforms the sequence to a new frame rate', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 30, 60);
    const q = applyEdits(a.p, changeFrameRate(a.p, 60, 1));
    expect(q.settings.fpsNum).toBe(60);
    expect([q.clips[a.clip.id].start, q.clips[a.clip.id].duration]).toEqual([60, 120]);
  });

  it('reorders tracks', () => {
    const f = fixture();
    const q = applyEdits(f.p, moveTrack(f.p, f.v1.id, 1));
    expect(tracksOf(q).video.map((t) => t.id)).toEqual([f.v2.id, f.v1.id]);
  });
});
