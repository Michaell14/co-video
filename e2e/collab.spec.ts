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
});
