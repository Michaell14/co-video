import { expect, test, type BrowserContext, type Page } from '@playwright/test';
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

/**
 * Let the pages of `context` lose the collaboration server on demand (`cutOff`, `reconnect`):
 * while cut off, their sockets to it fail to open. The dev server's own socket is left unanswered,
 * so a file saved while the test runs does not reload a page under it.
 */
const canBeCutOff = (context: BrowserContext): Promise<void> =>
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

/** Start counting toasts as they appear; `toasts` then lists the ones that said `text`. */
const watchToasts = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seen: string[] = ((window as any).__toasts = []);
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes))
          if (n instanceof HTMLElement && n.classList.contains('toast')) seen.push(n.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true });
  });

const toasts = (page: Page, text: string): Promise<string[]> =>
  page.evaluate((text) => ((window as any).__toasts as string[]).filter((t) => t.includes(text)), text);

/** `start+duration text` for every title, sorted; with `tracks`, `V1:`, `V2:`, … in front. */
const titles = (page: Page, tracks = false): Promise<string[]> =>
  page.evaluate((tracks) => {
    const p = (window as any).tandem.session.store.get();
    return (Object.values(p.clips) as any[])
      .map((c) => {
        const track = tracks ? `V${p.tracks[c.trackId].order + 1}:` : '';
        return `${track}${c.start}+${c.duration} ${c.text?.content}`;
      })
      .sort();
  }, tracks);

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

    // Bringing in media is refused in the words of the access each of them has.
    const refusedImports = (p: Page): Promise<number> =>
      p.evaluate(async () => {
        const s = (window as any).tandem.session;
        const [asset] = Object.keys(s.store.get().assets);
        const imported = await s.importFiles([new File(['x'], 'still.png', { type: 'image/png' })]);
        const replaced = await s.replaceAsset(asset, new File(['x'], 'other.mp4', { type: 'video/mp4' }));
        return imported.length === 0 && replaced === null ? Object.keys(s.store.get().assets).length : -1;
      });
    expect(await refusedImports(c)).toBe(1);
    await expect(c.locator('.toast', { hasText: 'You have view-only access to this project.' })).toHaveCount(2);
    const commenterLink: string = await page.evaluate(() =>
      (window as any).tandem.session.inviteLink('commenter'),
    );
    await c.goto(commenterLink);
    await c.waitForFunction(() => (window as any).tandem?.session?.getMeta().role === 'commenter');
    expect(await refusedImports(c)).toBe(1);
    await expect(c.locator('.toast', { hasText: 'You have comment-only access to this project.' })).toHaveCount(
      2,
    );
    await expect(c.locator('.toast', { hasText: 'view-only' })).toHaveCount(0);

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

  test('undo and redo say so when someone else has left nothing of a step to take back', async ({
    page,
    browser,
  }) => {
    await canBeCutOff(page.context());
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));
    const ctxB = await browser.newContext();
    await canBeCutOff(ctxB);
    const b = await ctxB.newPage();
    await b.goto(link);
    await b.waitForFunction(() => (window as any).tandem?.session?.getMeta().status === 'connected');
    await watchToasts(page);
    const undoState = () =>
      page.evaluate(() => {
        const { store } = (window as any).tandem.session;
        return { canUndo: store.canUndo, canRedo: store.canRedo };
      });
    /** The collaborator makes a title, and this person moves it: a step that is theirs. */
    const theirTitleMovedByMe = async (content: string, at: number): Promise<void> => {
      await b.evaluate(
        ({ content, at }) => {
          const { cmd } = (window as any).tandem;
          cmd.seek(at);
          cmd.addText({ content });
        },
        { content, at },
      );
      await expect.poll(() => titles(page)).toContain(`${at}+150 ${content}`);
      await page.evaluate((content) => {
        const { session, cmd, ui } = (window as any).tandem;
        const clip = (Object.values(session.store.get().clips) as any[]).find(
          (c) => c.text?.content === content,
        );
        ui.getState().select([clip.id]);
        cmd.nudge(30);
        ui.getState().select([]);
      }, content);
      await expect.poll(() => titles(b)).toContain(`${at + 30}+150 ${content}`);
    };
    const theyDelete = async (content: string): Promise<void> => {
      await b.evaluate((content) => {
        const { session } = (window as any).tandem;
        const clip = (Object.values(session.store.get().clips) as any[]).find(
          (c) => c.text?.content === content,
        );
        session.store.commit([{ op: 'removeClip', id: clip.id }]);
      }, content);
      await expect.poll(async () => (await titles(page)).some((t) => t.endsWith(` ${content}`))).toBe(false);
    };

    // The only step this person has is a move of a clip that is gone: nothing to undo, and it says so.
    await theirTitleMovedByMe('Theirs', 0);
    await theyDelete('Theirs');
    expect(await undoState()).toEqual({ canUndo: true, canRedo: false });
    await page.keyboard.press('Control+z');
    await expect
      .poll(() => toasts(page, 'undo'))
      .toEqual(['Nothing left to undo: someone else has changed what those steps touched.']);
    expect(await titles(page)).toEqual([]);
    expect(await titles(b)).toEqual([]);
    expect(await undoState()).toEqual({ canUndo: false, canRedo: false });

    // With a step of their own before it, that one is taken back, and the one passed over is counted.
    await page.evaluate(() => {
      const { cmd, ui } = (window as any).tandem;
      cmd.addText({ content: 'Mine' });
      ui.getState().select([]);
    });
    await theirTitleMovedByMe('Also theirs', 0);
    await theyDelete('Also theirs');
    await page.keyboard.press('Control+z');
    await expect
      .poll(() => toasts(page, 'undone'))
      .toEqual(['1 earlier step could not be undone: someone else has changed the same things since.']);
    expect(await titles(page)).toEqual([]);
    await expect.poll(() => titles(b)).toEqual([]);

    // Redo has the same to say: the move it would make again has nothing left to move.
    await page.keyboard.press('Control+Shift+z');
    expect(await titles(page)).toEqual(['0+150 Mine']);
    await theirTitleMovedByMe('Once more', 0);
    await page.keyboard.press('Control+z');
    await expect.poll(() => titles(b)).toContain('0+150 Once more');
    await theyDelete('Once more');
    await page.keyboard.press('Control+Shift+z');
    await expect
      .poll(() => toasts(page, 'redo'))
      .toEqual(['Nothing left to redo: someone else has changed what those steps touched.']);
    expect(await titles(page)).toEqual(['0+150 Mine']);
    // An ordinary undo and redo say nothing.
    await page.keyboard.press('Control+z');
    expect(await titles(page)).toEqual([]);
    await page.keyboard.press('Control+Shift+z');
    expect(await titles(page)).toEqual(['0+150 Mine']);
    expect(await page.evaluate(() => (window as any).__toasts)).toHaveLength(3);

    await ctxB.close();
  });

  test('clips two people put on the same frames at the same moment are moved apart by one of them', async ({
    page,
    browser,
  }) => {
    await canBeCutOff(page.context());
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('editor'));
    const ctxB = await browser.newContext();
    await canBeCutOff(ctxB);
    const b = await ctxB.newPage();
    await b.goto(link);
    await b.waitForFunction(() => (window as any).tandem?.session?.getMeta().status === 'connected');
    await expect.poll(() => page.evaluate(() => (window as any).tandem.session.peers.get().length)).toBe(1);
    const people = [page, b];
    for (const p of people) await watchToasts(p);

    /** Clips that share frames with another clip of their track. */
    const sharing = (p: Page): Promise<number> =>
      p.evaluate(() => {
        const all = Object.values((window as any).tandem.session.store.get().clips) as any[];
        return all.filter((c) =>
          all.some(
            (o) =>
              o !== c &&
              o.trackId === c.trackId &&
              o.start < c.start + c.duration &&
              c.start < o.start + o.duration,
          ),
        ).length;
      });
    const steps = (p: Page): Promise<number> =>
      p.evaluate(() => (window as any).tandem.session.store.undoManager.undoStack.length);

    // Neither can see the other for a moment, and each puts a title at the start of the same track.
    for (const p of people) await cutOff(p);
    await page.evaluate(() => {
      const { cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addText({ content: 'From the owner' });
    });
    await b.evaluate(() => {
      const { cmd } = (window as any).tandem;
      cmd.seek(0);
      cmd.addText({ content: 'From the editor' });
    });
    const [placed] = await titles(page, true);
    const track = placed.slice(0, placed.indexOf(':'));
    expect(placed).toBe(`${track}:0+150 From the owner`);
    expect(await titles(b, true)).toEqual([`${track}:0+150 From the editor`]);
    const before = [await steps(page), await steps(b)];
    for (const p of people) await reconnect(p);

    // Both arrive, on top of each other; a moment later one of them has moved to a track of its own.
    for (const p of people) {
      await expect.poll(async () => (await titles(p)).length).toBe(2);
      await expect.poll(() => sharing(p)).toBe(0);
    }
    const settled = await titles(page, true);
    expect(await titles(b, true)).toEqual(settled);
    expect(settled.filter((t) => t.startsWith(`${track}:0+150 `))).toHaveLength(1);

    // Exactly one of the two moved a clip, and said so: the one whose clip it was.
    const moved = 'A clip that landed on another clip was moved to a free track.';
    await expect
      .poll(async () => [(await toasts(page, 'landed')).length, (await toasts(b, 'landed')).length].sort())
      .toEqual([0, 1]);
    const mover = (await toasts(page, 'landed')).length ? page : b;
    const other = mover === page ? b : page;
    expect(await toasts(mover, 'landed')).toEqual([moved]);
    const mine = mover === page ? 'From the owner' : 'From the editor';
    expect(settled).not.toContain(`${track}:0+150 ${mine}`);
    // It stays that way: nobody moves anything a second time.
    await page.waitForTimeout(1500);
    expect(await titles(page, true)).toEqual(settled);
    expect(await titles(b, true)).toEqual(settled);

    // Making way is not a step of its own. Each still has the one step of placing their title,
    // and undoing it takes that title away, wherever it ended up.
    expect([await steps(page), await steps(b)]).toEqual(before);
    await other.keyboard.press('Control+z');
    await expect.poll(() => titles(mover)).toEqual([`0+150 ${mine}`]);
    await mover.keyboard.press('Control+z');
    await expect.poll(() => titles(other)).toEqual([]);

    await ctxB.close();
  });

  test('what the server passed over of someone’s presence is said again once the rush is over', async ({
    page,
    browser,
  }) => {
    await canBeCutOff(page.context());
    await newProject(page);
    const meta = await page.evaluate(() => (window as any).tandem.session.getMeta());
    test.skip(!meta.online || !meta.shared, 'collaboration server not reachable');
    const link: string = await page.evaluate(() => (window as any).tandem.session.inviteLink('viewer'));
    const ctxB = await browser.newContext();
    await canBeCutOff(ctxB);
    const b = await ctxB.newPage();
    await b.goto(link);
    await b.waitForFunction(() => (window as any).tandem?.session?.getMeta().status === 'connected');
    const id: number = await page.evaluate(() => (window as any).tandem.session.awareness.clientID);
    /** Where the collaborator sees this person's playhead. */
    const seen = (): Promise<number | undefined> =>
      b.evaluate(
        (id) => (window as any).tandem.session.peers.get().find((x: any) => x.clientId === id)?.playhead,
        id,
      );
    const clock = (): Promise<number> =>
      page.evaluate(() => {
        const { awareness } = (window as any).tandem.session;
        return awareness.meta.get(awareness.clientID).clock as number;
      });

    await page.evaluate(() => (window as any).tandem.session.setPresence({ playhead: 777 }));
    await expect.poll(seen).toBe(777);

    // Two hundred updates in one go, as nothing in the editor sends them: the server relays the
    // first few and passes over the rest, so what everyone is left looking at is not the last word.
    const flooded: number = await page.evaluate(() => {
      const { awareness } = (window as any).tandem.session;
      const state = awareness.getLocalState();
      for (let i = 0; i < 200; i++) awareness.setLocalState({ ...state, playhead: 1 });
      return awareness.meta.get(awareness.clientID).clock;
    });
    await expect.poll(seen).toBe(1);

    // Told that updates were passed over, the editor says where it is once more, a second later.
    await expect.poll(seen, { timeout: 8000 }).toBe(777);
    expect(await clock()).toBe(flooded + 1);
    await page.waitForTimeout(2500);
    expect(await clock()).toBe(flooded + 1);

    await ctxB.close();
  });
});
