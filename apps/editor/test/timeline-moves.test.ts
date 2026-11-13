import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  ASSET_DEFAULTS,
  emptyProject,
  makeClip,
  makeTrack,
  overlappingClips,
  sequenceEnd,
  type Clip,
  type Placement,
  type Project,
  type Track,
} from '@tandem/core';
import { markerEdits } from '../src/state/edits';
import { insertMove } from '../src/features/timeline/moves';

interface Cut {
  p: Project;
  v1: Track;
  v2: Track;
  a1: Track;
  a2: Track;
  /** Three shots on V1 with their sound on A1: 0-120, 120-240 and 240-390. */
  shots: { picture: Clip; sound: Clip }[];
}

function cut(): Cut {
  const v1 = makeTrack('video', 0);
  const v2 = makeTrack('video', 1);
  const a1 = makeTrack('audio', 0);
  const a2 = makeTrack('audio', 1);
  let p = applyEdits(emptyProject(), [
    ...[v1, v2, a1, a2].map((track) => ({ op: 'addTrack', track }) as const),
    { op: 'addAsset', asset: { ...ASSET_DEFAULTS, id: 'asset1', name: 'clip.mp4', kind: 'video', duration: 60 } },
  ]);
  const shots = [
    [0, 120],
    [120, 120],
    [240, 150],
  ].map(([start, duration], i) => {
    const linkId = `link${i}`;
    const picture = makeClip('video', v1.id, { assetId: 'asset1', start, duration, linkId });
    const sound = makeClip('audio', a1.id, { assetId: 'asset1', start, duration, linkId });
    p = applyEdits(p, [
      { op: 'addClip', clip: picture },
      { op: 'addClip', clip: sound },
    ]);
    return { picture, sound };
  });
  return { p, v1, v2, a1, a2, shots };
}

const on = (p: Project, t: Track): string[] =>
  Object.values(p.clips)
    .filter((c) => c.trackId === t.id)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.start}+${c.duration}`);

/** The placements a drag of `clips` by `delta` frames asks for, each clip staying on its track. */
const dragged = (clips: Clip[], delta: number): Placement[] =>
  clips.map((c) => ({ id: c.id, start: c.start + delta, trackId: c.trackId }));

describe('a move that inserts', () => {
  it('puts the third shot before the first and pushes the others along, sound with picture', () => {
    const f = cut();
    const third = f.shots[2];
    const r = insertMove(f.p, dragged([third.picture, third.sound], -235));
    expect(r.refused).toBeNull();
    expect(r.at).toBe(0);
    const after = applyEdits(f.p, r.edits);
    expect(on(after, f.v1)).toEqual(['0+150', '150+120', '270+120']);
    expect(on(after, f.a1)).toEqual(['0+150', '150+120', '270+120']);
    expect(after.clips[third.picture.id].start).toBe(0);
    expect(after.clips[f.shots[0].picture.id].start).toBe(150);
    // Nothing is cut, nothing lies on anything else, and the sequence is as long as it was.
    expect(Object.keys(after.clips)).toHaveLength(6);
    expect(overlappingClips(after).size).toBe(0);
    expect(sequenceEnd(after)).toBe(sequenceEnd(f.p));
    expect(r.edits.every((e) => e.op === 'updateClip')).toBe(true);
  });

  it('goes to the cut nearest to where the clips were dragged, also later in the sequence', () => {
    const f = cut();
    const first = f.shots[0];
    const clips = [first.picture, first.sound];
    // Dragged a little: the nearest cut is the one the shot already stands at, and nothing moves.
    expect(insertMove(f.p, dragged(clips, 50)).edits).toEqual([]);
    // Dragged past the middle of the second shot: it lands after that shot.
    const r = insertMove(f.p, dragged(clips, 70));
    expect(r.at).toBe(120);
    const after = applyEdits(f.p, r.edits);
    expect(after.clips[f.shots[1].picture.id].start).toBe(0);
    expect(after.clips[first.picture.id].start).toBe(120);
    expect(after.clips[f.shots[2].picture.id].start).toBe(240);
    expect(on(after, f.a1)).toEqual(on(after, f.v1));
    // Dragged far past the end: it becomes the last shot, right after the others.
    const last = applyEdits(f.p, insertMove(f.p, dragged(clips, 900)).edits);
    expect(on(last, f.v1)).toEqual(['0+120', '120+150', '270+120']);
    expect(last.clips[first.picture.id].start).toBe(270);
  });

  it('leaves a title above and a music bed below where they are', () => {
    const f = cut();
    const title = makeClip('text', f.v2.id, { start: 250, duration: 60 });
    const bed = makeClip('audio', f.a2.id, { assetId: 'asset1', start: 0, duration: 390 });
    const p = applyEdits(f.p, [
      { op: 'addClip', clip: title },
      { op: 'addClip', clip: bed },
    ]);
    const third = f.shots[2];
    const r = insertMove(p, dragged([third.picture, third.sound], -240));
    const after = applyEdits(p, r.edits);
    expect(on(after, f.v1)).toEqual(['0+150', '150+120', '270+120']);
    expect(after.clips[title.id]).toEqual(title);
    expect(after.clips[bed.id]).toEqual(bed);
  });

  it('takes a clip to another track and keeps both tracks in step', () => {
    const f = cut();
    const third = f.shots[2];
    const placements: Placement[] = [
      { id: third.picture.id, start: 0, trackId: f.v2.id },
      { id: third.sound.id, start: 0, trackId: f.a1.id },
    ];
    const after = applyEdits(f.p, insertMove(f.p, placements).edits);
    expect(on(after, f.v2)).toEqual(['0+150']);
    expect(on(after, f.v1)).toEqual(['150+120', '270+120']);
    expect(on(after, f.a1)).toEqual(['0+150', '150+120', '270+120']);
  });

  it('is refused when a clip that is not being moved lies alongside, and when a track is locked', () => {
    const f = cut();
    const third = f.shots[2];
    // The picture alone: its own sound would be left where the others have to close up.
    const alone = insertMove(f.p, dragged([third.picture], -240));
    expect(alone.edits).toEqual([]);
    expect(alone.refused).toMatch(/^A clip on A1 lies alongside/);
    const locked = applyEdits(f.p, [{ op: 'updateTrack', id: f.a1.id, patch: { locked: true } }]);
    const unlinked = applyEdits(locked, [
      { op: 'updateClip', id: third.picture.id, patch: { linkId: null } },
      { op: 'updateClip', id: third.sound.id, patch: { linkId: null } },
    ]);
    // The other shots are linked to sound on the locked track, which would have to shift with them.
    const r = insertMove(unlinked, dragged([third.picture], -240));
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Unlock A1 to insert here: its clips have to move too.');
  });

  it('does not put the clips in the middle of a clip on a linked track', () => {
    const f = cut();
    // A split edit: the sound of the second shot begins 20 frames before its picture.
    const p = applyEdits(f.p, [
      { op: 'updateClip', id: f.shots[0].sound.id, patch: { duration: 100 } },
      { op: 'updateClip', id: f.shots[1].sound.id, patch: { start: 100, duration: 140 } },
    ]);
    const third = f.shots[2];
    const r = insertMove(p, dragged([third.picture, third.sound], -130));
    // Frames 100 and 120 are each a cut on one track and inside a clip on the other.
    expect(r.at).toBe(0);
    const after = applyEdits(p, r.edits);
    expect(overlappingClips(after).size).toBe(0);
    expect(on(after, f.a1)).toEqual(['0+150', '150+100', '250+140']);
  });

  it('says what it did to time, so that markers stay on their shots', () => {
    const f = cut();
    const p = applyEdits(f.p, [
      { op: 'setMarker', marker: { id: 'm1', frame: 30, name: 'On the first', color: '#fff', note: '' } },
      { op: 'setMarker', marker: { id: 'm3', frame: 300, name: 'On the third', color: '#fff', note: '' } },
    ]);
    const third = f.shots[2];
    const r = insertMove(p, dragged([third.picture, third.sound], -240));
    expect(r.spans).toEqual([
      { from: 240, by: -150 },
      { from: 0, by: 150 },
    ]);
    const after = applyEdits(p, [...r.edits, ...markerEdits(p, r.edits, r.spans)]);
    expect(after.markers.m1.frame).toBe(180);
    expect(after.markers.m3.frame).toBe(60);
  });
});
