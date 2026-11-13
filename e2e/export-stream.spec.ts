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
  /** Hand out files whose every write fails, as on a disk that has no room. */
  full: boolean;
}

async function standInPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const picker: Picker = { picks: [], asked: [], refuse: null, full: false };
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
      const name = `picked-${picker.picks.length}-${options.suggestedName}`;
      picker.picks.push(name);
      const directory = await navigator.storage.getDirectory();
      const handle = await directory.getFileHandle(name, { create: true });
      if (!picker.full) return handle;
      return {
        createWritable: async () => {
          const writable = await handle.createWritable();
          writable.write = () => Promise.reject(new DOMException('The disk is full.', 'QuotaExceededError'));
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
});
