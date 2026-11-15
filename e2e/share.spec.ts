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

async function join(page: Page, link: string, clips = 1): Promise<void> {
  await noReloads(page);
  await page.goto(link);
  await expect(page.locator('.tl')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).tandem?.session?.player);
  await expect.poll(() => clipCount(page)).toBe(clips);
  // The key in the link is taken out of the address once the server has accepted it.
  await expect(page).toHaveURL(/#\/p\/[\w-]+$/);
}

const comment = (page: Page, text: string): Locator => page.locator('.comment', { hasText: text });

/** The comments as the panel lists them: what each says and the timecode it is pinned to. */
const thread = (page: Page): Promise<string[]> =>
  page
    .locator('.comment')
    .evaluateAll((cards) =>
      cards.map(
        (card) =>
          `${card.querySelector('.comment__text')!.textContent} @ ${card.querySelector('.comment__tc')!.textContent}`,
      ),
    );

/**
 * The shot a comment is on, and how many frames into it: what has to stay the same when a ripple
 * moves the shot. Null when the comment stands on no shot.
 */
const shotUnder = (page: Page, text: string): Promise<string | null> =>
  page.evaluate((text) => {
    const { session } = (window as any).tandem;
    const { frame } = session.review.get().find((c: any) => c.text === text);
    const shot = (Object.values(session.store.get().clips) as any[]).find(
      (c) => c.type === 'video' && c.start <= frame && frame < c.start + c.duration,
    );
    return shot ? `${shot.name}+${frame - shot.start}` : null;
  }, text);

/** Where the pin of the comment at `timecode` is drawn on the timeline's ruler, in frames. */
const pinnedAt = (page: Page, timecode: string): Promise<number> =>
  page.locator(`.ruler__comment[aria-label$=" at ${timecode}"]`).evaluate((pin: HTMLElement) => {
    const { ppf, scrollX } = (window as any).tandem.ui.getState();
    return Math.round((parseFloat(pin.style.left) + scrollX) / ppf);
  });

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
 * What a keyboard goes on sending for a key that is down and stays down: the press again and
 * again, marked as a repeat. Then long enough for those to have started what they should not.
 */
async function keepDown(page: Page, key: string): Promise<void> {
  for (let n = 0; n < 3; n++) await page.keyboard.down(key);
  await aMoment(page);
}

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

  test('a note pinned to a shot stays on it when the owner ripples the cut, for both of them, and returns with the undo', async ({
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
    // The bundled sample: three shots of four seconds on V1, a title over the first, music under all.
    await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
    await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });

    const dialog = await openShare(page);
    const link = await copyLink(dialog, 'Can comment');
    await page.keyboard.press('Escape');
    const theirs = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guest = await theirs.newPage();
    const guestErrors = trackErrors(guest);
    await join(guest, link, 5);
    const guestName: string = await guest.evaluate(() => (window as any).tandem.session.getMeta().user.name);

    // The guest pins a note ten frames into the third shot and one into the second; the owner one
    // on the first.
    const seek = (who: Page, frame: number) =>
      who.evaluate((frame) => (window as any).tandem.cmd.seek(frame), frame);
    await guest.keyboard.press('Shift+C');
    const theirBox = guest.getByPlaceholder('Add a comment at the playhead…');
    await seek(guest, 250);
    await theirBox.fill('Hold this a beat longer');
    await theirBox.press('Enter');
    await seek(guest, 130);
    await theirBox.fill('Tighten');
    await theirBox.press('Enter');
    await page.keyboard.press('Shift+C');
    await expect(comment(page, 'Tighten')).toBeVisible();
    const box = page.getByPlaceholder('Add a comment at the playhead…');
    await seek(page, 60);
    await box.fill('Cold open');
    await box.press('Enter');
    const pinned = [
      'Cold open @ 00:00:02:00',
      'Tighten @ 00:00:04:10',
      'Hold this a beat longer @ 00:00:08:10',
    ];
    for (const who of [page, guest]) {
      await expect.poll(() => thread(who)).toEqual(pinned);
      expect(await shotUnder(who, 'Hold this a beat longer')).toBe('aurora.mp4+10');
      expect(await pinnedAt(who, '00:00:08:10')).toBe(250);
    }

    // The owner ripple-deletes the first shot: the two shots after it come up by four seconds.
    const first: string = await page.evaluate(
      () =>
        (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
          (c) => c.name === 'dusk.mp4',
        ).id,
    );
    await page.locator(`.clip[data-clip="${first}"]`).click();
    await page.keyboard.press('Shift+Delete');
    const moved = [
      'Cold open @ 00:00:00:00',
      'Tighten @ 00:00:00:10',
      'Hold this a beat longer @ 00:00:04:10',
    ];
    for (const who of [page, guest]) {
      // Both read the same timecodes, in the order of the frames: the note on the shot that was
      // removed stands on the cut it left, the others where they were on their shots.
      await expect.poll(() => thread(who)).toEqual(moved);
      expect(await shotUnder(who, 'Hold this a beat longer')).toBe('aurora.mp4+10');
      expect(await shotUnder(who, 'Tighten')).toBe('fractal.mp4+10');
      expect(await pinnedAt(who, '00:00:04:10')).toBe(130);
      await expect(who.locator('.ruler__comment')).toHaveCount(3);
      await expect(who.locator('.ruler__comment[aria-label$=" at 00:00:08:10"]')).toHaveCount(0);
    }
    // The guest's playhead is still on frame 130, which is now the note on the third shot.
    await expect(comment(guest, 'Hold this a beat longer')).toHaveAttribute('data-current', 'true');
    await expect(comment(guest, 'Tighten')).toHaveAttribute('data-current', 'false');
    // It is still the guest's note, and nothing about it says that someone else touched it: the
    // guest may delete it, the owner's copy names the guest, and the thread is as it was.
    const theirCard = comment(guest, 'Hold this a beat longer');
    await expect(theirCard.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(comment(guest, 'Cold open').getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(comment(page, 'Hold this a beat longer').locator('.comment__head b')).toHaveText(guestName);
    await expect(comment(page, 'Hold this a beat longer')).not.toHaveClass(/comment--resolved/);
    await expect(comment(page, 'Hold this a beat longer').locator('.comment__reply')).toHaveCount(0);

    // What the guest does to a note meanwhile is kept when the owner takes the edit back: the
    // answer and the resolved state stay, and only the frames return. One press of undo for all.
    await comment(guest, 'Tighten').getByRole('button', { name: 'Reply' }).click();
    const reply = guest.getByPlaceholder('Reply…');
    await reply.fill('From the wide, please');
    await reply.press('Enter');
    await comment(guest, 'Cold open').getByRole('button', { name: 'Resolve' }).click();
    await expect(comment(page, 'Cold open')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    for (const who of [page, guest]) {
      await expect.poll(() => thread(who)).toEqual(pinned.slice(1));
      expect(await shotUnder(who, 'Hold this a beat longer')).toBe('aurora.mp4+10');
      expect(await pinnedAt(who, '00:00:08:10')).toBe(250);
      await expect(comment(who, 'Tighten').locator('.comment__reply')).toContainText('From the wide, please');
    }
    expect(
      await guest.evaluate(() =>
        (window as any).tandem.session.review
          .get()
          .map((c: any) => [c.text, c.frame, c.resolved, c.replies.length]),
      ),
    ).toEqual([
      ['Cold open', 60, true, 0],
      ['Tighten', 130, false, 1],
      ['Hold this a beat longer', 250, false, 0],
    ]);

    // And the redo moves them again.
    await page.keyboard.press('Control+Shift+z');
    for (const who of [page, guest]) await expect.poll(() => thread(who)).toEqual(moved.slice(1));
    await theirs.close();

    expect(errors).toEqual([]);
    expect(guestErrors).toEqual([]);
  });

  test('notes a guest pins, moves and deletes while the owner drags the speed slider stay on their shots, for both of them, and the drag is one step to undo', async ({
    page,
    context,
    browser,
  }) => {
    const errors = trackErrors(page);
    await noReloads(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // The owner's clock runs as any clock does until the drag below holds it for a moment.
    await page.clock.install();
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    // The bundled sample: three shots of four seconds on V1, a title over the first, music under all.
    await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
    await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });

    const dialog = await openShare(page);
    const link = await copyLink(dialog, 'Can comment');
    await page.keyboard.press('Escape');
    const theirs = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guest = await theirs.newPage();
    const guestErrors = trackErrors(guest);
    await join(guest, link, 5);

    await guest.keyboard.press('Shift+C');
    const box = guest.getByPlaceholder('Add a comment at the playhead…');
    /** The guest pins a note at `frame`, typed into the panel at the playhead. */
    const pin = async (frame: number, text: string) => {
      await guest.evaluate((frame) => (window as any).tandem.cmd.seek(frame), frame);
      await box.fill(text);
      await box.press('Enter');
      await expect(comment(guest, text)).toBeVisible();
    };
    /** The guest moves the note that says `text` to `frame`. */
    const move = (text: string, frame: number) =>
      guest.evaluate(
        ([text, frame]) => {
          const { review } = (window as any).tandem.session;
          review.update(review.get().find((c: any) => c.text === text).id, { frame });
        },
        [text, frame] as const,
      );
    const [second, third] = await page.evaluate(() =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === 'video')
        .sort((a, b) => a.start - b.start)
        .slice(1)
        .map((c) => c.id as string),
    );
    /** The second and third shots and the frame of every note, as one of the two has them. */
    const state = (who: Page) =>
      who.evaluate(
        ([second, third]) => {
          const { session } = (window as any).tandem;
          const { clips } = session.store.get();
          return {
            second: { start: clips[second].start as number, duration: clips[second].duration as number },
            third: clips[third].start as number,
            notes: Object.fromEntries(
              session.review.get().map((c: any) => [c.text, c.frame] as const),
            ) as Record<string, number>,
          };
        },
        [second, third],
      );
    type State = Awaited<ReturnType<typeof state>>;
    const steps = () =>
      page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length as number);

    // Where each note belongs, by what it says: so many frames into its shot.
    const belongs: Record<string, (s: State) => number> = {
      'Hold this a beat longer': (s) => s.third + 10,
      Tighten: (s) => s.second.start + 10,
      'Too dark': (s) => s.third + 60,
    };
    await pin(250, 'Hold this a beat longer');
    await pin(130, 'Tighten');
    await pin(300, 'Too dark');
    await expect.poll(async () => Object.keys((await state(page)).notes).length).toBe(3);

    /**
     * Wait until the owner's drag has rested and written the notes where it has them, and the
     * guest sees the same. Every note is then where it belongs, and no other note is there.
     */
    const rest = async (): Promise<State> => {
      await expect
        .poll(async () => {
          const s = await state(page);
          return Object.fromEntries(
            Object.entries(s.notes).map(([text, frame]) => [text, frame - (belongs[text]?.(s) ?? NaN)]),
          );
        })
        .toEqual(Object.fromEntries(Object.keys(belongs).map((text) => [text, 0])));
      const owner = await state(page);
      await expect.poll(() => state(guest)).toEqual(owner);
      return owner;
    };

    // The owner drags the speed slider of the second shot under ripple editing. 100% lies three
    // sevenths along it.
    await page.locator(`.clip[data-clip="${second}"]`).click();
    await page.keyboard.press('r');
    const inspector = page.locator('[aria-label="Inspector"]');
    await inspector.locator('.section__head', { hasText: 'Speed' }).click();
    const track = (await inspector
      .locator('.section', { hasText: 'Presets' })
      .locator('.slider')
      .first()
      .boundingBox())!;
    const y = track.y + track.height / 2;
    const at = (step: number) => page.mouse.move(track.x + track.width * (3 / 7 + step * 0.02), y);
    const before = { state: await state(page), steps: await steps() };
    await page.mouse.move(track.x + (track.width * 3) / 7, y);
    await page.mouse.down();
    await at(2);
    const mid = await rest();
    expect(mid.third).toBeLessThan(before.state.third);

    // While the owner's button is still down, the guest goes by the picture as it is now: a note
    // twenty frames into the third shot and one five frames before the end of the second, the
    // note on the second moved forty frames into the third, and the one sixty frames in deleted.
    const late = mid.second.duration - 5;
    await pin(mid.third + 20, 'Warmer here');
    await pin(mid.second.start + late, 'Cut before the turn');
    await move('Tighten', mid.third + 40);
    await comment(guest, 'Too dark').getByRole('button', { name: 'Delete' }).click();
    await expect(comment(guest, 'Too dark')).toHaveCount(0);
    const put: Record<string, number> = {
      Tighten: mid.third + 40,
      'Warmer here': mid.third + 20,
      'Cut before the turn': mid.second.start + late,
    };
    await expect
      .poll(async () => (await state(page)).notes)
      .toEqual({ ...put, 'Hold this a beat longer': mid.third + 10 });
    belongs.Tighten = (s) => s.third + 40;
    delete belongs['Too dark'];
    belongs['Warmer here'] = (s) => s.third + 20;
    // On the second shot, which is at the cut while the shot is shorter than that.
    belongs['Cut before the turn'] = (s) => s.second.start + Math.min(late, s.second.duration);

    // Faster still, which takes out the time the note on the second was pinned in, then slower
    // than the shot began, which puts it back.
    await at(5);
    const faster = await rest();
    expect(faster.second.duration).toBeLessThan(late);
    expect(faster.notes['Cut before the turn']).toBe(faster.third);

    // A step moves the shots at once and writes the notes once the pointer has rested. A note the
    // guest moves in that wait is left where the guest put it. The owner's clock is held at the
    // step, so that the wait lasts until the guest's move has come in. A clock is only held at a
    // time still to come, and the page's goes on while it is asked for it.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await at(-3);
    const slower = await state(page);
    expect(slower.third).toBeGreaterThan(faster.third);
    expect(slower.notes).toEqual(faster.notes);
    await expect.poll(async () => (await state(guest)).third).toBe(slower.third);
    await move('Warmer here', slower.third + 30);
    await expect.poll(async () => (await state(page)).notes['Warmer here']).toBe(slower.third + 30);
    expect((await state(page)).notes['Hold this a beat longer']).toBe(faster.third + 10);
    await page.clock.resume();
    put['Warmer here'] = slower.third + 30;
    belongs['Warmer here'] = (s) => s.third + 30;
    await rest();
    await at(-5);
    const after = await rest();
    expect(after.second.duration).toBeGreaterThan(late);
    expect(after.third).toBeGreaterThan(before.state.third);
    await page.mouse.up();
    expect(await steps()).toBe(before.steps + 1);

    // One step to undo, for both of them: the shots return, the first note to where it was pinned
    // before the drag and the others to where the guest put them, and the deleted note stays gone.
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    for (const who of [page, guest]) {
      await expect
        .poll(() => state(who))
        .toEqual({ ...before.state, notes: { ...put, 'Hold this a beat longer': 250 } });
    }
    await page.evaluate(() => (window as any).tandem.cmd.redo());
    for (const who of [page, guest]) await expect.poll(() => state(who)).toEqual(after);
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
    // The last press of all is not let go until after the answer.
    await page.keyboard.down('Enter');
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
    // A key that stays down repeats. This one was refused by the button at work, and is not a
    // press of the button now that it would act again.
    await keepDown(page, 'Enter');
    await page.keyboard.up('Enter');
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
    // Asked again while that is saved, with a key that then stays down.
    await page.keyboard.down('Enter');
    await aMoment(page);
    expect(saves.asked()).toBe(1);
    saves.answer();
    await expect(listed).toHaveCount(1);
    await expect(save).not.toHaveAttribute('aria-busy');
    await expect(name).toBeFocused();
    // Still down once the version is there, it saves no second one from the emptied field.
    await keepDown(page, 'Enter');
    await page.keyboard.up('Enter');
    expect(saves.asked()).toBe(1);

    // From the button, which stays where it is and as wide as it was. The key that presses it
    // stays down, as a key easily does for longer than a server takes to answer.
    await page.keyboard.type('Second cut');
    await page.keyboard.press('Tab');
    await expect(save).toBeFocused();
    const wide = await widthOf(save);
    await page.keyboard.down('Enter');
    await expect.poll(saves.asked).toBe(2);
    await expect(save).toBeFocused();
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await expect(save).toHaveText('Save version');
    expect(await widthOf(save)).toBe(wide);
    // What else the dialog could start waits for it, and those buttons really are off.
    await expect(listed.getByRole('button', { name: 'Restore' })).toBeDisabled();
    await expect(listed.getByRole('button', { name: 'Restore' })).not.toHaveAttribute('aria-busy');
    await keepDown(page, 'Enter');
    expect(saves.asked()).toBe(2);
    saves.answer();
    await expect(listed).toHaveCount(2);
    await expect(save).toBeFocused();
    await expect(save).not.toHaveAttribute('aria-busy');
    // The button is ready again under a key that has not come up. That key has saved its version:
    // one long Enter is one version, not one for every repeat the answer left time for.
    await keepDown(page, 'Enter');
    expect(saves.asked()).toBe(2);
    // Let go and pressed anew, it saves the next.
    await page.keyboard.up('Enter');
    await page.keyboard.press('Enter');
    await expect.poll(saves.asked).toBe(3);
    // Space presses a button as it comes up. Let down while the button is at work and let go once
    // it is ready again, it was refused when it went down and presses nothing.
    await page.keyboard.down('Space');
    await aMoment(page);
    saves.answer();
    await expect(listed).toHaveCount(3);
    await expect(save).toBeFocused();
    await expect(save).not.toHaveAttribute('aria-busy');
    await page.keyboard.up('Space');
    await aMoment(page);
    expect(saves.asked()).toBe(3);
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
