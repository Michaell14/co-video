import { expect, test, type Locator, type Page } from '@playwright/test';
import { clips, ffprobe, hasFfprobe, importFixtures, newProject } from './helpers';

const SAMPLE = ['audio@0+360', 'text@18+90', 'video@0+120', 'video@120+120', 'video@240+120'];

/**
 * A project that lives in this browser only, holding the bundled sample edit: dusk, fractal and
 * aurora (four seconds each) on V1, a title on V2, music on A1 and the playhead on frame 45.
 */
async function sample(page: Page): Promise<void> {
  await newLocal(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect.poll(() => clips(page), { timeout: 60_000 }).toEqual(SAMPLE);
  await expect(page.locator('.clip')).toHaveCount(5);
}

async function newLocal(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
}

/** The earliest clip that shows the media file `name`, or is a `title`. */
const clip = (page: Page, name: string): Promise<any> =>
  page.evaluate(
    (name) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .sort((a, b) => a.start - b.start)
        .find((c) => (name === 'title' ? c.type === 'text' : c.name === name)),
    name,
  );

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((ids) => (window as any).tandem.ui.getState().select(ids), ids);

const seek = async (page: Page, frame: number): Promise<void> => {
  await page.evaluate((f) => (window as any).tandem.cmd.seek(f), frame);
  // The inspector reads animated values a few times a second.
  await page.waitForTimeout(250);
};

const undoDepth = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);

const undo = (page: Page): Promise<void> => page.evaluate(() => (window as any).tandem.cmd.undo());

const set = (page: Page, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate((patch) => (window as any).tandem.ui.getState().set(patch), patch);

/** `V1:name@start+duration` for every clip, sorted. */
const layout = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const p = (window as any).tandem.session.store.get();
    const track = (id: string) => `${p.tracks[id].kind === 'video' ? 'V' : 'A'}${p.tracks[id].order + 1}`;
    return (Object.values(p.clips) as any[])
      .map((c) => `${track(c.trackId)}:${c.name || c.type}@${c.start}+${c.duration}`)
      .sort();
  });

async function box(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await target.boundingBox();
  if (!b) throw new Error('not on screen');
  return b;
}

/** Type into a field of the inspector and confirm with Enter. */
async function enter(field: Locator, text: string): Promise<void> {
  await field.click();
  await field.press('Control+a');
  await field.pressSequentially(text);
  await field.press('Enter');
}

const inspector = (page: Page) => page.locator('[aria-label="Inspector"]');

/** The colour a design token stands for, as computed styles report it. */
const token = (page: Page, name: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.backgroundColor = `var(${name})`;
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  }, name);

const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text }).first();

/**
 * Keys pressed on the focused control one straight after the other, as a held key repeats: each in
 * a turn of its own, with nothing but the page's own work between them. A run of presses is told
 * from the next by a rest of over half a second, and presses sent one by one to a busy page can
 * lie further apart than that.
 */
const burst = (page: Page, keys: string[]): Promise<void> =>
  page.evaluate(async (keys) => {
    for (const name of keys) {
      const shiftKey = name.startsWith('Shift+');
      const ctrlKey = name.startsWith('Control+');
      const key = name.slice(name.indexOf('+') + 1);
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, ctrlKey, bubbles: true, cancelable: true }),
      );
      await new Promise((turn) => setTimeout(turn));
    }
  }, keys);

// A file saved while the suite runs makes the dev server reload the page under the test; its
// socket is left unanswered so that cannot happen.
test.beforeEach(async ({ context }) => {
  await context.routeWebSocket(/\/\?token=/, () => {});
});

test.describe('inspector', () => {
  test('a speed gesture is one undo step, measured from where it began', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    const fractal = await clip(page, 'fractal.mp4');
    await select(page, [dusk.id]);
    await inspector(page).locator('.section__head', { hasText: 'Speed' }).click();
    const speed = inspector(page).locator('.section', { hasText: 'Presets' });
    const field = speed.getByRole('textbox', { name: 'Speed', exact: true });
    await speed.getByText('Duration').scrollIntoViewIfNeeded();
    const depth = await undoDepth(page);

    // Scrub the number down to 70% and back in one drag. The next clip holds dusk at 120 frames
    // on the way down; back at 100% it has to be the clip it was.
    const b = await box(field);
    const y = b.y + b.height / 2;
    const scrub = async (meanwhile: (dx: number) => Promise<void> = async () => {}) => {
      await page.mouse.move(b.x + b.width / 2, y);
      await page.mouse.down();
      for (let dx = 3; dx <= 30; dx += 3) {
        await page.mouse.move(b.x + b.width / 2 - dx, y);
        await meanwhile(dx);
      }
      expect(await clip(page, 'dusk.mp4')).toMatchObject({ speed: 0.7, duration: 120 });
      for (let dx = 27; dx >= 0; dx -= 3) {
        await page.mouse.move(b.x + b.width / 2 - dx, y);
        await meanwhile(dx);
      }
      await page.mouse.up();
    };
    await scrub();
    expect(await clip(page, 'dusk.mp4')).toEqual(dusk);
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);

    // The same drag while somebody else is at work: between any two moves an edit of theirs
    // arrives, to the title and to the look of dusk itself. It stays one gesture.
    const title = await clip(page, 'title');
    await scrub((dx) =>
      page.evaluate(
        ([ids, opacity]) => {
          const { doc } = (window as any).tandem.session.store;
          doc.transact(() => {
            for (const id of ids) doc.getMap('clips').get(id).set('opacity', opacity);
          }, 'peer');
        },
        [[title.id, dusk.id], 0.5 + dx / 100] as const,
      ),
    );
    expect(await clip(page, 'title')).toEqual({ ...title, opacity: 0.5 });
    expect(await clip(page, 'dusk.mp4')).toEqual({ ...dusk, opacity: 0.5 });
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);
    expect(await clip(page, 'dusk.mp4')).toEqual({ ...dusk, opacity: 0.5 });

    // A double-click on the slider resets the speed: one step, and nothing lost on the way.
    await page.evaluate(() => (window as any).tandem.cmd.setSpeed(0.5));
    const slowed = await clip(page, 'dusk.mp4');
    expect(slowed).toMatchObject({ speed: 0.5, duration: 120 });
    const slider = await box(speed.locator('.slider').first());
    await page.mouse.dblclick(slider.x + slider.width * 0.9, slider.y + slider.height / 2);
    // Half speed showed 60 frames' worth of source; at full speed that is 60 frames.
    expect(await clip(page, 'dusk.mp4')).toMatchObject({ speed: 1, duration: 60 });
    expect(await undoDepth(page)).toBe(depth + 2);
    await undo(page);
    expect(await clip(page, 'dusk.mp4')).toEqual(slowed);
    await undo(page);

    // Reverse changes the direction of each clip and leaves its speed alone.
    await select(page, [fractal.id]);
    await page.evaluate(() => (window as any).tandem.cmd.setSpeed(2));
    await select(page, [dusk.id, fractal.id]);
    await page.getByRole('switch', { name: 'Reverse' }).click();
    expect(await clip(page, 'dusk.mp4')).toMatchObject({ speed: 1, duration: 120, reverse: true });
    expect(await clip(page, 'fractal.mp4')).toMatchObject({ speed: 2, duration: 60, reverse: true });
  });

  test('the keyframe diamond offers the interpolation, for every selected clip with a key there', async ({
    page,
  }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    const title = await clip(page, 'title');
    await select(page, [title.id, dusk.id]);
    const diamond = inspector(page).getByRole('button', { name: 'Toggle keyframe for Position X' });
    const x = inspector(page).getByLabel('Position X', { exact: true });
    await seek(page, 30);
    await diamond.click();
    await seek(page, 60);
    await enter(x, '400');
    const easings = async () =>
      Promise.all(
        ['title', 'dusk.mp4'].map(async (n) => (await clip(page, n)).keyframes.x.map((k: any) => k.e)),
      );
    expect(await easings()).toEqual([
      ['easeInOut', 'easeInOut'],
      ['easeInOut', 'easeInOut'],
    ]);

    // A quarter of the way from one key to the next an eased move lags behind a linear one.
    await seek(page, 37);
    expect(Number(await x.inputValue())).toBeLessThan(80);

    await seek(page, 30);
    const depth = await undoDepth(page);
    const checked = page.locator('[role="menuitem"]:has(.menu-item__check svg)');
    await diamond.click({ button: 'right' });
    await expect(page.getByRole('menu')).toContainText('From this keyframe to the next');
    await expect(checked).toHaveText('Ease in-out');
    await page.getByRole('menuitem', { name: 'Linear' }).click();
    expect(await easings()).toEqual([
      ['linear', 'easeInOut'],
      ['linear', 'easeInOut'],
    ]);
    expect(await undoDepth(page)).toBe(depth + 1);
    await seek(page, 37);
    expect(Number(await x.inputValue())).toBeCloseTo((400 * 7) / 30, 0);

    // The menu shows what is set now; Hold keeps the value until the next key.
    await seek(page, 30);
    await diamond.click({ button: 'right' });
    await expect(checked).toHaveText('Linear');
    await page.getByRole('menuitem', { name: 'Hold' }).click();
    await seek(page, 59);
    expect(Number(await x.inputValue())).toBe(0);

    // Away from a keyframe there is nothing to set, and clearing is still on offer.
    await diamond.click({ button: 'right' });
    await expect(page.getByRole('menu')).toContainText('No keyframe at the playhead');
    await expect(page.getByRole('menuitem', { name: 'Linear' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Clear all keyframes' })).toBeEnabled();
    await page.keyboard.press('Escape');

    await undo(page);
    await undo(page);
    expect(await easings()).toEqual([
      ['easeInOut', 'easeInOut'],
      ['easeInOut', 'easeInOut'],
    ]);
  });

  test('a clip is named, placed and given a length by typing', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    const fractal = await clip(page, 'fractal.mp4');
    const aurora = await clip(page, 'aurora.mp4');
    const start = inspector(page).getByLabel('Start', { exact: true });
    const duration = inspector(page).getByLabel('Duration', { exact: true });
    const depth = await undoDepth(page);

    await select(page, [dusk.id]);
    await expect(duration).toHaveValue('00:00:04:00');
    // Longer is not possible: fractal follows straight on. That is said, and nothing is overwritten.
    await enter(duration, '6:00');
    await expect(toast(page, 'Stopped at the end of the media or at the next clip.')).toBeVisible();
    expect(await layout(page)).toContain('V1:dusk.mp4@0+120');
    expect(await undoDepth(page)).toBe(depth);
    // Shorter leaves a gap, unless ripple mode closes it.
    await enter(duration, '2:00');
    expect(await layout(page)).toEqual(
      expect.arrayContaining(['V1:dusk.mp4@0+60', 'V1:fractal.mp4@120+120', 'V1:aurora.mp4@240+120']),
    );
    await undo(page);
    await set(page, { rippleMode: true });
    await enter(duration, '2:00');
    expect(await layout(page)).toEqual(
      expect.arrayContaining(['V1:dusk.mp4@0+60', 'V1:fractal.mp4@60+120', 'V1:aurora.mp4@180+120']),
    );
    await undo(page);
    await set(page, { rippleMode: false });

    // Start: a place that is taken moves the clip no further than its neighbour, a free one is taken.
    await select(page, [aurora.id]);
    await enter(start, '2:00');
    await expect(toast(page, 'Another clip is in the way')).toBeVisible();
    expect((await clip(page, 'aurora.mp4')).start).toBe(240);
    await enter(start, '+60');
    expect((await clip(page, 'aurora.mp4')).start).toBe(300);
    await expect(start).toHaveValue('00:00:10:00');
    await undo(page);

    // Several clips take one length in one step.
    await select(page, [dusk.id, fractal.id, aurora.id]);
    await enter(duration, '3:00');
    expect(await layout(page)).toEqual(
      expect.arrayContaining(['V1:dusk.mp4@0+90', 'V1:fractal.mp4@120+90', 'V1:aurora.mp4@240+90']),
    );
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);

    // An entry is for the clip it was typed for, also when the click that ends it selects another.
    await select(page, [aurora.id]);
    for (const [field, text, result] of [
      [duration, '1:00', 'V1:aurora.mp4@240+30'],
      [start, '20:00', 'V1:aurora.mp4@600+120'],
    ] as const) {
      await field.click();
      await field.press('Control+a');
      await field.pressSequentially(text);
      await page.locator(`.clip[data-clip="${dusk.id}"]`).click();
      expect(await layout(page)).toEqual(expect.arrayContaining(['V1:dusk.mp4@0+120', result]));
      expect(await page.evaluate(() => (window as any).tandem.ui.getState().selection)).toEqual([dusk.id]);
      expect(await undoDepth(page)).toBe(depth + 1);
      await undo(page);
      await page.locator(`.clip[data-clip="${aurora.id}"]`).click();
    }

    // The name shows wherever the clip is named.
    await select(page, [dusk.id]);
    const name = inspector(page).getByLabel('Clip name');
    await name.fill('Opening shot');
    await expect(page.locator('.insp__title')).toHaveText('Opening shot');
    await expect(page.locator(`.clip[data-clip="${dusk.id}"]`)).toContainText('Opening shot');
    expect(await undoDepth(page)).toBe(depth + 1);
  });

  test('rows keep one label edge and one column of fields', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    const title = await clip(page, 'title');
    await select(page, [dusk.id]);
    const insp = inspector(page);
    const field = async (label: string) =>
      box(insp.getByRole('textbox', { name: label, exact: true }).locator('..'));
    // The linked Scale row has its link toggle in the label, so its field lines up with the rest.
    const scale = await field('Scale');
    const rotation = await field('Rotation');
    expect(scale.x).toBe(rotation.x);
    expect(scale.width).toBe(rotation.width);
    await expect(
      insp.locator('.row__label').getByRole('button', { name: 'Unlink scale axes' }),
    ).toBeVisible();

    // Labels of rows without a keyframe diamond start where the others do.
    const textLeft = (label: string) =>
      insp
        .locator('.row__label', { hasText: label })
        .first()
        .evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el.querySelector('span') ?? el);
          return Math.round(range.getBoundingClientRect().left);
        });
    const edge = await textLeft('Rotation');
    expect(await textLeft('Fit')).toBe(edge);
    expect(await textLeft('Flip')).toBe(edge);

    // A value that is only shown starts where the text inside the fields around it does.
    const typed = await insp
      .getByLabel('Start', { exact: true })
      .evaluate((el) =>
        Math.round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)),
      );
    const shown = await insp
      .locator('.row', { hasText: 'End' })
      .locator('.insp__read')
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return Math.round(range.getBoundingClientRect().left);
      });
    expect(shown).toBe(typed);

    // A property that is animated gains its keyframe arrows without its number leaving the column.
    const still = { opacity: await field('Opacity'), y: await field('Position Y') };
    await page.evaluate((id) => {
      const key = (t: number, v: number) => ({ t, v, e: 'linear' });
      (window as any).tandem.session.store.commit([
        {
          op: 'updateClip',
          id,
          patch: {
            keyframes: {
              opacity: [key(0, 0.2), key(60, 1)],
              x: [key(0, -0.1), key(60, 0.1)],
              scaleX: [key(0, 1), key(60, 1.2)],
              scaleY: [key(0, 1), key(60, 1.2)],
            },
          },
        },
      ]);
    }, dusk.id);
    await expect(insp.getByRole('button', { name: 'Next keyframe' })).toHaveCount(3);
    const moving = {
      opacity: await field('Opacity'),
      x: await field('Position X'),
      scale: await field('Scale'),
    };
    expect([moving.opacity.x, moving.opacity.width]).toEqual([still.opacity.x, still.opacity.width]);
    expect([moving.scale.x, moving.scale.width]).toEqual([scale.x, scale.width]);
    expect(moving.x.x + moving.x.width).toBe(still.y.x + still.y.width);
    // The arrows step from key to key, on the linked scale as on any other row.
    await insp.locator('.row', { hasText: 'Scale' }).getByRole('button', { name: 'Next keyframe' }).click();
    expect(await page.evaluate(() => (window as any).tandem.session.player.getFrame())).toBe(60);
    await insp
      .locator('.row', { hasText: 'Opacity' })
      .getByRole('button', { name: 'Previous keyframe' })
      .click();
    expect(await page.evaluate(() => (window as any).tandem.session.player.getFrame())).toBe(0);

    // What a switch of the text style turns on is set off under it, in the same control column.
    await select(page, [title.id]);
    // And a number a switch turns on stands in the column of the numbers above it.
    const wrap = insp.locator('.row', { hasText: 'Wrap width' });
    if ((await wrap.getByRole('switch').getAttribute('aria-checked')) === 'false')
      await wrap.getByRole('switch').click();
    const wrapped = await box(wrap.locator('.num'));
    const tracking = await box(insp.locator('.row', { hasText: 'Tracking' }).locator('.num'));
    expect([wrapped.x, wrapped.width]).toEqual([tracking.x, tracking.width]);
    await insp.locator('.section__head', { hasText: 'Text style' }).click();
    await page.getByRole('switch', { name: 'Outline' }).click();
    const outline = insp.locator('.subrows').first();
    // Read out, each row carries the name of its group; on screen only its own words show.
    await expect(outline.locator('.row__label')).toHaveText(['Outline Colour', 'Outline Width']);
    await expect(outline.locator('.row__label .sr-only')).toHaveText(['Outline', 'Outline']);
    const inner = await box(outline.locator('.row__ctrl').first());
    const outer = await box(insp.locator('.row', { hasText: 'Outline' }).first().locator('.row__ctrl'));
    expect(inner.x).toBe(outer.x);

    // Width and height of the project share their row in two halves.
    await set(page, { selection: [] });
    const w = await box(insp.locator('.row', { hasText: 'Size' }).locator('.num').first());
    const h = await box(insp.locator('.row', { hasText: 'Size' }).locator('.num').last());
    const rate = await box(insp.locator('.row', { hasText: 'Frame rate' }).locator('.select'));
    expect(Math.abs(w.width - h.width)).toBeLessThanOrEqual(1);
    expect(Math.round(h.x + h.width)).toBe(Math.round(rate.x + rate.width));
  });

  test('controls take their names from the rows they stand in', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    const title = await clip(page, 'title');
    const insp = inspector(page);
    const one = (role: 'button' | 'textbox' | 'slider' | 'group' | 'switch', name: string) =>
      expect(page.getByRole(role, { name, exact: true })).toHaveCount(1);

    await select(page, [dusk.id]);
    await one('button', 'Blend mode Normal');
    await one('slider', 'Scale');
    await one('textbox', 'Scale');
    // A slider says its value the way the field beside it shows it.
    await insp.locator('.section__head', { hasText: 'Speed' }).click();
    await expect(insp.getByRole('slider', { name: 'Speed', exact: true })).toHaveAttribute(
      'aria-valuetext',
      '100%',
    );

    // A title has a colour of its own, and one for each part of its style that is switched on.
    await select(page, [title.id]);
    await one('group', 'Align');
    await insp.locator('.section__head', { hasText: 'Text style' }).click();
    for (const name of ['Outline', 'Shadow']) {
      const part = page.getByRole('switch', { name, exact: true });
      if ((await part.getAttribute('aria-checked')) === 'false') await part.click();
    }
    await one('textbox', 'Colour Hex colour');
    await one('textbox', 'Outline Colour Hex colour');
    await one('textbox', 'Shadow Colour Hex colour');
    await one('slider', 'Shadow Opacity');

    await set(page, { selection: [] });
    await one('textbox', 'Size W');
    await one('textbox', 'Size H');

    await set(page, { workspace: 'color', selection: [dusk.id] });
    for (const name of ['Temp', 'Lift master', 'Lift colour balance']) await one('slider', name);

    await set(page, { workspace: 'audio' });
    for (const name of ['Pan, A1', 'Volume, A1']) await one('slider', name);
    await one('textbox', 'Volume, A1');
    await expect(page.getByRole('slider', { name: 'Pan, A1' })).toHaveAttribute('aria-valuetext', 'C');
    // The strip's buttons show a letter and say what they do, and to which track.
    for (const [name, shown] of [
      ['Mute, A1', 'M'],
      ['Solo, A1', 'S'],
      ['EQ and compressor, A1', 'FX'],
    ]) {
      await one('button', name);
      await expect(page.getByRole('button', { name, exact: true })).toHaveText(shown);
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
    }
    await page.getByRole('button', { name: 'EQ and compressor, A1' }).click();
    for (const name of ['EQ high', 'Compressor threshold', 'Compressor make-up gain'])
      await one('slider', name);

    await set(page, { workspace: 'edit', dialog: 'export' });
    await expect(page.locator('.exp .spinner')).toHaveCount(0);
    await one('button', 'Codec H.264 (AVC)');
    await one('group', 'Quality');
    // The other group of choices stands under the row label 'Export', which says too little by itself.
    await one('group', 'Export range');
    await expect(page.getByRole('option', { name: /· project$/ })).toHaveCount(0);
    await page.locator('.exp .row', { hasText: 'Resolution' }).locator('.select').click();
    await expect(page.getByRole('option', { name: '1920×1080 · project' })).toHaveCount(1);
  });

  test('the speed controls ripple with ripple editing, and offer room without it', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    await select(page, [dusk.id]);
    await inspector(page).locator('.section__head', { hasText: 'Speed' }).click();
    const speed = inspector(page).locator('.section', { hasText: 'Presets' });
    const field = speed.getByRole('textbox', { name: 'Speed', exact: true });
    const places = async () => (await layout(page)).filter((c) => c.startsWith('V1:'));
    const before = await places();
    expect(before).toEqual(['V1:aurora.mp4@240+120', 'V1:dusk.mp4@0+120', 'V1:fractal.mp4@120+120']);
    const depth = await undoDepth(page);

    // Without ripple editing the next clip holds dusk at its length: the panel says so, as the
    // presets do, and offers to make the room.
    await enter(field, '50');
    expect(await clip(page, 'dusk.mp4')).toMatchObject({ speed: 0.5, duration: 120 });
    const offer = toast(page, 'The next clip is in the way');
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Make room' }).click();
    expect(await places()).toEqual(['V1:aurora.mp4@360+120', 'V1:dusk.mp4@0+240', 'V1:fractal.mp4@240+120']);
    await undo(page);
    await undo(page);
    expect(await places()).toEqual(before);
    expect(await undoDepth(page)).toBe(depth);

    // With it, what follows moves with the end of the clip, from the field and from the slider.
    await set(page, { rippleMode: true });
    await enter(field, '50');
    expect(await places()).toEqual(['V1:aurora.mp4@360+120', 'V1:dusk.mp4@0+240', 'V1:fractal.mp4@240+120']);
    expect(await undoDepth(page)).toBe(depth + 1);
    const slider = speed.getByRole('slider', { name: 'Speed', exact: true });
    await slider.focus();
    await page.keyboard.press('Delete');
    expect(await clip(page, 'dusk.mp4')).toMatchObject({ speed: 1, duration: 120 });
    expect(await places()).toEqual(before);
    await page.waitForTimeout(900);
    await expect(toast(page, 'The next clip is in the way')).toHaveCount(0);

    // Where what follows cannot move, the clip stops at the next one as it does without ripple
    // editing, and the panel says why: once, when the gesture has ended. Here the next clip has
    // its sound on a locked track, and the two would be parted.
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.addTrack('audio');
      const p = session.store.get();
      const all = Object.values(p.clips) as any[];
      const a2 = (Object.values(p.tracks) as any[]).find((t) => t.kind === 'audio' && t.order === 1);
      const music = all.find((c) => c.type === 'audio');
      const fractal = all.find((c) => c.name === 'fractal.mp4');
      const sound = { ...music, id: 'sound', trackId: a2.id, start: 120, duration: 120, linkId: 'pair' };
      session.store.commit([
        { op: 'addClip', clip: sound },
        { op: 'updateClip', id: fractal.id, patch: { linkId: 'pair' } },
        { op: 'updateTrack', id: a2.id, patch: { locked: true } },
      ]);
    });
    const refusal = page.locator('.toast', { hasText: 'Unlock A2 to ripple' });
    const track = await box(speed.locator('.slider').first());
    const y = track.y + track.height / 2;
    // 100% lies three sevenths along the slider, which runs from an eighth of the speed to 16 times.
    await page.mouse.move(track.x + (track.width * 3) / 7, y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(track.x + track.width * (3 / 7 - step * 0.02), y);
      await expect(refusal).toHaveCount(0);
    }
    await page.mouse.up();
    await expect(refusal).toHaveCount(1);
    await expect(refusal).toHaveText('Unlock A2 to ripple: a linked clip on it has to move too.');
    const slowed = await clip(page, 'dusk.mp4');
    expect(slowed.speed).toBeLessThan(0.6);
    expect(slowed.duration).toBe(120);
    expect(await places()).toEqual(before);
    // The same gesture, now that the track can follow, says nothing.
    await undo(page);
    await expect(refusal).toHaveCount(0, { timeout: 10_000 });
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const a2 = (Object.values(session.store.get().tracks) as any[]).find(
        (t) => t.kind === 'audio' && t.order === 1,
      );
      session.store.commit([{ op: 'updateTrack', id: a2.id, patch: { locked: false } }]);
    });
    await enter(field, '50');
    expect(await places()).toEqual(['V1:aurora.mp4@360+120', 'V1:dusk.mp4@0+240', 'V1:fractal.mp4@240+120']);
    await page.waitForTimeout(900);
    await expect(refusal).toHaveCount(0);
  });

  test('an effect added by hand is brought into view, and removing one keeps the keyboard in the list', async ({
    page,
  }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    await select(page, [dusk.id]);
    const insp = inspector(page);
    const body = insp.locator('.panel__body');
    const effects = insp.locator('.section', { has: page.locator('.section__head', { hasText: 'Effects' }) });
    await expect(effects.locator('.fxitem')).toHaveCount(dusk.effects.length);
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(effects.locator('.fxitem').last()).not.toBeInViewport();

    // From the library: the section is the last of the panel, and the new effect is shown.
    await page.getByRole('tab', { name: 'Effects' }).click();
    await page.getByLabel('Search effects').fill('invert');
    await page.locator('.fx', { hasText: 'Invert' }).click();
    const added = effects.locator('.fxitem', { hasText: 'Invert' });
    await expect(added).toBeInViewport({ ratio: 1 });

    // An effect that arrives from someone else leaves the panel where the person has it.
    await body.evaluate((el) => (el.scrollTop = 0));
    await page.evaluate((id) => {
      const { store } = (window as any).tandem.session;
      const effects = store.get().clips[id].effects;
      store.commit([
        {
          op: 'updateClip',
          id,
          patch: { effects: [...effects, { id: 'theirs', type: 'sepia', enabled: true, params: {} }] },
        },
      ]);
    }, dusk.id);
    await expect(effects.locator('.fxitem')).toHaveCount(dusk.effects.length + 2);
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);

    // A folded section is opened for the effect it is given.
    const head = effects.locator('.section__head');
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await page.getByLabel('Search effects').fill('vignette');
    await page.locator('.fx', { hasText: 'Vignette' }).first().click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(effects.locator('.fxitem', { hasText: 'Vignette' }).last()).toBeInViewport({ ratio: 1 });

    // Remove them one by one from the keyboard: the focus moves to the next, then to where
    // effects come from.
    const count = await effects.locator('.fxitem').count();
    const remove = effects.getByRole('button', { name: 'Remove effect' });
    await remove.first().focus();
    for (let left = count; left > 1; left--) {
      await page.keyboard.press('Enter');
      await expect(effects.locator('.fxitem')).toHaveCount(left - 1);
      await expect(remove.first()).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(effects.locator('.fxitem')).toHaveCount(0);
    await expect(effects.getByRole('button', { name: 'Browse effects', exact: true })).toBeFocused();
    expect((await clip(page, 'dusk.mp4')).effects).toEqual([]);
  });

  test('a typed timecode goes to the clip as it is when applied, and goes with a clip that leaves', async ({
    page,
  }) => {
    await sample(page);
    const aurora = await clip(page, 'aurora.mp4');
    const fractal = await clip(page, 'fractal.mp4');
    await select(page, [aurora.id]);
    const start = inspector(page).getByLabel('Start', { exact: true });

    // Twelve frames on, typed while someone else moves the clip: twelve on from where it is now.
    await start.click();
    await start.pressSequentially('+12');
    await page.evaluate((id) => {
      const { doc } = (window as any).tandem.session.store;
      doc.transact(() => doc.getMap('clips').get(id).set('start', 400), 'peer');
    }, aurora.id);
    await start.press('Enter');
    expect((await clip(page, 'aurora.mp4')).start).toBe(412);

    // An entry whose clip leaves the panel by other means than a press is not applied to anything.
    await start.click();
    await start.pressSequentially('100');
    await select(page, [fractal.id]);
    await expect(start).toHaveValue('00:00:04:00');
    expect((await clip(page, 'aurora.mp4')).start).toBe(412);
    expect((await clip(page, 'fractal.mp4')).start).toBe(120);

    // A press on another clip ends the entry first: it goes to the clip it was typed for.
    await select(page, [aurora.id]);
    await start.click();
    await start.pressSequentially('+5');
    await page.locator(`[data-clip="${fractal.id}"]`).click();
    expect((await clip(page, 'aurora.mp4')).start).toBe(417);
    expect((await clip(page, 'fractal.mp4')).start).toBe(120);
  });

  test('a number typed and not applied stays with the clip it was typed for', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    const fractal = await clip(page, 'fractal.mp4');
    const title = inspector(page).locator('.insp__title');
    const opacity = inspector(page).getByRole('textbox', { name: 'Opacity', exact: true });
    const opacities = async () => [
      (await clip(page, 'dusk.mp4')).opacity,
      (await clip(page, 'fractal.mp4')).opacity,
    ];
    const depth = await undoDepth(page);

    // The panel comes to show the next clip without a press of the pointer, here by the command
    // that Ctrl+Down runs (pressed in the field itself, the key is the field's). What was typed
    // for the first clip goes to neither: the field is the next clip's, and nobody is typing in it.
    await select(page, [dusk.id]);
    await opacity.click();
    await opacity.pressSequentially('37');
    await page.evaluate(() => (window as any).tandem.cmd.selectClip(1));
    await expect(title).toHaveText('fractal.mp4');
    await expect(opacity).toHaveValue('100');
    await expect(opacity).not.toBeFocused();
    await page.keyboard.press('Tab');
    expect(await opacities()).toEqual([1, 1]);
    expect(await undoDepth(page)).toBe(depth);

    // Only the fields are new with the selection. A slider that has the keyboard keeps it, and
    // goes on to work on the clip the key selected.
    await select(page, [dusk.id]);
    const slider = inspector(page).getByRole('slider', { name: 'Opacity', exact: true });
    await slider.focus();
    await page.keyboard.press('Control+ArrowDown');
    await expect(title).toHaveText('fractal.mp4');
    await expect(slider).toBeFocused();
    await page.keyboard.press('Home');
    await expect.poll(opacities).toEqual([1, 0]);
    await undo(page);

    // A press that selects another clip ends the entry first, for the clip it was typed for.
    await select(page, [dusk.id]);
    await opacity.click();
    await opacity.pressSequentially('50');
    await page.locator(`[data-clip="${fractal.id}"]`).click();
    expect(await opacities()).toEqual([0.5, 1]);
    await undo(page);

    // With nothing selected the Colour panel is on the clip under the playhead, and moves on to
    // the next shot as the playhead does. A number typed for the first shot is not the second's.
    const temperatures = async () =>
      [await clip(page, 'dusk.mp4'), await clip(page, 'fractal.mp4')].map((c) => c.grade?.temperature ?? 0);
    await set(page, { selection: [], workspace: 'color' });
    await seek(page, 110);
    const shown = page.locator('.color__clip');
    await expect(shown).toContainText('dusk.mp4');
    const temp = page.getByRole('textbox', { name: 'Temp', exact: true });
    await temp.click();
    await temp.pressSequentially('0.5');
    await seek(page, 150);
    await expect(shown).toContainText('fractal.mp4');
    await expect(temp).toHaveValue('0.00');
    await expect(temp).not.toBeFocused();
    await page.keyboard.press('Tab');
    expect(await temperatures()).toEqual([0, 0]);
    // Typed and applied while the panel stays on its clip, it is that clip's.
    await enter(temp, '0.5');
    expect(await temperatures()).toEqual([0, 0.5]);
  });

  test('the panel says when the file of what is selected is offline or cannot be decoded', async ({
    page,
  }) => {
    await sample(page);
    await importFixtures(page, ['testsrc.webm']);
    const card = page.locator('.asset', { hasText: 'testsrc.webm' });
    await expect(card).toBeVisible();
    const dusk = await clip(page, 'dusk.mp4');
    const trouble = inspector(page).locator('.insp__trouble');
    // A clip of a file the project lists but that is on neither this device nor a server, and one
    // of a file the project no longer has.
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const p = session.store.get();
      const dusk = (Object.values(p.clips) as any[]).find((c) => c.name === 'dusk.mp4');
      const spare = { ...dusk, transIn: null, transOut: null, effects: [] };
      session.store.commit([
        {
          op: 'addAsset',
          asset: { ...p.assets[dusk.assetId], id: 'away', name: 'away.mp4', uploaded: false },
        },
        { op: 'addClip', clip: { ...spare, id: 'away', assetId: 'away', name: 'away.mp4', start: 400 } },
        { op: 'addClip', clip: { ...spare, id: 'gone', assetId: 'gone', name: 'gone.mp4', start: 540 } },
      ]);
    });

    await select(page, [dusk.id]);
    await expect(inspector(page).locator('.insp__title')).toHaveText('dusk.mp4');
    await expect(trouble).toHaveCount(0);
    // The line stands under the clip's name, and says what the pool says of the same file.
    await select(page, ['away']);
    await expect(trouble).toHaveText('Media offline: not on this device or the server');
    const name = await box(inspector(page).getByRole('textbox', { name: 'Clip name' }));
    const start = await box(inspector(page).getByLabel('Start', { exact: true }));
    const line = await box(trouble);
    expect(line.y).toBeGreaterThanOrEqual(name.y + name.height);
    expect(line.y + line.height).toBeLessThanOrEqual(start.y);
    await expect(page.locator('.asset[aria-label="away.mp4"]')).toHaveAttribute('data-offline', 'true');
    await select(page, ['gone']);
    await expect(trouble).toHaveText('Media offline: its file is no longer in the project');
    // Clips of different files have no one file to speak of.
    await select(page, ['away', dusk.id]);
    await expect(inspector(page).locator('.insp__title')).toHaveText('2 clips');
    await expect(trouble).toHaveCount(0);

    // From here on this browser decodes no picture. A shot selected with its linked sound is
    // told about the picture; the sound by itself has nothing the matter with it.
    await page.evaluate(() => {
      VideoDecoder.isConfigSupported = async (config) => ({ supported: false, config });
    });
    await seek(page, 700);
    await card.locator('.asset__add').click();
    await expect(inspector(page).locator('.insp__title')).toHaveText('2 clips');
    await expect(page.locator('.clip__chip', { hasText: 'Unsupported' })).toBeVisible();
    await expect(trouble).toHaveText(/^This browser cannot decode the picture of this file \(vp0?9/);
    const sound = await page.evaluate(
      () =>
        (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
          (c) => c.type === 'audio' && c.name === 'testsrc.webm',
        ).id,
    );
    await select(page, [sound]);
    await expect(inspector(page).locator('.insp__title')).toHaveText('testsrc.webm');
    await expect(trouble).toHaveCount(0);
  });

  test('headings and labels are spelt the way the rest of the interface is', async ({ page }) => {
    await sample(page);
    const fractal = await clip(page, 'fractal.mp4');
    await set(page, { selection: [], selectedTransition: { clipId: fractal.id, side: 'in' } });
    await inspector(page).locator('.row', { hasText: 'Type' }).locator('.select').click();
    await expect(page.locator('.popover .menu-label')).toHaveText(['Dissolve', 'Wipe', 'Motion', 'Stylise']);
    await page.keyboard.press('Escape');

    const music = await clip(page, 'pulse.ogg');
    await select(page, [music.id]);
    await expect(inspector(page).getByRole('button', { name: 'Normalise loudness' })).toHaveText(
      'Normalise…',
    );
    await set(page, { dialog: 'palette' });
    await page.keyboard.type('normali');
    await expect(page.getByRole('option', { name: /Normalise loudness to −14 LUFS/ })).toBeVisible();
    await expect(page.getByText('Normalize')).toHaveCount(0);
  });

  test('the ring of a button in a row’s label is not cut off, and a long label ends in an ellipsis', async ({
    page,
  }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    await select(page, [dusk.id]);
    const diamond = inspector(page).getByRole('button', { name: 'Toggle keyframe for Position X' });
    // The ring is drawn four pixels out from the button: nothing between it and the panel clips.
    const clipped = await diamond.evaluate((el) => {
      const own = el.getBoundingClientRect();
      const body = el.closest('.panel__body')!;
      for (let up = el.parentElement!; up !== body; up = up.parentElement!) {
        if (getComputedStyle(up).overflow === 'visible') continue;
        const r = up.getBoundingClientRect();
        if (own.left - 4 < r.left || own.top - 4 < r.top || own.bottom + 4 > r.bottom) return up.className;
      }
      return null;
    });
    expect(clipped).toBeNull();
    const words = inspector(page).locator('.row__label > span').first();
    await expect(words).toHaveCSS('text-overflow', 'ellipsis');
    await expect(words).toHaveCSS('overflow', 'hidden');
  });

  test('a new frame rate takes comments, the marked range and the playhead with it', async ({ page }) => {
    await sample(page);
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      for (const frame of [7, 90, 301])
        session.review.add({
          frame,
          text: 'note',
          authorId: 'me',
          authorName: 'Me',
          authorColor: '#ff0000',
          x: null,
          y: null,
        });
      session.player.setRange({ in: 60, out: 300 });
      cmd.seek(331);
    });
    const state = () =>
      page.evaluate(() => {
        const { session } = (window as any).tandem;
        const s = session.store.get().settings;
        return {
          fps: s.fpsNum / s.fpsDen,
          comments: session.review.get().map((c: any) => c.frame),
          range: session.player.getState().range,
          frame: session.player.getFrame(),
        };
      });
    const at30 = { fps: 30, comments: [7, 90, 301], range: { in: 60, out: 300 }, frame: 331 };
    const at24 = { fps: 24, comments: [6, 72, 241], range: { in: 48, out: 240 }, frame: 265 };
    expect(await state()).toEqual(at30);

    await inspector(page).locator('.row', { hasText: 'Frame rate' }).locator('.select').click();
    await page.getByRole('option', { name: '24 fps', exact: true }).click();
    expect(await state()).toEqual(at24);
    // Undo and redo carry them along, back to the very frames they came from: 6 × 1.25 would
    // round to 8, the comment was on 7.
    await undo(page);
    expect(await state()).toEqual(at30);
    await page.evaluate(() => (window as any).tandem.cmd.redo());
    expect(await state()).toEqual(at24);
    // So does choosing the old rate again by hand.
    await inspector(page).locator('.row', { hasText: 'Frame rate' }).locator('.select').click();
    await page.getByRole('option', { name: '30 fps', exact: true }).click();
    expect(await state()).toEqual(at30);
  });

  test('the panel follows the selection without moving, also under a drag in the timeline', async ({
    page,
  }) => {
    await sample(page);
    await set(page, { selection: [] });
    await page.evaluate(() => {
      const started: string[] = ((window as any).started = []);
      const note = (e: AnimationEvent): void => {
        if ((e.target as Element).closest('[aria-label="Inspector"]')) started.push(e.animationName);
      };
      document.addEventListener('animationstart', note, true);
    });
    /** The animations that began inside the panel since this was last asked. */
    const started = (): Promise<string[]> => page.evaluate(() => (window as any).started.splice(0));
    const selected = (): Promise<number> =>
      page.evaluate(() => (window as any).tandem.ui.getState().selection.length);
    const sections = inspector(page).locator('.section');
    const dusk = await clip(page, 'dusk.mp4');
    const onDusk = await box(page.locator(`[data-clip="${dusk.id}"]`));
    const middle = [onDusk.x + onDusk.width / 2, onDusk.y + onDusk.height / 2] as const;
    const free = await box(page.locator('.lane').last());

    // A marquee selects and lets go again while it is dragged: the panel shows the clips, then
    // the project, with the pointer down throughout.
    await page.mouse.move(free.x + 40, free.y + free.height / 2);
    await page.mouse.down();
    await page.mouse.move(...middle, { steps: 6 });
    await expect.poll(selected).toBeGreaterThan(0);
    await expect(sections.first()).toBeVisible();
    await page.mouse.move(free.x + 50, free.y + free.height / 2, { steps: 6 });
    await expect.poll(selected).toBe(0);
    await expect(sections).toHaveCount(0);
    await page.mouse.up();
    // The press that picks up a clip selects it: its sections and its effect are there at once.
    await page.mouse.move(...middle);
    await page.mouse.down();
    await expect(inspector(page).locator('.fxitem')).toHaveCount(dusk.effects.length);
    await page.waitForTimeout(200);
    await page.mouse.up();
    expect(dusk.effects.length).toBeGreaterThan(0);
    expect(await started()).toEqual([]);

    // What a person opens or adds in the panel does move: a section under its head, a new effect
    // into the list. And the panel itself fades in when the workspace brings it back.
    const transform = inspector(page).locator('.section__head', { hasText: 'Transform' });
    await transform.click();
    await expect(transform).toHaveAttribute('aria-expanded', 'false');
    await transform.click();
    await expect.poll(started).toEqual(['section-open']);
    await page.evaluate(() => (window as any).tandem.cmd.applyEffect('invert'));
    await expect.poll(started).toEqual(['slide-up']);
    await set(page, { workspace: 'color' });
    await set(page, { workspace: 'edit' });
    await expect(inspector(page).locator('.panel__body')).toHaveCSS('animation-name', 'fade-in');
  });
});

test.describe('colour', () => {
  test('grades are copied from and pasted onto the clip the panel shows', async ({ page }) => {
    await sample(page);
    await set(page, { workspace: 'color', selection: [] });
    await seek(page, 150);
    await expect(page.locator('.color__clip')).toContainText('fractal.mp4');
    const paste = page.getByRole('button', { name: 'Paste grade' });
    await expect(paste).toBeDisabled();
    await enter(page.locator('.gslider', { hasText: 'Temp' }).getByRole('textbox'), '0.4');
    await page.getByRole('button', { name: 'Copy grade' }).click();
    await expect(toast(page, 'Attributes copied')).toBeVisible();
    await expect(paste).toBeEnabled();

    await seek(page, 300);
    await expect(page.locator('.color__clip')).toContainText('aurora.mp4');
    await paste.click();
    expect((await clip(page, 'aurora.mp4')).grade.temperature).toBe(0.4);

    // With the clip it shows among several selected ones, the grade goes onto all of them, and
    // the button says so. Onto a single selected clip it is the plain paste.
    const dusk0 = await clip(page, 'dusk.mp4');
    const title = await clip(page, 'title');
    await select(page, [dusk0.id]);
    await expect(page.locator('.color__clip')).toContainText('dusk.mp4');
    await expect(paste).toHaveCount(1);
    await select(page, [dusk0.id, title.id]);
    const pasteAll = page.getByRole('button', { name: 'Paste grade onto the selected clips' });
    await pasteAll.click();
    await expect(toast(page, 'pasted onto 2 clips')).toBeVisible();
    expect((await clip(page, 'dusk.mp4')).grade.temperature).toBe(0.4);
    expect((await clip(page, 'title')).grade.temperature).toBe(0.4);
    // What was copied from a sound clip holds no look: there is nothing to paste as a grade.
    const music = await clip(page, 'pulse.ogg');
    await page.evaluate((id) => (window as any).tandem.cmd.copyAttributes(id), music.id);
    await expect(pasteAll).toBeDisabled();
    await page.evaluate((id) => (window as any).tandem.cmd.copyAttributes(id), dusk0.id);
    await expect(pasteAll).toBeEnabled();
    await set(page, { selection: [] });
    await seek(page, 300);
    await expect(page.locator('.color__clip')).toContainText('aurora.mp4');

    // A lock covers the clip under the playhead too, and the panel says why nothing moves.
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const p = session.store.get();
      const v1 = (Object.values(p.clips) as any[]).find((c) => c.type === 'video').trackId;
      session.store.commit([{ op: 'updateTrack', id: v1, patch: { locked: true } }]);
    });
    await expect(page.locator('.color__locked')).toHaveText(
      'V1 is locked. Unlock the track to grade this clip.',
    );
    await expect(paste).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Reset grade' })).toBeDisabled();
    const graded = (await clip(page, 'aurora.mp4')).grade;
    const dusk = await clip(page, 'dusk.mp4');
    await page.evaluate((id) => (window as any).tandem.cmd.pasteAttributes('all', [id]), dusk.id);
    await expect(toast(page, 'That track is locked')).toBeVisible();
    expect(await clip(page, 'dusk.mp4')).toEqual(dusk);
    expect((await clip(page, 'aurora.mp4')).grade).toEqual(graded);
  });

  test('wheel readouts stay under their wheel and the curve fits its panel', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    await set(page, { workspace: 'color' });
    await select(page, [dusk.id]);
    // The widest case: every channel of every wheel negative.
    await page.evaluate((id) => {
      const { session } = (window as any).tandem;
      const wheel = [-0.4, -0.3, -0.5, -1];
      const grade = { lift: wheel, gamma: wheel, gain: wheel, offset: wheel };
      session.store.commit([{ op: 'updateClip', id, patch: { grade: { ...grade, enabled: true } } }]);
    }, dusk.id);
    await expect(page.locator('.wheel__read').first()).toHaveText('-1.4-1.3-1.5');
    const spill = await page.locator('.wheel').evaluateAll((wheels) =>
      wheels.map((w) => {
        const own = w.getBoundingClientRect();
        return [...w.querySelectorAll('.wheel__read span')].some((s) => {
          const range = document.createRange();
          range.selectNodeContents(s);
          const text = range.getBoundingClientRect();
          return text.left < own.left - 0.5 || text.right > own.right + 0.5;
        });
      }),
    );
    expect(spill).toEqual([false, false, false, false]);

    await page.getByRole('tab', { name: 'Curves' }).click();
    const fit = await page.locator('.panel__body.color').evaluate((body) => {
      const bottom = (sel: string) => body.querySelector(sel)!.getBoundingClientRect().bottom;
      const tabs = body.querySelector('.curve__tabs')!;
      return {
        scrolls: body.scrollHeight > body.clientHeight,
        inside: bottom('.curve__foot') <= body.getBoundingClientRect().bottom,
        chipRows: new Set([...tabs.children].map((c) => Math.round(c.getBoundingClientRect().top))).size,
        chipsCut: tabs.scrollWidth > tabs.clientWidth,
      };
    });
    expect(fit).toEqual({ scrolls: false, inside: true, chipRows: 1, chipsCut: false });

    // A zone fader resets on double-click in one undo step.
    await page.getByRole('tab', { name: 'HDR' }).click();
    const depth = await undoDepth(page);
    const fader = await box(page.locator('.vfader').nth(2));
    await page.mouse.dblclick(fader.x + fader.width / 2, fader.y + fader.height * 0.2);
    expect((await clip(page, 'dusk.mp4')).grade.zones.mid).toBe(0);
    expect(await undoDepth(page)).toBe(depth + 1);
  });

  test('wheels, curve points and zone faders are worked from the keyboard', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    await set(page, { workspace: 'color' });
    await select(page, [dusk.id]);
    const grade = async () => (await clip(page, 'dusk.mp4')).grade;
    const frame = () => page.evaluate(() => (window as any).tandem.session.player.getFrame());
    const at = await frame();
    const clipCount = (await clips(page)).length;

    // The tabs: arrows move through them once the keyboard is on one.
    const tabs = page.locator('section[aria-label="Inspector"] [role="tab"]');
    await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Wheels');
    await page.locator('.color__clip').focus();
    await page.keyboard.press('Shift+Tab');
    for (let i = 0; i < 6 && !(await tabs.first().evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press('Shift+Tab');
    await expect(tabs.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Curves');
    await page.keyboard.press('End');
    await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    // A tab that was only clicked leaves the arrows to the playhead.
    await tabs.first().click();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    expect(await frame()).toBe(at + 1);
    await page.keyboard.press('ArrowLeft');

    // A wheel: Tab reaches its puck and the arrows move it across the wheel.
    const lift = page.getByRole('slider', { name: 'Lift colour balance' });
    await expect(lift).toHaveAttribute('aria-valuetext', 'Neutral');
    await page.locator('.color__clip').focus();
    await page.keyboard.press('Tab');
    await expect(lift).toBeFocused();
    for (const key of ['ArrowRight', 'ArrowRight', 'Shift+ArrowUp']) await page.keyboard.press(key);
    await expect(lift).toHaveAttribute('aria-valuetext', '20% toward red');
    expect((await grade()).lift[0]).toBeGreaterThan(0.09);
    // End takes it to the rim along its hue, Page Down a tenth of the way back.
    await page.keyboard.press('End');
    await expect(lift).toHaveAttribute('aria-valuetext', '100% toward red');
    await page.keyboard.press('PageDown');
    await expect(lift).toHaveAttribute('aria-valuetext', '90% toward red');
    // Delete puts the puck back, and is the wheel's: no clip is deleted, the playhead stays.
    await page.keyboard.press('Delete');
    await expect(lift).toHaveAttribute('aria-valuetext', 'Neutral');
    expect((await grade()).lift).toEqual([0, 0, 0, 0]);
    expect((await clips(page)).length).toBe(clipCount);
    expect(await frame()).toBe(at);
    // A run of presses is one undo step, as one drag is; after a rest the next press begins another.
    await page.waitForTimeout(800);
    const depth = await undoDepth(page);
    await burst(page, ['ArrowLeft', 'ArrowLeft', 'ArrowDown', 'Shift+ArrowLeft']);
    await expect(lift).toHaveAttribute('aria-valuetext', '24% toward blue');
    expect(await undoDepth(page)).toBe(depth + 1);
    await page.waitForTimeout(800);
    await page.keyboard.press('ArrowLeft');
    expect(await undoDepth(page)).toBe(depth + 2);
    await undo(page);
    await undo(page);
    expect((await grade()).lift).toEqual([0, 0, 0, 0]);
    // A drag leaves the keyboard where it was: the arrows are the playhead's again.
    const disc = await box(page.locator('.wheel__disc').first());
    await page.mouse.move(disc.x + disc.width / 2, disc.y + disc.height / 2);
    await page.mouse.down();
    await page.mouse.move(disc.x + disc.width / 2 + 12, disc.y + disc.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect(lift).not.toBeFocused();
    await page.keyboard.press('ArrowRight');
    expect(await frame()).toBe(at + 1);
    await page.keyboard.press('ArrowLeft');

    // A curve: a point is added from the keyboard, moved with the arrows and removed with Delete.
    await page.getByRole('tab', { name: 'Curves' }).click();
    await expect(page.getByRole('group', { name: 'Master curve' })).toBeVisible();
    await page.getByRole('button', { name: 'Add point' }).focus();
    await page.keyboard.press('Enter');
    const point = page.getByRole('slider', { name: 'Point 2 of 3' });
    await expect(point).toBeFocused();
    await expect(point).toHaveAttribute('aria-valuetext', 'Input 50%, output 50%');
    const before = await undoDepth(page);
    await burst(page, ['ArrowUp', 'ArrowUp', 'Shift+ArrowLeft']);
    await expect(point).toHaveAttribute('aria-valuetext', 'Input 40%, output 52%');
    expect((await grade()).curves.m).toEqual([
      [0, 0],
      [0.4, 0.52],
      [1, 1],
    ]);
    expect(await undoDepth(page)).toBe(before + 1);
    // An end of the curve is not removed; a point between the ends is.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('slider', { name: 'Point 1 of 3' })).toBeFocused();
    await page.keyboard.press('Delete');
    expect((await grade()).curves.m).toHaveLength(3);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Delete');
    expect((await grade()).curves.m).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect((await clips(page)).length).toBe(clipCount);
    // A press on a point drags it and leaves the keyboard alone.
    const dot = await box(page.locator('.curve__pt').last());
    await page.mouse.click(dot.x + dot.width / 2, dot.y + dot.height / 2);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

    // A zone fader: a vertical slider in stops.
    await page.getByRole('tab', { name: 'HDR' }).click();
    const mid = page.getByRole('slider', { name: 'Mid zone' });
    await expect(mid).toHaveAttribute('aria-orientation', 'vertical');
    await mid.focus();
    const zones = await undoDepth(page);
    await burst(page, ['ArrowUp', 'ArrowUp', 'Shift+ArrowUp', 'PageDown']);
    // Two steps of 0.05 and one of 0.5 up, then a tenth of the eight stops down.
    expect((await grade()).zones.mid).toBe(-0.2);
    await expect(mid).toHaveAttribute('aria-valuetext', '−0.20 stops');
    expect(await undoDepth(page)).toBe(zones + 1);
    await page.keyboard.press('Home');
    expect((await grade()).zones.mid).toBe(-4);
    await page.keyboard.press('Delete');
    expect((await grade()).zones.mid).toBe(0);
    expect(await frame()).toBe(at);
  });

  test('a run of key presses on a wheel ends with the clip it was made on', async ({ page }) => {
    await sample(page);
    const dusk = await clip(page, 'dusk.mp4');
    await set(page, { workspace: 'color', selection: [dusk.id] });
    const lifts = async () =>
      [await clip(page, 'dusk.mp4'), await clip(page, 'fractal.mp4')].map((c) => c.grade?.lift ?? null);
    const puck = page.getByRole('slider', { name: 'Lift colour balance', exact: true });
    await puck.focus();
    const depth = await undoDepth(page);
    // Two presses on the first shot, the key that selects the next clip, and two more: all within
    // the time that makes presses one run, and the wheel keeps the keyboard throughout.
    await burst(page, ['ArrowRight', 'ArrowRight', 'Control+ArrowDown', 'ArrowRight', 'ArrowRight']);
    await expect(page.locator('.color__clip')).toContainText('fractal.mp4');
    await expect(puck).toBeFocused();
    const [first, second] = await lifts();
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    // Each shot has its own undo step: taking back the second leaves the first as it was graded.
    expect(await undoDepth(page)).toBe(depth + 2);
    await undo(page);
    expect(await lifts()).toEqual([first, null]);
  });

  test('what is printed on the band of tonal zones is readable to its light end', async ({ page }) => {
    await sample(page);
    await set(page, { workspace: 'color' });
    await page.getByRole('tab', { name: 'HDR' }).click();
    await expect(page.locator('.zone')).toHaveCount(6);
    // The band is a gradient that gets lighter to the right. Each text is measured against the
    // lightest ground it could ever stand on, the band's far end, in the colour it is printed in.
    const ratios = await page.locator('.zones').evaluate((zones) => {
      const stops = Array.from(
        getComputedStyle(zones).backgroundImage.matchAll(/rgba?\(([^)]+)\)(?:\s+([\d.]+)%)?/g),
        (stop) => ({ colour: `rgb(${stop[1]})`, at: stop[2] === undefined ? null : Number(stop[2]) / 100 }),
      );
      const band = document.createElement('canvas');
      band.width = 256;
      band.height = 1;
      const paint = band.getContext('2d', { willReadFrequently: true })!;
      const gradient = paint.createLinearGradient(0, 0, band.width, 0);
      stops.forEach((stop, i) => gradient.addColorStop(stop.at ?? (i === 0 ? 0 : 1), stop.colour));
      paint.fillStyle = gradient;
      paint.fillRect(0, 0, band.width, 1);
      const ground = Array.from(paint.getImageData(band.width - 1, 0, 1, 1).data.slice(0, 3));
      const luminance = (rgb: number[]): number => {
        const [r, g, b] = rgb.map((v) =>
          v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4,
        );
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return ['.zone__val', '.zone__label', '.zone__stops'].map((selector) => {
        const [r, g, b, alpha = 1] = getComputedStyle(zones.querySelector(selector)!)
          .color.match(/[\d.]+/g)!
          .map(Number);
        const ink = [r, g, b].map((v, i) => v * alpha + ground[i] * (1 - alpha));
        return (luminance(ink) + 0.05) / (luminance(ground) + 0.05);
      });
    });
    expect(ratios).toHaveLength(3);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test('scopes are read again only when the viewer has drawn a frame', async ({ page }) => {
    await sample(page);
    await set(page, { workspace: 'color' });
    await expect(page.locator('.scope canvas').first()).toBeVisible();
    // Count the frames the scopes read back, and note which drawn frame each belongs to.
    await page.evaluate(() => {
      const { player } = (window as any).tandem.session;
      const read = player.readScope.bind(player);
      const seen = ((window as any).reads = { count: 0, drawn: -1 });
      player.readScope = async (...args: unknown[]) => {
        const drawn = player.drawnFrames;
        const frame = await read(...args);
        if (frame) Object.assign(seen, { count: seen.count + 1, drawn });
        return frame;
      };
    });
    // Once the frame that was drawn last has been read, a viewer at rest costs the scopes nothing:
    // no read-back, and with it none of the work each scope does on a frame.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).reads.drawn === (window as any).tandem.session.player.drawnFrames,
        ),
      )
      .toBe(true);
    const rest = await page.evaluate(async () => {
      const { player } = (window as any).tandem.session;
      const before = { reads: (window as any).reads.count, drawn: player.drawnFrames };
      await new Promise((done) => setTimeout(done, 1500));
      return { reads: (window as any).reads.count - before.reads, drawn: player.drawnFrames - before.drawn };
    });
    expect(rest.reads).toBeLessThanOrEqual(rest.drawn);
    // A new frame is read at the next beat.
    const read = await page.evaluate(() => (window as any).reads.count);
    await seek(page, 200);
    await expect.poll(() => page.evaluate(() => (window as any).reads.count)).toBeGreaterThan(read);
    // And a scope that is switched on is drawn from the frame that is held.
    await page.getByRole('button', { name: 'Choose scopes' }).click();
    await page.getByRole('menuitem', { name: 'Histogram' }).click();
    const histogram = page.locator('.scope[data-kind="histogram"] canvas');
    await expect
      .poll(() =>
        histogram.evaluate((canvas: HTMLCanvasElement) => {
          const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
          return data.some((v) => v > 0);
        }),
      )
      .toBe(true);
  });
});

test.describe('mixer', () => {
  test('the master meter stays in view and every fader keeps its travel', async ({ page }) => {
    await sample(page);
    await page.evaluate(() => (window as any).tandem.cmd.addTrack('audio'));
    await set(page, { workspace: 'audio' });
    await expect(page.locator('.fader')).toHaveCount(3);
    const strips = page.locator('.mixer__strips');
    const heights = () => page.locator('.fader').evaluateAll((els) => els.map((e) => e.clientHeight));
    const masterInView = async () => {
      const panel = await box(page.locator('.panel__body.mixer'));
      const master = await box(page.locator('.strip--master'));
      return master.x >= panel.x && master.x + master.width <= panel.x + panel.width + 0.5;
    };
    // Three tracks need more room than the panel has: the strips scroll, the master does not.
    expect(await strips.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await masterInView()).toBe(true);
    await strips.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    expect(await masterInView()).toBe(true);
    await strips.evaluate((el) => (el.scrollLeft = 0));

    // EQ and compressor open under the strips, inside the panel, and act on their track.
    const before = await heights();
    await page.getByRole('button', { name: 'EQ and compressor, A1' }).click();
    const drawer = page.locator('.mixer__fx');
    await expect(drawer).toContainText('A1');
    const open = await heights();
    expect(new Set(open).size).toBe(1);
    expect(open[0]).toBeLessThan(before[0]);
    const body = page.locator('.panel__body.mixer');
    expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
    await drawer.getByRole('switch', { name: 'Enable compressor' }).click();
    const a1 = () =>
      page.evaluate(() => {
        const p = (window as any).tandem.session.store.get();
        return (Object.values(p.tracks) as any[]).find((t) => t.kind === 'audio' && t.order === 0);
      });
    expect((await a1()).compressor.enabled).toBe(true);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);
    expect(await heights()).toEqual(before);

    // A double-click on a fader is one undo step back to 0 dB.
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const t = (Object.values(session.store.get().tracks) as any[]).find(
        (t) => t.kind === 'audio' && t.order === 0,
      );
      session.store.commit([{ op: 'updateTrack', id: t.id, patch: { volume: -9 } }]);
    });
    const depth = await undoDepth(page);
    const fader = await box(page.locator('.fader').first());
    await page.mouse.dblclick(fader.x + 10, fader.y + fader.height * 0.8);
    expect((await a1()).volume).toBe(0);
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);
    expect((await a1()).volume).toBe(-9);

    // Solo and mute show what they are switched to while the pointer is still on the button, in
    // the colours the track's header has for them.
    for (const [name, colour] of [
      ['Solo, A1', '--track-solo'],
      ['Mute, A1', '--track-mute'],
    ]) {
      const button = page.getByRole('button', { name, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(await button.evaluate((el) => el.matches(':hover'))).toBe(true);
      await expect(button).toHaveCSS('background-color', await token(page, colour));
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  });

  test('all meters share one reading of the levels a frame, and none is taken at rest', async ({ page }) => {
    await sample(page);
    await page.evaluate(() => (window as any).tandem.cmd.addTrack('audio'));
    await set(page, { workspace: 'audio' });
    // Three strips and the mix, and the headers of the same tracks in the timeline below them.
    await expect(page.locator('.strip')).toHaveCount(4);
    /** How often the levels were read during `ms`, and how many frames the page drew meanwhile. */
    const reads = (ms: number): Promise<{ calls: number; frames: number }> =>
      page.evaluate(async (ms) => {
        const { player } = (window as any).tandem.session;
        const count = { calls: 0, frames: 0 };
        const read = player.levels;
        player.levels = function (this: unknown) {
          count.calls++;
          return read.call(this);
        };
        let counting = true;
        const frame = (): void => {
          if (!counting) return;
          count.frames++;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        await new Promise((done) => setTimeout(done, ms));
        counting = false;
        delete player.levels;
        return count;
      }, ms);
    const shown = () =>
      page.evaluate(() => ({
        bars: Array.from(document.querySelectorAll<HTMLElement>('.meter__bar'), (el) => el.style.transform),
        peaks: Array.from(document.querySelectorAll<HTMLElement>('.meter__peak'), (el) => el.style.bottom),
      }));
    const moving = (bar: string): boolean => bar !== '' && bar !== 'scaleY(0)';

    expect((await reads(1000)).calls).toBe(0);

    await seek(page, 0);
    await page.evaluate(() => (window as any).tandem.session.player.play());
    // The music plays on A1: its bar and both bars of the mix move, the empty tracks' do not.
    await expect.poll(async () => (await shown()).bars.map(moving)).toEqual([true, false, false, true, true]);
    const playing = await reads(1000);
    expect(playing.calls).toBeGreaterThan(0);
    expect(playing.calls).toBeLessThanOrEqual(playing.frames + 1);

    // Stopped, the bars fall back and the peak marks let go. The levels are read for a moment
    // longer than that takes, and then not at all. That moment is over when a frame is drawn
    // without them being read: while it lasts they are read on every frame. Time without a
    // reading does not show it, as a busy machine can let half a second pass between two frames.
    await page.evaluate(() => (window as any).tandem.session.player.pause());
    await expect.poll(shown).toEqual({ bars: Array(5).fill('scaleY(0)'), peaks: Array(5).fill('0%') });
    await expect
      .poll(async () => {
        const quiet = await reads(500);
        return quiet.calls === 0 && quiet.frames > 0;
      })
      .toBe(true);
    expect((await reads(1000)).calls).toBe(0);
    expect(await shown()).toEqual({ bars: Array(5).fill('scaleY(0)'), peaks: Array(5).fill('0%') });
  });

  test('a fader is a slider for the keyboard, in decibels', async ({ page }) => {
    await sample(page);
    await set(page, { workspace: 'audio' });
    const a1 = () =>
      page.evaluate(() => {
        const p = (window as any).tandem.session.store.get();
        return (Object.values(p.tracks) as any[]).find((t) => t.kind === 'audio' && t.order === 0);
      });
    const frame = () => page.evaluate(() => (window as any).tandem.session.player.getFrame());
    const at = await frame();
    const fader = page.getByRole('slider', { name: 'Volume, A1' });
    await expect(fader).toHaveAttribute('aria-orientation', 'vertical');
    await expect(fader).toHaveAttribute('aria-valuetext', '0.0 dB');
    await fader.focus();
    const depth = await undoDepth(page);
    for (const key of ['ArrowDown', 'ArrowDown', 'Shift+ArrowDown']) await page.keyboard.press(key);
    expect((await a1()).volume).toBe(-6);
    await expect(fader).toHaveAttribute('aria-valuetext', '−6.0 dB');
    await page.keyboard.press('End');
    expect((await a1()).volume).toBe(12);
    // A run of presses is one undo step.
    await page.waitForTimeout(800);
    const run = await undoDepth(page);
    await burst(page, ['ArrowDown', 'ArrowDown', 'PageDown']);
    expect((await a1()).volume).toBe(4);
    expect(await undoDepth(page)).toBe(run + 1);
    await undo(page);
    expect((await a1()).volume).toBe(12);
    await page.keyboard.press('Delete');
    expect((await a1()).volume).toBe(0);
    expect(await frame()).toBe(at);
    for (let steps = await undoDepth(page); steps > depth; steps--) await undo(page);
    expect((await a1()).volume).toBe(0);
    // A drag on the fader does not leave the keyboard on it.
    const track = await box(page.locator('.fader').first());
    await page.mouse.click(track.x + 10, track.y + track.height * 0.5);
    await expect(fader).not.toBeFocused();
    await page.keyboard.press('ArrowRight');
    expect(await frame()).toBe(at + 1);
  });
});

test.describe('export', () => {
  const codec = (page: Page) => page.locator('.exp .row', { hasText: 'Codec' }).first().locator('.row__ctrl');
  const range = (page: Page) => page.locator('.exp .row', { hasText: 'Dynamic range' }).locator('.row__ctrl');
  const exportButton = (page: Page) => page.locator('.dialog__foot .btn--primary');
  const probed = (page: Page) => expect(page.locator('.exp .spinner')).toHaveCount(0);

  test('no preset leaves an HDR export on a codec that cannot carry it', async ({ page }, info) => {
    await newLocal(page);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      session.store.commit([
        { op: 'settings', patch: { colorMode: 'hdr-pq', toneMap: 'bt2390', width: 320, height: 180 } },
      ]);
      cmd.addSolid('#c04020');
      const solid = Object.values(session.store.get().clips)[0] as any;
      session.store.commit([{ op: 'updateClip', id: solid.id, patch: { duration: 12 } }]);
      ui.getState().set({ dialog: 'export' });
    });
    await expect(page.locator('.exp')).toBeVisible();
    await probed(page);
    test.skip(
      (await codec(page).innerText()).includes('No encoder'),
      'this browser has no 10-bit encoder for MP4',
    );

    const choose = async (name: string) => {
      const preset = page.locator('.exp__preset', { hasText: name });
      await preset.click();
      await probed(page);
      await expect(preset).toHaveAttribute('aria-pressed', 'true');
    };
    // "Plays everywhere" means SDR: the timeline is tone-mapped rather than tagged as HDR.
    await choose('Web 1080p');
    await expect(range(page)).toContainText('SDR');
    await expect(codec(page)).toHaveText(/H\.264|HEVC|VP9|AV1|VP8/);
    // Every other preset is the project's own HDR on a codec the browser has in 10-bit, also when
    // it is chosen straight after the SDR one.
    for (const name of ['Small file', 'Web 1080p', '4K master', 'HDR10', 'Web 1080p', 'Match project']) {
      await choose(name);
      if (name === 'Web 1080p') continue;
      await expect(range(page)).toContainText('HDR10');
      await expect(codec(page)).toHaveText(/HEVC|VP9|AV1/);
      await expect(exportButton(page)).toBeEnabled();
    }

    // A dynamic range picked by hand is no longer what the preset stands for.
    await choose('Web 1080p');
    await range(page).locator('.select').click();
    await page.getByRole('option', { name: /HDR10/ }).click();
    await probed(page);
    await expect(page.locator('.exp__preset[aria-pressed="true"]')).toHaveCount(0);
    await expect(codec(page)).toHaveText(/HEVC|VP9|AV1/);
    await choose('Match project');
    await expect(range(page)).toContainText('HDR10');

    const download = page.waitForEvent('download');
    await exportButton(page).click();
    const file = await download;
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    const path = info.outputPath(file.suggestedFilename());
    await file.saveAs(path);
    test.skip(!hasFfprobe(), 'ffprobe not installed');
    const video = ffprobe(path).streams.find((s) => s.codec_type === 'video')!;
    expect(video.pix_fmt).toMatch(/10/);
    expect(video.color_transfer).toBe('smpte2084');
  });

  test('missing media is listed before exporting and reported with the file', async ({ page }) => {
    await sample(page);
    // Two clips of a file that is neither on this device nor on a server.
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const p = session.store.get();
      const dusk = (Object.values(p.clips) as any[]).find((c) => c.name === 'dusk.mp4');
      const lost = {
        ...dusk,
        assetId: 'lost',
        name: 'holiday.mp4',
        transIn: null,
        effects: [],
        duration: 15,
      };
      session.store.commit([
        { op: 'settings', patch: { width: 320, height: 180 } },
        {
          op: 'addAsset',
          asset: { ...p.assets[dusk.assetId], id: 'lost', name: 'holiday.mp4', uploaded: false },
        },
        { op: 'addClip', clip: { ...lost, id: 'lost1', start: 360 } },
        { op: 'addClip', clip: { ...lost, id: 'lost2', start: 390 } },
      ]);
      session.player.setRange({ in: 350, out: 410 });
      ui.getState().set({ dialog: 'export' });
    });
    const warning = page.locator('.exp .callout--warn');
    await expect(warning).toContainText('Not everything can be exported.');
    await expect(warning.locator('.exp__problems li')).toHaveCount(1);
    await expect(warning).toContainText(
      '“holiday.mp4” is not on this device or the server, so it is missing from the export.',
    );
    await expect(warning.locator('.exp__place')).toHaveText(['00:00:12:00', '00:00:13:00']);
    await expect(exportButton(page)).toHaveText('Export anyway');

    // A timecode leads to its clip.
    await warning.locator('.exp__place').nth(1).click();
    await expect(page.locator('.exp')).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const { session, ui } = (window as any).tandem;
        return { selection: ui.getState().selection, frame: session.player.getFrame() };
      }),
    ).toEqual({ selection: ['lost2'], frame: 390 });

    // Exporting anyway says what is missing in the result, next to the file.
    await set(page, { dialog: 'export' });
    await expect(exportButton(page)).toHaveText('Export anyway');
    const download = page.waitForEvent('download');
    await exportButton(page).click();
    await download;
    const done = page.locator('.dialog');
    await expect(done).toContainText('Exported with gaps', { timeout: 100_000 });
    await expect(done.locator('.exp__problems')).toContainText('“holiday.mp4” is not on this device');
    await expect(done.locator('.exp__place')).toHaveText(['00:00:12:00', '00:00:13:00']);
    await done.getByRole('button', { name: 'Done' }).click();

    // A range that needs nothing but what is there exports without a warning.
    await page.evaluate(() => (window as any).tandem.session.player.setRange({ in: 100, out: 110 }));
    await set(page, { dialog: 'export' });
    await expect(page.locator('.exp')).toBeVisible();
    await probed(page);
    await expect(exportButton(page)).toHaveText('Export');
    const clean = page.waitForEvent('download');
    await exportButton(page).click();
    await clean;
    await expect(page.locator('.dialog')).toContainText('Export complete', { timeout: 100_000 });
    await expect(page.locator('.exp__problems')).toHaveCount(0);
  });

  test('a running export has one way out, and a failed one is shown as a failure', async ({ page }) => {
    await sample(page);
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      session.store.commit([{ op: 'settings', patch: { width: 320, height: 180 } }]);
      ui.getState().set({ dialog: 'export' });
    });
    await expect(page.locator('.exp')).toBeVisible();
    await probed(page);
    const dialog = page.locator('.dialog');
    const close = dialog.getByRole('button', { name: 'Close' });
    await expect(close).toBeVisible();
    // The dialog scales in: its title row has its own height once that is over.
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((entrance) => entrance.finished)));
    const head = (await box(dialog.locator('.dialog__head'))).height;

    // The whole sample takes this renderer far longer than the checks below.
    await exportButton(page).click();
    const running = page.locator('.exp__run');
    await expect(running).toBeVisible();
    // "Cancel export" is the only button: none beside the title that would do nothing, and the
    // title stays where it was without it.
    await expect(dialog.getByRole('button')).toHaveText(['Cancel export']);
    expect((await box(dialog.locator('.dialog__head'))).height).toBe(head);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(running).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel export' }).click();
    await expect(dialog.locator('.exp__preset').first()).toBeVisible();
    await expect(close).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);

    // An encoder that will not start is a failure, and looks like one: not like a warning.
    await page.evaluate(() => {
      (window as any).VideoEncoder = class {
        static isConfigSupported = () => Promise.resolve({ supported: true });
        constructor() {
          throw new Error('The video encoder could not be started.');
        }
      };
    });
    await exportButton(page).click();
    const failed = dialog.getByRole('alert');
    await expect(failed).toHaveText('Export failed. The video encoder could not be started.');
    await expect(failed).not.toHaveClass(/callout--warn/);
    await expect(failed.locator('svg')).toHaveCSS('color', await token(page, '--red'));
    // The settings are still there to be changed and tried again.
    await expect(exportButton(page)).toBeEnabled();
    await expect(close).toBeVisible();
  });
  test('the keyboard stays in the dialog from the first press to Done', async ({ page }) => {
    await newLocal(page);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      session.store.commit([{ op: 'settings', patch: { width: 320, height: 180 } }]);
      cmd.addSolid('#c04020');
      const solid = Object.values(session.store.get().clips)[0] as any;
      session.store.commit([{ op: 'updateClip', id: solid.id, patch: { duration: 12 } }]);
      ui.getState().set({ dialog: 'export' });
    });
    await expect(page.locator('.exp')).toBeVisible();
    await probed(page);
    const dialog = page.getByRole('dialog');
    const inside = () => dialog.evaluate((el) => el.contains(document.activeElement));
    // Hold the export in its first frames, to look at the dialog while it runs.
    await page.evaluate(() => {
      const Real = (window as any).VideoEncoder;
      const hold = new Promise<void>((go) => ((window as any).letGo = go));
      (window as any).VideoEncoder = class extends Real {
        async flush() {
          await hold;
          return super.flush();
        }
      };
    });
    const download = page.waitForEvent('download');
    await exportButton(page).focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('.exp__run')).toBeVisible();
    // The button that was pressed is gone. The keyboard rests on the dialog, where a second Enter
    // or a Space cancels nothing, and Cancel is the next stop.
    expect(await inside()).toBe(true);
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(page.locator('.exp__run')).toBeVisible();
    const bar = dialog.getByRole('progressbar', { name: 'Export progress' });
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    await expect(bar).toHaveAttribute('aria-valuenow', /^\d+$/);
    await expect(bar).toHaveAttribute('aria-valuetext', /%, (preparing|rendering|writing file)$/);
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel export' })).toBeFocused();

    await page.evaluate(() => (window as any).letGo());
    await download;
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    // The result is announced, Done has the keyboard and says what was made, and Enter closes.
    const done = dialog.getByRole('button', { name: 'Done' });
    await expect(done).toBeFocused();
    await expect(dialog.getByRole('status')).toContainText('Untitled project.mp4');
    await expect(done).toHaveAccessibleDescription(/Untitled project\.mp4.*rendered in/);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
  });

  test('the key that cancels an export does not go on to start it again', async ({ page }) => {
    await newLocal(page);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      session.store.commit([{ op: 'settings', patch: { width: 320, height: 180 } }]);
      cmd.addSolid('#c04020');
      const solid = Object.values(session.store.get().clips)[0] as any;
      session.store.commit([{ op: 'updateClip', id: solid.id, patch: { duration: 12 } }]);
      ui.getState().set({ dialog: 'export' });
    });
    await expect(page.locator('.exp')).toBeVisible();
    await probed(page);
    const dialog = page.getByRole('dialog');
    // Hold the export in its first frames: stopping it then takes as long as the test says.
    await page.evaluate(() => {
      const Real = (window as any).VideoEncoder;
      const hold = new Promise<void>((go) => ((window as any).letGo = go));
      (window as any).VideoEncoder = class extends Real {
        async flush() {
          await hold;
          return super.flush();
        }
      };
    });
    await exportButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.exp__run')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel export' })).toBeFocused();

    // Enter goes down on Cancel and stays down while the export winds up.
    await page.keyboard.down('Enter');
    await page.evaluate(() => (window as any).letGo());
    await expect(page.locator('.exp__presets')).toBeVisible({ timeout: 60_000 });
    // The keyboard is in the dialog and not on Export: neither the key that is still held nor an
    // impatient second press starts the render again.
    await expect(dialog).toBeFocused();
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(exportButton(page)).toHaveText('Export');
    await expect(page.locator('.exp__run')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(exportButton(page)).toBeFocused();

    // After a failure the next thing to do is to try again, and Export has the keyboard.
    await page.evaluate(() => {
      (window as any).VideoEncoder = class {
        static isConfigSupported = () => Promise.resolve({ supported: true });
        constructor() {
          throw new Error('No encoder to be had');
        }
      };
    });
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Export failed.')).toBeVisible({ timeout: 60_000 });
    await expect(exportButton(page)).toBeFocused();
  });

  /**
   * A local project of one small solid clip, `frames` long, with the export dialog open on it.
   * `project` is what its settings have besides the small size.
   */
  async function smallExport(
    page: Page,
    frames: number,
    project: Record<string, unknown> = {},
  ): Promise<void> {
    await newLocal(page);
    await page.evaluate(
      ({ frames, project }) => {
        const { session, cmd, ui } = (window as any).tandem;
        session.store.commit([{ op: 'settings', patch: { ...project, width: 320, height: 180 } }]);
        cmd.addSolid('#c04020');
        const solid = Object.values(session.store.get().clips)[0] as any;
        session.store.commit([{ op: 'updateClip', id: solid.id, patch: { duration: frames } }]);
        ui.getState().set({ dialog: 'export' });
      },
      { frames, project },
    );
    await expect(page.locator('.exp')).toBeVisible();
    await probed(page);
  }

  test('settings the encoder will not take are said before anything is written', async ({ page }) => {
    await smallExport(page, 12);
    const dialog = page.getByRole('dialog');
    const refused = dialog.locator('.exp__refused');
    const bitrate = dialog.getByRole('textbox', { name: 'Bitrate', exact: true });
    const started = async () =>
      (await page.locator('.exp__run').count()) + (await page.locator('.exp__failed').count());
    await expect(codec(page)).toHaveText(/H\.264/);
    await expect(refused).toHaveCount(0);

    // The field takes more than the software H.264 encoder does at this size. The dialog names
    // the ceiling for this codec and size, and does not offer the export.
    await enter(bitrate, '400');
    await expect(refused).toHaveText(
      /^H\.264 \(AVC\) at 320×180 takes at most [\d.]+ Mbps in this browser\. Lower the bitrate, or choose another codec\.$/,
    );
    await expect(dialog.getByRole('alert')).toHaveText(/takes at most/);
    await expect(exportButton(page)).toBeDisabled();
    // The ceiling is one: at it the export is offered again, a step above it is not.
    const limit = Number(/at most ([\d.]+) Mbps/.exec(await refused.innerText())![1]);
    expect(limit).toBeGreaterThanOrEqual(100);
    expect(limit).toBeLessThan(400);
    await enter(bitrate, (limit + 0.1).toFixed(1));
    await expect(bitrate).toHaveValue((limit + 0.1).toFixed(1));
    await expect(refused).toHaveText(new RegExp(`at most ${limit} Mbps`));
    await enter(bitrate, String(limit));
    await expect(refused).toHaveCount(0);
    await expect(exportButton(page)).toBeEnabled();

    // Typed and not applied, with Export pressed straight away: the press applies the number, and
    // the answer to it comes before anything is started.
    await bitrate.click();
    await bitrate.press('Control+a');
    await bitrate.pressSequentially('400');
    const button = await box(exportButton(page));
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    await expect(refused).toBeVisible();
    await expect(exportButton(page)).toBeDisabled();
    expect(await started()).toBe(0);

    // A kind of encoder this browser does not have for the codec is said the same way.
    await enter(bitrate, '8');
    await expect(refused).toHaveCount(0);
    await page.evaluate(() => {
      const real = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = (config) =>
        config.hardwareAcceleration === 'prefer-hardware'
          ? Promise.resolve({ supported: false, config })
          : real(config);
    });
    const acceleration = dialog.locator('.row', { hasText: 'Acceleration' }).locator('.select');
    await acceleration.click();
    await page.getByRole('option', { name: 'Prefer GPU encoder' }).click();
    await expect(refused).toHaveText(
      'This browser has no GPU encoder for H.264 (AVC) at 320×180. Set Acceleration to Automatic.',
    );
    await expect(exportButton(page)).toBeDisabled();
    await acceleration.click();
    await page.getByRole('option', { name: 'Automatic' }).click();
    await expect(refused).toHaveCount(0);
    expect(await started()).toBe(0);

    // Export pressed twice while the answer for a number just typed is still out: one export is
    // started, and Cancel stops all there is of it. What the encoder is asked is kept back to see
    // that: the dialog's question until both presses are in, and then the question every export
    // puts at its first frame, where it is neither over nor past stopping when Cancel is pressed.
    const downloads: string[] = [];
    page.on('download', (file) => downloads.push(file.suggestedFilename()));
    await page.evaluate(() => {
      const real = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      const asking = ((window as any).asking = {
        kept: 0,
        until: Promise.resolve(),
        letGo: () => {},
        /** Answer what has been kept back, and keep back what is asked from now on. */
        keepNext() {
          const letGo = asking.letGo;
          asking.kept = 0;
          asking.until = new Promise<void>((go) => (asking.letGo = go));
          letGo();
        },
      });
      asking.keepNext();
      VideoEncoder.isConfigSupported = async (config) => {
        asking.kept++;
        await asking.until;
        return real(config);
      };
    });
    const kept = (): Promise<number> => page.evaluate(() => (window as any).asking.kept);
    await bitrate.click();
    await bitrate.press('Control+a');
    await bitrate.pressSequentially('7.3');
    const twice = await box(exportButton(page));
    await page.mouse.click(twice.x + twice.width / 2, twice.y + twice.height / 2);
    await page.mouse.click(twice.x + twice.width / 2, twice.y + twice.height / 2);
    // The dialog's question is the one that is out, and nothing was started without its answer.
    expect(await kept()).toBe(1);
    expect(await started()).toBe(0);
    await page.evaluate(() => (window as any).asking.keepNext());
    await expect(page.locator('.exp__run')).toBeVisible();
    // One export has come to its first frame: a second one would be asking beside it.
    await expect.poll(kept).toBe(1);
    await dialog.getByRole('button', { name: 'Cancel export' }).click();
    await page.evaluate(() => (window as any).asking.letGo());
    await expect(page.locator('.exp__presets')).toBeVisible({ timeout: 60_000 });
    await expect(bitrate).toHaveValue('7.3');

    // A bitrate that is not a whole number of bits once multiplied out is exported like any other.
    // Its file is the only one there is: nothing of the cancelled export was left running to
    // write one of its own.
    await enter(bitrate, '4.1');
    const download = page.waitForEvent('download');
    await exportButton(page).click();
    await download;
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    expect(downloads).toEqual(['Untitled project.mp4']);
  });

  test('a save prompt that fails is said with its reason, and the export is downloaded instead', async ({
    page,
  }) => {
    await smallExport(page, 90);
    const dialog = page.getByRole('dialog');
    const said = toast(page, 'cannot be written straight to a file');
    // Three seconds at this bitrate are estimated above the size up to which an export is built
    // in memory without asking.
    await enter(dialog.getByRole('textbox', { name: 'Bitrate', exact: true }), '200');
    await expect
      .poll(async () => Number(/≈ ([\d.]+) MB/.exec(await page.locator('.exp__est').innerText())?.[1]))
      .toBeGreaterThan(64);
    const prompt = (fails: string): Promise<void> =>
      page.evaluate((fails) => {
        (window as any).showSaveFilePicker = () =>
          Promise.reject(new DOMException('No prompt can be shown here.', fails));
      }, fails);

    // Closed by the person, the prompt is "not now": nothing starts, and there is nothing to say.
    await prompt('AbortError');
    await exportButton(page).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.exp__run')).toHaveCount(0);
    await expect(said).toHaveCount(0);

    // Refused by the browser, it is no reason to lose the export, and no secret either.
    await prompt('SecurityError');
    await exportButton(page).click();
    await expect(page.locator('.exp__run')).toBeVisible();
    await expect(said).toHaveText(
      'This export cannot be written straight to a file, so it will be downloaded when it is done. The browser’s reason: No prompt can be shown here.',
    );
    await dialog.getByRole('button', { name: 'Cancel export' }).click();
    await expect(page.locator('.exp__presets')).toBeVisible({ timeout: 60_000 });
  });

  test('Cancel pressed when every frame is drawn still cancels, and nothing is downloaded', async ({
    page,
  }) => {
    await smallExport(page, 12);
    const dialog = page.getByRole('dialog');
    const downloads: string[] = [];
    page.on('download', (file) => downloads.push(file.suggestedFilename()));
    // The encoder is flushed once the last frame has gone to it: the export is held there, where
    // the file is being finished and there is nothing left to draw.
    await page.evaluate(() => {
      const Real = (window as any).VideoEncoder;
      const held = ((window as any).held = { flushes: 0, letGo: () => {} });
      const hold = new Promise<void>((go) => (held.letGo = go));
      (window as any).VideoEncoder = class extends Real {
        async flush() {
          held.flushes++;
          await hold;
          return super.flush();
        }
      };
    });
    await exportButton(page).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).held.flushes), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect(dialog.locator('.exp__run .kv dd').first()).toHaveText('Writing file');

    // Cancel is offered there as before, and is no less a cancel: the settings come back, and
    // neither a file nor word of one follows.
    await dialog.getByRole('button', { name: 'Cancel export' }).click();
    await page.evaluate(() => (window as any).held.letGo());
    await expect(page.locator('.exp__presets')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Export complete')).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(downloads).toEqual([]);

    // The export after it makes the only file there is.
    const download = page.waitForEvent('download');
    await exportButton(page).click();
    await download;
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    expect(downloads).toEqual(['Untitled project.mp4']);
  });

  test('a 10-bit export is asked about under its own codec string, before the save prompt', async ({
    page,
  }) => {
    // Three seconds: at the bitrates below the export is estimated above the size up to which it
    // is built in memory, so one that started would ask where to save first.
    await smallExport(page, 90, { colorMode: 'hdr-pq', toneMap: 'bt2390' });
    const dialog = page.getByRole('dialog');
    const refused = dialog.locator('.exp__refused');
    const bitrate = dialog.getByRole('textbox', { name: 'Bitrate', exact: true });
    const started = async () =>
      (await page.locator('.exp__run').count()) + (await page.locator('.exp__failed').count());
    await expect(range(page)).toContainText('HDR10');
    if ((await codec(page).innerText()).includes('No encoder')) {
      // A browser with no 10-bit encoder for MP4 at all has nothing to be asked about: that is
      // what stands in the way there, and what the dialog names.
      await expect(codec(page)).toHaveText('No encoder available for this format in 10-bit');
      await expect(exportButton(page)).toBeDisabled();
      await expect(refused).toHaveCount(0);
      return;
    }
    await expect(codec(page)).toHaveText(/HEVC|VP9|AV1/);
    await expect(refused).toHaveCount(0);
    await expect(exportButton(page)).toBeEnabled();

    // An encoder that takes a 10-bit picture up to 200 Mbps and has no GPU version for one, and a
    // save prompt that notes it was shown and is closed again. An 8-bit picture is not affected,
    // so a question put under an 8-bit codec string would find nothing to say.
    await page.evaluate(() => {
      const real = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = (config) =>
        /^vp09\.02\.|^av01\.0\.\d\dM\.10\.|^hvc1\.2\./.test(config.codec)
          ? Promise.resolve({
              supported: (config.bitrate ?? 0) <= 200e6 && config.hardwareAcceleration !== 'prefer-hardware',
              config,
            })
          : real(config);
      (window as any).prompts = 0;
      (window as any).showSaveFilePicker = () => {
        (window as any).prompts++;
        return Promise.reject(new DOMException('Closed.', 'AbortError'));
      };
    });
    const prompts = (): Promise<number> => page.evaluate(() => (window as any).prompts);

    // Typed and not applied, with Export pressed straight away: the ceiling is named for the
    // 10-bit picture, and neither the export nor the question where to save it has begun.
    await bitrate.click();
    await bitrate.press('Control+a');
    await bitrate.pressSequentially('400');
    const button = await box(exportButton(page));
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    await expect(refused).toHaveText(
      /^10-bit (H\.265 \(HEVC\)|VP9|AV1) at 320×180 takes at most 200 Mbps in this browser\. Lower the bitrate, or choose another codec\.$/,
    );
    await expect(exportButton(page)).toBeDisabled();
    expect(await started()).toBe(0);
    expect(await prompts()).toBe(0);

    // The kind of encoder is found to be in the way the same.
    await enter(bitrate, '200');
    await expect(refused).toHaveCount(0);
    const acceleration = dialog.locator('.row', { hasText: 'Acceleration' }).locator('.select');
    await acceleration.click();
    await page.getByRole('option', { name: 'Prefer GPU encoder' }).click();
    await expect(refused).toHaveText(
      /^This browser has no GPU encoder for 10-bit (H\.265 \(HEVC\)|VP9|AV1) at 320×180\. Set Acceleration to Automatic\.$/,
    );
    await expect(exportButton(page)).toBeDisabled();
    await acceleration.click();
    await page.getByRole('option', { name: 'Automatic' }).click();
    await expect(refused).toHaveCount(0);
    expect(await prompts()).toBe(0);

    // At the ceiling the export is offered, and pressing it gets as far as the save prompt.
    await exportButton(page).click();
    await expect.poll(prompts).toBe(1);
    expect(await started()).toBe(0);
  });
});
