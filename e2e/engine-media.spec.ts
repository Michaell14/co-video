import { expect, test, type Page } from '@playwright/test';
import { openLab, trackErrors } from './helpers';

/**
 * Decoding and media handling, driven through the engine lab page: what the decode cursors show
 * for a given time, how many decoders and textures they keep, and what happens when media is
 * missing, late or oddly shaped.
 */

/** Open the lab with a few measuring tools on `window.kit`. */
async function openMediaLab(page: Page): Promise<void> {
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
      /** A project of the given size with one video track holding `clips` (props for `makeClip`). */
      project(width: number, height: number, assets: unknown[], clips: any[], settings = {}) {
        const v1 = core.makeTrack('video', 0);
        const a1 = core.makeTrack('audio', 0);
        return core.applyEdits(core.emptyProject({ width, height, ...settings }), [
          { op: 'addTrack', track: v1 },
          { op: 'addTrack', track: a1 },
          ...assets.map((asset) => ({ op: 'addAsset', asset })),
          ...clips.map(({ type = 'video', ...props }) => ({
            op: 'addClip',
            clip: core.makeClip(type, type === 'audio' ? a1.id : v1.id, props),
          })),
        ]);
      },
      /**
       * Draw the way a paused viewer does: once now, then again whenever the sources say new
       * pixels arrived, until `done()` holds or `ms` have passed. Returns the number of draws.
       */
      async view(project: any, frame: number, ms: number, done: () => boolean = () => false) {
        let dirty = true;
        let draws = 0;
        lab.sources.onInvalidate = () => {
          dirty = true;
        };
        const desc = core.resolveFrame(project, frame);
        const until = performance.now() + ms;
        while (performance.now() < until) {
          if (dirty) {
            dirty = false;
            void lab.sources.prepare(project, desc, false);
            kit.last = lab.compositor.render(project, desc, lab.sources, {});
            lab.sources.collect();
            draws++;
            if (done()) break;
          }
          await new Promise((r) => requestAnimationFrame(r));
        }
        return draws;
      },
      last: null as any,
      /** A mono 16-bit WAV file holding `samples`. */
      wav(samples: ArrayLike<number>, rate: number): Blob {
        const n = samples.length;
        const buf = new ArrayBuffer(44 + n * 2);
        const v = new DataView(buf);
        const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        text(0, 'RIFF');
        v.setUint32(4, 36 + n * 2, true);
        text(8, 'WAVEfmt ');
        v.setUint32(16, 16, true);
        v.setUint16(20, 1, true);
        v.setUint16(22, 1, true);
        v.setUint32(24, rate, true);
        v.setUint32(28, rate * 2, true);
        v.setUint16(32, 2, true);
        v.setUint16(34, 16, true);
        text(36, 'data');
        v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, samples[i], true);
        return new Blob([buf], { type: 'audio/wav' });
      },
      /** A WAV of a steady tone, `seconds` long. */
      tone(seconds: number, rate = 8000, hz = 440): Blob {
        const n = Math.round(seconds * rate);
        return kit.wav(
          Int16Array.from({ length: n }, (_, i) => Math.sin((i / rate) * hz * 2 * Math.PI) * 12000),
          rate,
        );
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
      /** `seconds` of a sine as samples. */
      sine(hz: number, rate: number, seconds: number, amp = 0.5): Float32Array {
        return Float32Array.from(
          { length: Math.round(rate * seconds) },
          (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate),
        );
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

test.describe('media engine', () => {
  test('a reversed clip shows its source backwards, frame for frame', async ({ page }) => {
    const errors = trackErrors(page);
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const n = 100;
      const forward = kit.project(320, 180, [vid], [{ assetId: 'vid', start: 0, duration: n }]);
      const reversed = kit.project(
        320,
        180,
        [vid],
        [{ assetId: 'vid', start: 0, duration: n, reverse: true }],
      );
      const want: number[] = [];
      for (let f = 0; f < n; f++) want.push(kit.hash((await lab.renderFrame(forward, f)).pixels));
      lab.init(320, 180);
      kit.decoders.started = 0;
      let wrong = 0;
      let slowest = 0;
      let held = 0;
      for (let f = 0; f < n; f++) {
        const t0 = performance.now();
        const got = kit.hash((await lab.renderFrame(reversed, f)).pixels);
        slowest = Math.max(slowest, performance.now() - t0);
        held = Math.max(held, lab.sources.stats().frames);
        if (got !== want[n - 1 - f]) wrong++;
      }
      return { distinct: new Set(want).size, wrong, slowest, held, started: kit.decoders.started };
    });
    expect(r.distinct).toBe(100); // the source really has a different picture on every frame
    expect(r.wrong).toBe(0);
    // Runs of frames decoded behind the playhead, not one seek per frame and never a stall.
    expect(r.started).toBeLessThanOrEqual(8);
    expect(r.slowest).toBeLessThan(3000);
    expect(r.held).toBeLessThanOrEqual(48);
    expect(errors).toEqual([]);
  });

  test('shuttling backwards plays the picture backwards', async ({ page }) => {
    const decodeErrors: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('decode error')) decodeErrors.push(m.text());
    });
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const n = Math.round(vid.duration * 30);
      const project = kit.project(320, 180, [vid], [{ assetId: 'vid', start: 0, duration: n }]);
      // A coarse signature of every frame, to recognise what the player is showing.
      const signature = (px: Uint8Array) => {
        const out: number[] = [];
        for (let y = 10; y < 180; y += 20)
          for (let x = 10; x < 320; x += 20) out.push(px[(y * 320 + x) * 4 + 1]);
        return out;
      };
      const known: number[][] = [];
      for (let f = 0; f < n; f++) known.push(signature((await lab.renderFrame(project, f)).pixels));
      const nearest = (sig: number[]) => {
        let best = -1;
        let bestD = Infinity;
        for (let f = 0; f < n; f++) {
          let d = 0;
          for (let i = 0; i < sig.length; i++) d += Math.abs(sig[i] - known[f][i]);
          if (d < bestD) [best, bestD] = [f, d];
        }
        return best;
      };
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const player = new engine.Player(canvas, project, lab.resolver);
      player.setQuality(1);
      player.seek(110);
      await new Promise((res) => setTimeout(res, 800));
      const atRest = nearest(signature(player.compositor.readPixels()));
      player.shuttle(-1);
      const shown: number[] = [];
      const until = performance.now() + 2500;
      while (performance.now() < until && player.getState().playing) {
        await new Promise((res) => requestAnimationFrame(res));
        shown.push(nearest(signature(player.compositor.readPixels())));
      }
      const rate = player.getState().rate;
      player.pause();
      const playhead = player.getFrame();
      await new Promise((res) => setTimeout(res, 800));
      const afterPause = nearest(signature(player.compositor.readPixels()));

      // From the last frame of the file, where the seek leaves a single frame in hand.
      player.seek(n - 1);
      await new Promise((res) => setTimeout(res, 800));
      const atEnd = nearest(signature(player.compositor.readPixels()));
      player.shuttle(-1);
      const fromEnd: number[] = [];
      const stop = performance.now() + 1200;
      while (performance.now() < stop && player.getState().playing) {
        await new Promise((res) => requestAnimationFrame(res));
        fromEnd.push(nearest(signature(player.compositor.readPixels())));
      }
      player.dispose();
      canvas.remove();
      return { n, atRest, shown, rate, playhead, afterPause, atEnd, fromEnd };
    });
    expect(r.n).toBe(120);
    expect(r.atRest).toBe(110);
    expect(r.rate).toBe(-1);
    const steps = r.shown.filter((f: number, i: number) => i > 0 && f !== r.shown[i - 1]);
    // The picture moves, a lot, and only ever towards earlier frames.
    expect(new Set(r.shown).size).toBeGreaterThan(12);
    expect(steps.every((f: number, i: number) => f < (i ? steps[i - 1] : 111))).toBe(true);
    expect(Math.min(...r.shown)).toBeLessThan(80);
    // Paused again, the viewer settles on the frame under the playhead.
    expect(r.afterPause).toBe(r.playhead);
    // Starting on the file's last frame is no different: the run behind it is decoded, not guessed at.
    expect(r.atEnd).toBe(119);
    expect(new Set(r.fromEnd).size).toBeGreaterThan(6);
    expect(r.fromEnd.every((f: number, i: number) => f <= (i ? r.fromEnd[i - 1] : 119))).toBe(true);
    expect(decodeErrors).toEqual([]);
  });

  test('a browser recording renders exactly without stalling on frames that carry no duration', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(160, 90);
      // Recorded with MediaRecorder: the last frame of each cluster has no duration.
      const rec = await lab.addFile('rec', '/fixtures/recorder.webm', 'recorder.webm');
      const n = Math.floor(rec.duration * 30) - 1;
      const project = kit.project(160, 90, [rec], [{ assetId: 'rec', start: 0, duration: n }]);
      let slowest = 0;
      const pictures = new Set<number>();
      for (let f = 0; f < n; f++) {
        const t0 = performance.now();
        pictures.add(kit.hash((await lab.renderFrame(project, f)).pixels));
        slowest = Math.max(slowest, performance.now() - t0);
      }
      return { n, slowest, pictures: pictures.size };
    });
    expect(r.n).toBeGreaterThan(110); // long enough to cross a cluster boundary
    expect(r.slowest).toBeLessThan(2000);
    expect(r.pictures).toBeGreaterThan(r.n * 0.9);
  });

  test('tracks that do not start at zero keep their sync, and the asset its real length', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const onset = async (file: string, name = file) => {
        const asset = await lab.addFile(name, `/fixtures/${file}`, name);
        const project = kit.project(
          160,
          90,
          [asset],
          [
            { assetId: name, start: 0, duration: 60 },
            { type: 'audio', assetId: name, start: 0, duration: 60 },
          ],
        );
        const audio = (await engine.renderAudioChunk(project, lab.library, 0, 2, 48000)).getChannelData(0);
        let first = -1;
        for (let i = 0; i < audio.length && first < 0; i++) if (Math.abs(audio[i]) > 0.02) first = i / 48000;
        const t0 = performance.now();
        const frame = await lab.renderFrame(project, 0);
        const media = await lab.library.get(name);
        return {
          duration: asset.duration,
          first,
          missing: frame.stats.missing,
          frameMs: performance.now() - t0,
          videoStart: media.videoStart,
          audioStart: media.audioStart,
        };
      };
      // Video from 0 s, a tone that begins half a second later.
      const late = await onset('late-audio.mkv');
      // A 3 s transport stream whose clock starts at 101.4 s (audio a little before the picture).
      const ts = await onset('offset.mpegts', 'offset.ts');
      return { late, ts };
    });
    expect(r.late.first).toBeGreaterThan(0.47);
    expect(r.late.first).toBeLessThan(0.53);
    expect(r.late.duration).toBeCloseTo(3, 1);
    expect(r.ts.duration).toBeGreaterThan(2.9);
    expect(r.ts.duration).toBeLessThan(3.1);
    expect(r.ts.videoStart).toBeCloseTo(101.4, 3);
    expect(r.ts.audioStart).toBe(r.ts.videoStart);
    expect(r.ts.first).toBeLessThan(0.03);
    expect(r.ts.missing).toBe(0);
    expect(r.ts.frameMs).toBeLessThan(3000);
  });

  test('anamorphic video is laid out by its display size', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(320, 180);
      // 240x180 stored pixels with a 4:3 pixel aspect ratio: a 16:9 picture.
      const asset = await lab.addFile('ana', '/fixtures/anamorphic.webm', 'anamorphic.webm');
      const project = kit.project(320, 180, [asset], [{ assetId: 'ana', start: 0, duration: 20 }], {
        background: '#ff00ff',
      });
      const f = await lab.renderFrame(project, 3);
      const background = (x: number) => {
        const [red, green, blue] = lab.sample(f.pixels, 320, x, 88);
        return red > 200 && green < 60 && blue > 200;
      };
      return { width: asset.width, height: asset.height, left: background(4), right: background(312) };
    });
    expect([r.width, r.height]).toEqual([320, 180]);
    // The picture reaches both edges; laid out by stored width it would leave 40 px bars.
    expect(r.left).toBe(false);
    expect(r.right).toBe(false);
  });

  test('stepping back while paused is served from frames kept behind the playhead', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const project = kit.project(320, 180, [vid], [{ assetId: 'vid', start: 0, duration: 110 }]);
      const want: number[] = [];
      for (let f = 0; f <= 90; f++) want.push(kit.hash((await lab.renderFrame(project, f)).pixels));
      lab.init(320, 180);
      const shows = (f: number) => () => kit.hash(lab.compositor.readPixels()) === want[f];
      await kit.view(project, 90, 4000, shows(90));
      kit.decoders.started = 0;
      let exact = 0;
      let held = 0;
      for (let f = 89; f >= 50; f--) {
        await kit.view(project, f, 4000, shows(f));
        if (shows(f)()) exact++;
        held = Math.max(held, lab.sources.stats().frames);
      }
      const back = kit.decoders.started;
      for (let f = 51; f <= 62; f++) {
        await kit.view(project, f, 4000, shows(f));
        if (shows(f)()) exact++;
      }
      const forth = kit.decoders.started - back;
      // Playing, nothing behind the playhead is worth keeping.
      lab.sources.sequential = true;
      for (let f = 63; f <= 80; f++) await kit.view(project, f, 4000, shows(f));
      return { exact, back, forth, held, playing: lab.sources.stats().frames };
    });
    expect(r.exact).toBe(52);
    // 40 steps back: a decode run every dozen frames or so instead of a seek for each.
    expect(r.back).toBeLessThanOrEqual(5);
    expect(r.forth).toBeLessThanOrEqual(1);
    expect(r.held).toBeLessThanOrEqual(24);
    expect(r.playing).toBeLessThanOrEqual(6);
  });

  test('a decoder that stops while too many of its frames are held gets them back', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const n = 60;
      const forward = kit.project(320, 180, [vid], [{ assetId: 'vid', start: 0, duration: n }]);
      const reversed = kit.project(
        320,
        180,
        [vid],
        [{ assetId: 'vid', start: 0, duration: n, reverse: true }],
      );
      const want: number[] = [];
      for (let f = 0; f < n; f++) want.push(kit.hash((await lab.renderFrame(forward, f)).pixels));

      // Stand in for hardware decoders with a pool of ten pictures each: one produces nothing
      // more while ten of its frames are still open.
      const pool = 10;
      let peak = 0;
      const sink = engine.VideoSampleSink.prototype;
      const samples = sink.samples;
      sink.samples = function (...args: unknown[]) {
        const inner = samples.apply(this, args);
        let open = 0;
        const waiting = new Set<() => void>();
        return (async function* () {
          for await (const sample of inner) {
            while (open >= pool) await new Promise<void>((res) => waiting.add(res));
            peak = Math.max(peak, ++open);
            const close = sample.close.bind(sample);
            let closed = false;
            sample.close = () => {
              if (!closed) open--;
              closed = true;
              close();
              for (const wake of Array.from(waiting)) wake();
              waiting.clear();
            };
            yield sample;
          }
        })();
      };

      lab.init(320, 180);
      let wrong = 0;
      let slowest = 0;
      for (let f = 0; f < n; f++) {
        const t0 = performance.now();
        if (kit.hash((await lab.renderFrame(reversed, f)).pixels) !== want[n - 1 - f]) wrong++;
        slowest = Math.max(slowest, performance.now() - t0);
      }

      // The same decoder under a paused viewer that steps back.
      lab.init(320, 180);
      const shows = (f: number) => () => kit.hash(lab.compositor.readPixels()) === want[f];
      await kit.view(forward, 50, 4000, shows(50));
      let stepped = 0;
      const t1 = performance.now();
      for (let f = 49; f >= 30; f--) {
        await kit.view(forward, f, 6000, shows(f));
        if (shows(f)()) stepped++;
      }
      sink.samples = samples;
      return { wrong, slowest, stepped, steppingMs: performance.now() - t1, peak };
    });
    expect(r.peak).toBe(10); // the stand-in did run dry
    expect(r.wrong).toBe(0);
    expect(r.slowest).toBeLessThan(3000);
    expect(r.stepped).toBe(20);
    expect(r.steppingMs).toBeLessThan(12000);
  });

  test('a decoder that never delivers a frame gets a few spaced tries, then is reported and left alone', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const project = kit.project(320, 180, [vid], [{ assetId: 'vid', start: 0, duration: 150 }]);
      const want = kit.hash((await lab.renderFrame(project, 5)).pixels);
      const wantFar = kit.hash((await lab.renderFrame(project, 100)).pixels);

      const sink = engine.VideoSampleSink.prototype;
      const samples = sink.samples;
      let starts = 0;
      const dead = function () {
        starts++;
        return (async function* () {
          throw new Error('decoder gave up');
        })();
      };
      const exact = async (frame: number) => {
        const [before, t0] = [starts, performance.now()];
        const problems = await lab.sources.prepare(project, core.resolveFrame(project, frame), true);
        return {
          reasons: problems.map((p: any) => `${p.part}:${p.reason}`),
          causes: problems.map((p: any) => p.cause ?? null),
          ms: performance.now() - t0,
          starts: starts - before,
        };
      };

      // A paused viewer resting on the clip.
      sink.samples = dead;
      lab.init(320, 180);
      const draws = await kit.view(project, 5, 2000);
      const viewer = { draws, starts };

      // Exact renders: the first learns that the clip does not decode, its neighbours are told at once.
      lab.init(320, 180);
      const first = await exact(5);
      const next = await exact(6);

      // The same from a decoder that ends without an error and without a frame.
      sink.samples = function () {
        starts++;
        return (async function* () {})();
      };
      lab.init(320, 180);
      const empty = await exact(5);

      // An export says so once and does not wait for every frame. Nor when the clip runs so fast
      // that each frame lies seconds further into the file than the one before.
      sink.samples = dead;
      const exportOf = async (what: unknown, frames: number) => {
        starts = 0;
        const out = await lab.exportBase64(what, {
          container: 'webm',
          videoCodec: 'vp9',
          audioCodec: 'opus',
          width: 160,
          height: 90,
          fpsNum: 30,
          fpsDen: 1,
          videoBitrate: 300_000,
          audioBitrate: 96_000,
          range: { in: 0, out: frames },
          includeVideo: true,
          includeAudio: false,
          dynamicRange: 'sdr',
          keyFrameInterval: 1,
          hardwareAcceleration: 'no-preference',
        });
        return {
          frames: out.frames,
          seconds: out.seconds,
          starts,
          warnings: out.warnings.map((w: any) => `${w.part}:${w.reason}@${w.frame}`),
          message: out.warnings[0]?.message,
          cause: out.warnings[0]?.cause,
        };
      };
      const exported = await exportOf(project, 45);
      const fast = kit.project(320, 180, [vid], [{ assetId: 'vid', start: 0, duration: 3, speed: 50 }]);
      const exportedFast = await exportOf(fast, 3);

      // The verdict stands for the frames around it even when the decoder would work again, and
      // for whatever frame is asked for next while frames are asked for in order. A viewer at
      // rest in another part of the file gets a new try, and so does a reset of the asset.
      lab.init(320, 180);
      await exact(5);
      sink.samples = function (...args: unknown[]) {
        starts++;
        return samples.apply(this, args);
      };
      const stands = await exact(7);
      lab.sources.sequential = true;
      const inOrder = await exact(100);
      lab.sources.sequential = false;
      const far = await exact(100);
      const farShown = kit.hash((await lab.renderFrame(project, 100)).pixels) === wantFar;
      sink.samples = dead;
      lab.init(320, 180);
      await exact(5);
      sink.samples = samples;
      lab.sources.resetAsset('vid');
      const reset = kit.hash((await lab.renderFrame(project, 5)).pixels) === want;
      return { viewer, first, next, empty, exported, exportedFast, stands, inOrder, far, farShown, reset };
    });
    // Three starts, a redraw for each and for each wait that ended: not one of each per frame.
    expect(r.viewer.starts).toBe(3);
    expect(r.viewer.draws).toBeLessThan(10);
    // With what the decoder said when it stopped, where it said anything.
    expect(r.first).toMatchObject({
      reasons: ['video:decode-error'],
      causes: ['decoder gave up'],
      starts: 3,
    });
    expect(r.first.ms).toBeLessThan(1000);
    expect(r.next).toMatchObject({ reasons: ['video:decode-error'], starts: 0 });
    expect(r.next.ms).toBeLessThan(100);
    expect(r.empty).toMatchObject({ reasons: ['video:decode-error'], causes: [null], starts: 3 });
    expect(r.empty.ms).toBeLessThan(1000);
    expect(r.exported.frames).toBe(45);
    expect(r.exported.warnings).toEqual(['video:decode-error@0']);
    expect(r.exported.message).toContain('“testsrc.mp4” stopped decoding');
    expect(r.exported.cause).toBe('decoder gave up');
    expect(r.exported.starts).toBe(3);
    expect(r.exported.seconds).toBeLessThan(8);
    expect(r.exportedFast).toMatchObject({ frames: 3, warnings: ['video:decode-error@0'], starts: 3 });
    expect(r.stands).toMatchObject({ reasons: ['video:decode-error'], starts: 0 });
    expect(r.inOrder).toMatchObject({ reasons: ['video:decode-error'], starts: 0 });
    expect(r.far).toMatchObject({ reasons: [], starts: 1 });
    expect(r.farShown).toBe(true);
    expect(r.reset).toBe(true);
  });

  test('a decoder that fails once is started again: before its first frame, and after a break further in', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const project = kit.project(320, 180, [vid], [{ assetId: 'vid', start: 0, duration: 90 }]);
      const want: number[] = [];
      for (const f of [3, 5, 9, 40]) want[f] = kit.hash((await lab.renderFrame(project, f)).pixels);

      const sink = engine.VideoSampleSink.prototype;
      const samples = sink.samples;
      let starts = 0;
      /** The real decoder, except that its first `failures` starts throw before any frame. */
      const flaky = (failures: number) => {
        starts = 0;
        sink.samples = function (...args: unknown[]) {
          if (++starts > failures) return samples.apply(this, args);
          return (async function* () {
            throw new Error('decoder not ready');
          })();
        };
      };
      const shows = (f: number) => () => kit.hash(lab.compositor.readPixels()) === want[f];

      // Exact render: one failed start, then two.
      const exact = [];
      for (const failures of [1, 2]) {
        flaky(failures);
        lab.init(320, 180);
        const t0 = performance.now();
        const problems = await lab.sources.prepare(project, core.resolveFrame(project, 5), true);
        lab.compositor.render(project, core.resolveFrame(project, 5), lab.sources, {});
        exact.push({ problems, ms: performance.now() - t0, shown: shows(5)(), starts });
      }
      // A paused viewer: nobody waits for the frame, the cursor has to ask for the redraw itself.
      flaky(1);
      lab.init(320, 180);
      await kit.view(project, 5, 4000, shows(5));
      const viewer = { shown: shows(5)(), starts };

      // A decoder that breaks after its ninth frame: the picture holds there, nothing is
      // restarted for the frames past the break, and going back in front of it decodes again.
      starts = 0;
      sink.samples = function (...args: unknown[]) {
        starts++;
        const inner = samples.apply(this, args);
        return (async function* () {
          let n = 0;
          for await (const sample of inner) {
            if (++n > 9) {
              sample.close();
              throw new Error('bad data');
            }
            yield sample;
          }
        })();
      };
      lab.init(320, 180);
      await lab.renderFrame(project, 3);
      const t1 = performance.now();
      const past = await lab.sources.prepare(project, core.resolveFrame(project, 40), true);
      const pastMs = performance.now() - t1;
      lab.compositor.render(project, core.resolveFrame(project, 40), lab.sources, {});
      const held = shows(40)();
      const brokenStarts = starts;
      sink.samples = samples;
      const before = kit.hash((await lab.renderFrame(project, 3)).pixels) === want[3];
      const recovered = kit.hash((await lab.renderFrame(project, 40)).pixels) === want[40];
      return {
        exact,
        viewer,
        past: past.map((p: any) => p.reason),
        pastMs,
        held,
        brokenStarts,
        before,
        recovered,
      };
    });
    expect(r.exact[0]).toMatchObject({ problems: [], shown: true, starts: 2 });
    expect(r.exact[1]).toMatchObject({ problems: [], shown: true, starts: 3 });
    expect(r.exact[1].ms).toBeLessThan(2500);
    expect(r.viewer).toEqual({ shown: true, starts: 2 });
    expect(r.past).toEqual(['decode-error']);
    expect(r.pastMs).toBeLessThan(1500);
    expect(r.held).toBe(false); // the last good frame, not the one asked for
    expect(r.brokenStarts).toBe(1);
    expect(r.before).toBe(true);
    expect(r.recovered).toBe(true);
  });

  test('media that turns up later is shown and heard without a reload', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const png = await lab.addFile('png', '/fixtures/green.png', 'green.png');
      const tone = await lab.addFile('tone', URL.createObjectURL(kit.tone(30)), 'tone.wav');
      const files = new Map(lab.files);
      // Neither on this device nor on the server yet: a collaborator is still uploading.
      lab.files.clear();
      const project = kit.project(
        320,
        180,
        [vid, png, tone],
        [
          { assetId: 'vid', start: 0, duration: 60 },
          { type: 'image', assetId: 'png', start: 60, duration: 30 },
          { type: 'audio', assetId: 'tone', start: 0, duration: 900 },
        ],
      );
      const seen = () => kit.last.missing === 0;
      const timed = async (frame: number) => {
        const t0 = performance.now();
        await kit.view(project, frame, 9000, seen);
        return { ms: performance.now() - t0, missing: kit.last.missing };
      };

      const t0 = performance.now();
      const exact = await lab.sources.prepare(project, core.resolveFrame(project, 5), true);
      const exactMs = performance.now() - t0;
      await kit.view(project, 5, 400);
      const videoBefore = kit.last.missing;
      lab.files.set('vid', files.get('vid'));
      const video = await timed(5);

      await kit.view(project, 70, 400);
      const stillBefore = kit.last.missing;
      lab.files.set('png', files.get('png'));
      const still = await timed(70);

      // Told that the asset arrived, the answer is immediate.
      lab.files.delete('vid');
      lab.sources.resetAsset('vid');
      await kit.view(project, 5, 400);
      const resetBefore = kit.last.missing;
      lab.files.set('vid', files.get('vid'));
      lab.sources.resetAsset('vid');
      const reset = await timed(5);

      // Sound: a voice whose file is missing when playback starts joins in when it arrives.
      const ctx = new AudioContext();
      await ctx.resume();
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      graph.start(project, { startSec: 0, t0: ctx.currentTime, rate: 1, endSec: 30 });
      const pump = setInterval(() => void graph.pump(), 200);
      void graph.pump();
      const level = () => Math.max(...graph.masterLevels());
      let before = 0;
      for (const end = performance.now() + 700; performance.now() < end;) {
        before = Math.max(before, level());
        await new Promise((res) => setTimeout(res, 50));
      }
      lab.files.set('tone', files.get('tone'));
      const a0 = performance.now();
      let heard = -1;
      while (heard < 0 && performance.now() - a0 < 8000) {
        if (level() > 0.02) heard = performance.now() - a0;
        else await new Promise((res) => setTimeout(res, 50));
      }
      clearInterval(pump);
      graph.dispose();
      await ctx.close();
      return { exact, exactMs, videoBefore, video, stillBefore, still, resetBefore, reset, before, heard };
    });
    // An exact render does not wait for media that is not there; it says so.
    expect(r.exact).toMatchObject([{ assetId: 'vid', part: 'video', reason: 'missing' }]);
    expect(r.exactMs).toBeLessThan(1500);
    expect(r.videoBefore).toBe(1);
    expect(r.video.missing).toBe(0);
    expect(r.video.ms).toBeLessThan(6000);
    expect(r.stillBefore).toBe(1);
    expect(r.still.missing).toBe(0);
    expect(r.still.ms).toBeLessThan(7000);
    expect(r.resetBefore).toBe(1);
    expect(r.reset.missing).toBe(0);
    expect(r.reset.ms).toBeLessThan(1500);
    expect(r.before).toBeLessThan(0.001);
    expect(r.heard).toBeGreaterThanOrEqual(0);
    expect(r.heard).toBeLessThan(6000);
  });

  test('a still or a LUT that is not there is asked for again in silence, and one that does not decode is named once', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core } = lab;
      lab.init(160, 90);
      const still = await lab.addFile('absent-still', '/fixtures/green.png', 'green.png');
      const look = await lab.addFile('absent-look', '/fixtures/warm.cube', 'warm.cube');
      const files = new Map(lab.files);
      // Neither is on this device or on the server: the project was opened without its media.
      lab.files.clear();
      lab.files.set('odd-still', new File(['not a picture at all'], 'odd.png', { type: 'image/png' }));
      lab.files.set('odd-look', new File(['no table in here'], 'odd.cube'));
      const graded = (assetId: string, lutId: string, start: number) => ({
        type: 'image',
        assetId,
        start,
        duration: 30,
        grade: { ...core.DEFAULT_GRADE, lutId },
      });
      const project = kit.project(
        160,
        90,
        [still, look, { ...still, id: 'odd-still' }, { ...look, id: 'odd-look' }],
        [graded('absent-still', 'absent-look', 0), graded('odd-still', 'odd-look', 30)],
      );
      const asked: Record<string, number> = {};
      const read = lab.library.read;
      lab.library.read = function (id: string) {
        asked[id] = (asked[id] ?? 0) + 1;
        return read.call(this, id);
      };
      // A viewer at rest on each clip, for longer than two of the waits between tries.
      await kit.view(project, 10, 7500);
      const absent = kit.last.missing;
      await kit.view(project, 40, 7500);
      // The files arrive, and the session says so.
      for (const id of ['absent-still', 'absent-look']) {
        lab.files.set(id, files.get(id));
        lab.sources.resetAsset(id);
      }
      const there = () => kit.last.missing === 0 && !!lab.sources.getLut('absent-look');
      await kit.view(project, 10, 4000, there);
      return { asked, absent, there: there() };
    });
    // Each was asked for again while the playhead rested on it (every three seconds).
    expect(r.absent).toBe(1);
    expect(r.asked['absent-still']).toBeGreaterThanOrEqual(2);
    expect(r.asked['absent-look']).toBeGreaterThanOrEqual(2);
    expect(r.asked['odd-still']).toBeGreaterThanOrEqual(2);
    expect(r.there).toBe(true);
    expect(warnings.filter((w) => w.includes('absent-'))).toEqual([]);
    // What is wrong with a file that is there is said, once.
    const odd = warnings.filter((w) => w.includes('odd-')).sort();
    expect(odd.length).toBe(2);
    expect(odd[0].startsWith('[image] odd-still')).toBe(true);
    expect(odd[1].startsWith('[lut] odd-look')).toBe(true);
  });

  test('a voiceover take whose capture breaks is reported and not kept', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { engine } = (window as any).lab;
      const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
      const devices = navigator.mediaDevices;
      const getUserMedia = devices.getUserMedia;
      let stream: MediaStream | null = null;
      devices.getUserMedia = async function (constraints) {
        return (stream = await getUserMedia.call(this, constraints));
      };
      const outcome = (rec: any) =>
        rec.stop().then(
          (blob: Blob) => blob.size,
          (err: Error) => err,
        );

      // A take that runs its course.
      const good = await engine.VoiceRecorder.start();
      const heard: Error[] = [];
      good.onError = (err: Error) => heard.push(err);
      await wait(600);
      const kept = await outcome(good);
      // Giving the microphone back afterwards is not a failure of the take.
      await wait(200);
      const again = await outcome(good);

      // The microphone goes away in the middle of one.
      const lost = await engine.VoiceRecorder.start();
      const track = stream!.getAudioTracks()[0];
      const told: Error[] = [];
      lost.onError = (err: Error) => told.push(err);
      await wait(400);
      track.dispatchEvent(new Event('ended'));
      track.dispatchEvent(new Event('ended'));
      const refused = await outcome(lost);
      await lost.cancel();
      const unplugged = {
        told: told.map((e) => e.message),
        same: refused === told[0],
        released: track.readyState,
        level: lost.level(),
      };

      // The source itself fails: what the microphone delivers can no longer be taken in.
      const Processor = (window as any).MediaStreamTrackProcessor;
      (window as any).MediaStreamTrackProcessor = class {
        readable = new ReadableStream({
          start: (c) => void setTimeout(() => c.error(new Error('device lost')), 300),
        });
      };
      const broken = await engine.VoiceRecorder.start();
      const failed: Error[] = [];
      broken.onError = (err: Error) => failed.push(err);
      for (const until = performance.now() + 5000; performance.now() < until && !failed.length;)
        await wait(50);
      const rejected = await outcome(broken);
      (window as any).MediaStreamTrackProcessor = Processor;
      devices.getUserMedia = getUserMedia;
      return {
        kept,
        heard: heard.length,
        again: (again as Error).message,
        unplugged,
        source: {
          told: failed.map((e) => e.message),
          same: rejected === failed[0],
          cause: ((failed[0]?.cause as Error) ?? {}).message,
          released: stream!.getAudioTracks()[0].readyState,
        },
      };
    });
    expect(r.kept).toBeGreaterThan(44);
    expect(r.heard).toBe(0);
    expect(r.again).toBe('The recording has already ended.');
    expect(r.unplugged).toEqual({
      told: ['The microphone was disconnected, so the take was lost.'],
      same: true,
      released: 'ended',
      level: 0,
    });
    expect(r.source).toEqual({
      told: ['The recording failed part-way, so the take was lost.'],
      same: true,
      cause: 'device lost',
      released: 'ended',
    });
    // The library the recorder is built on warns when nobody listens for a source's errors.
    expect(warnings.filter((w) => w.includes('errorPromise'))).toEqual([]);
  });

  test('sound that starts long after playback began does not decode its way there', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const tone = await lab.addFile('long', URL.createObjectURL(kit.tone(700, 4000)), 'long.wav');
      const project = kit.project(
        160,
        90,
        [tone],
        [{ type: 'audio', assetId: 'long', start: 0, duration: 21000 }],
      );
      const asked: number[] = [];
      const sink = engine.AudioBufferSink.prototype;
      const buffers = sink.buffers;
      sink.buffers = function (...args: number[]) {
        asked.push(args[0]);
        return buffers.apply(this, args);
      };
      const ctx = new AudioContext();
      await ctx.resume();
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      // Ten minutes into uninterrupted playback the mix is rebuilt (a track was unmuted, say):
      // the session still carries the anchor of the moment playback started.
      graph.start(project, { startSec: 0, t0: ctx.currentTime - 600, rate: 1, endSec: 700 });
      const t0 = performance.now();
      void graph.pump();
      let heard = -1;
      while (heard < 0 && performance.now() - t0 < 8000) {
        if (Math.max(...graph.masterLevels()) > 0.02) heard = performance.now() - t0;
        else await new Promise((res) => setTimeout(res, 20));
      }
      graph.dispose();
      await ctx.close();
      sink.buffers = buffers;
      return { asked, heard };
    });
    expect(r.asked.length).toBe(1);
    expect(r.asked[0]).toBeGreaterThan(599.9);
    expect(r.asked[0]).toBeLessThan(602);
    expect(r.heard).toBeGreaterThanOrEqual(0);
    expect(r.heard).toBeLessThan(2000);
  });

  test('sound at the timeline’s sample rate passes through sample for sample, wherever the clip starts', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      // Noise: any resampling or interpolation changes every sample of it.
      let seed = 4321;
      const noise = Int16Array.from({ length: 48000 * 5 }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed % 16001) - 8000 || 1;
      });
      const treble = Int16Array.from({ length: 48000 * 3 }, (_, i) =>
        Math.round(Math.sin((i / 48000) * 15000 * 2 * Math.PI) * 8000),
      );
      const assets = [
        await lab.addFile('noise', URL.createObjectURL(kit.wav(noise, 48000)), 'noise.wav'),
        await lab.addFile('treble', URL.createObjectURL(kit.wav(treble, 48000)), 'treble.wav'),
      ];
      // 29.97 fps: four frames in five begin between two samples at 48 kHz.
      const ntsc = { fpsNum: 30000, fpsDen: 1001, sampleRate: 48000 };
      const fps = 30000 / 1001;
      const render = async (clip: object, start: number, seconds: number, settings = ntsc) => {
        const project = kit.project(160, 90, assets, [{ type: 'audio', ...clip }], settings);
        const rate = settings.sampleRate;
        return (await engine.renderAudioChunk(project, lab.library, start, seconds, rate)).getChannelData(0);
      };

      // A clip that starts on frame 7 from an in-point 5 frames into the file: both between samples.
      const clip = { assetId: 'noise', start: 7, duration: 100, sourceIn: 5 / fps };
      const out = await render(clip, 0, 4);
      const from = (7 / fps) * 48000;
      const to = (107 / fps) * 48000;
      const zero = from - (5 / fps) * 48000;
      const differing = (shift: number) => {
        let wrong = 0;
        for (let i = 0; i < out.length; i++) {
          const inside = i >= from + 2 && i < to - 2;
          if (!inside && i > from - 2 && i < to + 2) continue;
          if (Math.abs(out[i] - (inside ? noise[i - shift] / 32768 : 0)) > 1e-7) wrong++;
        }
        return wrong;
      };
      const wrong = Math.min(differing(Math.floor(zero)), differing(Math.ceil(zero)));

      // Rendered again, and in two chunks the way an export does.
      const again = await render(clip, 0, 4);
      let repeatable = true;
      for (let i = 0; i < out.length; i++) if (out[i] !== again[i]) repeatable = false;
      const [a, b, whole] = [
        await render(clip, 0.5, 1),
        await render(clip, 1.5, 1),
        await render(clip, 0.5, 2),
      ];
      let seam = 0;
      for (let i = 0; i < 48000; i++)
        seam = Math.max(seam, Math.abs(a[i] - whole[i]), Math.abs(b[i] - whole[48000 + i]));

      // An export renders its sound in 4 s chunks from wherever it starts, here on a frame between
      // two samples and less than the pre-roll into the timeline. `lead` is how many samples into
      // the clip that is; joined, the chunks are the source from there on.
      const joined = async (clip: object, start: number, lead: number, settings = ntsc) => {
        const head = await render(clip, start, 4, settings);
        const tail = await render(clip, start + 4, 0.5, settings);
        const differing = (shift: number) => {
          let wrong = 0;
          for (let i = 0; i < head.length + tail.length; i++) {
            const got = i < head.length ? head[i] : tail[i - head.length];
            if (Math.abs(got - noise[i + shift] / 32768) > 1e-7) wrong++;
          }
          return wrong;
        };
        return {
          lengths: [head.length, tail.length],
          wrong: Math.min(differing(Math.floor(lead)), differing(Math.ceil(lead))),
        };
      };
      const offGrid = await joined({ assetId: 'noise', start: 3, duration: 140 }, 7 / fps, (4 / fps) * 48000);
      // 44.1 kHz at 24 fps: a clip on an odd frame lies exactly half-way between two samples.
      assets.push(
        await lab.addFile('cd', URL.createObjectURL(kit.wav(noise.subarray(0, 44100 * 5), 44100)), 'cd.wav'),
      );
      const film = { fpsNum: 24, fpsDen: 1, sampleRate: 44100 };
      const halfWay = await joined({ assetId: 'cd', start: 3, duration: 110 }, 4 / 24, 44100 / 24, film);

      // A 15 kHz tone keeps its level whichever frame the clip starts on.
      const levels = [];
      for (let frame = 1; frame <= 5; frame++) {
        const tone = await render({ assetId: 'treble', start: frame, duration: 60 }, 0, 2);
        const at = Math.round((frame / fps) * 48000) + 4800;
        let sum = 0;
        for (let i = at; i < at + 48000; i++) sum += tone[i] * tone[i];
        levels.push(20 * Math.log10(Math.sqrt(sum / 48000) / (8000 / 32768 / Math.SQRT2)));
      }
      return { wrong, repeatable, seam, offGrid, halfWay, levels };
    });
    expect(r.wrong).toBe(0);
    expect(r.repeatable).toBe(true);
    expect(r.seam).toBeLessThan(1e-6);
    // Every chunk is exactly as long as it says, and nothing is lost, added or moved where two meet.
    expect(r.offGrid).toEqual({ lengths: [192000, 24000], wrong: 0 });
    expect(r.halfWay).toEqual({ lengths: [176400, 22050], wrong: 0 });
    for (const db of r.levels) expect(Math.abs(db)).toBeLessThan(0.05);
  });

  test('sound at another sample rate or speed is converted without dulling it or adding what was not there', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const add = async (id: string, samples: Float32Array, rate: number) =>
        lab.addFile(id, URL.createObjectURL(kit.floatWav([samples], rate)), `${id}.wav`);
      const settings = { sampleRate: 48000 };
      const render = async (project: any, start: number, seconds: number) =>
        (await engine.renderAudioChunk(project, lab.library, start, seconds, 48000)).getChannelData(0);

      // 44.1 kHz material in a 48 kHz project, one tone at a time: its level, everything that is
      // not the tone, and the tone's mirror image around half the source rate.
      const tones = [];
      for (const hz of [100, 1000, 4000, 10000, 15000, 18000]) {
        const asset = await add(`t${hz}`, kit.sine(hz, 44100, 6), 44100);
        const project = kit.project(
          160,
          90,
          [asset],
          [{ type: 'audio', assetId: `t${hz}`, start: 0, duration: 180 }],
          settings,
        );
        const out = await render(project, 1, 4);
        const image = kit.purity(
          out,
          44100 - hz > 24000 ? 48000 - (44100 - hz) : 44100 - hz,
          48000,
          0.5,
          4800,
          187200,
        );
        tones.push({ hz, ...kit.purity(out, hz, 48000, 0.5, 4800, 187200), image: image.gain });
      }

      // A real export of such a clip: 16-bit WAV, ten seconds from frame 15, rendered in three chunks.
      const asset = await add('export', kit.sine(10000, 44100, 12), 44100);
      const project = kit.project(
        160,
        90,
        [asset],
        [{ type: 'audio', assetId: 'export', start: 0, duration: 360 }],
        settings,
      );
      const file = await lab.exportBase64(project, {
        container: 'wav',
        videoCodec: 'vp9',
        audioCodec: 'pcm-s16',
        width: 160,
        height: 90,
        fpsNum: 30,
        fpsDen: 1,
        videoBitrate: 300_000,
        audioBitrate: 96_000,
        range: { in: 15, out: 315 },
        includeVideo: false,
        includeAudio: true,
        dynamicRange: 'sdr',
        keyFrameInterval: 1,
        hardwareAcceleration: 'no-preference',
      });
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      let at = 12;
      while (String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'data')
        at += 8 + view.getUint32(at + 4, true);
      const frames = view.getUint32(at + 4, true) / 4;
      const pcm = Float32Array.from(
        { length: frames },
        (_, i) => view.getInt16(at + 8 + i * 4, true) / 32768,
      );
      const exported = { frames, ...kit.purity(pcm, 10000, 48000, 0.5, 4800, frames - 4800) };

      // Faster and slower: a 48 kHz file at double and at half speed. At double speed 15 kHz would
      // come out at 30 kHz, beyond what 48 kHz can carry; it must not come back as 18 kHz.
      const fast = await add('fast', kit.sine(15000, 48000, 9), 48000);
      const low = await add('low', kit.sine(3000, 48000, 9), 48000);
      const speed = async (assetId: string, speed: number) =>
        render(
          kit.project(
            160,
            90,
            [fast, low],
            [{ type: 'audio', assetId, start: 0, duration: 120, speed }],
            settings,
          ),
          0.5,
          3,
        );
      const folded = await speed('fast', 2);
      let foldedPeak = 0;
      for (let i = 4800; i < 139200; i++) foldedPeak = Math.max(foldedPeak, Math.abs(folded[i]));
      return {
        tones,
        exported,
        foldedPeak,
        doubled: kit.purity(await speed('low', 2), 6000, 48000, 0.5, 4800, 139200),
        halved: kit.purity(await speed('low', 0.5), 1500, 48000, 0.5, 4800, 139200),
      };
    });
    for (const t of r.tones) {
      expect(Math.abs(t.gain), `${t.hz} Hz level`).toBeLessThan(0.1);
      expect(t.rest, `${t.hz} Hz residue`).toBeLessThan(-80);
      expect(t.image, `${t.hz} Hz image`).toBeLessThan(-80);
    }
    expect(r.exported.frames).toBe(480000);
    expect(Math.abs(r.exported.gain)).toBeLessThan(0.1);
    // 16 bits put their own floor 92 dB under a tone at half scale.
    expect(r.exported.rest).toBeLessThan(-80);
    expect(20 * Math.log10(r.foldedPeak / 0.5 + 1e-30)).toBeLessThan(-80);
    expect(Math.abs(r.doubled.gain)).toBeLessThan(0.1);
    expect(r.doubled.rest).toBeLessThan(-80);
    expect(Math.abs(r.halved.gain)).toBeLessThan(0.1);
    expect(r.halved.rest).toBeLessThan(-80);
  });

  test('converted sound joins without a seam across the chunks of an export, and stays in sync', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const add = async (id: string, samples: Float32Array, rate: number) =>
        lab.addFile(id, URL.createObjectURL(kit.floatWav([samples], rate)), `${id}.wav`);
      const clicks = (rate: number, at: number[]) => {
        const x = new Float32Array(rate * 10);
        for (const i of at) x[i] = 0.9;
        return x;
      };
      const at44 = [44100, 110250, 319725];
      const at48 = [48000, 120000, 348000];
      const assets = [
        await add('cd', kit.sine(1000, 44100, 11), 44100),
        await add('dat', kit.sine(3000, 48000, 16), 48000),
        await add('clicks44', clicks(44100, at44), 44100),
        await add('clicks48', clicks(48000, at48), 48000),
      ];
      const ntsc = { fpsNum: 30000, fpsDen: 1001, sampleRate: 48000 };
      const fps = 30000 / 1001;
      const render = async (project: any, start: number, seconds: number): Promise<Float32Array> =>
        (await engine.renderAudioChunk(project, lab.library, start, seconds, 48000))
          .getChannelData(0)
          .slice();
      /** Nine seconds from `start`, rendered the way an export does: four seconds at a time. */
      const chunked = async (project: any, start: number) => {
        const parts = [
          await render(project, start, 4),
          await render(project, start + 4, 4),
          await render(project, start + 8, 1),
        ];
        const joined = new Float32Array(432000);
        parts.forEach((part, i) => joined.set(part, i * 192000));
        return { joined, lengths: parts.map((part) => part.length) };
      };
      /** The largest bend (second difference) of `x` in `[from, to)`: a click shows as one. */
      const bend = (x: Float32Array, from: number, to: number) => {
        let most = 0;
        for (let i = from; i < to; i++) most = Math.max(most, Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]));
        return most;
      };
      const seams = async (clip: object, start: number) => {
        const project = kit.project(160, 90, assets, [{ type: 'audio', ...clip }], ntsc);
        const { joined, lengths } = await chunked(project, start);
        const whole = await render(project, start, 9);
        let apart = 0;
        for (let i = 0; i < joined.length; i++) apart = Math.max(apart, Math.abs(joined[i] - whole[i]));
        const again = (await chunked(project, start)).joined;
        let same = true;
        for (let i = 0; i < joined.length; i++) if (joined[i] !== again[i]) same = false;
        return {
          lengths,
          apart,
          same,
          atSeams: Math.max(bend(joined, 192000 - 64, 192000 + 64), bend(joined, 384000 - 64, 384000 + 64)),
          between: Math.max(bend(joined, 9600, 182400), bend(joined, 201600, 374400)),
        };
      };
      /** Where the loudest samples of a nine-second render fall, one per click. */
      const landed = async (clip: object, count: number) => {
        const project = kit.project(160, 90, assets, [{ type: 'audio', ...clip }], ntsc);
        const x = Float32Array.from((await chunked(project, 0)).joined, Math.abs);
        const found: number[] = [];
        for (let n = 0; n < count; n++) {
          let peak = 0;
          for (let i = 0; i < x.length; i++) if (x[i] > x[peak]) peak = i;
          found.push(peak);
          x.fill(0, Math.max(0, peak - 400), peak + 400);
        }
        return found.sort((a, b) => a - b);
      };
      const start = 7 / fps;
      return {
        // 44.1 kHz in a 48 kHz mix, on a frame and from an in-point that both lie between samples.
        rate: await seams({ assetId: 'cd', start: 7, duration: 290, sourceIn: 5 / fps }, 11 / fps),
        reversed: await seams({ assetId: 'cd', start: 3, duration: 290, reverse: true }, 8 / fps),
        faster: await seams({ assetId: 'dat', start: 4, duration: 290, speed: 1.5 }, 9 / fps),
        slowerBackwards: await seams(
          { assetId: 'dat', start: 4, duration: 290, speed: 0.5, reverse: true },
          9 / fps,
        ),
        // A click at source time t belongs on output sample (clip start + (t - in-point) / speed) * 48000.
        forward: {
          found: await landed({ assetId: 'clicks44', start: 7, duration: 280, sourceIn: 0.4 }, 3),
          ideal: at44.map((i) => (start + i / 44100 - 0.4) * 48000),
        },
        backwards: {
          found: await landed({ assetId: 'clicks44', start: 7, duration: 280, reverse: true }, 3),
          ideal: at44.map((i) => (start + 280 / fps - i / 44100) * 48000).reverse(),
        },
        doubleSpeed: {
          found: await landed({ assetId: 'clicks48', start: 7, duration: 140, speed: 2 }, 3),
          ideal: at48.map((i) => (start + i / 48000 / 2) * 48000),
        },
      };
    });
    // 1 kHz at half scale bends by 0.0086 from sample to sample, 3 kHz at speed 1.5 by 0.169.
    for (const [name, steady] of [
      ['rate', 0.0086],
      ['reversed', 0.0086],
      ['faster', 0.169],
      ['slowerBackwards', 0.0193],
    ] as const) {
      const m = r[name];
      expect(m.lengths, name).toEqual([192000, 192000, 48000]);
      // In chunks or in one go: the same sound, and the same bytes every time.
      expect(m.apart, name).toBeLessThan(1e-6);
      expect(m.same, name).toBe(true);
      expect(m.between, name).toBeGreaterThan(steady * 0.98);
      expect(m.between, name).toBeLessThan(steady * 1.02);
      expect(m.atSeams, name).toBeLessThan(m.between * 1.001);
    }
    for (const name of ['forward', 'backwards', 'doubleSpeed'] as const) {
      const { found, ideal } = r[name];
      expect(found, name).toHaveLength(3);
      // Backwards, a sample is heard one sample early, as it is at the timeline's own rate.
      found.forEach((at: number, i: number) =>
        expect(Math.abs(at - ideal[i]), `${name} ${i}`).toBeLessThan(1.5),
      );
    }
  });

  test('converted sound plays every sample once: none twice where buffers join, none after a clip has ended', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      // A constant level, so that a sample played twice or left over stands out wherever it falls.
      const level = async (id: string, rate: number) =>
        lab.addFile(
          id,
          URL.createObjectURL(kit.floatWav([new Float32Array(rate * 30).fill(0.5)], rate)),
          `${id}.wav`,
        );
      const assets = [await level('cd', 44100), await level('dat', 48000)];
      const measure = async (assetId: string, rate: number, speed: number) => {
        // Sixty short clips with gaps between them: buffers of many lengths, and many ends.
        const clips = [];
        for (let k = 0; k < 60; k++)
          clips.push({
            type: 'audio',
            assetId,
            start: k * 14,
            duration: 5 + (k % 7),
            sourceIn: 0.5 + k * 0.01,
            speed,
          });
        const project = kit.project(160, 90, assets, clips, { sampleRate: rate });
        const x = (await engine.renderAudioChunk(project, lab.library, 0, 29, rate)).getChannelData(0);
        let after = 0;
        let within = 0;
        for (const { start, duration } of clips) {
          const from = Math.ceil((start / 30) * rate - 1e-4);
          const to = Math.ceil(((start + duration) / 30) * rate - 1e-4);
          for (let i = to; i < to + 4; i++) if (Math.abs(x[i]) > 1e-4) after++;
          // Away from the ends, where the conversion fades in and out.
          for (let i = from + 400; i < to - 400; i++) if (Math.abs(x[i] - 0.5) > 2e-3) within++;
        }
        return { after, within };
      };
      return {
        rate: await measure('cd', 48000, 1),
        down: await measure('dat', 44100, 1),
        faster: await measure('dat', 48000, 1.25),
        slower: await measure('cd', 44100, 0.8),
      };
    });
    for (const name of ['rate', 'down', 'faster', 'slower'] as const)
      expect(r[name], name).toEqual({ after: 0, within: 0 });
  });

  test('sound from a lossy file joins across the chunks of an export, forwards and backwards', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      // Vorbis in WebM: packet times in whole milliseconds, and a decoder that returns nothing for
      // the first packet it is given. A decode that starts part-way does not place its sound where
      // the decode before it placed the same sound.
      const sweep = await lab.addFile('sweep', '/fixtures/sweep-vorbis.webm', 'sweep-vorbis.webm');
      const bend = (x: Float32Array, from: number, to: number) => {
        let most = 0;
        for (let i = from; i < to; i++) most = Math.max(most, Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]));
        return most;
      };
      const apart = (a: Float32Array, b: Float32Array, n: number) => {
        let most = 0;
        for (let i = 0; i < n; i++) most = Math.max(most, Math.abs(a[i] - b[i]));
        return most;
      };
      const measure = async (
        clip: { start: number; duration: number; sourceIn?: number; reverse?: boolean },
        rate: number,
      ) => {
        const project = kit.project(160, 90, [sweep], [{ type: 'audio', assetId: 'sweep', ...clip }], {
          sampleRate: rate,
        });
        const render = async (start: number, seconds: number, runs?: unknown): Promise<Float32Array> =>
          (
            await engine.renderAudioChunk(
              project,
              lab.library,
              start,
              seconds,
              rate,
              undefined,
              undefined,
              runs,
            )
          )
            .getChannelData(0)
            .slice();
        const whole = await render(0, 9);
        // Four seconds at a time, as an export renders, with what an export carries between them.
        const runs = new engine.AudioRuns();
        const parts = [await render(0, 4, runs), await render(4, 4, runs), await render(8, 1, runs)];
        runs.dispose();
        const joined = new Float32Array(rate * 9);
        parts.forEach((part, i) => joined.set(part, i * rate * 4));
        // And the export itself, as 16-bit PCM.
        const out = await lab.exportBase64(project, {
          container: 'wav',
          videoCodec: 'vp9',
          audioCodec: 'pcm-s16',
          width: 160,
          height: 90,
          fpsNum: 30,
          fpsDen: 1,
          videoBitrate: 300_000,
          audioBitrate: 96_000,
          range: null,
          includeVideo: false,
          includeAudio: true,
          dynamicRange: 'sdr',
          keyFrameInterval: 1,
          hardwareAcceleration: 'no-preference',
        });
        const bytes = Uint8Array.from(atob(out.base64), (c) => c.charCodeAt(0));
        const ctx = new OfflineAudioContext(2, 1, rate);
        const exported = (await ctx.decodeAudioData(bytes.buffer)).getChannelData(0);
        // Chunks are four seconds long; a short export has only the first seam.
        const atSeams = (x: Float32Array) =>
          Math.max(
            ...[4, 8]
              .filter((seconds) => rate * seconds + 64 < x.length)
              .map((seconds) => bend(x, rate * seconds - 64, rate * seconds + 64)),
          );
        // The clip without its two ends, where the sound starts and stops at once.
        const inside = [(clip.start / 30 + 0.1) * rate, ((clip.start + clip.duration) / 30 - 0.1) * rate];
        return {
          apart: apart(joined, whole, joined.length),
          seams: atSeams(joined),
          // The sweep rises, so what it bends by there is taken from the render in one go.
          sweep: atSeams(whole),
          rough: bend(whole, Math.ceil(inside[0]), Math.floor(inside[1])),
          exported: {
            seconds: exported.length / rate,
            apart: apart(exported, whole, exported.length),
            seams: atSeams(exported),
          },
        };
      };
      const measured = {
        native: await measure({ start: 0, duration: 266 }, 44100),
        converted: await measure({ start: 7, duration: 250, sourceIn: 1.3 }, 48000),
        reversed: await measure({ start: 3, duration: 260, reverse: true }, 48000),
        // From here the decode begins on a packet whose time lies half-way between two samples:
        // the times of the buffers that follow are rounded up or down as it happens.
        between: await measure({ start: 2, duration: 190, sourceIn: 0.2 }, 44100),
        betweenConverted: await measure({ start: 2, duration: 190, sourceIn: 0.2 }, 48000),
      };

      // A clip that plays backwards has its sound decoded in one go and kept until played. This
      // one plays its file from 9.2 s down to 0.2 s. A stretch of it is rendered in chunks, as an
      // export would, and what those ask of the decoder is noted.
      const backwards = kit.project(
        160,
        90,
        [sweep],
        [{ type: 'audio', assetId: 'sweep', start: 0, duration: 270, sourceIn: 0.2, reverse: true }],
        { sampleRate: 44100 },
      );
      const sink = engine.AudioBufferSink.prototype;
      const buffers = sink.buffers;
      const inChunks = async (chunks: [number, number][]) => {
        const [start] = chunks[0];
        const end = chunks[chunks.length - 1][0] + chunks[chunks.length - 1][1];
        const render = async (from: number, seconds: number, runs?: unknown): Promise<Float32Array> =>
          (
            await engine.renderAudioChunk(
              backwards,
              lab.library,
              from,
              seconds,
              44100,
              undefined,
              undefined,
              runs,
            )
          ).getChannelData(0);
        const whole = await render(start, end - start);
        const asked: number[][] = [];
        sink.buffers = function (from: number, to: number) {
          asked.push([Number(from.toFixed(2)), Number(to.toFixed(2))]);
          return buffers.call(this, from, to);
        };
        const runs = new engine.AudioRuns(end);
        const joined = new Float32Array(whole.length);
        for (const [from, seconds] of chunks)
          joined.set(await render(from, seconds, runs), Math.round((from - start) * 44100));
        runs.dispose();
        sink.buffers = buffers;
        return { asked, apart: apart(joined, whole, whole.length) };
      };
      const part = {
        range: await inChunks([
          [4, 1],
          [5, 1],
        ]),
        playedOut: await inChunks([
          [6, 3.3],
          [9.3, 0.7],
        ]),
      };
      return { ...measured, part };
    });
    for (const name of ['native', 'converted', 'reversed', 'between', 'betweenConverted'] as const) {
      const m = r[name];
      // In chunks or in one go: the same sound, with nothing at the seams that is not in the sweep.
      expect(m.apart, name).toBeLessThan(1e-6);
      expect(m.sweep, name).toBeLessThan(0.02);
      expect(m.seams, name).toBeLessThan(m.sweep * 1.001);
      // Nor anywhere else: a sample missing or played twice where two buffers meet bends the
      // sweep thirty times as much as its highest note does.
      expect(m.rough, name).toBeLessThan(0.02);
      expect(m.exported.seconds, name).toBeGreaterThan(6);
      expect(m.exported.apart, name).toBeLessThan(1e-4);
      expect(m.exported.seams, name).toBeLessThan(m.sweep * 1.02);
    }
    // Of a clip that plays backwards, a render of the seconds from 4 to 6 decodes what those play
    // and no more, in one pass for both chunks.
    expect(r.part.range.asked).toEqual([[3.2, 5.7]]);
    expect(r.part.range.apart).toBeLessThan(1e-6);
    // The chunk in which the clip plays out lets its sound go: the next one, which has the clip's
    // last 0.2 s in its pre-roll, decodes those for itself.
    expect(r.part.playedOut.asked).toEqual([
      [0.2, 3.7],
      [0.2, 0.4],
    ]);
    expect(r.part.playedOut.apart).toBeLessThan(1e-6);
  });

  test('a preview schedules converted sound from several clips ahead of time, on whole samples and without a gap', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      // Multiples of 100 Hz, so that a whole number of periods of each fits the stretch analysed.
      const tones = [300, 500, 1100, 2300];
      const assets = [];
      for (const hz of tones) {
        const x = kit.sine(hz, 44100, 8, 0.1);
        assets.push(
          await lab.addFile(`v${hz}`, URL.createObjectURL(kit.floatWav([x, x], 44100)), `v${hz}.wav`),
        );
      }
      const tracks = tones.map((_, i) => core.makeTrack('audio', i));
      const project = core.applyEdits(core.emptyProject({ width: 160, height: 90, sampleRate: 48000 }), [
        ...tracks.map((track: any) => ({ op: 'addTrack', track })),
        ...assets.map((asset) => ({ op: 'addAsset', asset })),
        ...tones.map((hz, i) => ({
          op: 'addClip',
          clip: core.makeClip('audio', tracks[i].id, { assetId: `v${hz}`, start: 0, duration: 230 }),
        })),
      ]);
      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      // What the mixer hands to the browser, and when: every buffer source it starts. Such a
      // buffer, at the context's rate and started on a whole sample, is played as it is: from its
      // first sample, to an end that lies within its last one.
      const started: { at: number; lead: number; samples: Float32Array; rate: number; whole: boolean }[] = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when = 0, offset?: number, duration?: number) {
        const { length, sampleRate } = this.buffer!;
        started.push({
          at: when * 48000,
          lead: when - ctx.currentTime,
          samples: this.buffer!.getChannelData(0),
          rate: sampleRate * this.playbackRate.value,
          whole:
            (offset ?? 0) === 0 &&
            (duration === undefined || Math.ceil(duration * sampleRate - 1e-6) === length),
        });
        return start.call(this, when, offset, duration);
      };
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      const t0 = ctx.currentTime + 0.3;
      graph.start(project, { startSec: 0.25, t0, rate: 1, endSec: 7 });
      const pump = setInterval(() => void graph.pump(), 200);
      void graph.pump();
      // Three seconds from half a second in, on the context's own sample count.
      const from = Math.round((t0 + 0.5) * 48000);
      const mix = new Float32Array(144000);
      while (ctx.currentTime * 48000 < from + mix.length) await new Promise((res) => setTimeout(res, 100));
      clearInterval(pump);
      graph.dispose();
      await ctx.close();
      AudioBufferSourceNode.prototype.start = start;

      for (const { at, samples } of started) {
        const first = Math.round(at);
        for (let i = Math.max(0, from - first); i < samples.length && first + i - from < mix.length; i++)
          mix[first + i - from] += samples[i];
      }
      const levels = [];
      for (const hz of tones) {
        levels.push(kit.purity(mix, hz, 48000, 0.1, 0, mix.length).gain);
        // Take the tone out, so that what is left in the end is what should not be there.
        let [ys, yc] = [0, 0];
        for (let i = 0; i < mix.length; i++) {
          const w = (2 * Math.PI * hz * i) / 48000;
          ys += mix[i] * Math.sin(w);
          yc += mix[i] * Math.cos(w);
        }
        for (let i = 0; i < mix.length; i++) {
          const w = (2 * Math.PI * hz * i) / 48000;
          mix[i] -= (ys * Math.sin(w) + yc * Math.cos(w)) / (mix.length / 2);
        }
      }
      let rest = 0;
      for (let i = 0; i < mix.length; i++) rest = Math.max(rest, Math.abs(mix[i]));
      return {
        buffers: started.length,
        converted: started.every((b) => b.rate === 48000 && b.whole),
        offGrid: started.filter((b) => Math.abs(b.at - Math.round(b.at)) > 1e-6).length,
        // In the stretch analysed; the very first buffers of a voice may have to catch up.
        late: started.filter((b) => b.at >= from && b.lead < 0).length,
        levels,
        rest: 20 * Math.log10(rest / 0.1 + 1e-30),
      };
    });
    expect(r.buffers).toBeGreaterThan(200);
    expect(r.converted).toBe(true);
    expect(r.offGrid).toBe(0);
    expect(r.late).toBe(0);
    for (const db of r.levels) expect(Math.abs(db)).toBeLessThan(0.1);
    // The largest sample that is not one of the four tones, against one tone: a gap, an overlap or
    // a click where two buffers meet would be thousands of times this.
    expect(r.rest).toBeLessThan(-80);
  });

  test('a preview keeps up with clips sped up a hundred times by not converting them; an export converts them', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      // A hundred times faster, 20 Hz is heard as 2 kHz, and 300 Hz would be 30 kHz: more than a
      // 48 kHz mix can hold. Read without a filter it turns up at 18 kHz instead.
      const samples = new Int16Array(48000 * 140);
      for (let i = 0; i < samples.length; i++)
        samples[i] =
          4000 * (Math.sin((2 * Math.PI * 20 * i) / 48000) + Math.sin((2 * Math.PI * 300 * i) / 48000));
      const asset = await lab.addFile('long', URL.createObjectURL(kit.wav(samples, 48000)), 'long.wav');
      const tracks = [0, 1, 2].map((i) => core.makeTrack('audio', i));
      const project = core.applyEdits(core.emptyProject({ width: 160, height: 90, sampleRate: 48000 }), [
        ...tracks.map((track: any) => ({ op: 'addTrack', track })),
        { op: 'addAsset', asset },
        ...tracks.map((track: any) => ({
          op: 'addClip',
          clip: core.makeClip('audio', track.id, { assetId: 'long', start: 0, duration: 40, speed: 100 }),
        })),
      ]);

      const ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.resume();
      // Every stretch of sound the mixer hands to the browser: where it starts and how long it
      // plays, in samples of the context, and how fast it is read.
      const started: { at: number; length: number; speed: number }[] = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when = 0, offset?: number, duration?: number) {
        const speed = this.playbackRate.value;
        started.push({
          at: when * 48000,
          length: ((duration ?? this.buffer!.duration) / speed) * 48000,
          speed,
        });
        return start.call(this, when, offset, duration);
      };
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      const t0 = ctx.currentTime + 0.3;
      graph.start(project, { startSec: 0, t0, rate: 1, endSec: 1.3 });
      const pump = setInterval(() => void graph.pump(), 200);
      void graph.pump();
      // How much of 0.8 s, from 0.4 s in, the three clips were given sound for.
      const from = (t0 + 0.4) * 48000;
      const to = from + 38400;
      while (ctx.currentTime * 48000 < to) await new Promise((res) => setTimeout(res, 100));
      clearInterval(pump);
      graph.dispose();
      await ctx.close();
      AudioBufferSourceNode.prototype.start = start;
      let covered = 0;
      for (const b of started) covered += Math.max(0, Math.min(to, b.at + b.length) - Math.max(from, b.at));

      const out = (await engine.renderAudioChunk(project, lab.library, 0.5, 0.25, 48000)).getChannelData(0);
      return {
        speeds: Array.from(new Set(started.map((b) => b.speed))),
        covered: covered / (tracks.length * (to - from)),
        // The three clips play the same sound.
        exported: kit.purity(out, 2000, 48000, (tracks.length * 4000) / 32768, 0, out.length),
      };
    });
    // Converted as well, three such clips take a preview's mixer about as long as they play or
    // longer, and what it has not scheduled in time is not heard.
    expect(r.speeds).toEqual([100]);
    expect(r.covered).toBeGreaterThan(0.9);
    expect(r.covered).toBeLessThan(1.001);
    // An export takes that time: the tone at its level, and nothing folded down from above the band.
    expect(Math.abs(r.exported.gain)).toBeLessThan(0.1);
    expect(r.exported.rest).toBeLessThan(-70);
  });

  test('an export releases each decoder as soon as its clip has left the picture', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      const vid = await lab.addFile('vid', '/fixtures/testsrc.webm', 'testsrc.webm');
      const clips = [];
      for (let i = 0; i < 14; i++)
        clips.push({
          assetId: 'vid',
          start: i * 8,
          duration: 8,
          sourceIn: (i % 5) * 0.5,
          transIn: i === 7 ? core.makeTransition('crossDissolve', 4) : null,
        });
      const project = kit.project(160, 90, [vid], clips);
      const peak = { decoders: 0, frames: 0, calls: 0 };
      const manager = engine.SourceManager.prototype;
      const release = manager.releaseUnused;
      manager.releaseUnused = function () {
        release.call(this);
        const s = this.stats();
        peak.calls++;
        peak.decoders = Math.max(peak.decoders, s.decoders);
        peak.frames = Math.max(peak.frames, s.frames);
      };
      const out = await lab.exportBase64(project, {
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
      manager.releaseUnused = release;
      return { frames: out.frames, warnings: out.warnings, peak };
    });
    expect(r.frames).toBe(112);
    expect(r.warnings).toEqual([]);
    expect(r.peak.calls).toBe(112);
    // One clip on screen, two during the dissolve; never the clips the export has passed.
    expect(r.peak.decoders).toBeLessThanOrEqual(2);
    expect(r.peak.frames).toBeLessThanOrEqual(12);
  });

  test('the pieces of a take cut where it lies are decoded as one: frame by frame, in an export and playing', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      // 180 frames behind a single keyframe: a decoder started anywhere has to come all the way.
      const vid = await lab.addFile('vid', '/fixtures/long-gop.webm', 'long-gop.webm');
      const twin = await lab.addFile('twin', '/fixtures/long-gop.webm', 'long-gop.webm');
      const whole = kit.project(160, 90, [vid], [{ assetId: 'vid', start: 0, duration: 180 }]);
      const pieces = [];
      for (let s = 0; s < 180; s += 15)
        pieces.push({ assetId: 'vid', start: s, duration: 15, sourceIn: s / 30 });
      const cut = kit.project(160, 90, [vid], pieces);
      const decoded = { chunks: 0 };
      const decoder = VideoDecoder.prototype;
      const decode = decoder.decode;
      decoder.decode = function (chunk: EncodedVideoChunk) {
        decoded.chunks++;
        return decode.call(this, chunk);
      };
      const reset = () => {
        kit.decoders.started = 0;
        decoded.chunks = 0;
      };
      const count = () => ({ started: kit.decoders.started, chunks: decoded.chunks });
      const want: number[] = [];
      for (let f = 0; f < 180; f++) want.push(kit.hash((await lab.renderFrame(whole, f)).pixels));

      // Frame by frame over every cut, then back over the last few.
      lab.init(160, 90);
      reset();
      let exact = 0;
      for (let f = 0; f < 180; f++) if (kit.hash((await lab.renderFrame(cut, f)).pixels) === want[f]) exact++;
      const forwards = { ...count(), decoders: lab.sources.stats().decoders };
      let back = 0;
      for (let f = 178; f >= 140; f--)
        if (kit.hash((await lab.renderFrame(cut, f)).pixels) === want[f]) back++;
      const backwards = lab.sources.stats().decoders;

      // The same take played backwards, whole and in pieces: the runs decoded behind the playhead
      // carry on over the cuts as they do within a clip.
      const turned = async (clips: object[]) => {
        lab.init(160, 90);
        reset();
        const project = kit.project(160, 90, [vid], clips);
        let shown = 0;
        for (let f = 0; f < 180; f++)
          if (kit.hash((await lab.renderFrame(project, f)).pixels) === want[179 - f]) shown++;
        return { shown, started: count().started, decoders: lab.sources.stats().decoders };
      };
      const reversed = {
        whole: await turned([{ assetId: 'vid', start: 0, duration: 180, reverse: true }]),
        cut: await turned(pieces.map((p) => ({ ...p, sourceIn: (165 - p.start) / 30, reverse: true }))),
      };

      // Two pieces that dissolve into each other are both in the picture: each keeps its own.
      const dissolve = (second: string) =>
        kit.project(
          160,
          90,
          [vid, twin],
          [
            { assetId: 'vid', start: 0, duration: 30 },
            {
              assetId: second,
              start: 30,
              duration: 30,
              sourceIn: 1.1,
              transIn: core.makeTransition('crossDissolve', 10),
            },
          ],
        );
      const apart: number[] = [];
      lab.init(160, 90);
      for (let f = 20; f < 40; f++) apart.push(kit.hash((await lab.renderFrame(dissolve('twin'), f)).pixels));
      lab.init(160, 90);
      reset();
      let same = 0;
      const one = dissolve('vid');
      for (let f = 20; f < 40; f++)
        if (kit.hash((await lab.renderFrame(one, f)).pixels) === apart[f - 20]) same++;
      const dissolved = count().started;

      // Only the export's own decoders are to be counted next, and every frame it draws is looked at.
      lab.init(160, 90);
      await new Promise((res) => setTimeout(res, 200));
      reset();
      const drawn: number[] = [];
      const compositor = engine.Compositor.prototype;
      const render = compositor.render;
      compositor.render = function (...args: unknown[]) {
        const stats = render.apply(this, args);
        drawn.push(kit.hash(this.readPixels()));
        return stats;
      };
      const out = await lab.exportBase64(cut, {
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
      const exported = {
        ...count(),
        frames: out.frames,
        warnings: out.warnings,
        exact: drawn.filter((h, f) => h === want[f]).length,
      };

      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const player = new engine.Player(canvas, cut, lab.resolver);
      player.setQuality(1);
      player.seek(20);
      const settled = performance.now() + 10_000;
      while (performance.now() < settled && player.sources.stats().frames < 5)
        await new Promise((res) => setTimeout(res, 50));
      reset();
      let peak = 0;
      const off = player.onFrame(() => {
        peak = Math.max(peak, player.sources.stats().decoders);
      });
      player.play();
      const until = performance.now() + 20_000;
      while (performance.now() < until && player.getFrame() < 100)
        await new Promise((res) => requestAnimationFrame(res));
      player.pause();
      off();
      const playing = { ...count(), peak, played: player.getFrame() - 20, dropped: player.stats.dropped };
      player.dispose();
      canvas.remove();
      decoder.decode = decode;
      return {
        distinct: new Set(want).size,
        exact,
        forwards,
        back,
        backwards,
        reversed,
        same,
        dissolved,
        exported,
        playing,
      };
    });
    expect(r.distinct).toBe(180);
    // Every frame is the one the uncut take shows there, from one decoder that never starts over.
    expect(r.exact).toBe(180);
    expect(r.forwards).toEqual({ started: 1, chunks: 180, decoders: 1 });
    expect(r.back).toBe(39);
    expect(r.backwards).toBe(1);
    expect(r.reversed.whole).toMatchObject({ shown: 180, decoders: 1 });
    expect(r.reversed.cut).toMatchObject({ shown: 180, decoders: 1 });
    // A run is started every three quarters of a second either way, not one more for every piece.
    expect(r.reversed.cut.started).toBeLessThanOrEqual(r.reversed.whole.started + 1);
    expect(r.same).toBe(20);
    expect(r.dissolved).toBe(2);
    expect(r.exported).toEqual({ started: 1, chunks: 180, frames: 180, warnings: [], exact: 180 });
    // Playing on from a frame that is already up: nothing is started, at the cuts or before them,
    // and what is decoded is what is shown plus the few frames kept ahead.
    expect(r.playing.played).toBeGreaterThanOrEqual(80);
    expect(r.playing.started).toBe(0);
    expect(r.playing.peak).toBe(1);
    expect(r.playing.chunks).toBeLessThanOrEqual(r.playing.played + 12);
  });

  test('a decoder that broke on a damaged spot stays with its clip: the next clip of the file gets its own', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core, engine } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      // The second clip follows the first at once and plays a later part of the same file.
      const project = kit.project(
        320,
        180,
        [vid],
        [
          { assetId: 'vid', start: 0, duration: 30 },
          { assetId: 'vid', start: 30, duration: 30, sourceIn: 2 },
        ],
      );
      const first = (Object.values(project.clips) as any[]).find((clip) => clip.start === 0).id;
      const want: number[] = [];
      for (let f = 0; f < 60; f++) want.push(kit.hash((await lab.renderFrame(project, f)).pixels));

      // Damage half a second into the file: no decoder gets past it. One that starts behind it
      // never meets it.
      const sink = engine.VideoSampleSink.prototype;
      const samples = sink.samples;
      sink.samples = function (...args: unknown[]) {
        const inner = samples.apply(this, args);
        return (async function* () {
          for await (const sample of inner) {
            if (sample.timestamp >= 0.5 && sample.timestamp < 0.6) {
              sample.close();
              throw new Error('bad data');
            }
            yield sample;
          }
        })();
      };

      // The way an export goes through the frames.
      lab.init(320, 180);
      lab.sources.sequential = true;
      const exact = { first: 0, second: 0 };
      const blamed = new Set<string>();
      for (let f = 0; f < 60; f++) {
        const desc = core.resolveFrame(project, f);
        for (const problem of await lab.sources.prepare(project, desc, true))
          blamed.add(`${problem.clipId === first ? 'first' : 'second'}: ${problem.reason}`);
        lab.compositor.render(project, desc, lab.sources, {});
        if (kit.hash(lab.compositor.readPixels()) === want[f]) exact[f < 30 ? 'first' : 'second']++;
        lab.sources.releaseUnused();
        lab.sources.collect();
      }
      const out = await lab.exportBase64(project, {
        container: 'webm',
        videoCodec: 'vp9',
        audioCodec: 'opus',
        width: 320,
        height: 180,
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

      // A viewer at rest steps into the damage, where the picture holds, and then goes on to the
      // second clip while the first one's decoder is still among those kept.
      lab.init(320, 180);
      const shows = (f: number) => () => kit.hash(lab.compositor.readPixels()) === want[f];
      for (const f of [10, 11, 12, 13, 14]) await kit.view(project, f, 3000, shows(f));
      await kit.view(project, 16, 3000, shows(14));
      const held = shows(14)();
      kit.decoders.started = 0;
      await kit.view(project, 45, 5000, shows(45));
      const paused = { held, second: shows(45)(), started: kit.decoders.started };
      sink.samples = samples;
      return {
        exact,
        blamed: Array.from(blamed),
        warned: out.warnings.map((w: any) => `${w.clipId === first ? 'first' : 'second'}: ${w.reason}`),
        paused,
      };
    });
    // The first clip up to the damage, and every frame of the second: only the first is reported.
    expect(r.exact).toEqual({ first: 15, second: 30 });
    expect(r.blamed).toEqual(['first: decode-error']);
    expect(r.warned).toEqual(['first: decode-error']);
    expect(r.paused).toEqual({ held: true, second: true, started: 1 });
  });

  test('a scrub over many clips keeps a few decoders, and a viewer at rest only the one it shows', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.webm', 'testsrc.webm');
      // Neighbours show parts of the file far from one another: none can carry on where another is.
      const clips = [];
      for (let k = 0; k < 30; k++)
        clips.push({ assetId: 'vid', start: k * 8, duration: 8, sourceIn: k % 2 ? 3 : 0.2 });
      const project = kit.project(320, 180, [vid], clips);
      const open = { now: 0 };
      const decoder = VideoDecoder.prototype;
      const { configure, close } = decoder;
      decoder.configure = function (config: VideoDecoderConfig) {
        open.now++;
        return configure.call(this, config);
      };
      decoder.close = function () {
        if (this.state !== 'closed') open.now--;
        return close.call(this);
      };
      const want = kit.hash((await lab.renderFrame(project, 239)).pixels);
      lab.init(320, 180);
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const player = new engine.Player(canvas, project, lab.resolver);
      player.setQuality(1);
      const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
      const shows = () => kit.hash(player.compositor.readPixels()) === want;
      await wait(500);
      kit.decoders.started = 0;
      let peak = 0;
      for (let i = 0; i <= 80; i++) {
        player.seek(Math.round((239 * i) / 80));
        await wait(30);
        peak = Math.max(peak, player.sources.stats().decoders);
      }
      const started = kit.decoders.started;
      const until = performance.now() + 20_000;
      while (performance.now() < until && (player.sources.stats().decoders > 1 || !shows())) await wait(200);
      const rest = { ...player.sources.stats(), open: open.now, shows: shows() };
      // Letting decoders go is not a reason to draw the frame again.
      const drawn = player.drawnFrames;
      await wait(1500);
      const redrawn = player.drawnFrames - drawn;
      player.invalidate();
      for (const end = performance.now() + 5000; performance.now() < end && player.drawnFrames === drawn;)
        await wait(20);
      await wait(300);
      const asked = player.drawnFrames - drawn;
      const again = {
        decoders: player.sources.stats().decoders,
        shows: shows(),
        started: kit.decoders.started,
      };
      player.dispose();
      canvas.remove();
      Object.assign(decoder, { configure, close });
      return { peak, started, rest, redrawn, asked, again, drawn };
    });
    // The clip under the playhead and the three before it, however many the scrub has crossed.
    expect(r.started).toBeGreaterThan(8);
    expect(r.peak).toBeLessThanOrEqual(4);
    expect(r.rest.decoders).toBe(1);
    expect(r.rest.open).toBe(1);
    expect(r.rest.frames).toBeLessThanOrEqual(18);
    expect(r.rest.shows).toBe(true);
    expect(r.drawn).toBeGreaterThan(0);
    expect(r.redrawn).toBe(0);
    // Drawn again on request, the frame at rest still has its decoder and its picture.
    expect(r.asked).toBe(1);
    expect(r.again).toEqual({ decoders: 1, shows: true, started: r.started });
  });

  test('stepping to and fro over a cut while paused starts each clip’s decoder once', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.webm', 'testsrc.webm');
      const project = kit.project(
        320,
        180,
        [vid],
        [
          { assetId: 'vid', start: 0, duration: 8, sourceIn: 0.2 },
          { assetId: 'vid', start: 8, duration: 8, sourceIn: 3 },
        ],
      );
      const want = [
        kit.hash((await lab.renderFrame(project, 7)).pixels),
        kit.hash((await lab.renderFrame(project, 8)).pixels),
      ];
      lab.init(320, 180);
      kit.decoders.started = 0;
      let exact = 0;
      for (const f of [7, 8, 7, 8, 7, 8, 7]) {
        const shows = () => kit.hash(lab.compositor.readPixels()) === want[f - 7];
        await kit.view(project, f, 4000, shows);
        if (shows()) exact++;
      }
      return { exact, started: kit.decoders.started, decoders: lab.sources.stats().decoders };
    });
    expect(r.exact).toBe(7);
    expect(r.started).toBe(2);
    expect(r.decoders).toBe(2);
  });

  test('an export names the clips whose media is missing or will not open, and a pre-flight finds them first', async ({
    page,
  }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { engine } = lab;
      const vid = await lab.addFile('vid', '/fixtures/testsrc.webm', 'testsrc.webm');
      const gone = await lab.addFile('gone', '/fixtures/testsrc.mp4', 'holiday.mp4');
      const lut = await lab.addFile('lut', '/fixtures/warm.cube', 'warm.cube');
      const bad = await lab.addFile('bad', '/fixtures/testsrc.mp4', 'damaged.mp4');
      lab.files.delete('gone');
      lab.files.delete('lut');
      // On this device, but no longer media: a damaged or truncated file.
      lab.files.set('bad', new Blob(['not a video file at all'.repeat(50)], { type: 'video/mp4' }));
      const settings = {
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
        includeAudio: true,
        dynamicRange: 'sdr',
        keyFrameInterval: 1,
        hardwareAcceleration: 'no-preference',
      };
      const broken = kit.project(
        160,
        90,
        [vid, gone, lut, bad],
        [
          { assetId: 'vid', start: 0, duration: 12, grade: { ...lab.core.DEFAULT_GRADE, lutId: 'lut' } },
          { assetId: 'gone', start: 12, duration: 12 },
          { assetId: 'bad', start: 24, duration: 12 },
          { type: 'audio', assetId: 'vid', start: 0, duration: 12 },
          { type: 'audio', assetId: 'gone', start: 12, duration: 12 },
          { type: 'audio', assetId: 'bad', start: 24, duration: 12 },
        ],
      );
      const clean = kit.project(
        160,
        90,
        [vid],
        [
          { assetId: 'vid', start: 0, duration: 12 },
          { type: 'audio', assetId: 'vid', start: 0, duration: 12 },
        ],
      );
      const brief = (list: any[]) => list.map((w) => `${w.part}:${w.reason}@${w.frame}:${w.assetId}`).sort();
      const preflight = await engine.checkExportMedia(broken, lab.resolver, settings);
      const out = await lab.exportBase64(broken, settings);
      const ok = await lab.exportBase64(clean, settings);

      // A viewer resting on the damaged clip: its file is opened once, not time and again.
      lab.init(160, 90);
      let opened = 0;
      const get = lab.files.get.bind(lab.files);
      lab.files.get = (id: string) => {
        if (id === 'bad') opened++;
        return get(id);
      };
      const draws = await kit.view(broken, 30, 4500);
      delete lab.files.get;
      return {
        opened,
        draws,
        preflight: brief(preflight),
        warnings: brief(out.warnings),
        reported: brief(out.reported),
        messages: out.warnings.map((w: any) => w.message),
        clipsKnown: out.warnings.every((w: any) => !!broken.clips[w.clipId]),
        frames: out.frames,
        seconds: out.seconds,
        cleanPreflight: await engine.checkExportMedia(clean, lab.resolver, settings),
        cleanWarnings: ok.warnings,
        videoOnly: brief(
          await engine.checkExportMedia(broken, lab.resolver, { ...settings, includeAudio: false }),
        ),
        firstHalf: brief(
          await engine.checkExportMedia(broken, lab.resolver, { ...settings, range: { in: 0, out: 12 } }),
        ),
      };
    });
    const expected = [
      'audio:missing@12:gone',
      'audio:unreadable@24:bad',
      'lut:missing@0:lut',
      'video:missing@12:gone',
      'video:unreadable@24:bad',
    ];
    // The pre-flight gives each file the reason the export then reports for it.
    expect(r.preflight).toEqual(expected);
    expect(r.warnings).toEqual(expected);
    expect(r.reported).toEqual(expected);
    expect(r.clipsKnown).toBe(true);
    expect(r.messages.filter((m: string) => m.includes('“holiday.mp4” is not on this device'))).toHaveLength(
      2,
    );
    expect(r.messages.filter((m: string) => m.includes('“damaged.mp4” could not be opened'))).toHaveLength(2);
    expect(r.frames).toBe(36);
    // Missing media is reported, not waited for.
    expect(r.seconds).toBeLessThan(20);
    expect(r.cleanPreflight).toEqual([]);
    expect(r.cleanWarnings).toEqual([]);
    expect(r.videoOnly).toEqual(['lut:missing@0:lut', 'video:missing@12:gone', 'video:unreadable@24:bad']);
    expect(r.firstHalf).toEqual(['lut:missing@0:lut']);
    expect(r.opened).toBe(1);
    expect(r.draws).toBeLessThanOrEqual(2);
  });

  test('stills are held at the size the frame can show and released when over budget', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      lab.init(640, 360);
      const still = async (
        id: string,
        w: number,
        h: number,
        paint: (g: CanvasRenderingContext2D) => void,
      ) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        paint(c.getContext('2d')!);
        const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
        return lab.addFile(id, URL.createObjectURL(blob), `${id}.png`);
      };
      const colours = ['#c81e1e', '#1ec81e', '#1e1ec8', '#c8c81e', '#1ec8c8'];
      const photos = [];
      for (let i = 0; i < colours.length; i++)
        photos.push(
          await still(`photo${i}`, 4000, 3000, (g) => {
            g.fillStyle = colours[i];
            g.fillRect(0, 0, 4000, 3000);
          }),
        );
      // One-pixel stripes: any resampling turns them grey.
      const striped = (id: string, w: number, h: number) =>
        still(id, w, h, (g) => {
          g.fillStyle = '#000';
          g.fillRect(0, 0, w, h);
          g.fillStyle = '#fff';
          for (let x = 0; x < w; x += 2) g.fillRect(x, 0, 1, h);
        });
      const stripes = await striped('stripes', 2000, 1500);
      const wide = await striped('wide', 1920, 1080);
      const project = kit.project(
        640,
        360,
        [...photos, stripes, wide],
        [
          ...photos.map((p: any, i: number) => ({
            type: 'image',
            assetId: p.id,
            start: i * 10,
            duration: 10,
          })),
          { type: 'image', assetId: 'stripes', start: 50, duration: 10 },
          { type: 'image', assetId: 'stripes', start: 60, duration: 10, fit: 'none' },
          { type: 'image', assetId: 'wide', start: 70, duration: 10 },
        ],
      );
      // What an export or the viewer does for every frame.
      const draw = async (frame: number) => {
        const f = await lab.renderFrame(project, frame);
        lab.sources.collect();
        return f;
      };
      const centre = async (frame: number) =>
        lab.sample((await draw(frame)).pixels, 640, 318, 178).slice(0, 3);
      const first = [];
      for (let i = 0; i < 5; i++) first.push(await centre(i * 10 + 2));
      const fitted = lab.sources.stats();

      // Fitted into the frame the stripes are too fine to show; at their own size every one counts.
      await centre(52);
      const small = lab.sources.stats().stillBytes - fitted.stillBytes;
      const f = await draw(62);
      const large = lab.sources.stats().stillBytes - fitted.stillBytes;
      let contrast = 0;
      for (let x = 200; x < 440; x += 2)
        contrast += Math.abs(f.pixels[(180 * 640 + x) * 4] - f.pixels[(180 * 640 + x + 1) * 4]) / 120;

      lab.sources.stillBudget = 16 * 1024 * 1024;
      const again = [];
      const held = [];
      for (let i = 0; i < 5; i++) {
        again.push(await centre(i * 10 + 2));
        held.push(lab.sources.stats());
      }

      // Drawn three times the size of the project, as a 1080p export of this timeline is, a still
      // fills three times as many pixels and has to bring the detail for them.
      lab.init(1920, 1080);
      const big = await lab.renderFrame(project, 72);
      const scaled = lab.sources.stats().stillBytes;
      let fine = 0;
      for (let x = 400; x < 1500; x += 2)
        fine += Math.abs(big.pixels[(540 * 1920 + x) * 4] - big.pixels[(540 * 1920 + x + 1) * 4]) / 550;
      // The export says how large it draws before its first frame, not after it.
      const exporting: number[] = [];
      const manager = lab.engine.SourceManager.prototype;
      const release = manager.releaseUnused;
      manager.releaseUnused = function () {
        release.call(this);
        exporting.push(this.stats().stillBytes);
      };
      await lab.exportBase64(project, {
        container: 'webm',
        videoCodec: 'vp9',
        audioCodec: 'opus',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
        videoBitrate: 2_000_000,
        audioBitrate: 96_000,
        range: { in: 72, out: 74 },
        includeVideo: true,
        includeAudio: false,
        dynamicRange: 'sdr',
        keyFrameInterval: 1,
        hardwareAcceleration: 'no-preference',
      });
      manager.releaseUnused = release;
      return { first, again, fitted, small, large, contrast, held, scaled, fine, exporting };
    });
    const colours = [
      [200, 30, 30],
      [30, 200, 30],
      [30, 30, 200],
      [200, 200, 30],
      [30, 200, 200],
    ];
    const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
    r.first.forEach((c: number[], i: number) => expect(close(c, colours[i])).toBe(true));
    // 12-megapixel photos (48 MB each at full size) on a 640x360 timeline.
    expect(r.fitted.stills).toBe(5);
    expect(r.fitted.stillBytes).toBeLessThan(5 * 8 * 1024 * 1024);
    // The same file is sharpened when a clip shows it larger, and then resolves single pixels.
    expect(r.small).toBeLessThan(2000 * 1500 * 4 * 0.6);
    expect(r.large).toBe(2000 * 1500 * 4);
    expect(r.contrast).toBeGreaterThan(200);
    // Over budget, the stills drawn longest ago go; whatever is needed comes back.
    r.again.forEach((c: number[], i: number) => expect(close(c, colours[i])).toBe(true));
    for (const s of r.held) {
      expect(s.stillBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(s.stills).toBeLessThanOrEqual(2);
    }
    // Rendered larger than the project, a still is held at the size that render can show.
    expect(r.scaled).toBe(1920 * 1080 * 4);
    expect(r.fine).toBeGreaterThan(200);
    expect(r.exporting).toEqual([1920 * 1080 * 4, 1920 * 1080 * 4]);
  });

  test('a web font that cannot be fetched is asked for once, not on every frame', async ({ page }) => {
    await openMediaLab(page);
    let requests = 0;
    await page.route('**/fixtures/no-such-font.woff2', (route) => {
      requests++;
      return route.fulfill({ status: 404, body: '' });
    });
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core } = lab;
      lab.init(320, 180);
      document.fonts.add(new FontFace('Unreachable', 'url(/fixtures/no-such-font.woff2)'));
      const project = kit.project(
        320,
        180,
        [],
        [
          {
            type: 'text',
            start: 0,
            duration: 30,
            fit: 'none',
            text: { ...core.DEFAULT_TEXT, content: 'Offline', font: 'Unreachable', size: 0.3 },
          },
        ],
      );
      const settling = await kit.view(project, 3, 1500);
      const idle = await kit.view(project, 3, 1500);
      const t0 = performance.now();
      const f = await lab.renderFrame(project, 3);
      const exactMs = performance.now() - t0;
      let lit = 0;
      for (let i = 0; i < f.pixels.length; i += 4) if (f.pixels[i] > 200) lit++;
      return { settling, idle, exactMs, lit };
    });
    expect(requests).toBeGreaterThanOrEqual(1);
    // `view` draws once on entry; nothing may ask for another draw after that.
    expect(r.idle).toBe(1);
    expect(r.settling).toBeLessThanOrEqual(4);
    expect(r.exactMs).toBeLessThan(2000);
    expect(r.lit).toBeGreaterThan(500); // drawn in the fallback face
  });

  test('a video texture gets new mipmaps only when it gets new pixels', async ({ page }) => {
    await openMediaLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit } = window as any;
      const { core } = lab;
      lab.init(320, 180);
      // 1600x1200 drawn at a fifth of its size: the mipmapped path.
      const vid = await lab.addFile('big', '/fixtures/large.mp4', 'large.mp4');
      const project = kit.project(320, 180, [vid], [{ assetId: 'big', start: 0, duration: 25 }]);
      const gl = lab.compositor.gl;
      let built = 0;
      const generate = gl.generateMipmap.bind(gl);
      gl.generateMipmap = (target: number) => {
        built++;
        generate(target);
      };
      const layer = (frame: number) => core.resolveFrame(project, frame).layers[0].layer;
      await lab.renderFrame(project, 3);
      const first = built;
      const v1 = lab.sources.getTexture(layer(3), project, 320, 180).version;
      // A paused viewer redraws the same frame for all sorts of reasons.
      for (let i = 0; i < 5; i++) await lab.renderFrame(project, 3);
      const redrawn = built;
      const v2 = lab.sources.getTexture(layer(3), project, 320, 180).version;
      await lab.renderFrame(project, 4);
      const next = built;
      const v3 = lab.sources.getTexture(layer(4), project, 320, 180).version;
      return { first, redrawn, next, v1, v2, v3 };
    });
    expect(r.first).toBe(1);
    expect(r.redrawn).toBe(1);
    expect(r.next).toBe(2);
    expect(r.v2).toBe(r.v1);
    expect(r.v3).toBeGreaterThan(r.v2);
  });

  test('the poster of a picture many times taller than wide is one a project can carry', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      // Noise is the worst a JPEG can be given: no two neighbouring pixels alike.
      const poster = async (id: string, w: number, h: number) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d')!;
        const image = g.createImageData(w, h);
        for (let i = 0; i < image.data.length; i++) image.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;
        g.putImageData(image, 0, 0);
        const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
        const asset = await lab.addFile(id, URL.createObjectURL(blob), `${id}.png`);
        const picture = new Image();
        picture.src = asset.thumb;
        await picture.decode();
        return {
          picture: [asset.width, asset.height],
          poster: [picture.naturalWidth, picture.naturalHeight],
          length: asset.thumb.length,
          jpeg: asset.thumb.startsWith('data:image/jpeg;base64,'),
        };
      };
      return {
        most: lab.core.MAX_THUMB_LENGTH,
        sixfold: await poster('sixfold', 400, 2400),
        fourfold: await poster('fourfold', 320, 1280),
        // Already the size of its poster, so none of its noise is averaged away on the way down.
        worst: await poster('worst', 174, 1044),
        portrait: await poster('portrait', 720, 1280),
        frame: await poster('frame', 1280, 720),
        small: await poster('small', 100, 300),
      };
    });
    expect(r.most).toBe(256 * 1024);
    // As many pixels as a portrait frame gets, in the picture's own proportions.
    expect(r.sixfold).toMatchObject({ picture: [400, 2400], poster: [174, 1045], jpeg: true });
    expect(r.fourfold.poster).toEqual([213, 853]);
    expect(r.worst.poster).toEqual([174, 1044]);
    for (const tall of [r.sixfold, r.fourfold, r.worst]) expect(tall.length).toBeLessThan(r.most);
    // Pictures no taller than that keep the poster they had.
    expect(r.portrait.poster).toEqual([320, 569]);
    expect(r.portrait.length).toBeLessThan(r.most);
    expect(r.frame.poster).toEqual([320, 180]);
    expect(r.small.poster).toEqual([100, 300]);
  });

  test('a file is not blamed for its codec on a page that has no decoder at all', async ({
    page,
    context,
  }) => {
    const warnings = (on: Page): Promise<string[]> =>
      on.evaluate(async () => {
        const { lab } = window as any;
        const blob = await (await fetch('/fixtures/testsrc.webm')).blob();
        const probe = await lab.engine.probeFile(new File([blob], 'testsrc.webm', { type: blob.type }));
        return probe.warnings;
      });

    // A browser that has the decoders: nothing to say about a file it can play.
    await openLab(page);
    expect(await warnings(page)).toEqual([]);
    // One whose decoder refuses the picture: that is the codec's doing, and it is named.
    await page.evaluate(() => {
      VideoDecoder.isConfigSupported = async (config) => ({ supported: false, config });
    });
    const refused = await warnings(page);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(
      /^This browser cannot decode the video codec \(vp0?9[\w.]*\) in “testsrc.webm”\.$/,
    );

    // A browser with no video decoder for any page.
    const without = await context.newPage();
    await without.addInitScript(() => {
      delete (window as any).VideoDecoder;
    });
    await openLab(without);
    expect(await warnings(without)).toEqual([
      'This browser has no video decoder for web pages (WebCodecs), so the video in “testsrc.webm” will not play.',
    ]);

    // Plain HTTP from a name that is not localhost: the browser keeps both decoders back.
    const insecure = await context.newPage();
    await insecure.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', { get: () => false });
      delete (window as any).VideoDecoder;
      delete (window as any).AudioDecoder;
    });
    await openLab(insecure);
    expect(await warnings(insecure)).toEqual([
      'The video in “testsrc.webm” will not play: this address is neither HTTPS nor localhost, so the browser has switched off video decoding.',
      'The audio in “testsrc.webm” will not play: this address is neither HTTPS nor localhost, so the browser has switched off audio decoding.',
    ]);
  });
});

/**
 * The media lab with the page's two audio decoders stood in for, as `window.decoders` says.
 *
 * `AudioDecoder`: one that is set up for AAC at `rate` (the file under test: an export sets up a
 * decoder of its own to measure its encoder, and that one is left alone) decodes with the real
 * decoder. It fails on every chunk (`dead`) or on the chunks whose times are in `bad`
 * (microseconds), as a decoder does: after what it was given before has come out. From its output
 * number `after` on it gives twice the samples at twice the rate (`double`) and two channels for
 * one (`stereo`), as the decoder of a stream that does not declare what it decodes to. The bytes
 * of the chunk whose time is `keep` are kept in `kept`.
 *
 * `decodeAudioData`, given what the engine makes of a file for the browser's own decoder (an ADTS
 * stream, or an MP4 file of sound alone): `own: 'refuses'` rejects it; `'adts'` rejects only ADTS,
 * so that AAC goes as MP4; `'unedited'` does that too, and plays an MP4 file without its edit, as
 * a browser does that does not follow edits; `'cuts'` drops the 2112 samples from the front that a
 * browser may take for the priming of Apple's encoder; `'loses'` leaves a packet's worth out of
 * the middle of every stream longer than the engine's test stream, as a browser does with a packet
 * it cannot decode.
 *
 * `window.sound` reads and measures: see the functions.
 */
async function openSoundLab(page: Page): Promise<void> {
  await openMediaLab(page);
  await page.evaluate(() => {
    const { lab, kit } = window as any;
    const { engine } = lab;
    const decoders = {
      rate: 0,
      dead: false,
      bad: [] as number[],
      double: false,
      stereo: false,
      after: 0,
      own: '' as '' | 'refuses' | 'adts' | 'unedited' | 'cuts' | 'loses',
      /** Decoders set up for the file under test. */
      made: 0,
      /** The time of a chunk of the file under test to keep the bytes of, and the bytes. */
      keep: -1,
      kept: null as Uint8Array | null,
    };
    const Real = (window as any).AudioDecoder;
    const changed = (data: AudioData): AudioData => {
      const planes = Array.from({ length: data.numberOfChannels }, (_, c) => {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        if (!decoders.double) return plane;
        // Each sample, and between it and the next their mean; behind the last, which has no
        // next in this buffer, where the line through the last two leads.
        return Float32Array.from({ length: plane.length * 2 }, (_, i) => {
          const k = i >> 1;
          if (i % 2 === 0) return plane[k];
          return k + 1 < plane.length
            ? (plane[k] + plane[k + 1]) / 2
            : plane[k] + (plane[k] - plane[k - 1]) / 2;
        });
      });
      if (decoders.stereo && planes.length === 1) planes.push(planes[0]);
      const frames = planes[0].length;
      const all = new Float32Array(frames * planes.length);
      planes.forEach((plane, c) => all.set(plane, c * frames));
      const out = new AudioData({
        format: 'f32-planar',
        sampleRate: data.sampleRate * (decoders.double ? 2 : 1),
        numberOfFrames: frames,
        numberOfChannels: planes.length,
        timestamp: data.timestamp,
        data: all,
      });
      data.close();
      return out;
    };
    class StandIn {
      private real: any;
      private ours = false;
      private outputs = 0;
      private failing = false;
      private failed = false;
      constructor(private readonly init: { output(d: AudioData): void; error(e: unknown): void }) {
        this.real = new Real({
          output: (data: AudioData) => {
            if (this.failed) return data.close();
            const change =
              this.ours && (decoders.double || decoders.stereo) && this.outputs++ >= decoders.after;
            init.output(change ? changed(data) : data);
          },
          error: (e: unknown) => init.error(e),
        });
      }
      get state() {
        return this.failed ? 'closed' : this.real.state;
      }
      get decodeQueueSize() {
        return this.real.decodeQueueSize;
      }
      configure(config: AudioDecoderConfig) {
        this.ours = config.codec.startsWith('mp4a') && config.sampleRate === decoders.rate;
        if (this.ours) decoders.made++;
        this.real.configure(config);
      }
      decode(chunk: EncodedAudioChunk) {
        if (this.failed) throw new DOMException('The decoder is closed.', 'InvalidStateError');
        if (this.failing) return;
        if (this.ours && chunk.timestamp === decoders.keep) {
          decoders.kept = new Uint8Array(chunk.byteLength);
          chunk.copyTo(decoders.kept);
        }
        if (!this.ours || !(decoders.dead || decoders.bad.includes(chunk.timestamp)))
          return this.real.decode(chunk);
        this.failing = true;
        void this.real
          .flush()
          .catch(() => {})
          .then(() => {
            this.failed = true;
            if (this.real.state !== 'closed') this.real.close();
            this.init.error(new DOMException('Decoding error.', 'EncodingError'));
          });
      }
      flush() {
        return this.failed
          ? Promise.reject(new DOMException('The decoder is closed.', 'InvalidStateError'))
          : this.real.flush();
      }
      close() {
        if (!this.failed) this.real.close();
      }
      addEventListener(...args: unknown[]) {
        this.real.addEventListener(...args);
      }
      static isConfigSupported(config: AudioDecoderConfig) {
        return Real.isConfigSupported(config);
      }
    }
    (window as any).AudioDecoder = StandIn;

    /** What the engine makes of a file for the browser's own decoder, if `bytes` are that. */
    const madeFor = (bytes: Uint8Array): 'adts' | 'mp4' | null => {
      if (bytes[0] === 0xff && bytes[1] === 0xf1) return 'adts';
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const type = (at: number) => String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (bytes.length < 16 || type(0) !== 'ftyp') return null;
      const moov = view.getUint32(0);
      if (type(moov) !== 'moov') return null;
      const header = new TextDecoder('latin1').decode(bytes.subarray(moov, moov + view.getUint32(moov)));
      return header.includes('soun') && !header.includes('vide') ? 'mp4' : null;
    };
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    OfflineAudioContext.prototype.decodeAudioData = function (this: OfflineAudioContext, bytes: ArrayBuffer) {
      const made = decoders.own ? madeFor(new Uint8Array(bytes)) : null;
      if (!made) return decode.call(this, bytes);
      const refused =
        decoders.own === 'refuses' || (made === 'adts' && ['adts', 'unedited'].includes(decoders.own));
      if (refused) return Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError'));
      if (decoders.own === 'adts') return decode.call(this, bytes);
      if (decoders.own === 'unedited') {
        // The edit's box made into one that every reader passes over.
        const all = new Uint8Array(bytes);
        const at = all.findIndex((_, i) => String.fromCharCode(...all.subarray(i, i + 4)) === 'edts');
        all.set([0x66, 0x72, 0x65, 0x65], at);
        return decode.call(this, bytes);
      }
      const long = bytes.byteLength > 1000;
      return decode.call(this, bytes).then((whole) => {
        const [from, to] = decoders.own === 'cuts' ? [0, 2112] : long ? [4096, 5120] : [0, 0];
        const out = new AudioBuffer({
          numberOfChannels: whole.numberOfChannels,
          length: whole.length - (to - from),
          sampleRate: whole.sampleRate,
        });
        for (let c = 0; c < whole.numberOfChannels; c++) {
          const data = whole.getChannelData(c);
          out.copyToChannel(data.subarray(0, from), c);
          out.copyToChannel(data.subarray(to), c, from);
        }
        return out;
      });
    } as typeof decode;

    const sound = {
      /** Forget what the page has learnt about decoding the file, and open it anew. */
      anew(assetId: string) {
        lab.library.invalidate(assetId);
      },
      /** The buffers of `[from, to)` as the mixer gets them: their times, their samples by channel, what was reported. */
      async read(assetId: string, from?: number, to?: number) {
        const media = await lab.library.get(assetId);
        const times: number[] = [];
        const rates = new Set<number>();
        const parts: Float32Array[][] = [];
        const troubles: unknown[] = [];
        for await (const wb of new engine.Sound(assetId, media.audio).buffers(from, to, (t: unknown) =>
          troubles.push(t),
        )) {
          times.push(wb.timestamp);
          rates.add(wb.buffer.sampleRate);
          parts.push(
            Array.from({ length: wb.buffer.numberOfChannels }, (_, c) => wb.buffer.getChannelData(c).slice()),
          );
        }
        const channels = (parts[0] ?? []).map((_, c) => {
          const all = new Float32Array(parts.reduce((n, part) => n + part[c].length, 0));
          let at = 0;
          for (const part of parts) {
            all.set(part[c], at);
            at += part[c].length;
          }
          return all;
        });
        return { times, rates: [...rates], channels, troubles };
      },
      /** The largest difference between two sets of channels, sample for sample, from sample `from` on. */
      apart(a: Float32Array[], b: Float32Array[], from = 0, to = Infinity): number {
        if (a.length !== b.length) return Infinity;
        let most = 0;
        a.forEach((x, c) => {
          if (x.length !== b[c].length) most = Infinity;
          for (let i = from; i < Math.min(x.length, to); i++) most = Math.max(most, Math.abs(x[i] - b[c][i]));
        });
        return most;
      },
      /** A project that plays the file's sound from its start, on a timeline at `rate`, and its picture if asked. */
      project(asset: any, rate: number, frames: number, clip = {}) {
        return kit.project(
          160,
          90,
          [asset],
          [{ type: 'audio', assetId: asset.id, start: 0, duration: frames, ...clip }],
          { sampleRate: rate },
        );
      },
      /** The project's sound rendered in one go: both channels, and what the mixer reported. */
      async render(project: any, seconds: number) {
        const problems: any[] = [];
        const rate = project.settings.sampleRate;
        const out = await engine.renderAudioChunk(
          project,
          lab.library,
          0,
          seconds,
          rate,
          undefined,
          (p: any) => problems.push(p),
        );
        return { channels: [out.getChannelData(0).slice(), out.getChannelData(1).slice()], problems };
      },
      /** The project exported as 16-bit PCM, as an export makes it: in chunks of four seconds. */
      async exported(project: any) {
        const out = await lab.exportBase64(project, {
          container: 'wav',
          videoCodec: 'vp9',
          audioCodec: 'pcm-s16',
          width: 160,
          height: 90,
          fpsNum: 30,
          fpsDen: 1,
          videoBitrate: 300_000,
          audioBitrate: 96_000,
          range: null,
          includeVideo: false,
          includeAudio: true,
          dynamicRange: 'sdr',
          keyFrameInterval: 1,
          hardwareAcceleration: 'no-preference',
        });
        const bytes = Uint8Array.from(atob(out.base64), (c) => c.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        // Two channels of 16 bits behind the header, which ends with "data" and a length.
        let at = 12;
        while (view.getUint32(at) !== 0x64617461) at += 8 + view.getUint32(at + 4, true);
        const frames = view.getUint32(at + 4, true) / 4;
        const channels = [new Float32Array(frames), new Float32Array(frames)];
        for (let i = 0; i < frames; i++)
          for (let c = 0; c < 2; c++) channels[c][i] = view.getInt16(at + 8 + (i * 2 + c) * 2, true) / 32768;
        return { channels, warnings: out.warnings, seconds: out.seconds };
      },
      /** The stretches (seconds, from and to) in which `x` stays under `level`, a hundredth of a second or longer. */
      quiet(x: Float32Array, rate: number, level = 0.02): number[][] {
        const out: number[][] = [];
        let start = -1;
        for (let i = 0; i <= x.length; i++) {
          if (i < x.length && Math.abs(x[i]) < level) {
            if (start < 0) start = i;
          } else if (start >= 0) {
            if (i - start >= rate / 100) out.push([start / rate, i / rate]);
            start = -1;
          }
        }
        return out;
      },
    };
    Object.assign(window, { decoders, sound });
  });
}

/**
 * `stereo-441.mp4` is what a phone or a screen recorder writes: H.264 with stereo AAC-LC at
 * 44.1 kHz, the index behind the media. Six seconds; left a sweep that rises from 300 Hz by 200 Hz
 * a second, right a 440 Hz tone that is silent from 2.5 s to 2.6 s. Made with
 *   ffmpeg -f lavfi -i "testsrc=size=160x90:rate=30:duration=6" -f lavfi -i
 *     "aevalsrc=0.4*sin(2*PI*(300*t+100*t*t))|0.3*sin(2*PI*440*t)*(1-between(t\,2.5\,2.6)):s=44100:d=6"
 *     -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryslow -crf 34 -g 60
 *     -c:a aac -aac_pns 0 -b:a 128k -ar 44100 -ac 2 stereo-441.mp4
 * Without noise substitution (`-aac_pns 0`), as the encoders of phones write it: every decoder
 * then gives the same samples for a packet wherever it began. `testsrc.mp4` (mono, 48 kHz) has
 * bands of noise that a decoder fills with random numbers of its own.
 *
 * `mono-2205.mp4` is AAC-LC at 22.05 kHz in mono, which an ADTS header can describe but which may
 * hide a stream that decodes to twice its rate: the engine gives it to the browser's own decoder
 * as MP4. Six seconds of the same picture; a sweep that rises from 300 Hz by 200 Hz a second,
 * silent from 2.5 s to 2.6 s. Made with
 *   ffmpeg -f lavfi -i "testsrc=size=160x90:rate=30:duration=6" -f lavfi -i
 *     "aevalsrc=0.4*sin(2*PI*(300*t+100*t*t))*(1-between(t\,2.5\,2.6)):s=22050:d=6"
 *     -c:v libx264 -profile:v high -pix_fmt yuv420p -preset veryslow -crf 34 -g 60
 *     -c:a aac -aac_pns 0 -b:a 48k -ar 22050 -ac 1 -movflags +faststart mono-2205.mp4
 */
test.describe('sound that does not decode as it should', () => {
  test('a stream that decodes to another rate and other channels than it declares is heard in its place, at its pitch', async ({
    page,
  }) => {
    await openSoundLab(page);
    const r = await page.evaluate(async () => {
      const { lab, kit, decoders, sound } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const stereo = await lab.addFile('stereo', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      const mono = await lab.addFile('mono', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const heard = async (asset: any, rate: number, change: Record<string, unknown>) => {
        Object.assign(
          decoders,
          { rate: asset.audioSampleRate, double: false, stereo: false, after: 0 },
          change,
        );
        sound.anew(asset.id);
        const out = await sound.render(sound.project(asset, rate, 120), 4);
        return { ...out, problems: out.problems.length };
      };
      const files: Record<string, any> = {};
      for (const rate of [44100, 48000]) {
        const plain = await heard(stereo, rate, {});
        // Twice the rate from the first buffer on, and from the third: a decoder that finds out late.
        const doubled = await heard(stereo, rate, { double: true });
        const late = await heard(stereo, rate, { double: true, after: 2 });
        const right = plain.channels[1];
        files[`stereo at ${rate}`] = {
          problems: plain.problems + doubled.problems + late.problems,
          tone: kit.purity(right, 440, rate, 0.3, Math.round(0.5 * rate), Math.round(2.4 * rate)),
          gap: sound.quiet(right, rate),
          doubled: sound.apart(plain.channels, doubled.channels, 64, 4 * rate - 64),
          late: sound.apart(plain.channels, late.channels, 4096, 4 * rate - 64),
        };
        const one = await heard(mono, rate, {});
        const two = await heard(mono, rate, { stereo: true });
        const both = await heard(mono, rate, { stereo: true, double: true, after: 1 });
        files[`mono at ${rate}`] = {
          problems: one.problems + two.problems + both.problems,
          tone: kit.purity(one.channels[0], 880, rate, 0.125, rate, 3 * rate),
          two: sound.apart(one.channels, two.channels),
          both: sound.apart(one.channels, both.channels, 4096, 4 * rate - 64),
        };
      }

      // What the mixer asks of a file whose sound has to be converted reaches a little beyond what
      // plays, and whether it has to be is decided by the rate it decodes to: after a first
      // buffer has shown that, not by what the file declares.
      const asked: number[] = [];
      const sink = engine.AudioBufferSink.prototype;
      const buffers = sink.buffers;
      sink.buffers = function (...args: number[]) {
        asked.push(args[0]);
        return buffers.apply(this, args);
      };
      Object.assign(decoders, { rate: 44100, double: true, stereo: false, after: 0 });
      sound.anew('stereo');
      const cut = sound.project(stereo, 44100, 60, { sourceIn: 1 });
      await sound.render(cut, 2);
      await sound.render(cut, 2);
      sink.buffers = buffers;
      return {
        files,
        asked,
        rate: new engine.Sound('stereo', (await lab.library.get('stereo')).audio).rate,
      };
    });
    for (const rate of [44100, 48000]) {
      const s = r.files[`stereo at ${rate}`];
      expect(s.problems, `${rate}`).toBe(0);
      // The tone at its pitch and its level, and silent where the file is: to within a millisecond.
      expect(Math.abs(s.tone.gain), `${rate}`).toBeLessThan(0.2);
      expect(s.tone.rest, `${rate}`).toBeLessThan(-30);
      expect(s.gap, `${rate}`).toHaveLength(1);
      expect(Math.abs(s.gap[0][0] - 2.5), `${rate}`).toBeLessThan(0.002);
      expect(Math.abs(s.gap[0][1] - 2.6), `${rate}`).toBeLessThan(0.002);
      // Doubled, the same sound in the same place. One of the doubled samples out would be 0.03
      // at the top of the sweep; putting means between the samples changes it by a tenth of that.
      expect(s.doubled, `${rate}`).toBeLessThan(0.006);
      expect(s.late, `${rate}`).toBeLessThan(0.006);
      const m = r.files[`mono at ${rate}`];
      expect(m.problems, `${rate}`).toBe(0);
      expect(Math.abs(m.tone.gain), `${rate}`).toBeLessThan(0.2);
      // One channel played on both sides is what two equal channels are.
      expect(m.two, `${rate}`).toBeLessThan(1e-6);
      expect(m.both, `${rate}`).toBeLessThan(0.006);
    }
    expect(r.rate).toBe(88200);
    // The first render took the file at its word (44.1 kHz on a 44.1 kHz timeline: nothing to
    // convert) and asked from where the clip begins; the second knew better.
    expect(r.asked).toHaveLength(2);
    expect(r.asked[0]).toBeCloseTo(1, 9);
    expect(r.asked[1]).toBeLessThan(1 - 10 / 88200);
    expect(r.asked[1]).toBeGreaterThan(1 - 0.01);
  });

  test('a packet that will not decode costs the sound around it, not the rest of the clip', async ({
    page,
  }) => {
    await openSoundLab(page);
    const errors = trackErrors(page);
    const warned: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' && m.text().startsWith('[audio]')) warned.push(m.text().split('\n')[0]);
    });
    const r = await page.evaluate(async () => {
      const { lab, decoders, sound } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const asset = await lab.addFile('a', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      const rate = 44100;
      const packet = 1024 / rate;
      // The time of packet `n` as the decoder is given it. The first lies one packet before zero.
      const first = await (await lab.library.get('a')).audio.getFirstTimestamp();
      const at = (n: number) => Math.max(0, Math.trunc((first + n * packet) * 1e6));
      const project = sound.project(asset, rate, 180);
      Object.assign(decoders, { rate, keep: at(100) });
      const clean = await sound.exported(project);
      const exportOf = async (of: unknown) => {
        const out = await sound.exported(of);
        // Where the export is not the clean one, in packets from the start of the file's sound.
        const differs: number[] = [];
        for (let i = 0; i < clean.channels[0].length; i++) {
          if (clean.channels[0][i] === out.channels[0][i] && clean.channels[1][i] === out.channels[1][i])
            continue;
          const n = Math.floor((i / rate - first) / packet);
          if (differs[differs.length - 1] !== n) differs.push(n);
        }
        return {
          differs,
          silent: sound
            .quiet(out.channels[0], rate, 1e-4)
            .map(([a, b]: number[]) => [Math.round((a - first) / packet), Math.round((b - first) / packet)]),
          warnings: out.warnings.map(({ clipId: _, assetId: __, ...w }: any) => w),
          made: decoders.made,
          seconds: out.seconds,
        };
      };

      // A file in which packet 100 really is damaged, and the page's decoder as it is: the bytes
      // the decoder was given for it are found in the file and spoilt there.
      const file = new Uint8Array(await (await fetch('/fixtures/stereo-441.mp4')).arrayBuffer());
      const bytes: Uint8Array = decoders.kept;
      let where = -1;
      for (let i = 0; where < 0 && i + bytes.length <= file.length; i++)
        if (bytes.every((byte, k) => file[i + k] === byte)) where = i;
      for (let k = 4; k < bytes.length; k += 7) file[where + k] ^= 0x5a;
      const damaged = await lab.addFile('damaged', URL.createObjectURL(new Blob([file])), 'damaged.mp4');
      const real = await exportOf(sound.project(damaged, rate, 180));

      // The decoder made to fail, and no other to turn to: what is lost is what the one cannot give.
      Object.assign(decoders, { own: 'refuses' });
      const broken = async (bad: number[], dead = false) => {
        Object.assign(decoders, { bad: bad.map(at), dead, made: 0 });
        sound.anew('a');
        return exportOf(project);
      };
      const one = await broken([60]);
      const run = await broken([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
      const two = await broken([40, 200]);
      const start = await broken([0]);
      const dead = await broken([], true);

      // The same for a preview: its mixer says which clip is silent, from where, and why.
      const ctx = new AudioContext();
      await ctx.resume();
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      const problems: any[] = [];
      graph.onProblem = (p: any) => problems.push(p);
      sound.anew('a');
      graph.start(project, { startSec: 0, t0: ctx.currentTime + 0.05, rate: 1, endSec: 6 });
      void graph.pump();
      const until = performance.now() + 5000;
      while (!problems.length && performance.now() < until) await new Promise((res) => setTimeout(res, 20));
      const level = Math.max(...graph.masterLevels());
      graph.dispose();
      await ctx.close();
      return {
        found: where >= 0,
        real,
        one,
        run,
        two,
        start,
        dead,
        preview: problems.map(({ clipId: _, ...p }) => p),
        level,
      };
    });
    const cause = 'EncodingError: Decoding error.';
    const stretch =
      'A stretch of the audio in “stereo-441.mp4” could not be decoded, so the export is silent there.';
    // The damaged packet costs itself and at most the three behind it, at 2.3 s. Whether this
    // browser's decoder stops at such a packet or makes something of it is its own business: if it
    // stops, that is said once, with what it said.
    expect(r.found).toBe(true);
    expect(r.real.differs[0]).toBe(100);
    expect(r.real.differs.every((n: number) => n >= 100 && n <= 103)).toBe(true);
    expect(r.real.warnings.length).toBeLessThanOrEqual(1);
    for (const warning of r.real.warnings) {
      expect(warning).toMatchObject({
        lost: 'stretch',
        frame: 68,
        message: stretch.replace('stereo-441.mp4', 'damaged.mp4'),
      });
      expect(warning.cause).toMatch(/\S/);
    }
    // Packet 60 and the two a decoder started behind it needs to get going: 70 ms, at 1.37 s.
    expect(r.one.differs).toEqual([60, 61, 62]);
    expect(r.one.silent).toEqual([[60, 63]]);
    expect(r.one.warnings).toEqual([
      { part: 'audio', reason: 'decode-error', lost: 'stretch', frame: 41, message: stretch, cause },
    ]);
    // Ten in a row: the decoder is started further on each time, and is past them at the fourth start.
    expect(r.run.silent).toEqual([[60, 72]]);
    expect(r.run.warnings).toHaveLength(1);
    expect(r.run.made).toBe(5);
    // Two apart, in the first and in the second chunk of the export: two holes, one warning.
    expect(r.two.silent).toEqual([
      [40, 43],
      [200, 203],
    ]);
    expect(r.two.warnings).toEqual([
      { part: 'audio', reason: 'decode-error', lost: 'stretch', frame: 27, message: stretch, cause },
    ]);
    // The very first packet: the sound begins three packets in.
    expect(r.start.silent).toEqual([[1, 4]]);
    expect(r.start.warnings).toMatchObject([{ lost: 'stretch', frame: 0 }]);
    // A decoder that fails wherever it is started: a few starts, one warning, and the export is done.
    expect(r.dead.silent).toEqual([[1, 259]]);
    expect(r.dead.warnings).toEqual([
      {
        part: 'audio',
        reason: 'decode-error',
        lost: 'all',
        frame: 0,
        message: 'The audio in “stereo-441.mp4” could not be decoded, so it is missing from the export.',
        cause,
      },
    ]);
    expect(r.dead.made).toBeLessThan(12);
    expect(r.dead.seconds).toBeLessThan(5);
    expect(r.preview).toEqual([{ assetId: 'a', reason: 'decode-error', lost: 'all', at: 0, cause }]);
    expect(r.level).toBe(0);
    // The console is told what failed once for a file, however often it does. The browser's own
    // decoder is asked where nothing of the sound decodes (from the very first packet, dead, and
    // the preview), and says what it says, once each time; that it places ADTS badly, once.
    const webcodecs = '[audio] a: decoding failed (webcodecs) EncodingError: Decoding error.';
    const browser = '[audio] a: decoding failed (browser) EncodingError: Unable to decode audio data';
    expect(warned.filter((line) => line.startsWith('[audio] a: decoding failed'))).toEqual([
      ...Array(3).fill(webcodecs),
      ...Array(3).fill([webcodecs, browser]).flat(),
    ]);
    expect(warned.filter((line) => line.includes('it is given MP4 instead'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('a decoder that stops for good costs what it did not give: not what a clip played backwards still has to play, nor a word behind a clip’s end', async ({
    page,
  }) => {
    await openSoundLab(page);
    const errors = trackErrors(page);
    const r = await page.evaluate(async () => {
      const { lab, kit, decoders, sound } = window as any;
      lab.init(160, 90);
      const asset = await lab.addFile('a', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      const rate = 44100;
      const packet = 1024 / rate;
      const first = await (await lab.library.get('a')).audio.getFirstTimestamp();
      const at = (n: number) => Math.max(0, Math.trunc((first + n * packet) * 1e6));
      // No other decoder to turn to, and this one gives nothing from packet `n` on: the file has 260.
      Object.assign(decoders, { rate, own: 'refuses' });
      const stopAt = (n: number) => {
        decoders.bad = Array.from({ length: 262 - n }, (_, i) => at(n + i));
        sound.anew('a');
      };
      const told = (list: any[]) => list.map(({ clipId: _, assetId: __, ...rest }) => rest);

      // Backwards, the end of the file is played first, and the first third of the clip is what
      // the decoder did not give. The export is made in two chunks, and one decode serves both.
      const backwards = sound.project(asset, rate, 180, { reverse: true });
      stopAt(262);
      const whole = await sound.exported(backwards);
      stopAt(172);
      const part = await sound.exported(backwards);
      sound.anew('a');
      const inOneGo = await sound.render(backwards, 6);
      let same = part.channels[0].length;
      while (same > 0 && [0, 1].every((c) => part.channels[c][same - 1] === whole.channels[c][same - 1]))
        same--;

      // Forwards, under a clip that ends where a chunk of the export does, with more of the
      // timeline behind it: the chunk that follows plays the end of the clip before its own
      // start, to settle its filters, and none of that is in the export.
      const two = kit.project(
        160,
        90,
        [asset],
        [
          { type: 'audio', assetId: 'a', start: 0, duration: 120 },
          { type: 'audio', assetId: 'a', start: 150, duration: 30 },
        ],
        { sampleRate: rate },
      );
      stopAt(100);
      const tail = await sound.exported(two);

      // A clip that ends in its file in the packet before the first that will not decode, with
      // more of the timeline behind it. The decoder reads a few packets ahead and stops behind
      // what the clip plays, which costs it nothing, forwards or backwards.
      const short = (reverse: boolean) =>
        kit.project(
          160,
          90,
          [asset],
          [
            { type: 'audio', assetId: 'a', start: 0, duration: 41, reverse },
            { type: 'audio', assetId: 'a', start: 60, duration: 30 },
          ],
          { sampleRate: rate },
        );
      const ahead: { silent: number[][]; warnings: unknown[] }[] = [];
      for (const reverse of [false, true]) {
        stopAt(60);
        const out = await sound.exported(short(reverse));
        ahead.push({ silent: sound.quiet(out.channels[0], rate, 1e-4), warnings: told(out.warnings) });
      }
      return {
        backwards: {
          samples: part.channels[0].length,
          same,
          silent: sound.quiet(part.channels[0], rate, 1e-4),
          inOneGo: sound.apart(inOneGo.channels, part.channels),
          warnings: told(part.warnings),
          problems: told(inOneGo.problems),
        },
        tail: { silent: sound.quiet(tail.channels[0], rate, 1e-4), warnings: told(tail.warnings) },
        ahead,
      };
    });
    const rate = 44100;
    const cause = 'EncodingError: Decoding error.';
    const stretch = {
      part: 'audio',
      reason: 'decode-error',
      lost: 'stretch',
      message:
        'A stretch of the audio in “stereo-441.mp4” could not be decoded, so the export is silent there.',
      cause,
    };
    // Packet 171 is the last that decoded, and ends 171 packets into the file's sound: from where
    // that is played on, the export is the one of the whole file, sample for sample.
    expect(r.backwards.samples).toBe(6 * rate);
    expect(r.backwards.same).toBe(6 * rate - 171 * 1024);
    expect(r.backwards.silent).toHaveLength(1);
    expect(r.backwards.silent[0][0]).toBe(0);
    expect(Math.abs(r.backwards.silent[0][1] * rate - r.backwards.same)).toBeLessThan(16);
    // It is what a render in one go gives, to the 16 bits of the export: as a preview hears it.
    expect(r.backwards.inOneGo).toBeLessThan(1 / 32768);
    // The clip is without a stretch, the one it plays first, and what follows that is in its place.
    expect(r.backwards.warnings).toEqual([{ ...stretch, frame: 0 }]);
    expect(r.backwards.problems).toEqual([{ reason: 'decode-error', lost: 'stretch', cause }]);
    // Silent from packet 100 to where the second clip begins, and said once, of where it begins:
    // the chunk behind the clip's end, which got nothing of it either, has nothing to add.
    expect(r.tail.silent).toHaveLength(1);
    expect(Math.abs(r.tail.silent[0][0] * rate - 99 * 1024)).toBeLessThan(16);
    expect(Math.abs(r.tail.silent[0][1] - 5)).toBeLessThan(0.001);
    expect(r.tail.warnings).toEqual([{ ...stretch, frame: 68 }]);
    // Silent only between the two clips, from frame 41 to frame 60, and nothing said.
    for (const { silent, warnings } of r.ahead) {
      expect(silent).toHaveLength(1);
      expect(Math.abs(silent[0][0] * rate - (41 / 30) * rate)).toBeLessThan(16);
      expect(Math.abs(silent[0][1] - 2)).toBeLessThan(0.001);
      expect(warnings).toEqual([]);
    }
    expect(errors).toEqual([]);
  });

  test('sound the WebCodecs decoder fails on comes from the browser’s own decoder, the same to the sample', async ({
    page,
  }) => {
    await openSoundLab(page);
    const errors = trackErrors(page);
    const warned: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' && m.text().startsWith('[audio]')) warned.push(m.text().split('\n')[0]);
    });
    const r = await page.evaluate(async () => {
      const { lab, decoders, sound } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const stereo = await lab.addFile('stereo', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      const mono = await lab.addFile('mono', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      // The whole file; its start; across the places where one stretch of 128 packets ends and
      // the next begins; a short read in the middle (a seek); and from a seek to the end.
      const ranges: [number | undefined, number | undefined][] = [
        [undefined, undefined],
        [-0.1, 1],
        [0.5, 3.5],
        [2.9, 3.2],
        [1.2345, 1.3],
        [3.3, undefined],
      ];
      const compared = async (asset: any) => {
        const frames = Math.floor(asset.duration * 30);
        const both = async (dead: boolean) => {
          Object.assign(decoders, { rate: asset.audioSampleRate, dead, made: 0 });
          sound.anew(asset.id);
          const reads = [];
          for (const [from, to] of ranges) reads.push(await sound.read(asset.id, from, to));
          const renders = [];
          for (const rate of [44100, 48000]) {
            renders.push(await sound.render(sound.project(asset, rate, frames), frames / 30));
            // A clip that begins a second into the file, ten frames into the timeline.
            renders.push(await sound.render(sound.project(asset, rate, 60, { start: 10, sourceIn: 1 }), 2.4));
          }
          const exported = await sound.exported(sound.project(asset, 48000, frames));
          return { reads, renders, exported, made: decoders.made };
        };
        const direct = await both(false);
        const other = await both(true);
        return {
          buffers: other.reads.map((read) => read.times.length),
          // Every buffer at the time the WebCodecs decoder gives it, at the same rate.
          times: other.reads.map(
            (read, i) => JSON.stringify(read.times) === JSON.stringify(direct.reads[i].times),
          ),
          rates: other.reads.map((read) => read.rates),
          reads: other.reads.map((read, i) => sound.apart(read.channels, direct.reads[i].channels)),
          troubles: other.reads.flatMap((read) => read.troubles),
          renders: other.renders.map((render, i) => sound.apart(render.channels, direct.renders[i].channels)),
          problems: other.renders.flatMap((render) => render.problems),
          exported: sound.apart(other.exported.channels, direct.exported.channels),
          warnings: other.exported.warnings,
          // The WebCodecs decoder was tried once, and not again for any later read of the file.
          made: [direct.made, other.made],
          // What it differs from itself by when it is started at another packet.
          self: sound.apart(
            direct.reads[2].channels.map((x: Float32Array) => x.subarray(2048, 100_000)),
            direct.reads[0].channels.map((x: Float32Array) => {
              const skip = Math.round(
                (direct.reads[2].times[0] - direct.reads[0].times[0]) * asset.audioSampleRate,
              );
              return x.subarray(skip + 2048, skip + 100_000);
            }),
          ),
        };
      };
      const exact = await compared(stereo);
      const noisy = await compared(mono);

      // A preview is heard.
      const ctx = new AudioContext();
      await ctx.resume();
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      const problems: unknown[] = [];
      graph.onProblem = (p: unknown) => problems.push(p);
      graph.start(sound.project(stereo, 44100, 180), {
        startSec: 0,
        t0: ctx.currentTime + 0.05,
        rate: 1,
        endSec: 6,
      });
      void graph.pump();
      let level = 0;
      const until = performance.now() + 5000;
      while (level < 0.1 && performance.now() < until) {
        level = Math.max(level, ...graph.masterLevels());
        await new Promise((res) => setTimeout(res, 20));
      }
      graph.dispose();
      await ctx.close();

      // A browser whose own decoder leaves out a packet it cannot decode gives fewer samples than
      // the packets hold. Where they are missing cannot be known, so nothing of the stretch is
      // placed, and with the other decoder dead as well the clip is reported as silent.
      Object.assign(decoders, { rate: 48000, dead: true, own: 'loses' });
      sound.anew('mono');
      const lossy = await sound.render(sound.project(mono, 48000, 120), 4);
      return {
        exact,
        noisy,
        preview: { level, problems },
        lossy: {
          problems: lossy.problems.map((p: any) => `${p.lost}: ${p.cause}`),
          loudest: Math.max(
            ...lossy.channels.map((x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)),
          ),
        },
      };
    });
    for (const [name, file, packets] of [
      ['stereo-441.mp4', r.exact, 260],
      ['testsrc.mp4', r.noisy, 189],
    ] as const) {
      expect(file.buffers[0], name).toBe(packets);
      expect(file.times, name).toEqual(Array(6).fill(true));
      expect(new Set(file.rates.flat()).size, name).toBe(1);
      expect(file.troubles, name).toEqual([]);
      expect(file.problems, name).toEqual([]);
      expect(file.warnings, name).toEqual([]);
      // Six reads, four renders and an export each start a decoder; with the WebCodecs one dead it
      // is tried once, and not again for anything that reads the file after that.
      expect(file.made, name).toEqual([11, 1]);
    }
    // Sample for sample: read as buffers, mixed at the file's own rate and converted to another,
    // and exported. Nothing is rounded on the way but the export's 16 bits.
    expect(Math.max(...r.exact.reads, ...r.exact.renders)).toBeLessThan(1e-6);
    expect(r.exact.exported).toBeLessThan(1 / 32768 + 1e-9);
    expect(r.exact.self).toBeLessThan(1e-6);
    // In the file with noise bands the two differ by what one decoder differs from itself when it
    // begins at another packet (3e-4 measured, in a tone of 0.125). One sample out of place would
    // be 0.014.
    expect(r.noisy.self).toBeGreaterThan(1e-6);
    expect(Math.max(...r.noisy.reads, ...r.noisy.renders, r.noisy.exported)).toBeLessThan(2e-3);
    expect(r.preview.level).toBeGreaterThan(0.1);
    expect(r.preview.problems).toEqual([]);
    expect(r.lossy.problems).toEqual(['all: EncodingError: Decoding error.']);
    expect(r.lossy.loudest).toBe(0);
    // Said once for each file, with what the WebCodecs decoder said.
    expect(warned.filter((line) => line.includes('own decoder instead'))).toEqual(
      ['stereo', 'mono'].map(
        (id) =>
          `[audio] ${id}: the WebCodecs decoder failed (EncodingError: Decoding error.); its sound is decoded by the browser’s own decoder instead`,
      ),
    );
    expect(errors).toEqual([]);
  });

  test('AAC the browser’s own decoder is given as MP4 comes back the same to the sample: at 22.05 kHz, and plain AAC-LC where ADTS will not do, whether or not the browser follows the edit', async ({
    page,
  }) => {
    await openSoundLab(page);
    const errors = trackErrors(page);
    const warned: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' && m.text().startsWith('[audio]')) warned.push(m.text().split('\n')[0]);
    });
    const r = await page.evaluate(async () => {
      const { lab, decoders, sound } = window as any;
      lab.init(160, 90);
      const mono = await lab.addFile('mono', '/fixtures/mono-2205.mp4', 'mono-2205.mp4');
      const stereo = await lab.addFile('stereo', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      // The whole file; across the place where two stretches join; a short read (a seek); from a
      // seek to the end.
      const ranges: [number | undefined, number | undefined][] = [
        [undefined, undefined],
        [0.5, 3.5],
        [1.2345, 1.3],
        [3.3, undefined],
      ];
      /** The file read, mixed (at its in-point too) and exported, with the decoders as they are set. */
      const heard = async (asset: any) => {
        const frames = Math.floor(asset.duration * 30);
        sound.anew(asset.id);
        decoders.made = 0;
        const reads = [];
        for (const [from, to] of ranges) reads.push(await sound.read(asset.id, from, to));
        const renders = [
          await sound.render(sound.project(asset, 48000, frames), frames / 30),
          await sound.render(sound.project(asset, 44100, 60, { start: 10, sourceIn: 1 }), 2.4),
        ];
        const exported = await sound.exported(sound.project(asset, 48000, frames));
        return { reads, renders, exported, made: decoders.made };
      };
      const compared = async (asset: any, own: string) => {
        Object.assign(decoders, { rate: asset.audioSampleRate, dead: false, own: '' });
        const direct = await heard(asset);
        Object.assign(decoders, { dead: true, own });
        const other = await heard(asset);
        return {
          buffers: other.reads.map((read: any) => read.times.length),
          times: other.reads.every(
            (read: any, i: number) => JSON.stringify(read.times) === JSON.stringify(direct.reads[i].times),
          ),
          rates: [...new Set(other.reads.flatMap((read: any) => read.rates))],
          apart: Math.max(
            ...other.reads.map((read: any, i: number) =>
              sound.apart(read.channels, direct.reads[i].channels),
            ),
            ...other.renders.map((render: any, i: number) =>
              sound.apart(render.channels, direct.renders[i].channels),
            ),
          ),
          exported: sound.apart(other.exported.channels, direct.exported.channels),
          said: [
            ...other.reads.flatMap((read: any) => read.troubles),
            ...other.renders.flatMap((render: any) => render.problems),
            ...other.exported.warnings,
          ],
          made: [direct.made, other.made],
        };
      };
      const files = {
        mono: await compared(mono, ''),
        'mono, the edit not followed': await compared(mono, 'unedited'),
        'stereo, without ADTS': await compared(stereo, 'adts'),
        'stereo, without ADTS, the edit not followed': await compared(stereo, 'unedited'),
      };

      // A browser that leaves a packet out of the middle of what it is given, or cuts the front
      // of it: what comes back cannot be placed, and is not used.
      const lossy: Record<string, unknown> = {};
      for (const own of ['loses', 'cuts']) {
        Object.assign(decoders, { rate: 22050, dead: true, own });
        sound.anew('mono');
        const render = await sound.render(sound.project(mono, 48000, 120), 4);
        lossy[own] = {
          problems: render.problems.map((p: any) => `${p.lost}: ${p.cause}`),
          loudest: Math.max(
            ...render.channels.map((x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)),
          ),
        };
      }
      return { files, lossy };
    });
    for (const [name, file] of Object.entries(r.files)) {
      const packets = name.startsWith('mono') ? 131 : 260;
      expect(file.buffers[0], name).toBe(packets);
      expect(file.times, name).toBe(true);
      // At the rate the file decodes to: the 22.05 kHz file says it carries nothing that doubles it.
      expect(file.rates, name).toEqual([name.startsWith('mono') ? 22050 : 44100]);
      expect(file.apart, name).toBeLessThan(1e-6);
      expect(file.exported, name).toBeLessThan(1 / 32768 + 1e-9);
      expect(file.said, name).toEqual([]);
      // Seven reads and renders and an export each start a decoder; the WebCodecs one, dead, once.
      expect(file.made, name).toEqual([7, 1]);
    }
    for (const own of ['loses', 'cuts'])
      expect(r.lossy[own], own).toEqual({ problems: ['all: EncodingError: Decoding error.'], loudest: 0 });
    expect(warned.filter((line) => line.includes('own decoder instead'))).toEqual(
      ['mono', 'mono', 'stereo', 'stereo'].map(
        (id) =>
          `[audio] ${id}: the WebCodecs decoder failed (EncodingError: Decoding error.); its sound is decoded by the browser’s own decoder instead`,
      ),
    );
    expect(errors).toEqual([]);
  });

  test('a decoder that gives what lies in front of a file’s sound and fails on the sound itself has decoded none of it', async ({
    page,
  }) => {
    await openSoundLab(page);
    const errors = trackErrors(page);
    const r = await page.evaluate(async () => {
      const { lab, decoders, sound } = window as any;
      const { engine } = lab;
      lab.init(160, 90);
      const asset = await lab.addFile('a', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      const rate = 44100;
      const packet = 1024 / rate;
      // The file's first packet, its priming, lies before 0 and decodes; from the next on nothing
      // does, and no other decoder stands in.
      const first = await (await lab.library.get('a')).audio.getFirstTimestamp();
      const times = Array.from({ length: 259 }, (_, i) => Math.trunc((first + (i + 1) * packet) * 1e6));
      Object.assign(decoders, { rate, bad: times, own: 'refuses' });
      sound.anew('a');
      const read = await sound.read('a');
      const exported = await sound.exported(sound.project(asset, 48000, 180));

      // The preview's mixer says the same of the clip.
      const ctx = new AudioContext();
      await ctx.resume();
      const graph = new engine.AudioGraph(ctx, lab.library, true);
      const problems: any[] = [];
      graph.onProblem = (p: any) => problems.push(p);
      graph.start(sound.project(asset, rate, 180), {
        startSec: 0,
        t0: ctx.currentTime + 0.05,
        rate: 1,
        endSec: 6,
      });
      void graph.pump();
      const until = performance.now() + 5000;
      while (!problems.length && performance.now() < until) await new Promise((res) => setTimeout(res, 20));
      graph.dispose();
      await ctx.close();
      return {
        first,
        given: read.times,
        troubles: read.troubles.map((t: any) => t.lost),
        warnings: exported.warnings.map(({ clipId: _, assetId: __, ...w }: any) => w),
        loudest: Math.max(
          ...exported.channels.map((x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)),
        ),
        preview: problems.map((p) => p.lost),
      };
    });
    // The priming came out, and is all that did.
    expect(r.first).toBeLessThan(0);
    expect(r.given).toEqual([r.first]);
    expect(r.troubles).toEqual(['all']);
    expect(r.warnings).toEqual([
      {
        part: 'audio',
        reason: 'decode-error',
        lost: 'all',
        frame: 0,
        message: 'The audio in “stereo-441.mp4” could not be decoded, so it is missing from the export.',
        cause: 'EncodingError: Decoding error.',
      },
    ]);
    expect(r.loudest).toBe(0);
    expect(r.preview).toEqual(['all']);
    expect(errors).toEqual([]);
  });

  test('a browser that cuts the priming from the front of a stream itself still gets every sample in its place', async ({
    page,
  }) => {
    await openSoundLab(page);
    const r = await page.evaluate(async () => {
      const { lab, decoders, sound } = window as any;
      lab.init(160, 90);
      const asset = await lab.addFile('a', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      const direct = [await sound.read('a'), await sound.read('a', 2.9, 3.2)];
      Object.assign(decoders, { rate: 44100, dead: true, own: 'cuts' });
      sound.anew('a');
      const other = [await sound.read('a'), await sound.read('a', 2.9, 3.2)];
      return {
        times: other.map((read, i) => JSON.stringify(read.times) === JSON.stringify(direct[i].times)),
        troubles: other.flatMap((read) => read.troubles),
        // The 2112 samples such a browser drops at the very start of the file stay silent...
        start: Math.max(
          ...other[0].channels.map((x: Float32Array) => Math.max(...x.subarray(0, 2112).map(Math.abs))),
        ),
        // ...and everything behind them, and every later read, is what the other decoder gives.
        whole: sound.apart(other[0].channels, direct[0].channels, 2112),
        seek: sound.apart(other[1].channels, direct[1].channels),
      };
    });
    expect(r.times).toEqual([true, true]);
    expect(r.troubles).toEqual([]);
    expect(r.start).toBe(0);
    expect(r.whole).toBeLessThan(1e-6);
    expect(r.seek).toBeLessThan(1e-6);
  });

  test('the player passes on what its mixer reports: each stretch that would not decode, once every time the clip is played, and nothing behind what it plays', async ({
    page,
  }) => {
    await openSoundLab(page);
    const errors = trackErrors(page);
    const r = await page.evaluate(async () => {
      const { lab, decoders, sound } = window as any;
      const { core, engine } = lab;
      lab.init(160, 90);
      const asset = await lab.addFile('a', '/fixtures/stereo-441.mp4', 'stereo-441.mp4');
      const rate = 44100;
      const packet = 1024 / rate;
      const first = await (await lab.library.get('a')).audio.getFirstTimestamp();
      const at = (n: number) => Math.max(0, Math.trunc((first + n * packet) * 1e6));
      const project = sound.project(asset, rate, 180);
      const clip = Object.values(project.clips)[0] as any;
      // No other decoder to turn to, so that a play that begins on a bad packet stays where it is.
      Object.assign(decoders, { rate, own: 'refuses' });
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const player = new engine.Player(canvas, project, lab.resolver);
      const problems: any[] = [];
      player.onAudioProblem = (p: any) => problems.push(p);
      const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
      /**
       * Play from the start until `count` problems are in and the playhead is two seconds in,
       * behind the first of the holes, and a little longer for a problem too many.
       */
      const played = async (count: number) => {
        player.seek(0);
        player.play();
        const until = performance.now() + 10_000;
        while ((problems.length < count || player.getFrame() < 60) && performance.now() < until)
          await wait(20);
        await wait(600);
        const level = Math.max(...player.levels().master);
        player.pause();
        return { problems: problems.splice(0), level };
      };

      // A file that decodes, played with everything that ends a clip's sound early: jumps, and an
      // edit that cuts the clip short under the playhead and gives it back.
      player.play();
      await wait(400);
      for (const frame of [30, 90, 12, 150, 60, 61, 62, 100, 5]) {
        player.seek(frame);
        await wait(40);
      }
      player.setProject(
        core.applyEdits(project, [{ op: 'updateClip', id: clip.id, patch: { duration: 20 } }]),
      );
      await wait(400);
      player.setProject(project);
      await wait(400);
      player.pause();
      const healthy = problems.splice(0);

      // One packet that will not decode, played twice; then two, far apart.
      decoders.bad = [at(60)];
      player.refreshAsset('a');
      const once = await played(1);
      const again = await played(1);
      decoders.bad = [at(40), at(200)];
      player.refreshAsset('a');
      const two = await played(2);

      // The decoder reads a few packets beyond what it is asked for. Looped over a range that ends
      // in the packet before the bad one, it fails behind what is played, which costs the loop
      // nothing; a range that takes in the start of the bad packet is without it, each time round.
      decoders.bad = [at(60)];
      player.refreshAsset('a');
      const looped = async (out: number) => {
        player.setRange({ in: 0, out });
        player.setLoop(true);
        player.seek(0);
        player.play();
        let loops = 0;
        for (let last = 0, until = performance.now() + 10_000; loops < 2 && performance.now() < until;) {
          await wait(20);
          const frame = player.getFrame();
          if (frame < last) loops++;
          last = frame;
        }
        player.pause();
        player.setLoop(false);
        player.setRange(null);
        return { loops, problems: problems.splice(0) };
      };
      const ahead = await looped(41);
      const inside = await looped(42);
      // Played backwards, a clip that ends in its file in the packet before the bad one has all
      // its sound; one that takes in the bad packet, well before its end, does not. (A voice that
      // starts late leaves out what is already past, which backwards is the end of the stretch.)
      const backwards = async (duration: number) => {
        player.setProject(
          core.applyEdits(project, [{ op: 'updateClip', id: clip.id, patch: { duration, reverse: true } }]),
        );
        player.seek(0);
        player.play();
        const until = performance.now() + 10_000;
        while (player.getState().playing && performance.now() < until) await wait(20);
        await wait(300);
        return problems.splice(0);
      };
      const reversed = { ahead: await backwards(41), inside: await backwards(60) };
      player.dispose();
      canvas.remove();
      return { clipId: clip.id as string, packet, healthy, once, again, two, ahead, inside, reversed };
    });
    const stretch = (n: number) => ({
      clipId: r.clipId,
      assetId: 'a',
      reason: 'decode-error',
      lost: 'stretch',
      // Where packet `n` begins: the file's first lies one packet before zero.
      at: expect.closeTo((n - 1) * r.packet, 6),
      cause: 'EncodingError: Decoding error.',
    });
    expect(r.healthy).toEqual([]);
    expect(r.once.problems).toEqual([stretch(60)]);
    // The clip plays on behind the hole.
    expect(r.once.level).toBeGreaterThan(0.05);
    expect(r.again.problems).toEqual([stretch(60)]);
    expect(r.two.problems).toEqual([stretch(40), stretch(200)]);
    // A range that ends at frame 41 ends a tenth of a frame before packet 60 begins.
    expect(r.ahead).toEqual({ loops: 2, problems: [] });
    expect(r.inside.loops).toBe(2);
    expect(r.inside.problems.length).toBeGreaterThanOrEqual(2);
    expect(r.inside.problems).toEqual(r.inside.problems.map(() => stretch(60)));
    expect(r.reversed.ahead).toEqual([]);
    expect(r.reversed.inside).toEqual([{ ...stretch(60), at: undefined }]);
    expect(errors).toEqual([]);
  });
});
