import { describe, expect, it } from 'vitest';
import type { ExportWarning } from '@tandem/engine';
import {
  describeBitrate,
  groupProblems,
  hasUnseen,
  highestAccepted,
  refusalNotice,
  usableCodec,
} from '../src/features/export/plan';

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

describe('highestAccepted', () => {
  /** An encoder that takes up to `ceiling`, and the numbers it was asked about. */
  const encoder = (ceiling: number) => {
    const asked: number[] = [];
    return { asked, accepts: async (n: number) => (asked.push(n), n <= ceiling) };
  };

  it('finds the ceiling under a number that is refused', async () => {
    for (const ceiling of [2, 3, 1999, 2000, 2881, 3999]) {
      expect(await highestAccepted(2, 4000, encoder(ceiling).accepts)).toBe(ceiling);
    }
  });

  it('asks about a handful of numbers, not about each', async () => {
    const { asked, accepts } = encoder(2880);
    await highestAccepted(2, 4000, accepts);
    expect(asked.length).toBeLessThanOrEqual(13);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('has none where even the lowest is refused, or there is nothing below the refused number', async () => {
    expect(await highestAccepted(2, 4000, encoder(1).accepts)).toBeNull();
    const { asked, accepts } = encoder(100);
    expect(await highestAccepted(2, 2, accepts)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('what the dialog says about settings the encoder refuses', () => {
  const asked = { codec: 'H.264 (AVC)', size: '320×180', bitrate: 400e6, hardware: 'no-preference' } as const;

  it('writes a bitrate the way its field shows it', () => {
    expect(describeBitrate(200e6)).toBe('200 Mbps');
    expect(describeBitrate(12_500_000)).toBe('12.5 Mbps');
    expect(describeBitrate(4_099_999)).toBe('4.1 Mbps');
  });

  it('names the ceiling for this codec and size where the bitrate is over it', () => {
    expect(refusalNotice({ accepted: false, limit: 200e6, acceleration: false }, asked)).toBe(
      'H.264 (AVC) at 320×180 takes at most 200 Mbps in this browser. Lower the bitrate, or choose another codec.',
    );
  });

  it('points at the choice of encoder where that is what stands in the way', () => {
    const verdict = { accepted: false, limit: null, acceleration: true } as const;
    expect(refusalNotice(verdict, { ...asked, hardware: 'prefer-hardware' })).toBe(
      'This browser has no GPU encoder for H.264 (AVC) at 320×180. Set Acceleration to Automatic.',
    );
    expect(refusalNotice(verdict, { ...asked, hardware: 'prefer-software' })).toBe(
      'This browser has no software encoder for H.264 (AVC) at 320×180. Set Acceleration to Automatic.',
    );
  });

  it('says what was refused where neither explains it', () => {
    expect(refusalNotice({ accepted: false, limit: null, acceleration: false }, asked)).toBe(
      'This browser’s H.264 (AVC) encoder does not take 320×180 at 400 Mbps. Choose another codec, size or frame rate.',
    );
  });
});
