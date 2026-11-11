import { expect, test, type Browser, type Page } from '@playwright/test';
import { clips, importFixtures, newProject } from './helpers';

/** `track:start+duration` for every clip, sorted, with tracks named V1, A1, … */
function layout(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const p = (window as any).tandem.session.store.get();
    const name = (id: string) => `${p.tracks[id].kind === 'video' ? 'V' : 'A'}${p.tracks[id].order + 1}`;
    return (Object.values(p.clips) as any[]).map((c) => `${name(c.trackId)}:${c.start}+${c.duration}`).sort();
  });
}

function meta(page: Page): Promise<{
  role: string;
  shared: boolean;
  status: string;
  synced: boolean;
  busy: boolean;
  denied: boolean;
  online: boolean;
}> {
  return page.evaluate(() => {
    const { player: _player, user: _user, ...rest } = (window as any).tandem.session.getMeta();
    return rest;
  });
}

const registry = (page: Page): Promise<{ id: string; token: string | null; role?: string }[]> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('tandem.projects.v1') ?? '[]'));

/** The newest toast that says `text`. */
const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text }).last();

/** Start counting toasts as they appear, so one that is still on screen is not taken for a new one. */
async function watchToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = ((window as any).__toasts = []);
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof HTMLElement && n.classList.contains('toast')) seen.push(n.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true });
  });
}

/** How many toasts containing `text` have appeared since `watchToasts`. */
const toastCount = (page: Page, text: string): Promise<number> =>
  page.evaluate(
    (text) => ((window as any).__toasts as string[]).filter((t) => t.includes(text)).length,
    text,
  );

/** Open the command palette and type into it once it has the keyboard. */
async function searchPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k');
  const input = page.locator('.palette input');
  await expect(input).toBeFocused();
  await input.fill(query);
  await expect(page.locator('.palette__item')).toHaveCount(1);
}

const editorReady = (page: Page) => page.waitForFunction(() => !!(window as any).tandem?.session?.player);

async function goHome(page: Page): Promise<void> {
  await page.goto('/#/');
  await expect(page.locator('.home__hero')).toBeVisible();
}

/** Two copies of the test clip back to back: picture on V1 and its linked sound on A1, 120 frames each. */
async function twoLinkedClips(page: Page): Promise<void> {
  await importFixtures(page, ['testsrc.mp4']);
  await page.evaluate(() => {
    const { session, cmd } = (window as any).tandem;
    const asset = Object.values(session.store.get().assets)[0];
    cmd.seek(0);
    cmd.addAsset(asset);
    cmd.addAsset(asset);
    cmd.seek(0);
  });
  expect(await layout(page)).toEqual(['A1:0+120', 'A1:120+120', 'V1:0+120', 'V1:120+120']);
}

/** Press a key the way a keyboard with another layout would report it. */
function press(
  page: Page,
  init: { key: string; code: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean },
): Promise<void> {
  return page.evaluate(
    (init) =>
      void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })),
    init,
  );
}

/**
 * A project that lives in this browser only. These tests are about editing, so they leave the
 * collaboration server alone (it also limits how many projects one address may create in an hour).
 */
async function newLocalProject(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
  expect((await meta(page)).shared).toBe(false);
}

/** For tests that need a shared project: skip where no server took the one just created. */
async function skipWithoutServer(page: Page): Promise<void> {
  const { online, shared } = await meta(page);
  test.skip(!online || !shared, 'no collaboration server, or it is not taking new projects');
}

/** A second person: their own browser profile, opened on `link`. */
async function join(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  return page;
}

test.describe('editing commands', () => {
  test('a locked track is out of reach of Select All, linked selection and every command', async ({
    page,
  }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    await page.locator('.tl [aria-label="Lock track"]').nth(2).click();
    const locked = await page.evaluate(() => {
      const p = (window as any).tandem.session.store.get();
      return (Object.values(p.tracks) as any[]).filter((t) => t.locked).map((t) => `${t.kind}${t.order}`);
    });
    expect(locked).toEqual(['audio0']);

    // Select All takes the picture only.
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().selection.length)).toBe(2);
    // Clicking a clip does not drag its linked partner on the locked track into the selection.
    await page.locator('.clip').first().click();
    const picked = await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      return ui.getState().selection.map((id: string) => session.store.get().clips[id].type);
    });
    expect(picked).toEqual(['video']);

    // The tools that work on a clip under the pointer leave that partner alone too. The blade:
    const start = ['A1:0+120', 'A1:120+120', 'V1:0+120', 'V1:120+120'];
    const sound = start.slice(0, 2);
    const [first, second]: string[] = await page.evaluate(() =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === 'video')
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id),
    );
    await page.evaluate(() => (window as any).tandem.cmd.setTool('blade'));
    await page.locator(`[data-clip="${first}"]`).click();
    const cut = await layout(page);
    expect(cut).toHaveLength(5);
    expect(cut.filter((c) => c.startsWith('A1'))).toEqual(sound);
    await page.keyboard.press('Control+z');
    // A drag on an edge:
    await page.evaluate(() => (window as any).tandem.cmd.setTool('select'));
    const drag = async (from: { x: number; y: number; width: number; height: number }, by: number) => {
      const x = from.x + from.width / 2;
      const y = from.y + from.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + by, y, { steps: 6 });
      await page.mouse.up();
    };
    await drag((await page.locator(`[data-clip="${second}"] .clip__trim--r`).boundingBox())!, -60);
    const trimmed = await layout(page);
    expect(trimmed).not.toContain('V1:120+120');
    expect(trimmed.filter((c) => c.startsWith('A1'))).toEqual(sound);
    await page.keyboard.press('Control+z');
    // And a slip, with both halves of the first pair shortened so that either one could be slipped.
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      const pair = (Object.values(session.store.get().clips) as any[]).filter((c) => c.start === 0);
      session.store.commit(pair.map((c) => ({ op: 'updateClip', id: c.id, patch: { duration: 60 } })));
      cmd.setTool('slip');
    });
    await drag((await page.locator(`[data-clip="${first}"]`).boundingBox())!, -80);
    const slipped = await page.evaluate(() =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.start === 0)
        .map((c) => `${c.type}:${c.sourceIn > 0 ? 'slipped' : 'as it was'}`)
        .sort(),
    );
    expect(slipped).toEqual(['audio:as it was', 'video:slipped']);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.evaluate(() => (window as any).tandem.cmd.setTool('select'));
    expect(await layout(page)).toEqual(start);

    // Nudge, disable, speed and delete leave the locked track exactly as it was.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Shift+.');
    await page.keyboard.press('d');
    expect(await layout(page)).toEqual(['A1:0+120', 'A1:120+120', 'V1:10+120', 'V1:130+120']);
    const audible = await page.evaluate(() =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === 'audio')
        .map((c) => c.enabled),
    );
    expect(audible).toEqual([true, true]);
    await page.keyboard.press('Delete');
    expect(await layout(page)).toEqual(['A1:0+120', 'A1:120+120']);
    await page.keyboard.press('Control+z');

    // Locking a track under a selected clip lets go of it.
    await page.keyboard.press('Control+a');
    await page.locator('.tl [aria-label="Lock track"]').nth(1).click();
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().selection)).toEqual([]);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    expect(await clips(page)).toHaveLength(4);
  });

  test('Duplicate makes room instead of overwriting the next clip', async ({ page }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Title' }));
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const p = session.store.get();
      const first = (Object.values(p.clips) as any[]).find((c) => c.type === 'video' && c.start === 0);
      ui.getState().set({ linkedSelection: true });
      ui.getState().select([first.id]);
    });
    await page.keyboard.press('Control+d');
    // Picture and sound are copied together; the second pair moved along, nothing was lost.
    expect(await layout(page)).toEqual([
      'A1:0+120',
      'A1:120+120',
      'A1:240+120',
      'V1:0+120',
      'V1:120+120',
      'V1:240+120',
      'V2:0+120',
      'V2:240+30',
    ]);
    // One undo step.
    await page.keyboard.press('Control+z');
    expect(await layout(page)).toEqual(['A1:0+120', 'A1:120+120', 'V1:0+120', 'V1:120+120', 'V2:0+150']);

    // With free space after the selection, the copy simply goes there.
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const title = (Object.values(session.store.get().clips) as any[]).find((c) => c.type === 'text');
      ui.getState().select([title.id]);
    });
    await page.keyboard.press('Control+d');
    expect(await layout(page)).toEqual([
      'A1:0+120',
      'A1:120+120',
      'V1:0+120',
      'V1:120+120',
      'V2:0+150',
      'V2:150+150',
    ]);
  });

  test('a ripple that is refused says why and changes nothing', async ({ page }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    await watchToasts(page);
    const before = await layout(page);
    // Only the first picture clip: closing its space would pull the second clip away from its sound,
    // which cannot follow because the first clip's sound is still in the way.
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const first = (Object.values(session.store.get().clips) as any[]).find(
        (c) => c.type === 'video' && c.start === 0,
      );
      ui.getState().set({ linkedSelection: false });
      ui.getState().select([first.id]);
    });
    await page.keyboard.press('Shift+Delete');
    await expect(toast(page, 'Cannot ripple here: a linked clip on A1')).toBeVisible();
    expect(await layout(page)).toEqual(before);
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().selection.length)).toBe(1);

    // W on the same clip is refused for the same reason, as one edit: nothing is half-trimmed.
    await page.evaluate(() => (window as any).tandem.cmd.seek(60));
    await page.keyboard.press('w');
    await expect.poll(() => toastCount(page, 'Cannot ripple here')).toBe(2);
    expect(await layout(page)).toEqual(before);

    // With picture and sound together the trim goes through and everything after closes up.
    await page.evaluate(() =>
      (window as any).tandem.ui.getState().set({ linkedSelection: true, selection: [] }),
    );
    await page.keyboard.press('w');
    expect(await layout(page)).toEqual(['A1:0+60', 'A1:60+120', 'V1:0+60', 'V1:60+120']);
    await page.keyboard.press('Control+z');
    // Q trims the heads and leaves the playhead at the new start.
    await page.keyboard.press('q');
    expect(await layout(page)).toEqual(['A1:0+60', 'A1:60+120', 'V1:0+60', 'V1:60+120']);
    expect(await page.evaluate(() => (window as any).tandem.session.player.getFrame())).toBe(0);
    await page.keyboard.press('Control+z');

    // Close gap: one gap on V1 whose closing would part a linked pair is refused with the reason.
    await page.evaluate(() => {
      const { session, ui, cmd } = (window as any).tandem;
      const p = session.store.get();
      const first = (Object.values(p.clips) as any[]).find((c) => c.type === 'video' && c.start === 0);
      ui.getState().set({ linkedSelection: false });
      ui.getState().select([first.id]);
      cmd.delete(false);
      cmd.seek(60);
    });
    expect(await layout(page)).toEqual(['A1:0+120', 'A1:120+120', 'V1:120+120']);
    await page.keyboard.press('Shift+g');
    await expect.poll(() => toastCount(page, 'Cannot ripple here')).toBe(3);
    expect(await layout(page)).toEqual(['A1:0+120', 'A1:120+120', 'V1:120+120']);
    // Without the sound in the way the gap closes on both tracks at once.
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const sound = (Object.values(session.store.get().clips) as any[]).find(
        (c) => c.type === 'audio' && c.start === 0,
      );
      session.store.commit([{ op: 'removeClip', id: sound.id }]);
    });
    await page.keyboard.press('Shift+g');
    expect(await layout(page)).toEqual(['A1:0+120', 'V1:0+120']);
    expect(await toastCount(page, 'Cannot ripple')).toBe(3);
  });

  test('shortcuts work on a Cyrillic layout, with macOS Option symbols and for every "+"', async ({
    page,
  }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    // Ctrl+A arrives as "ф", S as "ы", Ctrl+Z as "я".
    await page.evaluate(() => (window as any).tandem.cmd.seek(30));
    await press(page, { key: 'ы', code: 'KeyS' });
    expect(await clips(page)).toHaveLength(6);
    await press(page, { key: 'я', code: 'KeyZ', ctrlKey: true });
    expect(await clips(page)).toHaveLength(4);
    await press(page, { key: 'Я', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    expect(await clips(page)).toHaveLength(6);
    await press(page, { key: 'я', code: 'KeyZ', ctrlKey: true });
    await press(page, { key: 'ф', code: 'KeyA', ctrlKey: true });
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().selection.length)).toBe(4);

    // Option+X on a Mac types "≈"; it still clears the in/out range.
    await page.keyboard.press('i');
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().range)).not.toBeNull();
    await press(page, { key: '≈', code: 'KeyX', altKey: true });
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().range)).toBeNull();

    // "+" needs Shift on most keyboards; with or without Ctrl it zooms the timeline in.
    const ppf = () => page.evaluate(() => (window as any).tandem.ui.getState().ppf);
    const start = await ppf();
    await page.keyboard.press('Shift+=');
    const once = await ppf();
    expect(once).toBeGreaterThan(start);
    await press(page, { key: '+', code: 'Equal', shiftKey: true, ctrlKey: true });
    expect(await ppf()).toBeGreaterThan(once);
  });

  test('zoom keeps what is on screen when the playhead is not', async ({ page }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    const view = () =>
      page.evaluate(() => {
        const { ppf, scrollX } = (window as any).tandem.ui.getState();
        return { ppf, scrollX, width: document.querySelector('.tl__area')!.clientWidth };
      });
    // Playhead at 0, looking at frame 150 onwards at 20 px a frame.
    await page.evaluate(() => {
      const { ui, cmd } = (window as any).tandem;
      cmd.seek(0);
      ui.getState().set({ ppf: 20, scrollX: 3000 });
    });
    const before = await view();
    await page.keyboard.press('=');
    const after = await view();
    expect(after.ppf).toBeCloseTo(28);
    // The frame in the middle of the timeline stays in the middle. (The left edge used to fall
    // back from frame 150 to 107, sliding the clips being looked at off to the right.)
    const middle = (v: typeof before) => (v.scrollX + v.width / 2) / v.ppf;
    expect(middle(after)).toBeCloseTo(middle(before), 3);
    expect(after.scrollX / after.ppf).toBeGreaterThan(150);

    // The toolbar buttons take the same path.
    await page.locator('.tl [aria-label="Zoom out"]').click();
    expect(middle(await view())).toBeCloseTo(middle(before), 3);

    // With the playhead in view it is still the anchor.
    await page.evaluate(() => {
      const { ui, cmd } = (window as any).tandem;
      ui.getState().set({ ppf: 20, scrollX: 3000 });
      cmd.seek(160, false);
    });
    await page.keyboard.press('=');
    const anchored = await view();
    expect(160 * anchored.ppf - anchored.scrollX).toBeCloseTo(160 * 20 - 3000, 3);
  });

  test('markers can be stepped through; clips select by side; the timeline zooms to a selection', async ({
    page,
  }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    const frame = () => page.evaluate(() => (window as any).tandem.session.player.getFrame());
    for (const f of [30, 90, 200]) {
      await page.evaluate((f) => (window as any).tandem.cmd.seek(f), f);
      await page.keyboard.press('m');
    }
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+m');
    expect(await frame()).toBe(30);
    await page.keyboard.press('Shift+m');
    await page.keyboard.press('Shift+m');
    expect(await frame()).toBe(200);
    await page.keyboard.press('Shift+m');
    expect(await frame()).toBe(200);
    await page.keyboard.press('Control+Shift+m');
    expect(await frame()).toBe(90);
    await page.keyboard.press('Alt+m');
    expect(await frame()).toBe(30);
    await page.keyboard.press('Alt+m');
    expect(await frame()).toBe(30);

    // Both commands are in the palette too.
    await searchPalette(page, 'next marker');
    await page.keyboard.press('Enter');
    await expect.poll(frame).toBe(90);

    const selected = () =>
      page.evaluate(() => {
        const { session, ui } = (window as any).tandem;
        const p = session.store.get();
        return ui
          .getState()
          .selection.map((id: string) => `${p.clips[id].type}@${p.clips[id].start}`)
          .sort();
      });
    await page.evaluate(() => (window as any).tandem.cmd.seek(150));
    await page.keyboard.press('Shift+End');
    expect(await selected()).toEqual(['audio@120', 'video@120']);
    await page.evaluate(() => (window as any).tandem.cmd.seek(120));
    await page.keyboard.press('Shift+Home');
    expect(await selected()).toEqual(['audio@0', 'video@0']);

    // Z frames the selection (frames 0…120) in the timeline, with a margin either side.
    await page.keyboard.press('z');
    const fit = await page.evaluate(() => {
      const s = (window as any).tandem.ui.getState();
      return { left: 0 * s.ppf - s.scrollX, right: 120 * s.ppf - s.scrollX };
    });
    expect(fit.left).toBeGreaterThanOrEqual(-40);
    expect(fit.right).toBeGreaterThan(600);
  });

  test('pasting into another project leaves out clips whose media is not there', async ({ page }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Travels' }));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(1600);

    await goHome(page);
    await page.locator('.starter').first().click();
    await editorReady(page);
    expect(await clips(page)).toEqual([]);
    await page.keyboard.press('Control+v');
    await expect(toast(page, '4 clips were left out: the media is not in this project')).toBeVisible();
    const pasted = await page.evaluate(() => {
      const p = (window as any).tandem.session.store.get();
      return (Object.values(p.clips) as any[]).map((c) => ({
        type: c.type,
        orphan: !!c.assetId && !p.assets[c.assetId],
      }));
    });
    expect(pasted).toEqual([{ type: 'text', orphan: false }]);
  });
});

test.describe('projects, links and media', () => {
  test('a link is only stored once the server accepts it, and never in place of better access', async ({
    page,
    browser,
  }) => {
    await newProject(page);
    await skipWithoutServer(page);
    await watchToasts(page);
    const id: string = await page.evaluate(() => (window as any).tandem.session.id);
    const [entry] = await registry(page);
    expect(entry).toMatchObject({ id, role: 'owner' });
    const viewerLink: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('viewer'));
    const editorLink: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));

    // The owner opens the view-only link they just made, in the same browser.
    await page.goto(viewerLink);
    await page.waitForFunction(
      () => !!(window as any).tandem?.session?.player && !location.hash.includes('t='),
    );
    await expect.poll(() => toastCount(page, 'You already have owner access')).toBe(1);
    expect(await meta(page)).toMatchObject({ role: 'owner', shared: true });
    expect(await registry(page)).toEqual([
      expect.objectContaining({ id, token: entry.token, role: 'owner' }),
    ]);
    // Opening it from the project list afterwards is still the owner's project.
    await goHome(page);
    await page.locator('.pcard__open').click();
    await editorReady(page);
    expect((await meta(page)).role).toBe('owner');

    // A mangled link changes nothing either, and the project keeps syncing.
    for (const junk of ['junk', `${entry.token!.slice(0, 40)}`, `${entry.token}x`]) {
      await goHome(page);
      await page.goto(`/#/p/${id}?t=${junk}`);
      await editorReady(page);
      await expect.poll(async () => (await meta(page)).status).toBe('connected');
      expect(await meta(page)).toMatchObject({ role: 'owner', shared: true, denied: false });
      expect((await registry(page))[0].token).toBe(entry.token);
    }
    expect(await toastCount(page, 'That link is not valid for this project')).toBe(3);

    // A bad link to a project this browser has never seen leaves no entry behind.
    await goHome(page);
    await page.goto('/#/p/nosuchproject1234567?t=junk');
    await expect(page.getByText('This project is not available')).toBeVisible();
    expect(await registry(page)).toHaveLength(1);
    await goHome(page);
    await expect(page.locator('.pcard')).toHaveCount(1);

    // Someone else opens their link while the server cannot be reached. Nothing has accepted it
    // yet, so it is not stored: it stays in the address, where a reload finds it again.
    const ctx = await browser.newContext();
    const b = await ctx.newPage();
    const address = () => b.evaluate(() => location.hash);
    const serverBack = async () => {
      await ctx.unroute('**/api/**');
      await b.evaluate(() => void window.dispatchEvent(new Event('online')));
    };
    await ctx.route('**/api/**', (route) => route.abort());
    await b.goto(viewerLink);
    await expect(b.getByText('Still trying to reach the server')).toBeVisible();
    await b.reload();
    await expect(b.getByText('Still trying to reach the server')).toBeVisible();
    expect(await address()).toContain('?t=');
    expect(await registry(b)).toEqual([]);
    // Once the server answers the page joins by itself, and only then is the link put away.
    await serverBack();
    await b.waitForFunction(() => (window as any).tandem?.session?.getMeta().status === 'connected');
    expect(await meta(b)).toMatchObject({ role: 'viewer', shared: true, denied: false });
    expect(await address()).toBe(`#/p/${id}`);
    expect(await registry(b)).toEqual([expect.objectContaining({ id, role: 'viewer' })]);

    // The same for a link that adds to the access already held: it waits in the address, too.
    await b.waitForTimeout(1800);
    await ctx.route('**/api/**', (route) => route.abort());
    await b.goto(editorLink);
    await b.reload();
    await editorReady(b);
    expect(await meta(b)).toMatchObject({ role: 'viewer', online: false });
    expect(await address()).toContain('?t=');
    await serverBack();
    await b.waitForFunction(() => (window as any).tandem.session.getMeta().role === 'editor');
    expect(await address()).toBe(`#/p/${id}`);
    expect((await registry(b))[0].role).toBe('editor');
    await ctx.close();
  });

  test('a viewer stays a viewer offline, and changes the server refused are thrown away', async ({
    page,
    browser,
  }) => {
    await newProject(page);
    await skipWithoutServer(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));
    const viewerLink: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('viewer'));
    const editorLink: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));

    const v = await join(browser, viewerLink);
    await v.waitForFunction(
      () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 1,
    );
    expect((await meta(v)).role).toBe('viewer');
    expect((await registry(v))[0].role).toBe('viewer');
    // Let the local copy and the registry settle before cutting the server off.
    await v.waitForTimeout(1800);

    // Server unreachable: the role comes from what was confirmed last time, not from a default.
    await v.context().route('**/api/**', (route) => route.abort());
    await v.reload();
    await editorReady(v);
    expect(await meta(v)).toMatchObject({ role: 'viewer', shared: true, online: false });
    await expect(v.locator('.conn')).toContainText('View-only access');
    await v.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Not allowed' }));
    await v.keyboard.press('Control+a');
    await v.keyboard.press('Delete');
    expect(await clips(v)).toHaveLength(1);

    // An entry written before roles were kept: the stored token still says what it is for.
    await v.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('tandem.projects.v1')!);
      delete list[0].role;
      localStorage.setItem('tandem.projects.v1', JSON.stringify(list));
    });
    await v.reload();
    await editorReady(v);
    expect((await meta(v)).role).toBe('viewer');

    // Back online, with an edit forced into the local copy behind the interface's back.
    await v.context().unroute('**/api/**');
    await v.reload();
    await editorReady(v);
    await expect.poll(async () => (await meta(v)).synced).toBe(true);
    await watchToasts(v);
    await v.evaluate(() => {
      const s = (window as any).tandem.session;
      (window as any).__before = s;
      s.doc.transact(() => {
        for (const key of Array.from(s.doc.getMap('clips').keys())) s.doc.getMap('clips').delete(key);
      });
    });
    // The server refuses it; the copy is dropped and loaded again from the server.
    await v.waitForFunction(() => {
      const s = (window as any).tandem?.session;
      return s && s !== (window as any).__before && Object.keys(s.store.get().clips).length === 1;
    });
    expect(await toastCount(v, 'Changes made here were not saved: you have view-only access')).toBe(1);
    expect(await clips(page)).toHaveLength(1);
    // Nothing of it is left on the device either.
    await v.waitForTimeout(1500);
    await v.context().route('**/api/**', (route) => route.abort());
    await v.reload();
    await editorReady(v);
    expect(await clips(v)).toHaveLength(1);
    await v.context().unroute('**/api/**');

    // A better link upgrades the stored access; the lesser one cannot take it back.
    await v.goto(editorLink);
    await v.waitForFunction(() => (window as any).tandem?.session?.getMeta().role === 'editor');
    expect((await registry(v))[0].role).toBe('editor');
    await v.goto(viewerLink);
    await v.waitForFunction(() => !!(window as any).tandem?.session?.player && !location.hash.includes('t='));
    expect((await meta(v)).role).toBe('editor');
    await v.context().close();
  });

  test('a busy server is not mistaken for a refused link, and a withdrawn link is not retried for ever', async ({
    page,
    browser,
  }) => {
    await newProject(page);
    await skipWithoutServer(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));
    const id: string = await page.evaluate(() => (window as any).tandem.session.id);
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));

    const ctx = await browser.newContext();
    const b = await ctx.newPage();
    // Sockets to the collaboration server fail to open while `refuse` is set, the way they do when
    // the server turns the upgrade away. A browser reports that the same whatever the status was.
    await b.addInitScript(() => {
      const state = ((window as any).__sockets = { refuse: true });
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
          if (!state.refuse || !String(args[0]).includes('/ws/')) return new target(...(args as [string]));
          const dead: any = { readyState: 3, send() {}, close() {} };
          setTimeout(() => dead.onclose?.({ code: 1006 }), 5);
          return dead;
        },
      });
    });
    await b.goto(link);
    // The link is good (the API says so), so this is a full or rate-limited server: keep waiting.
    await expect(b.getByText('Waiting for a place in this project')).toBeVisible();
    await expect(b.getByText('This project is not available')).toHaveCount(0);
    expect(await meta(b)).toMatchObject({ busy: true, denied: false, role: 'editor' });

    // Room again: it joins by itself.
    await b.evaluate(() => ((window as any).__sockets.refuse = false));
    await b.waitForFunction(
      () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 1,
    );
    await expect(b.locator('.tl')).toBeVisible();
    expect(await meta(b)).toMatchObject({ busy: false, status: 'connected' });

    // Now the link really is withdrawn: sockets are turned away and the API says 401.
    await watchToasts(b);
    await b.route(`**/api/projects/${id}`, (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid token"}' }),
    );
    await b.evaluate(() => {
      (window as any).__sockets.refuse = true;
      for (const p of (window as any).tandem.session.providers) p.ws?.close();
    });
    await expect.poll(() => toastCount(b, 'no longer accepts your link'), { timeout: 30_000 }).toBe(1);
    expect(await meta(b)).toMatchObject({ shared: false, status: 'offline', busy: false, role: 'owner' });
    await expect(b.locator('.conn')).toContainText('Saved on this device');
    // It stopped knocking.
    const attempts = await b.evaluate(() => (window as any).tandem.session.providers.length);
    expect(attempts).toBe(0);
    await ctx.close();
  });

  test('leaving while the project is still connecting opens no sockets afterwards', async ({ page }) => {
    await newProject(page);
    await skipWithoutServer(page);
    const id: string = await page.evaluate(() => (window as any).tandem.session.id);
    await page.waitForTimeout(1700);
    await goHome(page);

    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    let asked = 0;
    await page.route(`**/api/projects/${id}`, async (route) => {
      asked++;
      await new Promise((r) => setTimeout(r, 1500));
      await route.fallback();
    });
    await page.goto(`/#/p/${id}`);
    await expect(page.getByText('Opening project')).toBeVisible();
    await expect.poll(() => asked).toBeGreaterThan(0);
    await goHome(page);
    await page.waitForTimeout(3000);
    expect(sockets.filter((u) => u.includes('/ws/'))).toEqual([]);
  });

  test('imports show up at once, save in the background, and say so when the device cannot keep them', async ({
    page,
  }) => {
    // Every write to the device goes through here: it can be slowed down, made to fail, and counted.
    await page.addInitScript(() => {
      const real = FileSystemFileHandle.prototype.createWritable;
      const state = ((window as any).__disk = { delay: 0, fail: '', opened: [] as string[] });
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        state.opened.push(this.name);
        if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
        if (state.fail) throw new DOMException('no room', state.fail);
        return real.apply(this, args);
      };
    });
    await newLocalProject(page);
    await watchToasts(page);
    const statuses = () =>
      page.evaluate(() => {
        const s = (window as any).tandem.session;
        return (Object.values(s.store.get().assets) as any[])
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (a) => `${a.name}:${s.media.get(a.id).local ? 'local' : 'missing'}:${s.media.get(a.id).unsaved}`,
          );
      });

    // Two files, each taking 1.5 s to reach the disk: both are in the pool, and usable, straight away.
    await page.evaluate(() => ((window as any).__disk.delay = 1500));
    await importFixtures(page, ['testsrc.mp4', 'tone.ogg']);
    expect(await statuses()).toEqual(['testsrc.mp4:local:saving', 'tone.ogg:local:saving']);
    await expect(page.locator('.asset')).toHaveCount(2);
    await expect(toast(page, 'Imported 2 files')).toBeVisible();
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.addAsset(
        (Object.values(session.store.get().assets) as any[]).find((a) => a.name === 'testsrc.mp4'),
      );
    });
    expect(await clips(page)).toEqual(['audio@0+120', 'video@0+120']);
    await expect.poll(statuses).toEqual(['testsrc.mp4:local:null', 'tone.ogg:local:null']);
    // The whole batch is one undo step (after the clip that was added since).
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.asset')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('.asset')).toHaveCount(2);

    // A full disk: the file still works for now, and the user is told it will not survive a reload.
    await page.evaluate(() =>
      Object.assign((window as any).__disk, { delay: 0, fail: 'QuotaExceededError' }),
    );
    await importFixtures(page, ['green.png']);
    await expect.poll(() => toastCount(page, 'There is no room on this device to keep “green.png”')).toBe(1);
    expect(await statuses()).toContain('green.png:local:failed');
    await page.evaluate(() => ((window as any).__disk.fail = ''));

    // The browser reporting too little free space is caught before anything is written.
    await page.evaluate(() => {
      navigator.storage.estimate = async () => ({ quota: 1000, usage: 990 });
    });
    const opened = await page.evaluate(() => (window as any).__disk.opened.length);
    await importFixtures(page, ['red.webm']);
    await expect.poll(() => toastCount(page, 'There is no room on this device to keep “red.webm”')).toBe(1);
    expect(await page.evaluate(() => (window as any).__disk.opened.length)).toBe(opened);

    // What the device could not keep is held by the page: leaving the project does not lose it.
    await page.waitForTimeout(1700);
    await page.evaluate(() => ((window as any).__left = (window as any).tandem.session));
    await goHome(page);
    await page.locator('.pcard__open').click();
    await page.waitForFunction(() => {
      const s = (window as any).tandem.session;
      return s !== (window as any).__left && !!s.player;
    });
    expect(await statuses()).toEqual([
      'green.png:local:failed',
      'red.webm:local:failed',
      'testsrc.mp4:local:null',
      'tone.ogg:local:null',
    ]);

    // What was saved is there after a reload; what could not be is offline, as the toast said.
    await page.reload();
    await editorReady(page);
    expect(await statuses()).toEqual([
      'green.png:missing:null',
      'red.webm:missing:null',
      'testsrc.mp4:local:null',
      'tone.ogg:local:null',
    ]);
  });

  test('publishing takes along imports that are still being saved, and those that could not be', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const real = FileSystemFileHandle.prototype.createWritable;
      const state = ((window as any).__disk = { delay: 0, fail: '' });
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
        if (state.fail) throw new DOMException('no room', state.fail);
        return real.apply(this, args);
      };
    });
    await newLocalProject(page);
    await page.unroute('**/api/health');
    const server = await page.evaluate(() =>
      fetch('/api/health').then(
        (r) => r.ok,
        () => false,
      ),
    );
    test.skip(!server, 'no collaboration server');
    await page.evaluate(() => void window.dispatchEvent(new Event('online')));
    await expect.poll(async () => (await meta(page)).online).toBe(true);
    await watchToasts(page);
    const statuses = () =>
      page.evaluate(() => {
        const s = (window as any).tandem.session;
        return (Object.values(s.store.get().assets) as any[])
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (a) => `${a.name}:${s.media.get(a.id).local ? 'local' : 'missing'}:${s.media.get(a.id).unsaved}`,
          );
      });

    // One file the device has no room for, and two that are still on their way to it.
    await page.evaluate(() => ((window as any).__disk.fail = 'QuotaExceededError'));
    await importFixtures(page, ['green.png']);
    await expect.poll(() => toastCount(page, 'There is no room on this device to keep “green.png”')).toBe(1);
    const warning = page.locator('.asset', { hasText: 'green.png' }).locator('.asset__status svg');
    await expect(warning).toHaveCount(1);
    await page.evaluate(() => Object.assign((window as any).__disk, { fail: '', delay: 2500 }));
    await importFixtures(page, ['testsrc.mp4', 'tone.ogg']);
    await expect(page.locator('.asset')).toHaveCount(3);
    expect(await statuses()).toEqual([
      'green.png:local:failed',
      'testsrc.mp4:local:saving',
      'tone.ogg:local:saving',
    ]);

    const local: string = await page.evaluate(() => (window as any).tandem.session.id);
    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/projects',
    );
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('button', { name: 'Publish and share' }).click();
    await expect(toast(page, 'Still saving imported media on this device')).toBeVisible();
    test.skip(!(await created).ok(), 'the collaboration server is not taking new projects');
    await page.waitForFunction((local) => {
      const s = (window as any).tandem?.session;
      return s && s.id !== local && !!s.player;
    }, local);

    // Under its new id the project has all three: two on the device by now, one still in the page.
    expect(await statuses()).toEqual([
      'green.png:local:failed',
      'testsrc.mp4:local:null',
      'tone.ogg:local:null',
    ]);
    await page.waitForFunction(
      () =>
        (Object.values((window as any).tandem.session.store.get().assets) as any[]).every((a) => a.uploaded),
      null,
      { timeout: 60_000 },
    );
    // So nothing is lost to a reload, and the card of the file the device could not keep stops
    // warning that it would be: it comes back from the server.
    await expect(warning).toHaveCount(0);
    await page.waitForTimeout(1700);
    await page.reload();
    await editorReady(page);
    await expect
      .poll(statuses, { timeout: 30_000 })
      .toEqual(['green.png:local:null', 'testsrc.mp4:local:null', 'tone.ogg:local:null']);
  });

  test('closing the tab while an import is still being saved asks first', async ({ page }) => {
    await page.addInitScript(() => {
      const real = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        await new Promise((r) => setTimeout(r, (window as any).__delay ?? 0));
        return real.apply(this, args);
      };
    });
    const prompts: string[] = [];
    page.on('dialog', (d) => {
      prompts.push(d.type());
      void d.accept();
    });
    await newLocalProject(page);
    // The browser only asks on pages the user has interacted with.
    await page.locator('.viewer, .panel--viewer').first().click();
    await page.reload();
    await editorReady(page);
    expect(prompts).toEqual([]);

    await page.locator('.viewer, .panel--viewer').first().click();
    await page.evaluate(() => ((window as any).__delay = 5000));
    await importFixtures(page, ['tone.ogg']);
    await expect(page.locator('.asset')).toHaveCount(1);
    await page.waitForTimeout(1700);
    await page.reload();
    await editorReady(page);
    expect(prompts).toEqual(['beforeunload']);
  });

  test('uploads and downloads run a few at a time, are written once, and reach peers when they land', async ({
    page,
    browser,
  }) => {
    await newProject(page);
    await skipWithoutServer(page);
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Shared' }));
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));

    /**
     * Note how many uploads and downloads the page has under way at once. Transfers are slowed
     * down on the wire so that they would all overlap if nothing held them back.
     */
    const gauge = async (target: Page) => {
      await target.route('**/api/projects/*/media/*', async (route) => {
        const r = route.request();
        if (r.method() === 'PUT' || (r.method() === 'GET' && !r.headers().range))
          await new Promise((res) => setTimeout(res, 400));
        await route.fallback();
      });
      await target.evaluate(() => {
        const media = (window as any).tandem.session.media;
        const stats: Record<string, { now: number; peak: number; total: number }> = ((
          window as any
        ).__transfers = {});
        for (const kind of ['upload', 'download']) {
          const run = media[kind].bind(media);
          const s = (stats[kind] = { now: 0, peak: 0, total: 0 });
          media[kind] = async (...args: unknown[]) => {
            s.total++;
            s.peak = Math.max(s.peak, ++s.now);
            try {
              return await run(...args);
            } finally {
              s.now--;
            }
          };
        }
      });
      return (kind: 'upload' | 'download'): Promise<{ now: number; peak: number; total: number }> =>
        target.evaluate((kind) => (window as any).__transfers[kind], kind);
    };

    // A second editor is already in the project, told to count writes to the device and what the
    // player is asked to look at again.
    const ctx = await browser.newContext();
    const b = await ctx.newPage();
    await b.addInitScript(() => {
      const real = FileSystemFileHandle.prototype.createWritable;
      const opened: string[] = ((window as any).__opened = []);
      FileSystemFileHandle.prototype.createWritable = function (...args) {
        opened.push(this.name);
        return real.apply(this, args);
      };
    });
    await b.goto(link);
    await b.waitForFunction(
      () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 1,
    );
    await editorReady(b);
    const received = await gauge(b);
    await b.evaluate(() => {
      const s = (window as any).tandem.session;
      const calls: { id: string; local: boolean }[] = ((window as any).__refreshed = []);
      const refresh = s.player.refreshAsset.bind(s.player);
      s.player.refreshAsset = (id: string) => {
        calls.push({ id, local: s.media.get(id).local });
        refresh(id);
      };
    });

    const sent = await gauge(page);
    const names = ['testsrc.mp4', 'testsrc.webm', 'tone.ogg', 'red.webm', 'green.png', 'large.mp4'];
    await importFixtures(page, names);
    await page.waitForFunction(
      (n) => {
        const assets = Object.values((window as any).tandem.session.store.get().assets) as any[];
        return assets.length === n && assets.every((a) => a.uploaded);
      },
      names.length,
      { timeout: 60_000 },
    );
    expect(await sent('upload')).toMatchObject({ now: 0, peak: 2 });
    expect((await sent('upload')).total).toBeGreaterThanOrEqual(names.length);

    // The peer caches them, two at a time, leaving connections for streaming and the API.
    await b.waitForFunction(
      (n) => {
        const s = (window as any).tandem.session;
        const assets = Object.values(s.store.get().assets) as any[];
        return assets.length === n && assets.every((a) => s.media.get(a.id).local);
      },
      names.length,
      { timeout: 60_000 },
    );
    expect(await received('download')).toMatchObject({ now: 0, peak: 2 });
    expect((await received('download')).total).toBeGreaterThanOrEqual(names.length);

    // Each download went to the device once, straight into place.
    const written: string[] = await b.evaluate(() => (window as any).__opened);
    const ids: string[] = await b.evaluate(() =>
      Object.keys((window as any).tandem.session.store.get().assets),
    );
    expect(written.slice().sort()).toEqual(ids.slice().sort());

    // Every asset was announced to the player the moment the server had it, before the local copy.
    const early: string[] = await b.evaluate(() =>
      ((window as any).__refreshed as { id: string; local: boolean }[])
        .filter((c) => !c.local)
        .map((c) => c.id),
    );
    expect(Array.from(new Set(early)).sort()).toEqual(ids.slice().sort());
    await ctx.close();
  });

  test('a failed upload is tried again by itself and on request', async ({ page }) => {
    await newProject(page);
    await skipWithoutServer(page);
    let failing = true;
    let puts = 0;
    await page.route('**/api/projects/*/media/*', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      puts++;
      return failing ? route.abort('connectionreset') : route.fallback();
    });
    await importFixtures(page, ['tone.ogg']);
    const state = () =>
      page.evaluate(() => {
        const s = (window as any).tandem.session;
        const [a] = Object.values(s.store.get().assets) as any[];
        return { uploaded: a.uploaded, error: s.media.get(a.id).transferError };
      });
    // Two attempts have failed; the next one is four seconds off.
    await expect.poll(() => puts, { timeout: 15_000 }).toBe(2);
    await expect.poll(async () => (await state()).error).toBe('Upload interrupted');
    expect((await state()).uploaded).toBe(false);

    // The pool offers a retry, and it happens at once.
    await page.locator('.asset').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Retry upload' }).click();
    await expect.poll(() => puts, { timeout: 1500 }).toBe(3);

    // Once the connection is back the upload completes without anyone doing anything.
    failing = false;
    await expect.poll(async () => (await state()).uploaded, { timeout: 30_000 }).toBe(true);
    expect((await state()).error).toBeNull();
    await page.locator('.asset').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Replace media…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Retry upload' })).toHaveCount(0);
  });

  test('opening a project file makes a new project; replacing the open one asks first', async ({ page }) => {
    await newLocalProject(page);
    await twoLinkedClips(page);
    await watchToasts(page);
    await page.evaluate(() => (window as any).tandem.cmd.renameProject('Source cut'));
    const source: string = await page.evaluate(() => (window as any).tandem.session.id);
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    const file = await download.path();
    const saved = await layout(page);
    // The project moves on after the file was saved.
    await page.evaluate(() => (window as any).tandem.cmd.addText({ content: 'Added later' }));
    const current = await layout(page);
    expect(current).toHaveLength(saved.length + 1);
    await page.waitForTimeout(1700);

    // Ctrl+O: the file opens as a project of its own, with the media this device has for it.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+o')]);
    await chooser.setFiles(file);
    await page.waitForFunction((source) => {
      const s = (window as any).tandem?.session;
      return s && s.id !== source && !!s.player;
    }, source);
    await expect.poll(() => toastCount(page, 'Opened “Source cut” as a new project.')).toBe(1);
    expect(await layout(page)).toEqual(saved);
    const copy = await page.evaluate(() => {
      const s = (window as any).tandem.session;
      const assets = Object.values(s.store.get().assets) as any[];
      return { name: s.store.get().settings.name, local: assets.map((a) => s.media.get(a.id).local) };
    });
    expect(copy).toEqual({ name: 'Source cut', local: [true] });
    expect(await registry(page)).toHaveLength(2);

    // The project it was opened from is exactly as it was left.
    await page.waitForTimeout(1700);
    await page.goto(`/#/p/${source}`);
    await page.waitForFunction((source) => (window as any).tandem?.session?.id === source, source);
    await editorReady(page);
    expect(await layout(page)).toEqual(current);

    // Replacing the open project is a separate command that spells out what goes.
    const asked: string[] = [];
    let answer: 'accept' | 'dismiss' = 'dismiss';
    page.on('dialog', (d) => {
      asked.push(d.message());
      void d[answer]();
    });
    const replace = async () => {
      await searchPalette(page, 'replace this project');
      const [c] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
      await c.setFiles(file);
    };
    await replace();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain('Replace “Source cut” with “Source cut”?');
    expect(asked[0]).toContain('5 clips, 4 tracks and 1 media file');
    expect(asked[0]).toContain('Undo brings it back only until the project is closed or reloaded');
    expect(await layout(page)).toEqual(current);

    answer = 'accept';
    await replace();
    await expect.poll(() => layout(page)).toEqual(saved);
    await expect.poll(() => toastCount(page, 'Replaced with “Source cut”')).toBe(1);
    await page.keyboard.press('Control+z');
    expect(await layout(page)).toEqual(current);
  });
});
