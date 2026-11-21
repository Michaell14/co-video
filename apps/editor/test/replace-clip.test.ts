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
  mediaToStream,
  rampTable,
  setRamp,
  shapeRamp,
  shiftRamp,
  sourceTimeAt,
  type Asset,
  type Clip,
  type Project,
  type RampShape,
} from '@tandem/core';
import { replaceEdits } from '../src/state/edits';

const asset = (id: string, init: Partial<Asset> & Pick<Asset, 'kind'>): Asset => ({
  ...ASSET_DEFAULTS,
  id,
  name: `${id}.mp4`,
  ...init,
});

/** A graded, zoomed, animated shot of take1 on V1 (frames 100-220) with its sound on A1, at 30 fps. */
function project(): Project {
  const key = (t: number, v: number) => ({ t, v, e: 'easeInOut' as const });
  return applyEdits(emptyProject(), [
    { op: 'addTrack', track: { ...makeTrack('video', 0), id: 'v1' } },
    { op: 'addTrack', track: { ...makeTrack('audio', 0), id: 'a1' } },
    {
      op: 'addAsset',
      asset: asset('take1', { kind: 'video', duration: 10, hasVideo: true, hasAudio: true }),
    },
    { op: 'addAsset', asset: asset('take2', { kind: 'video', duration: 8, hasVideo: true, hasAudio: true }) },
    { op: 'addAsset', asset: asset('short', { kind: 'video', duration: 2, hasVideo: true, hasAudio: true }) },
    { op: 'addAsset', asset: asset('mute', { kind: 'video', duration: 8, hasVideo: true, hasAudio: false }) },
    {
      op: 'addAsset',
      asset: asset('still', { kind: 'image', duration: 0, hasVideo: true, hasAudio: false }),
    },
    {
      op: 'addAsset',
      asset: asset('song', { kind: 'audio', duration: 30, hasVideo: false, hasAudio: true }),
    },
    {
      op: 'addClip',
      clip: makeClip('video', 'v1', {
        id: 'shot',
        assetId: 'take1',
        name: 'take1.mp4',
        start: 100,
        duration: 120,
        sourceIn: 2,
        linkId: 'sync',
        scaleX: 1.2,
        scaleY: 1.2,
        grade: { ...DEFAULT_GRADE, enabled: true },
        effects: [makeEffect('filmGrain')],
        keyframes: { opacity: [key(0, 0), key(30, 1)] },
        transIn: makeTransition('dipToBlack', 20),
        transOut: makeTransition('crossZoom', 90),
      }),
    },
    {
      op: 'addClip',
      clip: makeClip('audio', 'a1', {
        id: 'sound',
        assetId: 'take1',
        name: 'take1.mp4',
        start: 100,
        duration: 120,
        sourceIn: 2,
        linkId: 'sync',
        volume: -6,
        fadeOut: 100,
      }),
    },
  ]);
}

describe('replacing the media of a clip', () => {
  it('keeps the place, the length and everything done to the clip, and takes the sound along', () => {
    const p = project();
    const r = replaceEdits(p, 'shot', p.assets.take2);
    expect(r).toMatchObject({ shortened: false, refused: null });
    const after = applyEdits(p, r.edits);
    const { shot, sound } = after.clips;
    expect(shot).toEqual({ ...p.clips.shot, assetId: 'take2', name: 'take2.mp4', sourceIn: 0 });
    expect(sound).toEqual({ ...p.clips.sound, assetId: 'take2', name: 'take2.mp4', sourceIn: 0 });
  });

  it('starts where it is told to, the sound keeping its offset from the picture, and keeps a given name', () => {
    const base = project();
    // A split edit: the sound begins half a second of media before the picture.
    const p = applyEdits(base, [
      { op: 'updateClip', id: 'sound', patch: { start: 85, duration: 135, sourceIn: 1.5 } },
      { op: 'updateClip', id: 'shot', patch: { name: 'The wide shot' } },
    ]);
    const after = applyEdits(p, replaceEdits(p, 'shot', p.assets.take2, 3).edits);
    expect(after.clips.shot).toMatchObject({
      assetId: 'take2',
      sourceIn: 3,
      name: 'The wide shot',
      start: 100,
    });
    expect(after.clips.sound).toMatchObject({ assetId: 'take2', sourceIn: 2.5, start: 85, duration: 135 });
  });

  it('ends the clip where shorter media ends, and brings fades and transitions inside it', () => {
    const p = project();
    const r = replaceEdits(p, 'shot', p.assets.short);
    expect(r.shortened).toBe(true);
    const after = applyEdits(p, r.edits);
    // Two seconds of media at 30 fps.
    expect(after.clips.shot).toMatchObject({ start: 100, duration: 60, scaleX: 1.2 });
    expect(after.clips.shot.transIn?.duration).toBe(20);
    expect(after.clips.shot.transOut?.duration).toBe(60);
    expect(after.clips.sound).toMatchObject({ start: 100, duration: 60, fadeOut: 60, volume: -6 });
    // At half speed the same media lasts twice as long.
    const slow = applyEdits(p, [{ op: 'updateClip', id: 'shot', patch: { speed: 0.5 } }]);
    expect(applyEdits(slow, replaceEdits(slow, 'shot', slow.assets.short).edits).clips.shot.duration).toBe(
      120,
    );
  });

  it('removes the sound of a picture whose new file has none, and unlinks what is left', () => {
    const p = project();
    const after = applyEdits(p, replaceEdits(p, 'shot', p.assets.mute).edits);
    expect(after.clips.sound).toBeUndefined();
    expect(after.clips.shot).toMatchObject({ assetId: 'mute', linkId: null });
  });

  it('replaces sound alone when the sound clip is what is replaced', () => {
    const p = project();
    const after = applyEdits(p, replaceEdits(p, 'sound', p.assets.song).edits);
    expect(after.clips.sound).toMatchObject({
      assetId: 'song',
      name: 'song.mp4',
      linkId: 'sync',
      volume: -6,
    });
    expect(after.clips.shot).toEqual(p.clips.shot);
  });

  it('is refused for a file of another kind', () => {
    const p = project();
    expect(replaceEdits(p, 'shot', p.assets.still)).toEqual({
      edits: [],
      shortened: false,
      refused: 'A video clip can only be replaced by a video file.',
    });
    expect(replaceEdits(p, 'shot', p.assets.song).refused).toBe(
      'A video clip can only be replaced by a video file.',
    );
    expect(replaceEdits(p, 'sound', p.assets.mute).refused).toBe(
      'A sound clip can only be replaced by a file that has sound.',
    );
    expect(replaceEdits(p, 'nothing', p.assets.take2)).toEqual({
      edits: [],
      shortened: false,
      refused: null,
    });
  });
});

describe('replacing the media of a clip that is on a speed ramp', () => {
  /** The shot and its sound of `project()` on a shape, laid over the four seconds they play. */
  function ramped(shape: RampShape, init: (p: Project) => Project = (p) => p): Project {
    const p = init(project());
    return applyEdits(p, setRamp(p, ['shot'], { ramps: { shot: shapeRamp(shape, 2, 6, false) } }));
  }

  /** How far the media a clip shows moved, in seconds, over every frame of it and a second either side. */
  function shifts(before: Project, after: Project, id: string): number[] {
    const was = before.clips[id];
    const now = after.clips[id];
    const out: number[] = [];
    for (let u = -30; u < was.duration + 30; u++) {
      out.push(sourceTimeAt(now, u, after) - sourceTimeAt(was, u, before));
    }
    return out;
  }

  /** The most two clips are apart, in seconds of their media, on the frames they share. */
  function apart(p: Project, a: Clip, b: Clip): number {
    let most = 0;
    for (let f = Math.max(a.start, b.start); f < Math.min(clipEnd(a), clipEnd(b)); f++) {
      most = Math.max(most, Math.abs(sourceTimeAt(a, f - a.start, p) - sourceTimeAt(b, f - b.start, p)));
    }
    return most;
  }

  it('keeps the shape of the ramp, moved to where the clip begins in the new file, for the sound as well', () => {
    const p = ramped('hero');
    expect(p.clips.shot.duration).toBe(121);
    const r = replaceEdits(p, 'shot', p.assets.take2);
    expect(r).toMatchObject({ shortened: false, refused: null });
    const after = applyEdits(p, r.edits);
    const ramp = shiftRamp(p.clips.shot.ramp!, -2);
    expect(ramp[0]).toEqual({ m: 0, v: 1 });
    for (const id of ['shot', 'sound']) {
      expect(after.clips[id]).toEqual({
        ...p.clips[id],
        assetId: 'take2',
        name: 'take2.mp4',
        sourceIn: 0,
        ramp,
      });
      // Every frame shows the place two seconds earlier in its file than it showed, handles included.
      for (const by of shifts(p, after, id)) expect(by).toBeCloseTo(-2, 9);
    }
    expect(apart(after, after.clips.shot, after.clips.sound)).toBeLessThan(1e-9);
  });

  it('keeps a split edit in step, from an in point that is on no microsecond', () => {
    // The sound begins 15 frames before its picture, and the ramp has brought it forward.
    const p = ramped('bullet', (base) =>
      applyEdits(base, [
        { op: 'updateClip', id: 'sound', patch: { start: 85, duration: 135, sourceIn: 1.5 } },
      ]),
    );
    expect(p.clips.sound).toMatchObject({ start: 97, duration: 30 });
    expect(apart(p, p.clips.shot, p.clips.sound)).toBeLessThan(1e-9);
    const after = applyEdits(p, replaceEdits(p, 'shot', p.assets.take2, 4 / 3).edits);
    // The ramp stands on whole microseconds, and the in point goes with it: one and a third
    // seconds, to the microsecond.
    expect(after.clips.shot.sourceIn).toBeCloseTo(4 / 3, 6);
    expect(after.clips.shot.sourceIn).toBe(2 + -0.666667);
    expect(after.clips.shot.ramp).toEqual(shiftRamp(p.clips.shot.ramp!, -0.666667));
    expect(after.clips.sound.ramp).toEqual(after.clips.shot.ramp);
    for (const id of ['shot', 'sound']) {
      for (const by of shifts(p, after, id)) expect(by).toBeCloseTo(-0.666667, 9);
    }
    expect(apart(after, after.clips.shot, after.clips.sound)).toBeLessThan(1e-9);
    // Another shape set afterwards still finds the two in step, and keeps them so.
    const again = applyEdits(
      after,
      setRamp(after, ['shot'], { ramps: { shot: shapeRamp('rampDown', 4 / 3, 4 + 4 / 3, false) } }),
    );
    expect(again.clips.sound.start).not.toBe(after.clips.sound.start);
    expect(apart(again, again.clips.shot, again.clips.sound)).toBeLessThan(1e-9);
  });

  it('ends the clip where shorter media ends under the ramp', () => {
    const p = ramped('rampUp');
    expect(p.clips.shot.duration).toBe(96);
    const r = replaceEdits(p, 'shot', p.assets.short);
    expect(r.shortened).toBe(true);
    const after = applyEdits(p, r.edits);
    // Ramp up begins at half the speed: the two seconds there are take 2.12 s, 63 whole frames.
    const table = rampTable(after.clips.shot.ramp!);
    const frames = Math.floor((mediaToStream(table, 2) - mediaToStream(table, 0)) * 30 + 1e-6);
    expect(frames).toBe(63);
    expect(after.clips.shot).toMatchObject({ start: 100, duration: 63, sourceIn: 0 });
    expect(after.clips.shot.transOut?.duration).toBe(63);
    expect(after.clips.sound).toMatchObject({ start: 100, duration: 63, fadeOut: 63 });
    // The last frame ends inside the file, and one more would run past the end of it.
    expect(sourceTimeAt(after.clips.shot, 63, after)).toBeLessThan(2);
    expect(sourceTimeAt(after.clips.shot, 64, after)).toBeGreaterThan(2);
  });

  it('leaves the ramp where it is when the new file is played from the same place', () => {
    const p = ramped('flashOut');
    const after = applyEdits(p, replaceEdits(p, 'shot', p.assets.take2, 2).edits);
    expect(after.clips.shot.ramp).toBe(p.clips.shot.ramp);
    expect(after.clips.shot).toEqual({ ...p.clips.shot, assetId: 'take2', name: 'take2.mp4' });
  });
});
