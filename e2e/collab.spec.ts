import { expect, test } from '@playwright/test';
import { clips, importFixtures, newProject, trackErrors } from './helpers';

test.describe('collaboration', () => {
  test('two editors and a viewer share one project', async ({ page, browser }) => {
    const errors = trackErrors(page);
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online, 'collaboration server not reachable');
    expect(meta.role).toBe('owner');
    expect(meta.shared).toBe(true);

    await importFixtures(page, ['testsrc.mp4']);
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addAsset(Object.values(session.store.get().assets)[0]);
      cmd.seek(15);
      cmd.addText({ content: 'Shared edit' });
    });
    // The owner's media uploads on its own.
    await page.waitForFunction(() =>
      Object.values((window as any).tandem.session.store.get().assets).every((a: any) => a.uploaded),
    );
    const editorLink: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));
    const viewerLink: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('viewer'));

    // ── A second editor joins by link ─────────────────────────────────────
    const ctxB = await browser.newContext();
    const b = await ctxB.newPage();
    const errorsB = trackErrors(b);
    await b.goto(editorLink);
    await b.waitForFunction(
      () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 3,
    );
    expect(await b.evaluate(() => (window as any).tandem.session.getMeta().role)).toBe('editor');
    // The token is a capability; it must not linger in the address bar.
    expect(b.url()).not.toContain('t=');
    expect(await clips(b)).toEqual(await clips(page));
    // Media arrives from the server and is cached locally.
    await b.waitForFunction(() => {
      const s = (window as any).tandem.session;
      return Object.values(s.store.get().assets).every((a: any) => s.media.get(a.id).local);
    });

    // Presence: each sees the other.
    await page.waitForFunction(() => (window as any).tandem.session.awareness.getStates().size === 2);
    await expect(page.locator('.avatars .avatar')).toHaveCount(2);

    // B edits; A sees it. Selections show up as coloured rings.
    await b.evaluate(() => {
      const { session, cmd, ui } = (window as any).tandem;
      const t = (Object.values(session.store.get().clips) as any[]).find((c) => c.type === 'text');
      ui.getState().select([t.id]);
      cmd.nudge(30);
    });
    await page.waitForFunction(() =>
      (Object.values((window as any).tandem.session.store.get().clips) as any[]).some(
        (c) => c.type === 'text' && c.start === 45,
      ),
    );
    await expect(page.locator('.clip__peer')).toBeVisible();

    // Concurrent edits to different properties of the same clip both survive.
    await Promise.all([
      page.evaluate(() => {
        const { session } = (window as any).tandem;
        const t = (Object.values(session.store.get().clips) as any[]).find((c) => c.type === 'text');
        session.store.commit([{ op: 'updateClip', id: t.id, patch: { opacity: 0.5 } }]);
      }),
      b.evaluate(() => {
        const { session } = (window as any).tandem;
        const t = (Object.values(session.store.get().clips) as any[]).find((c) => c.type === 'text');
        session.store.commit([{ op: 'updateClip', id: t.id, patch: { rotation: 15 } }]);
      }),
    ]);
    for (const p of [page, b]) {
      await p.waitForFunction(() => {
        const t = (Object.values((window as any).tandem.session.store.get().clips) as any[]).find(
          (c) => c.type === 'text',
        );
        return t.opacity === 0.5 && t.rotation === 15;
      });
    }

    // Comments travel on their own document.
    await b.evaluate(() => {
      const s = (window as any).tandem.session;
      const u = s.getMeta().user;
      s.review.add({
        frame: 20,
        text: 'Tighten this',
        authorId: u.id,
        authorName: u.name,
        authorColor: u.color,
        x: null,
        y: null,
      });
    });
    await page.waitForFunction(() => (window as any).tandem.session.review.get().length === 1);

    // ── A viewer can watch but never write ────────────────────────────────
    const ctxC = await browser.newContext();
    const c = await ctxC.newPage();
    await c.goto(viewerLink);
    await c.waitForFunction(
      () => Object.keys((window as any).tandem?.session?.store.get().clips ?? {}).length === 3,
    );
    expect(await c.evaluate(() => (window as any).tandem.session.getMeta().role)).toBe('viewer');
    // The polite path: commands refuse.
    await c.evaluate(() => {
      const { cmd } = (window as any).tandem;
      cmd.selectAll();
      cmd.delete(false);
    });
    // The hostile path: write straight into the CRDT. The server must drop it.
    await c.evaluate(() => {
      const s = (window as any).tandem.session;
      s.doc.transact(() => {
        for (const k of Array.from(s.doc.getMap('clips').keys())) s.doc.getMap('clips').delete(k);
      });
    });
    await page.waitForTimeout(1000);
    expect(await clips(page)).toHaveLength(3);
    expect(await clips(b)).toHaveLength(3);

    await ctxB.close();
    await ctxC.close();
    expect(errors).toEqual([]);
    expect(errorsB).toEqual([]);
  });

  test('a collaborator’s new frame rate leaves your playhead, range and zoom on the same moment', async ({
    page,
    browser,
  }) => {
    // A file saved while this runs must not reload either page under it (the dev server's socket).
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');

    // Ten seconds of picture at 30 fps, and a comment three seconds in.
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addSolid('#205080');
      const solid = Object.values(session.store.get().clips)[0] as any;
      session.store.commit([{ op: 'updateClip', id: solid.id, patch: { duration: 300 } }]);
      const u = session.getMeta().user;
      session.review.add({
        frame: 90,
        text: 'Here',
        authorId: u.id,
        authorName: u.name,
        authorColor: u.color,
        x: null,
        y: null,
      });
      cmd.seek(45);
      (window as any).tandem.ui.getState().set({ selection: [] });
    });
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));

    const ctxB = await browser.newContext();
    await ctxB.routeWebSocket(/\/\?token=/, () => {});
    const b = await ctxB.newPage();
    await b.goto(link);
    await b.waitForFunction(() => {
      const s = (window as any).tandem?.session;
      return !!s?.player && Object.keys(s.store.get().clips).length === 1 && s.review.get().length === 1;
    });
    // The collaborator is parked two seconds in, with a range marked from one second to five.
    await b.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(60);
      session.player.setRange({ in: 30, out: 150 });
    });
    const view = (p: typeof page) =>
      p.evaluate(() => {
        const { session, ui } = (window as any).tandem;
        const s = session.store.get().settings;
        return {
          fps: s.fpsNum / s.fpsDen,
          frame: session.player.getFrame(),
          range: session.player.getState().range,
          ppf: ui.getState().ppf,
          comments: session.review.get().map((c: any) => c.frame),
        };
      });
    const zoom = (await view(b)).ppf;
    const parked = { fps: 30, frame: 60, range: { in: 30, out: 150 }, ppf: zoom, comments: [90] };
    expect(await view(b)).toEqual(parked);

    const setRate = async (label: string) => {
      await page
        .locator('[aria-label="Inspector"] .row', { hasText: 'Frame rate' })
        .locator('.select')
        .click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };
    // Twice the frames: every count of the collaborator's doubles, once, and the zoom halves.
    await setRate('60 fps');
    await expect
      .poll(() => view(b))
      .toEqual({ fps: 60, frame: 120, range: { in: 60, out: 300 }, ppf: zoom / 2, comments: [180] });
    // Whoever made the change is re-timed once as well, not a second time by its echo.
    expect((await view(page)).frame).toBe(90);

    // Undone by its author, it takes the collaborator back to where they were.
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await expect.poll(() => view(b)).toEqual(parked);
    expect((await view(page)).frame).toBe(45);

    // Fewer frames, with the playhead beyond the new end of the sequence: it lands on the same
    // moment, not on that end.
    await b.evaluate(() => (window as any).tandem.cmd.seek(290));
    await setRate('24 fps');
    await expect
      .poll(() => view(b))
      .toEqual({ fps: 24, frame: 232, range: { in: 24, out: 120 }, ppf: zoom / (24 / 30), comments: [72] });

    await ctxB.close();
  });
});
