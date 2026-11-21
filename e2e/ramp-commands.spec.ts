import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';
import { clipEnd, sourceTimeAt, type Clip, type Project, type RampPoint } from '../packages/core/src/index';
import { importFixtures, newProject, noReloads, trackErrors } from './helpers';

/**
 * Speed ramps and the pitch of retimed sound, asked for the way the palette, a menu or a script
 * asks: by command. Nothing here looks at the inspector, which shows a ramp in its own spec.
 */

async function localProject(page: Page): Promise<void> {
  await page.route('**/api/health', (route) => route.abort());
  await newProject(page);
  await watchToasts(page);
}

/** Start noting what every toast says as it appears: a toast is gone again after a few seconds. */
const watchToasts = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seen: string[] = ((window as any).__toasts = []);
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof HTMLElement && n.classList.contains('toast')) seen.push(n.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true });
  });

/** The toasts so far that said `text`, whether they are still showing or not. */
const said = (page: Page, text: string): Promise<string[]> =>
  page.evaluate((text) => ((window as any).__toasts as string[]).filter((t) => t.includes(text)), text);

/** Wait until `text` has been said as many times as that. */
const saidTimes = (page: Page, text: string, times: number): Promise<void> =>
  expect.poll(() => said(page, text), { message: text }).toHaveLength(times);

/** The bundled sample: three shots of four seconds on V1, a title over the first on V2 and music under all on A1. */
async function sampleProject(page: Page): Promise<void> {
  await localProject(page);
  await page.evaluate(() => void (window as any).tandem.cmd.loadSample());
  await expect(page.locator('.clip')).toHaveCount(5, { timeout: 60_000 });
  await page.evaluate(() => (window as any).tandem.ui.getState().clearSelection());
}

/** Two takes of the test file back to back, each a picture on V1 linked to its sound on A1, two seconds long. */
async function syncSequence(page: Page): Promise<void> {
  await localProject(page);
  await importFixtures(page, ['testsrc.mp4']);
  await page.evaluate(() => {
    const { session, cmd, ui } = (window as any).tandem;
    const [asset] = Object.values(session.store.get().assets);
    for (let i = 0; i < 2; i++) cmd.addAsset(asset, { frame: i * 60, sourceIn: 1, sourceOut: 3 });
    ui.getState().clearSelection();
  });
  await page.keyboard.press('Shift+z');
}

const SAMPLE = { A1: ['0-360'], V1: ['0-120', '120-240', '240-360'], V2: ['18-108'] };

/** The timeline as `start-end` spans per track, e.g. `{ V1: ['0-120', '120-240'], A1: ['0-240'] }`. */
const rows = (page: Page): Promise<Record<string, string[]>> =>
  page.evaluate(() => {
    const p = (window as any).tandem.session.store.get();
    const label = (id: string): string =>
      `${p.tracks[id].kind === 'video' ? 'V' : 'A'}${p.tracks[id].order + 1}`;
    const out: Record<string, string[]> = {};
    for (const c of (Object.values(p.clips) as any[]).sort((a, b) => a.start - b.start)) {
      (out[label(c.trackId)] ??= []).push(`${c.start}-${c.start + c.duration}`);
    }
    return out;
  });

const project = (page: Page): Promise<Project> =>
  page.evaluate(() => (window as any).tandem.session.store.get());

const idsOf = (page: Page, type: string): Promise<string[]> =>
  page.evaluate(
    (type) =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[])
        .filter((c) => c.type === type)
        .sort((a, b) => a.start - b.start)
        .map((c) => c.id),
    type,
  );

const clip = (page: Page, id: string): Promise<Clip> =>
  page.evaluate((id) => (window as any).tandem.session.store.get().clips[id], id);

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((ids) => (window as any).tandem.ui.getState().select(ids), ids);

const set = (page: Page, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate((patch) => (window as any).tandem.ui.getState().set(patch), patch);

const seek = (page: Page, frame: number): Promise<void> =>
  page.evaluate((frame) => (window as any).tandem.cmd.seek(frame), frame);

const undo = (page: Page): Promise<void> => page.evaluate(() => (window as any).tandem.cmd.undo());

const undoDepth = (page: Page): Promise<number> =>
  page.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);

const markers = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    (Object.values((window as any).tandem.session.store.get().markers) as any[])
      .map((m) => m.frame)
      .sort((a, b) => a - b),
  );

const toast = (page: Page, text: string): Locator => page.locator('.toast', { hasText: text });

type Shape =
  'none' | 'custom' | 'rampUp' | 'rampDown' | 'montage' | 'hero' | 'bullet' | 'flashIn' | 'flashOut';

const setRamp = (page: Page, shape: Shape): Promise<void> =>
  page.evaluate((shape) => (window as any).tandem.cmd.setRamp(shape), shape);

const setSpeed = (page: Page, speed: number): Promise<void> =>
  page.evaluate((speed) => (window as any).tandem.cmd.setSpeed(speed), speed);

/** Whether the document holds the field for the clip at all, and what it holds. */
const written = (page: Page, id: string, field: string): Promise<{ has: boolean; value: unknown }> =>
  page.evaluate(
    ([id, field]) => {
      const map = (window as any).tandem.session.doc.getMap('clips').get(id);
      return { has: map.has(field), value: map.get(field) ?? null };
    },
    [id, field] as const,
  );

/**
 * How far apart two clips are, in seconds of their media, on the frames of the timeline they
 * share: the most over those frames. A pair that shares none is not in step at all.
 */
function apart(p: Project, a: Clip, b: Clip): number {
  const from = Math.max(a.start, b.start);
  const to = Math.min(clipEnd(a), clipEnd(b));
  if (to <= from) return Infinity;
  let most = 0;
  for (let f = from; f < to; f++) {
    most = Math.max(most, Math.abs(sourceTimeAt(a, f - a.start, p) - sourceTimeAt(b, f - b.start, p)));
  }
  return most;
}

test.describe('speed ramps by command', () => {
  test.beforeEach(({ page }) => noReloads(page));

  test('a shape changes how long the clip takes and nothing else, and one undo takes it back', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await sampleProject(page);
    const [dusk] = await idsOf(page, 'video');
    const before = await project(page);
    const depth = await undoDepth(page);

    // Nothing that has a speed is selected: a title has none.
    await setRamp(page, 'bullet');
    await saidTimes(page, 'Select a video or sound clip to ramp its speed.', 1);
    await select(page, await idsOf(page, 'text'));
    await setRamp(page, 'bullet');
    await saidTimes(page, 'Select a video or sound clip to ramp its speed.', 2);
    expect(await project(page)).toEqual(before);
    expect(await undoDepth(page)).toBe(depth);

    // Bullet plays the four seconds in 27 frames. Without ripple editing nothing else moves.
    await select(page, [dusk]);
    await setRamp(page, 'bullet');
    expect(await rows(page)).toEqual({ ...SAMPLE, V1: ['0-27', '120-240', '240-360'] });
    const ramped = await clip(page, dusk);
    expect(ramped).toMatchObject({ speed: 1, sourceIn: 0, duration: 27 });
    expect(ramped.ramp?.map((q) => q.v)).toEqual([5, 5, 0.25, 5, 5]);
    expect(ramped.ramp?.map((q) => q.m)).toEqual([0, 1.68, 2, 2.32, 4]);
    expect(await markers(page)).toEqual([120]);
    expect(await undoDepth(page)).toBe(depth + 1);
    // The same shape again is no change, and no step.
    await setRamp(page, 'bullet');
    expect(await undoDepth(page)).toBe(depth + 1);

    await undo(page);
    expect(await project(page)).toEqual(before);
    // The clip had room all along: nothing was said of a clip in its way.
    expect(await said(page, 'The next clip is in the way')).toEqual([]);
    // The project is kept on this device: the request for the server, which is not let through, fails.
    expect(errors.filter((e) => !e.includes('net::ERR_FAILED'))).toEqual([]);
  });

  test('a ramp that the next clip cuts short says so, and offers the room ripple editing would have made', async ({
    page,
  }) => {
    await sampleProject(page);
    const [dusk] = await idsOf(page, 'video');
    await select(page, [dusk]);
    // Twice as fast with ripple editing on: the next shot now stands right after the 60 frames.
    await set(page, { rippleMode: true });
    await setSpeed(page, 2);
    await set(page, { rippleMode: false });
    const fast = { A1: ['0-360'], V1: ['0-60', '60-180', '180-300'], V2: ['18-108'] };
    expect(await rows(page)).toEqual(fast);
    const found = await project(page);

    // Ramp up plays the same four seconds in 96 frames, of which 60 fit.
    await setRamp(page, 'rampUp');
    expect(await rows(page)).toEqual(fast);
    expect((await clip(page, dusk)).ramp).toEqual([
      { m: 0, v: 0.5 },
      { m: 4, v: 2 },
    ]);
    const offer = toast(
      page,
      'The next clip is in the way, so the clip now plays only the first 2 of its 3.2 seconds.',
    );
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Make room' }).click();
    const roomy = { A1: ['0-360'], V1: ['0-96', '96-216', '216-336'], V2: ['18-108'] };
    expect(await rows(page)).toEqual(roomy);
    expect(await markers(page)).toEqual([96]);
    const withRoom = await project(page);

    // Two steps back: the room, then the ramp.
    await undo(page);
    expect(await rows(page)).toEqual(fast);
    expect((await clip(page, dusk)).ramp).not.toBeNull();
    await undo(page);
    expect(await project(page)).toEqual(found);

    // The same change with ripple editing on leaves the same timeline, in one step.
    await set(page, { rippleMode: true });
    const depth = await undoDepth(page);
    await setRamp(page, 'rampUp');
    expect(await project(page)).toEqual(withRoom);
    expect(await undoDepth(page)).toBe(depth + 1);

    // An offer is about the clip as its change left it. After another change of ramp the room
    // that was offered is no longer the room the clip is short of, and the old offer does nothing.
    await undo(page);
    await set(page, { rippleMode: false });
    await setRamp(page, 'rampUp');
    await saidTimes(page, 'so the clip now plays only the first 2 of its 3.2 seconds.', 2);
    const stale = toast(page, 'so the clip now plays only the first 2 of its 3.2 seconds.').last();
    const level = [
      { m: 0, v: 0.25 },
      { m: 4, v: 0.25 },
    ];
    await page.evaluate((level) => (window as any).tandem.cmd.setRampPoints(level), level);
    // A quarter of the speed over what the 60 frames of Ramp up covered: 7.2 seconds.
    await expect(toast(page, 'so the clip now plays only the first 2 of its 7.2 seconds.')).toBeVisible();
    const held = await project(page);
    expect(held.clips[dusk]).toMatchObject({ duration: 60, speed: 2, ramp: level });
    await stale.getByRole('button', { name: 'Make room' }).click();
    expect(await project(page)).toEqual(held);
    // Three offers in all: ripple editing made its room without one.
    expect(await said(page, 'The next clip is in the way')).toHaveLength(3);
  });

  test('with ripple editing what follows moves with the end of the clip, marker and comment on their shots', async ({
    page,
  }) => {
    await sampleProject(page);
    const [dusk, fractal, aurora] = await idsOf(page, 'video');
    await page.evaluate(() => {
      const { session } = (window as any).tandem;
      const user = { authorId: 'u1', authorName: 'Ada', authorColor: '#51cf66' };
      session.review.add({ ...user, frame: 250, text: 'on the third shot', x: null, y: null });
      session.store.commit([
        { op: 'setMarker', marker: { id: 'third', frame: 240, name: 'third', color: '#fff', note: '' } },
      ]);
    });
    const note = (): Promise<number> =>
      page.evaluate(() => (window as any).tandem.session.review.get()[0].frame as number);
    const before = await project(page);
    const depth = await undoDepth(page);
    await set(page, { rippleMode: true });
    await select(page, [fractal]);

    // The second shot goes from 120 frames to 27: the third comes up by 93, with what stands on it.
    await setRamp(page, 'bullet');
    expect(await rows(page)).toEqual({ ...SAMPLE, V1: ['0-120', '120-147', '147-267'] });
    expect(await markers(page)).toEqual([120, 147]);
    await expect.poll(note).toBe(157);
    expect(await undoDepth(page)).toBe(depth + 1);
    // Hero takes about as long as one speed does, and pushes them back out. It is laid over what
    // the 27 whole frames cover, a little less than the four seconds: 118 frames, not 121.
    await setRamp(page, 'hero');
    expect(await rows(page)).toEqual({ ...SAMPLE, V1: ['0-120', '120-238', '238-358'] });
    expect(await markers(page)).toEqual([120, 238]);
    await expect.poll(note).toBe(248);

    await undo(page);
    await undo(page);
    expect(await project(page)).toEqual(before);
    await expect.poll(note).toBe(250);

    // Where what follows cannot move, the ramp is set all the same and the clip changes where it
    // stands: the reason is said once. Here the next shot has its sound on a locked track.
    await page.evaluate(
      ([fractal]) => {
        const { session, cmd } = (window as any).tandem;
        cmd.addTrack('audio');
        const p = session.store.get();
        const a2 = (Object.values(p.tracks) as any[]).find((t) => t.kind === 'audio' && t.order === 1);
        const music = (Object.values(p.clips) as any[]).find((c) => c.type === 'audio');
        const sound = { ...music, id: 'sound', trackId: a2.id, start: 120, duration: 120, linkId: 'pair' };
        session.store.commit([
          { op: 'addClip', clip: sound },
          { op: 'updateClip', id: fractal, patch: { linkId: 'pair' } },
          { op: 'updateTrack', id: a2.id, patch: { locked: true } },
        ]);
      },
      [fractal],
    );
    await select(page, [dusk]);
    await setRamp(page, 'bullet');
    const refusal = toast(page, 'Unlock A2 to ripple');
    await saidTimes(page, 'Unlock A2 to ripple', 1);
    await expect(refusal).toHaveCount(1);
    await expect(refusal).toHaveText('Unlock A2 to ripple: a linked clip on it has to move too.');
    expect((await rows(page)).V1).toEqual(['0-27', '120-240', '240-360']);
    expect((await clip(page, dusk)).ramp).toHaveLength(5);
    expect((await clip(page, aurora)).start).toBe(240);
    expect(await said(page, 'Unlock A2 to ripple')).toHaveLength(1);
  });

  test('None returns a clip to its one speed, to within the frames the ramp rounded away', async ({
    page,
  }) => {
    await sampleProject(page);
    const [dusk] = await idsOf(page, 'video');
    await select(page, [dusk]);
    await set(page, { rippleMode: true });
    // Once at the speed the clip came with, and once at half of it: a frame of its file is two there.
    for (const [speed, length, within] of [
      [1, 120, 3],
      [0.5, 240, 6],
    ]) {
      await setSpeed(page, speed);
      const found = await clip(page, dusk);
      expect(found).toMatchObject({ speed, duration: length, ramp: null });
      for (const shape of ['bullet', 'hero', 'flashOut'] as const) {
        const label = `${shape} at ${speed}`;
        await setRamp(page, shape);
        const on = await clip(page, dusk);
        expect(on.ramp, label).not.toBeNull();
        // The speed it had is kept for when the ramp goes.
        expect(on.speed, label).toBe(speed);
        await setRamp(page, 'none');
        const back = await clip(page, dusk);
        expect(back, label).toMatchObject({ ramp: null, speed, sourceIn: 0 });
        expect(Math.abs(back.duration - length), label).toBeLessThanOrEqual(within);
        // What follows stands against it wherever it ends.
        expect((await rows(page)).V1[1], label).toBe(`${back.duration}-${back.duration + 120}`);
        await undo(page);
        // One step back from the shape is exact: the clip as it was found.
        await undo(page);
        expect(await clip(page, dusk), label).toEqual(found);
      }
    }
  });

  test('a picture and its linked sound play the same media on every frame, whatever was selected', async ({
    page,
  }) => {
    await syncSequence(page);
    expect(await rows(page)).toEqual({ A1: ['0-60', '60-120'], V1: ['0-60', '60-120'] });
    const [picture] = await idsOf(page, 'video');
    const [sound] = await idsOf(page, 'audio');
    const inStep = async (): Promise<number> => {
      const p = await project(page);
      return apart(p, p.clips[picture], p.clips[sound]);
    };
    expect(await inStep()).toBe(0);

    // Both selected, as a click with linked selection on selects them.
    await select(page, [picture, sound]);
    await setRamp(page, 'bullet');
    expect(await rows(page)).toEqual({ A1: ['0-14', '60-120'], V1: ['0-14', '60-120'] });
    expect(await inStep()).toBeLessThan(1e-9);
    expect((await clip(page, sound)).ramp).toEqual((await clip(page, picture)).ramp);

    await undo(page);

    // Linked selection off and the picture alone: the sound still goes with it.
    await set(page, { linkedSelection: false });
    await select(page, [picture]);
    await setRamp(page, 'rampDown');
    expect(await rows(page)).toEqual({ A1: ['0-48', '60-120'], V1: ['0-48', '60-120'] });
    expect(await inStep()).toBeLessThan(1e-9);
    // Asked of the sound alone, the ramp is still the picture's.
    await select(page, [sound]);
    await setRamp(page, 'hero');
    expect((await clip(page, picture)).ramp).toHaveLength(6);
    expect(await inStep()).toBeLessThan(1e-9);
    await setRamp(page, 'none');
    expect(await rows(page)).toEqual({ A1: ['0-60', '60-120'], V1: ['0-60', '60-120'] });

    // A J cut: the head of the picture is trimmed by 20 frames, and the sound leads into it.
    await page.evaluate(
      ([picture]) => {
        const { session } = (window as any).tandem;
        const c = session.store.get().clips[picture];
        const patch = { start: c.start + 20, duration: c.duration - 20, sourceIn: c.sourceIn + 20 / 30 };
        session.store.commit([{ op: 'updateClip', id: picture, patch }]);
      },
      [picture],
    );
    expect(await inStep()).toBeLessThan(1e-9);
    const starts: Record<string, string> = {};
    for (const shape of ['flashIn', 'rampUp', 'montage'] as const) {
      await select(page, [picture]);
      await setRamp(page, shape);
      expect(await inStep(), shape).toBeLessThan(1e-9);
      const p = await project(page);
      starts[shape] = `${p.clips[sound].start}, ${p.clips[picture].start}`;
      // Sound and picture still end together.
      expect(clipEnd(p.clips[sound]), shape).toBe(clipEnd(p.clips[picture]));
      await undo(page);
    }
    // The 20 frames of sound before the picture take 4 at 500%, 40 at 50% (there are only 20
    // before the picture, so the sound begins on the first frame there is), and 20 at 100%.
    expect(starts).toEqual({ flashIn: '16, 20', rampUp: '0, 20', montage: '0, 20' });
  });

  test('a clip whose linked sound is on a locked track is not ramped, and is not taken off its ramp by a speed', async ({
    page,
  }) => {
    await syncSequence(page);
    const [picture] = await idsOf(page, 'video');
    const [sound] = await idsOf(page, 'audio');
    const lock = (locked: boolean): Promise<void> =>
      page.evaluate(
        ([sound, locked]) => {
          const { session } = (window as any).tandem;
          const { trackId } = session.store.get().clips[sound as string];
          session.store.commit([{ op: 'updateTrack', id: trackId, patch: { locked } }]);
        },
        [sound, locked] as const,
      );
    await lock(true);
    await select(page, [picture]);
    const before = await project(page);
    const depth = await undoDepth(page);
    const RAMP = 'Unlock A1 to ramp this clip: what is linked to it has to follow.';
    const SPEED = "Unlock A1 to change this clip's speed: what is linked to it has to follow.";

    for (const ripple of [false, true]) {
      await set(page, { rippleMode: ripple });
      await setRamp(page, 'bullet');
      await saidTimes(page, RAMP, ripple ? 2 : 1);
      expect(await project(page)).toEqual(before);
    }
    await page.evaluate(() => (window as any).tandem.cmd.addRampPoint());
    await saidTimes(page, RAMP, 3);
    expect(await project(page)).toEqual(before);
    expect(await undoDepth(page)).toBe(depth);

    // A clip that is on a ramp comes off it with everything linked to it, so a speed is refused
    // the same way: from the command the presets use, and from the clip's menu.
    await lock(false);
    await set(page, { rippleMode: false });
    await setRamp(page, 'rampUp');
    await lock(true);
    await select(page, [picture]);
    const ramped = await project(page);
    expect(ramped.clips[sound].ramp).toHaveLength(2);
    for (const ripple of [false, true]) {
      await set(page, { rippleMode: ripple });
      await setSpeed(page, 2);
      await saidTimes(page, SPEED, ripple ? 2 : 1);
      expect(await project(page)).toEqual(ramped);
    }
    await page.locator(`[data-clip="${picture}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Speed: 200%' }).click();
    await saidTimes(page, SPEED, 3);
    expect(await project(page)).toEqual(ramped);

    // A clip that is on no ramp has its speed set by itself, as before: the lock is not in its way.
    await lock(false);
    await select(page, [picture]);
    await setRamp(page, 'none');
    await lock(true);
    await select(page, [picture]);
    const plain = await clip(page, sound);
    await setSpeed(page, 2);
    expect(await clip(page, picture)).toMatchObject({ speed: 2, duration: 30, ramp: null });
    expect(await clip(page, sound)).toEqual(plain);
  });

  test('a clip that is too short for a shape is refused it, and Custom says when a ramp cannot go as fast or as slow', async ({
    page,
  }) => {
    await sampleProject(page);
    const [dusk, , aurora] = await idsOf(page, 'video');
    // One frame at a quarter of the speed is 8 ms of media. Bullet has points 12.5 ms apart at the least.
    await select(page, [dusk]);
    await setSpeed(page, 0.25);
    await page.evaluate(() => (window as any).tandem.cmd.setDuration(1));
    const tiny = await project(page);
    expect(tiny.clips[dusk]).toMatchObject({ speed: 0.25, duration: 1 });
    const depth = await undoDepth(page);
    await setRamp(page, 'bullet');
    await saidTimes(page, 'This clip is too short for a speed ramp.', 1);
    expect(await project(page)).toEqual(tiny);
    expect(await undoDepth(page)).toBe(depth);

    // Twenty times as fast is beyond a ramp: Custom starts level at ten times, and the clip is
    // as long as that makes it.
    await select(page, [aurora]);
    await setSpeed(page, 20);
    expect(await clip(page, aurora)).toMatchObject({ speed: 20, duration: 6 });
    await setRamp(page, 'custom');
    expect(await clip(page, aurora)).toMatchObject({ speed: 20, duration: 12, sourceIn: 0 });
    expect((await clip(page, aurora)).ramp).toEqual([
      { m: 0, v: 10 },
      { m: 4, v: 10 },
    ]);
    await expect(
      toast(page, 'A ramp runs between 10% and 1000%, so the clip now plays at 1000%.'),
    ).toBeVisible();
    // Custom on a clip that is on a ramp keeps the ramp, and says nothing more.
    const again = await undoDepth(page);
    await setRamp(page, 'custom');
    expect(await undoDepth(page)).toBe(again);
    await saidTimes(page, 'A ramp runs between', 1);

    // A twentieth of the speed is beyond it the other way.
    await setSpeed(page, 0.05);
    expect(await clip(page, aurora)).toMatchObject({ speed: 0.05, ramp: null, duration: 2400 });
    await setRamp(page, 'custom');
    expect(await clip(page, aurora)).toMatchObject({ speed: 0.05, duration: 1200 });
    expect((await clip(page, aurora)).ramp?.map((q) => q.v)).toEqual([0.1, 0.1]);
    await expect(
      toast(page, 'A ramp runs between 10% and 1000%, so the clip now plays at 10%.'),
    ).toBeVisible();
    // Within what a ramp runs at, Custom changes no length and says nothing.
    await setSpeed(page, 2);
    await setRamp(page, 'custom');
    expect(await clip(page, aurora)).toMatchObject({ speed: 2, duration: 60 });
    expect((await clip(page, aurora)).ramp?.map((q) => q.v)).toEqual([2, 2]);
    expect(await said(page, 'A ramp runs between')).toHaveLength(2);
  });

  test('a point is added where the playhead is, on the curve, up to the most a ramp holds', async ({
    page,
  }) => {
    await sampleProject(page);
    const [, , aurora] = await idsOf(page, 'video');
    const addPoint = (): Promise<number | null> =>
      page.evaluate(() => (window as any).tandem.cmd.addRampPoint() as number | null);
    const points = async (): Promise<RampPoint[] | null> => (await clip(page, aurora)).ramp;
    expect(await addPoint()).toBeNull();
    await saidTimes(page, 'Select a video or sound clip to ramp its speed.', 1);

    // A clip at one speed: three points at that speed, and the length it had.
    await select(page, [aurora]);
    await seek(page, 300);
    const depth = await undoDepth(page);
    expect(await addPoint()).toBe(2);
    expect(await points()).toEqual([
      { m: 0, v: 1 },
      { m: 2, v: 1 },
      { m: 4, v: 1 },
    ]);
    expect((await clip(page, aurora)).duration).toBe(120);
    expect(await undoDepth(page)).toBe(depth + 1);
    // The playhead is on that point now: the next goes into the middle of the wider gap, the first.
    expect(await addPoint()).toBe(1);
    await undo(page);
    await undo(page);
    expect(await points()).toBeNull();

    // On a ramp the point lies on the curve: at frame 48 of Ramp up the clip shows 1.25 s of its
    // media at 125%. A point is a place where the speed rests, so the length changes a little.
    await setRamp(page, 'rampUp');
    expect((await clip(page, aurora)).duration).toBe(96);
    await seek(page, 240 + 48);
    expect(await addPoint()).toBe(1.25);
    expect(await points()).toEqual([
      { m: 0, v: 0.5 },
      { m: 1.25, v: 1.25 },
      { m: 4, v: 2 },
    ]);
    expect((await clip(page, aurora)).duration).toBe(94);
    // With the playhead off the clip it goes into the widest gap.
    await seek(page, 0);
    expect(await addPoint()).toBe(2.625);

    // Thirty-two points are a full ramp.
    const full = Array.from({ length: 32 }, (_, i) => ({ m: i / 8, v: i % 2 ? 2 : 1 }));
    await page.evaluate((full) => (window as any).tandem.cmd.setRampPoints(full), full);
    expect(await points()).toEqual(full);
    const held = await project(page);
    expect(await addPoint()).toBeNull();
    await saidTimes(page, 'A ramp holds at most 32 points.', 1);
    await page.evaluate((more) => (window as any).tandem.cmd.setRampPoints(more), [...full, { m: 4, v: 1 }]);
    await saidTimes(page, 'A ramp holds at most 32 points.', 2);
    expect(await project(page)).toEqual(held);
    // And no points are no ramp.
    await page.evaluate(() => (window as any).tandem.cmd.setRampPoints(null));
    expect(await points()).toBeNull();
  });

  test('sound keeps its pitch from the first change of its speed on, written in the document, until it is switched off', async ({
    page,
  }) => {
    await syncSequence(page);
    const [picture, untouched] = await idsOf(page, 'video');
    const [sound, other] = await idsOf(page, 'audio');
    const keepPitch = (on?: boolean): Promise<void> =>
      page.evaluate((on) => (window as any).tandem.cmd.setKeepPitch(on), on);
    // Nobody has changed the speed of these clips: the document holds no such field for them.
    for (const id of [picture, sound, untouched, other]) {
      expect(await written(page, id, 'keepPitch')).toEqual({ has: false, value: null });
      expect((await clip(page, id)).keepPitch).toBeNull();
    }
    await keepPitch();
    await saidTimes(page, 'Select a sound clip to keep its pitch.', 1);

    await select(page, [picture, sound]);
    let depth = await undoDepth(page);
    await setSpeed(page, 2);
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: true });
    // A picture has no sound of its own to keep the pitch of.
    expect((await written(page, picture, 'keepPitch')).has).toBe(false);
    expect(await undoDepth(page)).toBe(depth + 1);
    await undo(page);
    expect((await clip(page, sound)).keepPitch).toBeNull();
    await page.evaluate(() => (window as any).tandem.cmd.redo());
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: true });

    // Switched off, it stays off through the next change of speed, and through a ramp.
    depth = await undoDepth(page);
    await keepPitch(false);
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: false });
    expect(await undoDepth(page)).toBe(depth + 1);
    await setSpeed(page, 0.5);
    expect((await clip(page, sound)).speed).toBe(0.5);
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: false });
    await setRamp(page, 'rampUp');
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: false });
    // Without a word it switches over, from the picture as well: the sound is the one linked to it.
    await set(page, { linkedSelection: false });
    await select(page, [picture]);
    await keepPitch();
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: true });
    await keepPitch();
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: false });
    await undo(page);
    expect(await written(page, sound, 'keepPitch')).toEqual({ has: true, value: true });

    // A ramp is a change of speed like any other for the sound it is set on.
    await select(page, [untouched]);
    await setRamp(page, 'flashIn');
    expect(await written(page, other, 'keepPitch')).toEqual({ has: true, value: true });
    expect((await written(page, untouched, 'keepPitch')).has).toBe(false);
  });

  test('the palette lists the shapes, and running one is the command', async ({ page }) => {
    await sampleProject(page);
    const [dusk] = await idsOf(page, 'video');
    await select(page, [dusk]);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const run = async (query: string, title: string): Promise<void> => {
      await page.keyboard.press('Control+k');
      await palette.getByLabel('Search commands').fill(query);
      await expect(palette.getByRole('option').first()).toHaveText(new RegExp(`^${title}`));
      await page.keyboard.press('Enter');
      await expect(palette).toHaveCount(0);
    };
    await page.keyboard.press('Control+k');
    await palette.getByLabel('Search commands').fill('speed ramp');
    for (const name of [
      'None',
      'Ramp up',
      'Ramp down',
      'Montage',
      'Hero',
      'Bullet',
      'Flash in',
      'Flash out',
    ]) {
      await expect(palette.getByText(`Speed ramp: ${name}`, { exact: true })).toBeVisible();
    }
    await page.keyboard.press('Escape');

    await run('speed ramp: bullet', 'Speed ramp: Bullet');
    expect(await rows(page)).toEqual({ ...SAMPLE, V1: ['0-27', '120-240', '240-360'] });
    await seek(page, 5);
    await run('add ramp point', 'Add ramp point at playhead');
    expect((await clip(page, dusk)).ramp).toHaveLength(6);
    await run('speed ramp: none', 'Speed ramp: None');
    expect((await clip(page, dusk)).ramp).toBeNull();
    // The music: its pitch follows its speed until it is asked to keep it.
    const [music] = await idsOf(page, 'audio');
    await select(page, [music]);
    await run('keep pitch', 'Keep pitch: on or off');
    expect(await written(page, music, 'keepPitch')).toEqual({ has: true, value: true });
  });
});

/**
 * Let the pages of `context` lose the collaboration server on demand (`cutOff`, `reconnect`):
 * while cut off, their sockets to it fail to open. The dev server's own socket is left unanswered,
 * so a file saved while the test runs does not reload a page under it.
 */
const canBeCutOff = (context: BrowserContext): Promise<unknown> =>
  context.addInitScript(() => {
    const net = ((window as any).__net = { down: false });
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        const url = String(args[0]);
        if (/\/\?token=/.test(url)) {
          return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} });
        }
        if (!net.down || !url.includes('/ws/')) return new target(...(args as [string]));
        const dead: any = { readyState: 3, send() {}, close() {} };
        setTimeout(() => dead.onclose?.({ code: 1006 }), 5);
        return dead;
      },
    });
  });

const cutOff = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as any).__net.down = true;
    for (const p of (window as any).tandem.session.providers) p.ws?.close();
  });

const reconnect = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as any).__net.down = false;
    window.dispatchEvent(new Event('online'));
  });

test.describe('speed ramps and two people', () => {
  /** The owner with a sync clip of two seconds on the timeline, and an editor who has joined. */
  async function together(
    page: Page,
    browser: Browser,
  ): Promise<{ b: Page; close: () => Promise<void>; picture: string; sound: string }> {
    await canBeCutOff(page.context());
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      const [asset] = Object.values(session.store.get().assets);
      cmd.addAsset(asset, { frame: 0, sourceIn: 1, sourceOut: 3 });
      ui.getState().clearSelection();
    });
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await canBeCutOff(ctxB);
    const b = await ctxB.newPage();
    await b.goto(link);
    await b.waitForFunction(() => (window as any).tandem?.session?.getMeta().status === 'connected');
    await expect.poll(() => page.evaluate(() => (window as any).tandem.session.peers.get().length)).toBe(1);
    await expect
      .poll(() => b.evaluate(() => Object.keys((window as any).tandem.session.store.get().clips).length))
      .toBe(2);
    const [picture] = await idsOf(page, 'video');
    const [sound] = await idsOf(page, 'audio');
    return { b, close: () => ctxB.close(), picture, sound };
  }

  /** Wait until both have the same clips, and give the project they then share. */
  async function alike(page: Page, b: Page): Promise<Project> {
    let shared = await project(page);
    await expect
      .poll(async () => {
        shared = await project(page);
        return isDeepStrictEqual(shared.clips, (await project(b)).clips);
      })
      .toBe(true);
    return shared;
  }

  test('two shapes set on one clip at the same moment leave one of them, whole, for both', async ({
    page,
    browser,
  }) => {
    const errors = trackErrors(page);
    const { b, close, picture, sound } = await together(page, browser);
    const theirErrors = trackErrors(b);
    const flat = [
      { m: 1, v: 1 },
      { m: 3, v: 1 },
    ];
    const won: string[] = [];
    // Bullet makes the clip 14 frames long and Custom leaves it at 60. Whoever's ramp stands,
    // the length that goes with it stands too. Once with each of them asking for each.
    for (const [mine, theirs] of [
      ['bullet', 'custom'],
      ['custom', 'bullet'],
    ] as const) {
      await select(page, [picture]);
      await select(b, [picture]);
      for (const p of [page, b]) await cutOff(p);
      await setRamp(page, mine);
      await setRamp(b, theirs);
      expect((await clip(page, picture)).duration).toBe(mine === 'bullet' ? 14 : 60);
      expect((await clip(b, picture)).duration).toBe(theirs === 'bullet' ? 14 : 60);
      for (const p of [page, b]) await reconnect(p);
      const p = await alike(page, b);
      const ramp = p.clips[picture].ramp!;
      const bullet = ramp.length === 5;
      won.push(bullet ? 'bullet' : 'custom');
      if (!bullet) expect(ramp).toEqual(flat);
      for (const id of [picture, sound]) {
        expect(p.clips[id]).toMatchObject({ start: 0, duration: bullet ? 14 : 60, sourceIn: 1 });
        expect(p.clips[id].ramp).toEqual(ramp);
      }
      expect(apart(p, p.clips[picture], p.clips[sound])).toBeLessThan(1e-9);
      // Back to where they began for the next round: one of them undoes, then the other.
      await undo(page);
      await alike(page, b);
      await undo(b);
      const back = await alike(page, b);
      for (const id of [picture, sound]) {
        expect(back.clips[id]).toMatchObject({ ramp: null, start: 0, duration: 60, sourceIn: 1 });
      }
    }
    // The same person's change stands both times, so each shape has stood once.
    expect(won.sort()).toEqual(['bullet', 'custom']);
    expect([...errors, ...theirErrors]).toEqual([]);
    await close();
  });

  test('a shape set while the other person trims the head leaves both alike, with the ramp there', async ({
    page,
    browser,
  }) => {
    const { b, close, picture, sound } = await together(page, browser);
    const found = await project(page);
    const outcomes: string[] = [];
    // Once with each of the two setting the shape while the other trims.
    for (const [shaper, trimmer] of [
      [page, b],
      [b, page],
    ]) {
      await select(shaper, [picture]);
      for (const p of [page, b]) await cutOff(p);
      await setRamp(shaper, 'rampDown');
      expect((await rows(shaper)).V1).toEqual(['0-48']);
      // The other person takes ten frames off the head of the picture and of its sound.
      await trimmer.evaluate(
        (ids) => {
          const { session } = (window as any).tandem;
          const patch = { start: 10, duration: 50, sourceIn: 1 + 10 / 30 };
          session.store.commit(ids.map((id) => ({ op: 'updateClip', id, patch })));
        },
        [picture, sound],
      );
      for (const p of [page, b]) await reconnect(p);
      const p = await alike(page, b);
      // The ramp stands for both clips, on the media it was set on, and the picture begins where
      // the trim put it: nobody else wrote its start.
      for (const id of [picture, sound]) {
        expect(p.clips[id].ramp).toEqual([
          { m: 1, v: 2 },
          { m: 3, v: 0.5 },
        ]);
      }
      expect(p.clips[picture].start).toBe(10);
      // Length and in point are one person's, and so is where the sound begins, which both wrote.
      const trim = { start: 10, duration: 50, sourceIn: 1 + 10 / 30 };
      const places = [picture, sound].map((id) => {
        const { start, duration, sourceIn } = p.clips[id];
        return { start, duration, sourceIn };
      });
      const trimWon = places[0].duration === 50;
      if (trimWon) {
        expect(places).toEqual([trim, trim]);
        // The trim's in point on the ramp: picture and sound play the same media on every frame.
        expect(apart(p, p.clips[picture], p.clips[sound])).toBeLessThan(1e-9);
      } else {
        expect(places).toEqual([
          { start: 10, duration: 48, sourceIn: 1 },
          { start: 0, duration: 48, sourceIn: 1 },
        ]);
      }
      outcomes.push(trimWon ? 'trim' : 'ramp');
      // As it was found, for the next round.
      await page.evaluate(
        (clips) => {
          const { session } = (window as any).tandem;
          session.store.commit(
            clips.map(({ id, start, duration, sourceIn, ramp, keepPitch }: any) => ({
              op: 'updateClip',
              id,
              patch: { start, duration, sourceIn, ramp, keepPitch },
            })),
          );
        },
        [found.clips[picture], found.clips[sound]],
      );
      await expect.poll(async () => isDeepStrictEqual((await project(b)).clips, found.clips)).toBe(true);
    }
    // The same person's writes stand both times: once that was the shape, once the trim.
    expect(outcomes.sort()).toEqual(['ramp', 'trim']);
    await close();
  });
});
