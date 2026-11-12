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
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(format).toBeFocused();

    // Chosen from with the pointer, the select keeps focus all the same: it must not fall out of
    // the dialog. No shortcut is live here, so the arrow keys are the select's, and Tab goes on
    // from it.
    await format.click();
    await page.getByRole('option', { selected: true }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(format).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { selected: true })).toBeFocused();
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
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
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
    await expect(content).toBeFocused();
    expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await page.keyboard.press('ArrowDown');
    await expect.poll(top).toBeGreaterThan(0);
    await page.keyboard.press('End');
    await expect
      .poll(() => content.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(2);

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
    const list = page.getByRole('listbox');
    const before = await frame(page);

    await blend.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: 'Normal' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { selected: true })).not.toBeFocused();
    expect(await focusIsIn(page, '[role="listbox"]')).toBe(true);
    await page.keyboard.type('scr');
    await expect(page.getByRole('option', { name: 'Screen' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    expect((await clipOf(page, 'video')).blend).toBe('screen');
    await expect(blend).toBeFocused();
    expect(await frame(page)).toBe(before);

    // An arrow key opens it again on the current option; Tab closes it and stays on the control.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Screen' })).toBeFocused();
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
    await page.getByRole('option', { name: 'Multiply' }).hover();
    await expect(page.getByRole('option', { name: 'Multiply' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    expect((await clipOf(page, 'video')).blend).toBe('screen');
  });

  test('after a choice made with the pointer the arrow keys are still the transport', async ({ page }) => {
    await sample(page);
    await select(page, 'video');
    const blend = row(page, 'Blend mode').locator('.select');
    const list = page.getByRole('listbox');
    const menu = page.getByRole('menu');

    await blend.click();
    await page.getByRole('option', { name: 'Screen' }).click();
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
    await expect(page.getByRole('option', { name: 'Screen' })).toBeFocused();
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
    const list = page.getByRole('listbox');

    // Enter held on the select opens the list and leaves the choice to the next press.
    await blend.focus();
    await page.keyboard.down('Enter');
    await expect(page.getByRole('option', { name: 'Normal' })).toBeFocused();
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
    await expect(page.getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.down('ArrowDown');
    await page.keyboard.down('ArrowDown');
    await page.keyboard.down('ArrowDown');
    await page.keyboard.up('ArrowDown');
    await expect(page.getByRole('option').nth(4)).toBeFocused();
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
    const ratios = await page.evaluate(() => {
      const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      // Painted, a colour is three bytes however the browser writes it out (a mixed one is not rgb()).
      const paint = document.createElement('canvas').getContext('2d')!;
      const luminance = (colour: string) => {
        paint.fillStyle = colour;
        paint.fillRect(0, 0, 1, 1);
        const [r, g, b] = Array.from(paint.getImageData(0, 0, 1, 1).data, (v) => linear(v / 255));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const surface = getComputedStyle(document.querySelector('.palette')!).backgroundColor;
      return Array.from(document.querySelectorAll('.palette__item'), (row) => {
        const own = getComputedStyle(row).backgroundColor;
        const text = luminance(getComputedStyle(row.querySelector('.palette__group')!).color);
        const behind = luminance(own === 'rgba(0, 0, 0, 0)' ? surface : own);
        return (Math.max(text, behind) + 0.05) / (Math.min(text, behind) + 0.05);
      });
    });
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
