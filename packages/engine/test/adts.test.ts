import { describe, expect, it } from 'vitest';
import { adts, clicksStream, cutFromFront, plainAac } from '../src/audio/adts';

describe('plainAac', () => {
  it('reads the rate and the channels of AAC-LC from its AudioSpecificConfig', () => {
    // What ffmpeg writes for AAC-LC: 44.1 kHz stereo, 48 kHz mono, 48 kHz 5.1.
    expect(plainAac(Uint8Array.of(0x12, 0x10))).toEqual({ frequencyIndex: 4, channelConfiguration: 2 });
    expect(plainAac(Uint8Array.of(0x11, 0x88))).toEqual({ frequencyIndex: 3, channelConfiguration: 1 });
    expect(plainAac(Uint8Array.of(0x11, 0xb0))).toEqual({ frequencyIndex: 3, channelConfiguration: 6 });
  });

  it('turns down everything an ADTS header cannot say, or that is not AAC-LC', () => {
    // HE-AAC (object type 5), AAC Main (1), xHE-AAC (escaped object type 42).
    expect(plainAac(Uint8Array.of(0x2b, 0x92, 0x08, 0x00))).toBeNull();
    expect(plainAac(Uint8Array.of(0x0a, 0x10))).toBeNull();
    expect(plainAac(Uint8Array.of(0xf9, 0x46, 0x40))).toBeNull();
    // A rate written out in full, channels described in the stream, packets of 960 samples.
    expect(plainAac(Uint8Array.of(0x17, 0x80, 0x5d, 0xc0, 0x10))).toBeNull();
    expect(plainAac(Uint8Array.of(0x12, 0x00))).toBeNull();
    expect(plainAac(Uint8Array.of(0x12, 0x14))).toBeNull();
    expect(plainAac(Uint8Array.of(0x12))).toBeNull();
  });
});

describe('adts', () => {
  it('puts the header ffmpeg writes in front of each packet', () => {
    const packets = [new Uint8Array(21).fill(1), new Uint8Array(297).fill(2)];
    const stream = adts({ frequencyIndex: 4, channelConfiguration: 1 }, packets);
    expect(stream).toHaveLength(7 + 21 + 7 + 297);
    const hex = (from: number) =>
      Array.from(stream.subarray(from, from + 7), (b) => b.toString(16).padStart(2, '0')).join('');
    // The headers of the first and the fourth packet of the stream `CLICKS` was taken from.
    expect(hex(0)).toBe('fff15040039ffc');
    expect(hex(28)).toBe('fff15040261ffc');
    expect(Array.from(stream.subarray(7, 28))).toEqual(Array.from(packets[0]));
    expect(stream[35]).toBe(2);
  });

  it('says how many channels there are and how long a long packet is', () => {
    const stream = adts({ frequencyIndex: 3, channelConfiguration: 6 }, [new Uint8Array(3000)]);
    // 48 kHz, six channels: the channel count straddles two bytes; the length is 13 bits.
    expect(stream[2]).toBe(0x40 | (3 << 2) | 1);
    expect(stream[3] >> 6).toBe(2);
    expect(((stream[3] & 3) << 11) | (stream[4] << 3) | (stream[5] >> 5)).toBe(3007);
  });
});

describe('the test stream for the browser’s own decoder', () => {
  const FRAMES = 12 * 1024;
  /** What a decoder makes of it that cuts `cut` samples from the front and puts the clicks at `at`. */
  const decoded = (cut: number, at = [4024, 8524]) => {
    const out = new Float32Array(FRAMES - cut);
    for (const click of at) {
      out[click - cut] = 0.6;
      out[click - cut + 1] = -0.18;
      out[click - cut - 1] = 0.18;
    }
    return out;
  };

  it('is twelve packets behind their headers', () => {
    const stream = clicksStream();
    expect(stream).toHaveLength(543 + 12 * 7);
    expect(stream[0]).toBe(0xff);
    // The first packet is 21 bytes long, and the second begins right behind it.
    expect([stream[28], stream[29]]).toEqual([0xff, 0xf1]);
  });

  it('shows how much a decoder cuts from the front: nothing, a packet, or the priming of Apple’s encoder', () => {
    expect(cutFromFront(decoded(0))).toBe(0);
    expect(cutFromFront(decoded(1024))).toBe(1024);
    expect(cutFromFront(decoded(2112))).toBe(2112);
  });

  it('turns down a decoder that does anything else to the stream', () => {
    // Samples missing from the end as well, or from the middle: the clicks are not where the count says.
    expect(() => cutFromFront(decoded(1024, [4024 + 1024, 8524 + 1024]))).toThrow(/test clicks/);
    expect(() => cutFromFront(decoded(1024, [4024, 8524 + 1024]))).toThrow(/test clicks/);
    // One sample out.
    expect(() => cutFromFront(decoded(0, [4025, 8525]))).toThrow(/test clicks/);
    // More cut than a stretch has packets to spare for, and more samples than the packets hold.
    expect(() => cutFromFront(decoded(4096))).toThrow(/samples/);
    expect(() => cutFromFront(new Float32Array(FRAMES + 1024))).toThrow(/samples/);
    // Silence.
    expect(() => cutFromFront(new Float32Array(FRAMES))).toThrow(/test clicks/);
  });
});
