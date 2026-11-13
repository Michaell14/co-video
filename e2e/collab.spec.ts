import { expect, test, type Page } from '@playwright/test';
import { clips, importFixtures, newProject, trackErrors } from './helpers';

/** Everything a person's view counts in frames, and the comments everyone shares. */
const view = (p: Page) =>
  p.evaluate(() => {
    const { session, ui } = (window as any).tandem;
    const s = session.store.get().settings;
    return {
      fps: s.fpsNum / s.fpsDen,
      frame: session.player.getFrame(),
      range: session.player.getState().range,
      ppf: ui.getState().ppf,
      comments: session.review
        .get()
        .map((c: any) => c.frame)
        .sort((a: number, b: number) => a - b),
    };
  });

/** Pick a frame rate in the project settings. */
async function setRate(page: Page, label: string): Promise<void> {
  await page.locator('[aria-label="Inspector"] .row', { hasText: 'Frame rate' }).locator('.select').click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

function comment(page: Page, frame: number, text: string): Promise<void> {
  return page.evaluate(
    ({ frame, text }) => {
      const { session } = (window as any).tandem;
      const u = session.getMeta().user;
      session.review.add({
        frame,
        text,
        authorId: u.id,
        authorName: u.name,
        authorColor: u.color,
        x: null,
        y: null,
      });
    },
    { frame, text },
  );
}

/** An awareness update as it travels: `[client id, clock, state]` entries. Built in the page. */
const awarenessFrame = (entries: [number, number, unknown][]): number[] => {
  const varUint = (n: number): number[] => {
    const out: number[] = [];
    while (n > 127) {
      out.push(128 | (n % 128));
      n = Math.floor(n / 128);
    }
    out.push(n);
    return out;
  };
  const inner = [...varUint(entries.length)];
  for (const [id, clock, state] of entries) {
    const json = Array.from(new TextEncoder().encode(JSON.stringify(state)));
    inner.push(...varUint(id), ...varUint(clock), ...varUint(json.length), ...json);
  }
  // Message type 1 is awareness.
  return [1, ...varUint(inner.length), ...inner];
};

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
      cmd.seek(45);
      (window as any).tandem.ui.getState().set({ selection: [] });
    });
    await comment(page, 90, 'Here');
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
    const zoom = (await view(b)).ppf;
    const parked = { fps: 30, frame: 60, range: { in: 30, out: 150 }, ppf: zoom, comments: [90] };
    expect(await view(b)).toEqual(parked);

    // Twice the frames: every count of the collaborator's doubles, once, and the zoom halves.
    await setRate(page, '60 fps');
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
    await setRate(page, '24 fps');
    await expect
      .poll(() => view(b))
      .toEqual({ fps: 24, frame: 232, range: { in: 24, out: 120 }, ppf: zoom / (24 / 30), comments: [72] });

    await ctxB.close();
  });

  test('a version or a project file at another frame rate takes comments, playhead and range with it', async ({
    page,
    browser,
  }) => {
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');

    // Ten seconds of picture at 30 fps and a comment three seconds in: kept as a file and as a version.
    await page.evaluate(() => {
      const { session, cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addSolid('#205080');
      const solid = Object.values(session.store.get().clips)[0] as any;
      session.store.commit([{ op: 'updateClip', id: solid.id, patch: { duration: 300 } }]);
      (window as any).tandem.ui.getState().set({ selection: [] });
    });
    await comment(page, 90, 'Three seconds in');
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    const file = await download.path();
    await page.waitForTimeout(600);
    await page.evaluate(async () => {
      const s = (window as any).tandem.session;
      const res = await fetch(`/api/projects/${s.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ name: 'At 30', author: 'Test' }),
      });
      if (!res.ok) throw new Error(`version not saved (${res.status})`);
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

    // The project moves to 60 fps and work goes on there: a second comment, on an odd frame.
    await setRate(page, '60 fps');
    await expect.poll(async () => (await view(b)).fps).toBe(60);
    await comment(page, 121, 'Just after two seconds');
    for (const p of [page, b]) {
      await p.evaluate(() => {
        const { session, cmd } = (window as any).tandem;
        cmd.seek(120);
        session.player.setRange({ in: 60, out: 300 });
      });
    }
    const zoom = (await view(page)).ppf;
    const at60 = { fps: 60, frame: 120, range: { in: 60, out: 300 }, ppf: zoom, comments: [121, 180] };
    expect(await view(page)).toEqual(at60);
    await expect.poll(() => view(b)).toEqual({ ...at60, ppf: (await view(b)).ppf });
    const zoomB = (await view(b)).ppf;

    // The 30 fps version comes back. Everything outside the document follows, for the person who
    // restores as much as for the collaborator: the same moments at half the frame numbers. The
    // first comment returns to the exact frame it had; the odd one has no such frame and rounds.
    const at30 = { fps: 30, frame: 60, range: { in: 30, out: 150 }, ppf: zoom * 2, comments: [61, 90] };
    await page.evaluate(() => (window as any).tandem.ui.getState().set({ dialog: 'versions' }));
    await page.locator('.version', { hasText: 'At 30' }).getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('button', { name: 'Restore version' }).click();
    await expect.poll(() => view(page)).toEqual(at30);
    await expect.poll(() => view(b)).toEqual({ ...at30, ppf: zoomB * 2 });

    // Undoing the restore takes all of it back, comments to the frame they came from.
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await expect.poll(() => view(page)).toEqual(at60);
    await expect.poll(() => view(b)).toEqual({ ...at60, ppf: zoomB });
    await page.evaluate(() => (window as any).tandem.cmd.redo());
    await expect.poll(() => view(page)).toEqual(at30);
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await expect.poll(() => view(page)).toEqual(at60);

    // The project file saved at 30 fps, loaded over the open project, is the same journey.
    await page.keyboard.press('Control+k');
    await page.locator('.palette input').fill('replace this project');
    await expect(page.locator('.palette__item')).toHaveCount(1);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    await chooser.setFiles(file);
    await page.getByRole('button', { name: 'Replace project' }).click();
    await expect.poll(() => view(page)).toEqual(at30);
    await expect.poll(() => view(b)).toEqual({ ...at30, ppf: zoomB * 2 });
    await page.evaluate(() => (window as any).tandem.cmd.undo());
    await expect.poll(() => view(page)).toEqual(at60);
    await expect.poll(() => view(b)).toEqual({ ...at60, ppf: zoomB });

    await ctxB.close();
  });

  test('nothing a participant announces breaks anyone’s editor, reaches a style or becomes someone else’s words', async ({
    page,
    browser,
  }) => {
    const errors = trackErrors(page);
    await page.context().routeWebSocket(/\/\?token=/, () => {});
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    await page.evaluate(() => {
      const { cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addText({ content: 'One' });
      cmd.seek(200);
      cmd.addText({ content: 'Two' });
      cmd.seek(0);
    });
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));
    const ctxB = await browser.newContext();
    await ctxB.routeWebSocket(/\/\?token=/, () => {});
    const b = await ctxB.newPage();
    await b.goto(link);
    await b.waitForFunction(() => {
      const s = (window as any).tandem?.session;
      return (
        !!s?.player && Object.keys(s.store.get().clips).length === 2 && s.getMeta().status === 'connected'
      );
    });
    const bId: number = await b.evaluate(() => (window as any).tandem.session.awareness.clientID);
    const peer = (p: Page, clientId: number) =>
      p.evaluate(
        (clientId) =>
          (window as any).tandem.session.peers.get().find((x: any) => x.clientId === clientId) ?? null,
        clientId,
      );
    await expect.poll(() => peer(page, bId)).not.toBeNull();
    const crashed = page.locator('.splash[role=alert]');

    // One state with every field wrong, sent the way any link holder can: straight to the room.
    await b.evaluate(() => {
      (window as any).tandem.session.awareness.setLocalState({
        user: { id: 'intruder', name: 12345, color: 'url(https://example.com/seen.png)' },
        role: 'superuser',
        playhead: 'NaN',
        playing: 1,
        selection: 7,
        cursor: 'x',
        dragging: 5,
        page: 3,
      });
    });
    await expect.poll(async () => (await peer(page, bId))?.user.id).toBe('intruder');
    const read = await peer(page, bId);
    expect(read).toMatchObject({
      user: { id: 'intruder', name: 'Guest' },
      playhead: 0,
      playing: false,
      selection: [],
      cursor: null,
      dragging: [],
      page: 'edit',
    });
    expect(read.user.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(['owner', 'editor', 'commenter', 'viewer']).toContain(read.role);
    await expect(crashed).toHaveCount(0);
    await expect(page.locator('.tl')).toBeVisible();
    await expect(page.locator('.avatars .avatar').first()).toHaveText('GU');

    // Long lists and a name of any length are drawn up to a bound, in a colour that is one.
    const { clipIds, trackId } = await page.evaluate(() => {
      const all = Object.values((window as any).tandem.session.store.get().clips) as any[];
      return { clipIds: all.map((c) => c.id), trackId: all[0].trackId };
    });
    await b.evaluate(
      ({ clipIds, trackId }) => {
        // Well under what the server relays, far over what anyone needs to see.
        const many = Array.from({ length: 1000 }, (_, i) => `made-up-${i}`);
        (window as any).tandem.session.awareness.setLocalState({
          user: {
            id: 'intruder',
            name: 'E'.repeat(20_000),
            color: 'red; background: url(https://example.com/seen.png)',
          },
          role: 'editor',
          playhead: 30,
          playing: false,
          selection: [...clipIds, ...many],
          cursor: { area: 'timeline', x: 30, y: trackId },
          dragging: many.map((id, i) => ({ id, start: i * 12, duration: 10, trackId })),
          page: 'edit',
        });
      },
      { clipIds, trackId },
    );
    await expect.poll(async () => (await peer(page, bId))?.selection.length).toBe(100);
    const long = await peer(page, bId);
    expect(long.user.name).toBe('E'.repeat(60));
    expect(long.dragging).toHaveLength(50);
    await expect(page.locator('.peer-ghost')).toHaveCount(50);
    const styles = await page
      .locator('.avatars .avatar, .peer-ghost, .peer-cursor, .playhead--peer')
      .evaluateAll((els) => els.map((e) => e.getAttribute('style') ?? '').join('\n'));
    expect(styles).not.toMatch(/url|example\.com|red/);
    expect(styles).toContain(long.user.color);
    await expect(crashed).toHaveCount(0);

    // Someone speaks for the owner: an entry under the owner's own id, later than anything they said.
    const mine = await page.evaluate(() => {
      const { awareness } = (window as any).tandem.session;
      return {
        id: awareness.clientID as number,
        clock: awareness.meta.get(awareness.clientID).clock as number,
        name: awareness.getLocalState().user.name as string,
      };
    });
    const forged = {
      user: { id: 'x', name: 'Mallory (owner)', color: '#ff0000' },
      role: 'owner',
      playhead: 0,
      playing: false,
      selection: [],
      cursor: null,
      dragging: null,
      page: 'edit',
    };
    await page.evaluate(
      (bytes) => {
        const socket = (window as any).tandem.session.providers[0].ws as WebSocket;
        socket.onmessage!(new MessageEvent('message', { data: new Uint8Array(bytes).buffer }));
      },
      awarenessFrame([[mine.id, mine.clock + 50, forged]]),
    );
    const said = () =>
      page.evaluate(() => {
        const { awareness } = (window as any).tandem.session;
        return {
          name: awareness.getLocalState().user.name as string,
          clock: awareness.meta.get(awareness.clientID).clock as number,
        };
      });
    // The owner still says who they are, and says it later than the forgery so that it is believed.
    expect(await said()).toEqual({ name: mine.name, clock: mine.clock + 51 });
    await page.evaluate(() => (window as any).tandem.session.setPresence({ playhead: 12 }));
    await expect.poll(async () => (await peer(b, mine.id))?.playhead).toBe(12);
    expect((await said()).name).toBe(mine.name);
    expect((await peer(b, mine.id)).user.name).toBe(mine.name);

    // The owner's own pointer and playhead are no reason to draw everyone else again.
    const quiet = await page.evaluate(async () => {
      const s = (window as any).tandem.session;
      let changes = 0;
      const off = s.peers.subscribe(() => changes++);
      const before = s.peers.get();
      for (let i = 0; i < 5; i++) {
        s.setPresence({ cursor: { area: 'viewer', x: i / 5, y: 0.5 }, playhead: 20 + i });
        await new Promise((r) => setTimeout(r, 100));
      }
      off();
      return { changes, same: s.peers.get() === before };
    });
    expect(quiet).toEqual({ changes: 0, same: true });

    // And what the owner publishes stays small, however much is selected.
    await page.evaluate(() => {
      const { session, ui } = (window as any).tandem;
      const one = Object.values(session.store.get().clips)[0] as any;
      const edits = Array.from({ length: 150 }, (_, i) => ({
        op: 'addClip',
        clip: { ...one, id: `filler${i}`, start: 1000 + i * 100, linkId: null },
      }));
      session.store.commit(edits);
      ui.getState().set({ selection: Object.keys(session.store.get().clips) });
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).tandem.session.awareness.getLocalState().selection.length),
      )
      .toBe(100);
    await expect.poll(async () => (await peer(b, mine.id))?.selection.length).toBe(100);

    await ctxB.close();
    expect(errors).toEqual([]);
  });
});
