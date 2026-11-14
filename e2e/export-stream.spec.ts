import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { ffprobe, hasFfprobe, importFixtures, newProject, noReloads, trackErrors } from './helpers';

/**
 * An export whose estimate passes 64 MB is not built in memory: the dialog asks where to save it
 * and the engine writes there as it goes. The save prompt cannot be operated from a test, so a
 * stand-in answers it with a file in the origin's private file system, which gives the export a
 * real `FileSystemWritableFileStream` and lets the test read back what was written.
 */
interface Picker {
  /** Names of the files handed out, in order. */
  picks: string[];
  /** What the prompt was asked for, each time. */
  asked: { suggestedName: string; extensions: string[] }[];
  /** Make the prompt fail with a `DOMException` of this name instead of answering. */
  refuse: string | null;
  /**
   * Leave the prompt open, as it is for as long as the person has not answered it, until
   * `window.__answerPrompt()` is called.
   */
  open: boolean;
  /** Hand out files whose every write fails, as on a disk that has no room. */
  full: boolean;
  /**
   * Hand out files that are not put in place when they are closed, but only once
   * `window.__finishClosing()` is called; `closing` says that one is waiting for it.
   */
  slow: boolean;
  closing: boolean;
}

async function standInPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const picker: Picker = {
      picks: [],
      asked: [],
      refuse: null,
      open: false,
      full: false,
      slow: false,
      closing: false,
    };
    (window as any).__picker = picker;
    (window as any).showSaveFilePicker = async (options: {
      suggestedName: string;
      types: { accept: Record<string, string[]> }[];
    }) => {
      picker.asked.push({
        suggestedName: options.suggestedName,
        extensions: options.types.flatMap((type) => Object.values(type.accept).flat()),
      });
      if (picker.refuse) throw new DOMException('The stand-in save prompt was told to fail.', picker.refuse);
      if (picker.open) await new Promise<void>((answer) => ((window as any).__answerPrompt = answer));
      const name = `picked-${picker.picks.length}-${options.suggestedName}`;
      picker.picks.push(name);
      const directory = await navigator.storage.getDirectory();
      const handle = await directory.getFileHandle(name, { create: true });
      if (!picker.full && !picker.slow) return handle;
      const { full, slow } = picker;
      return {
        createWritable: async () => {
          const writable = await handle.createWritable();
          if (full)
            writable.write = () =>
              Promise.reject(new DOMException('The disk is full.', 'QuotaExceededError'));
          if (slow) {
            const close = writable.close.bind(writable);
            writable.close = async () => {
              picker.closing = true;
              await new Promise<void>((finish) => ((window as any).__finishClosing = finish));
              picker.closing = false;
              return close();
            };
          }
          return writable;
        },
      };
    };
  });
}

const picker = (page: Page): Promise<Picker> => page.evaluate(() => (window as any).__picker);

const setPicker = (page: Page, patch: Partial<Picker>): Promise<void> =>
  page.evaluate((patch) => void Object.assign((window as any).__picker, patch), patch);

/** A picked file as it is on disk now: its size, and its bytes when they are wanted. */
async function picked(page: Page, name: string): Promise<{ size: number; bytes: Buffer }> {
  const file = await page.evaluate(async (name) => {
    const directory = await navigator.storage.getDirectory();
    const file = await (await directory.getFileHandle(name)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { size: file.size, base64: btoa(binary) };
  }, name);
  return { size: file.size, bytes: Buffer.from(file.base64, 'base64') };
}

/**
 * A project in this browser only, with the four-second test clip twice in a small frame, and the
 * export dialog open on a bitrate at which `frames` frames are estimated well above 64 MB.
 */
async function largeExport(page: Page, frames: number): Promise<void> {
  await noReloads(page);
  await standInPicker(page);
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
  await importFixtures(page, ['testsrc.mp4']);
  await page.evaluate((frames) => {
    const { session, cmd } = (window as any).tandem;
    const [asset] = Object.values(session.store.get().assets);
    cmd.seek(0);
    cmd.addAsset(asset);
    cmd.addAsset(asset);
    session.store.commit([{ op: 'settings', patch: { width: 320, height: 180 } }]);
    session.player.setRange({ in: 0, out: frames });
  }, frames);
  await openDialog(page);
}

async function openDialog(page: Page): Promise<void> {
  await page.keyboard.press('Control+e');
  await expect(page.locator('.exp')).toBeVisible();
  const bitrate = page.locator('.exp .row', { hasText: 'Bitrate' }).locator('input');
  // As much as the software H.264 encoder takes: three seconds of it are estimated at 70 MB.
  await bitrate.fill('200');
  await bitrate.press('Enter');
  await expect
    .poll(async () => Number(/≈ ([\d.]+) MB/.exec(await page.locator('.exp__est').innerText())?.[1]))
    .toBeGreaterThan(64);
}

const exportButton = (page: Page) => page.locator('.dialog__foot .btn--primary');

/**
 * Hold the exports of this page where the video encoder is flushed: every frame is drawn and
 * encoded by then, and the file is still to be finished. `window.__held.flushes` counts the
 * exports that have got there, and `window.__held.letGo()` lets them go on.
 */
async function holdAtFlush(page: Page): Promise<void> {
  await page.evaluate(() => {
    const Real = (window as any).VideoEncoder;
    const held = ((window as any).__held = { flushes: 0, letGo: () => {} });
    const hold = new Promise<void>((go) => (held.letGo = go));
    (window as any).VideoEncoder = class extends Real {
      async flush() {
        held.flushes++;
        await hold;
        return super.flush();
      }
    };
  });
}

const heldAtFlush = (page: Page): Promise<number> => page.evaluate(() => (window as any).__held.flushes);

/** What `trackErrors` collected, without the health checks this file fails to keep its projects local. */
const unexpected = (errors: string[]): string[] => errors.filter((e) => !e.endsWith('net::ERR_FAILED'));

test.describe('export to a file on disk', () => {
  test('a large export is written to the file that was picked, and is not downloaded as well', async ({
    page,
  }, info) => {
    const errors = trackErrors(page);
    let downloads = 0;
    page.on('download', () => downloads++);
    await largeExport(page, 90);

    await exportButton(page).click();
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    await expect(page.locator('.exp__done')).toContainText('Saved to the location you chose');
    // Nothing is kept in memory to download a second time.
    await expect(page.getByRole('button', { name: 'Download again' })).toHaveCount(0);
    expect(downloads).toBe(0);

    const { picks, asked } = await picker(page);
    expect(asked).toEqual([{ suggestedName: 'Untitled project.mp4', extensions: ['.mp4'] }]);
    const file = await picked(page, picks[0]);
    // An MP4 begins with its `ftyp` box.
    expect(file.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(file.size).toBeGreaterThan(20_000);
    expect(unexpected(errors)).toEqual([]);

    test.skip(!hasFfprobe(), 'ffprobe not installed');
    const path = info.outputPath('picked.mp4');
    writeFileSync(path, file.bytes);
    const probe = ffprobe(path);
    const video = probe.streams.find((s) => s.codec_type === 'video')!;
    expect(Number(video.width)).toBe(320);
    expect(Number(video.nb_read_frames)).toBe(90);
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true);
    expect(Number(probe.format.duration)).toBeCloseTo(3, 1);
  });

  test('cancelling part-way leaves the picked file empty, and the next export is whole', async ({ page }) => {
    const errors = trackErrors(page);
    await largeExport(page, 240);

    await exportButton(page).click();
    // Under way: frames have been encoded and nothing has been finished.
    await expect
      .poll(async () => Number.parseInt(await page.locator('.exp__pct').innerText(), 10), { timeout: 60_000 })
      .toBeGreaterThan(5);
    await page.getByRole('button', { name: 'Cancel export' }).click();
    // Back on the settings, with nothing said to have failed.
    await expect(exportButton(page)).toHaveText('Export');
    await expect(page.locator('.exp__failed')).toHaveCount(0);
    const first = (await picker(page)).picks[0];
    expect((await picked(page, first)).size).toBe(0);

    await page.evaluate(() => (window as any).tandem.session.player.setRange({ in: 0, out: 90 }));
    await exportButton(page).click();
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    const { picks } = await picker(page);
    expect(picks).toHaveLength(2);
    const second = await picked(page, picks[1]);
    expect(second.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect((await picked(page, first)).size).toBe(0);
    expect(unexpected(errors)).toEqual([]);
  });

  test('a cancel while the file is finished leaves it empty; while it is put in place there is none', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await largeExport(page, 90);
    const dialog = page.getByRole('dialog');
    const stage = dialog.locator('.exp__run .kv dd').first();
    const cancel = dialog.getByRole('button', { name: 'Cancel export' });
    await holdAtFlush(page);

    await exportButton(page).click();
    await expect.poll(() => heldAtFlush(page), { timeout: 100_000 }).toBeGreaterThan(0);
    await expect(stage).toHaveText('Writing file');
    // Cancel is still offered, and it still cancels: the dialog is back on its settings with
    // nothing said to have failed or to be complete, and the picked file has nothing in it.
    await cancel.click();
    await page.evaluate(() => (window as any).__held.letGo());
    await expect(exportButton(page)).toHaveText('Export', { timeout: 60_000 });
    await expect(page.locator('.exp__failed')).toHaveCount(0);
    await expect(page.getByText('Export complete')).toHaveCount(0);
    const first = (await picker(page)).picks[0];
    expect((await picked(page, first)).size).toBe(0);

    // Closing the file is what puts it in the place that was picked, and that cannot be stopped
    // or taken back. While it lasts Cancel is not to be had, and the dialog says so.
    await setPicker(page, { slow: true });
    await exportButton(page).click();
    await expect(page.locator('.exp__run')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await expect.poll(async () => (await picker(page)).closing, { timeout: 100_000 }).toBe(true);
    await expect(stage).toHaveText('Saving file');
    await expect(cancel).toBeDisabled();
    await expect(page.locator('.exp__run')).toContainText('This last step cannot be cancelled.');
    // The keyboard was on the button that is withdrawn, and stays in the dialog.
    await expect(dialog).toBeFocused();
    const second = (await picker(page)).picks[1];
    expect((await picked(page, second)).size).toBe(0);

    await page.evaluate(() => (window as any).__finishClosing());
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
    expect((await picked(page, second)).bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect((await picked(page, first)).size).toBe(0);
    expect(unexpected(errors)).toEqual([]);
    // The export cancelled with its file finished had no encoder left to stop, and did not ask
    // for one to be stopped: the library that encodes remarks on that.
    expect(warnings.filter((text) => text.includes('finalized'))).toEqual([]);
  });

  test('an export with gaps says to cancel while that can be done, and not while its file is put in place', async ({
    page,
  }) => {
    await largeExport(page, 90);
    const dialog = page.getByRole('dialog');
    const stage = dialog.locator('.exp__run .kv dd').first();
    const cancel = dialog.getByRole('button', { name: 'Cancel export' });
    const gaps = dialog.locator('.exp__run .callout--warn');
    // The last half second of what is exported is a clip of a file that is neither on this device
    // nor on a server.
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const p = session.store.get();
      const last = (Object.values(p.clips) as any[])
        .filter((c) => c.type === 'video')
        .sort((a, b) => b.start - a.start)[0];
      const end = last.start + last.duration;
      session.store.commit([
        {
          op: 'addAsset',
          asset: { ...p.assets[last.assetId], id: 'lost', name: 'holiday.mp4', uploaded: false },
        },
        {
          op: 'addClip',
          clip: { ...last, id: 'lost1', assetId: 'lost', name: 'holiday.mp4', start: end, duration: 15 },
        },
      ]);
      session.player.setRange({ in: end - 75, out: end + 15 });
    });
    await expect(exportButton(page)).toHaveText('Export anyway');
    await holdAtFlush(page);
    await setPicker(page, { slow: true });

    await exportButton(page).click();
    await expect.poll(() => heldAtFlush(page), { timeout: 100_000 }).toBeGreaterThan(0);
    await expect(stage).toHaveText('Writing file');
    // The file is still being finished: Cancel is there, and is what the gaps are answered with.
    await expect(cancel).toBeEnabled();
    await expect(gaps).toContainText('This export will have gaps.');
    await expect(gaps).toContainText('Cancel to sort the media out first, or let the export run on.');

    await page.evaluate(() => (window as any).__held.letGo());
    await expect.poll(async () => (await picker(page)).closing, { timeout: 100_000 }).toBe(true);
    await expect(stage).toHaveText('Saving file');
    await expect(cancel).toBeDisabled();
    // The gaps are still listed, and nothing points to a button that is no longer to be had.
    await expect(gaps).toContainText('This export will have gaps.');
    await expect(gaps.locator('.exp__problems li')).toHaveText([
      /“holiday\.mp4” is not on this device or the server, so it is missing from the export\./,
    ]);
    await expect(gaps).not.toContainText('Cancel');
    await expect(gaps).not.toContainText('let the export run on');

    await page.evaluate(() => (window as any).__finishClosing());
    await expect(page.getByText('Exported with gaps')).toBeVisible({ timeout: 100_000 });
    const whole = await picked(page, (await picker(page)).picks[0]);
    expect(whole.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  });

  test('a file that cannot be written fails the export with the reason, and nothing is left in it', async ({
    page,
  }) => {
    await largeExport(page, 90);
    await setPicker(page, { full: true });

    await exportButton(page).click();
    await expect(page.locator('.exp__failed')).toContainText('Export failed. The disk is full.', {
      timeout: 100_000,
    });
    await expect(page.getByText('Export complete')).toHaveCount(0);
    const { picks } = await picker(page);
    expect((await picked(page, picks[0])).size).toBe(0);

    // The dialog is back on its settings, and a file that takes the data gets all of it.
    await setPicker(page, { full: false });
    await exportButton(page).click();
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    const whole = await picked(page, (await picker(page)).picks[1]);
    expect(whole.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  });

  test('closing the save prompt starts nothing; a prompt that fails falls back to a download', async ({
    page,
  }) => {
    await largeExport(page, 90);

    // The person closed the prompt: that is "not now", and the dialog stays as it is.
    await setPicker(page, { refuse: 'AbortError' });
    await exportButton(page).click();
    await expect.poll(async () => (await picker(page)).asked.length).toBe(1);
    await expect(exportButton(page)).toHaveText('Export');
    await expect(page.getByText('Exporting…')).toHaveCount(0);
    await expect(page.locator('.exp__failed')).toHaveCount(0);

    // The browser would not show a prompt at all: the export is built in memory and downloaded.
    await setPicker(page, { refuse: 'SecurityError' });
    const download = page.waitForEvent('download');
    await exportButton(page).click();
    const file = await download;
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    expect(file.suggestedFilename()).toBe('Untitled project.mp4');
    await expect(page.locator('.exp__done')).not.toContainText('Saved to the location you chose');
    expect((await picker(page)).picks).toEqual([]);
  });

  test('a save prompt answered once its dialog has gone starts no export', async ({ page }) => {
    const errors = trackErrors(page);
    await largeExport(page, 90);
    await page.evaluate(() => {
      const Real = (window as any).VideoEncoder;
      (window as any).__encoders = 0;
      (window as any).VideoEncoder = class extends Real {
        constructor(init: unknown) {
          super(init);
          (window as any).__encoders++;
        }
      };
    });
    await setPicker(page, { open: true });
    await exportButton(page).click();
    await expect.poll(async () => (await picker(page)).asked.length).toBe(1);

    // The prompt is the browser's own and stays open over whatever becomes of the page under it.
    // Here the project is left, and the dialog goes with it.
    await page.goBack();
    await expect(page.locator('.home__hero')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.evaluate(() => (window as any).__answerPrompt());
    await expect.poll(async () => (await picker(page)).picks.length).toBe(1);
    // An export that started all the same would have its encoder well within this second. None
    // is made, and the file is left as the prompt made it.
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).__encoders)).toBe(0);
    expect((await picked(page, (await picker(page)).picks[0])).size).toBe(0);
    expect(unexpected(errors)).toEqual([]);
  });
});
