import { describe, expect, it } from 'vitest';
import type { WrappedAudioBuffer } from 'mediabunny';
import { makeClip, timeMap } from '@tandem/core';
import { AudioRuns } from '../src/audio/graph';
import { Retimed } from '../src/audio/retimed';
import type { Sound, SoundTrouble } from '../src/audio/sound';

const RATE = 44100;
const BLOCK = 1024;

/** A decoder's output: `count` buffers of `BLOCK` samples from `first` (in samples) on. */
function decoded(first: number, count: number, nudge: (i: number) => number = () => 0): WrappedAudioBuffer[] {
  return Array.from({ length: count }, (_, i) => ({
    buffer: { length: BLOCK, sampleRate: RATE, duration: BLOCK / RATE } as AudioBuffer,
    timestamp: (first + i * BLOCK + nudge(i)) / RATE,
    duration: BLOCK / RATE,
  }));
}

/** A file's sound over `all` that answers as Mediabunny's sink does, and counts what is asked of it. */
function sinkOver(all: WrappedAudioBuffer[]) {
  const stats = { decodes: [] as [number, number][], open: 0, pulled: 0 };
  const sink = {
    buffers(from: number, to: number) {
      stats.decodes.push([from, to]);
      stats.open++;
      return (async function* () {
        try {
          // The buffer that holds `from`, then every one that starts before `to`.
          const first = Math.max(
            0,
            all.findLastIndex((wb) => wb.timestamp <= from),
          );
          for (let i = first; i < all.length && all[i].timestamp < to; i++) {
            stats.pulled++;
            yield all[i];
          }
        } finally {
          stats.open--;
        }
      })();
    },
  } as unknown as Sound;
  return { sink, stats };
}

/** Nothing fails in a sink over buffers. */
const unheard = () => {};

/**
 * A file's sound of which a decode gives three buffers where `decodes(from)`, and otherwise
 * nothing and the word `Sound` has for that.
 */
function soundWhere(decodes: (from: number) => boolean): Sound {
  return {
    buffers(from: number, _to: number, report: (trouble: SoundTrouble) => void) {
      return (async function* () {
        if (decodes(from)) yield* decoded(Math.round(from * RATE), 3);
        else report({ lost: 'all', from, cause: 'bad packet' });
      })();
    },
  } as unknown as Sound;
}

async function collect(buffers: AsyncGenerator<WrappedAudioBuffer, void, unknown>): Promise<number[]> {
  const starts: number[] = [];
  for await (const wb of buffers) starts.push(Math.round(wb.timestamp * RATE));
  return starts;
}

const seconds = (samples: number) => samples / RATE;
const clip = makeClip('audio', 'a1', { assetId: 'sound' });

/** A buffer that holds its samples: what a stream reads of a decoded buffer, and what it hands on. */
function holding(channels: Float32Array[], rate: number): AudioBuffer {
  return {
    length: channels[0].length,
    sampleRate: rate,
    numberOfChannels: channels.length,
    duration: channels[0].length / rate,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

/** A file of `count` decoded buffers with sound in them: noise on a tone, every sample its own. */
function recorded(count: number): WrappedAudioBuffer[] {
  let seed = 9;
  const samples = Float32Array.from({ length: count * BLOCK }, (_, i) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE) + 0.2 * ((seed % 20001) / 20000 - 0.5);
  });
  return decoded(0, count).map((wb, i) => ({
    ...wb,
    buffer: holding([samples.subarray(i * BLOCK, (i + 1) * BLOCK)], RATE),
  }));
}

/** A clip the mixer retimes: on a ramp with pitch following speed, or at one speed with pitch kept. */
const retimedClip = (keepPitch: boolean) =>
  makeClip(
    'audio',
    'a1',
    keepPitch
      ? { assetId: 'sound', speed: 1.5, keepPitch }
      : {
          assetId: 'sound',
          ramp: [
            { m: 1, v: 0.5 },
            { m: 4, v: 2 },
            { m: 7, v: 1 },
          ],
        },
  );

/** The stream of such a clip over the file `all`, as the mixer makes one for a retimed voice. */
function streamOver(all: WrappedAudioBuffer[], keepPitch: boolean) {
  const { sink, stats } = sinkOver(all);
  const file = { rate: RATE, buffers: sink.buffers.bind(sink) };
  // What is asked of the stream itself, in seconds of the stream.
  const reads: [number, number][] = [];
  const stream = new Retimed(file, 0, timeMap(retimedClip(keepPitch)), keepPitch, holding);
  const sound = {
    buffers(from: number, to: number, report: (trouble: SoundTrouble) => void) {
      reads.push([from, to]);
      return stream.buffers(from, to, report);
    },
  };
  return { sound, stream, stats, reads };
}

/** `recorded` as another decoder gives the same packets: at half the rate, with samples of its own. */
function recordedLow(count: number): WrappedAudioBuffer[] {
  const rate = RATE / 2;
  const size = BLOCK / 2;
  return Array.from({ length: count }, (_, i) => ({
    buffer: holding(
      [
        Float32Array.from(
          { length: size },
          (_, k) => 0.25 * Math.sin((2 * Math.PI * 330 * (i * size + k)) / rate),
        ),
      ],
      rate,
    ),
    timestamp: (i * size) / rate,
    duration: size / rate,
  }));
}

/**
 * A file's sound as `Sound` gives it where the decoder it begins with hands over to the browser's
 * own: the first decode gives `few` buffers of `before`, from the one that holds what was asked
 * for, and then `after` from where those end. Every decode after that one gives `after` alone.
 */
function handingOver(before: WrappedAudioBuffer[], after: WrappedAudioBuffer[], few: number) {
  const stats = { decodes: 0, open: 0 };
  let handed = false;
  let rate: number | null = null;
  const file = {
    get rate() {
      return rate;
    },
    buffers(from: number, to: number) {
      stats.decodes++;
      stats.open++;
      return (async function* () {
        try {
          let end = -Infinity;
          if (!handed) {
            const first = Math.max(
              0,
              before.findLastIndex((wb) => wb.timestamp <= from),
            );
            for (const wb of before.slice(first, first + few)) {
              if (wb.timestamp >= to) return;
              rate = wb.buffer.sampleRate;
              end = wb.timestamp + wb.duration;
              yield wb;
            }
          }
          const next = Math.max(
            0,
            after.findLastIndex((wb) => wb.timestamp <= Math.max(from, end)),
          );
          for (let i = next; i < after.length && after[i].timestamp < to; i++) {
            if (after[i].timestamp < end - 1e-3) continue;
            handed = true;
            rate = after[i].buffer.sampleRate;
            yield after[i];
          }
        } finally {
          stats.open--;
        }
      })();
    },
  };
  return { file, stats };
}

/** Where each buffer lies and every sample in it. */
async function heard(buffers: AsyncGenerator<WrappedAudioBuffer, void, unknown>) {
  const all: { at: number; samples: Float32Array }[] = [];
  for await (const wb of buffers) all.push({ at: wb.timestamp, samples: wb.buffer.getChannelData(0) });
  return all;
}

describe('AudioRuns', () => {
  it('reads that follow one another come out of one decode, which ends with the clip', async () => {
    const all = decoded(0, 400);
    const { sink, stats } = sinkOver(all);
    const runs = new AudioRuns();
    const high = seconds(400 * BLOCK);
    const read = (from: number, to: number, again: number) =>
      collect(runs.of(clip).read(sink, seconds(from), seconds(to), seconds(again), 0, high, false, unheard));
    const direct = async (from: number, to: number) =>
      collect(sinkOver(all).sink.buffers(seconds(from), seconds(to), unheard));

    // Each read begins a little before the one before it ended, as the chunks of an export do.
    expect(await read(500, 150_000, 120_000)).toEqual(await direct(500, 150_000));
    expect(await read(130_000, 300_000, 270_000)).toEqual(await direct(130_000, 300_000));
    expect(stats.decodes).toHaveLength(1);
    expect(stats.open).toBe(1);
    // No further than the read needed: the buffer that starts at its end, and no more.
    expect(stats.pulled).toBe(Math.ceil(300_000 / BLOCK) + 1);
    expect(await read(280_000, 400 * BLOCK, 400 * BLOCK)).toEqual(await direct(280_000, 400 * BLOCK));
    expect(stats.decodes).toHaveLength(1);
    expect(stats.open).toBe(0);
  });

  it('keeps only what the next read can ask for, and seeks for a read that asks for more', async () => {
    const { sink, stats } = sinkOver(decoded(0, 400));
    const runs = new AudioRuns();
    const read = (from: number, to: number, again: number) =>
      collect(
        runs
          .of(clip)
          .read(sink, seconds(from), seconds(to), seconds(again), 0, seconds(400 * BLOCK), false, unheard),
      );
    await read(0, 100_000, 90_000);
    await read(90_000, 200_000, 190_000);
    expect(stats.decodes).toHaveLength(1);
    // Before where the last read said the next one could begin: let go, so decoded again.
    expect((await read(150_000, 250_000, 240_000))[0]).toBe(Math.floor(150_000 / BLOCK) * BLOCK);
    expect(stats.decodes).toHaveLength(2);
    expect(stats.open).toBe(1);
    // Disposing closes the decoder that was still part-way; the closing itself takes a few turns.
    runs.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stats.open).toBe(0);
  });

  it('places a buffer whose time is one sample off where the buffer before it ends, and leaves a real gap', async () => {
    // Rounded up or down as it happens, and from the 30th buffer on a hole of 300 samples.
    const all = decoded(7860, 60, (i) => (i >= 30 ? 300 : 0) + [0, 1, 0, 0, -1, 1][i % 6]);
    const { sink } = sinkOver(all);
    const runs = new AudioRuns();
    const starts = await collect(runs.of(clip).read(sink, 0, 10, 10, 0, 10, false, unheard));
    const steps = starts.slice(1).map((at, i) => at - starts[i]);
    expect(steps.filter((step) => step !== BLOCK)).toEqual([BLOCK + 300]);
    expect(steps.indexOf(BLOCK + 300)).toBe(29);
    expect(starts[0]).toBe(7860);
  });

  it('decodes what is played of a clip that plays backwards once, hands it out from the end and lets it go', async () => {
    const all = decoded(0, 400);
    const { sink, stats } = sinkOver(all);
    const runs = new AudioRuns();
    // The render plays the clip from part-way in, and ends before the clip does.
    const low = seconds(20_000);
    const high = seconds(400 * BLOCK);
    const read = (from: number, to: number) =>
      collect(runs.of(clip).read(sink, seconds(from), seconds(to), 0, low, high, true, unheard));
    const direct = async (from: number, to: number) =>
      collect(sinkOver(all).sink.buffers(seconds(from), seconds(to), unheard));
    // Descending, each stretch reaching a little into the one before it.
    expect(await read(250_000, 350_000)).toEqual(await direct(250_000, 350_000));
    expect(await read(100_000, 270_000)).toEqual(await direct(100_000, 270_000));
    expect(await read(20_000, 120_000)).toEqual(await direct(20_000, 120_000));
    // One decode, of no more than the first read's end and the render's own end leave to play.
    expect(stats.decodes).toEqual([[low, seconds(350_000)]]);
    expect(stats.open).toBe(0);
    // The last of those reads reached the bottom, and nothing is kept after it: the chunk that
    // follows, which has the clip's end in its pre-roll, decodes that bit for itself.
    expect(await read(20_000, 40_000)).toEqual(await direct(20_000, 40_000));
    expect(stats.decodes).toEqual([
      [low, seconds(350_000)],
      [low, seconds(40_000)],
    ]);
  });

  it('seeks for each read of a clip that plays backwards while what is left of it is too long to keep', async () => {
    const { sink, stats } = sinkOver(decoded(0, 400));
    const runs = new AudioRuns();
    const read = (from: number, to: number) =>
      collect(runs.of(clip).read(sink, from, to, 0, 0, 310, true, unheard));
    // More than five minutes are left to play: decoded as without anything carried.
    await read(301, 305);
    await read(297, 301.5);
    expect(stats.decodes).toEqual([
      [301, 305],
      [297, 301.5],
    ]);
    // What is left fits: decoded in one pass, and the reads after that come out of it.
    await read(293, 297.5);
    await read(289, 293.5);
    expect(stats.decodes.slice(2)).toEqual([[0, 297.5]]);
  });

  it('tells whoever is reading of sound that would not decode, and starts no decoder once one has stopped for good', async () => {
    const all = decoded(0, 400);
    let started = 0;
    // Decodes as far as buffer 150 with a hole after buffer 100, then stops for good.
    const sound = {
      buffers(from: number, _to: number, report: (trouble: SoundTrouble) => void) {
        started++;
        return (async function* () {
          for (let i = Math.floor((from * RATE) / BLOCK); i < 150; i++) {
            if (i === 101) report({ lost: 'stretch', from: all[i].timestamp, cause: 'bad packet' });
            if (i !== 101) yield all[i];
          }
          report({ lost: 'rest', from: seconds(150 * BLOCK), cause: 'bad packet' });
        })();
      },
    } as unknown as Sound;
    const runs = new AudioRuns();
    const heard: string[] = [];
    const high = seconds(400 * BLOCK);
    const read = (chunk: string, from: number, to: number, again = to) =>
      collect(
        runs
          .of(clip)
          .read(sound, seconds(from), seconds(to), seconds(again), 0, high, false, (t) =>
            heard.push(`${chunk}: ${t.lost} at ${Math.round(t.from * RATE)}`),
          ),
      );
    expect(await read('first', 0, 50 * BLOCK)).toHaveLength(50);
    // The hole is met, and then the end, by the chunk that reads there: not by the one that began the decode.
    const second = await read('second', 50 * BLOCK, 200 * BLOCK, 140 * BLOCK);
    expect(second).toHaveLength(99);
    expect(second).not.toContain(101 * BLOCK);
    // The chunk after it begins before that one ended, and gets what was decoded of its beginning.
    const third = await read('third', 140 * BLOCK, 300 * BLOCK);
    expect(third).toEqual(second.slice(-10));
    expect(await read('fourth', 300 * BLOCK, 400 * BLOCK)).toEqual([]);
    expect(heard).toEqual([`second: stretch at ${101 * BLOCK}`, `second: rest at ${150 * BLOCK}`]);
    expect(started).toBe(1);
  });

  it('hands out what was decoded of a clip that plays backwards before its decoder stopped for good', async () => {
    // Only the first 150 buffers decode: the end of the file, which is played first, does not.
    const good = decoded(0, 150);
    let started = 0;
    const sound = {
      buffers(from: number, to: number, report: (trouble: SoundTrouble) => void) {
        started++;
        return (async function* () {
          yield* sinkOver(good).sink.buffers(from, to, unheard);
          report({ lost: 'rest', from: seconds(150 * BLOCK), cause: 'bad packet' });
        })();
      },
    } as unknown as Sound;
    const runs = new AudioRuns();
    const heard: string[] = [];
    const read = (chunk: string, from: number, to: number) =>
      collect(
        runs
          .of(clip)
          .read(sound, seconds(from), seconds(to), 0, 0, seconds(400 * BLOCK), true, (t) =>
            heard.push(`${chunk}: ${t.lost}`),
          ),
      );
    const direct = async (from: number, to: number) =>
      collect(sinkOver(good).sink.buffers(seconds(from), seconds(to), unheard));
    expect(await read('first', 300 * BLOCK, 400 * BLOCK)).toEqual(await direct(300 * BLOCK, 400 * BLOCK));
    // Every later read gets what a decode of its own stretch would give: all of the 150 between them.
    const second = await read('second', 100 * BLOCK, 310 * BLOCK);
    expect(second).toEqual(await direct(100 * BLOCK, 310 * BLOCK));
    expect(second).toHaveLength(50);
    const third = await read('third', 0, 110 * BLOCK);
    expect(third).toEqual(await direct(0, 110 * BLOCK));
    expect(third).toHaveLength(110);
    expect(heard).toEqual(['first: rest']);
    expect(started).toBe(1);
  });

  it('lets each read of a clip that plays backwards and is too long to keep decode for itself, whatever the one before could not', async () => {
    // Five minutes and twenty seconds, of which the last ten do not decode.
    const sound = soundWhere((from) => from < 310);
    const runs = new AudioRuns();
    const heard: string[] = [];
    const read = (chunk: string, from: number, to: number) =>
      collect(runs.of(clip).read(sound, from, to, 0, 0, 320, true, (t) => heard.push(`${chunk}: ${t.lost}`)));
    expect(await read('first', 316, 320)).toEqual([]);
    expect(await read('second', 312, 316.5)).toEqual([]);
    expect(await read('third', 308, 312.5)).toHaveLength(3);
    expect(await read('fourth', 304, 308.5)).toHaveLength(3);
    // Of its own few seconds a read gave nothing, which is a stretch of the clip and not all of it.
    expect(heard).toEqual(['first: stretch', 'second: stretch']);
  });

  it('calls sound that a decode does not give all of the clip’s only while none of it has been handed out', async () => {
    const lost = async (sound: Sound, backwards: boolean, high: number, reads: [number, number][]) => {
      const runs = new AudioRuns();
      const heard: string[] = [];
      for (const [from, to] of reads)
        await collect(runs.of(clip).read(sound, from, to, to, 0, high, backwards, (t) => heard.push(t.lost)));
      return heard;
    };
    // Forwards, the end of the clip does not decode. The chunk that follows the clip’s last has
    // that end in its pre-roll and decodes it for itself: the rest of the clip is without sound.
    const start = soundWhere((from) => from < 9);
    expect(await lost(start, false, 10, [[9.5, 10]])).toEqual(['all']);
    expect(
      await lost(start, false, 10, [
        [0, 10],
        [9.5, 10],
      ]),
    ).toEqual(['rest']);
    // A decode that hands out what lies in front of the file's sound and gives none of the sound
    // itself has lost all of it, as `Sound` says: what it handed out was not sound of the clip.
    const priming = {
      buffers(_from: number, _to: number, report: (trouble: SoundTrouble) => void) {
        return (async function* () {
          yield* decoded(-2 * BLOCK, 2);
          report({ lost: 'all', from: 0, cause: 'bad packet' });
        })();
      },
    } as unknown as Sound;
    expect(await lost(priming, false, 10, [[-0.1, 4]])).toEqual(['all']);
    // Backwards, only the end of the file decodes, which is played first: a stretch is without.
    const end = soundWhere((from) => from >= 305);
    expect(await lost(end, true, 10, [[5, 10]])).toEqual(['all']);
    expect(
      await lost(end, true, 320, [
        [316, 320],
        [292, 296.5],
      ]),
    ).toEqual(['stretch']);
  });

  it('reads the stream of a retimed clip in one decode of its file, and the same samples wherever a read begins', async () => {
    const all = recorded(520);
    for (const keepPitch of [false, true]) {
      const { sound, stats } = streamOver(all, keepPitch);
      const runs = new AudioRuns();
      // Seconds of the stream, of which the render plays those from 0.3 to 7.5.
      const [low, high] = [0.3, 7.5];
      const read = (from: number, to: number, again: number) =>
        heard(runs.of(clip).read(sound, from, to, again, low, high, false, unheard));
      const direct = (from: number, to: number) => heard(streamOver(all, keepPitch).stream.buffers(from, to));

      // Each read begins a little before the one before it ended, as the chunks of an export do.
      const first = await read(0.3, 3, 2.4);
      expect(first).toEqual(await direct(0.3, 3));
      expect(first.length).toBeGreaterThan(25);
      const second = await read(2.5, 6, 5.4);
      expect(second).toEqual(await direct(2.5, 6));
      expect(stats.decodes).toHaveLength(1);
      expect(stats.open).toBe(1);
      // The buffers the two reads share are the very ones the first was given.
      const shared = second.filter(({ at }) => at < 3);
      expect(shared.length).toBeGreaterThan(3);
      for (const { at, samples } of shared) expect(first.find((b) => b.at === at)?.samples).toBe(samples);
      const third = await read(5.5, 7.5, 7.5);
      expect(third).toEqual(await direct(5.5, 7.5));
      expect(stats.decodes).toHaveLength(1);
      expect(stats.open).toBe(0);

      // From the middle, by a render that begins there: other buffers of the file, the same stream.
      const fresh = streamOver(all, keepPitch);
      const middle = await heard(
        new AudioRuns().of(clip).read(fresh.sound, 4.1, 5.2, 5.2, 4.1, 5.2, false, unheard),
      );
      expect(fresh.stats.decodes).toHaveLength(1);
      expect(fresh.stats.decodes[0][0]).toBeGreaterThan(stats.decodes[0][0] + 1);
      expect(middle.length).toBeGreaterThan(10);
      for (const block of middle) expect(second.find((b) => b.at === block.at)).toEqual(block);
    }
  });

  it('gives every chunk the buffers of a retimed clip whose decoder hands over to another format in its first buffers', async () => {
    // 22.05 kHz from the decoder the file begins with, 44.1 kHz from the browser's own.
    const before = recordedLow(520);
    const after = recorded(520);
    const blocks = async (buffers: AsyncGenerator<WrappedAudioBuffer, void, unknown>) => {
      const all: { at: number; rate: number; ends: number; samples: Float32Array }[] = [];
      for await (const wb of buffers)
        all.push({
          at: wb.timestamp,
          rate: wb.buffer.sampleRate,
          ends: wb.timestamp + wb.duration,
          samples: wb.buffer.getChannelData(0),
        });
      return all;
    };
    const preRoll = 0.5;
    let cases = 0;
    const lost: string[] = [];
    for (const keepPitch of [false, true]) {
      const map = timeMap(retimedClip(keepPitch));
      // The first decoder gives the one buffer it had under way, or three.
      for (const few of [1, 3]) {
        // Seconds of the stream that the render plays: from the file's first buffer, and from part-way in.
        for (const low of [0, 1.3]) {
          const high = low + 1.5;
          // The render in one piece, by a page that reads the file for the first time: one series,
          // the buffers every later read of the file gives.
          const fresh = handingOver(before, after, few);
          const whole = await blocks(new Retimed(fresh.file, 0, map, keepPitch, holding).buffers(low, high));
          expect(fresh.stats.decodes).toBe(2);
          const { sink } = sinkOver(after);
          const handed = { rate: RATE, buffers: sink.buffers.bind(sink) };
          const later = new Retimed(handed, 0, map, keepPitch, holding).buffers(low, high);
          expect(whole).toEqual(await blocks(later));
          expect(whole.every((block, i) => i === 0 || block.at > whole[i - 1].at)).toBe(true);
          // In two chunks, the seam anywhere in the second after the clip begins to play.
          for (let seam = low + 0.03; seam < low + 1; seam += 0.0473) {
            cases++;
            const page = handingOver(before, after, few);
            const stream = new Retimed(page.file, 0, map, keepPitch, holding);
            const runs = new AudioRuns();
            const chunks = [
              [low, seam, Math.max(low, seam - preRoll - 0.1)],
              [Math.max(low, seam - preRoll), high, high],
            ];
            let short = 0;
            for (const [from, to, again] of chunks) {
              const got = await blocks(
                runs.of(clip).read(stream, from, to, again, low, high, false, unheard),
              );
              // What a read of the same stretch gives: every buffer that reaches into it.
              const want = whole.filter((block) => block.at < to && block.ends > from);
              short += want.filter(
                (block) => !got.some((given) => given.at === block.at && given.rate === block.rate),
              ).length;
              if (short === 0) expect(got).toEqual(want);
            }
            if (short > 0)
              lost.push(
                `${short} buffers: keep pitch ${keepPitch}, ${few} before the hand-over, from ${low}, seam ${seam.toFixed(4)}`,
              );
            expect(page.stats.decodes).toBe(2);
            expect(page.stats.open).toBe(0);
          }
        }
      }
    }
    expect(cases).toBe(168);
    expect(lost).toEqual([]);
  });

  it('reads the stream of a retimed clip that plays backwards once, and hands it out from the end', async () => {
    const all = recorded(520);
    for (const keepPitch of [false, true]) {
      const { sound, stats, reads } = streamOver(all, keepPitch);
      const runs = new AudioRuns();
      const [low, high] = [1, 7.5];
      const read = (from: number, to: number) =>
        heard(runs.of(clip).read(sound, from, to, 0, low, high, true, unheard));
      const direct = (from: number, to: number) => heard(streamOver(all, keepPitch).stream.buffers(from, to));
      // Descending, each stretch reaching a little into the one before it.
      expect(await read(5, 7.5)).toEqual(await direct(5, 7.5));
      expect(await read(2.5, 5.4)).toEqual(await direct(2.5, 5.4));
      expect(await read(1, 2.9)).toEqual(await direct(1, 2.9));
      // One read of the stream, from where the render stops playing the clip to the first read's
      // end, out of one decode of the file.
      expect(reads).toEqual([[low, 7.5]]);
      expect(stats.decodes).toHaveLength(1);
      expect(stats.open).toBe(0);
    }
  });
});
