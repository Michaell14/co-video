import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  FRAME_RATE_PRESETS,
  ProjectStore,
  addGenerator,
  applyEdits,
  changeFrameRate,
  deepEqual,
  deleteClips,
  fpsOf,
  linkClips,
  makeClip,
  mediaToStream,
  overlappingClips,
  placeClips,
  flatRamp,
  rampTable,
  resolveFrame,
  rippleDelete,
  setRamp,
  setSpeed,
  shapeRamp,
  sourceSpan,
  sourceTimeAt,
  splitClips,
  streamSpeed,
  tidyRamp,
  tracksOf,
  trimClips,
} from '../src';
import type { Clip, Edit, Marker, RampPoint, RampShape } from '../src';
import { connect, overlaps } from './helpers';

/**
 * Two people who hear of each other only when `sync()` is called. When both write the same value in
 * between, it is `winner`'s that stands once they have synced.
 */
function apart(winner: 'a' | 'b' = 'a') {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  docA.clientID = winner === 'a' ? 2 : 1;
  docB.clientID = winner === 'a' ? 1 : 2;
  const a = new ProjectStore(docA);
  const b = new ProjectStore(docB);
  a.initIfEmpty({ name: 'Spring campaign' });
  const sync = () => {
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)), 'remote');
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)), 'remote');
  };
  sync();
  return { a, b, sync };
}

/** Two people who see each other's edits as they are made. */
function together() {
  const a = new ProjectStore();
  a.initIfEmpty({ name: 'Spring campaign' });
  const b = new ProjectStore();
  connect(a.doc, b.doc);
  return { a, b };
}

/** Five clips back to back on V1, a hundred frames each. */
function cut(s: ProjectStore): Clip[] {
  const v1 = tracksOf(s.get()).video[0];
  const clips = [0, 1, 2, 3, 4].map((i) =>
    makeClip('solid', v1.id, { start: i * 100, duration: 100, name: `C${i + 1}` }),
  );
  s.commit(clips.map((clip): Edit => ({ op: 'addClip', clip })));
  return clips;
}

/** Eight clips back to back on V1, of lengths that no two frame rates round alike. */
function unevenCut(s: ProjectStore): Clip[] {
  const v1 = tracksOf(s.get()).video[0];
  let at = 0;
  const clips = [37, 5, 112, 64, 13, 90, 41, 77].map((duration, i) => {
    const clip = makeClip('video', v1.id, { start: at, duration, name: `C${i}` });
    at += duration;
    return clip;
  });
  s.commit(clips.map((clip): Edit => ({ op: 'addClip', clip })));
  return clips;
}

/** Start and length of each clip, or null for one that is not on the timeline. */
const places = (s: ProjectStore, clips: Clip[]): ([number, number] | null)[] =>
  clips.map((c) => {
    const now = s.get().clips[c.id];
    return now ? [now.start, now.duration] : null;
  });

const stored = (s: ProjectStore, map: string, id: string): Record<string, unknown> =>
  (s.doc.getMap(map).get(id) as Y.Map<unknown>).toJSON();

const marker = (frame: number, name = 'Beat'): Marker => ({
  id: 'm1',
  frame,
  name,
  color: '#f59e0b',
  note: '',
});

const TAKEN = { changed: true, dropped: 0 };

describe('undo after someone wrote the same value at the same moment', () => {
  it('puts a clip back where it was, not at frame 0', () => {
    const { a, b, sync } = apart();
    const clips = cut(a);
    sync();
    const v1 = clips[0].trackId;
    // A closes up the cut while B, who has not heard of it, moves C4 on by 20 frames.
    a.commit(rippleDelete(a.get(), [clips[0].id]).edits);
    b.commit(placeClips(b.get(), [{ id: clips[3].id, start: 320, trackId: v1 }]));
    sync();
    const merged = [null, [0, 100], [100, 100], [200, 100], [300, 80]];
    expect(places(a, clips)).toEqual(merged);

    expect(a.undo()).toEqual(TAKEN);
    sync();
    const undone = [
      [0, 100],
      [100, 100],
      [200, 100],
      [300, 100],
      [400, 80],
    ];
    for (const s of [a, b]) {
      expect(places(s, clips)).toEqual(undone);
      expect(overlaps(s.get())).toEqual([]);
      expect(stored(s, 'clips', clips[3].id)).toMatchObject({ start: 300, trackId: v1 });
    }
    expect(a.get()).toEqual(b.get());
    expect(new ProjectStore(a.doc).get()).toEqual(a.get());

    // The repair is part of the step: redo takes it away again, and undo makes it again.
    expect(a.redo()).toEqual(TAKEN);
    expect(a.canRedo).toBe(false);
    sync();
    expect(places(b, clips)).toEqual(merged);
    expect(a.undo()).toEqual(TAKEN);
    expect(a.undoManager.redoStack).toHaveLength(1);
    sync();
    expect(places(b, clips)).toEqual(undone);
    expect(a.get()).toEqual(b.get());
  });

  it('leaves the other value alone when that is the one that stands', () => {
    const { a, b, sync } = apart('b');
    const clips = cut(a);
    sync();
    a.commit(rippleDelete(a.get(), [clips[0].id]).edits);
    b.commit(placeClips(b.get(), [{ id: clips[3].id, start: 320, trackId: clips[0].trackId }]));
    sync();
    expect(places(a, clips)).toEqual([null, [0, 100], [100, 100], [320, 100], [420, 80]]);
    expect(a.undo()).toEqual(TAKEN);
    sync();
    for (const s of [a, b]) {
      expect(places(s, clips)).toEqual([
        [0, 100],
        [100, 100],
        [200, 100],
        [320, 100],
        [420, 80],
      ]);
      expect(overlaps(s.get())).toEqual([]);
    }
  });

  it('puts back a length that a change of rate replaced while it was being trimmed', () => {
    const { a, b, sync } = apart();
    const clips = cut(a);
    sync();
    const before = a.get();
    a.commit(changeFrameRate(a.get(), 25, 1));
    b.commit(trimClips(b.get(), [clips[2].id], 'end', -10));
    sync();
    expect(a.get().clips[clips[2].id].duration).toBe(83);

    expect(a.undo()).toEqual(TAKEN);
    sync();
    for (const s of [a, b]) {
      expect(s.get().settings).toMatchObject({ fpsNum: 30, fpsDen: 1 });
      expect(places(s, clips)).toEqual(clips.map((c) => [c.start, 100]));
      expect(stored(s, 'clips', clips[2].id).duration).toBe(100);
    }
    expect(a.get()).toEqual(before);
    a.redo();
    sync();
    expect(b.get().settings.fpsNum).toBe(25);
    expect(places(b, clips)[2]).toEqual([167, 83]);
  });

  it('puts a clip back on its track when two people dropped it elsewhere at once', () => {
    const { a, b, sync } = apart();
    const clips = cut(a);
    sync();
    const [v1, v2] = tracksOf(a.get()).video;
    a.commit(placeClips(a.get(), [{ id: clips[4].id, start: 0, trackId: v2.id }]));
    b.commit(placeClips(b.get(), [{ id: clips[4].id, start: 600, trackId: v2.id }]));
    sync();
    expect(a.get().clips[clips[4].id]).toMatchObject({ start: 0, trackId: v2.id });

    a.undo();
    sync();
    for (const s of [a, b]) {
      expect(s.get().clips[clips[4].id]).toMatchObject({ start: 400, trackId: v1.id });
      expect(s.hiddenClips()).toEqual([]);
    }
    a.redo();
    sync();
    expect(b.get().clips[clips[4].id]).toMatchObject({ start: 0, trackId: v2.id });
  });

  it('puts back a setting, a marker and a field of a track', () => {
    const { a, b, sync } = apart();
    const a1 = tracksOf(a.get()).audio[0];
    a.commit([{ op: 'setMarker', marker: marker(100) }]);
    sync();

    a.commit([{ op: 'settings', patch: { name: 'Spring campaign v2' } }]);
    b.commit([{ op: 'settings', patch: { name: 'Spring campaign (client cut)' } }]);
    sync();
    expect(b.get().settings.name).toBe('Spring campaign v2');
    a.undo();
    sync();
    for (const s of [a, b]) expect(s.get().settings.name).toBe('Spring campaign');
    expect(a.doc.getMap('settings').has('name')).toBe(true);

    a.commit([{ op: 'setMarker', marker: marker(130) }]);
    b.commit([{ op: 'setMarker', marker: marker(100, 'Drop') }]);
    sync();
    expect(b.get().markers.m1).toEqual(marker(130));
    a.undo();
    sync();
    for (const s of [a, b]) expect(s.get().markers.m1).toEqual(marker(100));

    b.commit([{ op: 'updateTrack', id: a1.id, patch: { volume: -6 } }]);
    a.commit([{ op: 'updateTrack', id: a1.id, patch: { volume: -3 } }]);
    sync();
    expect(b.get().tracks[a1.id].volume).toBe(-3);
    a.undo();
    sync();
    for (const s of [a, b]) expect(stored(s, 'tracks', a1.id).volume).toBe(0);
    expect(a.get()).toEqual(b.get());
  });

  it('does the same for a redo', () => {
    const { a, b, sync } = apart();
    const clip = cut(a)[1];
    a.commit([{ op: 'updateClip', id: clip.id, patch: { start: 150, name: 'Moved' } }]);
    sync();
    // A takes the move back while B, who still sees it, nudges the clip.
    a.undo();
    b.commit([{ op: 'updateClip', id: clip.id, patch: { start: 170 } }]);
    sync();
    expect(b.get().clips[clip.id]).toMatchObject({ start: 100, name: 'C2' });

    expect(a.redo()).toEqual(TAKEN);
    sync();
    for (const s of [a, b]) {
      expect(s.get().clips[clip.id]).toMatchObject({ start: 150, name: 'Moved' });
      expect(stored(s, 'clips', clip.id).start).toBe(150);
    }
    a.undo();
    sync();
    expect(b.get().clips[clip.id]).toMatchObject({ start: 100, name: 'C2' });
  });

  it('brings a deleted clip back whole when it was being moved as it was deleted', () => {
    const { a, b, sync } = apart();
    const clips = cut(a);
    sync();
    a.commit(deleteClips(a.get(), [clips[3].id]));
    b.commit([{ op: 'updateClip', id: clips[3].id, patch: { start: 320, duration: 60 } }]);
    sync();
    expect(b.get().clips[clips[3].id]).toBeUndefined();

    expect(a.undo()).toEqual(TAKEN);
    sync();
    for (const s of [a, b]) {
      expect(s.get().clips[clips[3].id]).toEqual(clips[3]);
      expect(stored(s, 'clips', clips[3].id)).toMatchObject({ start: 300, duration: 100 });
    }
    a.redo();
    sync();
    expect(b.get().clips[clips[3].id]).toBeUndefined();
  });
});

describe('undo of a change to something that someone else has deleted since', () => {
  it('leaves a marker deleted', () => {
    const { a, b } = together();
    a.commit([{ op: 'setMarker', marker: marker(100) }]);
    a.commit([{ op: 'setMarker', marker: marker(130) }]);
    b.commit([{ op: 'removeMarker', id: 'm1' }]);

    // Neither the move nor the adding of the marker has anything left to take back.
    expect(a.undo()).toEqual({ changed: false, dropped: 2 });
    for (const s of [a, b]) expect(s.get().markers.m1).toBeUndefined();
    expect(a.canUndo).toBe(false);
    expect(a.canRedo).toBe(false);

    // The deletion is still B's to take back.
    expect(b.undo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().markers.m1).toEqual(marker(130));
  });

  it('leaves a folder deleted, and takes the step before instead', () => {
    const { a, b } = together();
    a.commit([{ op: 'settings', patch: { name: 'Renamed' } }]);
    a.commit([{ op: 'addFolder', folder: { id: 'f1', name: 'B-roll', parentId: null } }]);
    b.commit([{ op: 'updateFolder', id: 'f1', patch: { name: 'B-roll, day two' } }]);
    a.commit([{ op: 'updateFolder', id: 'f1', patch: { name: 'Cutaways' } }]);
    b.commit([{ op: 'removeFolder', id: 'f1' }]);

    expect(a.undo()).toEqual({ changed: true, dropped: 2 });
    for (const s of [a, b]) {
      expect(s.get().folders).toEqual({});
      expect(s.get().settings.name).toBe('Spring campaign');
    }
    expect(a.redo()).toEqual(TAKEN);
    expect(b.get().settings.name).toBe('Renamed');
    expect(b.get().folders).toEqual({});
  });

  it('still brings back what the same person deleted', () => {
    const { a, b } = together();
    a.commit([{ op: 'setMarker', marker: marker(100) }]);
    a.commit([{ op: 'addFolder', folder: { id: 'f1', name: 'B-roll', parentId: null } }]);
    a.commit([{ op: 'setMarker', marker: marker(130) }]);
    a.commit([
      { op: 'removeMarker', id: 'm1' },
      { op: 'removeFolder', id: 'f1' },
    ]);
    expect(a.undo()).toEqual(TAKEN);
    expect(b.get().markers.m1).toEqual(marker(130));
    expect(b.get().folders.f1).toEqual({ id: 'f1', name: 'B-roll', parentId: null });
    expect(a.undo()).toEqual(TAKEN);
    expect(b.get().markers.m1).toEqual(marker(100));
  });

  it('leaves them deleted also when what they held was put there by an undo', () => {
    const { a, b } = together();
    const folder = (name: string): Edit =>
      name === 'B-roll'
        ? { op: 'addFolder', folder: { id: 'f1', name, parentId: null } }
        : { op: 'updateFolder', id: 'f1', patch: { name } };
    a.commit([{ op: 'setMarker', marker: marker(100) }]);
    a.commit([folder('B-roll')]);
    a.commit([{ op: 'setMarker', marker: marker(130) }]);
    a.commit([folder('Cutaways')]);
    a.commit([{ op: 'setMarker', marker: marker(160) }]);
    a.commit([folder('Inserts')]);
    // Back one step each: the marker and the folder are now copies of what the steps before wrote.
    a.undo();
    a.undo();
    expect(b.get().markers.m1).toEqual(marker(130));
    expect(b.get().folders.f1.name).toBe('Cutaways');
    b.commit([
      { op: 'removeMarker', id: 'm1' },
      { op: 'removeFolder', id: 'f1' },
    ]);

    expect(a.undo()).toEqual({ changed: false, dropped: 4 });
    for (const s of [a, b]) {
      expect(s.get().markers).toEqual({});
      expect(s.get().folders).toEqual({});
    }
    expect(b.undo()).toEqual(TAKEN);
    expect(a.get().markers.m1).toEqual(marker(130));
    expect(a.get().folders.f1.name).toBe('Cutaways');
  });

  it('takes the change back after all once the deletion has been undone', () => {
    const { a, b } = together();
    a.commit([{ op: 'setMarker', marker: marker(100) }]);
    a.commit([{ op: 'setMarker', marker: marker(130) }]);
    b.commit([{ op: 'removeMarker', id: 'm1' }]);
    b.undo();
    expect(a.get().markers.m1).toEqual(marker(130));
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().markers.m1).toEqual(marker(100));
  });
});

describe('what undo and redo report', () => {
  it('says so when there was nothing to take', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    expect(s.undo()).toEqual({ changed: false, dropped: 0 });
    expect(s.redo()).toEqual({ changed: false, dropped: 0 });
  });

  it('counts the steps it passed over because someone else has changed the same thing since', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    const x = makeClip('solid', v1.id, { start: 0, duration: 50, name: 'Intro' });
    const y = makeClip('solid', v1.id, { start: 100, duration: 50 });
    a.commit([
      { op: 'addClip', clip: x },
      { op: 'addClip', clip: y },
    ]);
    a.commit([{ op: 'updateClip', id: x.id, patch: { name: 'Opening titles' } }]);
    a.commit(placeClips(a.get(), [{ id: y.id, start: 300, trackId: v1.id }]));
    b.commit(placeClips(b.get(), [{ id: y.id, start: 500, trackId: v1.id }]));

    // B has moved the clip on: the move is not A's to take back any more, and the rename goes.
    expect(a.undo()).toEqual({ changed: true, dropped: 1 });
    expect(b.get().clips[x.id].name).toBe('Intro');
    expect(b.get().clips[y.id].start).toBe(500);
    expect(a.undoManager.undoStack).toHaveLength(1);
    expect(a.undoManager.redoStack).toHaveLength(1);
    expect(a.redo()).toEqual(TAKEN);
    expect(b.get().clips[x.id].name).toBe('Opening titles');
  });

  it('tells whoever follows the history when every step came to nothing', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    const clip = makeClip('solid', v1.id, { start: 0, duration: 50 });
    a.commit([{ op: 'addClip', clip }]);
    a.commit([{ op: 'updateClip', id: clip.id, patch: { start: 20 } }]);
    b.commit(deleteClips(b.get(), [clip.id]));
    let told = 0;
    a.subscribeUndo(() => told++);
    const version = a.undoVersion;

    expect(a.canUndo).toBe(true);
    expect(a.undo()).toEqual({ changed: false, dropped: 2 });
    expect(a.canUndo).toBe(false);
    expect(told).toBe(1);
    expect(a.undoVersion).toBeGreaterThan(version);
    expect(b.get().clips[clip.id]).toBeUndefined();
  });

  it('tells them once for a step that was taken', () => {
    const { a } = together();
    cut(a);
    let told = 0;
    a.subscribeUndo(() => told++);
    a.undo();
    expect(told).toBe(1);
    expect([a.canUndo, a.canRedo]).toEqual([false, true]);
    a.redo();
    expect(told).toBe(2);
    expect([a.canUndo, a.canRedo]).toEqual([true, false]);
  });
});

describe('undo of a change to a clip that came back once and is gone for good', () => {
  it('passes the step over instead of failing half way', () => {
    const { a, b, sync } = apart();
    const v1 = tracksOf(a.get()).video[0];
    const clip = makeClip('video', v1.id, { start: 0, duration: 50, name: 'One' });
    a.commit([{ op: 'addClip', clip }]);
    a.commit([{ op: 'updateClip', id: clip.id, patch: { name: 'Uno' } }]);
    // Deleted and brought back: the clip in the document is now a copy of the one that was renamed.
    a.commit(deleteClips(a.get(), [clip.id]));
    a.undo();
    a.commit([{ op: 'updateClip', id: clip.id, patch: { opacity: 0.5 } }]);
    a.undo();
    // A new edit ends the chance of a redo, and with it the reason to keep the copy once deleted.
    a.commit([{ op: 'settings', patch: { name: 'Elsewhere' } }]);
    sync();
    b.commit(deleteClips(b.get(), [clip.id]));
    sync();

    expect(a.undo()).toEqual(TAKEN);
    expect(a.get().settings.name).toBe('Spring campaign');
    // The rename and the adding of the clip have nothing left to take back.
    expect(a.undo()).toEqual({ changed: false, dropped: 2 });
    sync();
    for (const s of [a, b]) expect(s.get().clips[clip.id]).toBeUndefined();
    expect(a.get()).toEqual(b.get());
    expect(a.redo()).toEqual(TAKEN);
    expect(a.get().settings.name).toBe('Elsewhere');
  });
});

describe('undo after someone else changed the frame rate', () => {
  it('takes back moves, trims and markers made before it, one step at a time', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    const first = makeClip('video', v1.id, { start: 0, duration: 240 });
    const second = makeClip('video', v1.id, { start: 240, duration: 120, fadeIn: 9 });
    a.commit([
      { op: 'addClip', clip: first },
      { op: 'addClip', clip: second },
    ]);
    const title = addGenerator(b.get(), 'text', { frame: 360, duration: 150 });
    b.commit(title.edits);
    b.commit(placeClips(b.get(), [{ id: second.id, start: 270, trackId: v1.id }]));
    b.commit(trimClips(b.get(), [second.id], 'end', -21));
    b.commit([{ op: 'setMarker', marker: marker(200) }]);
    const at30 = b.get();

    a.commit(changeFrameRate(a.get(), 60, 1));
    const at60 = b.get();
    expect(at60.clips[second.id]).toMatchObject({ start: 540, duration: 198, fadeIn: 18 });
    expect(b.undoManager.undoStack).toHaveLength(4);

    expect(b.undo()).toEqual(TAKEN);
    expect(a.get().markers.m1).toBeUndefined();
    expect(b.undo()).toEqual(TAKEN);
    expect(a.get().clips[second.id]).toMatchObject({ start: 540, duration: 240 });
    expect(b.undo()).toEqual(TAKEN);
    expect(a.get().clips[second.id]).toMatchObject({ start: 480, duration: 240 });
    expect(a.get().clips[title.created[0]]).toBeDefined();
    expect(b.undo()).toEqual(TAKEN);
    expect(a.get().clips[title.created[0]]).toBeUndefined();
    expect(b.canUndo).toBe(false);
    expect(a.get()).toEqual(b.get());

    for (let i = 0; i < 4; i++) expect(b.redo()).toEqual(TAKEN);
    expect(b.canRedo).toBe(false);
    expect(a.get()).toEqual(at60);
    expect(b.get()).toEqual(at60);

    // And the change of rate is still its author's to take back, with what B did left as it was.
    expect(a.undo()).toEqual(TAKEN);
    expect(b.get()).toEqual(at30);
    expect(a.get()).toEqual(at30);
  });

  it('takes back a move to a frame that reads the same at both rates', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    const clip = makeClip('video', v1.id, { start: 300, duration: 100 });
    a.commit([{ op: 'addClip', clip }]);
    b.commit([{ op: 'updateClip', id: clip.id, patch: { start: 0 } }]);
    // 30 to 29.97: a clip this early keeps its numbers, and the change writes them all the same.
    a.commit(changeFrameRate(a.get(), 30000, 1001));
    expect(a.get().clips[clip.id]).toMatchObject({ start: 0, duration: 100 });
    expect(b.undo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().clips[clip.id]).toMatchObject({ start: 300, duration: 100 });
  });

  it('puts a rippled cut back without a gap and without a clip on another track', () => {
    const a = new ProjectStore();
    a.initIfEmpty({ fpsNum: 24000, fpsDen: 1001 });
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const clips = unevenCut(a);
    a.commit(rippleDelete(a.get(), [clips[1].id]).edits);
    b.commit(changeFrameRate(b.get(), 25, 1));
    const changed = a.get();

    expect(a.undo()).toEqual(TAKEN);
    // Every start and every end as 23.976 to 25 takes them: 37 to 39, 42 to 44, 154 to 161...
    const ends = [0, 39, 44, 161, 227, 241, 335, 377, 458];
    for (const s of [a, b]) {
      expect(places(s, clips)).toEqual(clips.map((_, i) => [ends[i], ends[i + 1] - ends[i]]));
      expect(clips.map((c) => s.get().clips[c.id].trackId)).toEqual(clips.map((c) => c.trackId));
      expect(s.get().tracks).toEqual(changed.tracks);
    }
    expect(a.redo()).toEqual(TAKEN);
    expect(a.get()).toEqual(changed);
    expect(b.get()).toEqual(changed);
  });

  it('puts a moved clip back into its slot, as long as the slot is at the new rate', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    const moved = makeClip('video', v1.id, { start: 450, duration: 129 });
    const next = makeClip('video', v1.id, { start: 579, duration: 121 });
    a.commit([
      { op: 'addClip', clip: moved },
      { op: 'addClip', clip: next },
    ]);
    a.commit(placeClips(a.get(), [{ id: moved.id, start: 15516, trackId: v1.id }]));
    // 30 to 29.97. Out there the clip stays 129 frames long; in its slot it is 128, up to frame 578.
    b.commit(changeFrameRate(b.get(), 30000, 1001));
    expect(a.get().clips[moved.id]).toMatchObject({ start: 15500, duration: 129 });
    expect(a.get().clips[next.id]).toMatchObject({ start: 578, duration: 121 });

    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b]) {
      expect(s.get().clips[moved.id]).toMatchObject({ start: 450, duration: 128, trackId: v1.id });
      expect(s.get().clips[next.id]).toMatchObject({ start: 578, duration: 121, trackId: v1.id });
      expect(overlaps(s.get())).toEqual([]);
    }
    expect(a.redo()).toEqual(TAKEN);
    expect(b.get().clips[moved.id]).toMatchObject({ start: 15500, duration: 129 });
  });

  it('gives the cut as the change of rate alone would have left it, whatever the two rates', () => {
    const rates = FRAME_RATE_PRESETS.slice(0, 9);
    const edits: Record<string, (s: ProjectStore, clips: Clip[]) => void> = {
      'a ripple delete': (s, clips) => s.commit(rippleDelete(s.get(), [clips[1].id]).edits),
      'a ripple trim': (s, clips) => s.commit(trimClips(s.get(), [clips[3].id], 'end', -7, true)),
      'a move': (s, clips) =>
        s.commit(placeClips(s.get(), [{ id: clips[3].id, start: 1003, trackId: clips[3].trackId }])),
      'a trim and a ripple delete': (s, clips) => {
        s.commit(trimClips(s.get(), [clips[3].id], 'end', -7, true));
        s.commit(rippleDelete(s.get(), [clips[1].id]).edits);
      },
      'a trim, a move and a trim': (s, clips) => {
        s.commit(trimClips(s.get(), [clips[7].id], 'end', -9));
        s.commit(placeClips(s.get(), [{ id: clips[7].id, start: 1003, trackId: clips[7].trackId }]));
        s.commit(trimClips(s.get(), [clips[7].id], 'end', 4));
      },
    };
    for (const [name, edit] of Object.entries(edits)) {
      for (const from of rates) {
        for (const to of rates) {
          if (from === to) continue;
          const label = `${name}, ${from.label} to ${to.label}`;
          const a = new ProjectStore();
          a.initIfEmpty({ fpsNum: from.fpsNum, fpsDen: from.fpsDen });
          const b = new ProjectStore();
          connect(a.doc, b.doc);
          const clips = unevenCut(a);
          const alone = applyEdits(a.get(), changeFrameRate(a.get(), to.fpsNum, to.fpsDen));
          const steps = a.undoManager.undoStack.length;
          edit(a, clips);
          b.commit(changeFrameRate(b.get(), to.fpsNum, to.fpsDen));
          const changed = a.get();

          while (a.undoManager.undoStack.length > steps) expect([label, a.undo()]).toEqual([label, TAKEN]);
          expect([label, a.get().clips]).toEqual([label, alone.clips]);
          expect([label, b.get()]).toEqual([label, a.get()]);
          while (a.canRedo) expect([label, a.redo()]).toEqual([label, TAKEN]);
          expect([label, a.get()]).toEqual([label, changed]);
        }
      }
    }
  });

  it('leaves a clip of one frame on the frame the new rate gives it, though the next clip begins there', () => {
    const a = new ProjectStore();
    a.initIfEmpty({ fpsNum: 60, fpsDen: 1 });
    const b = new ProjectStore();
    connect(a.doc, b.doc);
    const v1 = tracksOf(a.get()).video[0];
    const flash = makeClip('solid', v1.id, { start: 11018, duration: 1 });
    const shot = makeClip('solid', v1.id, { start: 11019, duration: 40 });
    a.commit([
      { op: 'addClip', clip: flash },
      { op: 'addClip', clip: shot },
    ]);
    const alone = applyEdits(a.get(), changeFrameRate(a.get(), 25, 1));
    a.commit(deleteClips(a.get(), [flash.id]));
    b.commit(changeFrameRate(b.get(), 25, 1));

    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b]) {
      expect(s.get().clips).toEqual(alone.clips);
      expect(s.get().clips[flash.id]).toMatchObject({ start: 4591, duration: 1, trackId: v1.id });
    }
  });

  it('passes over a step once someone has changed the value for another reason', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    const clip = makeClip('video', v1.id, { start: 300, duration: 100 });
    a.commit([{ op: 'addClip', clip }]);
    b.commit([{ op: 'settings', patch: { name: 'Renamed' } }]);
    b.commit([{ op: 'updateClip', id: clip.id, patch: { start: 400 } }]);
    a.commit(changeFrameRate(a.get(), 60, 1));
    a.commit([{ op: 'updateClip', id: clip.id, patch: { start: 900 } }]);

    expect(b.undo()).toEqual({ changed: true, dropped: 1 });
    for (const s of [a, b]) {
      expect(s.get().clips[clip.id].start).toBe(900);
      expect(s.get().settings.name).toBe('Spring campaign');
    }
  });
});

describe('a change of frame rate', () => {
  const rates = FRAME_RATE_PRESETS.slice(0, 9);

  it('comes back exactly on undo and on redo', () => {
    const cases: [number, number, number, number, number, number][] = [
      [30, 1, 24, 1, 2933, 4],
      [30, 1, 25, 1, 2933, 4],
      [30, 1, 30000, 1001, 15516, 129],
      [24000, 1001, 30000, 1001, 7, 3],
    ];
    for (const [fromNum, fromDen, toNum, toDen, start, duration] of cases) {
      const s = new ProjectStore();
      s.initIfEmpty({ fpsNum: fromNum, fpsDen: fromDen });
      const v1 = tracksOf(s.get()).video[0];
      const clip = makeClip('solid', v1.id, { start, duration });
      s.commit([{ op: 'addClip', clip }]);
      const before = s.get();
      s.commit(changeFrameRate(before, toNum, toDen));
      const changed = s.get();
      expect(changed.clips[clip.id]).toEqual(
        applyEdits(before, changeFrameRate(before, toNum, toDen)).clips[clip.id],
      );
      for (let round = 0; round < 2; round++) {
        s.undo();
        expect([toNum, s.get()]).toEqual([toNum, before]);
        s.redo();
        expect([toNum, s.get()]).toEqual([toNum, changed]);
      }
    }
  });

  it('keeps a long cut exactly as it was through undo and redo, whatever the two rates', () => {
    // The same two hundred clips, back to back, on every run.
    let seed = 7;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const lengths = Array.from({ length: 200 }, () => 1 + Math.floor(random() * 150));
    for (const from of rates) {
      for (const to of rates) {
        if (from === to) continue;
        const s = new ProjectStore();
        s.initIfEmpty({ fpsNum: from.fpsNum, fpsDen: from.fpsDen });
        const v1 = tracksOf(s.get()).video[0];
        let at = 0;
        s.commit(
          lengths.map((duration): Edit => {
            const clip = makeClip('solid', v1.id, { start: at, duration });
            at += duration;
            return { op: 'addClip', clip };
          }),
        );
        const before = s.get();
        s.commit(changeFrameRate(before, to.fpsNum, to.fpsDen));
        const changed = s.get();
        const differing = (p: typeof before, q: typeof before) =>
          Object.keys(p.clips).filter(
            (id) => p.clips[id] !== q.clips[id] && !deepEqual(p.clips[id], q.clips[id]),
          );
        s.undo();
        expect([from.label, to.label, differing(s.get(), before)]).toEqual([from.label, to.label, []]);
        s.redo();
        expect([from.label, to.label, differing(s.get(), changed)]).toEqual([from.label, to.label, []]);
      }
    }
  });

  it('re-times what someone trimmed or moved after it when it is taken back', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    const trimmed = makeClip('video', v1.id, { start: 30, duration: 60 });
    const moved = makeClip('video', v1.id, { start: 300, duration: 60 });
    a.commit([
      { op: 'addClip', clip: trimmed },
      { op: 'addClip', clip: moved },
    ]);
    a.commit(changeFrameRate(a.get(), 60, 1));
    b.commit([{ op: 'updateClip', id: trimmed.id, patch: { duration: 100 } }]);
    b.commit([{ op: 'updateClip', id: moved.id, patch: { start: 700 } }]);

    a.undo();
    for (const s of [a, b]) {
      expect(s.get().clips[trimmed.id]).toMatchObject({ start: 30, duration: 50 });
      expect(s.get().clips[moved.id]).toMatchObject({ start: 350, duration: 60 });
    }
    a.redo();
    for (const s of [a, b]) {
      expect(s.get().clips[trimmed.id]).toMatchObject({ start: 60, duration: 100 });
      expect(s.get().clips[moved.id]).toMatchObject({ start: 700, duration: 120 });
    }
  });

  it('is won whole by one of two people who change it at the same moment', () => {
    const changes: [[number, number], [number, number], [number, number]][] = [
      [
        [30, 1],
        [60, 1],
        [24000, 1001],
      ],
      [
        [30000, 1001],
        [30, 1],
        [24000, 1001],
      ],
      [
        [30, 1],
        [30000, 1001],
        [60, 1],
      ],
    ];
    for (const [from, toA, toB] of changes) {
      for (const winner of ['a', 'b'] as const) {
        const { a, b, sync } = apart(winner);
        const v1 = tracksOf(a.get()).video[0];
        const clips = [
          makeClip('video', v1.id, { start: 0, duration: 1 }),
          makeClip('video', v1.id, { start: 1, duration: 2 }),
          makeClip('video', v1.id, { start: 3, duration: 297, fadeIn: 15 }),
          makeClip('video', v1.id, { start: 300, duration: 300 }),
        ];
        a.commit([
          { op: 'settings', patch: { fpsNum: from[0], fpsDen: from[1] } },
          ...clips.map((clip): Edit => ({ op: 'addClip', clip })),
          { op: 'setMarker', marker: marker(450) },
        ]);
        sync();
        const before = a.get();
        a.commit(changeFrameRate(a.get(), toA[0], toA[1]));
        b.commit(changeFrameRate(b.get(), toB[0], toB[1]));
        sync();

        const to = winner === 'a' ? toA : toB;
        const alone = applyEdits(before, changeFrameRate(before, to[0], to[1]));
        const label = `${from} to ${toA} and ${toB}, ${winner} wins`;
        for (const s of [a, b]) {
          expect([
            label,
            s.doc.getMap('settings').get('fpsNum'),
            s.doc.getMap('settings').get('fpsDen'),
          ]).toEqual([label, ...to]);
          expect([label, fpsOf(s.get().settings)]).toEqual([label, to[0] / to[1]]);
          expect([label, places(s, clips)]).toEqual([
            label,
            clips.map((c) => [alone.clips[c.id].start, alone.clips[c.id].duration]),
          ]);
          expect([label, s.get().markers.m1]).toEqual([label, alone.markers.m1]);
        }
        expect(a.get()).toEqual(b.get());
      }
    }
  });

  it('is not written by a change of other settings, also when the rate is among them', () => {
    const { a, b, sync } = apart();
    const [clip] = cut(a);
    sync();
    // A saves the whole settings form with a new name while B changes the rate.
    a.commit([{ op: 'settings', patch: { ...a.get().settings, name: 'Renamed' } }]);
    b.commit(changeFrameRate(b.get(), 60, 1));
    sync();
    for (const s of [a, b]) {
      expect(s.get().settings).toMatchObject({ name: 'Renamed', fpsNum: 60, fpsDen: 1 });
      expect(s.get().clips[clip.id].duration).toBe(200);
    }
  });

  it('writes both halves of the rate when only one is given', () => {
    const { a, b, sync } = apart();
    a.commit([{ op: 'settings', patch: { fpsNum: 60 } }]);
    b.commit([{ op: 'settings', patch: { fpsNum: 24000, fpsDen: 1001 } }]);
    sync();
    for (const s of [a, b]) expect(s.get().settings).toMatchObject({ fpsNum: 60, fpsDen: 1 });
  });
});

describe('a clip that comes back onto frames someone else has taken', () => {
  it('goes to a free track above, as part of the undo', () => {
    const { a, b } = together();
    const [v1, v2] = tracksOf(a.get()).video;
    const clips = [0, 120, 240].map((start) => makeClip('video', v1.id, { start, duration: 120 }));
    a.commit(clips.map((clip): Edit => ({ op: 'addClip', clip })));
    b.commit(deleteClips(b.get(), [clips[1].id]));
    a.commit(placeClips(a.get(), [{ id: clips[2].id, start: 130, trackId: v1.id }]));

    expect(b.undo()).toEqual(TAKEN);
    for (const s of [a, b]) {
      expect(s.get().clips[clips[1].id]).toEqual({ ...clips[1], trackId: v2.id });
      expect(s.get().clips[clips[2].id]).toEqual({ ...clips[2], start: 130 });
      expect(overlappingClips(s.get()).size).toBe(0);
      expect(Object.keys(s.get().tracks)).toHaveLength(4);
    }
    expect(b.undoManager.redoStack).toHaveLength(1);
    expect(b.redo()).toEqual(TAKEN);
    expect(b.canRedo).toBe(false);
    expect(a.get().clips[clips[1].id]).toBeUndefined();
    expect(b.undo()).toEqual(TAKEN);
    expect(a.get().clips[clips[1].id]).toEqual({ ...clips[1], trackId: v2.id });
    expect(a.get()).toEqual(b.get());
  });

  it('gets a new track when no track has room, and the track goes with the redo', () => {
    const { a, b } = together();
    const [v1, v2] = tracksOf(a.get()).video;
    const gone = makeClip('video', v1.id, { start: 100, duration: 100 });
    const above = makeClip('video', v2.id, { start: 0, duration: 400 });
    const late = makeClip('video', v1.id, { start: 150, duration: 100 });
    a.commit([
      { op: 'addClip', clip: gone },
      { op: 'addClip', clip: above },
    ]);
    b.commit(deleteClips(b.get(), [gone.id]));
    a.commit([{ op: 'addClip', clip: late }]);

    b.undo();
    for (const s of [a, b]) {
      const p = s.get();
      const video = tracksOf(p).video;
      expect(video).toHaveLength(3);
      expect(p.clips[gone.id]).toEqual({ ...gone, trackId: video[2].id });
      expect(overlaps(p)).toEqual([]);
    }
    b.redo();
    for (const s of [a, b]) {
      expect(tracksOf(s.get()).video).toHaveLength(2);
      expect(s.get().clips[gone.id]).toBeUndefined();
      expect(s.hiddenClips()).toEqual([]);
    }
  });

  it('keeps picture and sound of a linked pair in step', () => {
    const { a, b } = together();
    const { video, audio } = tracksOf(a.get());
    const picture = makeClip('video', video[0].id, { start: 100, duration: 100 });
    const sound = makeClip('audio', audio[0].id, { start: 100, duration: 100 });
    a.commit([
      { op: 'addClip', clip: picture },
      { op: 'addClip', clip: sound },
    ]);
    a.commit(linkClips(a.get(), [picture.id, sound.id]));
    const linkId = a.get().clips[picture.id].linkId;
    b.commit(deleteClips(b.get(), [picture.id, sound.id]));
    a.commit([{ op: 'addClip', clip: makeClip('video', video[0].id, { start: 150, duration: 30 }) }]);

    b.undo();
    for (const s of [a, b]) {
      expect(s.get().clips[picture.id]).toEqual({ ...picture, linkId, trackId: video[1].id });
      expect(s.get().clips[sound.id]).toEqual({ ...sound, linkId });
      expect(overlaps(s.get())).toEqual([]);
    }
  });

  it('stays where it is next to a clip it shared frames with before the step as well', () => {
    const s = new ProjectStore();
    s.initIfEmpty();
    const v1 = tracksOf(s.get()).video[0];
    // Left like this by two people who placed them at the same moment.
    const one = makeClip('video', v1.id, { start: 0, duration: 100 });
    const two = makeClip('video', v1.id, { start: 50, duration: 100 });
    s.commit([
      { op: 'addClip', clip: one },
      { op: 'addClip', clip: two },
    ]);
    const before = s.get();
    s.commit([{ op: 'updateClip', id: one.id, patch: { start: 10 } }]);
    s.undo();
    expect(s.get()).toEqual(before);
    s.commit([
      { op: 'updateClip', id: one.id, patch: { start: 10 } },
      { op: 'updateClip', id: two.id, patch: { duration: 80 } },
    ]);
    const moved = s.get();
    s.undo();
    expect(s.get()).toEqual(before);
    s.redo();
    expect(s.get()).toEqual(moved);
  });

  it('comes back onto the frames it shared before the step when nobody else has been there', () => {
    const s = new ProjectStore();
    s.initIfEmpty({ fpsNum: 60, fpsDen: 1 });
    const v1 = tracksOf(s.get()).video[0];
    const flash = makeClip('solid', v1.id, { start: 11018, duration: 1 });
    const shot = makeClip('solid', v1.id, { start: 11019, duration: 40 });
    s.commit([
      { op: 'addClip', clip: flash },
      { op: 'addClip', clip: shot },
    ]);
    const at60 = s.get();
    // At 25 frames a second both begin on frame 4591.
    s.commit(changeFrameRate(at60, 25, 1));
    const at25 = s.get();
    expect(overlappingClips(at25)).toEqual(new Set([flash.id, shot.id]));

    const away = [
      deleteClips(at25, [flash.id]),
      placeClips(at25, [{ id: flash.id, start: 9000, trackId: v1.id }]),
    ];
    for (const edits of away) {
      s.commit(edits);
      const without = s.get();
      expect(s.undo()).toEqual(TAKEN);
      expect(s.get()).toEqual(at25);
      expect(s.undo()).toEqual(TAKEN);
      expect(s.get()).toEqual(at60);
      expect(s.redo()).toEqual(TAKEN);
      expect(s.get()).toEqual(at25);
      expect(s.redo()).toEqual(TAKEN);
      expect(s.get()).toEqual(without);
      expect(s.undo()).toEqual(TAKEN);
      expect(s.get()).toEqual(at25);
    }
  });

  it('is given back with the clips it shared frames with, however often the step is taken', () => {
    const { a, b } = together();
    const v1 = tracksOf(a.get()).video[0];
    // Left like this by two people who placed them at the same moment.
    const one = makeClip('video', v1.id, { start: 0, duration: 100 });
    const two = makeClip('video', v1.id, { start: 60, duration: 100 });
    a.commit([
      { op: 'addClip', clip: one },
      { op: 'addClip', clip: two },
    ]);
    const before = a.get();
    // Only the second half of the split clip is on the frames of the other clip.
    a.commit(splitClips(before, [one.id], 40).edits);
    const split = a.get();
    for (let round = 0; round < 2; round++) {
      expect(a.undo()).toEqual(TAKEN);
      expect(a.get()).toEqual(before);
      expect(a.redo()).toEqual(TAKEN);
      expect(a.get()).toEqual(split);
    }
    a.undo();

    // The same for a step of someone who did not put either of them there.
    b.commit([{ op: 'updateClip', id: one.id, patch: { start: 500 } }]);
    expect(b.undo()).toEqual(TAKEN);
    expect(b.get()).toEqual(before);
    expect(a.get()).toEqual(before);
  });

  it('stays where it is when it is the redo of a change of rate that put two short clips on one frame', () => {
    const s = new ProjectStore();
    s.initIfEmpty({ fpsNum: 60, fpsDen: 1 });
    const v1 = tracksOf(s.get()).video[0];
    // At 25 frames a second both of these begin on frame 4591, and a clip is never shorter than a frame.
    s.commit([
      { op: 'addClip', clip: makeClip('solid', v1.id, { start: 11018, duration: 1 }) },
      { op: 'addClip', clip: makeClip('solid', v1.id, { start: 11019, duration: 40 }) },
    ]);
    s.commit(changeFrameRate(s.get(), 25, 1));
    const changed = s.get();
    s.undo();
    s.redo();
    expect(s.get()).toEqual(changed);
  });
});

describe('two clips placed on the same frames at the same moment', () => {
  it('are moved apart by the one person who placed the clip that gives way', () => {
    const { a, b, sync } = apart();
    const [v1, v2] = tracksOf(a.get()).video;
    const dusk = makeClip('video', v1.id, { start: 360, duration: 180, name: 'dusk' });
    const fractal = makeClip('video', v1.id, { start: 360, duration: 180, name: 'fractal' });
    a.commit([{ op: 'addClip', clip: dusk }]);
    b.commit([{ op: 'addClip', clip: fractal }]);
    sync();
    expect(overlappingClips(a.get())).toEqual(new Set([dusk.id, fractal.id]));

    const [stays, moves] = dusk.id < fractal.id ? [dusk, fractal] : [fractal, dusk];
    const mover = moves === dusk ? a : b;
    const other = moves === dusk ? b : a;
    const viewer = new ProjectStore();
    Y.applyUpdate(viewer.doc, Y.encodeStateAsUpdate(a.doc));
    expect(other.resolveOverlaps()).toBe(0);
    expect(viewer.resolveOverlaps()).toBe(0);
    expect(mover.resolveOverlaps()).toBe(1);
    sync();
    for (const s of [a, b]) {
      expect(s.get().clips[stays.id]).toEqual(stays);
      expect(s.get().clips[moves.id]).toEqual({ ...moves, trackId: v2.id });
      expect(overlappingClips(s.get()).size).toBe(0);
      // Not a step of anybody's: each still has the one step of adding a clip.
      expect(s.undoManager.undoStack).toHaveLength(1);
      expect(s.resolveOverlaps()).toBe(0);
    }
    expect(a.get()).toEqual(b.get());

    // Taking back the clip that stayed leaves the other one where it went.
    other.undo();
    sync();
    expect(mover.get().clips[moves.id]).toEqual({ ...moves, trackId: v2.id });
  });

  /** Three people, and a clip on V1 that the first of them placed and the second trimmed. */
  function three() {
    const stores = [1, 2, 3].map((clientID) => {
      const doc = new Y.Doc();
      doc.clientID = clientID;
      return new ProjectStore(doc);
    });
    const sync = () => {
      for (const from of stores) {
        for (const to of stores) {
          if (from !== to)
            Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
        }
      }
    };
    const [a, b, c] = stores;
    a.initIfEmpty();
    sync();
    const [v1, v2] = tracksOf(a.get()).video;
    // V2 is taken: a clip that gives way needs a track of its own.
    const wide = makeClip('video', v2.id, { start: 0, duration: 5000 });
    const placed = makeClip('video', v1.id, { id: 'zz-gives-way', start: 300, duration: 100 });
    a.commit([
      { op: 'addClip', clip: wide },
      { op: 'addClip', clip: placed },
    ]);
    sync();
    b.commit([{ op: 'updateClip', id: placed.id, patch: { duration: 80 } }]);
    sync();
    return { a, b, c, stores, sync, v1, placed };
  }

  it('are moved apart once when several people had a hand in placing the clip', () => {
    const { a, b, c, stores, sync, v1, placed } = three();
    c.commit([
      { op: 'addClip', clip: makeClip('video', v1.id, { id: 'aa-stays', start: 320, duration: 100 }) },
    ]);
    sync();
    expect(overlappingClips(a.get())).toEqual(new Set(['aa-stays', placed.id]));

    // Each of them looks before hearing what the others did about it.
    expect([a, b, c].map((s) => s.resolveOverlaps())).toEqual([0, 1, 0]);
    sync();
    const video = tracksOf(a.get()).video;
    expect(video).toHaveLength(3);
    for (const s of stores) {
      expect(s.get()).toEqual(a.get());
      expect(s.get().clips[placed.id]).toMatchObject({ start: 300, duration: 80, trackId: video[2].id });
      expect(overlappingClips(s.get()).size).toBe(0);
      expect(s.resolveOverlaps()).toBe(0);
    }
  });

  it('stay together when it was a change of frame rate that rounded them onto one frame', () => {
    const { a, b, sync } = apart();
    const v1 = tracksOf(a.get()).video[0];
    // At 24 frames a second both begin on frame 2, and a clip is never shorter than a frame.
    const flash = makeClip('solid', v1.id, { start: 2, duration: 1, name: 'flash' });
    const shot = makeClip('solid', v1.id, { start: 3, duration: 40, name: 'shot' });
    a.commit([{ op: 'addClip', clip: flash }]);
    sync();
    b.commit([{ op: 'addClip', clip: shot }]);
    sync();
    const before = a.get();
    a.commit(changeFrameRate(before, 24, 1));
    sync();
    const changed = a.get();
    expect(changed.clips[flash.id]).toMatchObject({ start: 2, duration: 1 });
    expect(changed.clips[shot.id]).toMatchObject({ start: 2, duration: 32 });
    expect(overlappingClips(changed)).toEqual(new Set([flash.id, shot.id]));

    // Nobody moves either of them, whoever looks and whoever is said to be here.
    const here = [a.doc.clientID, b.doc.clientID];
    expect([a, b].map((s) => s.resolveOverlaps())).toEqual([0, 0]);
    expect([a, b].map((s) => s.resolveOverlaps(here))).toEqual([0, 0]);
    sync();
    expect(a.get()).toEqual(changed);
    expect(b.get()).toEqual(changed);

    // So the step can be taken back to exactly what there was, and made again.
    expect(a.undo()).toEqual(TAKEN);
    sync();
    expect(a.get()).toEqual(before);
    expect(b.get()).toEqual(before);
    expect(a.redo()).toEqual(TAKEN);
    sync();
    expect(a.get()).toEqual(changed);
    expect(b.get()).toEqual(changed);
  });

  it('are moved apart when one of them is a single frame anywhere but at the start of the other', () => {
    const { a, b, sync } = apart();
    const v1 = tracksOf(a.get()).video[0];
    a.commit([{ op: 'addClip', clip: makeClip('solid', v1.id, { start: 360, duration: 180 }) }]);
    b.commit([{ op: 'addClip', clip: makeClip('solid', v1.id, { start: 400, duration: 1 }) }]);
    sync();
    expect(overlappingClips(a.get()).size).toBe(2);
    expect(a.resolveOverlaps() + b.resolveOverlaps()).toBe(1);
    sync();
    expect(overlappingClips(a.get()).size).toBe(0);
    expect(a.get()).toEqual(b.get());
  });

  it('are moved apart by someone who is there when the one it falls to has left', () => {
    const { a, b, c, sync, v1, placed } = three();
    c.commit([
      { op: 'addClip', clip: makeClip('video', v1.id, { id: 'aa-stays', start: 320, duration: 100 }) },
    ]);
    sync();
    // The second person, who trimmed the clip, is gone. Told who is here, the first one moves it.
    const here = [a.doc.clientID, c.doc.clientID];
    expect(c.resolveOverlaps(here)).toBe(0);
    expect(a.resolveOverlaps()).toBe(0);
    expect(a.resolveOverlaps(here)).toBe(1);
    sync();
    expect(overlappingClips(c.get()).size).toBe(0);
    expect(tracksOf(c.get()).video).toHaveLength(3);
    expect(b.resolveOverlaps()).toBe(0);
  });
});

describe('a speed ramp', () => {
  /**
   * A take on V1 that plays seconds 5 to 15 over frames 100 to 400, its sound on A1 from a second
   * earlier (a J cut), and another clip right after the picture.
   */
  function take(s: ProjectStore, init: Partial<Clip> = {}) {
    const v1 = tracksOf(s.get()).video[0];
    const a1 = tracksOf(s.get()).audio[0];
    const picture = makeClip('video', v1.id, {
      start: 100,
      duration: 300,
      sourceIn: 5,
      linkId: 'take',
      ...init,
    });
    const sound = makeClip('audio', a1.id, { start: 70, duration: 330, sourceIn: 4, linkId: 'take' });
    const next = makeClip('video', v1.id, { start: 400, duration: 100, sourceIn: 30 });
    s.commit([picture, sound, next].map((clip): Edit => ({ op: 'addClip', clip })));
    return { picture, sound, next };
  }

  const bullet = shapeRamp('bullet', 5, 15, false)!;
  const flat = flatRamp(5, 15, 1)!;

  /** Every frame of every clip resolves to a second of media, for both people alike. */
  const renders = (a: ProjectStore, b: ProjectStore): void => {
    expect(a.get()).toEqual(b.get());
    const p = a.get();
    for (const c of Object.values(p.clips)) {
      for (let u = -5; u < c.duration + 5; u += 7) expect(Number.isFinite(sourceTimeAt(c, u, p))).toBe(true);
      resolveFrame(p, c.start);
      resolveFrame(p, c.start + c.duration - 1);
    }
    expect(new ProjectStore(a.doc).get()).toEqual(p);
  };

  it('writes the fields that the new ramp changes, and no others', () => {
    const { a } = together();
    const { picture, sound } = take(a);
    const fields = (id: string): Y.Map<unknown> => a.doc.getMap('clips').get(id) as Y.Map<unknown>;
    const written: Record<string, string[]> = { [picture.id]: [], [sound.id]: [] };
    for (const id of [picture.id, sound.id])
      fields(id).observe((event) => written[id].push(...[...event.keysChanged].sort()));
    // A flat ramp leaves both clips as long as they are, where they are.
    const edits = setRamp(a.get(), [picture.id], { ramps: { [picture.id]: flat } });
    expect(edits.map((e) => Object.keys((e as { patch: object }).patch).sort())).toEqual([
      ['duration', 'ramp', 'sourceIn'],
      ['duration', 'keepPitch', 'ramp', 'sourceIn', 'start'],
    ]);
    a.commit(edits);
    expect(written).toEqual({ [picture.id]: ['ramp'], [sound.id]: ['keepPitch', 'ramp'] });
    // "Bullet" makes the picture 69 frames long, and moves and shortens its sound.
    a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }));
    expect(written[picture.id].slice(1)).toEqual(['duration', 'ramp']);
    expect(written[sound.id].slice(2)).toEqual(['duration', 'ramp', 'start']);
  });

  for (const winner of ['a', 'b'] as const) {
    it(`ends as one of the two ramps, on a length that may be the other's, when two people set different ramps at the same moment (${winner} wins)`, () => {
      const { a, b, sync } = apart(winner);
      const { picture, sound } = take(a);
      sync();
      // "Bullet" makes the clip 69 frames long and moves its sound. A flat ramp changes neither,
      // so whoever sets it writes the ramp and nothing else.
      a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }));
      b.commit(setRamp(b.get(), [picture.id], { ramps: { [picture.id]: flat } }));
      expect(a.get().clips[picture.id]).toMatchObject({ ramp: bullet, duration: 69 });
      expect(a.get().clips[sound.id]).toMatchObject({ ramp: bullet, start: 94, duration: 75 });
      expect(b.get().clips[picture.id]).toMatchObject({ ramp: flat, duration: 300 });
      expect(b.get().clips[sound.id]).toMatchObject({ ramp: flat, start: 70, duration: 330 });
      sync();
      // One ramp for everyone, the same on both clips. The length and the place are those of the
      // only edit that changed them, whichever ramp stands: a flat ramp over 69 frames plays the
      // first 69 frames of the stretch.
      const ramp = winner === 'a' ? bullet : flat;
      expect(a.get().clips[picture.id]).toMatchObject({ ramp, start: 100, duration: 69, sourceIn: 5 });
      expect(a.get().clips[sound.id]).toMatchObject({ ramp, start: 94, duration: 75, keepPitch: true });
      renders(a, b);
      // Whoever lost has nothing to take back; whoever won takes the ramp back, and the length stays.
      expect(b.undo()).toEqual(winner === 'a' ? { changed: false, dropped: 1 } : TAKEN);
      sync();
      expect(a.get().clips[picture.id]).toMatchObject({ ramp: winner === 'a' ? bullet : null, duration: 69 });
      renders(a, b);
    });

    it(`keeps a ramp and a trim made at the same moment, each field from one of the two (${winner} wins)`, () => {
      const { a, b, sync } = apart(winner);
      const { picture } = take(a);
      sync();
      a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }));
      b.commit(trimClips(b.get(), [picture.id], 'start', 30));
      expect(b.get().clips[picture.id]).toMatchObject({ start: 130, duration: 270, sourceIn: 6, ramp: null });
      sync();
      const merged = a.get().clips[picture.id];
      // The ramp stands either way, on the media it was set on, and so does the trim: where the
      // clip starts and where its media begins, which the ramp left as they were and did not write.
      expect(merged).toMatchObject({ ramp: bullet, start: 130, sourceIn: 6 });
      // The length is the one thing both wrote.
      expect(merged.duration).toBe(winner === 'a' ? 69 : 270);
      renders(a, b);
    });

    it(`keeps a ramp and a change of speed made at the same moment (${winner} wins)`, () => {
      const { a, b, sync } = apart(winner);
      const { picture, sound } = take(a);
      sync();
      a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }));
      b.commit(setSpeed(b.get(), [picture.id], 2));
      sync();
      // Nobody but the ramp wrote the ramp, and nobody but the speed the speed.
      expect(a.get().clips[picture.id]).toMatchObject({ ramp: bullet, speed: 2, start: 100, sourceIn: 5 });
      expect(a.get().clips[picture.id].duration).toBe(winner === 'a' ? 69 : 150);
      expect(a.get().clips[sound.id]).toMatchObject({ ramp: bullet, start: 94 });
      renders(a, b);

      // Off the ramp to one speed, against another ramp: the ramp or none, with the length that goes with it.
      a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }, true));
      sync();
      a.commit(
        setRamp(a.get(), [picture.id], { ramps: { [picture.id]: shapeRamp('rampUp', 5, 15, false) } }),
      );
      b.commit(setSpeed(b.get(), [picture.id], 4));
      const alone = (winner === 'a' ? a : b).get().clips[picture.id];
      sync();
      const { ramp, duration, sourceIn } = a.get().clips[picture.id];
      expect({ ramp, duration, sourceIn }).toEqual({
        ramp: alone.ramp,
        duration: alone.duration,
        sourceIn: alone.sourceIn,
      });
      expect(a.get().clips[picture.id].speed).toBe(4);
      renders(a, b);
    });
  }

  it('is not written again, and makes no step of history, when the clip has it already', () => {
    const { a, b } = together();
    const { picture, sound } = take(a);
    a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }));
    const steps = a.undoManager.undoStack.length;
    let updates = 0;
    a.doc.on('update', () => updates++);
    const before = a.get();
    const again = setRamp(a.get(), [sound.id], { ramps: { [picture.id]: bullet.map((q) => ({ ...q })) } });
    expect(again).toHaveLength(2);
    a.commit(again);
    expect(updates).toBe(0);
    expect(a.undoManager.undoStack).toHaveLength(steps);
    expect(a.get()).toBe(before);
    expect(a.get().clips[picture.id].ramp).toBe(before.clips[picture.id].ramp);
    expect(b.get()).toEqual(a.get());
  });

  it('is one step of history for the whole group, taken back and made again around what someone else did', () => {
    const { a, b } = together();
    const { picture, sound } = take(a, {
      keyframes: { x: [{ t: 150, v: 1, e: 'linear' }] },
      fadeOut: 200,
    });
    const found = a.get().clips;
    a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }));
    const made = a.get().clips;
    expect(made[picture.id]).toMatchObject({ ramp: bullet, duration: 69, fadeOut: 69 });
    expect(made[picture.id].keyframes.x[0].t).not.toBe(150);
    expect(made[sound.id]).toMatchObject({ ramp: bullet, start: 94, duration: 75, keepPitch: true });
    // The other person changes something else on both clips meanwhile.
    b.commit([
      { op: 'updateClip', id: picture.id, patch: { opacity: 0.5 } },
      { op: 'updateClip', id: sound.id, patch: { volume: -6 } },
    ]);
    expect(a.undo()).toEqual(TAKEN);
    expect(a.get().clips[picture.id]).toEqual({ ...found[picture.id], opacity: 0.5 });
    expect(a.get().clips[sound.id]).toEqual({ ...found[sound.id], volume: -6 });
    expect(b.get()).toEqual(a.get());
    expect(a.redo()).toEqual(TAKEN);
    expect(a.get().clips[picture.id]).toEqual({ ...made[picture.id], opacity: 0.5 });
    expect(a.get().clips[sound.id]).toEqual({ ...made[sound.id], volume: -6 });
    expect(b.get()).toEqual(a.get());
    expect(a.undo()).toEqual(TAKEN);
    expect(a.canUndo).toBe(true);
    expect(a.get().clips[sound.id]).toEqual({ ...found[sound.id], volume: -6 });
  });

  it('is one step for a drag of a point, however many times it was written on the way', () => {
    const { a, b } = together();
    const { picture, sound } = take(a);
    const found = a.get().clips;
    a.beginGesture();
    for (const v of [1.2, 1.9, 2.7, 3.4]) {
      const ramp = [
        { m: 5, v: 1 },
        { m: 10, v },
        { m: 15, v: 1 },
      ];
      // Each step from where the drag found the clips, as the planner works a gesture out.
      const from: Edit[] = [picture.id, sound.id].map((id) => {
        const { start, duration, sourceIn, ramp: was, keepPitch } = found[id];
        return { op: 'updateClip', id, patch: { start, duration, sourceIn, ramp: was, keepPitch } };
      });
      const p = applyEdits(a.get(), from);
      a.commit([...from, ...setRamp(p, [picture.id], { ramps: { [picture.id]: ramp } })], { merge: true });
    }
    expect(a.get().clips[picture.id].ramp![1].v).toBe(3.4);
    expect(b.get()).toEqual(a.get());
    expect(a.undo()).toEqual(TAKEN);
    expect(a.get().clips).toEqual(found);
    expect(b.get().clips).toEqual(found);
    expect(a.redo()).toEqual(TAKEN);
    expect(a.get().clips[picture.id].ramp![1].v).toBe(3.4);
  });

  it('goes through a change of frame rate untouched, and both come back exactly', () => {
    const { a, b } = together();
    const { picture, sound } = take(a);
    const found = a.get();
    a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: bullet } }));
    const ramped = a.get();
    a.commit(changeFrameRate(a.get(), 24, 1));
    const slower = a.get();
    for (const id of [picture.id, sound.id]) {
      expect(slower.clips[id].ramp).toBe(ramped.clips[id].ramp);
      expect(slower.clips[id].sourceIn).toBe(ramped.clips[id].sourceIn);
    }
    expect([slower.clips[picture.id].start, slower.clips[picture.id].duration]).toEqual([80, 55]);
    expect(a.undo()).toEqual(TAKEN);
    expect(a.get()).toEqual(ramped);
    expect(a.undo()).toEqual(TAKEN);
    expect(a.get()).toEqual(found);
    expect(a.redo()).toEqual(TAKEN);
    expect(a.redo()).toEqual(TAKEN);
    expect(a.get()).toEqual(slower);
    expect(b.get()).toEqual(a.get());
  });

  for (const ramp of [bullet, flat]) {
    it(`is taken back after someone else changed the frame rate (${ramp === flat ? 'no change of length' : 'a change of length'})`, () => {
      const { a, b } = together();
      const { picture, sound } = take(a);
      a.commit(setRamp(a.get(), [picture.id], { ramps: { [picture.id]: ramp } }));
      b.commit(changeFrameRate(b.get(), 24, 1));
      expect(a.get().clips[picture.id].ramp).toEqual(ramp);
      expect(a.undo()).toEqual(TAKEN);
      // As the change of rate alone would have left the two clips.
      const alone = new ProjectStore();
      alone.initIfEmpty({ name: 'Spring campaign' });
      const plain = take(alone);
      alone.commit(changeFrameRate(alone.get(), 24, 1));
      for (const [id, same] of [
        [picture.id, plain.picture.id],
        [sound.id, plain.sound.id],
      ]) {
        const { start, duration, sourceIn, ramp: now, speed } = a.get().clips[id];
        const meant = alone.get().clips[same];
        expect({ start, duration, sourceIn, ramp: now, speed }).toEqual({
          start: meant.start,
          duration: meant.duration,
          sourceIn: meant.sourceIn,
          ramp: null,
          speed: 1,
        });
      }
      expect(b.get()).toEqual(a.get());
      expect(overlaps(a.get())).toEqual([]);
    });
  }
});

describe('undo of a move or a trim after someone else changed the ramp of the clip', () => {
  /** A take of four seconds: its picture on V1, with or without its sound on A1, linked to it. */
  function take(s: ProjectStore, at: number, linked: boolean) {
    const v1 = tracksOf(s.get()).video[0];
    const a1 = tracksOf(s.get()).audio[0];
    const linkId = linked ? 'take' : null;
    const picture = makeClip('video', v1.id, { start: at, duration: 120, linkId });
    const sound = makeClip('audio', a1.id, { start: at, duration: 120, linkId });
    const clips = linked ? [picture, sound] : [picture];
    s.commit(clips.map((clip): Edit => ({ op: 'addClip', clip })));
    return { picture, sound, ids: clips.map((c) => c.id) };
  }
  const pair = (s: ProjectStore, at = 0) => take(s, at, true);

  /** The shape, on the stretch of media the clip plays now, as the chips of the inspector set it. */
  const shaped = (s: ProjectStore, id: string, shape: RampShape): void => {
    const p = s.get();
    const { in: from, out: to } = sourceSpan(p.clips[id], p);
    s.commit(setRamp(p, [id], { ramps: { [id]: shapeRamp(shape, from, to, p.clips[id].reverse) } }));
  };
  const SHAPES: RampShape[] = ['hero', 'bullet', 'montage'];

  /** A point of the ramp dragged in twelve steps of one gesture, each written as the planner writes it. */
  const dragged = (s: ProjectStore, ids: string[], lead: string): void => {
    const from = s.get().clips;
    s.beginGesture();
    for (let step = 1; step <= 12; step++) {
      const ramp = from[lead].ramp!.map((q, i) =>
        i === 2 ? { ...q, v: Math.round((q.v + 0.07 * step) * 1e3) / 1e3 } : q,
      );
      // Each step from where the drag found the clips, in one edit for each clip.
      const found = applyEdits(
        s.get(),
        ids.map((id): Edit => {
          const { start, duration, sourceIn, ramp: was, keepPitch } = from[id];
          return { op: 'updateClip', id, patch: { start, duration, sourceIn, ramp: was, keepPitch } };
        }),
      );
      s.commit(
        setRamp(found, [lead], { ramps: { [lead]: ramp } }).map((e) => {
          if (e.op !== 'updateClip') return e;
          const { duration, sourceIn, ramp: was, keepPitch } = from[e.id];
          return { ...e, patch: { duration, sourceIn, ramp: was, keepPitch, ...e.patch } };
        }),
        { merge: true },
      );
    }
  };

  const move = (s: ProjectStore, ids: string[], by: number): void =>
    s.commit(
      ids.map((id): Edit => ({ op: 'updateClip', id, patch: { start: s.get().clips[id].start + by } })),
    );

  /** How far apart picture and sound are in their media on the frames they share, at most. */
  const apartBy = (s: ProjectStore, picture: Clip, sound: Clip): number => {
    const p = s.get();
    const [v, a] = [p.clips[picture.id], p.clips[sound.id]];
    const from = Math.max(v.start, a.start);
    const to = Math.min(v.start + v.duration, a.start + a.duration);
    expect(to - from).toBeGreaterThan(0);
    let worst = 0;
    for (let f = from; f < to; f++) {
      worst = Math.max(worst, Math.abs(sourceTimeAt(v, f - v.start, p) - sourceTimeAt(a, f - a.start, p)));
    }
    return worst;
  };
  /** Picture and sound stand on the same frames and show the same media on each. */
  const inStep = (s: ProjectStore, picture: Clip, sound: Clip): void => {
    const { clips } = s.get();
    const [v, a] = [clips[picture.id], clips[sound.id]];
    expect([a.start, a.duration, a.ramp]).toEqual([v.start, v.duration, v.ramp]);
    expect(apartBy(s, picture, sound)).toBeLessThan(1e-9);
  };

  // A start at frame 0 and an in point at the start of the file are what a clip has when nothing
  // is written: taking a move or a trim back there removes the value, and the next change of the
  // ramp must not write one in its place.
  for (const at of [0, 60]) {
    for (const edit of ['move', 'trim of the head'] as const) {
      for (const linked of [true, false]) {
        for (const changes of [1, 2, 3, 'drag'] as const) {
          const what = `a ${edit} of ${linked ? 'picture and sound' : 'one clip'} at frame ${at}`;
          const after = changes === 'drag' ? 'a point was dragged' : `${changes} of its shapes were set`;
          it(`takes back ${what} after ${after}, and makes it again`, () => {
            const { a, b } = together();
            const { picture, sound, ids } = take(a, at, linked);
            if (changes === 'drag') shaped(a, picture.id, 'hero');
            const found = a.get().clips;

            if (edit === 'move') move(b, ids, 45);
            else b.commit(trimClips(b.get(), ids, 'start', 20));
            if (changes === 'drag') dragged(a, ids, picture.id);
            else for (const shape of SHAPES.slice(0, changes)) shaped(a, picture.id, shape);
            const made = a.get().clips;
            expect(made[picture.id].ramp).not.toEqual(found[picture.id].ramp);
            expect(made[picture.id].start).toBe(edit === 'move' ? at + 45 : at + 20);

            expect(b.undo()).toEqual(TAKEN);
            for (const s of [a, b]) {
              // Where it was, and playing from where it played, on the ramp that stands and at
              // the length that ramp has given it since.
              for (const id of ids) {
                const { start, sourceIn } = found[id];
                expect(s.get().clips[id]).toEqual({ ...made[id], start, sourceIn });
              }
              if (linked) inStep(s, picture, sound);
            }
            expect(b.redo()).toEqual(TAKEN);
            for (const s of [a, b]) expect(s.get().clips).toEqual(made);
            expect(new ProjectStore(a.doc).get()).toEqual(b.get());
          });
        }
      }
    }

    it(`makes a move again after the ramp was changed once more, for clips that stood at frame ${at}`, () => {
      for (const before of [[], ['hero'], ['hero', 'bullet']] as RampShape[][]) {
        const { a, b } = together();
        const { picture, sound, ids } = pair(a, at);
        move(b, ids, 45);
        for (const shape of before) shaped(a, picture.id, shape);
        expect(b.undo()).toEqual(TAKEN);
        for (const s of [a, b]) expect(ids.map((id) => s.get().clips[id].start)).toEqual([at, at]);
        shaped(a, picture.id, 'montage');
        shaped(a, picture.id, 'hero');
        expect(b.redo()).toEqual(TAKEN);
        for (const s of [a, b]) {
          expect(ids.map((id) => s.get().clips[id].start)).toEqual([at + 45, at + 45]);
          inStep(s, picture, sound);
        }
        shaped(a, picture.id, 'bullet');
        expect(b.undo()).toEqual(TAKEN);
        for (const s of [a, b]) {
          expect(ids.map((id) => s.get().clips[id].start)).toEqual([at, at]);
          inStep(s, picture, sound);
        }
      }
    });
  }

  it('makes a trim of the head again after the ramp was changed once more, for clips that began at the start of their file', () => {
    for (const linked of [true, false]) {
      const { a, b } = together();
      const { picture, sound, ids } = take(a, 30, linked);
      b.commit(trimClips(b.get(), ids, 'start', 20));
      expect(b.undo()).toEqual(TAKEN);
      shaped(a, picture.id, 'hero');
      expect(b.redo()).toEqual(TAKEN);
      for (const s of [a, b]) {
        for (const id of ids) expect(s.get().clips[id]).toMatchObject({ start: 50, sourceIn: 20 / 30 });
        if (linked) inStep(s, picture, sound);
      }
    }
  });

  it('takes back a move after a point of the ramp was dragged, and the drag is still one step for the one who made it', () => {
    const { a, b } = together();
    const { picture, sound, ids } = pair(a);
    shaped(a, picture.id, 'hero');
    move(b, ids, 45);
    const found = a.get().clips;
    dragged(a, ids, picture.id);
    const made = a.get().clips;
    expect(b.undo()).toEqual(TAKEN);
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b]) {
      expect(s.get().clips[picture.id]).toEqual({ ...found[picture.id], start: 0 });
      expect(s.get().clips[sound.id]).toEqual({ ...found[sound.id], start: 0 });
    }
    expect(a.redo()).toEqual(TAKEN);
    expect(b.redo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().clips).toEqual(made);
  });

  it('takes back a move after changes of the ramp that all arrived at once, written over on the way', () => {
    // Through a server, which keeps nothing of a value once it has been written over: whoever was
    // away gets what happened meanwhile as one update, with only the last value under each key.
    const server = new Y.Doc();
    const a = new ProjectStore();
    a.initIfEmpty({ name: 'Spring campaign' });
    const b = new ProjectStore();
    const sync = (s: ProjectStore): void => {
      Y.applyUpdate(server, Y.encodeStateAsUpdate(s.doc, Y.encodeStateVector(server)), 'remote');
      Y.applyUpdate(s.doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(s.doc)), 'remote');
    };
    const { picture, sound, ids } = pair(a);
    sync(a);
    sync(b);
    move(b, ids, 45);
    sync(b);
    sync(a);
    for (const shape of ['hero', 'bullet', 'hero'] as const) {
      shaped(a, picture.id, shape);
      sync(a);
    }
    sync(b);
    expect(b.undo()).toEqual(TAKEN);
    sync(b);
    sync(a);
    for (const s of [a, b]) {
      expect(ids.map((id) => s.get().clips[id].start)).toEqual([0, 0]);
      inStep(s, picture, sound);
    }
    expect(b.redo()).toEqual(TAKEN);
    sync(b);
    sync(a);
    for (const s of [a, b]) expect(ids.map((id) => s.get().clips[id].start)).toEqual([45, 45]);

    // Once somebody has moved the clips elsewhere, the step is passed over.
    move(a, ids, 25);
    sync(a);
    shaped(a, picture.id, 'bullet');
    sync(a);
    sync(b);
    expect(b.undo()).toEqual({ changed: false, dropped: 1 });
    expect(ids.map((id) => b.get().clips[id].start)).toEqual([70, 70]);
  });

  it('still passes over a move once someone has put the clips elsewhere and back', () => {
    const { a, b } = together();
    const { picture, ids } = pair(a);
    move(b, ids, 45);
    shaped(a, picture.id, 'hero');
    move(a, ids, 15);
    move(a, ids, -15);
    shaped(a, picture.id, 'bullet');
    expect(b.undo()).toEqual({ changed: false, dropped: 1 });
    for (const s of [a, b]) expect(ids.map((id) => s.get().clips[id].start)).toEqual([45, 45]);
  });

  it('takes back a move when a change of frame rate lies among the changes of the ramp', () => {
    for (const order of ['rate ramp', 'ramp rate', 'ramp rate ramp']) {
      const { a, b } = together();
      const c = new ProjectStore();
      connect(a.doc, c.doc);
      connect(b.doc, c.doc);
      const { picture, sound, ids } = pair(a);
      move(b, ids, 45);
      for (const change of order.split(' ')) {
        if (change === 'rate') c.commit(changeFrameRate(c.get(), 60, 1));
        else shaped(a, picture.id, a.get().clips[picture.id].ramp ? 'bullet' : 'hero');
      }
      expect(ids.map((id) => a.get().clips[id].start)).toEqual([90, 90]);
      expect(b.undo()).toEqual(TAKEN);
      for (const s of [a, b, c]) {
        expect(
          ids.map((id) => s.get().clips[id].start),
          order,
        ).toEqual([0, 0]);
        inStep(s, picture, sound);
      }
    }
  });

  /** People with the client ids given, who hear of each other only when `sync()` is called. */
  function people(ids: number[]) {
    const docs = ids.map((id) => {
      const doc = new Y.Doc();
      doc.clientID = id;
      return doc;
    });
    const stores = docs.map((doc) => new ProjectStore(doc));
    stores[0].initIfEmpty({ name: 'Spring campaign' });
    const sync = (): void => {
      for (let round = 0; round < 2; round++) {
        for (const from of docs) {
          for (const to of docs) {
            if (from !== to)
              Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
          }
        }
      }
    };
    sync();
    return { stores, sync };
  }

  it('takes back a move after two others set different ramps at the same moment, whoever of them won', () => {
    for (const order of [
      [1, 2, 3],
      [3, 2, 1],
      [1, 3, 2],
      [2, 3, 1],
      [2, 1, 3],
      [3, 1, 2],
    ]) {
      const { stores, sync } = people(order);
      const [a, b, c] = stores;
      const { picture, sound, ids } = pair(a);
      sync();
      move(b, ids, 45);
      sync();
      shaped(a, picture.id, 'hero');
      shaped(c, picture.id, 'bullet');
      sync();
      expect(ids.map((id) => b.get().clips[id].start)).toEqual([45, 45]);
      expect(b.undo()).toEqual(TAKEN);
      sync();
      for (const s of stores) {
        expect(
          ids.map((id) => s.get().clips[id].start),
          `${order}`,
        ).toEqual([0, 0]);
        inStep(s, picture, sound);
      }
      expect(a.get()).toEqual(c.get());
    }
  });

  it('keeps picture and sound together when they were moved while someone else, not having seen it, set a ramp', () => {
    for (const order of [
      [1, 2],
      [2, 1],
    ]) {
      for (const shapes of [['hero'], ['hero', 'bullet']] as RampShape[][]) {
        const { stores, sync } = people(order);
        const [a, b] = stores;
        const { picture, sound, ids } = pair(a);
        sync();
        move(b, ids, 45);
        for (const shape of shapes) shaped(a, picture.id, shape);
        sync();
        for (const s of stores) {
          expect(
            ids.map((id) => s.get().clips[id].start),
            `${order}`,
          ).toEqual([45, 45]);
          expect(s.get().clips[picture.id].ramp).toEqual(a.get().clips[picture.id].ramp);
          inStep(s, picture, sound);
        }
        expect(b.undo()).toEqual(TAKEN);
        sync();
        for (const s of stores) {
          expect(ids.map((id) => s.get().clips[id].start)).toEqual([0, 0]);
          inStep(s, picture, sound);
        }
      }
    }
  });

  it('keeps picture and sound in step when their head was trimmed while someone else, not having seen it, set a ramp', () => {
    for (const order of [
      [1, 2],
      [2, 1],
    ]) {
      const { stores, sync } = people(order);
      const [a, b] = stores;
      const { picture, sound, ids } = pair(a);
      sync();
      b.commit(trimClips(b.get(), ids, 'start', 20));
      shaped(a, picture.id, 'hero');
      const ramp = a.get().clips[picture.id].ramp;
      sync();
      for (const s of stores) {
        // The trim's start and in point on both, under the ramp; the length is that of one of the two.
        for (const id of ids) expect(s.get().clips[id]).toMatchObject({ start: 20, sourceIn: 20 / 30, ramp });
        expect([100, 121]).toContain(s.get().clips[picture.id].duration);
        inStep(s, picture, sound);
      }
    }
  });

  describe('for sound that starts before or after its picture', () => {
    /** A split edit: the sound begins `lead` frames before its picture (after it, when negative). */
    function split(s: ProjectStore, lead: number) {
      const v1 = tracksOf(s.get()).video[0];
      const a1 = tracksOf(s.get()).audio[0];
      const early = Math.max(0, lead);
      const late = Math.max(0, -lead);
      const picture = makeClip('video', v1.id, {
        start: 30 + early,
        duration: 120 - early,
        sourceIn: 1 + early / 30,
        linkId: 'take',
      });
      const sound = makeClip('audio', a1.id, {
        start: 30 + late,
        duration: 120 - late,
        sourceIn: 1 + late / 30,
        linkId: 'take',
      });
      s.commit([picture, sound].map((clip): Edit => ({ op: 'addClip', clip })));
      return { picture, sound, ids: [picture.id, sound.id] };
    }

    for (const lead of [15, -15]) {
      for (const shapes of [['hero'], ['hero', 'bullet'], ['rampUp']] as RampShape[][]) {
        it(`takes the sound back with its picture (${lead > 0 ? 'J' : 'L'} cut, ${shapes.join(' then ')})`, () => {
          const { a, b } = together();
          const { picture, sound, ids } = split(a, lead);
          expect(apartBy(a, picture, sound)).toBeLessThan(1e-9);
          move(b, ids, 45);
          for (const shape of shapes) shaped(a, picture.id, shape);
          const made = a.get().clips;
          expect(apartBy(a, picture, sound)).toBeLessThan(1e-9);
          // The ramp has placed the sound anew: where it starts is no longer what the move wrote.
          const placed = made[sound.id].start - made[picture.id].start;
          expect(made[picture.id].start).toBe(picture.start + 45);

          expect(b.undo()).toEqual(TAKEN);
          for (const s of [a, b]) {
            expect(s.get().clips[picture.id]).toEqual({ ...made[picture.id], start: picture.start });
            expect(s.get().clips[sound.id]).toEqual({ ...made[sound.id], start: picture.start + placed });
            expect(apartBy(s, picture, sound)).toBeLessThan(1e-9);
          }
          expect(b.redo()).toEqual(TAKEN);
          for (const s of [a, b]) expect(s.get().clips).toEqual(made);
          // Changed once more in between, and taken back again.
          shaped(a, picture.id, 'montage');
          const again = a.get().clips;
          expect(b.undo()).toEqual(TAKEN);
          for (const s of [a, b]) {
            expect(s.get().clips[picture.id].start).toBe(picture.start);
            expect(s.get().clips[sound.id].start - picture.start).toBe(
              again[sound.id].start - again[picture.id].start,
            );
            expect(apartBy(s, picture, sound)).toBeLessThan(1e-9);
          }
          expect(new ProjectStore(a.doc).get()).toEqual(b.get());
        });
      }
    }

    it('leaves a clip alone that the step had not moved, or that someone has put out of step since', () => {
      // The picture alone was moved: its sound, placed by the ramp since, is not the step's to move.
      const one = together();
      const first = split(one.a, 15);
      move(one.b, [first.picture.id], 45);
      shaped(one.a, first.picture.id, 'bullet');
      const stood = one.a.get().clips[first.sound.id];
      expect(one.b.undo()).toEqual(TAKEN);
      expect(one.a.get().clips[first.picture.id].start).toBe(first.picture.start);
      expect(one.a.get().clips[first.sound.id]).toBe(stood);

      // Both were moved, and then someone moved the sound by itself: on a ramp that does not end
      // at the speed it begins at, the two are then out of step.
      const two = together();
      const second = split(two.a, 15);
      move(two.b, second.ids, 45);
      shaped(two.a, second.picture.id, 'rampUp');
      move(two.a, [second.sound.id], 10);
      const parted = two.a.get().clips[second.sound.id];
      expect(two.b.undo()).toEqual(TAKEN);
      expect(two.b.get().clips[second.picture.id].start).toBe(second.picture.start);
      expect(two.b.get().clips[second.sound.id]).toEqual(parted);
    });

    it('leaves the sound where it is when it would have to begin before the timeline does', () => {
      // A J cut at the head of the timeline. Ramp up begins at half speed: the half second of
      // sound before the picture now takes a second, for which there is room only after the move.
      const { a, b } = together();
      const v1 = tracksOf(a.get()).video[0];
      const a1 = tracksOf(a.get()).audio[0];
      const picture = makeClip('video', v1.id, { start: 15, duration: 105, sourceIn: 1.5, linkId: 'take' });
      const sound = makeClip('audio', a1.id, { start: 0, duration: 120, sourceIn: 1, linkId: 'take' });
      a.commit([picture, sound].map((clip): Edit => ({ op: 'addClip', clip })));
      move(b, [picture.id, sound.id], 45);
      shaped(a, picture.id, 'rampUp');
      const made = a.get().clips;
      expect([made[picture.id].start, made[sound.id].start]).toEqual([60, 30]);
      expect(b.undo()).toEqual(TAKEN);
      for (const s of [a, b]) {
        expect(s.get().clips[picture.id].start).toBe(15);
        expect(s.get().clips[sound.id]).toEqual(made[sound.id]);
      }
      expect(b.redo()).toEqual(TAKEN);
      for (const s of [a, b]) expect(s.get().clips).toEqual(made);
    });

    it('moves nothing along for clips without a ramp', () => {
      const { a, b } = together();
      const { picture, sound, ids } = split(a, 15);
      move(b, ids, 45);
      // Someone trims the head of the sound: still in step, and no longer where the move put it.
      a.commit(trimClips(a.get(), [sound.id], 'start', 10));
      const stood = a.get().clips[sound.id];
      expect(b.undo()).toEqual(TAKEN);
      expect(b.get().clips[picture.id].start).toBe(picture.start);
      expect(b.get().clips[sound.id]).toEqual(stood);
    });
  });
});

describe('undo of a change of speed or ramp after someone else changed the ramp or the length of the clip', () => {
  /**
   * A take that plays seconds 1 to 5 of its file: its picture on V1 and its sound on A1, linked.
   * Nobody's step has put it there: an undo that finds nothing left of a step goes on to the step
   * before it, and here there is none.
   */
  function pair(s: ProjectStore, at = 0) {
    const v1 = tracksOf(s.get()).video[0];
    const a1 = tracksOf(s.get()).audio[0];
    const linkId = `take ${at}`;
    const picture = makeClip('video', v1.id, { start: at, duration: 120, sourceIn: 1, linkId });
    const sound = makeClip('audio', a1.id, { start: at, duration: 120, sourceIn: 1, linkId });
    s.commit(
      [picture, sound].map((clip): Edit => ({ op: 'addClip', clip })),
      { undoable: false },
    );
    return { picture, sound, ids: [picture.id, sound.id] };
  }
  const PASSED = { changed: false, dropped: 1 };

  const speed = (s: ProjectStore, ids: string[], to: number): void => s.commit(setSpeed(s.get(), ids, to));
  const ramped = (s: ProjectStore, id: string, ramp: RampPoint[] | null): void =>
    s.commit(setRamp(s.get(), [id], { ramps: { [id]: ramp } }));
  /** The ramp the clip is on, or a level one at the speed it has, over the stretch it plays. */
  const rampOf = (s: ProjectStore, id: string): RampPoint[] => {
    const p = s.get();
    const { in: from, out: to } = sourceSpan(p.clips[id], p);
    return p.clips[id].ramp ?? flatRamp(from, to, p.clips[id].speed)!;
  };
  /** A shape on the stretch the clip plays now, as the chips of the inspector set it. */
  const shaped = (s: ProjectStore, id: string, shape: RampShape): void => {
    const p = s.get();
    const { in: from, out: to } = sourceSpan(p.clips[id], p);
    ramped(s, id, shapeRamp(shape, from, to, p.clips[id].reverse));
  };
  /** "Custom": a level ramp at the speed the clip has. It leaves the clip as long as it is. */
  const custom = (s: ProjectStore, id: string): void => ramped(s, id, rampOf(s, id));
  /** "Add point": one more point, on the curve as it runs. It leaves the clip as long as it is. */
  const addPoint = (s: ProjectStore, id: string): void => {
    const p = s.get();
    const { in: from, out: to } = sourceSpan(p.clips[id], p);
    const ramp = rampOf(s, id);
    const m = Math.round((from + (to - from) * 0.37) * 1e6) / 1e6;
    const table = rampTable(ramp);
    ramped(s, id, tidyRamp([...ramp, { m, v: streamSpeed(table, mediaToStream(table, m)) }]));
  };
  /** The seconds of media each clip plays, from its first frame to the end of its last. */
  const plays = (s: ProjectStore, ids: string[]): number[][] =>
    ids.map((id) => {
      const p = s.get();
      const c = p.clips[id];
      return [sourceTimeAt(c, 0, p), sourceTimeAt(c, c.duration, p)].map((t) => Math.round(t * 1e3) / 1e3);
    });
  const WHOLE = [
    [1, 5],
    [1, 5],
  ];

  for (const first of ['a', 'b'] as const) {
    it(`leaves a speed and its length under a ramp that someone else set without changing the length (${first} set the speed)`, () => {
      for (const to of [1.25, 2, 0.5]) {
        const people = together();
        const [x, y] = first === 'a' ? [people.a, people.b] : [people.b, people.a];
        const { picture, sound, ids } = pair(people.a);
        speed(x, ids, to);
        custom(y, picture.id);
        // Twice over for one of the speeds: however many such edits follow, the length is still
        // the one the change of speed wrote.
        if (to === 2) addPoint(y, picture.id);
        const theirs = y.get().clips;
        for (const id of ids) expect(theirs[id]).toMatchObject({ speed: to, duration: 120 / to });
        expect(theirs[picture.id].ramp).toHaveLength(to === 2 ? 3 : 2);
        expect(theirs[sound.id].keepPitch).toBe(true);

        // Nothing of the change of speed is taken back, and whoever made it is told so.
        expect(x.undo()).toEqual(PASSED);
        for (const s of [x, y]) expect(s.get().clips).toEqual(theirs);
        expect(plays(x, ids)).toEqual(WHOLE);
        expect(x.canRedo).toBe(false);

        // The ramp taken off again leaves the speed, its length and the media the clips held.
        expect(y.undo()).toEqual(TAKEN);
        if (to === 2) expect(y.undo()).toEqual(TAKEN);
        for (const s of [x, y]) {
          for (const id of ids)
            expect(s.get().clips[id]).toMatchObject({ speed: to, ramp: null, duration: 120 / to });
          expect(s.get().clips[sound.id].keepPitch).toBe(true);
          expect(plays(s, ids)).toEqual(WHOLE);
        }
        expect(new ProjectStore(x.doc).get()).toEqual(y.get());
      }
    });
  }

  it('leaves a shape and its length under a point that someone else added or dragged', () => {
    for (const edit of ['a point added', 'a point dragged'] as const) {
      const { a, b } = together();
      const { picture, sound, ids } = pair(a);
      shaped(a, picture.id, 'bullet');
      const bullet = a.get().clips;
      expect(bullet[picture.id].duration).toBe(27);
      if (edit === 'a point added') addPoint(b, picture.id);
      else {
        // A drag that ends where the clip is as long as it was, in one step of history.
        const from = bullet[picture.id].ramp!;
        b.beginGesture();
        for (const dv of [0.2, 0.4, 0.2, 0.05, 0.01]) {
          const ramp = from.map((q, i) => (i === 2 ? { ...q, v: q.v + dv } : q));
          b.commit(setRamp(b.get(), [picture.id], { ramps: { [picture.id]: ramp } }), { merge: true });
        }
      }
      const theirs = b.get().clips;
      expect(theirs[picture.id].ramp).not.toEqual(bullet[picture.id].ramp);
      for (const id of ids) expect(theirs[id].duration).toBe(27);

      expect(a.undo()).toEqual(PASSED);
      for (const s of [a, b]) expect(s.get().clips).toEqual(theirs);
      // The clips still end within a frame of where their four seconds do.
      for (const [from, to] of plays(a, ids)) {
        expect(from).toBe(1);
        expect(to).toBeGreaterThan(4.9);
        expect(to).toBeLessThan(5.01);
      }
      expect(b.undo()).toEqual(TAKEN);
      for (const s of [a, b]) expect(s.get().clips).toEqual(bullet);
      expect(a.get().clips[sound.id].keepPitch).toBe(true);
      expect(new ProjectStore(a.doc).get()).toEqual(b.get());
    }
  });

  it('does not make a change of speed or ramp again under a ramp that someone else has set meanwhile', () => {
    for (const change of ['bullet', 1.25] as const) {
      const { a, b } = together();
      const { picture, ids } = pair(a);
      if (change === 'bullet') shaped(a, picture.id, change);
      else speed(a, ids, change);
      expect(a.undo()).toEqual(TAKEN);
      custom(b, picture.id);
      const theirs = b.get().clips;
      expect(theirs[picture.id]).toMatchObject({ speed: 1, duration: 120 });
      expect(theirs[picture.id].ramp).toHaveLength(2);

      expect(a.redo()).toEqual(PASSED);
      for (const s of [a, b]) expect(s.get().clips).toEqual(theirs);
      expect(plays(a, ids)).toEqual(WHOLE);
      expect(a.canUndo).toBe(false);
      // And off the ramp again: at the speed the clips had, whole.
      expect(b.undo()).toEqual(TAKEN);
      for (const s of [a, b]) {
        for (const id of ids)
          expect(s.get().clips[id]).toMatchObject({ speed: 1, ramp: null, duration: 120 });
      }
    }
  });

  it('holds for three people: the speed and the first ramp are passed over, the last ramp is taken back', () => {
    const { a, b } = together();
    const c = new ProjectStore();
    connect(a.doc, c.doc);
    connect(b.doc, c.doc);
    const { picture, ids } = pair(a);
    speed(a, ids, 2);
    custom(b, picture.id);
    const level = b.get().clips;
    addPoint(c, picture.id);
    const theirs = c.get().clips;
    expect(a.undo()).toEqual(PASSED);
    expect(b.undo()).toEqual(PASSED);
    for (const s of [a, b, c]) expect(s.get().clips).toEqual(theirs);
    expect(c.undo()).toEqual(TAKEN);
    for (const s of [a, b, c]) {
      expect(s.get().clips).toEqual(level);
      expect(plays(s, ids)).toEqual(WHOLE);
    }
  });

  for (const winner of ['a', 'b'] as const) {
    it(`gives the whole stretch back under a ramp that someone set at the same moment, not having seen the change (${winner} wins)`, () => {
      // A shape against a level ramp: the level ramp writes no length, so where it wins the clip
      // is on it at the length the shape gave, and plays the start of its stretch.
      const one = apart(winner);
      const first = pair(one.a);
      one.sync();
      shaped(one.a, first.picture.id, 'bullet');
      custom(one.b, first.picture.id);
      one.sync();
      const level = one.b.get().clips[first.picture.id].ramp!.length === 2;
      expect(level).toBe(winner === 'b');
      for (const id of first.ids) expect(one.a.get().clips[id].duration).toBe(27);
      // Whoever set the shape takes it back. Under the level ramp the length that comes back is
      // the one that ramp was set on: the clip plays what it played before either of them.
      expect(one.a.undo()).toEqual(TAKEN);
      one.sync();
      for (const s of [one.a, one.b]) {
        for (const id of first.ids) expect(s.get().clips[id].duration).toBe(120);
        expect(s.get().clips[first.picture.id].ramp).toEqual(level ? flatRamp(1, 5, 1) : null);
        expect(plays(s, first.ids)).toEqual(WHOLE);
      }

      // A speed against a level ramp at the speed the clip had: the same.
      const two = apart(winner);
      const second = pair(two.a);
      two.sync();
      speed(two.a, second.ids, 1.25);
      custom(two.b, second.picture.id);
      two.sync();
      expect(two.b.get().clips[second.picture.id]).toMatchObject({ speed: 1.25, duration: 96 });
      expect(two.b.get().clips[second.picture.id].ramp).toEqual(flatRamp(1, 5, 1));
      expect(two.a.undo()).toEqual(TAKEN);
      two.sync();
      for (const s of [two.a, two.b]) {
        for (const id of second.ids) expect(s.get().clips[id]).toMatchObject({ speed: 1, duration: 120 });
        expect(plays(s, second.ids)).toEqual(WHOLE);
      }
    });
  }

  it('does not put a ramp back on a length that someone else has set since', () => {
    // Made again after a trim of the head.
    const one = together();
    const first = pair(one.a);
    shaped(one.a, first.picture.id, 'bullet');
    expect(one.a.undo()).toEqual(TAKEN);
    one.b.commit(trimClips(one.b.get(), first.ids, 'start', 3));
    const trimmed = one.b.get().clips;
    expect(trimmed[first.picture.id]).toMatchObject({ start: 3, duration: 117, ramp: null });
    expect(one.a.redo()).toEqual(PASSED);
    for (const s of [one.a, one.b]) expect(s.get().clips).toEqual(trimmed);

    // One speed in place of a ramp, taken back after a third person trimmed the tail.
    const two = together();
    const c = new ProjectStore();
    connect(two.a.doc, c.doc);
    connect(two.b.doc, c.doc);
    const second = pair(two.a);
    shaped(two.a, second.picture.id, 'bullet');
    speed(two.b, second.ids, 1);
    c.commit(trimClips(c.get(), second.ids, 'end', -5));
    const shorter = c.get().clips;
    expect(shorter[second.picture.id]).toMatchObject({ ramp: null, duration: 113 });
    expect(two.b.undo()).toEqual(PASSED);
    for (const s of [two.a, two.b, c]) expect(s.get().clips).toEqual(shorter);

    // One shape after another, by one person, and a trim of the tail by the other.
    const three = together();
    const third = pair(three.a);
    shaped(three.a, third.picture.id, 'bullet');
    shaped(three.a, third.picture.id, 'hero');
    three.b.commit(trimClips(three.b.get(), third.ids, 'end', -1));
    const stands = three.b.get().clips;
    expect(stands[third.picture.id].duration).toBe(117);
    // Neither shape is the first person's to take back any more.
    expect(three.a.undo()).toEqual({ changed: false, dropped: 2 });
    for (const s of [three.a, three.b]) expect(s.get().clips).toEqual(stands);
    // The trim still is its maker's.
    expect(three.b.undo()).toEqual(TAKEN);
    expect(three.a.get().clips[third.picture.id].duration).toBe(118);
  });

  it('takes back the rest of a step, and makes it again, around the clip it leaves alone', () => {
    const { a, b } = together();
    const one = pair(a);
    const two = pair(a, 600);
    speed(a, [...one.ids, ...two.ids], 1.25);
    custom(b, one.picture.id);
    const theirs = b.get().clips;
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b]) {
      for (const id of one.ids) expect(s.get().clips[id]).toEqual(theirs[id]);
      for (const id of two.ids) expect(s.get().clips[id]).toMatchObject({ speed: 1, duration: 120 });
      expect(plays(s, [...one.ids, ...two.ids])).toEqual([...WHOLE, ...WHOLE]);
    }
    expect(a.redo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().clips).toEqual(theirs);
    expect(a.undo()).toEqual(TAKEN);
    expect(b.get().clips[two.picture.id]).toMatchObject({ speed: 1, duration: 120 });
    expect(b.get().clips[one.picture.id]).toEqual(theirs[one.picture.id]);
  });

  it('goes on to the step before, as for any step of which nothing is left', () => {
    const { a, b } = together();
    const { picture, ids } = pair(a);
    a.commit([{ op: 'setMarker', marker: marker(10) }]);
    speed(a, ids, 1.25);
    custom(b, picture.id);
    const theirs = b.get().clips;
    expect(a.undo()).toEqual({ changed: true, dropped: 1 });
    for (const s of [a, b]) {
      expect(s.get().markers).toEqual({});
      expect(s.get().clips).toEqual(theirs);
    }
    expect(a.redo()).toEqual(TAKEN);
    expect(b.get().markers).toEqual({ m1: marker(10) });
    expect(a.canRedo).toBe(false);
  });

  it('holds when someone has changed the frame rate in between', () => {
    for (const order of ['rate ramp', 'ramp rate']) {
      const { a, b } = together();
      const { picture, ids } = pair(a);
      speed(a, ids, 1.25);
      for (const change of order.split(' ')) {
        if (change === 'rate') b.commit(changeFrameRate(b.get(), 60, 1));
        else custom(b, picture.id);
      }
      const theirs = b.get().clips;
      expect(theirs[picture.id]).toMatchObject({ speed: 1.25, duration: 192 });
      expect(a.undo(), order).toEqual(PASSED);
      for (const s of [a, b]) expect(s.get().clips).toEqual(theirs);
      expect(plays(a, ids)).toEqual(WHOLE);
    }
  });

  it('changes nothing for one person: a speed, a level ramp on it, both taken back and made again', () => {
    const { a, b } = together();
    const { picture, ids } = pair(a);
    const found = a.get().clips;
    speed(a, ids, 1.25);
    const faster = a.get().clips;
    custom(a, picture.id);
    const level = a.get().clips;
    shaped(a, picture.id, 'bullet');
    const bullet = a.get().clips;
    for (const back of [level, faster, found]) {
      expect(a.undo()).toEqual(TAKEN);
      expect(a.get().clips).toEqual(back);
      expect(b.get().clips).toEqual(back);
    }
    for (const again of [faster, level, bullet]) {
      expect(a.redo()).toEqual(TAKEN);
      expect(a.get().clips).toEqual(again);
      expect(b.get().clips).toEqual(again);
    }
  });

  it('still gives a trimmed tail back under a ramp that someone else has set, and takes a ramp off a clip someone else has trimmed', () => {
    const one = together();
    const first = pair(one.a);
    one.a.commit(trimClips(one.a.get(), first.ids, 'end', -30));
    custom(one.b, first.picture.id);
    const level = one.b.get().clips[first.picture.id].ramp;
    expect(one.a.undo()).toEqual(TAKEN);
    for (const s of [one.a, one.b]) {
      for (const id of first.ids) expect(s.get().clips[id]).toMatchObject({ duration: 120 });
      expect(s.get().clips[first.picture.id].ramp).toEqual(level);
      expect(plays(s, first.ids)).toEqual(WHOLE);
    }
    expect(one.a.redo()).toEqual(TAKEN);
    expect(one.b.get().clips[first.picture.id]).toMatchObject({ duration: 90, ramp: level });

    // The ramp comes off and the other person's trim stays: the clip plays at one speed what is
    // left of its frames. Made again, it is on the ramp as that person left it.
    const two = together();
    const second = pair(two.a);
    shaped(two.a, second.picture.id, 'bullet');
    two.b.commit(trimClips(two.b.get(), second.ids, 'end', -2));
    const trimmed = two.b.get().clips;
    expect(two.a.undo()).toEqual(TAKEN);
    for (const s of [two.a, two.b])
      for (const id of second.ids) expect(s.get().clips[id]).toMatchObject({ ramp: null, duration: 25 });
    expect(two.a.redo()).toEqual(TAKEN);
    for (const s of [two.a, two.b]) expect(s.get().clips).toEqual(trimmed);
  });

  it('is not held to it where the length is not what comes back, or no ramp is left to see: what stays as it was', () => {
    // A speed alone, with a trim by someone else since: the speed goes back and the length is
    // the trimmer's, as it always was. At 100 % those frames are twice the media the clip held.
    const one = together();
    const first = pair(one.a);
    speed(one.a, first.ids, 0.5);
    one.b.commit(trimClips(one.b.get(), first.ids, 'end', -5));
    expect(one.a.undo()).toEqual(TAKEN);
    for (const id of first.ids) expect(one.b.get().clips[id]).toMatchObject({ speed: 1, duration: 235 });
    expect(plays(one.b, [first.picture.id])).toEqual([[1, 8.833]]);

    // A speed under a ramp that someone else set and that changed the length: the speed goes
    // back underneath, where it does not show, and is what the clip plays at once the ramp is
    // taken off, on the length the other speed gave.
    const three = together();
    const third = pair(three.a);
    speed(three.a, third.ids, 0.5);
    shaped(three.b, third.picture.id, 'hero');
    expect(three.a.undo()).toEqual(TAKEN);
    expect(three.b.get().clips[third.picture.id]).toMatchObject({ speed: 1, duration: 121 });
    expect(three.b.undo()).toEqual(TAKEN);
    expect(three.a.get().clips[third.picture.id]).toMatchObject({ speed: 1, ramp: null, duration: 240 });
    expect(plays(three.a, [third.picture.id])).toEqual([[1, 9]]);

    // "None" taken back after the speed under it was: the ramp comes back as it was, on the
    // length the clip has by now.
    const two = together();
    const second = pair(two.a);
    speed(two.a, second.ids, 1.25);
    custom(two.b, second.picture.id);
    ramped(two.b, second.picture.id, null);
    expect(two.a.undo()).toEqual(TAKEN);
    expect(plays(two.a, second.ids)).toEqual(WHOLE);
    expect(two.b.undo()).toEqual(TAKEN);
    expect(two.a.get().clips[second.picture.id]).toMatchObject({ speed: 1, duration: 120 });
    expect(two.a.get().clips[second.picture.id].ramp).toHaveLength(2);
    expect(plays(two.a, [second.picture.id])).toEqual([[1, 6]]);
    // Taken back once more, the clip is whole again.
    expect(two.b.undo()).toEqual(TAKEN);
    expect(plays(two.a, second.ids)).toEqual(WHOLE);
  });
});

describe('keep pitch, switched on by a change of speed', () => {
  /**
   * A take that neither of the two has put there: an undo that finds nothing left of a step goes
   * on to the step before it, and here there is none.
   */
  function pair(a: ProjectStore, init: Partial<Clip> = {}) {
    const v1 = tracksOf(a.get()).video[0];
    const a1 = tracksOf(a.get()).audio[0];
    const picture = makeClip('video', v1.id, { start: 0, duration: 120, linkId: 'take', ...init });
    const sound = makeClip('audio', a1.id, { start: 0, duration: 120, linkId: 'take', ...init });
    a.commit(
      [picture, sound].map((clip): Edit => ({ op: 'addClip', clip })),
      { undoable: false },
    );
    return { picture, sound };
  }

  const hero = shapeRamp('hero', 0, 4, false)!;
  const bullet = shapeRamp('bullet', 0, 4, false)!;
  const ramped = (s: ProjectStore, id: string, ramp: typeof hero | null): void =>
    s.commit(setRamp(s.get(), [id], { ramps: { [id]: ramp } }));
  const PASSED = { changed: false, dropped: 1 };

  it('is written by the change that switches it on and by no change of speed after it', () => {
    const { a, b } = together();
    const { picture, sound } = pair(a);
    const fields = (id: string): Y.Map<unknown> => a.doc.getMap('clips').get(id) as Y.Map<unknown>;
    const written: string[] = [];
    fields(picture.id).observe((event) => written.push(...event.keysChanged));
    fields(sound.id).observe((event) => written.push(...event.keysChanged));
    a.commit(setSpeed(a.get(), [sound.id], 1.25));
    expect(written.sort()).toEqual(['duration', 'keepPitch', 'speed']);
    written.length = 0;
    b.commit(setSpeed(b.get(), [sound.id], 1.5));
    ramped(b, sound.id, hero);
    expect(written).not.toContain('keepPitch');
    // And nothing at all for a clip that does not keep its pitch.
    written.length = 0;
    a.commit([{ op: 'updateClip', id: sound.id, patch: { keepPitch: false } }]);
    a.commit(setSpeed(a.get(), [picture.id, sound.id], 2));
    expect(written.filter((key) => key === 'keepPitch')).toHaveLength(1);
    expect(a.get().clips[sound.id].keepPitch).toBe(false);
  });

  it('stays on under the ramp someone else has set since, when the first change is taken back', () => {
    const { a, b } = together();
    const { picture, sound } = pair(a);
    ramped(a, picture.id, bullet);
    expect(a.get().clips[sound.id].keepPitch).toBe(true);
    ramped(b, picture.id, hero);
    const theirs = b.get().clips;
    expect(theirs[sound.id]).toMatchObject({ ramp: hero, keepPitch: true });

    // Nothing of the first change is left to take back, and the one who made it is told so.
    expect(a.undo()).toEqual(PASSED);
    for (const s of [a, b]) expect(s.get().clips).toEqual(theirs);
    // The one who set the ramp that stands takes it back: the first ramp again, at its own pitch.
    expect(b.undo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ ramp: bullet, keepPitch: true });
    expect(new ProjectStore(a.doc).get()).toEqual(b.get());
  });

  it('stays on under the speed someone else has set since, in whichever order the two take theirs back', () => {
    for (const first of ['a', 'b']) {
      const { a, b } = together();
      const { sound } = pair(a);
      a.commit(setSpeed(a.get(), [sound.id], 1.25));
      b.commit(setSpeed(b.get(), [sound.id], 1.5));
      if (first === 'a') {
        expect(a.undo()).toEqual(PASSED);
        for (const s of [a, b])
          expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.5, keepPitch: true });
        expect(b.undo()).toEqual(TAKEN);
      } else {
        expect(b.undo()).toEqual(TAKEN);
        for (const s of [a, b])
          expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.25, keepPitch: true });
        // The speed that stands again was put back by the other person, and is theirs.
        expect(a.undo()).toEqual(PASSED);
      }
      for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.25, keepPitch: true });
      expect(b.redo()).toEqual(TAKEN);
      for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.5, keepPitch: true });
    }
  });

  it('stays on when what is left of the step is taken back: a speed set on a clip of an older project, with a ramp set on it since', () => {
    const { a, b } = together();
    const { sound } = pair(a, { speed: 2, duration: 60 });
    a.commit(setSpeed(a.get(), [sound.id], 1.5));
    expect(a.get().clips[sound.id]).toMatchObject({ speed: 1.5, duration: 80, keepPitch: true });
    ramped(b, sound.id, hero);
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b])
      expect(s.get().clips[sound.id]).toMatchObject({ speed: 2, ramp: hero, keepPitch: true });
    expect(a.redo()).toEqual(TAKEN);
    for (const s of [a, b])
      expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.5, ramp: hero, keepPitch: true });
    // Left on, it is no step's to take back any more: it stays on when both have taken theirs
    // back, at the speed the clip had before, where its pitch followed the speed.
    expect(a.undo()).toEqual(TAKEN);
    expect(b.undo()).toEqual(TAKEN);
    for (const s of [a, b])
      expect(s.get().clips[sound.id]).toMatchObject({ speed: 2, ramp: null, keepPitch: true });
  });

  it('stays on when it was switched on by hand and someone else has set a speed since, and its old value is not put back', () => {
    const { a, b } = together();
    const { sound } = pair(a, { speed: 2, duration: 60 });
    a.commit([{ op: 'updateClip', id: sound.id, patch: { keepPitch: false } }], { undoable: false });
    a.commit([{ op: 'updateClip', id: sound.id, patch: { keepPitch: true } }]);
    b.commit(setSpeed(b.get(), [sound.id], 1.5));
    expect(a.undo()).toEqual(PASSED);
    for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.5, keepPitch: true });
  });

  for (const winner of ['a', 'b'] as const) {
    it(`stays on under the ramp that stands when two were set at the same moment and the other is taken back (${winner} wins)`, () => {
      const { a, b, sync } = apart(winner);
      const { picture, sound } = pair(a);
      sync();
      ramped(a, picture.id, bullet);
      ramped(b, picture.id, hero);
      sync();
      const [won, lost] = winner === 'a' ? [a, b] : [b, a];
      const stands = won.get().clips;
      expect(stands[sound.id]).toMatchObject({ ramp: winner === 'a' ? bullet : hero, keepPitch: true });
      expect(lost.undo()).toEqual(PASSED);
      sync();
      for (const s of [a, b]) expect(s.get().clips).toEqual(stands);
      // Taken back by the one whose ramp it is, nothing is left of either.
      expect(won.undo()).toEqual(TAKEN);
      sync();
      for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ ramp: null, keepPitch: null });
    });

    it(`stays off when it was switched off while someone else, not having seen it, set another speed (${winner} wins)`, () => {
      const { a, b, sync } = apart(winner);
      const { sound } = pair(a);
      a.commit(setSpeed(a.get(), [sound.id], 1.25));
      sync();
      a.commit([{ op: 'updateClip', id: sound.id, patch: { keepPitch: false } }]);
      b.commit(setSpeed(b.get(), [sound.id], 1.5));
      sync();
      for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.5, keepPitch: false });
      // The switch is still its maker's to take back.
      expect(a.undo()).toEqual(TAKEN);
      sync();
      for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ speed: 1.5, keepPitch: true });
    });
  }

  it('goes off again with the change that switched it on while the speed and the ramp are still that change left', () => {
    const { a, b } = together();
    const { picture, sound } = pair(a);
    ramped(a, picture.id, bullet);
    b.commit([{ op: 'updateClip', id: sound.id, patch: { volume: -6 } }]);
    ramped(a, picture.id, hero);
    expect(a.undo()).toEqual(TAKEN);
    expect(b.get().clips[sound.id]).toMatchObject({ ramp: bullet, keepPitch: true });
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b])
      expect(s.get().clips[sound.id]).toMatchObject({ ramp: null, keepPitch: null, volume: -6 });
    expect(a.redo()).toEqual(TAKEN);
    expect(b.get().clips[sound.id]).toMatchObject({ ramp: bullet, keepPitch: true });

    // A speed dragged in several steps of one gesture, and one set on a clip of an older project.
    const other = together();
    const old = pair(other.a, { speed: 2, duration: 60 });
    other.a.beginGesture();
    for (const speed of [1.8, 1.5, 1.2]) {
      const found = applyEdits(other.a.get(), [
        { op: 'updateClip', id: old.sound.id, patch: { speed: 2, duration: 60, keepPitch: null } },
      ]);
      other.a.commit(setSpeed(found, [old.sound.id], speed), { merge: true });
    }
    expect(other.b.get().clips[old.sound.id]).toMatchObject({ speed: 1.2, keepPitch: true });
    other.a.commit(setRamp(other.a.get(), [old.sound.id], { ramps: { [old.sound.id]: hero } }));
    expect(other.a.undo()).toEqual(TAKEN);
    expect(other.a.undo()).toEqual(TAKEN);
    for (const s of [other.a, other.b])
      expect(s.get().clips[old.sound.id]).toMatchObject({
        speed: 2,
        duration: 60,
        ramp: null,
        keepPitch: null,
      });
  });

  it('stays on under a speed that someone else set while the ramp was still being dragged', () => {
    const { a, b } = together();
    const { sound } = pair(a);
    a.beginGesture();
    a.commit(setRamp(a.get(), [sound.id], { ramps: { [sound.id]: bullet } }), { merge: true });
    b.commit([{ op: 'updateClip', id: sound.id, patch: { speed: 2 } }]);
    a.commit(setRamp(a.get(), [sound.id], { ramps: { [sound.id]: hero } }), { merge: true });
    expect(b.get().clips[sound.id]).toMatchObject({ ramp: hero, speed: 2, keepPitch: true });
    // The drag is taken back whole, and leaves the clip at the other person's speed, pitch kept.
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b])
      expect(s.get().clips[sound.id]).toMatchObject({ ramp: null, speed: 2, keepPitch: true });
  });

  it('goes off with the change that switched it on once the ramp someone else set has been taken off again', () => {
    const { a, b } = together();
    const { picture, sound } = pair(a);
    ramped(a, picture.id, bullet);
    ramped(b, picture.id, hero);
    ramped(b, picture.id, null);
    expect(a.get().clips[sound.id]).toMatchObject({ ramp: null, keepPitch: true });
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ ramp: null, keepPitch: null });
  });

  it('is not followed to a clip that was deleted and has come back: there it goes off under what someone else has set since', () => {
    // What undo and redo are left with after a deletion taken back in between, stated so that it
    // is not forgotten: the clip that comes back is another one in the document than the one
    // the step wrote to, and what stands under its speed and ramp is not looked for there.
    for (const [mine, theirs] of [
      ['speed', 'speed'],
      ['ramp', 'ramp'],
      ['speed', 'ramp'],
    ]) {
      const { a, b } = together();
      const { picture, sound } = pair(a);
      const ids = [picture.id, sound.id];
      if (mine === 'speed') a.commit(setSpeed(a.get(), ids, 1.25));
      else ramped(a, picture.id, bullet);
      a.commit(deleteClips(a.get(), ids));
      expect(a.undo()).toEqual(TAKEN);
      expect(b.get().clips[sound.id].keepPitch).toBe(true);
      if (theirs === 'speed') b.commit(setSpeed(b.get(), ids, 1.5));
      else ramped(b, picture.id, hero);
      const stands = b.get().clips;
      expect(a.undo()).toEqual(TAKEN);
      for (const s of [a, b]) {
        expect(s.get().clips[sound.id]).toMatchObject({
          ramp: stands[sound.id].ramp,
          duration: stands[sound.id].duration,
          keepPitch: null,
        });
      }
    }
  });

  it('is left as it was switched by hand: off through a change of speed, and on again when the switch is taken back', () => {
    const { a, b } = together();
    const { picture, sound } = pair(a);
    ramped(a, picture.id, bullet);
    a.commit([{ op: 'updateClip', id: sound.id, patch: { keepPitch: false } }]);
    ramped(b, picture.id, hero);
    expect(b.get().clips[sound.id]).toMatchObject({ ramp: hero, keepPitch: false });
    expect(a.undo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ ramp: hero, keepPitch: true });
    // Switched off again by the redo: that is the switch, made by hand, and not held back.
    expect(a.redo()).toEqual(TAKEN);
    for (const s of [a, b]) expect(s.get().clips[sound.id]).toMatchObject({ ramp: hero, keepPitch: false });
  });
});
