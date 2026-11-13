import { expect, test, type Page } from '@playwright/test';
import { importFixtures, newProject } from './helpers';

/** The viewer panel: the source monitor and three-point editing from it, and the layout handles. */

/** `track:type@start+duration<sourceIn` for every clip, sorted, with tracks named V1, A1, … */
function cut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const p = (window as any).tandem.session.store.get();
    const name = (id: string) => `${p.tracks[id].kind === 'video' ? 'V' : 'A'}${p.tracks[id].order + 1}`;
    return (Object.values(p.clips) as any[])
      .map((c) => `${name(c.trackId)}:${c.type}@${c.start}+${c.duration}<${Math.round(c.sourceIn * 30)}`)
      .sort();
  });
}

/** What the editor holds around the monitor: playhead, selection, and what is kept per file. */
const state = (page: Page): Promise<{ frame: number; selection: number; open: string | null; kept: any }> =>
  page.evaluate(() => {
    const { ui, session } = (window as any).tandem;
    const s = ui.getState();
    const assets = session.store.get().assets;
    return {
      frame: Math.floor(session.player.getFrame()),
      selection: s.selection.length,
      open: s.sourceAsset ? assets[s.sourceAsset].name : null,
      kept: Object.fromEntries(
        Object.entries(s.sourceMarks).map(([id, marks]) => [assets[id]?.name ?? id, marks]),
      ),
    };
  });

/** The file in the monitor: where it stands, in frames of a 30 fps file, and whether it is held. */
const source = (page: Page): Promise<{ frame: number; paused: boolean } | null> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLMediaElement>('.source video, .source audio');
    return el && el.readyState >= 1 ? { frame: Math.round(el.currentTime * 30), paused: el.paused } : null;
  });

async function open(page: Page, name: string): Promise<void> {
  await page.locator('.asset', { hasText: name }).dblclick();
  await expect(page.locator('.source__name')).toHaveText(name);
  await page.waitForFunction(
    () => (document.querySelector<HTMLMediaElement>('.source video, .source audio')?.readyState ?? 0) >= 2,
  );
}

/**
 * Note, from now on, where a file in the monitor stands each time it starts to play. Looking at the
 * element afterwards would miss a short file that has played out by then.
 */
async function notePlaying(page: Page): Promise<void> {
  await page.evaluate(() => {
    const started: number[] = ((window as any).playedFrom = []);
    document.addEventListener(
      'playing',
      (e) => started.push(Math.round((e.target as HTMLMediaElement).currentTime * 30)),
      true,
    );
  });
}

/** The frame the file in the monitor first played from since `notePlaying`, once it has. */
const playedFrom = (page: Page): Promise<number> =>
  page.evaluate(() => ((window as any).playedFrom as number[])[0] ?? -1);

/** Hold the file in the monitor on its frame `seconds` in: whole seconds only. */
async function holdAt(page: Page, seconds: number): Promise<void> {
  await page.keyboard.press('Home');
  for (let i = 0; i < seconds; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => source(page)).toEqual({ frame: seconds * 30, paused: true });
}

const markIn = (page: Page) => page.locator('.source__foot button', { hasText: 'Mark in' });
const markOut = (page: Page) => page.locator('.source__foot button', { hasText: 'Mark out' });
const clearMarks = (page: Page) => page.getByRole('button', { name: 'Clear in and out' });
const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text });

test.describe('source monitor', () => {
  test('selects are pulled from one file without leaving the keyboard or the monitor', async ({ page }) => {
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4', 'tone.ogg']);
    await open(page, 'testsrc.mp4');

    // The first second to the second second, inserted with the comma key.
    await holdAt(page, 1);
    await page.keyboard.press('i');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('o');
    await expect(markIn(page)).toContainText('0:01.00');
    await expect(markOut(page)).toContainText('0:02.00');
    await page.keyboard.press('Comma');
    await expect.poll(() => cut(page)).toEqual(['A1:audio@0+30<30', 'V1:video@0+30<30']);
    // The monitor is still there with its marks, the playhead stands after the new clip, and the
    // clip is not selected behind the monitor: Delete, pressed with the file in mind, removes nothing.
    await expect(page.locator('.source')).toBeVisible();
    await expect(markIn(page)).toContainText('0:01.00');
    expect(await state(page)).toMatchObject({ frame: 30, selection: 0, open: 'testsrc.mp4' });
    await page.keyboard.press('Delete');
    expect(await cut(page)).toHaveLength(2);

    // The next select from the same file: from where the last one ended, to three seconds in.
    await page.keyboard.press('i');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('o');
    await expect(markIn(page)).toContainText('0:02.00');
    await expect(markOut(page)).toContainText('0:03.00');
    await page.keyboard.press('Period');
    await expect
      .poll(() => cut(page))
      .toEqual(['A1:audio@0+30<30', 'A1:audio@30+30<60', 'V1:video@0+30<30', 'V1:video@30+30<60']);
    expect((await state(page)).frame).toBe(60);

    // A key held down adds once.
    await page.keyboard.down('Period');
    await page.keyboard.down('Period');
    await page.keyboard.down('Period');
    await page.keyboard.up('Period');
    await expect.poll(async () => (await cut(page)).length).toBe(6);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await cut(page)).length).toBe(4);
    expect(await state(page)).toMatchObject({ open: 'testsrc.mp4' });

    // F9 inserts and F10 adds, as the buttons do: at the playhead, which is put on the cut here.
    await page.evaluate(() => (window as any).tandem.cmd.seek(30));
    await page.keyboard.press('F9');
    await expect
      .poll(() => cut(page))
      .toEqual([
        'A1:audio@0+30<30',
        'A1:audio@30+30<60',
        'A1:audio@60+30<60',
        'V1:video@0+30<30',
        'V1:video@30+30<60',
        'V1:video@60+30<60',
      ]);
    expect((await state(page)).frame).toBe(60);
    await page.evaluate(() => (window as any).tandem.cmd.goEnd());
    await page.keyboard.press('F10');
    await expect.poll(async () => (await cut(page)).filter((c) => c.endsWith('@90+30<60')).length).toBe(2);
    await page.locator('.source__foot button', { hasText: 'Insert' }).click();
    await expect.poll(async () => (await cut(page)).filter((c) => c.endsWith('@120+30<60')).length).toBe(2);
    await expect(page.locator('.source')).toBeVisible();
    expect(await state(page)).toMatchObject({ frame: 150, selection: 0 });

    // Closed and opened again, the file has its marks and plays on from where it was left.
    await holdAt(page, 1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.source')).toHaveCount(0);
    expect((await state(page)).kept).toEqual({ 'testsrc.mp4': { in: 2, out: 3, at: 1 } });
    await notePlaying(page);
    await open(page, 'testsrc.mp4');
    await expect(markIn(page)).toContainText('0:02.00');
    await expect(markOut(page)).toContainText('0:03.00');
    await expect.poll(() => playedFrom(page)).toBeGreaterThanOrEqual(30);
    expect(await playedFrom(page)).toBeLessThan(60);
    await page.keyboard.press('k');

    // Shift+I and Shift+O go to the marks, and the marks are cleared by key or by button.
    await page.keyboard.press('Shift+o');
    await expect.poll(() => source(page)).toEqual({ frame: 90, paused: true });
    await page.keyboard.press('Shift+i');
    await expect.poll(() => source(page)).toEqual({ frame: 60, paused: true });
    await expect(clearMarks(page)).toBeVisible();
    await page.keyboard.press('Alt+x');
    await expect(markIn(page)).toContainText('0:00.00');
    await expect(markOut(page)).toContainText('0:04.00');
    await expect(clearMarks(page)).toHaveCount(0);
    await page.keyboard.press('i');
    await expect(markIn(page)).toContainText('0:02.00');
    await clearMarks(page).click();
    await expect(markIn(page)).toContainText('0:00.00');
    await expect(clearMarks(page)).toHaveCount(0);

    // Another file has marks and a place of its own, and the first one keeps its own meanwhile.
    await holdAt(page, 3);
    await page.keyboard.press('i');
    await open(page, 'tone.ogg');
    await expect(markIn(page)).toContainText('0:00.00');
    await holdAt(page, 1);
    await page.keyboard.press('o');
    await open(page, 'testsrc.mp4');
    await expect(markIn(page)).toContainText('0:03.00');
    expect((await state(page)).kept).toEqual({
      'testsrc.mp4': { in: 3, out: null, at: 3 },
      'tone.ogg': { in: 0, out: 1, at: 1 },
    });

    // With nothing in the monitor the keys say so, and comma and period are the nudge keys again.
    await page.keyboard.press('Escape');
    const before = await cut(page);
    await page.keyboard.press('F9');
    await expect(toast(page, 'Nothing is open in the source monitor.')).toBeVisible();
    await page.keyboard.press('Comma');
    expect(await cut(page)).toEqual(before);

    // The shortcut sheet lists both keys.
    await page.keyboard.press('Shift+?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const keysOf = (title: string) =>
      sheet.locator('.shortcut', { has: page.getByText(title, { exact: true }) }).locator('.kbd');
    await expect(keysOf('Insert from source monitor at playhead')).toHaveText(['F9']);
    await expect(keysOf('Add from source monitor at playhead')).toHaveText(['F10']);
    await page.keyboard.press('Escape');

    // A file that leaves the project takes what was kept of it along.
    await page.locator('.asset', { hasText: 'tone.ogg' }).click({ button: 'right' });
    await page.locator('[role="menu"] .menu-item', { hasText: /^Remove/ }).click();
    await expect.poll(async () => Object.keys((await state(page)).kept)).toEqual(['testsrc.mp4']);
  });

  test('match frame opens the file with its marks around the clip', async ({ page }) => {
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    // Two seconds of the file from its second second, and after a gap the same slowed to half speed.
    await page.evaluate(() => {
      const { cmd, session } = (window as any).tandem;
      const [asset] = Object.values(session.store.get().assets);
      cmd.addAsset(asset, { frame: 0, sourceIn: 1, sourceOut: 3 });
      cmd.addAsset(asset, { frame: 90, sourceIn: 2, sourceOut: 3 });
      cmd.setSpeed(0.5);
    });
    await expect.poll(() => cut(page)).toContain('V1:video@90+60<60');
    await page.evaluate(() => {
      const { cmd, ui } = (window as any).tandem;
      ui.getState().clearSelection();
      cmd.seek(45);
    });

    await page.keyboard.press('f');
    await expect(page.locator('.source__name')).toHaveText('testsrc.mp4');
    await expect.poll(() => source(page)).toEqual({ frame: 75, paused: true });
    await expect(markIn(page)).toContainText('0:01.00');
    await expect(markOut(page)).toContainText('0:03.00');
    // Laid in again as it is, the stretch is as long as the clip it was matched from.
    await page.evaluate(() => (window as any).tandem.cmd.goEnd());
    await page.keyboard.press('Period');
    await expect.poll(() => cut(page)).toContain('V1:video@150+60<30');

    // Matched again from the slowed clip while the monitor is open: the marks follow what that
    // clip uses of the file, which is one second of it.
    await page.evaluate(() => (window as any).tandem.cmd.seek(110));
    await page.keyboard.press('f');
    await expect.poll(() => source(page)).toEqual({ frame: 70, paused: true });
    await expect(markIn(page)).toContainText('0:02.00');
    await expect(markOut(page)).toContainText('0:03.00');
    // The match is used up by showing it: opened from the pool later, the file plays on from there.
    await page.keyboard.press('Escape');
    await notePlaying(page);
    await open(page, 'testsrc.mp4');
    await expect.poll(() => playedFrom(page)).toBeGreaterThanOrEqual(70);
    expect(await playedFrom(page)).toBeLessThan(90);
  });

  test('a control the keyboard is working keeps its keys while the monitor is open', async ({ page }) => {
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await open(page, 'testsrc.mp4');
    await holdAt(page, 1);

    // A button that was clicked leaves Space to the monitor's transport.
    await markIn(page).click();
    await expect(markIn(page)).toContainText('0:01.00');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await source(page))?.paused).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await source(page))?.paused).toBe(true);

    // One that Tab has reached is pressed by it: Mark out here, with the file left as it stands.
    await holdAt(page, 2);
    await page.keyboard.press('Tab');
    await expect(markOut(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(markOut(page)).toContainText('0:02.00');
    expect(await source(page)).toEqual({ frame: 60, paused: true });

    // The volume slider is named, says its value, and is moved by the arrow keys while it has the
    // keyboard: the file in the monitor does not step. Space on it is still the monitor's.
    const volume = page.getByRole('slider', { name: 'Volume', exact: true });
    await volume.focus();
    await expect(volume).toHaveAttribute('aria-valuetext', '100%');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(volume).toHaveAttribute('aria-valuetext', '89%');
    expect(await source(page)).toEqual({ frame: 60, paused: true });
    await page.keyboard.press('Space');
    await expect.poll(async () => (await source(page))?.paused).toBe(false);
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().playing)).toBe(false);
    await page.keyboard.press('k');
    // Off the slider the same keys step the file again.
    await volume.blur();
    await holdAt(page, 2);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => source(page)).toEqual({ frame: 59, paused: true });
  });

  test('in a narrow viewer every button of the monitor stays in sight', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await open(page, 'testsrc.mp4');
    await holdAt(page, 1);
    await page.keyboard.press('i');
    await expect(clearMarks(page)).toBeVisible();
    const inside = () =>
      page.evaluate(() => {
        const monitor = document.querySelector('.source')!.getBoundingClientRect();
        const foot = document.querySelector('.source__foot')!;
        const picture = document.querySelector('.source video')!.getBoundingClientRect();
        return {
          buttons: [...foot.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            return r.left >= monitor.left && r.right <= monitor.right && r.bottom <= monitor.bottom;
          }),
          // The picture gives up the room the second row takes, and still ends where the footer begins.
          overlap: picture.bottom - foot.getBoundingClientRect().top,
          picture: picture.height,
        };
      });
    const narrow = await inside();
    expect(narrow.buttons).toEqual([true, true, true, true, true]);
    expect(narrow.overlap).toBeLessThan(0.5);
    expect(narrow.picture).toBeGreaterThan(100);
    await expect(page.locator('.source__foot button', { hasText: 'Add to timeline' })).toBeInViewport({
      ratio: 1,
    });
  });
});

test.describe('layout handles', () => {
  test('with several clips selected under the playhead, the handles are on the one selected first', async ({
    page,
  }) => {
    await newProject(page);
    // A small rectangle on V2 over a solid that fills the frame on V1.
    await page.evaluate(() => {
      const { cmd } = (window as any).tandem;
      cmd.addSolid();
      cmd.addShape({ kind: 'rect' });
    });
    const ids = await page.evaluate(() => {
      const clips = Object.values((window as any).tandem.session.store.get().clips) as any[];
      return {
        solid: clips.find((c) => c.type === 'solid').id,
        shape: clips.find((c) => c.type === 'shape').id,
      };
    });
    const select = (order: string[]) =>
      page.evaluate((order) => (window as any).tandem.ui.getState().select(order), order);
    /** Width of the outlined box as a share of the frame. */
    const outlined = () =>
      page.evaluate(() => {
        const body = document.querySelector('.gizmo__body');
        const frame = document.querySelector('.viewer__frame');
        if (!body || !frame) return null;
        return Math.round((body.getBoundingClientRect().width / frame.getBoundingClientRect().width) * 100);
      });

    await select([ids.solid, ids.shape]);
    await expect.poll(outlined).toBeGreaterThan(95);
    await select([ids.shape, ids.solid]);
    await expect.poll(outlined).toBeLessThan(50);
    // Past the end of both there is nothing to take hold of.
    await page.evaluate(() => (window as any).tandem.cmd.goEnd());
    await expect(page.locator('.gizmo__body')).toHaveCount(0);
  });
});
