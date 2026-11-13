import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  makeClip,
  makeTrack,
  overlappingClips,
  overlappingPairs,
  separateClips,
  tracksOf,
} from '../src';
import type { Clip, Edit, Project } from '../src';
import { fixture, overlaps } from './helpers';

/** The fixture's project with these clips on it, placed as they are, whatever is under them. */
function withClips(p: Project, clips: Clip[]): Project {
  return applyEdits(
    p,
    clips.map((clip): Edit => ({ op: 'addClip', clip })),
  );
}

describe('clips that share frames on a track', () => {
  it('are found pair by pair', () => {
    const f = fixture();
    const a = makeClip('video', f.v1.id, { id: 'a', start: 0, duration: 100 });
    const b = makeClip('video', f.v1.id, { id: 'b', start: 50, duration: 100 });
    const c = makeClip('video', f.v1.id, { id: 'c', start: 90, duration: 20 });
    const d = makeClip('video', f.v1.id, { id: 'd', start: 150, duration: 50 });
    const e = makeClip('video', f.v2.id, { id: 'e', start: 0, duration: 500 });
    const p = withClips(f.p, [a, b, c, d, e]);
    expect(overlappingPairs(p).map(([x, y]) => x.id + y.id)).toEqual(['ab', 'ac', 'bc']);
    expect(overlappingClips(p)).toEqual(new Set(['a', 'b', 'c']));

    // Clips that only touch do not share a frame.
    const touching = withClips(f.p, [a, { ...d, start: 100 }]);
    expect(overlappingPairs(touching)).toEqual([]);
    expect(overlappingClips(f.p).size).toBe(0);
  });

  it('are moved apart: picture to a free track above, each clip staying where it is in time', () => {
    const f = fixture();
    const under = makeClip('video', f.v1.id, { id: 'under', start: 0, duration: 100 });
    const over = makeClip('video', f.v1.id, { id: 'over', start: 50, duration: 100 });
    const p = withClips(f.p, [under, over]);
    const edits = separateClips(p, ['over']);
    expect(edits).toEqual([{ op: 'updateClip', id: 'over', patch: { trackId: f.v2.id } }]);
    const q = applyEdits(p, edits);
    expect(overlaps(q)).toEqual([]);
    expect(q.clips.over).toEqual({ ...over, trackId: f.v2.id });
    expect(q.clips.under).toBe(p.clips.under);

    // Asked for both, the one that starts first stays.
    expect(separateClips(p, ['over', 'under'])).toEqual(edits);
    // A clip that shares frames with nothing is left alone, and so is one that is not there.
    expect(separateClips(q, ['over', 'under', 'nobody'])).toEqual([]);
  });

  it('never puts picture under the clip it gave way to, nor anything on a locked track', () => {
    const f = fixture();
    const top = makeClip('video', f.v2.id, { id: 'top', start: 0, duration: 100 });
    const also = makeClip('video', f.v2.id, { id: 'also', start: 20, duration: 30 });
    const p = withClips(f.p, [top, also]);
    // V1 below is free, but a clip moved there would be covered by the one that stays.
    const edits = separateClips(p, ['also']);
    expect(edits.map((e) => e.op)).toEqual(['addTrack', 'updateClip']);
    const q = applyEdits(p, edits);
    const video = tracksOf(q).video;
    expect(video).toHaveLength(3);
    expect(q.clips.also.trackId).toBe(video[2].id);
    expect(overlaps(q)).toEqual([]);

    const locked = applyEdits(
      withClips(f.p, [
        { ...top, trackId: f.v1.id },
        { ...also, trackId: f.v1.id },
      ]),
      [{ op: 'updateTrack', id: f.v2.id, patch: { locked: true } }],
    );
    const moved = applyEdits(locked, separateClips(locked, ['also']));
    expect(tracksOf(moved).video).toHaveLength(3);
    expect(moved.clips.also.trackId).toBe(tracksOf(moved).video[2].id);
  });

  it('gives sound any free audio track, and several clips one new track when they fit on it', () => {
    const f = fixture();
    const a2 = makeTrack('audio', 1);
    const base = applyEdits(f.p, [{ op: 'addTrack', track: a2 }]);
    const stays = makeClip('audio', a2.id, { id: 'stays', start: 0, duration: 300 });
    const one = makeClip('audio', a2.id, { id: 'one', start: 10, duration: 50 });
    const two = makeClip('audio', a2.id, { id: 'two', start: 100, duration: 50 });
    const p = withClips(base, [stays, one, two]);
    // A1 is above A2 in the list and free: both go there.
    const q = applyEdits(p, separateClips(p, ['one', 'two']));
    expect([q.clips.one.trackId, q.clips.two.trackId]).toEqual([f.a1.id, f.a1.id]);
    expect(overlaps(q)).toEqual([]);

    // With A1 taken as well, one new track holds both.
    const full = withClips(p, [makeClip('audio', f.a1.id, { id: 'full', start: 0, duration: 300 })]);
    const edits = separateClips(full, ['two', 'one']);
    expect(edits.map((e) => e.op)).toEqual(['addTrack', 'updateClip', 'updateClip']);
    const r = applyEdits(full, edits);
    const audio = tracksOf(r).audio;
    expect(audio).toHaveLength(3);
    expect([r.clips.one.trackId, r.clips.two.trackId]).toEqual([audio[2].id, audio[2].id]);
    expect(overlaps(r)).toEqual([]);
  });
});
