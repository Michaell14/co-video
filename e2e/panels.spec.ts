import { expect, test, type Locator, type Page } from '@playwright/test';
import { clips, ffprobe, hasFfprobe, newProject } from './helpers';

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

const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text }).first();

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
    const field = speed.getByLabel('Speed', { exact: true });
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
    const field = async (label: string) => box(insp.getByLabel(label, { exact: true }).locator('..'));
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
    await expect(outline.locator('.row__label')).toHaveText(['Colour', 'Width']);
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
    await page.locator('.strip').first().getByRole('button', { name: 'FX' }).click();
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

    // Solo and mute show what they are switched to while the pointer is still on the button.
    const token = (name: string) =>
      page.evaluate((name) => {
        const probe = document.body.appendChild(document.createElement('span'));
        probe.style.backgroundColor = `var(${name})`;
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      }, name);
    for (const [name, colour] of [
      ['S', '--amber'],
      ['M', '--red'],
    ]) {
      const button = page.locator('.strip').first().getByRole('button', { name, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(await button.evaluate((el) => el.matches(':hover'))).toBe(true);
      await expect(button).toHaveCSS('background-color', await token(colour));
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
    }
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
});
