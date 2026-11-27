import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { ffprobe, hasFfprobe, noReloads, openLab, trackErrors } from './helpers';

/**
 * Speed ramps and speed that keeps its pitch, driven through the engine lab page: what the mixer
 * renders for such clips, what the picture shows, what a preview schedules and what an export
 * holds. Sound is measured, since nobody listens to a test: where a tone and a click land, at
 * which pitch and level, and whether the pieces of a render meet without a seam.
 */

/** Open the lab with a few measuring tools on `window.kit`. */
async function openRampLab(page: Page): Promise<void> {
  await noReloads(page);
  await openLab(page);
  await page.evaluate(() => {
    const { lab } = window as any;
    const { core, engine } = lab;
    const decoders = { started: 0 };
    const sink = engine.VideoSampleSink.prototype;
    const samples = sink.samples;
    sink.samples = function (...args: unknown[]) {
      decoders.started++;
      return samples.apply(this, args);
    };
    const kit = {
      /** Counts decode pipelines started (one per seek). */
      decoders,
      hash(px: Uint8Array): number {
        let h = 0;
        for (let i = 0; i < px.length; i += 41) h = (h * 31 + px[i]) | 0;
        return h;
      },
      /**
       * The frame of a 30 fps file that a decoder shows for second `t`: the last one that begins
       * no later than 2 ms after it, since containers round their times. `sure` is false within a
       * tenth of a millisecond of where that changes from one frame to the next.
       */
      shown(t: number): { frame: number; sure: boolean } {
        const at = (t + 0.002) * 30;
        return { frame: Math.floor(at), sure: Math.abs(at - Math.round(at)) > 1e-4 * 30 };
      },
      /**
       * A project with one video track and as many audio tracks as the clips name (`lane`),
       * holding `clips` (props for `makeClip`).
       */
      project(assets: unknown[], clips: any[], settings = {}) {
        const v1 = core.makeTrack('video', 0);
        const lanes = new Map<number, any>();
        const lane = (i: number) => {
          if (!lanes.has(i)) lanes.set(i, core.makeTrack('audio', i));
          return lanes.get(i);
        };
        const made = clips.map(({ type = 'video', lane: i = 0, ...props }) =>
          core.makeClip(type, type === 'audio' ? lane(i).id : v1.id, props),
        );
        return core.applyEdits(core.emptyProject({ width: 160, height: 90, ...settings }), [
          { op: 'addTrack', track: v1 },
          ...[...lanes.values()].map((track) => ({ op: 'addTrack', track })),
          ...assets.map((asset) => ({ op: 'addAsset', asset })),
          ...made.map((clip: unknown) => ({ op: 'addClip', clip })),
        ]);
      },
      /** A 32-bit float WAV file, one array per channel: nothing is rounded on the way in. */
      floatWav(channels: Float32Array[], rate: number): Blob {
        const n = channels[0].length;
        const size = n * channels.length * 4;
        const buf = new ArrayBuffer(44 + size);
        const v = new DataView(buf);
        const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        text(0, 'RIFF');
        v.setUint32(4, 36 + size, true);
        text(8, 'WAVEfmt ');
        v.setUint32(16, 16, true);
        v.setUint16(20, 3, true);
        v.setUint16(22, channels.length, true);
        v.setUint32(24, rate, true);
        v.setUint32(28, rate * channels.length * 4, true);
        v.setUint16(32, channels.length * 4, true);
        v.setUint16(34, 32, true);
        text(36, 'data');
        v.setUint32(40, size, true);
        for (let i = 0; i < n; i++)
          for (let c = 0; c < channels.length; c++)
            v.setFloat32(44 + (i * channels.length + c) * 4, channels[c][i], true);
        return new Blob([buf], { type: 'audio/wav' });
      },
      /** Add `samples` to the lab as a mono WAV file, and return its asset. */
      add(id: string, samples: Float32Array, rate: number) {
        return lab.addFile(id, URL.createObjectURL(kit.floatWav([samples], rate)), `${id}.wav`);
      },
      /** `seconds` of a sine as samples. */
      sine(hz: number, rate: number, seconds: number, amp = 0.5): Float32Array {
        return Float32Array.from(
          { length: Math.round(rate * seconds) },
          (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate),
        );
      },
      /** `seconds` of noise: every sample is its own, so anything read otherwise shows. */
      noise(rate: number, seconds: number, seed: number): Float32Array {
        return Float32Array.from({ length: Math.round(rate * seconds) }, () => {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return (seed % 16001) / 16000 - 0.5;
        });
      },
      /** The left channel of `seconds` of the project's sound from `start`, rendered as an export renders a chunk. */
      async render(project: any, start: number, seconds: number, runs?: unknown): Promise<Float32Array> {
        const rate = project.settings.sampleRate;
        const out = await engine.renderAudioChunk(
          project,
          lab.library,
          start,
          seconds,
          rate,
          undefined,
          undefined,
          runs,
        );
        return out.getChannelData(0).slice();
      },
      /** The largest difference between two renders over their first `n` samples. */
      apart(a: Float32Array, b: Float32Array, n = Math.min(a.length, b.length)): number {
        let most = 0;
        for (let i = 0; i < n; i++) most = Math.max(most, Math.abs(a[i] - b[i]));
        return most;
      },
      peak(x: Float32Array): number {
        let most = 0;
        for (let i = 0; i < x.length; i++) most = Math.max(most, Math.abs(x[i]));
        return most;
      },
      /**
       * Nine seconds from `start`, rendered the way an export does: four seconds at a time, with
       * what an export carries from one chunk to the next where `runs` is given.
       */
      async chunked(project: any, start: number, runs?: unknown) {
        const rate = project.settings.sampleRate;
        const parts = [
          await kit.render(project, start, 4, runs),
          await kit.render(project, start + 4, 4, runs),
          await kit.render(project, start + 8, 1, runs),
        ];
        const joined = new Float32Array(9 * rate);
        parts.forEach((part, i) => joined.set(part, i * 4 * rate));
        return { joined, lengths: parts.map((part) => part.length) };
      },
      /** Where the `count` loudest samples of `x` fall, one to a click, in order. */
      loudest(x: Float32Array, count: number): number[] {
        const y = Float32Array.from(x, Math.abs);
        const found: number[] = [];
        for (let n = 0; n < count; n++) {
          let peak = 0;
          for (let i = 0; i < y.length; i++) if (y[i] > y[peak]) peak = i;
          found.push(peak);
          y.fill(0, Math.max(0, peak - 400), peak + 400);
        }
        return found.sort((a, b) => a - b);
      },
      /**
       * Where the click whose loudest sample is `peak` lies, to a fraction of a sample. A click of
       * one sample that has been read between samples is the reading filter's response about the
       * click's place, the same before it as after it: at a low frequency, the phase of that
       * response says where the place is.
       */
      place(x: Float32Array, peak: number, rate: number): number {
        const w = (2 * Math.PI * 750) / rate;
        let [re, im] = [0, 0];
        for (let k = -160; k <= 160; k++) {
          re += x[peak + k] * Math.cos(w * k);
          im -= x[peak + k] * Math.sin(w * k);
        }
        return peak - Math.atan2(im, re) / w;
      },
      /**
       * The frequency of the tone in `x[from..to)`, counted from the first time it rises through
       * zero to the last, and the sample half-way between those two.
       */
      frequency(x: Float32Array, from: number, to: number, rate: number) {
        const rises: number[] = [];
        for (let i = from + 1; i < to; i++)
          if (x[i - 1] < 0 && x[i] >= 0) rises.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]));
        const [first, last] = [rises[0], rises[rises.length - 1]];
        return { hz: ((rises.length - 1) * rate) / (last - first), at: (first + last) / 2, first, last };
      },
      /**
       * Note every stretch of sound a mixer hands to the browser from now on: the voice it is
       * for (the node it plays into), where it starts in samples of its context, how far ahead of
       * the clock it was handed over, what it plays and how fast.
       */
      listen() {
        const started: any[] = [];
        const into = new WeakMap<AudioNode, unknown>();
        const connect = AudioNode.prototype.connect as (...args: unknown[]) => unknown;
        (AudioNode.prototype as any).connect = function (this: AudioNode, ...args: unknown[]) {
          if (this instanceof AudioBufferSourceNode) into.set(this, args[0]);
          return connect.apply(this, args);
        };
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
          const { length, sampleRate } = this.buffer!;
          const first = Math.round(offset * sampleRate);
          const count = duration === undefined ? length - first : Math.ceil(duration * sampleRate - 1e-6);
          started.push({
            voice: into.get(this),
            context: this.context,
            at: when * this.context.sampleRate,
            lead: when - this.context.currentTime,
            wall: performance.now(),
            samples: this.buffer!.getChannelData(0).subarray(first, first + count),
            rate: sampleRate,
            speed: this.playbackRate.value,
            // From its first sample to its last, and from a whole sample of it.
            whole: first === 0 && count === length,
            between: Math.abs(offset * sampleRate - first) > 1e-6,
          });
          return start.call(this, when, offset, duration);
        };
        return {
          started,
          stop() {
            (AudioNode.prototype as any).connect = connect;
            AudioBufferSourceNode.prototype.start = start;
          },
        };
      },
      /**
       * What one voice plays on samples `[from, from + length)` of its context, out of the
       * stretches noted for it at the context's rate, and how many of those samples none of them
       * covers or more than one does: a stretch that was late has lost its beginning.
       */
      heard(stretches: any[], from: number, length: number) {
        const mix = new Float32Array(length);
        const times = new Uint8Array(length);
        for (const { at, samples } of stretches) {
          const first = Math.round(at);
          for (let i = Math.max(0, from - first); i < samples.length && first + i - from < length; i++) {
            mix[first + i - from] += samples[i];
            times[first + i - from]++;
          }
        }
        return {
          mix,
          missing: times.filter((n) => n === 0).length,
          twice: times.filter((n) => n > 1).length,
        };
      },
      /**
       * Play `project` through a mixer of its own on a live context, as a player does: from
       * `startSec` of the timeline, which sounds 0.3 s from now (`t0` on the context's clock), for
       * `seconds` from then. Returns what the mixer handed to the browser.
       */
      async preview(project: any, startSec: number, endSec: number, seconds: number, rate = 1) {
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const noted = kit.listen();
        const problems: string[] = [];
        const graph = new engine.AudioGraph(ctx, lab.library, true);
        graph.onProblem = (p: any) => problems.push(`${p.reason} ${p.lost ?? ''} ${p.cause ?? ''}`);
        const began = performance.now();
        const t0 = ctx.currentTime + 0.3;
        graph.start(project, { startSec, t0, rate, endSec });
        const pump = setInterval(() => void graph.pump(), 200);
        void graph.pump();
        while (ctx.currentTime < t0 + seconds) await new Promise((res) => setTimeout(res, 100));
        clearInterval(pump);
        graph.dispose();
        await ctx.close();
        noted.stop();
        return { started: noted.started, t0, began, problems };
      },
      /**
       * The pitch and level of a tone near `hz` in `x[from..to)`: how its phase against a tone of
       * exactly `hz` moves from one hundredth of a second to the next gives the pitch, to a
       * fraction of a hertz. The level is in dB relative to a sine of amplitude `amp`.
       */
      pitch(x: Float32Array, hz: number, rate: number, amp: number, from: number, to: number) {
        const size = Math.round(rate / 100);
        const phases: number[] = [];
        let power = 0;
        for (let at = from; at + size <= to; at += size) {
          let [re, im] = [0, 0];
          for (let i = at; i < at + size; i++) {
            const w = (2 * Math.PI * hz * i) / rate;
            re += x[i] * Math.sin(w);
            im += x[i] * Math.cos(w);
          }
          power += ((2 * Math.hypot(re, im)) / size) ** 2;
          const phase = Math.atan2(im, re);
          const last = phases.length ? phases[phases.length - 1] : phase;
          phases.push(phase + 2 * Math.PI * Math.round((last - phase) / (2 * Math.PI)));
        }
        // The slope of the line through the phases, by least squares.
        const n = phases.length;
        const mean = phases.reduce((a, b) => a + b, 0) / n;
        let [up, down] = [0, 0];
        phases.forEach((phase, k) => {
          up += (k - (n - 1) / 2) * (phase - mean);
          down += (k - (n - 1) / 2) ** 2;
        });
        return {
          hz: hz + ((up / down) * rate) / (2 * Math.PI * size),
          level: 10 * Math.log10(power / n / (amp * amp) + 1e-30),
        };
      },
      /**
       * The `hz` component of `x[from..to)` by least squares: its level, and the level of everything
       * that is left when it is taken out, both in dB relative to a sine of amplitude `amp`.
       */
      purity(x: Float32Array, hz: number, rate: number, amp: number, from: number, to: number) {
        let [ss, sc, cc, ys, yc] = [0, 0, 0, 0, 0];
        for (let i = from; i < to; i++) {
          const w = (2 * Math.PI * hz * i) / rate;
          const [sin, cos] = [Math.sin(w), Math.cos(w)];
          ss += sin * sin;
          sc += sin * cos;
          cc += cos * cos;
          ys += x[i] * sin;
          yc += x[i] * cos;
        }
        const det = ss * cc - sc * sc;
        const a = (ys * cc - yc * sc) / det;
        const b = (yc * ss - ys * sc) / det;
        let rest = 0;
        for (let i = from; i < to; i++) {
          const w = (2 * Math.PI * hz * i) / rate;
          rest += (x[i] - a * Math.sin(w) - b * Math.cos(w)) ** 2;
        }
        return {
          gain: 20 * Math.log10(Math.hypot(a, b) / amp + 1e-30),
          rest: 10 * Math.log10(rest / (to - from) / ((amp * amp) / 2) + 1e-30),
        };
      },
    };
    (window as any).kit = kit;
  });
}

test.describe('speed ramps and kept pitch in the engine', () => {
  test('a clip without a ramp that does not keep its pitch is mixed as it was, to the sample', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      const assets = [
        await kit.add('dat', kit.noise(48000, 30, 4321), 48000),
        await kit.add('cd', kit.noise(44100, 30, 1234), 44100),
      ];
      // 29.97 fps: four frames in five begin between two samples at 48 kHz.
      const ntsc = { fpsNum: 30000, fpsDen: 1001, sampleRate: 48000 };
      const fps = 30000 / 1001;
      /** The project as one made before there were ramps: its clips have neither field. */
      const before = (project: any) => ({
        ...project,
        clips: Object.fromEntries(
          Object.entries(project.clips).map(([id, { ramp: _ramp, keepPitch: _keepPitch, ...clip }]: any) => [
            id,
            clip,
          ]),
        ),
      });
      /**
       * One clip at a time: several voices are added up in an order that is the browser's own, and
       * two renders of the same mix can differ in the last bit for that alone.
       */
      const compare = async (clips: object[], seconds: number, settings = ntsc) => {
        const worst = { fields: 0, apart: 0, chunked: 0, quietest: Infinity };
        for (const clip of clips) {
          const project = kit.project(assets, [{ type: 'audio', ...clip }], settings);
          const old = before(project);
          worst.fields += Object.values(old.clips).filter((c: any) => 'ramp' in c || 'keepPitch' in c).length;
          const [now, then] = [await kit.render(project, 0, seconds), await kit.render(old, 0, seconds)];
          // In the chunks of an export as well, with what an export carries from one to the next.
          const chunked = async (p: any) => {
            const runs = new engine.AudioRuns(seconds);
            const parts = [await kit.render(p, 0, 1.5, runs), await kit.render(p, 1.5, seconds - 1.5, runs)];
            runs.dispose();
            const joined = new Float32Array(parts[0].length + parts[1].length);
            joined.set(parts[0]);
            joined.set(parts[1], parts[0].length);
            return joined;
          };
          worst.apart = Math.max(worst.apart, kit.apart(now, then));
          worst.chunked = Math.max(worst.chunked, kit.apart(await chunked(project), await chunked(old)));
          worst.quietest = Math.min(worst.quietest, kit.peak(now));
        }
        return worst;
      };
      const plain = await compare(
        [
          { assetId: 'dat', start: 7, duration: 100, sourceIn: 5 / fps },
          { assetId: 'cd', start: 3, duration: 110, speed: 1.5, keepPitch: false },
          { assetId: 'dat', start: 11, duration: 90, speed: 0.5, reverse: true, keepPitch: false },
          // Keep pitch at exactly 100 %: there is nothing to keep.
          { assetId: 'cd', start: 2, duration: 120, sourceIn: 0.3, keepPitch: true },
          { assetId: 'dat', start: 5, duration: 100, reverse: true, keepPitch: true },
        ],
        4.5,
      );
      // Beyond what the stretcher is made for the pitch follows the speed, as it always did.
      const outside = await compare(
        [
          { assetId: 'dat', start: 3, duration: 100, sourceIn: 0.2, speed: 0.05, keepPitch: true },
          { assetId: 'cd', start: 9, duration: 90, speed: 0.09, keepPitch: true },
          { assetId: 'dat', start: 4, duration: 60, speed: 11, keepPitch: true },
          { assetId: 'cd', start: 20, duration: 8, speed: 100, keepPitch: true },
        ],
        3.6,
      );
      // Inside it the switch is heard: the comparison above is not one of a render with itself.
      const inside = await compare(
        [{ assetId: 'dat', start: 3, duration: 100, speed: 2, keepPitch: true }],
        3.6,
      );
      // So it is at a tenth of the speed and at ten times it, the two ends of what the stretcher
      // is made for. At some frame rates the mixer's own arithmetic makes a hair less of the one
      // and a hair more of the other (`speed` is what it works out), which is not what decides.
      const ends: Record<string, { speed: number; apart: number }> = {};
      for (const [name, speed, fpsNum, fpsDen] of [
        ['a tenth at 29.97 fps', 0.1, 30000, 1001],
        ['a tenth at 2997/100 fps', 0.1, 2997, 100],
        ['ten times at 29.97 fps', 10, 30000, 1001],
        ['ten times at 1000/33 fps', 10, 1000, 33],
      ] as const) {
        const settings = { fpsNum, fpsDen, sampleRate: 48000 };
        const clip = { assetId: 'dat', start: 3, duration: 60, speed, keepPitch: true };
        const project = kit.project(assets, [{ type: 'audio', ...clip }], settings);
        const [made] = Object.values(project.clips);
        ends[name] = {
          speed: core.sourcePerFrame(made, project) * (fpsNum / fpsDen),
          apart: (await compare([clip], 2.4, settings)).apart,
        };
      }
      return { plain, outside, inside, ends };
    });
    expect(r.plain).toMatchObject({ fields: 0, apart: 0, chunked: 0 });
    expect(r.plain.quietest).toBeGreaterThan(0.1);
    expect(r.outside).toMatchObject({ fields: 0, apart: 0, chunked: 0 });
    expect(r.outside.quietest).toBeGreaterThan(0.01);
    expect(r.inside.apart).toBeGreaterThan(0.1);
    expect(r.ends['a tenth at 2997/100 fps'].speed).toBeLessThan(0.1);
    expect(r.ends['ten times at 1000/33 fps'].speed).toBeGreaterThan(10);
    for (const [name, end] of Object.entries(r.ends)) expect(end.apart, name).toBeGreaterThan(0.1);
    expect(errors).toEqual([]);
  });

  test('a clip whose in point lies at no time of its clock is silent, and the render ends', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const assets = [await kit.add('dat', kit.noise(48000, 12, 4321), 48000)];
      const up = [
        { m: 1, v: 0.5 },
        { m: 5, v: 2 },
      ];
      const down = [
        { m: 1, v: 2 },
        { m: 5, v: 0.5 },
      ];
      const out: Record<string, unknown> = {};
      for (const [name, clip] of Object.entries({
        // In its file, the clip sounds.
        sound: { ramp: up, sourceIn: 0.5 },
        // A second that no file has, at one speed with the pitch following and with it kept,
        slow: { speed: 0.05, keepPitch: true, sourceIn: 1e308 },
        kept: { speed: 2, keepPitch: true, sourceIn: 1e308 },
        // and on ramps. A ramp that ends at double speed gets there at a time that is still a
        // number, one that ends at half speed at none; before the file it is the other way round.
        up: { ramp: up, sourceIn: 1e308 },
        down: { ramp: down, keepPitch: true, sourceIn: 1e308 },
        early: { ramp: up, keepPitch: true, sourceIn: -1e308 },
        earlier: { ramp: down, sourceIn: -1e308 },
      })) {
        const project = kit.project(
          assets,
          [{ type: 'audio', assetId: 'dat', start: 5, duration: 60, ...clip }],
          { sampleRate: 48000 },
        );
        const problems: string[] = [];
        const render = async (runs?: unknown) =>
          kit.peak(
            (
              await engine.renderAudioChunk(
                project,
                lab.library,
                0,
                3,
                48000,
                undefined,
                (p: any) => problems.push(`${p.reason} ${p.lost ?? ''} ${p.cause ?? ''}`),
                runs,
              )
            ).getChannelData(0),
          );
        const runs = new engine.AudioRuns(3);
        const ended = await Promise.race([
          (async () => [await render(), await render(runs)])(),
          new Promise((resolve) => setTimeout(() => resolve('never'), 20_000)),
        ]).catch((err) => `threw ${err}`);
        runs.dispose();
        out[name] = { ended, problems };
      }
      return out;
    });
    const sound = r.sound as { ended: number[]; problems: string[] };
    expect(Math.min(...sound.ended)).toBeGreaterThan(0.2);
    expect(sound.problems).toEqual([]);
    // Nothing to play is not something gone wrong: no sound, no word of a failure, and an end.
    for (const name of ['slow', 'kept', 'up', 'down', 'early', 'earlier'])
      expect(r[name], name).toEqual({ ended: [0, 0], problems: [] });
    expect(errors).toEqual([]);
  });

  test('sound follows a speed ramp sample for sample: each where the map puts it, at the pitch of the speed there', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core } = lab;
      lab.init(160, 90);
      const clicksAt = [1, 2.5, 7.25];
      const clicks = (rate: number) => {
        const x = new Float32Array(rate * 13);
        for (const m of clicksAt) x[Math.round(m * rate)] = 0.9;
        return x;
      };
      const assets = [
        await kit.add('tone48', kit.sine(1000, 48000, 13), 48000),
        await kit.add('tone44', kit.sine(1000, 44100, 13), 44100),
        await kit.add('clicks48', clicks(48000), 48000),
        await kit.add('clicks44', clicks(44100), 44100),
        await kit.add('treble48', kit.sine(15000, 48000, 9), 48000),
        await kit.add('treble44', kit.sine(15000, 44100, 9), 44100),
      ];
      // 29.97 fps: four frames in five begin between two samples at 48 kHz.
      const ntsc = { fpsNum: 30000, fpsDen: 1001, sampleRate: 48000 };
      const fps = 30000 / 1001;
      // Half speed up to second 1 of the file, easing to double speed at second 7, and on at that.
      const ramp = [
        { m: 1, v: 0.5 },
        { m: 7, v: 2 },
      ];
      const shape = { start: 7, duration: 240, sourceIn: 0.4, ramp, keepPitch: false };
      const c = 7 / fps;
      const length = 240 / fps;
      const one = (clip: object) => kit.project(assets, [{ type: 'audio', ...clip }], ntsc);
      const only = (project: any) => Object.values(project.clips)[0] as any;

      const tone = async (assetId: string, placed: boolean) => {
        const project = one({ ...shape, assetId });
        const map = core.timeMap(only(project));
        const streamIn = map.stream(0.4);
        const start = 3 / fps;
        const { joined, lengths } = await kit.chunked(project, start);
        const whole = await kit.render(project, start, 9);
        const again = (await kit.chunked(project, start)).joined;
        let same = true;
        for (let i = 0; i < joined.length; i++) if (joined[i] !== again[i]) same = false;
        /** The second of the stream that sounds at sample `i` of the render. */
        const stream = (i: number) => streamIn + start + i / 48000 - c;
        // The clip without its two ends, where the sound starts and stops at once.
        const first = Math.ceil((c - start) * 48000) + 2400;
        const last = Math.floor((c + length - start) * 48000) - 2400;
        /** Everything that is not the tone read at each sample's own place, the voice `late` samples late. */
        const residue = (late: number) => {
          let rest = 0;
          for (let i = first; i < last; i++)
            rest +=
              (whole[i] - 0.5 * Math.sin(2 * Math.PI * 1000 * map.media(stream(i) - late / 48000))) ** 2;
          return 10 * Math.log10(rest / (last - first) / 0.125 + 1e-30);
        };
        // A stream at the mix's own rate is played sample for sample, so as a whole it lies on the
        // sample nearest its place, as every voice at that rate does: up to half a sample off.
        const off = (c - streamIn - start) * 48000;
        const lates = placed ? [Math.floor(off) - off, Math.ceil(off) - off] : [0];
        const late = lates.reduce((a, b) => (residue(a) <= residue(b) ? a : b));

        const places = [0.6, 3.6, 7].map((seconds) => {
          const middle = Math.round((c + seconds - start) * 48000);
          const { hz, at } = kit.frequency(whole, middle - 480, middle + 480, 48000);
          return { hz, speed: map.speed(stream(at)) };
        });

        /**
         * The largest bend (second difference) in `[from, to)` against that of the tone at the
         * speed there: a click shows as one, wherever on the ramp it falls.
         */
        const bend = (from: number, to: number) => {
          let most = 0;
          for (let i = from; i < to; i++) {
            const w = (Math.PI * 1000 * map.speed(stream(i))) / 48000;
            const steady = 0.5 * 4 * Math.sin(w) ** 2;
            most = Math.max(most, Math.abs(joined[i + 1] - 2 * joined[i] + joined[i - 1]) / steady);
          }
          return most;
        };
        const seams = [192000, 384000];
        const points = ramp.map(({ m }) => Math.round((c - start + map.stream(m) - streamIn) * 48000));
        let between = 0;
        let from = first;
        for (const mark of [...seams, ...points].sort((a, b) => a - b)) {
          between = Math.max(between, bend(from, mark - 64));
          from = mark + 64;
        }
        between = Math.max(between, bend(from, last));
        return {
          lengths,
          apart: kit.apart(joined, whole),
          same,
          late,
          residue: residue(late),
          places,
          between,
          atSeams: Math.max(...seams.map((at) => bend(at - 64, at + 64))),
          atPoints: Math.max(...points.map((at) => bend(at - 64, at + 64))),
        };
      };

      /** Where the clicks of a nine-second render fall, and where the map puts them. */
      const landed = async (clip: object) => {
        const project = one({ ...shape, ...clip });
        const made = only(project);
        const map = core.timeMap(made);
        const { joined } = await kit.chunked(project, 0);
        const found = kit.loudest(joined, 3).map((peak: number) => kit.place(joined, peak, 48000));
        // Seconds of the clip's own clock from its in point to each click.
        const into = clicksAt.map((m) => map.stream(m) - map.stream(0.4));
        return {
          found,
          ideal: made.reverse
            ? into.map((t) => (c + length - t) * 48000).reverse()
            : into.map((t) => (c + t) * 48000),
        };
      };

      const cut = async (assetId: string) => {
        const project = one({ ...shape, assetId });
        const { id, sourceIn } = only(project);
        const whole = await kit.render(project, 0, 9);
        // Frame 104 of the timeline is 3.2 s into the clip, in the middle of the ease.
        const halves = core.applyEdits(project, core.splitClips(project, [id], 104).edits);
        const trimmed = core.applyEdits(project, core.trimClips(project, [id], 'start', 13));
        const back = core.applyEdits(trimmed, core.trimClips(trimmed, [id], 'start', -13));
        const head = await kit.render(trimmed, 0, 9);
        const from = Math.ceil((20 / fps) * 48000) + 64;
        return {
          pieces: Object.keys(halves.clips).length,
          split: kit.apart(await kit.render(halves, 0, 9), whole),
          moved: trimmed.clips[id].sourceIn - sourceIn,
          trimmed: kit.apart(head.subarray(from), whole.subarray(from)),
          returned: Math.abs(back.clips[id].sourceIn - sourceIn),
          back: kit.apart(await kit.render(back, 0, 9), whole),
        };
      };

      /** A ramp that rests at normal speed from second 2.5 to second 3.5 of the file: the level through the rest. */
      const rest = async (assetId: string) => {
        const points = [
          { m: 1, v: 0.5 },
          { m: 2.5, v: 1 },
          { m: 3.5, v: 1 },
          { m: 5, v: 2 },
        ];
        const project = one({
          assetId,
          start: 4,
          duration: 200,
          sourceIn: 0.2,
          ramp: points,
          keepPitch: false,
        });
        const map = core.timeMap(only(project));
        const out = await kit.render(project, 0, 7);
        const from = Math.round((4 / fps + map.stream(2.5) - map.stream(0.2)) * 48000);
        const to = Math.round((4 / fps + map.stream(3.5) - map.stream(0.2)) * 48000);
        return { samples: to - from, ...kit.purity(out, 15000, 48000, 0.5, from + 2400, to - 2400) };
      };

      return {
        tone: { dat: await tone('tone48', true), cd: await tone('tone44', false) },
        clicks: {
          forwards: await landed({ assetId: 'clicks48' }),
          backwards: await landed({ assetId: 'clicks48', reverse: true }),
          convertedForwards: await landed({ assetId: 'clicks44' }),
          convertedBackwards: await landed({ assetId: 'clicks44', reverse: true }),
        },
        cut: { dat: await cut('tone48'), cd: await cut('tone44') },
        rest: { dat: await rest('treble48'), cd: await rest('treble44') },
      };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    for (const name of ['dat', 'cd'] as const) {
      const m = r.tone[name];
      expect(m.lengths, name).toEqual([192000, 192000, 48000]);
      // In chunks or in one go: the same sound, and the same bytes every time.
      expect(m.apart, name).toBeLessThan(1e-6);
      expect(m.same, name).toBe(true);
      // Nothing but the tone read along the map, 80 dB under it.
      expect(Math.abs(m.late), name).toBeLessThanOrEqual(0.5);
      expect(m.residue, name).toBeLessThan(-80);
      for (const { hz, speed } of m.places)
        expect(Math.abs(hz / (1000 * speed) - 1), name).toBeLessThan(0.005);
      // No click where two chunks meet or where the speed begins and ends its change.
      expect(m.between, name).toBeGreaterThan(0.98);
      expect(m.between, name).toBeLessThan(1.02);
      expect(m.atSeams, name).toBeLessThan(m.between * 1.001);
      expect(m.atPoints, name).toBeLessThan(m.between * 1.001);

      const c = r.cut[name];
      expect(c.pieces, name).toBe(2);
      expect(c.split, name).toBeLessThan(1e-6);
      expect(c.moved, name).toBeGreaterThan(0.2);
      expect(c.trimmed, name).toBeLessThan(1e-6);
      expect(c.returned, name).toBeLessThan(1e-9);
      expect(c.back, name).toBeLessThan(1e-6);

      // A second of the file at normal speed in mid-ramp, read like the rest: not dulled.
      expect(r.rest[name].samples, name).toBe(48000);
      expect(Math.abs(r.rest[name].gain), name).toBeLessThan(0.1);
    }
    // A click sounds where the map puts it. Backwards it is heard one sample of the stream early,
    // as it is without a ramp. A stream at the mix's rate lies on the mix's samples, up to half a
    // sample from its place; one at another rate is converted to its exact place.
    for (const [name, early, within] of [
      ['forwards', 0, 0.51],
      ['backwards', 1, 0.51],
      ['convertedForwards', 0, 0.01],
      ['convertedBackwards', 48000 / 44100, 0.01],
    ] as const) {
      const { found, ideal } = r.clicks[name];
      expect(found, name).toHaveLength(3);
      found.forEach((at: number, i: number) =>
        expect(Math.abs(at - (ideal[i] - early)), `${name} ${i}`).toBeLessThan(within),
      );
    }
    expect(errors).toEqual([]);
  });

  test('sound that keeps its pitch stays at its pitch, and is the same sound in chunks, in pieces and moved', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      const assets = [
        await kit.add('tone48', kit.sine(1000, 48000, 20), 48000),
        await kit.add('tone44', kit.sine(1000, 44100, 20), 44100),
        // Vorbis in WebM: a decode that starts part-way does not place its sound where the
        // decode before it placed the same sound.
        await lab.addFile('sweep', '/fixtures/sweep-vorbis.webm', 'sweep-vorbis.webm'),
      ];
      // A tone with a burst of 5 ms on every half second of the file. At 125 % from the start of
      // the file a burst lies on each place where the chain of grains is brought back to its map.
      const beat = kit.sine(1000, 48000, 13, 0.25);
      for (let i = 12000; i < beat.length; i++) {
        const t = (i % 24000) / 48000;
        if (t < 0.005) beat[i] += 0.4 * Math.sin(2 * Math.PI * 4000 * t);
      }
      assets.push(await kit.add('beat48', beat, 48000));
      const ntsc = { fpsNum: 30000, fpsDen: 1001, sampleRate: 48000 };
      const fps = 30000 / 1001;
      const one = (clip: object, settings: object = ntsc) =>
        kit.project(assets, [{ type: 'audio', ...clip }], settings);
      const only = (project: any) => Object.values(project.clips)[0] as any;
      // Up to three times the speed, down to half and back, by way of a stretch at half speed.
      const sixPoints = [
        { m: 1, v: 1 },
        { m: 3, v: 3 },
        { m: 4.5, v: 0.5 },
        { m: 6, v: 0.5 },
        { m: 8, v: 2 },
        { m: 10, v: 1 },
      ];
      const kinds: Record<string, object> = {
        half: { speed: 0.5 },
        double: { speed: 2 },
        doubleBackwards: { speed: 2, reverse: true },
        ramp: { ramp: sixPoints },
      };
      const start = 3 / fps;
      const placed = { start: 7, duration: 260, sourceIn: 0.4, keepPitch: true };
      // The clip without its two ends, in samples of a render from `start`.
      const inside = [
        Math.ceil((7 / fps - start) * 48000) + 4800,
        Math.floor((267 / fps - start) * 48000) - 4800,
      ];

      const measure = async (kind: object, assetId: string) => {
        const project = one({ ...placed, ...kind, assetId });
        const whole = await kit.render(project, start, 9);
        // Four seconds at a time, each chunk decoding and stretching for itself,
        const alone = await kit.chunked(project, start);
        // and with what an export carries from one chunk to the next.
        const runs = new engine.AudioRuns(start + 9);
        const carried = await kit.chunked(project, start, runs);
        runs.dispose();
        // Every two seconds of the clip, and all of it.
        const blocks = [];
        for (let at = inside[0]; at + 96000 <= inside[1]; at += 96000)
          blocks.push(kit.pitch(whole, 1000, 48000, 0.5, at, at + 96000));
        const { id } = only(project);
        // Frame 131 of the timeline is 4.1 s into the clip.
        const halves = core.applyEdits(project, core.splitClips(project, [id], 131).edits);
        return {
          lengths: [alone.lengths, carried.lengths],
          alone: kit.apart(alone.joined, whole),
          carried: kit.apart(carried.joined, whole),
          all: kit.pitch(whole, 1000, 48000, 0.5, inside[0], inside[1]),
          offPitch: Math.max(...blocks.map((b) => Math.abs(b.hz - 1000))),
          offLevel: Math.max(...blocks.map((b) => Math.abs(b.level))),
          pieces: Object.keys(halves.clips).length,
          split: kit.apart(await kit.render(halves, start, 9), whole),
        };
      };

      /** In a 30 fps project seven frames are 11 200 samples: the clip moved by that, sample for sample. */
      const moved = async (kind: object, assetId: string) => {
        const film = { fpsNum: 30, fpsDen: 1, sampleRate: 48000 };
        const at = (frame: number) =>
          kit.render(one({ ...placed, ...kind, assetId, start: frame }, film), 0, 9);
        const [here, there] = [await at(10), await at(17)];
        return { apart: kit.apart(there.subarray(11200), here, 432000 - 11200), peak: kit.peak(here) };
      };

      /** A lossy file, in the chunks of an export against one render. */
      const lossy = async (clip: object, rate: number) => {
        const project = one({ assetId: 'sweep', keepPitch: true, ...clip }, { sampleRate: rate });
        const whole = await kit.render(project, 0, 9);
        const runs = new engine.AudioRuns(9);
        const carried = await kit.chunked(project, 0, runs);
        runs.dispose();
        return {
          rate,
          apart: kit.apart(carried.joined, whole),
          lengths: carried.lengths,
          peak: kit.peak(whole),
        };
      };

      /** How far off 1 kHz the tone under the bursts is in each two seconds of the grains, in Hz. */
      const beaten = async () => {
        const film = { fpsNum: 30, fpsDen: 1, sampleRate: 48000 };
        const clip = { assetId: 'beat48', start: 0, duration: 270, speed: 1.25, keepPitch: true };
        const whole = await kit.render(one(clip, film), 0, 9);
        const off = [];
        for (let at = 0; at + 96000 <= whole.length; at += 96000)
          off.push(kit.pitch(whole, 1000, 48000, 0.25, at, at + 96000).hz - 1000);
        return { off, peak: kit.peak(whole) };
      };

      const out: Record<string, unknown> = {};
      for (const [name, kind] of Object.entries(kinds)) {
        out[name] = {
          dat: { ...(await measure(kind, 'tone48')), moved: await moved(kind, 'tone48') },
          cd: { ...(await measure(kind, 'tone44')), moved: await moved(kind, 'tone44') },
        };
      }
      // For comparison: the same file at normal speed, which the mixer plays as it is.
      const plain = one({ ...placed, keepPitch: null, assetId: 'tone48' });
      return {
        kinds: out as Record<string, Record<string, any>>,
        plain: kit.apart((await kit.chunked(plain, start)).joined, await kit.render(plain, start, 9)),
        beaten: await beaten(),
        lossy: {
          slower: await lossy({ start: 3, duration: 266, speed: 0.5 }, 44100),
          slowerConverted: await lossy({ start: 3, duration: 266, speed: 0.5 }, 48000),
          fasterBackwards: await lossy(
            { start: 2, duration: 180, sourceIn: 0.2, speed: 1.5, reverse: true },
            48000,
          ),
          ramp: await lossy({ start: 5, duration: 240, sourceIn: 0.1, ramp: sixPoints }, 44100),
        },
      };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    for (const kind of ['half', 'double', 'doubleBackwards', 'ramp']) {
      for (const source of ['dat', 'cd']) {
        const m = r.kinds[kind][source];
        const name = `${kind}, ${source}`;
        expect(m.lengths, name).toEqual([
          [192000, 192000, 48000],
          [192000, 192000, 48000],
        ]);
        // A chunk that decodes and stretches for itself makes the samples one render makes.
        expect(m.alone, name).toBeLessThan(1e-6);
        expect(m.carried, name).toBeLessThan(1e-6);
        // 1 kHz stays 1 kHz, where without the switch it is 500 Hz and 2 kHz.
        expect(Math.abs(m.all.hz - 1000), name).toBeLessThan(1.5);
        expect(Math.abs(m.all.level), name).toBeLessThan(0.5);
        expect(m.offPitch, name).toBeLessThan(1.5);
        expect(m.offLevel, name).toBeLessThan(0.5);
        expect(m.pieces, name).toBe(2);
        expect(m.split, name).toBeLessThan(1e-6);
        expect(m.moved.peak, name).toBeGreaterThan(0.4);
        expect(m.moved.apart, name).toBeLessThan(1e-6);
      }
      // A stream at the mix's rate is played sample for sample, as a clip at normal speed is: what
      // chunks differ by is what the browser's own start part-way into a buffer differs by.
      expect(r.kinds[kind].dat.alone, kind).toBeLessThan(Math.max(1e-9, 10 * r.plain));
    }
    // What comes round with the grains does not pull the tone off its pitch: slid out over two
    // seconds, the 5 ms between the burst and the map were 2.5 Hz, in every block alike.
    expect(r.beaten.off).toHaveLength(4);
    for (const hz of r.beaten.off) expect(Math.abs(hz)).toBeLessThan(0.3);
    expect(r.beaten.peak).toBeGreaterThan(0.5);
    for (const name of ['slower', 'slowerConverted', 'fasterBackwards', 'ramp'] as const) {
      const m = r.lossy[name];
      expect(m.lengths, name).toEqual([4 * m.rate, 4 * m.rate, m.rate]);
      expect(m.peak, name).toBeGreaterThan(0.1);
      expect(m.apart, name).toBeLessThan(1e-6);
    }
    expect(errors).toEqual([]);
  });

  test('sound that keeps its pitch puts a click near its place, and joins without a seam where chunks and blocks of grains meet', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core } = lab;
      lab.init(160, 90);
      // Clicks of a millisecond every 0.2173 s of the file, over noise 60 dB down.
      const times: number[] = [];
      for (let t = 0.731; t < 19; t += 0.2173) times.push(t);
      let seed = 7;
      const clicks = Float32Array.from({ length: 48000 * 20 }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return 0.001 * ((seed % 20001) / 10000 - 1);
      });
      for (const t of times)
        for (let i = 0; i < 48; i++)
          clicks[Math.round(t * 48000) + i] += 0.8 * Math.exp(-i / 12) * (i % 2 ? -1 : 1);
      const assets = [
        await kit.add('clicks', clicks, 48000),
        await kit.add('low48', kit.sine(220, 48000, 20), 48000),
        await kit.add('low44', kit.sine(220, 44100, 20), 44100),
      ];
      const ntsc = { fpsNum: 30000, fpsDen: 1001, sampleRate: 48000 };
      const fps = 30000 / 1001;
      const sixPoints = [
        { m: 1, v: 1 },
        { m: 3, v: 3 },
        { m: 4.5, v: 0.5 },
        { m: 6, v: 0.5 },
        { m: 8, v: 2 },
        { m: 10, v: 1 },
      ];
      const kinds: Record<string, object> = {
        half: { speed: 0.5 },
        double: { speed: 2 },
        doubleBackwards: { speed: 2, reverse: true },
        ramp: { ramp: sixPoints },
      };
      const start = 3 / fps;
      const placed = { start: 7, duration: 260, sourceIn: 0.4, keepPitch: true };
      const one = (clip: object) => kit.project(assets, [{ type: 'audio', ...placed, ...clip }], ntsc);
      // The clip in samples of a render from `start`, and the clip without its two ends.
      const [from, to] = [(7 / fps - start) * 48000, (267 / fps - start) * 48000];
      const inside = [Math.ceil(from) + 4800, Math.floor(to) - 4800];
      /** Where second `tau` of the stream of `clip`, counted from its in point, sounds in the render. */
      const sounds = (clip: any, tau: number) => (clip.reverse ? to - tau * 48000 : from + tau * 48000);

      const landed = async (kind: object) => {
        const project = one({ ...kind, assetId: 'clicks' });
        const clip = Object.values(project.clips)[0] as any;
        const map = core.timeMap(clip);
        const out = await kit.render(project, start, 9);
        const found = [];
        for (const t of times) {
          const tau = map.stream(t) - map.stream(0.4);
          const place = sounds(clip, tau);
          if (place < inside[0] || place > inside[1]) continue;
          // The loudest sample within 30 ms of the click's place: at three times the speed the
          // next click is 72 ms on.
          let where = Math.round(place) - 1440;
          for (let i = where; i < Math.round(place) + 1440; i++)
            if (Math.abs(out[i]) > Math.abs(out[where])) where = i;
          found.push({
            speed: map.speed(map.stream(t)),
            peak: Math.abs(out[where]),
            late: ((where - place) / 48000) * 1000,
          });
        }
        // A click is there when it is no more than 12 dB down.
        const present = found.filter((click) => click.peak >= 0.2);
        const off = (some: { late: number }[]) => Math.max(0, ...some.map((click) => Math.abs(click.late)));
        const moderate = present.filter((click) => click.speed >= 0.75 && click.speed <= 1.5);
        return {
          clicks: found.length,
          present: present.length,
          off: off(present),
          moderate: moderate.length,
          offModerate: off(moderate),
        };
      };

      /** The largest bend (second difference) of `x` in `[from, to)`: a click shows as one. */
      const bend = (x: Float32Array, from: number, to: number) => {
        let most = 0;
        for (let i = from; i < to; i++) most = Math.max(most, Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]));
        return most;
      };
      const joins = async (kind: object, assetId: string, rate: number) => {
        const project = one({ ...kind, assetId });
        const clip = Object.values(project.clips)[0] as any;
        const streamIn = core.timeMap(clip).stream(0.4);
        const { joined } = await kit.chunked(project, start);
        const seams = [192000, 384000];
        // A block of grains is two seconds of the stream, counted from its second 0.
        const blocks = [];
        for (let k = Math.ceil(streamIn / 2); ; k++) {
          const at = Math.round(sounds(clip, 2 * k - streamIn));
          if (at < inside[0] || at > inside[1]) break;
          blocks.push(at);
        }
        let between = 0;
        let last = inside[0];
        for (const mark of [...seams, ...blocks].sort((a, b) => a - b)) {
          between = Math.max(between, bend(joined, last, mark - 64));
          last = mark + 64;
        }
        between = Math.max(between, bend(joined, last, inside[1]));
        return {
          rate,
          blocks: blocks.length,
          between,
          atSeams: Math.max(...seams.map((at) => bend(joined, at - 64, at + 64))),
          atBlocks: Math.max(...blocks.map((at) => bend(joined, at - 64, at + 64))),
        };
      };

      const out: Record<string, any> = {};
      for (const [name, kind] of Object.entries(kinds))
        out[name] = {
          clicks: await landed(kind),
          dat: await joins(kind, 'low48', 48000),
          cd: await joins(kind, 'low44', 44100),
        };
      return out;
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    // Slowed down, every click is there, within 22 ms of where the map puts it.
    expect(r.half.clicks.clicks).toBeGreaterThan(16);
    expect(r.half.clicks.present).toBe(r.half.clicks.clicks);
    expect(r.half.clicks.off).toBeLessThan(22);
    // At twice the speed a click of a millisecond that falls between two grains taken 20 ms apart
    // is not played: a stated limit. Those that are played lie within 10 ms.
    for (const name of ['double', 'doubleBackwards']) {
      expect(r[name].clicks.clicks, name).toBeGreaterThan(70);
      expect(r[name].clicks.present / r[name].clicks.clicks, name).toBeGreaterThan(0.4);
      expect(r[name].clicks.off, name).toBeLessThan(10);
    }
    // Along the ramp, where it runs between three quarters of the speed and one and a half times.
    expect(r.ramp.clicks.moderate).toBeGreaterThan(4);
    expect(r.ramp.clicks.offModerate).toBeLessThan(12);
    // 220 Hz at half scale bends by 0.00041 from sample to sample. Where two chunks of an export
    // meet, and where one block of grains ends and the next begins, it bends no more than anywhere.
    for (const name of ['half', 'double', 'doubleBackwards', 'ramp'])
      for (const source of ['dat', 'cd']) {
        const m = r[name][source];
        expect(m.blocks, `${name}, ${source}`).toBeGreaterThanOrEqual(3);
        expect(m.between, `${name}, ${source}`).toBeGreaterThan(0.0004);
        expect(m.atSeams, `${name}, ${source}`).toBeLessThan(m.between * 1.001);
        expect(m.atBlocks, `${name}, ${source}`).toBeLessThan(m.between * 1.001);
      }
    expect(errors).toEqual([]);
  });

  test('a clip on a speed ramp shows the frame of its file that the map names, whole and cut into pieces', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      // The file's 120 frames, as a clip at normal speed shows them.
      const plain = kit.project([vid], [{ assetId: 'vid', start: 0, duration: 120 }]);
      const want: number[] = [];
      for (let f = 0; f < 120; f++) want.push(kit.hash((await lab.renderFrame(plain, f)).pixels));

      /** The clip on "Ramp up": from half speed to double over the four seconds of the file. */
      const rampedUp = (reverse: boolean) => {
        const base = kit.project([vid], [{ assetId: 'vid', start: 0, duration: 120, reverse }]);
        const id = Object.keys(base.clips)[0];
        const ramp = core.shapeRamp('rampUp', 0, 4, reverse);
        return core.applyEdits(base, core.setRamp(base, [id], { ramps: { [id]: ramp } }));
      };
      /** Every frame of the one clip of `project` against the frame of the file the map names. */
      const frames = async (project: any) => {
        lab.init(160, 90);
        const clip = Object.values(project.clips)[0] as any;
        const got: number[] = [];
        const named: number[] = [];
        let [wrong, unsure] = [0, 0];
        for (let f = 0; f < clip.duration; f++) {
          got.push(kit.hash((await lab.renderFrame(project, f)).pixels));
          const { frame, sure } = kit.shown(core.sourceTimeAt(clip, f, project));
          named.push(frame);
          if (!sure) unsure++;
          else if (got[f] !== want[frame]) wrong++;
        }
        return { got, named, wrong, unsure, frames: clip.duration };
      };
      const up = rampedUp(false);
      const forwards = await frames(up);
      const backwards = await frames(rampedUp(true));

      // Cut in four at frames in mid-ease, and stepped through from a fresh start.
      const id = Object.keys(up.clips)[0];
      let cut = up;
      for (const at of [20, 47, 71])
        cut = core.applyEdits(cut, core.splitClips(cut, Object.keys(cut.clips), at).edits);
      lab.init(160, 90);
      kit.decoders.started = 0;
      let same = 0;
      for (let f = 0; f < forwards.frames; f++)
        if (kit.hash((await lab.renderFrame(cut, f)).pixels) === forwards.got[f]) same++;
      const pieces = {
        clips: Object.keys(cut.clips).length,
        ramps: new Set(Object.values(cut.clips).map((c: any) => c.ramp)).size,
        same,
        started: kit.decoders.started,
        decoders: lab.sources.stats().decoders,
      };

      // Played: no decoder is started ahead of a cut for the piece that follows it.
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const player = new engine.Player(canvas, cut, lab.resolver);
      player.setQuality(1);
      player.seek(4);
      const settled = performance.now() + 10_000;
      while (performance.now() < settled && player.sources.stats().frames < 5)
        await new Promise((res) => setTimeout(res, 50));
      kit.decoders.started = 0;
      let warmed = 0;
      const manager = engine.SourceManager.prototype;
      const prewarm = manager.prewarm;
      manager.prewarm = function (upcoming: unknown[]) {
        warmed += upcoming.length;
        return prewarm.call(this, upcoming);
      };
      let peak = 0;
      const off = player.onFrame(() => {
        peak = Math.max(peak, player.sources.stats().decoders);
      });
      player.play();
      const until = performance.now() + 20_000;
      while (performance.now() < until && player.getFrame() < 80)
        await new Promise((res) => requestAnimationFrame(res));
      player.pause();
      off();
      manager.prewarm = prewarm;
      const playing = { played: player.getFrame() - 4, started: kit.decoders.started, warmed, peak };
      player.dispose();
      canvas.remove();

      const steps = (named: number[]) => named.slice(1).map((frame, i) => frame - named[i]);
      return {
        distinct: new Set(want).size,
        whole: up.clips[id].duration,
        forwards: { ...forwards, got: undefined, named: undefined, steps: steps(forwards.named) },
        backwards: { ...backwards, got: undefined, named: undefined, steps: steps(backwards.named) },
        pieces,
        playing,
      };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    expect(r.distinct).toBe(120); // the file really has a different picture on every frame
    // Four seconds from half speed to double take 3.2 s.
    expect(r.whole).toBe(96);
    for (const name of ['forwards', 'backwards'] as const) {
      const m = r[name];
      expect(m.frames, name).toBe(96);
      expect(m.wrong, name).toBe(0);
      // Frames whose time lies on the edge between two frames of the file are not judged.
      expect(m.unsure, name).toBeLessThanOrEqual(4);
    }
    // Slow, a frame of the file is held; fast, frames are passed over.
    expect(Math.min(...r.forwards.steps.slice(0, 20))).toBe(0);
    expect(Math.max(...r.forwards.steps.slice(-20))).toBe(2);
    expect(Math.max(...r.forwards.steps)).toBeLessThanOrEqual(2);
    expect(Math.min(...r.backwards.steps)).toBeGreaterThanOrEqual(-2);
    expect(Math.max(...r.backwards.steps)).toBeLessThanOrEqual(0);
    // The pieces share the ramp of the clip they were cut from and show its frames, from one decoder.
    expect(r.pieces).toEqual({ clips: 4, ramps: 1, same: 96, started: 1, decoders: 1 });
    expect(r.playing.played).toBeGreaterThanOrEqual(60);
    expect(r.playing).toMatchObject({ started: 0, warmed: 0, peak: 1 });
    expect(errors).toEqual([]);
  });

  test('two ramped clips dissolve through frames of their handles, and an export of a ramped clip has the frames the map names', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const plain = kit.project([vid], [{ assetId: 'vid', start: 0, duration: 120 }]);
      const want: number[] = [];
      for (let f = 0; f < 120; f++) want.push(kit.hash((await lab.renderFrame(plain, f)).pixels));

      // The first second and a half of the file from half speed to double, then the last second
      // and a half from double to half, each 1.2 s long, with ten frames of dissolve over the cut.
      // Past its end the first clip runs on through its file at double speed, and so does the
      // second before its start: the dissolve mixes frames that neither clip shows by itself.
      const placed = [
        { assetId: 'vid', start: 0, duration: 36, sourceIn: 0 },
        {
          assetId: 'vid',
          start: 36,
          duration: 36,
          sourceIn: 2.5,
          transIn: core.makeTransition('crossDissolve', 10),
        },
      ];
      const dissolve = kit.project(
        [vid],
        [
          { ...placed[0], ramp: core.shapeRamp('rampUp', 0, 1.5, false) },
          { ...placed[1], ramp: core.shapeRamp('rampDown', 2.5, 4, false) },
        ],
      );
      // The same cut between two clips at normal speed, slipped for each frame so that they
      // show the two frames of the file named: what the dissolve of those two looks like.
      const base = kit.project([vid], placed);
      const [a, b] = Object.values(base.clips).sort((x: any, y: any) => x.start - y.start) as any[];
      const between = async (f: number, first: number, second: number) => {
        const project = core.applyEdits(base, [
          { op: 'updateClip', id: a.id, patch: { sourceIn: (first - f) / 30 } },
          { op: 'updateClip', id: b.id, patch: { sourceIn: (second - (f - 36)) / 30 } },
        ]);
        return kit.hash((await lab.renderFrame(project, f)).pixels);
      };
      const mixed: { f: number; first: number; second: number; sure: boolean; same: boolean }[] = [];
      for (let f = 31; f < 41; f++) {
        const layer = core.resolveFrame(dissolve, f).layers.find((l: any) => l.kind === 'transition');
        const [first, second] = [kit.shown(layer.a.sourceTime), kit.shown(layer.b.sourceTime)];
        const got = kit.hash((await lab.renderFrame(dissolve, f)).pixels);
        mixed.push({
          f,
          first: first.frame,
          second: second.frame,
          sure: first.sure && second.sure,
          same: got === (await between(f, first.frame, second.frame)),
        });
      }
      // Each clip's own frame at the cut, held through the other's half of the dissolve, would be
      // another picture: the first clip's last where it has ended, the second's first before it begins.
      const [outgoing, incoming] = Object.values(dissolve.clips).sort(
        (x: any, y: any) => x.start - y.start,
      ) as any[];
      const own = [
        kit.shown(core.sourceTimeAt(outgoing, 35, dissolve)).frame,
        kit.shown(core.sourceTimeAt(incoming, 0, dissolve)).frame,
      ];
      const [early, late] = [mixed[1], mixed[8]];
      const held = [
        kit.hash((await lab.renderFrame(dissolve, late.f)).pixels) ===
          (await between(late.f, own[0], late.second)),
        kit.hash((await lab.renderFrame(dissolve, early.f)).pixels) ===
          (await between(early.f, early.first, own[1])),
      ];

      // An export of the whole file on "Ramp up", every frame it draws looked at.
      const whole = kit.project([vid], [{ assetId: 'vid', start: 0, duration: 120 }]);
      const id = Object.keys(whole.clips)[0];
      const ramp = core.shapeRamp('rampUp', 0, 4, false);
      const up = core.applyEdits(whole, core.setRamp(whole, [id], { ramps: { [id]: ramp } }));
      const clip = up.clips[id];
      const named = Array.from({ length: clip.duration }, (_, f) =>
        kit.shown(core.sourceTimeAt(clip, f, up)),
      );
      lab.init(160, 90);
      await new Promise((res) => setTimeout(res, 200));
      const drawn: number[] = [];
      const compositor = engine.Compositor.prototype;
      const render = compositor.render;
      compositor.render = function (...args: unknown[]) {
        const stats = render.apply(this, args);
        drawn.push(kit.hash(this.readPixels()));
        return stats;
      };
      const out = await lab.exportBase64(up, {
        container: 'webm',
        videoCodec: 'vp9',
        audioCodec: 'opus',
        width: 160,
        height: 90,
        fpsNum: 30,
        fpsDen: 1,
        videoBitrate: 300_000,
        audioBitrate: 96_000,
        range: null,
        includeVideo: true,
        includeAudio: false,
        dynamicRange: 'sdr',
        keyFrameInterval: 1,
        hardwareAcceleration: 'no-preference',
      });
      compositor.render = render;
      const right = (f: number) => drawn[f] === want[named[f].frame];
      return {
        mixed,
        own,
        held,
        exported: {
          base64: out.base64,
          extension: out.extension,
          frames: out.frames,
          warnings: out.warnings,
          length: clip.duration,
          drawn: drawn.length,
          unsure: named.filter((n) => !n.sure).length,
          right: named.filter((n, f) => n.sure && right(f)).length,
          tenth: [named[9].frame, right(9)],
          middle: [named[48].frame, right(48)],
          end: [named[95].frame, right(95)],
        },
      };
    });
    const { base64, ...exported } = r.exported;
    await info.attach('measured', {
      body: JSON.stringify({ ...r, exported }, null, 1),
      contentType: 'application/json',
    });
    expect(r.mixed).toHaveLength(10);
    for (const w of r.mixed) if (w.sure) expect(w.same, `frame ${w.f}`).toBe(true);
    expect(r.mixed.filter((w) => !w.sure).length).toBeLessThanOrEqual(2);
    // Beyond the cut each clip goes on through its file, two frames of it to one of the timeline.
    const after = r.mixed.filter((w) => w.f >= 36).map((w) => w.first);
    const before = r.mixed.filter((w) => w.f < 36).map((w) => w.second);
    expect(after[0]).toBeGreaterThan(r.own[0]);
    expect(after[4] - after[0]).toBe(8);
    expect(before[4]).toBeLessThan(r.own[1]);
    expect(before[4] - before[0]).toBe(8);
    expect(r.held).toEqual([false, false]);

    expect(exported).toMatchObject({ frames: 96, warnings: [], length: 96, drawn: 96 });
    expect(exported.right).toBe(96 - exported.unsure);
    expect(exported.unsure).toBeLessThanOrEqual(4);
    // Half speed at first: the tenth frame is the file's fifth. Double at the end.
    expect(exported.tenth).toEqual([4, true]);
    expect(exported.middle[1]).toBe(true);
    expect(exported.end).toEqual([118, true]);
    test.skip(!hasFfprobe(), 'ffprobe not installed: skipping container inspection');
    const file = info.outputPath(`ramp${exported.extension}`);
    writeFileSync(file, Buffer.from(base64, 'base64'));
    const video = ffprobe(file).streams.find((stream) => stream.codec_type === 'video')!;
    expect(Number(video.nb_read_frames)).toBe(96);
    expect(errors).toEqual([]);
  });

  test('a preview schedules sound that keeps its pitch from several clips ahead of time, on whole samples and without a gap', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(160, 90);
      // Four tones, none of which a grain of a hundredth of a second holds a whole number of
      // periods of, each at a speed of its own; two of the files at the context's rate.
      const tones = [311, 523, 787, 1130];
      const speeds = [0.5, 0.8, 1.5, 2];
      const rates = [44100, 48000, 44100, 48000];
      const assets = [];
      for (const [i, hz] of tones.entries())
        assets.push(await kit.add(`v${hz}`, kit.sine(hz, rates[i], 21, 0.1), rates[i]));
      const project = kit.project(
        assets,
        tones.map((hz, lane) => ({
          type: 'audio',
          lane,
          assetId: `v${hz}`,
          start: 0,
          duration: 230,
          speed: speeds[lane],
          keepPitch: true,
        })),
        { sampleRate: 48000 },
      );
      const { started, t0, problems } = await kit.preview(project, 0.25, 7, 5.6);
      // Three seconds from two and a half seconds in, on the context's own sample count: by then
      // every voice has its first two seconds of grains behind it.
      const from = Math.round((t0 + 2.5) * 48000);
      const voices = [...new Set(started.map((b: any) => b.voice))].map((voice) => {
        const mine = started.filter((b: any) => b.voice === voice);
        const { mix, missing, twice } = kit.heard(mine, from, 144000);
        const within = mine.filter((b: any) => b.at >= from && b.at + b.samples.length <= from + 144000);
        const [found] = tones
          .map((hz) => ({ tone: hz, ...kit.pitch(mix, hz, 48000, 0.1, 0, 144000) }))
          .sort((a, b) => b.level - a.level);
        return {
          ...found,
          stretches: mine.length,
          missing,
          twice,
          atRate: mine.every((b: any) => b.rate === 48000 && b.speed === 1),
          offGrid: mine.filter((b: any) => b.between || Math.abs(b.at - Math.round(b.at)) > 1e-6).length,
          partial: within.filter((b: any) => !b.whole).length,
          late: within.filter((b: any) => b.lead < 0).length,
        };
      });
      return { voices: voices.sort((a, b) => a.tone - b.tone), problems };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    expect(r.problems).toEqual([]);
    expect(r.voices.map((v) => v.tone)).toEqual([311, 523, 787, 1130]);
    for (const v of r.voices) {
      const name = `${v.tone} Hz`;
      expect(v.stretches, name).toBeGreaterThan(40);
      // At the context's rate and on its samples, as the mixer plays every other clip.
      expect(v.atRate, name).toBe(true);
      expect(v.offGrid, name).toBe(0);
      expect(v.partial, name).toBe(0);
      // In the stretch analysed nothing came late: every sample of it is played, once.
      expect(v.late, name).toBe(0);
      expect(v.missing, name).toBe(0);
      expect(v.twice, name).toBe(0);
      expect(Math.abs(v.hz - v.tone), name).toBeLessThan(1.5);
      expect(Math.abs(v.level), name).toBeLessThan(0.5);
    }
    expect(errors).toEqual([]);
  });

  test('a preview keeps up with a ramp that passes ten times the speed', async ({ page }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(160, 90);
      const assets = [
        await kit.add('long48', kit.sine(1000, 48000, 45, 0.1), 48000),
        await kit.add('long44', kit.sine(1000, 44100, 45, 0.1), 44100),
      ];
      // Two seconds up to ten times the speed, 1.8 s at it, two seconds down again.
      const ramp = [
        { m: 1, v: 1 },
        { m: 12, v: 10 },
        { m: 30, v: 10 },
        { m: 41, v: 1 },
      ];
      const project = kit.project(
        assets,
        ['long48', 'long44'].map((assetId, lane) => ({
          type: 'audio',
          lane,
          assetId,
          start: 0,
          duration: 200,
          sourceIn: 0.5,
          ramp,
          keepPitch: false,
        })),
        { sampleRate: 48000 },
      );
      const { started, t0, problems } = await kit.preview(project, 0.25, 6.5, 5.6);
      // From a second in to 5.3 s in: the whole of the ramp's rise, top and fall.
      const from = Math.round((t0 + 1) * 48000);
      const length = Math.round(4.3 * 48000);
      // The clip is at ten times the speed from 2.5 s to 4.3 s of the timeline: a second of that.
      const top = [Math.round((2.9 - 1.25) * 48000), Math.round((3.9 - 1.25) * 48000)];
      const voices = [...new Set(started.map((b: any) => b.voice))].map((voice) => {
        const mine = started.filter((b: any) => b.voice === voice);
        const { mix, missing, twice } = kit.heard(mine, from, length);
        const within = mine.filter((b: any) => b.at >= from && b.at + b.samples.length <= from + length);
        return {
          stretches: mine.length,
          missing,
          twice,
          atRate: mine.every((b: any) => b.rate === 48000 && b.speed === 1),
          offGrid: mine.filter((b: any) => b.between || Math.abs(b.at - Math.round(b.at)) > 1e-6).length,
          late: within.filter((b: any) => b.lead < 0).length,
          top: kit.pitch(mix, 10000, 48000, 0.1, top[0], top[1]),
        };
      });
      return { voices, problems };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    expect(r.problems).toEqual([]);
    expect(r.voices).toHaveLength(2);
    for (const v of r.voices) {
      expect(v.atRate).toBe(true);
      expect(v.offGrid).toBe(0);
      expect(v.late).toBe(0);
      expect(v.missing).toBe(0);
      expect(v.twice).toBe(0);
      // 1 kHz at ten times the speed, at its level.
      expect(Math.abs(v.top.hz / 10000 - 1)).toBeLessThan(0.005);
      expect(Math.abs(v.top.level)).toBeLessThan(0.5);
    }
    expect(errors).toEqual([]);
  });

  test('a stretched voice of a preview is heard from the two seconds it starts in, and stops reading when it is stopped', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const assets = [await kit.add('long', kit.sine(1000, 48000, 45, 0.1), 48000)];
      const at = (speed: number) =>
        kit.project(
          assets,
          [{ type: 'audio', assetId: 'long', start: 0, duration: 180, speed, keepPitch: true }],
          { sampleRate: 48000 },
        );
      // The playhead starts a quarter of a second into the clip and into the first block of its
      // grains, which ends 1.75 s on. That block is ready when the file is decoded as far as the
      // block's end: two seconds of it at normal speed, twenty at ten times.
      const first: Record<string, unknown> = {};
      for (const speed of [0.5, 2, 4, 10]) {
        const { started, t0, began, problems } = await kit.preview(at(speed), 0.25, 6, 2.2);
        const [stretch] = started;
        first[speed] = stretch && {
          // From the start of the mixer to the first sound handed over, on the page's clock,
          ms: stretch.wall - began,
          // and when that sound plays, counted from when the playhead sets off.
          sounds: stretch.at / 48000 - t0,
          problems,
        };
      }

      // Stopped while its first block is still being decoded: the decoder is closed there.
      const read = { buffers: 0, open: 0 };
      const sound = engine.Sound.prototype;
      const buffers = sound.buffers;
      sound.buffers = function (...args: unknown[]) {
        const inner = buffers.apply(this, args);
        read.open++;
        return (async function* () {
          try {
            for await (const wb of inner) {
              read.buffers++;
              yield wb;
            }
          } finally {
            read.open--;
          }
        })();
      };
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const noted = kit.listen();
      const problems: string[] = [];
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      graph.onProblem = (p: any) => problems.push(`${p.reason} ${p.lost ?? ''} ${p.cause ?? ''}`);
      graph.start(at(10), { startSec: 0.25, t0: ctx.currentTime + 0.3, rate: 1, endSec: 6 });
      void graph.pump();
      const waited = performance.now() + 10_000;
      while (performance.now() < waited && read.buffers < 1) await new Promise((res) => setTimeout(res, 0));
      const stopped = { buffers: read.buffers, sounding: noted.started.length };
      graph.stop();
      await new Promise((res) => setTimeout(res, 600));
      const after = {
        buffers: read.buffers - stopped.buffers,
        open: read.open,
        sounding: noted.started.length,
      };
      graph.dispose();
      await ctx.close();
      noted.stop();
      sound.buffers = buffers;
      return { first, stopped, after, problems };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    for (const speed of ['0.5', '2', '4', '10']) {
      const m = r.first[speed] as { ms: number; sounds: number; problems: string[] };
      expect(m, speed).toBeTruthy();
      expect(m.problems, speed).toEqual([]);
      // How long the first block takes is this machine's to say. That something of the block the
      // playhead starts in is heard is not.
      expect(m.sounds, speed).toBeLessThan(1.75);
    }
    // The voice was stopped as soon as its decode was under way, with nothing handed over yet,
    expect(r.stopped.buffers).toBeGreaterThanOrEqual(1);
    expect(r.stopped.sounding).toBe(0);
    // and that is where its read ended: a buffer that was on its way at most, of the hundreds its
    // first block takes, no sound, and no word of a failure.
    expect(r.after.buffers).toBeLessThanOrEqual(2);
    expect(r.after).toMatchObject({ open: 0, sounding: 0 });
    expect(r.problems).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a change of Keep pitch or of the ramp while playing is heard within a second; a change of look is not a restart', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      const assets = [await kit.add('long', kit.sine(1000, 48000, 45, 0.1), 48000)];
      // Twenty seconds at double speed, pitch kept.
      let project = kit.project(
        assets,
        [{ type: 'audio', assetId: 'long', start: 0, duration: 600, speed: 2, keepPitch: true }],
        { sampleRate: 48000 },
      );
      const id = Object.keys(project.clips)[0];
      const noted = kit.listen();
      // Every time the player begins its mix anew.
      let restarts = 0;
      const mixer = engine.AudioGraph.prototype;
      const begin = mixer.start;
      mixer.start = function (...args: unknown[]) {
        restarts++;
        return begin.apply(this, args);
      };
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const player = new engine.Player(canvas, project, lab.resolver);
      player.play();
      const flowing = performance.now() + 15_000;
      while (performance.now() < flowing && !noted.started.length)
        await new Promise((res) => setTimeout(res, 50));
      const ctx: AudioContext = noted.started[0].context;
      const until = async (time: number) => {
        while (ctx.currentTime < time) await new Promise((res) => setTimeout(res, 50));
      };
      await until(ctx.currentTime + 0.7);

      /** Change the clip, and say what is played from one second after that to 1.4 s after it. */
      const change = async (patch: object | null) => {
        const [before, since, at] = [restarts, noted.started.length, ctx.currentTime];
        if (patch) {
          project = core.applyEdits(project, [{ op: 'updateClip', id, patch }]);
          player.setProject(project);
        }
        await until(at + 1.6);
        const restarted = restarts - before;
        // A mix begun anew stops what the one before it had handed over.
        const playing = noted.started.slice(restarted ? since : 0);
        const length = Math.round(0.4 * ctx.sampleRate);
        const { mix, missing } = kit.heard(playing, Math.round((at + 1) * ctx.sampleRate), length);
        const [found] = [500, 800, 1000, 2000]
          .map((hz) => kit.pitch(mix, hz, ctx.sampleRate, 0.1, 0, length))
          .sort((a, b) => b.level - a.level);
        return { restarted, missing, ...found };
      };
      const flat = (speed: number) => core.flatRamp(0, 45, speed);
      const steps = {
        kept: await change(null),
        faded: await change({ opacity: 0.5 }),
        followed: await change({ keepPitch: false }),
        ramped: await change({ ramp: flat(0.5) }),
        rampedAnew: await change({ ramp: flat(0.8) }),
        keptOnRamp: await change({ keepPitch: true }),
      };
      player.dispose();
      canvas.remove();
      noted.stop();
      mixer.start = begin;
      return { rate: ctx.sampleRate, steps };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    expect(r.rate).toBe(48000);
    // What plays a second after each change: the mix left alone or begun anew, and the pitch of
    // a 1 kHz tone. Twice the speed with its pitch kept; unchanged by a change of look; an octave
    // up without the switch; then on a ramp at half speed, on one at 80 %, and that at pitch.
    for (const [name, restarted, hz] of [
      ['kept', 0, 1000],
      ['faded', 0, 1000],
      ['followed', 1, 2000],
      ['ramped', 1, 500],
      ['rampedAnew', 1, 800],
      ['keptOnRamp', 1, 1000],
    ] as const) {
      const step = r.steps[name];
      expect(step.restarted, name).toBe(restarted);
      expect(step.missing, name).toBe(0);
      expect(Math.abs(step.hz - hz), name).toBeLessThan(1.5);
      expect(Math.abs(step.level), name).toBeLessThan(0.5);
    }
    expect(errors).toEqual([]);
  });

  test('shuttling at double speed plays retimed clips an octave up, like every other clip', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(160, 90);
      const assets = [
        await kit.add('long48', kit.sine(1000, 48000, 45, 0.1), 48000),
        await kit.add('long44', kit.sine(1000, 44100, 45, 0.1), 44100),
      ];
      const ramp = [
        { m: 1, v: 0.5 },
        { m: 9, v: 2 },
      ];
      const project = kit.project(
        assets,
        [
          { assetId: 'long48', speed: 0.5, keepPitch: true },
          { assetId: 'long44', speed: 2, keepPitch: true },
          { assetId: 'long48', ramp, keepPitch: false },
        ].map((clip, lane) => ({ type: 'audio', lane, start: 0, duration: 360, ...clip })),
        { sampleRate: 48000 },
      );
      // Twice as fast as the clock: three seconds of it are six of the timeline.
      const { started, t0, problems } = await kit.preview(project, 0.25, 11, 3, 2);
      const [from, to] = [(t0 + 1) * 48000, (t0 + 2.5) * 48000];
      const voices = [...new Set(started.map((b: any) => b.voice))].map((voice) => {
        const mine = started.filter((b: any) => b.voice === voice);
        let covered = 0;
        for (const b of mine) {
          const length = (b.samples.length / (b.rate * b.speed)) * 48000;
          covered += Math.max(0, Math.min(to, b.at + length) - Math.max(from, b.at));
        }
        // What a stretch of the stream holds, read at the stream's own rate.
        const longest = mine.reduce((a: any, b: any) => (b.samples.length > a.samples.length ? b : a));
        return {
          rate: longest.rate,
          speeds: [...new Set(mine.map((b: any) => b.speed))],
          covered: covered / (to - from),
          holds: kit.pitch(longest.samples, 1000, longest.rate, 0.1, 0, longest.samples.length),
        };
      });
      return { voices, problems };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    expect(r.problems).toEqual([]);
    expect(r.voices).toHaveLength(3);
    for (const v of r.voices) {
      // Left to the browser to play at twice the rate, as all sound is while shuttling.
      expect(v.speeds).toEqual([2]);
      expect(v.covered).toBeGreaterThan(0.9);
      expect(v.covered).toBeLessThan(1.001);
    }
    // The two that keep their pitch hold a tone of 1 kHz, which at twice the rate is 2 kHz.
    const kept = r.voices.filter((v) => Math.abs(v.holds.hz - 1000) < 1.5 && Math.abs(v.holds.level) < 0.5);
    expect(kept.map((v) => v.rate).sort()).toEqual([44100, 48000]);
    expect(errors).toEqual([]);
  });

  test('stretching one voice of a preview takes a few milliseconds for a second of sound', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    await openRampLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      // Stereo, a tone under noise: every grain has to be looked for.
      const left = kit.sine(220, 48000, 42, 0.2);
      const right = kit.sine(330, 48000, 42, 0.2);
      const hiss = kit.noise(48000, 42, 99);
      for (let i = 0; i < left.length; i++) {
        left[i] += 0.1 * hiss[i];
        right[i] += 0.1 * hiss[left.length - 1 - i];
      }
      const asset = await lab.addFile(
        'stereo',
        URL.createObjectURL(kit.floatWav([left, right], 48000)),
        'stereo.wav',
      );
      const project = kit.project(
        [asset],
        [{ type: 'audio', assetId: 'stereo', start: 0, duration: 540, speed: 2, keepPitch: true }],
        { sampleRate: 48000 },
      );
      // The time spent in the stretcher, and the longest the page went without a turn.
      const spent = { ms: 0, longest: 0, samples: 0 };
      const stretcher = engine.Stretcher.prototype;
      const { push, take } = stretcher;
      const timed = (inner: (...args: unknown[]) => any) =>
        function (this: unknown, ...args: unknown[]) {
          const from = performance.now();
          const out = inner.apply(this, args);
          const ms = performance.now() - from;
          spent.ms += ms;
          spent.longest = Math.max(spent.longest, ms);
          if (out?.data) spent.samples += out.data[0].length;
          return out;
        };
      stretcher.push = timed(push);
      stretcher.take = timed(take);
      const turns = { last: performance.now(), longest: 0 };
      const beat = () => {
        const now = performance.now();
        turns.longest = Math.max(turns.longest, now - turns.last);
        turns.last = now;
      };
      const idle = setInterval(beat, 4);
      await new Promise((res) => setTimeout(res, 1500));
      const atRest = turns.longest;
      // Steady state: from two seconds in, when the voice is as far ahead as it stays.
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      const t0 = ctx.currentTime + 0.3;
      graph.start(project, { startSec: 0.25, t0, rate: 1, endSec: 17 });
      const pump = setInterval(() => void graph.pump(), 200);
      void graph.pump();
      while (ctx.currentTime < t0 + 2) await new Promise((res) => setTimeout(res, 50));
      const first = { ...spent };
      Object.assign(spent, { ms: 0, longest: 0, samples: 0 });
      turns.longest = 0;
      while (ctx.currentTime < t0 + 8) await new Promise((res) => setTimeout(res, 50));
      clearInterval(pump);
      clearInterval(idle);
      graph.dispose();
      await ctx.close();
      stretcher.push = push;
      stretcher.take = take;
      return {
        // Milliseconds of stretching for a second of stereo sound made, once playing and at the start.
        perSecond: spent.ms / (spent.samples / 48000),
        seconds: spent.samples / 48000,
        longestCall: spent.longest,
        longestWithoutATurn: turns.longest,
        atRest,
        atFirst: { ms: first.ms, seconds: first.samples / 48000, longestCall: first.longest },
      };
    });
    await info.attach('measured', { body: JSON.stringify(r, null, 1), contentType: 'application/json' });
    // Six seconds of playing made about six seconds of sound.
    expect(r.seconds).toBeGreaterThanOrEqual(4);
    expect(r.seconds).toBeLessThanOrEqual(8);
    // A guard, with room for a machine several times slower than the one this was written on.
    expect(r.perSecond).toBeLessThan(60);
    expect(errors).toEqual([]);
  });

  test('an export of a clip on a ramp, measured outside the browser: as long as the timeline, the tone and the clicks where the map puts them', async ({
    page,
  }, info) => {
    test.skip(!hasFfprobe(), 'ffprobe and ffmpeg not installed: an export cannot be measured');
    const errors = trackErrors(page);
    await openRampLab(page);
    const made = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      // The picture is 27 s of ffmpeg's test pattern, small enough to keep beside the tests:
      //   ffmpeg -f lavfi -i testsrc=size=160x90:rate=30 -t 27 -c:v libx264 -preset veryslow \
      //     -crf 30 -pix_fmt yuv420p -g 60 -movflags +faststart testsrc-long.mp4
      const pattern = await lab.addFile('pattern', '/fixtures/testsrc-long.mp4', 'testsrc-long.mp4');
      // The sound is made here, where no codec has been at it: a tone of 1 kHz on the left, a
      // click of one sample every half second of the file on the right.
      const clicks = new Float32Array(48000 * 27);
      for (let m = 0.5; m < 26.5; m += 0.5) clicks[Math.round(m * 48000)] = 0.9;
      const sound = await lab.addFile(
        'sound',
        URL.createObjectURL(kit.floatWav([kit.sine(1000, 48000, 27), clicks], 48000)),
        'sound.wav',
      );
      const base = kit.project(
        [pattern, sound],
        [
          { assetId: 'pattern', start: 0, duration: 786 },
          { type: 'audio', assetId: 'sound', start: 0, duration: 786 },
        ],
        { sampleRate: 48000 },
      );
      const ids = Object.keys(base.clips);
      const picture = ids.find((id) => base.clips[id].type === 'video')!;
      const voice = ids.find((id) => base.clips[id].type === 'audio')!;
      const linked = core.applyEdits(base, core.linkClips(base, ids));
      // "Bullet" over 26.2 s of the file: five times the speed, a dip to a quarter of it, and five
      // times again. Set on the picture, it is the ramp of its sound too, which keeps its pitch
      // from then on; the second export has the switch off.
      const ramp = core.shapeRamp('bullet', 0, 26.2, false);
      const kept = core.applyEdits(linked, core.setRamp(linked, [picture], { ramps: { [picture]: ramp } }));
      const followed = core.applyEdits(kept, [{ op: 'updateClip', id: voice, patch: { keepPitch: false } }]);
      kit.bullet = { kept, followed, voice };
      /** How late each click of the file is in the right channel `x`, in samples, against the map. */
      kit.bullet.clicks = (x: Float32Array) => {
        const map = core.timeMap(followed.clips[voice]);
        const found = [];
        for (let m = 0.5; m < 26.2; m += 0.5) {
          const ideal = (map.stream(m) - map.stream(0)) * 48000;
          if (ideal < 2400 || ideal > x.length - 2400) continue;
          let peak = Math.round(ideal) - 1200;
          for (let i = peak; i < Math.round(ideal) + 1200; i++)
            if (Math.abs(x[i]) > Math.abs(x[peak])) peak = i;
          found.push({ m, speed: map.speed(map.stream(m)), late: kit.place(x, peak, 48000) - ideal });
        }
        return found;
      };
      // What the encoder is given: the mixer's own render, in the chunks of an export.
      const runs = new engine.AudioRuns(6);
      const mixed = new Float32Array(288000);
      for (const [from, seconds] of [
        [0, 4],
        [4, 2],
      ]) {
        const chunk = await engine.renderAudioChunk(
          followed,
          lab.library,
          from,
          seconds,
          48000,
          undefined,
          undefined,
          runs,
        );
        mixed.set(chunk.getChannelData(1), from * 48000);
      }
      runs.dispose();
      const files: Record<string, unknown> = {};
      for (const [name, project] of Object.entries({ kept, followed })) {
        const out = await lab.exportBase64(project, {
          container: 'mp4',
          videoCodec: 'avc',
          audioCodec: 'opus',
          width: 160,
          height: 90,
          fpsNum: 30,
          fpsDen: 1,
          videoBitrate: 300_000,
          audioBitrate: 192_000,
          range: null,
          includeVideo: true,
          includeAudio: true,
          dynamicRange: 'sdr',
          keyFrameInterval: 1,
          hardwareAcceleration: 'no-preference',
        });
        files[name] = {
          base64: out.base64,
          frames: out.frames,
          warnings: out.warnings,
          extension: out.extension,
        };
      }
      return {
        files: files as Record<
          string,
          { base64: string; frames: number; warnings: unknown[]; extension: string }
        >,
        frames: [kept.clips[picture].duration, kept.clips[voice].duration],
        keepPitch: [kept.clips[voice].keepPitch, followed.clips[voice].keepPitch],
        oneRamp: kept.clips[voice].ramp === kept.clips[picture].ramp,
        mixed: kit.bullet.clicks(mixed) as { m: number; speed: number; late: number }[],
      };
    });
    // Twenty-six seconds of the file in six of the timeline, picture and sound alike.
    expect(made.frames).toEqual([180, 180]);
    expect(made.keepPitch).toEqual([true, false]);
    expect(made.oneRamp).toBe(true);

    const probed: Record<string, unknown> = {};
    const pcm: Record<string, string> = {};
    for (const name of ['kept', 'followed']) {
      const { base64, frames, warnings, extension } = made.files[name];
      expect(frames, name).toBe(180);
      expect(warnings, name).toEqual([]);
      const file = info.outputPath(`${name}${extension}`);
      writeFileSync(file, Buffer.from(base64, 'base64'));
      const streams: Record<string, string>[] = JSON.parse(
        execFileSync('ffprobe', [
          ...['-v', 'error', '-count_frames', '-of', 'json'],
          ...['-show_entries', 'stream=codec_type,codec_name,duration,nb_read_frames,sample_rate'],
          file,
        ]).toString(),
      ).streams;
      const video = streams.find((stream) => stream.codec_type === 'video')!;
      const audio = streams.find((stream) => stream.codec_type === 'audio')!;
      probed[name] = { video, audio };
      expect(video.codec_name, name).toBe('h264');
      expect(Number(video.nb_read_frames), name).toBe(180);
      // Each stream lasts as long as the timeline: to a frame of picture, to a packet of sound.
      expect(Math.abs(Number(video.duration) - 6), name).toBeLessThanOrEqual(1 / 30 + 1e-6);
      expect(audio.codec_name, name).toBe('opus');
      expect(Math.abs(Number(audio.duration) - 6), name).toBeLessThanOrEqual(0.02 + 1e-6);
      // The sound as any player decodes it: 32-bit float, both channels, at the rate it was mixed at.
      pcm[name] = execFileSync(
        'ffmpeg',
        ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'],
        { maxBuffer: 64 * 1024 * 1024 },
      ).toString('base64');
    }

    const r = await page.evaluate(async (pcm) => {
      const { lab, kit } = window as any;
      const { core } = lab;
      const channels = (name: string) => {
        const both = new Float32Array(Uint8Array.from(atob(pcm[name]), (c) => c.charCodeAt(0)).buffer);
        const left = Float32Array.from({ length: both.length / 2 }, (_, i) => both[2 * i]);
        const right = Float32Array.from({ length: both.length / 2 }, (_, i) => both[2 * i + 1]);
        return { left, right, windows: Math.floor(Math.min(left.length, 6 * 48000) / 12000) };
      };
      // With Keep pitch: the pitch and level of the tone in every quarter of a second.
      const kept = channels('kept');
      const pitches = [];
      for (let w = 0; w < kept.windows; w++)
        pitches.push(kit.pitch(kept.left, 1000, 48000, 0.5, w * 12000, (w + 1) * 12000));

      // Without it the tone is at 1 kHz times the speed. Through the dip that changes twentyfold
      // within a second, so each quarter of a second is counted in whole periods, from the first
      // time the tone rises through zero to the last, and held against what the map says of that
      // very stretch: the file it plays through in it, over the time that takes.
      const followed = channels('followed');
      const clip = kit.bullet.followed.clips[kit.bullet.voice];
      const map = core.timeMap(clip);
      const streamIn = map.stream(clip.sourceIn);
      const speeds = [];
      for (let w = 0; w < followed.windows; w++) {
        const { hz, first, last } = kit.frequency(followed.left, w * 12000, (w + 1) * 12000, 48000);
        const played = map.media(streamIn + last / 48000) - map.media(streamIn + first / 48000);
        speeds.push({
          hz,
          speed: played / ((last - first) / 48000),
          middle: map.speed(streamIn + (w + 0.5) / 4),
        });
      }
      // The clicks: where each is found, to a fraction of a sample, against where the map puts it.
      const clicks: { m: number; speed: number; late: number }[] = kit.bullet.clicks(followed.right);
      return { seconds: [kept.left.length / 48000, followed.left.length / 48000], pitches, speeds, clicks };
    }, pcm);
    // An encoder gives its sound a little late or early as a whole, by a delay of its own. What
    // is common to all the clicks is taken to be that: the middle one of how late each is found.
    const lates = r.clicks.map((click) => click.late).sort((a, b) => a - b);
    const delay = lates[Math.floor(lates.length / 2)];
    await info.attach('measured', {
      body: JSON.stringify({ frames: made.frames, probed, delay, mixed: made.mixed, ...r }, null, 1),
      contentType: 'application/json',
    });
    // Before any encoder: the clip's sound lies on the mix's samples, so as a whole up to half a
    // sample from its place, and every click of it by that same fraction.
    expect(made.mixed.length).toBeGreaterThan(45);
    for (const click of made.mixed) {
      expect(Math.abs(click.late), `mixed, the click at second ${click.m} of the file`).toBeLessThanOrEqual(
        0.5,
      );
      expect(Math.abs(click.late - made.mixed[0].late), `mixed, second ${click.m}`).toBeLessThan(0.01);
    }
    expect(r.pitches.length).toBeGreaterThanOrEqual(23);
    for (const [w, { hz, level }] of r.pitches.entries()) {
      expect(Math.abs(hz - 1000), `kept, quarter ${w}`).toBeLessThan(1.5);
      expect(Math.abs(level), `kept, quarter ${w}`).toBeLessThan(1);
    }
    expect(r.speeds.length).toBeGreaterThanOrEqual(23);
    for (const [w, { hz, speed }] of r.speeds.entries())
      expect(Math.abs(hz / (1000 * speed) - 1), `followed, quarter ${w}`).toBeLessThan(0.02);
    // Five times the speed at both ends, and through the dip in between.
    expect(r.speeds[1].speed).toBeCloseTo(5, 6);
    expect(Math.min(...r.speeds.map((s) => s.speed))).toBeLessThan(1);
    expect(r.clicks.length).toBeGreaterThan(45);
    // No more than a packet of sound, 20 ms.
    expect(Math.abs(delay)).toBeLessThan(960);
    for (const click of r.clicks)
      expect(Math.abs(click.late - delay), `the click at second ${click.m} of the file`).toBeLessThan(1.5);
    expect(errors).toEqual([]);
  });
});
