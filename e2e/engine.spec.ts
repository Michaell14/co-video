import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { ffprobe, hasFfprobe, openLab, trackErrors } from './helpers';

test.describe('render engine', () => {
  test('every effect and transition shader compiles and renders without GL errors', async ({ page }) => {
    const errors = trackErrors(page);
    await openLab(page);
    const result = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(320, 180);
      const failed: string[] = lab.compileAll();
      const vid = await lab.addFile('vid', '/fixtures/testsrc.webm', 'testsrc.webm');
      const v1 = core.makeTrack('video', 0);
      const a = core.makeClip('video', v1.id, { assetId: 'vid', start: 0, duration: 30 });
      const b = core.makeClip('video', v1.id, { assetId: 'vid', start: 30, duration: 30, sourceIn: 1 });
      let p = core.applyEdits(core.emptyProject({ width: 320, height: 180 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addAsset', asset: vid },
        { op: 'addClip', clip: a },
        { op: 'addClip', clip: b },
      ]);
      const gl = lab.compositor.gl;
      const glErrors: string[] = [];
      for (const def of core.EFFECTS) {
        await lab.renderFrame(
          core.applyEdits(p, [{ op: 'updateClip', id: a.id, patch: { effects: [core.makeEffect(def.id)] } }]),
          10,
        );
        const e = gl.getError();
        if (e) glErrors.push(`${def.id}:${e}`);
      }
      for (const def of core.TRANSITIONS) {
        await lab.renderFrame(
          core.applyEdits(p, [
            { op: 'updateClip', id: b.id, patch: { transIn: core.makeTransition(def.id, 10) } },
          ]),
          30,
        );
        const e = gl.getError();
        if (e) glErrors.push(`${def.id}:${e}`);
      }
      return { failed, glErrors, effects: core.EFFECTS.length, transitions: core.TRANSITIONS.length };
    });
    expect(result.failed).toEqual([]);
    expect(result.glErrors).toEqual([]);
    expect(result.effects).toBeGreaterThanOrEqual(40);
    expect(result.transitions).toBeGreaterThanOrEqual(20);
    expect(errors).toEqual([]);
  });

  test('composites video, stills and text with correct geometry and colour', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(640, 360);
      const red = await lab.addFile('red', '/fixtures/red.webm', 'red.webm');
      const png = await lab.addFile('png', '/fixtures/green.png', 'green.png');
      const [v1, v2, v3] = [0, 1, 2].map((i) => core.makeTrack('video', i));
      const p = core.applyEdits(core.emptyProject({ width: 640, height: 360 }), [
        ...[v1, v2, v3].map((track: unknown) => ({ op: 'addTrack', track })),
        { op: 'addAsset', asset: red },
        { op: 'addAsset', asset: png },
        { op: 'addClip', clip: core.makeClip('video', v1.id, { assetId: 'red', start: 0, duration: 30 }) },
        // A square still, scaled to half and moved to the top-left quadrant.
        {
          op: 'addClip',
          clip: core.makeClip('image', v2.id, {
            assetId: 'png',
            start: 0,
            duration: 30,
            scaleX: 0.5,
            scaleY: 0.5,
            x: -0.25,
            y: -0.25,
          }),
        },
        {
          op: 'addClip',
          clip: core.makeClip('text', v3.id, {
            start: 0,
            duration: 30,
            fit: 'none',
            y: 0.25,
            text: { ...core.DEFAULT_TEXT, content: 'TANDEM', size: 0.2 },
          }),
        },
      ]);
      const f = await lab.renderFrame(p, 5);
      let white = 0;
      for (let y = 200; y < 340; y++)
        for (let x = 0; x < 640; x++)
          if (f.pixels[(y * 640 + x) * 4] > 240 && f.pixels[(y * 640 + x) * 4 + 1] > 240) white++;
      return {
        stats: f.stats,
        background: lab.sample(f.pixels, 640, 600, 20),
        still: lab.sample(f.pixels, 640, 160, 90),
        outsideStill: lab.sample(f.pixels, 640, 280, 90),
        white,
      };
    });
    expect(r.stats.missing).toBe(0);
    expect(r.background[0]).toBeGreaterThan(240); // red video
    expect(r.background[1]).toBeLessThan(40);
    expect(r.still.slice(0, 3)).toEqual([0, 254, 0]); // green still, where we put it
    expect(r.outsideStill[0]).toBeGreaterThan(240); // …and nowhere else
    expect(r.white).toBeGreaterThan(3000); // the title rasterised
  });

  test('large sources drawn small are mipmapped, not aliased', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(640, 360);
      // 1024 px of stripes with a 3 px period: point-sampling this at 1/8 size beats wildly.
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
      const v1 = core.makeTrack('video', 0);
      const p = core.applyEdits(core.emptyProject({ width: 640, height: 360 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addAsset', asset },
        {
          op: 'addClip',
          clip: core.makeClip('image', v1.id, {
            assetId: 'stripes',
            start: 0,
            duration: 30,
            fit: 'none',
            scaleX: 0.125,
            scaleY: 0.125,
          }),
        },
      ]);
      const spread = (pixels: Uint8Array) => {
        let min = 255;
        let max = 0;
        for (let x = 262; x < 378; x++) {
          const v = pixels[(180 * 640 + x) * 4];
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        return max - min;
      };
      const best = await lab.renderFrame(p, 0);
      const fast = await lab.renderFrame(p, 0, { fast: true });
      const again = await lab.renderFrame(p, 0);
      return {
        best: spread(best.pixels),
        fast: spread(fast.pixels),
        again: spread(again.pixels),
        glError: lab.compositor.gl.getError(),
      };
    });
    expect(r.glError).toBe(0);
    expect(r.fast).toBeGreaterThan(100); // plain bilinear: strong beating
    expect(r.best).toBeLessThan(r.fast / 3); // mipmapped: close to an even grey
    expect(r.again).toBe(r.best); // switching back and forth leaves no stale state
  });

  test('shows the frame that belongs to the requested time', async ({ page }) => {
    await openLab(page);
    // testsrc2 burns a moving marker into the picture; frames differ, so identical requests must
    // produce identical pixels and different times different pixels.
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core } = lab;
      lab.init(320, 180);
      const vid = await lab.addFile('vid', '/fixtures/testsrc.mp4', 'testsrc.mp4');
      const v1 = core.makeTrack('video', 0);
      const p = core.applyEdits(core.emptyProject({ width: 320, height: 180 }), [
        { op: 'addTrack', track: v1 },
        { op: 'addAsset', asset: vid },
        { op: 'addClip', clip: core.makeClip('video', v1.id, { assetId: 'vid', start: 0, duration: 120 }) },
      ]);
      const grab = async (f: number): Promise<Uint8Array> => (await lab.renderFrame(p, f)).pixels.slice();
      const diff = (a: Uint8Array, b: Uint8Array) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4)
          if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
        return n;
      };
      // Step forwards frame by frame (the export path), jump away, then come back.
      const f20 = await grab(20);
      const f21 = await grab(21);
      const f22 = await grab(22);
      const f75 = await grab(75);
      const again20 = await grab(20);
      const f19 = await grab(19);
      const again21 = await grab(21);
      return {
        step: [diff(f19, f20), diff(f20, f21), diff(f21, f22)],
        jump: diff(f20, f75),
        repeat: [diff(f20, again20), diff(f21, again21)],
      };
    });
    // Every consecutive frame is a different picture: nothing is repeated or skipped…
    for (const d of r.step) expect(d).toBeGreaterThan(500);
    expect(r.jump).toBeGreaterThan(500);
    // …and asking for the same frame twice, from either direction, gives the same pixels.
    expect(r.repeat).toEqual([0, 0]);
  });

  test('HDR timeline hands the encoder a 10-bit PQ source to within one code value', async ({ page }) => {
    await openLab(page);
    const r = await page.evaluate(async () => {
      const { lab } = window as any;
      const { core, engine } = lab;
      lab.init(640, 360);
      const hdr = await lab.addFile('hdr', '/fixtures/hdr-pq-ramp.webm', 'hdr-pq-ramp.webm');
      const v1 = core.makeTrack('video', 0);
      const p = core.applyEdits(
        core.emptyProject({ width: 640, height: 360, colorMode: 'hdr-pq', peakNits: 10000 }),
        [
          { op: 'addTrack', track: v1 },
          { op: 'addAsset', asset: hdr },
          { op: 'addClip', clip: core.makeClip('video', v1.id, { assetId: 'hdr', start: 0, duration: 30 }) },
        ],
      );
      await lab.renderFrame(p, 6);
      const yuv: Uint16Array = lab.compositor.readYuv10('pq');
      const xs = [8, 24, 40, 56, 72, 88, 104, 120, 300, 600];
      const rendered = xs.map((x) => yuv[180 * 640 + x]);
      const media = await lab.library.get('hdr');
      const sample = await new engine.VideoSampleSink(media.video).getSample(0.2);
      const buf = new Uint8Array(sample.allocationSize());
      const layout = await sample.copyTo(buf);
      const row = new Uint16Array(buf.buffer, layout[0].offset + layout[0].stride * 180, 640);
      const source = xs.map((x) => row[x]);
      const format = sample.format;
      sample.close();
      return { hdr: hdr.hdr, transfer: hdr.color?.transfer, format, source, rendered };
    });
    expect(r.hdr).toBe(true);
    expect(r.transfer).toBe('pq');
    expect(r.format).toBe('I420P10');
    expect(Math.max(...r.source) - Math.min(...r.source)).toBeGreaterThan(500); // a real ramp
    for (let i = 0; i < r.source.length; i++)
      expect(Math.abs(r.rendered[i] - r.source[i])).toBeLessThanOrEqual(1);
  });

  for (const variant of [
    // Chromium tags frames captured from an sRGB canvas with the sRGB transfer; both are valid SDR.
    {
      name: 'SDR WebM (VP9 + Opus)',
      settings: {},
      project: {},
      pix: 'yuv420p',
      transfer: /^(bt709|iec61966-2-1)$/,
    },
    {
      name: 'HDR10 (VP9 10-bit PQ)',
      settings: { dynamicRange: 'pq' },
      project: { colorMode: 'hdr-pq' },
      pix: 'yuv420p10le',
      transfer: /^smpte2084$/,
    },
    {
      name: 'HLG (VP9 10-bit)',
      settings: { dynamicRange: 'hlg', container: 'mkv' },
      project: { colorMode: 'hdr-hlg' },
      pix: 'yuv420p10le',
      transfer: /^arib-std-b67$/,
    },
  ]) {
    test(`exports ${variant.name}`, async ({ page }, info) => {
      await openLab(page);
      const out = await page.evaluate(
        async ({ settings, project }) => {
          const { lab } = window as any;
          const { core } = lab;
          const vid = await lab.addFile('vid', '/fixtures/testsrc.webm', 'testsrc.webm');
          const v1 = core.makeTrack('video', 0);
          const v2 = core.makeTrack('video', 1);
          const a1 = core.makeTrack('audio', 0);
          const p = core.applyEdits(core.emptyProject({ width: 320, height: 180, ...project }), [
            ...[v1, v2, a1].map((track: unknown) => ({ op: 'addTrack', track })),
            { op: 'addAsset', asset: vid },
            {
              op: 'addClip',
              clip: core.makeClip('video', v1.id, { assetId: 'vid', start: 0, duration: 20 }),
            },
            {
              op: 'addClip',
              clip: core.makeClip('video', v1.id, {
                assetId: 'vid',
                start: 20,
                duration: 25,
                sourceIn: 1,
                transIn: core.makeTransition('crossDissolve', 8),
              }),
            },
            {
              op: 'addClip',
              clip: core.makeClip('text', v2.id, {
                start: 5,
                duration: 30,
                fit: 'none',
                text: { ...core.DEFAULT_TEXT, content: 'Export' },
              }),
            },
            {
              op: 'addClip',
              clip: core.makeClip('audio', a1.id, {
                assetId: 'vid',
                start: 0,
                duration: 45,
                fadeIn: 5,
                fadeOut: 5,
              }),
            },
          ]);
          return lab.exportBase64(p, {
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
            includeAudio: true,
            dynamicRange: 'sdr',
            keyFrameInterval: 1,
            hardwareAcceleration: 'no-preference',
            ...settings,
          });
        },
        { settings: variant.settings, project: variant.project },
      );
      expect(out.frames).toBe(45);
      expect(out.phases).toContain('done');
      test.skip(!hasFfprobe(), 'ffprobe not installed: skipping container inspection');
      const file = info.outputPath(`out${out.extension}`);
      writeFileSync(file, Buffer.from(out.base64, 'base64'));
      const probe = ffprobe(file);
      const video = probe.streams.find((s) => s.codec_type === 'video')!;
      const audio = probe.streams.find((s) => s.codec_type === 'audio')!;
      expect(video.codec_name).toBe('vp9');
      expect(Number(video.nb_read_frames)).toBe(45);
      expect(video.pix_fmt).toBe(variant.pix);
      expect(video.color_transfer).toMatch(variant.transfer);
      expect(audio.codec_name).toBe('opus');
      expect(Number(probe.format.duration)).toBeGreaterThan(1.4);
    });
  }
});
