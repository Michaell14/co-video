import { expect, test, type Page } from '@playwright/test';
import { importFixtures, newProject } from './helpers';

/** `track:type@start+duration` for every clip, sorted, with tracks named V1, A1, … */
function layout(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const p = (window as any).tandem.session.store.get();
    const name = (id: string) => `${p.tracks[id].kind === 'video' ? 'V' : 'A'}${p.tracks[id].order + 1}`;
    return (Object.values(p.clips) as any[])
      .map((c) => `${name(c.trackId)}:${c.type}@${c.start}+${c.duration}`)
      .sort();
  });
}

const SAMPLE = ['A1:audio@0+360', 'V1:video@0+120', 'V1:video@120+120', 'V1:video@240+120', 'V2:text@18+90'];

/**
 * A new project holding the bundled sample edit: dusk, fractal and aurora (four seconds each, cut
 * together with transitions) on V1, the title "Edit in tandem" on V2, music under all of it on A1,
 * a marker on the first cut and the playhead on frame 45.
 */
async function sample(page: Page): Promise<void> {
  await newProject(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect.poll(() => layout(page), { timeout: 60_000 }).toEqual(SAMPLE);
  await expect(page.locator('.clip')).toHaveCount(5);
}

interface View {
  preview: boolean;
  scrollX: number;
  ppf: number;
  selection: number;
  lanes: number;
}

const view = (page: Page): Promise<View> =>
  page.evaluate(() => {
    const s = (window as any).tandem.ui.getState();
    return {
      preview: !!s.preview,
      scrollX: s.scrollX,
      ppf: s.ppf,
      selection: s.selection.length,
      lanes: document.querySelectorAll('.lane').length,
    };
  });

/** The earliest clip of the committed project that shows the media file `name`, or is a `title`. */
const clip = (page: Page, name: string): Promise<any> =>
  page.evaluate(
    (name) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .sort((a, b) => a.start - b.start)
        .find((c) => (name === 'title' ? c.type === 'text' : c.name === name)),
    name,
  );

async function box(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

const clipBox = async (page: Page, name: string) =>
  box(page, `.clip[data-clip="${(await clip(page, name)).id}"]`);

/** The lane of the track labelled V1, A2, … */
async function laneBox(page: Page, label: string) {
  const index = await page
    .locator('.th__tag')
    .evaluateAll((els, label) => els.findIndex((e) => e.textContent === label), label);
  if (index < 0) throw new Error(`no track ${label}`);
  return box(page, `.lane >> nth=${index}`);
}

/** Press at `from` and move to `to`, leaving the button down. */
async function dragTo(page: Page, from: [number, number], to: [number, number], steps = 8): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
}

const commit = (page: Page, edits: unknown[]): Promise<void> =>
  page.evaluate((edits) => (window as any).tandem.session.store.commit(edits), edits);

const toast = (page: Page, text: string) => page.locator('.toast', { hasText: text });

const menuItem = (page: Page, text: string) => page.locator('[role="menu"] .menu-item', { hasText: text });

test.describe('timeline', () => {
  test('the empty hint is one sentence, a rename can be abandoned, and the transport fits a narrow viewer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1180, height: 720 });
    await newProject(page);
    expect((await page.locator('.tl__hint').innerText()).split('\n')).toEqual([
      'Your timeline is empty',
      'Import media, then drag it here — or press T to start with a title.',
    ]);

    // Renaming a track: the old name is selected, Escape leaves it as it was, Enter stores the new one.
    const names = () =>
      page.evaluate(() =>
        (Object.values((window as any).tandem.session.store.get().tracks) as any[])
          .map((t) => t.name)
          .filter(Boolean),
      );
    const header = page.locator('.th').first();
    await header.click({ button: 'right', position: { x: 60, y: 30 } });
    await menuItem(page, 'Rename').click();
    const field = page.getByLabel('Track name');
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((el: HTMLInputElement) => [el.value, el.selectionStart, el.selectionEnd]),
    ).toEqual(['V2', 0, 2]);
    await page.keyboard.type('Oops');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    expect(await names()).toEqual([]);
    await header.click({ button: 'right', position: { x: 60, y: 30 } });
    await menuItem(page, 'Rename').click();
    await page.keyboard.type('Titles');
    await page.keyboard.press('Enter');
    await expect.poll(names).toEqual(['Titles']);

    // In a window this narrow the viewer is about 250px wide: only the transport buttons remain,
    // and none of them overlaps another or leaves the bar.
    await page.setViewportSize({ width: 760, height: 720 });
    await expect.poll(async () => (await page.locator('.panel--viewer').boundingBox())?.width).toBe(256);
    await expect(page.locator('.transport__left')).toBeHidden();
    const bar = await page.evaluate(() => {
      const t = document.querySelector('.transport')!;
      const r = t.getBoundingClientRect();
      const rects = Array.from(t.querySelectorAll<HTMLElement>('button, input'))
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.getBoundingClientRect());
      let clashes = 0;
      rects.forEach((a, i) =>
        rects.slice(i + 1).forEach((b) => {
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5) clashes++;
        }),
      );
      return {
        width: r.width,
        buttons: rects.length,
        clashes,
        outside: rects.filter((b) => b.left < r.left || b.right > r.right).length,
      };
    });
    expect(bar.width).toBeLessThan(360);
    expect(bar.buttons).toBe(6);
    expect(bar).toMatchObject({ clashes: 0, outside: 0 });
  });

  test('the volume slider opens without moving its button: beside it, or above it in a narrow viewer', async ({
    page,
  }) => {
    await newProject(page);
    const button = page.locator('.vol .icon-btn');
    const slider = page.locator('.vol__slider');
    const loop = page.getByRole('button', { name: 'Loop playback' });
    const volume = () => page.evaluate(() => (window as any).tandem.session.player.getState().volume);
    const apart = (a: { x: number; width: number }, b: { x: number; width: number }) =>
      a.x >= b.x + b.width || b.x >= a.x + a.width;
    const rest = (await button.boundingBox())!;
    await button.hover();
    await expect.poll(async () => (await slider.boundingBox())?.width).toBe(72);
    // The button is still under the pointer, and the slider ends where the button begins.
    const open = (await slider.boundingBox())!;
    expect((await button.boundingBox())!.x).toBe(rest.x);
    expect(open.x + open.width).toBeCloseTo(rest.x, 0);
    // It stays clear of the buttons in the middle of the bar.
    expect(apart(open, (await loop.boundingBox())!)).toBe(true);
    await page.mouse.move(5, 5);

    // In a narrower viewer the bar has no room for that. The slider opens above the button, clear
    // of the bar and of the button's tip, which goes below.
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect.poll(async () => (await page.locator('.viewer').boundingBox())?.width).toBeLessThan(760);
    await expect(slider).toBeHidden();
    const low = (await button.boundingBox())!;
    await button.hover();
    await expect(slider).toBeVisible();
    await expect(page.locator('.tooltip')).toBeVisible();
    expect((await button.boundingBox())!.x).toBe(low.x);
    const above = (await slider.boundingBox())!;
    const bar = (await page.locator('.transport').boundingBox())!;
    const tip = (await page.locator('.tooltip').boundingBox())!;
    expect(above.width).toBeGreaterThanOrEqual(72);
    expect(above.y + above.height).toBeLessThanOrEqual(bar.y);
    expect(above.x + above.width / 2).toBeCloseTo(low.x + low.width / 2, 0);
    expect(tip.y).toBeGreaterThanOrEqual(low.y + low.height);
    // The pointer gets from the button to the slider without the slider closing, and sets the volume.
    const track = (await slider.locator('.slider').boundingBox())!;
    await page.mouse.move(track.x + track.width / 4, track.y + track.height / 2, { steps: 8 });
    await expect(slider).toBeVisible();
    await page.mouse.down();
    await expect.poll(volume).toBeLessThan(0.4);
    // Dragged off the slider, it stays for as long as it is held.
    await page.mouse.move(track.x + (track.width * 3) / 4, track.y - 90, { steps: 4 });
    await expect.poll(volume).toBeGreaterThan(0.6);
    await expect(slider).toBeVisible();
    await page.mouse.up();
    await expect(slider).toBeHidden();
    // A press on the button mutes, and does not keep the slider over the picture afterwards.
    await button.click();
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().muted)).toBe(true);
    await page.mouse.move(5, 5);
    await expect(slider).toBeHidden();
  });

  test('the source monitor keeps its buttons clear of the picture and owns the transport keys', async ({
    page,
  }) => {
    await sample(page);
    await page.locator('.asset', { hasText: 'aurora.mp4' }).dblclick();
    await page.waitForFunction(
      () => (document.querySelector<HTMLVideoElement>('.source video')?.readyState ?? 0) >= 2,
    );
    const source = () =>
      page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>('.source video')!;
        const player = (window as any).tandem.session.player;
        return {
          paused: v.paused,
          frame: Math.round(v.currentTime * 30),
          programme: {
            playing: player.getState().playing,
            range: player.getState().range,
            frame: player.getFrame(),
          },
        };
      });
    const still = { playing: false, range: null, frame: 45 };

    // The picture is fitted into the body, so it ends where the footer begins.
    const overlap = await page.evaluate(() => {
      const v = document.querySelector('.source video')!.getBoundingClientRect();
      return v.bottom - document.querySelector('.source__foot')!.getBoundingClientRect().top;
    });
    expect(overlap).toBeLessThan(0.5);

    // Space stops the source, which plays as it opens. The programme behind it stays where it is.
    expect((await source()).paused).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await source()).paused).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await source()).frame).toBe(31);
    await page.keyboard.press('i');
    const markIn = page.locator('.source__foot button', { hasText: 'Mark in' });
    const markOut = page.locator('.source__foot button', { hasText: 'Mark out' });
    await expect(markIn).toContainText('0:01.03');
    expect((await source()).programme).toEqual(still);

    // L plays and K stops, also with the keyboard focus on the video itself.
    await page.locator('.source video').focus();
    await page.keyboard.press('l');
    await expect.poll(async () => (await source()).paused).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(async () => (await source()).paused).toBe(true);
    await page.keyboard.press('l');
    await expect.poll(async () => (await source()).frame).toBeGreaterThan(40);
    await page.keyboard.press('k');
    await expect.poll(async () => (await source()).paused).toBe(true);
    // J winds back.
    const reached = (await source()).frame;
    await page.keyboard.press('j');
    await expect.poll(async () => (await source()).frame).toBeLessThan(reached - 3);
    await page.keyboard.press('k');
    expect((await source()).programme).toEqual(still);

    // A question asked on top of the monitor has the keys to itself: the source and its marks stay
    // as they are, and Space presses the button that has the focus, which here is Cancel.
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.evaluate(() => void (window as any).tandem.cmd.replaceWithProjectFile()),
    ]);
    await chooser.setFiles(await download.path());
    const question = page.getByRole('dialog', { name: /^Replace / });
    await expect(question).toBeVisible();
    const held = await source();
    const marks = [await markIn.innerText(), await markOut.innerText()];
    for (const key of ['l', 'ArrowRight', 'Shift+ArrowRight', 'i', 'o', 'j', 'End']) {
      await page.keyboard.press(key);
    }
    expect(await source()).toEqual(held);
    expect([await markIn.innerText(), await markOut.innerText()]).toEqual(marks);
    await page.keyboard.press('Space');
    await expect(question).toHaveCount(0);
    expect(await source()).toEqual(held);
    expect(await layout(page)).toEqual(SAMPLE);
    await expect(page.locator('.source')).toBeVisible();

    // The buttons take real clicks: mark two seconds, then add them.
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
    await markIn.click();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await markOut.click();
    await expect(markIn).toContainText('0:01.00');
    await expect(markOut).toContainText('0:03.00');
    await page.locator('.source__foot button', { hasText: 'Add to timeline' }).click();
    // The monitor stays open for the next piece, and what it added is not selected behind it.
    await expect(page.locator('.source')).toBeVisible();
    expect(await layout(page)).toEqual([...SAMPLE, 'V3:video@45+60'].sort());
    expect((await view(page)).selection).toBe(0);
    // The earliest aurora clip is now the new one: it begins at the in point.
    const added = await clip(page, 'aurora.mp4');
    expect(added.sourceIn).toBeCloseTo(1);

    // Escape closes the monitor and leaves the selection alone.
    await page.evaluate((id) => (window as any).tandem.ui.getState().select([id]), added.id);
    await page.locator('.asset', { hasText: 'dusk.mp4' }).dblclick();
    await expect(page.locator('.source')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.source')).toHaveCount(0);
    expect((await view(page)).selection).toBe(1);

    // Match frame: F opens the source of the picture under the playhead, held on the same frame.
    await page.evaluate(() => {
      const { ui, cmd } = (window as any).tandem;
      ui.getState().clearSelection();
      cmd.seek(150);
    });
    await page.keyboard.press('f');
    await expect(page.locator('.source__name')).toHaveText('fractal.mp4');
    // fractal starts on frame 120 one second into its file: frame 150 shows its second second.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const v = document.querySelector<HTMLVideoElement>('.source video');
          return v && v.readyState >= 1 ? [v.paused, Math.round(v.currentTime * 30)] : null;
        }),
      )
      .toEqual([true, 60]);
    // From a clip's menu it works for that clip, at its first frame when the playhead is elsewhere.
    const dusk = await clipBox(page, 'dusk.mp4');
    await page.mouse.click(dusk.x + dusk.width / 2, dusk.y + dusk.height / 2, { button: 'right' });
    await menuItem(page, 'Match frame').click();
    await expect(page.locator('.source__name')).toHaveText('dusk.mp4');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const v = document.querySelector<HTMLVideoElement>('.source video');
          return v && v.readyState >= 1 ? [v.paused, Math.round(v.currentTime * 30)] : null;
        }),
      )
      .toEqual([true, 0]);
    // A match frame is used up by showing it: the same file opened from the pool plays as usual.
    await page.keyboard.press('Escape');
    await page.locator('.asset', { hasText: 'dusk.mp4' }).dblclick();
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector<HTMLVideoElement>('.source video')?.paused ?? null),
      )
      .toBe(false);

    // Removing the file that is on show closes the monitor, and the keys are the programme's again.
    await page.locator('.asset', { hasText: 'dusk.mp4' }).click({ button: 'right' });
    await menuItem(page, 'Remove (and its clips)').click();
    await expect(page.locator('.source')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().sourceAsset)).toBeNull();
    const playing = () => page.evaluate(() => (window as any).tandem.session.player.getState().playing);
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(playing).toBe(false);
  });

  test('a library drag that opens a track holds still, and leaves nothing behind when abandoned', async ({
    page,
  }) => {
    await sample(page);
    const asset = await box(page, '.asset:has-text("dusk.mp4")');
    const from: [number, number] = [asset.x + 30, asset.y + 30];
    const a1 = await laneBox(page, 'A1');
    const v1 = await laneBox(page, 'V1');
    const { ppf } = await view(page);
    // Over a sound lane, a few pixels from the playhead so the clip snaps to it. Every video track
    // is taken there, so the picture needs a track of its own. It opens on top and pushes the
    // other lanes down, which brings V1 under the pointer.
    const x = a1.x + 45 * ppf + 3;
    const y = a1.y + a1.height / 2;
    /** The lanes on show, the tracks the preview adds and how many committed clips it changes. */
    const shown = () =>
      page.evaluate(() => {
        const { ui, session } = (window as any).tandem;
        const p = session.store.get();
        const pv = ui.getState().preview;
        return {
          lanes: document.querySelectorAll('.lane').length,
          opened: pv ? Object.keys(pv.tracks).filter((id) => !p.tracks[id]) : [],
          changed: pv ? (Object.values(p.clips) as any[]).filter((c) => pv.clips[c.id] !== c).length : 0,
        };
      });

    await dragTo(page, from, [x, y], 10);
    const first = await shown();
    expect(first).toMatchObject({ lanes: 5, changed: 0 });
    expect(first.opened).toHaveLength(1);
    const under = await laneBox(page, 'V1');
    expect(y).toBeGreaterThan(under.y);
    expect(y).toBeLessThan(under.y + under.height);
    // One new lane, the same one at every pointer position, and V1 is left alone: the lane that
    // slid under the pointer is not what the pointer was brought to.
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(x + (i % 3), y);
      expect(await shown()).toEqual(first);
    }
    // Brought to where V1 lies when nothing is being dragged, the clip goes onto V1 and needs no
    // track. Back over the sound lane it is the same track that opens again.
    await page.mouse.move(x, v1.y + v1.height / 2, { steps: 4 });
    const onV1 = await shown();
    expect(onV1).toMatchObject({ lanes: 4, opened: [] });
    expect(onV1.changed).toBeGreaterThan(0);
    await page.mouse.move(x, y, { steps: 4 });
    expect(await shown()).toEqual(first);

    // Leaving the timeline takes the preview along, wherever the button is let go.
    const viewer = await box(page, '.viewer__stage');
    await page.mouse.move(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2, { steps: 6 });
    expect(await view(page)).toMatchObject({ preview: false, lanes: 4 });
    await page.mouse.up();
    expect(await view(page)).toMatchObject({ preview: false, lanes: 4 });
    // And a click on a trim handle afterwards edits nothing.
    const fractal = await clipBox(page, 'fractal.mp4');
    await page.mouse.click(fractal.x + fractal.width - 3, fractal.y + fractal.height / 2);
    expect(await layout(page)).toEqual(SAMPLE);

    // Escape while over the timeline does the same.
    await dragTo(page, from, [x, y], 10);
    await page.mouse.move(x + 1, y);
    expect((await view(page)).preview).toBe(true);
    await page.keyboard.press('Escape');
    expect(await view(page)).toMatchObject({ preview: false, lanes: 4 });
    await page.mouse.up();
    expect(await layout(page)).toEqual(SAMPLE);

    // Dropped, the clip lands on the track the preview showed, and that is the only track added.
    await dragTo(page, from, [x, y], 10);
    await page.mouse.move(x + 1, y);
    const planned = await page.evaluate(() => {
      const { ui, session } = (window as any).tandem;
      const pv = ui.getState().preview;
      const fresh = (Object.values(pv.clips) as any[]).find((c) => !session.store.get().clips[c.id]);
      const track = pv.tracks[fresh.trackId];
      return `${track.kind === 'video' ? 'V' : 'A'}${track.order + 1}@${fresh.start}`;
    });
    await page.mouse.up();
    await expect.poll(() => layout(page)).toEqual([...SAMPLE, 'V3:video@45+180'].sort());
    expect(planned).toBe('V3@45');
    expect(await view(page)).toMatchObject({ preview: false, lanes: 5 });
  });

  test('a library drag keeps its aim when a sound track opens below the last one', async ({ page }) => {
    await sample(page);
    // Sound on both audio tracks: anything with sound that is not aimed at one of them needs a third.
    await page.evaluate(() => {
      const store = (window as any).tandem.session.store;
      const p = store.get();
      const music = (Object.values(p.clips) as any[]).find((c) => c.type === 'audio');
      const a2 = (Object.values(p.tracks) as any[])
        .filter((t) => t.kind === 'audio')
        .sort((a, b) => a.order - b.order)[1];
      store.commit([{ op: 'addClip', clip: { ...music, id: 'second', trackId: a2.id } }]);
    });
    const busy = [...SAMPLE, 'A2:audio@0+360'];
    await importFixtures(page, ['testsrc.mp4']);
    await page.waitForFunction(() =>
      (Object.values((window as any).tandem.session.store.get().assets) as any[]).some(
        (a) => a.name === 'testsrc.mp4' && a.hasAudio,
      ),
    );
    const { ppf } = await view(page);
    /** What the preview adds, how many committed clips it changes, and how far the lanes are scrolled. */
    const planned = () =>
      page.evaluate(() => {
        const { ui, session } = (window as any).tandem;
        const p = session.store.get();
        const pv = ui.getState().preview;
        const name = (id: string) =>
          `${pv.tracks[id].kind === 'video' ? 'V' : 'A'}${pv.tracks[id].order + 1}`;
        const fresh = pv ? (Object.values(pv.clips) as any[]).filter((c) => !p.clips[c.id]) : [];
        return {
          added: fresh.map((c) => `${name(c.trackId)}:${c.type}@${c.start}+${c.duration}`).sort(),
          changed: pv ? (Object.values(p.clips) as any[]).filter((c) => pv.clips[c.id] !== c).length : 0,
          scrolled: document.querySelector('.tl__body')!.scrollTop,
          ids: fresh.map((c) => c.id),
        };
      });

    // Picture and sound, brought to a free stretch of V2. The picture lands under the pointer and
    // the sound on a third track below. The lanes stay put for that: scrolling to the new track
    // would take V2 away from under the pointer.
    const film = await box(page, '.asset:has-text("testsrc.mp4")');
    const v2 = await laneBox(page, 'V2');
    const x = v2.x + 200 * ppf;
    const y = v2.y + v2.height / 2;
    await dragTo(page, [film.x + 30, film.y + 30], [x, y], 10);
    const both = { added: ['A3:audio@200+120', 'V2:video@200+120'], changed: 0, scrolled: 0 };
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(x + (i % 2), y);
      expect(await planned()).toMatchObject(both);
    }
    expect((await laneBox(page, 'V2')).y).toBe(v2.y);
    await page.mouse.up();
    const withFilm = [...busy, ...both.added];
    await expect.poll(() => layout(page)).toEqual([...withFilm].sort());

    // Sound alone, over a video lane: all of it goes to a new track, so that track is scrolled
    // into view. The sound lanes slide under the pointer by that, and are left alone all the same.
    const sound = await box(page, '.asset:has-text("pulse.ogg")');
    const v1 = await laneBox(page, 'V1');
    const sx = v1.x + 100 * ppf;
    const sy = v1.y + v1.height - 8;
    await dragTo(page, [sound.x + 30, sound.y + 30], [sx, sy], 10);
    const alone = { added: ['A4:audio@100+540'], changed: 0 };
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(sx + (i % 2), sy);
      expect(await planned()).toMatchObject(alone);
    }
    const { ids, scrolled } = await planned();
    expect(scrolled).toBeGreaterThan(0);
    const moved = await laneBox(page, 'V1');
    expect(moved.y + moved.height).toBeLessThan(sy);
    // The new clip is in view and really shown there: at its middle the pointer would meet it.
    expect(
      await page.evaluate((id) => {
        const r = document.querySelector(`.clip[data-clip="${id}"]`)!.getBoundingClientRect();
        const b = document.querySelector('.tl__body')!.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + 40, r.top + r.height / 2);
        return (
          r.top >= b.top && r.bottom <= b.bottom && top?.closest('[data-clip]')?.getAttribute('data-clip')
        );
      }, ids[0]),
    ).toBe(ids[0]);
    // Given up, the drag leaves the lanes where it found them.
    await page.keyboard.press('Escape');
    expect(await planned()).toMatchObject({ added: [], scrolled: 0 });
    await page.mouse.up();
    expect(await layout(page)).toEqual([...withFilm].sort());
    // Dropped, the new track stays in view.
    await dragTo(page, [sound.x + 30, sound.y + 30], [sx, sy], 10);
    await page.mouse.move(sx + 1, sy);
    expect(await planned()).toMatchObject(alone);
    await page.mouse.up();
    await expect.poll(() => layout(page)).toEqual([...withFilm, ...alone.added].sort());
    expect((await planned()).scrolled).toBe(scrolled);
  });

  test('a transition dropped on the outgoing side of a cut joins the two clips', async ({ page }) => {
    await sample(page);
    const transitions = () =>
      page.evaluate(() =>
        (Object.values((window as any).tandem.session.store.get().clips) as any[])
          .filter((c) => c.type === 'video')
          .sort((a, b) => a.start - b.start)
          .map((c) => `${c.name} in=${c.transIn?.type ?? '-'} out=${c.transOut?.type ?? '-'}`),
      );
    await commit(page, [
      { op: 'updateClip', id: (await clip(page, 'fractal.mp4')).id, patch: { transIn: null } },
      { op: 'updateClip', id: (await clip(page, 'aurora.mp4')).id, patch: { transOut: null } },
    ]);
    await page.getByRole('tab', { name: 'Transitions' }).click();
    const tile = await box(page, '.fx:has-text("Cross Dissolve")');
    const from: [number, number] = [tile.x + tile.width / 2, tile.y + 20];

    // On the last half second of dusk, with fractal right behind it: the cut itself is meant.
    const dusk = await clipBox(page, 'dusk.mp4');
    await dragTo(page, from, [dusk.x + dusk.width - 20, dusk.y + dusk.height / 2], 10);
    await page.mouse.move(dusk.x + dusk.width - 21, dusk.y + dusk.height / 2);
    await expect(page.locator('.clip[data-hint]')).toHaveAttribute(
      'data-clip',
      (await clip(page, 'fractal.mp4')).id,
    );
    await expect(page.locator('.clip[data-hint]')).toHaveAttribute('data-hint', 'in');
    await page.mouse.up();
    await expect
      .poll(transitions)
      .toEqual([
        'dusk.mp4 in=dipToBlack out=-',
        'fractal.mp4 in=crossDissolve out=-',
        'aurora.mp4 in=lumaFade out=-',
      ]);

    // Nothing follows the last clip: there it is the clip's own way out.
    const aurora = await clipBox(page, 'aurora.mp4');
    await dragTo(page, from, [aurora.x + aurora.width - 20, aurora.y + aurora.height / 2], 10);
    await page.mouse.move(aurora.x + aurora.width - 21, aurora.y + aurora.height / 2);
    await page.mouse.up();
    await expect.poll(async () => (await transitions())[2]).toBe('aurora.mp4 in=lumaFade out=crossDissolve');

    // The dissolve reaches back across the cut, over the end of dusk. The end handle of dusk is
    // still what the pointer finds there, coming from inside the clip, whichever of the two clips
    // at the cut is selected. Clear of the handles, the transition is what a press finds, on
    // either side of the cut.
    const duskId = (await clip(page, 'dusk.mp4')).id;
    const fractalId = (await clip(page, 'fractal.mp4')).id;
    const y = dusk.y + dusk.height / 2;
    const cut = dusk.x + dusk.width;
    const select = (ids: string[]) =>
      page.evaluate((ids) => {
        const ui = (window as any).tandem.ui.getState();
        ui.set({ selectedTransition: null });
        ui.select(ids);
      }, ids);
    const trimsDusk = async () => {
      await page.mouse.move(dusk.x + 100, y);
      await page.mouse.move(cut - 3, y, { steps: 5 });
      await page.mouse.down();
      await page.mouse.move(cut - 43, y, { steps: 4 });
      const trimmed = await page.evaluate(
        (id) => (window as any).tandem.ui.getState().preview?.clips[id].duration ?? null,
        duskId,
      );
      await page.keyboard.press('Escape');
      await page.mouse.up();
      expect((await clip(page, 'dusk.mp4')).duration).toBe(120);
      return trimmed;
    };
    for (const selected of [[], [duskId], [fractalId], [duskId, fractalId]]) {
      await select(selected);
      expect(await trimsDusk()).toBeLessThan(120);
      for (const x of [cut - 14, cut + 15]) {
        await select(selected);
        await page.mouse.click(x, y);
        expect(await page.evaluate(() => (window as any).tandem.ui.getState().selectedTransition)).toEqual({
          clipId: fractalId,
          side: 'in',
        });
      }
    }
    // A clip that is switched off is dimmed, and keeps its end handle all the same.
    await commit(page, [{ op: 'updateClip', id: duskId, patch: { enabled: false } }]);
    await select([]);
    expect(await trimsDusk()).toBeLessThan(120);

    // Sound without a fade: the fade handle stands clear of the trim handle at that end, so
    // dragging it makes a fade and leaves the length of the clip alone.
    const musicId = (await clip(page, 'pulse.ogg')).id;
    await commit(page, [{ op: 'updateClip', id: musicId, patch: { fadeIn: 0 } }]);
    const music = await clipBox(page, 'pulse.ogg');
    await page.mouse.move(music.x + 200, music.y + music.height / 2);
    const fadeIn = page.locator(`.clip[data-clip="${musicId}"] .clip__fade--in`);
    const handle = (await fadeIn.boundingBox())!;
    expect(handle.x).toBeGreaterThanOrEqual(music.x + 7);
    const at: [number, number] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
    // A press that goes nowhere makes no fade, although the handle stands where a fade would end.
    await page.mouse.click(at[0], at[1]);
    expect((await clip(page, 'pulse.ogg')).fadeIn).toBe(0);
    // Taken along, the handle stays in sight and under the pointer, and the fade ends at it, to
    // the nearest frame: on the way out, and back to less than the handle stood for at rest.
    const { ppf } = await view(page);
    const middle = async () => {
      const b = (await fadeIn.boundingBox())!;
      return b.x + b.width / 2;
    };
    await page.mouse.move(at[0], at[1]);
    await page.mouse.down();
    for (const dx of [6, 25, 60, -6]) {
      await page.mouse.move(at[0] + dx, at[1], { steps: 3 });
      const centre = await middle();
      expect(Math.abs(centre - (at[0] + dx))).toBeLessThanOrEqual(ppf / 2 + 1);
      expect(centre - music.x).toBeCloseTo((await clip(page, 'pulse.ogg')).fadeIn * ppf, 0);
      await expect(fadeIn).toHaveCSS('opacity', '1');
    }
    // Let go, it stays where it was left.
    await page.mouse.move(at[0] + 60, at[1], { steps: 3 });
    const left = await middle();
    await page.mouse.up();
    expect(await middle()).toBeCloseTo(left, 1);
    const faded = await clip(page, 'pulse.ogg');
    expect(faded.fadeIn).toBeGreaterThan(10);
    expect([faded.start, faded.duration]).toEqual([0, 360]);
  });

  test('trims are planned on the project as it is at release, and short clips stay movable', async ({
    page,
  }) => {
    await sample(page);
    const ids = {
      title: (await clip(page, 'title')).id,
      dusk: (await clip(page, 'dusk.mp4')).id,
      fractal: (await clip(page, 'fractal.mp4')).id,
      aurora: (await clip(page, 'aurora.mp4')).id,
      music: (await clip(page, 'pulse.ogg')).id,
    };

    // Trim the end of the title; before the button is let go, someone else changes two other clips.
    const title = await clipBox(page, 'title');
    const mid = title.y + title.height / 2;
    await dragTo(page, [title.x + title.width - 3, mid], [title.x + title.width + 60, mid], 6);
    expect((await view(page)).preview).toBe(true);
    await commit(page, [
      { op: 'updateClip', id: ids.fractal, patch: { opacity: 0.3 } },
      { op: 'removeClip', id: ids.aurora },
    ]);
    await page.mouse.up();
    const trimmed = await clip(page, 'title');
    expect(trimmed.start).toBe(18);
    expect(trimmed.duration).toBeGreaterThan(100);
    expect((await clip(page, 'fractal.mp4')).opacity).toBe(0.3);
    expect(await clip(page, 'aurora.mp4')).toBeUndefined();
    expect((await view(page)).preview).toBe(false);

    // Zoomed far out the title is a few pixels wide. Its middle still moves it; it does not trim.
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ ppf: 0.08, scrollX: 0 }));
    const narrow = await clipBox(page, 'title');
    expect(narrow.width).toBeLessThan(12);
    const cy = narrow.y + narrow.height / 2;
    await dragTo(page, [narrow.x + narrow.width / 2, cy], [narrow.x + narrow.width / 2 + 40, cy], 6);
    await page.mouse.up();
    const moved = await clip(page, 'title');
    expect(moved.duration).toBe(trimmed.duration);
    expect(moved.start).toBeGreaterThan(300);
    // The same goes for a short clip that carries a transition.
    const short = await clipBox(page, 'dusk.mp4');
    const sy = short.y + short.height / 2;
    await dragTo(page, [short.x + short.width / 2, sy], [short.x + short.width / 2 + 40, sy], 6);
    await page.mouse.up();
    const dusk = await clip(page, 'dusk.mp4');
    expect(dusk.duration).toBe(120);
    expect(dusk.start).toBeGreaterThan(300);
    expect(dusk.transIn.type).toBe('dipToBlack');

    // A ripple trim that cannot move says why. Here the sound linked to fractal is locked, and
    // shortening dusk would pull fractal away from it. (The cut between the two is made a plain
    // one, so that the end of dusk is not shared with a transition.)
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    const a1 = (await clip(page, 'pulse.ogg')).trackId;
    await commit(page, [
      { op: 'updateClip', id: ids.fractal, patch: { linkId: 'pair', transIn: null } },
      { op: 'updateClip', id: ids.music, patch: { linkId: 'pair', start: 120, duration: 60 } },
      { op: 'updateTrack', id: a1, patch: { locked: true } },
    ]);
    await page.evaluate(() => {
      const { ui, cmd } = (window as any).tandem;
      cmd.zoomFit();
      ui.getState().clearSelection();
      ui.getState().set({ rippleMode: true });
    });
    const before = await layout(page);
    const end = await clipBox(page, 'dusk.mp4');
    const ey = end.y + end.height / 2;
    await dragTo(page, [end.x + end.width - 3, ey], [end.x + end.width - 70, ey], 6);
    await page.mouse.up();
    await expect(toast(page, 'Unlock A1 to ripple: a linked clip on it has to move too.')).toBeVisible();
    expect(await layout(page)).toEqual(before);

    // So does a ripple delete of a marked range that would leave the locked half behind.
    await commit(page, [{ op: 'updateTrack', id: a1, patch: { name: 'Music' } }]);
    await page.evaluate(() => {
      const { ui, session } = (window as any).tandem;
      ui.getState().clearSelection();
      session.player.setRange({ in: 30, out: 60 });
    });
    await page.keyboard.press('Shift+Delete');
    await expect(toast(page, 'Unlock Music to ripple: a linked clip on it has to move too.')).toBeVisible();
    expect(await layout(page)).toEqual(before);
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().range)).toEqual({
      in: 30,
      out: 60,
    });
  });

  test('dragging past the outermost lane opens a track there, and only while the pointer is there', async ({
    page,
  }) => {
    await sample(page);
    // A shorter V2 leaves the audio lanes clear of the bottom edge, with no room for one more.
    await commit(page, [
      { op: 'updateTrack', id: (await clip(page, 'title')).trackId, patch: { height: 40 } },
    ]);
    const previewTrackOf = (name: string) =>
      page.evaluate((name) => {
        const pv = (window as any).tandem.ui.getState().preview;
        const c =
          pv &&
          (Object.values(pv.clips) as any[]).find((c) =>
            name === 'title' ? c.type === 'text' : c.name === name,
          );
        return c
          ? `${pv.tracks[c.trackId].kind === 'video' ? 'V' : 'A'}${pv.tracks[c.trackId].order + 1}`
          : null;
      }, name);

    const title = await clipBox(page, 'title');
    const grab: [number, number] = [title.x + title.width / 2, title.y + title.height / 2];
    const top = await laneBox(page, 'V2');
    await dragTo(page, grab, [grab[0], top.y - 12], 6);
    expect((await view(page)).lanes).toBe(5);
    expect(await previewTrackOf('title')).toBe('V3');
    // The new lane does not come and go while the pointer stays out there.
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(grab[0] + i, top.y - 12);
      expect((await view(page)).lanes).toBe(5);
    }
    // Back where it started the lanes are as they were, and letting go there changes nothing.
    await page.mouse.move(grab[0], grab[1], { steps: 6 });
    expect((await view(page)).lanes).toBe(4);
    await page.mouse.up();
    expect(await layout(page)).toEqual(SAMPLE);
    expect(await view(page)).toMatchObject({ preview: false, lanes: 4 });

    // Sound goes the other way: below the last lane. The lane that opens there is scrolled into view.
    const music = await clipBox(page, 'pulse.ogg');
    const body = await box(page, '.tl__body');
    const a2 = await laneBox(page, 'A2');
    const below = body.y + body.height - 3;
    expect(a2.y + a2.height + 4).toBeLessThan(below);
    await dragTo(page, [music.x + 200, music.y + music.height / 2], [music.x + 205, below], 8);
    await expect.poll(() => previewTrackOf('pulse.ogg')).toBe('A3');
    const musicId = (await clip(page, 'pulse.ogg')).id;
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const el = document.querySelector(`.clip[data-clip="${id}"]`)!.getBoundingClientRect();
          const b = document.querySelector('.tl__body')!.getBoundingClientRect();
          return el.top >= b.top && el.bottom <= b.bottom;
        }, musicId),
      )
      .toBe(true);
    // It is really shown there: at its middle the pointer would meet the clip.
    const onTop = () =>
      page.evaluate((id) => {
        const r = document.querySelector(`.clip[data-clip="${id}"]`)!.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + 100, r.top + r.height / 2);
        return top?.closest('[data-clip]')?.getAttribute('data-clip') === id;
      }, musicId);
    expect(await onTop()).toBe(true);
    // Back over A2 the track is given up and the lanes return to where they were. The bottom edge
    // has not moved them on the way: all that is out of view is some of the room under A2.
    const scrolled = () => page.evaluate(() => document.querySelector('.tl__body')!.scrollTop);
    expect(await scrolled()).toBeGreaterThan(0);
    await page.mouse.move(music.x + 205, a2.y + a2.height / 2, { steps: 4 });
    await expect.poll(() => previewTrackOf('pulse.ogg')).toBe('A2');
    expect(await scrolled()).toBe(0);
    expect((await laneBox(page, 'A2')).y).toBe(a2.y);
    // Out there again and let go: the track is kept, and stays in view.
    await page.mouse.move(music.x + 205, below, { steps: 4 });
    await expect.poll(() => previewTrackOf('pulse.ogg')).toBe('A3');
    await page.mouse.up();
    await expect
      .poll(() => layout(page))
      .toEqual(SAMPLE.map((c) => c.replace('A1:audio', 'A3:audio')).sort());
    expect(await scrolled()).toBeGreaterThan(0);
    expect(await onTop()).toBe(true);
  });

  test('the view follows a drag at its edge and stops when the drag ends', async ({ page }) => {
    await sample(page);
    await page.evaluate(() => {
      const { ui, cmd } = (window as any).tandem;
      cmd.zoom(2);
      ui.getState().set({ scrollX: 0 });
    });
    const scrollX = async () => (await view(page)).scrollX;
    const settled = async () => {
      const at = await scrollX();
      await page.waitForTimeout(400);
      expect(await scrollX()).toBe(at);
    };
    const lanes = await box(page, '.lanes');
    const right = lanes.x + lanes.width;

    // A clip held at the right edge: the view scrolls and the clip travels with it.
    const title = await clipBox(page, 'title');
    const y = title.y + title.height / 2;
    await dragTo(page, [title.x + 40, y], [right - 200, y], 6);
    await page.waitForTimeout(300);
    expect(await scrollX()).toBe(0);
    await page.mouse.move(right - 5, y, { steps: 4 });
    await expect.poll(scrollX, { timeout: 30_000 }).toBeGreaterThan(150);
    const previewStart = () =>
      page.evaluate(() => {
        const pv = (window as any).tandem.ui.getState().preview;
        return pv ? (Object.values(pv.clips) as any[]).find((c) => c.type === 'text').start : -1;
      });
    const start = await previewStart();
    await expect.poll(previewStart, { timeout: 30_000 }).toBeGreaterThan(start);
    await page.mouse.up();
    await settled();
    const dropped = (await clip(page, 'title')).start;
    expect(dropped).toBeGreaterThan(start);

    // Back at the left edge it scrolls the other way.
    const moved = await clipBox(page, 'title');
    const from = await scrollX();
    await dragTo(page, [moved.x + 20, y], [lanes.x + 3, y], 10);
    await expect.poll(scrollX, { timeout: 30_000 }).toBeLessThan(from - 100);
    await page.mouse.up();
    await settled();
    expect((await clip(page, 'title')).start).toBeLessThan(dropped);

    // Scrubbing the ruler past the right edge takes the view and the playhead along.
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ scrollX: 0 }));
    const ruler = await box(page, '.ruler');
    await dragTo(page, [ruler.x + 300, ruler.y + 15], [ruler.x + ruler.width + 30, ruler.y + 15], 6);
    await expect.poll(scrollX, { timeout: 30_000 }).toBeGreaterThan(100);
    // The playhead is past everything that was in view when the scrub began.
    const { ppf } = await view(page);
    expect(await page.evaluate(() => (window as any).tandem.session.player.getFrame())).toBeGreaterThan(
      ruler.width / ppf,
    );
    await page.mouse.up();
    await settled();

    // A marquee dragged to the edge keeps growing into what scrolls in.
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ scrollX: 0 }));
    const a2 = await laneBox(page, 'A2');
    const v2 = await laneBox(page, 'V2');
    await dragTo(page, [a2.x + 30, a2.y + 10], [right - 4, v2.y + 30], 10);
    await expect.poll(scrollX, { timeout: 30_000 }).toBeGreaterThan(150);
    await expect.poll(async () => (await view(page)).selection, { timeout: 30_000 }).toBe(5);
    await page.mouse.up();
    await settled();

    // Something dragged in from the library scrolls the view too, and leaving the timeline stops it.
    await page.evaluate(() => {
      const { ui } = (window as any).tandem;
      ui.getState().set({ scrollX: 0 });
      ui.getState().clearSelection();
    });
    const asset = await box(page, '.asset:has-text("fractal.mp4")');
    await dragTo(page, [asset.x + 30, asset.y + 30], [right - 200, v2.y + 30], 10);
    await page.mouse.move(right - 5, v2.y + 30, { steps: 4 });
    await expect.poll(scrollX, { timeout: 30_000 }).toBeGreaterThan(100);
    const viewer = await box(page, '.viewer__stage');
    await page.mouse.move(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2, { steps: 4 });
    await settled();
    expect((await view(page)).preview).toBe(false);
    await page.mouse.up();
  });

  test('with more tracks than fit, the lanes follow a drag held at their top or bottom edge', async ({
    page,
  }) => {
    await sample(page);
    const scrolled = () => page.evaluate(() => document.querySelector('.tl__body')!.scrollTop);
    const settled = async () => {
      const at = await scrolled();
      await page.waitForTimeout(600);
      expect(await scrolled()).toBe(at);
    };
    /**
     * How far the lanes scroll, and how far a drag takes them: until the last lane ends at the
     * bottom edge. The 26 pixels of empty room under that lane stay out of view.
     */
    const reach = () =>
      page.evaluate(() => {
        const b = document.querySelector('.tl__body')!;
        return { furthest: b.scrollHeight - b.clientHeight, stop: b.scrollHeight - b.clientHeight - 26 };
      });
    /** Scroll the lanes so that the top of the lane labelled `label` lies `offset` below their top edge. */
    const bring = (label: string, offset: number) =>
      page.evaluate(
        ([label, offset]) => {
          const tags = Array.from(document.querySelectorAll('.th__tag'), (e) => e.textContent);
          const lane = document.querySelectorAll<HTMLElement>('.lane')[tags.indexOf(label as string)];
          document.querySelector('.tl__body')!.scrollTop = lane.offsetTop - (offset as number);
        },
        [label, offset],
      );
    /** The label of the lane that lies at this height of the window. */
    const laneAt = (y: number) =>
      page.evaluate((y) => {
        const tags = Array.from(document.querySelectorAll('.th__tag'), (e) => e.textContent);
        const at = Array.from(document.querySelectorAll('.lane')).findIndex((l) => {
          const r = l.getBoundingClientRect();
          return y >= r.top && y < r.bottom;
        });
        return tags[at] ?? null;
      }, y);
    /** The track the previewed (or committed) clip is on. */
    const trackOf = (name: string) =>
      page.evaluate((name) => {
        const { ui, session } = (window as any).tandem;
        const p = ui.getState().preview ?? session.store.get();
        const c = (Object.values(p.clips) as any[]).find((c) =>
          name === 'title' ? c.type === 'text' : c.name === name,
        );
        return `${p.tracks[c.trackId].kind === 'video' ? 'V' : 'A'}${p.tracks[c.trackId].order + 1}`;
      }, name);
    const body = await box(page, '.tl__body');
    const bottom = body.y + body.height - 4;
    const past = body.y + body.height + 6;

    // The sample as it comes: the bottom edge cuts off the last lane, A2, and under that lane there
    // is some empty room. The music held on the lower part of what shows of A2 goes to A2 and stays
    // there. The lanes come up until all of A2 shows and no further: the room under it would open a
    // track under a pointer that has not moved.
    const short = await reach();
    expect(short.stop).toBeGreaterThan(0);
    const a2 = await laneBox(page, 'A2');
    const held = body.y + body.height - 12;
    expect(a2.y + a2.height).toBeGreaterThan(body.y + body.height);
    expect(held).toBeGreaterThan(a2.y + 20);
    const pulse = await clipBox(page, 'pulse.ogg');
    await dragTo(page, [pulse.x + 200, pulse.y + pulse.height / 2], [pulse.x + 205, held], 6);
    await expect.poll(scrolled, { timeout: 30_000 }).toBe(short.stop);
    await settled();
    expect(await trackOf('pulse.ogg')).toBe('A2');
    await expect(page.locator('.lane')).toHaveCount(4);
    // So it is down to the last row of pixels above the edge. Past the edge a track opens, as it
    // does past the last lane anywhere, and on the way back it is given up.
    await page.mouse.move(pulse.x + 205, body.y + body.height - 1, { steps: 3 });
    await settled();
    expect(await trackOf('pulse.ogg')).toBe('A2');
    await expect(page.locator('.lane')).toHaveCount(4);
    await page.mouse.move(pulse.x + 205, past, { steps: 3 });
    await expect.poll(() => trackOf('pulse.ogg')).toBe('A3');
    await expect(page.locator('.lane')).toHaveCount(5);
    await page.mouse.move(pulse.x + 205, held, { steps: 3 });
    await expect.poll(() => trackOf('pulse.ogg')).toBe('A2');
    await expect.poll(scrolled).toBe(short.stop);
    await expect(page.locator('.lane')).toHaveCount(4);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await layout(page)).toEqual(SAMPLE);

    await page.evaluate(() => {
      const { cmd } = (window as any).tandem;
      for (let i = 0; i < 4; i++) {
        cmd.addTrack('video');
        cmd.addTrack('audio');
      }
    });
    await expect(page.locator('.lane')).toHaveCount(12);
    const { furthest, stop } = await reach();
    expect(stop).toBeGreaterThan(200);

    // The music, taken from A1. In the middle of the lanes nothing scrolls; held at the bottom edge
    // the lanes come up under it, and the clip is on whichever one has reached the pointer.
    await bring('A1', 60);
    const from = await scrolled();
    const music = await clipBox(page, 'pulse.ogg');
    const x = music.x + 205;
    await dragTo(page, [music.x + 200, music.y + 10], [x, body.y + body.height / 2], 5);
    await page.waitForTimeout(300);
    expect(await scrolled()).toBe(from);
    await page.mouse.move(x, bottom, { steps: 6 });
    await expect.poll(scrolled, { timeout: 30_000 }).toBeGreaterThan(from + 40);
    // They stop with the last lane at the edge, and the clip is on it.
    await expect.poll(scrolled, { timeout: 30_000 }).toBe(stop);
    await settled();
    expect(await trackOf('pulse.ogg')).toBe('A6');
    await expect(page.locator('.lane')).toHaveCount(12);
    // Past the edge the pointer is past the last lane. The track that opens there is scrolled to
    // once, and the two kinds of scrolling do not take turns after that.
    await page.mouse.move(x, past, { steps: 3 });
    await expect.poll(() => trackOf('pulse.ogg')).toBe('A7');
    await expect.poll(scrolled).toBeGreaterThan(stop);
    await settled();
    await expect(page.locator('.lane')).toHaveCount(13);
    // Back among the lanes the track is given up. The lanes return to the end the edge had taken
    // them to, not to where the drag began, and the clip is on the lane the pointer is over there.
    await page.mouse.move(x, bottom - 60, { steps: 4 });
    await expect.poll(scrolled).toBe(stop);
    await expect(page.locator('.lane')).toHaveCount(12);
    expect(await trackOf('pulse.ogg')).toBe(await laneAt(bottom - 60));
    await settled();
    // Scrolled on by the wheel, the room under the last lane is in view, and there the pointer is
    // past the last lane without leaving the lanes. The wheel turned while the track that opens
    // is being shown counts for what the pointer is over, and is still there when that track is
    // given up.
    await page.mouse.wheel(0, furthest - stop);
    await expect.poll(scrolled).toBe(furthest);
    await page.mouse.move(x, bottom, { steps: 4 });
    await expect.poll(() => trackOf('pulse.ogg')).toBe('A7');
    await expect.poll(scrolled, { timeout: 30_000 }).toBeGreaterThan(furthest);
    await page.mouse.wheel(0, -150);
    await expect.poll(scrolled).toBeLessThan(furthest);
    await page.mouse.move(x + 1, bottom);
    await expect.poll(scrolled).toBe(furthest - 150);
    expect(await trackOf('pulse.ogg')).toBe(await laneAt(bottom));
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settled();
    expect(await layout(page)).toEqual(SAMPLE);

    // The title, held at the top edge, goes up through the video lanes to the topmost one.
    await bring('V2', 80);
    const title = await clipBox(page, 'title');
    await dragTo(page, [title.x + 40, title.y + 30], [title.x + 40, body.y + 5], 6);
    await expect.poll(scrolled, { timeout: 30_000 }).toBe(0);
    await expect.poll(() => trackOf('title')).toBe('V6');
    await page.mouse.up();
    await settled();
    expect(await layout(page)).toEqual(SAMPLE.map((c) => c.replace('V2:text', 'V6:text')).sort());

    // A clip that is taken hold of inside the strip does not send the lanes off: only heading for
    // the edge does.
    await bring('A1', body.height - 46);
    const low = await clipBox(page, 'pulse.ogg');
    const grab = low.y + low.height - 12;
    expect(body.y + body.height - grab).toBeLessThan(32);
    const rest = await scrolled();
    await dragTo(page, [low.x + 300, grab], [low.x + 340, grab - 2], 4);
    await page.waitForTimeout(500);
    expect(await scrolled()).toBe(rest);
    await page.mouse.move(low.x + 340, grab + 9, { steps: 3 });
    await expect.poll(scrolled, { timeout: 30_000 }).toBeGreaterThan(rest);
    await page.keyboard.press('Escape');
    await page.mouse.up();

    // A trim follows the pointer in time only: at the bottom edge it leaves the lanes where they are.
    await bring('A1', 100);
    const kept = await scrolled();
    const end = await clipBox(page, 'pulse.ogg');
    await dragTo(page, [end.x + end.width - 3, end.y + 30], [end.x + end.width - 80, bottom + 2], 6);
    await page.waitForTimeout(600);
    expect((await view(page)).preview).toBe(true);
    expect(await scrolled()).toBe(kept);
    await page.keyboard.press('Escape');
    await page.mouse.up();

    // Something brought in from the library scrolls the lanes too, until it leaves the timeline.
    await page.evaluate(() => (document.querySelector('.tl__body')!.scrollTop = 0));
    const asset = await box(page, '.asset:has-text("pulse.ogg")');
    const lanes = await box(page, '.lanes');
    await dragTo(page, [asset.x + 30, asset.y + 30], [lanes.x + 700, body.y + 80], 8);
    await page.waitForTimeout(300);
    expect(await scrolled()).toBe(0);
    await page.mouse.move(lanes.x + 700, bottom, { steps: 6 });
    await expect.poll(scrolled, { timeout: 30_000 }).toBeGreaterThan(40);
    const viewer = await box(page, '.viewer__stage');
    await page.mouse.move(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2, { steps: 4 });
    await settled();
    expect((await view(page)).preview).toBe(false);
    await page.mouse.up();
  });

  test('ruler and lane menus act where they were opened, and markers can be edited', async ({ page }) => {
    await sample(page);
    const markers = () =>
      page.evaluate(() =>
        (Object.values((window as any).tandem.session.store.get().markers) as any[])
          .map((m) => `${m.name}@${m.frame}`)
          .sort(),
      );
    const { ppf } = await view(page);
    const ruler = await box(page, '.ruler');

    // Double-clicking a marker opens its editor.
    const first = await box(page, '.marker');
    const onMarker: [number, number] = [first.x + first.width / 2, first.y + first.height / 2];
    await page.mouse.dblclick(...onMarker);
    const name = page.getByLabel('Marker name');
    await expect(name).toBeVisible();
    await name.fill('Opening ends');
    await name.press('Enter');
    await expect(name).toHaveCount(0);
    expect(await markers()).toEqual(['Opening ends@120']);

    // Right-click the ruler at frame 250 (far from any cut) with the playhead on 45.
    await page.mouse.click(ruler.x + 250 * ppf, ruler.y + 8, { button: 'right' });
    await menuItem(page, 'Add marker here').click();
    await expect.poll(markers).toEqual(['Marker 2@250', 'Opening ends@120']);
    expect(await page.evaluate(() => (window as any).tandem.session.player.getFrame())).toBe(120);
    // Asking again at the same place does not take the marker away.
    await page.mouse.click(ruler.x + 250 * ppf, ruler.y + 8, { button: 'right' });
    await menuItem(page, 'Add marker here').click();
    expect(await markers()).toEqual(['Marker 2@250', 'Opening ends@120']);

    // A marker's own menu edits and deletes it.
    await page.mouse.click(...onMarker, { button: 'right' });
    await menuItem(page, 'Edit marker').click();
    await expect(name).toHaveValue('Opening ends');
    await page.keyboard.press('Escape');
    await expect(name).toHaveCount(0);
    await page.mouse.click(...onMarker, { button: 'right' });
    await menuItem(page, 'Delete marker').click();
    await expect.poll(markers).toEqual(['Marker 2@250']);

    // Two gaps: one on V1 after dusk, one on V2 before the title, which is where the playhead goes.
    const later = ['fractal.mp4', 'aurora.mp4'];
    await commit(
      page,
      await Promise.all(
        later.map(async (n) => {
          const c = await clip(page, n);
          return { op: 'updateClip', id: c.id, patch: { start: c.start + 60 } };
        }),
      ),
    );
    await page.evaluate(() => (window as any).tandem.cmd.seek(5));
    const v1 = await laneBox(page, 'V1');
    await page.mouse.click(v1.x + 150 * ppf, v1.y + v1.height / 2, { button: 'right' });
    await menuItem(page, 'Close gap here').click();
    // The gap under the pointer closed; the one under the playhead is still there.
    await expect.poll(() => layout(page)).toEqual(SAMPLE);
    // Where there is no gap to close the entry is not on offer.
    await page.mouse.click(v1.x + 380 * ppf, v1.y + v1.height / 2, { button: 'right' });
    await expect(menuItem(page, 'Close gap here')).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('a commit repaints only the lanes whose clips it changed', async ({ page }) => {
    await sample(page);
    const paints = await page.evaluate(async () => {
      const { session } = (window as any).tandem;
      const clips = Object.values(session.store.get().clips) as any[];
      const title = clips.find((c) => c.type === 'text');
      const music = clips.find((c) => c.type === 'audio');
      const painted: Element[] = [];
      const proto = CanvasRenderingContext2D.prototype;
      const clearRect = proto.clearRect;
      proto.clearRect = function (...args) {
        if (this.canvas.classList.contains('lane__canvas')) painted.push(this.canvas.closest('.lane')!);
        return clearRect.apply(this, args);
      };
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      /**
       * The lanes painted while `commit` ran `times`, a frame apart. What a commit paints is
       * painted with every commit. A thumbnail, a stretch of waveform or an upload that finishes
       * paints lanes too, whenever it happens to arrive, so a measurement that holds more than
       * the commits may account for is made again: for a minute, after which the last one stands.
       */
      const during = async (
        times: number,
        commit: (i: number) => void,
        explained: (lanes: Element[]) => boolean,
      ): Promise<Element[]> => {
        const began = performance.now();
        for (;;) {
          painted.length = 0;
          for (let i = 0; i < times; i++) {
            commit(i);
            await frame();
          }
          // What the last commit set off has been painted two frames on.
          await frame();
          await frame();
          const lanes = painted.slice();
          if (explained(lanes) || performance.now() - began > 60_000) return lanes;
        }
      };
      const forTitle = await during(
        20,
        (i) =>
          session.store.commit([{ op: 'updateClip', id: title.id, patch: { opacity: 0.5 + i / 100 } }], {
            merge: true,
          }),
        (lanes) => lanes.length === 0,
      );
      const forMusic = await during(
        5,
        (i) =>
          session.store.commit([{ op: 'updateClip', id: music.id, patch: { volume: -5 - i } }], {
            merge: true,
          }),
        (lanes) => lanes.length <= 5 && new Set(lanes).size <= 1,
      );
      proto.clearRect = clearRect;
      return { forTitle: forTitle.length, forMusic: forMusic.length, lanes: new Set(forMusic).size };
    });
    // The title has no picture on a lane canvas; the music's waveform follows its volume.
    expect(paints.forTitle).toBe(0);
    expect(paints.forMusic).toBeGreaterThan(0);
    expect(paints.forMusic).toBeLessThanOrEqual(5);
    expect(paints.lanes).toBe(1);
  });

  test('a clip whose media is gone has the red strip that says so, however short it is', async ({ page }) => {
    await sample(page);
    // Two clips of a file the project no longer has, one of them too short for a name, and a short
    // clip that has its file.
    const spare = {
      ...(await clip(page, 'aurora.mp4')),
      trackId: (await clip(page, 'title')).trackId,
      transIn: null,
      transOut: null,
    };
    // And two of a file the project still lists, but which is on neither this device nor a server:
    // what a project file opened on another computer brings along.
    const listed = await page.evaluate(
      (id) => (window as any).tandem.session.store.get().assets[id],
      spare.assetId,
    );
    await commit(page, [
      { op: 'addClip', clip: { ...spare, id: 'lost', assetId: 'gone', start: 380 } },
      { op: 'addClip', clip: { ...spare, id: 'lost-short', assetId: 'gone', start: 520, duration: 10 } },
      { op: 'addClip', clip: { ...spare, id: 'short', start: 540, duration: 10 } },
      { op: 'addAsset', asset: { ...listed, id: 'away', name: 'away.mp4', uploaded: false } },
      { op: 'addClip', clip: { ...spare, id: 'away-long', assetId: 'away', name: 'away.mp4', start: 560 } },
      { op: 'addClip', clip: { ...spare, id: 'away-short', assetId: 'away', start: 700, duration: 10 } },
    ]);
    await page.evaluate(() => (window as any).tandem.cmd.zoomFit());
    // The pool marks that file offline, and the timeline goes by the same rule.
    await expect(page.locator('.asset[aria-label="away.mp4"]')).toHaveAttribute('data-offline', 'true');
    const away = page.locator('.clip[data-clip="away-long"]');
    await expect(away).toHaveAttribute('data-missing', 'true');
    await expect(away.locator('.clip__chip', { hasText: 'Offline' })).toBeVisible();
    await expect(away).toHaveAttribute('aria-label', /^away\.mp4, V2, .*, media offline$/);
    await expect(page.locator('.clip[data-clip="short"]')).toHaveAttribute('data-missing', 'false');
    const strip = page.locator('.clip[data-clip="lost"] .clip__label');
    await expect(strip.locator('.clip__chip', { hasText: 'Offline' })).toBeVisible();
    await expect(page.locator('.clip[data-clip="lost-short"]')).toBeVisible();
    await expect(page.locator('.clip[data-clip="lost-short"] .clip__label')).toHaveCount(0);
    // The strip of the long one is an element. Where a clip has no room for that, the lane canvas
    // paints the strip, and for a clip without its file it paints it in the same red.
    const red = await strip.evaluate((label) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = getComputedStyle(label).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    });
    const painted = (id: string) =>
      page.evaluate((id) => {
        const el = document.querySelector(`.clip[data-clip="${id}"]`)!;
        const canvas = el.closest('.lane')!.querySelector('canvas')!;
        const r = el.getBoundingClientRect();
        const c = canvas.getBoundingClientRect();
        const scale = canvas.width / c.width;
        const x = Math.round((r.left + r.width / 2 - c.left) * scale);
        return Array.from(
          canvas
            .getContext('2d')!
            .getImageData(x, Math.round(8 * scale), 1, 1)
            .data.slice(0, 3),
        );
      }, id);
    expect(red[0]).toBeGreaterThan(red[1] + red[2]);
    await expect.poll(() => painted('lost-short')).toEqual(red);
    await expect.poll(() => painted('away-short')).toEqual(red);
    const healthy = await painted('short');
    expect(healthy[2]).toBeGreaterThan(healthy[0]);
  });

  test('asking for a title goes straight to typing it', async ({ page }) => {
    await sample(page);
    const field = page.getByLabel('Text content');
    const texts = () =>
      page.evaluate(() =>
        (Object.values((window as any).tandem.session.store.get().clips) as any[])
          .filter((c) => c.type === 'text')
          .sort((a, b) => a.start - b.start)
          .map((c) => c.text.content),
      );
    await page.evaluate(() => (window as any).tandem.cmd.seek(200));
    await page.keyboard.press('t');
    await expect(field).toBeFocused();
    await page.keyboard.type('hold shot');
    // Typed over the placeholder, and none of those letters ran a shortcut (h, l, o, s, d, t all have one).
    await expect.poll(texts).toEqual(['Edit in tandem', 'hold shot']);
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().tool)).toBe('select');
    expect(await page.evaluate(() => (window as any).tandem.session.player.getState().range)).toBeNull();
    expect(await layout(page)).toHaveLength(6);
    await page.keyboard.press('Escape');
    await expect(field).not.toBeFocused();

    // Double-clicking a title on the timeline does the same, also when its section was folded away.
    await page.locator('.section__head', { hasText: /^Text$/ }).click();
    await expect(field).toHaveCount(0);
    const first = await clipBox(page, 'title');
    await page.mouse.dblclick(first.x + first.width / 2, first.y + first.height / 2);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Edit in tandem');
    expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([
      0, 14,
    ]);
    await page.keyboard.press('Escape');

    // And so does double-clicking it in the viewer, without moving it.
    await page.evaluate(() => {
      const { ui, cmd } = (window as any).tandem;
      ui.getState().clearSelection();
      cmd.seek(45);
    });
    const frame = await box(page, '.viewer__frame');
    await page.mouse.dblclick(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Edit in tandem');
    const title = await clip(page, 'title');
    expect([title.x, title.y]).toEqual([0, 0]);
  });

  test('the viewer selects what is under the pointer, turns it smoothly, and says when the context is lost', async ({
    page,
  }) => {
    await sample(page);
    const selected = () =>
      page.evaluate(() => {
        const { ui, session } = (window as any).tandem;
        return ui.getState().selection.map((id: string) => session.store.get().clips[id].type);
      });
    const frame = await box(page, '.viewer__frame');
    const centre: [number, number] = [frame.x + frame.width / 2, frame.y + frame.height / 2];
    const corner: [number, number] = [frame.x + 40, frame.y + 40];

    // The title lies over the full-frame video. Selecting the video must not hide the title from clicks.
    await page.mouse.click(...corner);
    await expect.poll(selected).toEqual(['video']);
    await page.mouse.click(...centre);
    await expect.poll(selected).toEqual(['text']);
    // Pressing on the title while the video is selected drags the title, not the video.
    await page.mouse.click(...corner);
    await expect.poll(selected).toEqual(['video']);
    await dragTo(page, centre, [centre[0] + 60, centre[1] + 40], 5);
    await page.mouse.up();
    const title = await clip(page, 'title');
    expect(title.x).toBeGreaterThan(0.05);
    expect(title.y).toBeGreaterThan(0.05);
    const dusk = await clip(page, 'dusk.mp4');
    expect([dusk.x, dusk.y]).toEqual([0, 0]);
    expect(await selected()).toEqual(['text']);
    await page.evaluate(() => (window as any).tandem.cmd.undo());

    // A layer that lies wholly under another has no free spot to be taken by. Selected on the
    // timeline, it is what a drag in its box moves; a click there goes to the layer on top.
    await page.evaluate((id) => {
      const { cmd, ui } = (window as any).tandem;
      cmd.addSolid();
      ui.getState().select([id]);
    }, title.id);
    await expect.poll(selected).toEqual(['text']);
    await expect(page.locator('.gizmo__body')).toHaveCount(1);
    await dragTo(page, centre, [centre[0] + 60, centre[1] + 40], 5);
    await page.mouse.up();
    const under = await clip(page, 'title');
    expect(under.x).toBeGreaterThan(0.05);
    expect(under.y).toBeGreaterThan(0.05);
    const solid = await page.evaluate(() =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
        (c) => c.type === 'solid',
      ),
    );
    expect([solid.x, solid.y]).toEqual([0, 0]);
    expect(await selected()).toEqual(['text']);
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await page.mouse.move(...centre);
    await page.mouse.down();
    await page.mouse.move(centre[0] + 1, centre[1] + 1);
    await page.mouse.up();
    await expect.poll(selected).toEqual(['solid']);
    expect((await clip(page, 'title')).x).toBe(0);
    // Take the solid away again.
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await expect.poll(async () => (await layout(page)).length).toBe(SAMPLE.length);

    // The rotation handle of a layer that fills the frame is inside the panel.
    await page.mouse.click(...corner);
    await expect.poll(selected).toEqual(['video']);
    const handle = await box(page, '.gizmo__rotate');
    expect(handle.y).toBeGreaterThanOrEqual((await box(page, '.viewer__stage')).y);

    // Turn the title counter-clockwise through 225°, around its middle, 15° at a time.
    const turn = async (read: (c: any) => number): Promise<number[]> => {
      const h = await box(page, '.gizmo__rotate');
      const b = await box(page, '.gizmo__body');
      const pivot = [b.x + b.width / 2, b.y + b.height / 2];
      const start = [h.x + h.width / 2, h.y + h.height / 2];
      const radius = Math.hypot(start[0] - pivot[0], start[1] - pivot[1]);
      const seen: number[] = [];
      await page.mouse.move(start[0], start[1]);
      await page.mouse.down();
      for (let deg = 15; deg <= 225; deg += 15) {
        const a = ((-90 - deg) * Math.PI) / 180;
        await page.mouse.move(pivot[0] + radius * Math.cos(a), pivot[1] + radius * Math.sin(a));
        seen.push(read(await clip(page, 'title')));
      }
      await page.mouse.up();
      return seen;
    };
    const steps = Array.from({ length: 15 }, (_, i) => -15 * (i + 1));
    const near = (seen: number[], want: number[]) =>
      expect(seen.map((v, i) => Math.abs(v - want[i]) < 2)).toEqual(want.map(() => true));
    await page.mouse.click(...centre);
    await expect.poll(selected).toEqual(['text']);
    // A rotation that stands still is stored within half a turn: past -180° it reads 165°, 150°, …
    near(
      await turn((c) => c.rotation),
      steps.map((d) => (d <= -180 ? d + 360 : d)),
    );
    // Between keyframes the turn itself counts: there it runs on to -225° and never jumps by 360°.
    await commit(page, [
      {
        op: 'updateClip',
        id: title.id,
        patch: { rotation: 0, keyframes: { rotation: [{ t: 0, v: 0, e: 'linear' }] } },
      },
    ]);
    await expect.poll(async () => (await box(page, '.gizmo__rotate')).y).toBeLessThan(centre[1] - 20);
    // The playhead is on frame 45 and the title starts on 18: the key lands on its frame 27.
    near(await turn((c) => c.keyframes.rotation.find((k: any) => k.t === 27)?.v ?? 0), steps);

    // Grading and mixing show the picture without handles; clicking it still selects.
    const workspace = (id: string) =>
      page.evaluate((id) => (window as any).tandem.ui.getState().set({ workspace: id }), id);
    await expect(page.locator('.gizmo__handle')).toHaveCount(8);
    await workspace('color');
    await expect(page.locator('.gizmo__handle')).toHaveCount(0);
    await expect(page.locator('.gizmo__body')).toHaveCount(0);
    const graded = await box(page, '.viewer__frame');
    await page.mouse.click(graded.x + 20, graded.y + 20);
    await expect.poll(selected).toEqual(['video']);
    await workspace('audio');
    await expect(page.locator('.gizmo__body')).toHaveCount(0);
    await workspace('edit');
    await expect(page.locator('.gizmo__handle')).toHaveCount(8);

    // Losing the graphics context is said in so many words, and unsaid when it is back.
    await page.evaluate(() => {
      const gl = (window as any).tandem.session.player.compositor.glx.gl;
      (window as any).lose = gl.getExtension('WEBGL_lose_context');
      (window as any).lose.loseContext();
    });
    await expect(page.locator('.viewer__lost')).toContainText('The graphics context was lost');
    await page.evaluate(() => (window as any).lose.restoreContext());
    await expect(page.locator('.viewer__lost')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).tandem.session.player.contextLost)).toBe(false);
  });
});

/** `name@start+duration` for the clips of the track labelled V1, A2, …, in order. */
function row(page: Page, label: string): Promise<string[]> {
  return page.evaluate((label) => {
    const p = (window as any).tandem.session.store.get();
    const name = (id: string) => `${p.tracks[id].kind === 'video' ? 'V' : 'A'}${p.tracks[id].order + 1}`;
    return (Object.values(p.clips) as any[])
      .filter((c) => name(c.trackId) === label)
      .sort((a, b) => a.start - b.start)
      .map((c) => `${c.name || c.type}@${c.start}+${c.duration}`);
  }, label);
}

const THREE_SHOTS = ['testsrc.mp4@0+120', 'testsrc.webm@120+120', 'testsrc.mp4@240+120'];

/**
 * A new project with three four-second shots cut together on V1 and their linked sound on A1:
 * testsrc.mp4, testsrc.webm and testsrc.mp4 again. `more` names further files for the pool.
 */
async function threeShots(page: Page, more: string[] = []): Promise<void> {
  await newProject(page);
  await importFixtures(page, ['testsrc.mp4', 'testsrc.webm', ...more]);
  await page.evaluate(() => {
    const { session, cmd, ui } = (window as any).tandem;
    const assets = Object.values(session.store.get().assets) as any[];
    for (const name of ['testsrc.mp4', 'testsrc.webm', 'testsrc.mp4']) {
      cmd.addAsset(assets.find((a) => a.name === name));
    }
    cmd.zoomFit();
    cmd.seek(0);
    ui.getState().clearSelection();
  });
  await expect.poll(() => row(page, 'V1')).toEqual(THREE_SHOTS);
  await expect.poll(() => row(page, 'A1')).toEqual(THREE_SHOTS);
  await expect(page.locator('.clip')).toHaveCount(6);
}

/** The clips of a track in order, as the store has them. */
const clipsOn = (page: Page, label: string): Promise<any[]> =>
  page.evaluate((label) => {
    const p = (window as any).tandem.session.store.get();
    const name = (id: string) => `${p.tracks[id].kind === 'video' ? 'V' : 'A'}${p.tracks[id].order + 1}`;
    return (Object.values(p.clips) as any[])
      .filter((c) => name(c.trackId) === label)
      .sort((a, b) => a.start - b.start);
  }, label);

const boxOf = (page: Page, id: string) => box(page, `.clip[data-clip="${id}"]`);

/** What the drag in progress says a drop would do, when a modifier key makes it more than an overwrite. */
const dropMode = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.drop-mode')!;
    return getComputedStyle(el).visibility === 'visible' ? el.textContent : null;
  });

const markerFrames = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    (Object.values((window as any).tandem.session.store.get().markers) as any[])
      .map((m) => m.frame)
      .sort((a, b) => a - b),
  );

const undo = async (page: Page): Promise<void> => {
  await page.evaluate(() => (window as any).tandem.cmd.undo());
};

test.describe('timeline: keyboard, drops and marks', () => {
  // These tests are long, and a page that reloads because someone saved a file loses the project.
  test.beforeEach(({ page }) => page.context().routeWebSocket(/\/\?token=/, () => {}));

  test('clips are a list the keyboard can walk, and a click leaves the keys to the editor', async ({
    page,
  }) => {
    await sample(page);
    const state = () =>
      page.evaluate(() => {
        const { session, ui } = (window as any).tandem;
        const p = session.store.get();
        return {
          focus: document.activeElement?.getAttribute('aria-label') ?? null,
          ring: document.querySelectorAll('.clip[data-focus="true"]').length,
          selected: ui.getState().selection.map((id: string) => p.clips[id].name || p.clips[id].type),
          frame: Math.floor(session.player.getFrame()),
          said: document.querySelector('.lanes > [role="status"]')!.textContent,
        };
      });
    const names = {
      title: 'Edit in tandem, V2, 0:00.18 to 0:03.18',
      dusk: 'dusk.mp4, V1, 0:00.00 to 0:04.00',
      fractal: 'fractal.mp4, V1, 0:04.00 to 0:08.00',
      aurora: 'aurora.mp4, V1, 0:08.00 to 0:12.00',
    };

    // Each lane is a list of its clips, each clip an option with a name; the lanes are one Tab stop.
    await expect(page.getByRole('listbox', { name: 'Clips on V1' })).toHaveAttribute(
      'aria-multiselectable',
      'true',
    );
    await expect(page.getByRole('option', { name: names.dusk })).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('option')).toHaveCount(5);
    await expect(page.locator('.clip[tabindex="0"]')).toHaveCount(1);

    // Tab comes from the track headers to one clip, which shows a ring. Enter selects it.
    await page.locator('.th .icon-btn').last().focus();
    await page.keyboard.press('Tab');
    expect(await state()).toMatchObject({ focus: names.title, ring: 1, selected: [], frame: 45 });
    await page.keyboard.press('Enter');
    expect(await state()).toMatchObject({ focus: names.title, selected: ['Text'] });
    await expect(page.getByRole('option', { name: names.title })).toHaveAttribute('aria-selected', 'true');

    // The arrow keys go from clip to clip and the selection goes along; Shift adds. The playhead stays.
    await page.keyboard.press('ArrowDown');
    expect(await state()).toMatchObject({ focus: names.dusk, ring: 1, selected: ['dusk.mp4'] });
    await page.keyboard.press('ArrowRight');
    expect(await state()).toMatchObject({ focus: names.fractal, selected: ['fractal.mp4'] });
    await page.keyboard.press('Shift+ArrowRight');
    expect(await state()).toMatchObject({
      focus: names.aurora,
      selected: ['fractal.mp4', 'aurora.mp4'],
      frame: 45,
    });
    // Shift+Space takes the clip out of the selection again and leaves the keyboard on it.
    await page.keyboard.press('Shift+Space');
    expect(await state()).toMatchObject({ focus: names.aurora, ring: 1, selected: ['fractal.mp4'] });
    await page.keyboard.press('Home');
    expect(await state()).toMatchObject({ focus: names.dusk, selected: ['dusk.mp4'] });
    expect(await page.locator('.tl__body').evaluate((el) => el.scrollLeft)).toBe(0);

    // The clip's menu opens from the keyboard, at the clip, and gives the keyboard back to it.
    await page.keyboard.press('Shift+F10');
    await expect(menuItem(page, 'Split at playhead')).toBeVisible();
    const placed = await page.evaluate(
      () => document.querySelector('[role="menu"]')!.getBoundingClientRect().left,
    );
    const dusk = await clipBox(page, 'dusk.mp4');
    expect(placed).toBeGreaterThanOrEqual(dusk.x);
    expect(placed).toBeLessThan(dusk.x + 40);
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    expect(await state()).toMatchObject({ focus: names.dusk, ring: 1 });

    // A command of the editor's that selects another clip takes the keyboard to that clip.
    await page.keyboard.press('Control+ArrowDown');
    expect(await state()).toMatchObject({
      focus: names.fractal,
      ring: 1,
      selected: ['fractal.mp4'],
      said: '',
    });
    // Tab leaves the lanes in one step and Shift+Tab comes back to the selected clip.
    await page.keyboard.press('Tab');
    expect((await state()).focus).not.toBe(names.fractal);
    await page.keyboard.press('Shift+Tab');
    expect(await state()).toMatchObject({ focus: names.fractal, ring: 1 });

    // A press of the pointer selects as before. The clip it leaves focused shows no ring, and the
    // keys are the editor's: the arrows step through frames and Space plays.
    const aurora = await clipBox(page, 'aurora.mp4');
    await page.mouse.click(aurora.x + aurora.width / 2, aurora.y + 30);
    expect(await state()).toMatchObject({ focus: names.aurora, ring: 0, selected: ['aurora.mp4'], said: '' });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await state()).toMatchObject({ frame: 47, selected: ['aurora.mp4'], ring: 0 });
    await page.keyboard.press('Space');
    await expect
      .poll(() => page.evaluate(() => (window as any).tandem.session.player.getState().playing))
      .toBe(true);
    await page.keyboard.press('Space');
    // The same after its menu was opened with the pointer and closed with Escape.
    await page.mouse.click(aurora.x + aurora.width / 2, aurora.y + 30, { button: 'right' });
    await expect(menuItem(page, 'Split at playhead')).toBeVisible();
    await page.keyboard.press('Escape');
    const before = (await state()).frame;
    await page.keyboard.press('ArrowLeft');
    expect(await state()).toMatchObject({ frame: before - 1, ring: 0 });

    // With the keyboard elsewhere, a selection made by a key is said: one clip by name, more by count.
    const lane = await laneBox(page, 'A2');
    await page.mouse.click(lane.x + 300, lane.y + lane.height / 2);
    await page.evaluate(() => (window as any).tandem.cmd.seek(45));
    const said = async () => (await state()).said;
    await page.keyboard.press('Shift+V');
    await expect.poll(said).toBe(names.title);
    expect((await state()).selected).toEqual(['Text']);
    await page.keyboard.press('Control+A');
    await expect.poll(said).toBe('5 clips selected');
    await page.keyboard.press('Escape');
    await expect.poll(said).toBe('No clip selected');
  });

  test('a command pressed on a clicked clip leaves the keys to the editor, and in the list the keyboard keeps its place', async ({
    page,
  }) => {
    await sample(page);
    // More tracks than fit, with a clip on the last of them, and the lanes scrolled down to it.
    await page.evaluate(() => {
      const { cmd, session } = (window as any).tandem;
      for (let i = 0; i < 8; i++) cmd.addTrack('audio');
      const p = session.store.get();
      const last = (Object.values(p.tracks) as any[])
        .filter((t) => t.kind === 'audio')
        .sort((a, b) => b.order - a.order)[0];
      const music = (Object.values(p.clips) as any[]).find((c) => c.type === 'audio');
      session.store.commit([
        { op: 'addClip', clip: { ...music, id: 'lastlaneclip01', trackId: last.id, name: 'bed.ogg' } },
      ]);
    });
    await expect(page.locator('.clip')).toHaveCount(6);
    const state = () =>
      page.evaluate(() => {
        const { session, ui } = (window as any).tandem;
        const p = session.store.get();
        const id = (document.activeElement as HTMLElement | null)?.dataset.clip;
        return {
          focus: id ? (p.clips[id]?.name ?? 'gone') : null,
          ring: Array.from(document.querySelectorAll<HTMLElement>('.clip[data-focus="true"]')).map(
            (el) => p.clips[el.dataset.clip!].name,
          ),
          selected: ui.getState().selection.map((id: string) => p.clips[id].name),
          frame: Math.floor(session.player.getFrame()),
          down: document.querySelector('.tl__body')!.scrollTop,
        };
      });
    const playing = () =>
      page.evaluate(() => (window as any).tandem.session.player.getState().playing as boolean);
    /** The keys are the editor's: an arrow steps one frame and Space plays. */
    const keysAreTheEditors = async () => {
      const { frame } = await state();
      await page.keyboard.press('ArrowRight');
      expect(await state()).toMatchObject({ frame: frame + 1, ring: [] });
      await page.keyboard.press('Space');
      await expect.poll(playing).toBe(true);
      await page.keyboard.press('Space');
      await expect.poll(playing).toBe(false);
    };
    const click = async (name: string) => {
      const at = await clipBox(page, name);
      await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    };

    // Delete on a clip the pointer selected: the keyboard goes to no other clip, the lanes stay
    // where they were scrolled to, and the keys go on being the editor's.
    const body = page.locator('.tl__body');
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const down = (await state()).down;
    expect(down).toBeGreaterThan(0);
    await click('bed.ogg');
    expect(await state()).toMatchObject({ focus: 'bed.ogg', ring: [], selected: ['bed.ogg'], down });
    await page.keyboard.press('Delete');
    await expect(page.locator('.clip')).toHaveCount(5);
    expect(await state()).toMatchObject({ focus: null, ring: [], selected: [], down });
    await keysAreTheEditors();

    // The same after the other commands that change what is selected.
    await body.evaluate((el) => (el.scrollTop = 0));
    await page.evaluate(() => (window as any).tandem.cmd.seek(180));
    await click('fractal.mp4');
    await page.keyboard.press('Control+B');
    await expect(page.locator('.clip')).toHaveCount(6);
    expect((await state()).ring).toEqual([]);
    await keysAreTheEditors();
    await undo(page);
    await click('aurora.mp4');
    await page.keyboard.press('Control+D');
    await expect(page.locator('.clip')).toHaveCount(6);
    expect((await state()).ring).toEqual([]);
    await keysAreTheEditors();
    await undo(page);
    await click('dusk.mp4');
    await page.keyboard.press('Control+ArrowDown');
    expect(await state()).toMatchObject({ focus: 'dusk.mp4', ring: [], selected: ['fractal.mp4'] });
    await keysAreTheEditors();

    // A press of the pointer on the very clip the keyboard is on gives the keys back as well.
    await page.locator('.th .icon-btn').last().focus();
    await page.keyboard.press('Tab');
    expect(await state()).toMatchObject({ focus: 'fractal.mp4', ring: ['fractal.mp4'] });
    await click('fractal.mp4');
    expect(await state()).toMatchObject({ focus: 'fractal.mp4', ring: [], selected: ['fractal.mp4'] });
    await keysAreTheEditors();
    expect((await state()).selected).toEqual(['fractal.mp4']);

    // In the list, the keyboard stays on a clip that a command of the editor's brought it to when
    // the clip's menu has been open in between.
    await page.locator('.th .icon-btn').last().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Home');
    await page.keyboard.press('Control+ArrowDown');
    expect(await state()).toMatchObject({ focus: 'fractal.mp4', ring: ['fractal.mp4'] });
    await page.keyboard.press('Shift+F10');
    await expect(menuItem(page, 'Split at playhead')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    expect(await state()).toMatchObject({ focus: 'fractal.mp4', ring: ['fractal.mp4'] });
    const { frame } = await state();
    await page.keyboard.press('ArrowRight');
    expect(await state()).toMatchObject({ focus: 'aurora.mp4', selected: ['aurora.mp4'], frame });

    // A clip moved to another track takes the keyboard along, and one that is deleted hands it to
    // the clip that follows: the last of a lane to the one before, the only one to the next lane.
    await page.keyboard.press('Alt+ArrowUp');
    expect((await layout(page)).filter((c) => c.startsWith('V2'))).toEqual([
      'V2:text@18+90',
      'V2:video@240+120',
    ]);
    expect(await state()).toMatchObject({ focus: 'aurora.mp4', ring: ['aurora.mp4'] });
    await page.keyboard.press('Alt+ArrowDown');
    expect(await state()).toMatchObject({ focus: 'aurora.mp4', ring: ['aurora.mp4'] });
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Delete');
    await expect(page.locator('.clip')).toHaveCount(4);
    expect(await state()).toMatchObject({ focus: 'aurora.mp4', ring: ['aurora.mp4'], selected: [] });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Delete');
    expect(await state()).toMatchObject({ focus: 'dusk.mp4', ring: ['dusk.mp4'], selected: [] });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Delete');
    await expect(page.locator('.clip')).toHaveCount(2);
    expect(await state()).toMatchObject({ focus: 'pulse.ogg', ring: ['pulse.ogg'] });

    // Scrolled out of view, the clip the keyboard is on keeps it, and the next arrow goes on from there.
    await undo(page);
    await undo(page);
    await undo(page);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    expect(await state()).toMatchObject({ focus: 'dusk.mp4', ring: ['dusk.mp4'] });
    await page.evaluate(() => {
      const { cmd, ui } = (window as any).tandem;
      cmd.zoom(6);
      ui.getState().set({ scrollX: 6000 });
    });
    await expect.poll(async () => (await view(page)).scrollX).toBe(6000);
    expect(await state()).toMatchObject({ focus: 'dusk.mp4' });
    await page.keyboard.press('ArrowRight');
    expect(await state()).toMatchObject({ focus: 'fractal.mp4', ring: ['fractal.mp4'] });
  });

  test('timeline buttons have names, markers open from the keyboard, and mute is one colour everywhere', async ({
    page,
  }) => {
    await sample(page);
    await expect(page.getByRole('button', { name: 'Add video track' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add audio track' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Solo track' })).toHaveCount(2);
    const unnamed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.tl button'))
        .filter((b) => !(b.getAttribute('aria-label') || b.textContent || '').trim())
        .map((b) => b.className),
    );
    expect(unnamed).toEqual([]);
    const zoom = page.getByRole('slider', { name: 'Timeline zoom' });
    await expect(zoom).toHaveAttribute('aria-valuetext', /^\d+ (second|minute)s? in view$/);

    // A marker is a button: Enter goes to it and opens its editor, Escape gives the keyboard back.
    const marker = page.getByRole('button', { name: /^Marker .*, 00:00:04:00$/ });
    await marker.focus();
    await page.keyboard.press('Enter');
    const name = page.getByLabel('Marker name');
    await expect(name).toBeFocused();
    expect(await page.evaluate(() => (window as any).tandem.session.player.getFrame())).toBe(120);
    // Typing a name is one undo step, not one for each letter, and does not join the step before.
    const markerName = () =>
      page.evaluate(
        () => (Object.values((window as any).tandem.session.store.get().markers) as any[])[0]?.name,
      );
    const original = await markerName();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Intro');
    expect(await markerName()).toBe('Intro');
    await page.keyboard.press('Escape');
    await expect(name).toHaveCount(0);
    await expect(marker.or(page.getByRole('button', { name: /^Marker Intro/ }))).toBeFocused();
    await undo(page);
    expect(await markerName()).toBe(original);
    await page.evaluate(() => (window as any).tandem.cmd.redo());
    expect(await markerName()).toBe('Intro');

    // The switch for what markers do under a ripple is beside the ripple switch.
    const follow = page.getByRole('button', { name: 'Markers follow ripple edits' });
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await follow.click();
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => (window as any).tandem.ui.getState().markersFollow)).toBe(false);
    await follow.click();

    // A picture track offers its captions; a sound track has none to offer.
    await page
      .locator('.th[data-kind="video"]')
      .first()
      .click({ button: 'right', position: { x: 60, y: 30 } });
    await expect(menuItem(page, 'Export captions from this track')).toBeVisible();
    await page.keyboard.press('Escape');
    await page
      .locator('.th[data-kind="audio"]')
      .first()
      .click({ button: 'right', position: { x: 60, y: 20 } });
    await expect(menuItem(page, 'Delete track')).toBeVisible();
    await expect(menuItem(page, 'Export captions from this track')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Muted is red and soloed amber, in the track's header and on its strip in the mixer.
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ workspace: 'audio' }));
    await page.getByRole('button', { name: 'Mute track' }).first().click();
    await page.getByRole('button', { name: 'Solo track' }).last().click();
    const colour = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    // Each button eases into its colour, so each is given the time to get there.
    for (const selector of ['.th__mute--on', '.strip__btn--mute']) {
      await expect.poll(() => colour(selector)).toBe('rgb(255, 93, 93)');
    }
    for (const selector of ['.th__solo--on', '.strip__btn--solo']) {
      await expect.poll(() => colour(selector)).toBe('rgb(255, 181, 71)');
    }
  });

  test('a roll moves the cut of picture and sound together, and a ripple trim takes the markers along', async ({
    page,
  }) => {
    await threeShots(page);
    // Give the first cut media to roll into: the first shot ends a second early, the second begins a second in.
    const trimmed = (label: string) =>
      clipsOn(page, label).then(([a, b, c]) => [
        { op: 'updateClip', id: a.id, patch: { duration: 90 } },
        { op: 'updateClip', id: b.id, patch: { start: 90, duration: 90, sourceIn: 1 } },
        { op: 'updateClip', id: c.id, patch: { start: 180 } },
      ]);
    await commit(page, [...(await trimmed('V1')), ...(await trimmed('A1'))]);
    const { ppf } = await view(page);
    const rollBy = async (frames: number) => {
      const second = (await clipsOn(page, 'V1'))[1];
      const b = await boxOf(page, second.id);
      await page.keyboard.down('Control');
      await dragTo(page, [b.x + 2, b.y + 40], [b.x + 2 + frames * ppf, b.y + 40]);
      await page.mouse.up();
      await page.keyboard.up('Control');
    };
    const cuts = async () => [(await row(page, 'V1')).slice(0, 2), (await row(page, 'A1')).slice(0, 2)];
    const rolled = ['testsrc.mp4@0+105', 'testsrc.webm@105+75'];
    const straight = ['testsrc.mp4@0+90', 'testsrc.webm@90+90'];

    // With linked selection on, both cuts roll, by exactly what the pointer asked for.
    await rollBy(15);
    expect(await cuts()).toEqual([rolled, rolled]);
    expect((await clipsOn(page, 'A1'))[1].sourceIn).toBeCloseTo(1.5, 5);
    await undo(page);
    expect(await cuts()).toEqual([straight, straight]);
    // With it off the same drag makes a split edit: the sound cut stays.
    await page.keyboard.press('Control+Shift+L');
    await rollBy(15);
    expect(await cuts()).toEqual([rolled, straight]);
    // A sound cut that is elsewhere is left alone when the picture cut is rolled again.
    await page.keyboard.press('Control+Shift+L');
    await rollBy(-5);
    expect(await cuts()).toEqual([['testsrc.mp4@0+100', 'testsrc.webm@100+80'], straight]);
    await undo(page);
    await undo(page);
    expect(await cuts()).toEqual([straight, straight]);

    // A ripple trim by dragging: the markers on the shots that move up move with them.
    await commit(page, [
      {
        op: 'setMarker',
        marker: { id: 'on-second', frame: 150, name: 'Second', color: '#ffb547', note: '' },
      },
      { op: 'setMarker', marker: { id: 'on-first', frame: 40, name: 'First', color: '#ffb547', note: '' } },
    ]);
    const first = (await clipsOn(page, 'V1'))[0];
    const b = await boxOf(page, first.id);
    await page.keyboard.down('Alt');
    await dragTo(page, [b.x + b.width - 2, b.y + 40], [b.x + b.width - 2 - 10 * ppf, b.y + 40]);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    expect((await row(page, 'V1'))[0]).toBe('testsrc.mp4@0+80');
    expect(await markerFrames(page)).toEqual([40, 140]);
    await undo(page);
    expect(await markerFrames(page)).toEqual([40, 150]);
  });

  test('a drop with Ctrl goes in between the clips instead of over them', async ({ page }) => {
    await threeShots(page, ['tone.ogg']);
    await commit(page, [
      { op: 'setMarker', marker: { id: 'm', frame: 300, name: 'Third', color: '#ffb547', note: '' } },
    ]);
    const { ppf } = await view(page);
    const v1 = await laneBox(page, 'V1');
    const third = (await clipsOn(page, 'V1'))[2];
    const from = await boxOf(page, third.id);

    // Dragged to the front, the third shot would overwrite the first. The preview shows as much.
    await dragTo(page, [from.x + 30, from.y + 8], [v1.x + 30 + 4 * ppf, from.y + 8], 12);
    expect(await dropMode(page)).toBeNull();
    // Ctrl, pressed while the pointer holds still, makes it an insert, and says so beside the pointer.
    await page.keyboard.down('Control');
    await expect.poll(() => dropMode(page)).toBe('Insert');
    await page.mouse.up();
    await page.keyboard.up('Control');
    const reordered = ['testsrc.mp4@0+120', 'testsrc.mp4@120+120', 'testsrc.webm@240+120'];
    expect(await row(page, 'V1')).toEqual(reordered);
    expect(await row(page, 'A1')).toEqual(reordered);
    expect((await clipsOn(page, 'V1'))[0].id).toBe(third.id);
    expect(await dropMode(page)).toBeNull();
    // The marker stays on its shot, and all of it is one step to undo.
    expect(await markerFrames(page)).toEqual([60]);
    await undo(page);
    expect(await row(page, 'V1')).toEqual(THREE_SHOTS);
    expect(await row(page, 'A1')).toEqual(THREE_SHOTS);
    expect(await markerFrames(page)).toEqual([300]);

    // Without the key the same drop overwrites, as it always did.
    await dragTo(page, [from.x + 30, from.y + 8], [v1.x + 30 + 4 * ppf, from.y + 8], 12);
    await page.mouse.up();
    expect(await row(page, 'V1')).toEqual(['testsrc.mp4@0+4', 'testsrc.mp4@4+120', 'testsrc.webm@124+116']);
    await undo(page);

    // A file from the pool, dropped on the first cut with Ctrl: everything from there on makes way.
    const a1 = await laneBox(page, 'A1');
    const card = await box(page, '.asset[aria-label="tone.ogg"]');
    await dragTo(page, [card.x + 40, card.y + 30], [card.x + 80, card.y + 90], 3);
    await page.keyboard.down('Control');
    await page.mouse.move(a1.x + 121 * ppf, a1.y + a1.height / 2, { steps: 10 });
    await expect.poll(() => dropMode(page)).toBe('Insert');
    await page.mouse.up();
    await page.keyboard.up('Control');
    expect(await row(page, 'A1')).toEqual([
      'testsrc.mp4@0+120',
      'tone.ogg@120+90',
      'testsrc.webm@210+120',
      'testsrc.mp4@330+120',
    ]);
    expect(await row(page, 'V1')).toEqual([
      'testsrc.mp4@0+120',
      'testsrc.webm@210+120',
      'testsrc.mp4@330+120',
    ]);
    expect(await markerFrames(page)).toEqual([390]);
    await undo(page);
    expect(await row(page, 'A1')).toEqual(THREE_SHOTS);

    // Paste insert does the same with what was copied, at the playhead.
    const second = (await clipsOn(page, 'V1'))[1];
    await page.evaluate((id) => {
      const { ui, cmd } = (window as any).tandem;
      ui.getState().select([id]);
      cmd.copy();
      cmd.seek(240);
    }, second.id);
    await page.keyboard.press('Control+Shift+V');
    const pasted = [...THREE_SHOTS.slice(0, 2), 'testsrc.webm@240+120', 'testsrc.mp4@360+120'];
    expect(await row(page, 'V1')).toEqual(pasted);
    expect(await row(page, 'A1')).toEqual(pasted);
  });

  test('a file dropped on a clip with Alt takes its place and keeps what was done to the clip', async ({
    page,
  }) => {
    await threeShots(page);
    const [first] = await clipsOn(page, 'V1');
    await commit(page, [
      { op: 'updateClip', id: first.id, patch: { scaleX: 1.2, scaleY: 1.2, opacity: 0.5, fadeIn: 0 } },
    ]);
    const target = await boxOf(page, first.id);
    const card = await box(page, '.asset[aria-label="testsrc.webm"]');
    await dragTo(page, [card.x + 40, card.y + 30], [card.x + 80, card.y + 90], 3);
    await page.keyboard.down('Alt');
    await page.mouse.move(target.x + 60, target.y + 30, { steps: 10 });
    await expect.poll(() => dropMode(page)).toBe('Replace');
    await expect(page.locator(`.clip[data-clip="${first.id}"]`)).toHaveAttribute('data-hint', 'all');
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const shots = ['testsrc.webm@0+120', 'testsrc.webm@120+120', 'testsrc.mp4@240+120'];
    expect(await row(page, 'V1')).toEqual(shots);
    // Its sound came along, and nothing after it was touched.
    expect(await row(page, 'A1')).toEqual(shots);
    const [replaced] = await clipsOn(page, 'V1');
    expect(replaced).toMatchObject({ id: first.id, scaleX: 1.2, opacity: 0.5, linkId: first.linkId });
    expect(replaced.assetId).not.toBe(first.assetId);
    await undo(page);
    expect(await row(page, 'V1')).toEqual(THREE_SHOTS);
    expect(await row(page, 'A1')).toEqual(THREE_SHOTS);
  });

  test('keyframes are moved and removed on the clip, and the level line follows them', async ({ page }) => {
    await sample(page);
    const music = await clip(page, 'pulse.ogg');
    const key = (t: number, v: number) => ({ t, v, e: 'easeInOut' });
    await commit(page, [
      {
        op: 'updateClip',
        id: music.id,
        patch: { keyframes: { volume: [key(60, 0), key(90, -14), key(200, -14), key(230, 0)] } },
      },
    ]);
    const times = () =>
      page.evaluate(
        (id) =>
          (window as any).tandem.session.store
            .get()
            .clips[id].keyframes.volume?.map((k: any) => k.t)
            .join(',') ?? '',
        music.id,
      );
    // The marks show on the selected clip.
    await expect(page.locator('.clip__kf')).toHaveCount(0);
    await page.evaluate((id) => (window as any).tandem.ui.getState().select([id]), music.id);
    await expect(page.locator('.clip__kf')).toHaveCount(4);
    // The bracket keys step the playhead through them.
    const playhead = () => page.evaluate(() => (window as any).tandem.session.player.getFrame());
    await page.evaluate(() => (window as any).tandem.cmd.seek(0));
    await page.keyboard.press(']');
    await page.keyboard.press(']');
    expect(await playhead()).toBe(90);
    await page.keyboard.press('[');
    expect(await playhead()).toBe(60);
    const { ppf } = await view(page);
    const mark = async (n: number): Promise<[number, number]> => {
      const b = await box(page, `.clip__kf >> nth=${n}`);
      return [b.x + b.width / 2, b.y + b.height / 2];
    };

    // A click takes the playhead to the keyframe; a drag moves it in time, and the clip stays.
    await page.mouse.click(...(await mark(1)));
    expect(await page.evaluate(() => (window as any).tandem.session.player.getFrame())).toBe(90);
    const [x, y] = await mark(1);
    await dragTo(page, [x, y], [x + 40 * ppf, y - 2]);
    await page.mouse.up();
    expect(await times()).toBe('60,130,200,230');
    // It stops a frame short of the next one, and the whole drag is one step to undo.
    const [x2, y2] = await mark(1);
    await dragTo(page, [x2, y2], [x2 + 500, y2 - 2]);
    await page.mouse.up();
    expect(await times()).toBe('60,199,200,230');
    await undo(page);
    expect(await times()).toBe('60,130,200,230');
    expect((await clip(page, 'pulse.ogg')).start).toBe(0);

    // The line drawn on the clip dips where the volume does: lower at frame 160 than at frame 20.
    const lineAt = (frame: number) =>
      page.evaluate(
        ([id, frame]) => {
          const el = document.querySelector(`.clip[data-clip="${id}"]`)!;
          const canvas = el.closest('.lane')!.querySelector('canvas')!;
          const r = el.getBoundingClientRect();
          const c = canvas.getBoundingClientRect();
          const scale = canvas.width / c.width;
          const { ppf } = (window as any).tandem.ui.getState();
          const x = Math.round((r.left - c.left + (frame as number) * ppf) * scale);
          const column = canvas.getContext('2d')!.getImageData(x, 0, 1, canvas.height).data;
          // The line is the lightest thing in its column, below the label strip.
          let best = -1;
          let light = 0;
          for (let row = Math.round(20 * scale); row < canvas.height; row++) {
            const sum = column[row * 4] + column[row * 4 + 1] + column[row * 4 + 2];
            if (sum > light) [light, best] = [sum, row];
          }
          return best / scale;
        },
        [music.id, frame] as const,
      );
    await expect.poll(async () => (await lineAt(160)) - (await lineAt(20))).toBeGreaterThan(4);

    // Its menu removes a keyframe.
    await page.mouse.click(...(await mark(0)), { button: 'right' });
    await menuItem(page, 'Delete keyframe').click();
    expect(await times()).toBe('130,200,230');
    await expect(page.locator('.clip__kf')).toHaveCount(3);
  });

  test('clips that lost their track or share frames with another are said, and can be put right', async ({
    page,
  }) => {
    await sample(page);
    const spare = { ...(await clip(page, 'aurora.mp4')), transIn: null, transOut: null };
    const tracks = () =>
      page.evaluate(() => Object.keys((window as any).tandem.session.store.get().tracks).length);
    const hidden = () => page.evaluate(() => (window as any).tandem.session.store.hiddenClips().length);

    // A clip on a track that is not there: what is left when a track is removed as a clip lands on it.
    await commit(page, [{ op: 'addClip', clip: { ...spare, id: 'stray', trackId: 'removed', start: 500 } }]);
    expect(await layout(page)).toEqual(SAMPLE);
    const notice = page.locator('.tl__lost');
    await expect(notice).toContainText('A clip has lost its track.');
    const before = await tracks();
    await notice.getByRole('button', { name: 'Restore to a new track' }).click();
    await expect(notice).toHaveCount(0);
    expect(await tracks()).toBe(before + 1);
    expect(await layout(page)).toEqual([...SAMPLE, 'V3:video@500+120'].sort());
    // One step: undone, the clip is without a track again and the notice is back.
    await undo(page);
    await expect(notice).toBeVisible();
    expect(await tracks()).toBe(before);
    await notice.getByRole('button', { name: 'Discard' }).click();
    await expect(notice).toHaveCount(0);
    expect(await hidden()).toBe(0);
    expect(await layout(page)).toEqual(SAMPLE);

    // Two clips on the same frames of a track, as two people placing them at one moment leave them.
    await commit(page, [{ op: 'addClip', clip: { ...spare, id: 'twin', start: 30, duration: 60 } }]);
    const marked = page.locator('.clip[data-overlap="true"]');
    await expect(marked).toHaveCount(2);
    const twin = page.locator('.clip[data-clip="twin"]');
    await expect(twin).toHaveAttribute('aria-label', /overlaps another clip$/);
    await expect(twin.locator('.clip__overlap')).toBeVisible();
    const b = await box(page, '.clip[data-clip="twin"]');
    await page.mouse.click(b.x + b.width / 2, b.y + 40, { button: 'right' });
    await menuItem(page, 'Move to a free track').click();
    await expect(marked).toHaveCount(0);
    const moved = await page.evaluate(() => {
      const p = (window as any).tandem.session.store.get();
      return {
        start: p.clips.twin.start,
        sameTrack:
          p.clips.twin.trackId ===
          (Object.values(p.clips) as any[]).find((c) => c.name === 'dusk.mp4').trackId,
      };
    });
    expect(moved).toEqual({ start: 30, sameTrack: false });
    // A clip that shares frames with nothing is not offered the move.
    const dusk = await clipBox(page, 'dusk.mp4');
    await page.mouse.click(dusk.x + dusk.width - 20, dusk.y + 40, { button: 'right' });
    await expect(menuItem(page, 'Split at playhead')).toBeVisible();
    await expect(menuItem(page, 'Move to a free track')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
