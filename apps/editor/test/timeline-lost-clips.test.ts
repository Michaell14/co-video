import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { makeClip, ProjectStore, removeTrack, tracksOf, trackLabel, addTrack } from '@tandem/core';
import { discardEdits, restoreEdits } from '../src/features/timeline/lostClips';

/** Two people in one project who exchange what they did only when `sync` is called. */
function pair() {
  const a = new ProjectStore();
  a.initIfEmpty();
  const b = new ProjectStore();
  const sync = () => {
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'remote');
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'remote');
  };
  sync();
  return { a, b, sync };
}

/**
 * A adds a picture and a sound track and removes them again while B, who has not heard of the
 * removal yet, puts clips on them: two on the picture track, one on the sound track.
 */
function lost() {
  const { a, b, sync } = pair();
  const video = addTrack(a.get(), 'video');
  a.commit(video.edits);
  const audio = addTrack(a.get(), 'audio');
  a.commit(audio.edits);
  sync();
  a.commit([...removeTrack(a.get(), video.trackId), ...removeTrack(a.get(), audio.trackId)]);
  const clips = [
    makeClip('video', video.trackId, { start: 100, duration: 50 }),
    makeClip('video', video.trackId, { start: 150, duration: 30 }),
    makeClip('audio', audio.trackId, { start: 100, duration: 80 }),
  ];
  b.commit(clips.map((clip) => ({ op: 'addClip', clip })));
  sync();
  return { a, b, sync, clips };
}

const where = (s: ProjectStore): string[] =>
  Object.values(s.get().clips)
    .map((c) => `${trackLabel(s.get(), s.get().tracks[c.trackId])}:${c.start}+${c.duration}`)
    .sort();

describe('clips whose track was removed as they were placed', () => {
  it('are in the document and on no track, for both people', () => {
    const { a, b, clips } = lost();
    for (const s of [a, b]) {
      expect(Object.keys(s.get().clips)).toEqual([]);
      expect(
        s
          .hiddenClips()
          .map((c) => c.id)
          .sort(),
      ).toEqual(clips.map((c) => c.id).sort());
    }
  });

  it('come back on a new track of their kind, together where they were together, as one undo step', () => {
    const { a, b, sync } = lost();
    const before = { video: tracksOf(b.get()).video.length, audio: tracksOf(b.get()).audio.length };
    b.commit(restoreEdits(b.get(), b.hiddenClips()));
    sync();
    for (const s of [a, b]) {
      expect(s.hiddenClips()).toEqual([]);
      expect(tracksOf(s.get()).video).toHaveLength(before.video + 1);
      expect(tracksOf(s.get()).audio).toHaveLength(before.audio + 1);
      const top = `V${before.video + 1}`;
      const last = `A${before.audio + 1}`;
      expect(where(s)).toEqual([`${last}:100+80`, `${top}:100+50`, `${top}:150+30`]);
    }
    b.undo();
    sync();
    for (const s of [a, b]) {
      expect(Object.keys(s.get().clips)).toEqual([]);
      expect(s.hiddenClips()).toHaveLength(3);
      expect(tracksOf(s.get()).video).toHaveLength(before.video);
    }
  });

  it('are gone for good when discarded', () => {
    const { a, b, sync } = lost();
    a.commit(discardEdits(a.hiddenClips()));
    sync();
    for (const s of [a, b]) {
      expect(s.hiddenClips()).toEqual([]);
      expect(Object.keys(s.get().clips)).toEqual([]);
    }
  });
});
