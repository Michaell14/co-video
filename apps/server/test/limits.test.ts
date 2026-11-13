/**
 * What a connection and a room may make the server hold and send: each limit refuses what is over
 * it, says so, and leaves everyone else as they were.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ProjectStore, makeClip, newId } from '@tandem/core';
import type { ProjectInfo, VersionInfo } from '@tandem/core';
import { SilentPeer, awarenessFrame, sleep, upgradeStatus, useServers, waitFor } from './helpers';
import type { Api, Project, TestClient } from './helpers';

const { start, connect } = useServers();

const KIB = 1024;
const MIB = 1024 * KIB;
/** WebSocket close code "message too big": what a client gets whose update is not taken. */
const TOO_BIG = 1009;

const errors = (client: TestClient): string[] =>
  client.controls.filter((message) => message.type === 'error').map((message) => message.message ?? '');

/** One string of `bytes` characters: a single struct, so only the size limit is in play. */
const blob = (bytes: number): string => 'x'.repeat(bytes);

/** What `GET /api/projects/:id` says about opening the project's documents. */
async function availability(api: Api, project: Project, token = project.token): Promise<ProjectInfo['docs']> {
  const res = await api.fetch(`/api/projects/${project.id}`, { token });
  expect(res.status).toBe(200);
  return ((await res.json()) as ProjectInfo).docs;
}

describe('document limits', () => {
  it('takes no update that would grow a document past its size limit', async () => {
    const { api } = await start({ maxProjectDocBytes: 64 * KIB });
    const project = await api.createProject();
    const owner = await connect(api, project, 'project').whenSynced();
    const peer = await connect(api, project, 'project').whenSynced();

    owner.map.set('first', blob(30 * KIB));
    await waitFor(() => peer.map.has('first'), 'first half relayed');
    // In one message or in several, what does not fit is refused as a whole and with a reason.
    owner.map.set('second', blob(40 * KIB));
    await waitFor(() => owner.closed, 'writer of the update that does not fit closed');
    expect(owner.closeCode).toBe(TOO_BIG);
    expect(errors(owner)).toEqual(['the project document has reached the size this server allows']);

    // Nobody else saw any of it, the document is as it was, and it still takes what does fit.
    peer.map.set('small', 1);
    const fresh = await connect(api, project, 'project').whenSynced();
    await waitFor(() => fresh.map.get('small') === 1, 'small edit relayed');
    expect([...fresh.map.keys()].sort()).toEqual(['first', 'small']);
    expect(peer.map.has('second')).toBe(false);
    expect(peer.closed).toBe(false);

    // Coming back with the same change gets the same answer: it is offered again in the handshake.
    const again = connect(api, project, 'project');
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(owner.doc), again);
    await waitFor(() => again.closed, 'reconnecting writer closed again');
    expect(again.closeCode).toBe(TOO_BIG);

    // The limit is on what the document holds, not on what was ever written to it.
    peer.map.delete('first');
    peer.map.set('third', blob(40 * KIB));
    await waitFor(() => fresh.map.has('third'), 'room again after a deletion');
    expect(peer.closed).toBe(false);
  });

  it('holds a document to one struct for every sixteen bytes of its limit', async () => {
    const { api } = await start({ maxProjectDocBytes: 128 * KIB });
    const project = await api.createProject();
    const peer = await connect(api, project, 'project').whenSynced();

    // 9000 entries of a few bytes each are well under 128 KiB, and over its 8192 structs.
    const dense = await connect(api, project, 'project').whenSynced();
    dense.doc.transact(() => {
      for (let i = 0; i < 9000; i++) dense.doc.getMap('m').set(i.toString(36), 0);
    });
    expect(Y.encodeStateAsUpdate(dense.doc).byteLength).toBeLessThan(110 * KIB);
    await waitFor(() => dense.closed, 'writer of many small entries closed');
    expect(dense.closeCode).toBe(TOO_BIG);
    expect(errors(dense)).toEqual(['the project document has reached the size this server allows']);
    expect(peer.doc.getMap('m').size).toBe(0);

    // One struct of text, and then a few kilobytes of deletions that would cut it into thousands.
    const cutter = await connect(api, project, 'project').whenSynced();
    cutter.doc.getText('script').insert(0, blob(60 * KIB));
    await waitFor(() => peer.doc.getText('script').length === 60 * KIB, 'text relayed');
    const before = Y.encodeStateVector(cutter.doc);
    cutter.doc.transact(() => {
      for (let i = 4999; i >= 0; i--) cutter.doc.getText('script').delete(i * 8, 1);
    });
    expect(Y.encodeStateAsUpdate(cutter.doc, before).byteLength).toBeLessThan(32 * KIB);
    await waitFor(() => cutter.closed, 'writer of the deletions closed');
    expect(cutter.closeCode).toBe(TOO_BIG);
    expect(peer.doc.getText('script').length).toBe(60 * KIB);

    // Ordinary editing of that text is cuts too, and fits.
    const editor = await connect(api, project, 'project').whenSynced();
    for (let i = 0; i < 50; i++) editor.doc.getText('script').insert(i * 100 + 7, 'y');
    editor.doc.getText('script').delete(5000, 10);
    await waitFor(() => peer.doc.getText('script').length === 60 * KIB + 40, 'edits relayed');
    expect(editor.closed).toBe(false);
  });

  it('gives the review document a limit of its own', async () => {
    const { api } = await start({ maxReviewDocBytes: 16 * KIB });
    const project = await api.createProject();
    const commenterToken = await api.invite(project, 'commenter');
    const owner = await connect(api, project, 'review').whenSynced();
    const commenter = await connect(api, project, 'review', commenterToken).whenSynced();

    commenter.map.set('comment', 'Tighten this cut');
    await waitFor(() => owner.map.get('comment') === 'Tighten this cut', 'comment relayed');
    commenter.map.set('essay', blob(20 * KIB));
    await waitFor(() => commenter.closed, 'writer of the oversized comment closed');
    expect(commenter.closeCode).toBe(TOO_BIG);
    expect(errors(commenter)).toEqual(['the review document has reached the size this server allows']);
    expect(owner.map.has('essay')).toBe(false);

    // The same bytes are nothing to the project document.
    const project1 = await connect(api, project, 'project').whenSynced();
    const project2 = await connect(api, project, 'project').whenSynced();
    project1.map.set('essay', blob(20 * KIB));
    await waitFor(() => project2.map.has('essay'), 'project document takes it');
  });

  it('does not load a stored document that is far over the limit, and stays up', async () => {
    const generous = await start();
    const project = await generous.api.createProject();
    const other = await generous.api.createProject();
    const writer = await connect(generous.api, project, 'project').whenSynced();
    writer.map.set('blob', blob(300 * KIB));
    const reviewer = await connect(generous.api, project, 'review').whenSynced();
    reviewer.map.set('comment', 'Fine');
    const stored1 = await connect(generous.api, project, 'project').whenSynced();
    const stored2 = await connect(generous.api, project, 'review').whenSynced();
    await waitFor(() => stored1.map.has('blob') && stored2.map.has('comment'), 'both documents stored');
    await generous.server.close();
    const snapshot = join(generous.dataDir, 'projects', project.id, 'project.snapshot');
    const stored = (await stat(snapshot)).size;
    expect(stored).toBeGreaterThan(300 * KIB);

    // A server set up for smaller documents finds the large one already on its disk.
    const strict = await start({ dataDir: generous.dataDir, maxProjectDocBytes: 64 * KIB });
    const viewerToken = await strict.api.invite(project, 'viewer');
    expect(await upgradeStatus(strict.api.wsUrl(project.id, 'project', project.token))).toBe(507);
    expect(await upgradeStatus(strict.api.wsUrl(project.id, 'project', viewerToken))).toBe(507);
    const version = await strict.api.json(
      `/api/projects/${project.id}/versions`,
      { name: 'v1' },
      project.token,
    );
    expect(version.status).toBe(507);
    expect(await version.json()).toEqual({ error: expect.stringMatching(/larger than this server accepts/) });

    // Everything else about the project and the server works as before.
    expect((await strict.api.fetch('/api/health')).status).toBe(200);
    expect((await strict.api.fetch(`/api/projects/${project.id}`, { token: project.token })).status).toBe(
      200,
    );
    const review = await connect(strict.api, project, 'review').whenSynced();
    expect(review.map.get('comment')).toBe('Fine');
    const elsewhere = await connect(strict.api, other, 'project').whenSynced();
    elsewhere.map.set('title', 'Unaffected');
    await review.close();
    await elsewhere.close();
    await strict.server.close();

    // Nothing was touched: with the limit raised again the document is all there.
    expect((await stat(snapshot)).size).toBe(stored);
    const restored = await start({ dataDir: generous.dataDir });
    const reader = await connect(restored.api, project, 'project').whenSynced();
    expect((reader.map.get('blob') as string).length).toBe(300 * KIB);
  });

  it('does not load a stored document with far more structs than its limit allows', async () => {
    const generous = await start();
    const project = await generous.api.createProject();
    const writer = await connect(generous.api, project, 'project').whenSynced();
    writer.doc.transact(() => {
      for (let i = 0; i < 40_000; i++) writer.doc.getMap('m').set(i.toString(36), 0);
    });
    const reader = await connect(generous.api, project, 'project').whenSynced();
    await waitFor(() => reader.doc.getMap('m').size === 40_000, 'entries stored');
    await generous.server.close();
    const stored = (await stat(join(generous.dataDir, 'projects', project.id, 'project.snapshot'))).size;

    // In bytes the document is within twice the limit; in structs, which is what it would cost
    // in memory, it is not: 256 KiB allow 16,384 of them.
    expect(stored).toBeLessThan(2 * 256 * KIB);
    const strict = await start({ dataDir: generous.dataDir, maxProjectDocBytes: 256 * KIB });
    // The size of the files gives nothing away, and nothing is read just because someone asks.
    expect(await availability(strict.api, project)).toEqual({ project: 'ok', review: 'ok' });
    expect(await upgradeStatus(strict.api.wsUrl(project.id, 'project', project.token))).toBe(507);
    expect((await strict.api.fetch('/api/health')).status).toBe(200);
    // Once a connection has made the server read them, it knows, and says so to whoever asks.
    expect(await availability(strict.api, project)).toEqual({ project: 'too-large', review: 'ok' });
    const viewerToken = await strict.api.invite(project, 'viewer');
    expect(await availability(strict.api, project, viewerToken)).toEqual({ project: 'too-large', review: 'ok' });
  });

  it('keeps all loaded documents together within one budget', async () => {
    // No document may grow past half of the budget, so it takes three to use it up.
    const { api } = await start({ maxOpenDocBytes: 100 * KIB, roomIdleMs: 50 });
    const [first, second, third] = [
      await api.createProject(),
      await api.createProject(),
      await api.createProject(),
    ];
    const a = await connect(api, first, 'project').whenSynced();
    const a2 = await connect(api, first, 'project').whenSynced();
    a.map.set('blob', blob(40 * KIB));
    await waitFor(() => a2.map.has('blob'), 'first project written');
    const b = await connect(api, second, 'project').whenSynced();
    const b2 = await connect(api, second, 'project').whenSynced();
    b.map.set('blob', blob(40 * KIB));
    await waitFor(() => b2.map.has('blob'), 'second project written');

    // The third project may be opened, but there is no room left for it to grow like the others.
    const c = await connect(api, third, 'project').whenSynced();
    c.map.set('small', 1);
    c.map.set('blob', blob(40 * KIB));
    await waitFor(() => c.closed, 'writer in the third project closed');
    expect(c.closeCode).toBe(TOO_BIG);
    expect(errors(c)).toEqual(['the server has no memory to spare for more document data']);
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);

    // Once the first project is out of memory again, the third has the room.
    await a.close();
    await a2.close();
    const retry = async (): Promise<TestClient> => {
      const client = await connect(api, third, 'project').whenSynced();
      client.map.set('blob', blob(40 * KIB));
      return client;
    };
    let writer = await retry();
    const reader = await connect(api, third, 'project').whenSynced();
    for (let attempt = 0; attempt < 50 && !reader.map.has('blob'); attempt++) {
      await sleep(50);
      if (writer.closed) writer = await retry();
    }
    expect(reader.map.has('blob')).toBe(true);
    expect(reader.map.get('small')).toBe(1);

    // And now it is the first project that has to wait: it is not even loaded.
    expect(await upgradeStatus(api.wsUrl(first.id, 'project', first.token))).toBe(503);
    expect((await api.fetch('/api/health')).status).toBe(200);
  });

  it('tells a stored document that can never fit from one that has to wait', async () => {
    const generous = await start();
    const store = async (kib: number): Promise<Project> => {
      const project = await generous.api.createProject();
      const writer = await connect(generous.api, project, 'project').whenSynced();
      writer.map.set('blob', blob(kib * KIB));
      const reader = await connect(generous.api, project, 'project').whenSynced();
      await waitFor(() => reader.map.has('blob'), 'document stored');
      return project;
    };
    const huge = await store(300);
    const large = await store(150);
    const other = await store(150);
    await generous.server.close();

    // The same data on a server that keeps 200 KiB of documents in memory, all of them together:
    // as on a machine with less memory, where the default for that is smaller.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const small = await start({ dataDir: generous.dataDir, maxOpenDocBytes: 200 * KIB, roomIdleMs: 50 });
      const url = (project: Project): string => small.api.wsUrl(project.id, 'project', project.token);

      // More than the server holds in all: trying again later would not help, and the answer
      // and the log say so, with nothing else loaded and with something else loaded. Asked over
      // HTTP, the server says the same before anyone has tried to connect.
      expect(await availability(small.api, huge)).toEqual({ project: 'too-large', review: 'ok' });
      expect(await availability(small.api, other)).toEqual({ project: 'ok', review: 'ok' });
      expect(warn).not.toHaveBeenCalled();
      expect(await upgradeStatus(url(huge))).toBe(507);
      const reader = await connect(small.api, large, 'project').whenSynced();
      expect((reader.map.get('blob') as string).length).toBe(150 * KIB);
      expect(await upgradeStatus(url(huge))).toBe(507);
      expect(await availability(small.api, huge)).toEqual({ project: 'too-large', review: 'ok' });
      expect(await availability(small.api, large)).toEqual({ project: 'ok', review: 'ok' });
      const logged = warn.mock.calls.map((call) => String(call[0]));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(`not loading the project document of project ${huge.id}`);
      expect(logged[0]).toMatch(/project\.snapshot holds \d+ bytes, and at most 204800 are loaded/);
      expect(logged[0]).toMatch(
        /MAX_PROJECT_DOC_BYTES, and at most 1\/2 of MAX_OPEN_DOC_BYTES, which is 204800/,
      );

      // Within what the server holds, but not next to what is loaded right now: that does pass.
      expect(await availability(small.api, other)).toEqual({ project: 'busy', review: 'ok' });
      expect(await upgradeStatus(url(other))).toBe(503);
      expect(warn.mock.calls.map((call) => String(call[0]))[1]).toMatch(/not loading another document/);
      await reader.close();
      let status = 503;
      for (let attempt = 0; attempt < 50 && status === 503; attempt++) {
        await sleep(50);
        status = await upgradeStatus(url(other)).catch(() => 101);
      }
      expect(status).toBe(101);
      expect(await availability(small.api, other)).toEqual({ project: 'ok', review: 'ok' });
      expect((await small.api.fetch('/api/health')).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });

  it('gives back what rooms and connections held once they are gone', async () => {
    // Room for three documents of 60 KiB and for one copy of one on its way to a client. Whatever
    // a room or a connection kept on the books after it had gone would be missing a round later.
    const { api } = await start({
      maxOpenDocBytes: 200 * KIB,
      maxSyncBacklogBytes: 100 * KIB,
      roomIdleMs: 20,
    });
    const projects = [await api.createProject(), await api.createProject(), await api.createProject()];
    for (const project of projects) {
      const writer = await connect(api, project, 'project').whenSynced();
      writer.map.set('blob', blob(60 * KIB));
      const reader = await connect(api, project, 'project').whenSynced();
      await waitFor(() => reader.map.has('blob'), 'document written');
      await writer.close();
      await reader.close();
    }
    for (let round = 0; round < 10; round++) {
      await Promise.all(
        projects.map(async (project, i) => {
          // Someone reads the document, someone is turned away with too large a change, and they
          // leave in every way there is: politely, cut off, or closed by the server.
          const reader = await connect(api, project, 'project').whenSynced();
          expect((reader.map.get('blob') as string).length).toBe(60 * KIB);
          const greedy = await connect(api, project, 'project').whenSynced();
          greedy.map.set('more', blob(150 * KIB));
          await waitFor(() => greedy.closed, 'oversized change refused');
          const leaving = connect(api, project, 'project');
          await leaving.whenOpen();
          leaving.drop();
          if ((round + i) % 2) reader.drop();
          else await reader.close();
        }),
      );
      await sleep(80);
    }
    const readers = await Promise.all(
      projects.map((project) => connect(api, project, 'project').whenSynced()),
    );
    for (const reader of readers) expect([...reader.map.keys()]).toEqual(['blob']);
  });

  it('carries a large project, many peers with cursors and a reconnect on default limits', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const author = await connect(api, project, 'project').whenSynced();

    // Two thousand clips, published in one go as when a local project is shared, then edited.
    const local = new Y.Doc();
    const store = new ProjectStore(local);
    store.initIfEmpty();
    const track = Object.values(store.get().tracks)[0];
    const ids: string[] = [];
    for (let i = 0; i < 2000; i += 100) {
      store.commit(
        Array.from({ length: 100 }, (_, j) => {
          const id = newId();
          ids.push(id);
          return {
            op: 'addClip' as const,
            clip: makeClip('video', track.id, {
              id,
              start: (i + j) * 60,
              duration: 60,
              name: `Clip ${i + j}`,
            }),
          };
        }),
      );
    }
    Y.applyUpdate(author.doc, Y.encodeStateAsUpdate(local));

    const tokens = [await api.invite(project, 'editor'), await api.invite(project, 'viewer')];
    const peers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => connect(api, project, 'project', tokens[i % 2]).whenSynced()),
    );
    const clips = (client: TestClient): number => client.doc.getMap('clips').size;
    await waitFor(() => peers.every((peer) => clips(peer) === 2000), 'project at every peer', 15_000);

    // Everyone moves a cursor while the author keeps editing, with a selection of every clip.
    const editing = new ProjectStore(author.doc);
    for (let round = 0; round < 25; round++) {
      peers.forEach((peer, i) =>
        peer.awareness.setLocalState({
          user: { name: `Peer ${i}` },
          cursor: { x: round, y: i },
          selection: ids,
        }),
      );
      editing.commit([{ op: 'updateClip', id: ids[round * 31], patch: { start: round * 3, opacity: 0.5 } }]);
      await sleep(20);
    }
    const everyoneSeesEveryone = (): boolean =>
      peers.every((peer) => peers.every((other) => peer.awareness.getStates().has(other.doc.clientID)));
    await waitFor(everyoneSeesEveryone, 'cursors of all peers', 15_000);
    const lastCursor = (peer: TestClient): unknown =>
      peer.awareness.getStates().get(peers[7].doc.clientID)?.cursor;
    await waitFor(
      () => peers.slice(0, 7).every((peer) => (lastCursor(peer) as { x: number })?.x === 24),
      'last cursor',
    );

    // One peer loses its connection and comes back with everything it has, as a reconnect does.
    const lost = peers[0];
    lost.drop();
    const back = connect(api, project, 'project', tokens[0]);
    Y.applyUpdate(back.doc, Y.encodeStateAsUpdate(lost.doc), back);
    await back.whenSynced();
    editing.commit([{ op: 'updateClip', id: ids[0], patch: { name: 'After the reconnect' } }]);
    const name = (client: TestClient): unknown => new ProjectStore(client.doc).get().clips[ids[0]]?.name;
    await waitFor(() => name(back) === 'After the reconnect', 'edit at the reconnected peer');

    for (const client of [author, back, ...peers.slice(1)]) {
      expect(client.closed).toBe(false);
      expect(errors(client)).toEqual([]);
      expect(client.hasControl('readonly')).toBe(false);
    }
    editing.destroy();
    store.destroy();
  });
});

describe('sync answers', () => {
  /** A project whose document is too large to disappear into the socket buffers of the machine. */
  async function largeProject(options: Parameters<typeof start>[0] = {}) {
    const { api } = await start({ maxOpenDocBytes: 256 * MIB, ...options });
    const project = await api.createProject();
    const viewerToken = await api.invite(project, 'viewer');
    const owner = await connect(api, project, 'project').whenSynced();
    owner.map.set('blob', blob(24 * MIB));
    const reader = await connect(api, project, 'project', viewerToken).whenSynced();
    await waitFor(() => reader.map.has('blob'), 'large document stored', 15_000);
    await owner.close();
    await reader.close();
    return { api, project, viewerToken };
  }

  it('sends a client that does not read one copy of the document, however often it asks', async () => {
    const { api, project, viewerToken } = await largeProject();
    const greedy = connect(api, project, 'project', viewerToken);
    await greedy.whenOpen();
    greedy.stall();
    for (let i = 0; i < 40; i++) greedy.requestSync();
    // Time for the server to answer every one of them, if it were going to.
    await sleep(1500);
    expect(greedy.closed).toBe(false);

    greedy.resume();
    // The request that opened the connection, and the latest of those that came while its
    // answer was on the way.
    await waitFor(() => greedy.answers === 2, 'both copies arrive', 15_000);
    await sleep(1000);
    expect(greedy.answers).toBe(2);
    expect(greedy.closed).toBe(false);
  });

  it('keeps the copies on their way to clients within one budget, first come first served', async () => {
    const { api, project, viewerToken } = await largeProject({ maxSyncBacklogBytes: 32 * MIB });
    const stalled = connect(api, project, 'project', viewerToken);
    await stalled.whenOpen();
    stalled.stall();
    await sleep(300);

    // One copy is queued for a client that does not read. The next client waits for its turn…
    const waiting = connect(api, project, 'project', viewerToken);
    await waiting.whenOpen();
    await sleep(700);
    expect(waiting.synced).toBe(false);
    expect(waiting.closed).toBe(false);
    // …while it is otherwise a member like any other.
    const elsewhere = await connect(api, await api.createProject(), 'project').whenSynced();
    expect(elsewhere.synced).toBe(true);

    // …and gets it as soon as the first copy is out of the way.
    stalled.drop();
    await waitFor(() => waiting.synced, 'the next in line is served', 15_000);
    expect((waiting.map.get('blob') as string).length).toBe(24 * MIB);
  });
});

describe('presence limits', () => {
  it('relays one entry per connection and ignores the rest with a reason', async () => {
    const { api } = await start({ maxPresenceBytes: 4 * KIB });
    const project = await api.createProject();
    const viewerToken = await api.invite(project, 'viewer');
    const owner = await connect(api, project, 'project').whenSynced();
    owner.awareness.setLocalState({ user: { name: 'Ada' } });
    const viewer = await connect(api, project, 'project', viewerToken).whenSynced();
    const id = viewer.doc.clientID;
    const present = (client: TestClient): number[] => [...client.awareness.getStates().keys()].sort();
    const everyone = [owner.doc.clientID, id].sort();

    viewer.awareness.setLocalState({ user: { name: 'Vera' } });
    await waitFor(() => owner.awareness.getStates().has(id), 'viewer visible');

    // Made-up participants.
    viewer.send(
      awarenessFrame(Array.from({ length: 50 }, (_, i) => ({ clientId: 9000 + i, clock: 1, state: '{}' }))),
    );
    await waitFor(() => errors(viewer).length === 1, 'notice about more than one entry');
    expect(errors(viewer)[0]).toBe('presence update ignored: a connection can announce one presence entry');

    // Someone else's entry: rewritten, or declared gone.
    await sleep(1100); // notices of one kind come at most once a second
    viewer.send(
      awarenessFrame([{ clientId: owner.doc.clientID, clock: 99, state: '{"user":{"name":"Not Ada"}}' }]),
    );
    await waitFor(() => errors(viewer).length === 2, 'notice about the entry of another participant');
    expect(errors(viewer)[1]).toBe('presence update ignored: the entry belongs to another participant');
    viewer.send(awarenessFrame([{ clientId: owner.doc.clientID, clock: 99, state: 'null' }]));

    // More entries than the room has places, and ids nobody has seen, by the thousand.
    await sleep(1100);
    viewer.send(
      awarenessFrame(
        Array.from({ length: 101 }, (_, i) => ({ clientId: 5000 + i, clock: 1, state: 'null' })),
      ),
    );
    await waitFor(() => errors(viewer).length === 3, 'notice about too many entries');
    expect(errors(viewer)[2]).toBe('presence update ignored: it lists more than 100 entries');
    for (let frame = 0; frame < 5; frame++) {
      viewer.send(
        awarenessFrame(
          Array.from({ length: 100 }, (_, i) => ({
            clientId: 70_000 + frame * 100 + i,
            clock: 1,
            state: 'null',
          })),
        ),
      );
    }

    // A state that is too large.
    await sleep(1100);
    viewer.send(awarenessFrame([{ clientId: id, clock: 50, state: JSON.stringify({ pad: blob(5 * KIB) }) }]));
    await waitFor(() => errors(viewer).length === 4, 'notice about the size');
    expect(errors(viewer)[3]).toBe('presence update ignored: it is larger than 4096 bytes');

    // None of it reached anyone, none of it cost the connection, and the viewer's own entry
    // still follows what it says.
    viewer.send(
      awarenessFrame([{ clientId: id, clock: 51, state: '{"user":{"name":"Vera"},"playhead":7}' }]),
    );
    await waitFor(() => owner.awareness.getStates().get(id)?.playhead === 7, 'own entry still relayed');
    expect(present(owner)).toEqual(everyone);
    expect(owner.awareness.getStates().get(owner.doc.clientID)).toEqual({ user: { name: 'Ada' } });
    const joiner = await connect(api, project, 'project').whenSynced();
    await waitFor(() => present(joiner).length === 2, 'joiner sees who is there');
    expect(present(joiner)).toEqual(everyone);
    expect(joiner.awareness.getStates().get(owner.doc.clientID)).toEqual({
      user: { name: 'Ada' },
      role: 'owner',
    });
    expect(viewer.closed).toBe(false);

    // The owner is still there when the viewer leaves.
    await viewer.close();
    await waitFor(() => !joiner.awareness.getStates().has(id), 'viewer gone');
    expect(present(joiner)).toEqual([owner.doc.clientID]);
  });

  it('skips presence updates that come faster than a client sends them, and keeps the connection', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const viewerToken = await api.invite(project, 'viewer');
    const owner = await connect(api, project, 'project').whenSynced();
    const viewer = await connect(api, project, 'project', viewerToken).whenSynced();
    const id = viewer.doc.clientID;

    for (let clock = 1; clock <= 200; clock++) {
      viewer.send(awarenessFrame([{ clientId: id, clock, state: `{"n":${clock}}` }]));
    }
    await waitFor(() => errors(viewer).length > 0, 'notice about the pace');
    expect(errors(viewer)).toEqual([
      'presence update ignored: updates are arriving faster than they are relayed',
    ]);
    // Forty at once is what a connection may send; the owner is told of those and few more.
    await sleep(200);
    expect(owner.presenceMessages).toBeGreaterThanOrEqual(40);
    expect(owner.presenceMessages).toBeLessThan(60);

    // The document is not held up by any of it.
    owner.map.set('title', 'Still in sync');
    await waitFor(() => viewer.map.get('title') === 'Still in sync', 'document update at the viewer');
    expect(viewer.closed).toBe(false);
    await sleep(1100);
    viewer.send(awarenessFrame([{ clientId: id, clock: 500, state: '{"n":500}' }]));
    await waitFor(() => owner.awareness.getStates().get(id)?.n === 500, 'presence relayed again');
  });

  it('holds the sockets of one link to what one link may show, and sends the document first', async () => {
    const { api } = await start({ maxPresenceBytes: 8 * KIB });
    const project = await api.createProject();
    const viewerToken = await api.invite(project, 'viewer');
    const editorToken = await api.invite(project, 'editor');
    const owner = await connect(api, project, 'project').whenSynced();
    owner.awareness.setLocalState({ user: { name: 'Ada' } });
    owner.map.set('title', 'Rough cut');

    // One viewer link on twelve sockets, each of them within what a connection may send.
    const pad = blob(3 * KIB);
    const sockets = await Promise.all(
      Array.from({ length: 12 }, () => connect(api, project, 'project', viewerToken).whenSynced()),
    );
    for (const socket of sockets) socket.awareness.setLocalState({ user: { name: 'Vera' }, pad });
    const refused = (): TestClient[] => sockets.filter((socket) => errors(socket).length > 0);
    await waitFor(() => refused().length === 10, 'ten of the twelve told that they are not shown');
    for (const socket of refused()) {
      expect(errors(socket)).toEqual([
        'presence update ignored: the connections made with this link already show as much as one link may, 8192 bytes',
      ]);
    }
    const shownTo = (client: TestClient): number =>
      sockets.filter((socket) => client.awareness.getStates().has(socket.doc.clientID)).length;
    await waitFor(() => shownTo(owner) === 2, 'the two that fit shown to the owner');
    // Saying it again changes nothing, and costs none of them the connection.
    await sleep(1100);
    for (const socket of sockets) socket.awareness.setLocalState({ user: { name: 'Vera' }, pad, again: 1 });
    await waitFor(() => refused().every((socket) => errors(socket).length === 2), 'told again');
    expect(shownTo(owner)).toBe(2);
    expect(sockets.every((socket) => !socket.closed)).toBe(true);

    // Whoever has another link is shown as before.
    const editor = await connect(api, project, 'project', editorToken).whenSynced();
    editor.awareness.setLocalState({ user: { name: 'Ed' }, pad });
    await waitFor(() => owner.awareness.getStates().has(editor.doc.clientID), 'editor shown to the owner');

    // Someone who joins gets the document, and then in one message everyone who is shown.
    const joiner = await connect(api, project, 'project', editorToken).whenSynced();
    await waitFor(() => joiner.awareness.getStates().size === 4, 'joiner told who is here');
    expect(joiner.presenceBeforeSync).toBe(0);
    expect(joiner.presenceMessages).toBe(1);
    expect(joiner.map.get('title')).toBe('Rough cut');
    expect(shownTo(joiner)).toBe(2);

    // When one of the two leaves, there is room for one of the others.
    const shown = sockets.find((socket) => owner.awareness.getStates().has(socket.doc.clientID));
    const waiting = refused()[0];
    await shown?.close();
    await sleep(1100);
    waiting.awareness.setLocalState({ user: { name: 'Vera' }, pad, again: 2 });
    await waitFor(() => owner.awareness.getStates().has(waiting.doc.clientID), 'room for another');
  });

  it('says nothing about presence to a client that has not been sent the document', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const owner = await connect(api, project, 'project').whenSynced();
    owner.awareness.setLocalState({ user: { name: 'Ada before' } });
    const earlier = await connect(api, project, 'project').whenSynced();
    await waitFor(() => earlier.awareness.getStates().has(owner.doc.clientID), 'owner shown');

    // Connected and greeted, and never asking for the document.
    const silent = new SilentPeer(api.wsUrl(project.id, 'project', project.token), []);
    try {
      await waitFor(() => silent.heard('hello'), 'silent peer greeted');
      owner.awareness.setLocalState({ user: { name: 'Ada after' } });
      await waitFor(
        () => earlier.awareness.getStates().get(owner.doc.clientID)?.user?.name === 'Ada after',
        'change relayed to a member who has the document',
      );
      await sleep(200);
      expect(silent.heard('Ada before')).toBe(false);
      expect(silent.heard('Ada after')).toBe(false);
    } finally {
      silent.destroy();
    }
  });

  it('keeps a presence id for the link of someone who dropped out', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const editorToken = await api.invite(project, 'editor');
    const viewerToken = await api.invite(project, 'viewer');
    const observer = await connect(api, project, 'project').whenSynced();
    const viewer = await connect(api, project, 'project', viewerToken).whenSynced();
    const editor = await connect(api, project, 'project', editorToken).whenSynced();
    editor.send(awarenessFrame([{ clientId: 4242, clock: 1, state: '{"user":{"name":"Ed"}}' }]));
    await waitFor(() => viewer.awareness.getStates().has(4242), 'editor shown');

    // The editor's connection is cut. The viewer hears that entry 4242 is gone and asks for it.
    editor.drop();
    await waitFor(() => !viewer.awareness.getStates().has(4242), 'editor gone');
    viewer.send(awarenessFrame([{ clientId: 4242, clock: 1000, state: '{"user":{"name":"Not Ed"}}' }]));
    await waitFor(() => errors(viewer).length === 1, 'viewer refused');
    expect(errors(viewer)).toEqual(['presence update ignored: the entry belongs to another participant']);
    expect(observer.awareness.getStates().has(4242)).toBe(false);

    // The editor's tab reconnects under the id it has always had, and is shown again.
    const back = await connect(api, project, 'project', editorToken).whenSynced();
    back.send(awarenessFrame([{ clientId: 4242, clock: 2, state: '{"user":{"name":"Ed"}}' }]));
    await waitFor(() => observer.awareness.getStates().has(4242), 'editor shown again');
    expect(observer.awareness.getStates().get(4242)).toEqual({ user: { name: 'Ed' }, role: 'editor' });
    expect(errors(back)).toEqual([]);
  });

  it('hands presence over to the same link reconnecting, while its old socket lingers', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const editorToken = await api.invite(project, 'editor');
    const observer = await connect(api, project, 'project').whenSynced();

    // A tab whose connection died without a word: the server has no way to know yet.
    const ghost = new SilentPeer(api.wsUrl(project.id, 'project', editorToken), [
      awarenessFrame([{ clientId: 4242, clock: 3, state: '{"user":{"name":"Ed"},"playhead":1}' }]),
    ]);
    try {
      await waitFor(
        () => observer.awareness.getStates().get(4242)?.playhead === 1,
        'first connection visible',
      );

      // The same tab, reconnected: same link, same id, and its presence follows it at once.
      const back = await connect(api, project, 'project', editorToken).whenSynced();
      back.send(awarenessFrame([{ clientId: 4242, clock: 4, state: '{"user":{"name":"Ed"},"playhead":2}' }]));
      await waitFor(() => observer.awareness.getStates().get(4242)?.playhead === 2, 'presence handed over');

      // When the old socket finally goes, it takes nothing with it.
      ghost.destroy();
      await sleep(300);
      expect(observer.awareness.getStates().get(4242)).toEqual({
        user: { name: 'Ed' },
        playhead: 2,
        role: 'editor',
      });
      await back.close();
      await waitFor(() => !observer.awareness.getStates().has(4242), 'gone with the connection that held it');
    } finally {
      ghost.destroy();
    }
  });

  it('sends a member who is behind the latest presence once, not every update in between', async () => {
    const { api } = await start({ maxOpenDocBytes: 256 * MIB });
    const project = await api.createProject();
    const viewerToken = await api.invite(project, 'viewer');
    const owner = await connect(api, project, 'project').whenSynced();
    owner.map.set('blob', blob(24 * MIB));
    const prompt = await connect(api, project, 'project', viewerToken).whenSynced();
    await waitFor(() => prompt.map.has('blob'), 'large document stored', 15_000);

    // An editor on a slow link: the document is still on its way to them…
    const slow = connect(api, project, 'project');
    await slow.whenOpen();
    slow.stall();
    await sleep(300);
    const before = { slow: slow.presenceMessages, prompt: prompt.presenceMessages };

    // …while a viewer's cursor moves and moves.
    const viewer = await connect(api, project, 'project', viewerToken).whenSynced();
    const id = viewer.doc.clientID;
    for (let n = 1; n <= 30; n++) {
      viewer.send(awarenessFrame([{ clientId: id, clock: n, state: `{"n":${n}}` }]));
      await sleep(10);
    }
    await waitFor(
      () => prompt.awareness.getStates().get(id)?.n === 30,
      'a member who keeps up sees every move',
    );
    expect(prompt.presenceMessages - before.prompt).toBe(30);

    // The slow member is not cut off, and catches up on presence with a single message.
    slow.resume();
    await waitFor(
      () => slow.awareness.getStates().get(id)?.n === 30,
      'latest presence at the slow member',
      15_000,
    );
    expect(slow.presenceMessages - before.slow).toBe(1);
    expect(slow.closed).toBe(false);
    expect((slow.map.get('blob') as string).length).toBe(24 * MIB);
  });
});

describe('message size', () => {
  it('reads no message from a connection that is larger than its role has use for', async () => {
    const { api } = await start({
      maxProjectDocBytes: 4 * MIB,
      maxReviewDocBytes: 2 * MIB,
      maxOpenDocBytes: 64 * MIB,
    });
    const project = await api.createProject();
    const viewerToken = await api.invite(project, 'viewer');
    const commenterToken = await api.invite(project, 'commenter');
    const big = (bytes: number): Uint8Array => {
      const frame = new Uint8Array(bytes);
      frame[0] = 9; // a message type the server does not know and would ignore
      return frame;
    };

    // A megabyte is enough to ask for the document and to say where one's cursor is.
    const viewer = await connect(api, project, 'project', viewerToken).whenSynced();
    viewer.send(big(MIB));
    viewer.send(big(MIB + 64));
    await waitFor(() => viewer.closed, 'viewer closed');
    expect(viewer.closeCode).toBe(TOO_BIG);

    // A commenter reads the project document and writes the review document.
    const commenterProject = await connect(api, project, 'project', commenterToken).whenSynced();
    commenterProject.send(big(MIB + 64));
    await waitFor(() => commenterProject.closed, 'commenter closed in the project room');
    const commenterReview = await connect(api, project, 'review', commenterToken).whenSynced();
    commenterReview.send(big(2 * MIB));
    commenterReview.send(big(2 * MIB + 64));
    await waitFor(() => commenterReview.closed, 'commenter closed in the review room');
    expect(commenterReview.closeCode).toBe(TOO_BIG);

    // Whoever writes the project document may send as much as it may hold.
    const owner = await connect(api, project, 'project').whenSynced();
    owner.send(big(4 * MIB));
    owner.map.set('title', 'Still here');
    const reader = await connect(api, project, 'project', viewerToken).whenSynced();
    await waitFor(() => reader.map.get('title') === 'Still here', 'owner still connected');
    owner.send(big(4 * MIB + 64));
    await waitFor(() => owner.closed, 'owner closed');
    expect(owner.closeCode).toBe(TOO_BIG);
  });

  it('closes a connection whose message is shorter than it says', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const peer = await connect(api, project, 'project').whenSynced();
    // An update, a request for the document and a presence update, each announcing more bytes
    // than follow.
    for (const frame of [
      [0, 2, 200, 1, 0, 0],
      [0, 0, 100, 1],
      [1, 120, 1, 7, 1, 2, 123, 125],
    ]) {
      const sender = await connect(api, project, 'project').whenSynced();
      sender.send(Uint8Array.from(frame));
      await waitFor(() => sender.closed, 'sender closed');
      expect(sender.closeCode).toBe(1007);
      expect(errors(sender)).toEqual(['malformed message']);
    }
    expect(peer.closed).toBe(false);
    expect(peer.map.size).toBe(0);
  });
});

describe('versions', () => {
  it('still takes versions of a document that is full', async () => {
    const { api } = await start({ maxProjectDocBytes: 64 * KIB });
    const project = await api.createProject();
    const owner = await connect(api, project, 'project').whenSynced();
    owner.map.set('blob', blob(60 * KIB));
    const peer = await connect(api, project, 'project').whenSynced();
    await waitFor(() => peer.map.has('blob'), 'document stored');
    const res = await api.json(`/api/projects/${project.id}/versions`, { name: 'Full' }, project.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as VersionInfo).name).toBe('Full');
  });
});
