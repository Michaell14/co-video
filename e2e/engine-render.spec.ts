import { expect, test } from '@playwright/test';
import { openLab, trackErrors } from './helpers';

/**
 * Rendering behaviour that is easy to get subtly wrong: resource use over time, colour at the edges
 * of the range, and pictures much larger than the frame. Everything runs on the engine lab page.
 * WebGL is software-rendered here, so cost is asserted as counts (targets, allocations, mip builds),
 * never as time.
 */
test.describe('render engine: resources', () => {
  test('a zoom on a graded, blurred clip runs on a handful of render targets', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const g = c.getContext('2d')!;
      g.fillStyle = '#468';
      g.fillRect(0, 0, 640, 360);
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
      const asset = await lab.addFile('still', URL.createObjectURL(blob), 'still.png');
      const v1 = core.makeTrack('video', 0);
      // A push-in from 80% to 100%, shown at half size: the clip is a different size on every frame.
      const frames = 60;
      const zoom = [
        { t: 0, v: 0.8, e: 'linear' },
        { t: frames - 1, v: 1, e: 'linear' },
      ];
      const out: Record<string, { peak: number; end: number; created: number }> = {};
      for (const blur of [false, true]) {
        lab.init(320, 180);
        const gl = lab.compositor.gl;
        let created = 0;
        const createFramebuffer = gl.createFramebuffer.bind(gl);
        gl.createFramebuffer = () => {
          created++;
          return createFramebuffer();
        };
        const p = core.applyEdits(core.emptyProject({ width: 640, height: 360 }), [
          { op: 'addTrack', track: v1 },
          { op: 'addAsset', asset },
          {
            op: 'addClip',
            clip: core.makeClip('image', v1.id, {
              assetId: 'still',
              start: 0,
              duration: frames,
              grade: { ...core.DEFAULT_GRADE, exposure: 0.3 },
              effects: blur ? [core.makeEffect('gaussianBlur')] : [],
              keyframes: { scaleX: zoom, scaleY: zoom },
            }),
          },
        ]);
        let peak = 0;
        for (let f = 0; f < frames; f++) {
          const desc = core.resolveFrame(p, f);
          await lab.sources.prepare(p, desc, true);
          lab.compositor.render(p, desc, lab.sources, { skipPresent: true });
          peak = Math.max(peak, lab.compositor.glx.liveTargets);
        }
        delete gl.createFramebuffer;
        out[blur ? 'blur' : 'grade'] = { peak, end: lab.compositor.glx.liveTargets, created };
      }
      return out;
    });
    // A buffer per frame used to mean 60 targets with the grade alone and 180 with the blur,
    // none of them ever freed.
    expect(r.grade.peak).toBeLessThanOrEqual(6);
    expect(r.grade.created).toBeLessThanOrEqual(8);
    expect(r.grade.end).toBeLessThanOrEqual(4);
    expect(r.blur.peak).toBeLessThanOrEqual(16);
    expect(r.blur.created).toBeLessThanOrEqual(24);
    expect(r.blur.end).toBeLessThanOrEqual(8);
  });

  test('render targets of sizes that are no longer drawn are freed', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(640, 360);
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      c.getContext('2d')!.fillRect(0, 0, 1280, 720);
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
      const asset = await lab.addFile('still', URL.createObjectURL(blob), 'still.png');
      const v1 = core.makeTrack('video', 0);
      // Twelve graded stills in a row, each at its own (fixed) size, six frames apiece.
      const clips = Array.from({ length: 12 }, (_, i) =>
        core.makeClip('image', v1.id, {
          assetId: 'still',
          start: i * 6,
          duration: 6,
          scaleX: 0.3 + i * 0.05,
          scaleY: 0.3 + i * 0.05,
          grade: { ...core.DEFAULT_GRADE, contrast: 0.2 },
        }),
      );
      const p = core.applyEdits(core.emptyProject({ width: 1280, height: 720 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addAsset', asset },
        ...clips.map((clip: unknown) => ({ op: 'addClip', clip })),
      ]);
      const live: number[] = [];
      for (let f = 0; f < 72; f++) {
        const desc = core.resolveFrame(p, f);
        await lab.sources.prepare(p, desc, true);
        lab.compositor.render(p, desc, lab.sources, { skipPresent: true });
        live.push(lab.compositor.glx.liveTargets);
      }
      // Reading back and scopes take targets of their own; those must not pile up either.
      for (let i = 0; i < 5; i++) {
        lab.compositor.readPixels();
        await lab.compositor.readScope(64 + i * 16);
        lab.compositor.render(p, core.resolveFrame(p, 71), lab.sources, { skipPresent: true });
      }
      for (let i = 0; i < 6; i++)
        lab.compositor.render(p, core.resolveFrame(p, 71), lab.sources, { skipPresent: true });
      return {
        peak: Math.max(...live),
        end: live[live.length - 1],
        settled: lab.compositor.glx.liveTargets,
        glError: lab.compositor.gl.getError(),
      };
    });
    expect(r.glError).toBe(0);
    expect(r.peak).toBeLessThanOrEqual(5);
    expect(r.end).toBeLessThanOrEqual(4);
    // Accumulator, last frame, the clip's buffer and the one scope target that is still held.
    expect(r.settled).toBeLessThanOrEqual(5);
  });

  test('idle render targets go after a few frames, or at once when they hold a lot of memory', async ({
    page,
  }) => {
    await openLab(page);
    const r = await page.evaluate(() => {
      const { lab } = window as any;
      lab.init(64, 36);
      const glx = lab.compositor.glx;
      const before = glx.liveTargets;
      const live: number[] = [];
      // Small targets wait in the pool for four frames in case their size comes round again.
      glx.release(glx.acquire(256, 256));
      for (let i = 0; i < 5; i++) {
        glx.endFrame();
        live.push(glx.liveTargets - before);
      }
      // Two 4096-pixel float targets are exactly the 256 MB the pool may hold idle; with a third
      // target it is over, and then only the frame that used them keeps them.
      const big = [glx.acquire(4096, 4096), glx.acquire(4096, 4096), glx.acquire(1024, 1024)];
      const float = big[0].float;
      for (const rt of big) glx.release(rt);
      for (let i = 0; i < 2; i++) {
        glx.endFrame();
        live.push(glx.liveTargets - before);
      }
      return { live, float, glError: lab.compositor.gl.getError() };
    });
    expect(r.float).toBe(true);
    expect(r.glError).toBe(0);
    expect(r.live).toEqual([1, 1, 1, 1, 0, 3, 0]);
  });

  test('what only changes with the project is not worked out again for every frame', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core, engine } = lab;
      lab.init(640, 360);
      const gl = lab.compositor.gl;
      const v1 = core.makeTrack('video', 0);
      const v2 = core.makeTrack('video', 1);
      const title = core.makeClip('text', v2.id, {
        start: 0,
        duration: 60,
        fit: 'none',
        text: { ...core.DEFAULT_TEXT, content: 'OPENING TITLE', font: 'Bebas Neue', weight: 400 },
      });
      const project = (settings = {}) =>
        core.applyEdits(core.emptyProject({ width: 640, height: 360, ...settings }), [
          { op: 'addTrack', track: v1 },
          { op: 'addTrack', track: v2 },
          {
            op: 'addClip',
            clip: core.makeClip('solid', v1.id, {
              start: 0,
              duration: 60,
              shape: { ...core.DEFAULT_SHAPE, fill: '#203860' },
              grade: { ...core.DEFAULT_GRADE, exposure: 0.4, saturation: 1.3 },
            }),
          },
          { op: 'addClip', clip: title },
        ]);
      const sdr = project();
      const hash = (px: Uint8Array) => {
        let h = 0;
        for (let i = 0; i < px.length; i += 7) h = (h * 31 + px[i]) | 0;
        return h;
      };
      /** How wide the title is drawn: the columns of the frame that hold a near-white pixel. */
      const width = (px: Uint8Array) => {
        let columns = 0;
        for (let x = 0; x < 640; x++) {
          let lit = false;
          for (let y = 0; y < 360 && !lit; y++) lit = px[(y * 640 + x) * 4] > 230;
          if (lit) columns++;
        }
        return columns;
      };

      // Ten frames drawn the way a viewer draws them, with what they ask of the browser counted.
      const counts = { check: 0, uniform1i: 0, bindTexture: 0, stringify: 0 };
      const check = document.fonts.check;
      document.fonts.check = function (...args: [string, string?]) {
        counts.check++;
        return check.apply(this, args);
      };
      const stringify = JSON.stringify;
      JSON.stringify = function (this: unknown, ...args: Parameters<typeof JSON.stringify>) {
        counts.stringify++;
        return stringify.apply(this, args);
      } as typeof JSON.stringify;
      for (const name of ['uniform1i', 'bindTexture'] as const) {
        const inner = gl[name].bind(gl);
        gl[name] = (...args: unknown[]) => {
          counts[name]++;
          return inner(...args);
        };
      }
      await lab.renderFrame(sdr, 0);
      const first = { ...counts };
      for (let f = 1; f <= 10; f++) {
        const desc = core.resolveFrame(sdr, f);
        void lab.sources.prepare(sdr, desc, false);
        lab.compositor.render(sdr, desc, lab.sources, {});
      }
      const steady = { check: counts.check - first.check, stringify: counts.stringify - first.stringify };
      // A pass whose only integer uniform would be the unit its sampler reads: a plain copy.
      const { glx } = lab.compositor;
      const [from, to] = [glx.acquire(16, 16), glx.acquire(16, 16)];
      const copy = glx.program('copy', engine.COPY_FS);
      const before = { ...counts };
      for (let i = 0; i < 5; i++) glx.pass(copy, to, { u_tex: from.tex, u_opacity: 1 });
      const copies = {
        uniform1i: counts.uniform1i - before.uniform1i,
        bindTexture: counts.bindTexture - before.bindTexture,
      };
      glx.release(from);
      glx.release(to);
      delete (document.fonts as any).check;
      JSON.stringify = stringify;
      delete gl.uniform1i;
      delete gl.bindTexture;

      // The same compositor on another working space and back: nothing kept from the one before.
      const a = hash((await lab.renderFrame(sdr, 3)).pixels);
      const hdr = hash((await lab.renderFrame(project({ colorMode: 'hdr-pq', peakNits: 1000 }), 3)).pixels);
      const fallback = await lab.renderFrame(sdr, 3);
      const b = hash(fallback.pixels);

      // The title's family was unknown to the document until now, so its text counted as ready to
      // draw. Registering the editor's faces must not leave that answer standing.
      const spec = engine.fontSpec(title.text, 32);
      const knownBefore = document.fonts.check(spec, title.text.content);
      const epoch = engine.fontEpoch();
      await lab.registerTitleFonts();
      await lab.renderFrame(sdr, 3);
      // The document announces the new face a moment after its file has arrived.
      for (const end = performance.now() + 10_000; engine.fontEpoch() === epoch && performance.now() < end;)
        await new Promise((res) => setTimeout(res, 50));
      const loaded = await lab.renderFrame(sdr, 3);
      return {
        steady,
        copies,
        a,
        b,
        hdr,
        knownBefore,
        loadedAfter: document.fonts.check(spec, title.text.content),
        fallbackWidth: width(fallback.pixels),
        loadedWidth: width(loaded.pixels),
        glError: gl.getError(),
      };
    });
    // Once asked, the browser is not asked again whether the title's font is there, and the title
    // is not written out again to look up its picture.
    expect(r.steady.check).toBe(0);
    expect(r.steady.stringify).toBe(0);
    // A program is told which unit each of its samplers reads when it is made, not at every pass.
    expect(r.copies).toEqual({ uniform1i: 0, bindTexture: 5 });
    expect(r.b).toBe(r.a);
    expect(r.hdr).not.toBe(r.a);
    expect(r.knownBefore).toBe(true);
    expect(r.loadedAfter).toBe(true);
    // Bebas Neue is a condensed face: the fallback drew the title far wider.
    expect(r.fallbackWidth).toBeGreaterThan(r.loadedWidth * 1.2);
    expect(r.loadedWidth).toBeGreaterThan(40);
    expect(r.glError).toBe(0);
  });

  test('mipmaps are built once per picture, not once per draw', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(320, 180);
      const gl = lab.compositor.gl;
      let builds = 0;
      const generateMipmap = gl.generateMipmap.bind(gl);
      gl.generateMipmap = (target: number) => {
        builds++;
        generateMipmap(target);
      };
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 1024;
      const g = c.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, 1024, 1024);
      g.fillStyle = '#fff';
      for (let x = 0; x < 1024; x += 3) g.fillRect(x, 0, 1, 1024);
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
      const asset = await lab.addFile('stripes', URL.createObjectURL(blob), 'stripes.png');
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const v1 = core.makeTrack('video', 0);
      const small = { fit: 'none', scaleX: 0.125, scaleY: 0.125 };
      const project = (clip: unknown, ...assets: unknown[]) =>
        core.applyEdits(core.emptyProject({ width: 320, height: 180 }), [
          { op: 'addTrack', track: v1 },
          ...assets.map((a) => ({ op: 'addAsset', asset: a })),
          { op: 'addClip', clip },
        ]);
      const text = project(
        core.makeClip('text', v1.id, {
          start: 0,
          duration: 30,
          ...small,
          text: { ...core.DEFAULT_TEXT, content: 'TANDEM', size: 0.6 },
        }),
      );
      const still = project(
        core.makeClip('image', v1.id, { assetId: 'stripes', start: 0, duration: 30, ...small }),
        asset,
      );
      const video = project(
        core.makeClip('video', v1.id, { assetId: 'vid', start: 0, duration: 30, ...small }),
        vid,
      );
      const spread = (pixels: Uint8Array) => {
        let min = 255;
        let max = 0;
        for (let x = 100; x < 220; x++) {
          const v = pixels[(90 * 320 + x) * 4];
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        return max - min;
      };
      const count = async (fn: () => Promise<void>) => {
        builds = 0;
        await fn();
        return builds;
      };
      const out: Record<string, number> = {};
      out.text = await count(async () => {
        for (let i = 0; i < 20; i++) await lab.renderFrame(text, i % 5);
      });
      let first = 0;
      let last = 0;
      out.still = await count(async () => {
        first = spread((await lab.renderFrame(still, 0)).pixels);
        for (let i = 0; i < 9; i++) {
          // Switching mips off and on again must neither rebuild nor lose them.
          await lab.renderFrame(still, 0, { fast: true });
          last = spread((await lab.renderFrame(still, 0)).pixels);
        }
      });
      out.first = first;
      out.last = last;
      // A decoder writes each new frame into the same texture, so video still rebuilds.
      out.video = await count(async () => {
        for (let i = 0; i < 4; i++) await lab.renderFrame(video, i);
      });
      delete gl.generateMipmap;
      return out;
    });
    expect(r.text).toBe(1);
    expect(r.still).toBe(1);
    expect(r.first).toBeLessThan(60); // filtered: the stripes come out as a near-even grey
    expect(r.last).toBe(r.first);
    expect(r.video).toBeGreaterThanOrEqual(4);
  });
});

test.describe('render engine: colour', () => {
  test('a 10-bit source drawn smaller keeps its code values', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core, engine } = lab;
      const hdr = await lab.addFile('hdr', '/fixtures/hdr-pq-ramp.webm', 'hdr-pq-ramp.webm');
      const media = await new engine.MediaLibrary(lab.resolver).get('hdr');
      const sample = await new engine.VideoSampleSink(media.video).getSample(0.2);
      const buf = new Uint8Array(sample.allocationSize());
      const layout = await sample.copyTo(buf);
      const srcRow = (y: number) => new Uint16Array(buf.buffer, layout[0].offset + layout[0].stride * y, 640);
      // Mean of the source over the area that output pixel (x, y) of a w × h picture covers. Lengths
      // are counted in units of 1 / w (1 / h) of a source pixel, which keeps the coverage exact.
      // Where the ramp levels off the encoder overshoots nominal white (code 940) by a code or two;
      // that is brighter than the timeline's peak, so it is not expected back.
      const covered = (x: number, y: number, w: number, h: number) => {
        let acc = 0;
        for (let j = Math.floor((y * 360) / h); j * h < (y + 1) * 360; j++) {
          const wy = Math.min((j + 1) * h, (y + 1) * 360) - Math.max(j * h, y * 360);
          const src = srcRow(j);
          for (let i = Math.floor((x * 640) / w); i * w < (x + 1) * 640; i++) {
            const wx = Math.min((i + 1) * w, (x + 1) * 640) - Math.max(i * w, x * 640);
            acc += Math.min(src[i], 940) * wy * wx;
          }
        }
        return acc / (640 * 360);
      };
      const out: Record<string, number> = {};
      // Half and quarter size, and a size in between (1.6×), which no whole number of halvings reaches.
      for (const [w, h] of [
        [400, 225],
        [320, 180],
        [160, 90],
      ]) {
        lab.init(w, h);
        const v1 = core.makeTrack('video', 0);
        const p = core.applyEdits(
          core.emptyProject({ width: w, height: h, colorMode: 'hdr-pq', peakNits: 10000 }),
          [
            { op: 'addTrack', track: v1 },
            { op: 'addAsset', asset: hdr },
            {
              op: 'addClip',
              clip: core.makeClip('video', v1.id, { assetId: 'hdr', start: 0, duration: 30 }),
            },
          ],
        );
        await lab.renderFrame(p, 6);
        const yuv: Uint16Array = lab.compositor.readYuv10('pq');
        // Every output sample against the mean of the source it covers. The ramp crosses 256, 512
        // and 768, which is where averaging the two bytes of a sample separately goes wrong.
        const row = h >> 1;
        let worst = 0;
        for (let x = 0; x < w; x++) {
          worst = Math.max(worst, Math.abs(yuv[row * w + x] - covered(x, row, w, h)));
        }
        out[`${w}x${h}`] = worst;
        const chroma = yuv.subarray(w * h);
        out[`${w}x${h} chroma`] = Math.max(...Array.from(chroma, (v) => Math.abs(v - 512)));
      }
      const row = srcRow(180);
      out.range = Math.max(...row) - Math.min(...row);
      sample.close();
      return out;
    });
    expect(r.range).toBeGreaterThan(500);
    for (const size of ['400x225', '320x180', '160x90']) {
      expect(r[size], size).toBeLessThanOrEqual(2);
      expect(r[`${size} chroma`], size).toBeLessThanOrEqual(2);
    }
  });

  test('a 10-bit source drawn a little smaller keeps its detail and does not alias', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core, engine } = lab;
      // The ramp fixture has no detail, so this clip is made here: stripes, sent through the HDR
      // exporter to get real 10-bit planes.
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const g = c.getContext('2d')!;
      g.fillStyle = '#404040';
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#b0b0b0';
      // Top half: two columns on, two off, from an odd column on, so that every 2×2 block of a
      // half-size copy averages to the same grey. Bottom half: single columns, which no smaller
      // picture can hold.
      for (let x = 1; x < 640; x += 4) g.fillRect(x, 0, 2, 180);
      for (let x = 1; x < 640; x += 2) g.fillRect(x, 180, 1, 180);
      const png: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
      const still = await lab.addFile('still', URL.createObjectURL(png), 'stripes.png');
      const project = (w: number, h: number, asset: any, type: string) => {
        const v1 = core.makeTrack('video', 0);
        return core.applyEdits(
          core.emptyProject({ width: w, height: h, colorMode: 'hdr-pq', peakNits: 10000 }),
          [
            { op: 'addTrack', track: v1 },
            { op: 'addAsset', asset },
            { op: 'addClip', clip: core.makeClip(type, v1.id, { assetId: asset.id, start: 0, duration: 4 }) },
          ],
        );
      };
      lab.init(640, 360);
      const file = await lab.exportBase64(project(640, 360, still, 'image'), {
        container: 'webm',
        videoCodec: 'vp9',
        audioCodec: 'opus',
        width: 640,
        height: 360,
        fpsNum: 30,
        fpsDen: 1,
        videoBitrate: 12_000_000,
        audioBitrate: 96_000,
        range: null,
        includeVideo: true,
        includeAudio: false,
        dynamicRange: 'pq',
        keyFrameInterval: 1,
        hardwareAcceleration: 'no-preference',
      });
      const bytes = Uint8Array.from(atob(file.base64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
      const hdr = await lab.addFile('hdr', url, 'stripes.webm');

      // Difference between the brightest and the darkest luma sample of a row, edges left out.
      const swing = (row: Uint16Array) => {
        const inner = row.subarray(8, row.length - 8);
        return Math.max(...inner) - Math.min(...inner);
      };
      const media = await new engine.MediaLibrary(lab.resolver).get('hdr');
      const sample = await new engine.VideoSampleSink(media.video).getSample(0.04);
      const buf = new Uint8Array(sample.allocationSize());
      const layout = await sample.copyTo(buf);
      const srcRow = (y: number) => new Uint16Array(buf.buffer, layout[0].offset + layout[0].stride * y, 640);
      const format: string | null = sample.format;
      const swings: Record<string, number> = {
        'source coarse': swing(srcRow(90)),
        'source fine': swing(srcRow(270)),
      };
      sample.close();
      // 1.6× and 1.9× smaller: more than is sampled in one go, less than one halving.
      for (const [w, h] of [
        [400, 225],
        [336, 189],
      ]) {
        lab.init(w, h);
        await lab.renderFrame(project(w, h, hdr, 'video'), 1);
        const yuv: Uint16Array = lab.compositor.readYuv10('pq');
        const row = (y: number) => yuv.subarray(y * w, (y + 1) * w);
        swings[`${w} coarse`] = swing(row(h >> 2));
        swings[`${w} fine`] = swing(row(h - (h >> 2)));
      }
      return { format, swings };
    });
    expect(r.format).toBe('I420P10');
    expect(r.swings['source coarse']).toBeGreaterThan(120);
    expect(r.swings['source fine']).toBeGreaterThan(120);
    // Stripes 2.5 pixels apart at this size fit the picture, so they have to be in it. Reduced by
    // way of a half-size copy they are gone: the copy is smaller than the picture it is made for.
    expect(r.swings['400 coarse']).toBeGreaterThan(0.75 * r.swings['source coarse']);
    // Stripes the picture cannot hold must fade to grey. Sampling the source once per output pixel
    // turns them into bands at close to full contrast instead.
    expect(r.swings['336 fine']).toBeLessThan(0.25 * r.swings['source fine']);
  });

  test('the tone-map setting leaves SDR pictures alone and rolls off log sources once', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(64, 36);
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 36;
      const g = c.getContext('2d')!;
      g.fillStyle = 'rgb(128, 128, 128)';
      g.fillRect(0, 0, 64, 36);
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
      const grey = await lab.addFile('grey', URL.createObjectURL(blob), 'grey.png');
      const v1 = core.makeTrack('video', 0);
      const solid = (fill: string) =>
        core.makeClip('solid', v1.id, { start: 0, duration: 30, shape: { ...core.DEFAULT_SHAPE, fill } });
      const project = (toneMap: string, clip: unknown, asset?: unknown) =>
        core.applyEdits(core.emptyProject({ width: 64, height: 36, toneMap }), [
          { op: 'addTrack', track: v1 },
          ...(asset ? [{ op: 'addAsset', asset }] : []),
          { op: 'addClip', clip },
        ]);
      const centre = async (p: unknown): Promise<number> =>
        (await lab.renderFrame(p, 0)).pixels[(18 * 64 + 32) * 4];
      const out: Record<string, number[]> = {};
      for (const toneMap of ['none', 'bt2390', 'aces', 'reinhard', 'hable']) {
        out[toneMap] = [
          await centre(project(toneMap, solid('#ffffff'))),
          await centre(project(toneMap, solid('#808080'))),
          await centre(
            project(toneMap, core.makeClip('image', v1.id, { assetId: 'grey', duration: 30 }), grey),
          ),
          // The same still, declared to be S-Log3 footage.
          await centre(
            project(toneMap, core.makeClip('image', v1.id, { assetId: 'grey', duration: 30 }), {
              ...grey,
              inputColorSpace: 'slog3',
            }),
          ),
        ];
      }
      return out;
    });
    for (const toneMap of ['none', 'bt2390', 'aces', 'reinhard', 'hable']) {
      expect(r[toneMap][0], toneMap).toBe(255);
      // Within the half step of dither that an 8-bit read-back carries.
      expect(Math.abs(r[toneMap][1] - 128), toneMap).toBeLessThanOrEqual(1);
      expect(Math.abs(r[toneMap][2] - 128), toneMap).toBeLessThanOrEqual(1);
    }
    // S-Log3 code 128/255 is 0.4229 in linear light. Through the ACES curve once, sRGB-encoded,
    // that is 166; a second trip through the curve would bring it down to 158.
    const lin = Math.pow(10, ((128 / 255) * 1023 - 420) / 261.5) * 0.19 - 0.01;
    const aces = (x: number) => {
      const v = x * 0.6;
      return (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
    };
    const encoded = (v: number) => Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
    expect(encoded(aces(lin))).toBe(166);
    expect(Math.abs(r.aces[3] - 166)).toBeLessThanOrEqual(1);
    // Each operator shapes the log source differently, so the setting is still in effect there.
    expect(new Set([r.bt2390[3], r.aces[3], r.reinhard[3], r.hable[3]]).size).toBe(4);
  });

  test('a LUT on an HDR timeline keeps highlights above diffuse white', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(64, 36);
      const identity = ['LUT_3D_SIZE 2'];
      for (let b = 0; b < 2; b++)
        for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) identity.push(`${r} ${g} ${b}`);
      lab.files.set('identity', new Blob([identity.join('\n')], { type: 'text/plain' }));
      // Swaps red and blue, to show the LUT is really applied to the bright pixels too.
      const swap = ['LUT_3D_SIZE 2'];
      for (let b = 0; b < 2; b++)
        for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) swap.push(`${b} ${g} ${r}`);
      lab.files.set('swap', new Blob([swap.join('\n')], { type: 'text/plain' }));
      const v1 = core.makeTrack('video', 0);
      const project = (colorMode: string, fill: string, lutId: string | null) =>
        core.applyEdits(core.emptyProject({ width: 64, height: 36, colorMode, peakNits: 1000 }), [
          { op: 'addTrack', track: v1 },
          {
            op: 'addClip',
            clip: core.makeClip('solid', v1.id, {
              start: 0,
              duration: 30,
              shape: { ...core.DEFAULT_SHAPE, fill },
              grade: { ...core.DEFAULT_GRADE, exposure: 2, lutId },
            }),
          },
        ]);
      const luma = async (lutId: string | null): Promise<number> => {
        await lab.renderFrame(project('hdr-pq', '#ffffff', lutId), 0);
        return lab.compositor.readYuv10('pq')[18 * 64 + 32];
      };
      const sdr = async (lutId: string | null): Promise<number[]> => {
        const f = await lab.renderFrame(project('sdr', '#ffa040', lutId), 0);
        return Array.from(f.pixels.slice((18 * 64 + 32) * 4, (18 * 64 + 32) * 4 + 3));
      };
      return {
        plain: await luma(null),
        identity: await luma('identity'),
        sdrPlain: await sdr(null),
        sdrIdentity: await sdr('identity'),
        sdrSwap: await sdr('swap'),
      };
    });
    // White pushed up two stops is about 814 nits: PQ luma code 703. Clamped to the LUT's top
    // entry it would be diffuse white again (code 573).
    expect(Math.abs(r.plain - 703)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.identity - r.plain)).toBeLessThanOrEqual(1);
    // Orange pushed over the top on an SDR timeline: the identity changes nothing, the swap swaps.
    for (let i = 0; i < 3; i++) expect(Math.abs(r.sdrIdentity[i] - r.sdrPlain[i])).toBeLessThanOrEqual(1);
    expect(r.sdrPlain[0]).toBeGreaterThan(r.sdrPlain[2] + 60);
    for (let i = 0; i < 3; i++) expect(Math.abs(r.sdrSwap[i] - r.sdrPlain[2 - i])).toBeLessThanOrEqual(1);
  });
});

test.describe('render engine: compositing', () => {
  test('a transition on an adjustment layer brings its look in and out', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(64, 36);
      const v1 = core.makeTrack('video', 0);
      const v2 = core.makeTrack('video', 1);
      const red = core.makeClip('solid', v1.id, {
        start: 0,
        duration: 60,
        shape: { ...core.DEFAULT_SHAPE, fill: '#ff0000' },
      });
      const project = (adjustment: unknown) =>
        core.applyEdits(core.emptyProject({ width: 64, height: 36 }), [
          { op: 'addTrack', track: v1 },
          { op: 'addTrack', track: v2 },
          { op: 'addClip', clip: red },
          { op: 'addClip', clip: core.makeClip('adjustment', v2.id, adjustment) },
        ]);
      const invert = { start: 0, duration: 60, effects: [core.makeEffect('invert')] };
      const at = async (p: unknown, frame: number, x = 32): Promise<number[]> => {
        const f = await lab.renderFrame(p, frame);
        return Array.from(f.pixels.slice((18 * 64 + x) * 4, (18 * 64 + x) * 4 + 3));
      };
      const dissolveIn = project({ ...invert, transIn: core.makeTransition('crossDissolve', 20) });
      const dissolveOut = project({ ...invert, transOut: core.makeTransition('crossDissolve', 20) });
      const wipeIn = project({ ...invert, transIn: core.makeTransition('wipe', 20) });
      const half = project({ ...invert, opacity: 0.5, transIn: core.makeTransition('crossDissolve', 20) });
      // Two looks back to back on one track, dissolving across the cut.
      const cut = core.applyEdits(core.emptyProject({ width: 64, height: 36 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addTrack', track: v2 },
        { op: 'addClip', clip: red },
        { op: 'addClip', clip: core.makeClip('adjustment', v2.id, { ...invert, duration: 30 }) },
        {
          op: 'addClip',
          clip: core.makeClip('adjustment', v2.id, {
            start: 30,
            duration: 30,
            effects: [{ ...core.makeEffect('fill'), params: { color: '#0000ff', amount: 1 } }],
            transIn: core.makeTransition('crossDissolve', 20),
          }),
        },
      ]);
      return {
        fadeIn: [
          await at(dissolveIn, 0),
          await at(dissolveIn, 10),
          await at(dissolveIn, 19),
          await at(dissolveIn, 20),
        ],
        fadeOut: [
          await at(dissolveOut, 39),
          await at(dissolveOut, 40),
          await at(dissolveOut, 50),
          await at(dissolveOut, 59),
        ],
        wipe: [await at(wipeIn, 10, 4), await at(wipeIn, 10, 60)],
        half: [await at(half, 10), await at(half, 30)],
        cut: [await at(cut, 15), await at(cut, 30), await at(cut, 45)],
      };
    });
    const near = (actual: number[], wanted: number[]) => {
      for (let i = 0; i < 3; i++)
        expect(Math.abs(actual[i] - wanted[i]), `${actual} ~ ${wanted}`).toBeLessThanOrEqual(2);
    };
    // Red under Invert is cyan. Frame f of a 20-frame dissolve is (f + 1) / 21 of the way there.
    const mix = (t: number) => [255 * (1 - t), 255 * t, 255 * t];
    near(r.fadeIn[0], mix(1 / 21));
    near(r.fadeIn[1], mix(11 / 21));
    near(r.fadeIn[2], mix(20 / 21));
    near(r.fadeIn[3], mix(1));
    near(r.fadeOut[0], mix(1));
    near(r.fadeOut[1], mix(20 / 21));
    near(r.fadeOut[2], mix(10 / 21));
    near(r.fadeOut[3], mix(1 / 21));
    // A wipe shows the look on the side it has already crossed.
    near(r.wipe[0], mix(1));
    near(r.wipe[1], mix(0));
    // The layer's own opacity still applies on top of the transition.
    near(r.half[0], mix((11 / 21) * 0.5));
    near(r.half[1], mix(0.5));
    // Invert (cyan) dissolving into a blue overlay.
    near(r.cut[0], [0, 255, 255]);
    near(r.cut[1], [0, 255 * (1 - 11 / 21), 255]);
    near(r.cut[2], [0, 0, 255]);
  });

  test('wide blurs fall off smoothly at 4K', async ({ page }) => {
    test.slow();
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      // A white bar on black, taller than the frame, so the picture only varies along x.
      const bar = (W: number, H: number, width: number, effect: unknown) => {
        const v1 = core.makeTrack('video', 0);
        return core.applyEdits(core.emptyProject({ width: W, height: H, background: '#000000' }), [
          { op: 'addTrack', track: v1 },
          {
            op: 'addClip',
            clip: core.makeClip('shape', v1.id, {
              start: 0,
              duration: 30,
              fit: 'none',
              shape: { ...core.DEFAULT_SHAPE, fill: '#ffffff', w: width / W, h: 1.2 },
              effects: [effect],
            }),
          },
        ]);
      };
      const erf = (x: number) => {
        const t = 1 / (1 + 0.3275911 * Math.abs(x));
        const y =
          1 -
          ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.exp(-x * x);
        return x < 0 ? -y : y;
      };
      // Worst difference from an ideal gaussian of `sigma`, over the row `y`, in 8-bit steps.
      const worst = (f: any, y: number, width: number, sigma: number) => {
        let max = 0;
        for (let x = 0; x < f.width; x++) {
          const d = x + 0.5 - f.width / 2;
          const ideal =
            127.5 *
            (erf((d + width / 2) / (sigma * Math.SQRT2)) - erf((d - width / 2) / (sigma * Math.SQRT2)));
          max = Math.max(max, Math.abs(f.pixels[(y * f.width + x) * 4] - ideal));
        }
        return max;
      };
      const out: Record<string, number> = {};
      const run = async (
        name: string,
        W: number,
        H: number,
        id: string,
        params: object,
        width: number,
        y: number,
        sigma: number,
      ) => {
        lab.init(W, H);
        const fx = core.makeEffect(id);
        Object.assign(fx.params, params);
        const f = await lab.renderFrame(bar(W, H, width, fx), 0);
        out[name] = worst(f, y, width, sigma);
        out[`${name} peak`] = f.pixels[(y * W + W / 2) * 4];
        return f;
      };
      // Radius is in 1080p pixels and sigma is half of it: 200 px of sigma on a 2160p frame.
      await run('gaussian 200', 3840, 2160, 'gaussianBlur', { radius: 200 }, 24, 1080, 200);
      await run('gaussian 100', 3840, 2160, 'gaussianBlur', { radius: 100 }, 24, 1080, 100);
      // Tilt-shift is fully blurred near the top edge and must stay sharp in the focus band.
      const tilt = async (name: string, W: number, H: number, blur: number, sigma: number) => {
        const f = await run(name, W, H, 'tiltShift', { blur }, 4, Math.round(H * 0.03), sigma);
        const o = ((H / 2) * W + W / 2) * 4;
        out[`${name} focus`] =
          Math.min(f.pixels[o - 4], f.pixels[o]) - Math.max(f.pixels[o - 16], f.pixels[o + 12]);
      };
      await tilt('tilt 4K', 3840, 2160, 16, 16);
      await tilt('tilt wide', 1920, 1080, 60, 30);
      await tilt('tilt default', 1920, 1080, 16, 8);
      return out;
    });
    // Under-sampled, these came out as stripes: up to 15 steps away from the curve.
    expect(r['gaussian 200']).toBeLessThanOrEqual(2);
    expect(r['gaussian 100']).toBeLessThanOrEqual(2);
    expect(r['gaussian 200 peak']).toBeGreaterThanOrEqual(10);
    expect(r['tilt 4K']).toBeLessThanOrEqual(2.5);
    expect(r['tilt wide']).toBeLessThanOrEqual(2.5);
    expect(r['tilt default']).toBeLessThanOrEqual(2.5);
    for (const name of ['tilt 4K', 'tilt wide', 'tilt default'])
      expect(r[`${name} focus`], name).toBeGreaterThan(240);
  });

  test('text and shapes too large for a texture keep their proportions and their layout size', async ({
    page,
  }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core, engine } = lab;
      const credits = {
        ...core.DEFAULT_TEXT,
        content: Array.from({ length: 70 }, (_, i) => `Credit line ${i + 1}`).join('\n'),
        size: 0.05,
        bg: { ...core.DEFAULT_TEXT.bg, enabled: true, color: '#ff0000', opacity: 1, radius: 0 },
      };
      // Size of the opaque background box, measured in the raster's own pixels.
      const box = (raster: any) => {
        const ctx = raster.canvas.getContext('2d');
        const { width, height } = raster.canvas;
        const row = ctx.getImageData(0, height >> 1, width, 1).data;
        const col = ctx.getImageData(width >> 1, 0, 1, height).data;
        let w = 0;
        let h = 0;
        for (let x = 0; x < width; x++) if (row[x * 4 + 3] > 128) w++;
        for (let y = 0; y < height; y++) if (col[y * 4 + 3] > 128) h++;
        return { w, h };
      };
      const describe = (raster: any) => ({
        width: raster.width,
        height: raster.height,
        canvasWidth: raster.canvas.width,
        canvasHeight: raster.canvas.height,
        box: box(raster),
      });
      const v1 = core.makeTrack('video', 0);
      const clip = core.makeClip('text', v1.id, { start: 0, duration: 30, fit: 'none', text: credits });
      const p = core.applyEdits(core.emptyProject({ width: 3840, height: 2160 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addClip', clip },
      ]);
      return {
        hd: describe(engine.rasterizeText(credits, 1920, 1080)),
        uhd: describe(engine.rasterizeText(credits, 3840, 2160)),
        shadowed: describe(
          engine.rasterizeText({ ...credits, shadow: { ...credits.shadow, enabled: true } }, 3840, 2160),
        ),
        ellipse: (() => {
          const raster = engine.rasterizeShape(
            { ...core.DEFAULT_SHAPE, kind: 'ellipse', w: 1.2, h: 0.2 },
            7680,
            4320,
          );
          return {
            ...describe(raster),
            small: describe(
              engine.rasterizeShape({ ...core.DEFAULT_SHAPE, kind: 'ellipse', w: 1.2, h: 0.2 }, 1920, 1080),
            ),
          };
        })(),
        measured: engine.measureClip(clip, p),
      };
    });
    // The 2160p block is the 1080p block at twice the size, even though it cannot be drawn that large.
    expect(Math.abs(r.uhd.height - 2 * r.hd.height)).toBeLessThanOrEqual(4);
    expect(Math.abs(r.uhd.width - 2 * r.hd.width)).toBeLessThanOrEqual(4);
    expect(r.uhd.height).toBeGreaterThan(8192);
    expect(r.uhd.canvasHeight).toBeLessThanOrEqual(8192);
    const shape = (b: { w: number; h: number }) => b.w / b.h;
    expect(Math.abs(shape(r.uhd.box) / shape(r.hd.box) - 1)).toBeLessThan(0.01);
    expect(Math.abs(r.uhd.canvasWidth / r.uhd.canvasHeight / (r.uhd.width / r.uhd.height) - 1)).toBeLessThan(
      0.01,
    );
    expect(Math.abs(shape(r.shadowed.box) / shape(r.hd.box) - 1)).toBeLessThan(0.01);
    // The transform handles and the compositor lay out the same box.
    expect(r.measured).toEqual({ w: r.uhd.width, h: r.uhd.height });
    expect(r.ellipse.width).toBeGreaterThan(8192);
    expect(r.ellipse.canvasWidth).toBeLessThanOrEqual(8192);
    expect(Math.abs(shape(r.ellipse.box) / shape(r.ellipse.small.box) - 1)).toBeLessThan(0.01);
  });

  test('a title is measured again once its font has loaded', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core, engine } = lab;
      // The editor's title faces: registered up front, fetched on first use.
      await lab.registerTitleFonts();
      const v1 = core.makeTrack('video', 0);
      const clip = core.makeClip('text', v1.id, {
        start: 0,
        duration: 30,
        fit: 'none',
        text: { ...core.DEFAULT_TEXT, content: 'OPENING TITLE SEQUENCE', font: 'Bebas Neue', weight: 400 },
      });
      const p = core.applyEdits(core.emptyProject({ width: 1920, height: 1080 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addClip', clip },
      ]);
      const spec = engine.fontSpec(clip.text, 32);
      const loadedBefore = document.fonts.check(spec, clip.text.content);
      let notified = 0;
      const stop = engine.onFontsLoaded(() => notified++);
      const epoch = engine.fontEpoch();
      const before = engine.measureClip(clip, p);
      await document.fonts.load(spec, clip.text.content);
      await new Promise((res) => setTimeout(res, 50));
      const after = engine.measureClip(clip, p);
      const raster = engine.rasterizeText(clip.text, 1920, 1080);
      stop();
      return {
        loadedBefore,
        loadedAfter: document.fonts.check(spec, clip.text.content),
        before,
        after,
        raster: { w: raster.width, h: raster.height },
        notified,
        epochs: engine.fontEpoch() - epoch,
      };
    });
    expect(r.loadedBefore).toBe(false);
    expect(r.loadedAfter).toBe(true);
    expect(r.notified).toBeGreaterThanOrEqual(1);
    expect(r.epochs).toBeGreaterThanOrEqual(1);
    // Bebas Neue is a condensed face: the fallback measured far wider.
    expect(r.before.w).toBeGreaterThan(r.after.w * 1.2);
    expect(r.after).toEqual(r.raster);
  });
});

test.describe('render engine: effect library', () => {
  test('preview parameters give neutral-by-default effects a picture of their own', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(() => {
      const { lab } = window as any;
      const { core, engine } = lab;
      // The library's thumbnail pipeline in miniature: one sample picture, one pass through the effect.
      const W = 160;
      const H = 90;
      const sample = new OffscreenCanvas(W, H);
      const g = sample.getContext('2d')!;
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#1b2a6b');
      sky.addColorStop(0.55, '#e0568a');
      sky.addColorStop(1, '#ffb347');
      g.fillStyle = sky;
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#fff4c2';
      g.beginPath();
      g.arc(112, 40, 14, 0, Math.PI * 2);
      g.fill();
      const canvas = new OffscreenCanvas(W, H);
      const gl = canvas.getContext('webgl2')!;
      const glx = new engine.Glx(gl, false);
      const tex = glx.createTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, sample);
      const render = (def: any, values: unknown): Uint8Array => {
        const out = engine.runEffect(
          glx,
          def,
          core.resolveParams(def.params, values),
          { tex, width: W, height: H },
          { px: (H / 1080) * 4, time: 0.6, frame: 14, seed: 0.37, lumaW: [0.2126, 0.7152, 0.0722] },
        );
        const px = new Uint8Array(W * H * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        glx.release(out);
        return px;
      };
      const distance = (a: Uint8Array, b: Uint8Array) => {
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length;
      };
      const untouched = render(
        { id: 'none', params: [], passes: [{ glsl: 'vec4 effect(vec2 uv) { return src(uv); }' }] },
        {},
      );
      const previewed = core.EFFECTS.filter((def: any) => def.preview);
      const pictures = new Map<string, Uint8Array>(
        previewed.map((def: any) => [def.id, render(def, core.previewParams(def))]),
      );
      const adjustments = ['brightnessContrast', 'exposure', 'hueSaturation', 'temperature', 'levels'];
      let closestPair = Infinity;
      for (const a of adjustments)
        for (const b of adjustments)
          if (a < b) closestPair = Math.min(closestPair, distance(pictures.get(a)!, pictures.get(b)!));
      return {
        ids: previewed.map((def: any) => def.id),
        fromUntouched: previewed.map((def: any) => distance(untouched, pictures.get(def.id)!)),
        defaults: adjustments.map((id) => {
          const def = core.getEffectDef(id);
          return distance(untouched, render(def, core.defaultParams(def.params)));
        }),
        closestPair,
        fill: Array.from(pictures.get('fill')!.slice(0, 3)),
      };
    });
    expect(r.ids).toEqual(
      expect.arrayContaining([
        'brightnessContrast',
        'exposure',
        'hueSaturation',
        'temperature',
        'levels',
        'fill',
      ]),
    );
    // With their defaults these five return the sample untouched, which is why they need a preview.
    expect(r.defaults).toEqual([0, 0, 0, 0, 0]);
    for (let i = 0; i < r.ids.length; i++) {
      // Mean difference over the whole tile; an effect that only touches edges (Sharpen) moves it less.
      expect(r.fromUntouched[i], r.ids[i]).toBeGreaterThan(r.ids[i] === 'sharpen' ? 0.5 : 3);
    }
    expect(r.closestPair).toBeGreaterThan(3);
    // Color Overlay tints the picture instead of replacing it with a white tile.
    expect(Math.max(...r.fill) - Math.min(...r.fill)).toBeGreaterThan(40);
  });
});

test.describe('render engine: losing the graphics context', () => {
  test('the player draws again after the context is restored, with effects added meanwhile', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core, engine } = lab;
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const v1 = core.makeTrack('video', 0);
      const solid = core.makeClip('solid', v1.id, {
        start: 0,
        duration: 60,
        shape: { ...core.DEFAULT_SHAPE, fill: '#ff0000' },
      });
      const red = core.applyEdits(core.emptyProject({ width: 320, height: 180 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addClip', clip: solid },
      ]);
      const inverted = core.applyEdits(red, [
        { op: 'updateClip', id: solid.id, patch: { effects: [core.makeEffect('invert')] } },
      ]);
      const player = new engine.Player(canvas, red, lab.resolver);
      player.setViewport(320, 180, 1);
      const until = async (what: string, test: () => boolean) => {
        const t0 = performance.now();
        while (!test()) {
          if (performance.now() - t0 > 10_000) throw new Error(`timed out waiting for ${what}`);
          await new Promise((res) => setTimeout(res, 20));
        }
      };
      const centre = (): number[] => {
        const px: Uint8Array = player.compositor.readPixels();
        const o = (90 * player.compositor.width + (player.compositor.width >> 1)) * 4;
        return [px[o], px[o + 1], px[o + 2]];
      };
      await until('the first frame', () => centre()[0] > 250);
      const first = centre();

      const before = player.compositor;
      const lose = before.gl.getExtension('WEBGL_lose_context');
      const seen: boolean[] = [];
      player.subscribe(() => seen.push(player.contextLost));
      lose.loseContext();
      await until('the loss to be noticed', () => player.contextLost);
      // An effect arrives while there is no context; the idle shader warm-up gets a chance to run.
      player.setProject(inverted);
      await new Promise((res) => setTimeout(res, 300));
      const stillLost = player.contextLost;
      lose.restoreContext();
      await until('the context to come back', () => !player.contextLost);
      await until('a frame on the new context', () => centre()[1] > 250);
      const restored = centre();
      const glError = player.compositor.gl.getError();
      const rebuilt = player.compositor !== before;
      player.dispose();
      canvas.remove();

      // A shader that could not compile on the dead context must not stay disabled elsewhere.
      const png: Blob = await engine.renderStill(inverted, lab.resolver, 0);
      const bmp = await createImageBitmap(png);
      const c2 = document.createElement('canvas');
      c2.width = bmp.width;
      c2.height = bmp.height;
      const g = c2.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const still = Array.from(g.getImageData(160, 90, 1, 1).data.slice(0, 3));
      return { first, stillLost, restored, seen, glError, rebuilt, still };
    });
    expect(r.first).toEqual([255, 0, 0]);
    expect(r.stillLost).toBe(true);
    expect(r.rebuilt).toBe(true);
    expect(r.seen).toEqual([true, false]);
    expect(r.restored).toEqual([0, 255, 255]);
    expect(r.glError).toBe(0);
    expect(r.still).toEqual([0, 255, 255]);
    expect(errors).toEqual([]);
  });

  for (const dynamicRange of ['sdr', 'pq'] as const) {
    test(`an export fails loudly when the context is lost part-way (${dynamicRange})`, async ({ page }) => {
      await openLab(page);
      const r = await page.evaluate(async (dynamicRange) => {
        const { lab } = window as any;
        const { core, engine } = lab;
        const v1 = core.makeTrack('video', 0);
        const p = core.applyEdits(
          core.emptyProject({
            width: 320,
            height: 180,
            colorMode: dynamicRange === 'sdr' ? 'sdr' : 'hdr-pq',
          }),
          [
            { op: 'addTrack', track: v1 },
            {
              op: 'addClip',
              clip: core.makeClip('solid', v1.id, {
                start: 0,
                duration: 40,
                shape: { ...core.DEFAULT_SHAPE, fill: '#ff0000' },
              }),
            },
          ],
        );
        // The exporter makes its own off-screen context: catch it on the way out.
        const getContext = OffscreenCanvas.prototype.getContext;
        let gl: WebGL2RenderingContext | null = null;
        (OffscreenCanvas.prototype as any).getContext = function (
          this: OffscreenCanvas,
          type: string,
          ...rest: unknown[]
        ) {
          const ctx = (getContext as any).call(this, type, ...rest);
          if (type === 'webgl2') gl = ctx;
          return ctx;
        };
        let lostAt = -1;
        const phases: string[] = [];
        try {
          await engine.exportProject(
            p,
            lab.resolver,
            {
              container: 'webm',
              videoCodec: 'vp9',
              audioCodec: 'opus',
              width: 320,
              height: 180,
              fpsNum: 30,
              fpsDen: 1,
              videoBitrate: 800_000,
              audioBitrate: 96_000,
              range: null,
              includeVideo: true,
              includeAudio: false,
              dynamicRange,
              keyFrameInterval: 1,
              hardwareAcceleration: 'no-preference',
            },
            {
              onProgress: (progress: { phase: string; frame: number }) => {
                phases.push(progress.phase);
                if (progress.phase === 'rendering' && progress.frame >= 9 && lostAt < 0 && gl) {
                  lostAt = progress.frame;
                  gl.getExtension('WEBGL_lose_context')!.loseContext();
                }
              },
            },
          );
          return { lostAt, outcome: 'finished', phases: Array.from(new Set(phases)) };
        } catch (err) {
          return { lostAt, outcome: (err as Error).message, phases: Array.from(new Set(phases)) };
        } finally {
          OffscreenCanvas.prototype.getContext = getContext;
        }
      }, dynamicRange);
      expect(r.lostAt).toBeGreaterThan(0);
      expect(r.outcome).toMatch(/graphics context was lost/);
      expect(r.phases).not.toContain('done');
    });
  }
});
