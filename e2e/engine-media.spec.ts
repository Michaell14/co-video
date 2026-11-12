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
});
