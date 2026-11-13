import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Everything a page of the production build may not do: throw, log an error, ask its own server
 * for a file that is not there, or run into its Content-Security-Policy.
 */
async function watch(
  context: BrowserContext,
): Promise<{ problems: string[]; offline: (off: boolean) => Promise<void> }> {
  const problems: string[] = [];
  let offline = false;
  context.on('weberror', (error) => problems.push(`uncaught: ${error.error().message}`));
  context.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const from = message.location().url;
    // The API says 404 for media a collaborator has not finished uploading; the editor asks again.
    if (text.startsWith('Failed to load resource') && new URL(from).pathname.startsWith('/api/')) return;
    if (offline && /ERR_INTERNET_DISCONNECTED|WebSocket/.test(text)) return;
    problems.push(`console: ${text} (${from})`);
  });
  // A path that is right on the dev server and wrong under /app/ shows up here.
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && !url.pathname.startsWith('/api/')) {
      problems.push(`${response.status()} for ${url.pathname}`);
    }
  });
  await context.exposeBinding('reportPolicyViolation', (_source, what: string) => {
    problems.push(`Content-Security-Policy: ${what}`);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (window as any).reportPolicyViolation(`${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  return {
    problems,
    offline: async (off) => {
      offline = off;
      await context.setOffline(off);
    },
  };
}

const clipCount = (page: Page): Promise<number> =>
  page.evaluate(() => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length);

const meta = (page: Page): Promise<{ shared: boolean; online: boolean; role: string }> =>
  page.evaluate(() => {
    const { shared, online, role } = (window as any).tandem.session.getMeta();
    return { shared, online, role };
  });

async function editorOpen(page: Page): Promise<void> {
  await expect(page.locator('.tl')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => !!(window as any).tandem?.session?.player);
}

test('the production build works in a browser: site, editor, a second person, export, offline', async ({
  page,
  context,
  browser,
}) => {
  const first = await watch(context);

  await test.step('the website links to the editor', async () => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Tandem/);
    expect(await page.locator('a[href="/app/"]').count()).toBeGreaterThan(0);
  });

  await test.step('the editor opens under /app/ with its security headers', async () => {
    const response = await page.goto('/app/');
    const headers = response!.headers();
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    expect(headers['permissions-policy']).toContain('microphone=(self)');
    await expect(page.locator('.home__hero')).toBeVisible();
    // What the build redistributes comes with the licences it is redistributed under.
    const notices = await page.request.get('/app/THIRD_PARTY_NOTICES.txt');
    expect(notices.headers()['content-type']).toContain('text/plain');
    expect(await notices.text()).toContain('SIL OPEN FONT LICENSE');
  });

  await test.step('a new project is shared, takes the sample and plays', async () => {
    await page.locator('.starter').first().click();
    await editorOpen(page);
    expect(page.url()).toContain('/app/#/p/');
    await expect.poll(() => meta(page).then((m) => m.shared)).toBe(true);
    await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
    await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Object.values((window as any).tandem.session.store.get().assets).every((a: any) => a.uploaded),
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    const played = await page.evaluate(async () => {
      const { player } = (window as any).tandem.session;
      const from = player.getFrame();
      player.play();
      await new Promise((r) => setTimeout(r, 2000));
      const frames = player.getFrame() - from;
      player.pause();
      return frames;
    });
    expect(played).toBeGreaterThan(10);
    expect(await page.evaluate(() => (window as any).tandem.session.player.compositor.gl.getError())).toBe(0);
  });

  await test.step('a second person joins by link and their edit arrives', async () => {
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));
    expect(new URL(link).pathname).toBe('/app/');
    const theirs = await browser.newContext();
    const second = await watch(theirs);
    const guest = await theirs.newPage();
    await guest.goto(link);
    await editorOpen(guest);
    await expect.poll(() => clipCount(guest)).toBe(5);
    expect((await meta(guest)).role).toBe('editor');
    await guest.evaluate(() => (window as any).tandem.cmd.addText({ content: 'From the guest' }));
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.values((window as any).tandem.session.store.get().clips).some(
            (c: any) => c.text?.content === 'From the guest',
          ),
        ),
      )
      .toBe(true);
    await theirs.close();
    expect(second.problems).toEqual([]);
  });

  await test.step('the export dialog writes a file', async () => {
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      // A small frame and a second and a half, so that software encoding stays quick.
      session.store.commit([{ op: 'settings', patch: { width: 320, height: 180 } }]);
      session.player.setRange({ in: 100, out: 145 });
    });
    await page.keyboard.press('Control+e');
    await expect(page.locator('.exp')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.locator('.dialog__foot .btn--primary').click();
    const file = await download;
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 100_000 });
    expect(file.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.exp')).toHaveCount(0);
  });

  await test.step('with no network the project opens again, whatever was visited meanwhile', async () => {
    const project = page.url();
    const clips = await clipCount(page);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // Files inside the service worker's scope, opened as pages: neither may become the editor's
    // offline copy.
    const script = await page.evaluate(() => document.querySelector<HTMLScriptElement>('script[src]')!.src);
    const other = await context.newPage();
    await other.goto('/app/favicon.svg');
    await other.goto(script);
    await other.close();

    await first.offline(true);
    await page.goto('/app/');
    await expect(page.locator('.home__hero')).toBeVisible();
    await page.goto(project);
    await editorOpen(page);
    expect(await clipCount(page)).toBe(clips);
    expect((await meta(page)).online).toBe(false);
    await first.offline(false);
  });

  expect(first.problems).toEqual([]);
});
