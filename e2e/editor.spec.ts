import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { clips, FIXTURES, ffprobe, hasFfprobe, importFixtures, newProject, trackErrors } from './helpers';

async function buildEdit(page: import('@playwright/test').Page) {
  await importFixtures(page, ['testsrc.mp4', 'testsrc.webm', 'tone.ogg', 'warm.cube']);
  await page.evaluate(() => {
    const { session, cmd } = (window as any).tandem;
    const by = (n: string) => Object.values(session.store.get().assets).find((a: any) => a.name === n);
    cmd.seek(0);
    cmd.addAsset(by('testsrc.mp4'));
    cmd.addAsset(by('testsrc.webm'));
    cmd.seek(30);
    cmd.addText({ content: 'Tandem' });
    cmd.seek(0);
  });
  await page.keyboard.press('Shift+z');
}

test.describe('editor', () => {
  test('imports media, builds a timeline, and survives a reload', async ({ page }) => {
    const errors = trackErrors(page);
    await newProject(page);
    await buildEdit(page);
    expect(await clips(page)).toEqual([
      'audio@0+120',
      'audio@120+120',
      'text@30+150',
      'video@0+120',
      'video@120+120',
    ]);
    await expect(page.locator('.clip')).toHaveCount(5);
    await expect(page.locator('.asset')).toHaveCount(4);

    // Everything is persisted locally (IndexedDB + OPFS): reload and it is all still there.
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).tandem?.session?.player);
    expect(await clips(page)).toHaveLength(5);
    const local = await page.evaluate(() => {
      const s = (window as any).tandem.session;
      return Object.values(s.store.get().assets).every((a: any) => s.media.get(a.id).local);
    });
    expect(local).toBe(true);
    expect(errors).toEqual([]);
  });

  test('plays in real time and stops at the end', async ({ page }) => {
    await newProject(page);
    await buildEdit(page);
    await page.keyboard.press('Space');
    // Time the run inside the page: the harness can be late to look, the clock must not be wrong.
    const run = await page.evaluate(async () => {
      const player = (window as any).tandem.session.player;
      const t0 = performance.now();
      const f0 = player.getFrame();
      await new Promise((r) => setTimeout(r, 1500));
      return {
        frames: player.getFrame() - f0,
        seconds: (performance.now() - t0) / 1000,
        playing: player.getState().playing,
      };
    });
    expect(run.playing).toBe(true);
    // A 30 fps timeline advances 30 frames a second: never faster, and only a start-up beat slower.
    expect(run.frames / run.seconds).toBeGreaterThan(20);
    expect(run.frames / run.seconds).toBeLessThan(33);
    await page.keyboard.press('Space');
    await page.keyboard.press('End');
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({
      playing: (window as any).tandem.session.player.getState().playing,
      frame: (window as any).tandem.session.player.getFrame(),
    }));
    // Play from the very end wraps to the start rather than doing nothing.
    expect(state.playing).toBe(true);
    expect(state.frame).toBeLessThan(60);
  });

  test('drag, trim, split and undo with the mouse and keyboard', async ({ page }) => {
    await newProject(page);
    await buildEdit(page);
    const before = await clips(page);

    // Drag the first video clip to the right: its linked audio follows, and it overwrites what it lands on.
    const first = page.locator('.clip[data-type="video"]').first();
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const moved = await clips(page);
    expect(moved).not.toEqual(before);
    const video = moved.filter((c) => c.startsWith('video@'));
    const audio = moved.filter((c) => c.startsWith('audio@'));
    expect(video.map((c) => c.slice(5))).toEqual(audio.map((c) => c.slice(5))); // A/V stayed in sync
    const overlaps = await page.evaluate(() => {
      const p = (window as any).tandem.session.store.get();
      const byTrack: Record<string, any[]> = {};
      for (const c of Object.values(p.clips) as any[]) (byTrack[c.trackId] ??= []).push(c);
      return Object.values(byTrack).some((list) =>
        list
          .sort((a, b) => a.start - b.start)
          .some((c, i) => i > 0 && c.start < list[i - 1].start + list[i - 1].duration),
      );
    });
    expect(overlaps).toBe(false);

    await page.keyboard.press('Control+z');
    expect(await clips(page)).toEqual(before);

    // Trim the tail of the first clip.
    const b2 = (await page.locator('.clip[data-type="video"]').first().boundingBox())!;
    await page.mouse.move(b2.x + b2.width - 3, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width - 50, b2.y + b2.height / 2, { steps: 5 });
    await page.mouse.up();
    const trimmed = await clips(page);
    const dur = Number(trimmed.find((c) => c.startsWith('video@0+'))!.split('+')[1]);
    expect(dur).toBeLessThan(120);
    expect(trimmed).toContain(`audio@0+${dur}`);

    // Split under the playhead.
    await page.evaluate(() => (window as any).tandem.cmd.seek(20));
    await page.keyboard.press('Control+b');
    expect(await clips(page)).toHaveLength(7);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await clips(page)).toEqual(before);
    await page.keyboard.press('Control+Shift+z');
    expect(await clips(page)).toEqual(trimmed);
  });

  test('freeze frame, drag to a new track, and replace media', async ({ page }) => {
    const errors = trackErrors(page);
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addAsset(Object.values(session.store.get().assets)[0]);
    });
    await page.keyboard.press('Shift+z');
    const frameHash = (f: number) =>
      page.evaluate(async (frame) => {
        const { cmd, session } = (window as any).tandem;
        cmd.seek(frame);
        // Wait until the decoder has delivered this frame and it has been drawn.
        await new Promise((r) => setTimeout(r, 900));
        const d: Uint8Array = session.player.compositor.readPixels();
        let h = 0;
        for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
        return h;
      }, f);

    // Freeze: two seconds of hold at the playhead, everything after ripples right.
    await page.evaluate(() => (window as any).tandem.cmd.seek(45));
    await page.keyboard.press('Shift+f');
    expect(await clips(page)).toEqual([
      'audio@0+45',
      'audio@105+75',
      'video@0+45',
      'video@105+75',
      'video@45+60',
    ]);
    const [at, mid, end, after] = [
      await frameHash(45),
      await frameHash(70),
      await frameHash(104),
      await frameHash(120),
    ];
    expect(mid).toBe(at);
    expect(end).toBe(at);
    expect(after).not.toBe(at);
    await page.keyboard.press('Control+z');
    expect(await clips(page)).toEqual(['audio@0+120', 'video@0+120']);

    // Dragging a clip above the top lane creates a track for it.
    const videoTracks = () =>
      page.evaluate(
        () =>
          Object.values((window as any).tandem.session.store.get().tracks).filter(
            (t: any) => t.kind === 'video',
          ).length,
      );
    const before = await videoTracks();
    const box = (await page.locator('.clip[data-type="video"]').first().boundingBox())!;
    const ruler = (await page.locator('.ruler').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 10, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2, ruler.y + ruler.height / 2, { steps: 6 });
    await page.mouse.up();
    expect(await videoTracks()).toBe(before + 1);
    const onTop = await page.evaluate(() => {
      const p = (window as any).tandem.session.store.get();
      const top = Object.values(p.tracks)
        .filter((t: any) => t.kind === 'video')
        .sort((a: any, b: any) => b.order - a.order)[0] as any;
      return Object.values(p.clips)
        .filter((c: any) => c.type === 'video')
        .every((c: any) => c.trackId === top.id);
    });
    expect(onTop).toBe(true);

    // Replace media: the clips follow the new file, in one undoable step.
    const oldId = await page.evaluate(
      () => Object.keys((window as any).tandem.session.store.get().assets)[0],
    );
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.evaluate((id) => void (window as any).tandem.cmd.replaceMedia(id), oldId),
    ]);
    await chooser.setFiles(join(FIXTURES, 'testsrc.webm'));
    await page.waitForFunction((id) => !(window as any).tandem.session.store.get().assets[id], oldId);
    const repointed = await page.evaluate(() => {
      const p = (window as any).tandem.session.store.get();
      const [asset] = Object.values(p.assets) as any[];
      return { name: asset.name, all: Object.values(p.clips).every((c: any) => c.assetId === asset.id) };
    });
    expect(repointed).toEqual({ name: 'testsrc.webm', all: true });
    await page.keyboard.press('Control+z');
    expect(await page.evaluate((id) => !!(window as any).tandem.session.store.get().assets[id], oldId)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });

  test('proxy media stands in for the preview and never for the export', async ({ page }) => {
    const errors = trackErrors(page);
    await newProject(page);
    await importFixtures(page, ['large.mp4']);
    // Footage beyond 1080p prompts the offer.
    await expect(page.locator('.toast', { hasText: 'Proxies make it lighter to edit' })).toBeVisible();
    const sample = (frame: number) =>
      page.evaluate(async (f) => {
        const { cmd, session } = (window as any).tandem;
        cmd.seek(f);
        await new Promise((r) => setTimeout(r, 1200));
        const d: Uint8Array = session.player.compositor.readPixels();
        const cur: any = Array.from(session.player.sources.cursors.values()).pop();
        return {
          px: Array.from(d.filter((_, i) => i % 53 === 0)),
          tex: `${cur.width}x${cur.height}`,
          scale: cur.scale as number,
        };
      }, frame);
    const diff = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      session.setProxies(false);
      session.player.setQuality(0.5);
      cmd.seek(0);
      cmd.addAsset(Object.values(session.store.get().assets)[0]);
      // Native-size layout is where a smaller texture would show if it leaked into geometry.
      const clip: any = Object.values(session.store.get().clips).find((c: any) => c.type === 'video');
      session.store.commit([
        { op: 'updateClip', id: clip.id, patch: { fit: 'none', scaleX: 0.6, scaleY: 0.6, x: 0.1 } },
      ]);
    });
    const original = await sample(12);
    expect(original.tex).toBe('1600x1200');

    await page.evaluate(() => (window as any).tandem.cmd.createProxies());
    await page.waitForFunction(
      () => {
        const s = (window as any).tandem.session;
        return s.media.get(Object.keys(s.store.get().assets)[0]).proxy;
      },
      null,
      { timeout: 90_000 },
    );
    await expect(page.locator('.asset__proxy')).toBeVisible();
    const proxied = await sample(12);
    expect(proxied.tex).toBe('720x540');
    expect(proxied.scale).toBeCloseTo(1600 / 720, 3);
    // Same picture, same place (only encoding loss between them).
    expect(diff(original.px, proxied.px)).toBeLessThan(4);

    const locations = await page.evaluate(async () => {
      const s = (window as any).tandem.session;
      const id = Object.keys(s.store.get().assets)[0];
      return {
        preview: !!(await s.previewResolver()(id)).proxy,
        export: !!(await s.exportResolver()(id)).proxy,
      };
    });
    expect(locations).toEqual({ preview: true, export: false });

    // Switching proxies off goes straight back to the original.
    await page.evaluate(() => (window as any).tandem.session.setProxies(false));
    expect((await sample(12)).tex).toBe('1600x1200');
    await page.evaluate(() => (window as any).tandem.session.setProxies(true));
    expect(errors).toEqual([]);
  });

  test('records a voiceover onto a free audio track', async ({ page }) => {
    const errors = trackErrors(page);
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addAsset(Object.values(session.store.get().assets)[0]);
      cmd.seek(15);
    });
    // Chromium's fake capture device stands in for the microphone (see playwright.config.ts).
    await page.getByRole('button', { name: 'Record voiceover' }).click();
    await expect(page.locator('.rec')).toBeVisible();
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().playing)).toBe(true);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Shift+r');
    await page.waitForFunction(
      () => Object.values((window as any).tandem.session.store.get().clips).length === 3,
    );
    const take = await page.evaluate(async () => {
      const s = (window as any).tandem.session;
      const p = s.store.get();
      const asset: any = Object.values(p.assets).find((a: any) => a.name === 'Voiceover 1.wav');
      const clip: any = Object.values(p.clips).find((c: any) => c.assetId === asset.id);
      const alone = Object.values(p.clips).filter((c: any) => c.trackId === clip.trackId).length === 1;
      const loc = await s.exportResolver()(asset.id);
      const audio = await new AudioContext().decodeAudioData(await loc.blob.arrayBuffer());
      let peak = 0;
      for (const v of audio.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
      return {
        kind: asset.kind,
        seconds: audio.duration,
        start: clip.start,
        type: clip.type,
        alone,
        peak,
        playing: s.player.getState().playing,
      };
    });
    expect(take.kind).toBe('audio');
    expect(take.type).toBe('audio');
    expect(take.start).toBe(15); // where the playhead was when recording began
    expect(take.alone).toBe(true); // never recorded over existing sound
    expect(take.seconds).toBeGreaterThan(1);
    expect(take.peak).toBeGreaterThan(0.05); // the fake device beeps: this is not silence
    expect(take.playing).toBe(false);
    await expect(page.locator('.rec')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('normalises clip loudness to a LUFS target', async ({ page }) => {
    const errors = trackErrors(page);
    await newProject(page);
    await importFixtures(page, ['tone.ogg']);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      cmd.seek(0);
      cmd.addAsset(Object.values(session.store.get().assets)[0]);
      ui.getState().select(Object.keys(session.store.get().clips));
    });
    await page.evaluate(() => (window as any).tandem.cmd.normalizeLoudness(-14));
    const volume = () =>
      page.evaluate(
        () => (Object.values((window as any).tandem.session.store.get().clips)[0] as any).volume as number,
      );
    // `ffmpeg -af ebur128` measures this fixture at −21.1 LUFS, so −14 needs +7.1 dB.
    expect(await volume()).toBeCloseTo(7.1, 1);
    await page.keyboard.press('Control+z');
    expect(await volume()).toBe(0);
    expect(errors).toEqual([]);
  });

  test('feature sweep produces no runtime or GL errors', async ({ page }) => {
    const errors = trackErrors(page);
    await newProject(page);
    await buildEdit(page);
    const result = await page.evaluate(async () => {
      const { session, cmd, ui } = (window as any).tandem;
      const store = session.store;
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const videos = () =>
        (Object.values(store.get().clips) as any[])
          .filter((c) => c.type === 'video')
          .sort((a, b) => a.start - b.start);
      const out: Record<string, unknown> = {};

      cmd.importSubtitles(
        '1\n00:00:00,500 --> 00:00:02,000\nHello\n\n2\n00:00:02,200 --> 00:00:03,800\nWorld\n',
      );
      out.captions = (Object.values(store.get().clips) as any[]).filter((c) => c.type === 'text').length;

      const v = videos()[0];
      ui.getState().select([v.id]);
      const lut = (Object.values(store.get().assets) as any[]).find((a) => a.kind === 'lut');
      cmd.applyLut(lut.id);
      cmd.applyEffect('glow');
      cmd.applyEffect('chromaKey');
      store.commit([
        {
          op: 'updateClip',
          id: v.id,
          patch: {
            mask: {
              type: 'ellipse',
              x: 0.5,
              y: 0.5,
              w: 0.7,
              h: 0.7,
              rotation: 10,
              feather: 0.1,
              radius: 0,
              invert: false,
            },
            blend: 'screen',
            cropL: 0.1,
            flipH: true,
            rotation: 12,
            keyframes: {
              opacity: [
                { t: 0, v: 0, e: 'easeInOut' },
                { t: 30, v: 1, e: 'linear' },
              ],
            },
          },
        },
      ]);
      cmd.seek(15);
      await wait(700);
      out.lutLoaded = !!session.player.sources.getLut(lut.id);

      ui.getState().select([videos()[1].id]);
      cmd.setSpeed(2, true);
      cmd.applyTransition('push', videos()[1].id, 'in');
      cmd.applyTransition('dipToBlack', videos()[1].id, 'out');
      cmd.seek(videos()[1].start);
      await wait(500);

      cmd.seek(300);
      cmd.addShape({ kind: 'star' });
      cmd.addSolid('#223355');
      cmd.addAdjustment();
      cmd.seek(310);
      await wait(300);

      cmd.seek(40);
      cmd.addMarker();
      cmd.markIn();
      cmd.seek(90);
      cmd.markOut();
      cmd.toggleLoop();
      cmd.seek(40);
      cmd.togglePlay();
      await wait(900);
      cmd.togglePlay();
      cmd.clearRange();
      cmd.toggleLoop();

      cmd.seek(100);
      cmd.shuttle(-1);
      await wait(600);
      out.reverseFrame = session.player.getFrame();
      cmd.shuttle(0);

      store.commit([{ op: 'settings', patch: { colorMode: 'hdr-pq', toneMap: 'bt2390' } }]);
      cmd.seek(30);
      await wait(500);
      const scope = await session.player.readScope(128);
      out.hdrScope = scope ? scope.pq : null;
      store.commit([
        { op: 'settings', patch: { colorMode: 'sdr', toneMap: 'none', width: 1080, height: 1920 } },
      ]);
      await wait(400);

      const before = Object.keys(store.get().clips).length;
      for (let i = 0; i < 8; i++) cmd.undo();
      for (let i = 0; i < 8; i++) cmd.redo();
      out.undoRedoStable = Object.keys(store.get().clips).length === before;
      out.glError = session.player.compositor.gl.getError();
      return out;
    });
    expect(result.captions).toBe(3);
    expect(result.lutLoaded).toBe(true);
    expect(result.reverseFrame as number).toBeLessThan(100);
    expect(result.hdrScope).toBe(true);
    expect(result.undoRedoStable).toBe(true);
    expect(result.glError).toBe(0);
    expect(errors).toEqual([]);
  });

  test('exports through the export dialog', async ({ page }, info) => {
    await newProject(page);
    await buildEdit(page);
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      const vids = (Object.values(session.store.get().clips) as any[])
        .filter((c) => c.type === 'video')
        .sort((a, b) => a.start - b.start);
      cmd.applyTransition('crossZoom', vids[1].id, 'in');
      // Small frame so software encoding on CI stays quick.
      session.store.commit([{ op: 'settings', patch: { width: 320, height: 180 } }]);
      session.player.setRange({ in: 100, out: 145 });
    });
    await page.keyboard.press('Control+e');
    await expect(page.locator('.exp')).toBeVisible();
    await expect(page.getByText('In – Out')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.locator('.dialog__foot .btn--primary').click();
    const file = await download;
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    const path = info.outputPath(file.suggestedFilename());
    await file.saveAs(path);
    test.skip(!hasFfprobe(), 'ffprobe not installed');
    const probe = ffprobe(path);
    const video = probe.streams.find((s) => s.codec_type === 'video')!;
    expect(Number(video.width)).toBe(320);
    expect(Number(video.nb_read_frames)).toBe(45);
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  });
});
