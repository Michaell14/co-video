/**
 * Wire contract between the editor and the collaboration server.
 *
 * HTTP (JSON unless noted). `Authorization: Bearer <token>` or `?t=<token>`.
 *   GET    /api/health                              → { ok, name, version }
 *   POST   /api/projects        { name? }           → { id, token }          (owner token)
 *   GET    /api/projects/:id                        → ProjectInfo
 *   POST   /api/projects/:id/invites { role }       → { token }              (owner / editor)
 *   GET    /api/projects/:id/versions               → VersionInfo[]
 *   POST   /api/projects/:id/versions { name }      → VersionInfo            (editor+)
 *   GET    /api/projects/:id/versions/:vid          → binary Yjs update
 *   HEAD   /api/projects/:id/media/:assetId         → Upload-Offset, Upload-Complete headers
 *   PUT    /api/projects/:id/media/:assetId         body = bytes; headers Upload-Offset, Upload-Length
 *   GET    /api/projects/:id/media/:assetId         → bytes, honours Range
 *
 * WebSocket: /ws/:projectId/:doc?t=<token>  where doc ∈ { project, review }.
 * Messages are y-protocols frames: varUint type (0 = sync, 1 = awareness) followed by the payload.
 * The server drops document updates from connections whose role may not write that doc.
 */
import type { Role } from './presence';

export const WS_MSG_SYNC = 0;
export const WS_MSG_AWARENESS = 1;
/** Server → client: JSON control message (role, errors). */
export const WS_MSG_CONTROL = 2;

export type DocKind = 'project' | 'review';

export interface TokenPayload {
  /** Project id. */
  p: string;
  /** Role. */
  r: Role;
  /** Issued at (seconds). */
  iat: number;
}

export interface ProjectInfo {
  id: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

export interface VersionInfo {
  id: string;
  name: string;
  createdAt: number;
  author: string;
  auto: boolean;
}

export interface ControlMessage {
  type: 'hello' | 'error' | 'readonly';
  role?: Role;
  message?: string;
}

/** Which roles may write which document. */
export function canWriteDoc(role: Role, doc: DocKind): boolean {
  if (doc === 'project') return role === 'owner' || role === 'editor';
  return role !== 'viewer';
}
