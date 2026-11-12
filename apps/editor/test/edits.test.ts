import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  ASSET_DEFAULTS,
  clipEnd,
  emptyProject,
  makeClip,
  makeTrack,
  type Clip,
  type Project,
  type Track,
} from '@tandem/core';
import {
  clipsBeside,
  closeGapsAt,
  duplicateClips,
  markerBeside,
  matchFrameAt,
  pasteable,
  rippleDeleteRange,
  transitionTarget,
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
    expect(duplicateClips(f.p, ['nope'])).toEqual({ edits: [], created: [] });
  });
});

describe('closeGapsAt', () => {
  it('closes the gap under the frame and carries the other tracks along', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    const b = add(a.p, f.v1, 90, 30);
    const s = add(b.p, f.a1, 90, 30);
    const r = closeGapsAt(s.p, 50);
    expect(r.refused).toBeNull();
    const p = applyEdits(s.p, r.edits);
    expect(layout(p, f.v1)).toEqual(['0-30', '30-60']);
    expect(layout(p, f.a1)).toEqual(['30-60']);
  });

  it('reports nothing when there is no gap', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    expect(closeGapsAt(a.p, 10)).toEqual({ edits: [], refused: null });
    expect(closeGapsAt(a.p, 500)).toEqual({ edits: [], refused: null });
  });

  it('says why when the only gap cannot be closed', () => {
    const f = fixture();
    // The clip after the gap is linked to sound that has no room to follow.
    const a = add(f.p, f.v1, 0, 30);
    const v = add(a.p, f.v1, 90, 30, { linkId: 'L' });
    const blocker = add(v.p, f.a1, 0, 90);
    const s = add(blocker.p, f.a1, 90, 30, { linkId: 'L' });
    const r = closeGapsAt(s.p, 50);
    expect(r.edits).toEqual([]);
    expect(r.refused).toMatch(/^Cannot ripple here/);
  });

  it('skips locked tracks', () => {
    const f = fixture();
    const a = add(f.p, f.v1, 0, 30);
    const b = add(a.p, f.v1, 90, 30);
    const p0 = lock(b.p, f.v1);
    expect(closeGapsAt(p0, 50)).toEqual({ edits: [], refused: null });
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
    expect(rippleDeleteRange(a.p, 60, 60)).toEqual({ edits: [], refused: null });
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
