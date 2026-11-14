import { describe, expect, it } from 'vitest';
import type { WrappedAudioBuffer } from 'mediabunny';
import { makeClip } from '@tandem/core';
import { AudioRuns } from '../src/audio/graph';
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

async function collect(buffers: AsyncGenerator<WrappedAudioBuffer, void, unknown>): Promise<number[]> {
  const starts: number[] = [];
  for await (const wb of buffers) starts.push(Math.round(wb.timestamp * RATE));
  return starts;
}

const seconds = (samples: number) => samples / RATE;
const clip = makeClip('audio', 'a1', { assetId: 'sound' });

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
    const read = (chunk: string, from: number, to: number) =>
      collect(
        runs
          .of(clip)
          .read(sound, seconds(from), seconds(to), seconds(to), 0, high, false, (t) =>
            heard.push(`${chunk}: ${t.lost} at ${Math.round(t.from * RATE)}`),
          ),
      );
    expect(await read('first', 0, 50 * BLOCK)).toHaveLength(50);
    // The hole is met, and then the end, by the chunk that reads there: not by the one that began the decode.
    const second = await read('second', 50 * BLOCK, 200 * BLOCK);
    expect(second).toHaveLength(99);
    expect(second).not.toContain(101 * BLOCK);
    expect(await read('third', 200 * BLOCK, 300 * BLOCK)).toEqual([]);
    expect(await read('fourth', 300 * BLOCK, 400 * BLOCK)).toEqual([]);
    expect(heard).toEqual([`second: stretch at ${101 * BLOCK}`, `second: rest at ${150 * BLOCK}`]);
    expect(started).toBe(1);
  });
});
