import { expect, test, type Locator, type Page } from '@playwright/test';
import { newProject, noReloads, trackErrors } from './helpers';

/**
 * The Share dialog, a comment link and the comments panel, used the way people use them: the link
 * is made and copied in the dialog, the guest opens it, and everything that is said about the cut
 * is typed into the panel.
 */
const clipCount = (page: Page): Promise<number> =>
  page.evaluate(() => Object.keys((window as any).tandem.session.store.get().clips).length);

const role = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).tandem.session.getMeta().role);

const shareDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Share project' });

async function openShare(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = shareDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Make a link for `access` in the open Share dialog, the way a person does, and read it. */
async function copyLink(dialog: Locator, access: 'Can edit' | 'Can comment' | 'Can view'): Promise<string> {
  await dialog
    .getByRole('group', { name: 'People with the link' })
    .getByRole('button', { name: access, exact: true })
    .click();
  const field = dialog.getByLabel('Share link');
  // Another level of access is another link: the one that was shown is gone.
  await expect(field).toHaveValue('');
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await expect(field).toHaveValue(/#\/p\/[\w-]+\?t=/);
  await expect(dialog.getByRole('button', { name: 'Copy again' })).toBeVisible();
  return field.inputValue();
}

async function join(page: Page, link: string): Promise<void> {
  await noReloads(page);
  await page.goto(link);
  await expect(page.locator('.tl')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).tandem?.session?.player);
  await expect.poll(() => clipCount(page)).toBe(1);
  // The key in the link is taken out of the address once the server has accepted it.
  await expect(page).toHaveURL(/#\/p\/[\w-]+$/);
}

const comment = (page: Page, text: string): Locator => page.locator('.comment', { hasText: text });

/** The part of a text field's content that is selected. */
const selection = (field: Locator): Promise<string> =>
  field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!));

/**
 * Keep the server's answers to one kind of request back until `answer` is called, so that the page
 * can be looked at while it waits for them. `asked` says how many such requests have been made;
 * `answer` with a status sends that failure in the server's place.
 */
async function holdBack(
  page: Page,
  url: string,
  method: string,
): Promise<{ asked: () => number; answer: (status?: number) => void }> {
  let asked = 0;
  const waiting: ((status?: number) => void)[] = [];
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    asked++;
    const status = await new Promise<number | undefined>((resolve) => waiting.push(resolve));
    if (status) await route.fulfill({ status, json: { error: 'not now' } });
    else await route.fallback();
  });
  return { asked: () => asked, answer: (status) => waiting.splice(0).forEach((go) => go(status)) };
}

/** How wide a control is laid out, whatever the dialog it is in is doing as it opens. */
const widthOf = (control: Locator): Promise<string> => control.evaluate((el) => getComputedStyle(el).width);

/** Long enough for a press that should start nothing to have started it. */
const aMoment = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));

/**
 * Make the page what a browser makes of one served over plain HTTP from a name that is not
 * localhost: everything that is kept for HTTPS is missing from it. Call before the page is opened.
 */
async function overPlainHttp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const gone = (owner: object, names: string[]) => {
      for (const name of names) delete (owner as Record<string, unknown>)[name];
    };
    Object.defineProperty(window, 'isSecureContext', { get: () => false });
    gone(Navigator.prototype, ['clipboard', 'locks', 'mediaDevices', 'serviceWorker', 'storage']);
    gone(Crypto.prototype, ['randomUUID', 'subtle']);
    gone(window, [
      'AudioDecoder',
      'AudioEncoder',
      'ImageDecoder',
      'VideoDecoder',
      'VideoEncoder',
      'VideoFrame',
    ]);
  });
}

test.describe('sharing and review', () => {
  test('a comment link from the Share dialog lets a guest discuss the cut and change nothing', async ({
    page,
    context,
    browser,
  }) => {
    const errors = trackErrors(page);
    await noReloads(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));

    // The owner makes a comment link and copies it.
    const dialog = await openShare(page);
    await expect(dialog.locator('.person')).toHaveCount(1);
    await expect(dialog.locator('.person')).toContainText('(you)');
    await expect(dialog.locator('.person .badge')).toHaveText('Owner');
    // What a link allows is one choice with a name, not three buttons on their own.
    const access = dialog.getByRole('group', { name: 'People with the link' });
    await expect(access.getByRole('button')).toHaveText(['Can edit', 'Can comment', 'Can view']);
    await expect(access.getByRole('button', { pressed: true })).toHaveText('Can edit');
    const link = await copyLink(dialog, 'Can comment');
    await expect(dialog).toContainText('Can watch, scrub and leave time-coded comments.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    // The guest opens it, and the dialog that is still open shows who has joined, and as what.
    const theirs = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guest = await theirs.newPage();
    const guestErrors = trackErrors(guest);
    await join(guest, link);
    expect(await role(guest)).toBe('commenter');
    await expect(dialog.locator('.person')).toHaveCount(2);
    await expect(dialog.locator('.person .badge')).toHaveText(['Owner', 'Can comment']);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // A comment typed by the guest reaches the owner.
    await guest.keyboard.press('Shift+C');
    const composer = guest.getByPlaceholder('Add a comment at the playhead…');
    await composer.fill('Trim this shot');
    await composer.press('Enter');
    await expect(comment(guest, 'Trim this shot')).toBeVisible();
    await expect(composer).toHaveValue('');
    await page.keyboard.press('Shift+C');
    await expect(comment(page, 'Trim this shot')).toBeVisible();

    // The owner answers in the thread.
    await comment(page, 'Trim this shot').getByRole('button', { name: 'Reply' }).click();
    const reply = page.getByPlaceholder('Reply…');
    await reply.fill('Done');
    await reply.press('Enter');
    await expect(comment(guest, 'Trim this shot').locator('.comment__reply')).toContainText('Done');

    // A guest is offered the deletion of their own comment and of nobody else's.
    const note = page.getByPlaceholder('Add a comment at the playhead…');
    await note.fill('Hold the title a little longer');
    await note.press('Enter');
    const theirCard = comment(guest, 'Hold the title a little longer');
    await expect(theirCard.getByRole('button', { name: 'Reply' })).toBeVisible();
    await expect(theirCard.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(comment(guest, 'Trim this shot').getByRole('button', { name: 'Delete' })).toBeVisible();
    await comment(page, 'Hold the title a little longer').getByRole('button', { name: 'Delete' }).click();
    await expect(theirCard).toHaveCount(0);

    // The guest resolves it: it leaves the owner's list and is kept, whole, under Resolved.
    await comment(guest, 'Trim this shot').getByRole('button', { name: 'Resolve' }).click();
    await expect(comment(page, 'Trim this shot')).toHaveCount(0);
    await expect(page.locator('.comments')).toContainText('All caught up');
    await page.getByRole('button', { name: 'Resolved', exact: true }).click();
    await expect(page.locator('.comment--resolved', { hasText: 'Trim this shot' })).toBeVisible();
    await expect(page.locator('.comment--resolved .comment__reply')).toContainText('Done');

    // What the editor lets a commenter do to the cut: nothing, and it says why.
    await guest.locator('.clip').first().click();
    await guest.keyboard.press('Delete');
    await expect(guest.locator('.toast').last()).toContainText(
      'You have comment-only access to this project.',
    );
    await guest.keyboard.press('t');
    await guest.keyboard.press('Control+a');
    await guest.keyboard.press('Shift+Delete');
    await expect.poll(() => clipCount(guest)).toBe(1);
    expect(await clipCount(page)).toBe(1);
    const theirDialog = await openShare(guest);
    await expect(theirDialog).toContainText('You have comment-only access.');
    await expect(theirDialog.getByLabel('Share link')).toHaveCount(0);
    await guest.keyboard.press('Escape');

    // The link's access and the thread are still there after a reload.
    await guest.reload();
    await guest.waitForFunction(() => !!(window as any).tandem?.session?.player);
    await expect.poll(() => role(guest)).toBe('commenter');
    await expect
      .poll(() =>
        guest.evaluate(() =>
          (window as any).tandem.session.review.get().map((c: any) => ({
            text: c.text,
            resolved: c.resolved,
            replies: c.replies.map((r: any) => r.text),
          })),
        ),
      )
      .toEqual([{ text: 'Trim this shot', resolved: true, replies: ['Done'] }]);
    await theirs.close();

    expect(errors).toEqual([]);
    expect(guestErrors).toEqual([]);
  });

  test('over plain HTTP a project is shared and synced all the same, and a link the page cannot copy is not called copied', async ({
    page,
    browser,
  }) => {
    const errors = trackErrors(page);
    await noReloads(page);
    await overPlainHttp(page);
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    expect(
      await page.evaluate(() => [typeof crypto.subtle, typeof navigator.storage, typeof navigator.clipboard]),
    ).toEqual(['undefined', 'undefined', 'undefined']);
    await expect(page.getByRole('alert').filter({ hasText: 'Tandem needs HTTPS' })).toBeVisible();

    // Media needs what the browser withholds here. The connection does not: the top bar says so.
    await expect(page.locator('.conn')).toHaveText('All changes synced');
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));

    // There is no clipboard to copy to. The link is made, and left where it can be copied by hand.
    const dialog = await openShare(page);
    await dialog.getByRole('button', { name: 'Copy link' }).click();
    const field = dialog.getByLabel('Share link');
    await expect(field).toHaveValue(/#\/p\/[\w-]+\?t=/);
    await expect(page.locator('.toast')).toHaveText(
      'This page cannot reach the clipboard. The link is selected: copy it from its field.',
    );
    await expect(field).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();
    const link = await field.inputValue();
    expect(await selection(field)).toBe(link);

    // Every press takes the keyboard off the field, and two presses in one second get the same link
    // from the server: the second leaves it under the keyboard as the first did.
    await page.waitForFunction(() => Date.now() % 1000 < 300);
    for (let press = 0; press < 2; press++) await dialog.getByRole('button', { name: 'Copy link' }).click();
    await expect(field).toBeFocused();
    expect(await selection(field)).toBe(await field.inputValue());
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // What was made here has reached the server: someone who opens the link gets it.
    const theirs = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guest = await theirs.newPage();
    await join(guest, link);
    expect(await role(guest)).toBe('editor');
    await theirs.close();
    expect(errors).toEqual([]);
  });

  test('a view link from the Share dialog lets a guest read the comments and write none', async ({
    page,
    context,
    browser,
  }) => {
    await noReloads(page);
    // A link is copied as it is made, and one that could not be is left in its field instead.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));
    await page.keyboard.press('Shift+C');
    const composer = page.getByPlaceholder('Add a comment at the playhead…');
    await composer.fill('Colour is too warm here');
    await composer.press('Enter');
    await expect(comment(page, 'Colour is too warm here')).toBeVisible();

    const dialog = await openShare(page);
    // Each level of access gets a link of its own.
    const commentLink = await copyLink(dialog, 'Can comment');
    const viewLink = await copyLink(dialog, 'Can view');
    expect(viewLink).not.toBe(commentLink);
    await expect(dialog).toContainText('Read-only. Sees edits live, cannot change or comment.');
    await page.keyboard.press('Escape');

    const theirs = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guest = await theirs.newPage();
    await join(guest, viewLink);
    expect(await role(guest)).toBe('viewer');
    await guest.keyboard.press('Shift+C');
    await expect(comment(guest, 'Colour is too warm here')).toBeVisible();
    await expect(guest.getByLabel('Comment at the playhead')).toBeDisabled();
    await expect(guest.getByLabel('Comment at the playhead')).toHaveAttribute(
      'placeholder',
      'You have view-only access',
    );
    // Nothing on the card offers to answer, resolve or delete.
    await expect(
      comment(guest, 'Colour is too warm here').getByRole('button', { name: /Reply|Resolve|Delete/ }),
    ).toHaveCount(0);
    await theirs.close();
  });

  test('a button that is at work keeps the keyboard, says so and is not pressed twice', async ({
    page,
    context,
  }) => {
    const thrown: string[] = [];
    page.on('pageerror', (e) => thrown.push(e.message));
    await noReloads(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));

    // ── A link, made and copied from the keyboard ──
    const share = page.getByRole('button', { name: 'Share', exact: true });
    await share.focus();
    await page.keyboard.press('Enter');
    const dialog = shareDialog(page);
    const copy = dialog.getByRole('button', { name: 'Copy link' });
    const field = dialog.getByLabel('Share link');
    const invites = await holdBack(page, '**/api/projects/*/invites', 'POST');
    await copy.focus();
    const width = await widthOf(copy);
    await page.keyboard.press('Enter');
    await expect.poll(invites.asked).toBe(1);
    // While the server is asked the button is not switched off, which would drop the keyboard to
    // the page: it is at work and says so, dimmed as a button that is off and of the same size.
    await expect(copy).toBeFocused();
    await expect(copy).toHaveAttribute('aria-busy', 'true');
    await expect(copy).toHaveAttribute('aria-disabled', 'true');
    expect(await widthOf(copy)).toBe(width);
    // Nothing in it moves: over the dialog's live blur that would be the whole page drawn again
    // for every frame.
    await expect.poll(() => copy.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    // Pressed again, by either key or by the pointer, it asks for no second link.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await copy.click({ force: true });
    await aMoment(page);
    expect(invites.asked()).toBe(1);
    await expect(copy).toBeFocused();

    invites.answer();
    const again = dialog.getByRole('button', { name: 'Copy again' });
    await expect(again).toBeFocused();
    await expect(again).not.toHaveAttribute('aria-busy');
    await expect(again).toBeEnabled();
    await expect(field).toHaveValue(/#\/p\/[\w-]+\?t=/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await field.inputValue());
    expect(invites.asked()).toBe(1);
    // Tab goes on from the button, in both directions: not from the top of the dialog.
    await page.keyboard.press('Shift+Tab');
    await expect(field).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(again).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(share).toBeFocused();

    // ── A version, saved from its field and from its button ──
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await menu.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Version history…' }).focus();
    await page.keyboard.press('Enter');
    const versions = page.getByRole('dialog', { name: 'Version history' });
    const name = versions.getByLabel('Version name');
    const save = versions.getByRole('button', { name: 'Save version' });
    const listed = versions.locator('.version');
    await expect(name).toBeFocused();
    await expect(versions).toContainText('No versions yet');
    const saves = await holdBack(page, '**/api/projects/*/versions', 'POST');

    // Enter in the field asks as the button does, and has no button to be refused by: once.
    await page.keyboard.type('First cut');
    await page.keyboard.press('Enter');
    await expect.poll(saves.asked).toBe(1);
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Enter');
    await aMoment(page);
    expect(saves.asked()).toBe(1);
    saves.answer();
    await expect(listed).toHaveCount(1);
    await expect(name).toBeFocused();

    // From the button, which stays where it is and as wide as it was.
    await page.keyboard.type('Second cut');
    await page.keyboard.press('Tab');
    await expect(save).toBeFocused();
    const wide = await widthOf(save);
    await page.keyboard.press('Enter');
    await expect.poll(saves.asked).toBe(2);
    await expect(save).toBeFocused();
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await expect(save).toHaveText('Save version');
    expect(await widthOf(save)).toBe(wide);
    // What else the dialog could start waits for it, and those buttons really are off.
    await expect(listed.getByRole('button', { name: 'Restore' })).toBeDisabled();
    await expect(listed.getByRole('button', { name: 'Restore' })).not.toHaveAttribute('aria-busy');
    await page.keyboard.press('Enter');
    await aMoment(page);
    expect(saves.asked()).toBe(2);
    saves.answer();
    await expect(listed).toHaveCount(2);
    await expect(save).toBeFocused();
    await expect(save).not.toHaveAttribute('aria-busy');
    await page.keyboard.press('Tab');
    const restore = listed.first().getByRole('button', { name: 'Restore' });
    await expect(restore).toBeFocused();

    // ── A version restored: the server fails once, then answers ──
    const loads = await holdBack(page, '**/api/projects/*/versions/*', 'GET');
    const sure = page.getByRole('dialog', { name: /^Restore / });
    await page.keyboard.press('Enter');
    await expect(sure.getByRole('button', { name: 'Restore version' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(loads.asked).toBe(1);
    await expect(restore).toBeFocused();
    await expect(restore).toHaveAttribute('aria-busy', 'true');
    await expect(save).toBeDisabled();
    await expect(listed.nth(1).getByRole('button', { name: 'Restore' })).toBeDisabled();
    loads.answer(500);
    await expect(page.locator('.toast', { hasText: 'Could not load version (500)' })).toBeVisible();
    // Nothing happened, and the keyboard is where it was to ask again.
    await expect(restore).toBeFocused();
    await expect(restore).not.toHaveAttribute('aria-busy');
    await expect(save).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect(sure.getByRole('button', { name: 'Restore version' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(loads.asked).toBe(2);
    loads.answer();
    // Restored, the dialog closes: the keyboard is back at the menu it was called from.
    await expect(page.locator('.toast', { hasText: 'Restored' })).toBeVisible();
    await expect(versions).toHaveCount(0);
    await expect(menu).toBeFocused();
    expect(await clipCount(page)).toBe(1);
    expect(thrown).toEqual([]);
  });
});
