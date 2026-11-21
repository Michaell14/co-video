import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEdits,
  emptyProject,
  makeClip,
  makeTrack,
  mediaAt,
  type Clip,
  type Project,
  type RampPoint,
} from '@tandem/core';
import type { AudioProblem } from '@tandem/engine';
import { soundLossChip, soundLossNotice, soundLossSpoken } from '../src/features/library/fault';
import { TimelineMedia } from '../src/features/timeline/mediaCache';
import { gravest, SoundLosses } from '../src/features/timeline/soundLoss';

const CAUSE = 'EncodingError: Decoding error.';

/** Thirty frames a second; on A1 the clip `take` of the file `file`, from 0:02 to 0:08. */
function project(clip: Partial<Clip> = {}): Project {
  return applyEdits(emptyProject(), [
    { op: 'addTrack', track: { ...makeTrack('audio', 0), id: 'a1' } },
    {
      op: 'addClip',
      clip: makeClip('audio', 'a1', {
        id: 'take',
        name: 'take.mp4',
        assetId: 'file',
        start: 60,
        duration: 180,
        ...clip,
      }),
    },
  ]);
}

const change = (p: Project, patch: Partial<Clip>): Project =>
  applyEdits(p, [{ op: 'updateClip', id: 'take', patch }]);

/** What the mixer says of `take` when sound is lost from `at` (seconds on the timeline). */
const lost = (at: number | undefined, how: AudioProblem['lost'] = 'stretch'): AudioProblem => ({
  clipId: 'take',
  assetId: 'file',
  reason: 'decode-error',
  lost: how,
  at,
  cause: CAUSE,
});

describe('sound the preview played a clip without', () => {
  it('is kept by clip: what kind, from which frame, and what the decoder said', () => {
    const p = project();
    const losses = new SoundLosses();
    expect(losses.of(p.clips.take, p)).toEqual([]);
    // Packet 60 of a file at 44.1 kHz, in a clip that begins two seconds in.
    expect(losses.note(lost(2 + (59 * 1024) / 44100), p)).toBe(true);
    expect(losses.of(p.clips.take, p)).toEqual([{ lost: 'stretch', frame: 101, cause: CAUSE }]);
  });

  it('is one of a kind for a clip, however often it is played and from wherever', () => {
    const p = project();
    const losses = new SoundLosses();
    expect([lost(3.4), lost(3.4), lost(3.4)].map((problem) => losses.note(problem, p))).toEqual([
      true,
      false,
      false,
    ]);
    // A second stretch further on, and the first one met again by a play that began inside it.
    expect(losses.note(lost(6.2), p)).toBe(false);
    expect(losses.note(lost(3.45), p)).toBe(false);
    expect(losses.of(p.clips.take, p)).toEqual([{ lost: 'stretch', frame: 102, cause: CAUSE }]);
    // An earlier one is where the clip first falls silent.
    expect(losses.note({ ...lost(2.5), cause: 'another' }, p)).toBe(true);
    expect(losses.of(p.clips.take, p)).toEqual([{ lost: 'stretch', frame: 75, cause: 'another' }]);
    // Sound that stops for good is another kind, and the graver one.
    expect(gravest(losses.of(p.clips.take, p))).toEqual({ lost: 'stretch', frame: 75, cause: 'another' });
    expect(losses.note(lost(7, 'rest'), p)).toBe(true);
    expect(losses.note(lost(7, 'rest'), p)).toBe(false);
    expect(losses.of(p.clips.take, p)).toEqual([
      { lost: 'stretch', frame: 75, cause: 'another' },
      { lost: 'rest', frame: 210, cause: CAUSE },
    ]);
    expect(gravest(losses.of(p.clips.take, p))).toEqual({ lost: 'rest', frame: 210, cause: CAUSE });
    expect(gravest([])).toBeNull();
  });

  it('takes a play that entered the clip part-way and got nothing for the rest of the clip', () => {
    const p = project();
    const losses = new SoundLosses();
    expect(losses.note(lost(5, 'all'), p)).toBe(true);
    expect(losses.of(p.clips.take, p)).toEqual([{ lost: 'rest', frame: 150, cause: CAUSE }]);
  });

  it('keeps nothing of a file that is missing or has no decoder, of a clip it does not know, or of the clip’s very end', () => {
    const p = project();
    const losses = new SoundLosses();
    for (const reason of ['missing', 'unreadable', 'undecodable'] as const)
      expect(losses.note({ clipId: 'take', assetId: 'file', reason }, p)).toBe(false);
    expect(losses.note({ ...lost(3), clipId: 'gone' }, p)).toBe(false);
    expect(losses.note({ ...lost(3), assetId: 'another' }, p)).toBe(false);
    // Trouble where the clip ends, or behind its end, is not the clip's.
    expect(losses.note(lost(8), p)).toBe(false);
    expect(losses.note(lost(9.5), p)).toBe(false);
    expect(losses.of(p.clips.take, p)).toEqual([]);
  });

  it('is a place in the file: it follows a clip that is moved, slipped or played at another speed', () => {
    const p = project();
    const losses = new SoundLosses();
    losses.note(lost(3.4), p);
    const frame = (q: Project) => losses.of(q.clips.take, q).map((gap) => gap.frame);
    expect(frame(p)).toEqual([102]);
    expect(frame(change(p, { start: 90 }))).toEqual([132]);
    // 1.4 s into the file is 0.9 s into a clip that begins half a second in, and 0.7 s at double speed.
    expect(frame(change(p, { sourceIn: 0.5 }))).toEqual([87]);
    expect(frame(change(p, { speed: 2, duration: 90 }))).toEqual([81]);
    // All of them still play the place, so the project moving on changes nothing.
    expect(losses.keep(change(p, { start: 90, sourceIn: 0.5 }))).toBe(false);
  });

  it('is not said of a clip that no longer plays the place, and is forgotten once the project has moved on', () => {
    const p = project();
    const losses = new SoundLosses();
    losses.note(lost(3.4), p);
    losses.note(lost(7, 'rest'), p);
    // Cut short before the first place, or begun behind it: a drag that has not been let go yet.
    const short = change(p, { duration: 30 });
    const late = change(p, { sourceIn: 2, duration: 120 });
    expect(losses.of(short.clips.take, short)).toEqual([]);
    expect(losses.of(late.clips.take, late)).toEqual([{ lost: 'rest', frame: 150, cause: CAUSE }]);
    expect(losses.of(p.clips.take, p)).toHaveLength(2);
    // Let go: what the clip does not play any more is gone, also when the edit is taken back.
    expect(losses.keep(late)).toBe(true);
    expect(losses.of(p.clips.take, p)).toEqual([{ lost: 'rest', frame: 210, cause: CAUSE }]);
    expect(losses.keep(short)).toBe(true);
    expect(losses.of(p.clips.take, p)).toEqual([]);
    expect(losses.keep(p)).toBe(false);
  });

  it('is forgotten with the clip, with the file the clip was of, and when the clip is turned round', () => {
    const p = project();
    const gone = applyEdits(p, [{ op: 'removeClip', id: 'take' }]);
    const other = change(p, { assetId: 'another' });
    const turned = change(p, { reverse: true });
    for (const next of [gone, other, turned]) {
      const losses = new SoundLosses();
      losses.note(lost(3.4), p);
      if (next.clips.take) expect(losses.of(next.clips.take, next)).toEqual([]);
      expect(losses.keep(next)).toBe(true);
      expect(losses.of(p.clips.take, p)).toEqual([]);
    }
    const losses = new SoundLosses();
    losses.note(lost(3.4), p);
    expect(losses.forgetAsset('another')).toBe(false);
    expect(losses.forgetAsset('file')).toBe(true);
    expect(losses.of(p.clips.take, p)).toEqual([]);
  });

  it('is, on a clip that is on a speed ramp, the place in the file the clip plays at that moment', () => {
    // From half speed to double speed over the first ten seconds of the file.
    const ramp: RampPoint[] = [
      { m: 0, v: 0.5 },
      { m: 10, v: 2 },
    ];
    const p = project({ ramp, sourceIn: 1, duration: 150 });
    const take = p.clips.take;
    const frame = (q: Project, losses: SoundLosses) => losses.of(q.clips.take, q).map((gap) => gap.frame);
    // Wherever in the clip the silence falls, it is marked on the frame it fell on.
    for (const f of [0, 1, 29, 75, 76, 133, 149]) {
      const losses = new SoundLosses();
      expect(losses.note(lost((60 + f) / 30), p)).toBe(true);
      expect(frame(p, losses)).toEqual([60 + f]);
    }
    const losses = new SoundLosses();
    losses.note(lost(2 + 75 / 30), p);
    // The place is the one the ramp gives: half-way through a clip that gathers speed, well short
    // of the middle of what it plays, where a clip at the average speed would be.
    const m = mediaAt(take, 75, p);
    expect((1 + mediaAt(take, 150, p)) / 2 - m).toBeGreaterThan(0.5);
    // Taken off its ramp, the clip plays that second of its file at another frame.
    const plain = change(p, { ramp: null, duration: 600 });
    expect(frame(plain, losses)).toEqual([60 + Math.floor((m - 1) * 30 + 1e-6)]);
    expect(frame(plain, losses)).not.toEqual([135]);
    // A trim of the head moves the window and leaves the ramp: the mark stays on its frame.
    const trimmed = change(p, { start: 90, duration: 120, sourceIn: mediaAt(take, 30, p) });
    expect(frame(trimmed, losses)).toEqual([135]);
    expect(losses.keep(trimmed)).toBe(false);
    // Another ramp over the same media plays the place at another moment.
    const slower = change(p, { ramp: [ramp[0], { m: 10, v: 1 }] });
    expect(frame(slower, losses)[0]).toBeGreaterThan(135);
    // Cut short before the place, or begun behind it, the clip no longer plays it. Cut on the
    // very frame the silence fell on, the place is the second piece's, at its first frame.
    const short = change(p, { duration: 75 });
    const rest = change(p, { start: 135, duration: 75, sourceIn: m });
    const late = change(p, { start: 136, duration: 74, sourceIn: mediaAt(take, 76, p) });
    expect(frame(short, losses)).toEqual([]);
    expect(frame(rest, losses)).toEqual([135]);
    expect(frame(late, losses)).toEqual([]);
    expect(frame(change(p, { duration: 76 }), losses)).toEqual([135]);
    expect(losses.keep(late)).toBe(true);
    expect(frame(p, losses)).toEqual([]);
  });

  it('has no place for a clip that plays backwards, of which the mixer cannot say where', () => {
    const p = project({ reverse: true });
    const losses = new SoundLosses();
    expect(losses.note(lost(undefined), p)).toBe(true);
    expect(losses.note(lost(undefined), p)).toBe(false);
    expect(losses.of(p.clips.take, p)).toEqual([{ lost: 'stretch', frame: null, cause: CAUSE }]);
    // Wherever the clip is taken, it is the same clip played the same way round.
    expect(losses.keep(change(p, { start: 0, sourceIn: 1, duration: 60 }))).toBe(false);
    // On a ramp as at one speed.
    const ramp: RampPoint[] = [
      { m: 0, v: 0.5 },
      { m: 10, v: 2 },
    ];
    const ramped = project({ reverse: true, ramp });
    const heard = new SoundLosses();
    expect(heard.note(lost(undefined), ramped)).toBe(true);
    expect(heard.of(ramped.clips.take, ramped)).toEqual([{ lost: 'stretch', frame: null, cause: CAUSE }]);
  });

  it('is said in a word or two on the clip, in a phrase where the clip is read out, and in a sentence beside it', () => {
    expect(soundLossChip('stretch')).toBe('Sound gap');
    expect(soundLossChip('rest')).toBe('Sound stops');
    expect(soundLossSpoken('stretch')).toBe('a stretch of its sound could not be decoded');
    expect(soundLossSpoken('rest')).toBe('its sound stopped decoding part-way through');
    expect(soundLossSpoken('stretch', '0:01.11')).toBe(
      'a stretch of its sound from 0:01.11 could not be decoded',
    );
    expect(soundLossSpoken('rest', '0:04.00')).toBe('its sound stopped decoding at 0:04.00');
    expect(soundLossNotice('stretch')).toBe(
      'A stretch of the sound of this clip could not be decoded and is silent.',
    );
    expect(soundLossNotice('rest')).toBe(
      'The sound of this clip stopped decoding part-way through and is silent from there.',
    );
    // Beside more than one clip, the clip is named.
    expect(soundLossNotice('stretch', 'take.mp4')).toBe(
      'A stretch of the sound of “take.mp4” could not be decoded and is silent.',
    );
    expect(soundLossNotice('rest', 'take.mp4')).toBe(
      'The sound of “take.mp4” stopped decoding part-way through and is silent from there.',
    );
  });
});

describe('what the timeline’s media knows of sound lost in the preview', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tells whoever shows the clip once, whatever the number of plays, and forgets when the file is read anew', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const media = new TimelineMedia(async () => null);
    const p = project();
    let told = 0;
    media.subscribeFaults(() => told++);
    const version = media.getFaultsVersion();
    for (let play = 0; play < 3; play++) media.heard(lost(3.4), p);
    expect(told).toBe(1);
    expect(media.getFaultsVersion()).toBe(version + 1);
    expect(media.soundLost(p.clips.take, p)).toEqual([{ lost: 'stretch', frame: 102, cause: CAUSE }]);
    // The project moving on without touching the clip is no news.
    media.follow(change(p, { start: 90 }));
    expect(told).toBe(1);

    // Another file's bytes moved: nothing to do with this clip. Its own: read anew, so forgotten.
    media.refresh('another');
    expect(told).toBe(1);
    media.refresh('file');
    expect(told).toBe(2);
    expect(media.soundLost(p.clips.take, p)).toEqual([]);

    // Still true when the clip is played again; then the clip goes.
    media.heard(lost(3.4), p);
    expect(media.soundLost(p.clips.take, p)).toHaveLength(1);
    media.follow(applyEdits(p, [{ op: 'removeClip', id: 'take' }]));
    expect(told).toBe(4);
    expect(media.soundLost(p.clips.take, p)).toEqual([]);
    media.dispose();
  });
});
