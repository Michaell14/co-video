import { expect, type BrowserContext, type FileChooser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Page errors and console errors that are not expected noise. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Missing media before upload and the dev-mode double mount are expected.
    if (/404 \(Not Found\)|502 \(Bad Gateway\)|WebSocket/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
}

/**
 * Keep the dev server from reloading a page in the middle of a test because a source file was
 * saved meanwhile: the test would go on in a page that has forgotten everything it set up. The
 * dev server's own socket is taken over and never answered, for every page of the context, so
 * call this before the page is opened. `page.reload()` works as before.
 */
export async function noReloads(target: Page | BrowserContext): Promise<void> {
  const context = 'context' in target ? target.context() : target;
  await context.routeWebSocket(/\/\?token=/, () => {});
}

export async function newProject(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.starter').first().click();
  await expect(page.locator('.tl')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).tandem?.session?.player);
}

/**
 * The file chooser that pressing `key` brings up. A browser hands a chooser to a test only once it
 * has been told to, and that message and the key reach the page by different routes: a command
 * that asks for its files within the key press can be there first, and its chooser then opens
 * where no test sees it. One round trip to the page between the two settles the order.
 */
export async function chooserOnKey(page: Page, key: string): Promise<FileChooser> {
  const asked = page.waitForEvent('filechooser');
  await page.evaluate(() => undefined);
  await page.keyboard.press(key);
  return asked;
}

export async function importFixtures(page: Page, names: string[]): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.evaluate(() => void (window as any).tandem.cmd.importMedia()),
  ]);
  await chooser.setFiles(names.map((n) => join(FIXTURES, n)));
  await page.waitForFunction(
    (n) => Object.keys((window as any).tandem.session.store.get().assets).length >= n,
    names.length,
  );
}

/** Summarise the timeline as `type@start+duration` strings, sorted. */
export function clips(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.values((window as any).tandem.session.store.get().clips)
      .map((c: any) => `${c.type}@${c.start}+${c.duration}`)
      .sort(),
  );
}

export function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function ffprobe(file: string): { streams: Record<string, string>[]; format: Record<string, string> } {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_name,codec_type,width,height,r_frame_rate,nb_read_frames,pix_fmt,color_transfer,color_primaries',
    '-show_entries',
    'format=duration,size',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(out.toString());
}

/** Serve fixture files to the engine lab page. */
export async function openLab(page: Page): Promise<void> {
  await page.route('**/fixtures/*', (route) =>
    route.fulfill({ path: join(FIXTURES, new URL(route.request().url()).pathname.split('/').pop()!) }),
  );
  await page.goto('/lab.html');
  await page.waitForFunction(() => document.title === 'lab-ready');
}
