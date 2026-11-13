import { expect, test, type Locator, type Page } from '@playwright/test';
import { newProject } from './helpers';

/**
 * The building blocks every panel is made of: dialogs, menus, selects, fields, sliders, tooltips,
 * the command palette and the confirmation dialog, driven the way a person would, keyboard included.
 */

/** A project in this browser only, holding the bundled sample edit (the playhead is on frame 45). */
async function sample(page: Page): Promise<void> {
  // These tests never need the collaboration server, which limits projects per address and hour.
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });
}

/** React warnings and uncaught errors (a blocked health check and missing media are expected). */
function trackProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket/.test(m.text())) problems.push(m.text());
  });
  return problems;
}

const frame = (page: Page): Promise<number> =>
  page.evaluate(() => Math.round((window as any).tandem.session.player.getFrame()));

const undoSteps = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);

const uiState = (page: Page): Promise<{ dialog: string | null; snapping: boolean; tool: string }> =>
  page.evaluate(() => {
    const s = (window as any).tandem.ui.getState();
    return { dialog: s.dialog, snapping: s.snapping, tool: s.tool };
  });

/** The earliest clip of a type in the committed project. */
const clipOf = (page: Page, type: string): Promise<any> =>
  page.evaluate(
    (type) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === type)
        .sort((a, b) => a.start - b.start)[0],
    type,
  );

async function select(page: Page, type: string): Promise<void> {
  const clip = await clipOf(page, type);
  await page.evaluate((id) => (window as any).tandem.ui.getState().select([id]), clip.id);
  await expect(page.locator('[aria-label="Inspector"] .row').first()).toBeVisible();
}

const row = (page: Page, label: string): Locator =>
  page.locator('[aria-label="Inspector"] .row', { hasText: label }).first();

/** Where a select's open list is drawn. The timeline's lanes are lists of clips too: not those. */
const entries = (page: Page): Locator => page.locator('.popover');
const openList = (page: Page): Locator => entries(page).getByRole('listbox');

const focusIsIn = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((selector) => !!document.activeElement?.closest(selector), selector);

const rootInert = (page: Page): Promise<boolean> =>
  page.evaluate(() => (document.getElementById('root') as HTMLElement).inert);

/** Whether the focus ring is drawn around a control (it eases in on buttons). */
async function expectRing(control: Locator): Promise<void> {
  await expect
    .poll(() =>
      control.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.boxShadow = 'var(--ring)';
        document.body.appendChild(probe);
        const ring = getComputedStyle(probe).boxShadow;
        probe.remove();
        return getComputedStyle(el).boxShadow.includes(ring);
      }),
    )
    .toBe(true);
}

/**
 * Contrast of each element's text against what is painted behind it: every background from the
 * page down to the element, one over the other. Painted, a colour is three bytes however the
 * browser writes it out (a mixed one is not rgb()).
 */
const contrasts = (texts: Locator): Promise<number[]> =>
  texts.evaluateAll((elements) => {
    const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const luminance = () => {
      const [r, g, b] = Array.from(paint.getImageData(0, 0, 1, 1).data, (v) => linear(v / 255));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const cover = (colour: string) => {
      paint.fillStyle = colour;
      paint.fillRect(0, 0, 1, 1);
    };
    return elements.map((el) => {
      const layers: string[] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        layers.unshift(getComputedStyle(node).backgroundColor);
      }
      layers.forEach(cover);
      const behind = luminance();
      cover(getComputedStyle(el).color);
      const ink = luminance();
      return (Math.max(ink, behind) + 0.05) / (Math.min(ink, behind) + 0.05);
    });
  });

/**
 * Contrast of the line drawn round a control (its inset shadow, over its own fill) against what
 * is painted behind the control.
 */
const edgeContrast = (control: Locator): Promise<number> =>
  control.evaluate((el) => {
    const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const luminance = () => {
      const [r, g, b] = Array.from(paint.getImageData(0, 0, 1, 1).data, (v) => linear(v / 255));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const cover = (colour: string) => {
      paint.fillStyle = colour;
      paint.fillRect(0, 0, 1, 1);
    };
    const behind: string[] = [];
    for (let node = el.parentElement; node; node = node.parentElement) {
      behind.unshift(getComputedStyle(node).backgroundColor);
    }
    behind.forEach(cover);
    const around = luminance();
    const line = /rgba?\([^)]+\)(?= 0px 0px 0px 1px inset)/.exec(getComputedStyle(el).boxShadow);
    if (!line) return 0;
    cover(getComputedStyle(el).backgroundColor);
    cover(line[0]);
    const edge = luminance();
    return (Math.max(edge, around) + 0.05) / (Math.min(edge, around) + 0.05);
  });

/** Keys pressed on a control one straight after the other, with no time between them for a run of presses to end. */
const burst = (control: Locator, keys: string[]): Promise<void> =>
  control.evaluate((el, keys) => {
    for (const key of keys) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
  }, keys);

// A file saved while the suite runs makes the dev server reload the page under the test; its
// socket is left unanswered so that cannot happen.
test.beforeEach(async ({ context }) => {
  await context.routeWebSocket(/\/\?token=/, () => {});
});

test.describe('dialogs', () => {
  test('take focus, keep it, name themselves and give it back', async ({ page }) => {
    const problems = trackProblems(page);
    await sample(page);
    const opener = page.locator('.topbar .btn--primary');
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();

    // Focus is on a control of the dialog's content, and the page behind is out of reach.
    expect(await focusIsIn(page, '.dialog__body')).toBe(true);
    expect(await rootInert(page)).toBe(true);

    // Tab and Shift+Tab go round inside the dialog and visit more than one control.
    const stops = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      expect(await focusIsIn(page, '[role="dialog"]')).toBe(true);
      stops.add(await page.evaluate(() => document.activeElement!.outerHTML.slice(0, 120)));
    }
    expect(stops.size).toBeGreaterThan(5);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusIsIn(page, '[role="dialog"]')).toBe(true);
    }

    // The editor's shortcuts stay quiet behind it.
    const before = await frame(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    expect(await frame(page)).toBe(before);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await rootInert(page)).toBe(false);
    expect(problems).toEqual([]);
  });

  test('a select inside a dialog closes on its own, and a half-typed number is dropped first', async ({
    page,
  }) => {
    await sample(page);
    await page.keyboard.press('Control+e');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();

    const format = dialog.locator('.select').first();
    await format.focus();
    await page.keyboard.press('ArrowDown');
    await expect(openList(page)).toBeVisible();
    await expect(entries(page).getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(openList(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(format).toBeFocused();

    // Chosen from with the pointer, the select keeps focus all the same: it must not fall out of
    // the dialog. No shortcut is live here, so the arrow keys are the select's, and Tab goes on
    // from it.
    await format.click();
    await entries(page).getByRole('option', { selected: true }).click();
    await expect(openList(page)).toHaveCount(0);
    await expect(format).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entries(page).getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(format).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.select').nth(1)).toBeFocused();

    const number = dialog.locator('.num input').first();
    const shown = await number.inputValue();
    await number.click();
    await page.keyboard.type('99');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(number).toHaveValue(shown);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('show where the keyboard is on selects and buttons', async ({ page }) => {
    await sample(page);
    await page.keyboard.press('Control+e');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();

    // The ring is for someone moving through the controls by keyboard, as Tab does.
    await page.keyboard.press('Tab');
    for (const control of [
      dialog.locator('.select').first(),
      dialog.locator('.dialog__foot .btn--ghost'),
      dialog.locator('.dialog__foot .btn--primary'),
    ]) {
      await control.focus();
      await expectRing(control);
    }
    // Held Escape closes one thing: the list, and not the dialog under it as well.
    await dialog.locator('.select').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(openList(page)).toBeVisible();
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await expect(openList(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  test('content that only scrolls is scrolled, left and reached again with the keyboard', async ({
    page,
  }) => {
    await page.route('**/api/health', (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 640 });
    await newProject(page);
    await page.keyboard.press('Shift+?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const content = sheet.locator('.dialog__body');
    const close = sheet.getByRole('button', { name: 'Close' });
    const top = () => content.evaluate((el) => el.scrollTop);
    // The browser eases a scroll made with a key, and lets the next key go by when it arrives in
    // the instant that scroll settles: the keys below are pressed with the content at rest.
    const rest = async () => {
      let last = -1;
      await expect
        .poll(
          async () => {
            const before = last;
            last = await top();
            return last === before;
          },
          { intervals: [100] },
        )
        .toBe(true);
    };
    await expect(content).toBeFocused();
    expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((entrance) => entrance.finished)));

    await page.keyboard.press('ArrowDown');
    await expect.poll(top).toBeGreaterThan(0);
    await rest();
    await page.keyboard.press('End');
    await expect
      .poll(() => content.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(2);
    await rest();

    // Tab goes round between the close button and the content, in both directions.
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(content).toBeFocused();
    await page.keyboard.press('Home');
    await expect.poll(top).toBe(0);
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(content).toBeFocused();
  });

  test('content with nothing to press or to scroll holds the focus without a line round it', async ({
    page,
  }) => {
    await sample(page);
    // Without a server the Share dialog is a notice: no control in it, and nothing to scroll.
    await page.getByRole('button', { name: 'Selection tool' }).focus();
    await page.keyboard.press('Shift');
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ dialog: 'share' }));
    const content = page.getByRole('dialog', { name: 'Share project' }).locator('.dialog__body');
    await expect(content).toBeFocused();
    expect(
      await content.evaluate((el: HTMLElement) => [
        el.matches(':focus-visible'),
        el.tabIndex,
        getComputedStyle(el).boxShadow,
      ]),
    ).toEqual([true, -1, 'none']);
  });
});

test.describe('menus and selects', () => {
  test('a menu button toggles, and its menu works from the keyboard', async ({ page }) => {
    await sample(page);
    const button = page.getByRole('button', { name: 'Menu' });
    const menu = page.getByRole('menu');
    const items = page.getByRole('menuitem');

    // Pointer: the second press closes it again.
    await button.click();
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await button.click();
    await expect(menu).toHaveCount(0);

    // Keyboard: Enter opens it on the first entry; arrows, Home, End and typing move through it.
    await button.focus();
    const before = await frame(page);
    await page.keyboard.press('Enter');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
    await page.keyboard.type('key');
    await expect(page.getByRole('menuitem', { name: /^Keyboard shortcuts/ })).toBeFocused();
    // None of that reached the timeline (arrows, Home and End are transport keys there).
    expect(await frame(page)).toBe(before);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();

    // Choosing with Enter opens the dialog; closing that brings focus back to the menu button.
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.type('key');
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    expect(await focusIsIn(page, '[role="dialog"]')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('a select is chosen from with the keyboard, without moving the playhead', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    const blend = row(page, 'Blend mode').locator('.select');
    const list = openList(page);
    const before = await frame(page);

    await blend.focus();
    await page.keyboard.press('Enter');
    await expect(entries(page).getByRole('option', { name: 'Normal' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entries(page).getByRole('option', { selected: true })).not.toBeFocused();
    expect(await focusIsIn(page, '.popover [role="listbox"]')).toBe(true);
    await page.keyboard.type('scr');
    await expect(entries(page).getByRole('option', { name: 'Screen' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    expect((await clipOf(page, 'video')).blend).toBe('screen');
    await expect(blend).toBeFocused();
    expect(await frame(page)).toBe(before);

    // An arrow key opens it again on the current option; Tab closes it and stays on the control.
    await page.keyboard.press('ArrowDown');
    await expect(entries(page).getByRole('option', { name: 'Screen' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(list).toHaveCount(0);
    await expect(blend).toBeFocused();
    expect(await frame(page)).toBe(before);

    // Pointer: pressing the control again closes the list, and the entry under the pointer is the
    // highlighted one, so the arrow keys carry on from there.
    await blend.click();
    await expect(list).toBeVisible();
    await blend.click();
    await expect(list).toHaveCount(0);
    await blend.click();
    await entries(page).getByRole('option', { name: 'Multiply' }).hover();
    await expect(entries(page).getByRole('option', { name: 'Multiply' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    expect((await clipOf(page, 'video')).blend).toBe('screen');
  });

  test('after a choice made with the pointer the arrow keys are still the transport', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    const blend = row(page, 'Blend mode').locator('.select');
    const list = openList(page);
    const menu = page.getByRole('menu');

    await blend.click();
    await entries(page).getByRole('option', { name: 'Screen' }).click();
    await expect(list).toHaveCount(0);
    expect((await clipOf(page, 'video')).blend).toBe('screen');
    const steps = await undoSteps(page);

    // Down is "go to next edit" and Space plays: neither is taken for the select again.
    const playing = () => page.evaluate(() => (window as any).tandem.session.player.getState().playing);
    let at = await frame(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => frame(page)).toBeGreaterThan(at);
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(false);
    await expect(list).toHaveCount(0);

    // Opened and shut with the pointer the select has focus, and still leaves the arrows alone.
    await blend.click();
    await expect(list).toBeVisible();
    await blend.click();
    await expect(list).toHaveCount(0);
    await expect(blend).toBeFocused();
    at = await frame(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => frame(page)).toBeLessThan(at);
    await expect(list).toHaveCount(0);

    // So it does when the list it was pressed for is dismissed with Escape.
    await blend.click();
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(blend).toBeFocused();
    at = await frame(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => frame(page)).toBeGreaterThan(at);
    await expect(list).toHaveCount(0);

    // Once focus has been away and comes back by the keyboard, they are the select's.
    at = await frame(page);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(blend).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(entries(page).getByRole('option', { name: 'Screen' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(blend).toBeFocused();
    await expectRing(blend);
    expect(await frame(page)).toBe(at);

    // A menu button likewise, also when its entry opened a dialog that the pointer closed.
    await page.getByRole('button', { name: 'Viewer zoom' }).click();
    await page.getByRole('menuitem').first().click();
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => frame(page)).toBeGreaterThan(at);
    await expect(menu).toHaveCount(0);

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: /^Keyboard shortcuts/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
    at = await frame(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => frame(page)).toBeLessThan(at);
    await expect(menu).toHaveCount(0);

    expect((await clipOf(page, 'video')).blend).toBe('screen');
    expect(await undoSteps(page)).toBe(steps);
  });

  test('a key held down chooses once and opens nothing again', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    const blend = row(page, 'Blend mode').locator('.select');
    const list = openList(page);

    // Enter held on the select opens the list and leaves the choice to the next press.
    await blend.focus();
    await page.keyboard.down('Enter');
    await expect(entries(page).getByRole('option', { name: 'Normal' })).toBeFocused();
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await expect(list).toBeVisible();
    await page.keyboard.up('Enter');

    // Held on an option it chooses that one, and the list stays shut.
    await page.keyboard.press('ArrowDown');
    const chosen = await page.evaluate(() => document.activeElement!.textContent);
    await page.keyboard.down('Enter');
    await expect(list).toHaveCount(0);
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(list).toHaveCount(0);
    await expect(blend).toBeFocused();
    await expect(blend).toHaveText(chosen!);

    // Inside the list a held arrow key goes on stepping.
    await page.keyboard.press('Enter');
    await expect(entries(page).getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.down('ArrowDown');
    await page.keyboard.down('ArrowDown');
    await page.keyboard.down('ArrowDown');
    await page.keyboard.up('ArrowDown');
    await expect(entries(page).getByRole('option').nth(4)).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('a context menu and a popover of fields keep keys away from the editor', async ({ page }) => {
    await sample(page);
    const clips = await page.evaluate(
      () => Object.keys((window as any).tandem.session.store.get().clips).length,
    );

    await page.locator('.clip').first().click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    const before = await frame(page);
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('End');
    expect(await focusIsIn(page, '[role="menu"]')).toBe(true);
    expect(await frame(page)).toBe(before);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // The marker editor: its name field has the keyboard, Tab stays inside, and keys pressed on
    // its buttons act on the marker only.
    await page.locator('.marker').first().dblclick();
    const name = page.getByRole('textbox', { name: 'Marker name' });
    await expect(name).toBeFocused();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await focusIsIn(page, '.popover')).toBe(true);
    }
    const at = await frame(page);
    const colour = page.locator('.popover button[aria-label^="Colour"]').nth(3);
    await colour.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('s');
    const marker = await page.evaluate(
      () => (Object.values((window as any).tandem.session.store.get().markers) as any[])[0].color,
    );
    expect(marker).toBe(await colour.getAttribute('aria-label').then((l) => l!.replace('Colour ', '')));
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().playing)).toBe(false);
    expect(await frame(page)).toBe(at);
    expect(
      await page.evaluate(() => Object.keys((window as any).tandem.session.store.get().clips).length),
    ).toBe(clips);
    await page.keyboard.press('Escape');
    await expect(page.locator('.popover')).toHaveCount(0);
  });

  test('entries line up, the whole menu shows, and a long list keeps clear of its control', async ({
    page,
  }) => {
    await sample(page);
    const popover = page.locator('.popover');

    // Whether or not an entry has an icon, its label starts where the others do; and the menu is
    // on screen down to its last row, with nothing left to scroll to.
    await page.locator('.clip').first().click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    const lefts = await popover
      .locator('.menu-item__label')
      .evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().left)));
    expect(lefts.length).toBeGreaterThan(5);
    expect(new Set(lefts).size).toBe(1);
    expect(await popover.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
    const menu = (await popover.boundingBox())!;
    expect(menu.y).toBeGreaterThanOrEqual(0);
    expect(menu.y + menu.height).toBeLessThanOrEqual(900);
    await page.keyboard.press('Escape');

    // A list too long for either side of its control scrolls on the roomier one, with the chosen
    // option in view; it never lies over the control it belongs to.
    await select(page, 'video');
    const blend = row(page, 'Blend mode').locator('.select');
    await blend.scrollIntoViewIfNeeded();
    await blend.click();
    const chosen = entries(page).getByRole('option', { selected: true });
    await expect(chosen).toBeFocused();
    // Measured at rest: the list grows into place, and the readings are taken one after another.
    await popover.evaluate((el) => Promise.all(el.getAnimations().map((entrance) => entrance.finished)));
    const [control, list, option] = [
      (await blend.boundingBox())!,
      (await popover.boundingBox())!,
      (await chosen.boundingBox())!,
    ];
    expect(list.y >= control.y + control.height || list.y + list.height <= control.y).toBe(true);
    expect(list.y).toBeGreaterThanOrEqual(0);
    expect(list.y + list.height).toBeLessThanOrEqual(900);
    expect(option.y).toBeGreaterThanOrEqual(list.y);
    expect(option.y + option.height).toBeLessThanOrEqual(list.y + list.height);

    // The mark on the chosen option is the accent, the one colour a list has.
    const colours = await chosen.locator('.menu-item__check svg').evaluate((mark) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(mark).color, accent];
    });
    expect(colours[0]).toBe(colours[1]);
    await page.keyboard.press('Escape');
  });
});

test.describe('fields', () => {
  test('Escape drops what was typed into a number or colour field', async ({ page }) => {
    const problems = trackProblems(page);
    await sample(page);
    await select(page, 'video');
    const opacity = row(page, 'Opacity').locator('.num input');
    const steps = await undoSteps(page);

    await opacity.click();
    await page.keyboard.type('50');
    await page.keyboard.press('Escape');
    await expect(opacity).toHaveValue('100');
    await expect(opacity).not.toBeFocused();
    expect((await clipOf(page, 'video')).opacity).toBe(1);
    expect(await undoSteps(page)).toBe(steps);

    // Enter applies it, once.
    await opacity.click();
    await page.keyboard.type('50');
    await page.keyboard.press('Enter');
    expect((await clipOf(page, 'video')).opacity).toBe(0.5);
    expect(await undoSteps(page)).toBe(steps + 1);

    // So does leaving the field.
    await opacity.click();
    await page.keyboard.type('25');
    await page.keyboard.press('Tab');
    expect((await clipOf(page, 'video')).opacity).toBe(0.25);
    expect(await undoSteps(page)).toBe(steps + 2);

    await select(page, 'text');
    const hex = page.locator('[aria-label="Inspector"] input[aria-label="Hex colour"]').first();
    const colour = await hex.inputValue();
    const text = JSON.stringify((await clipOf(page, 'text')).text);
    await hex.click();
    await hex.fill('#123456');
    await page.keyboard.press('Escape');
    await expect(hex).toHaveValue(colour);
    expect(JSON.stringify((await clipOf(page, 'text')).text)).toBe(text);
    expect(await undoSteps(page)).toBe(steps + 2);
    expect(problems).toEqual([]);
  });

  test('one pick in the colour picker is one undo step', async ({ page }) => {
    const problems = trackProblems(page);
    await sample(page);
    await select(page, 'text');
    const picker = page.locator('[aria-label="Inspector"] input[type="color"]').first();
    await expect(picker).toBeAttached();
    const steps = await undoSteps(page);

    // What a browser sends while the pointer moves inside its picker, and once when it closes.
    const pick = (colours: string[]) =>
      picker.evaluate((el: HTMLInputElement, colours: string[]) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        for (const c of colours) {
          set.call(el, c);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, colours);

    await pick(['#ff0000', '#ff2200', '#ff4400', '#ff6600', '#ff8800']);
    await expect(page.locator('[aria-label="Inspector"] input[aria-label="Hex colour"]').first()).toHaveValue(
      '#FF8800',
    );
    expect(await undoSteps(page)).toBe(steps + 1);

    await pick(['#00ff00', '#00ff44']);
    expect(await undoSteps(page)).toBe(steps + 2);
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await expect(page.locator('[aria-label="Inspector"] input[aria-label="Hex colour"]').first()).toHaveValue(
      '#FF8800',
    );
    expect(problems).toEqual([]);
  });

  test('what is typed for one clip goes to that clip, whatever is clicked next', async ({ page }) => {
    const problems = trackProblems(page);
    await sample(page);
    const clipsOf = (type: string): Promise<any[]> =>
      page.evaluate(
        (type) =>
          (Object.values((window as any).tandem.session.store.get().clips) as any[])
            .filter((c) => c.type === type)
            .sort((a, b) => a.start - b.start),
        type,
      );
    const selection = () => page.evaluate(() => (window as any).tandem.ui.getState().selection);
    const pick = (id: string) => page.evaluate((id) => (window as any).tandem.ui.getState().select([id]), id);
    const width = await page.evaluate(() => (window as any).tandem.session.store.get().settings.width);
    const positions = async () => (await clipsOf('video')).map((c) => Math.round(c.x * width));
    const [first, second] = await clipsOf('video');
    const x = page.locator('[aria-label="Inspector"] input[aria-label="Position X"]');

    // The click selects the other clip before the field loses focus.
    await pick(first.id);
    const steps = await undoSteps(page);
    await x.click();
    await page.keyboard.type('123');
    await page.locator(`.clip[data-clip="${second.id}"]`).click();
    expect(await selection()).toEqual([second.id]);
    expect(await positions()).toEqual([123, 0, 0]);
    await expect(x).toHaveValue('0');
    expect(await undoSteps(page)).toBe(steps + 1);

    // A click on nothing takes the whole field away: the entry still counts.
    await x.click();
    await page.keyboard.type('-40');
    const lane = (await page.locator('.lane').nth(1).boundingBox())!;
    await page.mouse.click(lane.x + lane.width - 30, lane.y + lane.height / 2);
    expect(await selection()).toEqual([]);
    expect(await positions()).toEqual([123, -40, 0]);
    expect(await undoSteps(page)).toBe(steps + 2);

    // The same for a colour typed as hex.
    const title = (await clipsOf('text'))[0];
    await pick(title.id);
    await page.evaluate(() => (window as any).tandem.cmd.duplicate());
    const titles = await clipsOf('text');
    expect(titles).toHaveLength(2);
    await pick(titles[0].id);
    const hex = page.locator('[aria-label="Inspector"] input[aria-label="Hex colour"]').first();
    const shown = await hex.inputValue();
    await hex.click();
    await hex.fill('#123456');
    await page.locator(`.clip[data-clip="${titles[1].id}"]`).click();
    expect(await selection()).toEqual([titles[1].id]);
    expect((await clipsOf('text')).map((c) => c.text.color)).toEqual(['#123456', titles[1].text.color]);
    await expect(hex).toHaveValue(shown);
    expect(problems).toEqual([]);
  });

  test('what is typed lands on top of what changed meanwhile, and not on what is gone', async ({ page }) => {
    const problems = trackProblems(page);
    await sample(page);
    // A transition is written as a whole, so a field of it that wrote what it knew when the
    // typing began would take every other change made since back with it.
    const clipId: string = await page.evaluate(
      () =>
        (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
          (c) => c.transIn?.type === 'crossZoom',
        ).id,
    );
    const transition = (): Promise<any> =>
      page.evaluate((id) => (window as any).tandem.session.store.get().clips[id].transIn, clipId);
    const write = (transIn: unknown) =>
      page.evaluate(
        ([id, transIn]) =>
          (window as any).tandem.session.store.commit([{ op: 'updateClip', id, patch: { transIn } }]),
        [clipId, transIn] as const,
      );
    await page.evaluate(
      (clipId) =>
        (window as any).tandem.ui
          .getState()
          .set({ selection: [], selectedTransition: { clipId, side: 'in' } }),
      clipId,
    );
    const strength = row(page, 'Strength').locator('.num input');
    const duration = row(page, 'Duration').locator('.num input');
    const before = await transition();
    const steps = await undoSteps(page);

    // The press on the field beside it applies the entry; the drag that follows is a step of its
    // own and builds on it.
    await strength.click();
    await page.keyboard.type('1.5');
    const box = (await duration.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    expect(await transition()).toEqual({ ...before, params: { ...before.params, strength: 1.5 } });
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const scrubbed = await transition();
    expect(scrubbed.duration).toBeGreaterThan(before.duration);
    expect(scrubbed.params.strength).toBe(1.5);
    expect(await undoSteps(page)).toBe(steps + 2);

    // Someone else lengthens the transition while its strength is being typed. (A drag on a
    // number field does not take the keyboard, so the field still has it and its text is replaced.)
    await expect(strength).toBeFocused();
    await strength.fill('0.5');
    await write({ ...scrubbed, duration: scrubbed.duration + 4 });
    await page.keyboard.press('Enter');
    expect(await transition()).toEqual({
      ...scrubbed,
      duration: scrubbed.duration + 4,
      params: { ...scrubbed.params, strength: 0.5 },
    });

    // Someone else removes it: what was being typed for it must not bring it back.
    await strength.click();
    await page.keyboard.type('0.7');
    await write(null);
    await expect(strength).toHaveCount(0);
    const removed = await undoSteps(page);
    const lane = (await page.locator('.lane').nth(1).boundingBox())!;
    await page.mouse.click(lane.x + lane.width - 30, lane.y + lane.height / 2);
    expect(await transition()).toBeNull();
    expect(await undoSteps(page)).toBe(removed);
    expect(problems).toEqual([]);
  });
});

test.describe('names', () => {
  test('a row names its controls, and a select is read with what it is set to', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    // What it sets and what that is set to: the value alone says nothing, the label alone hides it.
    const blend = row(page, 'Blend mode').locator('.select');
    await expect(blend).toHaveAccessibleName('Blend mode Normal');
    await blend.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Blend mode' })).toBeVisible();
    await entries(page).getByRole('option', { name: 'Screen' }).click();
    await expect(blend).toHaveAccessibleName('Blend mode Screen');

    // Only the words of the label: the keyframe button beside them has a name of its own.
    await expect(row(page, 'Opacity').getByRole('slider')).toHaveAccessibleName('Opacity');
    await expect(row(page, 'Opacity').getByRole('textbox')).toHaveAccessibleName('Opacity');

    await select(page, 'text');
    await expect(row(page, 'Line height').getByRole('textbox')).toHaveAccessibleName('Line height');
    await expect(row(page, 'Line height').getByRole('slider')).toHaveAccessibleName('Line height');
    // Segments that are icons take the name their tooltip gives, and the row names the group.
    const align = row(page, 'Align');
    await expect(align.getByRole('group')).toHaveAccessibleName('Align');
    for (const name of ['Align left', 'Align centre', 'Align right']) {
      await expect(align.getByRole('button', { name, exact: true })).toBeVisible();
    }
    // Two colours in one panel are told apart by their rows.
    await expect(row(page, 'Colour').locator('input.mono')).toHaveAccessibleName('Colour Hex colour');
    await expect(row(page, 'Colour').locator('input[type="color"]')).toHaveAccessibleName(
      'Colour Pick colour',
    );
  });

  test('the rows of the new-project form name theirs, in the words the project settings use', async ({
    page,
  }) => {
    await page.route('**/api/health', (route) => route.abort());
    await page.goto('/');
    // One way of writing a frame size and a frame rate, on the starters as everywhere else.
    await expect(page.locator('.starter__hint').first()).toHaveText('1920×1080 · 30 fps');
    await page.getByRole('button', { name: 'Custom project…' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    const resolution = dialog.getByRole('button', { name: 'Resolution Full HD 1080p · 1920×1080' });
    await expect(resolution).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Size W' })).toHaveValue('1920');
    await expect(dialog.getByRole('textbox', { name: 'Size H' })).toHaveValue('1080');
    await expect(dialog.getByRole('button', { name: 'Frame rate 30 fps' })).toBeVisible();
    const colour = dialog.getByRole('button', { name: 'Colour SDR · Rec.709' });
    await colour.click();
    const modes = await page.getByRole('listbox', { name: 'Colour' }).getByRole('option').allTextContents();
    expect(modes).toEqual(['SDR · Rec.709', 'HDR · Rec.2100 PQ', 'HDR · Rec.2100 HLG']);
    await page.keyboard.press('Escape');
    await resolution.click();
    const sizes = await page
      .getByRole('listbox', { name: 'Resolution' })
      .getByRole('option')
      .allTextContents();
    expect(sizes).toContain('4K UHD · 3840×2160');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Create project' }).click();

    // The same options in the project's settings, word for word, and the same size in the top bar.
    await expect(page.locator('.tl')).toBeVisible();
    const settings = page.locator('[aria-label="Inspector"]');
    await expect(settings.locator('.row', { hasText: 'Resolution' }).locator('.select')).toHaveText(
      'Full HD 1080p · 1920×1080',
    );
    await settings.locator('.row', { hasText: 'Colour' }).locator('.select').first().click();
    expect(await entries(page).getByRole('option').allTextContents()).toEqual(modes);
    await page.keyboard.press('Escape');
    await expect(page.locator('.topbar')).toContainText('1920×1080 · 30 fps');
  });

  test('an empty field and the chosen segment are told from their surroundings by a line that can be seen', async ({
    page,
  }) => {
    await sample(page);
    await select(page, 'text');
    // 3:1 is what an edge needs where the edge is all there is.
    const search = page.locator('[aria-label="Library"] .field').first();
    await expect(search.locator('input')).toHaveValue('');
    expect(await edgeContrast(search)).toBeGreaterThanOrEqual(3);
    expect(await edgeContrast(page.locator('.topbar .seg__thumb'))).toBeGreaterThanOrEqual(3);
    expect(await edgeContrast(row(page, 'Align').locator('.seg__thumb'))).toBeGreaterThanOrEqual(3);
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ commentsOpen: true }));
    const composer = page.locator('.composer textarea');
    expect(await edgeContrast(composer)).toBeGreaterThanOrEqual(3);
    // With the keyboard in it, an empty field still shows the accent like any other.
    const accented = (field: Locator) =>
      field.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent-line)';
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(el).boxShadow.includes(accent);
      });
    await composer.focus();
    await expect.poll(() => accented(composer)).toBe(true);
    await search.locator('input').focus();
    await expect.poll(() => accented(search)).toBe(true);
    // A field that holds something keeps the quiet line: what it holds says what it is.
    await search.locator('input').fill('dusk');
    await search.locator('input').blur();
    await expect.poll(() => edgeContrast(search)).toBeLessThan(3);
  });
});

test.describe('sliders', () => {
  test('double-click resets in one undo step, back to the value before it', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      session.store.commit([{ op: 'updateClip', id: ui.getState().selection[0], patch: { opacity: 0.25 } }]);
    });
    const slider = row(page, 'Opacity').locator('.slider');
    const box = (await slider.boundingBox())!;
    const steps = await undoSteps(page);

    await page.mouse.dblclick(box.x + box.width * 0.6, box.y + box.height / 2);
    expect((await clipOf(page, 'video')).opacity).toBe(1);
    expect(await undoSteps(page)).toBe(steps + 1);
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    expect((await clipOf(page, 'video')).opacity).toBe(0.25);

    // A single press still jumps to the pointer.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect((await clipOf(page, 'video')).opacity).toBeCloseTo(0.5, 1);
  });

  test('a press straight after a click still drags, as part of the same step', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    const slider = row(page, 'Opacity').locator('.slider');
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    const steps = await undoSteps(page);

    await page.mouse.click(box.x + box.width * 0.3, y);
    expect((await clipOf(page, 'video')).opacity).toBeCloseTo(0.3, 1);
    // A mouse reports this press as the second of a double-click, and the browser sends a
    // double-click when it is let go, however far it has travelled in between.
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(box.x + box.width * 0.3 + 2, y);
    expect((await clipOf(page, 'video')).opacity).toBeCloseTo(0.3, 1);
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 4 });
    expect((await clipOf(page, 'video')).opacity).toBeCloseTo(0.7, 1);
    await page.mouse.up({ clickCount: 2 });
    expect((await clipOf(page, 'video')).opacity).toBeCloseTo(0.7, 1);

    expect(await undoSteps(page)).toBe(steps + 1);
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    expect((await clipOf(page, 'video')).opacity).toBe(1);
  });

  test('the thumb stays inside the slider at both ends and follows the pointer', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    const slider = row(page, 'Opacity').locator('.slider');
    const thumb = slider.locator('.slider__thumb');
    const field = row(page, 'Opacity').locator('.num');
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;

    for (const [x, value] of [
      [box.x + 1, 0],
      [box.x + box.width - 1, 1],
    ]) {
      await page.mouse.click(x, y);
      expect((await clipOf(page, 'video')).opacity).toBe(value);
      await page.mouse.move(box.x + box.width / 2, box.y - 40);
      // The hover enlargement eases out before the thumb is measured.
      await expect
        .poll(async () => {
          const t = (await thumb.boundingBox())!;
          return t.x >= box.x - 0.5 && t.x + t.width <= box.x + box.width + 0.5;
        })
        .toBe(true);
      // Double-click protection must not swallow the next, deliberate press.
      await page.waitForTimeout(600);
    }
    const t = (await thumb.boundingBox())!;
    const f = (await field.boundingBox())!;
    expect(f.x - (t.x + t.width)).toBeGreaterThanOrEqual(5);

    // Dragging keeps the thumb's centre under the pointer.
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 4 });
    const dragged = (await thumb.boundingBox())!;
    await page.mouse.up();
    expect(Math.abs(dragged.x + dragged.width / 2 - (box.x + box.width * 0.7))).toBeLessThan(1.5);
  });

  test('work from the keyboard: arrows, Shift, the page keys, Home, End and Delete', async ({ page }) => {
    const problems = trackProblems(page);
    await sample(page);
    await select(page, 'video');
    const thumb = row(page, 'Opacity').getByRole('slider');
    const opacity = async () => (await clipOf(page, 'video')).opacity;
    await expect(thumb).toHaveAccessibleName('Opacity');
    await expect(thumb).toHaveAttribute('aria-valuemin', '0');
    await expect(thumb).toHaveAttribute('aria-valuemax', '1');
    await expect(thumb).toHaveAttribute('aria-valuenow', '1');

    // Tab reaches it from the control before it, and it shows where the keyboard is.
    await row(page, 'Opacity').locator('.kf').focus();
    await page.keyboard.press('Tab');
    await expect(thumb).toBeFocused();
    await expectRing(thumb);

    const at = await frame(page);
    const clips = await page.locator('.clip').count();
    for (const key of ['ArrowLeft', 'ArrowDown', 'Shift+ArrowLeft']) await page.keyboard.press(key);
    expect(await opacity()).toBeCloseTo(0.88, 6);
    for (const key of ['ArrowRight', 'ArrowUp']) await page.keyboard.press(key);
    expect(await opacity()).toBeCloseTo(0.9, 6);
    await expect(thumb).toHaveAttribute('aria-valuenow', '0.9');
    await page.keyboard.press('PageDown');
    expect(await opacity()).toBeCloseTo(0.8, 6);
    await page.keyboard.press('PageUp');
    expect(await opacity()).toBeCloseTo(0.9, 6);
    await page.keyboard.press('Home');
    expect(await opacity()).toBe(0);
    await page.keyboard.press('End');
    expect(await opacity()).toBe(1);
    await page.keyboard.press('Home');
    // Delete goes back to the default. It is the slider's key here, not the editor's: the selected
    // clip stays, and the arrows have not moved the playhead.
    await page.keyboard.press('Delete');
    expect(await opacity()).toBe(1);
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    expect(await opacity()).toBe(1);
    await expect(page.locator('.clip')).toHaveCount(clips);
    expect(await frame(page)).toBe(at);

    // With Ctrl the same keys are the editor's again (select the next clip).
    const selection = () => page.evaluate(() => (window as any).tandem.ui.getState().selection);
    const selected = await selection();
    await page.keyboard.press('Control+ArrowDown');
    expect(await selection()).not.toEqual(selected);
    expect(await opacity()).toBe(1);
    expect(problems).toEqual([]);
  });

  test('a run of key presses is one undo step, ended by a pause or by leaving the slider', async ({
    page,
  }) => {
    await sample(page);
    await select(page, 'video');
    const thumb = row(page, 'Opacity').getByRole('slider');
    const opacity = async () => (await clipOf(page, 'video')).opacity;
    await thumb.focus();
    const steps = await undoSteps(page);

    await burst(thumb, ['ArrowLeft', 'ArrowLeft', 'PageDown', 'ArrowLeft']);
    expect(await opacity()).toBeCloseTo(0.87, 6);
    expect(await undoSteps(page)).toBe(steps + 1);
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    expect(await opacity()).toBe(1);

    // The keys rest: the next press begins a new step.
    await burst(thumb, ['ArrowLeft']);
    await page.waitForTimeout(900);
    await burst(thumb, ['ArrowLeft', 'ArrowLeft']);
    expect(await opacity()).toBeCloseTo(0.97, 6);
    expect(await undoSteps(page)).toBe(steps + 2);
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    expect(await opacity()).toBeCloseTo(0.99, 6);

    // The keyboard goes elsewhere and comes back: the same.
    await page.waitForTimeout(900);
    const base = await undoSteps(page);
    await burst(thumb, ['ArrowLeft']);
    await thumb.evaluate((el: HTMLElement) => {
      el.blur();
      el.focus();
    });
    await burst(thumb, ['ArrowLeft']);
    expect(await undoSteps(page)).toBe(base + 2);
  });

  test('a slider whose values are coarser than its steps still moves', async ({ page }) => {
    await sample(page);
    // A fade is kept in whole frames. On a clip of one second a step of the keyboard is a third
    // of a frame: a press that rounds away must not leave the next one where it started.
    const sound = await clipOf(page, 'audio');
    await page.evaluate(
      (id) =>
        (window as any).tandem.session.store.commit([
          { op: 'updateClip', id, patch: { duration: 30, fadeIn: 15, fadeOut: 0 } },
        ]),
      sound.id,
    );
    await select(page, 'audio');
    const thumb = row(page, 'Fade in').getByRole('slider');
    const fade = async () => (await clipOf(page, 'audio')).fadeIn;
    await thumb.focus();
    await page.keyboard.press('ArrowRight');
    expect(await fade()).toBe(15);
    await page.keyboard.press('ArrowRight');
    expect(await fade()).toBe(16);
    await page.keyboard.press('ArrowLeft');
    expect(await fade()).toBe(16);
    await page.keyboard.press('ArrowLeft');
    expect(await fade()).toBe(15);
  });

  test('a press with the pointer sets the value and leaves the arrow keys to the playhead', async ({
    page,
  }) => {
    await sample(page);
    await select(page, 'video');
    const slider = row(page, 'Opacity').locator('.slider');
    const thumb = slider.getByRole('slider');
    const box = (await slider.boundingBox())!;
    const at = await frame(page);

    // On the thumb itself, where it rests at the right-hand end.
    const t = (await thumb.boundingBox())!;
    await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
    await expect(thumb).not.toBeFocused();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(thumb).not.toBeFocused();
    expect((await clipOf(page, 'video')).opacity).toBeCloseTo(0.5, 1);
    const set = (await clipOf(page, 'video')).opacity;

    await page.keyboard.press('ArrowRight');
    expect(await frame(page)).toBe(at + 1);
    expect((await clipOf(page, 'video')).opacity).toBe(set);
  });
});

test.describe('library tiles', () => {
  test('double-clicking an effect applies it once', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ libraryTab: 'effects' }));
    const tile = page.locator('.fx-grid .fx', { hasText: 'Brightness' }).first();
    await expect(tile).toBeVisible();
    const before = (await clipOf(page, 'video')).effects.length;

    await tile.dblclick();
    await expect.poll(async () => (await clipOf(page, 'video')).effects.length).toBe(before + 1);
    await page.waitForTimeout(700);
    expect((await clipOf(page, 'video')).effects.length).toBe(before + 1);

    // A later, separate click is a second request.
    await tile.click();
    await expect.poll(async () => (await clipOf(page, 'video')).effects.length).toBe(before + 2);
  });
});

test.describe('tooltips', () => {
  test('stay wholly inside the window next to its edges', async ({ page }) => {
    await sample(page);
    const viewport = page.viewportSize()!;
    const tooltip = page.locator('.tooltip');
    // A tile in the library's left column carries a sentence: too wide to centre on it.
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ libraryTab: 'text' }));
    const targets = [
      page.locator('.preset').first(),
      page.locator('.topbar__home'),
      page.getByRole('button', { name: 'Fit timeline' }),
      page.locator('.tl [aria-label="Lock track"]').last(),
    ];
    for (const target of targets) {
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await expect(tooltip).toHaveCount(0);
      await target.hover();
      await expect(tooltip).toBeVisible();
      // Measured where it comes to rest, after the entrance animation.
      await tooltip.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const b = (await tooltip.boundingBox())!;
      const a = (await target.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(4);
      expect(b.y).toBeGreaterThanOrEqual(4);
      expect(b.x + b.width).toBeLessThanOrEqual(viewport.width - 4);
      expect(b.y + b.height).toBeLessThanOrEqual(viewport.height - 4);
      // Beside its target, never on top of it.
      expect(b.y >= a.y + a.height || b.y + b.height <= a.y).toBe(true);
    }
  });

  test('go away when what they describe does, or the person turns to something else', async ({ page }) => {
    await sample(page);
    const tooltip = page.locator('.tooltip');
    const show = (libraryTab: string) =>
      page.evaluate((libraryTab) => (window as any).tandem.ui.getState().set({ libraryTab }), libraryTab);
    /** Pointer off every control, and long enough for the next tooltip to wait its full delay. */
    const rest = async () => {
      await page.mouse.move(700, 300);
      await expect(tooltip).toHaveCount(0);
      await page.waitForTimeout(500);
    };

    // The tile is taken out of the page under a pointer that stays put: nothing tells it to leave.
    await show('text');
    const preset = page.locator('.preset').first();
    await preset.hover();
    await expect(tooltip).toBeVisible();
    await show('media');
    await expect(preset).toHaveCount(0);
    await expect(tooltip).toHaveCount(0);

    // The same while the tooltip was still waiting to appear.
    await rest();
    await show('text');
    await preset.hover();
    await show('media');
    await page.waitForTimeout(700);
    await expect(tooltip).toHaveCount(0);

    // Scrolled away from the pointer.
    await rest();
    await show('effects');
    const effect = page.locator('.fx-grid .fx', { hasText: 'Gaussian Blur' });
    await effect.hover();
    await expect(tooltip).toBeVisible();
    const said = (await tooltip.textContent())!;
    await page.locator('.fx-grid').evaluate((el) => (el.scrollTop += 60));
    await expect(page.locator('.tooltip', { hasText: said })).toHaveCount(0);

    // A key pressed, and the window losing the keyboard.
    const home = page.locator('.topbar__home');
    await rest();
    await home.hover();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Shift');
    await expect(tooltip).toHaveCount(0);
    await rest();
    await home.hover();
    await expect(tooltip).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(tooltip).toHaveCount(0);

    // Unrelated things moving leave it alone.
    await rest();
    await home.hover();
    await expect(tooltip).toBeVisible();
    await page.locator('.fx-grid').evaluate(
      (el) =>
        new Promise<void>((scrolled) => {
          el.addEventListener('scroll', () => scrolled(), { once: true });
          el.scrollTop += 20;
        }),
    );
    await expect(tooltip).toBeVisible();
  });

  test('show for the keyboard as for the pointer, and go with Escape or the focus', async ({ page }) => {
    await sample(page);
    const tooltip = page.locator('.tooltip');
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    const fit = page.getByRole('button', { name: 'Fit timeline' });
    await page.mouse.move(700, 300);

    // Tab arrives at an icon button: its name shows, with its shortcut.
    await zoomIn.focus();
    await page.keyboard.press('Tab');
    await expect(fit).toBeFocused();
    await expect(tooltip).toHaveText(/Fit timeline/);
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await expect(fit).toBeFocused();

    // It goes with the focus, and the next control's takes its place.
    await page.keyboard.press('Shift+Tab');
    await expect(tooltip).toHaveText(/Zoom in/);
    await page.keyboard.press('Tab');
    await expect(tooltip).toHaveText(/Fit timeline/);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(tooltip).toHaveCount(0);

    // Focus that a press of the pointer leaves behind brings nothing back.
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(tooltip).toHaveCount(0);
    await page.waitForTimeout(700);
    await expect(tooltip).toHaveCount(0);
  });

  test('stay away while something is carried over their controls', async ({ page }) => {
    await sample(page);
    const tooltip = page.locator('.tooltip');
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ libraryTab: 'effects' }));
    const tile = (await page.locator('.fx-grid .fx').first().boundingBox())!;
    const over = (await page.getByRole('button', { name: 'Fit timeline' }).boundingBox())!;
    const target = [over.x + over.width / 2, over.y + over.height / 2] as const;

    await page.mouse.move(tile.x + tile.width / 2, tile.y + 20);
    await page.mouse.down();
    await page.mouse.move(tile.x + tile.width / 2 + 30, tile.y + 50, { steps: 3 });
    await expect(page.locator('.drag-ghost')).toBeVisible();
    await page.mouse.move(...target, { steps: 6 });
    await page.waitForTimeout(700);
    await expect(tooltip).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator('.drag-ghost')).toHaveCount(0);

    // Let go, the pointer asks again like any other.
    await page.mouse.move(700, 300);
    await page.mouse.move(...target);
    await expect(tooltip).toHaveText(/Fit timeline/);
  });
});

test.describe('command palette', () => {
  test('owns the keyboard from the moment it opens', async ({ page }) => {
    await sample(page);
    const tool = page.getByRole('button', { name: 'Selection tool' });
    await tool.focus();
    const before = await uiState(page);

    await page.keyboard.press('Control+k');
    const input = page.locator('.palette input');
    await expect(input).toBeFocused();
    expect(await rootInert(page)).toBe(true);

    // Even with focus knocked off the field, keys are text for it and never editor shortcuts
    // (N toggles snapping, B is the blade tool).
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press('n');
    await page.keyboard.press('b');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('nb');
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    expect(await uiState(page)).toEqual({ ...before, dialog: 'palette' });

    // The group names are informative text: readable on the list and on the highlighted row.
    const ratios = await contrasts(page.locator('.palette__group'));
    expect(ratios.length).toBeGreaterThan(0);
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);

    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toHaveCount(0);
    await expect(tool).toBeFocused();

    // Running a command from it works as before.
    await page.keyboard.press('Control+k');
    await input.fill('toggle snapping');
    await expect(page.locator('.palette__item')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await uiState(page)).snapping).toBe(!before.snapping);
    expect((await uiState(page)).dialog).toBe(null);
  });

  test('says what it found and which entry Enter will run', async ({ page }) => {
    await sample(page);
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Search commands' });
    await expect(input).toBeFocused();
    const list = page.getByRole('listbox', { name: 'Commands' });
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(await input.getAttribute('aria-controls')).toBe(await list.getAttribute('id'));
    /** The entry the field points at, which is the one a screen reader reads out. */
    const pointedAt = () =>
      input.evaluate((el) => document.getElementById(el.getAttribute('aria-activedescendant')!)?.textContent);

    await page.keyboard.type('marker');
    const options = list.getByRole('option');
    const count = await options.count();
    expect(count).toBeGreaterThan(2);
    await expect(page.locator('.palette').getByRole('status')).toHaveText(`${count} commands`);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    expect(await pointedAt()).toBe(await options.first().textContent());

    // The highlight moves, the keyboard stays in the field, and the field follows the highlight.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(input).toBeFocused();
    await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(1);
    expect(await pointedAt()).toBe(await options.nth(2).textContent());

    await page.keyboard.type('zzzz');
    await expect(options).toHaveCount(0);
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(input).not.toHaveAttribute('aria-activedescendant', /./);
    await expect(page.locator('.palette').getByRole('status')).toHaveText('No commands match');

    // One match is counted as one.
    await input.fill('toggle snapping');
    await expect(page.locator('.palette').getByRole('status')).toHaveText('1 command');
  });
});

test.describe('confirmation dialog', () => {
  /** Ask through the editor's own confirm module; the answer lands in `window.__answer`. */
  const ask = (page: Page, opts: Record<string, unknown>) =>
    page.evaluate((opts) => {
      const w = window as any;
      w.__answer = undefined;
      const module = '/src/ui/confirm.tsx';
      void import(/* @vite-ignore */ module).then((m) => m.confirm(opts)).then((ok) => (w.__answer = ok));
    }, opts);
  const answer = (page: Page) => page.evaluate(() => (window as any).__answer);

  test('Enter goes ahead, Escape backs out, and the editor waits behind it', async ({ page }) => {
    const problems = trackProblems(page);
    await sample(page);
    const tool = page.getByRole('button', { name: 'Selection tool' });
    await tool.focus();
    const before = await uiState(page);

    await ask(page, {
      title: 'Replace this project?',
      message: 'Everything in it is replaced by the file.',
      confirmLabel: 'Replace',
    });
    const dialog = page.getByRole('dialog', { name: 'Replace this project?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription('Everything in it is replaced by the file.');
    await expect(page.getByRole('button', { name: 'Replace' })).toBeFocused();
    expect(await rootInert(page)).toBe(true);

    // Tab stays inside, and nothing typed here reaches the editor.
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab');
      expect(await focusIsIn(page, '[role="dialog"]')).toBe(true);
    }
    await page.keyboard.press('n');
    await page.keyboard.press('b');
    expect(await uiState(page)).toEqual(before);

    await page.getByRole('button', { name: 'Replace' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => answer(page)).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(tool).toBeFocused();
    expect(await rootInert(page)).toBe(false);

    await ask(page, { title: 'Replace this project?', confirmLabel: 'Replace' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => answer(page)).toBe(false);
    await expect(dialog).toHaveCount(0);
    await expect(tool).toBeFocused();
    expect(problems).toEqual([]);
  });

  test('the press that asks does not answer as well, however long the key is held', async ({ page }) => {
    await sample(page);
    // A stand-in for any button whose action asks first.
    await page.evaluate(() => {
      const w = window as any;
      const button = document.createElement('button');
      button.textContent = 'Restore';
      button.style.cssText = 'position: fixed; left: 8px; bottom: 8px; z-index: 5';
      const module = '/src/ui/confirm.tsx';
      button.onclick = () =>
        void import(/* @vite-ignore */ module)
          .then((m) => m.confirm({ title: 'Restore “v1”?', confirmLabel: 'Restore version' }))
          .then((ok) => (w.__answer = ok));
      document.getElementById('root')!.appendChild(button);
    });
    const asker = page.getByRole('button', { name: 'Restore', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Restore “v1”?' });
    const go = page.getByRole('button', { name: 'Restore version' });

    await asker.focus();
    await page.keyboard.down('Enter');
    await expect(go).toBeFocused();
    await expectRing(go);
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await expect(dialog).toBeVisible();
    expect(await answer(page)).toBeUndefined();
    await page.keyboard.up('Enter');

    // Let go and pressed again, the key answers; held on, it does not ask a second time.
    await page.keyboard.down('Enter');
    await expect.poll(() => answer(page)).toBe(true);
    await expect(asker).toBeFocused();
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(dialog).toHaveCount(0);
  });

  test('a destructive question starts on the safe button, and sits on top of another dialog', async ({
    page,
  }) => {
    await sample(page);
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ dialog: 'shortcuts' }));
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    const close = sheet.getByRole('button', { name: 'Close' });
    await close.focus();

    await ask(page, {
      title: 'Delete “Holiday”?',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      danger: true,
    });
    const question = page.getByRole('dialog', { name: 'Delete “Holiday”?' });
    await expect(question).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => answer(page)).toBe(false);
    await expect(question).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(close).toBeFocused();

    // Escape answers the question on top and leaves the dialog under it open. The ring says which
    // button Enter would have pressed.
    await ask(page, { title: 'Delete “Holiday”?', confirmLabel: 'Delete', danger: true });
    await expect(question).toBeVisible();
    await expectRing(page.getByRole('button', { name: 'Cancel' }));
    await page.keyboard.press('Escape');
    await expect.poll(() => answer(page)).toBe(false);
    await expect(sheet).toBeVisible();

    // With the page and the dialog underneath out of reach, the label alone finds the button,
    // although the timeline has a Delete button of its own.
    await ask(page, { title: 'Delete “Holiday”?', confirmLabel: 'Delete', danger: true });
    await expect(question).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => answer(page)).toBe(true);
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });

  test('a title that runs to several lines keeps the close button on its first', async ({ page }) => {
    await sample(page);
    await ask(page, {
      title:
        'Restore “Interview with the founders of a very small and very determined coffee roastery, part two”?',
      confirmLabel: 'Restore version',
    });
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Measured at rest: while the dialog is still arriving, two readings are of two places.
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((entrance) => entrance.finished)));
    const lines = await dialog.locator('.dialog__title').evaluate((title) => {
      const text = document.createRange();
      text.selectNodeContents(title);
      const boxes = Array.from(text.getClientRects());
      return {
        count: new Set(boxes.map((box) => Math.round(box.top))).size,
        firstMiddle: boxes[0].top + boxes[0].height / 2,
      };
    });
    const close = (await dialog.getByRole('button', { name: 'Close' }).boundingBox())!;
    expect(lines.count).toBeGreaterThan(1);
    expect(Math.abs(close.y + close.height / 2 - lines.firstMiddle)).toBeLessThanOrEqual(1.5);
    await page.keyboard.press('Escape');
  });
});

test.describe('shortcut sheet and empty states', () => {
  test('alternative shortcuts read as alternatives, and every key has a label', async ({ page }) => {
    await sample(page);
    await page.keyboard.press('Shift+?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();

    const keysOf = (title: string) =>
      sheet.locator('.shortcut', { has: page.getByText(title, { exact: true }) }).locator('.shortcut__keys');
    const separator = (title: string) =>
      keysOf(title)
        .locator('.kbd-group')
        .evaluateAll((groups) => groups.map((g) => getComputedStyle(g, '::before').content));

    expect(await separator('Redo')).toEqual(['none', '"or"']);
    expect(await separator('Selection tool')).toEqual(['none', '"or"']);
    expect(await separator('Undo')).toEqual(['none']);
    await expect(keysOf('Toggle safe areas').locator('.kbd')).toHaveText(['Shift', "'"]);
    await expect(keysOf('Go to previous marker').locator('.kbd')).toHaveText([
      'Ctrl',
      'Shift',
      'M',
      'Alt',
      'M',
    ]);
    await expect(keysOf('Zoom timeline to selection').locator('.kbd')).toHaveText(['Z']);

    // No key is shown by its internal name (those are lower-case words such as "quote").
    const labels = await sheet.locator('.kbd').allTextContents();
    expect(labels.filter((l) => /^[A-Z]{4,}$/.test(l))).toEqual([]);
  });

  test('the button in an empty media pool keeps its own icon', async ({ page }) => {
    await page.route('**/api/health', (route) => route.abort());
    await newProject(page);
    const sizes = await page.evaluate(() => {
      const size = (el: Element | null) => (el ? getComputedStyle(el).width : 'missing');
      return {
        illustration: size(document.querySelector('.empty > svg')),
        button: size(document.querySelector('.empty .btn svg')),
      };
    });
    expect(sizes).toEqual({ illustration: '28px', button: '14px' });
  });
});

test.describe('toasts', () => {
  test('fade out before they are taken away', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    // What happens to the toast, in order: it is shown, marked as leaving, and removed.
    await page.evaluate(() => {
      const w = window as any;
      w.__toasts = [];
      const note = (what: string, node: Node) => {
        if ((node as Element).classList?.contains('toast')) w.__toasts.push([what, node.textContent]);
      };
      new MutationObserver((changes) => {
        for (const change of changes) {
          if (change.type === 'attributes') note('leaving', change.target);
          change.addedNodes.forEach((node) => note('shown', node));
          change.removedNodes.forEach((node) => note('removed', node));
        }
      }).observe(document.querySelector('.toasts')!, {
        childList: true,
        subtree: true,
        attributeFilter: ['data-leaving'],
      });
      w.tandem.cmd.copy();
    });
    const toast = page.locator('.toast', { hasText: /^Copied \d+ clips?$/ });
    await expect(toast).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
    const seen: [string, string][] = await page.evaluate(() => (window as any).__toasts);
    expect(seen.filter(([, text]) => text.startsWith('Copied')).map(([what]) => what)).toEqual([
      'shown',
      'leaving',
      'removed',
    ]);
  });

  test('one that offers something to press waits while the pointer or the keyboard is on it', async ({
    page,
  }) => {
    await sample(page);
    await select(page, 'video');
    // Slowed down, the first clip runs into the next one: the toast offers to make room.
    await page.evaluate(() => (window as any).tandem.cmd.setSpeed(0.5));
    const offer = page.locator('.toast', { hasText: 'The next clip is in the way' });
    const action = offer.getByRole('button', { name: 'Make room' });
    await expect(offer).toBeVisible();

    // Under the pointer its time stands still: it is there long after it would have gone.
    await offer.hover();
    await page.waitForTimeout(11_000);
    await expect(offer).toBeVisible();
    // The same with the keyboard on its button, wherever the pointer has gone.
    await action.focus();
    await page.mouse.move(700, 300);
    await page.waitForTimeout(10_000);
    await expect(offer).toBeVisible();

    // Left alone it still has the time it had: more than a toast that only says something gets.
    await action.evaluate((button: HTMLElement) => button.blur());
    await page.waitForTimeout(5_000);
    await expect(offer).toBeVisible();
    await expect(offer).toHaveCount(0, { timeout: 8_000 });
  });
});

test.describe('home and profile', () => {
  test('the keyboard shows on the starter cards, the other ways in and the profile colours', async ({
    page,
  }) => {
    await page.route('**/api/health', (route) => route.abort());
    await page.goto('/');
    const name = page.getByRole('textbox', { name: 'Display name' });
    await name.focus();
    await page.keyboard.press('Tab');
    const starter = page.locator('.starter').first();
    await expect(starter).toBeFocused();
    await expectRing(starter);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    const custom = page.getByRole('button', { name: 'Custom project…' });
    await expect(custom).toBeFocused();
    await expectRing(custom);

    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.tl')).toBeVisible();
    await page.waitForFunction(() => !!(window as any).tandem?.session?.player);
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ dialog: 'profile' }));
    const profile = page.getByRole('dialog', { name: 'Your profile' });
    await expect(profile.getByRole('textbox', { name: 'Display name' })).toBeFocused();
    const chosen = profile.locator('.swatch-btn[aria-pressed="true"]');
    await expect(chosen).toHaveCount(1);
    const other = profile.locator('.swatch-btn[aria-pressed="false"]').first();
    const rings = (colour: Locator) =>
      colour.evaluate((el) => getComputedStyle(el).boxShadow.split(/,(?![^(]*\))/).length);

    // A colour that has the keyboard wears the focus ring; the chosen one keeps its own inside it.
    await other.focus();
    await expectRing(other);
    await chosen.focus();
    await expect.poll(() => rings(chosen)).toBe(3);
    await other.focus();
    await expect.poll(() => rings(chosen)).toBe(2);
  });

  test('a link that cannot be one is refused at the field, until it is changed', async ({ page }) => {
    const problems = trackProblems(page);
    await page.route('**/api/health', (route) => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Join with a link…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Join a project' });
    const link = dialog.getByRole('textbox', { name: 'Share link' });
    await expect(link).toBeFocused();
    await expect(link).not.toHaveAttribute('aria-invalid', 'true');

    await page.keyboard.type('not a link');
    await page.keyboard.press('Enter');
    await expect(link).toHaveAttribute('aria-invalid', 'true');
    await expect(link).toHaveAccessibleDescription('That does not look like a Tandem share link.');
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(link).toBeFocused();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => location.hash)).not.toContain('/p/');
    // The field wears the error's colour, also while it has the keyboard (its line eases into it).
    await expect
      .poll(() =>
        link.evaluate((input) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--red)';
          document.body.appendChild(probe);
          const red = getComputedStyle(probe).color;
          probe.remove();
          return getComputedStyle(input.closest('.field')!).boxShadow.includes(red);
        }),
      )
      .toBe(true);
    expect(Math.min(...(await contrasts(dialog.getByRole('alert'))))).toBeGreaterThanOrEqual(4.5);

    await page.keyboard.type('!');
    await expect(link).not.toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('says so for as long as the project list cannot be saved', async ({ page }) => {
    // Storage that has no room for the list while `__full` is set.
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if ((window as any).__full && key === 'tandem.projects.v1') {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        setItem.call(this, key, value);
      };
    });
    await page.route('**/api/health', (route) => route.abort());
    await newProject(page);
    await page.evaluate(() => (location.hash = '#/'));
    const card = page.locator('.pcard');
    await expect(card).toHaveCount(1);
    const notice = page.locator('.home__recent').getByRole('alert');
    await expect(notice).toHaveCount(0);

    const rename = async (name: string) => {
      await card.getByRole('button', { name: /^Options for/ }).click();
      await page.getByRole('menuitem', { name: 'Rename…' }).click();
      await page.getByRole('textbox', { name: 'Project name' }).fill(name);
      await page.keyboard.press('Enter');
      await expect(card.locator('.pcard__name')).toHaveText(name);
    };
    await page.evaluate(() => ((window as any).__full = true));
    await rename('Kept in this tab only');
    await expect(notice).toHaveText(
      'This browser has no room left to save the project list. Projects and links added in this tab are lost when it closes: delete a project you no longer need.',
    );
    expect(Math.min(...(await contrasts(notice)))).toBeGreaterThanOrEqual(4.5);

    // It is a standing notice, not a toast: it is there until the list is saved again.
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 12_000 });
    await expect(notice).toBeVisible();
    await page.evaluate(() => ((window as any).__full = false));
    await rename('Saved again');
    await expect(notice).toHaveCount(0);
  });

  test('a project whose link the server refused says so on its card, and what to do', async ({ page }) => {
    await page.route('**/api/health', (route) => route.abort());
    await newProject(page);
    // The link is kept aside, as the session leaves it after a refusal: the project is local for now.
    await page.evaluate(() => {
      const [project] = JSON.parse(localStorage.getItem('tandem.projects.v1')!);
      localStorage.setItem(
        'tandem.links-aside.v1',
        JSON.stringify({ [project.id]: { token: 'a.b', role: 'editor', refusedAt: Date.now() } }),
      );
    });
    await page.goto('/');
    await page.reload();
    const card = page.locator('.pcard');
    const hint = card.locator('.pcard__refused');
    await expect(hint).toContainText('Link refused');
    await expect(card.locator('.pcard__shared')).toHaveCount(0);
    const whatNow =
      'The server did not accept this project’s link. Open the project and choose Share, then Try again.';
    const open = card.getByRole('button', { name: /^Open / });
    await expect(open).toHaveAccessibleDescription(whatNow);

    // Asked with the pointer at the hint, and with the keyboard at the card.
    const tooltip = page.locator('.tooltip');
    await hint.hover();
    await expect(tooltip).toHaveText(whatNow);
    await page.mouse.move(700, 200);
    await expect(tooltip).toHaveCount(0);
    await page.getByRole('button', { name: 'Join with a link…' }).focus();
    await page.keyboard.press('Tab');
    await expect(open).toBeFocused();
    await expect(tooltip).toHaveText(whatNow);
  });
});

test.describe('an address the browser does not trust', () => {
  test('is named as the reason nothing plays, above every screen', async ({ page }) => {
    // What a browser reports for plain HTTP on anything but localhost.
    await page.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { get: () => false }));
    await page.route('**/api/health', (route) => route.abort());
    await page.goto('/');
    const notice = page.getByRole('alert').filter({ hasText: 'Tandem needs HTTPS' });
    await expect(notice).toContainText('Serve the editor over HTTPS');
    expect(Math.min(...(await contrasts(notice.locator('span'))))).toBeGreaterThanOrEqual(4.5);
    const height = page.viewportSize()!.height;
    const bottom = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!;
      return box.y + box.height;
    };
    // The screen has the rest of the window: nothing is pushed out of it.
    const under = await bottom('.insecure > .callout');
    expect((await page.locator('.home').boundingBox())!.y).toBeGreaterThanOrEqual(under);
    expect(await bottom('.home')).toBeLessThanOrEqual(height);

    await page.locator('.starter').first().click();
    await expect(page.locator('.tl')).toBeVisible();
    await expect(notice).toBeVisible();
    expect((await page.locator('.app').boundingBox())!.y).toBeGreaterThanOrEqual(under);
    expect(await bottom('.app')).toBeLessThanOrEqual(height);
  });

  test('is not mentioned on one it does', async ({ page }) => {
    await page.route('**/api/health', (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('.home__hero')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.insecure')).toHaveCount(0);
  });
});

test.describe('comments', () => {
  test('a resolved comment says so, stays readable and keeps its author in view', async ({ page }) => {
    // The window at its smallest, where the panel is narrowest.
    await page.setViewportSize({ width: 1280, height: 720 });
    await sample(page);
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const me = session.getMeta().user;
      const by = { authorId: me.id, authorName: 'Ada Lovelace', authorColor: me.color };
      session.review.add({ frame: 30, text: 'Hold this shot longer', x: null, y: null, ...by });
      session.review.update(session.review.get()[0].id, { resolved: true });
      ui.getState().set({ commentsOpen: true });
    });
    await page.locator('.chip', { hasText: 'Resolved' }).click();
    const comment = page.locator('.comment--resolved');
    await expect(comment).toBeVisible();
    await expect(comment.getByRole('img', { name: 'Resolved' })).toBeVisible();
    await expect(comment.getByRole('button', { name: 'Reopen' })).toBeVisible();
    const author = comment.locator('.comment__head b');
    await expect(author).toHaveText('Ada Lovelace');
    expect(await author.evaluate((name) => name.scrollWidth <= name.clientWidth)).toBe(true);

    // Stepping back is done with the surface and the text colour, not by fading the whole card.
    await expect(comment).toHaveCSS('opacity', '1');
    const ratios = await contrasts(
      comment.locator('.comment__text, .comment__ago, .comment__head b, .comment__actions button'),
    );
    expect(ratios.length).toBeGreaterThanOrEqual(5);
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
    expect((await contrasts(comment.locator('.comment__done')))[0]).toBeGreaterThanOrEqual(3);
  });

  test('a note written during playback is pinned where the writing began', async ({ page }) => {
    await sample(page);
    await page.evaluate(() => {
      const { cmd, ui } = (window as any).tandem;
      ui.getState().set({ commentsOpen: true });
      cmd.seek(30);
    });
    const playing = () => page.evaluate(() => (window as any).tandem.session.player.getState().playing);
    const box = page.getByRole('textbox', { name: 'Comment at the playhead' });
    await box.click();
    await page.evaluate(() => (window as any).tandem.session.player.play());
    await expect.poll(() => frame(page)).toBeGreaterThan(32);
    expect(await playing()).toBe(true);

    // The first character stops playback, and the playhead waits there for the rest of the note.
    await page.keyboard.type('T');
    await expect.poll(playing).toBe(false);
    const began = await frame(page);
    await page.keyboard.type('his cut comes a beat late', { delay: 20 });
    expect(await frame(page)).toBe(began);
    const stamp = await page.locator('.composer__tc').textContent();
    await page.keyboard.press('Enter');

    const card = page.locator('.comment');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.comment__tc')).toHaveText(stamp!);
    expect(await page.evaluate(() => (window as any).tandem.session.review.get()[0].frame)).toBe(began);
    await expect(card).toHaveAttribute('data-current', 'true');

    // Playback started again on purpose is left alone by the rest of a draft.
    await page.keyboard.type('And');
    await page.evaluate(() => (window as any).tandem.session.player.play());
    await page.keyboard.type(' so on');
    expect(await playing()).toBe(true);
    await page.evaluate(() => (window as any).tandem.session.player.pause());
  });

  test('the playhead lights the comment it is on without the list being drawn for every frame', async ({
    page,
  }) => {
    // Counts, by name, the components React renders again in each commit (first renders are not
    // counted): what its developer tools would show.
    await page.addInitScript(() => {
      const renders: Record<string, number> = {};
      const walk = (fiber: any, mounting: boolean): void => {
        const was = fiber.alternate;
        const mount = mounting || !was;
        const type = typeof fiber.type === 'object' && fiber.type ? fiber.type.type : fiber.type;
        if (!mount && fiber.flags & 1 && typeof type === 'function') {
          renders[type.name] = (renders[type.name] ?? 0) + 1;
        }
        if (mount || fiber.child !== was.child) {
          for (let child = fiber.child; child; child = child.sibling) walk(child, mount);
        }
      };
      (window as any).__renders = renders;
      (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        isDisabled: false,
        renderers: new Map(),
        inject: () => 1,
        onCommitFiberRoot: (_id: number, root: any) => walk(root.current, false),
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
      };
    });
    await sample(page);
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const me = session.getMeta().user;
      const by = { authorId: me.id, authorName: me.name, authorColor: me.color, x: null, y: null };
      for (let i = 0; i < 12; i++) session.review.add({ frame: 200 + i * 10, text: `Note ${i}`, ...by });
      ui.getState().set({ commentsOpen: true });
    });
    const cards = page.locator('.comment');
    await expect(cards).toHaveCount(12);
    /** Step the playhead through `frames`, one drawn frame at a time; what was rendered meanwhile. */
    const step = (frames: number[]): Promise<Record<string, number>> =>
      page.evaluate(async (frames) => {
        const w = window as any;
        for (const name of Object.keys(w.__renders)) delete w.__renders[name];
        for (const f of frames) {
          w.tandem.session.player.seek(f);
          await new Promise((drawn) => requestAnimationFrame(() => setTimeout(drawn, 0)));
        }
        return { ...w.__renders };
      }, frames);

    // Away from every comment only the composer's timecode follows the playhead.
    const away = await step(Array.from({ length: 30 }, (_, i) => 60 + i));
    expect(away.PlayheadTimecode).toBeGreaterThanOrEqual(30);
    expect(away.CommentCard ?? 0).toBe(0);
    expect(away.CommentsPanel ?? 0).toBe(0);
    await expect(page.locator('.composer__tc')).toHaveText('00:00:02:29');

    // Coming to a comment and leaving it again draws that one card twice, and no other.
    const across = await step([208, 209, 210, 211, 212]);
    expect(across.CommentCard).toBe(2);
    await page.evaluate(() => (window as any).tandem.cmd.seek(220));
    await expect(page.locator('.comment[data-current="true"] .comment__text')).toHaveText(['Note 2']);
  });

  test('closing the panel or removing a comment from the keyboard hands the keyboard on', async ({
    page,
  }) => {
    await sample(page);
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const me = session.getMeta().user;
      const by = { authorId: me.id, authorName: me.name, authorColor: me.color, x: null, y: null };
      for (const [i, text] of ['First', 'Second', 'Third'].entries()) {
        session.review.add({ frame: 30 * (i + 1), text, ...by });
      }
    });
    const toggle = page.locator('.topbar').getByRole('button', { name: 'Comments' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    const cards = page.locator('.comment');
    await expect(cards).toHaveCount(3);
    /** The comment the focused control belongs to. */
    const focusedIn = () =>
      page.evaluate(
        () => document.activeElement?.closest('.comment')?.querySelector('.comment__text')?.textContent,
      );

    // Deleting a comment: on to the one that takes its place. Held a moment too long, the key
    // that deleted the one does nothing to the next.
    await cards.nth(1).getByRole('button', { name: 'Delete' }).focus();
    await page.keyboard.down('Enter');
    await expect(cards).toHaveCount(2);
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(cards).toHaveCount(2);
    await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveCount(0);
    await expect(cards.nth(1).getByRole('button', { name: 'Reply' })).toBeFocused();
    expect(await focusedIn()).toBe('Third');

    // Resolving one takes it out of the list too: the last one hands on to the one before it.
    await cards.nth(1).getByRole('button', { name: 'Resolve' }).focus();
    await page.keyboard.press('Enter');
    await expect(cards).toHaveCount(1);
    await expect(cards.first().getByRole('button', { name: 'Reply' })).toBeFocused();
    expect(await focusedIn()).toBe('First');

    // With none left, to the box for writing a new one.
    await cards.first().getByRole('button', { name: 'Delete' }).focus();
    await page.keyboard.press('Enter');
    await expect(cards).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Comment at the playhead' })).toBeFocused();

    // Closing the panel: back to the button that opens it.
    await page.getByRole('button', { name: 'Close comments' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.composer')).toHaveCount(0);
    await expect(toggle).toBeFocused();

    // A reply is a named field, and the panel keeps the inset every panel has.
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const me = session.getMeta().user;
      session.review.add({
        frame: 10,
        text: 'Again',
        authorId: me.id,
        authorName: me.name,
        authorColor: me.color,
        x: null,
        y: null,
      });
    });
    const reply = cards.first().getByRole('button', { name: 'Reply' });
    const answer = page.getByRole('textbox', { name: 'Reply' });
    await reply.focus();
    await page.keyboard.press('Enter');
    await expect(answer).toBeFocused();
    // Given up or sent, the reply field goes and the keyboard is back on the comment's actions.
    await page.keyboard.press('Escape');
    await expect(answer).toHaveCount(0);
    await expect(reply).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Agreed');
    await page.keyboard.press('Enter');
    await expect(cards.first().locator('.comment__reply')).toContainText('Agreed');
    await expect(reply).toBeFocused();
    // Measured at rest: the panel and its cards ease into place.
    await page
      .locator('section[aria-label="Comments"]')
      .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    const panel = (await page.locator('section[aria-label="Comments"]').boundingBox())!;
    for (const part of ['.comment', '.composer textarea']) {
      const box = (await page.locator(`section[aria-label="Comments"] ${part}`).first().boundingBox())!;
      expect(box.x - panel.x).toBe(10);
      expect(panel.x + panel.width - (box.x + box.width)).toBe(10);
    }
  });
});
