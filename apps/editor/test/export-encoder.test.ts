import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoEncodingSettings } from '@tandem/engine';
import { askEncoder, encodingKey } from '../src/features/export/encoder';

afterEach(() => {
  vi.unstubAllGlobals();
});

const settings = (patch: Partial<VideoEncodingSettings> = {}): VideoEncodingSettings => ({
  videoCodec: 'vp9',
  width: 320,
  height: 180,
  fpsNum: 24,
  fpsDen: 1,
  videoBitrate: 8_000_000,
  keyFrameInterval: 2,
  hardwareAcceleration: 'no-preference',
  dynamicRange: 'sdr',
  ...patch,
});

/**
 * A browser's encoder that answers with `supported` and notes the codec strings it is asked about.
 * What stands between it and the dialog remembers every answer for as long as the page lives
 * (here: this file), so each case asks about settings that no other case has.
 */
function encoder(supported: (config: VideoEncoderConfig) => boolean): string[] {
  const asked: string[] = [];
  vi.stubGlobal('VideoEncoder', {
    isConfigSupported: async (config: VideoEncoderConfig) => {
      asked.push(config.codec);
      return { supported: supported(config), config };
    },
  });
  return asked;
}

const tenBit = (config: VideoEncoderConfig): boolean => config.codec.startsWith('vp09.02.');

describe('askEncoder', () => {
  it('finds the ceiling of a 10-bit export by asking under its own codec string', async () => {
    const asked = encoder((config) => !tenBit(config) || (config.bitrate ?? 0) <= 50_000_000);
    const hdr = settings({ dynamicRange: 'pq', videoBitrate: 400_000_000 });
    expect(await askEncoder(hdr)).toEqual({ accepted: false, limit: 50_000_000, acceleration: false });
    expect(asked.length).toBeGreaterThan(2);
    expect(new Set(asked)).toEqual(new Set(['vp09.02.31.10.01.09.16.09.00']));

    // The same numbers for an 8-bit picture are another question, with an answer of its own.
    expect(await askEncoder({ ...hdr, dynamicRange: 'sdr' })).toEqual({ accepted: true });
    expect(asked.at(-1)).toMatch(/^vp09\.00\./);
  });

  it('says so when the choice of encoder is what stands in the way of a 10-bit export', async () => {
    encoder((config) => !tenBit(config) || config.hardwareAcceleration !== 'prefer-hardware');
    const hdr = settings({ dynamicRange: 'hlg', videoBitrate: 9_000_000 });
    expect(await askEncoder({ ...hdr, hardwareAcceleration: 'prefer-hardware' })).toEqual({
      accepted: false,
      limit: null,
      acceleration: true,
    });
    expect(await askEncoder({ ...hdr, hardwareAcceleration: 'prefer-software' })).toEqual({ accepted: true });
  });

  it('gives the question asked last the answer it already has', async () => {
    const asked = encoder(() => true);
    const first = askEncoder(settings({ videoBitrate: 7_000_000 }));
    expect(askEncoder(settings({ videoBitrate: 7_000_000 }))).toBe(first);
    expect(await first).toEqual({ accepted: true });
    expect(asked).toHaveLength(1);
  });
});

describe('encodingKey', () => {
  it('tells apart everything the encoder is set up with, the bit depth and transfer included', () => {
    const base = settings();
    const others: Partial<VideoEncodingSettings>[] = [
      { videoCodec: 'av1' },
      { width: 640 },
      { height: 360 },
      { fpsNum: 25 },
      { fpsDen: 2 },
      { videoBitrate: 8_100_000 },
      { hardwareAcceleration: 'prefer-software' },
      { dynamicRange: 'pq' },
      { dynamicRange: 'hlg' },
    ];
    const keys = [base, ...others.map((patch) => settings(patch))].map(encodingKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(encodingKey(settings())).toBe(encodingKey(base));
  });
});
