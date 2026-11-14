import { expect, test, type Locator, type Page } from '@playwright/test';
import { importFixtures, newProject, noReloads } from './helpers';

/**
 * Deleting for good: a shared project from the server, for everyone, by its owner; a version from
 * the history; and from the pool, every file that nothing uses.
 */

const registry = (page: Page): Promise<any[]> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('tandem.projects.v1') ?? '[]'));

const card = (page: Page, name: string): Locator => page.locator('.pcard', { hasText: name });

const toast = (page: Page, text: string): Locator => page.locator('.toast', { hasText: text });

const clipCount = (page: Page): Promise<number> =>
  page.evaluate(() => Object.keys((window as any).tandem.session.store.get().clips).length);

const editorReady = (page: Page) => page.waitForFunction(() => !!(window as any).tandem?.session?.player);

/**
 * What went wrong in a page's own code. The answers a test asks the server for by hand, to see
 * that it refuses, are noted by the browser as failed requests and are not that.
 */
function thrownIn(page: Page): string[] {
  const thrown: string[] = [];
  page.on('pageerror', (error) => thrown.push(error.message));
  return thrown;
}

async function goHome(page: Page): Promise<void> {
  await page.goto('/#/');
  await expect(page.locator('.home__hero')).toBeVisible();
}

interface Shared {
  id: string;
  token: string;
}

/** A project on the collaboration server, named and with one title in it, open in the editor. */
async function sharedProject(page: Page, name: string): Promise<Shared> {
  await newProject(page);
  const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
  test.skip(!meta.online, 'collaboration server not reachable');
  await page.evaluate((name) => {
    const { cmd } = (window as any).tandem;
    cmd.renameProject(name);
    cmd.addText({ content: name });
  }, name);
  await expect
    .poll(async () => (await registry(page)).map((p) => p.name), { timeout: 10_000 })
    .toContain(name);
  await page.waitForFunction(() => (window as any).tandem.session.getMeta().synced);
  return page.evaluate(() => {
    const { session } = (window as any).tandem;
    return { id: session.id, token: session.token };
  });
}

const inviteLink = (page: Page, role: string): Promise<string> =>
  page.evaluate((role) => (window as any).tandem.session.inviteLink(role), role);

/** Open a share link in a browser of its own and wait for the project to have arrived there. */
async function join(guest: Page, link: string): Promise<void> {
  await noReloads(guest);
  await guest.goto(link);
  await editorReady(guest);
  await expect.poll(() => clipCount(guest)).toBe(1);
  await expect(guest).toHaveURL(/#\/p\/[\w-]+$/);
}

/** What the server answers when asked about a project with a link, by hand. */
const asked = (page: Page, project: Shared, method = 'GET'): Promise<number> =>
  page.evaluate(
    async ({ project, method }) =>
      (
        await fetch(`/api/projects/${project.id}`, {
          method,
          headers: { Authorization: `Bearer ${project.token}` },
        })
      ).status,
    { project, method },
  );

/**
 * Keep the server's answers to the deletion of a project back until `answer` is called. With a
 * status the request never reaches the server and is answered with that failure; with `'cut'`
 * the connection is lost instead.
 */
async function holdDeletion(
  page: Page,
  project: Shared,
): Promise<{ asked: () => number; answer: (how?: number | 'cut') => void; stop: () => Promise<void> }> {
  let count = 0;
  const waiting: ((how?: number | 'cut') => void)[] = [];
  const url = `**/api/projects/${project.id}`;
  await page.route(url, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    count++;
    const how = await new Promise<number | 'cut' | undefined>((resolve) => waiting.push(resolve));
    if (how === 'cut') await route.abort();
    else if (how) await route.fulfill({ status: how, json: { error: 'not now' } });
    else await route.fallback();
  });
  return {
    asked: () => count,
    answer: (how) => waiting.splice(0).forEach((go) => go(how)),
    stop: () => page.unroute(url),
  };
}

const deleteDialog = (page: Page, name: string): Locator =>
  page.getByRole('dialog', { name: `Delete “${name}” for everyone?` });

/** The names of the files this device keeps for a project. */
const filesOnDevice = (page: Page, projectId: string): Promise<string[]> =>
  page.evaluate(async (projectId) => {
    const names: string[] = [];
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('tandem')).getDirectoryHandle(projectId);
      for await (const name of (dir as any).keys()) names.push(name);
    } catch {
      // Nothing is kept for the project.
    }
    return names.sort();
  }, projectId);

test.describe('deleting a project for everyone', () => {
  test('the owner deletes from the card, by keyboard; a guest who has the project open keeps a local copy', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    const errors = thrownIn(page);
    await noReloads(page);
    const other = await sharedProject(page, 'Staying');
    const doomed = await sharedProject(page, 'Doomed');
    await importFixtures(page, ['tone.ogg']);
    await page.waitForFunction(() =>
      Object.values((window as any).tandem.session.store.get().assets).every((a: any) => a.uploaded),
    );
    const editorLink = await inviteLink(page, 'editor');
    const viewerLink = await inviteLink(page, 'viewer');

    // An editor has the project open, with its media on their device. A viewer has been and left.
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    const guestErrors = thrownIn(guest);
    await join(guest, editorLink);
    await guest.waitForFunction(() => {
      const { session } = (window as any).tandem;
      return Object.values(session.store.get().assets).every((a: any) => session.media.get(a.id).local);
    });
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await join(viewer, viewerLink);
    await expect.poll(async () => (await registry(viewer)).length, { timeout: 10_000 }).toBe(1);
    await goHome(viewer);

    // Neither is offered to delete it for everyone, and the server refuses whoever asks by hand.
    await card(viewer, 'Doomed').getByRole('button', { name: 'Options for Doomed' }).click();
    await expect(viewer.getByRole('menuitem', { name: 'Delete from this device…' })).toBeVisible();
    await expect(viewer.getByRole('menuitem', { name: 'Delete for everyone…' })).toHaveCount(0);
    await viewer.keyboard.press('Escape');
    const viewerEntry = (await registry(viewer))[0];
    expect(viewerEntry.role).toBe('viewer');
    expect(await asked(viewer, viewerEntry, 'DELETE')).toBe(403);
    const guestEntry = (await registry(guest))[0];
    expect(guestEntry.role).toBe('editor');
    expect(await asked(guest, guestEntry, 'DELETE')).toBe(403);
    expect(await asked(page, doomed)).toBe(200);

    // The owner asks from the card's menu, with the keyboard.
    await goHome(page);
    await expect(page.locator('.pcard')).toHaveCount(2);
    const open = card(page, 'Doomed').locator('.pcard__open');
    await open.focus();
    await page.keyboard.press('Tab');
    await expect(card(page, 'Doomed').getByRole('button', { name: 'Options for Doomed' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete for everyone…' }).focus();
    await page.keyboard.press('Enter');
    const dialog = deleteDialog(page, 'Doomed');
    await expect(dialog).toContainText(
      'The project is deleted from the collaboration server: the edit, its comments, every saved version and every uploaded media file.',
    );
    await expect(dialog).toContainText(
      'Every link to it stops working, for you and for everyone you shared it with.',
    );
    // The keyboard starts on the one choice there is, where no key deletes anything, and the copy
    // on this device is not kept unless that is asked for.
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    const go = dialog.getByRole('button', { name: 'Delete for everyone' });
    const keep = dialog.getByRole('switch', { name: 'Keep a copy on this device' });
    await expect(keep).toBeFocused();
    await expect(keep).toHaveAttribute('aria-checked', 'false');
    await expect(dialog).toContainText(
      'The project and the media stored for it on this device are deleted as well.',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(card(page, 'Doomed').getByRole('button', { name: 'Options for Doomed' })).toBeFocused();
    expect(await asked(page, doomed)).toBe(200);

    // Asked again and meant: the button says that it is at work, and the question stays until
    // the server has answered.
    const held = await holdDeletion(page, doomed);
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete for everyone…' }).focus();
    await page.keyboard.press('Enter');
    await expect(keep).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(go).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(held.asked).toBe(1);
    const working = dialog.getByRole('button', { name: 'Deleting…' });
    await expect(working).toBeFocused();
    await expect(working).toHaveAttribute('aria-busy', 'true');
    await expect(cancel).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    expect(held.asked()).toBe(1);
    held.answer();

    // Gone: the card, the entry and what this device kept. The keyboard is on the card that
    // took its place.
    await expect(dialog).toHaveCount(0);
    await expect(card(page, 'Doomed')).toHaveCount(0);
    await expect(toast(page, 'Deleted “Doomed” for everyone.')).toBeVisible();
    await expect(card(page, 'Staying').locator('.pcard__open')).toBeFocused();
    await held.stop();
    expect((await registry(page)).map((p) => p.id)).toEqual([other.id]);
    await expect.poll(() => filesOnDevice(page, doomed.id)).toEqual([]);
    expect(await asked(page, doomed)).toBe(410);
    expect(await asked(page, doomed, 'DELETE')).toBe(204);
    expect(await asked(page, other)).toBe(200);

    // The guest who had it open is told, and what was on their device is theirs: a local project
    // that is no longer shared, with its media.
    await expect(
      toast(
        guest,
        'This project was deleted from the collaboration server by its owner. Your copy stays on this device and is no longer shared.',
      ),
    ).toBeVisible();
    await guest.waitForFunction(() => !(window as any).tandem.session.getMeta().shared);
    expect(await clipCount(guest)).toBe(1);
    await guest.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Carried on' }));
    expect(await clipCount(guest)).toBe(2);
    // Let the edit reach the device before the project is left.
    await guest.waitForTimeout(1000);
    await goHome(guest);
    const kept = card(guest, 'Doomed');
    await expect(kept.locator('.pcard__unshared')).toContainText('No longer shared');
    await expect(kept.locator('.pcard__shared')).toHaveCount(0);
    await expect(kept.locator('.pcard__open')).toHaveAccessibleDescription(
      'Its owner deleted this project from the collaboration server. This copy stays on this device and is no longer shared.',
    );
    const afterwards = (await registry(guest))[0];
    expect([afterwards.token, afterwards.role, afterwards.deletedByOwner]).toEqual([null, undefined, true]);
    await kept.locator('.pcard__open').click();
    await editorReady(guest);
    expect(await clipCount(guest)).toBe(2);
    const local = await guest.evaluate(() => {
      const { session } = (window as any).tandem;
      return {
        shared: session.getMeta().shared,
        role: session.getMeta().role,
        media: Object.values(session.store.get().assets).map((a: any) => session.media.get(a.id).local),
      };
    });
    expect(local).toEqual({ shared: false, role: 'owner', media: [true] });
    // Nothing they do brings the project back on the server.
    expect(await asked(guest, guestEntry)).toBe(410);

    // Their copy can go on as a project of their own, under an id of its own, media included.
    await guest.getByRole('button', { name: 'Share', exact: true }).click();
    await guest.getByRole('button', { name: 'Publish and share' }).click();
    await guest.waitForFunction((old) => {
      const s = (window as any).tandem?.session;
      return s && s.id !== old && s.getMeta().shared && !!s.player;
    }, doomed.id);
    await guest.waitForFunction(() =>
      Object.values((window as any).tandem.session.store.get().assets).every((a: any) => a.uploaded),
    );
    const republished = await guest.evaluate(async () => {
      const { session } = (window as any).tandem;
      const [asset] = Object.keys(session.store.get().assets);
      const res = await fetch(`/api/projects/${session.id}/media/${asset}?probe`, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      return res.headers.get('Upload-Complete');
    });
    expect(republished).toBe('1');
    expect(await asked(guest, guestEntry)).toBe(410);

    // The viewer, who was not there, finds out on opening the project: the same words, the same copy.
    await card(viewer, 'Doomed').locator('.pcard__open').click();
    await expect(
      toast(viewer, 'This project was deleted from the collaboration server by its owner.'),
    ).toBeVisible();
    await editorReady(viewer);
    expect(await clipCount(viewer)).toBe(1);
    await goHome(viewer);
    await expect(card(viewer, 'Doomed').locator('.pcard__unshared')).toBeVisible();

    // And to someone who only has the link, the project is not available.
    const lateContext = await browser.newContext();
    const late = await lateContext.newPage();
    await noReloads(late);
    await late.goto(editorLink);
    await expect(late.locator('.splash__title')).toHaveText('This project is not available');
    await expect(
      toast(late, 'This project was deleted from the collaboration server by its owner.'),
    ).toBeVisible();
    await goHome(late);
    await expect(late.locator('.pcard')).toHaveCount(0);

    await guestContext.close();
    await viewerContext.close();
    await lateContext.close();
    expect(errors).toEqual([]);
    expect(guestErrors).toEqual([]);
  });

  test('by pointer, keeping a copy: the project stays on this device as a local one', async ({ page }) => {
    const errors = thrownIn(page);
    await noReloads(page);
    const project = await sharedProject(page, 'Keeper');
    await goHome(page);
    await expect(card(page, 'Keeper').locator('.pcard__shared')).toBeVisible();

    await card(page, 'Keeper').hover();
    await card(page, 'Keeper').getByRole('button', { name: 'Options for Keeper' }).click();
    await page.getByRole('menuitem', { name: 'Delete for everyone…' }).click();
    const dialog = deleteDialog(page, 'Keeper');
    await dialog.getByRole('switch', { name: 'Keep a copy on this device' }).click();
    await expect(dialog).toContainText('The project stays in your list as a local project.');
    await dialog.getByRole('button', { name: 'Delete for everyone' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(
      toast(page, 'Deleted “Keeper” from the server. The copy on this device is a local project now.'),
    ).toBeVisible();
    await expect(card(page, 'Keeper')).toHaveCount(1);
    await expect(card(page, 'Keeper').locator('.pcard__shared')).toHaveCount(0);
    // It was the owner's own decision: the card has nothing to explain.
    await expect(card(page, 'Keeper').locator('.pcard__unshared')).toHaveCount(0);
    const [entry] = await registry(page);
    expect([entry.id, entry.token, entry.role]).toEqual([project.id, null, undefined]);
    expect(await asked(page, project)).toBe(410);

    // Nothing is left to delete for everyone; the copy opens and can be worked on.
    await card(page, 'Keeper').getByRole('button', { name: 'Options for Keeper' }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete for everyone…' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await card(page, 'Keeper').locator('.pcard__open').click();
    await editorReady(page);
    expect(await clipCount(page)).toBe(1);
    expect(await page.evaluate(() => (window as any).tandem.session.getMeta().shared)).toBe(false);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Still mine' }));
    expect(await clipCount(page)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('a server that cannot be reached, refuses or fails is said in the question, and nothing is half-done', async ({
    page,
  }) => {
    await noReloads(page);
    const project = await sharedProject(page, 'Stubborn');
    await goHome(page);
    const held = await holdDeletion(page, project);
    await card(page, 'Stubborn').getByRole('button', { name: 'Options for Stubborn' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete for everyone…' }).focus();
    await page.keyboard.press('Enter');
    const dialog = deleteDialog(page, 'Stubborn');
    const go = dialog.getByRole('button', { name: 'Delete for everyone' });
    const problem = dialog.getByRole('alert');
    await go.focus();

    const attempts: [how: number | 'cut', said: RegExp][] = [
      ['cut', /The collaboration server could not be reached\. Nothing was changed on this device\./],
      [500, /The server could not delete the project \(500\)\. Nothing was changed on this device\./],
      [403, /only the owner can delete a project for everyone\. Nothing was deleted\./],
      [429, /Nothing was deleted: try again later\./],
    ];
    for (const [i, [how, said]] of attempts.entries()) {
      await page.keyboard.press('Enter');
      await expect.poll(held.asked).toBe(i + 1);
      // While the answer is out, what was said about the attempt before is not standing there.
      await expect(problem).toHaveCount(0);
      held.answer(how);
      await expect(problem).toHaveText(said);
      // The button is ready again, with the keyboard still on it.
      await expect(go).toBeFocused();
      await expect(go).not.toHaveAttribute('aria-busy');
      // Nothing has changed: the card, its link, the copy on this device, the project on the server.
      await expect(card(page, 'Stubborn').locator('.pcard__shared')).toBeVisible();
      expect((await registry(page))[0]).toMatchObject({
        id: project.id,
        token: project.token,
        role: 'owner',
      });
    }
    expect(await asked(page, project)).toBe(200);

    // The server answers after all.
    await page.keyboard.press('Enter');
    await expect.poll(held.asked).toBe(attempts.length + 1);
    held.answer();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.pcard')).toHaveCount(0);
    // With no card left, the keyboard is where a project is made.
    await expect(page.locator('.starter').first()).toBeFocused();
    await held.stop();
    expect(await registry(page)).toEqual([]);
    expect(await asked(page, project)).toBe(410);
  });
});

test.describe('deleting a version', () => {
  test('from the keyboard: the middle of three goes, and the keyboard moves on to the next', async ({
    page,
    browser,
  }) => {
    const errors = thrownIn(page);
    await noReloads(page);
    await sharedProject(page, 'Versions');
    const viewerLink = await inviteLink(page, 'viewer');
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await menu.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Version history…' }).focus();
    await page.keyboard.press('Enter');
    const versions = page.getByRole('dialog', { name: 'Version history' });
    const name = versions.getByLabel('Version name');
    const listed = versions.locator('.version');
    await expect(name).toBeFocused();
    for (const [i, title] of ['First', 'Second', 'Third'].entries()) {
      await page.keyboard.type(title);
      await page.keyboard.press('Enter');
      await expect(listed).toHaveCount(i + 1);
    }
    // Newest first.
    await expect(listed.locator('b')).toHaveText(['Third', 'Second', 'First']);

    // Tab reaches each row's Restore and then its Delete.
    const remove = (title: string): Locator => versions.getByRole('button', { name: `Delete “${title}”` });
    await page.keyboard.press('Tab');
    await expect(versions.getByRole('button', { name: 'Save version' })).toBeFocused();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    await expect(remove('Second')).toBeFocused();

    // It asks first, with the safe answer under the keyboard, and No means no.
    const sure = page.getByRole('dialog', { name: 'Delete “Second”?' });
    await page.keyboard.press('Enter');
    await expect(sure).toContainText(
      'The version is deleted for everyone in the project and cannot be brought back.',
    );
    await expect(sure.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sure).toHaveCount(0);
    await expect(listed).toHaveCount(3);
    await expect(remove('Second')).toBeFocused();

    // Meant: the row goes, and the keyboard is on the row that took its place.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(sure.getByRole('button', { name: 'Delete version' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(listed.locator('b')).toHaveText(['Third', 'First']);
    await expect(toast(page, 'Deleted “Second”')).toBeVisible();
    await expect(remove('First')).toBeFocused();

    // The last row gone, it is on the one before; the list empty, on the name field.
    const confirmDelete = async (title: string): Promise<void> => {
      const question = page.getByRole('dialog', { name: `Delete “${title}”?` });
      await page.keyboard.press('Enter');
      await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await expect(question).toHaveCount(0);
    };
    await confirmDelete('First');
    await expect(listed.locator('b')).toHaveText(['Third']);
    await expect(remove('Third')).toBeFocused();

    // Someone who may only watch sees the versions, and has no way to restore or delete one.
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await join(viewer, viewerLink);
    await viewer.getByRole('button', { name: 'Menu', exact: true }).click();
    await viewer.getByRole('menuitem', { name: 'Version history…' }).click();
    const theirs = viewer.getByRole('dialog', { name: 'Version history' });
    await expect(theirs.locator('.version b')).toHaveText(['Third']);
    await expect(theirs.locator('.version').getByRole('button')).toHaveCount(0);
    await viewerContext.close();

    await confirmDelete('Third');
    await expect(listed).toHaveCount(0);
    await expect(versions).toContainText('No versions yet');
    await expect(name).toBeFocused();
    expect(errors).toEqual([]);
  });
});

test.describe('removing unused media', () => {
  test('takes every file no clip uses out of the pool in one step, and undo brings them back to play', async ({
    page,
  }) => {
    const errors = thrownIn(page);
    await noReloads(page);
    // In this browser only: what the pool does needs no server.
    await page.route('**/api/health', (route) => route.abort());
    await newProject(page);
    await importFixtures(page, ['testsrc.mp4', 'tone.ogg', 'green.png']);
    const cards = page.locator('.pool .asset');
    await expect(cards).toHaveCount(3);
    const projectId: string = await page.evaluate(() => (window as any).tandem.session.id);
    const assetIds: Record<string, string> = await page.evaluate(() =>
      Object.fromEntries(
        (Object.values((window as any).tandem.session.store.get().assets) as any[]).map((a) => [
          a.name,
          a.id,
        ]),
      ),
    );
    await expect.poll(() => filesOnDevice(page, projectId)).toHaveLength(3);

    // The still is on the timeline; the film and the sound are in the pool and nowhere else.
    await page.evaluate((id) => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addAsset(session.store.get().assets[id]);
    }, assetIds['green.png']);
    expect(await clipCount(page)).toBe(1);
    const steps = (): Promise<number> =>
      page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);
    const before = await steps();

    const clear = page.locator('.pool').getByRole('button', { name: 'Remove unused media…' });
    await clear.focus();
    await page.keyboard.press('Enter');
    const sure = page.getByRole('dialog', { name: 'Remove 2 unused files?' });
    const sizes = await page.evaluate(() => {
      const { session } = (window as any).tandem;
      return (Object.values(session.store.get().assets) as any[])
        .filter((a) => a.kind !== 'image')
        .reduce((sum, a) => sum + a.size, 0);
    });
    expect(sizes).toBeGreaterThan(0);
    await expect(sure).toContainText(
      /Nothing on the timeline uses them: 2 files, [\d.]+ (KB|MB) in all\. Undo brings them back\./,
    );
    await expect(sure.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sure.getByRole('button', { name: 'Remove 2 files' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('aria-label', 'green.png');
    await expect(clear).toBeFocused();
    expect(await clipCount(page)).toBe(1);
    expect(await steps()).toBe(before + 1);
    // An undo may ask for the files again, so the device still has them.
    expect(await filesOnDevice(page, projectId)).toHaveLength(3);

    // Asked again with nothing left to remove, it says so.
    await page.keyboard.press('Enter');
    await expect(
      toast(page, 'Every file in the media pool is used on the timeline. There is nothing to remove.'),
    ).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await steps()).toBe(before + 1);

    // One undo brings both back, and they are there to be played.
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await expect(cards).toHaveCount(3);
    await expect(page.locator('.pool .asset[data-offline="true"]')).toHaveCount(0);
    const picture = await page.evaluate(async (id) => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(60);
      cmd.addAsset(session.store.get().assets[id]);
      cmd.seek(75);
      // Until the decoder has delivered the frame and it has been drawn.
      await new Promise((r) => setTimeout(r, 1500));
      const d: Uint8Array = session.player.compositor.readPixels();
      return new Set(Array.from(d.filter((_, i) => i % 4 !== 3 && i % 397 === 0))).size;
    }, assetIds['testsrc.mp4']);
    // A test pattern, not one flat colour.
    expect(picture).toBeGreaterThan(8);

    // Removed for good and the project opened again, the device lets go of the file as well.
    await page.evaluate((id) => {
      const { session } = (window as any).tandem;
      session.store.commit([{ op: 'removeAsset', id }]);
    }, assetIds['tone.ogg']);
    await expect(cards).toHaveCount(2);
    await page.waitForTimeout(1000);
    await page.reload();
    await editorReady(page);
    await expect
      .poll(() => filesOnDevice(page, projectId))
      .toEqual([assetIds['green.png'], assetIds['testsrc.mp4']].sort());
    expect(errors).toEqual([]);
  });

  test('is not offered to someone who may not edit', async ({ page, browser }) => {
    await noReloads(page);
    await sharedProject(page, 'Pool');
    await importFixtures(page, ['green.png']);
    await expect(page.locator('.pool').getByRole('button', { name: 'Remove unused media…' })).toBeVisible();
    const editorLink = await inviteLink(page, 'editor');
    const viewerLink = await inviteLink(page, 'viewer');
    for (const [link, offered] of [
      [viewerLink, 0],
      [editorLink, 1],
    ] as const) {
      const context = await browser.newContext();
      const guest = await context.newPage();
      await join(guest, link);
      await expect(guest.locator('.pool .asset')).toHaveCount(1);
      await expect(guest.locator('.pool').getByRole('button', { name: 'Import media' })).toBeVisible();
      await expect(guest.locator('.pool').getByRole('button', { name: 'Remove unused media…' })).toHaveCount(
        offered,
      );
      await context.close();
    }
  });
});

test.describe('what a device keeps of a project that is deleted from it', () => {
  test('is nothing, also when an import was still being saved', async ({ page }) => {
    await noReloads(page);
    await page.route('**/api/health', (route) => route.abort());
    await newProject(page);
    await importFixtures(page, ['green.png']);
    const projectId: string = await page.evaluate(() => (window as any).tandem.session.id);
    await expect.poll(() => filesOnDevice(page, projectId)).toHaveLength(1);
    // A second file, which takes eight seconds to read: its copy is under way for that long.
    await page.evaluate(() => {
      let sent = 0;
      const slow = {
        name: 'slow.bin',
        size: 80 * 65536,
        stream: () =>
          new ReadableStream({
            async pull(controller) {
              if (sent++ >= 80) return controller.close();
              await new Promise((r) => setTimeout(r, 100));
              controller.enqueue(new Uint8Array(65536));
            },
          }),
      };
      void (window as any).tandem.session.media.import('asset_being_saved', slow);
    });
    await expect.poll(() => filesOnDevice(page, projectId)).toContain('asset_being_saved.crswap');
    await expect.poll(async () => (await registry(page)).length, { timeout: 10_000 }).toBe(1);

    await goHome(page);
    await page
      .locator('.pcard')
      .getByRole('button', { name: /^Options for / })
      .focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete from this device…' }).focus();
    await page.keyboard.press('Enter');
    const sure = page.getByRole('dialog', { name: /from this device\?$/ });
    await expect(sure.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.pcard')).toHaveCount(0);
    // The card went with its project, and the keyboard is where the next one is made.
    await expect(page.locator('.starter').first()).toBeFocused();

    // The copy that was being written is stopped, and the directory goes with everything in it.
    const kept = (): Promise<string[]> =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of ((await root.getDirectoryHandle('tandem')) as any).keys()) names.push(name);
        return names;
      });
    await expect.poll(kept).toEqual([]);
    // Still nothing once the file would have been read to its end.
    await page.waitForTimeout(9000);
    expect(await kept()).toEqual([]);
    const databases = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
    expect(databases.filter((name) => name?.includes(projectId))).toEqual([]);
  });
});
