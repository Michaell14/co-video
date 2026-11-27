import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  clipEnd,
  frameOfMedia,
  meanSpeed,
  sourceSpan,
  sourceTimeAt,
  type Clip,
  type Project,
  type RampPoint,
} from '../packages/core/src/index';
import { clips, importFixtures, newProject } from './helpers';

/**
 * Speed ramps and Keep pitch as the inspector's Speed section shows them: the chips, the graph of
 * a ramp worked by pointer and by keyboard, and the switch. What a ramp does to the timeline when
 * it is asked for by command is in `ramp-commands.spec.ts`.
 */

const SAMPLE = ['audio@0+360', 'text@18+90', 'video@0+120', 'video@120+120', 'video@240+120'];

/** Start noting what every toast says as it appears: a toast is gone again after a few seconds. */
const watchToasts = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seen: string[] = ((window as any).__toasts = []);
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof HTMLElement && n.classList.contains('toast')) seen.push(n.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true });
  });

/** The toasts so far that said `text`, whether they are still showing or not. */
const said = (page: Page, text: string): Promise<string[]> =>
  page.evaluate((text) => ((window as any).__toasts as string[]).filter((t) => t.includes(text)), text);

/**
 * A project that lives in this browser only, holding the bundled sample edit: dusk, fractal and
 * aurora (four seconds each) on V1, a title on V2 and music on A1.
 */
async function sample(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
  await watchToasts(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect.poll(() => clips(page), { timeout: 60_000 }).toEqual(SAMPLE);
  await expect(page.locator('.clip')).toHaveCount(5);
}

const project = (page: Page): Promise<Project> =>
  page.evaluate(() => (window as any).tandem.session.store.get());

const clip = (page: Page, id: string): Promise<Clip> =>
  page.evaluate((id) => (window as any).tandem.session.store.get().clips[id], id);

/** The earliest clip that shows the media file `name`. */
const named = (page: Page, name: string): Promise<Clip> =>
  page.evaluate(
    (name) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .sort((a, b) => a.start - b.start)
        .find((c) => c.name === name),
    name,
  );

const idsOf = (page: Page, type: string): Promise<string[]> =>
  page.evaluate(
    (type) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === type)
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id),
    type,
  );

/** The picture track as `start+duration` of each clip, in order. */
const shots = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (Object.values((window as any).tandem.session.store.get().clips) as any[])
      .filter((c) => c.type === 'video')
      .sort((a, b) => a.start - b.start)
      .map((c) => `${c.start}+${c.duration}`),
  );

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((ids) => (window as any).tandem.ui.getState().select(ids), ids);

const set = (page: Page, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate((patch) => (window as any).tandem.ui.getState().set(patch), patch);

const seek = (page: Page, frame: number): Promise<void> =>
  page.evaluate((frame) => (window as any).tandem.cmd.seek(frame), frame);

const frame = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tandem.session.player.getFrame());

const undo = (page: Page): Promise<void> => page.evaluate(() => (window as any).tandem.cmd.undo());

const undoDepth = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);

type Shape =
  'none' | 'custom' | 'rampUp' | 'rampDown' | 'montage' | 'hero' | 'bullet' | 'flashIn' | 'flashOut';

const setRamp = (page: Page, shape: Shape): Promise<void> =>
  page.evaluate((shape) => (window as any).tandem.cmd.setRamp(shape), shape);

const setSpeed = (page: Page, speed: number): Promise<void> =>
  page.evaluate((speed) => (window as any).tandem.cmd.setSpeed(speed), speed);

const inspector = (page: Page): Locator => page.locator('[aria-label="Inspector"]');
const speed = (page: Page): Locator => inspector(page).locator('.section', { hasText: 'Presets' });
const chip = (page: Page, name: string): Locator => speed(page).getByRole('button', { name, exact: true });
const plot = (page: Page): Locator => speed(page).locator('.ramp__plot');
const points = (page: Page): Locator => speed(page).getByRole('slider', { name: /^Ramp point \d+ of \d+$/ });
const point = (page: Page, n: number, of: number): Locator =>
  speed(page).getByRole('slider', { name: `Ramp point ${n} of ${of}`, exact: true });
const toast = (page: Page, text: string): Locator => page.locator('.toast', { hasText: text }).first();

/** Select clips and have the Speed section open, with its last row in view. */
async function show(page: Page, ids: string[]): Promise<void> {
  await select(page, ids);
  const head = inspector(page).locator('.section__head', { hasText: 'Speed' });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await speed(page).getByText('Duration').scrollIntoViewIfNeeded();
}

interface Spot {
  x: number;
  y: number;
}

/** Where the box of the graph is on the screen, once all of the graph is in view. */
async function graph(page: Page): Promise<Spot & { width: number; height: number }> {
  await plot(page).scrollIntoViewIfNeeded();
  const box = await speed(page).locator('.ramp__box').boundingBox();
  if (!box) throw new Error('no graph');
  return box;
}

/** Where the dot of the `n`th shown point is, counted from 0 on the left. */
async function dot(page: Page, n: number): Promise<Spot> {
  await plot(page).scrollIntoViewIfNeeded();
  return speed(page)
    .locator('.ramp__pt')
    .nth(n)
    .evaluate((g) => {
      const r = g.querySelector('.ramp__pt-edge')!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
}

/** How far across the graph of `c` second `m` of its media lies, from 0 on the left to 1. */
function across(c: Clip, p: Project, m: number): number {
  const { in: from, out: to } = sourceSpan(c, p);
  return c.reverse ? (to - m) / (to - from) : (m - from) / (to - from);
}

/** The second of media at a place across the graph of `c`. */
function mediaAcross(c: Clip, p: Project, x: number): number {
  const { in: from, out: to } = sourceSpan(c, p);
  return c.reverse ? to - x * (to - from) : from + x * (to - from);
}

/** How far up the graph a speed lies: 10% at the bottom, 1000% at the top. */
const up = (v: number): number => (Math.log10(v) + 1) / 2;

/** A point as the graph reads it out. */
function spoken(c: Clip, p: Project, q: RampPoint): string {
  const { in: from, out: to } = sourceSpan(c, p);
  const into = Math.min(to - from, Math.max(0, c.reverse ? to - q.m : q.m - from));
  return `${Math.round(q.v * 100)}% at ${into.toFixed(2)} seconds`;
}

/**
 * Keys pressed on the focused control one straight after the other, as a held key repeats: a run
 * of presses is told from the next by a rest of over half a second, and presses sent one by one
 * to a busy page can lie further apart than that.
 */
const burst = (page: Page, keys: string[]): Promise<void> =>
  page.evaluate(async (keys) => {
    for (const name of keys) {
      const shiftKey = name.startsWith('Shift+');
      const key = name.slice(name.indexOf('+') + 1);
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
      );
      await new Promise((turn) => setTimeout(turn));
    }
  }, keys);

/**
 * How far apart two clips are, in seconds of their media, on the frames of the timeline they
 * share: the most over those frames.
 */
function apart(p: Project, a: Clip, b: Clip): number {
  const from = Math.max(a.start, b.start);
  const to = Math.min(clipEnd(a), clipEnd(b));
  if (to <= from) return Infinity;
  let most = 0;
  for (let f = from; f < to; f++) {
    most = Math.max(most, Math.abs(sourceTimeAt(a, f - a.start, p) - sourceTimeAt(b, f - b.start, p)));
  }
  return most;
}

// A file saved while the suite runs makes the dev server reload the page under the test; its
// socket is left unanswered so that cannot happen.
test.beforeEach(async ({ context }) => {
  await context.routeWebSocket(/\/\?token=/, () => {});
});

test.describe('the ramp chips', () => {
  test('put a clip on a shape, take it off again and make it ready for points', async ({ page }) => {
    await sample(page);
    const dusk = await named(page, 'dusk.mp4');
    await show(page, [dusk.id]);
    await expect(chip(page, 'None')).toHaveAttribute('aria-pressed', 'true');
    await expect(plot(page)).toHaveCount(0);
    // What the command makes of the clip is what the chip makes of it.
    await setRamp(page, 'bullet');
    const byCommand = await clip(page, dusk.id);
    expect(byCommand.ramp).toHaveLength(5);
    expect(byCommand.duration).toBeLessThan(40);
    await undo(page);
    expect(await clip(page, dusk.id)).toEqual(dusk);
    const depth = await undoDepth(page);

    await chip(page, 'Bullet').click();
    expect(await clip(page, dusk.id)).toEqual(byCommand);
    expect(await undoDepth(page)).toBe(depth + 1);
    await expect(chip(page, 'Bullet')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(page, 'None')).toHaveAttribute('aria-pressed', 'false');
    await expect(speed(page).locator('.chip[aria-pressed="true"]')).toHaveCount(1);
    await expect(plot(page)).toBeVisible();
    await expect(points(page)).toHaveCount(5);
    // Each shape is drawn on its chip, 20 by 12.
    const drawing = await chip(page, 'Bullet')
      .locator('svg')
      .evaluate((svg) => {
        const r = svg.getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          path: svg.querySelector('path')!.getAttribute('d')!.length,
        };
      });
    expect(drawing).toMatchObject({ width: 20, height: 12 });
    expect(drawing.path).toBeGreaterThan(40);
    // On a ramp the clip has no one speed: the row shows what it comes to and cannot be worked.
    const mean = Math.round(meanSpeed(byCommand, await project(page)) * 100);
    expect(mean).toBeGreaterThan(400);
    const slider = speed(page).getByRole('slider', { name: 'Speed', exact: true });
    await expect(slider).toHaveAttribute('aria-valuetext', `${mean}% on average`);
    await expect(speed(page).getByRole('textbox', { name: 'Speed', exact: true })).toHaveValue(String(mean));
    expect(await slider.evaluate((el) => !!el.closest('[inert]'))).toBe(true);
    expect(
      await speed(page)
        .locator('.slider')
        .first()
        .evaluate((el) => !!el.closest('[inert]')),
    ).toBe(true);

    // None: one speed again, the one it had, over the media it played.
    await chip(page, 'None').click();
    const off = await clip(page, dusk.id);
    expect(off).toMatchObject({ ramp: null, speed: 1, sourceIn: 0 });
    expect(Math.abs(off.duration - dusk.duration)).toBeLessThanOrEqual(3);
    await expect(plot(page)).toHaveCount(0);
    await expect(chip(page, 'None')).toHaveAttribute('aria-pressed', 'true');
    expect(await slider.evaluate((el) => !!el.closest('[inert]'))).toBe(false);
    await expect(slider).toHaveAttribute('aria-valuetext', '100%');
    expect(await undoDepth(page)).toBe(depth + 2);
    // Each click was one step, and undone the clip is the one it was, to the letter.
    await undo(page);
    expect(await clip(page, dusk.id)).toEqual(byCommand);
    await undo(page);
    expect(await clip(page, dusk.id)).toEqual(dusk);

    // Custom on a clip at 50%: a level line at 50%, and the clip as long as it was.
    const aurora = await named(page, 'aurora.mp4');
    await select(page, [aurora.id]);
    await setSpeed(page, 0.5);
    expect(await clip(page, aurora.id)).toMatchObject({ speed: 0.5, duration: 240 });
    await chip(page, 'Custom').click();
    const level = await clip(page, aurora.id);
    expect(level.ramp).toEqual([
      { m: 0, v: 0.5 },
      { m: 4, v: 0.5 },
    ]);
    expect(level.duration).toBe(240);
    await expect(chip(page, 'Custom')).toHaveAttribute('aria-pressed', 'true');
    await expect(points(page)).toHaveCount(2);
    for (const n of [1, 2]) await expect(point(page, n, 2)).toHaveAttribute('aria-valuenow', '50');
    // A preset takes it to one speed again.
    await chip(page, '2×').click();
    expect(await clip(page, aurora.id)).toMatchObject({ speed: 2, ramp: null, duration: 60 });
    await expect(chip(page, '2×')).toHaveAttribute('aria-pressed', 'true');
    await expect(plot(page)).toHaveCount(0);
  });

  test('ripple what follows with ripple editing, and offer room without it', async ({ page }) => {
    await sample(page);
    const dusk = await named(page, 'dusk.mp4');
    await show(page, [dusk.id]);
    const before = await shots(page);
    expect(before).toEqual(['0+120', '120+120', '240+120']);

    // Ramp up plays four seconds of media in 3.2: what follows comes up by the difference.
    await set(page, { rippleMode: true });
    const depth = await undoDepth(page);
    await chip(page, 'Ramp up').click();
    expect(await shots(page)).toEqual(['0+96', '96+120', '216+120']);
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);
    expect(await shots(page)).toEqual(before);
    expect(await clip(page, dusk.id)).toEqual(dusk);

    // At 200% the next shot stands right behind the clip. Without ripple editing the ramp is set
    // and the clip stops there: the panel says so, and offers to make the room.
    await setSpeed(page, 2);
    expect(await shots(page)).toEqual(['0+60', '60+120', '180+120']);
    await set(page, { rippleMode: false });
    await chip(page, 'Ramp up').click();
    expect(await clip(page, dusk.id)).toMatchObject({ duration: 60 });
    expect((await clip(page, dusk.id)).ramp).toHaveLength(2);
    const offer = toast(
      page,
      'The next clip is in the way, so the clip now plays only the first 2 of its 3.2 seconds.',
    );
    await expect(offer).toBeVisible();
    const cut = await undoDepth(page);
    await offer.getByRole('button', { name: 'Make room' }).click();
    expect(await shots(page)).toEqual(['0+96', '96+120', '216+120']);
    expect(await undoDepth(page)).toBe(cut + 1);
  });
});

test.describe('the ramp graph by pointer', () => {
  test('a drag of a point is one step, measured from where it began', async ({ page }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    const title = await named(page, 'Text');
    await show(page, [aurora.id]);
    await chip(page, 'Bullet').click();
    const bullet = await clip(page, aurora.id);
    const depth = await undoDepth(page);

    // The slow point in the middle is taken up to 140% and back down in one drag.
    const at = await dot(page, 2);
    const drag = async (meanwhile: (dy: number) => Promise<void> = async () => {}) => {
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      for (let dy = 6; dy <= 42; dy += 6) {
        await page.mouse.move(at.x, at.y - dy);
        await meanwhile(dy);
      }
      const raised = await clip(page, aurora.id);
      expect(raised.ramp![2].m).toBe(2);
      expect(raised.ramp![2].v).toBeCloseTo(0.25 * 10 ** ((2 * 42) / 112), 2);
      expect(raised.ramp!.filter((_, i) => i !== 2)).toEqual(bullet.ramp!.filter((_, i) => i !== 2));
      for (let dy = 36; dy >= 0; dy -= 6) {
        await page.mouse.move(at.x, at.y - dy);
        await meanwhile(dy);
      }
      await page.mouse.up();
    };
    await drag();
    expect(await clip(page, aurora.id)).toEqual(bullet);
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);

    // The same drag while somebody else is at work: between any two moves an edit of theirs
    // arrives, to the title and to the look of the clip itself. It stays one gesture.
    await drag((dy) =>
      page.evaluate(
        ([ids, opacity]) => {
          const { doc } = (window as any).tandem.session.store;
          doc.transact(() => {
            for (const id of ids) doc.getMap('clips').get(id).set('opacity', opacity);
          }, 'peer');
        },
        [[title.id, aurora.id], 0.5 + dy / 100] as const,
      ),
    );
    expect(await clip(page, title.id)).toEqual({ ...title, opacity: 0.5 });
    expect(await clip(page, aurora.id)).toEqual({ ...bullet, opacity: 0.5 });
    expect(await undoDepth(page)).toBe(depth + 1);
  });

  test('a point let go elsewhere is undone in one step, the ripple included', async ({ page }) => {
    await sample(page);
    const dusk = await named(page, 'dusk.mp4');
    await set(page, { rippleMode: true });
    await show(page, [dusk.id]);
    await chip(page, 'Bullet').click();
    const found = (await project(page)).clips;
    const depth = await undoDepth(page);
    expect(await shots(page)).toEqual(['0+27', '27+120', '147+120']);

    // The first point comes down from 500% to under 60%: the clip gets longer under the pointer,
    // and the shots after it move with its end at every step.
    const at = await dot(page, 0);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let dy = 10; dy <= 60; dy += 10) {
      await page.mouse.move(at.x, at.y + dy);
      const now = await shots(page);
      const length = Number(now[0].split('+')[1]);
      expect(now).toEqual([`0+${length}`, `${length}+120`, `${length + 120}+120`]);
    }
    await page.mouse.up();
    const lowered = await clip(page, dusk.id);
    expect(lowered.ramp![0]).toEqual({ m: 0, v: Number((5 * 10 ** ((-2 * 60) / 112)).toFixed(3)) });
    expect(lowered.duration).toBeGreaterThan(27);
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);
    expect((await project(page)).clips).toEqual(found);
  });

  test('a clip the next one cuts short says so when the drag ends, once', async ({ page }) => {
    await sample(page);
    const fractal = await named(page, 'fractal.mp4');
    await show(page, [fractal.id]);
    await chip(page, 'Custom').click();
    const level = await clip(page, fractal.id);
    expect(level.ramp).toEqual([
      { m: 1, v: 1 },
      { m: 5, v: 1 },
    ]);
    const offer = 'The next clip is in the way';
    expect(await said(page, offer)).toHaveLength(0);

    // The clip begins slower and would run on past the next shot, which holds it at its length.
    const at = await dot(page, 0);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let dy = 6; dy <= 30; dy += 6) {
      await page.mouse.move(at.x, at.y + dy);
      expect(await said(page, offer)).toHaveLength(0);
    }
    expect((await clip(page, fractal.id)).ramp![0].v).toBeLessThan(0.35);
    expect((await clip(page, fractal.id)).duration).toBe(120);
    // While the drag is under way the graph stays on the stretch it found, where the pointer is.
    await expect(points(page)).toHaveCount(2);
    await page.mouse.up();
    await expect.poll(() => said(page, offer)).toHaveLength(1);
    expect((await said(page, offer))[0]).toMatch(/plays only the first 4 of its \d\.\d seconds\./);
    await page.waitForTimeout(900);
    expect(await said(page, offer)).toHaveLength(1);
    // Let go, the graph shows the stretch the clip now plays: the last point lies beyond it.
    await expect(points(page)).toHaveCount(1);
    // Room made, the rest of the ramp is there again.
    await toast(page, offer).getByRole('button', { name: 'Make room' }).click();
    expect((await clip(page, fractal.id)).duration).toBeGreaterThan(120);
    await expect(points(page)).toHaveCount(2);
  });

  test('a point left beyond what the clip plays is out of reach until there is room for it', async ({
    page,
  }) => {
    await sample(page);
    const dusk = await named(page, 'dusk.mp4');
    await show(page, [dusk.id]);
    await chip(page, 'Montage').click();
    const montage = await clip(page, dusk.id);
    expect(montage.duration).toBeLessThan(120);
    await expect(points(page)).toHaveCount(6);
    const remove = speed(page).getByRole('button', { name: 'Remove point' });
    const chosen = speed(page).locator('.ramp__pt[data-chosen]');

    // The fifth point is taken down: the clip would run on past the next shot, which holds it at
    // its length. In hand, the point is the chosen one and stays where the pointer is.
    const at = await dot(page, 4);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let dy = 10; dy <= 50; dy += 10) await page.mouse.move(at.x, at.y + dy);
    await expect(chosen.locator('[aria-label="Ramp point 5 of 6"]')).toHaveCount(1);
    await page.mouse.up();
    const short = await clip(page, dusk.id);
    expect(short.duration).toBe(120);
    expect(short.ramp![4].v).toBeLessThan(1);
    // Let go, the clip ends before it gets to the point. A point that is not shown is not the
    // chosen one, and is not removed unseen.
    await expect(points(page)).toHaveCount(4);
    await expect(chosen).toHaveCount(0);
    await expect(remove).toBeDisabled();
    // Room made, the point is there again, and the chosen one as it was.
    await toast(page, 'The next clip is in the way').getByRole('button', { name: 'Make room' }).click();
    await expect(points(page)).toHaveCount(6);
    await expect(chosen.locator('[aria-label="Ramp point 5 of 6"]')).toHaveCount(1);
    await remove.click();
    expect((await clip(page, dusk.id)).ramp).toEqual(short.ramp!.filter((_, i) => i !== 4));
  });

  test('a point stops at its neighbour, and Shift keeps it from snapping to 100%', async ({ page }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Hero').click();
    const hero = await clip(page, aurora.id);
    const p = await project(page);
    const { in: from, out: to } = sourceSpan(hero, p);
    expect(hero.ramp!.map((q) => q.m)).toEqual([0, 1, 1.6, 2.4, 3, 4]);

    // Sideways the second point goes as far as a hundredth of the graph short of the third.
    const at = await dot(page, 1);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 12, at.y);
    const part = (await clip(page, aurora.id)).ramp![1];
    expect(part.v).toBe(4);
    expect(part.m).toBeGreaterThan(1.1);
    expect(part.m).toBeLessThan(1.4);
    await page.mouse.move(at.x + 200, at.y);
    const stopped = (await clip(page, aurora.id)).ramp!;
    expect(stopped[1].m).toBeCloseTo(1.6 - (to - from) / 100, 5);
    expect(stopped[2]).toEqual({ m: 1.6, v: 0.3 });
    // And to the left as far as the first, which stands on the edge of the graph.
    await page.mouse.move(at.x - 200, at.y);
    expect((await clip(page, aurora.id)).ramp![1].m).toBeCloseTo((to - from) / 100, 5);
    await page.mouse.move(at.x, at.y);
    await page.mouse.up();
    expect(await clip(page, aurora.id)).toEqual(hero);

    // Two pixels short of the 100% line the point snaps to it. With Shift held it stays where
    // the pointer is.
    const box = await graph(page);
    const line = box.y + box.height / 2;
    expect(line - at.y).toBeCloseTo((up(4) - up(1)) * box.height, 0);
    const lower = async () => {
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x, at.y + 12);
      await page.mouse.move(at.x, line - 2);
      const v = (await clip(page, aurora.id)).ramp![1].v;
      await page.mouse.up();
      await undo(page);
      return v;
    };
    expect(await lower()).toBe(1);
    await page.keyboard.down('Shift');
    const loose = await lower();
    await page.keyboard.up('Shift');
    expect(loose).toBeGreaterThan(1.02);
    expect(loose).toBeLessThan(1.12);
    expect(await clip(page, aurora.id)).toEqual(hero);

    // Sideways a point snaps to the playhead: to the moment of the media that was parked on.
    await seek(page, hero.start + 15);
    const parked = sourceTimeAt(hero, 15, p);
    expect(parked).toBeGreaterThan(1.1);
    expect(parked).toBeLessThan(1.5);
    const mark = box.x + across(hero, p, parked) * box.width;
    const aside = async (short: number) => {
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 12, at.y);
      await page.mouse.move(mark - short, at.y);
      const m = (await clip(page, aurora.id)).ramp![1].m;
      await page.mouse.up();
      await undo(page);
      return m;
    };
    expect(await aside(3)).toBe(Math.round(parked * 1e6) / 1e6);
    expect(await aside(-4)).toBe(Math.round(parked * 1e6) / 1e6);
    expect(await aside(9)).toBeLessThan(parked - 0.05);
    await page.keyboard.down('Shift');
    const unsnapped = await aside(3);
    await page.keyboard.up('Shift');
    expect(unsnapped).toBeLessThan(parked - 0.01);
    expect(await clip(page, aurora.id)).toEqual(hero);
  });

  test('a press beside the points moves the playhead, and a double-click adds or removes a point', async ({
    page,
  }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Hero').click();
    const hero = await clip(page, aurora.id);
    const p = await project(page);
    const depth = await undoDepth(page);
    const box = await graph(page);
    // A whole pixel of the screen some way across the graph, and the media that lies under it.
    const column = (share: number): number => Math.round(box.x + box.width * share);
    const under = (x: number): number => mediaAcross(hero, p, (x - box.x) / box.width);
    const shows = (x: number): number => hero.start + Math.round(frameOfMedia(hero, under(x), p));

    // A press on the empty graph takes the playhead to that moment of the clip. Nothing is edited.
    await page.mouse.click(column(0.5), box.y + 8);
    expect(await frame(page)).toBe(shows(column(0.5)));
    // Held, it scrubs.
    await page.mouse.move(column(0.2), box.y + 8);
    await page.mouse.down();
    expect(await frame(page)).toBe(shows(column(0.2)));
    await page.mouse.move(column(0.7), box.y + 30);
    expect(await frame(page)).toBe(shows(column(0.7)));
    await page.mouse.up();
    expect(shows(column(0.7)) - shows(column(0.2))).toBeGreaterThan(40);
    expect(await undoDepth(page)).toBe(depth);
    expect(await clip(page, aurora.id)).toEqual(hero);

    // A double-click on the line adds a point there. On the level stretch nothing else changes.
    const level = Math.round(box.y + (1 - up(0.3)) * box.height);
    await page.mouse.dblclick(column(0.5), level);
    const added = await clip(page, aurora.id);
    expect(added.ramp).toHaveLength(7);
    expect(added.ramp![3].m).toBeCloseTo(under(column(0.5)), 5);
    expect(added.ramp![3].v).toBe(0.3);
    expect(added.duration).toBe(hero.duration);
    expect(await undoDepth(page)).toBe(depth + 1);
    await expect(points(page)).toHaveCount(7);
    // The new point is the chosen one, and can be removed by the button.
    await expect(speed(page).locator('.ramp__pt[data-chosen]')).toHaveCount(1);
    await expect(speed(page).getByRole('button', { name: 'Remove point' })).toBeEnabled();
    // A double-click on a point removes it.
    const fresh = await dot(page, 3);
    await page.mouse.dblclick(fresh.x, fresh.y);
    expect(await clip(page, aurora.id)).toEqual(hero);
    expect(await undoDepth(page)).toBe(depth + 2);
    await expect(speed(page).getByRole('button', { name: 'Remove point' })).toBeDisabled();

    // Away from the line the new point is put on the curve as it runs, not where the pointer is.
    await page.mouse.dblclick(column(0.5), box.y + 8);
    expect((await clip(page, aurora.id)).ramp![3]).toEqual(added.ramp![3]);
    // The button removes the chosen point.
    await speed(page).getByRole('button', { name: 'Remove point' }).click();
    expect(await clip(page, aurora.id)).toEqual(hero);
    expect(await undoDepth(page)).toBe(depth + 4);

    // A ramp is two points at the least: neither of the last two can be removed.
    await chip(page, 'None').click();
    await chip(page, 'Custom').click();
    const two = await clip(page, aurora.id);
    expect(two.ramp).toHaveLength(2);
    const last = await undoDepth(page);
    const end = await dot(page, 1);
    await page.mouse.dblclick(end.x, end.y);
    expect(await clip(page, aurora.id)).toEqual(two);
    expect(await undoDepth(page)).toBe(last);
    await expect(speed(page).locator('.ramp__pt[data-chosen]')).toHaveCount(1);
    await expect(speed(page).getByRole('button', { name: 'Remove point' })).toBeDisabled();

    // And 32 at the most: a double-click on a full ramp says so, as the button does.
    const full = Array.from({ length: 32 }, (_, i) => ({ m: Math.round((i * 4e6) / 31) / 1e6, v: 1 }));
    await page.evaluate((points) => (window as any).tandem.cmd.setRampPoints(points), full);
    await expect(points(page)).toHaveCount(32);
    const most = 'A ramp holds at most 32 points.';
    expect(await said(page, most)).toHaveLength(0);
    await page.mouse.dblclick(column(0.5), box.y + 8);
    await expect.poll(() => said(page, most)).toHaveLength(1);
    await speed(page).getByRole('button', { name: 'Add point' }).click();
    await expect.poll(() => said(page, most)).toHaveLength(2);
    expect((await clip(page, aurora.id)).ramp).toEqual(full);
  });
});

test.describe('the ramp graph by keyboard', () => {
  test('points are Tab stops that the arrows move, Delete removes and Enter goes to', async ({ page }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Bullet').click();
    const bullet = await clip(page, aurora.id);
    const p = await project(page);
    const { in: from, out: to } = sourceSpan(bullet, p);
    const count = (await clips(page)).length;
    await seek(page, 45);

    // After the chips the keyboard comes to the points, one by one, from the left.
    await chip(page, 'Flash out').focus();
    await page.keyboard.press('Tab');
    await expect(point(page, 1, 5)).toBeFocused();
    await page.keyboard.press('Tab');
    const second = point(page, 2, 5);
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute('aria-valuemin', '10');
    await expect(second).toHaveAttribute('aria-valuemax', '1000');
    await expect(second).toHaveAttribute('aria-valuenow', '500');
    await expect(second).toHaveAttribute('aria-valuetext', '500% at 1.68 seconds');

    // Up three times is one step, and the point says where it now is.
    const depth = await undoDepth(page);
    await burst(page, ['ArrowUp', 'ArrowUp', 'ArrowUp']);
    let now = (await clip(page, aurora.id)).ramp![1];
    expect(now).toEqual({ m: 1.68, v: 5.789 });
    await expect(second).toHaveAttribute('aria-valuetext', '579% at 1.68 seconds');
    await expect(second).toHaveAttribute('aria-valuenow', '579');
    expect(await undoDepth(page)).toBe(depth + 1);
    // Left moves it a hundredth of the graph, in the same run of presses. Shift takes larger steps.
    await burst(page, ['ArrowLeft', 'Shift+ArrowDown', 'PageDown']);
    now = (await clip(page, aurora.id)).ramp![1];
    expect(now.m).toBeCloseTo(1.68 - (to - from) / 100, 5);
    expect(now.v).toBeCloseTo(5.789 / 1.62 / 2, 2);
    await expect(second).toHaveAttribute('aria-valuetext', spoken(await clip(page, aurora.id), p, now));
    expect(await undoDepth(page)).toBe(depth + 1);
    await expect(second).toBeFocused();
    // The arrows were the point's: the playhead has not moved, and no clip is gone.
    expect(await frame(page)).toBe(45);
    // After a rest the next press begins another step.
    await page.waitForTimeout(800);
    await page.keyboard.press('End');
    expect((await clip(page, aurora.id)).ramp![1].v).toBe(10);
    expect(await undoDepth(page)).toBe(depth + 2);
    await page.keyboard.press('Home');
    expect((await clip(page, aurora.id)).ramp![1].v).toBe(0.1);
    await undo(page);
    await undo(page);
    expect(await clip(page, aurora.id)).toEqual(bullet);

    // Enter takes the playhead to the point.
    await second.focus();
    await page.keyboard.press('Enter');
    expect(await frame(page)).toBe(aurora.start + Math.round(frameOfMedia(bullet, 1.68, p)));

    // Delete removes the point, not the clip, and the keyboard goes on to the point beside it.
    const before = await undoDepth(page);
    await page.keyboard.press('Delete');
    const fewer = await clip(page, aurora.id);
    expect(fewer.ramp!.map((q) => q.m)).toEqual([0, 2, 2.32, 4]);
    expect((await clips(page)).length).toBe(count);
    expect(await undoDepth(page)).toBe(before + 1);
    await expect(point(page, 2, 4)).toBeFocused();
    await expect(point(page, 2, 4)).toHaveAttribute('aria-valuenow', '25');
    await expect(speed(page).locator('.ramp__pt[data-chosen]')).toHaveCount(1);
    // Down to two points, Delete has nothing to do, and is still the point's key.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    expect((await clip(page, aurora.id)).ramp).toHaveLength(2);
    await page.keyboard.press('Delete');
    expect((await clip(page, aurora.id)).ramp).toHaveLength(2);
    expect((await clips(page)).length).toBe(count);
    await expect(point(page, 2, 2)).toBeFocused();
  });

  test('what a run of keys left behind is said when they rest, unless the clip has changed again', async ({
    page,
  }) => {
    await sample(page);
    const fractal = await named(page, 'fractal.mp4');
    await show(page, [fractal.id]);
    await chip(page, 'Custom').click();
    await seek(page, fractal.start + 60);
    await speed(page).getByRole('button', { name: 'Add point' }).click();
    const level = await clip(page, fractal.id);
    expect(level.ramp!.map((q) => q.v)).toEqual([1, 1, 1]);
    const offer = 'The next clip is in the way';

    // The first point is taken down to a quarter: the clip would run on into the next shot.
    await point(page, 1, 3).focus();
    await burst(page, ['PageDown', 'PageDown']);
    expect(await clip(page, fractal.id)).toMatchObject({ duration: 120 });
    expect((await clip(page, fractal.id)).ramp![0].v).toBe(0.25);
    expect(await said(page, offer)).toHaveLength(0);
    // When the keys have rested the graph lets go of the stretch it held, and the last point lies
    // beyond what the clip now plays. That is when the panel says so, not a while after.
    await expect(points(page)).toHaveCount(2);
    expect(await said(page, offer)).toHaveLength(1);
    await undo(page);
    expect(await clip(page, fractal.id)).toEqual(level);

    // The same run, and the point removed before the keys have rested: the clip is level again,
    // over the media the next shot had left it, with room to spare. Nothing is said about a
    // state that is no longer there.
    await point(page, 1, 3).focus();
    await burst(page, ['PageDown', 'PageDown', 'Delete']);
    const flat = await clip(page, fractal.id);
    expect(flat.ramp!.map((q) => q.v)).toEqual([1, 1]);
    expect(flat.duration).toBeLessThan(120);
    await page.waitForTimeout(1_800);
    expect(await said(page, offer)).toHaveLength(1);
  });

  test('Add point hands the keyboard to the new point, and a press on a dot leaves it alone', async ({
    page,
  }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Bullet').click();
    const bullet = await clip(page, aurora.id);
    const p = await project(page);
    // The playhead is on the level stretch before the dip: that is where the point goes.
    await seek(page, aurora.start + 4);
    const depth = await undoDepth(page);

    await speed(page).getByRole('button', { name: 'Add point' }).focus();
    await page.keyboard.press('Enter');
    const more = await clip(page, aurora.id);
    expect(more.ramp).toHaveLength(6);
    expect(await undoDepth(page)).toBe(depth + 1);
    const fresh = more.ramp!.find((q) => !bullet.ramp!.some((old) => old.m === q.m))!;
    expect(fresh.m).toBeCloseTo(sourceTimeAt(bullet, 4, p), 5);
    expect(fresh.v).toBe(5);
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('aria-label', 'Ramp point 2 of 6');
    await expect(focused).toHaveAttribute('aria-valuetext', spoken(more, p, fresh));
    // It is the chosen one, and the arrows work it at once.
    await expect(speed(page).locator('.ramp__pt[data-chosen] [aria-label="Ramp point 2 of 6"]')).toHaveCount(
      1,
    );
    await page.keyboard.press('ArrowDown');
    expect((await clip(page, aurora.id)).ramp![1]).toEqual({ m: fresh.m, v: 4.762 });

    // Remove point takes it away again and hands the keyboard to the point beside it.
    await page.waitForTimeout(800);
    await speed(page).getByRole('button', { name: 'Remove point' }).focus();
    await page.keyboard.press('Enter');
    expect((await clip(page, aurora.id)).ramp).toEqual(bullet.ramp);
    await expect(point(page, 2, 5)).toBeFocused();

    // A press on a dot takes hold of the dot and does not take the keyboard there: the arrows
    // are the playhead's for someone using the mouse.
    const at = await dot(page, 3);
    await page.mouse.click(at.x, at.y);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await expect(speed(page).locator('.ramp__pt[data-chosen] [aria-label="Ramp point 4 of 5"]')).toHaveCount(
      1,
    );
    const stood = await frame(page);
    await page.keyboard.press('ArrowRight');
    expect(await frame(page)).toBe(stood + 1);
    expect((await clip(page, aurora.id)).ramp).toEqual(bullet.ramp);
  });

  test('the keyboard is handed to a point once, and not again when the graph comes back', async ({
    page,
  }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    const dusk = await named(page, 'dusk.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Hero').click();
    const hero = await clip(page, aurora.id);
    await seek(page, aurora.start + 50);
    await speed(page).getByRole('button', { name: 'Add point' }).focus();
    await page.keyboard.press('Enter');
    await expect(point(page, 4, 7)).toBeFocused();
    const more = await clip(page, aurora.id);
    const head = inspector(page).locator('.section__head', { hasText: 'Speed' });

    // The keyboard goes on to the head of the section, which folds it and unfolds it again.
    const fold = async () => {
      await head.focus();
      await page.keyboard.press('Enter');
      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Enter');
    };
    await fold();
    await expect(points(page)).toHaveCount(7);
    await expect(head).toBeFocused();
    // Another clip is selected, and this one again.
    await select(page, [dusk.id]);
    await expect(plot(page)).toHaveCount(0);
    await select(page, [aurora.id]);
    await expect(points(page)).toHaveCount(7);
    await expect(head).toBeFocused();
    // The ramp is taken off with the pointer, and undo brings it back.
    await chip(page, 'None').click();
    await expect(plot(page)).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(points(page)).toHaveCount(7);
    await expect(chip(page, 'None')).toBeFocused();
    expect(await clip(page, aurora.id)).toEqual(more);

    // The same for the point that Remove point went on to.
    await speed(page).getByRole('button', { name: 'Remove point' }).focus();
    await page.keyboard.press('Enter');
    expect(await clip(page, aurora.id)).toEqual(hero);
    await expect(point(page, 4, 6)).toBeFocused();
    await fold();
    await expect(points(page)).toHaveCount(6);
    await expect(head).toBeFocused();
  });
});

test.describe('what the ramp graph shows', () => {
  test('the playhead stands at the media under it, moves while playing and is gone off the clip', async ({
    page,
  }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Hero').click();
    const hero = await clip(page, aurora.id);
    const p = await project(page);
    const head = speed(page).locator('.ramp__head');
    const placed = async (): Promise<number> => {
      const transform = await head.evaluate((el) => (el as HTMLElement).style.transform);
      return Number(/^translateX\(([\d.]+)%\)$/.exec(transform)![1]) / 100;
    };
    const expected = (frame: number): number =>
      across(hero, p, sourceTimeAt(hero, Math.floor(frame) - hero.start, p));

    for (const local of [0, 7, 30, 60, hero.duration - 1]) {
      await seek(page, hero.start + local);
      await expect(head).toHaveCSS('visibility', 'visible');
      expect(await placed()).toBeCloseTo(expected(hero.start + local), 4);
    }
    // It is fast at the start of this shape: seven frames in, the media is well further along.
    expect(expected(hero.start + 7)).toBeGreaterThan((7 / hero.duration) * 1.5);

    // Playing, the line moves with the picture.
    await seek(page, hero.start + 2);
    const began = await placed();
    await page.evaluate(() => (window as any).tandem.cmd.togglePlay());
    await expect.poll(placed).toBeGreaterThan(began + 0.02);
    await page.evaluate(() => (window as any).tandem.cmd.togglePlay());
    await seek(page, hero.start + 44);
    expect(await placed()).toBeCloseTo(expected(hero.start + 44), 4);

    // Off the clip there is no moment of it to show.
    await seek(page, hero.start - 1);
    await expect(head).toHaveCSS('visibility', 'hidden');
    await seek(page, hero.start);
    await expect(head).toHaveCSS('visibility', 'visible');

    // Under the graph each second of the clip has a mark, and the marks say what they are.
    const marks = speed(page).locator('.ramp__marks line');
    await expect(marks).toHaveCount(Math.ceil(hero.duration / 30) - 1);
    const xs = await marks.evaluateAll((lines) => lines.map((l) => Number(l.getAttribute('x1')) / 1000));
    xs.forEach((x, i) => expect(frameOfMedia(hero, mediaAcross(hero, p, x), p)).toBeCloseTo((i + 1) * 30, 3));
    await speed(page).locator('.ramp__marks').hover();
    await expect(page.locator('.tooltip')).toHaveText('Each mark is a second of the clip');
  });

  test('the stretch each piece plays, after a split, a trim and a turn', async ({ page }) => {
    await sample(page);
    const aurora = await named(page, 'aurora.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Hero').click();
    const hero = await clip(page, aurora.id);
    const p = await project(page);
    await expect(points(page)).toHaveCount(6);

    // Split in the first ease, each half shows the points of its own stretch on the one ramp.
    await seek(page, hero.start + 8);
    await page.evaluate(() => (window as any).tandem.cmd.split());
    const [head, tail] = (await idsOf(page, 'video')).slice(-2);
    const halves = [await clip(page, head), await clip(page, tail)];
    expect(halves.map((c) => c.ramp)).toEqual([hero.ramp, hero.ramp]);
    expect(halves.map((c) => c.duration)).toEqual([8, hero.duration - 8]);
    await select(page, [head]);
    await expect(points(page)).toHaveCount(1);
    await expect(point(page, 1, 1)).toHaveAttribute('aria-valuetext', '100% at 0.00 seconds');
    await select(page, [tail]);
    await expect(points(page)).toHaveCount(5);
    await expect(point(page, 1, 5)).toHaveAttribute('aria-valuetext', spoken(halves[1], p, hero.ramp![1]));
    await expect(point(page, 1, 5)).toHaveAttribute('aria-valuenow', '400');
    await undo(page);
    expect(await clip(page, aurora.id)).toEqual(hero);

    // Trimmed in past the second point, the points before the edge are not shown. They are
    // still there, and are shown again when the clip is trimmed back out.
    await select(page, [aurora.id]);
    await seek(page, hero.start);
    const second = await dot(page, 1);
    await page.mouse.click(second.x, second.y);
    const chosen = speed(page).locator('.ramp__pt[data-chosen]');
    const remove = speed(page).getByRole('button', { name: 'Remove point' });
    await expect(chosen.locator('[aria-label="Ramp point 2 of 6"]')).toHaveCount(1);
    await expect(remove).toBeEnabled();
    await page.evaluate(() => (window as any).tandem.cmd.trimEdge(20));
    const trimmed = await clip(page, aurora.id);
    expect(trimmed.sourceIn).toBeGreaterThan(1.2);
    expect(trimmed.ramp).toEqual(hero.ramp);
    await expect(points(page)).toHaveCount(4);
    await expect(point(page, 1, 4)).toHaveAttribute('aria-valuenow', '30');
    // The chosen point is one of those: no point is marked, and there is none to remove.
    await expect(chosen).toHaveCount(0);
    await expect(remove).toBeDisabled();
    await page.evaluate(() => (window as any).tandem.cmd.trimEdge(-20));
    expect((await clip(page, aurora.id)).sourceIn).toBeCloseTo(0, 9);
    await expect(points(page)).toHaveCount(6);
    await expect(chosen.locator('[aria-label="Ramp point 2 of 6"]')).toHaveCount(1);
    await expect(remove).toBeEnabled();

    // Turned round, the clip plays the end of its media first: the graph is the mirror image.
    await chip(page, 'Flash in').click();
    await expect(chip(page, 'Flash in')).toHaveAttribute('aria-pressed', 'true');
    const flash = await clip(page, aurora.id);
    expect(flash.ramp!.map((q) => q.v)).toEqual([5, 1, 1]);
    await expect(point(page, 1, 3)).toHaveAttribute('aria-valuenow', '500');
    const first = await dot(page, 0);
    await speed(page).getByRole('switch', { name: 'Reverse' }).click();
    const turned = await clip(page, aurora.id);
    expect(turned).toEqual({ ...flash, reverse: true });
    await expect(point(page, 1, 3)).toHaveAttribute('aria-valuenow', '100');
    await expect(point(page, 3, 3)).toHaveAttribute('aria-valuenow', '500');
    await expect(point(page, 3, 3)).toHaveAttribute('aria-valuetext', spoken(turned, p, turned.ramp![0]));
    const box = await graph(page);
    const fast = await dot(page, 2);
    expect(fast.x - box.x).toBeCloseTo(box.x + box.width - first.x, 0);
    expect(fast.y).toBeCloseTo(first.y, 0);
    // What was a fast start is now a fast end: the shape it has is the one seen in play order.
    await expect(chip(page, 'Flash out')).toHaveAttribute('aria-pressed', 'true');
  });

  test('nothing in the section animates when a clip on a ramp is selected', async ({ page }) => {
    await sample(page);
    const dusk = await named(page, 'dusk.mp4');
    const music = await named(page, 'pulse.ogg');
    await select(page, [dusk.id]);
    await setRamp(page, 'hero');
    await select(page, [music.id]);
    await setRamp(page, 'bullet');
    await set(page, { selection: [] });
    await expect(inspector(page).locator('.section')).toHaveCount(0);
    await page.evaluate(() => {
      const started: string[] = ((window as any).started = []);
      document.addEventListener(
        'animationstart',
        (e) => {
          if ((e.target as Element).closest('[aria-label="Inspector"]')) started.push(e.animationName);
        },
        true,
      );
    });
    const started = (): Promise<string[]> => page.evaluate(() => (window as any).started.splice(0));

    // The press that picks up the clip selects it: the graph, its points, its playhead and the
    // rows around it are simply there.
    const on = await page.locator(`[data-clip="${dusk.id}"]`).boundingBox();
    await page.mouse.move(on!.x + on!.width / 2, on!.y + on!.height / 2);
    await page.mouse.down();
    await expect(plot(page)).toBeVisible();
    await expect(points(page)).toHaveCount(6);
    await page.waitForTimeout(200);
    await page.mouse.up();
    expect(await started()).toEqual([]);
    // So are the Keep pitch row and the line under it, for sound on a ramp.
    await select(page, [music.id]);
    await expect(speed(page).getByRole('switch', { name: 'Keep pitch' })).toBeVisible();
    await expect(speed(page).getByText('the sound stays in time')).toBeVisible();
    await expect(points(page)).toHaveCount(5);
    await select(page, [dusk.id, music.id]);
    await expect(speed(page).getByText('Select one clip to shape its ramp.')).toBeVisible();
    await page.waitForTimeout(200);
    expect(await started()).toEqual([]);
  });
});

test.describe('linked clips, several clips and Keep pitch', () => {
  /** Two takes of the test file back to back, each a picture on V1 linked to its sound on A1, two seconds long. */
  async function takes(page: Page): Promise<{ pictures: string[]; sounds: string[] }> {
    await page.route('**/api/health', (route) => route.abort());
    await newProject(page);
    await watchToasts(page);
    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      const [asset] = Object.values(session.store.get().assets);
      for (let i = 0; i < 2; i++)
        cmd.addAsset(asset, { frame: i * 60, sourceIn: i * 2, sourceOut: i * 2 + 2 });
      ui.getState().clearSelection();
    });
    return { pictures: await idsOf(page, 'video'), sounds: await idsOf(page, 'audio') };
  }

  test('a picture and its sound have one graph, and two takes get a shape each', async ({ page }) => {
    const { pictures, sounds } = await takes(page);
    // The sound alone is selected: the ramp is one for it and its picture all the same, and the
    // graph is that of the picture.
    await set(page, { linkedSelection: false });
    await show(page, [sounds[0]]);
    await chip(page, 'Ramp up').click();
    let p = await project(page);
    expect(p.clips[pictures[0]].ramp).toEqual([
      { m: 0, v: 0.5 },
      { m: 2, v: 2 },
    ]);
    expect(p.clips[sounds[0]].ramp).toEqual(p.clips[pictures[0]].ramp);
    expect(p.clips[pictures[1]].ramp).toBeNull();
    await expect(plot(page)).toHaveCount(1);
    await expect(points(page)).toHaveCount(2);
    await expect(chip(page, 'Ramp up')).toHaveAttribute('aria-pressed', 'true');

    // A point dragged there shapes both, and they stay in step on every frame.
    const depth = await undoDepth(page);
    const at = await dot(page, 0);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (const dy of [8, 16, 24]) await page.mouse.move(at.x, at.y - dy);
    await page.mouse.up();
    p = await project(page);
    const [picture, sound] = [p.clips[pictures[0]], p.clips[sounds[0]]];
    expect(picture.ramp![0].v).toBeCloseTo(0.5 * 10 ** ((2 * 24) / 112), 2);
    expect(sound.ramp).toEqual(picture.ramp);
    expect(sound.duration).toBe(picture.duration);
    expect(apart(p, picture, sound)).toBeLessThan(1e-9);
    expect(await undoDepth(page)).toBe(depth + 1);

    // Selected together through their link they have the one graph.
    await set(page, { linkedSelection: true });
    await select(page, [pictures[0]]);
    await expect(plot(page)).toHaveCount(1);
    expect(await plot(page).evaluate((el) => el.hasAttribute('inert'))).toBe(false);
    await expect(points(page)).toHaveCount(2);
    await expect(speed(page).getByRole('button', { name: 'Add point' })).toBeVisible();

    // Two takes: the points are shaped for one clip at a time. A chip gives each its shape.
    await select(page, [pictures[0], pictures[1]]);
    await expect(plot(page)).toHaveAttribute('inert');
    await expect(speed(page).getByText('Select one clip to shape its ramp.')).toBeVisible();
    await expect(speed(page).getByRole('button', { name: 'Add point' })).toHaveCount(0);
    const still = await clip(page, pictures[0]);
    const on = await dot(page, 0);
    await page.mouse.move(on.x, on.y);
    await page.mouse.down();
    await page.mouse.move(on.x, on.y + 20);
    await page.mouse.up();
    expect(await clip(page, pictures[0])).toEqual(still);
    await chip(page, 'Flash out').click();
    p = await project(page);
    expect(p.clips[pictures[0]].ramp!.map((q) => q.v)).toEqual([1, 1, 5]);
    expect(p.clips[pictures[1]].ramp!.map((q) => q.v)).toEqual([1, 1, 5]);
    // Each over the media it plays.
    expect(p.clips[pictures[1]].ramp![0].m).toBe(2);
    expect(p.clips[pictures[1]].ramp![2].m).toBe(4);
    expect(p.clips[pictures[0]].ramp![0].m).toBe(0);
    for (const i of [0, 1]) {
      expect(p.clips[sounds[i]].ramp).toEqual(p.clips[pictures[i]].ramp);
      expect(apart(p, p.clips[pictures[i]], p.clips[sounds[i]])).toBeLessThan(1e-9);
    }
    await expect(chip(page, 'Flash out')).toHaveAttribute('aria-pressed', 'true');
    await select(page, [pictures[1]]);
    await expect(plot(page)).toHaveCount(1);
    expect(await plot(page).evaluate((el) => el.hasAttribute('inert'))).toBe(false);
    await expect(points(page)).toHaveCount(3);

    // With the sound's track locked the picture cannot go anywhere its sound cannot follow: a
    // drag changes nothing, and says why once, when it ends.
    await page.evaluate(
      (id) =>
        (window as any).tandem.session.store.commit([{ op: 'updateTrack', id, patch: { locked: true } }]),
      p.clips[sounds[1]].trackId,
    );
    const refusal = 'Unlock A1 to ramp this clip: what is linked to it has to follow.';
    const held = await project(page);
    const middle = await dot(page, 1);
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.down();
    for (const [dx, dy] of [
      [-8, 0],
      [-16, 6],
      [-24, 18],
    ]) {
      await page.mouse.move(middle.x + dx, middle.y + dy);
      expect(await said(page, refusal)).toHaveLength(0);
    }
    await page.mouse.up();
    await expect.poll(() => said(page, refusal)).toHaveLength(1);
    expect((await project(page)).clips).toEqual(held.clips);
    await page.waitForTimeout(900);
    expect(await said(page, refusal)).toHaveLength(1);
  });

  test('Keep pitch is a switch on what has sound, on from the first change of speed', async ({ page }) => {
    await sample(page);
    const dusk = await named(page, 'dusk.mp4');
    const music = await named(page, 'pulse.ogg');
    const keep = speed(page).getByRole('switch', { name: 'Keep pitch' });
    const rough = speed(page).getByText('Beyond 400% or under 25% the sound stays in time but turns rough.');
    const follows = speed(page).getByText('Beyond 1000% or under 10% the pitch follows the speed.');

    // A silent picture has no pitch to keep.
    await show(page, [dusk.id]);
    await expect(speed(page).getByRole('switch', { name: 'Reverse' })).toBeVisible();
    await expect(keep).toHaveCount(0);
    // Sound has, and sound whose speed nobody changed plays as it always did.
    await select(page, [music.id]);
    await expect(keep).toHaveAttribute('aria-checked', 'false');
    expect((await clip(page, music.id)).keepPitch).toBeNull();

    // The first change of speed switches it on, as part of that step.
    let depth = await undoDepth(page);
    await setSpeed(page, 1.5);
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    expect((await clip(page, music.id)).keepPitch).toBe(true);
    expect(await undoDepth(page)).toBe(depth + 1);
    await expect(rough).toHaveCount(0);
    await expect(follows).toHaveCount(0);

    // Switched off, it stays off through the next change of speed. Each is one step.
    depth = await undoDepth(page);
    await keep.click();
    await expect(keep).toHaveAttribute('aria-checked', 'false');
    expect(await clip(page, music.id)).toMatchObject({ keepPitch: false, speed: 1.5 });
    expect(await undoDepth(page)).toBe(depth + 1);
    await setSpeed(page, 2);
    await expect(keep).toHaveAttribute('aria-checked', 'false');
    expect(await clip(page, music.id)).toMatchObject({ keepPitch: false, speed: 2 });
    await keep.click();
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    expect(await undoDepth(page)).toBe(depth + 3);
    await expect(rough).toHaveCount(0);

    // What the stretch cannot do well is said under the switch while it is on: rough beyond
    // 400% or under 25%, as on a Bullet, which goes to 500%.
    await chip(page, 'Bullet').click();
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    await expect(rough).toBeVisible();
    await expect(follows).toHaveCount(0);
    await keep.click();
    await expect(rough).toHaveCount(0);
    await keep.click();
    await expect(rough).toBeVisible();
    // At one speed beyond 1000% the pitch is not kept at all, and that is what is said.
    await setSpeed(page, 20);
    expect(await clip(page, music.id)).toMatchObject({ keepPitch: true, speed: 20, ramp: null });
    await expect(follows).toBeVisible();
    await expect(rough).toHaveCount(0);
    await setSpeed(page, 6);
    await expect(rough).toBeVisible();
    await expect(follows).toHaveCount(0);
  });
});

test.describe('a ramp and two people', () => {
  /** The owner with the sample edit and its last shot on Hero, and someone who has joined by a link. */
  async function together(
    page: Page,
    browser: Browser,
    role: 'editor' | 'viewer',
  ): Promise<{ b: Page; close: () => Promise<void>; hero: Clip }> {
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
    await expect.poll(() => clips(page), { timeout: 60_000 }).toEqual(SAMPLE);
    const aurora = await named(page, 'aurora.mp4');
    await show(page, [aurora.id]);
    await chip(page, 'Hero').click();
    const hero = await clip(page, aurora.id);
    const link: string = await page.evaluate((role) => (window as any).tandem.session.inviteLink(role), role);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.routeWebSocket(/\/\?token=/, () => {});
    const b = await context.newPage();
    await b.goto(link);
    await b.waitForFunction(() => (window as any).tandem?.session?.getMeta().status === 'connected');
    await expect.poll(() => clip(b, aurora.id)).toEqual(hero);
    await select(b, [aurora.id]);
    return { b, close: () => context.close(), hero };
  }

  /** The other person takes the point at second `m` out of the ramp, as they have it by now. */
  const removes = (b: Page, id: string, m: number): Promise<void> =>
    b.evaluate(
      ([id, m]) => {
        const { session, cmd } = (window as any).tandem;
        const ramp: RampPoint[] = session.store.get().clips[id].ramp;
        cmd.setRampPoints(ramp.filter((q) => q.m !== m));
      },
      [id, m] as const,
    );

  test('a point somebody else removes during a drag stays removed, and the drag goes on', async ({
    page,
    browser,
  }) => {
    const { b, close, hero } = await together(page, browser, 'editor');
    const at = await dot(page, 1);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x, at.y + 10);
    await page.mouse.move(at.x, at.y + 16);
    const lowered = (await clip(page, hero.id)).ramp![1];
    expect(lowered.m).toBe(1);
    expect(lowered.v).toBeLessThan(3.2);
    // They have the drag so far, and take out the point at second 3.
    await expect.poll(async () => (await clip(b, hero.id)).ramp![1]).toEqual(lowered);
    await removes(b, hero.id, 3);
    await expect.poll(async () => (await clip(page, hero.id)).ramp!.length).toBe(5);
    // The drag carries on with the point it holds, in the ramp as it now is.
    await page.mouse.move(at.x, at.y + 22);
    await page.mouse.move(at.x, at.y + 28);
    const after = (await clip(page, hero.id)).ramp!;
    expect(after.map((q) => q.m)).toEqual([0, 1, 1.6, 2.4, 4]);
    expect(after[1].v).toBeCloseTo(4 * 10 ** ((-2 * 28) / 112), 2);
    await page.mouse.up();
    expect((await clip(page, hero.id)).ramp).toEqual(after);
    await expect.poll(async () => (await clip(b, hero.id)).ramp).toEqual(after);
    await expect(points(page)).toHaveCount(5);
    await close();
  });

  test('a drag ends when somebody else removes the point it holds', async ({ page, browser }) => {
    const { b, close, hero } = await together(page, browser, 'editor');
    const at = await dot(page, 1);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x, at.y + 10);
    await page.mouse.move(at.x, at.y + 16);
    const lowered = (await clip(page, hero.id)).ramp![1];
    await expect.poll(async () => (await clip(b, hero.id)).ramp![1]).toEqual(lowered);
    // They take out the very point that is being dragged.
    await removes(b, hero.id, 1);
    await expect.poll(async () => (await clip(page, hero.id)).ramp!.length).toBe(5);
    const theirs = await clip(page, hero.id);
    expect(theirs.ramp!.map((q) => q.m)).toEqual([0, 1.6, 2.4, 3, 4]);
    // Nothing the pointer does from here on brings the point back, or moves another in its place.
    for (const dy of [22, 28, 40, 0]) await page.mouse.move(at.x, at.y + dy);
    await page.mouse.up();
    expect(await clip(page, hero.id)).toEqual(theirs);
    await page.waitForTimeout(300);
    expect(await clip(b, hero.id)).toEqual(theirs);
    await expect(points(page)).toHaveCount(5);
    // The next press is a drag of its own, on the points that are there.
    const next = await dot(page, 1);
    await page.mouse.move(next.x, next.y);
    await page.mouse.down();
    await page.mouse.move(next.x, next.y - 12);
    await page.mouse.up();
    expect((await clip(page, hero.id)).ramp![1].m).toBe(1.6);
    expect((await clip(page, hero.id)).ramp![1].v).toBeGreaterThan(0.3);
    await close();
  });

  test('someone who may only look sees the ramp and cannot work it', async ({ page, browser }) => {
    const { b, close, hero } = await together(page, browser, 'viewer');
    expect(await b.evaluate(() => (window as any).tandem.session.getMeta().role)).toBe('viewer');
    const head = inspector(b).locator('.section__head', { hasText: 'Speed' });
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    await expect(speed(b).locator('.section__body')).toHaveAttribute('inert');
    await expect(plot(b)).toBeVisible();
    await expect(points(b)).toHaveCount(6);
    await expect(chip(b, 'Hero')).toHaveAttribute('aria-pressed', 'true');
    // Neither the points nor the chips answer.
    const at = await dot(b, 1);
    await b.mouse.move(at.x, at.y);
    await b.mouse.down();
    await b.mouse.move(at.x, at.y + 20);
    await b.mouse.up();
    await b.mouse.dblclick(at.x, at.y);
    const none = await chip(b, 'None').boundingBox();
    await b.mouse.click(none!.x + none!.width / 2, none!.y + none!.height / 2);
    await b.waitForTimeout(300);
    expect(await clip(b, hero.id)).toEqual(hero);
    expect(await clip(page, hero.id)).toEqual(hero);
    expect(await b.evaluate(() => document.activeElement?.getAttribute('role'))).not.toBe('slider');
    await close();
  });
});
