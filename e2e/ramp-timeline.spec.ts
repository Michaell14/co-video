import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  frameOfMedia,
  sourcePerFrame,
  sourceTimeAt,
  type Clip,
  type Project,
} from '../packages/core/src/index';
import { importFixtures, newProject, noReloads } from './helpers';

/**
 * Speed ramps as the timeline shows them: the chip and the read-out of a clip on a ramp, what its
 * menu offers, and its filmstrip and waveform, which are drawn where the picture shows and the
 * sound plays. The ramps are set by command; the inspector's graph has a spec of its own.
 */

async function localProject(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
}

/** The bundled sample: three shots of four seconds on V1, a title over the first on V2 and music under all on A1. */
async function sampleProject(page: Page): Promise<void> {
  await localProject(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });
  await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
}

const project = (page: Page): Promise<Project> =>
  page.evaluate(() => (window as any).tandem.session.store.get());

const idsOf = (page: Page, type: string): Promise<string[]> =>
  page.evaluate(
    (type) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === type)
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id),
    type,
  );

const clip = (page: Page, id: string): Promise<Clip> =>
  page.evaluate((id) => (window as any).tandem.session.store.get().clips[id], id);

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((ids) => (window as any).tandem.ui.getState().select(ids), ids);

/** Show the timeline from its start at `ppf` pixels to the frame. */
const zoom = (page: Page, ppf: number): Promise<void> =>
  page.evaluate((ppf) => (window as any).tandem.ui.getState().set({ ppf, scrollX: 0 }), ppf);

const seek = (page: Page, frame: number): Promise<void> =>
  page.evaluate((frame) => (window as any).tandem.cmd.seek(frame), frame);

const undo = (page: Page): Promise<void> => page.evaluate(() => (window as any).tandem.cmd.undo());

const undoDepth = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);

type Shape =
  'none' | 'custom' | 'rampUp' | 'rampDown' | 'montage' | 'hero' | 'bullet' | 'flashIn' | 'flashOut';

/** Select the clips and put them on a shape, as the palette does. */
async function setRamp(page: Page, ids: string[], shape: Shape): Promise<void> {
  await select(page, ids);
  await page.evaluate((shape) => (window as any).tandem.cmd.setRamp(shape), shape);
}

/** Select the clips and set their speed, and their direction when one is given. */
async function setSpeed(page: Page, ids: string[], speed: number, reverse?: boolean): Promise<void> {
  await select(page, ids);
  await page.evaluate(([speed, reverse]) => (window as any).tandem.cmd.setSpeed(speed, reverse), [
    speed,
    reverse,
  ] as const);
}

const clipEl = (page: Page, id: string): Locator => page.locator(`.clip[data-clip="${id}"]`);

/** The chip on a clip that says how fast it plays: the one with the gauge. */
const speedChip = (page: Page, id: string): Locator =>
  clipEl(page, id).locator('.clip__chip', { has: page.locator('.lucide-gauge') });

const menuItem = (page: Page, name: string): Locator => page.getByRole('menuitem', { name, exact: true });

/** Open the menu of a clip, as a right-click on it does. */
async function openMenu(page: Page, id: string): Promise<void> {
  await clipEl(page, id).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
}

/** Open the menu of a clip and, from it, the list of ramps. */
async function openRamps(page: Page, id: string): Promise<void> {
  await openMenu(page, id);
  await menuItem(page, 'Speed ramp…').click();
  await expect(menuItem(page, 'Add point at playhead')).toBeVisible();
}

/** What the open menu offers, and which of its entries are checked. */
const menu = (page: Page): Promise<{ labels: string[]; checked: string[] }> =>
  page.locator('[role="menu"] .menu-item').evaluateAll((items) => {
    const label = (item: Element): string => item.querySelector('.menu-item__label')!.textContent!;
    return {
      labels: items.map(label),
      checked: items.filter((item) => item.querySelector('.menu-item__check svg')).map(label),
    };
  });

const SHAPES = ['Ramp up', 'Ramp down', 'Montage', 'Hero', 'Bullet', 'Flash in', 'Flash out'];

/**
 * A sound file of `seconds` that is silent but for a burst in each of the hundredths of a second
 * `bins` names: a square wave at full height from two to eight milliseconds into the hundredth,
 * so that each burst is one peak of the file's waveform and nothing of it reaches the next.
 */
function clickTrack(seconds: number, bins: number[]): Buffer {
  const rate = 48000;
  const n = seconds * rate;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (const bin of bins) {
    const from = Math.round((bin / 100 + 0.002) * rate);
    const to = Math.round((bin / 100 + 0.008) * rate);
    for (let i = from; i < to; i++) wav.writeInt16LE(Math.floor(i / 12) % 2 ? 29000 : -29000, 44 + i * 2);
  }
  return wav;
}

/** The hundredths of a second that hold a click, and the middle of each in seconds. */
const CLICK_BINS = Array.from({ length: 15 }, (_, i) => 40 + i * 50);
const clickTimes = CLICK_BINS.map((bin) => bin / 100 + 0.005);

/**
 * Where the lane canvas shows sound under a clip: the middle of each run of pixel columns in
 * which the waveform stands tall, in pixels from the clip's left edge. It is read off the canvas
 * itself, column by column.
 */
const drawnClicks = (page: Page, id: string): Promise<number[]> =>
  page.evaluate((id) => {
    const el = document.querySelector(`.clip[data-clip="${id}"]`)!;
    const canvas = el.closest('.lane')!.querySelector('canvas')!;
    const r = el.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const scale = canvas.width / c.width;
    const left = (r.left - c.left) * scale;
    const { data, width, height } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    const from = Math.max(0, Math.floor(left));
    const to = Math.min(width, Math.ceil(left + r.width * scale));
    const top = Math.round(20 * scale);
    // How much paint a pixel holds: the waveform is the colour of the clip's ground, laid on thick.
    const paint = (x: number, y: number): number => data[(y * width + x) * 4 + 3];
    const all: number[] = [];
    for (let x = from; x < to; x++) for (let y = top; y < height; y++) all.push(paint(x, y));
    const ground = all.sort((a, b) => a - b)[all.length >> 1];
    // Of each column below the label strip, the rows that hold more than the ground does.
    const ink: number[] = [];
    for (let x = from; x < to; x++) {
      let rows = 0;
      for (let y = top; y < height; y++) if (paint(x, y) > ground * 1.8) rows++;
      ink.push(rows);
    }
    // Every column has the hairline of silence and the level line; a click stands far above them.
    const base = ink.slice().sort((a, b) => a - b)[ink.length >> 1];
    const tall = base + (Math.max(...ink) - base) / 4;
    const found: number[] = [];
    for (let i = 0; i < ink.length; i++) {
      if (ink[i] <= tall) continue;
      let end = i;
      while (end < ink.length && ink[end] > tall) end++;
      // The run, with the slope the drawing gives it to either side.
      let [sum, weight] = [0, 0];
      for (let k = Math.max(0, i - 1); k < Math.min(ink.length, end + 1); k++) {
        const over = Math.max(0, ink[k] - base);
        sum += (from + k + 0.5) * over;
        weight += over;
      }
      found.push((sum / weight - left) / scale);
      i = end;
    }
    return found;
  }, id);

/** A local project with nothing in it but a click track on A1, drawn at four pixels to the frame. */
async function clickProject(page: Page): Promise<string> {
  await localProject(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.evaluate(() => void (window as any).tandem.cmd.importMedia()),
  ]);
  await chooser.setFiles([{ name: 'clicks.wav', mimeType: 'audio/wav', buffer: clickTrack(8, CLICK_BINS) }]);
  await page.waitForFunction(
    () => Object.keys((window as any).tandem.session.store.get().assets).length === 1,
  );
  const id = await page.evaluate(() => {
    const { session, cmd } = (window as any).tandem;
    const [asset] = Object.values(session.store.get().assets) as any[];
    cmd.addAsset(asset, { frame: 30 });
    const [clip] = Object.values(session.store.get().clips) as any[];
    return clip.id as string;
  });
  await zoom(page, 4);
  // The whole file has been read: every click is in the waveform.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { session } = (window as any).tandem;
        const [asset] = Object.values(session.store.get().assets) as any[];
        return session.thumbs.wave.get(asset.id, asset.duration).done as boolean;
      }),
    )
    .toBe(true);
  return id;
}

test.describe('speed ramps on the timeline', () => {
  test.beforeEach(({ page }) => noReloads(page));

  test('a clip on a ramp says so on its chip and in its read-out, and a clip at one speed says what it said', async ({
    page,
  }) => {
    await sampleProject(page);
    await zoom(page, 6);
    const [dusk, fractal, aurora] = await idsOf(page, 'video');
    const [music] = await idsOf(page, 'audio');
    const [title] = await idsOf(page, 'text');
    // A clip at normal speed has no chip for it, and its read-out says nothing of speed.
    await expect(speedChip(page, fractal)).toHaveCount(0);
    await expect(clipEl(page, fractal)).toHaveAttribute('aria-label', 'fractal.mp4, V1, 0:04.00 to 0:08.00');

    await setRamp(page, [fractal], 'bullet');
    await expect(speedChip(page, fractal)).toHaveText('Ramp');
    await expect(speedChip(page, fractal)).toHaveAttribute('title', 'Speed ramp, 25% to 500%');
    await expect(clipEl(page, fractal)).toHaveAttribute(
      'aria-label',
      'fractal.mp4, V1, 0:04.00 to 0:04.27, speed ramp 25% to 500%',
    );
    // Played backwards it is the same ramp, with the sign a reversed clip has.
    await page.evaluate(() => (window as any).tandem.cmd.setReverse(true));
    await expect(speedChip(page, fractal)).toHaveText('−Ramp');
    await expect(speedChip(page, fractal)).toHaveAttribute('title', 'Speed ramp, 25% to 500%');
    await expect(clipEl(page, fractal)).toHaveAttribute(
      'aria-label',
      'fractal.mp4, V1, 0:04.00 to 0:04.27, speed ramp 25% to 500%',
    );
    // Sound says it as a picture does.
    await setRamp(page, [music], 'rampUp');
    await expect(speedChip(page, music)).toHaveText('Ramp');
    await expect(speedChip(page, music)).toHaveAttribute('title', 'Speed ramp, 50% to 200%');
    await expect(clipEl(page, music)).toHaveAttribute('aria-label', /, speed ramp 50% to 200%$/);

    // One speed is shown as it always was: the figure, a sign when reversed, and no word of it read out.
    await setSpeed(page, [dusk], 2);
    await expect(speedChip(page, dusk)).toHaveText('200%');
    await expect(speedChip(page, dusk)).not.toHaveAttribute('title');
    await expect(clipEl(page, dusk)).toHaveAttribute('aria-label', 'dusk.mp4, V1, 0:00.00 to 0:02.00');
    await setSpeed(page, [aurora], 1, true);
    await expect(speedChip(page, aurora)).toHaveText('−100%');
    await expect(clipEl(page, aurora)).toHaveAttribute('aria-label', 'aurora.mp4, V1, 0:08.00 to 0:12.00');
    // Off its ramp a clip is a clip at one speed again.
    await setRamp(page, [fractal], 'none');
    await expect(speedChip(page, fractal)).toHaveText('−100%');
    await expect(speedChip(page, title)).toHaveCount(0);
  });

  test('the clip menu turns a ramped clip round and leaves its ramp, and sets a ramp as the command does', async ({
    page,
  }) => {
    await sampleProject(page);
    await zoom(page, 6);
    const [dusk] = await idsOf(page, 'video');

    // "Bullet" from the menu is the command: the same clip, in one step.
    await setRamp(page, [dusk], 'bullet');
    const byCommand = await clip(page, dusk);
    expect(byCommand.ramp).toHaveLength(5);
    await undo(page);
    const plain = await clip(page, dusk);
    expect(plain.ramp).toBeNull();
    await select(page, []);
    const depth = await undoDepth(page);
    await openRamps(page, dusk);
    expect(await menu(page)).toEqual({
      labels: ['None', ...SHAPES, 'Add point at playhead'],
      checked: ['None'],
    });
    await menuItem(page, 'Bullet').click();
    expect(await clip(page, dusk)).toEqual(byCommand);
    expect(await undoDepth(page)).toBe(depth + 1);
    await openRamps(page, dusk);
    expect((await menu(page)).checked).toEqual(['Bullet']);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Turned round, the clip keeps its ramp, its length and its place in the file.
    await openMenu(page, dusk);
    await expect(menuItem(page, 'Play forwards')).toHaveCount(0);
    await menuItem(page, 'Reverse').click();
    const turned = await clip(page, dusk);
    expect(turned.ramp).toEqual(byCommand.ramp);
    expect(turned).toEqual({ ...byCommand, reverse: true });
    expect(await undoDepth(page)).toBe(depth + 2);
    await expect(speedChip(page, dusk)).toHaveText('−Ramp');
    // The shape is the one seen in play order, which is still Bullet: it is the same from either end.
    await openRamps(page, dusk);
    expect((await menu(page)).checked).toEqual(['Bullet']);
    await page.keyboard.press('Escape');
    await openMenu(page, dusk);
    await expect(menuItem(page, 'Reverse')).toHaveCount(0);
    await menuItem(page, 'Play forwards').click();
    expect(await clip(page, dusk)).toEqual(byCommand);

    // A point is added where the playhead shows the clip, on the curve as it runs.
    await seek(page, 6);
    await openRamps(page, dusk);
    await menuItem(page, 'Add point at playhead').click();
    const pointed = await clip(page, dusk);
    expect(pointed.ramp).toHaveLength(6);
    const shown = Math.round(sourceTimeAt(byCommand, 6, await project(page)) * 1e6) / 1e6;
    expect(pointed.ramp!.map((q) => q.m)).toContain(shown);
    expect(await undoDepth(page)).toBe(depth + 4);
    // A ramp shaped by hand is none of the ready-made ones.
    await openRamps(page, dusk);
    expect((await menu(page)).checked).toEqual([]);

    // "None" takes the clip off its ramp: back to its one speed, over the stretch it played.
    await menuItem(page, 'None').click();
    const off = await clip(page, dusk);
    expect(off).toMatchObject({ ramp: null, speed: 1, sourceIn: 0, reverse: false });
    expect(Math.abs(off.duration - plain.duration)).toBeLessThanOrEqual(3);
    await openRamps(page, dusk);
    expect((await menu(page)).checked).toEqual(['None']);
    await menuItem(page, 'Ramp up').click();
    const end = Math.round(sourceTimeAt(off, off.duration, await project(page)) * 1e6) / 1e6;
    expect((await clip(page, dusk)).ramp).toEqual([
      { m: 0, v: 0.5 },
      { m: end, v: 2 },
    ]);

    // One speed from the menu takes a ramped clip off its ramp, as the presets do.
    await openMenu(page, dusk);
    await menuItem(page, 'Speed: 100%').click();
    expect(await clip(page, dusk)).toMatchObject({ ramp: null, speed: 1, sourceIn: 0 });
    await expect(speedChip(page, dusk)).toHaveCount(0);
  });

  test('the clip menu offers ramps to what has a speed, Keep pitch to sound, and neither to someone who may not edit', async ({
    page,
  }) => {
    await sampleProject(page);
    await zoom(page, 3);
    const [dusk, , aurora] = await idsOf(page, 'video');
    const [music] = await idsOf(page, 'audio');
    const [title] = await idsOf(page, 'text');

    // Sound has the switch, off for sound nobody has retimed.
    await openMenu(page, music);
    const sound = await menu(page);
    expect(sound.labels).toEqual(expect.arrayContaining(['Reverse', 'Speed ramp…', 'Keep pitch']));
    expect(sound.labels.indexOf('Speed ramp…')).toBe(sound.labels.indexOf('Speed: 200%') + 1);
    expect(sound.labels.indexOf('Keep pitch')).toBe(sound.labels.indexOf('Speed ramp…') + 1);
    expect(sound.checked).toEqual([]);
    await menuItem(page, 'Keep pitch').click();
    expect((await clip(page, music)).keepPitch).toBe(true);
    await openMenu(page, music);
    expect((await menu(page)).checked).toEqual(['Keep pitch']);
    await menuItem(page, 'Keep pitch').click();
    expect((await clip(page, music)).keepPitch).toBe(false);
    await openMenu(page, music);
    expect((await menu(page)).checked).toEqual([]);
    await page.keyboard.press('Escape');

    // A picture has the ramps and no switch for a pitch; a title has no speed at all.
    await openMenu(page, dusk);
    const picture = (await menu(page)).labels;
    expect(picture).toEqual(expect.arrayContaining(['Reverse', 'Speed: 100%', 'Speed ramp…']));
    expect(picture).not.toContain('Keep pitch');
    await page.keyboard.press('Escape');
    await openMenu(page, title);
    const text = (await menu(page)).labels;
    for (const label of ['Reverse', 'Speed: 100%', 'Speed ramp…', 'Keep pitch'])
      expect(text).not.toContain(label);
    await page.keyboard.press('Escape');

    // A frozen frame holds one picture: nothing of it can be ramped.
    await select(page, [aurora]);
    await seek(page, 300);
    await page.evaluate(() => (window as any).tandem.cmd.freezeFrame());
    const frozen = (Object.values((await project(page)).clips) as Clip[]).find((c) => c.freeze)!;
    await openMenu(page, frozen.id);
    const still = (await menu(page)).labels;
    for (const label of ['Reverse', 'Speed: 100%', 'Speed ramp…', 'Keep pitch'])
      expect(still).not.toContain(label);
    await page.keyboard.press('Escape');

    // Someone who may only watch finds the entries and cannot choose them.
    await page.evaluate(() => (window as any).tandem.session.applyRole('viewer'));
    await openMenu(page, music);
    for (const label of ['Reverse', 'Speed: 100%', 'Speed ramp…', 'Keep pitch']) {
      await expect(menuItem(page, label)).toBeDisabled();
    }
    await page.keyboard.press('Escape');
  });

  test('the waveform of a clip on a ramp shows each sound where the mixer plays it', async ({ page }) => {
    const id = await clickProject(page);
    const ppf = 4;
    /** How far each click is drawn from where `place` puts it, in pixels: the furthest of them. */
    const off = async (place: (clip: Clip, m: number, p: Project) => number): Promise<number> => {
      const p = await project(page);
      const drawn = await drawnClicks(page, id);
      const wanted = clickTimes
        .map((m) => place(p.clips[id], m, p) * ppf)
        .filter((x) => x > 0 && x < p.clips[id].duration * ppf)
        .sort((a, b) => a - b);
      if (drawn.length !== wanted.length) return Infinity;
      return Math.max(...drawn.map((x, i) => Math.abs(x - wanted[i])));
    };
    /** The frame at which a clip at one speed plays second `m` of its file: the canvas's own line. */
    const linear = (c: Clip, m: number, p: Project): number => (m - c.sourceIn) / sourcePerFrame(c, p);

    // At one speed the clicks stand where they always stood: forwards, then twice as fast and backwards.
    expect((await clip(page, id)).duration).toBe(240);
    await expect.poll(() => off(linear)).toBeLessThan(1.5);
    await setSpeed(page, [id], 2, true);
    expect(await clip(page, id)).toMatchObject({ duration: 120, speed: 2, reverse: true, ramp: null });
    await expect.poll(() => off((c, m, p) => c.duration - linear(c, m, p))).toBeLessThan(1.5);
    await setSpeed(page, [id], 1, false);

    // On "Ramp up" the eight seconds take 6.4, and each click is drawn at the frame the clip's
    // clock reaches it, which is where the mixer plays it.
    await setRamp(page, [id], 'rampUp');
    const ramped = await clip(page, id);
    expect(ramped).toMatchObject({ duration: 192, start: 30, sourceIn: 0 });
    await expect.poll(() => off(frameOfMedia)).toBeLessThan(1.5);
    // Not where a clip at the average speed would have it: that is tens of pixels off.
    expect(await off(linear)).toBeGreaterThan(40);

    // Backwards the sound runs through the file from the top: each click at its distance from the end.
    await page.evaluate(() => (window as any).tandem.cmd.setReverse(true));
    expect(await clip(page, id)).toEqual({ ...ramped, reverse: true });
    await expect.poll(() => off((c, m, p) => c.duration - frameOfMedia(c, m, p))).toBeLessThan(1.5);

    // A trim moves the window and not the ramp: what is left is drawn where it was.
    await page.evaluate(() => (window as any).tandem.cmd.setReverse(false));
    const before = await drawnClicks(page, id);
    await seek(page, 30 + 60);
    await page.evaluate(() => (window as any).tandem.cmd.trimToPlayhead('start'));
    const trimmed = await clip(page, id);
    expect(trimmed.ramp).toEqual(ramped.ramp);
    expect(trimmed.duration).toBe(132);
    await expect.poll(() => off(frameOfMedia)).toBeLessThan(1.5);
    const kept = before.filter((x) => x > 60 * ppf).map((x) => x - 60 * ppf);
    const after = await drawnClicks(page, id);
    expect(after).toHaveLength(kept.length);
    for (const [i, x] of after.entries()) expect(Math.abs(x - kept[i])).toBeLessThan(1);
  });

  test('a change of ramp repaints the lanes of the clip and of the clip linked to it, and no other', async ({
    page,
  }) => {
    await sampleProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await page.waitForFunction(() =>
      (Object.values((window as any).tandem.session.store.get().assets) as any[]).some(
        (asset) => asset.name === 'testsrc.mp4',
      ),
    );
    // A take with its sound on tracks of their own, beside the sample's shots and music.
    const pair = await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      const p = session.store.get();
      const asset = (Object.values(p.assets) as any[]).find((a) => a.name === 'testsrc.mp4');
      const track = (kind: string, order: number) =>
        (Object.values(p.tracks) as any[]).find((t) => t.kind === kind && t.order === order).id;
      cmd.addAsset(asset, { frame: 150, videoTrackId: track('video', 1), audioTrackId: track('audio', 1) });
      ui.getState().set({ ppf: 3, scrollX: 0 });
      return (Object.values(session.store.get().clips) as any[])
        .filter((c) => c.assetId === asset.id)
        .map((c) => c.id as string);
    });
    expect(pair).toHaveLength(2);
    const [dusk] = await idsOf(page, 'video');
    const painted = await page.evaluate(
      async ([pair, dusk]) => {
        const { session, cmd, ui } = (window as any).tandem;
        const lanes: Element[] = [];
        const proto = CanvasRenderingContext2D.prototype;
        const clearRect = proto.clearRect;
        proto.clearRect = function (...args) {
          if (this.canvas.classList.contains('lane__canvas')) lanes.push(this.canvas.closest('.lane')!);
          return clearRect.apply(this, args);
        };
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const began = performance.now();
        const laneOf = (id: string) => document.querySelector(`.clip[data-clip="${id}"]`)!.closest('.lane')!;
        /** The clips as a shape leaves them: their ramp, and the length and place that go with it. */
        const shaped = (ids: string[], shape: string) => {
          ui.getState().select(ids);
          cmd.setRamp(shape);
          return ids.map((id) => {
            const { ramp, duration, sourceIn, start } = session.store.get().clips[id];
            return { op: 'updateClip', id, patch: { ramp, duration, sourceIn, start } };
          });
        };
        /**
         * The lanes painted while the clips were committed to one ramp and the other in turn,
         * `times` over, a frame apart. A thumbnail that arrives paints every lane, whenever it
         * arrives, and a ramp asks for thumbnails the one before did not: the measurement is made
         * again until it holds only what the commits account for, for a minute at most.
         */
        const during = async (ids: string[], times: number): Promise<Element[]> => {
          const ramps = [shaped(ids, 'montage'), shaped(ids, 'hero')];
          const own = ids.map(laneOf);
          for (;;) {
            lanes.length = 0;
            for (let i = 0; i < times; i++) {
              session.store.commit(ramps[i % 2]);
              await frame();
            }
            await frame();
            await frame();
            const seen = lanes.slice();
            const explained = seen.length <= times * own.length && seen.every((lane) => own.includes(lane));
            if (explained || performance.now() - began > 60_000) return seen;
          }
        };
        const all = document.querySelectorAll('.lane__canvas').length;
        const own = pair.map(laneOf);
        const forPair = await during(pair, 4);
        const forOne = await during([dusk], 4);
        proto.clearRect = clearRect;
        return {
          all,
          own: new Set(own).size,
          forPair: forPair.length,
          pairLanes: new Set(forPair).size,
          strangers: forPair.filter((lane) => !own.includes(lane)).length,
          forOne: forOne.length,
          oneLanes: new Set(forOne).size,
          other: forOne.filter((lane) => lane !== laneOf(dusk)).length,
        };
      },
      [pair, dusk] as const,
    );
    // Four lanes hold a picture or a waveform; the take and its sound are on two of them.
    expect(painted.all).toBe(4);
    expect(painted.own).toBe(2);
    // Both clips were changed (they are linked: one ramp for the two), so both lanes and no other.
    expect((await clip(page, pair[0])).ramp).toHaveLength(6);
    expect((await clip(page, pair[1])).ramp).toHaveLength(6);
    expect(painted.strangers).toBe(0);
    expect(painted.pairLanes).toBe(2);
    expect(painted.forPair).toBeLessThanOrEqual(8);
    // A clip that is linked to nothing: its own lane.
    expect(painted.other).toBe(0);
    expect(painted.oneLanes).toBe(1);
    expect(painted.forOne).toBeLessThanOrEqual(4);
  });

  test('the filmstrip of a clip on a ramp shows what the picture shows there, a slow stretch in nearer steps than a fast one', async ({
    page,
  }) => {
    await sampleProject(page);
    const [, fractal] = await idsOf(page, 'video');
    /**
     * The thumbnails the lane asks the cache for when it paints the clip from its first tile, at
     * `ppf` pixels to the frame: the second of the file each tile shows, and the step it is asked in.
     */
    const asked = (ppf: number): Promise<{ time: number; step: number }[]> =>
      page.evaluate(
        ([id, ppf]) => {
          const { session, ui } = (window as any).tandem;
          const film = session.thumbs.film;
          const { assetId, start } = session.store.get().clips[id];
          const calls: { time: number; step: number }[] = [];
          const get = film.get;
          film.get = function (asset: string, time: number, step: number) {
            if (asset === assetId) calls.push({ time, step });
            return get.call(film, asset, time, step);
          };
          // A change of view paints every lane.
          ui.getState().set({ ppf, scrollX: start * ppf - 24 });
          return new Promise<{ time: number; step: number }[]>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                film.get = get;
                // A thumbnail that arrived meanwhile had the lane painted again: one painting is enough.
                const again = calls.findIndex((call, i) => i > 0 && call.time <= calls[i - 1].time);
                resolve(again < 0 ? calls : calls.slice(0, again));
              }),
            ),
          );
        },
        [fractal, ppf] as const,
      );

    // At one speed every tile of a clip is as far from the next as any other, in one step.
    const even = await asked(12);
    expect(even.length).toBeGreaterThan(8);
    expect(new Set(even.map((tile) => tile.step)).size).toBe(1);
    const gaps = even.slice(1).map((tile, i) => tile.time - even[i].time);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-9);

    // "Bullet": five times the speed, a quarter of it around the middle, five times again.
    await setRamp(page, [fractal], 'bullet');
    const p = await project(page);
    const ramped = p.clips[fractal];
    const tiles = await asked(40);
    expect(tiles.length).toBeGreaterThan(8);
    // Each tile shows the second of the file the picture shows at the frame the tile begins on.
    const perTile = frameOfMedia(ramped, tiles[1].time, p);
    expect(perTile).toBeGreaterThan(1);
    const last = p.assets[ramped.assetId!].duration - 0.05;
    for (const [i, tile] of tiles.entries()) {
      expect(tile.time).toBeCloseTo(Math.min(sourceTimeAt(ramped, i * perTile, p), last), 6);
    }
    // In the slow middle the tiles are a few hundredths of a second of the file apart and ask
    // for the finest thumbnails; in the fast stretch they are far apart and ask for coarse ones.
    const apart = tiles.slice(1).map((tile, i) => tile.time - tiles[i].time);
    const slowest = apart.indexOf(Math.min(...apart));
    const fastest = apart.indexOf(Math.max(...apart));
    expect(apart[slowest]).toBeLessThan(0.1);
    expect(apart[fastest]).toBeGreaterThan(0.25);
    expect(tiles[slowest].step).toBe(0.125);
    expect(tiles[fastest].step).toBeGreaterThanOrEqual(0.25);
    expect(tiles[fastest].step).toBeGreaterThan(tiles[slowest].step);
  });

  test('the shortcut sheet says how a ramp point is moved, added and removed', async ({ page }) => {
    await sampleProject(page);
    await page.keyboard.press('Shift+?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    const rows = await sheet
      .locator('section', { has: page.getByRole('heading', { name: 'Mouse', exact: true }) })
      .locator('.shortcut')
      .evaluateAll((rows) =>
        rows.map((row) => ({
          what: row.firstElementChild!.textContent!,
          how: row.lastElementChild!.textContent!,
          // One line: nothing wraps and nothing is cut off.
          fits:
            row.scrollWidth <= row.clientWidth &&
            Array.from(row.children).every((half) => half.getBoundingClientRect().height <= row.clientHeight),
        })),
      );
    const mouse = new Map(rows.map((row) => [row.what, row]));
    expect(mouse.get('Move a ramp point')).toEqual({
      what: 'Move a ramp point',
      how: 'Drag it in the inspector’s graph',
      fits: true,
    });
    expect(mouse.get('Add or remove a ramp point')).toEqual({
      what: 'Add or remove a ramp point',
      how: 'Double-click the graph',
      fits: true,
    });
  });
});
