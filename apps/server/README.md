# @tandem/server

The collaboration and media server for Tandem. One Node process, one data directory, no database and
no native dependencies:

- **Realtime** — Yjs sync and presence over WebSocket (`/ws/:projectId/:doc`, `doc` = `project` or `review`),
  wire-compatible with y-websocket framing.
- **API** — projects, invite links, versions and resumable media uploads under `/api`.
- **Static hosting** — serves the built site at `/` and the built editor at `/app/` when those builds exist.

The wire contract lives in [`packages/core/src/protocol.ts`](../../packages/core/src/protocol.ts).

## Running

```sh
pnpm --filter @tandem/server dev      # tsx watch, restarts on change
pnpm --filter @tandem/server build    # bundles to dist/server.js
pnpm --filter @tandem/server start    # node dist/server.js
pnpm vitest run apps/server           # tests (from the repo root)
```

`dist/server.js` is self-contained; copy it anywhere and run it with Node ≥ 20.
On `SIGINT` / `SIGTERM` the server disconnects clients, writes every open document to disk and exits; a
second signal exits immediately.

It can also be embedded (this is what the tests do):

```ts
import { createTandemServer } from './src/server';
const server = await createTandemServer({ dataDir: './data', port: 0 });
console.log(server.url);
await server.close();
```

## Configuration

| Variable                   | Default                | Meaning                                                                                                      |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`                     | `8787`                 | TCP port.                                                                                                    |
| `HOST`                     | `0.0.0.0`              | Interface to bind.                                                                                           |
| `DATA_DIR`                 | `./data`               | Where everything is stored (see below).                                                                      |
| `CORS_ORIGIN`              | `*`                    | Value of `Access-Control-Allow-Origin` on API responses. Set it to the editor's origin in production.        |
| `EDITOR_DIST`              | `../editor/dist`       | Built editor, served at `/app/` (relative default is resolved against this package).                         |
| `SITE_DIST`                | `../site/dist`         | Built site, served at `/`.                                                                                   |
| `MAX_UPLOAD_BYTES`         | `21474836480` (20 GiB) | Largest single asset.                                                                                        |
| `TANDEM_OPEN_CREATE`       | `true`                 | Whether anyone may `POST /api/projects`. With `false` the endpoint answers 403.                              |
| `AUTO_SNAPSHOT_MS`         | `600000` (10 min)      | Interval of automatic versions while a project changes; `0` turns them off.                                  |
| `TRUST_PROXY`              | `false`                | Tell clients apart by the last `X-Forwarded-For` entry. Enable only behind a reverse proxy that sets it.     |
| `MAX_CONNECTIONS_PER_IP`   | `200`                  | WebSockets one client address may hold open at a time (an editor tab uses two). More are refused with `429`. |
| `MAX_CONNECTIONS_PER_ROOM` | `100`                  | WebSockets per room, i.e. per document of a project. More are refused with `503` (see the security model).   |

The server speaks plain HTTP. Put it behind a reverse proxy for TLS (and compression of the static
files); the proxy must pass WebSocket upgrades and should not buffer request bodies of uploads.

Behind a proxy every request arrives from the proxy's address. Unless `TRUST_PROXY` is on, all clients
then share one rate limit and `MAX_CONNECTIONS_PER_IP` caps the whole server, so turn `TRUST_PROXY` on
(or raise the cap). The two connection limits are a backstop against a client that opens sockets until
the process runs out of memory, not a quota: the defaults leave room for an office behind one address.

## Data layout

```
<DATA_DIR>/
  secret                        32 random bytes, mode 0600 — signs all tokens
  projects/<projectId>/
    meta.json                   { createdAt, updatedAt, name }   (timestamps in ms)
    project.snapshot            full Yjs state of the project document
    project.log                 updates received since that snapshot
    review.snapshot, review.log the same for the review document
    versions.json               VersionInfo[]
    versions/<versionId>.bin    full Yjs state of the project document at that version
    media/<assetId>             a finished asset
    media/<assetId>.json        { size, type, completedAt }
    media/<assetId>.part        an upload in progress
```

Backing up means copying the directory; restoring means copying it back. Keep `secret` with it, or every
existing link stops working.

**Documents.** Incoming updates are appended to the log within ~100 ms (one write + fdatasync per batch).
A log record is `u32 length | u32 CRC-32 | Yjs update`. When the log passes 1 MiB, when a room is unloaded
(30 s after its last client left) and on shutdown, the document is compacted: a new snapshot is written
to a temp file, fsynced and renamed into place, then the log is emptied. Loading applies the snapshot and
replays the log; a torn last record (crash mid-write) is detected by length/checksum and cut off. Because
Yjs updates are idempotent, a crash between "snapshot renamed" and "log emptied" is harmless. A snapshot
that cannot be decoded is never overwritten — the room refuses to load instead.

**Versions.** `POST …/versions` stores the current project document. In addition an `auto: true` version
named "Auto-save" is taken every `AUTO_SNAPSHOT_MS` while the document has changed since the last version
of either kind, and once more when a changed project is unloaded or the server shuts down, so the end of
every editing session is captured. At most 50 automatic versions are kept per project; named versions are
never pruned.

**Media.** `PUT` appends the body to `<assetId>.part` if `Upload-Offset` equals the bytes already stored
(otherwise `409` with the real offset), and renames it to `<assetId>` once `Upload-Length` bytes are there.
Each chunk is fsynced before the `204`. If a connection dies mid-chunk, the bytes that arrived are kept;
`HEAD` reports where to resume (`HEAD …?probe` answers offset 0 instead of `404` when nothing is stored yet).
A new `PUT` for an asset supersedes one that is still open for it.

Only one server process may use a data directory at a time.

## Security model

There are no accounts. Access is by **capability token**: whoever holds a token has the role it encodes
on the project it names.

```
token = base64url(JSON { p: projectId, r: role, iat }) + "." + base64url(HMAC-SHA256(payloadB64, secret))
```

Tokens are sent as `Authorization: Bearer <token>` or `?t=<token>` (needed for WebSockets and `<video src>`).
Signatures are compared in constant time, and a token is only accepted for the project id in its payload.

| Role        | Read documents, versions, media | Write `review` doc | Write `project` doc, upload/delete media, create versions | Create invites            |
| ----------- | :-----------------------------: | :----------------: | :-------------------------------------------------------: | ------------------------- |
| `owner`     |                ✓                |         ✓          |                             ✓                             | editor, commenter, viewer |
| `editor`    |                ✓                |         ✓          |                             ✓                             | editor, commenter, viewer |
| `commenter` |                ✓                |         ✓          |                             –                             | –                         |
| `viewer`    |                ✓                |         –          |                             –                             | –                         |

The only `owner` token is the one returned when the project is created; it cannot be minted again.

What the server enforces:

- Every API route and WebSocket upgrade requires a valid token for that project (`401` otherwise), except
  `GET /api/health`, CORS preflights and — if `TANDEM_OPEN_CREATE` is on — `POST /api/projects`.
- Role checks happen on the server. Document updates from a connection whose role may not write that
  document are dropped — neither applied nor relayed — and the client receives a `readonly` control message.
- Ids (project, asset, version) must match `^[A-Za-z0-9_-]{6,64}$` before they are used in a path; static
  files are confined to their build directory.
- Request limits: JSON bodies 64 KiB, WebSocket messages 32 MiB, assets `MAX_UPLOAD_BYTES`; project
  creation 30/hour and invites 120/hour per client address (in memory, best effort).
- Open WebSockets are capped per client address and per room; an upgrade over a cap is refused before the
  handshake. A full room still admits a participant who may write its document: the most recent read-only
  connection is closed (code `1013`) to make way, so a viewer link cannot be used to keep editors out.
- Presence updates over 1 MiB are ignored. One whose states are not valid JSON, or nest more than 32 levels
  deep, closes the connection like any other malformed message, and no part of it is kept or relayed.
- Uploaded files are served with their stored content type, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox`, so an uploaded HTML or SVG file cannot run script in the app's origin.
- The pages themselves (site and editor) are served with a Content-Security-Policy that allows scripts,
  styles, media and connections from their own origin only, `frame-ancestors 'none'` / `X-Frame-Options:
DENY`, and a Permissions-Policy that grants the microphone (voiceover) and nothing else.

What it does **not** do — know this before exposing a server:

- **Tokens do not expire and cannot be revoked individually.** A leaked link is valid until the secret is
  replaced (delete `secret` and restart), which invalidates every token of every project.
- **Tokens in URLs leak** into proxy and access logs and browser history. Responses carry
  `Referrer-Policy: no-referrer`, but treat logs as sensitive, and always use TLS.
- **Presence is not authenticated.** Any participant, viewers included, can publish arbitrary awareness
  state (name, colour, claimed role) and can overwrite another participant's presence. Never derive
  permissions from awareness; the role in the `hello` control message is the authoritative one.
- **Editors are trusted with the document.** The server relays Yjs updates without understanding the
  project model, so an editor can write anything into the document, and can fill the disk: there is no
  per-project quota, only the per-asset limit.
- **The connection caps do not arbitrate between equals.** Participants with the same rights can still
  fill a room and keep each other out (viewers other viewers, editors other editors) until they leave.
- **No encryption at rest**, and anyone who can read `DATA_DIR/secret` can mint any token.
- With `TANDEM_OPEN_CREATE=true` anyone who can reach the server can create projects. With `false` nobody
  can — create the projects you need first, then switch it off.

## HTTP details worth knowing

- Successful `POST`s answer `200` with JSON; errors are always `{ "error": string }`.
- `GET /api/projects/:id` returns `ProjectInfo` plus the project's `name`.
- `PUT …/media/:assetId` requires both `Upload-Offset` and `Upload-Length`; it answers `204` with
  `Upload-Offset` and `Upload-Complete: 1|0`. Also `400` (bad headers, more bytes than declared), `413`
  (over the limit), `507` (disk full). `DELETE` is idempotent.
- `GET …/media/:assetId` supports one byte range per request (`a-b`, `a-`, `-n`); a multi-range request
  gets the whole file with `200`.
- A WebSocket upgrade that is refused is answered with a normal HTTP status: `401` / `404` when
  authentication fails, `429` when the address has too many sockets open, `503` when the room is full.
  Browsers surface all of them only as a failed connection — validate the token with
  `GET /api/projects/:id` first if you need to tell a bad link from a busy server.
