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
    expect(
      await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!)),
    ).toBe(link);
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
    browser,
  }) => {
    await noReloads(page);
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
});
