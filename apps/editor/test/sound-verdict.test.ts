import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSET_DEFAULTS, applyEdits, emptyProject, makeClip, makeTrack, type Project } from '@tandem/core';
import type { AudioProblem, SoundTrouble } from '@tandem/engine';
import { TimelineMedia } from '../src/features/timeline/mediaCache';

const CAUSE = 'EncodingError: The given encoding is not supported.';

/** What the fake file's sound gives when its waveform reads it: nothing at all, or some sound. */
const file = { sound: 'none' as 'none' | 'some', reads: 0 };

vi.mock('@tandem/engine', async (original) => {
  const real = await original<typeof import('@tandem/engine')>();
  class Library {
    async get(assetId: string) {
      return { assetId, audio: {}, audioDecodable: true, audioStart: 0, video: null, videoDecodable: false };
    }
    invalidate() {}
    dispose() {}
  }
  class Sound {
    async *buffers(_from: undefined, _to: undefined, report: (trouble: SoundTrouble) => void) {
      file.reads++;
      // Read a moment later, as a decoder does.
      await new Promise((done) => setTimeout(done, 5));
      if (file.sound === 'none') return report({ lost: 'all', from: 0, cause: CAUSE });
      const samples = new Float32Array(1024).fill(0.5);
      yield {
        buffer: { sampleRate: 44100, numberOfChannels: 1, length: 1024, getChannelData: () => samples },
        timestamp: 0,
        duration: 1024 / 44100,
      };
      report({ lost: 'rest', from: 1024 / 44100, cause: CAUSE });
    }
  }
  return { ...real, MediaLibrary: Library, Sound };
});

/** The file `file`, of six seconds, and its sound on A1 as the clip `take`, from 0:02. */
function project(): Project {
  return applyEdits(emptyProject(), [
    {
      op: 'addAsset',
      asset: { ...ASSET_DEFAULTS, id: 'file', name: 'take.mp4', kind: 'video', duration: 6 },
    },
    { op: 'addTrack', track: { ...makeTrack('audio', 0), id: 'a1' } },
    {
      op: 'addClip',
      clip: makeClip('audio', 'a1', {
        id: 'take',
        name: 'take.mp4',
        assetId: 'file',
        start: 60,
        duration: 180,
      }),
    },
  ]);
}

/** What the preview's mixer says of `take` when nothing of what it played decoded. */
const none: AudioProblem = {
  clipId: 'take',
  assetId: 'file',
  reason: 'decode-error',
  lost: 'all',
  at: 2,
  cause: CAUSE,
};

describe('a clip of which the preview heard nothing decode', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    file.reads = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is said to be the file’s doing when its waveform finds none of the file’s sound decodes, and is not marked', async () => {
    file.sound = 'none';
    const media = new TimelineMedia(async () => null);
    const p = project();
    let told = 0;
    media.subscribeFaults(() => told++);
    // Played before the timeline has drawn its waveform: nothing is said until that is read.
    media.heard(none, p);
    media.heard(none, p);
    expect(media.soundLost(p.clips.take, p)).toEqual([]);
    expect(media.fault('file')).toBeNull();
    expect(told).toBe(0);
    // The preview's report has the waveform read, once.
    await vi.waitFor(() => expect(media.wave.done('file')).toBe(true));
    expect(file.reads).toBe(1);
    expect(media.fault('file')).toEqual({ picture: false, sound: true, cause: CAUSE });
    expect(media.soundLost(p.clips.take, p)).toEqual([]);
    // And once it is known, a play adds nothing to it.
    media.heard(none, p);
    expect(media.soundLost(p.clips.take, p)).toEqual([]);
    expect(told).toBe(1);
    media.dispose();
  });

  it('is marked as the clip’s, once the waveform has found that some of the file decodes', async () => {
    file.sound = 'some';
    const media = new TimelineMedia(async () => null);
    const p = project();
    media.heard(none, p);
    expect(media.soundLost(p.clips.take, p)).toEqual([]);
    await vi.waitFor(() => expect(media.soundLost(p.clips.take, p)).toHaveLength(1));
    expect(media.soundLost(p.clips.take, p)).toEqual([{ lost: 'rest', frame: 60, cause: CAUSE }]);
    expect(media.fault('file')).toBeNull();
    // From then on what a play hears is said at once, a stretch as well.
    media.heard({ ...none, lost: 'stretch', at: 3 }, p);
    expect(media.soundLost(p.clips.take, p).map((gap) => gap.lost)).toEqual(['stretch', 'rest']);
    expect(file.reads).toBe(1);
    media.dispose();
  });

  it('is forgotten with what was learnt of its file when the file is read anew', async () => {
    file.sound = 'some';
    const media = new TimelineMedia(async () => null);
    const p = project();
    media.heard(none, p);
    media.refresh('file');
    await vi.waitFor(() => expect(media.wave.done('file')).toBe(true));
    expect(media.soundLost(p.clips.take, p)).toEqual([]);
    media.dispose();
  });
});
