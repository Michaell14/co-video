import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  ASSET_DEFAULTS,
  clipEnd,
  DEFAULT_GRADE,
  emptyProject,
  makeClip,
  makeEffect,
  makeTrack,
  makeTransition,
  type Clip,
  type Edit,
  type Project,
  type Track,
} from '@tandem/core';
import {
  attributePatch,
  captionClips,
  clipBeside,
  clipExtent,
  clipsBeside,
  closeGapAt,
  closeGapOn,
  copiedAttributes,
  CUT_FADE,
  duplicateClips,
  edgeCuts,
  edgeRange,
  markerBeside,
  markerEdits,
  matchFrameAt,
  nearestEdge,
  openGapAt,
  pasteable,
  rippleDeleteClips,
  rippleDeleteRange,
  rippledFrame,
  rippleTrimToFrame,
  selectionAtFrame,
  trackNudge,
  transitionEdits,
  transitionTarget,
  transitionTargets,
  trimEdge,
  trimReference,
  trimSpans,
  unlocked,
} from '../src/state/edits';

interface Fixture {
  p: Project;
  v1: Track;
  v2: Track;
  a1: Track;
}

function fixture(): Fixture {
  const v1 = makeTrack('video', 0);
  const v2 = makeTrack('video', 1);
  const a1 = makeTrack('audio', 0);
  const p = applyEdits(emptyProject(), [
    { op: 'addTrack', track: v1 },
    { op: 'addTrack', track: v2 },
    { op: 'addTrack', track: a1 },
    { op: 'addAsset', asset: { ...ASSET_DEFAULTS, id: 'asset1', name: 'clip.mp4', kind: 'video' } },
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

const lock = (p: Project, t: Track): Project =>
  applyEdits(p, [{ op: 'updateTrack', id: t.id, patch: { locked: true } }]);

const layout = (p: Project, t: Track): string[] =>
  Object.values(p.clips)
    .filter((c) => c.trackId === t.id)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.start}-${clipEnd(c)}`);

function overlaps(p: Project): number {
  let n = 0;
  for (const t of Object.values(p.tracks)) {
    const list = Object.values(p.clips)
      .filter((c) => c.trackId === t.id)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) if (list[i].start < clipEnd(list[i - 1])) n++;
  }
  return n;
}

describe('unlocked', () => {
  it('drops clips on locked tracks and ids that name nothing', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    const b = add(a.p, f.a1, 0, 30);
    const p = lock(b.p, f.a1);
    expect(unlocked(p, [a.clip.id, b.clip.id, 'gone'])).toEqual([a.clip.id]);
    expect(unlocked(b.p, [a.clip.id, b.clip.id])).toEqual([a.clip.id, b.clip.id]);
  });
});

describe('duplicateClips', () => {
  it('puts the copy straight after the clip when that space is free', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const far = add(a.p, f.v1, 300, 60);
    const r = duplicateClips(far.p, [a.clip.id]);
    const p = applyEdits(far.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0-120', '120-240', '300-360']);
    expect(r.created).toHaveLength(1);
    expect(p.clips[r.created[0]].start).toBe(120);
  });

  it('makes room instead of overwriting the clip that follows', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120, { name: 'next' });
    const music = add(b.p, f.a1, 0, 360);
    const title = add(music.p, f.v2, 18, 90);
    const before = title.p;
    const r = duplicateClips(before, [a.clip.id]);
    const p = applyEdits(before, r.edits);
    // The neighbour is still there, whole, after the copy.
    expect(p.clips[b.clip.id]).toMatchObject({ start: 240, duration: 120, name: 'next' });
    expect(layout(p, f.v1)).toEqual(['0-120', '120-240', '240-360']);
    // Everything downstream moved by the same amount on the other tracks: the music is cut at the
    // insertion point and its tail follows; the title, which ends before it, stays.
    expect(layout(p, f.a1)).toEqual(['0-120', '240-480']);
    expect(layout(p, f.v2)).toEqual(['18-108']);
    expect(overlaps(p)).toBe(0);
    expect(Object.keys(p.clips)).toHaveLength(Object.keys(before.clips).length + 2);
  });

  it('keeps a linked pair linked to each other, not to the originals', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 60, { linkId: 'L' });
    const a = add(v.p, f.a1, 0, 60, { linkId: 'L' });
    const next = add(a.p, f.v1, 60, 60);
    const r = duplicateClips(next.p, [v.clip.id, a.clip.id]);
    const p = applyEdits(next.p, r.edits);
    const [c1, c2] = r.created.map((id) => p.clips[id]);
    expect(c1.linkId).toBeTruthy();
    expect(c1.linkId).toBe(c2.linkId);
    expect(c1.linkId).not.toBe('L');
    expect([c1.start, c2.start]).toEqual([60, 60]);
    expect(p.clips[next.clip.id].start).toBe(120);
    expect(overlaps(p)).toBe(0);
  });

  it('leaves locked tracks alone, as source and as bystander', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 60, 60);
    const held = add(b.p, f.a1, 0, 200);
    const p0 = lock(held.p, f.a1);
    const r = duplicateClips(p0, [a.clip.id, held.clip.id]);
    const p = applyEdits(p0, r.edits);
    expect(r.created).toHaveLength(1);
    expect(layout(p, f.a1)).toEqual(['0-200']);
    expect(layout(p, f.v1)).toEqual(['0-60', '60-120', '120-180']);
  });

  it('does nothing without clips to copy', () => {
    const f = fixture();
    expect(duplicateClips(f.p, ['nope'])).toEqual({ edits: [], created: [], spans: [] });
  });

  it('says how much room it made, and none when the space was free', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 120);
    const b = add(a.p, f.v1, 120, 120);
    expect(duplicateClips(b.p, [a.clip.id]).spans).toEqual([{ from: 120, by: 120 }]);
    expect(duplicateClips(b.p, [b.clip.id]).spans).toEqual([]);
  });
});

describe('closeGapAt', () => {
  const NOTHING = { edits: [], refused: null, spans: [] };

  it('closes the gap under the frame and carries the other tracks along', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    const b = add(a.p, f.v1, 90, 30);
    const s = add(b.p, f.a1, 90, 30);
    const r = closeGapAt(s.p, 50);
    expect(r.refused).toBeNull();
    const p = applyEdits(s.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0-30', '30-60']);
    expect(layout(p, f.a1)).toEqual(['30-60']);
    expect(r.spans).toEqual([{ from: 30, by: -60 }]);
  });

  it('closes one gap, the picture gap, when the tracks above have a longer one at the same frame', () => {
    const f = fixture();
    // Three shots with the second one deleted, a music bed, a title on the first shot and a
    // lower third 60 frames into the third.
    const one = add(f.p, f.v1, 0, 120);
    const three = add(one.p, f.v1, 240, 120);
    const bed = add(three.p, f.a1, 0, 360);
    const title = add(bed.p, f.v2, 18, 90);
    const third = add(title.p, f.v2, 300, 150);
    const r = closeGapAt(third.p, 130);
    expect(r.refused).toBeNull();
    const p = applyEdits(third.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0-120', '120-240']);
    // The lower third is still 60 frames into its shot. Closing V2's own 192-frame gap as well
    // would have put it at 108, before the shot begins.
    expect(layout(p, f.v2)).toEqual(['18-108', '180-330']);
    expect(layout(p, f.a1)).toEqual(['0-360']);
    expect(r.spans).toEqual([{ from: 120, by: -120 }]);
    // What Close gap in the lane menu does for the same gap.
    expect(closeGapOn(third.p, f.v1.id, 130).edits).toEqual(r.edits);
  });

  it('goes to the first sound track when no picture track has a gap there', () => {
    const f = fixture();
    const picture = add(f.p, f.v1, 0, 300);
    const a = add(picture.p, f.a1, 0, 60);
    const b = add(a.p, f.a1, 100, 60);
    const r = closeGapAt(b.p, 80);
    const p = applyEdits(b.p, r.edits);
    expect(layout(p, f.a1)).toEqual(['0-60', '60-120']);
    expect(layout(p, f.v1)).toEqual(['0-300']);
  });

  it('reports nothing when there is no gap', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    expect(closeGapAt(a.p, 10)).toEqual(NOTHING);
    expect(closeGapAt(a.p, 500)).toEqual(NOTHING);
  });

  it('says why when the gap cannot be closed', () => {
    const f = fixture();
    // The clip after the gap is linked to sound that has no room to follow.
    const a = add(f.p, f.v1, 0, 30);
    const v = add(a.p, f.v1, 90, 30, { linkId: 'L' });
    const blocker = add(v.p, f.a1, 0, 90);
    const s = add(blocker.p, f.a1, 90, 30, { linkId: 'L' });
    const r = closeGapAt(s.p, 50);
    expect(r.edits).toEqual([]);
    expect(r.spans).toEqual([]);
    expect(r.refused).toMatch(/^Cannot ripple here/);
  });

  it('skips locked tracks', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    const b = add(a.p, f.v1, 90, 30);
    const p0 = lock(b.p, f.v1);
    expect(closeGapAt(p0, 50)).toEqual(NOTHING);
  });
});

describe('clipsBeside', () => {
  it('splits the timeline at the frame, with the clip under it on both sides', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    const b = add(a.p, f.v1, 30, 30);
    const c = add(b.p, f.v1, 60, 30);
    const s = add(c.p, f.a1, 100, 30);
    expect(clipsBeside(s.p, 45, 'right')).toEqual([b.clip.id, c.clip.id, s.clip.id]);
    expect(clipsBeside(s.p, 45, 'left')).toEqual([a.clip.id, b.clip.id]);
    // On a cut: the clip ending there is to the left only, the one starting there to the right only.
    expect(clipsBeside(s.p, 30, 'right')).toEqual([b.clip.id, c.clip.id, s.clip.id]);
    expect(clipsBeside(s.p, 30, 'left')).toEqual([a.clip.id]);
  });

  it('leaves out locked tracks', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    const s = add(a.p, f.a1, 0, 30);
    expect(clipsBeside(lock(s.p, f.a1), 0, 'right')).toEqual([a.clip.id]);
  });
});

describe('markerBeside', () => {
  const marker = (id: string, frame: number) => ({ id, frame, name: id, color: '#fff', note: '' });
  const p = applyEdits(emptyProject(), [
    { op: 'setMarker', marker: marker('b', 120) },
    { op: 'setMarker', marker: marker('a', 30) },
    { op: 'setMarker', marker: marker('c', 240) },
  ]);

  it('finds the neighbouring marker either way', () => {
    expect(markerBeside(p, 0, 1)).toBe(30);
    expect(markerBeside(p, 30, 1)).toBe(120);
    expect(markerBeside(p, 100, 1)).toBe(120);
    expect(markerBeside(p, 240, -1)).toBe(120);
    expect(markerBeside(p, 121, -1)).toBe(120);
    expect(markerBeside(p, 500, -1)).toBe(240);
  });

  it('has nothing past the last or before the first', () => {
    expect(markerBeside(p, 240, 1)).toBeNull();
    expect(markerBeside(p, 30, -1)).toBeNull();
    expect(markerBeside(emptyProject(), 10, 1)).toBeNull();
  });
});

describe('pasteable', () => {
  it('leaves out clips whose media is not in the project', () => {
    const f = fixture();
    const mine = makeClip('video', f.v1.id, { assetId: 'asset1' });
    const foreign = makeClip('video', f.v1.id, { assetId: 'elsewhere' });
    const text = makeClip('text', f.v2.id);
    expect(pasteable(f.p, [mine, foreign, text])).toEqual({ clips: [mine, text], missing: 1 });
    expect(pasteable(f.p, [foreign])).toEqual({ clips: [], missing: 1 });
  });

  it('drops a LUT the project does not have but keeps the rest of the grade', () => {
    const f = fixture();
    const base = makeClip('text', f.v2.id);
    const graded = { ...base, grade: { ...({ lutId: 'lut-x', enabled: true } as Clip['grade'] & object) } };
    const { clips, missing } = pasteable(f.p, [graded]);
    expect(missing).toBe(0);
    expect(clips[0].grade).toMatchObject({ lutId: null, enabled: true });
    expect(graded.grade.lutId).toBe('lut-x');
  });

  it('re-times clips that were copied at another frame rate', () => {
    const f = fixture();
    // Copied at 30 fps, pasted into a project that runs at 60.
    const at60 = applyEdits(f.p, [{ op: 'settings', patch: { fpsNum: 60, fpsDen: 1 } }]);
    const first = makeClip('video', f.v1.id, {
      assetId: 'asset1',
      start: 90,
      duration: 120,
      fadeIn: 6,
      transIn: makeTransition('crossDissolve', 15),
      keyframes: { opacity: [{ t: 30, v: 0.5, e: 'linear' }] },
    });
    const second = makeClip('video', f.v1.id, { assetId: 'asset1', start: 210, duration: 45 });
    const { clips } = pasteable(at60, [first, second], 30);
    expect(clips[0]).toMatchObject({ start: 180, duration: 240, fadeIn: 12 });
    expect(clips[0].transIn?.duration).toBe(30);
    expect(clips[0].keyframes.opacity[0].t).toBe(60);
    // The second still starts where the first ends.
    expect(clips[1]).toMatchObject({ start: 420, duration: 90 });
    expect(first).toMatchObject({ start: 90, duration: 120 });
    // The same rate, however it is written, and an unknown one change nothing.
    expect(pasteable(at60, [first], 60).clips[0]).toBe(first);
    expect(pasteable(at60, [first]).clips[0]).toBe(first);
    expect(pasteable(at60, [first], 0).clips[0]).toBe(first);
  });
});

describe('rippleDeleteRange', () => {
  it('takes the range out of every unlocked track and closes it', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 100);
    const b = add(a.p, f.v1, 100, 50);
    const s = add(b.p, f.a1, 20, 100);
    const r = rippleDeleteRange(s.p, 30, 60);
    expect(r.refused).toBeNull();
    const p = applyEdits(s.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0-30', '30-70', '70-120']);
    expect(layout(p, f.a1)).toEqual(['20-30', '30-90']);
    expect(overlaps(p)).toBe(0);
  });

  it('is refused when a linked clip on a locked track would be left behind', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 100, { linkId: 'L' });
    const s = add(v.p, f.a1, 0, 100, { linkId: 'L' });
    const p = lock(s.p, f.a1);
    const r = rippleDeleteRange(p, 30, 60);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Unlock A1 to ripple: a linked clip on it has to move too.');
  });

  it('names the track as the user named it', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 200, 50, { linkId: 'L' });
    const s = add(v.p, f.a1, 200, 50, { linkId: 'L' });
    const named = applyEdits(s.p, [
      { op: 'updateTrack', id: f.a1.id, patch: { name: 'Dialogue', locked: true } },
    ]);
    // The pair lies after the range: it would be moved, not cut, and still be parted.
    expect(rippleDeleteRange(named, 30, 60).refused).toBe(
      'Unlock Dialogue to ripple: a linked clip on it has to move too.',
    );
  });

  it('leaves a locked track alone when nothing linked to it moves', () => {
    const f = fixture();
    const before = add(f.p, f.v1, 0, 20, { linkId: 'L' });
    const partner = add(before.p, f.a1, 0, 20, { linkId: 'L' });
    const later = add(partner.p, f.v1, 50, 50);
    const loose = add(later.p, f.a1, 40, 40);
    const p0 = lock(loose.p, f.a1);
    const r = rippleDeleteRange(p0, 30, 60);
    expect(r.refused).toBeNull();
    const p = applyEdits(p0, r.edits);
    expect(layout(p, f.v1)).toEqual(['0-20', '30-70']);
    expect(layout(p, f.a1)).toEqual(['0-20', '40-80']);
  });

  it('does nothing for an empty range', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 100);
    expect(rippleDeleteRange(a.p, 60, 60)).toEqual({ edits: [], refused: null, spans: [] });
  });

  it('says which time it took out', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 100);
    expect(rippleDeleteRange(a.p, 30, 60).spans).toEqual([{ from: 30, by: -30 }]);
  });
});

describe('transitionTarget', () => {
  it('turns the out side of a cut into the in side of the clip that follows', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 60, 60);
    expect(transitionTarget(b.p, a.clip.id, 'out')).toEqual({ clipId: b.clip.id, side: 'in' });
  });

  it('keeps the out side where nothing follows directly', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const gap = add(a.p, f.v1, 61, 60);
    expect(transitionTarget(gap.p, a.clip.id, 'out')).toEqual({ clipId: a.clip.id, side: 'out' });
    expect(transitionTarget(gap.p, gap.clip.id, 'out')).toEqual({ clipId: gap.clip.id, side: 'out' });
  });

  it('leaves the in side and unknown clips as they are', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 60, 60);
    expect(transitionTarget(b.p, b.clip.id, 'in')).toEqual({ clipId: b.clip.id, side: 'in' });
    expect(transitionTarget(b.p, 'nope', 'out')).toEqual({ clipId: 'nope', side: 'out' });
  });
});

describe('matchFrameAt', () => {
  const withLength = (p: Project): Project =>
    applyEdits(p, [{ op: 'updateAsset', id: 'asset1', patch: { duration: 10 } }]);

  it('gives the source time the timeline shows at the frame', () => {
    const f = fixture();
    const a = add(withLength(f.p), f.v1, 100, 60, { sourceIn: 2 });
    const fps = a.p.settings.fpsNum / a.p.settings.fpsDen;
    const m = matchFrameAt(a.p, 130);
    expect(m?.clip.id).toBe(a.clip.id);
    expect(m?.time).toBeCloseTo(2 + 30 / fps);
  });

  it('follows speed and reverse', () => {
    const f = fixture();
    const fast = add(withLength(f.p), f.v1, 0, 60, { sourceIn: 1, speed: 2 });
    const fps = fast.p.settings.fpsNum / fast.p.settings.fpsDen;
    expect(matchFrameAt(fast.p, 15)?.time).toBeCloseTo(1 + (15 * 2) / fps);
    const back = add(withLength(f.p), f.v1, 0, 60, { sourceIn: 1, reverse: true });
    expect(matchFrameAt(back.p, 0)?.time).toBeCloseTo(1 + 59 / fps);
    expect(matchFrameAt(back.p, 59)?.time).toBeCloseTo(1);
  });

  it('prefers the top-most picture, then sound, and a selected clip over both', () => {
    const f = fixture();
    const low = add(withLength(f.p), f.v1, 0, 60);
    const high = add(low.p, f.v2, 0, 60);
    const sound = add(high.p, f.a1, 0, 90);
    expect(matchFrameAt(sound.p, 10)?.clip.id).toBe(high.clip.id);
    expect(matchFrameAt(sound.p, 70)?.clip.id).toBe(sound.clip.id);
    expect(matchFrameAt(sound.p, 10, [sound.clip.id])?.clip.id).toBe(sound.clip.id);
    // A selected clip that is not under the frame does not count.
    expect(matchFrameAt(sound.p, 70, [low.clip.id])?.clip.id).toBe(sound.clip.id);
  });

  it('looks past what is not on screen', () => {
    const f = fixture();
    const low = add(withLength(f.p), f.v1, 0, 60);
    const off = add(low.p, f.v2, 0, 60, { enabled: false });
    expect(matchFrameAt(off.p, 10)?.clip.id).toBe(low.clip.id);
    const hidden = applyEdits(add(low.p, f.v2, 0, 60).p, [
      { op: 'updateTrack', id: f.v2.id, patch: { hidden: true } },
    ]);
    expect(matchFrameAt(hidden, 10)?.clip.id).toBe(low.clip.id);
  });

  it('has nothing to match on empty time or on clips without media', () => {
    const f = fixture();
    const a = add(withLength(f.p), f.v1, 0, 60);
    expect(matchFrameAt(a.p, 60)).toBeNull();
    const title = makeClip('text', f.v2.id, { start: 100, duration: 30 });
    const p = applyEdits(a.p, [{ op: 'addClip', clip: title }]);
    expect(matchFrameAt(p, 110)).toBeNull();
  });
});

/** The sample's layout: three shots on V1, a music bed under all of them, a title over the first. */
function sample() {
  const f = fixture();
  const dusk = add(f.p, f.v1, 0, 120);
  const fractal = add(dusk.p, f.v1, 120, 120);
  const aurora = add(fractal.p, f.v1, 240, 120);
  const bed = add(aurora.p, f.a1, 0, 360);
  const title = add(bed.p, f.v2, 18, 90);
  return {
    ...f,
    p: title.p,
    dusk: dusk.clip,
    fractal: fractal.clip,
    aurora: aurora.clip,
    bed: bed.clip,
    title: title.clip,
  };
}

const marker = (id: string, frame: number): Edit => ({
  op: 'setMarker',
  marker: { id, frame, name: id, color: '#fff', note: '' },
});

const markerFrames = (p: Project): Record<string, number> =>
  Object.fromEntries(Object.values(p.markers).map((m) => [m.id, m.frame]));

describe('trimReference', () => {
  it('is the shot on the lowest picture track, not the title above or the music below', () => {
    const s = sample();
    expect(trimReference(s.p, 60)?.id).toBe(s.dusk.id);
    expect(trimReference(s.p, 180)?.id).toBe(s.fractal.id);
  });

  it('trims that shot alone: the music bed keeps its head and its tail', () => {
    const s = sample();
    const ref = trimReference(s.p, 180)!;
    const tail = rippleTrimToFrame(s.p, [ref.id], 'end', 180);
    let p = applyEdits(s.p, tail.edits);
    expect(layout(p, s.v1)).toEqual(['0-120', '120-180', '180-300']);
    expect(layout(p, s.a1)).toEqual(['0-360']);
    expect(layout(p, s.v2)).toEqual(['18-108']);
    expect(tail.spans).toEqual([{ from: 180, by: -60 }]);

    const head = rippleTrimToFrame(s.p, [ref.id], 'start', 180);
    p = applyEdits(s.p, head.edits);
    expect(layout(p, s.v1)).toEqual(['0-120', '120-180', '180-300']);
    expect(layout(p, s.a1)).toEqual(['0-360']);
    // The trimmed shot now begins at the cut, which is where the playhead goes.
    expect(p.clips[ref.id].start).toBe(120);
    expect(head.spans).toEqual([{ from: 120, by: -60 }]);
  });

  it('has nothing to trim on a cut, and does not reach for the music instead', () => {
    const s = sample();
    expect(trimReference(s.p, 120)).toBeNull();
    expect(trimReference(s.p, 0)).toBeNull();
  });

  it('goes up to a title where the track below is empty, and to sound where there is no picture', () => {
    const f = fixture();
    const title = add(f.p, f.v2, 10, 50);
    const sound = add(title.p, f.a1, 0, 200);
    expect(trimReference(sound.p, 30)?.id).toBe(title.clip.id);
    expect(trimReference(sound.p, 100)?.id).toBe(sound.clip.id);
    expect(trimReference(sound.p, 300)).toBeNull();
  });

  it('passes over a locked track', () => {
    const s = sample();
    expect(trimReference(lock(s.p, s.v1), 60)?.id).toBe(s.title.id);
  });
});

describe('trackNudge', () => {
  it('moves the picture of a sync clip and leaves its sound on its track', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L' });
    const a = add(v.p, f.a1, 0, 120, { linkId: 'L' });
    const up = trackNudge(a.p, [v.clip.id, a.clip.id], 1);
    expect(up.refused).toBeNull();
    const p = applyEdits(a.p, up.edits);
    expect(p.clips[v.clip.id].trackId).toBe(f.v2.id);
    expect(p.clips[a.clip.id].trackId).toBe(f.a1.id);
    expect(p.clips[v.clip.id].linkId).toBe('L');
    // And back down again, with the sound still not in the way.
    const down = trackNudge(p, [v.clip.id, a.clip.id], -1);
    expect(applyEdits(p, down.edits).clips[v.clip.id].trackId).toBe(f.v1.id);
  });

  it('moves sound when only sound is selected: up is towards the first sound track', () => {
    const a2 = makeTrack('audio', 1);
    const f = fixture();
    const p0 = applyEdits(f.p, [{ op: 'addTrack', track: a2 }]);
    const s = add(p0, a2, 0, 60);
    const up = trackNudge(s.p, [s.clip.id], 1);
    expect(applyEdits(s.p, up.edits).clips[s.clip.id].trackId).toBe(f.a1.id);
    expect(trackNudge(s.p, [s.clip.id], -1)).toEqual({
      edits: [],
      refused: 'There is no track below to move to.',
    });
  });

  it('moves the clips of one kind together or not at all, and says what is in the way', () => {
    const f = fixture();
    const low = add(f.p, f.v1, 0, 60);
    const high = add(low.p, f.v2, 0, 60);
    expect(trackNudge(high.p, [low.clip.id, high.clip.id], 1)).toEqual({
      edits: [],
      refused: 'There is no track above to move to.',
    });
    expect(trackNudge(lock(high.p, f.v2), [low.clip.id], 1)).toEqual({
      edits: [],
      refused: 'V2 is locked. Unlock it to move clips onto it.',
    });
    expect(trackNudge(high.p, [], 1)).toEqual({ edits: [], refused: null });
  });
});

describe('captionClips', () => {
  const text = (track: Track, start: number, content: string, init: Partial<Clip> = {}) =>
    makeClip('text', track.id, { start, duration: 30, text: { content } as Clip['text'], ...init });

  /** A title on V2 and two captions on a track of their own, as an imported subtitle file leaves it. */
  function captioned() {
    const f = fixture();
    const captions = { ...makeTrack('video', 2), name: 'Captions' };
    const title = text(f.v2, 18, 'Edit in tandem');
    const one = text(captions, 15, 'Hello from Tandem');
    const two = text(captions, 66, 'Captions import as text clips');
    const p = applyEdits(f.p, [
      { op: 'addTrack', track: captions },
      ...[title, two, one].map((clip): Edit => ({ op: 'addClip', clip })),
    ]);
    return { ...f, p, captions, title, one, two };
  }

  const said = (clips: Clip[]): string[] => clips.map((c) => c.text!.content);

  it('writes the caption track and leaves the titles out', () => {
    const c = captioned();
    const r = captionClips(c.p, []);
    expect(r.from).toBe('captions');
    expect(said(r.clips)).toEqual(['Hello from Tandem', 'Captions import as text clips']);
  });

  it('goes by the name of the track, however it is capitalised or continued', () => {
    const c = captioned();
    const renamed = (name: string) =>
      applyEdits(c.p, [{ op: 'updateTrack', id: c.captions.id, patch: { name } }]);
    expect(captionClips(renamed('subtitles (EN)'), []).from).toBe('captions');
    expect(captionClips(renamed(' CAPTIONS'), []).clips).toHaveLength(2);
    // With no caption track at all the titles are all there is to go by.
    const none = captionClips(renamed('Text'), []);
    expect(none.from).toBe('everything');
    expect(said(none.clips)).toEqual([
      'Hello from Tandem',
      'Edit in tandem',
      'Captions import as text clips',
    ]);
  });

  it('prefers selected text, and a track that was asked for by id', () => {
    const c = captioned();
    const picked = captionClips(c.p, [c.two.id, c.title.id]);
    expect(picked.from).toBe('selection');
    expect(said(picked.clips)).toEqual(['Edit in tandem', 'Captions import as text clips']);
    const track = captionClips(c.p, [c.two.id], c.v2.id);
    expect(track.from).toBe('track');
    expect(track.tracks.map((t) => t.id)).toEqual([c.v2.id]);
    expect(said(track.clips)).toEqual(['Edit in tandem']);
  });

  it('leaves a hidden caption track out while another one is showing', () => {
    const c = captioned();
    const french = { ...makeTrack('video', 3), name: 'Captions (FR)' };
    const p = applyEdits(c.p, [
      { op: 'addTrack', track: french },
      { op: 'addClip', clip: text(french, 15, 'Bonjour de Tandem') },
    ]);
    const both = captionClips(p, []);
    expect(both.tracks).toHaveLength(2);
    expect(said(both.clips)).toEqual([
      'Hello from Tandem',
      'Bonjour de Tandem',
      'Captions import as text clips',
    ]);
    const hide = (track: Track, hidden = true): Edit => ({
      op: 'updateTrack',
      id: track.id,
      patch: { hidden },
    });
    const english = captionClips(applyEdits(p, [hide(french)]), []);
    expect(english.tracks.map((t) => t.name)).toEqual(['Captions']);
    expect(said(english.clips)).toEqual(['Hello from Tandem', 'Captions import as text clips']);
    // Captions that are all hidden, to see the picture while cutting, are still the captions.
    expect(captionClips(applyEdits(p, [hide(french), hide(c.captions)]), []).clips).toHaveLength(3);
  });

  it('leaves out disabled clips, and a selection without text does not count', () => {
    const c = captioned();
    const off = applyEdits(c.p, [{ op: 'updateClip', id: c.one.id, patch: { enabled: false } }]);
    const video = add(off, c.v1, 0, 60);
    const r = captionClips(video.p, [video.clip.id]);
    expect(r.from).toBe('captions');
    expect(said(r.clips)).toEqual(['Captions import as text clips']);
  });

  it('exports nothing rather than the titles when the caption track is empty', () => {
    const c = captioned();
    const emptied = applyEdits(c.p, [
      { op: 'removeClip', id: c.one.id },
      { op: 'removeClip', id: c.two.id },
    ]);
    expect(captionClips(emptied, [])).toMatchObject({ clips: [], from: 'captions' });
  });
});

describe('selecting from the keyboard', () => {
  const alone = (id: string) => [id];

  it('marks the selection, else the clip that is seen under the playhead', () => {
    const s = sample();
    expect(clipExtent(s.p, 300, [])).toEqual({ in: 240, out: 360 });
    // Under the title it is the title that is seen; selected clips say otherwise.
    expect(clipExtent(s.p, 60, [])).toEqual({ in: 18, out: 108 });
    expect(clipExtent(s.p, 60, [s.dusk.id, s.fractal.id])).toEqual({ in: 0, out: 240 });
    expect(clipExtent(s.p, 500, [])).toBeNull();
  });

  it('marks neither a disabled clip nor one on a hidden track, and sound only without picture', () => {
    const s = sample();
    const off = applyEdits(s.p, [{ op: 'updateClip', id: s.title.id, patch: { enabled: false } }]);
    expect(clipExtent(off, 60, [])).toEqual({ in: 0, out: 120 });
    const hidden = applyEdits(s.p, [{ op: 'updateTrack', id: s.v2.id, patch: { hidden: true } }]);
    expect(clipExtent(hidden, 60, [])).toEqual({ in: 0, out: 120 });
    const noPicture = applyEdits(s.p, [{ op: 'removeClip', id: s.fractal.id }]);
    expect(clipExtent(noPicture, 180, [])).toEqual({ in: 0, out: 360 });
  });

  it('selects the clip under the playhead from the top track down, round and round', () => {
    const s = sample();
    const first = selectionAtFrame(s.p, 60, [], alone);
    expect(first).toEqual([s.title.id]);
    const second = selectionAtFrame(s.p, 60, first!, alone);
    expect(second).toEqual([s.dusk.id]);
    const third = selectionAtFrame(s.p, 60, second!, alone);
    expect(third).toEqual([s.bed.id]);
    expect(selectionAtFrame(s.p, 60, third!, alone)).toEqual([s.title.id]);
    // Something else selected starts from the top again; an empty frame selects nothing.
    expect(selectionAtFrame(s.p, 60, [s.aurora.id], alone)).toEqual([s.title.id]);
    expect(selectionAtFrame(s.p, 500, [], alone)).toBeNull();
  });

  it('counts a picture and its linked sound as one stop, and passes over locked tracks', () => {
    const f = fixture();
    const v = add(f.p, f.v1, 0, 120, { linkId: 'L' });
    const a = add(v.p, f.a1, 0, 120, { linkId: 'L' });
    const over = add(a.p, f.v2, 0, 120);
    const pair = [v.clip.id, a.clip.id];
    const widen = (id: string) => (pair.includes(id) ? pair : [id]);
    expect(selectionAtFrame(over.p, 10, [over.clip.id], widen)).toEqual(pair);
    expect(selectionAtFrame(over.p, 10, [a.clip.id, v.clip.id], widen)).toEqual([over.clip.id]);
    expect(selectionAtFrame(lock(over.p, f.v2), 10, [], widen)).toEqual(pair);
  });

  it('steps to the next and the previous clip on the track of the selection', () => {
    const s = sample();
    expect(clipBeside(s.p, [s.dusk.id], 0, 1)?.id).toBe(s.fractal.id);
    expect(clipBeside(s.p, [s.fractal.id], 0, -1)?.id).toBe(s.dusk.id);
    expect(clipBeside(s.p, [s.aurora.id], 0, 1)).toBeNull();
    expect(clipBeside(s.p, [s.dusk.id], 0, -1)).toBeNull();
    // An extended selection goes on from its far end; picture decides the track of a sync pair.
    expect(clipBeside(s.p, [s.dusk.id, s.fractal.id], 0, 1)?.id).toBe(s.aurora.id);
    expect(clipBeside(s.p, [s.bed.id, s.fractal.id], 0, -1)?.id).toBe(s.dusk.id);
  });

  it('starts from the playhead when nothing is selected', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 100, 60);
    const s = add(b.p, f.a1, 70, 20);
    expect(clipBeside(s.p, [], 30, 1)?.id).toBe(a.clip.id);
    expect(clipBeside(s.p, [], 65, 1)?.id).toBe(s.clip.id);
    expect(clipBeside(s.p, [], 65, -1)?.id).toBe(a.clip.id);
    expect(clipBeside(s.p, [], 95, -1)?.id).toBe(s.clip.id);
    expect(clipBeside(s.p, [], 500, 1)).toBeNull();
    expect(clipBeside(lock(s.p, f.v1), [], 30, 1)?.id).toBe(s.clip.id);
  });
});

describe('trimming from the keyboard', () => {
  /** Tracks V1 and A1 with a ten-second file: three sync clips cut from its middle, back to back. */
  function sequence() {
    const f = fixture();
    let p = applyEdits(f.p, [{ op: 'updateAsset', id: 'asset1', patch: { duration: 10 } }]);
    const pairs: { v: Clip; a: Clip }[] = [];
    for (let i = 0; i < 3; i++) {
      const init = { linkId: `L${i}`, sourceIn: 2 };
      const v = add(p, f.v1, i * 60, 60, init);
      const a = add(v.p, f.a1, i * 60, 60, init);
      p = a.p;
      pairs.push({ v: v.clip, a: a.clip });
    }
    return { ...f, p, pairs };
  }

  it('picks the edge nearest the playhead, an end by the last frame of its clip', () => {
    const s = sequence();
    const ids = [s.pairs[1].v.id, s.pairs[1].a.id];
    expect(nearestEdge(s.p, ids, 60)).toMatchObject({ clip: { id: ids[0] }, edge: 'start' });
    expect(nearestEdge(s.p, ids, 70)?.edge).toBe('start');
    expect(nearestEdge(s.p, ids, 110)?.edge).toBe('end');
    // Parked on the last frame, where a trim of the end leaves the playhead, it is still the end.
    expect(nearestEdge(s.p, ids, 119)?.edge).toBe('end');
    expect(nearestEdge(s.p, ids, 500)?.edge).toBe('end');
    expect(nearestEdge(s.p, ['nope'], 60)).toBeNull();
    // Several clips: the one whose edge is nearest.
    const all = s.pairs.map((x) => x.v.id);
    expect(nearestEdge(s.p, all, 170)).toMatchObject({ clip: { id: all[2] }, edge: 'end' });
  });

  it('rolls a cut for picture and sound alike, so no hole opens and nothing after moves', () => {
    const s = sequence();
    const ids = [s.pairs[1].v.id, s.pairs[1].a.id];
    expect(edgeCuts(s.p, ids, 'start')).toEqual({
      cuts: [
        [s.pairs[0].v.id, s.pairs[1].v.id],
        [s.pairs[0].a.id, s.pairs[1].a.id],
      ],
      free: [],
    });
    const r = trimEdge(s.p, ids, 'start', 1, false);
    expect(r.moved).toBe(1);
    const p = applyEdits(s.p, r.edits);
    for (const t of [s.v1, s.a1]) expect(layout(p, t)).toEqual(['0-61', '61-120', '120-180']);
    expect(overlaps(p)).toBe(0);
    // The incoming clip shows one frame less of its head; its picture did not slide.
    expect(p.clips[ids[0]].sourceIn).toBeCloseTo(2 + 1 / 30);
    expect(p.clips[s.pairs[2].v.id]).toEqual(s.p.clips[s.pairs[2].v.id]);
    expect(r.spans).toEqual([]);
  });

  it('stops a roll where either clip runs out of media or of frames', () => {
    const s = sequence();
    const ids = [s.pairs[1].v.id, s.pairs[1].a.id];
    const { cuts, free } = edgeCuts(s.p, ids, 'end');
    // The outgoing clip has 6 s of media after its end (180 frames); the incoming one is 60 long.
    expect(edgeRange(s.p, 'end', cuts, free)).toEqual({ min: -59, max: 59 });
    expect(trimEdge(s.p, ids, 'end', 500, false).moved).toBe(59);
    const tight = applyEdits(s.p, [{ op: 'updateClip', id: s.pairs[2].a.id, patch: { sourceIn: 3 / 30 } }]);
    // The sound after the cut has three frames of head: the picture cut cannot go further either.
    expect(trimEdge(tight, ids, 'end', -10, false).moved).toBe(-3);
    const p = applyEdits(tight, trimEdge(tight, ids, 'end', -10, false).edits);
    for (const t of [s.v1, s.a1]) expect(layout(p, t)).toEqual(['0-60', '60-117', '117-180']);
  });

  it('trims a free edge on its own, up to the next clip', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 60);
    const b = add(a.p, f.v1, 70, 60);
    expect(edgeCuts(b.p, [a.clip.id], 'end')).toEqual({ cuts: [], free: [a.clip.id] });
    const r = trimEdge(b.p, [a.clip.id], 'end', 25, false);
    expect(r.moved).toBe(10);
    expect(layout(applyEdits(b.p, r.edits), f.v1)).toEqual(['0-70', '70-130']);
    // Now the two touch, so the same key rolls the cut it has made.
    const closed = applyEdits(b.p, r.edits);
    const roll = trimEdge(closed, [a.clip.id], 'end', 1, false);
    expect(layout(applyEdits(closed, roll.edits), f.v1)).toEqual(['0-71', '71-130']);
    // With nothing after it the edge stops where its media does: this file is ten seconds long.
    const media = applyEdits(f.p, [{ op: 'updateAsset', id: 'asset1', patch: { duration: 10 } }]);
    const last = add(media, f.v1, 0, 290);
    expect(trimEdge(last.p, [last.clip.id], 'end', 25, false).moved).toBe(10);
    expect(trimEdge(last.p, [last.clip.id], 'start', -5, false)).toMatchObject({ edits: [], moved: 0 });
  });

  it('rolls the picture and trims the sound where only the picture is at a cut', () => {
    const s = sequence();
    // The sound before the cut is gone: the selected pair's sound has a free head.
    const p0 = applyEdits(s.p, [{ op: 'removeClip', id: s.pairs[0].a.id }]);
    const ids = [s.pairs[1].v.id, s.pairs[1].a.id];
    const r = trimEdge(p0, ids, 'start', -5, false);
    const p = applyEdits(p0, r.edits);
    expect(layout(p, s.v1)).toEqual(['0-55', '55-120', '120-180']);
    expect(layout(p, s.a1)).toEqual(['55-120', '120-180']);
    expect(p.clips[ids[0]].sourceIn).toBeCloseTo(p.clips[ids[1]].sourceIn);
  });

  it('ripples under ripple editing: what follows moves, and the result says by how much', () => {
    const s = sequence();
    const ids = [s.pairs[0].v.id, s.pairs[0].a.id];
    const r = trimEdge(s.p, ids, 'end', -5, true);
    expect(r.moved).toBe(-5);
    const p = applyEdits(s.p, r.edits);
    for (const t of [s.v1, s.a1]) expect(layout(p, t)).toEqual(['0-55', '55-115', '115-175']);
    expect(r.spans).toEqual([{ from: 55, by: -5 }]);
    // A ripple that cannot move at all says why.
    const lone = trimEdge(s.p, [s.pairs[0].v.id], 'end', -5, true);
    expect(lone.edits).toEqual([]);
    expect(lone.refused).toMatch(/^Cannot ripple here/);
  });
});

describe('transitions on cuts', () => {
  it('goes on every cut of the selection, not before its first clip', () => {
    const s = sample();
    const all = [s.dusk.id, s.fractal.id, s.aurora.id, s.bed.id];
    expect(transitionTargets(s.p, all, 0)).toEqual([s.fractal.id, s.aurora.id]);
    // A selection without a cut gets the transition at its head, as one clip always did.
    expect(transitionTargets(s.p, [s.dusk.id], 300)).toEqual([s.dusk.id]);
    expect(transitionTargets(s.p, [s.title.id], 300)).toEqual([s.title.id]);
    expect(transitionTargets(lock(s.p, s.v1), all, 0)).toEqual([s.title.id]);
  });

  it('takes the cut nearest the playhead when no picture is selected: not a title, not frame 0', () => {
    const s = sample();
    // At 45 the title's start (18) is nearer than any cut, and frame 0 nearer than the cut at 120.
    expect(transitionTargets(s.p, [], 45)).toEqual([s.fractal.id]);
    expect(transitionTargets(s.p, [s.bed.id], 200)).toEqual([s.aurora.id]);
    const f = fixture();
    const only = add(f.p, f.v1, 30, 60);
    expect(transitionTargets(only.p, [], 0)).toEqual([only.clip.id]);
    expect(transitionTargets(f.p, [], 0)).toEqual([]);
  });

  it('fades the linked sound either side of the cut, keeping a longer fade', () => {
    const f = fixture();
    const v1 = add(f.p, f.v1, 0, 60, { linkId: 'A' });
    const a1 = add(v1.p, f.a1, 0, 60, { linkId: 'A', fadeOut: 12 });
    const v2 = add(a1.p, f.v1, 60, 60, { linkId: 'B' });
    const a2 = add(v2.p, f.a1, 60, 60, { linkId: 'B' });
    const v3 = add(a2.p, f.v1, 120, 60, { linkId: 'C' });
    const a3 = add(v3.p, f.a1, 120, 60, { linkId: 'C' });
    const edits = transitionEdits(a3.p, [v2.clip.id, v3.clip.id], 'in', makeTransition('crossDissolve', 18));
    const p = applyEdits(a3.p, edits);
    expect(p.clips[v2.clip.id].transIn).toMatchObject({ type: 'crossDissolve', duration: 18 });
    expect(p.clips[v3.clip.id].transIn?.duration).toBe(18);
    expect(p.clips[a1.clip.id]).toMatchObject({ fadeIn: 0, fadeOut: 12 });
    expect(p.clips[a2.clip.id]).toMatchObject({ fadeIn: CUT_FADE, fadeOut: CUT_FADE });
    expect(p.clips[a3.clip.id]).toMatchObject({ fadeIn: CUT_FADE, fadeOut: 0 });
  });

  it('leaves sound alone where its cut is elsewhere, on a locked track, or the clip is at no cut', () => {
    const f = fixture();
    const v1 = add(f.p, f.v1, 0, 60, { linkId: 'A' });
    const a1 = add(v1.p, f.a1, 0, 70, { linkId: 'A' });
    const v2 = add(a1.p, f.v1, 60, 60, { linkId: 'B' });
    const a2 = add(v2.p, f.a1, 70, 50, { linkId: 'B' });
    const t = makeTransition('crossDissolve', 18);
    // An L cut: the sound changes ten frames after the picture.
    expect(transitionEdits(a2.p, [v2.clip.id], 'in', t)).toHaveLength(1);
    expect(transitionEdits(a2.p, [v1.clip.id], 'in', t)).toHaveLength(1);
    const straight = applyEdits(a2.p, [
      { op: 'updateClip', id: a1.clip.id, patch: { duration: 60 } },
      { op: 'updateClip', id: a2.clip.id, patch: { start: 60, duration: 60 } },
    ]);
    expect(transitionEdits(straight, [v2.clip.id], 'in', t)).toHaveLength(3);
    expect(transitionEdits(straight, [v2.clip.id], 'out', t)).toHaveLength(1);
    expect(transitionEdits(lock(straight, f.a1), [v2.clip.id], 'in', t)).toHaveLength(1);
  });
});

describe('copied attributes', () => {
  const at30 = fixture();

  function copied() {
    const picture = makeClip('video', at30.v1.id, {
      scaleX: 1.3,
      scaleY: 1.3,
      x: 0.1,
      cropL: 0.2,
      effects: [makeEffect('filmGrain')],
      grade: { ...DEFAULT_GRADE, exposure: 0.5 },
    });
    const sound = makeClip('audio', at30.a1.id, { volume: -6, pan: 0.25, fadeIn: 15, fadeOut: 30 });
    return { picture, sound, both: copiedAttributes([sound, picture], 30)! };
  }

  it('takes the look of the first picture clip and the sound of the first audio clip', () => {
    const c = copied();
    expect(c.both.look).toMatchObject({ grade: { exposure: 0.5 }, transform: { scaleX: 1.3, cropL: 0.2 } });
    expect(c.both.sound).toEqual({ volume: -6, pan: 0.25, fadeIn: 15, fadeOut: 30 });
    expect(copiedAttributes([c.picture], 30)).toMatchObject({ fps: 30, sound: null });
    expect(copiedAttributes([c.sound], 30)).toMatchObject({ look: null });
    expect(copiedAttributes([], 30)).toBeNull();
  });

  it('pastes the grade alone and leaves a punch-in, a crop and the effects as they are', () => {
    const c = copied();
    const target = makeClip('video', at30.v1.id, { scaleX: 0.4, scaleY: 0.4, x: 0.3, cropL: 0.1 });
    expect(attributePatch(at30.p, target, c.both, 'grade')).toEqual({
      grade: { ...DEFAULT_GRADE, exposure: 0.5 },
    });
    const effects = attributePatch(at30.p, target, c.both, 'effects')!;
    expect(Object.keys(effects)).toEqual(['effects']);
    expect(effects.effects![0]).toMatchObject({ type: 'filmGrain' });
    expect(effects.effects![0].id).not.toBe(c.picture.effects[0].id);
    const transform = attributePatch(at30.p, target, c.both, 'transform')!;
    expect(transform).toMatchObject({ scaleX: 1.3, x: 0.1, cropL: 0.2 });
    expect(transform.grade).toBeUndefined();
    expect(transform.effects).toBeUndefined();
    const all = attributePatch(at30.p, target, c.both, 'all')!;
    expect(all).toMatchObject({ grade: { exposure: 0.5 }, scaleX: 1.3, cropL: 0.2 });
    expect(all.effects).toHaveLength(1);
    expect(all.volume).toBeUndefined();
  });

  it('pastes level, pan and fades onto sound, in the frames of the project pasted into', () => {
    const c = copied();
    const target = makeClip('audio', at30.a1.id, { duration: 40 });
    expect(attributePatch(at30.p, target, c.both, 'all')).toEqual({
      volume: -6,
      pan: 0.25,
      fadeIn: 15,
      fadeOut: 30,
    });
    const at60 = applyEdits(at30.p, [{ op: 'settings', patch: { fpsNum: 60, fpsDen: 1 } }]);
    // Half a second and a second of fade, in a clip that is only 40 frames long.
    expect(attributePatch(at60, target, c.both, 'sound')).toMatchObject({ fadeIn: 30, fadeOut: 40 });
  });

  it('has nothing for a clip of the other kind', () => {
    const c = copied();
    const picture = makeClip('video', at30.v1.id);
    const sound = makeClip('audio', at30.a1.id);
    expect(attributePatch(at30.p, sound, c.both, 'grade')).toBeNull();
    expect(attributePatch(at30.p, picture, c.both, 'sound')).toBeNull();
    expect(attributePatch(at30.p, picture, copiedAttributes([c.sound], 30)!, 'all')).toBeNull();
    expect(attributePatch(at30.p, sound, copiedAttributes([c.picture], 30)!, 'all')).toBeNull();
  });

  it('removes the keyframes a pasted value would otherwise be hidden behind, and no others', () => {
    const c = copied();
    const key = [{ t: 0, v: 1, e: 'linear' as const }];
    const target = makeClip('video', at30.v1.id, {
      effects: [{ ...makeEffect('filmGrain'), id: 'old' }],
      keyframes: { scaleX: key, opacity: key, 'fx:old:amount': key, volume: key },
    });
    expect(attributePatch(at30.p, target, c.both, 'grade')!.keyframes).toBeUndefined();
    expect(attributePatch(at30.p, target, c.both, 'transform')!.keyframes).toEqual({
      'fx:old:amount': key,
      volume: key,
    });
    expect(attributePatch(at30.p, target, c.both, 'effects')!.keyframes).toEqual({
      scaleX: key,
      opacity: key,
      volume: key,
    });
    const sound = makeClip('audio', at30.a1.id, { keyframes: { volume: key } });
    expect(attributePatch(at30.p, sound, c.both, 'sound')!.keyframes).toEqual({});
  });

  it('drops a LUT that is not in the project pasted into', () => {
    const c = copied();
    const withLut = { ...c.both, look: { ...c.both.look!, grade: { ...DEFAULT_GRADE, lutId: 'lut-x' } } };
    const target = makeClip('video', at30.v1.id);
    expect(attributePatch(at30.p, target, withLut, 'grade')!.grade).toMatchObject({ lutId: null });
  });
});

describe('markers under a ripple', () => {
  it('moves a frame with the time taken out before it, or put in at or before it', () => {
    const out = [{ from: 120, by: -120 }];
    expect([0, 119, 120, 121, 180, 239, 240, 250].map((f) => rippledFrame(f, out))).toEqual([
      0, 119, 120, 120, 120, 120, 120, 130,
    ]);
    const put = [{ from: 60, by: 30 }];
    expect([0, 59, 60, 61].map((f) => rippledFrame(f, put))).toEqual([0, 59, 90, 91]);
    // Each span counts in the frames the ones before it left behind.
    expect(
      rippledFrame(300, [
        { from: 200, by: -50 },
        { from: 10, by: -10 },
      ]),
    ).toBe(240);
    expect(rippledFrame(300, [])).toBe(300);
  });

  it('keeps a marker on its shot through a ripple delete, and parks one that was on the deleted shot', () => {
    const s = sample();
    const p0 = applyEdits(s.p, [
      marker('cut', 120),
      marker('on2', 150),
      marker('shot3', 240),
      marker('in3', 250),
    ]);
    const r = rippleDeleteClips(p0, [s.fractal.id]);
    expect(r.spans).toEqual([{ from: 120, by: -120 }]);
    const p = applyEdits(p0, [...r.edits, ...markerEdits(p0, r.edits, r.spans)]);
    expect(layout(p, s.v1)).toEqual(['0-120', '120-240']);
    expect(markerFrames(p)).toEqual({ cut: 120, on2: 120, shot3: 120, in3: 130 });
  });

  it('closes only the time picture and sound give up in common when a split edit is deleted', () => {
    const f = fixture();
    const before = add(f.p, f.v1, 0, 100);
    const v = add(before.p, f.v1, 100, 100, { linkId: 'L' });
    const a = add(v.p, f.a1, 80, 120, { linkId: 'L' });
    const after = add(a.p, f.v1, 200, 50);
    const r = rippleDeleteClips(after.p, [v.clip.id, a.clip.id]);
    expect(layout(applyEdits(after.p, r.edits), f.v1)).toEqual(['0-100', '100-150']);
    expect(r.spans).toEqual([{ from: 100, by: -100 }]);
  });

  it('gives two deleted clips two spans, the later one first', () => {
    const s = sample();
    const p0 = applyEdits(s.p, [marker('end', 360), marker('mid', 200)]);
    const r = rippleDeleteClips(p0, [s.dusk.id, s.aurora.id]);
    expect(r.spans).toEqual([
      { from: 240, by: -120 },
      { from: 0, by: -120 },
    ]);
    const p = applyEdits(p0, [...r.edits, ...markerEdits(p0, r.edits, r.spans)]);
    expect(layout(p, s.v1)).toEqual(['0-120']);
    expect(markerFrames(p)).toEqual({ end: 120, mid: 80 });
  });

  it('follows an insert, a trim of either edge and a refused ripple that moved nothing', () => {
    const s = sample();
    const p0 = applyEdits(s.p, [marker('start', 0), marker('shot3', 240)]);
    const room = openGapAt(p0, 0, 60);
    const inserted = applyEdits(p0, [...room.edits, ...markerEdits(p0, room.edits, room.spans)]);
    expect(layout(inserted, s.v1)).toEqual(['60-180', '180-300', '300-420']);
    expect(markerFrames(inserted)).toEqual({ start: 60, shot3: 300 });

    expect(trimSpans(p0, [s.fractal.id], 'end', -10)).toEqual([{ from: 230, by: -10 }]);
    expect(trimSpans(p0, [s.fractal.id], 'end', 10)).toEqual([{ from: 240, by: 10 }]);
    expect(trimSpans(p0, [s.fractal.id], 'start', 10)).toEqual([{ from: 120, by: -10 }]);
    expect(trimSpans(p0, [s.fractal.id], 'start', -10)).toEqual([{ from: 120, by: 10 }]);
    expect(trimSpans(p0, [s.fractal.id], 'end', 0)).toEqual([]);

    const f = fixture();
    const v = add(f.p, f.v1, 0, 100, { linkId: 'L' });
    const a = add(v.p, f.a1, 0, 100, { linkId: 'L' });
    const next = add(a.p, f.v1, 100, 50, { linkId: 'M' });
    const sound = add(next.p, f.a1, 100, 50, { linkId: 'M' });
    const refused = rippleDeleteClips(sound.p, [v.clip.id]);
    expect(refused.refused).toMatch(/^Cannot ripple here/);
    expect(refused.spans).toEqual([]);
    expect(markerEdits(p0, refused.edits, refused.spans)).toEqual([]);
  });

  it('leaves the markers on the shots alone when only the titles above them close up', () => {
    const s = sample();
    const later = add(s.p, s.v2, 300, 45);
    const p0 = applyEdits(later.p, [marker('cut', 120), marker('shot3', 240), marker('late', 310)]);
    const r = rippleDeleteClips(p0, [s.title.id]);
    const p = applyEdits(p0, [...r.edits, ...markerEdits(p0, r.edits, r.spans)]);
    // The second title moved up by the length of the first; no shot did.
    expect(layout(p, s.v2)).toEqual(['210-255']);
    expect(layout(p, s.v1)).toEqual(['0-120', '120-240', '240-360']);
    expect(markerFrames(p)).toEqual({ cut: 120, shot3: 240, late: 310 });
  });

  it('goes by the title or the sound where there is no picture below, and by time on empty frames', () => {
    const f = fixture();
    const first = add(f.p, f.v2, 0, 50);
    const second = add(first.p, f.v2, 100, 50);
    const sound = add(second.p, f.a1, 200, 50);
    const p0 = applyEdits(sound.p, [
      marker('gone', 20),
      marker('title', 110),
      marker('empty', 170),
      marker('sound', 210),
    ]);
    const r = rippleDeleteClips(p0, [first.clip.id]);
    const p = applyEdits(p0, [...r.edits, ...markerEdits(p0, r.edits, r.spans)]);
    expect(layout(p, f.v2)).toEqual(['50-100']);
    expect(layout(p, f.a1)).toEqual(['150-200']);
    expect(markerFrames(p)).toEqual({ gone: 0, title: 60, empty: 120, sound: 160 });
  });

  it('stays with a clip on a locked track, which a ripple never moves', () => {
    const s = sample();
    const p0 = lock(applyEdits(s.p, [marker('shot3', 300)]), s.v1);
    // With the picture locked only the music is cut: frames 100 to 160 are taken out of it.
    const r = rippleDeleteRange(p0, 100, 160);
    const p = applyEdits(p0, [...r.edits, ...markerEdits(p0, r.edits, r.spans)]);
    expect(layout(p, s.a1)).toEqual(['0-100', '100-300']);
    expect(markerFrames(p)).toEqual({ shot3: 300 });
  });

  it('never puts a marker before the start of the sequence, and writes no marker that stays', () => {
    const p = applyEdits(emptyProject(), [marker('a', 5)]);
    const moved = applyEdits(p, markerEdits(p, [], [{ from: -20, by: -10 }]));
    expect(markerFrames(moved)).toEqual({ a: 0 });
    expect(markerEdits(p, [], [{ from: 5, by: -50 }])).toEqual([]);
    expect(markerEdits(p, [], [])).toEqual([]);
  });
});
