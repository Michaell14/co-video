import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT,
  addAssetToTimeline,
  addGenerator,
  applyEdits,
  changeFrameRate,
  clipEnd,
  clipsOnTrack,
  closeGap,
  deleteClips,
  deleteRange,
  evalKeyframes,
  freezeFrame,
  handles,
  insertClips,
  linkedIds,
  sourceTimeAt,
  makeClip,
  makeTrack,
  makeTransition,
  openGap,
  pasteClips,
  placeClips,
  resolveFrame,
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
import type { Clip, Project } from '../src';
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

  it('ripple delete closes the gap and takes the other tracks along', () => {
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
    expect(q.clips[other.clip.id].start).toBe(100);
    // Without ripple nothing else moves.
    const lifted = applyEdits(p, deleteClips(p, [b.clip.id]));
    expect([lifted.clips[c.clip.id].start, lifted.clips[other.clip.id].start]).toEqual([150, 150]);
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

  /** A sync clip: picture on V1 and sound on A1 over the same frames, linked. */
  const syncPair = (f: ReturnType<typeof fixture>, start: number, duration: number, linkId: string) => {
    const video = makeClip('video', f.v1.id, { assetId: 'asset1', start, duration, linkId });
    const audio = makeClip('audio', f.a1.id, { assetId: 'asset1', start, duration, linkId });
    const p = applyEdits(f.p, [
      { op: 'addClip', clip: video },
      { op: 'addClip', clip: audio },
    ]);
    return { p, video, audio };
  };
  const spans = (p: Project, trackId: string) => clipsOnTrack(p, trackId).map((c) => [c.start, clipEnd(c)]);

  it('keeps picture and sound linked on both sides of a range cut out of a sync clip', () => {
    const f = fixture();
    const { p, video, audio } = syncPair(f, 0, 90, 'take');
    for (const ripple of [true, false]) {
      const q = applyEdits(p, deleteRange(p, [f.v1.id, f.a1.id], 30, 60, ripple));
      const after = ripple ? [30, 60] : [60, 90];
      for (const track of [f.v1, f.a1]) expect(spans(q, track.id)).toEqual([[0, 30], after]);
      const [v1, v2] = clipsOnTrack(q, f.v1.id);
      const [a1, a2] = clipsOnTrack(q, f.a1.id);
      // What comes before the cut is the clip that was there, link and all.
      expect([v1.id, a1.id]).toEqual([video.id, audio.id]);
      expect([v1.linkId, a1.linkId]).toEqual(['take', 'take']);
      // What comes after it is a pair of its own, as after a split at the same frame.
      expect(v2.linkId).toBeTruthy();
      expect(v2.linkId).not.toBe('take');
      expect(a2.linkId).toBe(v2.linkId);
      expect(linkedIds(q, v2.id).sort()).toEqual([v2.id, a2.id].sort());
      expect(v2.sourceIn).toBeCloseTo(2);
      expect(a2.sourceIn).toBeCloseTo(2);
    }
  });

  it('leaves the piece after a cut unlinked when only one track of a sync clip was cut', () => {
    const f = fixture();
    const { p, video, audio } = syncPair(f, 0, 90, 'take');
    const q = applyEdits(p, deleteRange(p, [f.v1.id], 30, 60, false));
    const [head, tail] = clipsOnTrack(q, f.v1.id);
    expect(head.linkId).toBe('take');
    expect(tail.linkId).toBeNull();
    expect(linkedIds(q, audio.id).sort()).toEqual([video.id, audio.id].sort());
  });

  it('links the pieces that begin at the same cut, also when the clips are cut differently', () => {
    const f = fixture();
    // The sound runs on after the picture, and the picture begins inside the first cut.
    const video = makeClip('video', f.v1.id, { assetId: 'asset1', start: 25, duration: 65, linkId: 'take' });
    const audio = makeClip('audio', f.a1.id, { assetId: 'asset1', start: 0, duration: 120, linkId: 'take' });
    const p = applyEdits(f.p, [
      { op: 'addClip', clip: video },
      { op: 'addClip', clip: audio },
    ]);
    const dropped = [20, 50, 100].flatMap((start) => [
      makeClip('solid', f.v1.id, { start, duration: 10 }),
      makeClip('audio', f.a1.id, { start, duration: 10 }),
    ]);
    const r = insertClips(p, dropped);
    const q = applyEdits(p, r.edits);
    expect(overlaps(q)).toEqual([]);
    const pieces = (trackId: string) => clipsOnTrack(q, trackId).filter((c) => !r.created.includes(c.id));
    const [v1, v2] = pieces(f.v1.id);
    const [a1, a2, a3, a4] = pieces(f.a1.id);
    expect([v1, v2].map((c) => [c.start, clipEnd(c)])).toEqual([
      [30, 50],
      [60, 90],
    ]);
    expect([a1, a2, a3, a4].map((c) => [c.start, clipEnd(c)])).toEqual([
      [0, 20],
      [30, 50],
      [60, 100],
      [110, 120],
    ]);
    // The first piece of each clip is the clip itself.
    expect([v1.id, a1.id]).toEqual([video.id, audio.id]);
    expect([v1.linkId, a1.linkId]).toEqual(['take', 'take']);
    // Picture and sound that begin at frame 60 belong together.
    expect(v2.linkId).toBeTruthy();
    expect(a3.linkId).toBe(v2.linkId);
    // Nothing else begins where these two do.
    expect([a2.linkId, a4.linkId]).toEqual([null, null]);
  });

  it('keeps a sync clip linked on both sides of a clip dropped into its middle', () => {
    const f = fixture();
    const { p } = syncPair(f, 0, 90, 'take');
    const drop = [
      makeClip('video', f.v1.id, { assetId: 'asset1', start: 30, duration: 30, linkId: 'new' }),
      makeClip('audio', f.a1.id, { assetId: 'asset1', start: 30, duration: 30, linkId: 'new' }),
    ];
    const q = applyEdits(p, insertClips(p, drop).edits);
    expect(overlaps(q)).toEqual([]);
    const v = clipsOnTrack(q, f.v1.id);
    const a = clipsOnTrack(q, f.a1.id);
    expect(v.map((c) => c.linkId === a[v.indexOf(c)].linkId)).toEqual([true, true, true]);
    expect(new Set(v.map((c) => c.linkId)).size).toBe(3);
    expect(v[2].linkId).toBeTruthy();

    // Dragging a sync clip onto another one does the same to the one underneath.
    const second = syncPair({ ...f, p }, 200, 30, 'moved');
    const moved = applyEdits(
      second.p,
      placeClips(second.p, [
        { id: second.video.id, start: 30, trackId: f.v1.id },
        { id: second.audio.id, start: 30, trackId: f.a1.id },
      ]),
    );
    const tails = [f.v1.id, f.a1.id].map((id) => clipsOnTrack(moved, id)[2]);
    expect(tails.map((c) => [c.start, clipEnd(c)])).toEqual([
      [60, 90],
      [60, 90],
    ]);
    expect(tails[0].linkId).toBeTruthy();
    expect(tails[0].linkId).toBe(tails[1].linkId);
  });

  /** Opacity the title animation applies at each frame (1 where no title is showing). */
  const animOpacity = (p: Project, frames: number[]): number[] =>
    frames.map((f) => {
      const layer = resolveFrame(p, f).layers[0];
      return layer?.kind === 'clip' ? +layer.layer.anim.opacity.toFixed(2) : 1;
    });

  const animatedTitle = (f: ReturnType<typeof fixture>, start: number, duration: number) => {
    const clip = makeClip('text', f.v2.id, {
      start,
      duration,
      fadeIn: 5,
      fadeOut: 5,
      transIn: makeTransition('crossDissolve', 10),
      transOut: makeTransition('crossDissolve', 10),
      text: {
        ...DEFAULT_TEXT,
        animIn: { type: 'fade', duration: 20 },
        animOut: { type: 'slideUp', duration: 20 },
      },
    });
    return { p: applyEdits(f.p, [{ op: 'addClip', clip }]), clip };
  };

  it('does not animate a title out and back in across a split', () => {
    const f = fixture();
    const { p, clip } = animatedTitle(f, 0, 100);
    const r = splitClips(p, [clip.id], 50);
    const q = applyEdits(p, r.edits);
    const left = q.clips[clip.id];
    const right = q.clips[r.created[0]];
    // Each half keeps the animation of the end it still owns, and its length.
    expect(left.text!.animIn).toEqual({ type: 'fade', duration: 20 });
    expect(left.text!.animOut).toEqual({ type: 'none', duration: 20 });
    expect(right.text!.animIn).toEqual({ type: 'none', duration: 20 });
    expect(right.text!.animOut).toEqual({ type: 'slideUp', duration: 20 });
    expect([left.transOut, left.fadeOut, right.transIn, right.fadeIn]).toEqual([null, 0, null, 0]);
    // The transitions at the outer ends hide the layer there, so look at the modifiers directly.
    const before = applyEdits(p, [
      { op: 'updateClip', id: clip.id, patch: { transIn: null, transOut: null } },
    ]);
    const after = applyEdits(q, [
      { op: 'updateClip', id: left.id, patch: { transIn: null } },
      { op: 'updateClip', id: right.id, patch: { transOut: null } },
    ]);
    expect(animOpacity(before, [0, 10, 48, 49, 50, 51, 99])).toEqual([0, 0.5, 1, 1, 1, 1, 0.1]);
    expect(animOpacity(after, [0, 10, 48, 49, 50, 51, 99])).toEqual([0, 0.5, 1, 1, 1, 1, 0.1]);
    // The original text object is shared, not rewritten, where nothing changes.
    const plain = makeClip('text', f.v2.id, { start: 200, duration: 50, text: { ...DEFAULT_TEXT } });
    const withPlain = applyEdits(p, [{ op: 'addClip', clip: plain }]);
    const halves = splitClips(withPlain, [plain.id], 220);
    expect(halves.edits.every((e) => e.op !== 'updateClip' || !('text' in e.patch))).toBe(true);
  });

  it('drops title animation at the edges made by an overwrite or an insert edit', () => {
    const f = fixture();
    const { p, clip } = animatedTitle(f, 0, 100);
    // Something lands in the middle: both remaining pieces lose the animation at the new cut.
    const mid = makeClip('image', f.v2.id, { start: 40, duration: 20 });
    let q = applyEdits(p, insertClips(p, [mid]).edits);
    const [head, , tail] = clipsOnTrack(q, f.v2.id);
    expect([head.text!.animIn.type, head.text!.animOut.type]).toEqual(['fade', 'none']);
    expect([tail.text!.animIn.type, tail.text!.animOut.type]).toEqual(['none', 'slideUp']);
    // Something covers the tail: the piece that is left keeps its entrance only.
    const over = makeClip('image', f.v2.id, { start: 70, duration: 80 });
    q = applyEdits(p, insertClips(p, [over]).edits);
    expect(q.clips[clip.id].text).toEqual({ ...clip.text, animOut: { type: 'none', duration: 20 } });
    expect(q.clips[clip.id].duration).toBe(70);
    // An insert edit splits it the same way.
    q = applyEdits(p, openGap(p, [f.v2.id], 30, 60));
    const [l, r] = clipsOnTrack(q, f.v2.id);
    expect([l.text!.animIn.type, l.text!.animOut.type]).toEqual(['fade', 'none']);
    expect([r.text!.animIn.type, r.text!.animOut.type]).toEqual(['none', 'slideUp']);
    expect(r.start).toBe(90);
    // Trimming is not a cut: the animation moves with the edge.
    q = applyEdits(p, trimClips(p, [clip.id], 'end', -30));
    expect(q.clips[clip.id].text).toEqual(clip.text);
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
      keyframes: {
        opacity: [
          { t: 0, v: 0, e: 'linear' },
          { t: 100, v: 1, e: 'linear' },
        ],
      },
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

  it('keeps keyframes on the picture when a neighbour limits a slow-down', () => {
    const f = fixture();
    const keyframes = { x: [{ t: 50, v: 1, e: 'linear' as const }] };
    const a = addClip(f.p, f.v1.id, 0, 100, { keyframes });
    const alone = applyEdits(a.p, setSpeed(a.p, [a.clip.id], 0.5));
    expect(alone.clips[a.clip.id].duration).toBe(200);
    expect(alone.clips[a.clip.id].keyframes.x[0].t).toBe(100);
    // With a clip right behind it the slowed clip cannot grow, but the moment the keyframe marks
    // is still twice as far in.
    const p = addClip(a.p, f.v1.id, 100, 50).p;
    const q = applyEdits(p, setSpeed(p, [a.clip.id], 0.5));
    expect(q.clips[a.clip.id].duration).toBe(100);
    expect(q.clips[a.clip.id].keyframes.x[0].t).toBe(100);
    expect(sourceTimeAt(q.clips[a.clip.id], 100, q)).toBeCloseTo(sourceTimeAt(a.clip, 50, p));
    // Back to full speed and the keyframe is where it started.
    const back = applyEdits(q, setSpeed(q, [a.clip.id], 1));
    expect(back.clips[a.clip.id].keyframes.x[0].t).toBe(50);
    expect(evalKeyframes(back.clips[a.clip.id].keyframes.x, 50)).toBe(1);
  });

  it('keeps the first frame of a reversed clip when a neighbour cuts a slow-down short', () => {
    const f = fixture();
    const a = addClip(f.p, f.v1.id, 300, 300, { sourceIn: 10, reverse: true });
    const p = addClip(a.p, f.v1.id, 600, 100).p;
    const first = sourceTimeAt(a.clip, 0, p);
    const q = applyEdits(p, setSpeed(p, [a.clip.id], 0.5));
    const slow = q.clips[a.clip.id];
    expect(slow.duration).toBe(300);
    // Half speed shows the top half of the source range, still starting from its last frame.
    expect(slow.sourceIn).toBeCloseTo(15);
    expect(Math.abs(sourceTimeAt(slow, 0, q) - first)).toBeLessThan(1 / 30);
    expect(sourceTimeAt(slow, 299, q)).toBeCloseTo(15);
    // Unclamped, forwards, or reversing in the same step: the range is used as before.
    const free = applyEdits(a.p, setSpeed(a.p, [a.clip.id], 0.5));
    expect([free.clips[a.clip.id].duration, free.clips[a.clip.id].sourceIn]).toEqual([600, 10]);
    const forwards = applyEdits(p, setSpeed(p, [a.clip.id], 0.5, false));
    expect(forwards.clips[a.clip.id].sourceIn).toBe(10);
    const b = addClip(p, f.v1.id, 0, 300, { sourceIn: 10 });
    const flipped = applyEdits(b.p, setSpeed(b.p, [b.clip.id], 0.5, true));
    expect(flipped.clips[b.clip.id].sourceIn).toBeCloseTo(15);
    expect(overlaps(flipped)).toEqual([]);
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

  it('pastes back onto the tracks the clips came from, overwriting what is there', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 50);
    p = a.p;
    const b = addClip(p, f.v2.id, 20, 50);
    p = b.p;
    const inTheWay = addClip(p, f.v1.id, 110, 30);
    p = inTheWay.p;
    const r = pasteClips(p, [a.clip, b.clip], 100);
    const q = applyEdits(p, r.edits);
    const [pa, pb] = r.created.map((id) => q.clips[id]);
    expect([pa.trackId, pa.start, pb.trackId, pb.start]).toEqual([f.v1.id, 100, f.v2.id, 120]);
    expect(q.clips[inTheWay.clip.id]).toBeUndefined();
    expect(tracksOf(q).video).toHaveLength(2);
    expect(overlaps(q)).toEqual([]);
  });

  it('gives each source track its own target when clips cannot go back where they came from', () => {
    const f = fixture();
    let p = f.p;
    const a = addClip(p, f.v1.id, 0, 100);
    p = a.p;
    const b = addClip(p, f.v2.id, 0, 100);
    p = b.p;
    const b2 = addClip(p, f.v2.id, 100, 50);
    p = b2.p;
    const items = [a.clip, b.clip, b2.clip];
    const tracks = (q: Project, ids: string[]) => ids.map((id) => q.clips[id].trackId);

    // V2 is locked: its clips move together to a new track above, not onto V1 with the others.
    const locked = applyEdits(p, [{ op: 'updateTrack', id: f.v2.id, patch: { locked: true } }]);
    let r = pasteClips(locked, items, 500);
    let q = applyEdits(locked, r.edits);
    expect(r.edits.filter((e) => e.op === 'addTrack')).toHaveLength(1);
    const top = tracksOf(q).video[2];
    expect(tracks(q, r.created)).toEqual([f.v1.id, top.id, top.id]);
    expect(r.created.map((id) => q.clips[id].start)).toEqual([500, 500, 600]);
    expect(overlaps(q)).toEqual([]);

    // The tracks are unknown (copied in another project): two layers stay two layers, on tracks
    // that are free at that time, and nothing already on the timeline is overwritten.
    const foreign = items.map((c): Clip => ({ ...c, trackId: c.trackId === f.v1.id ? 'gone1' : 'gone2' }));
    r = pasteClips(p, foreign, 50);
    q = applyEdits(p, r.edits);
    expect(Object.keys(q.clips)).toHaveLength(6);
    for (const c of [a.clip, b.clip, b2.clip]) expect(q.clips[c.id]).toBe(p.clips[c.id]);
    const [t1, t2, t3] = tracks(q, r.created);
    expect(t1).not.toBe(t2);
    expect(t2).toBe(t3);
    expect(r.edits.filter((e) => e.op === 'addTrack')).toHaveLength(2);
    expect(overlaps(q)).toEqual([]);

    // Where there is room they reuse existing tracks, bottom up, in the order they were copied.
    r = pasteClips(p, foreign, 400);
    q = applyEdits(p, r.edits);
    expect(r.edits.filter((e) => e.op === 'addTrack')).toHaveLength(0);
    expect(tracks(q, r.created)).toEqual([f.v1.id, f.v2.id, f.v2.id]);
    expect(overlaps(q)).toEqual([]);
  });

  it('creates one track for all the audio that has nowhere to go', () => {
    const f = fixture();
    let p = f.p;
    const audio = [0, 100, 200].map((start) =>
      makeClip('audio', f.a1.id, { assetId: 'asset1', start, duration: 100 }),
    );
    p = applyEdits(
      p,
      audio.map((clip) => ({ op: 'addClip', clip }) as const),
    );
    p = applyEdits(p, [{ op: 'updateTrack', id: f.a1.id, patch: { locked: true } }]);
    const r = pasteClips(p, audio, 0);
    const q = applyEdits(p, r.edits);
    expect(r.edits.filter((e) => e.op === 'addTrack')).toHaveLength(1);
    const added = tracksOf(q).audio[1];
    expect(r.created.map((id) => q.clips[id].trackId)).toEqual([added.id, added.id, added.id]);
    expect(clipsOnTrack(q, f.a1.id)).toHaveLength(3);
    expect(overlaps(q)).toEqual([]);

    // A second locked source track gets a second new track; a free unlocked one is used first.
    const a2 = makeTrack('audio', 1);
    const other = makeClip('audio', a2.id, { assetId: 'asset1', start: 0, duration: 300 });
    let two = applyEdits(p, [
      { op: 'addTrack', track: { ...a2, locked: true } },
      { op: 'addClip', clip: other },
    ]);
    const spare = makeTrack('audio', 2);
    two = applyEdits(two, [{ op: 'addTrack', track: spare }]);
    const r2 = pasteClips(two, [...audio, other], 0);
    const q2 = applyEdits(two, r2.edits);
    expect(r2.edits.filter((e) => e.op === 'addTrack')).toHaveLength(1);
    const homes = r2.created.map((id) => q2.clips[id].trackId);
    expect(new Set(homes.slice(0, 3))).toEqual(new Set([spare.id]));
    expect(homes[3]).not.toBe(spare.id);
    expect(overlaps(q2)).toEqual([]);
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
