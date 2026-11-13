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
 *
 * Type 2 is the server's own: a JSON `ControlMessage`. `hello` greets a connection with its role and
 * `readonly` says that an edit was dropped. `error` comes in two kinds. Followed by a close it is
 * the reason for the close. Without one it is a notice, and the connection goes on: its message
 * then begins with `PRESENCE_IGNORED` and says why a presence update was not relayed.
 *
 * Close codes the server uses (apps/server/README.md, "HTTP details", has them with the upgrade
 * refusals): 1001 shutting down, 1007 malformed message, 1009 the document is full, the server
 * has no memory to spare for it, or the message is larger than the role may send (only the last
 * comes without an `error` first), 1012 the room is restarting, 1013 a full room gave this place to
 * someone whose role ranks higher: try again later.
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

/**
 * Whether the server would open a document for a connection right now, as far as it can tell
 * without loading it: `busy` when the documents it has in memory leave no room for this one at
 * the moment, `too-large` when what is stored is more than it loads at all. The first passes; the
 * second lasts until whoever runs the server raises the limit.
 */
export type DocAvailability = 'ok' | 'busy' | 'too-large';

export interface ProjectInfo {
  id: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
  /** Not in the answer of a server from before it could tell. */
  docs?: Record<DocKind, DocAvailability>;
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

/** How the message of an `error` that is only a notice begins: a presence update was not relayed. */
export const PRESENCE_IGNORED = 'presence update ignored: ';
/**
 * The reason given, after `PRESENCE_IGNORED`, for an update that came in faster than the server
 * relays them. The state it carried is not shown to anyone until the sender says it again.
 */
export const PRESENCE_TOO_FAST = 'updates are arriving faster than they are relayed';

/** A close code a WebSocket uses for "too big": see the list of close codes above. */
export const WS_CLOSE_TOO_BIG = 1009;
/** The `error` before a close with `WS_CLOSE_TOO_BIG` when the document takes no more changes. */
export const docFullMessage = (doc: DocKind): string =>
  `the ${doc} document has reached the size this server allows`;
/** The same when the document has room, but the server holds as much document data as it may. */
export const NO_DOC_MEMORY = 'the server has no memory to spare for more document data';
/** "Try again later": a full room gave the connection's place to someone who outranks it. */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/** Which roles may write which document. */
export function canWriteDoc(role: Role, doc: DocKind): boolean {
  if (doc === 'project') return role === 'owner' || role === 'editor';
  return role !== 'viewer';
}
