import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  ASSET_DEFAULTS,
  DEFAULT_GRADE,
  emptyProject,
  makeClip,
  makeEffect,
  makeTrack,
  makeTransition,
  type Asset,
  type Project,
} from '@tandem/core';
import { replaceEdits } from '../src/state/edits';

const asset = (id: string, init: Partial<Asset>): Asset => ({
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
