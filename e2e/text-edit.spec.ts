import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FIXTURES, newProject, noReloads, openLab, trackErrors } from './helpers';

/** Typing into a title where it stands in the picture. */

// A page that reloads because someone saved a file comes back with nothing being typed into.
test.beforeEach(({ page }) => noReloads(page));

const field = (page: Page): Locator => page.getByLabel('Title text');
const inspectorField = (page: Page): Locator => page.getByLabel('Text content');
const toast = (page: Page, text: string): Locator => page.locator('.toast', { hasText: text });

/** Put a title on the timeline at the playhead, without going on to type into it. */
function addTitle(page: Page, text: Record<string, unknown> = {}, clip: Record<string, unknown> = {}) {
  return page.evaluate(
    ({ text, clip }) => {
      const { cmd, session } = (window as any).tandem;
      const before = new Set(Object.keys(session.store.get().clips));
      cmd.addText(text, clip);
      return Object.keys(session.store.get().clips).find((id) => !before.has(id)) as string;
    },
    { text, clip },
  );
}

const content = (page: Page, id: string): Promise<string | undefined> =>
  page.evaluate((id) => (window as any).tandem.session.store.get().clips[id]?.text.content, id);

/** The caret or the selection in the title that is being typed into. */
const caret = (page: Page): Promise<[number, number]> =>
  field(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);

/** What a key that was not meant for the title would have changed. */
const editor = (page: Page) =>
  page.evaluate(() => {
    const { session, ui } = (window as any).tandem;
    const p = session.store.get();
    return {
      frame: Math.floor(session.player.getFrame()),
      playing: session.player.getState().playing,
      range: session.player.getState().range,
      clips: Object.keys(p.clips).length,
      markers: Object.keys(p.markers).length,
      loop: session.player.getState().loop,
      tool: ui.getState().tool,
      selection: ui.getState().selection.length,
      steps: session.store.undoManager.undoStack.length,
    };
  });

const typing = (page: Page): Promise<string | null> =>
  page.evaluate(() => (window as any).tandem.ui.getState().typing?.clip ?? null);

const frameBox = async (page: Page) => (await page.locator('.viewer__frame').boundingBox())!;

/** Make sure the faces a title is set in have arrived: what is measured before is another font's. */
const fontsFor = (page: Page, font: string, sample: string) =>
  page.evaluate(({ font, sample }) => document.fonts.load(font, sample).then(() => undefined), {
    font,
    sample,
  });

/** The part of the frame that the viewer shows, in the window. */
async function shownFrame(page: Page) {
  const frame = await frameBox(page);
  const stage = (await page.locator('.viewer__stage').boundingBox())!;
  const x = Math.max(frame.x, stage.x);
  const y = Math.max(frame.y, stage.y);
  const width = Math.min(frame.x + frame.width, stage.x + stage.width) - x;
  const height = Math.min(frame.y + frame.height, stage.y + stage.height) - y;
  return { x, y, width, height };
}

/**
 * A picture of the frame as far as the viewer shows it. The caret is left out by the screenshot
 * itself; `hideOutline` takes the outline of what is selected out as well.
 */
async function picture(page: Page): Promise<Buffer> {
  return page.screenshot({ clip: await shownFrame(page) });
}

interface Difference {
  /** Pixels that differ by more than a rounding step in some channel, and the box around them. */
  pixels: number;
  box: { left: number; top: number; right: number; bottom: number } | null;
}

/** Where two pictures of the same size differ. */
function difference(page: Page, a: Buffer, b: Buffer): Promise<Difference> {
  return page.evaluate(
    async ([a, b]) => {
      const read = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [one, two] = [await read(a), await read(b)];
      if (one.width !== two.width || one.height !== two.height) return { pixels: -1, box: null };
      let pixels = 0;
      const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (let i = 0; i < one.data.length; i += 4) {
        const most = Math.max(
          Math.abs(one.data[i] - two.data[i]),
          Math.abs(one.data[i + 1] - two.data[i + 1]),
          Math.abs(one.data[i + 2] - two.data[i + 2]),
        );
        if (most <= 6) continue;
        pixels++;
        const x = (i / 4) % one.width;
        const y = Math.floor(i / 4 / one.width);
        box.left = Math.min(box.left, x);
        box.right = Math.max(box.right, x + 1);
        box.top = Math.min(box.top, y);
        box.bottom = Math.max(box.bottom, y + 1);
      }
      return { pixels, box: pixels ? box : null };
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

/**
 * The stretches along one axis of a picture in which it has bright pixels, looking only at the
 * band `from`…`to` of the other axis: across (`x`) one for each letter that stands apart, down
 * (`y`) one for each line.
 */
function ink(
  page: Page,
  shot: Buffer,
  axis: 'x' | 'y',
  from: number,
  to: number,
): Promise<[number, number][]> {
  return page.evaluate(
    async ({ base64, axis, from, to }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const along = axis === 'x' ? width : height;
      const lit = (i: number): boolean => {
        for (let j = Math.max(0, Math.floor(from)); j < Math.min(axis === 'x' ? height : width, to); j++) {
          const [x, y] = axis === 'x' ? [i, j] : [j, i];
          if (data[(y * width + x) * 4] > 128) return true;
        }
        return false;
      };
      const runs: [number, number][] = [];
      let begun = -1;
      for (let i = 0; i <= along; i++) {
        const on = i < along && lit(i);
        if (on && begun < 0) begun = i;
        if (!on && begun >= 0) {
          runs.push([begun, i]);
          begun = -1;
        }
      }
      return runs;
    },
    { base64: shot.toString('base64'), axis, from, to },
  );
}

/** Leave the picture alone in a screenshot: no outline around what is selected. */
const hideOutline = (page: Page) => page.addStyleTag({ content: '.gizmo { opacity: 0 !important; }' });

test.describe('typing into a title on the picture', () => {
  test('a double-click puts the caret where it was pressed, and what is typed is the title', async ({
    page,
    context,
  }) => {
    const errors = trackErrors(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await newProject(page);
    // Ten digits of one width each, centred in the frame: where each of them stands is known.
    const mono = '400 48px "JetBrains Mono Variable"';
    await fontsFor(page, mono, '0123456789');
    const id = await addTitle(page, { content: '0123456789', font: 'JetBrains Mono Variable', weight: 400 });
    const frame = await frameBox(page);
    const advance = await page.evaluate((mono) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
      ctx.font = mono;
      return ctx.measureText('0').width / 48;
    }, mono);
    const middle = frame.y + frame.height / 2;
    // The title's type is 9% of the frame's height.
    const step = advance * 0.09 * frame.height;
    /** Where in the window the place between the characters `n - 1` and `n` of a line of `count` is. */
    const place = (n: number, count: number) => frame.x + frame.width / 2 + (n - count / 2) * step;

    // Pressed in the right half of the 3: the caret goes between the 3 and the 4.
    await page.mouse.dblclick(place(3.7, 10), middle);
    await expect(field(page)).toBeFocused();
    expect(await caret(page)).toEqual([4, 4]);
    expect(await typing(page)).toBe(id);
    await page.keyboard.type('X');
    await expect.poll(() => content(page, id)).toBe('0123X456789');
    // The inspector shows the same text, and has not taken the keyboard.
    await expect(inspectorField(page)).toHaveValue('0123X456789');
    await expect(field(page)).toBeFocused();

    // Once the caret is in, a press moves it, a drag selects, and what is typed replaces that.
    await page.mouse.click(place(9.2, 11), middle);
    expect(await caret(page)).toEqual([9, 9]);
    await page.mouse.move(place(1.1, 11), middle);
    await page.mouse.down();
    await page.mouse.move(place(2.9, 11), middle, { steps: 4 });
    await page.mouse.up();
    expect(await caret(page)).toEqual([1, 3]);
    await page.keyboard.type('ab');
    await expect.poll(() => content(page, id)).toBe('0ab3X456789');
    // A double-click selects a word now, as in any text.
    await page.mouse.dblclick(place(5.4, 11), middle);
    expect(await caret(page)).toEqual([0, 11]);

    // Enter breaks the line, and the keys of a text field do what they do in one.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two words');
    await expect.poll(() => content(page, id)).toBe('0ab3X456789\ntwo words');
    // Three presses select a line: the upper one stands half a line above the middle of the frame.
    await page.mouse.click(place(5.4, 11), middle - 0.5 * 1.15 * 0.09 * frame.height, { clickCount: 3 });
    const line = await caret(page);
    expect(line[0]).toBe(0);
    expect([11, 12]).toContain(line[1]);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+Shift+ArrowLeft');
    expect(await caret(page)).toEqual([16, 21]);
    await page.keyboard.press('Shift+Home');
    expect(await caret(page)).toEqual([12, 21]);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('Delete');
    await expect.poll(() => content(page, id)).toBe('ab3X456789\n');

    // What is pasted arrives as plain text, whatever else the clipboard holds.
    await page.evaluate(() =>
      navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob(['plain\ttext'], { type: 'text/plain' }),
          'text/html': new Blob(['<b>plain</b> <i style="font-size:90px">text</i>'], { type: 'text/html' }),
        }),
      ]),
    );
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+v');
    await expect.poll(() => content(page, id)).toBe('ab3X456789\nplain\ttext');
    // Cut takes the text and nothing else: the clip is still there, and the text comes back.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+x');
    await expect.poll(() => content(page, id)).toBe('');
    await page.keyboard.press('Control+v');
    await expect.poll(() => content(page, id)).toBe('ab3X456789\nplain\ttext');
    expect(await editor(page)).toMatchObject({ clips: 1, selection: 1 });
    expect(errors).toEqual([]);
  });

  test('no key typed into a title is a shortcut', async ({ page }) => {
    await newProject(page);
    const id = await addTitle(page, { content: 'Title' }, { duration: 300 });
    await page.evaluate(() => (window as any).tandem.cmd.seek(40));
    const before = await editor(page);
    const frame = await frameBox(page);
    await page.mouse.dblclick(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Control+a');
    // Every one of these does something to the timeline when it is not typed into a text.
    await page.keyboard.type('jkl s b m i o t x');
    await page.keyboard.press('Space');
    await page.keyboard.type('q');
    await expect.poll(() => content(page, id)).toBe('jkl s b m i o t x q');
    for (const key of [
      'Home',
      'Delete',
      'End',
      'Backspace',
      'ArrowLeft',
      'ArrowLeft',
      'ArrowUp',
      'ArrowDown',
    ]) {
      await page.keyboard.press(key);
    }
    for (const key of ['Control+d', 'Control+b', 'Shift+Delete', 'Control+l', 'Shift+ArrowLeft']) {
      await page.keyboard.press(key);
    }
    await expect.poll(() => content(page, id)).toBe('kl s b m i o t x ');
    expect(await editor(page)).toEqual({ ...before, steps: before.steps + 1 });
    expect(await typing(page)).toBe(id);

    // The picture is not moved under the caret either: a title that reaches out of the viewer is
    // typed into where it is, and the viewer stays where it was.
    await page.keyboard.press('Control+a');
    await page.keyboard.type(
      'A title so long that most of it lies outside the frame, where no caret is seen',
    );
    await page.keyboard.press('Control+End');
    await page.keyboard.type('!');
    await expect.poll(() => content(page, id)).toContain('seen!');
    const scrolled = () =>
      field(page).evaluate((el) => {
        const moved: string[] = [];
        for (let box: Element | null = el; box; box = box.parentElement) {
          if (box.scrollLeft || box.scrollTop) moved.push(box.className);
        }
        return moved;
      });
    await page.waitForTimeout(300);
    await expect.poll(scrolled).toEqual([]);
  });

  test('Escape, Ctrl+Enter and a press outside end the typing and keep the text', async ({ page }) => {
    await newProject(page);
    const id = await addTitle(page, { content: 'Opening' });
    const frame = await frameBox(page);
    const centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const selection = () => page.evaluate(() => (window as any).tandem.ui.getState().selection);

    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    // Typing gives the handles up for the caret: the outline stays.
    await expect(page.locator('.gizmo__body')).toHaveCount(1);
    await expect(page.locator('.gizmo__handle')).toHaveCount(0);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('First');
    // Held down, the key that ends the typing does nothing more.
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await expect(field(page)).toHaveCount(0);
    expect(await content(page, id)).toBe('First');
    expect(await typing(page)).toBeNull();
    expect(await selection()).toEqual([id]);
    await expect(page.locator('.gizmo__handle')).toHaveCount(8);
    // The keyboard is the editor's again.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press('m');
    await expect.poll(async () => (await editor(page)).markers).toBe(1);

    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' cut');
    await page.keyboard.press('Control+Enter');
    await expect(field(page)).toHaveCount(0);
    expect(await content(page, id)).toBe('First cut');
    expect(await selection()).toEqual([id]);

    // A press outside the title ends the typing and does what it does anyway: here, on the empty
    // picture, it deselects.
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Second');
    await page.mouse.click(frame.x + 20, frame.y + 20);
    await expect(field(page)).toHaveCount(0);
    expect(await content(page, id)).toBe('Second');
    expect(await selection()).toEqual([]);

    // So does a press on a control that does not take the keyboard away.
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.getByRole('button', { name: 'Go to start' }).dispatchEvent('pointerdown');
    await expect(field(page)).toHaveCount(0);
    expect(await content(page, id)).toBe('Second');
  });

  test('the picture is the same before, while and after a title is typed into, and the caret is on the letters', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await newProject(page);
    await hideOutline(page);
    const same = async (a: Buffer, b: Buffer) => (await difference(page, a, b)).pixels === 0;
    // Two lines of three letters that stand apart, each as wide on its left as on its right: a
    // letter that is selected has to lie in the middle of what marks it.
    const cases: {
      text: { font: string; weight?: number; size?: number; letterSpacing?: number } & Record<
        string,
        unknown
      >;
      clip: Record<string, unknown>;
      zoom: 'fit' | number;
    }[] = [
      { text: { font: 'Inter' }, clip: {}, zoom: 'fit' },
      {
        text: {
          font: 'Playfair Display Variable',
          align: 'right',
          letterSpacing: 0.1,
          size: 0.14,
          lineHeight: 1,
        },
        clip: { x: -0.2, y: -0.2 },
        zoom: 'fit',
      },
      {
        text: {
          font: 'Bebas Neue',
          weight: 400,
          align: 'left',
          size: 0.1,
          lineHeight: 1.4,
          stroke: { enabled: true, color: '#ff0066', width: 0.03 },
          shadow: { enabled: true, color: '#000000', blur: 0.1, x: 0.04, y: 0.06, opacity: 0.8 },
        },
        clip: { x: -0.22, y: -0.16, scaleX: 1.6, scaleY: 1.6 },
        zoom: 0.5,
      },
      // Turned, stretched and off centre, in a box that wraps, at both sizes of the viewer. What
      // marks a letter is turned with it here and is not looked for: the picture has to hold.
      ...(['fit', 0.5] as const).map((zoom) => ({
        text: { font: 'Caveat Variable', weight: 600, size: 0.08, boxWidth: 0.2, letterSpacing: 0.05 },
        clip: { x: -0.2, y: -0.12, scaleX: 1.3, scaleY: 0.9, rotation: 17 },
        zoom,
      })),
    ];
    for (const c of cases) {
      const text = { content: 'H H H\nH H H', weight: 700, ...c.text };
      await fontsFor(page, `${text.weight} 48px "${text.font}"`, text.content);
      await page.evaluate((zoom) => (window as any).tandem.ui.getState().set({ viewerZoom: zoom }), c.zoom);
      const id = await addTitle(page, text, c.clip);
      await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
      /** The space added after each letter, in pixels of the window. */
      const spacing =
        Number(text.letterSpacing ?? 0) *
        Number(text.size ?? 0.09) *
        (await frameBox(page)).height *
        Number(c.clip.scaleX ?? 1);
      // The picture at rest: nothing selected, nothing typed.
      let before = await picture(page);
      await expect
        .poll(async () => {
          const again = await picture(page);
          const settled = (await same(before, again)) && (await ink(page, again, 'x', 0, 4000)).length > 0;
          before = again;
          return settled;
        })
        .toBe(true);

      await page.evaluate((id) => (window as any).tandem.cmd.editText(id), id);
      await expect(field(page)).toBeFocused();
      await page.keyboard.press('Control+Home');
      await expect.poll(async () => same(before, await picture(page))).toBe(true);

      // The H in the middle of each line, selected. What marks it lies on that letter and on no
      // other, and the two marks are as far apart as the two lines are drawn.
      const tops: number[] = [];
      const upright = !c.clip.rotation;
      for (const [from, to] of upright
        ? [
            [2, 3],
            [8, 9],
          ]
        : []) {
        await field(page).evaluate(
          (el: HTMLTextAreaElement, [from, to]) => el.setSelectionRange(from, to),
          [from, to],
        );
        let box: Difference['box'] = null;
        await expect
          .poll(async () => (box = (await difference(page, before, await picture(page))).box))
          .not.toBeNull();
        const { left, right, top, bottom } = box!;
        const band = (bottom - top) / 4;
        const letters = await ink(page, before, 'x', top + band, bottom - band);
        expect(letters, JSON.stringify({ box, letters })).toHaveLength(3);
        const inside = letters.filter(([a, b]) => a >= left - 1 && b <= right + 1);
        expect(inside, JSON.stringify({ box, letters })).toEqual([letters[1]]);
        // An H has as much room on its left as on its right; what is added after each letter
        // to space them out is on its right, within what marks it.
        const [inkLeft, inkRight] = letters[1];
        expect(Math.abs(right - inkRight - (inkLeft - left) - spacing)).toBeLessThanOrEqual(2);
        expect(letters[0][1]).toBeLessThanOrEqual(left);
        expect(letters[2][0]).toBeGreaterThanOrEqual(right);
        tops.push(top);
      }
      if (upright) {
        const lines = await ink(page, before, 'y', 0, 4000);
        expect(lines).toHaveLength(2);
        expect(Math.abs(tops[1] - tops[0] - (lines[1][0] - lines[0][0]))).toBeLessThanOrEqual(1.5);
      }

      // Typed and taken back, the title is drawn exactly as before; and so it is once the typing
      // has ended.
      await page.keyboard.press('Control+End');
      await page.keyboard.type('x');
      await expect.poll(() => content(page, id)).toBe('H H H\nH H Hx');
      await expect.poll(async () => same(before, await picture(page))).toBe(false);
      await page.keyboard.press('Backspace');
      await expect.poll(async () => same(before, await picture(page))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(field(page)).toHaveCount(0);
      await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
      await expect.poll(async () => same(before, await picture(page))).toBe(true);
      await page.evaluate(
        (id) => (window as any).tandem.session.store.commit([{ op: 'removeClip', id }]),
        id,
      );
    }
  });

  test('a title in a box is broken after a hyphen, where the field over it breaks its line', async ({
    page,
  }) => {
    await newProject(page);
    await hideOutline(page);
    // Characters of one width in a box ten and a half of them wide: "HHHH HHH-" fills the first
    // line, and the word goes on in the second.
    const mono = '700 48px "JetBrains Mono Variable"';
    await fontsFor(page, mono, 'H-');
    const advance = await page.evaluate((mono) => {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
      ctx.font = mono;
      return ctx.measureText('H').width / 48;
    }, mono);
    const { width, height } = await page.evaluate(() => (window as any).tandem.session.store.get().settings);
    const id = await addTitle(page, {
      content: 'HHHH HHH-HHH H',
      font: 'JetBrains Mono Variable',
      weight: 700,
      size: 0.09,
      align: 'left',
      boxWidth: (10.5 * advance * 0.09 * height) / width,
    });
    await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
    let before = await picture(page);
    await expect
      .poll(async () => {
        const again = await picture(page);
        const settled =
          (await difference(page, before, again)).pixels === 0 &&
          (await ink(page, again, 'x', 0, 4000)).length > 0;
        before = again;
        return settled;
      })
      .toBe(true);

    // The picture: seven letters and the hyphen in the first line, four letters in the second.
    const lines = await ink(page, before, 'y', 0, 4000);
    expect(lines).toHaveLength(2);
    expect(await ink(page, before, 'x', ...lines[0])).toHaveLength(8);
    const second = await ink(page, before, 'x', ...lines[1]);
    expect(second).toHaveLength(4);
    const last = second[3];

    // The field: its last letter, selected, is marked where the last letter is drawn.
    await page.evaluate((id) => (window as any).tandem.cmd.editText(id), id);
    await expect(field(page)).toBeFocused();
    await field(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(13, 14));
    await expect
      .poll(async () => {
        const { box } = await difference(page, before, await picture(page));
        return (
          !!box &&
          box.top >= lines[0][1] &&
          box.bottom >= lines[1][1] - 1 &&
          box.left >= second[2][1] &&
          box.left <= last[0] + 1 &&
          box.right >= last[1] - 1
        );
      })
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(field(page)).toHaveCount(0);

    // And a double-click on the left half of that letter puts the caret in front of it.
    const shown = await shownFrame(page);
    await page.mouse.dblclick(
      shown.x + last[0] + (last[1] - last[0]) / 4,
      shown.y + (lines[1][0] + lines[1][1]) / 2,
    );
    await expect(field(page)).toBeFocused();
    expect(await caret(page)).toEqual([13, 13]);
    await page.keyboard.type('X');
    await expect.poll(() => content(page, id)).toBe('HHHH HHH-HHH XH');
  });

  test('an input method composes into the title, and what it composed is one step', async ({ page }) => {
    await newProject(page);
    const id = await addTitle(page, { content: 'ab' });
    await page.evaluate((id) => (window as any).tandem.cmd.editText(id), id);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('End');
    // The events of an input method, as the browser sends them for one.
    const ime = await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await expect.poll(() => content(page, id)).toBe('abに');
    await ime.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await expect.poll(() => content(page, id)).toBe('abにほん');
    await ime.send('Input.insertText', { text: '日本' });
    await expect.poll(() => content(page, id)).toBe('ab日本');
    expect(await caret(page)).toEqual([4, 4]);
    // A dead key is a composition too: the accent first, then the letter it lands on.
    await ime.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
    await expect.poll(() => content(page, id)).toBe('ab日本´');
    await ime.send('Input.insertText', { text: 'é' });
    await expect.poll(() => content(page, id)).toBe('ab日本é');
    // A composition that is given up leaves nothing behind.
    await ime.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
    await expect.poll(() => content(page, id)).toBe('ab日本éか');
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await expect.poll(() => content(page, id)).toBe('ab日本é');
    // Emoji and text that runs the other way are text like any other.
    await page.keyboard.insertText(' 👨‍👩‍👧 שלום');
    await expect.poll(() => content(page, id)).toBe('ab日本é 👨‍👩‍👧 שלום');
    await page.keyboard.press('Backspace');
    await expect.poll(() => content(page, id)).toBe('ab日本é 👨‍👩‍👧 שלו');

    // Undo takes back one composition at a time, never half of one.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect.poll(() => content(page, id)).toBe('ab日本é');
    await page.keyboard.press('Control+z');
    await expect.poll(() => content(page, id)).toBe('ab日本');
    await page.keyboard.press('Control+z');
    await expect.poll(() => content(page, id)).toBe('ab');
    await page.keyboard.press('Control+z');
    expect(await content(page, id)).toBe('ab');
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+y');
    await expect.poll(() => content(page, id)).toBe('ab日本é');
    await expect(field(page)).toHaveValue('ab日本é');
  });

  test('a title that comes and goes with an animation shows all of its text while it is typed into', async ({
    page,
  }) => {
    await newProject(page);
    await hideOutline(page);
    // At its first frame a typewriter has typed nothing yet, and a fade has let nothing through.
    for (const type of ['typewriter', 'fade', 'slideUp']) {
      const id = await addTitle(page, { content: 'Opening', animIn: { type, duration: 30 } });
      const lit = async () => (await ink(page, await picture(page), 'x', 0, 4000)).length;
      await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
      await expect.poll(lit).toBe(0);
      await page.evaluate((id) => (window as any).tandem.cmd.editText(id), id);
      await expect(field(page)).toBeFocused();
      await page.keyboard.press('Control+End');
      await expect.poll(lit).toBeGreaterThan(3);
      // Where it comes to rest is where it is typed into: the outline and the field agree.
      const whole = await picture(page);
      await page.keyboard.type('!');
      await expect.poll(() => content(page, id)).toBe('Opening!');
      await expect
        .poll(async () => (await difference(page, whole, await picture(page))).pixels)
        .toBeGreaterThan(0);
      if (type === 'typewriter') {
        // The graphics context is lost and comes back with a compositor that knows nothing of the
        // title being typed into: it is told again, and the text is whole as before.
        const lost = () => page.evaluate(() => (window as any).tandem.session.player.contextLost);
        await page.evaluate(() => {
          const { gl } = (window as any).tandem.session.player.compositor;
          const lose = gl.getExtension('WEBGL_lose_context');
          lose.loseContext();
          setTimeout(() => lose.restoreContext(), 200);
        });
        await expect.poll(lost).toBe(true);
        await expect.poll(lost).toBe(false);
        await expect.poll(lit).toBeGreaterThan(3);
        await expect(field(page)).toBeFocused();
      }
      await page.keyboard.press('Escape');
      await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
      // The animation is back with the end of the typing.
      await expect.poll(lit).toBe(0);
      await page.evaluate(
        (id) => (window as any).tandem.session.store.commit([{ op: 'removeClip', id }]),
        id,
      );
    }
  });

  test('is not offered where it cannot work', async ({ page }) => {
    await newProject(page);
    const ids = await page.evaluate(() => {
      const { cmd, session } = (window as any).tandem;
      cmd.addShape();
      cmd.addText({ content: 'Opening' }, { duration: 600 });
      const clips = Object.values(session.store.get().clips) as any[];
      return {
        shape: clips.find((c) => c.type === 'shape').id as string,
        title: clips.find((c) => c.type === 'text').id as string,
        track: clips.find((c) => c.type === 'text').trackId as string,
      };
    });
    const frame = await frameBox(page);
    const centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const ui = (patch: Record<string, unknown>) =>
      page.evaluate((patch) => (window as any).tandem.ui.getState().set(patch), patch);
    const selection = () => page.evaluate(() => (window as any).tandem.ui.getState().selection);
    const lock = (locked: boolean) =>
      page.evaluate(
        ({ id, locked }) =>
          (window as any).tandem.session.store.commit([{ op: 'updateTrack', id, patch: { locked } }]),
        { id: ids.track, locked },
      );

    // Where the picture is graded or mixed there are no handles, and no caret either.
    for (const workspace of ['color', 'audio']) {
      await ui({ workspace, selection: [] });
      await page.mouse.dblclick(...centre);
      await expect.poll(selection).toEqual([ids.title]);
      await page.keyboard.press('Enter');
      await page.keyboard.press('F2');
      await page.waitForTimeout(200);
      expect(await typing(page)).toBeNull();
    }
    await ui({ workspace: 'edit' });

    // A shape has no text. Enter and F2 are nothing to it, and nothing is said.
    await ui({ selection: [ids.shape] });
    await page.keyboard.press('Enter');
    await page.keyboard.press('F2');
    await page.evaluate((id) => (window as any).tandem.cmd.editText(id), ids.shape);
    await page.waitForTimeout(200);
    expect(await typing(page)).toBeNull();
    await expect(page.locator('.toast')).toHaveCount(0);

    // A locked track is not typed into. On the picture its title is not there to be pressed or
    // selected; asked for on the timeline, it is refused in the words every edit of a locked track
    // is refused in.
    await lock(true);
    await ui({ selection: [] });
    await page.mouse.dblclick(...centre);
    await page.keyboard.press('F2');
    await page.waitForTimeout(200);
    expect(await typing(page)).toBeNull();
    await expect(page.locator('.toast')).toHaveCount(0);
    const clip = (await page.locator(`[data-clip="${ids.title}"]`).boundingBox())!;
    await page.mouse.dblclick(clip.x + clip.width / 2, clip.y + clip.height / 2);
    await expect(toast(page, 'That track is locked. Unlock it to change its clips.')).toBeVisible();
    expect(await typing(page)).toBeNull();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
    await lock(false);

    // Text is typed into a picture that stands still: asking while it plays stops it there.
    await page.evaluate(() => (window as any).tandem.cmd.togglePlay());
    await page.waitForFunction(() => (window as any).tandem.session.player.getFrame() > 2);
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    const stopped = await editor(page);
    expect(stopped.playing).toBe(false);
    expect(stopped.frame).toBeGreaterThan(0);
    await page.keyboard.type(' ');
    await page.waitForTimeout(300);
    expect(await editor(page)).toMatchObject({ playing: false, frame: stopped.frame });
    await page.keyboard.press('Escape');

    // A title that is not on show at the playhead is typed into in the inspector's field, as it
    // always was; so is any title while the source monitor hides the picture.
    await page.evaluate(() => (window as any).tandem.cmd.seek(700));
    await page.evaluate((id) => (window as any).tandem.cmd.editText(id), ids.title);
    await expect(inspectorField(page)).toBeFocused();
    expect(await typing(page)).toBeNull();
    expect(
      await inspectorField(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([0, 8]);
    await page.keyboard.press('Escape');
  });
});

test.describe('the lines of a title in a box', () => {
  test('are broken where a browser breaks the lines of the field over the title', async ({ page }) => {
    test.setTimeout(300_000);
    await openLab(page);
    // The field's own style, on a block whose lines can be read.
    const sheet = readFileSync(join(FIXTURES, '../../apps/editor/src/features/viewer/viewer.css'), 'utf8');
    const style = /textarea\.title-edit \{([^}]*)\}/.exec(sheet)![1];
    await page.addStyleTag({ content: `.title-lines {${style}}` });
    const differing = await page.evaluate(async () => {
      const { core, engine } = (window as any).lab;
      const text = { ...core.DEFAULT_TEXT, font: 'Inter', weight: 700, size: 0.05, align: 'left' };
      await document.fonts.load(engine.fontSpec(text, 32), 'mx1');
      const trimmed = (line: string) => line.replace(/[ \t]+$/, '');
      /** The lines a block as wide as the title's box, styled as the field is, breaks `t` into. */
      const blockLines = (t: typeof text, layout: any): string[] => {
        const block = document.createElement('div');
        block.className = 'title-lines';
        Object.assign(block.style, {
          width: `${layout.width}px`,
          padding: `0 ${layout.width - layout.x - layout.textWidth}px 0 ${layout.x}px`,
          fontFamily: engine.fontStack(t),
          fontSize: `${layout.size}px`,
          fontWeight: String(t.weight),
          lineHeight: `${layout.lineHeight}px`,
          letterSpacing: `${layout.spacing}px`,
        });
        block.textContent = t.content;
        document.body.append(block);
        const lines: string[] = [];
        let top: number | null = null;
        for (let i = 0; i < t.content.length; i++) {
          const range = document.createRange();
          range.setStart(block.firstChild!, i);
          range.setEnd(block.firstChild!, i + 1);
          const rect = range.getClientRects()[0];
          if (rect && (top === null || Math.abs(rect.top - top) > 2)) {
            lines.push('');
            top = rect.top;
          }
          lines[lines.length - 1] += t.content[i];
        }
        block.remove();
        return lines.map(trimmed);
      };
      const widthOf = (content: string): number =>
        engine.layoutText({ ...text, content, boxWidth: null }, 1920, 1080).widths[0];

      // Every character of ASCII that can be seen; and beyond it an accented and a Cyrillic letter,
      // the hyphens and dashes, the ellipsis, quotation marks, and the no-break, em and thin space.
      const ascii = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i));
      const beyond = [
        0xe9, 0x44f, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2026, 0x201c, 0x201d, 0x2018, 0x2019, 0xab,
        0xbb, 0xa0, 0x2003, 0x2009,
      ].map((code) => String.fromCharCode(code));
      const all = [...ascii, ...beyond];
      const differing: string[] = [];
      let count = 0;
      // Each pair after a letter, a number, a space and a full stop, in a box that ends between
      // the two: whether the line is broken there is the rule for the pair.
      for (const a of all) {
        for (const b of all) {
          for (const lead of ['xx', '11', 'x ', '.']) {
            const head = `mmmm ${lead}${a}`;
            const content = `${head}${b}xx`;
            const t = { ...text, content, boxWidth: (widthOf(head) + 1) / 1920 };
            const layout = engine.layoutText(t, 1920, 1080);
            const drawn = JSON.stringify(layout.lines.map(trimmed));
            const field = JSON.stringify(blockLines(t, layout));
            if (drawn === field) continue;
            count++;
            if (differing.length < 12)
              differing.push(`${JSON.stringify(content)}: drawn ${drawn}, field ${field}`);
          }
        }
      }
      return { count, differing };
    });
    expect(differing.count, differing.differing.join('\n')).toBe(0);
  });
});

test.describe('typing into a title is one step, seen by everyone', () => {
  test('all of it is one step of the project, and Ctrl+Z inside it undoes typing only', async ({ page }) => {
    await newProject(page);
    const id = await addTitle(page, { content: 'Before' });
    // Another field of the page that was typed into earlier: a browser's own undo would go on to it.
    const name = page.getByLabel('Project name');
    await name.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Rough cut');
    await page.keyboard.press('Enter');
    await expect(name).toHaveValue('Rough cut');
    const frame = await frameBox(page);
    const centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const steps = async () => (await editor(page)).steps;
    const before = await steps();

    // Looked at and left, a title is no step at all.
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Escape');
    expect(await steps()).toBe(before);

    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('One two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('three');
    await expect.poll(() => content(page, id)).toBe('One two\nthree');
    expect(await steps()).toBe(before + 1);

    // Ctrl+Z takes the typing back a word at a time and stops at the title as it was found: it
    // goes on neither to the project's history nor to the other field.
    for (const text of ['One two\n', 'One two', 'One ', 'One', 'Before', 'Before', 'Before']) {
      await page.keyboard.press('Control+z');
      await expect.poll(() => content(page, id)).toBe(text);
    }
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('Before');
    expect(await caret(page)).toEqual([0, 6]);
    await expect(name).toHaveValue('Rough cut');
    expect(await editor(page)).toMatchObject({ clips: 1, steps: before + 1 });
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+y');
    await expect.poll(() => content(page, id)).toBe('One ');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => content(page, id)).toBe('One two\nthree');
    await page.keyboard.press('Escape');
    expect(await steps()).toBe(before + 1);

    // One undo of the project puts the title back as it was before the double-click.
    await page.keyboard.press('Control+z');
    await expect.poll(() => content(page, id)).toBe('Before');
    expect(await steps()).toBe(before);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => content(page, id)).toBe('One two\nthree');
    // What is done next is a step of its own, also when it asks to be joined to the step before.
    await page.evaluate((id) => {
      const { store } = (window as any).tandem.session;
      store.commit([{ op: 'updateClip', id, patch: { x: 0.1 } }], { merge: true });
    }, id);
    expect(await steps()).toBe(before + 2);
    await page.keyboard.press('Control+z');
    expect(await content(page, id)).toBe('One two\nthree');
    expect(await steps()).toBe(before + 1);

    // A title that is emptied and left says again what it said: no clip is left that shows nothing.
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await expect.poll(() => content(page, id)).toBe('');
    await page.keyboard.type('   ');
    await page.keyboard.press('Escape');
    await expect.poll(() => content(page, id)).toBe('One two\nthree');
    await expect(toast(page, 'The title was left empty: its text from before was put back.')).toBeVisible();
    expect(await editor(page)).toMatchObject({ clips: 1, selection: 1 });
  });

  test('others see the letters arrive, and typing ends with a notice when it cannot go on', async ({
    page,
    browser,
  }) => {
    const errors = trackErrors(page);
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'no collaboration server, or it is not taking new projects');
    const id = await addTitle(page, { content: 'Shared' }, { duration: 300 });
    await expect(page.locator('.conn')).toContainText('All changes synced');
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));
    const context = await browser.newContext();
    await noReloads(context);
    const guest = await context.newPage();
    const theirErrors = trackErrors(guest);
    await guest.goto(link);
    await guest.waitForFunction(
      () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 1,
    );
    const frame = await frameBox(page);
    const centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const write = (on: Page, edits: unknown[]) =>
      on.evaluate((edits) => (window as any).tandem.session.store.commit(edits), edits);
    const track = await page.evaluate(
      (id) => (window as any).tandem.session.store.get().clips[id].trackId,
      id,
    );

    // The other sees each letter as it is typed, not the text once the typing has ended.
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Liv');
    await expect.poll(() => content(guest, id)).toBe('Liv');
    await page.keyboard.type('e');
    await expect.poll(() => content(guest, id)).toBe('Live');
    expect(await typing(page)).toBe(id);

    // The other changes the same title meanwhile: the field follows, with the caret where it was.
    await guest.evaluate((id) => {
      const { session } = (window as any).tandem;
      const clip = session.store.get().clips[id];
      session.store.commit([
        { op: 'updateClip', id, patch: { text: { ...clip.text, content: 'Live, from both' } } },
      ]);
    }, id);
    await expect(field(page)).toHaveValue('Live, from both');
    expect(await caret(page)).toEqual([4, 4]);
    await page.keyboard.type('!');
    await expect.poll(() => content(guest, id)).toBe('Live!, from both');

    // The other locks the track: the typing ends, and says why in the words of every such refusal.
    await write(guest, [{ op: 'updateTrack', id: track, patch: { locked: true } }]);
    await expect(field(page)).toHaveCount(0);
    await expect(toast(page, 'That track is locked. Unlock it to change its clips.')).toBeVisible();
    expect(await typing(page)).toBeNull();
    expect(await content(page, id)).toBe('Live!, from both');
    await write(guest, [{ op: 'updateTrack', id: track, patch: { locked: false } }]);
    await expect
      .poll(() => page.evaluate((t) => (window as any).tandem.session.store.get().tracks[t].locked, track))
      .toBe(false);

    // The other moves the title away from the playhead.
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await write(guest, [{ op: 'updateClip', id, patch: { start: 900 } }]);
    await expect(field(page)).toHaveCount(0);
    await expect(toast(page, 'This title is no longer shown at the playhead.')).toBeVisible();
    await write(guest, [{ op: 'updateClip', id, patch: { start: 0 } }]);
    await expect
      .poll(() => page.evaluate((id) => (window as any).tandem.session.store.get().clips[id].start, id))
      .toBe(0);

    // The access to edit is taken away from whoever is typing.
    await guest.evaluate((id) => (window as any).tandem.cmd.editText(id), id);
    await expect(field(guest)).toBeFocused();
    await guest.keyboard.press('End');
    await guest.keyboard.type('?');
    await expect.poll(() => content(page, id)).toBe('Live!, from both?');
    await guest.evaluate(() => (window as any).tandem.session.applyRole('viewer'));
    await expect(field(guest)).toHaveCount(0);
    await expect(toast(guest, 'You have view-only access to this project.')).toHaveCount(1);
    // Someone who may only view is offered no caret: a double-click selects, the keys do nothing,
    // and nothing more is said.
    const theirFrame = await frameBox(guest);
    await guest.mouse.dblclick(theirFrame.x + theirFrame.width / 2, theirFrame.y + theirFrame.height / 2);
    await guest.keyboard.press('Enter');
    await guest.keyboard.press('F2');
    await guest.waitForTimeout(200);
    expect(await typing(guest)).toBeNull();
    await expect(field(guest)).toHaveCount(0);
    expect(await guest.evaluate(() => (window as any).tandem.ui.getState().selection)).toEqual([id]);
    await expect(toast(guest, 'You have view-only access to this project.')).toHaveCount(1);
    await guest.evaluate(() => (window as any).tandem.session.applyRole('editor'));

    // The other removes the title.
    await page.mouse.dblclick(...centre);
    await expect(field(page)).toBeFocused();
    await page.keyboard.type('x');
    await write(guest, [{ op: 'removeClip', id }]);
    await expect(field(page)).toHaveCount(0);
    await expect(toast(page, 'This title was removed.')).toBeVisible();
    expect(await typing(page)).toBeNull();
    expect(await editor(page)).toMatchObject({ clips: 0 });
    // The keys that follow are the editor's again, and nothing was thrown on either side.
    await page.keyboard.press('m');
    await expect.poll(async () => (await editor(page)).markers).toBe(1);
    expect(errors).toEqual([]);
    expect(theirErrors).toEqual([]);
    await context.close();
  });
});

test.describe('a new title, and the keyboard', () => {
  test('a new title is typed into at once, and the inspector shows the same text', async ({ page }) => {
    await newProject(page);
    const texts = () =>
      page.evaluate(() =>
        (Object.values((window as any).tandem.session.store.get().clips) as any[])
          .filter((c) => c.type === 'text')
          .map((c) => c.text.content)
          .sort(),
      );
    const before = (await editor(page)).steps;

    // From the toolbar: the placeholder is selected, and what is typed replaces it.
    await page.getByRole('button', { name: 'Add text' }).click();
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('Your text here');
    expect(await caret(page)).toEqual([0, 14]);
    await page.keyboard.type('Name');
    await expect.poll(texts).toEqual(['Name']);
    await expect(inspectorField(page)).toHaveValue('Name');
    await expect(field(page)).toBeFocused();
    // Adding the title was one step and typing it another.
    expect((await editor(page)).steps).toBe(before + 2);
    await page.keyboard.press('Escape');

    // From the keyboard: held down, the key that asked for the title types nothing into it.
    await page.keyboard.down('t');
    await page.keyboard.down('t');
    await page.keyboard.down('t');
    await page.keyboard.up('t');
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('Your text here');
    expect(await caret(page)).toEqual([0, 14]);
    await expect.poll(texts).toEqual(['Name', 'Your text here']);
    await page.keyboard.type('hold shot');
    // None of those letters ran a shortcut (h, l, o, s, d and t all have one).
    await expect.poll(texts).toEqual(['Name', 'hold shot']);
    expect(await editor(page)).toMatchObject({ clips: 2, tool: 'select', range: null, markers: 0 });

    // Typing in the inspector's field works as before: a press into it ends the typing on the
    // picture, and the field has the keyboard.
    await inspectorField(page).click();
    await expect(field(page)).toHaveCount(0);
    await expect(inspectorField(page)).toBeFocused();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' longer');
    await expect.poll(texts).toEqual(['Name', 'hold shot longer']);
    const steps = (await editor(page)).steps;
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await expect.poll(texts).toEqual(['Name', 'hold shot']);
    expect((await editor(page)).steps).toBe(steps - 1);

    // A preset from the library is a new title like any other.
    await page.getByRole('tab', { name: 'Titles' }).click();
    await page.locator('.preset', { hasText: 'Name here' }).click();
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('Name Surname');
    await page.keyboard.type('Ada Lovelace');
    await expect.poll(texts).toEqual(['Ada Lovelace', 'Name', 'hold shot']);
  });

  test('Enter or F2 on the selected title starts the typing, with its text selected', async ({ page }) => {
    await newProject(page);
    const id = await addTitle(page, { content: 'Opening' }, { duration: 300 });
    const frame = await frameBox(page);
    const centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const select = (ids: string[]) =>
      page.evaluate((ids) => (window as any).tandem.ui.getState().select(ids), ids);

    // Selected on the picture, nothing else has the keyboard: Enter is the title's. Held down, it
    // breaks no line in it.
    await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
    await page.mouse.click(...centre);
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue('Opening');
    expect(await caret(page)).toEqual([0, 7]);
    await page.keyboard.type('Intro');
    await expect.poll(() => content(page, id)).toBe('Intro');
    await page.keyboard.press('Enter');
    await expect.poll(() => content(page, id)).toBe('Intro\n');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await expect(field(page)).toHaveCount(0);

    // Selected on the timeline, the clip has the keyboard of the press. F2 starts the typing, and
    // Escape gives the keyboard back to the clip it came from.
    const clip = (await page.locator(`[data-clip="${id}"]`).boundingBox())!;
    await page.mouse.click(clip.x + clip.width / 2, clip.y + clip.height / 2);
    const onClip = () =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.clip ?? null);
    expect(await onClip()).toBe(id);
    await page.keyboard.press('F2');
    await expect(field(page)).toBeFocused();
    expect(await caret(page)).toEqual([0, 5]);
    await page.keyboard.type('Cold open');
    await page.keyboard.press('Escape');
    await expect(field(page)).toHaveCount(0);
    expect(await content(page, id)).toBe('Cold open');
    expect(await onClip()).toBe(id);
    await page.keyboard.press('Enter');
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Control+Enter');
    await expect(field(page)).toHaveCount(0);

    // A control that has the keyboard keeps its Enter: the button is pressed, and no title is
    // typed into. F2 is nobody else's key.
    await page.evaluate(() => (window as any).tandem.cmd.seek(40));
    await select([id]);
    await page.getByRole('button', { name: 'Go to start' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await editor(page)).frame).toBe(0);
    expect(await typing(page)).toBeNull();
    await page.keyboard.press('F2');
    await expect(field(page)).toBeFocused();
    await page.keyboard.press('Escape');

    // A title the playhead is not on is typed into in the inspector's field. The Enter that asked
    // for it, held down, breaks no line there either: the text stays, selected.
    await page.evaluate(() => (window as any).tandem.cmd.seek(400));
    await select([id]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down('Enter');
    await expect(inspectorField(page)).toBeFocused();
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(inspectorField(page)).toHaveValue('Cold open');
    expect(await content(page, id)).toBe('Cold open');
    expect(
      await inspectorField(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([0, 9]);
    expect(await typing(page)).toBeNull();

    // With more than one clip selected, or none, there is no one title to type into.
    const other = await addTitle(page, { content: 'Second' });
    await select([id, other]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Enter');
    await page.keyboard.press('F2');
    await select([]);
    await page.keyboard.press('Enter');
    await page.keyboard.press('F2');
    await page.waitForTimeout(200);
    expect(await typing(page)).toBeNull();
    expect(await editor(page)).toMatchObject({ clips: 2 });
  });
});
