import { describe, expect, it } from 'vitest';
import {
  addAssetToTimeline,
  applyEdits,
  ASSET_DEFAULTS,
  clipEnd,
  emptyProject,
  makeClip,
  makeTrack,
  type Asset,
  type Project,
  type Track,
} from '@tandem/core';
import { picked, placeAssets, restOfDrop } from '../src/features/library/pool';
import { foldSpelling, search } from '../src/features/library/search';
import { tabToward } from '../src/features/editor/tabs';

const film = (id: string, seconds: number, sound = true): Asset => ({
  ...ASSET_DEFAULTS,
  id,
  name: `${id}.mp4`,
  kind: 'video',
  duration: seconds,
  hasVideo: true,
  hasAudio: sound,
});
const music: Asset = { ...ASSET_DEFAULTS, id: 'song', name: 'song.ogg', kind: 'audio', duration: 3 };
const still: Asset = { ...ASSET_DEFAULTS, id: 'still', name: 'still.png', kind: 'image' };
const lut: Asset = { ...ASSET_DEFAULTS, id: 'look', name: 'look.cube', kind: 'lut' };

interface Fixture {
  p: Project;
  v1: Track;
  a1: Track;
}

/** A 30 fps project with one video and one audio track and the files above in its pool. */
function fixture(): Fixture {
  const v1 = makeTrack('video', 0);
  const a1 = makeTrack('audio', 0);
  const p = applyEdits(emptyProject(), [
    { op: 'addTrack', track: v1 },
    { op: 'addTrack', track: a1 },
    ...[film('one', 2), film('two', 1), film('mute', 4, false), music, still, lut].map(
      (asset) => ({ op: 'addAsset', asset }) as const,
    ),
  ]);
  return { p, v1, a1 };
}

/** `name@start-end` of every clip on a track, in order. */
const lane = (p: Project, t: Track): string[] =>
  Object.values(p.clips)
    .filter((c) => c.trackId === t.id)
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.name}@${c.start}-${clipEnd(c)}`);

describe('selecting files in the media pool', () => {
  const shown = ['a', 'b', 'c', 'd', 'e'];

  it('selects the pressed file alone', () => {
    expect(picked(shown, ['a', 'b'], 'a', 'd', 'only')).toEqual(['d']);
  });

  it('adds a file with Ctrl and takes it out again, keeping the order of picking', () => {
    expect(picked(shown, ['d'], 'd', 'a', 'toggle')).toEqual(['d', 'a']);
    expect(picked(shown, ['d', 'a', 'c'], 'c', 'a', 'toggle')).toEqual(['d', 'c']);
  });

  it('takes every shown file from the anchor to the pressed one with Shift, in that direction', () => {
    expect(picked(shown, ['b'], 'b', 'd', 'range')).toEqual(['b', 'c', 'd']);
    expect(picked(shown, ['d'], 'd', 'b', 'range')).toEqual(['d', 'c', 'b']);
    // A second Shift press measures from the same anchor: the run is replaced, not added to.
    expect(picked(shown, ['b', 'c', 'd'], 'b', 'a', 'range')).toEqual(['b', 'a']);
  });

  it('starts a run at the pressed file when the anchor is not shown', () => {
    expect(picked(shown, [], null, 'c', 'range')).toEqual(['c']);
    expect(picked(shown, ['x'], 'x', 'c', 'range')).toEqual(['c']);
  });
});

describe('placing several files on the timeline', () => {
  it('lays them end to end from the frame, picture and sound on the tracks of the first', () => {
    const { p, v1, a1 } = fixture();
    const { one, two, mute } = p.assets;
    const r = placeAssets(p, [one, two, mute, p.assets.look], { frame: 10 });
    const after = applyEdits(p, r.edits);
    expect(lane(after, v1)).toEqual(['one.mp4@10-70', 'two.mp4@70-100', 'mute.mp4@100-220']);
    expect(lane(after, a1)).toEqual(['one.mp4@10-70', 'two.mp4@70-100']);
    expect(Object.keys(after.tracks)).toHaveLength(2);
    expect(r.created).toHaveLength(5);
    expect(r.spans).toEqual([]);
  });

  it('uses one new track for all of them where the first needed a new one', () => {
    const { p, v1, a1 } = fixture();
    const busy = applyEdits(p, [
      { op: 'addClip', clip: makeClip('video', v1.id, { assetId: 'one', start: 0, duration: 300 }) },
      { op: 'addClip', clip: makeClip('audio', a1.id, { assetId: 'one', start: 0, duration: 300 }) },
    ]);
    const r = placeAssets(busy, [busy.assets.one, busy.assets.two, busy.assets.song], { frame: 0 });
    const after = applyEdits(busy, r.edits);
    const made = Object.values(after.tracks).filter((t) => !busy.tracks[t.id]);
    expect(made.map((t) => t.kind).sort()).toEqual(['audio', 'video']);
    const [audio, video] = made.sort((a, b) => a.kind.localeCompare(b.kind));
    expect(lane(after, video)).toEqual(['one.mp4@0-60', 'two.mp4@60-90']);
    expect(lane(after, audio)).toEqual(['one.mp4@0-60', 'two.mp4@60-90', 'song.ogg@90-180']);
    // What was there is untouched.
    expect(lane(after, v1)).toEqual(['@0-300']);
  });

  it('replaces nothing: a track with room for the first file alone is not taken', () => {
    const { p, v1, a1 } = fixture();
    // The playhead stands before a clip with its sound: the first file fits in front of it, the
    // three together do not.
    const cut = applyEdits(p, [
      {
        op: 'addClip',
        clip: makeClip('video', v1.id, { name: 'there', assetId: 'one', start: 90, duration: 300 }),
      },
      {
        op: 'addClip',
        clip: makeClip('audio', a1.id, { name: 'there', assetId: 'one', start: 90, duration: 300 }),
      },
    ]);
    const r = placeAssets(cut, [cut.assets.one, cut.assets.two, cut.assets.mute], { frame: 0 });
    const after = applyEdits(cut, r.edits);
    // The pictures run on to frame 210 and take a new track together. The sounds end at 90,
    // where the clip that is there begins, and fit in front of it.
    expect(lane(after, v1)).toEqual(['there@90-390']);
    expect(lane(after, a1)).toEqual(['one.mp4@0-60', 'two.mp4@60-90', 'there@90-390']);
    const made = Object.values(after.tracks).filter((t) => !cut.tracks[t.id]);
    expect(made.map((t) => t.kind)).toEqual(['video']);
    expect(lane(after, made[0])).toEqual(['one.mp4@0-60', 'two.mp4@60-90', 'mute.mp4@90-210']);
    expect(r.edits.filter((e) => e.op !== 'addTrack' && e.op !== 'addClip')).toEqual([]);
  });

  it('takes the pictures and the sounds each to a track that is free for all of theirs', () => {
    const { p, v1, a1 } = fixture();
    // Something stands on the sound track where the second file would come; the picture track is clear.
    const cut = applyEdits(p, [
      {
        op: 'addClip',
        clip: makeClip('audio', a1.id, { name: 'music', assetId: 'song', start: 70, duration: 90 }),
      },
    ]);
    const r = placeAssets(cut, [cut.assets.one, cut.assets.two], { frame: 0 });
    const after = applyEdits(cut, r.edits);
    expect(lane(after, v1)).toEqual(['one.mp4@0-60', 'two.mp4@60-90']);
    expect(lane(after, a1)).toEqual(['music@70-160']);
    const made = Object.values(after.tracks).filter((t) => !cut.tracks[t.id]);
    expect(made.map((t) => t.kind)).toEqual(['audio']);
    expect(lane(after, made[0])).toEqual(['one.mp4@0-60', 'two.mp4@60-90']);
  });

  it('keeps to a named track that has the room, and leaves one that has not', () => {
    const { p, v1, a1 } = fixture();
    const v2 = makeTrack('video', 1);
    const two = applyEdits(p, [{ op: 'addTrack', track: v2 }]);
    const named = placeAssets(two, [two.assets.mute, two.assets.still], { frame: 0, videoTrackId: v2.id });
    expect(lane(applyEdits(two, named.edits), v2)).toEqual(['mute.mp4@0-120', 'still.png@120-270']);
    const busy = applyEdits(two, [
      {
        op: 'addClip',
        clip: makeClip('video', v2.id, { name: 'there', assetId: 'one', start: 200, duration: 30 }),
      },
    ]);
    const moved = placeAssets(busy, [busy.assets.mute, busy.assets.still], { frame: 0, videoTrackId: v2.id });
    const after = applyEdits(busy, moved.edits);
    expect(lane(after, v2)).toEqual(['there@200-230']);
    expect(lane(after, v1)).toEqual(['mute.mp4@0-120', 'still.png@120-270']);
    expect(lane(after, a1)).toEqual([]);
  });

  it('makes room for all of them together when they are inserted', () => {
    const { p, v1, a1 } = fixture();
    const cut = applyEdits(p, [
      {
        op: 'addClip',
        clip: makeClip('video', v1.id, { name: 'a', assetId: 'one', start: 0, duration: 40 }),
      },
      {
        op: 'addClip',
        clip: makeClip('video', v1.id, { name: 'b', assetId: 'one', start: 40, duration: 40 }),
      },
    ]);
    const r = placeAssets(
      cut,
      [cut.assets.two, cut.assets.still],
      { frame: 40, videoTrackId: v1.id, audioTrackId: a1.id },
      true,
    );
    const after = applyEdits(cut, r.edits);
    // One second of film and a five-second still: 180 frames go in at frame 40.
    expect(lane(after, v1)).toEqual(['a@0-40', 'two.mp4@40-70', 'still.png@70-220', 'b@220-260']);
    expect(r.spans).toEqual([{ from: 40, by: 180 }]);
  });

  it('places nothing and makes no room when there is nothing to place', () => {
    const { p } = fixture();
    expect(placeAssets(p, [p.assets.look], { frame: 0 }, true)).toEqual({
      edits: [],
      created: [],
      spans: [],
    });
  });
});

describe('the rest of a selection dragged to the timeline', () => {
  it('follows the file the drop placed, on its tracks', () => {
    const { p, v1, a1 } = fixture();
    const first = addAssetToTimeline(p, p.assets.one, {
      frame: 30,
      videoTrackId: v1.id,
      audioTrackId: a1.id,
    });
    const dropped = applyEdits(p, first.edits);
    const rest = restOfDrop(p, dropped, 'one', [p.assets.two, p.assets.song], false);
    const after = applyEdits(dropped, rest!.edits);
    expect(lane(after, v1)).toEqual(['one.mp4@30-90', 'two.mp4@90-120']);
    expect(lane(after, a1)).toEqual(['one.mp4@30-90', 'two.mp4@90-120', 'song.ogg@120-210']);
    expect(rest!.dropped.sort()).toEqual([...first.created].sort());
  });

  it('replaces nothing with the files that follow', () => {
    const { p, v1, a1 } = fixture();
    // The sound of the first file went to a track that was free for its length; further along
    // that track there is music, where the sound of the second would come.
    const cut = applyEdits(p, [
      {
        op: 'addClip',
        clip: makeClip('audio', a1.id, { name: 'music', assetId: 'song', start: 100, duration: 90 }),
      },
    ]);
    const first = addAssetToTimeline(cut, cut.assets.one, { frame: 30, videoTrackId: v1.id });
    const dropped = applyEdits(cut, first.edits);
    expect(lane(dropped, a1)).toEqual(['one.mp4@30-90', 'music@100-190']);
    const rest = restOfDrop(cut, dropped, 'one', [cut.assets.two, cut.assets.mute], false);
    const after = applyEdits(dropped, rest!.edits);
    expect(lane(after, v1)).toEqual(['one.mp4@30-90', 'two.mp4@90-120', 'mute.mp4@120-240']);
    expect(lane(after, a1)).toEqual(['one.mp4@30-90', 'music@100-190']);
    const made = Object.values(after.tracks).filter((t) => !cut.tracks[t.id]);
    expect(made.map((t) => t.kind)).toEqual(['audio']);
    expect(lane(after, made[0])).toEqual(['two.mp4@90-120']);
  });

  it('is nothing when the drop made no clip of that file', () => {
    const { p, v1 } = fixture();
    expect(restOfDrop(p, p, 'one', [p.assets.two], false)).toBeNull();
    // A clip of the file that was there before the drop is not what the drop made.
    const had = applyEdits(p, [
      { op: 'addClip', clip: makeClip('video', v1.id, { assetId: 'one', start: 0, duration: 10 }) },
    ]);
    expect(restOfDrop(had, had, 'one', [p.assets.two], false)).toBeNull();
  });
});

describe('searching the library in either spelling', () => {
  const items = [
    { name: 'Colour Overlay', description: 'Tints the picture.' },
    { name: 'Posterise', description: 'Fewer levels per channel.' },
    { name: 'Vignette', description: 'Darkens away from the centre.' },
    { name: 'Black & White', description: 'Greyscale, with a tint.' },
  ];
  const names = (query: string): string[] => search(items, query).map((i) => i.name);

  it('finds British names by their American spelling, and the other way round', () => {
    expect(names('color')).toEqual(['Colour Overlay']);
    expect(names('colour')).toEqual(['Colour Overlay']);
    expect(names('posterize')).toEqual(['Posterise']);
    expect(names('Posterise')).toEqual(['Posterise']);
    expect(names('center')).toEqual(['Vignette']);
    expect(names('grayscale')).toEqual(['Black & White']);
  });

  it('keeps finding while a word is half typed', () => {
    expect(names('colou')).toEqual(['Colour Overlay']);
    expect(names('posteri')).toEqual(['Posterise']);
    expect(names('posteriz')).toEqual(['Posterise']);
    expect(names('cente')).toEqual(['Vignette']);
  });

  it('returns everything for an empty query and nothing for a stranger', () => {
    expect(names('  ')).toHaveLength(4);
    expect(names('sepia')).toEqual([]);
  });

  it('folds both spellings to one', () => {
    expect(foldSpelling('colourise the centre in grey')).toBe(foldSpelling('colorize the center in gray'));
  });
});

describe('arrow keys in a row of tabs', () => {
  it('steps round the ends and jumps to the first and last', () => {
    expect(tabToward(0, 4, 'ArrowRight')).toBe(1);
    expect(tabToward(3, 4, 'ArrowRight')).toBe(0);
    expect(tabToward(0, 4, 'ArrowLeft')).toBe(3);
    expect(tabToward(2, 4, 'Home')).toBe(0);
    expect(tabToward(2, 4, 'End')).toBe(3);
  });

  it('leaves every other key, and a key pressed outside the tabs, alone', () => {
    expect(tabToward(1, 4, 'ArrowDown')).toBeUndefined();
    expect(tabToward(1, 4, 'a')).toBeUndefined();
    expect(tabToward(-1, 4, 'ArrowRight')).toBeUndefined();
  });
});
