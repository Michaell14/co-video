import { afterEach, describe, expect, it, vi } from 'vitest';
import { encoderAccepts, videoEncoding, type VideoEncodingSettings } from '../src/export';

afterEach(() => {
  vi.unstubAllGlobals();
});

const settings = (patch: Partial<VideoEncodingSettings> = {}): VideoEncodingSettings => ({
  videoCodec: 'avc',
  width: 1920,
  height: 1080,
  fpsNum: 30000,
  fpsDen: 1001,
  videoBitrate: 8_000_000,
  keyFrameInterval: 2,
  hardwareAcceleration: 'no-preference',
  dynamicRange: 'sdr',
  ...patch,
});

describe('videoEncoding', () => {
  it('sets an 8-bit encoder up from the settings and leaves its codec string to be worked out', () => {
    expect(videoEncoding(settings({ hardwareAcceleration: 'prefer-software', keyFrameInterval: 5 }))).toEqual({
      codec: 'avc',
      width: 1920,
      height: 1080,
      frameRate: 30000 / 1001,
      bitrate: 8_000_000,
      keyFrameInterval: 5,
      options: { hardwareAcceleration: 'prefer-software', latencyMode: 'quality', fullCodecString: undefined },
    });
  });

  it('names the depth and the transfer of a 10-bit picture in the codec string', () => {
    const string = (patch: Partial<VideoEncodingSettings>) =>
      videoEncoding(settings({ fpsNum: 30, fpsDen: 1, ...patch })).options.fullCodecString;
    expect(string({ videoCodec: 'vp9', dynamicRange: 'pq' })).toBe('vp09.02.40.10.01.09.16.09.00');
    expect(string({ videoCodec: 'vp9', dynamicRange: 'hlg' })).toBe('vp09.02.40.10.01.09.18.09.00');
    expect(string({ videoCodec: 'av1', dynamicRange: 'pq' })).toBe('av01.0.08M.10.0.110.09.16.09.0');
    expect(string({ videoCodec: 'av1', dynamicRange: 'hlg' })).toBe('av01.0.08M.10.0.110.09.18.09.0');
    expect(string({ videoCodec: 'hevc', dynamicRange: 'pq' })).toBe('hvc1.2.4.L120.B0');
    // The level in it is the one the size and the frame rate of the export need.
    expect(string({ videoCodec: 'vp9', dynamicRange: 'pq', fpsNum: 60 })).toBe('vp09.02.41.10.01.09.16.09.00');
    expect(string({ videoCodec: 'vp9', dynamicRange: 'pq', width: 320, height: 180 })).toBe(
      'vp09.02.31.10.01.09.16.09.00',
    );
    expect(string({ videoCodec: 'hevc', dynamicRange: 'hlg', width: 3840, height: 2160, fpsNum: 60 })).toBe(
      'hvc1.2.4.L153.B0',
    );
    // The same settings in SDR are an 8-bit picture, whatever the codec could carry.
    expect(string({ videoCodec: 'vp9', dynamicRange: 'sdr' })).toBeUndefined();
  });

  it('gives the encoder a whole number of bits a second', () => {
    // 4.1 Mbps as a product of two numbers is a hair short of a whole number of bits.
    expect(4.1 * 1e6).not.toBe(4_100_000);
    expect(videoEncoding(settings({ videoBitrate: 4.1 * 1e6 })).bitrate).toBe(4_100_000);
    expect(videoEncoding(settings({ videoBitrate: 1_234_567.5 })).bitrate).toBe(1_234_568);
  });
});

describe('encoderAccepts', () => {
  /** A browser's encoder that notes what it is asked and answers with `supported`. */
  function encoder(supported: (config: VideoEncoderConfig) => boolean): VideoEncoderConfig[] {
    const asked: VideoEncoderConfig[] = [];
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: async (config: VideoEncoderConfig) => {
        asked.push(config);
        return { supported: supported(config), config };
      },
    });
    return asked;
  }

  it('asks about an 8-bit export with the size, rate, bitrate and choice of encoder it will have', async () => {
    const asked = encoder(() => true);
    const answer = await encoderAccepts(
      settings({ videoBitrate: 6_100_000.4, hardwareAcceleration: 'prefer-hardware' }),
    );
    expect(answer).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      width: 1920,
      height: 1080,
      bitrate: 6_100_000,
      framerate: 30000 / 1001,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
    });
    expect(asked[0].codec).toMatch(/^avc1\./);
  });

  it('asks about a 10-bit export under the codec string it is encoded with', async () => {
    const asked = encoder(() => true);
    const hdr = settings({ videoCodec: 'vp9', dynamicRange: 'hlg', fpsNum: 60, fpsDen: 1 });
    expect(await encoderAccepts(hdr)).toBe(true);
    expect(asked.map((config) => config.codec)).toEqual([videoEncoding(hdr).options.fullCodecString]);
    expect(asked[0].codec).toBe('vp09.02.41.10.01.09.18.09.00');
    expect(asked[0]).toMatchObject({ framerate: 60, bitrate: 8_000_000, latencyMode: 'quality' });
  });

  it('answers no when the encoder refuses, and when there is none to ask', async () => {
    const asked = encoder((config) => (config.bitrate ?? 0) <= 50_000_000);
    expect(await encoderAccepts(settings({ videoBitrate: 50_000_000 }))).toBe(true);
    expect(await encoderAccepts(settings({ videoBitrate: 50_100_000 }))).toBe(false);
    expect(asked).toHaveLength(2);

    vi.unstubAllGlobals();
    expect(await encoderAccepts(settings({ videoBitrate: 3_300_000 }))).toBe(false);
  });

  it('takes settings that cannot be put to an encoder at all as refused', async () => {
    const asked = encoder(() => true);
    expect(await encoderAccepts(settings({ width: 0 }))).toBe(false);
    expect(await encoderAccepts(settings({ videoBitrate: 0 }))).toBe(false);
    expect(await encoderAccepts(settings({ fpsNum: 0 }))).toBe(false);
    // H.264 has no odd sizes.
    expect(await encoderAccepts(settings({ width: 1919 }))).toBe(false);
    expect(asked).toHaveLength(0);
  });
});
