import { describe, expect, it } from 'vitest';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { aacMp4, aacStream } from '../src/audio/mp4';

const config = (...bytes: number[]) => Uint8Array.of(...bytes);

describe('aacStream', () => {
  it('reads HE-AAC from a config that says so: the rate it doubles to, twice the samples a packet, stereo from a mono core', () => {
    // Object type 5 at 22.05 kHz, one channel, doubled to 44.1 kHz, over AAC-LC (what a phone's
    // HE-AAC looks like); and object type 29, which says parametric stereo as well.
    expect(aacStream(config(0x2b, 0x8a, 0x08, 0x00))).toEqual({ rate: 44100, frame: 2048, channels: 2 });
    expect(aacStream(config(0xeb, 0x8a, 0x08, 0x00))).toEqual({ rate: 44100, frame: 2048, channels: 2 });
    // At 24 kHz, two channels, doubled to 48 kHz.
    expect(aacStream(config(0x2b, 0x11, 0x88, 0x00))).toEqual({ rate: 48000, frame: 2048, channels: 2 });
    // Replication that runs at the core's rate.
    expect(aacStream(config(0x2a, 0x12, 0x08, 0x00))).toEqual({ rate: 44100, frame: 1024, channels: 2 });
  });

  it('reads the extension behind a config of AAC-LC that says whether there is replication', () => {
    // What ffmpeg writes for AAC-LC at 22.05 kHz mono: an extension that says there is none.
    expect(aacStream(config(0x13, 0x88, 0x56, 0xe5, 0x00))).toEqual({
      rate: 22050,
      frame: 1024,
      channels: 1,
    });
    // One that says there is, doubled to 44.1 kHz, with parametric stereo.
    expect(aacStream(config(0x13, 0x88, 0x56, 0xe5, 0xa5, 0x48, 0x80))).toEqual({
      rate: 44100,
      frame: 2048,
      channels: 2,
    });
  });

  it('asks for AAC-LC at 24 kHz and below that says nothing at twice its rate, and for the rest at its own', () => {
    expect(aacStream(config(0x13, 0x90))).toEqual({ rate: 44100, frame: 2048, channels: 2 });
    expect(aacStream(config(0x13, 0x08))).toEqual({ rate: 48000, frame: 2048, channels: 2 });
    expect(aacStream(config(0x12, 0x10))).toEqual({ rate: 44100, frame: 1024, channels: 2 });
    expect(aacStream(config(0x11, 0x88))).toEqual({ rate: 48000, frame: 1024, channels: 1 });
    expect(aacStream(config(0x11, 0xb0))).toEqual({ rate: 48000, frame: 1024, channels: 6 });
    expect(aacStream(config(0x11, 0xb8))).toEqual({ rate: 48000, frame: 1024, channels: 8 });
    // A rate written out in full: 48 kHz, stereo.
    expect(aacStream(config(0x17, 0x80, 0x5d, 0xc0, 0x10))).toEqual({
      rate: 48000,
      frame: 1024,
      channels: 2,
    });
  });

  it('turns down what it cannot place', () => {
    // AAC Main, xHE-AAC (escaped object type 42), HE-AAC over AAC Main.
    expect(aacStream(config(0x0a, 0x10))).toBeNull();
    expect(aacStream(config(0xf9, 0x46, 0x40))).toBeNull();
    expect(aacStream(config(0x2b, 0x8a, 0x04, 0x00))).toBeNull();
    // Channels described in the stream, packets of 960 samples, a core coder, a reserved rate.
    expect(aacStream(config(0x12, 0x00))).toBeNull();
    expect(aacStream(config(0x12, 0x14))).toBeNull();
    expect(aacStream(config(0x12, 0x12))).toBeNull();
    expect(aacStream(config(0x16, 0x90))).toBeNull();
    // Too short to say.
    expect(aacStream(config(0x2b))).toBeNull();
    expect(aacStream(config())).toBeNull();
  });
});

describe('aacMp4', () => {
  /** Packets that say which they are. */
  const packets = (count: number) =>
    Array.from({ length: count }, (_, i) => Uint8Array.of(0xa5, i, 0x5a, ...Array(i % 7).fill(i)));

  async function opened(bytes: Uint8Array) {
    const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
    const track = (await input.getPrimaryAudioTrack())!;
    const sink = new EncodedPacketSink(track);
    const read = [];
    for await (const packet of sink.packets()) read.push(packet);
    const config = await track.getDecoderConfig();
    return { input, track, read, config };
  }

  it('is an MP4 file of the packets, with the config as it is, each packet as long as the stream says', async () => {
    const description = config(0x2b, 0x8a, 0x08, 0x00);
    const stream = aacStream(description)!;
    const given = packets(40);
    const bytes = aacMp4(description, stream, given, 0);
    const { input, track, read, config: said } = await opened(bytes);
    expect(await input.getFormat()).toMatchObject({ name: 'MP4' });
    expect(await track.getCodec()).toBe('aac');
    expect(Array.from(new Uint8Array(said!.description as ArrayBuffer))).toEqual(Array.from(description));
    expect(await track.getSampleRate()).toBe(44100);
    // The sample entry says two channels, as it does for a mono core that carries parametric stereo.
    const entry = Array.from(bytes).findIndex(
      (_, i) => String.fromCharCode(...bytes.subarray(i, i + 4)) === 'mp4a',
    );
    expect((bytes[entry + 20] << 8) | bytes[entry + 21]).toBe(2);
    expect(read.map((p) => Array.from(p.data))).toEqual(given.map((p) => Array.from(p)));
    expect(read.map((p) => Math.round(p.timestamp * 44100))).toEqual(given.map((_, i) => i * 2048));
    expect(read.every((p) => Math.round(p.duration * 44100) === 2048)).toBe(true);
    expect(await track.getFirstTimestamp()).toBe(0);
  });

  it('leaves the packets in front out of what it plays, to the sample', async () => {
    const description = config(0x12, 0x10);
    const stream = aacStream(description)!;
    const { track, read } = await opened(aacMp4(description, stream, packets(131), 3));
    expect(read).toHaveLength(131);
    // Played from the fourth packet on: the three in front lie before the file's time 0.
    expect(read.slice(0, 5).map((p) => Math.round(p.timestamp * 44100))).toEqual([
      -3072, -2048, -1024, 0, 1024,
    ]);
    expect(Math.round((await track.getFirstTimestamp()) * 44100)).toBe(-3072);
    expect(Math.round((await track.computeDuration()) * 44100)).toBe(128 * 1024);
  });
});
