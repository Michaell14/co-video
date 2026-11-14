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
  overlappingClips,
  placeClips,
  rippleDelete,
  splitClips,
  tracksOf,
  trimClips,
} from '../src';
import type { Clip, Edit, Marker } from '../src';
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
