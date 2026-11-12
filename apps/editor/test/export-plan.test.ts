import { describe, expect, it } from 'vitest';
import type { ExportWarning } from '@tandem/engine';
import { groupProblems, hasUnseen, usableCodec } from '../src/features/export/plan';

const warning = (clipId: string, assetId: string, frame: number, init: Partial<ExportWarning> = {}) =>
  ({
    clipId,
    assetId,
    part: 'video',
    reason: 'missing',
    frame,
    message: `“${assetId}” is not on this device or the server, so it is missing from the export.`,
    ...init,
  }) satisfies ExportWarning;

describe('usableCodec', () => {
  it('keeps the wanted codec where the browser can encode it', () => {
    expect(usableCodec('avc', ['avc', 'vp9'])).toBe('avc');
  });

  it('falls back to the first supported codec, never to one that is not', () => {
    // A preset asking for H.264 on an export that only 10-bit encoders can make.
    expect(usableCodec('avc', ['hevc', 'vp9', 'av1'])).toBe('hevc');
    expect(usableCodec('av1', ['vp9'])).toBe('vp9');
  });

  it('has no codec while the encoders are unknown or when there is none', () => {
    expect(usableCodec('avc', null)).toBeNull();
    expect(usableCodec('avc', [])).toBeNull();
  });
});

describe('groupProblems', () => {
  it('gathers the clips that share a file and a fault under one sentence, in timeline order', () => {
    const groups = groupProblems([
      warning('c3', 'beach.mp4', 300),
      warning('c1', 'holiday.mp4', 40),
      warning('c2', 'beach.mp4', 120),
      warning('c2', 'beach.mp4', 120),
    ]);
    expect(groups.map((g) => [g.message.slice(1, 11), g.places])).toEqual([
      ['holiday.mp', [{ clipId: 'c1', frame: 40 }]],
      [
        'beach.mp4”',
        [
          { clipId: 'c2', frame: 120 },
          { clipId: 'c3', frame: 300 },
        ],
      ],
    ]);
  });

  it('keeps different faults of one file apart', () => {
    const groups = groupProblems([
      warning('c1', 'beach.mp4', 0),
      warning('c1', 'beach.mp4', 12, { reason: 'timeout', message: 'slow' }),
      warning('c4', 'beach.mp4', 0, { part: 'audio', message: 'audio' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      'beach.mp4|video|missing',
      'beach.mp4|audio|missing',
      'beach.mp4|video|timeout',
    ]);
  });
});

describe('hasUnseen', () => {
  const shown = [warning('c1', 'a.mp4', 0), warning('c2', 'b.mp4', 50)];

  it('is false for the same problems or fewer', () => {
    expect(hasUnseen(shown, shown)).toBe(false);
    expect(hasUnseen([shown[1]], shown)).toBe(false);
    expect(hasUnseen([], shown)).toBe(false);
  });

  it('is true for another clip or another fault', () => {
    expect(hasUnseen([...shown, warning('c3', 'a.mp4', 90)], shown)).toBe(true);
    expect(hasUnseen([warning('c1', 'a.mp4', 0, { reason: 'undecodable' })], shown)).toBe(true);
    expect(hasUnseen(shown, [])).toBe(true);
  });
});
