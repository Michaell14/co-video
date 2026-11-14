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
    expect(r.first).toMatchObject({ reasons: ['video:decode-error'], starts: 3 });
    expect(r.first.ms).toBeLessThan(1000);
    expect(r.next).toMatchObject({ reasons: ['video:decode-error'], starts: 0 });
    expect(r.next.ms).toBeLessThan(100);
    expect(r.empty).toMatchObject({ reasons: ['video:decode-error'], starts: 3 });
    expect(r.empty.ms).toBeLessThan(1000);
    expect(r.exported.frames).toBe(45);
    expect(r.exported.warnings).toEqual(['video:decode-error@0']);
    expect(r.exported.message).toContain('“testsrc.mp4” stopped decoding');
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
