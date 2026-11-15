import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputAudioTrack } from 'mediabunny';

/** A packet of the fake track: what it holds says which it is. */
interface Packet {
  timestamp: number;
  duration: number;
  data: Uint8Array;
}

const packetData = (n: number) => Uint8Array.of(0xa5, n >> 8, n & 255, 0x5a);
const numberOf = (data: Uint8Array, at: number) => (data[at + 1] << 8) | data[at + 2];

/** Packets as an MP4 or an ADTS stream holds them: by the marks they carry. */
function marked(bytes: Uint8Array): number[] {
  const found: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++)
    if (bytes[i] === 0xa5 && bytes[i + 3] === 0x5a) {
      found.push(numberOf(bytes, i));
      i += 3;
    }
  return found;
}

const text = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const boxAt = (bytes: Uint8Array, type: string) => bytes.findIndex((_, i) => text(bytes, i) === type);

/**
 * How the stand-in for the browser's own decoder treats a stream. `follows`: it plays an MP4 as
 * its edit says, and cuts `cut` samples from the front of an ADTS stream. `ignores`: it gives all
 * an MP4 holds. `drops`: it leaves a packet out of the middle. `cuts`: it cuts 2112 samples more.
 */
let behaviour: 'follows' | 'ignores' | 'drops' | 'cuts' = 'follows';
let adtsCut = 0;
const decoded: { packets: number[]; mp4: boolean }[] = [];

class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array[];
  constructor(o: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = o.numberOfChannels;
    this.length = o.length;
    this.sampleRate = o.sampleRate;
    this.data = Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length));
  }
  getChannelData(c: number) {
    return this.data[c];
  }
  copyToChannel(source: Float32Array, c: number, at = 0) {
    this.data[c].set(source, at);
  }
}

class FakeContext {
  constructor(
    _channels: number,
    _length: number,
    readonly sampleRate: number,
  ) {}
  async decodeAudioData(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    const mp4 = text(bytes, 4) === 'ftyp';
    const packets = marked(bytes);
    decoded.push({ packets, mp4 });
    // Each packet decodes to samples of its number, a quarter on.
    const frame = mp4 ? u32(bytes, boxAt(bytes, 'stts') + 16) : 1024;
    let samples = packets.flatMap((n) => Array<number>(frame).fill(n + 0.25));
    if (mp4 && behaviour !== 'ignores') samples = samples.slice(u32(bytes, boxAt(bytes, 'elst') + 16));
    if (!mp4) samples = samples.slice(adtsCut);
    if (behaviour === 'drops' && packets.length > 4) samples.splice(2 * frame, frame);
    if (behaviour === 'cuts') samples = samples.slice(2112);
    const out = new FakeBuffer({ numberOfChannels: 1, length: samples.length, sampleRate: this.sampleRate });
    out.copyToChannel(Float32Array.from(samples), 0);
    return out;
  }
}

/** The fake track: `count` packets of `span` seconds, the first `origin` of them before its time 0. */
function fakeTrack(count: number, span: number, origin: number, description: number[], rate: number) {
  const packets: Packet[] = Array.from({ length: count }, (_, n) => ({
    timestamp: (n - origin) * span,
    duration: span,
    data: packetData(n),
  }));
  return {
    packets,
    getCodec: async () => 'aac',
    getDecoderConfig: async () => ({
      codec: 'mp4a.40.2',
      sampleRate: rate,
      numberOfChannels: 1,
      description: Uint8Array.from(description),
    }),
    getSampleRate: async () => rate,
  };
}

vi.mock('mediabunny', () => ({
  EncodedPacketSink: class {
    constructor(private readonly track: { packets: Packet[] }) {}
    async getPacket(time: number) {
      return this.track.packets.findLast((p) => p.timestamp <= time + 1e-9) ?? null;
    }
    async getFirstPacket() {
      return this.track.packets[0] ?? null;
    }
    async *packets(start: Packet) {
      yield* this.track.packets.slice(this.track.packets.indexOf(start));
    }
  },
}));

async function load() {
  vi.resetModules();
  return import('../src/audio/adts');
}

/**
 * What a read gives, by buffer: its time, how many samples it begins with that are silent, and the
 * packet whose samples the rest are (null for none, -1 where they are of more than one).
 */
async function read(
  source: { buffers(from?: number, to?: number): AsyncGenerator<{ buffer: AudioBuffer; timestamp: number }> },
  from?: number,
  to?: number,
) {
  const out: { packet: number | null; time: number; silent: number }[] = [];
  for await (const { buffer, timestamp } of source.buffers(from, to)) {
    const data = buffer.getChannelData(0);
    const sound = data.findIndex((v) => v !== 0);
    const silent = sound < 0 ? data.length : sound;
    const held = new Set(Array.from(data.subarray(silent), (v) => v - 0.25));
    out.push({
      packet: held.size === 0 ? null : held.size === 1 ? [...held][0] : -1,
      time: timestamp,
      silent,
    });
  }
  return out;
}

const HE_AAC = [0x2b, 0x8a, 0x08, 0x00];
const LC_44 = [0x12, 0x10];

beforeEach(() => {
  vi.stubGlobal('OfflineAudioContext', FakeContext);
  vi.stubGlobal('AudioBuffer', FakeBuffer);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  behaviour = 'follows';
  adtsCut = 0;
  decoded.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the browser’s own decoder, given AAC as MP4', () => {
  const span = 2048 / 44100;
  const track = () => fakeTrack(300, span, 2, HE_AAC, 44100);
  /** Every buffer holds its own packet, at its packet's time to the sample. */
  const inPlace = (got: Awaited<ReturnType<typeof read>>, first: number, count: number) => {
    expect(got.map((g) => g.packet)).toEqual(Array.from({ length: count }, (_, i) => first + i));
    expect(got.map((g) => Math.round(g.time * 44100))).toEqual(
      Array.from({ length: count }, (_, i) => (first + i - 2) * 2048),
    );
    expect(got.every((g) => g.silent === 0)).toBe(true);
  };

  for (const way of ['follows', 'ignores'] as const) {
    it(`gives each packet’s samples at its time from a browser that ${way === 'follows' ? 'follows' : 'does not follow'} the edit`, async () => {
      const { AacByBrowser, inMp4 } = await load();
      behaviour = way;
      const t = track();
      const browser = new AacByBrowser(t as unknown as InputAudioTrack, inMp4(Uint8Array.from(HE_AAC))!);
      // The whole track, its priming first; and from a place in it, across where stretches join.
      inPlace(await read(browser), 0, 300);
      inPlace(await read(browser, 1.0, 9.0), 23, 173);
      // A stretch in the middle begins with the three packets in front of it, and is 128 long.
      expect(decoded.slice(1, 3).map((d) => [d.packets[0], d.packets.length])).toEqual([
        [125, 131],
        [253, 47],
      ]);
      expect(decoded.every((d) => d.mp4)).toBe(true);
    });
  }

  it('turns down a stretch that comes back with a packet left out, or cut at the front', async () => {
    const { AacByBrowser, inMp4 } = await load();
    const browser = new AacByBrowser(track() as unknown as InputAudioTrack, inMp4(Uint8Array.from(HE_AAC))!);
    behaviour = 'drops';
    await expect(read(browser, 2, 3)).rejects.toThrow(
      'The browser’s own decoder gave 43008 samples for 25 packets, not 45056 or 51200.',
    );
    behaviour = 'cuts';
    await expect(read(browser)).rejects.toThrow('gave 260032 samples for 128 packets, not 262144.');
  });
});

describe('the browser’s own decoder, given plain AAC-LC as ADTS', () => {
  it('leaves silent what the browser cuts from the very front of the file, and places the rest', async () => {
    const { AacByBrowser, asAdts } = await load();
    adtsCut = 2112;
    const t = fakeTrack(200, 1024 / 44100, 1, LC_44, 44100);
    const browser = new AacByBrowser(
      t as unknown as InputAudioTrack,
      asAdts({ frequencyIndex: 4, channelConfiguration: 2 }, 44100, 2112),
    );
    const got = await read(browser);
    expect(got).toHaveLength(200);
    // The first two packets and 64 samples of the third were cut, and nothing else.
    expect(got.slice(0, 3).map((g) => [g.packet, g.silent])).toEqual([
      [null, 1024],
      [null, 1024],
      [2, 64],
    ]);
    expect(got.slice(3).every((g, i) => g.packet === i + 3 && g.silent === 0)).toBe(true);
    // A stretch that does not begin the file loses nothing: the browser cuts its lead.
    const later = await read(browser, 1, 2);
    expect(later.every((g) => g.silent === 0 && (g.packet ?? -1) >= 0)).toBe(true);
    behaviour = 'drops';
    await expect(read(browser, 1, 2)).rejects.toThrow('gave 44992 samples for 47 packets, not 46016.');
  });
});

describe('aacByBrowser', () => {
  /** The browser's decoding of the engine's test clicks: in place, cut by `cut`, or with one click moved. */
  const decode = FakeContext.prototype.decodeAudioData;
  const clicksAs = (cut: number, moved = 0) => {
    adtsCut = cut;
    vi.spyOn(FakeContext.prototype, 'decodeAudioData').mockImplementation(async function (
      this: FakeContext,
      buffer: ArrayBuffer,
    ) {
      // The test stream begins with a packet of its own, not with one of the fake track's.
      const bytes = new Uint8Array(buffer);
      if (bytes[7] !== 0xde) return decode.call(this, buffer);
      const out = new FakeBuffer({ numberOfChannels: 1, length: 12 * 1024 - cut, sampleRate: 44100 });
      const data = out.getChannelData(0);
      data[4024 - cut] = 0.8;
      data[8524 - cut + moved] = 0.8;
      return out;
    } as typeof decode);
  };
  const choose = async (description: number[], rate: number, cut: number, moved = 0) => {
    const { aacByBrowser } = await load();
    clicksAs(cut, moved);
    const t = fakeTrack(40, 1024 / rate, 0, description, rate);
    const browser = await aacByBrowser(t as unknown as InputAudioTrack);
    if (!browser) return null;
    decoded.length = 0;
    await read(browser);
    return decoded[0].mp4 ? 'mp4' : 'adts';
  };

  it('gives plain AAC-LC above 24 kHz as ADTS to a browser that places the test clicks, and everything else as MP4', async () => {
    expect(await choose(LC_44, 44100, 0)).toBe('adts');
    expect(await choose(LC_44, 44100, 2112)).toBe('adts');
    // The clicks one sample out: then as MP4.
    expect(await choose(LC_44, 44100, 0, 1)).toBe('mp4');
    expect(await choose(HE_AAC, 44100, 0)).toBe('mp4');
    expect(await choose([0x13, 0x88, 0x56, 0xe5, 0x00], 22050, 0)).toBe('mp4');
    // A track that declares another rate than its config.
    expect(await choose(LC_44, 48000, 0)).toBe('mp4');
  });

  it('has nothing for what it cannot place', async () => {
    expect(await choose([0x0a, 0x10], 44100, 0)).toBeNull();
    expect(await choose([0xf9, 0x46, 0x40], 44100, 0)).toBeNull();
    const { aacByBrowser } = await load();
    const opus = { ...fakeTrack(4, 0.02, 0, [], 48000), getCodec: async () => 'opus' };
    expect(await aacByBrowser(opus as unknown as InputAudioTrack)).toBeNull();
  });
});
