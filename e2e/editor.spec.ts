import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
      // The LUT's file is read once the first frame that uses it has been drawn.
      for (const until = performance.now() + 20_000; performance.now() < until;) {
        if (session.player.sources.getLut(lut.id)) break;
        await wait(100);
      }
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
      // Going backwards begins once the picture behind the playhead is decoded, and on a busy
      // machine that can take longer than this.
      for (let waited = 0; session.player.getFrame() >= 100 && waited < 10_000; waited += 100) {
        await wait(100);
      }
      out.reverseFrame = session.player.getFrame();
      cmd.shuttle(0);

      store.commit([{ op: 'settings', patch: { colorMode: 'hdr-pq', toneMap: 'bt2390' } }]);
      cmd.seek(30);
      // The scope reads the frame drawn last, and answers null while another read is under way:
      // ask until the first frame of the HDR project is the one it measured.
      let scope = await session.player.readScope(128);
      for (const until = performance.now() + 20_000; !scope?.pq && performance.now() < until;) {
        await wait(100);
        scope = await session.player.readScope(128);
      }
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

/** A project in this browser only: the collaboration server limits projects per address and hour. */
async function localProject(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
}

/** The bundled sample: three shots on V1, a title over the first on V2 and music under all on A1. */
async function sampleProject(page: Page): Promise<void> {
  await localProject(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });
  await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
}

/** Three sync clips of one second, cut from the middle of the test file and placed back to back. */
async function syncSequence(page: Page): Promise<void> {
  await localProject(page);
  await importFixtures(page, ['testsrc.mp4']);
  await page.evaluate(() => {
    const { session, cmd, ui } = (window as any).tandem;
    const [asset] = Object.values(session.store.get().assets);
    for (let i = 0; i < 3; i++) cmd.addAsset(asset, { frame: i * 30, sourceIn: 1, sourceOut: 2 });
    ui.getState().clearSelection();
  });
  await page.keyboard.press('Shift+z');
}

/** The timeline as `start-end` spans per track, e.g. `{ V1: ['0-120', '120-240'], A1: ['0-240'] }`. */
const rows = (page: Page): Promise<Record<string, string[]>> =>
  page.evaluate(() => {
    const p = (window as any).tandem.session.store.get();
    const label = new Map<string, string>();
    for (const kind of ['video', 'audio']) {
      (Object.values(p.tracks) as any[])
        .filter((t) => t.kind === kind)
        .sort((a, b) => a.order - b.order)
        .forEach((t, i) => label.set(t.id, `${kind === 'video' ? 'V' : 'A'}${i + 1}`));
    }
    const out: Record<string, string[]> = {};
    for (const c of (Object.values(p.clips) as any[]).sort((a, b) => a.start - b.start)) {
      (out[label.get(c.trackId)!] ??= []).push(`${c.start}-${c.start + c.duration}`);
    }
    return out;
  });

const seek = (page: Page, frame: number): Promise<void> =>
  page.evaluate((frame) => (window as any).tandem.cmd.seek(frame), frame);

const playhead = (page: Page): Promise<number> =>
  page.evaluate(() => Math.floor((window as any).tandem.session.player.getFrame()));

const markers = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    (Object.values((window as any).tandem.session.store.get().markers) as any[])
      .map((m) => m.frame)
      .sort((a, b) => a - b),
  );

/** Names of the selected clips, sorted. */
const selected = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const { session, ui } = (window as any).tandem;
    const p = session.store.get();
    return ui
      .getState()
      .selection.map((id: string) => `${p.clips[id].name || p.clips[id].type}@${p.clips[id].start}`)
      .sort();
  });

/** Ids of the clips of one type, in timeline order. */
const idsOf = (page: Page, type: string): Promise<string[]> =>
  page.evaluate(
    (type) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === type)
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id),
    type,
  );

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((ids) => (window as any).tandem.ui.getState().select(ids), ids);

const clip = (page: Page, id: string): Promise<any> =>
  page.evaluate((id) => (window as any).tandem.session.store.get().clips[id], id);

const range = (page: Page): Promise<{ in: number; out: number } | null> =>
  page.evaluate(() => (window as any).tandem.session.player.getState().range);

const toast = (page: Page, text: string): Locator => page.locator('.toast', { hasText: text });

/** Run the command the palette finds for `text`, from the keyboard. */
async function fromPalette(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Command palette' }).getByLabel('Search commands').fill(text);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
}

const SAMPLE = { A1: ['0-360'], V1: ['0-120', '120-240', '240-360'], V2: ['18-108'] };

test.describe('editing from the keyboard', () => {
  test('Q and W with nothing selected trim the shot under the playhead, not the music or the title', async ({
    page,
  }) => {
    await sampleProject(page);
    expect(await rows(page)).toEqual(SAMPLE);
    const trimmed = { A1: ['0-360'], V1: ['0-120', '120-180', '180-300'], V2: ['18-108'] };

    // In the second shot, with the music bed running under the whole cut.
    await seek(page, 180);
    await page.keyboard.press('w');
    expect(await rows(page)).toEqual(trimmed);
    await page.keyboard.press('Control+z');
    expect(await rows(page)).toEqual(SAMPLE);

    await page.keyboard.press('q');
    expect(await rows(page)).toEqual(trimmed);
    // The playhead is on the cut the trim was made at, not at the start of the music.
    expect(await playhead(page)).toBe(120);
    await page.keyboard.press('Control+z');

    // Under the title the shot is trimmed and the title is neither topped nor tailed.
    await seek(page, 60);
    await page.keyboard.press('w');
    expect(await rows(page)).toEqual({ A1: ['0-360'], V1: ['0-60', '60-180', '180-300'], V2: ['18-108'] });
    await page.keyboard.press('Control+z');

    // On a cut there is nothing to trim, and the music is not trimmed in its place.
    await seek(page, 120);
    await page.keyboard.press('q');
    await expect(toast(page, 'Put the playhead inside a clip to trim it.')).toBeVisible();
    await page.keyboard.press('w');
    expect(await rows(page)).toEqual(SAMPLE);
  });

  test('Shift+G closes the gap in the picture once, and a title further on stays on its shot', async ({
    page,
  }) => {
    await sampleProject(page);
    // A lower third 60 frames into the third shot, a marker ten frames into it, the second shot gone.
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      const all = Object.values(session.store.get().clips) as any[];
      const v2 = all.find((c) => c.type === 'text').trackId;
      const second = all.filter((c) => c.type === 'video').sort((a, b) => a.start - b.start)[1];
      cmd.seek(300);
      cmd.addText({ content: 'Lower third' }, { trackId: v2 });
      cmd.seek(250);
      cmd.addMarker();
      ui.getState().select([second.id]);
      cmd.delete(false);
      ui.getState().clearSelection();
      cmd.seek(130);
    });
    const open = { A1: ['0-360'], V1: ['0-120', '240-360'], V2: ['18-108', '300-450'] };
    expect(await rows(page)).toEqual(open);
    expect(await markers(page)).toEqual([120, 250]);

    await page.keyboard.press('Shift+g');
    // V2 has a gap of its own under the playhead, 192 frames long: that one is not closed as well.
    expect(await rows(page)).toEqual({ A1: ['0-360'], V1: ['0-120', '120-240'], V2: ['18-108', '180-330'] });
    // The marker in the third shot went with it; the one on the first cut stayed.
    expect(await markers(page)).toEqual([120, 130]);

    // Clips and markers are one undo step.
    await page.keyboard.press('Control+z');
    expect(await rows(page)).toEqual(open);
    expect(await markers(page)).toEqual([120, 250]);

    // With the switch off the markers stay where they are, and the command says which way it is.
    await fromPalette(page, 'markers follow');
    await expect(toast(page, 'Markers stay where they are through ripple edits.')).toBeVisible();
    await page.keyboard.press('Shift+g');
    expect(await markers(page)).toEqual([120, 250]);
    await fromPalette(page, 'markers follow');
    await expect(toast(page, 'Markers follow ripple edits.')).toBeVisible();
    await seek(page, 300);
    await page.keyboard.press('Shift+g');
    await expect(toast(page, 'There is no gap under the playhead to close.')).toBeVisible();
  });

  test('markers stay on their shots through a ripple delete and an insert', async ({ page }) => {
    await sampleProject(page);
    await page.evaluate(() => {
      const { cmd } = (window as any).tandem;
      cmd.seek(240);
      cmd.addMarker();
      cmd.seek(250);
      cmd.addMarker();
    });
    const [, second] = await idsOf(page, 'video');
    await select(page, [second]);
    await page.keyboard.press('Shift+Delete');
    expect(await rows(page)).toEqual({ A1: ['0-360'], V1: ['0-120', '120-240'], V2: ['18-108'] });
    expect(await markers(page)).toEqual([120, 120, 130]);

    // Two seconds inserted at the start move every shot, and every marker with it.
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      const asset = (Object.values(session.store.get().assets) as any[]).find(
        (a) => a.name === 'fractal.mp4',
      );
      cmd.addAsset(asset, { frame: 0, insert: true, sourceIn: 0, sourceOut: 2 });
    });
    expect((await rows(page)).V1).toEqual(['0-60', '60-180', '180-300']);
    expect(await markers(page)).toEqual([180, 180, 190]);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await rows(page)).toEqual(SAMPLE);
    expect(await markers(page)).toEqual([120, 240, 250]);

    // A title deleted with a ripple moves no shot, and so no marker.
    const [title] = await idsOf(page, 'text');
    await select(page, [title]);
    await page.keyboard.press('Shift+Delete');
    expect((await rows(page)).V2).toBeUndefined();
    expect(await markers(page)).toEqual([120, 240, 250]);
  });

  test('Alt+Up and Alt+Down move the picture of a sync clip and leave its sound on its track', async ({
    page,
  }) => {
    await localProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      cmd.addAsset(Object.values(session.store.get().assets)[0], { frame: 0 });
      ui.getState().clearSelection();
    });
    await page.keyboard.press('Shift+z');
    // A click selects picture and sound together: linked selection is on.
    const [picture] = await idsOf(page, 'video');
    await page.locator(`[data-clip="${picture}"]`).click();
    expect(await selected(page)).toHaveLength(2);
    expect(await rows(page)).toEqual({ A1: ['0-120'], V1: ['0-120'] });

    await page.keyboard.press('Alt+ArrowUp');
    expect(await rows(page)).toEqual({ A1: ['0-120'], V2: ['0-120'] });
    await page.keyboard.press('Alt+ArrowUp');
    await expect(toast(page, 'There is no track above to move to.')).toBeVisible();
    expect(await rows(page)).toEqual({ A1: ['0-120'], V2: ['0-120'] });

    await page.keyboard.press('Alt+ArrowDown');
    expect(await rows(page)).toEqual({ A1: ['0-120'], V1: ['0-120'] });
    await page.keyboard.press('Alt+ArrowDown');
    await expect(toast(page, 'There is no track below to move to.')).toBeVisible();
    // The two are still one sync clip.
    const [sound] = await idsOf(page, 'audio');
    expect((await clip(page, picture)).linkId).toBe((await clip(page, sound)).linkId);
  });

  test('clips are selected, stepped through and marked without the pointer', async ({ page }) => {
    await sampleProject(page);
    await seek(page, 60);
    // From the top track down, and round again.
    const stops = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+v');
      stops.push(await selected(page));
    }
    expect(stops).toEqual([['Text@18'], ['dusk.mp4@0'], ['pulse.ogg@0'], ['Text@18']]);

    // X marks what is selected; with nothing selected, the clip that is seen under the playhead.
    await page.keyboard.press('x');
    expect(await range(page)).toEqual({ in: 18, out: 108 });
    await page.keyboard.press('Escape');
    await seek(page, 300);
    await page.keyboard.press('x');
    expect(await range(page)).toEqual({ in: 240, out: 360 });
    await seek(page, 0);
    await page.keyboard.press('Shift+o');
    expect(await playhead(page)).toBe(359);
    await page.keyboard.press('Shift+i');
    expect(await playhead(page)).toBe(240);
    await page.keyboard.press('Alt+x');
    await page.keyboard.press('Shift+i');
    await expect(toast(page, 'There is no range yet.')).toBeVisible();
    expect(await playhead(page)).toBe(240);

    // Next and previous clip on the track of the selection; Shift keeps what is selected.
    await page.keyboard.press('Control+ArrowDown');
    expect(await selected(page)).toEqual(['aurora.mp4@240']);
    await page.keyboard.press('Control+ArrowUp');
    expect(await selected(page)).toEqual(['fractal.mp4@120']);
    await page.keyboard.press('Control+Shift+ArrowUp');
    expect(await selected(page)).toEqual(['dusk.mp4@0', 'fractal.mp4@120']);
    await page.keyboard.press('Control+ArrowUp');
    await expect(toast(page, 'That is the first clip on its track.')).toBeVisible();
    await page.keyboard.press('x');
    expect(await range(page)).toEqual({ in: 0, out: 240 });

    await page.keyboard.press('Escape');
    await seek(page, 400);
    await page.keyboard.press('Shift+v');
    await expect(toast(page, 'There is no clip under the playhead to select.')).toBeVisible();
    expect(await selected(page)).toEqual([]);

    // All of it is in the palette.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    for (const [query, title] of [
      ['select clip under', 'Select clip under playhead'],
      ['mark clip', 'Mark clip'],
      ['go to out', 'Go to out'],
      ['trim nearest', 'Trim nearest edge left'],
      ['extend edit', 'Extend edit to playhead'],
      ['default transition', 'Add default transition'],
      ['grade only', 'Paste attributes: grade only'],
    ]) {
      await palette.getByLabel('Search commands').fill(query);
      await expect(palette.getByText(title, { exact: true })).toBeVisible();
    }
  });

  test('a cut is fine-tuned with the trim keys: no hole opens and nothing after it moves', async ({
    page,
  }) => {
    await syncSequence(page);
    const tight = ['0-30', '30-60', '60-90'];
    expect(await rows(page)).toEqual({ A1: tight, V1: tight });
    const [, picture] = await idsOf(page, 'video');
    await page.locator(`[data-clip="${picture}"]`).click();
    expect(await selected(page)).toHaveLength(2);

    // The head of the selected pair is on a cut: the cut rolls, for picture and sound alike.
    await seek(page, 30);
    await page.keyboard.press('Control+ArrowRight');
    let rolled = ['0-31', '31-60', '60-90'];
    expect(await rows(page)).toEqual({ A1: rolled, V1: rolled });
    expect(await playhead(page)).toBe(31);
    await page.keyboard.press('Control+Shift+ArrowLeft');
    rolled = ['0-26', '26-60', '60-90'];
    expect(await rows(page)).toEqual({ A1: rolled, V1: rolled });
    expect(await playhead(page)).toBe(26);
    // The incoming clip shows five frames more of its head: its picture did not slide.
    expect((await clip(page, picture)).sourceIn).toBeCloseTo(1 - 4 / 30);

    // Near the other end the same keys move the cut at the tail, and E takes it to the playhead.
    await seek(page, 58);
    await page.keyboard.press('Control+ArrowRight');
    rolled = ['0-26', '26-61', '61-90'];
    expect(await rows(page)).toEqual({ A1: rolled, V1: rolled });
    await seek(page, 50);
    await page.keyboard.press('e');
    rolled = ['0-26', '26-50', '50-90'];
    expect(await rows(page)).toEqual({ A1: rolled, V1: rolled });
    expect(await playhead(page)).toBe(50);

    // Each press is one undo step.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
    expect(await rows(page)).toEqual({ A1: tight, V1: tight });

    // With ripple editing on, what follows moves along instead.
    await page.keyboard.press('r');
    await seek(page, 58);
    await page.keyboard.press('Control+Shift+ArrowLeft');
    const rippled = ['0-30', '30-55', '55-85'];
    expect(await rows(page)).toEqual({ A1: rippled, V1: rippled });
    await page.keyboard.press('Control+z');
    await page.keyboard.press('r');

    // A roll stops where the outgoing clip is down to one frame, and says so.
    await seek(page, 30);
    for (let i = 0; i < 7; i++) await page.keyboard.press('Control+Shift+ArrowLeft');
    expect((await rows(page)).V1).toEqual(['0-1', '1-60', '60-90']);
    await expect(toast(page, 'That edge cannot move any further that way.')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+ArrowLeft');
    await expect(toast(page, 'Select a clip to trim its nearest edge.')).toBeVisible();
  });

  test('Shift+D puts the default transition on every selected cut, with a short fade for the sound', async ({
    page,
  }) => {
    await syncSequence(page);
    const pictures = await idsOf(page, 'video');
    const sounds = await idsOf(page, 'audio');
    const transitions = async () => {
      const list = [];
      for (const id of pictures) list.push((await clip(page, id)).transIn?.type ?? null);
      return list;
    };
    const fades = async () => {
      const list = [];
      for (const id of sounds) list.push([(await clip(page, id)).fadeIn, (await clip(page, id)).fadeOut]);
      return list;
    };

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Shift+d');
    // Both cuts, and nothing before the first clip.
    expect(await transitions()).toEqual([null, 'crossDissolve', 'crossDissolve']);
    expect(await fades()).toEqual([
      [0, 3],
      [3, 3],
      [3, 0],
    ]);
    await expect(toast(page, 'Cross Dissolve added to 2 clips')).toBeVisible();
    expect(await selected(page)).toHaveLength(6);
    await page.keyboard.press('Control+z');
    expect(await transitions()).toEqual([null, null, null]);
    expect(await fades()).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);

    // With nothing selected it is the cut nearest the playhead, selected for adjusting.
    await page.keyboard.press('Escape');
    await seek(page, 50);
    await page.keyboard.press('Shift+d');
    expect(await transitions()).toEqual([null, null, 'crossDissolve']);
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().selectedTransition?.clipId)).toBe(
      pictures[2],
    );
    await page.keyboard.press('Control+z');

    // The transition chosen last from the library is the default from then on.
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ libraryTab: 'transitions' }));
    await select(page, [pictures[1]]);
    await page.locator('[data-tile]', { hasText: 'Dip to Black' }).first().click();
    expect(await transitions()).toEqual([null, 'dipToBlack', null]);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Shift+d');
    expect(await transitions()).toEqual([null, 'dipToBlack', 'dipToBlack']);
  });

  test('a clip copied before the frame rate changed is pasted at the length it has in time', async ({
    page,
  }) => {
    await sampleProject(page);
    const [first] = await idsOf(page, 'video');
    await select(page, [first]);
    await page.keyboard.press('Control+c');
    expect(await clip(page, first)).toMatchObject({ duration: 120, transIn: { duration: 15 } });

    await page.evaluate(() => (window as any).tandem.ui.getState().set({ dialog: 'project' }));
    await page.locator('.dialog .row', { hasText: 'Frame rate' }).locator('.select').click();
    await page.locator('.popover [role="option"]', { hasText: /^60/ }).first().click();
    await expect
      .poll(() => page.evaluate(() => (window as any).tandem.session.store.get().settings.fpsNum))
      .toBe(60);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).toHaveCount(0);
    expect(await clip(page, first)).toMatchObject({ duration: 240, transIn: { duration: 30 } });

    await page.keyboard.press('End');
    await page.keyboard.press('Control+v');
    const [pasted] = await page.evaluate(() => (window as any).tandem.ui.getState().selection);
    // Four seconds and a half-second transition, as copied: not two seconds and a quarter.
    expect(await clip(page, pasted)).toMatchObject({ start: 720, duration: 240, transIn: { duration: 30 } });
  });

  test('a grade is pasted onto every selected clip and leaves their framing alone', async ({ page }) => {
    await sampleProject(page);
    const [dusk, fractal, aurora] = await idsOf(page, 'video');
    const [music] = await idsOf(page, 'audio');
    await page.evaluate(
      ([fractal, aurora, music]) => {
        const { session, cmd } = (window as any).tandem;
        const p = session.store.get();
        const asset = (Object.values(p.assets) as any[]).find((a) => a.kind === 'audio');
        session.store.commit([
          { op: 'updateClip', id: fractal, patch: { scaleX: 1.3, scaleY: 1.3, x: 0.1 } },
          { op: 'updateClip', id: aurora, patch: { scaleX: 0.4, scaleY: 0.4, cropL: 0.1 } },
          { op: 'updateClip', id: music, patch: { volume: -9, pan: -0.5 } },
        ]);
        cmd.addAsset(asset, { frame: 400 });
      },
      [fractal, aurora, music],
    );
    const [, second] = await idsOf(page, 'audio');
    // Grade the first shot in the colour panel and copy its attributes, with the music's.
    await page.evaluate(
      (dusk) => (window as any).tandem.ui.getState().set({ workspace: 'color', selection: [dusk] }),
      dusk,
    );
    const exposure = page.locator('.gslider', { hasText: 'Exposure' }).getByRole('textbox');
    await exposure.fill('0.5');
    await exposure.press('Enter');
    await expect.poll(async () => (await clip(page, dusk)).grade?.exposure).toBe(0.5);
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ workspace: 'edit' }));
    await select(page, [dusk, music]);
    await page.locator('.tl').focus();
    await page.keyboard.press('Control+Alt+c');
    await expect(toast(page, 'Attributes copied')).toBeVisible();

    // Grade only, from the palette, onto both of the other shots.
    await select(page, [fractal, aurora, second]);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByLabel('Search commands').fill('grade only');
    await page.keyboard.press('Enter');
    await expect(toast(page, 'Grade pasted onto 2 clips')).toBeVisible();
    expect(await clip(page, fractal)).toMatchObject({ grade: { exposure: 0.5 }, scaleX: 1.3, x: 0.1 });
    expect(await clip(page, aurora)).toMatchObject({ grade: { exposure: 0.5 }, scaleX: 0.4, cropL: 0.1 });
    expect((await clip(page, fractal)).effects).toEqual([]);
    expect((await clip(page, second)).volume).toBe(0);
    await page.keyboard.press('Control+z');
    expect((await clip(page, fractal)).grade).toBeNull();
    expect((await clip(page, aurora)).grade).toBeNull();

    // Everything: the look onto the picture, level and pan onto the sound, as one step.
    await page.keyboard.press('Control+Alt+v');
    await expect(toast(page, 'Attributes pasted onto 3 clips')).toBeVisible();
    expect(await clip(page, aurora)).toMatchObject({ grade: { exposure: 0.5 }, scaleX: 1, cropL: 0 });
    expect((await clip(page, aurora)).effects.map((e: any) => e.type)).toEqual(['filmGrain']);
    expect(await clip(page, second)).toMatchObject({ volume: -9, pan: -0.5 });
    await page.keyboard.press('Control+z');
    expect(await clip(page, aurora)).toMatchObject({ grade: null, scaleX: 0.4, cropL: 0.1 });
    expect((await clip(page, second)).volume).toBe(0);
  });

  test('a slowed clip makes room under ripple editing, and offers to without it', async ({ page }) => {
    await sampleProject(page);
    const [first] = await idsOf(page, 'video');
    const slow = async () => {
      await page.locator(`[data-clip="${first}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Speed: 50%' }).click();
    };
    const roomy = { A1: ['0-360'], V1: ['0-240', '240-360', '360-480'], V2: ['18-108'] };

    // Without ripple editing the next clip holds it at its old length, and the toast says so.
    await slow();
    expect(await rows(page)).toEqual(SAMPLE);
    const offer = toast(
      page,
      'The next clip is in the way, so the clip now plays only the first 4 of its 8 seconds.',
    );
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Make room' }).click();
    expect(await rows(page)).toEqual(roomy);
    expect(await markers(page)).toEqual([240]);
    await page.keyboard.press('Control+z');
    expect(await rows(page)).toEqual(SAMPLE);
    expect(await clip(page, first)).toMatchObject({ speed: 0.5, duration: 120 });
    await page.keyboard.press('Control+z');
    expect((await clip(page, first)).speed).toBe(1);

    // With it, what follows moves by as much as the clip grows, and comes back when it shrinks.
    await page.keyboard.press('Escape');
    await page.keyboard.press('r');
    await slow();
    expect(await rows(page)).toEqual(roomy);
    expect(await clip(page, first)).toMatchObject({ speed: 0.5, duration: 240, sourceIn: 0 });
    expect(await markers(page)).toEqual([240]);
    await page.locator(`[data-clip="${first}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Speed: 200%' }).click();
    expect(await rows(page)).toEqual({ A1: ['0-360'], V1: ['0-60', '60-180', '180-300'], V2: ['18-108'] });
    expect(await markers(page)).toEqual([60]);
    await page.locator(`[data-clip="${first}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Speed: 100%' }).click();
    expect(await rows(page)).toEqual(SAMPLE);
    expect(await markers(page)).toEqual([120]);
  });

  test('room made for a slowed clip leaves no hole when its media is not a whole number of frames long', async ({
    page,
  }) => {
    await localProject(page);
    // Four seconds of media are 95.9 frames at 23.976: placed whole, the clip is 96 frames long.
    await page.evaluate(() =>
      (window as any).tandem.session.store.commit([
        { op: 'settings', patch: { fpsNum: 24000, fpsDen: 1001 } },
      ]),
    );
    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      const [asset] = Object.values(session.store.get().assets);
      for (const frame of [0, 96]) cmd.addAsset(asset, { frame });
      ui.getState().clearSelection();
    });
    await page.keyboard.press('Shift+z');
    const whole = { A1: ['0-96', '96-192'], V1: ['0-96', '96-192'] };
    const roomy = { A1: ['0-192', '192-288'], V1: ['0-192', '192-288'] };
    expect(await rows(page)).toEqual(whole);
    const [first] = await idsOf(page, 'video');
    const slow = async () => {
      await page.locator(`[data-clip="${first}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Speed: 50%' }).click();
    };

    await slow();
    expect(await rows(page)).toEqual(whole);
    await toast(page, 'The next clip is in the way').getByRole('button', { name: 'Make room' }).click();
    // Picture and sound both run up to the clip that moved out of their way: no frame of black.
    expect(await rows(page)).toEqual(roomy);

    // The same timeline as the change of speed leaves under ripple editing.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect(await rows(page)).toEqual(whole);
    expect((await clip(page, first)).speed).toBe(1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('r');
    await slow();
    expect(await rows(page)).toEqual(roomy);
  });

  test('captions are exported without the titles', async ({ page }) => {
    await sampleProject(page);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.evaluate(() => void (window as any).tandem.cmd.importMedia()),
    ]);
    await chooser.setFiles(join(FIXTURES, 'captions.srt'));
    await expect(toast(page, 'Added 2 captions')).toBeVisible();
    await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
    const cues = async (act: () => Promise<unknown>): Promise<string[]> => {
      const [download] = await Promise.all([page.waitForEvent('download'), act()]);
      return readFileSync(await download.path(), 'utf8')
        .trim()
        .split(/\r?\n\r?\n/)
        .map((cue) => cue.split(/\r?\n/).slice(2).join(' '));
    };

    // From the palette: the caption track, and not the title that lies across both captions.
    const exported = await cues(async () => {
      await page.keyboard.press('Control+k');
      await page
        .getByRole('dialog', { name: 'Command palette' })
        .getByLabel('Search commands')
        .fill('captions');
      await page.keyboard.press('Enter');
    });
    expect(exported).toEqual(['Hello from Tandem', 'Captions import as text clips']);
    await expect(toast(page, 'Exported 2 captions from Captions.')).toBeVisible();

    // Selected text is exported as it is selected.
    const title = await page.evaluate(
      () =>
        (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
          (c) => c.text?.content === 'Edit in tandem',
        ).id,
    );
    await select(page, [title]);
    expect(await cues(() => page.evaluate(() => (window as any).tandem.cmd.exportSubtitles()))).toEqual([
      'Edit in tandem',
    ]);

    // A project without a caption track has only its text to go by, and the toast says what was written.
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const track = (Object.values(session.store.get().tracks) as any[]).find((t) => t.name === 'Captions');
      session.store.commit([{ op: 'updateTrack', id: track.id, patch: { name: 'Text' } }]);
      ui.getState().clearSelection();
    });
    expect(await cues(() => page.evaluate(() => (window as any).tandem.cmd.exportSubtitles()))).toHaveLength(
      3,
    );
    await expect(toast(page, 'Exported all 3 text clips, titles included.')).toBeVisible();
  });

  test('Space presses a button the keyboard focused, and plays after a click on one', async ({ page }) => {
    await sampleProject(page);
    const playing = () => page.evaluate(() => (window as any).tandem.session.player.getState().playing);
    const snapping = () => page.evaluate(() => (window as any).tandem.ui.getState().snapping);
    const button = page.getByRole('button', { name: 'Snapping', exact: true });

    // A click leaves the focus on the button; Space is still the transport's.
    await button.click();
    expect(await snapping()).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(true);
    expect(await snapping()).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(false);

    // The palette gives the focus back to the button when it closes on Enter. A click had put it
    // there, so Space is the transport's as before, also after the keys that step the playhead.
    await fromPalette(page, 'Fit timeline to window');
    await expect(button).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(true);
    expect(await snapping()).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(false);

    // Reached with Tab, the same button is pressed by Space and playback is left alone.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(button).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(snapping).toBe(true);
    expect(await playing()).toBe(false);

    // It stays that way when the palette returns to it: the keyboard brought the focus there.
    await fromPalette(page, 'Fit timeline to window');
    await expect(button).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(snapping).toBe(false);
    expect(await playing()).toBe(false);

    // A menu opened with a click and closed with Escape leaves its button to the transport too.
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await menu.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(menu).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(true);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('a voiceover whose microphone goes away stops with the reason and adds nothing', async ({ page }) => {
    const errors = trackErrors(page);
    // Keep hold of the stream the recorder is given, to end its track the way an unplugged device does.
    await page.addInitScript(() => {
      const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await open(constraints);
        (window as any).__microphone = stream;
        return stream;
      };
    });
    await localProject(page);
    await page.keyboard.press('Shift+r');
    await expect(page.locator('.rec')).toBeVisible();
    await page.waitForTimeout(800);
    await page.evaluate(() =>
      (window as any).__microphone.getAudioTracks()[0].dispatchEvent(new Event('ended')),
    );
    await expect(
      toast(page, 'The recording stopped. The microphone was disconnected, so the take was lost.'),
    ).toBeVisible();
    await expect(page.locator('.rec')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().playing)).toBe(false);
    expect(await rows(page)).toEqual({});

    // The next take records as usual.
    await page.keyboard.press('Shift+r');
    await expect(page.locator('.rec')).toBeVisible();
    await page.waitForTimeout(1200);
    await page.keyboard.press('Shift+r');
    await expect(toast(page, 'Voiceover added to the timeline.')).toBeVisible({ timeout: 30_000 });
    expect(Object.keys(await rows(page))).toEqual(['A1']);
    // The refused health check of a local project is the one failure that is meant.
    expect(errors.filter((e) => !e.includes('net::ERR_FAILED'))).toEqual([]);
  });
});
