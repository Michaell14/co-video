import { describe, expect, it } from 'vitest';
import { applyEdits, DEFAULT_TEXT, emptyProject, makeClip, makeTrack, type Project } from '@tandem/core';
import { describeClip, describeSelection, spokenTime } from '../src/features/timeline/describe';

function project(): Project {
  const v1 = makeTrack('video', 0);
  const a1 = makeTrack('audio', 0);
  return applyEdits(emptyProject(), [
    { op: 'addTrack', track: { ...v1, id: 'v1' } },
    { op: 'addTrack', track: { ...a1, id: 'a1' } },
    {
      op: 'addClip',
      clip: makeClip('video', 'v1', { id: 'dusk', name: 'dusk.mp4', start: 60, duration: 100, linkId: 'l1' }),
    },
    {
      op: 'addClip',
      clip: makeClip('audio', 'a1', {
        id: 'dusk-sound',
        name: 'dusk.mp4',
        start: 60,
        duration: 100,
        linkId: 'l1',
      }),
    },
    {
      op: 'addClip',
      clip: makeClip('video', 'v1', { id: 'dawn', name: 'dawn.mp4', start: 160, duration: 30 }),
    },
    {
      op: 'addClip',
      clip: makeClip('text', 'v1', {
        id: 'title',
        start: 400,
        duration: 30,
        text: { ...DEFAULT_TEXT, content: 'Hello\nthere' },
      }),
    },
  ]);
}

describe('what the timeline says about clips', () => {
  it('reads a time as minutes, seconds and frames', () => {
    const { settings } = project();
    expect(spokenTime(0, settings)).toBe('0:00.00');
    expect(spokenTime(160, settings)).toBe('0:05.10');
    expect(spokenTime(30 * 75, settings)).toBe('1:15.00');
    expect(spokenTime(30 * 3725 + 2, settings)).toBe('1:02:05.02');
  });

  it('names a clip by its media or its text, its track and its span, and says what is wrong with it', () => {
    const p = project();
    expect(describeClip(p.clips.dusk, 'V1', p.settings)).toBe('dusk.mp4, V1, 0:02.00 to 0:05.10');
    expect(describeClip(p.clips.title, 'V1', p.settings)).toBe('Hello there, V1, 0:13.10 to 0:14.10');
    expect(
      describeClip({ ...p.clips.dawn, enabled: false }, 'V1', p.settings, {
        offline: true,
        overlapping: true,
      }),
    ).toBe('dawn.mp4, V1, 0:05.10 to 0:06.10, disabled, media offline, overlaps another clip');
  });

  it('says of a clip that cannot be decoded whether it is the file, the browser or the address', () => {
    const p = project();
    const said = (id: string, gap?: 'absent' | 'insecure' | null) =>
      describeClip(p.clips[id], 'V1', p.settings, { undecodable: true, gap }).split(', ').pop();
    expect(said('dusk')).toBe('cannot be decoded in this browser');
    expect(said('dusk', null)).toBe('cannot be decoded in this browser');
    expect(said('dusk', 'absent')).toBe('no video decoder in this browser');
    expect(said('dusk-sound', 'absent')).toBe('no audio decoder in this browser');
    expect(said('dusk', 'insecure')).toBe('needs HTTPS to play');
    expect(said('dusk-sound', 'insecure')).toBe('needs HTTPS to play');
    // What the page lacks is no trouble of a clip that decodes.
    expect(describeClip(p.clips.dusk, 'V1', p.settings, { gap: 'absent' })).toBe(
      'dusk.mp4, V1, 0:02.00 to 0:05.10',
    );
  });

  it('describes one selected clip, a clip with what it is linked to, and counts anything else', () => {
    const p = project();
    expect(describeSelection(p, [])).toBe('No clip selected');
    expect(describeSelection(p, ['dawn'])).toBe('dawn.mp4, V1, 0:05.10 to 0:06.10');
    // Whichever of a linked pair comes first in the selection, the picture is what is named.
    expect(describeSelection(p, ['dusk-sound', 'dusk'])).toBe(
      'dusk.mp4, V1, 0:02.00 to 0:05.10, with its linked clip',
    );
    expect(describeSelection(p, ['dusk', 'dusk-sound', 'dawn'])).toBe('3 clips selected');
    expect(describeSelection(p, ['gone'])).toBe('No clip selected');
  });
});
