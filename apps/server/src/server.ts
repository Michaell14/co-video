/**
 * Tandem collaboration + media server.
 *
 * One Node process, one data directory, no database:
 *   HTTP  /api/…                 projects, invites, versions, media   (api.ts, media.ts)
 *   WS    /ws/:projectId/:doc    Yjs sync + awareness                 (rooms.ts)
 *   HTTP  everything else        the built site and editor, if present (static.ts)
 */
import { mkdir } from 'node:fs/promises';
import { STATUS_CODES, createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { createApiHandler } from './api';
import { TokenAuthority, extractToken, loadOrCreateSecret } from './auth';
import { HttpError, applySecurityHeaders, clientIp, parseRequestUrl, sendError } from './http';
import { MediaStore } from './media';
import { ProjectStore } from './projects';
import { ConcurrencyLimiter, RateLimiter } from './rateLimit';
import { DEFAULT_MAX_CONNECTIONS_PER_ROOM, DEFAULT_ROOM_IDLE_MS, RoomManager, isDocKind } from './rooms';
import { createStaticHandler } from './static';
import { delay, isValidId } from './util';
import { AUTO_VERSION_NAME, VersionStore } from './versions';

export const SERVER_VERSION: string = packageJson.version;

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 ** 3;
const DEFAULT_AUTO_SNAPSHOT_MS = 10 * 60 * 1000;
/** Projects one client address may create per hour. */
export const DEFAULT_CREATES_PER_HOUR = 30;
const INVITES_PER_HOUR = 120;
/**
 * Open WebSockets per client address. A backstop against one client exhausting memory, not a
 * quota: an office behind one NAT shares an address, and each editor tab holds two sockets.
 */
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 200;
/** Sockets that neither send nor receive anything for this long are closed (stalled transfers, idle keep-alive). */
const SOCKET_IDLE_MS = 120_000;
/** On shutdown, how long requests that are already running get to finish before their sockets are closed. */
const SHUTDOWN_GRACE_MS = 2000;

/** `apps/server`, whether this runs from `src/` (tsx, vitest) or from the bundle in `dist/`. */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface TandemServerOptions {
  /** Where everything is stored: the token secret and one directory per project. */
  dataDir: string;
  /** TCP port; `0` (the default) lets the OS pick a free one. */
  port?: number;
  /** Interface to bind. Defaults to loopback; pass `0.0.0.0` to accept remote connections. */
  host?: string;
  /** Value of `Access-Control-Allow-Origin` on API responses. Default `*`. */
  corsOrigin?: string;
  /** Built editor, served at `/app/`. Default `../editor/dist` next to the server package. */
  editorDist?: string;
  /** Built site, served at `/`. Default `../site/dist` next to the server package. */
  siteDist?: string;
  /** Largest asset that may be uploaded. Default 20 GiB. */
  maxUploadBytes?: number;
  /** Interval of automatic versions while a project changes. Default 10 minutes; `0` disables them. */
  autoSnapshotMs?: number;
  /** Whether `POST /api/projects` is open to anyone. Default true. */
  openCreate?: boolean;
  /** Projects one client address may create per hour. Default 30. */
  createsPerHour?: number;
  /** Tell clients apart by the address a reverse proxy reports in `X-Forwarded-For`. Default false. */
  trustProxy?: boolean;
  /** WebSockets one client address may hold open at a time. Default 200. */
  maxConnectionsPerIp?: number;
  /** WebSockets one room (a document of a project) holds at a time. Default 100. */
  maxConnectionsPerRoom?: number;
  /** How long a room without connections stays in memory. Default 30 s. */
  roomIdleMs?: number;
}

export interface TandemServer {
  /** The port actually bound (useful with `port: 0`). */
  port: number;
  /** A URL the server can be reached at from this machine. */
  url: string;
  /** Stop accepting work, disconnect clients, write every document to disk. Idempotent. */
  close(): Promise<void>;
}

/** Answer a WebSocket upgrade request with a plain HTTP error and close the socket. */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  // Do not wait for the peer to close its half: once our answer is flushed, drop the socket.
  socket.once('finish', () => socket.destroy());
  socket.end(
    [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`,
      'Connection: close',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: no-referrer',
      '',
      body,
    ].join('\r\n'),
  );
}

export async function createTandemServer(options: TandemServerOptions): Promise<TandemServer> {
  const dataDir = resolve(options.dataDir);
  const host = options.host ?? '127.0.0.1';
  const autoSnapshotMs = Math.max(0, options.autoSnapshotMs ?? DEFAULT_AUTO_SNAPSHOT_MS);
  const trustProxy = options.trustProxy ?? false;

  await mkdir(resolve(dataDir, 'projects'), { recursive: true });
  const auth = new TokenAuthority(await loadOrCreateSecret(dataDir));
  const projects = new ProjectStore(dataDir);
  const versions = new VersionStore(projects);
  const media = new MediaStore(projects, options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
  const rooms = new RoomManager({
    autoSnapshotMs,
    roomIdleMs: options.roomIdleMs ?? DEFAULT_ROOM_IDLE_MS,
    maxConnectionsPerRoom: options.maxConnectionsPerRoom ?? DEFAULT_MAX_CONNECTIONS_PER_ROOM,
    projectDir: (projectId) => projects.dir(projectId),
    onDocChanged: (projectId) => projects.touch(projectId),
    saveAutoVersion: async (projectId, state) => {
      await versions.create(projectId, { name: AUTO_VERSION_NAME, author: '', auto: true }, state);
    },
  });

  const handleApi = createApiHandler({
    auth,
    projects,
    rooms,
    versions,
    media,
    version: SERVER_VERSION,
    corsOrigin: options.corsOrigin ?? '*',
    openCreate: options.openCreate ?? true,
    trustProxy,
    createLimiter: new RateLimiter(options.createsPerHour ?? DEFAULT_CREATES_PER_HOUR, HOUR_MS),
    inviteLimiter: new RateLimiter(INVITES_PER_HOUR, HOUR_MS),
  });
  const handleStatic = createStaticHandler({
    siteDist: options.siteDist ?? resolve(PACKAGE_DIR, '../site/dist'),
    editorDist: options.editorDist ?? resolve(PACKAGE_DIR, '../editor/dist'),
  });

  /** Requests whose response has not finished yet; shutdown gives them a moment. */
  let activeRequests = 0;

  const server = createServer((req, res) => {
    activeRequests++;
    res.once('close', () => activeRequests--);
    applySecurityHeaders(res);

    const { pathname, search, query } = parseRequestUrl(req.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      void handleApi(req, res, pathname, query);
    } else if (pathname.startsWith('/ws/')) {
      // A plain request to the WebSocket endpoint (upgrades never reach this handler).
      sendError(res, 426, 'this endpoint only speaks WebSocket', {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
      });
    } else if (handleStatic) {
      void handleStatic(req, res, pathname, search);
    } else {
      sendError(res, 404, 'not found');
    }
  });

  // Node's default limits the *whole* request to five minutes, which a large upload over a slow
  // link exceeds. Stalled connections are caught by the idle timeout instead, slow headers by
  // the (default) headers timeout, and slow JSON bodies by readJsonBody's own deadline.
  server.requestTimeout = 0;
  server.setTimeout(SOCKET_IDLE_MS);

  /** Authenticate a WebSocket upgrade exactly like an API request, then hand it to the room. */
  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { pathname, query } = parseRequestUrl(req.url);
    const match = /^\/ws\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (!match || !isValidId(match[1]) || !isDocKind(match[2])) {
      rejectUpgrade(socket, 404, 'not found');
      return;
    }
    const [, projectId, kind] = match;
    const payload = auth.verify(extractToken(req, query), projectId);
    if (!payload) {
      rejectUpgrade(socket, 401, 'missing or invalid token for this project');
      return;
    }
    if (!(await projects.exists(projectId))) {
      rejectUpgrade(socket, 404, 'project not found');
      return;
    }
    await rooms.accept(req, socket, head, projectId, kind, payload.r);
  }

  const socketsPerAddress = new ConcurrencyLimiter(
    options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP,
  );

  server.on('upgrade', (req, socket, head) => {
    // Until `ws` takes over, an error on the raw socket (client reset) would otherwise be unhandled.
    socket.on('error', () => socket.destroy());
    // Counted per TCP connection, from before the handshake until the connection is gone, so an
    // upgrade that is still authenticating or loading its room already holds its place.
    const address = clientIp(req, trustProxy);
    if (!socketsPerAddress.acquire(address)) {
      rejectUpgrade(socket, 429, 'too many connections from this address');
      return;
    }
    socket.once('close', () => socketsPerAddress.release(address));
    handleUpgrade(req, socket, head).catch((err: unknown) => {
      if (err instanceof HttpError) {
        rejectUpgrade(socket, err.status, err.message);
        return;
      }
      console.error('[tandem] WebSocket upgrade failed:', err);
      rejectUpgrade(socket, 500, 'internal server error');
    });
  });

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once('error', rejectListening);
      server.listen(options.port ?? 0, host, () => {
        server.off('error', rejectListening);
        resolveListening();
      });
    });
  } catch (err) {
    await rooms.close(); // e.g. the port is taken: leave no timers behind
    throw err;
  }

  const { port, family } = server.address() as AddressInfo;
  // A wildcard address is not something a client can connect to; advertise loopback instead.
  let reachableHost = host;
  if (host === '0.0.0.0' || host === '::' || host === '') reachableHost = 'localhost';
  else if (family === 'IPv6') reachableHost = `[${host}]`;
  const url = `http://${reachableHost}:${port}`;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // 1. No new connections; idle keep-alive connections are closed right away.
      const httpClosed = new Promise<void>((done) => server.close(() => done()));
      // 2. Disconnect collaborators and write every loaded document (and pending auto version).
      await rooms.close();
      // 3. Let short requests that are mid-flight finish, then cut whatever is left — long
      //    transfers are resumable (uploads) or repeatable (downloads) by design.
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      while (activeRequests > 0 && Date.now() < deadline) await delay(20);
      server.closeAllConnections();
      await media.drain();
      await projects.flush();
      await httpClosed;
    })();
    return closing;
  };

  return { port, url, close };
}
