import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ProjectInfo, VersionInfo } from '@tandem/core';
import { createTandemServer } from '../src/server';
import type { TandemServer, TandemServerOptions } from '../src/server';
import {
  Api,
  TestClient,
  content,
  rawGet,
  removeTempDirs,
  sleep,
  tempDir,
  upgradeStatus,
  waitFor,
} from './helpers';
import type { Project } from './helpers';

const servers: TandemServer[] = [];
const clients: TestClient[] = [];

async function start(
  options: Partial<TandemServerOptions> = {},
): Promise<{ server: TandemServer; api: Api; dataDir: string }> {
  const dataDir = options.dataDir ?? (await tempDir());
  // Point the static mounts at nothing unless a test asks for them, whatever happens to be built.
  const missing = join(dataDir, 'no-such-dist');
  const server = await createTandemServer({ editorDist: missing, siteDist: missing, ...options, dataDir });
  servers.push(server);
  return { server, api: new Api(server.url), dataDir };
}

function connect(api: Api, project: Project, doc: string, token = project.token): TestClient {
  const client = new TestClient(api.wsUrl(project.id, doc, token));
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

describe('tandem server', () => {
  // One server per group: keeps the groups independent (and far below the creation rate limit).
  let api: Api;
  let dataDir: string;
  const freshServer = (): void => {
    beforeAll(async () => {
      ({ api, dataDir } = await start());
    });
  };

  describe('http plumbing', () => {
    freshServer();

    it('reports health with security and CORS headers', async () => {
      const res = await api.fetch('/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        name: 'tandem',
        version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      });
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('answers CORS preflights', async () => {
      const res = await api.fetch('/api/projects/whatever/media/whatever', {
        method: 'OPTIONS',
        headers: { Origin: 'https://editor.example', 'Access-Control-Request-Method': 'PUT' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toBe('GET,POST,PUT,HEAD,DELETE,OPTIONS');
      expect(res.headers.get('access-control-allow-headers')).toBe(
        'Authorization, Content-Type, Range, Upload-Offset, Upload-Length',
      );
      expect(res.headers.get('access-control-expose-headers')).toBe(
        'Upload-Offset, Upload-Complete, Content-Range, Accept-Ranges, Content-Length, Content-Type',
      );
      expect(res.headers.get('access-control-max-age')).toBe('86400');
    });

    it('uses JSON errors with proper status codes', async () => {
      const unknown = await api.fetch('/api/nope');
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: expect.any(String) });
      expect(unknown.headers.get('access-control-allow-origin')).toBe('*');

      const wrongMethod = await api.fetch('/api/projects', { method: 'DELETE' });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get('allow')).toContain('POST');

      const badJson = await api.fetch('/api/projects', { method: 'POST', body: '{nope' });
      expect(badJson.status).toBe(400);

      const tooBig = await api.fetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'x'.repeat(70_000) }),
      });
      expect(tooBig.status).toBe(413);

      // No static build is mounted in this server.
      expect((await api.fetch('/')).status).toBe(404);
    });
  });

  describe('auth', () => {
    freshServer();

    it('creates a project whose owner token opens it', async () => {
      const project = await api.createProject('My film');
      expect(project.id).toMatch(/^[A-Za-z0-9_-]{6,64}$/);

      const before = Date.now();
      const res = await api.fetch(`/api/projects/${project.id}`, { token: project.token });
      expect(res.status).toBe(200);
      const info = (await res.json()) as ProjectInfo;
      expect(info).toMatchObject({ id: project.id, role: 'owner' });
      expect(info.createdAt).toBeLessThanOrEqual(before);
      expect(info.updatedAt).toBeGreaterThanOrEqual(info.createdAt);

      // The token is also accepted as a query parameter.
      const viaQuery = await api.fetch(`/api/projects/${project.id}?t=${project.token}`);
      expect(viaQuery.status).toBe(200);

      const meta = JSON.parse(await readFile(join(dataDir, 'projects', project.id, 'meta.json'), 'utf8'));
      expect(meta).toMatchObject({ name: 'My film', createdAt: info.createdAt });
    });

    it('creates a project without a request body', async () => {
      const res = await api.fetch('/api/projects', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: expect.any(String), token: expect.any(String) });
    });

    it('rejects missing, garbage and forged tokens with 401', async () => {
      const project = await api.createProject();
      const path = `/api/projects/${project.id}`;
      const [payload, signature] = project.token.split('.');

      expect((await api.fetch(path)).status).toBe(401);
      expect((await api.fetch(path, { token: 'garbage' })).status).toBe(401);
      expect((await api.fetch(path, { token: 'a.b.c' })).status).toBe(401);
      expect((await api.fetch(path, { token: `${payload}.` })).status).toBe(401);

      // Same payload, tampered signature.
      const flipped = signature.slice(0, -2) + (signature.endsWith('AA') ? 'BB' : 'AA');
      expect((await api.fetch(path, { token: `${payload}.${flipped}` })).status).toBe(401);

      // Self-made payload claiming ownership, signed with the wrong key / the original signature.
      const forged = Buffer.from(JSON.stringify({ p: project.id, r: 'owner', iat: 1 })).toString('base64url');
      expect((await api.fetch(path, { token: `${forged}.${signature}` })).status).toBe(401);

      const res = await api.fetch(path, { token: 'garbage' });
      expect(await res.json()).toEqual({ error: expect.any(String) });
    });

    it('accepts exactly one spelling of a token', async () => {
      const project = await api.createProject();
      const path = `/api/projects/${project.id}`;
      const [payload, signature] = project.token.split('.');
      // Node's base64url decoder would happily ignore all of these decorations.
      for (const variant of [
        `${project.token}A`,
        `${project.token}=`,
        `${project.token}!`,
        `${payload}.${signature.slice(0, -1)}`,
        `${payload}.${Buffer.from(signature, 'base64url').toString('base64')}`,
        `${payload}=.${signature}`,
        `x${project.token}`,
      ]) {
        expect((await api.fetch(`${path}?t=${encodeURIComponent(variant)}`)).status, variant).toBe(401);
      }
      expect((await api.fetch(`${path}?t=${encodeURIComponent(project.token)}`)).status).toBe(200);
    });

    it('never turns path tricks into file access', async () => {
      const project = await api.createProject();
      const t = `?t=${project.token}`;
      for (const path of [
        '/api/projects/../../secret',
        '/api/projects/..',
        `/api/projects/${project.id}/../${project.id}`,
        `/api/projects/${project.id}/media/..%2Fmeta.json${t}`,
        `/api/projects/${project.id}/media/../meta.json${t}`,
        `/api/projects/${project.id}/versions/..%2F..%2F..%2Fsecret${t}`,
        `/api/projects/${project.id}%2F..%2F..%2Fsecret${t}`,
        `/api/projects/${project.id}/media/meta.json${t}`,
        `/api//projects/${project.id}${t}`,
      ]) {
        const res = await rawGet(api.base, path);
        expect([400, 404], path).toContain(res.status);
        expect(JSON.parse(res.body), path).toEqual({ error: expect.any(String) });
      }
    });

    it('rejects a token issued for another project', async () => {
      const a = await api.createProject();
      const b = await api.createProject();
      expect((await api.fetch(`/api/projects/${b.id}`, { token: a.token })).status).toBe(401);
      expect((await api.fetch(`/api/projects/${a.id}`, { token: b.token })).status).toBe(401);
      expect((await api.fetch(`/api/projects/${a.id}`, { token: a.token })).status).toBe(200);
    });

    it('answers 404 when a genuine token points at a project that no longer exists', async () => {
      const project = await api.createProject();
      await rm(join(dataDir, 'projects', project.id), { recursive: true });
      const res = await api.fetch(`/api/projects/${project.id}`, { token: project.token });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: expect.any(String) });
      expect((await api.fetch(`/api/projects/${project.id}/versions`, { token: project.token })).status).toBe(
        404,
      );
      expect(await upgradeStatus(api.wsUrl(project.id, 'project', project.token))).toBe(404);
      // Still 401 for everybody else: the answer does not reveal which ids exist.
      expect((await api.fetch(`/api/projects/${project.id}`, { token: 'garbage' })).status).toBe(401);
    });

    it('validates project ids and does not reveal which projects exist', async () => {
      const project = await api.createProject();
      expect((await api.fetch('/api/projects/bad!id', { token: project.token })).status).toBe(400);
      expect((await api.fetch('/api/projects/abc', { token: project.token })).status).toBe(400);
      // A well-formed id that does not exist, without a token for it: indistinguishable from "wrong token".
      expect((await api.fetch('/api/projects/doesNotExist1234', { token: project.token })).status).toBe(401);
    });
  });

  describe('invites', () => {
    freshServer();

    it('lets owners and editors mint lower roles only', async () => {
      const project = await api.createProject();
      const path = `/api/projects/${project.id}`;

      const editor = await api.invite(project, 'editor');
      const commenter = await api.invite(project, 'commenter');
      const viewer = await api.invite(project, 'viewer', editor);
      const role = async (token: string) =>
        ((await (await api.fetch(path, { token })).json()) as ProjectInfo).role;
      expect(await role(editor)).toBe('editor');
      expect(await role(commenter)).toBe('commenter');
      expect(await role(viewer)).toBe('viewer');

      // Editors can invite editors, but nobody can mint an owner — not even the owner.
      expect((await api.json(`${path}/invites`, { role: 'editor' }, editor)).status).toBe(200);
      expect((await api.json(`${path}/invites`, { role: 'owner' }, editor)).status).toBe(403);
      expect((await api.json(`${path}/invites`, { role: 'owner' }, project.token)).status).toBe(403);

      // Viewers and commenters cannot mint anything.
      for (const token of [viewer, commenter]) {
        for (const wanted of ['viewer', 'commenter', 'editor', 'owner']) {
          expect((await api.json(`${path}/invites`, { role: wanted }, token)).status).toBe(403);
        }
      }

      expect((await api.json(`${path}/invites`, { role: 'admin' }, project.token)).status).toBe(400);
      expect((await api.json(`${path}/invites`, {}, project.token)).status).toBe(400);
      expect((await api.json(`${path}/invites`, { role: 'viewer' })).status).toBe(401);
    });
  });

  describe('realtime', () => {
    freshServer();

    it('refuses upgrades without a valid token, for unknown documents and for unknown projects', async () => {
      const project = await api.createProject();
      const other = await api.createProject();
      expect(await upgradeStatus(api.wsUrl(project.id, 'project', 'garbage'))).toBe(401);
      expect(await upgradeStatus(api.wsUrl(project.id, 'project', other.token))).toBe(401);
      expect(await upgradeStatus(`${api.base.replace('http', 'ws')}/ws/${project.id}/project`)).toBe(401);
      expect(await upgradeStatus(api.wsUrl(project.id, 'secrets', project.token))).toBe(404);
      expect(await upgradeStatus(api.wsUrl('bad!id', 'project', project.token))).toBe(404);
    });

    it('greets with the role and converges edits between clients', async () => {
      const project = await api.createProject();
      const editorToken = await api.invite(project, 'editor');
      const a = await connect(api, project, 'project').whenSynced();
      const b = await connect(api, project, 'project', editorToken).whenSynced();

      expect(a.controls[0]).toEqual({ type: 'hello', role: 'owner' });
      expect(b.controls[0]).toEqual({ type: 'hello', role: 'editor' });

      a.map.set('title', 'Rough cut');
      await waitFor(() => b.map.get('title') === 'Rough cut', 'a → b');
      b.map.set('fps', 24);
      a.doc.getArray<string>('clips').push(['intro', 'outro']);
      await waitFor(() => a.map.get('fps') === 24, 'b → a');
      await waitFor(() => b.doc.getArray('clips').length === 2, 'array a → b');

      // Concurrent edits to the same key resolve to the same value on both sides.
      a.map.set('contested', 'from a');
      b.map.set('contested', 'from b');
      await waitFor(
        () =>
          a.map.get('contested') === b.map.get('contested') &&
          Y.encodeStateVector(a.doc).join() === Y.encodeStateVector(b.doc).join(),
        'convergence',
      );
      expect(content(a.doc)).toEqual(content(b.doc));

      // A late joiner receives everything in the initial sync.
      const c = await connect(api, project, 'project', editorToken).whenSynced();
      expect(content(c.doc)).toEqual(content(a.doc));
      expect(content(c.doc)).toMatchObject({
        test: { title: 'Rough cut', fps: 24 },
        clips: ['intro', 'outro'],
      });
    });

    it('sends state to viewers but neither applies nor broadcasts their edits', async () => {
      const project = await api.createProject();
      const viewerToken = await api.invite(project, 'viewer');
      const owner = await connect(api, project, 'project').whenSynced();
      owner.map.set('title', 'Final');

      const viewer = await connect(api, project, 'project', viewerToken).whenSynced();
      expect(viewer.controls[0]).toEqual({ type: 'hello', role: 'viewer' });
      await waitFor(() => viewer.map.get('title') === 'Final', 'viewer receives state');
      // Answering the server's sync step 1 (with nothing new) is not an attempted write.
      expect(viewer.hasControl('readonly')).toBe(false);

      viewer.map.set('title', 'Vandalised');
      viewer.map.set('extra', true);
      // The server tells the viewer that the update was dropped…
      await waitFor(() => viewer.hasControl('readonly'), 'readonly notice');

      // …keeps relaying everyone else's edits to it…
      owner.map.set('later', 1);
      await waitFor(() => viewer.map.get('later') === 1, 'viewer still receives updates');

      // …and nobody else ever sees the viewer's change, live or after a fresh sync.
      expect(owner.map.get('title')).toBe('Final');
      expect(owner.map.has('extra')).toBe(false);
      const fresh = await connect(api, project, 'project').whenSynced();
      expect(fresh.map.toJSON()).toEqual({ title: 'Final', later: 1 });

      // Not even via the handshake: a reconnecting viewer offers its local edits in sync step 2.
      const offline = new Y.Doc();
      Y.applyUpdate(offline, Y.encodeStateAsUpdate(viewer.doc));
      const sneaky = connect(api, project, 'project', viewerToken);
      Y.applyUpdate(sneaky.doc, Y.encodeStateAsUpdate(offline), sneaky);
      await sneaky.whenSynced();
      await waitFor(() => sneaky.hasControl('readonly'), 'readonly notice for step 2');
      const verify = await connect(api, project, 'project').whenSynced();
      expect(verify.map.toJSON()).toEqual({ title: 'Final', later: 1 });
    });

    it('lets commenters write the review document but not the project document', async () => {
      const project = await api.createProject();
      const commenterToken = await api.invite(project, 'commenter');
      const viewerToken = await api.invite(project, 'viewer');

      const ownerReview = await connect(api, project, 'review').whenSynced();
      const commenterReview = await connect(api, project, 'review', commenterToken).whenSynced();
      commenterReview.map.set('comment', 'Tighten this cut');
      await waitFor(
        () => ownerReview.map.get('comment') === 'Tighten this cut',
        'commenter → owner on review',
      );

      // Viewers cannot write the review document either.
      const viewerReview = await connect(api, project, 'review', viewerToken).whenSynced();
      viewerReview.map.set('comment', 'nope');
      await waitFor(() => viewerReview.hasControl('readonly'), 'viewer readonly on review');

      const ownerProject = await connect(api, project, 'project').whenSynced();
      const commenterProject = await connect(api, project, 'project', commenterToken).whenSynced();
      ownerProject.map.set('title', 'Mine');
      await waitFor(() => commenterProject.map.get('title') === 'Mine', 'commenter reads project');
      commenterProject.map.set('title', 'Hijacked');
      await waitFor(() => commenterProject.hasControl('readonly'), 'commenter readonly on project');

      ownerProject.map.set('marker', 1);
      await waitFor(() => commenterProject.map.get('marker') === 1, 'owner → commenter');
      expect(ownerProject.map.get('title')).toBe('Mine');
      expect(ownerReview.map.get('comment')).toBe('Tighten this cut');
      // The two documents of a project are separate rooms.
      expect(ownerProject.map.has('comment')).toBe(false);
    });

    it('drops connections that send malformed frames', async () => {
      const project = await api.createProject();
      const good = await connect(api, project, 'project').whenSynced();
      const bad = await connect(api, project, 'project').whenSynced();
      good.map.set('safe', true);
      bad.send(Uint8Array.from([0, 2, 5, 1, 2])); // sync update whose payload is cut short
      await waitFor(() => bad.closed, 'bad client closed');
      expect(bad.hasControl('error')).toBe(true);

      const fresh = await connect(api, project, 'project').whenSynced();
      expect(fresh.map.toJSON()).toEqual({ safe: true });
    });

    it('relays awareness, including from viewers, and removes it on disconnect', async () => {
      const project = await api.createProject();
      const viewerToken = await api.invite(project, 'viewer');
      const a = await connect(api, project, 'project').whenSynced();
      const b = await connect(api, project, 'project').whenSynced();

      a.awareness.setLocalState({ user: { name: 'Ada' }, playhead: 12 });
      await waitFor(() => b.awareness.getStates().has(a.doc.clientID), 'a visible to b');
      expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({ user: { name: 'Ada' }, playhead: 12 });

      a.awareness.setLocalStateField('playhead', 48);
      await waitFor(() => b.awareness.getStates().get(a.doc.clientID)?.playhead === 48, 'awareness update');

      // Someone joining later is told who is already there.
      const viewer = await connect(api, project, 'project', viewerToken).whenSynced();
      await waitFor(() => viewer.awareness.getStates().has(a.doc.clientID), 'a visible to late joiner');

      // Read-only users still show up in presence.
      viewer.awareness.setLocalState({ user: { name: 'Vera' } });
      await waitFor(() => a.awareness.getStates().has(viewer.doc.clientID), 'viewer visible to a');
      await waitFor(() => b.awareness.getStates().has(viewer.doc.clientID), 'viewer visible to b');

      // A socket that just disappears takes its presence with it.
      await a.close();
      await waitFor(() => !b.awareness.getStates().has(a.doc.clientID), 'a removed from b');
      await waitFor(() => !viewer.awareness.getStates().has(a.doc.clientID), 'a removed from viewer');
      expect(b.awareness.getStates().has(viewer.doc.clientID)).toBe(true);
    });
  });

  describe('media', () => {
    freshServer();

    const bytes = Buffer.alloc(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;

    const put = (
      path: string,
      token: string,
      body: Uint8Array,
      offset: number,
      total: number,
      type = 'video/mp4',
    ) =>
      api.fetch(path, {
        method: 'PUT',
        token,
        headers: { 'Upload-Offset': String(offset), 'Upload-Length': String(total), 'Content-Type': type },
        body,
      });

    it('uploads in chunks, resumes from the stored offset and serves ranges', async () => {
      const project = await api.createProject();
      const editor = await api.invite(project, 'editor');
      const viewer = await api.invite(project, 'viewer');
      const path = `/api/projects/${project.id}/media/asset_0001`;

      expect((await api.fetch(path, { method: 'HEAD', token: editor })).status).toBe(404);
      expect((await api.fetch(path, { token: editor })).status).toBe(404);

      // Chunk 1
      let res = await put(path, editor, bytes.subarray(0, 100_000), 0, bytes.length);
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-offset')).toBe('100000');
      expect(res.headers.get('upload-complete')).toBe('0');

      // HEAD reports progress; the asset is not downloadable yet.
      res = await api.fetch(path, { method: 'HEAD', token: viewer });
      expect(res.status).toBe(200);
      expect(res.headers.get('upload-offset')).toBe('100000');
      expect(res.headers.get('upload-complete')).toBe('0');
      expect((await api.fetch(path, { token: editor })).status).toBe(404);

      // Wrong offsets (behind and ahead) → 409 with the offset to resume from; nothing is written.
      for (const wrong of [0, 150_000]) {
        res = await put(path, editor, bytes.subarray(wrong, wrong + 50_000), wrong, bytes.length);
        expect(res.status).toBe(409);
        expect(res.headers.get('upload-offset')).toBe('100000');
        expect(await res.json()).toEqual({ error: expect.any(String) });
      }

      // Chunk 2 and 3
      res = await put(path, editor, bytes.subarray(100_000, 250_000), 100_000, bytes.length);
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-offset')).toBe('250000');
      expect(res.headers.get('upload-complete')).toBe('0');
      res = await put(path, editor, bytes.subarray(250_000), 250_000, bytes.length);
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-offset')).toBe('300000');
      expect(res.headers.get('upload-complete')).toBe('1');

      // On disk: the asset and its metadata, no leftover .part
      const mediaDir = join(dataDir, 'projects', project.id, 'media');
      expect((await readdir(mediaDir)).sort()).toEqual(['asset_0001', 'asset_0001.json']);
      expect(JSON.parse(await readFile(join(mediaDir, 'asset_0001.json'), 'utf8'))).toMatchObject({
        size: 300_000,
        type: 'video/mp4',
        completedAt: expect.any(Number),
      });

      // HEAD when complete
      res = await api.fetch(path, { method: 'HEAD', token: viewer });
      expect(res.status).toBe(200);
      expect(res.headers.get('upload-offset')).toBe('300000');
      expect(res.headers.get('upload-complete')).toBe('1');
      expect(res.headers.get('content-length')).toBe('300000');
      expect(res.headers.get('content-type')).toBe('video/mp4');

      // Uploading to a complete asset confirms completion without touching the file.
      const before = await stat(join(mediaDir, 'asset_0001'));
      res = await put(path, editor, Buffer.from('different bytes'), 0, 15);
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-offset')).toBe('300000');
      expect(res.headers.get('upload-complete')).toBe('1');
      const after = await stat(join(mediaDir, 'asset_0001'));
      expect(after.size).toBe(300_000);
      expect(after.mtimeMs).toBe(before.mtimeMs);

      // Full download (viewers may read; token via query string as a <video src> would)
      res = await api.fetch(`${path}?t=${viewer}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect(res.headers.get('content-length')).toBe('300000');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);

      // bytes=a-b
      res = await api.fetch(path, { token: viewer, headers: { Range: 'bytes=1000-1999' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 1000-1999/300000');
      expect(res.headers.get('content-length')).toBe('1000');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(1000, 2000))).toBe(true);

      // bytes=a-
      res = await api.fetch(path, { token: viewer, headers: { Range: 'bytes=299990-' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 299990-299999/300000');
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(299_990))).toBe(true);

      // bytes=-n
      res = await api.fetch(path, { token: viewer, headers: { Range: 'bytes=-500' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 299500-299999/300000');
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(299_500))).toBe(true);

      // An end beyond the file is clamped.
      res = await api.fetch(path, { token: viewer, headers: { Range: 'bytes=299000-999999999' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 299000-299999/300000');
      expect((await res.arrayBuffer()).byteLength).toBe(1000);

      // Unsatisfiable
      res = await api.fetch(path, { token: viewer, headers: { Range: 'bytes=300000-' } });
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe('bytes */300000');
      await res.arrayBuffer();

      // Delete (editor+)
      expect((await api.fetch(path, { method: 'DELETE', token: viewer })).status).toBe(403);
      expect((await api.fetch(path, { method: 'DELETE', token: editor })).status).toBe(204);
      expect((await api.fetch(path, { method: 'HEAD', token: editor })).status).toBe(404);
      expect(await readdir(mediaDir)).toEqual([]);
    });

    it('enforces roles, ids, required headers and the size limit', async () => {
      const project = await api.createProject();
      const viewer = await api.invite(project, 'viewer');
      const commenter = await api.invite(project, 'commenter');
      const base = `/api/projects/${project.id}/media`;
      const chunk = bytes.subarray(0, 1000);

      for (const token of [viewer, commenter]) {
        const res = await put(`${base}/asset_0002`, token, chunk, 0, 1000);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: expect.any(String) });
      }
      expect((await api.fetch(`${base}/asset_0002`, { method: 'HEAD', token: project.token })).status).toBe(
        404,
      );
      expect((await put(`${base}/asset_0002`, '', chunk, 0, 1000)).status).toBe(401);

      // Invalid asset ids: too short, illegal characters, traversal attempts.
      for (const id of ['abc', 'has.dot.in.it', 'white%20space', '..%2F..%2Fsecret', 'x'.repeat(65)]) {
        expect((await put(`${base}/${id}`, project.token, chunk, 0, 1000)).status, id).toBe(400);
        expect((await api.fetch(`${base}/${id}`, { token: project.token })).status, id).toBe(400);
      }

      const noLength = await api.fetch(`${base}/asset_0002`, {
        method: 'PUT',
        token: project.token,
        headers: { 'Upload-Offset': '0' },
        body: chunk,
      });
      expect(noLength.status).toBe(400);
      const noOffset = await api.fetch(`${base}/asset_0002`, {
        method: 'PUT',
        token: project.token,
        headers: { 'Upload-Length': '1000' },
        body: chunk,
      });
      expect(noOffset.status).toBe(400);
      // More bytes than declared.
      expect((await put(`${base}/asset_0002`, project.token, chunk, 0, 999)).status).toBe(400);
      expect((await api.fetch(`${base}/asset_0002`, { method: 'HEAD', token: project.token })).status).toBe(
        404,
      );

      const { api: small } = await start({ maxUploadBytes: 1000 });
      const tiny = await small.createProject();
      const tinyPath = `/api/projects/${tiny.id}/media/asset_0003`;
      const tooBig = await small.fetch(tinyPath, {
        method: 'PUT',
        token: tiny.token,
        headers: { 'Upload-Offset': '0', 'Upload-Length': '1001' },
        body: chunk,
      });
      expect(tooBig.status).toBe(413);
      const fits = await small.fetch(tinyPath, {
        method: 'PUT',
        token: tiny.token,
        headers: { 'Upload-Offset': '0', 'Upload-Length': '1000' },
        body: chunk,
      });
      expect(fits.status).toBe(204);
      expect(fits.headers.get('upload-complete')).toBe('1');
    });

    it('keeps the bytes of an interrupted upload and lets a new request take over', async () => {
      const project = await api.createProject();
      const path = `/api/projects/${project.id}/media/asset_resume`;
      const offsetNow = async (): Promise<number> => {
        const res = await api.fetch(path, { method: 'HEAD', token: project.token });
        return res.status === 200 ? Number(res.headers.get('upload-offset')) : -1;
      };

      // A request that promises the whole file, delivers 40 % of it and then stalls.
      const url = new URL(api.base);
      const stalled = httpRequest({
        host: url.hostname,
        port: url.port,
        path,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${project.token}`,
          'Upload-Offset': '0',
          'Upload-Length': String(bytes.length),
          'Content-Length': String(bytes.length),
          'Content-Type': 'video/mp4',
        },
      });
      const stalledEnded = new Promise<void>((resolve) => {
        stalled.on('error', () => resolve());
        stalled.on('close', () => resolve());
      });
      stalled.write(bytes.subarray(0, 120_000));
      // The server writes what it receives as it receives it.
      for (let i = 0; i < 300 && (await offsetNow()) !== 120_000; i++) await sleep(10);
      expect(await offsetNow()).toBe(120_000);

      // The client retries on a new connection while the old request is still open on the server.
      // The newcomer wins: the stalled request is aborted, its bytes are kept.
      let res = await put(path, project.token, bytes.subarray(120_000, 200_000), 120_000, bytes.length);
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-offset')).toBe('200000');
      expect(res.headers.get('upload-complete')).toBe('0');
      await stalledEnded;

      // A connection that simply dies mid-chunk leaves a resumable prefix behind, too.
      const dying = httpRequest({
        host: url.hostname,
        port: url.port,
        path,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${project.token}`,
          'Upload-Offset': '200000',
          'Upload-Length': String(bytes.length),
          'Content-Length': '100000',
        },
      });
      dying.on('error', () => undefined);
      dying.write(bytes.subarray(200_000, 230_000));
      for (let i = 0; i < 300 && (await offsetNow()) !== 230_000; i++) await sleep(10);
      dying.destroy();
      await sleep(30);
      expect(await offsetNow()).toBe(230_000);

      res = await put(path, project.token, bytes.subarray(230_000), 230_000, bytes.length);
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-complete')).toBe('1');
      res = await api.fetch(path, { token: project.token });
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it('is not wedged by clients that hang up right after sending', async () => {
      const project = await api.createProject();
      const path = `/api/projects/${project.id}/media/asset_hangup`;
      const url = new URL(api.base);
      const big = Buffer.alloc(4 * 1024 * 1024, 7);
      const total = big.length + 10;

      // Whole chunk written in one go, socket destroyed without waiting for the response.
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = await api.fetch(path, { method: 'HEAD', token: project.token });
        const offset = head.status === 200 ? Number(head.headers.get('upload-offset')) : 0;
        if (offset >= big.length) break;
        await new Promise<void>((resolve) => {
          const socket = netConnect(Number(url.port), url.hostname, () => {
            socket.write(
              `PUT ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${project.token}\r\n` +
                `Upload-Offset: ${offset}\r\nUpload-Length: ${total}\r\nContent-Length: ${big.length - offset}\r\n\r\n`,
            );
            socket.write(big.subarray(offset), () => {
              socket.destroy();
              resolve();
            });
          });
          socket.on('error', () => resolve());
        });
      }

      // Whatever arrived is a clean prefix, and the asset can still be finished and deleted.
      let offset = -1;
      for (let i = 0; i < 100; i++) {
        const head = await api.fetch(path, { method: 'HEAD', token: project.token });
        const now = head.status === 200 ? Number(head.headers.get('upload-offset')) : 0;
        if (now === offset) break;
        offset = now;
        await sleep(30);
      }
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(big.length);
      const rest = Buffer.concat([big.subarray(offset), Buffer.alloc(10, 9)]);
      const res = await put(path, project.token, rest, offset, total);
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-complete')).toBe('1');
      const body = Buffer.from(await (await api.fetch(path, { token: project.token })).arrayBuffer());
      expect(body.equals(Buffer.concat([big, Buffer.alloc(10, 9)]))).toBe(true);
      expect((await api.fetch(path, { method: 'DELETE', token: project.token })).status).toBe(204);
    });

    it('stores empty assets and falls back to a safe content type', async () => {
      const project = await api.createProject();
      const path = `/api/projects/${project.id}/media/empty_asset`;
      const res = await put(path, project.token, new Uint8Array(0), 0, 0, 'text/html ;<script>');
      expect(res.status).toBe(204);
      expect(res.headers.get('upload-complete')).toBe('1');

      const get = await api.fetch(path, { token: project.token });
      expect(get.status).toBe(200);
      expect(get.headers.get('content-type')).toBe('application/octet-stream');
      expect(get.headers.get('content-length')).toBe('0');
      expect(get.headers.get('content-security-policy')).toBe('sandbox');
      expect((await get.arrayBuffer()).byteLength).toBe(0);
      expect((await api.fetch(path, { token: project.token, headers: { Range: 'bytes=0-0' } })).status).toBe(
        416,
      );
    });
  });

  describe('versions', () => {
    freshServer();

    it('creates, lists and serves versions of the project document', async () => {
      const project = await api.createProject();
      const editor = await api.invite(project, 'editor');
      const viewer = await api.invite(project, 'viewer');
      const path = `/api/projects/${project.id}/versions`;

      const client = await connect(api, project, 'project').whenSynced();
      client.map.set('title', 'v1');
      client.doc.getArray<number>('track').push([1, 2, 3]);
      const watcher = await connect(api, project, 'project', viewer).whenSynced();
      await waitFor(() => watcher.doc.getArray('track').length === 3, 'server has v1');

      expect(await (await api.fetch(path, { token: viewer })).json()).toEqual([]);

      let res = await api.json(path, { name: 'First cut', author: 'Ada' }, editor);
      expect(res.status).toBe(200);
      const first = (await res.json()) as VersionInfo;
      expect(first).toEqual({
        id: expect.stringMatching(/^[A-Za-z0-9_-]{6,64}$/),
        name: 'First cut',
        author: 'Ada',
        auto: false,
        createdAt: expect.any(Number),
      });
      const expectedState = content(client.doc);

      // Change the document, then take a second version.
      client.map.set('title', 'v2');
      await waitFor(() => watcher.map.get('title') === 'v2', 'server has v2');
      await sleep(5); // distinct createdAt
      res = await api.json(path, { name: 'Second cut' }, project.token);
      const second = (await res.json()) as VersionInfo;
      expect(second).toMatchObject({ name: 'Second cut', author: '', auto: false });

      // Newest first; readable by any role.
      const list = (await (await api.fetch(path, { token: viewer })).json()) as VersionInfo[];
      expect(list).toEqual([second, first]);

      // The binary is the document as it was when the version was taken.
      res = await api.fetch(`${path}/${first.id}`, { token: viewer });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      const restored = new Y.Doc();
      Y.applyUpdate(restored, new Uint8Array(await res.arrayBuffer()));
      expect(content(restored)).toEqual(expectedState);
      expect(expectedState).toMatchObject({ test: { title: 'v1' }, track: [1, 2, 3] });
      expect(restored.getMap('test').get('title')).toBe('v1');

      const latest = new Y.Doc();
      Y.applyUpdate(
        latest,
        new Uint8Array(await (await api.fetch(`${path}/${second.id}`, { token: viewer })).arrayBuffer()),
      );
      expect(content(latest)).toEqual(content(client.doc));
      expect(Y.encodeStateVector(latest)).toEqual(Y.encodeStateVector(client.doc));

      // Stored where the brief says.
      const dir = join(dataDir, 'projects', project.id);
      expect((await readdir(join(dir, 'versions'))).sort()).toEqual(
        [`${first.id}.bin`, `${second.id}.bin`].sort(),
      );
      expect(JSON.parse(await readFile(join(dir, 'versions.json'), 'utf8'))).toHaveLength(2);

      // Permissions and validation.
      expect((await api.json(path, { name: 'nope' }, viewer)).status).toBe(403);
      expect((await api.json(path, { name: 42 }, editor)).status).toBe(400);
      expect((await api.fetch(`${path}/unknownVersion`, { token: viewer })).status).toBe(404);
      expect((await api.fetch(`${path}/bad!id`, { token: viewer })).status).toBe(400);
      expect((await api.fetch(`${path}/${first.id}`)).status).toBe(401);
    });

    it('versions a project nobody is connected to', async () => {
      const project = await api.createProject();
      const res = await api.json(`/api/projects/${project.id}/versions`, { name: 'Empty' }, project.token);
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as VersionInfo;
      const bin = await api.fetch(`/api/projects/${project.id}/versions/${id}`, { token: project.token });
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(await bin.arrayBuffer()));
      expect(Y.encodeStateAsUpdate(doc)).toEqual(Y.encodeStateAsUpdate(new Y.Doc()));
    });
  });
});

describe('automatic versions', () => {
  it('snapshots a changed project on a timer, and only when it changed', async () => {
    const { api } = await start({ autoSnapshotMs: 40 });
    const project = await api.createProject();
    const path = `/api/projects/${project.id}/versions`;
    const list = async () =>
      (await (await api.fetch(path, { token: project.token })).json()) as VersionInfo[];

    const client = await connect(api, project, 'project').whenSynced();
    await sleep(120);
    expect(await list()).toEqual([]); // nothing changed, nothing to snapshot

    client.map.set('n', 1);
    let versions: VersionInfo[] = [];
    for (let i = 0; i < 100 && versions.length === 0; i++) {
      await sleep(20);
      versions = await list();
    }
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ auto: true, name: 'Auto-save' });

    // Unchanged since the snapshot → no further versions.
    await sleep(150);
    expect(await list()).toHaveLength(1);

    const bin = await api.fetch(`${path}/${versions[0].id}`, { token: project.token });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await bin.arrayBuffer()));
    expect(doc.getMap('test').get('n')).toBe(1);
  });

  it('keeps at most 50 automatic versions and never prunes named ones', async () => {
    const { VersionStore, MAX_AUTO_VERSIONS } = await import('../src/versions');
    const { ProjectStore } = await import('../src/projects');
    const dataDir = await tempDir();
    await mkdir(join(dataDir, 'projects'), { recursive: true });
    const projects = new ProjectStore(dataDir);
    const versions = new VersionStore(projects);
    const { id } = await projects.create('p');

    const named = await versions.create(
      id,
      { name: 'keep me', author: '', auto: false },
      new Uint8Array([0, 0]),
    );
    const autos: VersionInfo[] = [];
    for (let i = 0; i < MAX_AUTO_VERSIONS + 5; i++) {
      autos.push(
        await versions.create(id, { name: 'Auto-save', author: '', auto: true }, new Uint8Array([0, 0])),
      );
    }
    const list = await versions.list(id);
    expect(list.filter((v) => v.auto)).toHaveLength(MAX_AUTO_VERSIONS);
    expect(list.some((v) => v.id === named.id)).toBe(true);
    // The five oldest automatic versions are gone, index entry and file.
    const kept = new Set(list.map((v) => v.id));
    expect(autos.slice(0, 5).some((v) => kept.has(v.id))).toBe(false);
    expect(autos.slice(5).every((v) => kept.has(v.id))).toBe(true);
    expect(await readdir(join(projects.dir(id), 'versions'))).toHaveLength(MAX_AUTO_VERSIONS + 1);
  });
});

describe('persistence', () => {
  it('keeps documents, tokens and media across a restart', async () => {
    const first = await start();
    const project = await first.api.createProject('Persistent');
    const viewerToken = await first.api.invite(project, 'viewer');

    const writer = await connect(first.api, project, 'project').whenSynced();
    const reviewer = await connect(first.api, project, 'review').whenSynced();
    const text = writer.doc.getText('script');
    text.insert(0, 'Hello, world');
    text.delete(5, 7); // deletions must survive too
    writer.map.set('clips', ['a', 'b']);
    reviewer.map.set('comment', 'Nice');

    // Make sure the server has seen everything before it is asked to stop.
    const observer = await connect(first.api, project, 'project', viewerToken).whenSynced();
    const reviewObserver = await connect(first.api, project, 'review', viewerToken).whenSynced();
    await waitFor(
      () => observer.doc.getText('script').toString() === 'Hello' && observer.map.has('clips'),
      'project synced',
    );
    await waitFor(() => reviewObserver.map.get('comment') === 'Nice', 'review synced');
    const expected = content(writer.doc);

    const asset = Buffer.from('not really a video');
    const mediaPath = `/api/projects/${project.id}/media/asset_keep`;
    const upload = await first.api.fetch(mediaPath, {
      method: 'PUT',
      token: project.token,
      headers: { 'Upload-Offset': '0', 'Upload-Length': String(asset.length), 'Content-Type': 'video/webm' },
      body: asset,
    });
    expect(upload.headers.get('upload-complete')).toBe('1');

    await first.server.close();
    await waitFor(() => writer.closed && observer.closed, 'clients disconnected by shutdown');

    // Shutdown compacts: a snapshot per document, nothing left in the logs.
    const dir = join(first.dataDir, 'projects', project.id);
    expect((await stat(join(dir, 'project.snapshot'))).size).toBeGreaterThan(0);
    expect((await stat(join(dir, 'review.snapshot'))).size).toBeGreaterThan(0);
    expect((await stat(join(dir, 'project.log'))).size).toBe(0);
    expect((await stat(join(dir, 'review.log'))).size).toBe(0);

    const second = await start({ dataDir: first.dataDir });
    // Same secret → the old tokens still work.
    const info = await second.api.fetch(`/api/projects/${project.id}`, { token: project.token });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ id: project.id, role: 'owner', name: 'Persistent' });

    const reader = await connect(second.api, project, 'project', viewerToken).whenSynced();
    expect(reader.doc.getText('script').toString()).toBe('Hello');
    expect(reader.map.get('clips')).toEqual(['a', 'b']);
    expect(content(reader.doc)).toEqual(expected);
    const reviewReader = await connect(second.api, project, 'review', viewerToken).whenSynced();
    expect(reviewReader.map.get('comment')).toBe('Nice');

    // The state at the end of the first session was captured as an automatic version on shutdown.
    const versions = (await (
      await second.api.fetch(`/api/projects/${project.id}/versions`, { token: viewerToken })
    ).json()) as VersionInfo[];
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ auto: true });
    const versionBin = await second.api.fetch(`/api/projects/${project.id}/versions/${versions[0].id}`, {
      token: viewerToken,
    });
    const versionDoc = new Y.Doc();
    Y.applyUpdate(versionDoc, new Uint8Array(await versionBin.arrayBuffer()));
    expect(content(versionDoc)).toEqual(expected);

    const download = await second.api.fetch(mediaPath, { token: viewerToken });
    expect(download.headers.get('content-type')).toBe('video/webm');
    expect(Buffer.from(await download.arrayBuffer()).equals(asset)).toBe(true);

    // And the document can keep growing from where it was.
    const editor = await connect(second.api, project, 'project').whenSynced();
    editor.doc.getText('script').insert(5, '!');
    await waitFor(() => reader.doc.getText('script').toString() === 'Hello!', 'edit after restart');
  });

  it('bumps updatedAt when a document changes', async () => {
    const { api, server, dataDir } = await start();
    const project = await api.createProject();
    const created = (
      (await (await api.fetch(`/api/projects/${project.id}`, { token: project.token })).json()) as ProjectInfo
    ).createdAt;
    await sleep(15);
    const client = await connect(api, project, 'project').whenSynced();
    client.map.set('x', 1);
    const observer = await connect(api, project, 'project').whenSynced();
    await waitFor(() => observer.map.get('x') === 1, 'synced');
    const live = (await (
      await api.fetch(`/api/projects/${project.id}`, { token: project.token })
    ).json()) as ProjectInfo;
    expect(live.updatedAt).toBeGreaterThan(created);

    await server.close();
    const meta = JSON.parse(await readFile(join(dataDir, 'projects', project.id, 'meta.json'), 'utf8'));
    expect(meta.updatedAt).toBe(live.updatedAt);
    expect(meta.createdAt).toBe(created);
  });

  it('unloads idle rooms after persisting them and reloads on demand', async () => {
    const { api, dataDir } = await start({ roomIdleMs: 50 });
    const project = await api.createProject();
    const dir = join(dataDir, 'projects', project.id);

    const writer = await connect(api, project, 'project').whenSynced();
    writer.map.set('kept', 'yes');
    const observer = await connect(api, project, 'project').whenSynced();
    await waitFor(() => observer.map.get('kept') === 'yes', 'synced');
    await writer.close();
    await observer.close();

    // Once the room is unloaded its state lives in the snapshot and the log is empty again.
    let compacted = false;
    for (let i = 0; i < 200 && !compacted; i++) {
      await sleep(10);
      const snapshot = await stat(join(dir, 'project.snapshot')).catch(() => null);
      const log = await stat(join(dir, 'project.log')).catch(() => null);
      compacted = snapshot !== null && snapshot.size > 0 && log !== null && log.size === 0;
    }
    expect(compacted).toBe(true);

    const reader = await connect(api, project, 'project').whenSynced();
    expect(reader.map.get('kept')).toBe('yes');
  });
});

describe('shutdown', () => {
  it('closes promptly and cleanly with clients connected and an upload in flight', async () => {
    const { api, server, dataDir } = await start({ autoSnapshotMs: 0 });
    const project = await api.createProject();
    const client = await connect(api, project, 'project').whenSynced();
    client.map.set('unsaved', 'not for long');
    // No waiting for an echo here: whatever the server has received when close() is called must be kept.
    const observer = await connect(api, project, 'project').whenSynced();
    await waitFor(() => observer.map.get('unsaved') === 'not for long', 'server received the edit');

    const url = new URL(api.base);
    const path = `/api/projects/${project.id}/media/asset_inflight`;
    const upload = httpRequest({
      host: url.hostname,
      port: url.port,
      path,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${project.token}`,
        'Upload-Offset': '0',
        'Upload-Length': '100000',
        'Content-Length': '100000',
      },
    });
    const uploadEnded = new Promise<void>((resolve) => {
      upload.on('error', () => resolve());
      upload.on('close', () => resolve());
    });
    upload.write(Buffer.alloc(30_000, 1));
    const partPath = join(dataDir, 'projects', project.id, 'media', 'asset_inflight.part');
    for (let i = 0; i < 300; i++) {
      if (((await stat(partPath).catch(() => null))?.size ?? 0) === 30_000) break;
      await sleep(10);
    }

    const started = Date.now();
    await Promise.all([server.close(), server.close()]); // idempotent
    expect(Date.now() - started).toBeLessThan(4000);
    await uploadEnded;
    await waitFor(() => client.closed && observer.closed, 'sockets closed');

    // Nothing accepts connections any more.
    await expect(fetch(`${api.base}/api/health`)).rejects.toThrow();

    // The document is in its snapshot, the partial upload is still there to be resumed.
    const dir = join(dataDir, 'projects', project.id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await readFile(join(dir, 'project.snapshot')));
    expect(doc.getMap('test').get('unsaved')).toBe('not for long');
    expect((await stat(partPath)).size).toBe(30_000);
    // autoSnapshotMs: 0 switches automatic versions off entirely.
    await expect(stat(join(dir, 'versions.json'))).rejects.toThrow();
  });
});

describe('project creation policy', () => {
  it('refuses to create projects when openCreate is off', async () => {
    const { api } = await start({ openCreate: false });
    const res = await api.json('/api/projects', { name: 'x' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('rate limits project creation per address', async () => {
    const { api } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await api.json('/api/projects', {})).status);
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const limited = await api.json('/api/projects', {});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Other endpoints are unaffected.
    expect((await api.fetch('/api/health')).status).toBe(200);
  });

  it('rate limits by the address the proxy reports when trustProxy is on', async () => {
    const { api } = await start({ trustProxy: true });
    const create = (forwardedFor: string): Promise<number> =>
      api
        .fetch('/api/projects', { method: 'POST', headers: { 'X-Forwarded-For': forwardedFor } })
        .then((res) => res.status);
    for (let i = 0; i < 30; i++) expect(await create('203.0.113.9')).toBe(200);
    expect(await create('203.0.113.9')).toBe(429);
    // Only the entry appended by the proxy counts; a forged prefix does not buy a fresh quota.
    expect(await create('198.51.100.1, 203.0.113.9')).toBe(429);
    expect(await create('203.0.113.9, 198.51.100.1')).toBe(200);
    expect(await create('203.0.113.10')).toBe(200);
  });

  it('rate limits invites per address', async () => {
    const { api } = await start();
    const project = await api.createProject();
    const path = `/api/projects/${project.id}/invites`;
    const statuses = await Promise.all(
      Array.from({ length: 125 }, () =>
        api.json(path, { role: 'viewer' }, project.token).then((r) => r.status),
      ),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(120);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    // Rejected attempts by roles that cannot invite do not count, and reads are not limited.
    expect((await api.fetch(`/api/projects/${project.id}`, { token: project.token })).status).toBe(200);
  });

  it('honours a configured CORS origin', async () => {
    const { api } = await start({ corsOrigin: 'https://tandem.example' });
    const res = await api.fetch('/api/health');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://tandem.example');
  });
});

describe('static hosting', () => {
  it('serves the site at / and the editor at /app/ with SPA fallback', async () => {
    const root = await tempDir();
    const siteDist = join(root, 'site');
    const editorDist = join(root, 'editor');
    await mkdir(join(siteDist, 'assets'), { recursive: true });
    await mkdir(join(editorDist, 'assets'), { recursive: true });
    await writeFile(join(siteDist, 'index.html'), '<h1>site</h1>');
    await writeFile(join(siteDist, 'assets', 'site-abc123.css'), 'body{}');
    await writeFile(join(siteDist, 'robots.txt'), 'User-agent: *');
    await writeFile(join(editorDist, 'index.html'), '<div id="app">editor</div>');
    await writeFile(join(editorDist, 'assets', 'index-abc123.js'), 'console.log(1)');
    await writeFile(join(editorDist, '.env'), 'SECRET=1');
    await writeFile(join(root, 'secret.txt'), 'top secret');

    const { api, server } = await start({ siteDist, editorDist });

    let res = await api.fetch('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('<h1>site</h1>');

    res = await api.fetch('/assets/site-abc123.css');
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    res = await api.fetch('/robots.txt');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect((await api.fetch('/missing')).status).toBe(404);

    // Editor
    res = await api.fetch('/app', { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/app/');
    res = await api.fetch('/app/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<div id="app">editor</div>');
    expect(res.headers.get('cache-control')).toBe('no-cache');

    res = await api.fetch('/app/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log(1)');

    // Client-side routes get the app shell; missing files do not.
    res = await api.fetch('/app/p/someProjectId123?t=token');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<div id="app">editor</div>');
    expect((await api.fetch('/app/assets/missing-000.js')).status).toBe(404);

    // Conditional requests and HEAD
    const etag = res.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    res = await api.fetch('/app/', { headers: { 'If-None-Match': etag } });
    expect(res.status).toBe(304);
    res = await api.fetch('/app/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String('<div id="app">editor</div>'.length));
    expect((await api.fetch('/app/', { method: 'POST' })).status).toBe(405);

    // Nothing outside the build directories, and no dotfiles.
    for (const path of [
      '/app/../../secret.txt',
      '/app/..%2F..%2Fsecret.txt',
      '/app/%2e%2e/%2e%2e/secret.txt',
      '/../secret.txt',
      '/..%2Fsecret.txt',
      '/app/.env',
      '/app/assets/../../secret.txt',
      '/app/%00',
      '/app/%zz',
    ]) {
      const raw = await rawGet(server.url, path);
      expect([400, 404], path).toContain(raw.status);
      expect(raw.body, path).not.toContain('top secret');
      expect(raw.body, path).not.toContain('SECRET');
    }

    // The API keeps working next to the static mounts.
    expect((await api.fetch('/api/health')).status).toBe(200);
  });
});
