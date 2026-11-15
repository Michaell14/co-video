/** What the server deletes: projects, versions, and media that nothing refers to any more. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { ClientRequest } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  ASSET_DEFAULTS,
  PROJECT_DELETED,
  ProjectStore as ProjectDocument,
  WS_CLOSE_PROJECT_DELETED,
  WS_MSG_SYNC,
} from '@tandem/core';
import type { Asset, Role, VersionInfo } from '@tandem/core';
import { assetIdsOf, watchAssets } from '../src/references';
import { DELETES_PER_HOUR } from '../src/server';
import { SilentPeer, sleep, tempDir, upgradeStatus, useServers, waitFor } from './helpers';
import type { Api, Project } from './helpers';

const { clients, start, connect } = useServers();

const HOUR = 60 * 60 * 1000;

/** Every file and empty directory under `dir`, as paths relative to it, sorted. */
async function tree(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (!entry.isDirectory()) found.push(path);
    else {
      const inside = await tree(join(dir, entry.name), `${path}/`);
      found.push(...(inside.length ? inside : [`${path}/`]));
    }
  }
  return found.sort();
}

const remove = (api: Api, path: string, token?: string): Promise<Response> =>
  api.fetch(path, { method: 'DELETE', token });

function upload(api: Api, project: Project, assetId: string, bytes: Uint8Array): Promise<Response> {
  return api.fetch(`/api/projects/${project.id}/media/${assetId}`, {
    method: 'PUT',
    token: project.token,
    headers: { 'Upload-Offset': '0', 'Upload-Length': String(bytes.length), 'Content-Type': 'video/mp4' },
    body: bytes,
  });
}

/** An upload that sends `sent` of `total` bytes and then waits, and a promise for its end. */
function stalledUpload(
  api: Api,
  project: Project,
  assetId: string,
  sent: number,
  total: number,
): { request: ClientRequest; ended: Promise<void> } {
  const url = new URL(api.base);
  const request = httpRequest({
    host: url.hostname,
    port: url.port,
    path: `/api/projects/${project.id}/media/${assetId}`,
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${project.token}`,
      'Upload-Offset': '0',
      'Upload-Length': String(total),
      'Content-Length': String(total),
    },
  });
  const ended = new Promise<void>((resolve) => {
    request.on('error', () => resolve());
    request.on('close', () => resolve());
  });
  request.write(Buffer.alloc(sent, 1));
  return { request, ended };
}

async function saveVersion(api: Api, project: Project, name: string): Promise<VersionInfo> {
  const res = await api.json(`/api/projects/${project.id}/versions`, { name }, project.token);
  expect(res.status).toBe(200);
  return (await res.json()) as VersionInfo;
}

const listVersions = async (api: Api, project: Project): Promise<string[]> =>
  (
    (await (
      await api.fetch(`/api/projects/${project.id}/versions`, { token: project.token })
    ).json()) as VersionInfo[]
  )
    .map((version) => version.name)
    .sort();

/** A document update as a client sends it. */
function updateFrame(change: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  change(doc);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MSG_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(encoder);
}

/** What the server logged as an error while a test ran: a request it failed at, a write that went wrong. */
let logged: unknown[][];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('deleting a project', () => {
  it('removes every file of it, answers every later request with 410 and keeps nothing but its id', async () => {
    const { api, dataDir } = await start();
    const project = await api.createProject('Doomed');
    const other = await api.createProject('Bystander');
    const editor = await api.invite(project, 'editor');

    const writer = await connect(api, project, 'project').whenSynced();
    writer.map.set('clip', 'a');
    const reviewer = await connect(api, project, 'review').whenSynced();
    reviewer.map.set('comment', 'Nice');
    expect((await upload(api, project, 'asset_one', Buffer.alloc(5000, 3))).status).toBe(204);
    await saveVersion(api, project, 'Rough cut');
    const dir = join(dataDir, 'projects', project.id);
    await waitFor(() => existsSync(join(dir, 'review.log')), 'documents on disk');
    expect(await tree(dir)).toEqual(
      expect.arrayContaining(['meta.json', 'media/asset_one', 'media/asset_one.json', 'versions.json']),
    );

    const deleted = await remove(api, `/api/projects/${project.id}`, project.token);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');

    // The directory is gone, with everything in it. What is left is the id, and when it went.
    expect(await tree(dataDir)).toEqual(
      [`deleted/${project.id}`, `projects/${other.id}/meta.json`, 'secret'].sort(),
    );
    expect(JSON.parse(await readFile(join(dataDir, 'deleted', project.id), 'utf8'))).toEqual({
      deletedAt: expect.any(Number),
    });

    // Whoever comes back with a link is told what happened, whatever they ask for.
    const base = `/api/projects/${project.id}`;
    for (const token of [project.token, editor]) {
      const asked = [
        await api.fetch(base, { token }),
        await api.fetch(`${base}/versions`, { token }),
        await api.json(`${base}/versions`, { name: 'Again' }, token),
        await api.json(`${base}/invites`, { role: 'viewer' }, token),
        await api.fetch(`${base}/media/asset_one`, { token }),
        await api.fetch(`${base}/media/asset_one?probe`, { method: 'HEAD', token }),
        await upload(api, { id: project.id, token }, 'asset_two', Buffer.alloc(10)),
        await remove(api, `${base}/media/asset_one`, token),
      ];
      expect(asked.map((res) => res.status)).toEqual(asked.map(() => 410));
      expect(await asked[0].json()).toEqual({ error: PROJECT_DELETED });
      expect(await upgradeStatus(api.wsUrl(project.id, 'project', token))).toBe(410);
      expect(await upgradeStatus(api.wsUrl(project.id, 'review', token))).toBe(410);
    }
    // Still 401 for everybody else: the answer does not reveal which ids there ever were.
    expect((await api.fetch(base, { token: 'garbage' })).status).toBe(401);
    expect((await api.fetch(base, { token: other.token })).status).toBe(401);

    // A second request is as good as the first for the owner, and news to nobody else.
    expect((await remove(api, base, project.token)).status).toBe(204);
    expect((await remove(api, base, editor)).status).toBe(410);
    expect(existsSync(dir)).toBe(false);
    expect((await api.fetch(`/api/projects/${other.id}`, { token: other.token })).status).toBe(200);
    expect(logged).toEqual([]);
  });

  it('is the owner’s alone: every other role and a stranger are refused, and nothing changes', async () => {
    const { api, dataDir } = await start();
    const project = await api.createProject();
    const stranger = await api.createProject();
    const client = await connect(api, project, 'project').whenSynced();
    client.map.set('kept', true);
    expect((await upload(api, project, 'asset_one', Buffer.alloc(100, 1))).status).toBe(204);
    await saveVersion(api, project, 'Kept');
    const dir = join(dataDir, 'projects', project.id);
    await waitFor(() => existsSync(join(dir, 'project.log')), 'document on disk');
    const before = await tree(dir);

    const path = `/api/projects/${project.id}`;
    for (const role of ['editor', 'commenter', 'viewer'] satisfies Role[]) {
      const res = await remove(api, path, await api.invite(project, role));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: `role "${role}" cannot delete the project` });
    }
    expect((await remove(api, path, stranger.token)).status).toBe(401);
    expect((await remove(api, path)).status).toBe(401);
    expect((await remove(api, path, 'garbage')).status).toBe(401);
    expect((await remove(api, '/api/projects/bad!id', project.token)).status).toBe(400);

    expect(await tree(dir)).toEqual(before);
    expect(existsSync(join(dataDir, 'deleted'))).toBe(false);
    expect(client.closed).toBe(false);
    expect((await api.fetch(path, { token: project.token })).status).toBe(200);
    expect(await listVersions(api, project)).toEqual(['Kept']);
    // The project the stranger does own is theirs to delete.
    expect((await remove(api, `/api/projects/${stranger.id}`, stranger.token)).status).toBe(204);
    expect(logged).toEqual([]);
  });

  it('tells everyone connected why, closes their sockets, and takes nothing from them afterwards', async () => {
    const { api, dataDir } = await start();
    const project = await api.createProject();
    const viewer = await api.invite(project, 'viewer');
    const owner = await connect(api, project, 'project').whenSynced();
    const guest = await connect(api, project, 'project', viewer).whenSynced();
    const reviewer = await connect(api, project, 'review').whenSynced();
    owner.map.set('clip', 'a');
    // One that neither reads nor answers a close: its socket stays open on the server for a while.
    const deaf = new SilentPeer(api.wsUrl(project.id, 'project', project.token), []);
    try {
      await waitFor(() => deaf.joined && deaf.heard('hello'), 'the silent peer joined');

      expect((await remove(api, `/api/projects/${project.id}`, project.token)).status).toBe(204);
      for (const client of [owner, guest, reviewer]) {
        await waitFor(() => client.closed, 'socket closed');
        expect(client.closeCode).toBe(WS_CLOSE_PROJECT_DELETED);
        expect(client.controls).toContainEqual({ type: 'error', message: PROJECT_DELETED });
      }
      await waitFor(() => deaf.heard(PROJECT_DELETED), 'the silent peer was told');

      // What still arrives on a connection that has not gone yet is not taken, and makes no file.
      deaf.send(updateFrame((doc) => doc.getMap('test').set('late', 'edit')));
      deaf.send(updateFrame((doc) => doc.getMap('assets').set('asset_late', new Y.Map())));
      await sleep(400);
      expect(existsSync(join(dataDir, 'projects', project.id))).toBe(false);
      expect(await tree(dataDir)).toEqual([`deleted/${project.id}`, 'projects/', 'secret']);
      expect(logged).toEqual([]);
    } finally {
      deaf.destroy();
    }
  });

  it('cuts off an upload that is in flight, which then cannot bring the directory back', async () => {
    const { api, dataDir } = await start();
    const project = await api.createProject();
    const dir = join(dataDir, 'projects', project.id);
    const { request, ended } = stalledUpload(api, project, 'asset_inflight', 30_000, 100_000);
    const part = join(dir, 'media', 'asset_inflight.part');
    await waitFor(() => existsSync(part), 'upload under way');
    for (let i = 0; i < 300 && (await stat(part)).size < 30_000; i++) await sleep(10);

    expect((await remove(api, `/api/projects/${project.id}`, project.token)).status).toBe(204);
    expect(existsSync(dir)).toBe(false);
    await ended;
    request.destroy();
    // The client tries again, as it does after any interruption, and is told.
    expect((await upload(api, project, 'asset_inflight', Buffer.alloc(100))).status).toBe(410);
    await sleep(200);
    expect(await tree(dataDir)).toEqual([`deleted/${project.id}`, 'projects/', 'secret']);
    expect(logged).toEqual([]);
  });

  it('cuts off a download that is under way', async () => {
    const { api, dataDir } = await start();
    const project = await api.createProject();
    const size = 24 * 1024 * 1024;
    expect((await upload(api, project, 'asset_large', Buffer.alloc(size, 9))).status).toBe(204);

    // Someone is downloading the file, slowly: the answer has begun and most of it is still to come.
    const url = new URL(api.base);
    const received = await new Promise<{ declared: number; got: Promise<number> }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `/api/projects/${project.id}/media/asset_large`,
          headers: { Authorization: `Bearer ${project.token}` },
        },
        (res) => {
          res.pause();
          let bytes = 0;
          res.on('data', (chunk: Buffer) => (bytes += chunk.length));
          const got = new Promise<number>((done) => {
            res.on('error', () => done(bytes));
            res.on('close', () => done(bytes));
          });
          resolve({ declared: Number(res.headers['content-length']), got });
          // Read on only once the project is gone.
          setTimeout(() => res.resume(), 500);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(received.declared).toBe(size);

    const started = Date.now();
    expect((await remove(api, `/api/projects/${project.id}`, project.token)).status).toBe(204);
    // The deletion does not wait for the download to end, and the download does not get to.
    expect(Date.now() - started).toBeLessThan(400);
    expect(existsSync(join(dataDir, 'projects', project.id))).toBe(false);
    expect(await received.got).toBeLessThan(size);
    expect(logged).toEqual([]);
  });

  it('stays consistent when writes of every kind race it', async () => {
    const { api, dataDir } = await start();
    for (let round = 0; round < 12; round++) {
      const project = await api.createProject();
      const client = await connect(api, project, 'project').whenSynced();
      client.map.set('n', round);
      const path = `/api/projects/${project.id}`;
      // In a different order each round, so that each write is at times ahead of the deletion.
      const racers = [
        () => remove(api, path, project.token).then((res) => res.status),
        // An upload that the deletion finds under way is cut off: no answer at all.
        () =>
          upload(api, project, 'asset_race', Buffer.alloc(50_000, round)).then(
            (res) => res.status,
            () => 0,
          ),
        () => api.json(`${path}/versions`, { name: 'Race' }, project.token).then((res) => res.status),
        () => api.json(`${path}/invites`, { role: 'editor' }, project.token).then((res) => res.status),
        () => upgradeStatus(api.wsUrl(project.id, 'review', project.token)).catch(() => 101),
        () => remove(api, path, project.token).then((res) => res.status),
      ];
      const order = racers.map((_, i) => (i + round) % racers.length);
      const answers = await Promise.all(order.map((i) => racers[i]()));
      const byRacer = order.map((i, at) => [i, answers[at]] as const).sort((a, b) => a[0] - b[0]);
      const [first, put, version, invite, socket, second] = byRacer.map(([, status]) => status);
      expect([first, second]).toEqual([204, 204]);
      expect([204, 410, 0]).toContain(put);
      expect([200, 410]).toContain(version);
      expect([200, 410]).toContain(invite);
      expect([101, 410]).toContain(socket);
      client.map.set('after', round);
      await waitFor(() => client.closed, 'socket closed');
      await sleep(150);
      expect(existsSync(join(dataDir, 'projects', project.id))).toBe(false);
      expect((await api.fetch(path, { token: project.token })).status).toBe(410);
    }
    expect(await readdir(join(dataDir, 'projects'))).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('finishes at the next start a deletion that the process did not live to finish', async () => {
    const first = await start();
    const project = await first.api.createProject();
    const kept = await first.api.createProject();
    expect((await upload(first.api, project, 'asset_one', Buffer.alloc(100, 1))).status).toBe(204);
    await first.server.close();
    // The record was written and the process died before the first file went.
    await mkdir(join(first.dataDir, 'deleted'));
    await writeFile(join(first.dataDir, 'deleted', project.id), JSON.stringify({ deletedAt: Date.now() }));
    await writeFile(join(first.dataDir, 'deleted', 'not an id'), '');

    const { api } = await start({ dataDir: first.dataDir });
    expect(await readdir(join(first.dataDir, 'projects'))).toEqual([kept.id]);
    expect((await api.fetch(`/api/projects/${project.id}`, { token: project.token })).status).toBe(410);
    expect((await api.fetch(`/api/projects/${kept.id}`, { token: kept.token })).status).toBe(200);
    expect(logged).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'is no failure of the write that was bringing the time of the project’s last change to disk',
    async () => {
      const { ProjectStore } = await import('../src/projects');
      const dataDir = await tempDir();
      await mkdir(join(dataDir, 'projects'));
      const projects = new ProjectStore(dataDir);
      await projects.open();
      const { id, meta } = await projects.create('Going');
      // That write reads the project's `meta.json` first. A pipe in the file's place holds the
      // read until something is written into it, which is after the project was deleted.
      const metaPath = join(dataDir, 'projects', id, 'meta.json');
      await rm(metaPath);
      expect(spawnSync('mkfifo', [metaPath]).status).toBe(0);
      projects.touch(id);
      const flushed = projects.flush();
      await projects.markDeleted(id);
      await writeFile(metaPath, JSON.stringify({ ...meta, updatedAt: meta.updatedAt - 1000 }));
      await flushed;
      await projects.remove(id);
      expect(await readdir(join(dataDir, 'projects'))).toEqual([]);
      expect(logged).toEqual([]);
    },
  );

  it('rate limits deletions per address', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const viewer = await api.invite(project, 'viewer');
    // Refused attempts are not counted.
    for (let i = 0; i < 5; i++) {
      expect((await remove(api, `/api/projects/${project.id}`, viewer)).status).toBe(403);
    }
    // Deleting a version that is not there is as clean as deleting one that is, and counts.
    const path = `/api/projects/${project.id}/versions/no_such_version`;
    const statuses = await Promise.all(
      Array.from({ length: DELETES_PER_HOUR + 3 }, () =>
        remove(api, path, project.token).then((r) => r.status),
      ),
    );
    expect(statuses.filter((status) => status === 204)).toHaveLength(DELETES_PER_HOUR);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
    const limited = await remove(api, `/api/projects/${project.id}`, project.token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Nothing was deleted by the refused request, and reads go on.
    expect((await api.fetch(`/api/projects/${project.id}`, { token: project.token })).status).toBe(200);
  });
});

describe('deleting a version', () => {
  it('is for the owner and editors, leaves the other versions alone and is clean when repeated', async () => {
    const { api, dataDir } = await start({ autoSnapshotMs: 0 });
    const project = await api.createProject();
    const client = await connect(api, project, 'project').whenSynced();
    const versions: VersionInfo[] = [];
    for (const name of ['First', 'Second', 'Third']) {
      client.map.set('at', name);
      await waitFor(() => existsSync(join(dataDir, 'projects', project.id, 'project.log')), 'edit stored');
      versions.push(await saveVersion(api, project, name));
    }
    const [first, second, third] = versions;
    const path = (version: VersionInfo): string => `/api/projects/${project.id}/versions/${version.id}`;
    const bins = async (): Promise<string[]> =>
      (await readdir(join(dataDir, 'projects', project.id, 'versions'))).sort();
    expect(await bins()).toEqual(versions.map((v) => `${v.id}.bin`).sort());

    for (const role of ['commenter', 'viewer'] satisfies Role[]) {
      const res = await remove(api, path(second), await api.invite(project, role));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: `role "${role}" cannot delete versions` });
    }
    expect((await remove(api, path(second))).status).toBe(401);
    expect((await remove(api, `/api/projects/${project.id}/versions/bad!id`, project.token)).status).toBe(
      400,
    );
    expect(await listVersions(api, project)).toEqual(['First', 'Second', 'Third']);

    expect((await remove(api, path(second), await api.invite(project, 'editor'))).status).toBe(204);
    expect(await listVersions(api, project)).toEqual(['First', 'Third']);
    expect(await bins()).toEqual([first, third].map((v) => `${v.id}.bin`).sort());
    expect((await api.fetch(path(second), { token: project.token })).status).toBe(404);
    // Again, and of one that never was: the same answer, and nothing else goes.
    expect((await remove(api, path(second), project.token)).status).toBe(204);
    expect(
      (await remove(api, `/api/projects/${project.id}/versions/never_there`, project.token)).status,
    ).toBe(204);
    expect(await listVersions(api, project)).toEqual(['First', 'Third']);

    expect((await remove(api, path(first), project.token)).status).toBe(204);
    expect((await remove(api, path(third), project.token)).status).toBe(204);
    expect(await listVersions(api, project)).toEqual([]);
    expect(await bins()).toEqual([]);
    // The project itself is as it was.
    const reader = await connect(api, project, 'project').whenSynced();
    expect(reader.map.get('at')).toBe('Third');
    expect(logged).toEqual([]);
  });

  it('hands a version that is being restored at the same moment over whole, or not at all', async () => {
    const { api } = await start({ autoSnapshotMs: 0 });
    const project = await api.createProject();
    const client = await connect(api, project, 'project').whenSynced();
    // Large enough to be sent in several pieces.
    client.doc.getText('script').insert(0, 'take '.repeat(400_000));
    const reader = await connect(api, project, 'project').whenSynced();
    await waitFor(() => reader.doc.getText('script').length === 2_000_000, 'server has the text');

    for (let round = 0; round < 8; round++) {
      const version = await saveVersion(api, project, `Take ${round}`);
      const path = `/api/projects/${project.id}/versions/${version.id}`;
      const [restored, deleted] = await Promise.all(
        round % 2
          ? [api.fetch(path, { token: project.token }), remove(api, path, project.token)]
          : [remove(api, path, project.token), api.fetch(path, { token: project.token })].reverse(),
      );
      expect(deleted.status).toBe(204);
      expect([200, 404]).toContain(restored.status);
      if (restored.status === 200) {
        const bytes = new Uint8Array(await restored.arrayBuffer());
        expect(bytes.length).toBe(Number(restored.headers.get('content-length')));
        const doc = new Y.Doc();
        Y.applyUpdate(doc, bytes);
        expect(doc.getText('script').length).toBe(2_000_000);
      }
      expect((await api.fetch(path, { token: project.token })).status).toBe(404);
      expect(await listVersions(api, project)).toEqual([]);
    }
    expect(logged).toEqual([]);
  });
});

describe('media that nothing refers to', () => {
  /** A server with a project, and the means to say what its document holds and what is stored. */
  async function projectWithMedia(options: Parameters<typeof start>[0] = {}) {
    const { api, server, dataDir } = await start({ autoSnapshotMs: 0, ...options });
    const project = await api.createProject();
    const client = await connect(api, project, 'project').whenSynced();
    const observer = await connect(api, project, 'project').whenSynced();
    const assets = client.doc.getMap<Y.Map<unknown>>('assets');
    const dir = join(dataDir, 'projects', project.id);
    return {
      api,
      server,
      project,
      dir,
      /** Put an asset into the project document, or take it out, and wait for the server to have it so. */
      async refer(assetId: string, on = true): Promise<void> {
        if (on) assets.set(assetId, new Y.Map([['name', assetId]]));
        else assets.delete(assetId);
        await waitFor(() => observer.doc.getMap('assets').has(assetId) === on, 'the server has the edit');
      },
      async store(...assetIds: string[]): Promise<void> {
        for (const assetId of assetIds) {
          expect((await upload(api, project, assetId, Buffer.alloc(2000, 5))).status).toBe(204);
        }
      },
      stored: async (): Promise<string[]> =>
        (await readdir(join(dir, 'media')).catch(() => [])).filter((name) => !name.includes('.')).sort(),
      noted: async (): Promise<string[]> =>
        Object.keys(
          JSON.parse(await readFile(join(dir, 'unreferenced.json'), 'utf8').catch(() => '{}')),
        ).sort(),
    };
  }

  it('is kept while the document or a version refers to it, and for the grace period after', async () => {
    const { api, server, project, dir, refer, store, stored, noted } = await projectWithMedia();
    await refer('asset_in_doc');
    await refer('asset_in_version');
    const version = await saveVersion(api, project, 'With both');
    await refer('asset_in_version', false);
    await store('asset_in_doc', 'asset_in_version', 'asset_in_neither');
    const t0 = Date.now();

    // Found for the first time, a file that nothing refers to is noted and kept.
    expect(await server.sweepUnusedMedia(t0)).toBe(0);
    expect(await noted()).toEqual(['asset_in_neither']);
    expect(await server.sweepUnusedMedia(t0 + 23 * HOUR)).toBe(0);
    expect(await stored()).toEqual(['asset_in_doc', 'asset_in_neither', 'asset_in_version']);

    // A day on it goes, with what was stored about it, and nothing else does.
    await store('asset_late');
    expect(await server.sweepUnusedMedia(t0 + 25 * HOUR)).toBe(1);
    expect(await stored()).toEqual(['asset_in_doc', 'asset_in_version', 'asset_late']);
    expect(await readdir(join(dir, 'media'))).not.toContain('asset_in_neither.json');
    expect(await noted()).toEqual(['asset_late']);

    // Asked for afterwards, it is a file that is not there, as if it had never been uploaded.
    const media = `/api/projects/${project.id}/media`;
    expect((await api.fetch(`${media}/asset_in_neither`, { token: project.token })).status).toBe(404);
    const probe = await api.fetch(`${media}/asset_in_neither?probe`, {
      method: 'HEAD',
      token: project.token,
    });
    expect([probe.status, probe.headers.get('upload-offset'), probe.headers.get('upload-complete')]).toEqual([
      200,
      '0',
      '0',
    ]);
    expect((await api.fetch(`${media}/asset_in_version`, { token: project.token })).status).toBe(200);

    // The version goes: what only it referred to is on its own from the next sweep on.
    expect(
      (await remove(api, `/api/projects/${project.id}/versions/${version.id}`, project.token)).status,
    ).toBe(204);
    expect(await server.sweepUnusedMedia(t0 + 26 * HOUR)).toBe(0);
    expect(await noted()).toEqual(['asset_in_version', 'asset_late']);
    expect(await server.sweepUnusedMedia(t0 + 49 * HOUR + 1)).toBe(1);
    expect(await stored()).toEqual(['asset_in_doc', 'asset_in_version']);
    expect(await server.sweepUnusedMedia(t0 + 51 * HOUR)).toBe(1);
    expect(await stored()).toEqual(['asset_in_doc']);
    expect(existsSync(join(dir, 'unreferenced.json'))).toBe(false);

    // What the document refers to stays, however long.
    expect(await server.sweepUnusedMedia(t0 + 1000 * HOUR)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 2000 * HOUR)).toBe(0);
    expect(await stored()).toEqual(['asset_in_doc']);
    expect(logged).toEqual([]);
  });

  it('starts counting afresh for a file that was referred to again in between', async () => {
    const { server, refer, store, stored, noted } = await projectWithMedia();
    await refer('asset_one');
    await store('asset_one');
    const t0 = Date.now();
    await refer('asset_one', false);
    expect(await server.sweepUnusedMedia(t0)).toBe(0);
    expect(await noted()).toEqual(['asset_one']);

    // An undo brings the asset back, and a later change of mind takes it out again.
    await refer('asset_one');
    expect(await server.sweepUnusedMedia(t0 + 2 * HOUR)).toBe(0);
    expect(await noted()).toEqual([]);
    await refer('asset_one', false);
    expect(await server.sweepUnusedMedia(t0 + 25 * HOUR)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 48 * HOUR)).toBe(0);
    expect(await stored()).toEqual(['asset_one']);
    expect(await server.sweepUnusedMedia(t0 + 49 * HOUR)).toBe(1);
    expect(await stored()).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('counts from the last time the document referred to a file, also when no sweep found it referred to', async () => {
    const { api, server, project, refer, store, stored, noted } = await projectWithMedia();
    const file = `/api/projects/${project.id}/media/asset_one`;
    await refer('asset_one');
    await refer('asset_other');
    await store('asset_one', 'asset_other');
    const t0 = Date.now();
    await refer('asset_one', false);
    await refer('asset_other', false);
    expect(await server.sweepUnusedMedia(t0)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 23 * HOUR)).toBe(0);
    expect(await noted()).toEqual(['asset_one', 'asset_other']);

    // Between two sweeps an undo brings one asset back and a redo takes it out again. No sweep
    // finds it in the document and no version was made of it there, and still it was referred to
    // an hour ago and not a day: what was noted about it is forgotten the moment it comes back.
    await refer('asset_one');
    expect(await noted()).toEqual(['asset_other']);
    await refer('asset_one', false);
    expect(await listVersions(api, project)).toEqual([]);
    expect(await server.sweepUnusedMedia(t0 + 24 * HOUR)).toBe(1);
    expect(await stored()).toEqual(['asset_one']);
    expect(await noted()).toEqual(['asset_one']);

    // The next undo, inside the grace period, finds its file.
    await refer('asset_one');
    expect((await api.fetch(file, { token: project.token })).status).toBe(200);
    expect(await noted()).toEqual([]);
    await refer('asset_one', false);

    // An asset that comes and goes within one change of the document was referred to as well.
    expect(await server.sweepUnusedMedia(t0 + 30 * HOUR)).toBe(0);
    expect(await noted()).toEqual(['asset_one']);
    const passing = await connect(api, project, 'project').whenSynced();
    const watcher = await connect(api, project, 'project').whenSynced();
    const theirs = passing.doc.getMap<Y.Map<unknown>>('assets');
    passing.doc.transact(() => {
      theirs.set('asset_one', new Y.Map());
      theirs.delete('asset_one');
    });
    // A second change over the same connection shows that the server has taken the first.
    theirs.set('asset_marker', new Y.Map());
    await waitFor(() => watcher.doc.getMap('assets').has('asset_marker'), 'the server has both changes');
    expect(watcher.doc.getMap('assets').has('asset_one')).toBe(false);
    expect(await noted()).toEqual([]);

    // From the sweep that next finds nothing referring to it, the file has its full time again.
    expect(await server.sweepUnusedMedia(t0 + 31 * HOUR)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 54 * HOUR)).toBe(0);
    expect(await stored()).toEqual(['asset_one']);
    expect(await server.sweepUnusedMedia(t0 + 55 * HOUR)).toBe(1);
    expect(await stored()).toEqual([]);
    expect((await api.fetch(file, { token: project.token })).status).toBe(404);
    expect(logged).toEqual([]);
  });

  it('has forgotten such a note for good: the sweep of the next start does not go by it', async () => {
    const dataDir = await tempDir();
    const first = await projectWithMedia({ dataDir });
    await first.refer('asset_one');
    await first.store('asset_one');
    const t0 = Date.now();
    // Uploaded three days ago and found to be referred to by nothing two days ago, as the files
    // have it.
    const longAgo = new Date(t0 - 72 * HOUR);
    await utimes(join(first.dir, 'media', 'asset_one'), longAgo, longAgo);
    await first.refer('asset_one', false);
    expect(await first.server.sweepUnusedMedia(t0 - 48 * HOUR)).toBe(0);
    expect(await first.noted()).toEqual(['asset_one']);
    await first.refer('asset_one');
    await first.refer('asset_one', false);
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await first.server.close();

    // The server sweeps when it starts, which is now: the file is found for the first time again.
    const { server } = await start({ dataDir, autoSnapshotMs: 0 });
    expect(await server.sweepUnusedMedia(t0 + 23 * HOUR)).toBe(0);
    expect(await first.stored()).toEqual(['asset_one']);
    expect(await server.sweepUnusedMedia(t0 + 25 * HOUR)).toBe(1);
    expect(await first.stored()).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('reads the document from disk when nobody has the project open', async () => {
    const { api, server, project, dir, refer, store, stored } = await projectWithMedia({ roomIdleMs: 30 });
    await refer('asset_in_doc');
    await store('asset_in_doc', 'asset_in_neither');
    await Promise.all(clients.splice(0).map((client) => client.close()));
    // Unloaded: the document is in its snapshot and nowhere else.
    await waitFor(() => existsSync(join(dir, 'project.snapshot')), 'room unloaded');
    await sleep(100);
    const t0 = Date.now();
    expect(await server.sweepUnusedMedia(t0)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 25 * HOUR)).toBe(1);
    expect(await stored()).toEqual(['asset_in_doc']);
    // And is in nobody's way afterwards.
    const reader = await connect(api, project, 'project').whenSynced();
    expect(Array.from(reader.doc.getMap('assets').keys())).toEqual(['asset_in_doc']);
    expect(logged).toEqual([]);
  });

  it('counts an upload from when it ended, whatever was noted about the asset before', async () => {
    const { server, dir, store, stored } = await projectWithMedia();
    await store('asset_early', 'asset_again');
    const t0 = Date.now();
    expect(await server.sweepUnusedMedia(t0)).toBe(0);
    // Uploaded once more half an hour ago, as the sweep will see it: before the edit that adds
    // its asset has arrived, the file is referred to by nothing, and is new all the same.
    const recent = new Date(t0 + 24.5 * HOUR);
    await utimes(join(dir, 'media', 'asset_again'), recent, recent);
    expect(await server.sweepUnusedMedia(t0 + 25 * HOUR)).toBe(1);
    expect(await stored()).toEqual(['asset_again']);
    expect(await server.sweepUnusedMedia(t0 + 48 * HOUR)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 49 * HOUR)).toBe(1);
    expect(logged).toEqual([]);
  });

  it('leaves an upload that is in flight alone', async () => {
    const { api, server, project, dir, store, stored } = await projectWithMedia();
    await store('asset_old');
    const { request, ended } = stalledUpload(api, project, 'asset_inflight', 30_000, 100_000);
    const part = join(dir, 'media', 'asset_inflight.part');
    await waitFor(() => existsSync(part), 'upload under way');
    const t0 = Date.now();
    expect(await server.sweepUnusedMedia(t0)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 25 * HOUR)).toBe(1);
    expect(await stored()).toEqual([]);

    // The upload goes on to its end and the file is whole.
    request.end(Buffer.alloc(70_000, 1));
    await ended;
    await waitFor(() => existsSync(join(dir, 'media', 'asset_inflight')), 'upload finished');
    const whole = await api.fetch(`/api/projects/${project.id}/media/asset_inflight`, {
      token: project.token,
    });
    expect(Buffer.from(await whole.arrayBuffer()).equals(Buffer.alloc(100_000, 1))).toBe(true);
    // Nothing refers to it yet. Found so for the first time, it is noted and kept.
    expect(await server.sweepUnusedMedia(t0 + 50 * HOUR)).toBe(0);
    expect(await stored()).toEqual(['asset_inflight']);
    expect(logged).toEqual([]);
  });

  it('does not touch a file that a request holds, however long nothing has referred to it', async () => {
    const { api, server, project, dir, stored } = await projectWithMedia();
    // An upload of the asset is under way, and its finished file is there all the same: put
    // there by hand, a day old and noted as long, so that only the upload stands in the way.
    const { request, ended } = stalledUpload(api, project, 'asset_busy', 30_000, 100_000);
    await waitFor(() => existsSync(join(dir, 'media', 'asset_busy.part')), 'upload under way');
    const longAgo = Date.now() - 48 * HOUR;
    await writeFile(join(dir, 'media', 'asset_busy'), 'an earlier upload');
    await utimes(join(dir, 'media', 'asset_busy'), new Date(longAgo), new Date(longAgo));
    await writeFile(join(dir, 'unreferenced.json'), JSON.stringify({ asset_busy: longAgo }));

    expect(await server.sweepUnusedMedia()).toBe(0);
    expect(await stored()).toEqual(['asset_busy']);
    // The upload gone, there is nothing left to wait for.
    request.destroy();
    await ended;
    await expect.poll(() => server.sweepUnusedMedia()).toBe(1);
    expect(await stored()).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('knows of a version from the moment it is asked for, before it is on disk', async () => {
    const { ProjectStore } = await import('../src/projects');
    const { VersionStore } = await import('../src/versions');
    const dataDir = await tempDir();
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    const projects = new ProjectStore(dataDir);
    const versions = new VersionStore(projects);
    const { id } = await projects.create('p');
    const other = await projects.create('q');
    const input = { name: 'v', author: '', auto: false };
    const state = new Uint8Array([0, 0]);
    const unread = (): string[] | null => null;

    await versions.create(id, input, { state, assets: ['asset_one'] });
    // Asked for but not written yet: an answer that is worked out now waits for it.
    const writing = versions.create(id, input, { state, assets: ['asset_two'] });
    const first = await versions.references(id, unread);
    expect([...first.assets!].sort()).toEqual(['asset_one', 'asset_two']);
    expect(first.current()).toBe(true);

    // A version of another project changes nothing for this answer. One of this project does, at once.
    const far = versions.create(other.id, input, { state, assets: ['asset_far'] });
    expect(first.current()).toBe(true);
    const third = versions.create(id, input, { state, assets: ['asset_three'] });
    expect(first.current()).toBe(false);
    // So does one asked for while the answer was still being worked out.
    const asking = versions.references(id, unread);
    const fourth = versions.create(id, input, { state, assets: ['asset_four'] });
    const second = await asking;
    expect([...second.assets!].sort()).toEqual(['asset_one', 'asset_three', 'asset_two']);
    expect(second.current()).toBe(false);
    await Promise.all([writing, far, third, fourth]);

    // Deleting one takes away what only it referred to. An answer given up is no longer kept up.
    const [newest] = await versions.list(id);
    expect(await versions.remove(id, newest.id)).toBe(true);
    expect(await versions.remove(id, newest.id)).toBe(false);
    const last = await versions.references(id, unread);
    expect([...last.assets!].sort()).toEqual(['asset_one', 'asset_three', 'asset_two']);
    first.release();
    second.release();
    last.release();
    await versions.create(id, input, { state, assets: [] });
    expect(last.current()).toBe(true);
  });

  it('reads what a version from before the lists were kept refers to, and keeps everything when it cannot', async () => {
    const first = await projectWithMedia();
    await first.store('asset_in_old_version', 'asset_in_neither');
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await first.server.close();

    // A version as an earlier server stored it: no list of assets in the index.
    const old = new Y.Doc();
    old.getMap('assets').set('asset_in_old_version', new Y.Map());
    await mkdir(join(first.dir, 'versions'), { recursive: true });
    await writeFile(join(first.dir, 'versions', 'version_old.bin'), Y.encodeStateAsUpdate(old));
    const entry = { id: 'version_old', name: 'Old', createdAt: 1, author: '', auto: false };
    const unreadable = { ...entry, id: 'version_bad', name: 'Damaged' };
    await writeFile(
      join(first.dir, 'versions', 'version_bad.bin'),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x07]),
    );
    await writeFile(join(first.dir, 'versions.json'), JSON.stringify([entry, unreadable]));

    const { api, server } = await start({ dataDir: dirname(dirname(first.dir)), autoSnapshotMs: 0 });
    const t0 = Date.now();
    // One version cannot be read, so what the versions refer to is not known: nothing is even noted.
    expect(await server.sweepUnusedMedia(t0)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 100 * HOUR)).toBe(0);
    expect(await first.stored()).toEqual(['asset_in_neither', 'asset_in_old_version']);
    expect(existsSync(join(first.dir, 'unreferenced.json'))).toBe(false);

    // Without it, the old version says what it refers to, and the index keeps that from then on.
    expect(
      (await remove(api, `/api/projects/${first.project.id}/versions/version_bad`, first.project.token))
        .status,
    ).toBe(204);
    expect(await server.sweepUnusedMedia(t0 + 200 * HOUR)).toBe(0);
    expect(await server.sweepUnusedMedia(t0 + 300 * HOUR)).toBe(1);
    expect(await first.stored()).toEqual(['asset_in_old_version']);
    expect(JSON.parse(await readFile(join(first.dir, 'versions.json'), 'utf8'))).toEqual([
      { ...entry, assets: ['asset_in_old_version'] },
    ]);
    expect(await listVersions(api, first.project)).toEqual(['Old']);
    expect(logged).toEqual([]);
  });

  it('goes by itself when the server starts, and never with the sweep turned off', async () => {
    const first = await projectWithMedia({ unusedMediaExpiryHours: 0 });
    await first.store('asset_in_neither');
    // Turned off, nothing is noted and nothing goes, whatever the time.
    expect(await first.server.sweepUnusedMedia(Date.now() + 1000 * HOUR)).toBe(0);
    expect(await first.noted()).toEqual([]);
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await first.server.close();

    const dataDir = dirname(dirname(first.dir));
    const second = await start({ dataDir, autoSnapshotMs: 0 });
    await waitFor(() => existsSync(join(first.dir, 'unreferenced.json')), 'the sweep at the start');
    expect(await first.noted()).toEqual(['asset_in_neither']);
    await second.server.close();

    // The note is a day old by the time the server starts again, and so is the file.
    const longAgo = Date.now() - 25 * HOUR;
    await writeFile(join(first.dir, 'unreferenced.json'), JSON.stringify({ asset_in_neither: longAgo }));
    await utimes(join(first.dir, 'media', 'asset_in_neither'), new Date(longAgo), new Date(longAgo));
    await start({ dataDir, autoSnapshotMs: 0 });
    await waitFor(() => !existsSync(join(first.dir, 'media', 'asset_in_neither')), 'the file to go');
    expect(await first.stored()).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('takes its grace period from UNUSED_MEDIA_EXPIRY_HOURS, which has to be a whole number of hours', async () => {
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const entry = join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
    const dataDir = await tempDir();
    for (const value of ['-1', '1.5', 'a day', '1e400']) {
      const run = spawnSync(process.execPath, [tsx, entry], {
        env: { ...process.env, DATA_DIR: dataDir, PORT: '0', UNUSED_MEDIA_EXPIRY_HOURS: value },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`UNUSED_MEDIA_EXPIRY_HOURS must be an integer ≥ 0, got "${value}"`);
      expect(run.stdout).toBe('');
    }
  }, 60_000);

  it('finds the assets of a project document where the editor keeps them', () => {
    const doc = new Y.Doc();
    const project = new ProjectDocument(doc);
    project.initIfEmpty({});
    const asset = (id: string): Asset => ({
      ...ASSET_DEFAULTS,
      id,
      name: `${id}.mp4`,
      kind: 'video',
      uploaded: true,
    });
    project.commit([
      { op: 'addAsset', asset: asset('asset_one') },
      { op: 'addAsset', asset: asset('asset_two') },
    ]);
    expect(assetIdsOf(doc).sort()).toEqual(Object.keys(project.get().assets).sort());
    expect(assetIdsOf(doc).sort()).toEqual(['asset_one', 'asset_two']);
    project.commit([{ op: 'removeAsset', id: 'asset_one' }]);
    expect(assetIdsOf(doc)).toEqual(['asset_two']);
    project.undo();
    expect(assetIdsOf(doc).sort()).toEqual(['asset_one', 'asset_two']);
    // A key that could not be the name of a file is not one.
    doc.getMap('assets').set('../secret', new Y.Map());
    expect(assetIdsOf(doc).sort()).toEqual(['asset_one', 'asset_two']);
  });

  it('hears of every asset an edit of the editor adds, takes out or brings back, as the edit is made', () => {
    const doc = new Y.Doc();
    const project = new ProjectDocument(doc);
    project.initIfEmpty({});
    const asset = (id: string): Asset => ({ ...ASSET_DEFAULTS, id, name: `${id}.mp4`, kind: 'video' });
    const heard: string[][] = [];
    const stop = watchAssets(doc, (assetIds) => heard.push(assetIds.sort()));

    project.commit([
      { op: 'addAsset', asset: asset('asset_one') },
      { op: 'addAsset', asset: asset('asset_two') },
    ]);
    expect(heard).toEqual([['asset_one', 'asset_two']]);
    // What an asset says about itself is no news of which assets there are.
    project.commit([{ op: 'updateAsset', id: 'asset_one', patch: { uploaded: true } }], { undoable: false });
    expect(heard).toHaveLength(1);
    project.commit([{ op: 'removeAsset', id: 'asset_one' }]);
    project.undo();
    project.redo();
    expect(heard.slice(1)).toEqual([['asset_one'], ['asset_one'], ['asset_one']]);

    // Back and out again within one change, as a client that was away sends it: referred to all the same.
    const away = new Y.Doc();
    Y.applyUpdate(away, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(away);
    away.getMap('assets').set('asset_one', new Y.Map());
    away.getMap('assets').delete('asset_one');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(away, before));
    expect(assetIdsOf(doc)).toEqual(['asset_two']);
    expect(heard.slice(4)).toEqual([['asset_one']]);

    // A key that names no file is none, and nothing is heard once it was said to stop.
    doc.getMap('assets').set('../secret', new Y.Map());
    stop();
    project.commit([{ op: 'removeAsset', id: 'asset_two' }]);
    expect(heard).toHaveLength(5);
  });
});
