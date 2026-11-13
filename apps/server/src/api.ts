/**
 * The JSON API under `/api` (see `packages/core/src/protocol.ts` for the contract).
 *
 * Every project route is checked in the same order, so responses never reveal more than the
 * caller is entitled to know:
 *   400  an id in the path is malformed
 *   401  no token, a bad signature, or a token issued for a different project
 *   404  the token is genuine but the project (or the resource in it) does not exist
 *   403  the token's role does not allow the operation
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canEdit } from '@tandem/core';
import type { ProjectInfo, Role } from '@tandem/core';
import { extractToken, invitableRoles, isRole } from './auth';
import type { TokenAuthority } from './auth';
import {
  HttpError,
  applyCorsHeaders,
  assertMethod,
  clientIp,
  readJsonBody,
  sendEmpty,
  sendJson,
  sendThrown,
  streamFile,
} from './http';
import type { MediaStore } from './media';
import type { ProjectMeta, ProjectStore } from './projects';
import type { RateLimiter } from './rateLimit';
import type { RoomManager } from './rooms';
import type { VersionStore } from './versions';
import { isNotFound, isValidId } from './util';

const MAX_NAME_LENGTH = 200;
const MAX_AUTHOR_LENGTH = 100;
const DEFAULT_PROJECT_NAME = 'Untitled project';
const DEFAULT_VERSION_NAME = 'Untitled version';

export interface ApiContext {
  auth: TokenAuthority;
  projects: ProjectStore;
  rooms: RoomManager;
  versions: VersionStore;
  media: MediaStore;
  /** Reported by `/api/health`. */
  version: string;
  corsOrigin: string;
  openCreate: boolean;
  trustProxy: boolean;
  createLimiter: RateLimiter;
  inviteLimiter: RateLimiter;
}

interface Caller {
  role: Role;
  meta: ProjectMeta;
}

/** Optional free-text field: absent → `fallback`; present → must be a string, trimmed and bounded. */
function textField(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  fallback: string,
): string {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, `"${field}" must be a string`);
  const text = value.trim();
  if (text.length > maxLength) throw new HttpError(400, `"${field}" must be at most ${maxLength} characters`);
  return text === '' ? fallback : text;
}

/** Every API path also answers OPTIONS (the CORS preflight, handled before routing). */
function allowMethods(req: IncomingMessage, methods: readonly string[]): void {
  assertMethod(req, [...methods, 'OPTIONS']);
}

function enforceRateLimit(limiter: RateLimiter, key: string): void {
  const retryAfter = limiter.consume(key);
  if (retryAfter > 0) {
    throw new HttpError(429, 'too many requests, slow down', { 'Retry-After': String(retryAfter) });
  }
}

export function createApiHandler(ctx: ApiContext) {
  /** Token → 401, then project existence → 404. Role checks are left to the route. */
  async function authenticate(
    req: IncomingMessage,
    query: URLSearchParams,
    projectId: string,
  ): Promise<Caller> {
    const payload = ctx.auth.verify(extractToken(req, query), projectId);
    if (!payload) {
      throw new HttpError(401, 'missing or invalid token for this project', { 'WWW-Authenticate': 'Bearer' });
    }
    const meta = await ctx.projects.get(projectId);
    if (!meta) throw new HttpError(404, 'project not found');
    return { role: payload.r, meta };
  }

  async function createProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ctx.openCreate) throw new HttpError(403, 'project creation is disabled on this server');
    enforceRateLimit(ctx.createLimiter, clientIp(req, ctx.trustProxy));
    const body = await readJsonBody(req);
    const name = textField(body, 'name', MAX_NAME_LENGTH, DEFAULT_PROJECT_NAME);
    const { id } = await ctx.projects.create(name);
    sendJson(res, 200, { id, token: ctx.auth.mint(id, 'owner') });
  }

  async function createInvite(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    caller: Caller,
  ): Promise<void> {
    const allowed = invitableRoles(caller.role);
    if (allowed.length === 0) throw new HttpError(403, `role "${caller.role}" cannot create invites`);
    enforceRateLimit(ctx.inviteLimiter, clientIp(req, ctx.trustProxy));
    const { role } = await readJsonBody(req);
    if (!isRole(role)) throw new HttpError(400, '"role" must be one of editor, commenter, viewer');
    if (!allowed.includes(role)) throw new HttpError(403, `invites for role "${role}" cannot be created`);
    sendJson(res, 200, { token: ctx.auth.mint(projectId, role) });
  }

  async function createVersion(
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    caller: Caller,
  ): Promise<void> {
    if (!canEdit(caller.role)) throw new HttpError(403, `role "${caller.role}" cannot create versions`);
    const body = await readJsonBody(req);
    const name = textField(body, 'name', MAX_NAME_LENGTH, DEFAULT_VERSION_NAME);
    const author = textField(body, 'author', MAX_AUTHOR_LENGTH, '');
    // Through the room, so the version reflects edits that have not reached the disk yet.
    const state = await ctx.rooms.withRoom(projectId, 'project', (room) => room.snapshotForVersion());
    const info = await ctx.versions.create(projectId, { name, author, auto: false }, state);
    ctx.projects.touch(projectId);
    sendJson(res, 200, info);
  }

  async function sendVersion(res: ServerResponse, projectId: string, versionId: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(ctx.versions.binPath(projectId, versionId), 'r');
    } catch (err) {
      if (isNotFound(err)) throw new HttpError(404, 'version not found');
      throw err;
    }
    let streaming = false;
    try {
      const { size } = await handle.stat();
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        // A version never changes once written.
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      streaming = true; // streamFile closes the handle
      await streamFile(res, handle);
    } finally {
      if (!streaming) await handle.close();
    }
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    // ['', 'api', ...segments]; a single trailing slash is tolerated.
    const segments = pathname.split('/').slice(2);
    if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
    const [collection, projectId, resource, resourceId] = segments;

    if (segments.length === 1 && collection === 'health') {
      allowMethods(req, ['GET', 'HEAD']);
      sendJson(res, 200, { ok: true, name: 'tandem', version: ctx.version }, { 'Cache-Control': 'no-store' });
      return;
    }
    if (collection !== 'projects' || segments.length > 4) throw new HttpError(404, 'not found');

    if (segments.length === 1) {
      allowMethods(req, ['POST']);
      await createProject(req, res);
      return;
    }

    if (!isValidId(projectId)) throw new HttpError(400, 'invalid project id');

    if (segments.length === 2) {
      allowMethods(req, ['GET']);
      const { role, meta } = await authenticate(req, query, projectId);
      // A refused WebSocket upgrade tells a browser nothing, so what would be refused is said here.
      const [project, review] = await Promise.all([
        ctx.rooms.availability(projectId, 'project'),
        ctx.rooms.availability(projectId, 'review'),
      ]);
      const info: ProjectInfo & { name: string } = {
        id: projectId,
        role,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        name: meta.name,
        docs: { project, review },
      };
      sendJson(res, 200, info, { 'Cache-Control': 'no-store' });
      return;
    }

    if (resource === 'invites' && segments.length === 3) {
      allowMethods(req, ['POST']);
      await createInvite(req, res, projectId, await authenticate(req, query, projectId));
      return;
    }

    if (resource === 'versions' && segments.length === 3) {
      allowMethods(req, ['GET', 'POST']);
      const caller = await authenticate(req, query, projectId);
      if (req.method === 'POST') await createVersion(req, res, projectId, caller);
      else sendJson(res, 200, await ctx.versions.list(projectId), { 'Cache-Control': 'no-store' });
      return;
    }

    if (resource === 'versions' && segments.length === 4) {
      if (!isValidId(resourceId)) throw new HttpError(400, 'invalid version id');
      allowMethods(req, ['GET']);
      await authenticate(req, query, projectId);
      await sendVersion(res, projectId, resourceId);
      return;
    }

    if (resource === 'media' && segments.length === 4) {
      if (!isValidId(resourceId)) throw new HttpError(400, 'invalid asset id');
      allowMethods(req, ['GET', 'HEAD', 'PUT', 'DELETE']);
      const { role } = await authenticate(req, query, projectId);
      await ctx.media.handle(req, res, projectId, resourceId, role);
      return;
    }

    throw new HttpError(404, 'not found');
  }

  /** Entry point for every request whose path is `/api` or starts with `/api/`. Never rejects. */
  return async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    applyCorsHeaders(res, ctx.corsOrigin);
    try {
      if (req.method === 'OPTIONS') {
        // CORS preflight. It carries no credentials, so it is answered for any path.
        sendEmpty(res, 204);
        return;
      }
      await route(req, res, pathname, query);
    } catch (err) {
      sendThrown(res, err);
    }
  };
}
