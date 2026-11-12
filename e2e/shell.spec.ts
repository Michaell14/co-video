import { expect, test, type Dialog, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { FIXTURES, importFixtures, newProject } from './helpers';

/**
 * The frame around the editing surfaces: the panel layout and the top bar, the library, the home
 * screen and the dialogs of a shared project.
 */

const tandem = <T>(page: Page, fn: (t: any) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.tandem)`) as Promise<T>;

const editorReady = (page: Page) => page.waitForFunction(() => !!(window as any).tandem?.session?.player);

/** A project in this browser only: the collaboration server limits projects per address and hour. */
async function localProject(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
}

/** A local project holding the bundled sample edit: three clips, a title and music. */
async function sample(page: Page): Promise<void> {
  await localProject(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });
}

const setUI = (page: Page, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate((patch) => (window as any).tandem.ui.getState().set(patch), patch);

const box = async (target: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await target.boundingBox();
  if (!b) throw new Error('not on the page');
  return b;
};

const panel = (page: Page, name: string): Locator => page.locator(`section[aria-label="${name}"]`);

const clipTypes = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (Object.values((window as any).tandem.session.store.get().clips) as any[]).map((c) => c.type).sort(),
  );

const projectName = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).tandem.session.store.get().settings.name);

const undoSteps = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);

const registry = (page: Page): Promise<any[]> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('tandem.projects.v1') ?? '[]'));

const toast = (page: Page, text: string): Locator => page.locator('.toast', { hasText: text });

/** Every toast from now on is kept in `window.__toasts`, also the ones that have faded since. */
async function watchToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = ((window as any).__toasts = []);
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof HTMLElement && n.classList.contains('toast')) seen.push(n.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true });
  });
}

const toastsWith = (page: Page, text: string): Promise<number> =>
  page.evaluate(
    (text) => ((window as any).__toasts as string[]).filter((t) => t.includes(text)).length,
    text,
  );

/**
 * Answer the question `act` raises. It is asked in a dialog of the editor's own; a browser prompt
 * is answered the same way should one appear instead.
 */
async function answer(page: Page, act: () => Promise<void>, label: string, go = true): Promise<void> {
  let native = false;
  const onDialog = (d: Dialog): void => {
    native = true;
    void (go ? d.accept() : d.dismiss());
  };
  page.on('dialog', onDialog);
  await act();
  const button = page.getByRole('dialog').getByRole('button', { name: go ? label : 'Cancel', exact: true });
  await expect.poll(async () => native || (await button.count()) > 0).toBe(true);
  if (!native) {
    // The button that goes ahead is named after what it does.
    await expect(page.getByRole('dialog').getByRole('button', { name: label, exact: true })).toBeVisible();
    await button.click();
    await expect(button).toHaveCount(0);
  }
  page.off('dialog', onDialog);
}

async function drag(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
  const b = await box(handle);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
}

/** The width of a panel once it has stopped changing: the columns glide to a new layout. */
async function settledWidth(target: Locator): Promise<number> {
  let last = -1;
  await expect
    .poll(async () => {
      // A busy page can show the same width twice in the middle of a glide, so ask about the glide too.
      const now = await target.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        gliding: el.parentElement!.getAnimations().length > 0,
      }));
      const still = !now.gliding && now.width === last;
      last = now.width;
      return still;
    })
    .toBe(true);
  return last;
}

test.describe('panel layout', () => {
  test('sizes chosen on a large screen fit a small window, and are kept for the large one', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await localProject(page);
    await setUI(page, { leftWidth: 560, rightWidth: 560, timelineHeight: 760 });
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem('tandem.ui.v1') ?? '{}').timelineHeight),
      )
      .toBe(760);

    // The same browser profile on a laptop: every panel is there, and nothing is pushed off screen.
    await page.setViewportSize({ width: 1100, height: 640 });
    await page.reload();
    await editorReady(page);
    const viewer = await box(panel(page, 'Viewer'));
    expect(viewer.width).toBeGreaterThanOrEqual(400);
    expect(viewer.height).toBeGreaterThanOrEqual(200);
    for (const name of ['Library', 'Viewer', 'Inspector', 'Timeline']) {
      const b = await box(panel(page, name));
      expect(b.x, name).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, name).toBeLessThanOrEqual(1100);
      expect(b.y + b.height, name).toBeLessThanOrEqual(640);
      expect(b.width, name).toBeGreaterThanOrEqual(220);
    }
    const exportButton = await box(page.locator('.topbar .btn--primary'));
    expect(exportButton.x + exportButton.width).toBeLessThanOrEqual(1100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100);

    // Nothing was given up for it: on the large screen the panels are as they were set.
    const width = async (name: string) => (await box(panel(page, name))).width;
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => width('Inspector')).toBe(560);
    expect(await width('Library')).toBe(560);
    expect((await box(panel(page, 'Timeline'))).height).toBe(760);

    // A splitter moves its panel from where it is drawn, by as much as the pointer moves: there is
    // no dead travel first, and the panel on the other side stays put.
    await page.setViewportSize({ width: 1100, height: 640 });
    const drawn = {
      library: await settledWidth(panel(page, 'Library')),
      viewer: await settledWidth(panel(page, 'Viewer')),
      inspector: await settledWidth(panel(page, 'Inspector')),
    };
    expect(drawn.library).toBeLessThan(560);
    await drag(page, page.locator('.resizer--x').first(), -40, 0);
    await expect.poll(() => width('Library')).toBe(drawn.library - 40);
    expect(await width('Viewer')).toBe(drawn.viewer + 40);
    expect(await width('Inspector')).toBe(drawn.inspector);
    const timeline = (await box(panel(page, 'Timeline'))).height;
    await drag(page, page.locator('.resizer--y'), 0, 30);
    await expect.poll(async () => (await box(panel(page, 'Timeline'))).height).toBe(timeline - 30);
  });

  test('comments take the inspector’s column where a fourth one would crush the viewer', async ({ page }) => {
    await localProject(page);
    const viewer = async () => (await box(panel(page, 'Viewer'))).width;
    const before = await viewer();
    const inspector = await box(panel(page, 'Inspector'));

    await page.locator('.topbar').getByRole('button', { name: 'Comments' }).click();
    const comments = panel(page, 'Comments');
    await expect(comments).toBeVisible();
    await expect(panel(page, 'Inspector')).toHaveCount(0);
    await expect.poll(viewer).toBe(before);
    await expect.poll(async () => (await box(comments)).x).toBe(inspector.x);

    // Timestamps are read, so they are set in the colour for secondary text.
    const draft = comments.locator('textarea');
    await draft.fill('Hold this shot longer');
    await draft.press('Enter');
    const stamp = comments.locator('.comment__ago');
    await expect(stamp).toBeVisible();
    const colours = await stamp.evaluate((el) => {
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = 'var(--fg-3)';
      const wanted = getComputedStyle(probe).color;
      probe.remove();
      return { stamp: getComputedStyle(el).color, wanted };
    });
    expect(colours.stamp).toBe(colours.wanted);

    // On a wide screen there is room for both, and a half-written comment survives the change.
    await draft.fill('Tighten the intro');
    await page.setViewportSize({ width: 1800, height: 900 });
    await expect(panel(page, 'Inspector')).toBeVisible();
    await expect(comments).toBeVisible();
    await expect(draft).toHaveValue('Tighten the intro');
    expect(await viewer()).toBeGreaterThanOrEqual(560);
    expect((await box(comments)).x).toBeGreaterThan((await box(panel(page, 'Inspector'))).x);

    // Adding a title needs the inspector's text field: the comments give the column back.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(panel(page, 'Inspector')).toHaveCount(0);
    await page.locator('.tl__hint, .tl__body').first().click();
    await page.keyboard.press('t');
    await expect(page.locator('textarea[aria-label="Text content"]')).toBeFocused();
    await expect(comments).toHaveCount(0);
  });

  test('a splitter moves its panel, and leaves the comments where they are', async ({ page }) => {
    await localProject(page);
    const width = async (name: string) => (await box(panel(page, name))).width;
    await setUI(page, { commentsOpen: true });
    const comments = panel(page, 'Comments');
    await expect(comments).toBeVisible();
    await expect(panel(page, 'Inspector')).toHaveCount(0);

    // In the inspector's column they stay in it, however much room the library gives up.
    const viewer = await settledWidth(panel(page, 'Viewer'));
    await drag(page, page.locator('.resizer--x').first(), -90, 0);
    await expect.poll(() => width('Library')).toBe(230);
    expect(await width('Viewer')).toBe(viewer + 90);
    expect(await width('Comments')).toBe(316);
    await expect(panel(page, 'Inspector')).toHaveCount(0);

    // In a column of their own they keep it: the inspector grows until the viewer is down to what
    // it keeps beside comments, and stops there.
    await setUI(page, { leftWidth: 320 });
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(panel(page, 'Inspector')).toBeVisible();
    expect(await settledWidth(panel(page, 'Inspector'))).toBe(316);
    const handle = await box(page.locator('.resizer--x').nth(1));
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y, { steps: 6 });
    await expect.poll(() => width('Inspector')).toBe(376);
    await page.mouse.move(x - 130, y, { steps: 7 });
    await expect.poll(() => width('Viewer')).toBe(560);
    expect(await width('Inspector')).toBe(390);
    expect(await width('Comments')).toBe(300);
    expect((await box(comments)).x).toBeGreaterThan((await box(panel(page, 'Inspector'))).x);
    // Having overshot the stop, the pointer finds the panel edge where it left it on the way back.
    await page.mouse.move(x - 60, y, { steps: 7 });
    await expect.poll(() => width('Inspector')).toBe(376);
    await page.mouse.up();
  });

  test('comments leave the colour and audio workspaces the panel they are for', async ({ page }) => {
    await localProject(page);
    const workspaces = [
      { tab: 'Colour', own: '.color', gives: 'Scopes' },
      { tab: 'Audio', own: '.mixer', gives: 'Library' },
    ];
    const open = (tab: string) => page.locator('.topbar__center').getByRole('button', { name: tab }).click();
    const without: Record<string, { viewer: number; own: number; left: number }> = {};
    for (const { tab, gives } of workspaces) {
      await open(tab);
      without[tab] = {
        viewer: await settledWidth(panel(page, 'Viewer')),
        own: await settledWidth(panel(page, 'Inspector')),
        left: (await box(panel(page, gives))).x,
      };
    }

    await open('Edit');
    await page.locator('.topbar').getByRole('button', { name: 'Comments' }).click();
    const comments = panel(page, 'Comments');
    const draft = comments.locator('textarea');
    await draft.fill('Warmer in the shadows');
    await expect(panel(page, 'Inspector')).toHaveCount(0);

    for (const { tab, own, gives } of workspaces) {
      await open(tab);
      // The grading controls or the mixer are still there, as wide as they were; the comments
      // stand where the scopes or the library did, and the viewer has lost nothing.
      await expect(panel(page, 'Inspector').locator(own)).toBeVisible();
      await expect(panel(page, gives)).toHaveCount(0);
      await expect.poll(async () => (await box(panel(page, 'Inspector'))).width, tab).toBe(without[tab].own);
      await expect.poll(async () => (await box(panel(page, 'Viewer'))).width, tab).toBe(without[tab].viewer);
      expect((await box(comments)).x, tab).toBe(without[tab].left);
      await expect(draft).toHaveValue('Warmer in the shadows');
    }

    // Closing them brings back what they stood in for.
    await comments.getByRole('button', { name: 'Close comments' }).click();
    await expect(panel(page, 'Library')).toBeVisible();
    await expect(panel(page, 'Inspector').locator('.mixer')).toBeVisible();
  });
});

test.describe('top bar', () => {
  test('the project name is replaced by typing, kept by Escape and stored by Enter', async ({ page }) => {
    await localProject(page);
    const name = page.getByLabel('Project name');
    const selection = () =>
      name.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length]);
    const steps = await undoSteps(page);

    await name.click();
    expect(await selection()).toEqual([0, 16, 16]);
    await page.keyboard.type('Oops wrong');
    await expect(name).toHaveValue('Oops wrong');
    await page.keyboard.press('Escape');
    await expect(name).not.toBeFocused();
    await expect(name).toHaveValue('Untitled project');
    expect(await projectName(page)).toBe('Untitled project');
    expect(await undoSteps(page)).toBe(steps);

    await name.click();
    await page.keyboard.type('Rough cut');
    await page.keyboard.press('Enter');
    await expect.poll(() => projectName(page)).toBe('Rough cut');
    await expect(name).toHaveValue('Rough cut');
    expect(await undoSteps(page)).toBe(steps + 1);

    // Once in the field, a press places the caret like in any other text field.
    await name.click();
    await name.click({ position: { x: 14, y: 12 } });
    const [start, end] = await selection();
    expect(start).toBe(end);
    await page.keyboard.press('Escape');

    await expect(page.locator('.topbar__center')).toContainText('Colour');
  });
});

test.describe('library', () => {
  const tabs = (page: Page) =>
    page.evaluate(() => {
      const side = document.querySelector('section[aria-label="Library"]')!.getBoundingClientRect();
      const ink = document.querySelector('.lib__tabs .tabs__ink')!.getBoundingClientRect();
      return Array.from(document.querySelectorAll<HTMLElement>('.lib__tabs .tab')).map((t) => {
        const r = t.getBoundingClientRect();
        return {
          name: t.getAttribute('aria-label'),
          shown: t.innerText.trim(),
          inside: r.left >= side.left && r.right <= side.right,
          underlined: Math.abs(ink.left - r.left) < 1.5 && Math.abs(ink.width - r.width) < 1.5,
        };
      });
    });

  test('all four tabs stay within the panel, folding to icons when it is narrow', async ({ page }) => {
    await localProject(page);
    const names = ['Media', 'Titles', 'Effects', 'Transitions'];
    const state = await tabs(page);
    expect(state.map((t) => t.name)).toEqual(names);
    expect(state.map((t) => t.shown)).toEqual(names);
    expect(state.every((t) => t.inside)).toBe(true);
    await expect
      .poll(async () => (await tabs(page)).map((t) => t.underlined))
      .toEqual([true, false, false, false]);

    // As narrow as the splitter goes: the open tab keeps its name, the others name themselves on hover.
    await drag(page, page.locator('.resizer--x').first(), -200, 0);
    await expect.poll(async () => (await box(panel(page, 'Library'))).width).toBe(220);
    await expect.poll(async () => (await tabs(page)).map((t) => t.shown)).toEqual(['Media', '', '', '']);
    expect((await tabs(page)).every((t) => t.inside)).toBe(true);
    const transitions = page.getByRole('tab', { name: 'Transitions' });
    await transitions.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Transitions');
    await transitions.click();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect
      .poll(async () => (await tabs(page)).map((t) => t.shown))
      .toEqual(['', '', '', 'Transitions']);
    await expect
      .poll(async () => (await tabs(page)).map((t) => t.underlined))
      .toEqual([false, false, false, true]);
    expect((await tabs(page)).every((t) => t.inside)).toBe(true);
    await expect(page.locator('.fx').first()).toBeVisible();

    // Widened again, every name is back and the underline has followed its tab.
    await page.getByRole('tab', { name: 'Effects' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Effects');
    await setUI(page, { leftWidth: 320 });
    await expect.poll(async () => (await tabs(page)).map((t) => t.shown)).toEqual(names);
    await expect
      .poll(async () => (await tabs(page)).map((t) => t.underlined))
      .toEqual([false, false, false, true]);
    await page.mouse.move(700, 300);
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    // Labels set in a wider stand-in face fold the row; it unfolds when the real font replaces it.
    const standIn = await page.addStyleTag({ content: '.lib__tabs .tab__label { letter-spacing: 0.6px }' });
    await expect
      .poll(async () => (await tabs(page)).map((t) => t.shown))
      .toEqual(['', '', '', 'Transitions']);
    await standIn.evaluate((style) => style.remove());
    await expect.poll(async () => (await tabs(page)).map((t) => t.shown)).toEqual(names);
    expect((await tabs(page)).every((t) => t.inside)).toBe(true);
  });

  test('every filter chip is in view, and the chosen one is quiet', async ({ page }) => {
    await localProject(page);
    await page.getByRole('tab', { name: 'Effects' }).click();
    const chips = await page.evaluate(() => {
      const side = document.querySelector('section[aria-label="Library"]')!.getBoundingClientRect();
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = 'var(--fg-1)';
      const loud = getComputedStyle(probe).color;
      probe.remove();
      return Array.from(document.querySelectorAll<HTMLElement>('.chips .chip')).map((c) => {
        const r = c.getBoundingClientRect();
        return {
          label: c.innerText.trim(),
          pressed: c.getAttribute('aria-pressed'),
          inside: r.left >= side.left && r.right <= side.right,
          loud: getComputedStyle(c).backgroundColor === loud,
        };
      });
    });
    expect(chips.map((c) => c.label)).toContain('Retro');
    expect(chips.length).toBeGreaterThanOrEqual(9);
    expect(chips.filter((c) => !c.inside)).toEqual([]);
    expect(chips.filter((c) => c.pressed === 'true').map((c) => c.label)).toEqual(['All']);
    expect(chips.filter((c) => c.loud)).toEqual([]);
  });

  test('a video can be added as picture only or as sound only', async ({ page }) => {
    await localProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    const card = page.locator('.asset', { hasText: 'testsrc.mp4' });
    const add = async (item: string) => {
      await card.click({ button: 'right' });
      await page.getByRole('menuitem', { name: item, exact: true }).click();
    };
    await add('Add video only');
    await expect.poll(() => clipTypes(page)).toEqual(['video']);
    await add('Add audio only');
    await expect.poll(() => clipTypes(page)).toEqual(['audio', 'video']);
    // Neither is tied to a partner that was never added.
    const links = await page.evaluate(() =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[]).map((c) => c.linkId ?? null),
    );
    expect(links).toEqual([null, null]);
    await add('Add to timeline');
    await expect.poll(() => clipTypes(page)).toEqual(['audio', 'audio', 'video', 'video']);
  });

  test('a title preset puts the keyboard in the new title’s text', async ({ page }) => {
    await localProject(page);
    await page.getByRole('tab', { name: 'Titles' }).click();
    await page.locator('.preset', { hasText: 'Name here' }).click();
    const field = page.locator('textarea[aria-label="Text content"]');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Name Surname');
    await page.keyboard.type('Ada Lovelace');
    await expect
      .poll(() =>
        page.evaluate(() =>
          (Object.values((window as any).tandem.session.store.get().clips) as any[]).map(
            (c) => c.text?.content,
          ),
        ),
      )
      .toEqual(['Ada Lovelace']);
  });

  test('“Reveal in media pool” shows the file behind a clip whatever the pool was showing', async ({
    page,
  }) => {
    // A short window: the pool shows one row of cards at a time.
    await page.setViewportSize({ width: 1280, height: 640 });
    await sample(page);
    const pressed = () => page.locator('.chips .chip[aria-pressed="true"]').innerText();
    const search = page.getByLabel('Search media');
    const dusk = page.locator('.asset', { hasText: 'dusk.mp4' });
    const duskClip = page.locator('.clip', { hasText: 'dusk.mp4' });

    // The pool is narrowed to something else: the search and the filter give way.
    await page.locator('.chips .chip', { hasText: 'Audio' }).click();
    await search.fill('pulse');
    await expect(page.locator('.asset')).toHaveCount(1);
    await expect(dusk).toHaveCount(0);
    await duskClip.click({ button: 'right', position: { x: 30, y: 30 } });
    await page.getByRole('menuitem', { name: 'Reveal in media pool' }).click();
    await expect(dusk).toBeInViewport({ ratio: 0.9 });
    await expect(dusk).toHaveAttribute('data-revealed', 'true');
    await expect(search).toHaveValue('');
    expect(await pressed()).toContain('All');
    await expect(page.locator('.asset')).toHaveCount(4);
    // The mark is a moment's emphasis, not a state.
    await expect(dusk).not.toHaveAttribute('data-revealed', 'true', { timeout: 5000 });

    // A search that already shows the file is left alone.
    await page.locator('.pool__grid').evaluate((el) => (el.scrollTop = 0));
    await search.fill('mp4');
    await expect(page.locator('.asset')).toHaveCount(3);
    await duskClip.click({ button: 'right', position: { x: 30, y: 30 } });
    await page.getByRole('menuitem', { name: 'Reveal in media pool' }).click();
    await expect(dusk).toHaveAttribute('data-revealed', 'true');
    await expect(dusk).toBeInViewport({ ratio: 0.9 });
    await expect(search).toHaveValue('mp4');

    // From the Colour workspace, where the library is not on screen at all.
    await setUI(page, { workspace: 'color' });
    await expect(panel(page, 'Library')).toHaveCount(0);
    await duskClip.click({ button: 'right', position: { x: 30, y: 30 } });
    await page.getByRole('menuitem', { name: 'Reveal in media pool' }).click();
    await expect(dusk).toBeInViewport({ ratio: 0.9 });
    await expect(dusk).toHaveAttribute('data-revealed', 'true');
    expect(await tandem(page, (t) => t.ui.getState().workspace)).toBe('edit');

    // The audio workspace has the pool on screen, so there it is shown beside the mixer.
    const mixer = panel(page, 'Inspector').locator('.mixer');
    await setUI(page, { workspace: 'audio' });
    await expect(mixer).toBeVisible();
    await expect(dusk).not.toHaveAttribute('data-revealed', 'true', { timeout: 5000 });
    await duskClip.click({ button: 'right', position: { x: 30, y: 30 } });
    await page.getByRole('menuitem', { name: 'Reveal in media pool' }).click();
    await expect(dusk).toHaveAttribute('data-revealed', 'true');
    expect(await tandem(page, (t) => t.ui.getState().workspace)).toBe('audio');
    await expect(mixer).toBeVisible();
    // Comments standing in for the library there make way for it.
    await setUI(page, { commentsOpen: true });
    await expect(panel(page, 'Library')).toHaveCount(0);
    await duskClip.click({ button: 'right', position: { x: 30, y: 30 } });
    await page.getByRole('menuitem', { name: 'Reveal in media pool' }).click();
    await expect(dusk).toBeInViewport({ ratio: 0.9 });
    await expect(dusk).toHaveAttribute('data-revealed', 'true');
    await expect(panel(page, 'Comments')).toHaveCount(0);
    expect(await tandem(page, (t) => t.ui.getState().workspace)).toBe('audio');
    await expect(mixer).toBeVisible();
    await setUI(page, { workspace: 'edit' });

    // From another tab of the library, by the command: it goes by the selected clip.
    await page.getByRole('tab', { name: 'Effects' }).click();
    await page.keyboard.press('Control+k');
    const input = page.locator('.palette input');
    await expect(input).toBeFocused();
    await input.fill('reveal in media pool');
    await expect(page.locator('.palette__item')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(dusk).toBeInViewport({ ratio: 0.9 });
    await expect(dusk).toHaveAttribute('data-revealed', 'true');

    // A title has no file to show.
    await page.locator('.clip', { hasText: 'Edit in tandem' }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Edit text' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Reveal in media pool' })).toHaveCount(0);
  });
});

test.describe('effect thumbnails', () => {
  const picture = (page: Page, name: string): Promise<string> =>
    page
      .locator('.fx', { has: page.getByText(name, { exact: true }) })
      .locator('canvas')
      .evaluate((c: HTMLCanvasElement) => c.toDataURL());

  /** The share of a thumbnail's pixels that are close to white. */
  const whiteShare = (page: Page, name: string): Promise<number> =>
    page
      .locator('.fx', { has: page.getByText(name, { exact: true }) })
      .locator('canvas')
      .evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let white = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
        return white / (d.length / 4);
      });

  test('each shows what its effect does', async ({ page }) => {
    await localProject(page);
    await page.getByRole('tab', { name: 'Effects' }).click();
    const blank = await page.evaluate(() =>
      Object.assign(document.createElement('canvas'), { width: 160, height: 90 }).toDataURL(),
    );
    const names = [
      'Brightness & Contrast',
      'Exposure',
      'Hue & Saturation',
      'Vibrance',
      'Temperature & Tint',
      'Levels',
      'Color Overlay',
      'Outline',
      'Drop Shadow',
    ];
    for (const name of names)
      await expect.poll(() => picture(page, name), { timeout: 30_000 }).not.toBe(blank);
    const pictures = await Promise.all(names.map((name) => picture(page, name)));
    expect(new Set(pictures).size).toBe(names.length);

    // An overlay tints the picture instead of hiding it, and an outline is a thin line round a layer.
    expect(await whiteShare(page, 'Color Overlay')).toBeLessThan(0.2);
    const outline = await whiteShare(page, 'Outline');
    expect(outline).toBeGreaterThan(0.02);
    expect(outline).toBeLessThan(0.3);
  });

  test('are drawn again on a new context after the graphics context is lost', async ({ page }) => {
    await page.addInitScript(() => {
      const made: WebGL2RenderingContext[] = ((window as any).__thumbContexts = []);
      const real = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function (this: OffscreenCanvas, kind: string, ...rest: any[]) {
        const context = (real as any).call(this, kind, ...rest);
        if (kind === 'webgl2' && context && this.width === 160 && this.height === 90) made.push(context);
        return context;
      } as typeof real;
    });
    await localProject(page);
    await page.getByRole('tab', { name: 'Effects' }).click();
    const blank = await page.evaluate(() =>
      Object.assign(document.createElement('canvas'), { width: 160, height: 90 }).toDataURL(),
    );
    await expect.poll(() => picture(page, 'Exposure'), { timeout: 30_000 }).not.toBe(blank);
    expect(await page.evaluate(() => (window as any).__thumbContexts.length)).toBe(1);

    await page.evaluate(() => {
      const [context] = (window as any).__thumbContexts as WebGL2RenderingContext[];
      context.getExtension('WEBGL_lose_context')!.loseContext();
    });
    // Thumbnails that were never drawn before have to come from a context made after the loss.
    await page.getByRole('tab', { name: 'Transitions' }).click();
    for (const name of ['Cross Dissolve', 'Additive Dissolve']) {
      await expect.poll(() => picture(page, name), { timeout: 30_000 }).not.toBe(blank);
    }
    expect(await page.evaluate(() => (window as any).__thumbContexts.length)).toBe(2);
    const [first, second] = await Promise.all([
      picture(page, 'Cross Dissolve'),
      picture(page, 'Additive Dissolve'),
    ]);
    expect(first).not.toBe(second);
  });
});

test.describe('home screen', () => {
  const goHome = async (page: Page): Promise<void> => {
    await page.goto('/#/');
    await expect(page.locator('.home__hero')).toBeVisible();
  };
  const card = (page: Page, name: string): Locator =>
    page.locator('.pcard', { has: page.locator('.pcard__name', { hasText: new RegExp(`^${name}$`) }) });
  const menu = async (page: Page, name: string, item: string): Promise<void> => {
    await card(page, name).hover();
    await card(page, name)
      .getByRole('button', { name: `Options for ${name}` })
      .click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  /** Let the session write the project list entry (it does so a moment after each change). */
  const listed = (page: Page, name: string) =>
    expect.poll(async () => (await registry(page)).map((p) => p.name), { timeout: 10_000 }).toContain(name);

  test('opens a project file as a new project and says what it does not bring', async ({ page }) => {
    await localProject(page);
    await importFixtures(page, ['tone.ogg']);
    await page.locator('.asset__add').click({ force: true });
    await page.evaluate(() => (window as any).tandem.cmd.renameProject('Field recording'));
    await expect.poll(() => clipTypes(page)).toEqual(['audio']);
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    const file = await download.path();
    const source: string = await page.evaluate(() => (window as any).tandem.session.id);
    await listed(page, 'Field recording');

    await goHome(page);
    await watchToasts(page);
    const open = page.getByRole('button', { name: 'Open project file…' });

    // Something that is not a project file is turned away, and the home screen stays.
    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()]);
    await chooser.setFiles(join(FIXTURES, 'captions.srt'));
    await expect(toast(page, 'That is not a Tandem project file.')).toBeVisible();
    await expect(page.locator('.home__hero')).toBeVisible();
    await expect(open).toBeEnabled();

    [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()]);
    await chooser.setFiles(file);
    await page.waitForFunction((source) => {
      const s = (window as any).tandem?.session;
      return s && s.id !== source && !!s.player;
    }, source);
    await expect
      .poll(() =>
        toastsWith(page, 'Opened “Field recording” as a new project. A project file does not carry media'),
      )
      .toBe(1);
    expect(await projectName(page)).toBe('Field recording');
    expect(await clipTypes(page)).toEqual(['audio']);
    await expect(page.locator('.asset[data-offline="true"]')).toHaveCount(1);
    expect((await registry(page)).map((p) => p.name)).toEqual(['Field recording', 'Field recording']);
  });

  test('renames, duplicates and deletes projects from their cards', async ({ page }) => {
    await localProject(page);
    await importFixtures(page, ['tone.ogg']);
    await page.locator('.asset__add').click({ force: true });
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Opening' }));
    await page.evaluate(() => (window as any).tandem.cmd.renameProject('Holiday'));
    const source: string = await page.evaluate(() => (window as any).tandem.session.id);
    await listed(page, 'Holiday');
    await goHome(page);
    await watchToasts(page);
    await expect(page.locator('.pcard')).toHaveCount(1);

    // Rename: the old name is selected, Escape leaves it, Enter stores it where the editor reads it.
    await menu(page, 'Holiday', 'Rename…');
    const dialog = page.getByRole('dialog', { name: 'Rename project' });
    const field = dialog.getByLabel('Project name');
    await expect(field).toBeFocused();
    // A right-click in the dialog belongs to its text field (the browser's Paste), not to the card.
    await page.evaluate(() => {
      const seen = ((window as any).__rightClicks = [] as boolean[]);
      const note = (e: Event): void => void setTimeout(() => seen.push(e.defaultPrevented));
      document.addEventListener('contextmenu', note, { capture: true, once: true });
    });
    await field.click({ button: 'right' });
    await expect.poll(() => page.evaluate(() => (window as any).__rightClicks)).toEqual([false]);
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await page.keyboard.type('Oops');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(card(page, 'Holiday')).toHaveCount(1);
    // Nor does one on an item of the card's open menu open that menu a second time.
    await card(page, 'Holiday').hover();
    await card(page, 'Holiday').getByRole('button', { name: 'Options for Holiday' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.pcard')).toHaveCount(1);
    await menu(page, 'Holiday', 'Rename…');
    await page.keyboard.type('Holiday 2026');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(card(page, 'Holiday 2026')).toHaveCount(1);
    await expect(card(page, 'Holiday')).toHaveCount(0);

    // Duplicate, from the card's context menu: a second project with the edit and its media.
    await card(page, 'Holiday 2026').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(card(page, 'Holiday 2026 copy')).toHaveCount(1);
    await expect.poll(() => toastsWith(page, 'Duplicated “Holiday 2026”.')).toBe(1);
    await expect(page.locator('.pcard')).toHaveCount(2);
    await card(page, 'Holiday 2026 copy').locator('.pcard__open').click();
    await page.waitForFunction((source) => {
      const s = (window as any).tandem?.session;
      return s && s.id !== source && !!s.player;
    }, source);
    expect(await projectName(page)).toBe('Holiday 2026 copy');
    expect(await clipTypes(page)).toEqual(['audio', 'text']);
    const local = await page.evaluate(() => {
      const s = (window as any).tandem.session;
      return (Object.values(s.store.get().assets) as any[]).map((a) => s.media.get(a.id).local);
    });
    expect(local).toEqual([true]);

    // The project that was renamed carries its new name inside, not only on its card.
    await page.goto(`/#/p/${source}`);
    await page.waitForFunction((source) => (window as any).tandem?.session?.id === source, source);
    await editorReady(page);
    expect(await projectName(page)).toBe('Holiday 2026');
    await expect(page.getByLabel('Project name')).toHaveValue('Holiday 2026');
    expect(await clipTypes(page)).toEqual(['audio', 'text']);

    // Delete asks first, and says no when told no.
    await goHome(page);
    await expect(page.locator('.pcard')).toHaveCount(2);
    await answer(
      page,
      () => menu(page, 'Holiday 2026 copy', 'Delete from this device…'),
      'Delete project',
      false,
    );
    await expect(page.locator('.pcard')).toHaveCount(2);
    await answer(page, () => menu(page, 'Holiday 2026 copy', 'Delete from this device…'), 'Delete project');
    await expect(page.locator('.pcard')).toHaveCount(1);
    await expect(card(page, 'Holiday 2026')).toHaveCount(1);
    expect((await registry(page)).map((p) => p.id)).toEqual([source]);
  });

  test('a link the server has withdrawn is forgotten, so the project opens quietly next time', async ({
    page,
  }) => {
    await localProject(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Kept' }));
    const id: string = await page.evaluate(() => (window as any).tandem.session.id);
    await expect.poll(async () => (await registry(page)).length, { timeout: 10_000 }).toBe(1);
    // Let the edit reach the device before the page goes.
    await page.waitForTimeout(1000);

    // The project was shared once: this device still holds a link, which the server now refuses.
    await page.evaluate((id) => {
      const list = JSON.parse(localStorage.getItem('tandem.projects.v1')!);
      const entry = list.find((p: any) => p.id === id);
      Object.assign(entry, { token: 'withdrawn-link', role: 'editor' });
      localStorage.setItem('tandem.projects.v1', JSON.stringify(list));
    }, id);
    await page.unroute('**/api/health');
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true } }));
    let asked = 0;
    await page.route(`**/api/projects/${id}`, (route) => {
      asked++;
      return route.fulfill({ status: 404, json: { error: 'No such project' } });
    });

    await page.reload();
    await editorReady(page);
    await expect(toast(page, 'The collaboration server no longer accepts your link')).toBeVisible();
    expect(asked).toBe(1);
    expect(await clipTypes(page)).toEqual(['text']);
    const entry = (await registry(page))[0];
    expect(entry.token).toBeNull();
    expect(entry.role).toBeUndefined();

    // Next visit: nothing is asked of the server, nothing is said, and the card is a local project's.
    await page.goto('/#/');
    await expect(page.locator('.pcard')).toHaveCount(1);
    await expect(page.locator('.pcard__shared')).toHaveCount(0);
    await watchToasts(page);
    await page.locator('.pcard__open').click();
    await editorReady(page);
    await expect(page.locator('.conn')).toContainText('Saved on this device');
    await page.waitForTimeout(1500);
    expect(await toastsWith(page, 'no longer accepts')).toBe(0);
    expect(asked).toBe(1);
    expect(await clipTypes(page)).toEqual(['text']);
  });
});

test.describe('shared project', () => {
  /** These need a project on the collaboration server: skip where it did not take the new one. */
  async function sharedProject(page: Page): Promise<void> {
    await newProject(page);
    const { online, shared } = await tandem(page, (t) => {
      const meta = t.session.getMeta();
      return { online: meta.online as boolean, shared: meta.shared as boolean };
    });
    test.skip(!online || !shared, 'no collaboration server, or it is not taking new projects');
  }

  test('the badge of an interrupted upload retries it', async ({ page }) => {
    await sharedProject(page);
    let failing = true;
    let puts = 0;
    await page.route('**/api/projects/*/media/*', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      puts++;
      return failing ? route.abort('connectionreset') : route.fallback();
    });
    await importFixtures(page, ['tone.ogg']);
    const badge = page.getByRole('button', { name: /^Upload interrupted: tone\.ogg\. Retry now$/ });
    // Two attempts fail by themselves; the third is four seconds off.
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => puts, { timeout: 15_000 }).toBe(2);
    // The top bar does not call this synced.
    await expect(page.locator('.conn')).toHaveText('Media not uploaded');
    await badge.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Upload interrupted. Click to retry now.');
    await badge.click();
    await expect.poll(() => puts, { timeout: 1500 }).toBe(3);

    failing = false;
    await expect(badge).toBeVisible();
    await badge.click();
    await expect
      .poll(() => tandem(page, (t) => (Object.values(t.session.store.get().assets) as any[])[0].uploaded), {
        timeout: 30_000,
      })
      .toBe(true);
    await expect(badge).toHaveCount(0);
    await expect(page.locator('.conn')).toHaveText('All changes synced');
  });

  test('restoring a version asks first', async ({ page }) => {
    await sharedProject(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'First' }));
    await expect.poll(() => clipTypes(page)).toEqual(['text']);
    await expect(page.locator('.conn')).toContainText('All changes synced');

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Version history…' }).click();
    const versions = page.getByRole('dialog', { name: 'Version history' });
    await versions.getByPlaceholder('Name this version').fill('Rough cut');
    await versions.getByRole('button', { name: 'Save version' }).click();
    const row = versions.locator('.version', { hasText: 'Rough cut' });
    await expect(row).toBeVisible();

    await page.evaluate(() => (window as any).tandem.cmd.addShape({ kind: 'rect' }));
    await expect.poll(() => clipTypes(page)).toEqual(['shape', 'text']);

    const restore = () => row.getByRole('button', { name: 'Restore' }).click();
    await answer(page, restore, 'Restore version', false);
    await expect(versions).toBeVisible();
    expect(await clipTypes(page)).toEqual(['shape', 'text']);

    await answer(page, restore, 'Restore version');
    await expect.poll(() => clipTypes(page)).toEqual(['text']);
    await expect(toast(page, 'Restored “Rough cut”')).toBeVisible();
    await expect(versions).toHaveCount(0);
  });
});
