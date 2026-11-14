import { expect, test, type Page } from '@playwright/test';
import { importFixtures, newProject, noReloads } from './helpers';

/** The viewer panel: the source monitor and three-point editing from it, and the layout handles. */

// A page that reloads because someone saved a file comes back with the monitor closed.
test.beforeEach(({ page }) => noReloads(page));

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
    // The button that clears the marks goes with them, and hands the keyboard on to Mark in.
    await page.keyboard.press('Tab');
    await expect(clearMarks(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(markIn(page)).toContainText('0:00.00');
    await expect(markOut(page)).toContainText('0:04.00');
    await expect(markIn(page)).toBeFocused();

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

  test('with the monitor open, the nudge keys leave the clips behind it where they are', async ({ page }) => {
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { cmd, session } = (window as any).tandem;
      const [asset] = Object.values(session.store.get().assets);
      cmd.addAsset(asset, { frame: 60 });
    });
    const placed = ['A1:audio@60+120<0', 'V1:video@60+120<0'];
    await expect.poll(() => cut(page)).toEqual(placed);
    // What was just added is selected, and stays so behind the monitor.
    await open(page, 'testsrc.mp4');
    await page.keyboard.press('k');
    expect(await state(page)).toMatchObject({ selection: 2, open: 'testsrc.mp4' });
    for (const key of ['Shift+Comma', 'Shift+Period', 'Shift+Period']) await page.keyboard.press(key);
    expect(await cut(page)).toEqual(placed);
    // With the monitor closed the same keys are the nudge by ten frames again.
    await page.keyboard.press('Escape');
    await expect(page.locator('.source')).toHaveCount(0);
    await page.keyboard.press('Shift+Period');
    await expect.poll(() => cut(page)).toEqual(['A1:audio@70+120<0', 'V1:video@70+120<0']);
    await page.keyboard.press('Shift+Comma');
    await expect.poll(() => cut(page)).toEqual(placed);
  });

  test('what is marked in the monitor is dragged to the timeline by the name of the file', async ({
    page,
  }) => {
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    await open(page, 'testsrc.mp4');
    await holdAt(page, 1);
    await page.keyboard.press('i');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('o');
    await expect(markOut(page)).toContainText('0:02.00');

    const v1 = (await page.locator('.lane').nth(1).boundingBox())!;
    const ppf: number = await page.evaluate(() => (window as any).tandem.ui.getState().ppf);
    const frameAt = (x: number) => Math.round((x - v1.x) / ppf);
    const middle = v1.y + v1.height / 2;
    /** Take the file by its name in the monitor, or by its card in the pool, to `x` on V1. */
    const carry = async (selector: string, x: number) => {
      const from = (await page.locator(selector).boundingBox())!;
      await page.mouse.move(from.x + 20, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 40, from.y + from.height / 2 + 30, { steps: 3 });
      await page.mouse.move(x, middle, { steps: 8 });
    };
    const ghost = () =>
      page.evaluate(() => {
        const preview = (window as any).tandem.ui.getState().preview;
        if (!preview) return null;
        return (Object.values(preview.clips) as any[]).map((c) => c.duration).sort((a, b) => a - b);
      });

    // The second second of the file, to V1: what shows in the lane while it is carried is as
    // long as what is marked, and so is what lands there, picture and sound.
    await expect(page.locator('.source__grip')).toHaveAttribute('data-live', 'true');
    const first = frameAt(v1.x + 200);
    await carry('.source__grip', v1.x + 200);
    await expect.poll(ghost).toEqual([30, 30]);
    await page.mouse.up();
    await expect.poll(() => cut(page)).toEqual([`A1:audio@${first}+30<30`, `V1:video@${first}+30<30`]);
    // The monitor stays as it was, and the drop is one step to undo.
    await expect(page.locator('.source')).toBeVisible();
    await expect(markIn(page)).toContainText('0:01.00');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => cut(page)).toEqual([]);
    await page.evaluate(() => (window as any).tandem.cmd.redo());
    await expect.poll(async () => (await cut(page)).length).toBe(2);

    // With Alt on a clip of its kind it takes the clip's place from its in point, which is now
    // the third second: the clip keeps its length and shows that second.
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('i');
    await expect(markIn(page)).toContainText('0:03.00');
    const onClip = v1.x + (first + 15) * ppf;
    await carry('.source__grip', onClip);
    await page.keyboard.down('Alt');
    await page.mouse.move(onClip + 2, middle);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect.poll(() => cut(page)).toEqual([`A1:audio@${first}+30<90`, `V1:video@${first}+30<90`]);
    await expect(toast(page, 'ends earlier')).toHaveCount(0);

    // Half a second further in, less of the file is left than the clip is long: the clip ends where
    // the file does, and what is said names the in point, since the file itself is long enough.
    for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(() => source(page)).toEqual({ frame: 105, paused: true });
    await page.keyboard.press('i');
    await expect(markIn(page)).toContainText('0:03.50');
    // Carried without Alt it would overwrite the second half of the clip, and is drawn there, under
    // the pointer. Alt pressed with the pointer at rest still finds the clip that is to be replaced.
    await carry('.source__grip', onClip);
    await expect.poll(ghost).toEqual([15, 15, 15, 30]);
    await page.keyboard.down('Alt');
    await expect(page.locator('.drop-mode')).toBeVisible();
    await expect(page.locator('.drop-mode')).toHaveText('Replace');
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect.poll(() => cut(page)).toEqual([`A1:audio@${first}+15<105`, `V1:video@${first}+15<105`]);
    await expect(toast(page, 'ends earlier')).toHaveText(
      'What is left of “testsrc.mp4” after its in point is shorter than the clip was, so the clip now ends earlier.',
    );
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => cut(page)).toEqual([`A1:audio@${first}+30<90`, `V1:video@${first}+30<90`]);

    // From the pool the same file still goes to the timeline whole.
    await page.keyboard.press('Escape');
    await expect(page.locator('.source')).toHaveCount(0);
    const second = frameAt(v1.x + 900);
    await carry('.asset[aria-label="testsrc.mp4"]', v1.x + 900);
    await expect.poll(ghost).toEqual([30, 30, 120, 120]);
    await page.mouse.up();
    await expect
      .poll(() => cut(page))
      .toEqual(
        [
          `A1:audio@${first}+30<90`,
          `A1:audio@${second}+120<0`,
          `V1:video@${first}+30<90`,
          `V1:video@${second}+120<0`,
        ].sort(),
      );
  });
});

test.describe('missing media', () => {
  test('the viewer says why the picture under the playhead is black', async ({ page }) => {
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4']);
    // The file on V1 for four seconds. Over its second and third second, on V2, a clip of a file
    // the project lists but that is on neither this device nor a server; and after both, a clip
    // of a file the project no longer lists at all.
    await page.evaluate(() => {
      const { cmd, session, ui } = (window as any).tandem;
      const [asset] = Object.values(session.store.get().assets) as any[];
      cmd.addAsset(asset, { frame: 0 });
      const p = session.store.get();
      const shot = (Object.values(p.clips) as any[]).find((c) => c.type === 'video');
      const v2 = (Object.values(p.tracks) as any[]).find((t) => t.kind === 'video' && t.order === 1);
      const over = { ...shot, trackId: v2.id, linkId: null };
      session.store.commit([
        { op: 'addAsset', asset: { ...asset, id: 'away', name: 'away.mp4', uploaded: false } },
        { op: 'addClip', clip: { ...over, id: 'away-clip', assetId: 'away', start: 30, duration: 60 } },
        { op: 'addClip', clip: { ...over, id: 'lost-clip', assetId: 'gone', start: 150, duration: 30 } },
      ]);
      ui.getState().clearSelection();
    });
    const seek = (frame: number) =>
      page.evaluate((frame) => (window as any).tandem.cmd.seek(frame, false), frame);
    const notice = page.locator('.viewer__media');

    // The timeline marks the two clips; the viewer speaks for the one the playhead is on.
    await expect(page.locator('.clip[data-missing="true"]')).toHaveCount(2);
    await seek(10);
    await expect(notice).toHaveCount(0);
    await seek(40);
    await expect(notice).toHaveText('Media offline: away.mp4');
    await expect(notice).toHaveAttribute('role', 'status');
    await seek(160);
    await expect(notice).toHaveText('Media offline: testsrc.mp4');
    await seek(100);
    await expect(notice).toHaveCount(0);

    // The line is not in the way of the pointer: a press on it reaches the picture under it.
    await seek(40);
    const line = (await notice.boundingBox())!;
    const frame = (await page.locator('.viewer__frame').boundingBox())!;
    expect(Math.abs(line.x + line.width / 2 - (frame.x + frame.width / 2))).toBeLessThan(1);
    await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().selection)).toEqual(['away-clip']);
    await expect(page.locator('.gizmo__body')).toBeVisible();
    await expect(notice).toBeVisible();

    // A track that is hidden shows nothing, so there is nothing to explain.
    const hide = page.getByRole('button', { name: 'Hide track' }).first();
    await hide.click();
    await expect(notice).toHaveCount(0);
    await page.getByRole('button', { name: 'Show track' }).click();
    await expect(notice).toHaveText('Media offline: away.mp4');

    // It follows the playhead while it runs: there over the clip, gone after it.
    await seek(20);
    await expect(notice).toHaveCount(0);
    await page.evaluate(() => {
      const said: (string | null)[] = ((window as any).said = []);
      new MutationObserver(() => {
        const now = document.querySelector('.viewer__media')?.textContent ?? null;
        if (said[said.length - 1] !== now) said.push(now);
      }).observe(document.querySelector('.viewer__frame')!, { childList: true, subtree: true });
      (window as any).tandem.session.player.play();
    });
    await page.waitForFunction(() => (window as any).tandem.session.player.getFrame() >= 100);
    await page.evaluate(() => (window as any).tandem.session.player.pause());
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).said)).toEqual(['Media offline: away.mp4', null]);
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

  test('someone who may only view sees what is selected outlined, with nothing to move it by', async ({
    page,
    browser,
  }) => {
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'no collaboration server, or it is not taking new projects');
    // A title over a solid that fills the frame.
    const ids = await page.evaluate(() => {
      const { cmd, session } = (window as any).tandem;
      cmd.addSolid();
      cmd.addText({ content: 'Opening' });
      const clips = Object.values(session.store.get().clips) as any[];
      return {
        solid: clips.find((c) => c.type === 'solid').id as string,
        title: clips.find((c) => c.type === 'text').id as string,
      };
    });
    await expect(page.locator('.conn')).toContainText('All changes synced');
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('viewer'));
    const context = await browser.newContext();
    await noReloads(context);
    const guest = await context.newPage();
    await guest.goto(link);
    await guest.waitForFunction(
      () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 2,
    );
    expect(await guest.evaluate(() => (window as any).tandem.session.getMeta().role)).toBe('viewer');

    const selection = (of: Page): Promise<string[]> =>
      of.evaluate(() => (window as any).tandem.ui.getState().selection);
    /** Where the title stands and how it is turned and sized. */
    const placed = (of: Page): Promise<number[]> =>
      of.evaluate((id) => {
        const c = (window as any).tandem.session.store.get().clips[id];
        return [c.x, c.y, c.scaleX, c.scaleY, c.rotation];
      }, ids.title);
    /** What is drawn on the selected layer, and the pointer its outline shows. */
    const drawn = (of: Page) =>
      of.evaluate(() => {
        const count = (selector: string) => document.querySelectorAll(selector).length;
        const body = document.querySelector('.gizmo__body');
        return {
          outline: count('.gizmo__body'),
          handles: count('.gizmo__handle'),
          rotate: count('.gizmo__rotate') + count('.gizmo__stem'),
          cursor: body ? getComputedStyle(body).cursor : null,
        };
      });
    const OUTLINED = { outline: 1, handles: 0, rotate: 0, cursor: 'auto' };
    const HELD = { outline: 1, handles: 8, rotate: 2, cursor: 'move' };
    const refusals = toast(guest, 'You have view-only access to this project.');
    const frame = (await guest.locator('.viewer__frame').boundingBox())!;
    const centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const corner: [number, number] = [frame.x + 30, frame.y + 30];

    // Looking is not editing: a press on the picture selects the layer under it, and the layer is
    // outlined. The outline has no handles, and its pointer does not promise a move.
    await guest.mouse.click(...centre);
    await expect.poll(() => selection(guest)).toEqual([ids.title]);
    await expect.poll(() => drawn(guest)).toEqual(OUTLINED);
    const before = await placed(guest);
    await guest.mouse.move(...centre);
    await guest.mouse.down();
    await guest.mouse.move(centre[0] + 60, centre[1] + 40, { steps: 5 });
    await guest.mouse.up();
    expect(await placed(guest)).toEqual(before);
    expect(await selection(guest)).toEqual([ids.title]);
    // Inside the outline of the solid, which reaches everywhere, a press still selects what is
    // under the pointer.
    await guest.mouse.click(...corner);
    await expect.poll(() => selection(guest)).toEqual([ids.solid]);
    await expect.poll(() => drawn(guest)).toEqual(OUTLINED);
    await guest.mouse.click(...centre);
    await expect.poll(() => selection(guest)).toEqual([ids.title]);
    // A double-click takes whoever may edit to the text of a title. Here it selects, and nothing
    // is refused because nothing was offered.
    await guest.mouse.click(...corner);
    await guest.mouse.dblclick(...centre);
    await expect.poll(() => selection(guest)).toEqual([ids.title]);
    await expect.poll(() => drawn(guest)).toEqual(OUTLINED);
    await expect(refusals).toHaveCount(0);

    // Access can change while the project is open, and the handles come and go with it. A layer
    // that is held when the access goes is let go of: the pointer that passes over it once the
    // handles are back does not move it.
    const access = (role: string) =>
      guest.evaluate((role) => (window as any).tandem.session.applyRole(role), role);
    await access('editor');
    await expect.poll(() => drawn(guest)).toEqual(HELD);
    await guest.mouse.move(...centre);
    await guest.mouse.down();
    await access('viewer');
    await expect.poll(() => drawn(guest)).toEqual(OUTLINED);
    await guest.mouse.up();
    await access('editor');
    await expect.poll(() => drawn(guest)).toEqual(HELD);
    await guest.mouse.move(centre[0] + 20, centre[1] + 10, { steps: 4 });
    expect(await placed(guest)).toEqual(before);
    await access('viewer');
    await expect.poll(() => drawn(guest)).toEqual(OUTLINED);
    await expect(refusals).toHaveCount(0);
    await context.close();

    // Whoever may edit takes the layer by its handles or its body, as before. Playback that starts
    // under a held layer takes the handles away as well, and ends the drag the same way.
    await page.evaluate((id) => (window as any).tandem.ui.getState().select([id]), ids.title);
    await expect.poll(() => drawn(page)).toEqual(HELD);
    const body = (await page.locator('.gizmo__body').boundingBox())!;
    const middle: [number, number] = [body.x + body.width / 2, body.y + body.height / 2];
    await page.mouse.move(...middle);
    await page.mouse.down();
    await page.mouse.move(middle[0] + 20, middle[1] + 10, { steps: 4 });
    const moved = await placed(page);
    expect(moved[0]).toBeGreaterThan(0);
    expect(moved[1]).toBeGreaterThan(0);
    await page.keyboard.press('Space');
    await expect(page.locator('.gizmo__body')).toHaveCount(0);
    await page.mouse.up();
    await page.evaluate(() => {
      const { cmd, session } = (window as any).tandem;
      session.player.pause();
      cmd.seek(0, false);
    });
    await expect.poll(() => drawn(page)).toEqual(HELD);
    await page.mouse.move(middle[0] + 30, middle[1] + 20, { steps: 4 });
    expect(await placed(page)).toEqual(moved);
  });
});
