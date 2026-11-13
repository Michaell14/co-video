/** Test utilities: temp data dirs, a tiny HTTP wrapper and a minimal Yjs WebSocket client. */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { WS_MSG_AWARENESS, WS_MSG_CONTROL, WS_MSG_SYNC } from '@tandem/core';
import type { ControlMessage, DocKind, Role } from '@tandem/core';
import { createTandemServer } from '../src/server';
import type { TandemServer, TandemServerOptions } from '../src/server';

const tempDirs: string[] = [];

export async function tempDir(prefix = 'tandem-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function waitFor(condition: () => boolean, what = 'condition', timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Plain-data view of the shared types the tests use. (`doc.toJSON()` would not do: it only sees
 * root types that were already instantiated on that particular Y.Doc.)
 */
export function content(doc: Y.Doc): Record<string, unknown> {
  return {
    test: doc.getMap('test').toJSON(),
    clips: doc.getArray('clips').toJSON(),
    track: doc.getArray('track').toJSON(),
    script: doc.getText('script').toString(),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Servers and clients for the tests of one file. Clients are closed after each test and servers
 * after the last one, so a test only has to start what it needs.
 */
export function useServers(): {
  clients: TestClient[];
  start(options?: Partial<TandemServerOptions>): Promise<{ server: TandemServer; api: Api; dataDir: string }>;
  connect(api: Api, project: Project, doc: string, token?: string): TestClient;
} {
  const servers: TandemServer[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });
  afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await removeTempDirs();
  });

  return {
    clients,
    async start(options = {}) {
      const dataDir = options.dataDir ?? (await tempDir());
      // Point the static mounts at nothing unless a test asks for them, whatever happens to be built.
      const missing = join(dataDir, 'no-such-dist');
      const server = await createTandemServer({
        editorDist: missing,
        siteDist: missing,
        ...options,
        dataDir,
      });
      servers.push(server);
      return { server, api: new Api(server.url), dataDir };
    },
    connect(api, project, doc, token = project.token) {
      const client = new TestClient(api.wsUrl(project.id, doc, token));
      clients.push(client);
      return client;
    },
  };
}

export interface Project {
  id: string;
  token: string;
}

/** Thin wrapper around fetch for one server. */
export class Api {
  constructor(readonly base: string) {}

  fetch(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
    return fetch(this.base + path, { ...init, headers });
  }

  json(path: string, body: unknown, token?: string): Promise<Response> {
    return this.fetch(path, {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async createProject(name?: string): Promise<Project> {
    const res = await this.json('/api/projects', name === undefined ? {} : { name });
    if (res.status !== 200) throw new Error(`create project failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as Project;
  }

  async invite(project: Project, role: Role, token = project.token): Promise<string> {
    const res = await this.json(`/api/projects/${project.id}/invites`, { role }, token);
    if (res.status !== 200) throw new Error(`invite failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { token: string }).token;
  }

  wsUrl(projectId: string, doc: DocKind | string, token: string): string {
    return `${this.base.replace(/^http/, 'ws')}/ws/${projectId}/${doc}?t=${encodeURIComponent(token)}`;
  }
}

/** A request whose path is sent exactly as given (fetch would normalise `..` away). */
export function rawGet(
  base: string,
  path: string,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = request({ host: url.hostname, port: url.port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * The client half of the wire protocol, as small as it gets: answer sync messages, forward local
 * document and awareness changes, record control frames.
 */
export class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly controls: ControlMessage[] = [];
  /** True once the server answered our sync step 1, i.e. we hold the server's state. */
  synced = false;
  /** How many times the server sent its state in answer to a sync step 1. */
  answers = 0;
  /** How many presence messages the server sent, and how many of them ahead of its state. */
  presenceMessages = 0;
  presenceBeforeSync = 0;
  closed = false;
  /** The code the connection was closed with, once it is. */
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.awareness.setLocalState(null);
    this.ws = new WebSocket(url, { headers });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ready.catch(() => undefined);

    this.ws.on('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, WS_MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.ws.send(encoding.toUint8Array(encoder));
    });
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)));

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // came from the server
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, WS_MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    });
    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === this) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, WS_MSG_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
        );
        this.send(encoding.toUint8Array(encoder));
      },
    );
  }

  private onMessage(message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    switch (decoding.readVarUint(decoder)) {
      case WS_MSG_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, WS_MSG_SYNC);
        const type = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
        if (type === syncProtocol.messageYjsSyncStep2) {
          this.synced = true;
          this.answers++;
        }
        break;
      }
      case WS_MSG_AWARENESS:
        this.presenceMessages++;
        if (!this.synced) this.presenceBeforeSync++;
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        break;
      case WS_MSG_CONTROL:
        this.controls.push(JSON.parse(decoding.readVarString(decoder)) as ControlMessage);
        break;
      default:
        throw new Error('unexpected frame type');
    }
  }

  send(frame: Uint8Array | string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  /** Ask for the document once more, as the handshake does when the connection opens. */
  requestSync(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, WS_MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));
  }

  /** Stop taking anything off the socket, like a client whose link has stalled. */
  stall(): void {
    this.ws.pause();
  }

  resume(): void {
    this.ws.resume();
  }

  /**
   * Take what one turn of the event loop reads off the socket (a couple of megabytes at the most)
   * and stall again: a link that is slow, not dead.
   */
  async readABit(): Promise<void> {
    this.ws.resume();
    await new Promise((resolve) => setImmediate(resolve));
    this.ws.pause();
  }

  /** Cut the connection without a closing handshake. */
  drop(): void {
    this.ws.terminate();
  }

  /** Resolves when connected, whether or not the server has sent its state yet. */
  whenOpen(): Promise<void> {
    return this.ready;
  }

  /** Resolves when connected and in sync with the server. */
  async whenSynced(): Promise<this> {
    await this.ready;
    await waitFor(() => this.synced, 'initial sync');
    return this;
  }

  get map(): Y.Map<unknown> {
    return this.doc.getMap('test');
  }

  hasControl(type: ControlMessage['type']): boolean {
    return this.controls.some((message) => message.type === type);
  }

  async close(): Promise<void> {
    if (!this.closed && this.ws.readyState !== WebSocket.CLOSED) {
      const done = new Promise((resolve) => this.ws.once('close', resolve));
      this.ws.close();
      await done;
    }
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/** An awareness frame written by hand, so it can carry states no real client would produce. */
export function awarenessFrame(entries: { clientId: number; clock: number; state: string }[]): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, entries.length);
  for (const { clientId, clock, state } of entries) {
    encoding.writeVarUint(update, clientId);
    encoding.writeVarUint(update, clock);
    encoding.writeVarString(update, state);
  }
  const frame = encoding.createEncoder();
  encoding.writeVarUint(frame, WS_MSG_AWARENESS);
  encoding.writeVarUint8Array(frame, encoding.toUint8Array(update));
  return encoding.toUint8Array(frame);
}

/** One unfragmented binary frame as a client has to send it: masked (a zero key leaves the payload as it is). */
function clientFrame(payload: Uint8Array): Buffer {
  if (payload.length > 0xffff) throw new Error('frame too large for this helper');
  const header =
    payload.length < 126
      ? [0x82, 0x80 | payload.length]
      : [0x82, 0x80 | 126, payload.length >> 8, payload.length & 0xff];
  return Buffer.concat([Buffer.from(header), Buffer.alloc(4), payload]);
}

/**
 * A WebSocket peer on a bare TCP socket: it completes the handshake, sends `frames` and from then
 * on answers nothing, not even a ping or a close frame, so its connection lingers on the server.
 */
export class SilentPeer {
  /** True once the server has ended the connection. */
  ended = false;
  private received = Buffer.alloc(0);
  private upgraded = false;
  private readonly socket: Socket;

  constructor(url: string, frames: Uint8Array[]) {
    const { hostname, port, host, pathname, search } = new URL(url);
    this.socket = netConnect(Number(port), hostname, () => {
      this.socket.write(
        `GET ${pathname}${search} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
      );
    });
    this.socket.on('data', (chunk: Buffer) => {
      this.received = Buffer.concat([this.received, chunk]);
      if (this.upgraded || !this.received.includes('\r\n\r\n')) return;
      this.upgraded = true;
      for (const frame of frames) this.socket.write(clientFrame(frame));
    });
    this.socket.on('error', () => undefined);
    this.socket.on('close', () => {
      this.ended = true;
    });
  }

  /** True once the handshake is done and the frames given at the start have been sent. */
  get joined(): boolean {
    return this.upgraded;
  }

  /** Send one more frame. */
  send(frame: Uint8Array): void {
    this.socket.write(clientFrame(frame));
  }

  /** True once the server sent `text` (control frames carry their JSON as plain UTF-8). */
  heard(text: string): boolean {
    return this.received.includes(text);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** Attempt a WebSocket connection that is expected to be refused; resolves with the HTTP status. */
export function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.on('open', () => {
      ws.terminate();
      reject(new Error('connection was accepted'));
    });
    ws.on('error', () => undefined);
  });
}
