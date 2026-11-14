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

    // Timestamps are read, so they are set in the colour for secondary text on a raised surface.
    const draft = comments.locator('textarea');
    await draft.fill('Hold this shot longer');
    await draft.press('Enter');
    const stamp = comments.locator('.comment__ago');
    await expect(stamp).toBeVisible();
    const colours = await stamp.evaluate((el) => {
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = 'var(--fg-3-raised)';
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

  test('a splitter is moved from the keyboard, and a drag leaves the keyboard alone', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await localProject(page);
    const width = async (name: string) => (await box(panel(page, name))).width;
    const library = page.getByRole('separator', { name: 'Library width' });
    await expect(library).toHaveAttribute('aria-orientation', 'vertical');
    await expect(library).toHaveAttribute('aria-valuenow', '320');
    await expect(library).toHaveAttribute('aria-valuemin', '220');
    await expect(library).toHaveAttribute('aria-valuemax', '560');

    // The arrows move the splitter, and the panel with it; Shift moves it ten times as far.
    await library.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => width('Library')).toBe(336);
    await expect(library).toHaveAttribute('aria-valuenow', '336');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => width('Library')).toBe(220);
    await page.keyboard.press('End');
    await expect.poll(() => width('Library')).toBe(560);
    await page.keyboard.press('Home');
    await expect.poll(() => width('Library')).toBe(220);
    await page.keyboard.press('PageUp');
    await expect.poll(() => width('Library')).toBe(254);

    // The splitter of a panel on the far side grows it as it moves towards the middle.
    const inspector = page.getByRole('separator', { name: 'Inspector width' });
    await inspector.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => width('Inspector')).toBe(332);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => width('Inspector')).toBe(316);
    const timeline = page.getByRole('separator', { name: 'Timeline height' });
    await expect(timeline).toHaveAttribute('aria-orientation', 'horizontal');
    await timeline.focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await box(panel(page, 'Timeline'))).height).toBe(336);
    await setUI(page, { workspace: 'color' });
    await expect(page.getByRole('separator', { name: 'Scopes width' })).toHaveCount(1);
    await expect(page.getByRole('separator', { name: 'Colour width' })).toHaveCount(1);
    await setUI(page, { workspace: 'edit' });

    // Dragged with the pointer it does not keep the keyboard: the arrow keys stay the playhead's.
    await tandem(page, (t) => t.cmd.addSolid());
    const frame = (): Promise<number> => tandem(page, (t) => t.session.player.getFrame());
    await tandem(page, (t) => t.cmd.seek(10));
    await drag(page, page.locator('.resizer--x').first(), 40, 0);
    await expect.poll(() => width('Library')).toBe(294);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await frame()).toBe(11);
    expect(await width('Library')).toBe(294);
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

  test('a long project name never runs under the workspace switcher', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await localProject(page);
    await tandem(page, (t) =>
      t.cmd.renameProject('A much longer project name for the launch film, final cut v12'),
    );
    const name = page.getByLabel('Project name');
    await expect(name).toHaveValue(/final cut v12$/);
    const redo = page.locator('.topbar').getByRole('button', { name: 'Redo' });
    const switcher = page.locator('.topbar__center');
    const clear = async () => {
      const r = await box(redo);
      return Math.round((await box(switcher)).x - (r.x + r.width));
    };
    const offCentre = async (width: number) => {
      const s = await box(switcher);
      return Math.abs(s.x + s.width / 2 - width / 2);
    };
    const cut = (target: Locator) => target.evaluate((el) => el.scrollWidth > el.clientWidth);
    // The name gives way: the switcher keeps the middle, Redo stays clear of it, and the size
    // beside the name is still whole.
    await expect.poll(clear).toBeGreaterThanOrEqual(8);
    expect(await offCentre(1280)).toBeLessThanOrEqual(1);
    expect(await cut(name)).toBe(true);
    expect(await cut(page.locator('.topbar__meta'))).toBe(false);
    const narrow = (await box(name)).width;

    // With room, the name is as long as it is allowed to be.
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(async () => (await box(name)).width).toBe(280);
    expect(narrow).toBeLessThan(280);
    expect(await clear()).toBeGreaterThanOrEqual(8);
    expect(await offCentre(1920)).toBeLessThanOrEqual(1);
  });

  test('the status says when the work is not reaching the server', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await localProject(page);
    const status = page.locator('.conn');
    const amber = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement('span'));
      probe.style.color = 'var(--amber)';
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    await expect(status).toHaveText('Saved on this device');

    // A link the server refused: the project runs from this device, and the way back is Share.
    await tandem(page, (t) => t.session.setMeta({ refusedLink: 'editor' }));
    await expect(status).toHaveText('Not syncing: link refused');
    await expect(status).toHaveCSS('color', amber);
    await status.hover();
    await expect(page.getByRole('tooltip')).toHaveText(
      'The server did not accept this project’s link. Open Share to try it again.',
    );
    await status.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await tandem(page, (t) => t.ui.getState().dialog)).toBe('share');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // A shared project the server has stopped taking changes for says why.
    const why =
      'This project has reached the size the server allows. Changes made here are kept on this device but are not being saved to the server.';
    await tandem(page, (t) => t.session.setMeta({ refusedLink: null, shared: true, status: 'connected' }));
    await expect(status).toHaveText('All changes synced');
    await page.evaluate((why) => (window as any).tandem.session.setMeta({ notSaving: why }), why);
    await expect(status).toHaveText('Not saving to the server');
    await expect(status).toHaveCSS('color', amber);
    await page.mouse.move(700, 300);
    await status.hover();
    await expect(page.getByRole('tooltip')).toHaveText(why);
    await page.evaluate(() => (window as any).tandem.session.setMeta({ notSaving: null }));
    await expect(status).toHaveText('All changes synced');
  });

  test('the menu lists the editing commands under the names the shortcut sheet gives them', async ({
    page,
  }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await sample(page);
    const menu = page.getByRole('menu');
    const open = async () => {
      await page.getByRole('button', { name: 'Edit commands', exact: true }).click();
      await expect(menu).toBeVisible();
    };
    const entry = (name: string) => menu.getByRole('menuitem', { name: new RegExp(`^${name}`) });
    await open();
    for (const name of [
      'Select clip under playhead',
      'Select next clip',
      'Select previous clip',
      'Mark clip',
      'Go to in',
      'Go to out',
      'Trim nearest edge left',
      'Trim nearest edge right',
      'Extend edit to playhead',
      'Add default transition',
      'Markers follow ripple edits',
    ])
      await expect(entry(name)).toBeEnabled();
    // Nothing has been copied yet, so there is nothing to paste a part of.
    for (const part of ['grade', 'effects', 'transform and crop', 'volume, pan and fades'])
      await expect(entry(`Paste attributes: ${part} only`)).toBeDisabled();
    // The whole menu fits the window it opens in, and so does the file menu beside it.
    const fits = () =>
      menu.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
    expect(await fits()).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(menu.getByRole('menuitem', { name: /^Export…/ })).toBeVisible();
    expect(await fits()).toBe(true);
    await page.keyboard.press('Escape');
    await open();

    // An entry runs its command: the clip under the playhead is selected, then marked.
    await entry('Select clip under playhead').click();
    expect(await tandem(page, (t) => t.ui.getState().selection.length)).toBeGreaterThan(0);
    await open();
    await entry('Mark clip').click();
    expect(await tandem(page, (t) => t.session.player.getState().range)).not.toBeNull();
    await tandem(page, (t) => t.cmd.copyAttributes());
    await open();
    await expect(entry('Paste attributes: grade only')).toBeEnabled();
    await expect(entry('Paste attributes: volume, pan and fades only')).toBeDisabled();
    await entry('Markers follow ripple edits').click();
    await expect(toast(page, 'Markers stay where they are through ripple edits.')).toBeVisible();
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
    await standIn.evaluate((style) => (style as Element).remove());
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

  test('a file takes the place of the selected clip’s media from its card’s menu', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await sample(page);
    await importFixtures(page, ['testsrc.mp4']);
    const entry = page.getByRole('menuitem', { name: 'Replace selected clip with this' });
    const menuOf = async (file: string): Promise<void> => {
      await page.locator('.asset', { hasText: file }).click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Replace media…' })).toBeVisible();
    };
    const select = (ids: string[]) =>
      page.evaluate((ids) => (window as any).tandem.ui.getState().select(ids), ids);
    /** `type:file@start+duration` of every clip that shows a file, in timeline order. */
    const shots = () =>
      tandem(page, (t) => {
        const p = t.session.store.get();
        return (Object.values(p.clips) as any[])
          .filter((c) => c.assetId)
          .sort((a, b) => a.start - b.start || a.type.localeCompare(b.type))
          .map((c) => `${c.type}:${p.assets[c.assetId].name}@${c.start}+${c.duration}`);
      });
    const idOf = (name: string): Promise<string> =>
      page.evaluate(
        (name) =>
          (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
            (c) => c.name === name,
          ).id,
        name,
      );
    const before = await shots();
    expect(before).toEqual([
      'audio:pulse.ogg@0+360',
      'video:dusk.mp4@0+120',
      'video:fractal.mp4@120+120',
      'video:aurora.mp4@240+120',
    ]);

    // With no clip selected, or more than one, there is no clip to offer the file for.
    await select([]);
    await menuOf('dusk.mp4');
    await expect(entry).toHaveCount(0);
    await page.keyboard.press('Escape');
    await select([await idOf('fractal.mp4'), await idOf('aurora.mp4')]);
    await menuOf('dusk.mp4');
    await expect(entry).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The one selected clip takes the file, where it stands and as one step.
    await page.locator('.clip', { hasText: 'fractal.mp4' }).click();
    // The file the clip already shows is not offered to it.
    await menuOf('fractal.mp4');
    await expect(entry).toHaveCount(0);
    await page.keyboard.press('Escape');
    const steps = await undoSteps(page);
    await menuOf('dusk.mp4');
    await entry.click();
    await expect.poll(shots).toEqual([before[0], before[1], 'video:dusk.mp4@120+120', before[3]]);
    expect(await undoSteps(page)).toBe(steps + 1);
    await tandem(page, (t) => t.cmd.undo());
    await expect.poll(shots).toEqual(before);

    // A shot selected with the sound linked to it is one clip: the picture takes the file, and
    // the sound goes, since the new file has none.
    await tandem(page, (t) => t.cmd.seek(360));
    await page.locator('.asset', { hasText: 'testsrc.mp4' }).locator('.asset__add').click();
    await expect
      .poll(async () => (await shots()).slice(4).map((shot) => shot.split('+')[0]))
      .toEqual(['audio:testsrc.mp4@360', 'video:testsrc.mp4@360']);
    expect(await tandem(page, (t) => t.ui.getState().selection.length)).toBe(2);
    const linked = await undoSteps(page);
    await menuOf('aurora.mp4');
    await entry.click();
    await expect
      .poll(async () => (await shots()).slice(4).map((shot) => shot.split('+')[0]))
      .toEqual(['video:aurora.mp4@360']);
    expect(await undoSteps(page)).toBe(linked + 1);

    // A clip that cannot show the file says why, and nothing changes.
    await select([await idOf('Text')]);
    const refused = await shots();
    await menuOf('dusk.mp4');
    await entry.click();
    await expect(toast(page, 'This clip has no media to replace.')).toBeVisible();
    expect(await shots()).toEqual(refused);
    expect(await undoSteps(page)).toBe(linked + 1);
  });

  test('a file this browser cannot decode says so on its card', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await localProject(page);
    await importFixtures(page, ['testsrc.webm', 'red.webm']);
    const card = (file: string) => page.locator('.asset', { hasText: file });
    await expect(page.locator('.asset')).toHaveCount(2);
    await expect(page.locator('.asset__fault')).toHaveCount(0);
    // From here on this browser decodes no picture. What a file needs is found out when it is
    // opened, and the timeline opens the files it shows.
    await page.evaluate(() => {
      VideoDecoder.isConfigSupported = async (config) => ({ supported: false, config });
    });
    await card('testsrc.webm').locator('.asset__add').click();
    await expect(page.locator('.clip__chip', { hasText: 'Unsupported' })).toBeVisible();
    const fault = card('testsrc.webm').getByRole('img', { name: /cannot decode/ });
    await expect(fault).toHaveAccessibleName(/^This browser cannot decode the picture of this file \(vp0?9/);
    // The chip stands beside the place of the transfer badges, on the picture, and says why
    // under the pointer.
    const picture = await box(card('testsrc.webm').locator('.asset__thumb'));
    const chip = await box(fault);
    expect(chip.x).toBeGreaterThanOrEqual(picture.x);
    expect(chip.y).toBeGreaterThanOrEqual(picture.y);
    expect(chip.y + chip.height).toBeLessThan(picture.y + picture.height / 2);
    await fault.hover();
    await expect(page.locator('.tooltip')).toHaveText(/^This browser cannot decode the picture of this file/);
    // The verdict is on that file, not on the pool.
    await expect(card('red.webm').locator('.asset__fault')).toHaveCount(0);
  });

  test('a key or a press that reaches the window from no element of the page is left alone', async ({
    page,
  }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await sample(page);
    const startOf = (name: string): Promise<number> =>
      page.evaluate(
        (name) =>
          (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
            (c) => c.name === name,
          ).start,
        name,
      );
    // Something typed and not applied yet makes a field listen for the press that ends the entry.
    await page.locator('.clip', { hasText: 'aurora.mp4' }).click();
    const start = panel(page, 'Inspector').getByLabel('Start', { exact: true });
    await start.click();
    await start.pressSequentially('+5');
    await page.evaluate(() => {
      const key = (): KeyboardEvent =>
        new KeyboardEvent('keydown', { key: 'F13', bubbles: true, cancelable: true });
      window.dispatchEvent(key());
      document.dispatchEvent(key());
      window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    // The press was not in the field, so it ended the entry like a press anywhere else.
    await expect.poll(() => startOf('aurora.mp4')).toBe(245);
    expect(errors).toEqual([]);
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

  test('tiles are worked from the keyboard, and applied once per click', async ({ page }) => {
    // Focus is what this is about: a file saved meanwhile must not have the dev server redraw the page.
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await sample(page);
    const effects = (): Promise<string[]> =>
      tandem(page, (t) => {
        const clips = Object.values(t.session.store.get().clips) as any[];
        return clips.find((c) => c.name === 'dusk.mp4').effects.map((e: any) => e.type);
      });
    const frame = (): Promise<number> => tandem(page, (t) => t.session.player.getFrame());
    const focused = (): Promise<string> =>
      page.evaluate(() => (document.activeElement as HTMLElement).innerText.trim());
    await tandem(page, (t) => {
      const clips = Object.values(t.session.store.get().clips) as any[];
      t.ui.getState().select([clips.find((c) => c.name === 'dusk.mp4').id]);
    });
    const before = await effects();
    await page.getByRole('tab', { name: 'Effects' }).click();
    const tiles = page.locator('.fx-grid .fx');
    await expect(tiles.first()).toBeVisible();
    const names = await tiles.allInnerTexts();
    const columns = await tiles.evaluateAll(
      (all) => all.filter((t) => t.getBoundingClientRect().top === all[0].getBoundingClientRect().top).length,
    );
    expect(columns).toBeGreaterThan(1);
    // Every name can be read in full: one too long for its column takes a second line.
    const cutShort = await tiles
      .locator('span')
      .evaluateAll((all) => all.filter((s) => s.scrollHeight > s.clientHeight + 1).map((s) => s.textContent));
    expect(cutShort).toEqual([]);

    // Tab stops at the grid once; the arrow keys, Home and End move between its tiles and leave
    // the playhead where it is.
    const at = await frame();
    await page.locator('.chips .chip').last().focus();
    await page.keyboard.press('Tab');
    expect(await focused()).toBe(names[0]);
    await page.keyboard.press('ArrowRight');
    expect(await focused()).toBe(names[1]);
    await page.keyboard.press('ArrowDown');
    expect(await focused()).toBe(names[1 + columns]);
    await page.keyboard.press('ArrowLeft');
    expect(await focused()).toBe(names[columns]);
    await page.keyboard.press('ArrowUp');
    expect(await focused()).toBe(names[0]);
    await page.keyboard.press('End');
    expect(await focused()).toBe(names[names.length - 1]);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    expect(await frame()).toBe(at);
    // Tab leaves the grid; coming back, it is on the tile it was left on.
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.chips .chip').last()).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await focused()).toBe(names[1]);
    await expect(tiles.nth(1).locator('.fx__thumb')).not.toHaveCSS('box-shadow', 'none');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement!.closest('.fx-grid'))).toBe(false);

    // Enter applies the tile that has the keyboard, to the selected clip.
    await page.getByLabel('Search effects').fill('gaussian');
    await expect(tiles).toHaveCount(1);
    await page.locator('.chips .chip').last().focus();
    await page.keyboard.press('Tab');
    expect(await focused()).toBe('Gaussian Blur');
    await page.keyboard.press('Enter');
    await expect.poll(effects).toEqual([...before, 'gaussianBlur']);

    // A click of the pointer applies it once, and so does a double-click.
    await page.getByLabel('Search effects').fill('');
    const invert = page.locator('.fx-grid .fx', { hasText: 'Invert' });
    await invert.click();
    await expect.poll(effects).toEqual([...before, 'gaussianBlur', 'invert']);
    // After a click the arrow keys are the transport's again, though the tile still has the focus.
    await page.keyboard.press('ArrowRight');
    expect(await frame()).toBe(at + 1);
    expect(await focused()).toBe('Invert');
    await page.locator('.fx-grid .fx', { hasText: 'Vignette' }).dblclick();
    await expect.poll(effects).toEqual([...before, 'gaussianBlur', 'invert', 'vignette']);
    await page.waitForTimeout(700);
    expect(await effects()).toEqual([...before, 'gaussianBlur', 'invert', 'vignette']);

    // A card of the media pool opens in the source monitor on Enter, as it does on a double-click.
    await page.getByRole('tab', { name: 'Media' }).click();
    await page.locator('.chips .chip').last().focus();
    await page.keyboard.press('Tab');
    const first = page.locator('.asset').first();
    await expect(first).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const second = page.locator('.asset').nth(1);
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    const shown = (): Promise<string | null> => tandem(page, (t) => t.ui.getState().sourceAsset);
    expect(await shown()).toBe(await second.getAttribute('data-asset'));
    expect(await shown()).toBeTruthy();

    // The open monitor steps through its clip with the same keys. With the focus ring on a card
    // they still move between the cards, all of them, and the monitor keeps the clip it shows.
    const cards = page.locator('.asset');
    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(second).toBeFocused();
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
    await page.keyboard.press('End');
    await expect(cards.last()).toBeFocused();
    expect(await shown()).toBe(await second.getAttribute('data-asset'));
    // A card the pointer chose leaves them to the monitor, and Escape closes it either way.
    const clip = page.locator('.source video');
    const source = (): Promise<{ time: number; paused: boolean }> =>
      clip.evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, paused: v.paused }));
    await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    await second.click();
    await page.keyboard.press('Home');
    await expect.poll(source).toEqual({ time: 0, paused: true });
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await source()).time).toBeGreaterThan(0);
    await expect(second).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await shown()).toBeNull();
  });

  test('files are selected in the pool and go to the timeline together', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await localProject(page);
    await importFixtures(page, ['testsrc.mp4', 'red.webm', 'green.png', 'tone.ogg']);
    const cards = page.locator('.asset');
    await expect(cards).toHaveCount(4);
    const names = await cards.evaluateAll((all) => all.map((c) => c.getAttribute('aria-label')!));
    const card = (i: number) => page.locator('.asset', { hasText: names[i] });
    const selected = () =>
      cards.evaluateAll((all) =>
        all
          .filter((c) => c.getAttribute('aria-selected') === 'true')
          .map((c) => c.getAttribute('aria-label')),
      );
    /** Every clip as `name@start+duration`, in the order they stand on the timeline. */
    const cut = (): Promise<string[]> =>
      tandem(page, (t) =>
        (Object.values(t.session.store.get().clips) as any[])
          .sort((a, b) => a.start - b.start || a.type.localeCompare(b.type))
          .map((c) => `${c.name}@${c.start}+${c.duration}`),
      );
    await expect(page.getByRole('grid', { name: 'Media' })).toHaveAttribute('aria-multiselectable', 'true');

    // A press selects, Shift takes the run up to it, Ctrl takes one out or puts one in.
    await card(0).click();
    expect(await selected()).toEqual([names[0]]);
    await card(2).click({ modifiers: ['Shift'] });
    expect(await selected()).toEqual(names.slice(0, 3));
    await card(1).click({ modifiers: ['ControlOrMeta'] });
    expect(await selected()).toEqual([names[0], names[2]]);
    await card(1).click({ modifiers: ['ControlOrMeta'] });
    // Ctrl+A with a card in hand is every file shown, and the clips of the timeline are not touched.
    await page.keyboard.press('ControlOrMeta+a');
    expect(await selected()).toEqual(names);
    expect(await tandem(page, (t) => t.ui.getState().selection)).toEqual([]);
    // A press beside the cards lets go; a double-click still opens the file, and selects it.
    const grid = await box(page.locator('.pool__grid'));
    await page.mouse.click(grid.x + grid.width / 2, grid.y + grid.height - 6);
    expect(await selected()).toEqual([]);
    await card(3).dblclick();
    expect(await tandem(page, (t) => t.ui.getState().sourceAsset)).toBe(
      await card(3).getAttribute('data-asset'),
    );
    await page.keyboard.press('Escape');
    expect(await selected()).toEqual([names[3]]);

    // Three files, one drag: they land end to end where the first is dropped, as one undo step.
    await card(0).click();
    await card(2).click({ modifiers: ['Shift'] });
    const steps = await undoSteps(page);
    const from = await box(card(1));
    const lane = await box(page.locator('.lane').nth(1));
    await page.mouse.move(from.x + from.width / 2, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 30, from.y + 60, { steps: 4 });
    await expect(page.locator('.drag-ghost')).toHaveText('3 files');
    await page.mouse.move(lane.x + 200, lane.y + lane.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await cut()).length).toBeGreaterThanOrEqual(3);
    const placed = (await tandem(page, (t) => Object.values(t.session.store.get().clips))) as any[];
    const order = names.slice(0, 3).map((name) => placed.filter((c) => c.name === name));
    expect(order.every((clips) => clips.length >= 1)).toBe(true);
    // Each begins where the one picked before it ends.
    for (let i = 1; i < 3; i++)
      expect(order[i][0].start).toBe(order[i - 1][0].start + order[i - 1][0].duration);
    expect(await undoSteps(page)).toBe(steps + 1);
    expect((await tandem(page, (t) => t.ui.getState().selection)).length).toBe(placed.length);
    await tandem(page, (t) => t.cmd.undo());
    expect(await cut()).toEqual([]);

    // The + of a selected card adds all of them at the playhead; that of another card only its own.
    await card(0).hover();
    const add = card(0).locator('.asset__add');
    await expect(add).toHaveAccessibleName('Add 3 selected files to timeline');
    await add.click();
    const added = (await tandem(page, (t) => Object.values(t.session.store.get().clips))) as any[];
    expect(new Set(added.map((c) => c.name))).toEqual(new Set(names.slice(0, 3)));
    expect(Math.min(...added.map((c) => c.start))).toBe(0);
    expect(await undoSteps(page)).toBe(steps + 1);
    await tandem(page, (t) => t.cmd.undo());
    await card(3).hover();
    await expect(card(3).locator('.asset__add')).toHaveAccessibleName(`Add ${names[3]} to timeline`);

    // The menu is about the selection, and asks before it removes several files.
    await card(1).click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['Add 3 files to timeline', 'Remove 3 files…']);
    await answer(page, () => page.getByRole('menuitem', { name: 'Remove 3 files…' }).click(), 'Remove');
    await expect(cards).toHaveCount(1);
    expect(await tandem(page, (t) => t.ui.getState().poolSelection)).toEqual([]);
    // Asked for on a card outside the selection, it is that card's own menu.
    await tandem(page, (t) => t.cmd.undo());
    await expect(cards).toHaveCount(4);
    await card(0).click();
    await card(3).click({ button: 'right' });
    expect(await selected()).toEqual([names[3]]);
    await expect(page.getByRole('menuitem', { name: 'Open in source monitor' })).toBeVisible();
    await page.keyboard.press('Escape');

    // From the keyboard: Space takes the card with the focus ring into the selection or out of it.
    await page.locator('.chips .chip').last().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Home');
    await expect(card(0)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    expect(await selected()).toEqual([names[1], names[3]]);
    await page.keyboard.press('Space');
    expect(await selected()).toEqual([names[3]]);
    expect(await tandem(page, (t) => t.session.player.getState().playing)).toBe(false);
  });

  test('a selection replaces nothing on the timeline, and Delete with a card in hand is about the files', async ({
    page,
  }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await localProject(page);
    await importFixtures(page, ['testsrc.mp4', 'red.webm', 'green.png', 'warm.cube']);
    const cards = page.locator('.asset');
    await expect(cards).toHaveCount(4);
    const card = (name: string) => page.locator(`.asset[aria-label="${name}"]`);
    const add = (name: string) => card(name).locator('.asset__add');
    const clips = (): Promise<any[]> =>
      tandem(page, (t) =>
        (Object.values(t.session.store.get().clips) as any[])
          .map(({ id, name, type, trackId, start, duration }) => ({
            id,
            name,
            type,
            trackId,
            start,
            duration,
          }))
          .sort((a, b) => a.start - b.start || a.type.localeCompare(b.type)),
      );
    const selectClips = () =>
      tandem(page, (t) => t.ui.getState().select(Object.keys(t.session.store.get().clips)));
    // A clip and its sound stand further along the first tracks, and the playhead in front of them.
    await tandem(page, (t) => {
      const file = Object.values(t.session.store.get().assets).find((a: any) => a.name === 'testsrc.mp4');
      t.cmd.addAsset(file, { frame: 200 });
      t.cmd.seek(0);
      t.ui.getState().select([]);
    });
    const there = await clips();
    expect(there.map((c) => `${c.type}@${c.start}+${c.duration}`)).toEqual([
      'audio@200+120',
      'video@200+120',
    ]);
    const kept = async () => (await clips()).filter((c) => there.some((o) => o.id === c.id));

    // Three files are added at the playhead. The first alone would fit in front of the clip that
    // is there; together they take a track that has room for all of them, and nothing is cut.
    await card('red.webm').click();
    await card('green.png').click({ modifiers: ['ControlOrMeta'] });
    await card('testsrc.mp4').click({ modifiers: ['ControlOrMeta'] });
    const steps = await undoSteps(page);
    await card('red.webm').hover();
    await add('red.webm').click();
    await expect.poll(async () => (await clips()).length).toBe(6);
    expect(await kept()).toEqual(there);
    const pictures = (await clips()).filter((c) => c.type !== 'audio' && !there.some((o) => o.id === c.id));
    expect(pictures.map((c) => `${c.name}@${c.start}+${c.duration}`)).toEqual([
      'red.webm@0+60',
      'green.png@60+150',
      'testsrc.mp4@210+120',
    ]);
    expect(new Set(pictures.map((c) => c.trackId)).size).toBe(1);
    expect(await undoSteps(page)).toBe(steps + 1);
    await tandem(page, (t) => {
      t.cmd.undo();
      t.cmd.seek(0);
    });
    expect(await clips()).toEqual(there);

    // A LUT among the selected files does not become a clip, and is not counted as one that does.
    await card('warm.cube').click();
    await card('red.webm').click({ modifiers: ['ControlOrMeta'] });
    await card('red.webm').hover();
    await expect(add('red.webm')).toHaveAccessibleName('Add red.webm to timeline');
    await card('green.png').click({ modifiers: ['ControlOrMeta'] });
    await card('red.webm').hover();
    await expect(add('red.webm')).toHaveAccessibleName('Add 2 selected files to timeline');
    await card('green.png').click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['Add 2 files to timeline', 'Remove 3 files…']);
    await page.keyboard.press('Escape');
    // Dragged by one of the others, they go to the timeline without it. The first lands where it
    // is dropped. The next would reach into the clip further along that track, and goes to one
    // that has room for it.
    const from = await box(card('red.webm'));
    const lane = await box(page.locator('.lane').nth(1));
    await page.mouse.move(from.x + from.width / 2, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 30, from.y + 60, { steps: 4 });
    await expect(page.locator('.drag-ghost')).toHaveText('2 files');
    await page.mouse.move(lane.x + 12, lane.y + lane.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await clips()).length).toBe(4);
    expect(await kept()).toEqual(there);
    const dropped = await clips();
    const red = dropped.find((c) => c.name === 'red.webm');
    const green = dropped.find((c) => c.name === 'green.png');
    expect(red.trackId).toBe(there.find((c) => c.type === 'video').trackId);
    expect(green.start).toBe(red.start + red.duration);
    expect(green.trackId).not.toBe(red.trackId);
    expect(await undoSteps(page)).toBe(steps + 1);

    // The file that is open in the source monitor has its card selected, and Delete there is
    // about neither: the file stays, and so do the clips.
    await selectClips();
    await card('red.webm').dblclick();
    await expect(page.locator('.source')).toBeVisible();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(cards).toHaveCount(4);
    expect(await clips()).toHaveLength(4);
    await page.keyboard.press('Escape');
    await expect(page.locator('.source')).toHaveCount(0);
    // With a card in hand Delete is about the files: the clips selected in the timeline stay.
    await card('warm.cube').click();
    await page.keyboard.press('Delete');
    await expect(cards).toHaveCount(3);
    expect(await clips()).toHaveLength(4);
    // A file that is used takes its clips along, and that is asked about first.
    await card('testsrc.mp4').click();
    await page.keyboard.press('Backspace');
    const ask = page.getByRole('dialog');
    await expect(ask).toContainText('Remove testsrc.mp4 from the project?');
    await ask.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(cards).toHaveCount(2);
    expect((await clips()).map((c) => c.name)).toEqual(['red.webm', 'green.png']);
    // A card that was taken out of the selection again has nothing to show for itself, and leaves
    // the key to the clips.
    await card('green.png').click();
    await card('green.png').click({ modifiers: ['ControlOrMeta'] });
    expect(await tandem(page, (t) => t.ui.getState().poolSelection)).toEqual([]);
    await selectClips();
    await page.keyboard.press('Delete');
    expect(await clips()).toEqual([]);
    await expect(cards).toHaveCount(2);
    // From the keyboard the card with the focus ring goes, and the ring moves to the one that
    // takes its place, or out of a pool that has none left.
    await page.locator('.chips .chip').last().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Home');
    await expect(cards.first()).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(cards).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import media' })).toBeFocused();
  });

  test('effects and transitions are found by either spelling of their names', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await localProject(page);
    await page.getByRole('tab', { name: 'Effects' }).click();
    const tiles = page.locator('.fx-grid .fx');
    const search = page.getByLabel('Search effects');
    await search.fill('color');
    await expect(tiles.filter({ hasText: 'Colour Overlay' })).toHaveCount(1);
    await search.fill('posterize');
    await expect(tiles).toHaveText(['Posterise']);
    // Half a word is still looked for as it was typed.
    await search.fill('colou');
    await expect(tiles.filter({ hasText: 'Colour Overlay' })).toHaveCount(1);
    await search.fill('posteriz');
    await expect(tiles).toHaveText(['Posterise']);
    await page.getByRole('tab', { name: 'Transitions' }).click();
    await page.getByLabel('Search transitions').fill('pixelize');
    await expect(tiles).toHaveText(['Pixelise']);
  });

  test('only a file that has just come in arrives; the pool shown again is simply there', async ({
    page,
  }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await sample(page);
    // The sample's own files have just come in, and the last of their cards may still be arriving
    // when its clips are on the timeline. What is watched for begins once they have arrived.
    await expect(page.locator('.asset')).toHaveCount(4);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.asset')).every((card) => card.getAnimations().length === 0),
    );
    await page.evaluate(() => {
      const started: string[] = ((window as any).started = []);
      document.addEventListener(
        'animationstart',
        (e) => {
          if ((e.target as Element).closest('.asset, .scope, .tabs')) started.push(e.animationName);
        },
        true,
      );
    });
    const started = (): Promise<string[]> => page.evaluate(() => (window as any).started.splice(0));
    // Another tab and back, another workspace and back, a filter and back: nothing arrives.
    await page.getByRole('tab', { name: 'Effects' }).click();
    await page.getByRole('tab', { name: 'Media' }).click();
    await expect(page.locator('.asset')).toHaveCount(4);
    await setUI(page, { workspace: 'audio' });
    await setUI(page, { workspace: 'edit' });
    await page.locator('.chips .chip', { hasText: 'Audio' }).click();
    await expect(page.locator('.asset')).toHaveCount(1);
    await page.locator('.chips .chip', { hasText: 'All' }).click();
    await expect(page.locator('.asset')).toHaveCount(4);
    await page.waitForTimeout(300);
    expect(await started()).toEqual([]);
    // A file that is imported does, once, and briefly.
    await importFixtures(page, ['green.png']);
    const card = page.locator('.asset', { hasText: 'green.png' });
    await expect(card).toHaveAttribute('data-added', 'true');
    await expect.poll(started).toEqual(['pop-in']);
    expect(
      await card.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration)),
    ).toBeLessThanOrEqual(0.2);
    await page.locator('.chips .chip', { hasText: 'Audio' }).click();
    await page.locator('.chips .chip', { hasText: 'All' }).click();
    await expect(card).toBeVisible();
    await page.waitForTimeout(300);
    expect(await started()).toEqual([]);
    // The underline of the tabs and the scopes move within the time the rest of the interface takes.
    const ink = page.locator('.lib__tabs .tabs__ink');
    expect(
      await ink.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration)),
    ).toBeLessThanOrEqual(0.2);
    await setUI(page, { workspace: 'color' });
    const scope = page.locator('.scope').first();
    expect(
      await scope.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration)),
    ).toBeLessThanOrEqual(0.2);
  });

  test('the tabs are stepped through with the arrow keys and name their panel', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await localProject(page);
    const tabs = page.locator('.lib__tabs [role="tab"]');
    await expect(panel(page, 'Library').getByRole('tabpanel')).toHaveAccessibleName('Media');
    // One stop for Tab: the open tab. From there the arrows open the others.
    await page.getByLabel('Project name').focus();
    for (let i = 0; i < 12 && !(await tabs.first().evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press('Tab');
    await expect(tabs.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page, 'Library').getByRole('tabpanel')).toHaveAccessibleName('Titles');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement!.closest('[role="tabpanel"]'))).toBe(true);
  });

  test('a tile on its way to the timeline leaves the tiles it passes alone', async ({ page }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await sample(page);
    await page.getByRole('tab', { name: 'Effects' }).click();
    const tiles = page.locator('.fx-grid .fx');
    await expect(tiles.first()).toBeVisible();
    const from = await box(tiles.nth(0));
    const over = await box(tiles.nth(1));
    const hovered = () => tiles.nth(1).evaluate((el) => el.matches(':hover'));
    const tooltip = page.getByRole('tooltip');

    // At rest, a tile under the pointer says what it does.
    await page.mouse.move(over.x + over.width / 2, over.y + 20);
    await expect(tooltip).toBeVisible();
    expect(await hovered()).toBe(true);

    // Under a drag it neither rises nor speaks, however long the pointer stays on it.
    await page.mouse.move(from.x + from.width / 2, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(over.x + over.width / 2, over.y + 20, { steps: 6 });
    await expect(page.locator('.drag-ghost')).toBeVisible();
    await page.waitForTimeout(700);
    await expect(tooltip).toHaveCount(0);
    expect(await hovered()).toBe(false);

    // Let go over the library: nothing is dropped, and the tiles answer the pointer again.
    await page.mouse.up();
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await page.mouse.move(over.x + over.width / 2 + 2, over.y + 22);
    await expect(tooltip).toBeVisible();
    expect(await hovered()).toBe(true);
  });

  test('a file that is HDR and has a proxy shows both badges, readable over bright footage', async ({
    page,
  }) => {
    await sample(page);
    const id = await tandem(page, (t) => {
      const assets = Object.values(t.session.store.get().assets) as any[];
      const asset = assets.find((a) => a.name === 'fractal.mp4');
      t.session.store.commit([{ op: 'updateAsset', id: asset.id, patch: { hdr: true } }]);
      // Only what the card reports is looked at here, so the proxy is announced, not made.
      t.session.media.patch(asset.id, { proxy: true });
      return asset.id as string;
    });
    const card = page.locator(`.asset[data-asset="${id}"]`);
    const hdr = await box(card.locator('.asset__hdr'));
    const proxy = await box(card.locator('.asset__proxy'));
    const duration = await box(card.locator('.asset__dur'));
    expect(proxy.x).toBeGreaterThanOrEqual(hdr.x + hdr.width + 4);
    expect(duration.x).toBeGreaterThanOrEqual(proxy.x + proxy.width);
    expect(Math.round(proxy.y + proxy.height)).toBe(Math.round(hdr.y + hdr.height));

    // Whatever lies on the picture keeps its contrast when the picture is white.
    for (const label of ['.asset__hdr', '.asset__dur']) {
      const ratio = await card.locator(label).evaluate((el) => {
        const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const luminance = (...layers: string[]): number => {
          for (const layer of layers) {
            paint.fillStyle = layer;
            paint.fillRect(0, 0, 1, 1);
          }
          const [r, g, b] = Array.from(paint.getImageData(0, 0, 1, 1).data.slice(0, 3), (v) =>
            v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4,
          );
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const style = getComputedStyle(el);
        const ink = luminance('#fff', style.color);
        const ground = luminance('#fff', style.backgroundColor);
        return (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05);
      });
      expect(ratio, label).toBeGreaterThanOrEqual(4.5);
    }
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
      'Colour Overlay',
      'Outline',
      'Drop Shadow',
    ];
    for (const name of names)
      await expect.poll(() => picture(page, name), { timeout: 30_000 }).not.toBe(blank);
    const pictures = await Promise.all(names.map((name) => picture(page, name)));
    expect(new Set(pictures).size).toBe(names.length);

    // An overlay tints the picture instead of hiding it, and an outline is a thin line round a layer.
    expect(await whiteShare(page, 'Colour Overlay')).toBeLessThan(0.2);
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
    // Nothing is said again, but the status does not pass the project off as a local one.
    await expect(page.locator('.conn')).toHaveText('Not syncing: link refused');
    await page.waitForTimeout(1500);
    expect(await toastsWith(page, 'no longer accepts')).toBe(0);
    expect(asked).toBe(1);
    expect(await clipTypes(page)).toEqual(['text']);
  });

  test('a refused link to a project that is not on this device takes its card away', async ({ page }) => {
    // Three projects known by their links only: nothing of them was ever stored here.
    const linked = (id: string, name: string) => ({
      id,
      name,
      createdAt: 1,
      updatedAt: 1,
      token: `link-to-${id}`,
      role: 'editor',
      thumb: null,
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 0,
    });
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true } }));
    // The server has deleted one, is too busy to say anything about the next, and the request
    // about the third never arrives.
    await page.route('**/api/projects/deleted01', (route) =>
      route.fulfill({ status: 404, json: { error: 'No such project' } }),
    );
    await page.route('**/api/projects/crowded01', (route) =>
      route.fulfill({ status: 503, json: { error: 'Busy' } }),
    );
    await page.route('**/api/projects/unreached1', (route) => route.abort('connectionreset'));
    await page.goto('/#/');
    await page.evaluate(
      (list) => localStorage.setItem('tandem.projects.v1', JSON.stringify(list)),
      [linked('deleted01', 'Deleted'), linked('crowded01', 'Crowded'), linked('unreached1', 'Unreached')],
    );
    await page.reload();
    await expect(page.locator('.pcard')).toHaveCount(3);
    const ids = async () => (await registry(page)).map((p) => p.id).sort();
    const notAvailable = page.locator('.splash', { hasText: 'This project is not available' });
    const removed = 'It has been removed from your projects.';

    // No answer and no room are not a refusal: the card stays for another day.
    for (const name of ['Unreached', 'Crowded']) {
      await page.locator('.pcard__open', { hasText: name }).click();
      await expect(notAvailable).toBeVisible();
      await expect(notAvailable).not.toContainText(removed);
      expect(await ids()).toEqual(['crowded01', 'deleted01', 'unreached1']);
      await notAvailable.getByRole('button', { name: 'Back to projects' }).click();
      await expect(page.locator('.pcard')).toHaveCount(3);
    }

    // Such a project can be tried again from where it failed: every opening asks the server anew.
    let asked = 0;
    await page.route('**/api/projects/crowded01', (route) => {
      asked++;
      return route.fulfill({ status: 503, json: { error: 'Busy' } });
    });
    await page.locator('.pcard__open', { hasText: 'Crowded' }).click();
    await expect(notAvailable).toBeVisible();
    const first = asked;
    expect(first).toBeGreaterThan(0);
    await notAvailable.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => asked).toBeGreaterThan(first);
    await expect(notAvailable).toBeVisible();
    expect(await ids()).toEqual(['crowded01', 'deleted01', 'unreached1']);
    await notAvailable.getByRole('button', { name: 'Back to projects' }).click();
    await expect(page.locator('.pcard')).toHaveCount(3);

    // A refusal is final: the screen says what became of the card, and it is gone from the list.
    await page.locator('.pcard__open', { hasText: 'Deleted' }).click();
    await expect(notAvailable).toContainText(removed);
    // There is nothing left to try: the card is gone.
    await expect(notAvailable.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    expect(await ids()).toEqual(['crowded01', 'unreached1']);
    await notAvailable.getByRole('button', { name: 'Back to projects' }).click();
    await expect(page.locator('.pcard')).toHaveCount(2);
    expect((await page.locator('.pcard__name').allInnerTexts()).sort()).toEqual(['Crowded', 'Unreached']);
    // Closing the project wrote nothing back.
    await page.waitForTimeout(2000);
    expect(await ids()).toEqual(['crowded01', 'unreached1']);
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

  test('someone who may not edit is told which access they do have', async ({ page, browser }) => {
    await sharedProject(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));
    await importFixtures(page, ['green.png']);
    await expect(page.locator('.conn')).toContainText('All changes synced');
    for (const role of ['commenter', 'viewer']) {
      const link: string = await page.evaluate(
        (role) => (window as any).tandem.session.inviteLink(role),
        role,
      );
      const context = await browser.newContext();
      const guest = await context.newPage();
      await guest.goto(link);
      await guest.waitForFunction(
        () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 1,
      );
      expect(await tandem(guest, (t) => t.session.getMeta().role)).toBe(role);
      // The owner sees who has come in, and with which access.
      await page.locator('.avatars .avatar:not(.avatar--me)').hover();
      await expect(page.getByRole('tooltip')).toContainText(
        role === 'commenter' ? ' · can comment · ' : ' · can view · ',
      );
      await page.mouse.move(700, 300);
      await watchToasts(guest);
      // A key, and two commands that check the access for themselves.
      await guest.keyboard.press('t');
      await guest.evaluate(() => void (window as any).tandem.cmd.loadSample());
      await guest.evaluate(() => void (window as any).tandem.cmd.normalizeLoudness());
      const access = role === 'commenter' ? 'comment-only' : 'view-only';
      await expect.poll(() => toastsWith(guest, `You have ${access} access to this project.`)).toBe(3);
      // Nobody on a comment link is told they can only view, and nothing was edited.
      expect(await toastsWith(guest, ' access to this project.')).toBe(3);
      expect(await clipTypes(guest)).toEqual(['text']);

      // What may not be changed is out of reach, for the keyboard as for the pointer, and every
      // panel says why in the same words.
      const side = panel(guest, 'Inspector');
      const outOfReach = (selector: string): Promise<boolean> =>
        side
          .locator(selector)
          .evaluateAll((all) => all.length > 0 && all.every((el) => (el as HTMLElement).inert));
      await guest.evaluate(() => {
        const { session, ui } = (window as any).tandem;
        ui.getState().select(Object.keys(session.store.get().clips));
      });
      await expect(side.getByText('Read only')).toBeVisible();
      await expect(side.locator('.section__body').first()).toBeVisible();
      expect(await outOfReach('.section__body')).toBe(true);
      // A field in a section does not take the keyboard, so nothing can be typed to be thrown away.
      const taken = await side
        .locator('.section__body input')
        .first()
        .evaluate((el: HTMLElement) => {
          el.focus();
          return document.activeElement === el;
        });
      expect(taken).toBe(false);
      // A section can still be folded away and read again.
      const head = side.locator('.section__head').first();
      await head.click();
      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await head.click();
      await setUI(guest, { selection: [] });
      expect(await outOfReach('.form')).toBe(true);
      await setUI(guest, { workspace: 'color' });
      await expect(side.getByText('Read only')).toBeVisible();
      expect(await outOfReach('.color__scroll')).toBe(true);
      // The project's settings on the HDR tab are dimmed with the page they stand in, and not
      // once more for themselves: they are what a viewer may still read there.
      await side.getByRole('tab', { name: 'HDR' }).click();
      await expect(side.locator('.color__scroll .form')).toBeVisible();
      const dimmed = await side.locator('.color__scroll').evaluate((page) => {
        const within = (el: Element | null): number => {
          let opacity = 1;
          for (; el && el !== page.parentElement; el = el.parentElement)
            opacity *= Number(getComputedStyle(el).opacity);
          return opacity;
        };
        return [within(page.querySelector('.form .row__label')), within(page.querySelector('.color__note'))];
      });
      expect(dimmed[0]).toBe(dimmed[1]);
      expect(dimmed[0]).toBeLessThan(1);
      await setUI(guest, { workspace: 'audio' });
      await expect(side.getByText('Read only')).toBeVisible();
      expect(await outOfReach('.strip:not(.strip--master)')).toBe(true);
      await setUI(guest, { workspace: 'edit' });
      await expect(panel(guest, 'Library').locator('.asset__add')).toBeDisabled();
      expect(await toastsWith(guest, ' access to this project.')).toBe(3);
      await context.close();
    }
  });
});
