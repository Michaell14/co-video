import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputAudioTrack, WrappedAudioBuffer } from 'mediabunny';

const RATE = 44100;
const BLOCK = 1024;
const PACKET = BLOCK / RATE;

/** What stands in for a track: its packets by number, which of them a decoder trips over, and what was started. */
interface Fake {
  packets: number;
  /** Packets the WebCodecs decoder fails on. */
  bad: Set<number>;
  /** How far ahead of what it has given a decoder is when it fails: those buffers are lost with it. */
  ahead: number;
  /** Starts of the WebCodecs decoder: the packet each began at. */
  starts: number[];
  /** The browser's own decoder for the track: absent, or the packets it fails on. */
  other: Set<number> | null;
  otherStarts: number[];
}

const buffer = (packet: number): WrappedAudioBuffer => ({
  buffer: { length: BLOCK, sampleRate: RATE, duration: PACKET } as AudioBuffer,
  timestamp: packet * PACKET,
  duration: PACKET,
});

/** As a sink answers: from the packet that holds `from` (after one to get going) up to `to`, failing on a bad one. */
async function* decode(fake: Fake, bad: Set<number>, from = 0, to = Infinity, lead = 1) {
  const first = Math.max(0, Math.min(fake.packets - 1, Math.floor(from / PACKET + 1e-9)));
  const pending: number[] = [];
  for (let p = Math.max(0, first - lead); p < fake.packets && p * PACKET < to; p++) {
    if (bad.has(p)) {
      // What the decoder had not handed over yet goes with it.
      for (const kept of pending.splice(0, Math.max(0, pending.length - fake.ahead))) yield buffer(kept);
      throw new DOMException(`Packet ${p} is damaged.`, 'EncodingError');
    }
    if (p >= first) pending.push(p);
    while (pending.length > fake.ahead) yield buffer(pending.shift()!);
  }
  for (const kept of pending) yield buffer(kept);
}

vi.mock('mediabunny', () => ({
  AudioBufferSink: class {
    constructor(private readonly fake: Fake) {}
    buffers(from?: number, to?: number) {
      this.fake.starts.push(Math.floor((from ?? 0) / PACKET + 1e-9));
      return decode(this.fake, this.fake.bad, from, to);
    }
  },
}));

vi.mock('../src/audio/adts', () => ({
  aacByBrowser: async (fake: Fake) =>
    fake.other && {
      buffers(from?: number, to?: number) {
        fake.otherStarts.push(Math.floor((from ?? 0) / PACKET + 1e-9));
        return decode(fake, fake.other!, from, to, 3);
      },
    },
}));

const { Sound, forgetSound } = await import('../src/audio/sound');

function track(init: Partial<Fake> = {}) {
  const fake: Fake = {
    packets: 400,
    bad: new Set(),
    ahead: 0,
    starts: [],
    other: null,
    otherStarts: [],
    ...init,
  };
  // The mocks read the fake through the track they are handed.
  return Object.assign(fake, {
    getPreRollDuration: async () => PACKET,
    getFirstTimestamp: async () => 0,
  }) as Fake & { getPreRollDuration(): Promise<number>; getFirstTimestamp(): Promise<number> };
}

async function read(fake: Fake, from?: number, to?: number, assetId = 'file') {
  const sound = new Sound(assetId, fake as unknown as InputAudioTrack);
  const given: number[] = [];
  const told: string[] = [];
  for await (const wb of sound.buffers(from, to, (t) =>
    told.push(`${t.lost} from ${Math.round(t.from / PACKET)}: ${t.cause}`),
  ))
    given.push(Math.round(wb.timestamp / PACKET));
  return { given, told, sound };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('Sound', () => {
  beforeEach(() => {
    forgetSound('file');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('gives what the decoder gives when nothing fails, and says nothing', async () => {
    const fake = track();
    const { given, told, sound } = await read(fake, 10 * PACKET, 50 * PACKET);
    expect(given).toEqual(range(10, 50));
    expect(told).toEqual([]);
    expect(fake.starts).toEqual([10]);
    expect(sound.rate).toBe(RATE);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('leaves out a packet that will not decode and the two a new start needs, and goes on behind them', async () => {
    const fake = track({ bad: new Set([100]) });
    const { given, told } = await read(fake);
    // The decoder is started again where it stopped, which fails at once, then three packets on:
    // one for it to get going on, and that one must not be the damaged one.
    expect(given).toEqual([...range(0, 100), ...range(103, 400)]);
    expect(told).toEqual(['stretch from 100: EncodingError: Packet 100 is damaged.']);
    expect(fake.starts).toEqual([0, 100, 103]);
  });

  it('loses with a failing decoder what it had decoded and not handed over, and no more than that', async () => {
    const fake = track({ bad: new Set([100]), ahead: 4 });
    const { given, told } = await read(fake);
    // Started again behind the last buffer it got; the four that were on their way are lost each time.
    expect(fake.starts).toEqual([0, 96, 99, 102]);
    expect(given).toEqual([...range(0, 96), ...range(102, 400)]);
    expect(told).toEqual(['stretch from 96: EncodingError: Packet 100 is damaged.']);
  });

  it('steps twice as far each time over a longer stretch of damage', async () => {
    const fake = track({ bad: new Set(range(100, 130)) });
    const { given, told } = await read(fake);
    expect(fake.starts).toEqual([0, 100, 103, 106, 112, 124, 148]);
    expect(given).toEqual([...range(0, 100), ...range(148, 400)]);
    expect(told).toEqual(['stretch from 100: EncodingError: Packet 100 is damaged.']);
  });

  it('reports each stretch of a file that is damaged in several places', async () => {
    const fake = track({ bad: new Set([50, 300]) });
    const { given, told } = await read(fake);
    expect(given).toEqual([...range(0, 50), ...range(53, 300), ...range(303, 400)]);
    expect(told.map((t) => t.split(':')[0])).toEqual(['stretch from 50', 'stretch from 300']);
  });

  it('gives up on a decoder that fails wherever it is started, after a bounded number of starts', async () => {
    const fake = track({ packets: 100_000, bad: new Set(range(0, 100_000)) });
    const { given, told } = await read(fake);
    expect(given).toEqual([]);
    expect(told).toEqual(['all from 0: EncodingError: Packet 0 is damaged.']);
    expect(fake.starts).toHaveLength(11);
    // And one that fails for good part-way through: what came before is given.
    const half = track({ packets: 100_000, bad: new Set(range(200, 100_000)) });
    const second = await read(half);
    expect(second.given).toEqual(range(0, 200));
    expect(second.told).toEqual(['rest from 200: EncodingError: Packet 200 is damaged.']);
    expect(half.starts).toHaveLength(12);
  });

  it('does not start beyond the end of what was asked for', async () => {
    const fake = track({ bad: new Set(range(0, 400)) });
    const { given, told } = await read(fake, 0, 20 * PACKET);
    expect(given).toEqual([]);
    expect(told).toEqual(['all from 0: EncodingError: Packet 0 is damaged.']);
    // Then a good three packets on (a packet is taken to be 25 ms long until one has been
    // decoded), and twice and four times as far; the next start would be at packet 25.
    expect(fake.starts).toEqual([0, 3, 6, 13]);
  });

  it('takes a failure behind the last packet for what it is: nothing is missing', async () => {
    // A decoder that fails as it is closed, having given everything. Started again, it has nothing more.
    const fake = track({ packets: 50 });
    const sound = new Sound('file', fake as unknown as InputAudioTrack);
    let starts = 0;
    const sink = {
      async *buffers(from?: number) {
        const first = starts++ === 0;
        yield* decode(fake, fake.bad, from);
        if (first) throw new DOMException('The decoder could not be flushed.', 'EncodingError');
      },
    };
    (sound as unknown as { sink: unknown }).sink = sink;
    const given: number[] = [];
    const told: string[] = [];
    for await (const wb of sound.buffers(undefined, undefined, (t) => told.push(t.lost)))
      given.push(Math.round(wb.timestamp / PACKET));
    expect(given).toEqual(range(0, 50));
    expect(told).toEqual([]);
    expect(starts).toBe(2);
  });

  it('asks the browser’s own decoder when the other gives nothing at all, and stays with it for the file', async () => {
    const fake = track({ bad: new Set(range(0, 400)), other: new Set() });
    const first = await read(fake, 20 * PACKET, 60 * PACKET);
    expect(first.given).toEqual(range(20, 60));
    expect(first.told).toEqual([]);
    expect(fake.starts).toEqual([20]);
    expect(fake.otherStarts).toEqual([20]);
    // Said once, with what the WebCodecs decoder said.
    const lines = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('browser’s own decoder'))).toEqual([
      '[audio] file: the WebCodecs decoder failed (EncodingError: Packet 19 is damaged.); its sound is decoded by the browser’s own decoder instead',
    ]);
    // The next read of the file, by whoever, does not try the decoder that failed.
    const again = await read(fake, 100 * PACKET, 110 * PACKET);
    expect(again.given).toEqual(range(100, 110));
    expect(fake.starts).toEqual([20]);
    expect(
      vi.mocked(console.warn).mock.calls.filter((call) => String(call[0]).includes('own decoder')),
    ).toHaveLength(1);
    // Until the file changes.
    forgetSound('file');
    await read(fake, 0, 10 * PACKET);
    expect(fake.starts).toEqual([20, 0]);
  });

  it('takes sound that begins later than what was asked for as that, not as a hole', async () => {
    // Asked from five packets before the track's first: the decoder that takes over begins where
    // the other failed, and what it gives first is the first there is.
    const fake = track({ bad: new Set(range(0, 400)), other: new Set() });
    const { given, told } = await read(fake, -5 * PACKET, 40 * PACKET);
    expect(given).toEqual(range(0, 40));
    expect(told).toEqual([]);
  });

  it('goes on with the decoder it has when the browser’s own gives nothing either', async () => {
    const fake = track({ bad: new Set([0, 1]), other: new Set(range(0, 400)) });
    const { given, told } = await read(fake);
    expect(fake.otherStarts).toEqual([0]);
    expect(given).toEqual(range(6, 400));
    expect(told).toEqual(['stretch from 0: EncodingError: Packet 0 is damaged.']);
    // And when neither gives anything, the sound is missing, after no more starts than without it.
    const dead = track({
      packets: 100_000,
      bad: new Set(range(0, 100_000)),
      other: new Set(range(0, 100_000)),
    });
    const none = await read(dead);
    expect(none.told).toEqual(['all from 0: EncodingError: Packet 0 is damaged.']);
    expect(dead.starts.length + dead.otherStarts.length).toBe(11);
  });

  it('asks the browser’s own decoder before giving up on one that stopped for good part-way through', async () => {
    const fake = track({ packets: 100_000, bad: new Set(range(200, 100_000)), other: new Set() });
    fake.packets = 2000;
    const { given, told } = await read(fake);
    expect(given).toEqual(range(0, 2000));
    expect(told).toEqual([]);
    expect(fake.otherStarts).toEqual([200]);
  });

  it('leaves out what the browser’s own decoder cannot decode either, once it has taken over', async () => {
    const fake = track({ bad: new Set(range(0, 400)), other: new Set([150]) });
    const { given, told } = await read(fake);
    // Its stretches begin three packets before what is wanted of them.
    expect(given.slice(0, 150)).toEqual(range(0, 150));
    expect(given.at(-1)).toBe(399);
    expect(given).not.toContain(150);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^stretch from 150: /);
  });

  it('lets the end of the file itself through', async () => {
    const fake = track();
    const sound = new Sound('file', fake as unknown as InputAudioTrack);
    const gone = Object.assign(new Error('Input has been disposed.'), { name: 'InputDisposedError' });
    const sink = {
      buffers: () =>
        (async function* () {
          yield buffer(0);
          throw gone;
        })(),
    };
    (sound as unknown as { sink: unknown }).sink = sink;
    const given: number[] = [];
    await expect(
      (async () => {
        for await (const wb of sound.buffers(0, undefined, () => {})) given.push(wb.timestamp);
      })(),
    ).rejects.toBe(gone);
    expect(given).toEqual([0]);
  });
});
