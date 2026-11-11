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
  pasteable,
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
