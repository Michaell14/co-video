import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEdits,
  ASSET_DEFAULTS,
  emptyProject,
  makeClip,
  makeTrack,
  secondsToFrame,
  type Asset,
  type Clip,
  type Project,
} from '@tandem/core';
import {
  clipMarks,
  markedRange,
  marksOfKnown,
  rememberSource,
  resumeAt,
  UNMARKED,
  withIn,
  withOut,
} from '../src/features/viewer/sourceMarks';
import { COMMANDS } from '../src/state/shortcuts';
import { useUI } from '../src/state/ui';

describe('marking a source', () => {
  it('sets the in point and keeps an out point that still follows it', () => {
    const marked = withIn({ in: 0, out: 6, at: 2 }, 3, 10);
    expect(marked).toEqual({ in: 3, out: 6, at: 2 });
  });

  it('lets go of an out point that an in point has reached or passed', () => {
    expect(withIn({ in: 0, out: 6, at: null }, 6, 10).out).toBeNull();
    expect(withIn({ in: 0, out: 6, at: null }, 8, 10)).toEqual({ in: 8, out: null, at: null });
  });

  it('sets the out point, and puts an in point that no longer comes before it back at the top', () => {
    expect(withOut({ in: 2, out: null, at: null }, 5, 10)).toEqual({ in: 2, out: 5, at: null });
    expect(withOut({ in: 5, out: 8, at: null }, 5, 10)).toEqual({ in: 0, out: 5, at: null });
    expect(withOut({ in: 5, out: 8, at: null }, 3, 10)).toEqual({ in: 0, out: 3, at: null });
  });

  it('keeps a mark inside the file', () => {
    expect(withIn(UNMARKED, -1, 10).in).toBe(0);
    expect(withIn(UNMARKED, 12, 10).in).toBe(10);
    expect(withOut(UNMARKED, 12, 10).out).toBe(10);
  });
});

describe('markedRange', () => {
  it('is the whole file while nothing is marked, and for a file the monitor has not shown', () => {
    expect(markedRange(UNMARKED, 10)).toEqual({ sourceIn: 0, sourceOut: 10 });
    expect(markedRange(undefined, 10)).toEqual({ sourceIn: 0, sourceOut: 10 });
  });

  it('runs from the in point to the out point, or to the end without one', () => {
    expect(markedRange({ in: 2, out: 5, at: null }, 10)).toEqual({ sourceIn: 2, sourceOut: 5 });
    expect(markedRange({ in: 2, out: null, at: null }, 10)).toEqual({ sourceIn: 2, sourceOut: 10 });
  });

  it('stays within a file that has become shorter than its marks', () => {
    expect(markedRange({ in: 2, out: 9, at: null }, 6)).toEqual({ sourceIn: 2, sourceOut: 6 });
    expect(markedRange({ in: 8, out: 9, at: null }, 6)).toEqual({ sourceIn: 6, sourceOut: 6 });
  });
});

describe('clipMarks', () => {
  const asset: Asset = { ...ASSET_DEFAULTS, id: 'asset1', name: 'clip.mp4', kind: 'video', duration: 10 };
  const track = makeTrack('video', 0);
  const project = (init: Partial<Clip>, patch: Partial<Asset> = {}): { p: Project; clip: Clip } => {
    const clip = makeClip('video', track.id, { assetId: asset.id, start: 100, duration: 60, ...init });
    const p = applyEdits(emptyProject(), [
      { op: 'addTrack', track },
      { op: 'addAsset', asset: { ...asset, ...patch } },
      { op: 'addClip', clip },
    ]);
    return { p, clip };
  };

  it('is the stretch of the file the clip shows', () => {
    const { p, clip } = project({ sourceIn: 2 });
    const marks = clipMarks(clip, p)!;
    expect(marks.in).toBe(2);
    expect(marks.out).toBeCloseTo(2 + 60 / 30);
    // Put back on the timeline, that stretch is as long as the clip it was taken from.
    expect(secondsToFrame(marks.out! - marks.in, p.settings)).toBe(60);
  });

  it('follows the speed of the clip, and is the same stretch when the clip plays backwards', () => {
    const fast = project({ sourceIn: 1, speed: 2 });
    expect(clipMarks(fast.clip, fast.p)).toEqual({ in: 1, out: 5 });
    const back = project({ sourceIn: 1, speed: 2, reverse: true });
    expect(clipMarks(back.clip, back.p)).toEqual({ in: 1, out: 5 });
  });

  it('ends with the file', () => {
    const { p, clip } = project({ sourceIn: 9, duration: 90 });
    expect(clipMarks(clip, p)).toEqual({ in: 9, out: 10 });
  });

  it('marks nothing for a frozen frame, a still or a clip without media', () => {
    const frozen = project({ sourceIn: 2, freeze: true });
    expect(clipMarks(frozen.clip, frozen.p)).toBeNull();
    const still = project({}, { kind: 'image', duration: 0 });
    expect(clipMarks(still.clip, still.p)).toBeNull();
    const title = project({ assetId: null });
    expect(clipMarks(title.clip, title.p)).toBeNull();
  });
});

describe('resumeAt', () => {
  it('goes on from where the file was left', () => {
    expect(resumeAt({ in: 0, out: null, at: 4.2 }, 10)).toBe(4.2);
  });

  it('starts from the top the first time, and when the file was left there or at its end', () => {
    expect(resumeAt(undefined, 10)).toBeNull();
    expect(resumeAt(UNMARKED, 10)).toBeNull();
    expect(resumeAt({ in: 0, out: null, at: 0 }, 10)).toBeNull();
    expect(resumeAt({ in: 0, out: null, at: 10 }, 10)).toBeNull();
    expect(resumeAt({ in: 0, out: null, at: 9.95 }, 10)).toBeNull();
    // A file that has become shorter than the place it was left at.
    expect(resumeAt({ in: 0, out: null, at: 8 }, 6)).toBeNull();
  });
});

describe('what the monitor keeps', () => {
  beforeEach(() => {
    useUI.getState().set({ sourceMarks: {} });
  });

  it('keeps marks and position per file, each without disturbing the other', () => {
    rememberSource('a', { in: 1, out: 2 });
    rememberSource('b', { at: 7 });
    rememberSource('a', { at: 3 });
    expect(useUI.getState().sourceMarks).toEqual({
      a: { in: 1, out: 2, at: 3 },
      b: { in: 0, out: null, at: 7 },
    });
    rememberSource('a', { in: 0, out: null });
    expect(useUI.getState().sourceMarks.a).toEqual({ in: 0, out: null, at: 3 });
  });

  it('lets go of the files that have left the project, and only of those', () => {
    const asset: Asset = { ...ASSET_DEFAULTS, id: 'a', name: 'a.mp4', kind: 'video' };
    const marks = { a: { in: 1, out: 2, at: 3 }, b: { in: 0, out: null, at: 7 } };
    expect(marksOfKnown(marks, { a: asset })).toEqual({ a: { in: 1, out: 2, at: 3 } });
    expect(marksOfKnown(marks, {})).toEqual({});
    // Nothing gone: the very same object, so that nobody is told of a change.
    expect(marksOfKnown(marks, { a: asset, b: { ...asset, id: 'b' } })).toBe(marks);
  });
});

describe('source monitor commands', () => {
  it('have keys of their own that work wherever the keyboard is', () => {
    const keysOf = (id: string) => COMMANDS.find((c) => c.id === id)?.keys;
    expect(keysOf('source-insert')).toEqual(['f9']);
    expect(keysOf('source-add')).toEqual(['f10']);
    // Comma and period stay the nudge keys in the catalogue: the open monitor takes them itself.
    expect(keysOf('nudge-left')).toEqual(['comma']);
    expect(keysOf('nudge-right')).toEqual(['period']);
  });
});
