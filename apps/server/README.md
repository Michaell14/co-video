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
| `UPLOAD_EXPIRY_DAYS`       | `7`                    | Days after which the stored part of an upload that was never finished is deleted; `0` keeps them.            |
| `TANDEM_OPEN_CREATE`       | `true`                 | Whether anyone may `POST /api/projects`. With `false` the endpoint answers 403.                              |
| `MAX_CREATES_PER_HOUR`     | `30`                   | Projects one client address may create per hour. More are refused with `429`.                                |
| `AUTO_SNAPSHOT_MS`         | `600000` (10 min)      | Interval of automatic versions while a project changes; `0` turns them off.                                  |
| `TRUST_PROXY`              | `false`                | Tell clients apart by the last `X-Forwarded-For` entry. Enable only behind a reverse proxy that sets it.     |
| `MAX_CONNECTIONS_PER_IP`   | `200`                  | WebSockets one client address may hold open at a time (an editor tab uses two). More are refused with `429`. |
| `MAX_CONNECTIONS_PER_ROOM` | `100`                  | WebSockets per room, i.e. per document of a project. More are refused with `503` (see the security model).   |
| `MAX_PROJECT_DOC_BYTES`    | `33554432` (32 MiB)    | Size a project document may reach. At the limit it takes no more changes (see "Limits").                     |
| `MAX_REVIEW_DOC_BYTES`     | `2097152` (2 MiB)      | The same for a review document (the comments of a project).                                                  |
| `MAX_OPEN_DOC_BYTES`       | 1 % of the V8 heap     | Size of all documents held in memory at the same time. No document's limit is more than half of it.          |
| `MAX_PRESENCE_BYTES`       | `262144` (256 KiB)     | Largest presence update (cursor, selection) that is relayed, and what one link may show in a room in all.    |
| `MAX_SYNC_BACKLOG_BYTES`   | `134217728` (128 MiB)  | Document copies queued for clients that have not read them yet. Further copies wait for their turn.          |

The server speaks plain HTTP, and **the editor only works over HTTPS** unless it is opened on
`localhost`: browsers switch off WebCodecs, the private file system, service workers, the clipboard
and the microphone on every other page that came over plain HTTP. At `http://your-server:8787/app/`
the editor loads and then decodes nothing, stores nothing on the device and does not open offline.
So put the server behind a reverse proxy that terminates TLS (and compresses the static files). The
proxy must pass WebSocket upgrades and should not buffer request bodies of uploads. With
[Caddy](https://caddyserver.com) that is:

```
tandem.example.com {
	reverse_proxy localhost:8787
}
```

Behind a proxy every request arrives from the proxy's address. Unless `TRUST_PROXY` is on, all clients
then share one rate limit and `MAX_CONNECTIONS_PER_IP` caps the whole server, so turn `TRUST_PROXY` on
(or raise the cap). The two connection limits are a backstop against a client that opens sockets until
the process runs out of memory, not a quota: the defaults leave room for an office behind one address.

## The editor on another origin

The editor is a static build and does not have to be served by this process: a CDN or any static
host will do. These settings connect the pieces.

| Set it for              | Variable          | Meaning                                                                                                                           |
| ----------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| the editor's build      | `VITE_SERVER_URL` | Address of this server, such as `https://api.example.com`. Without it the editor talks to the origin it was loaded from.          |
| the editor's build      | `TANDEM_BASE`     | Path the editor is served under. `/app/` by default; `/` for a host of its own.                                                   |
| this server             | `CORS_ORIGIN`     | The editor's origin, such as `https://edit.example.com`.                                                                          |
| the website's build     | `VITE_EDITOR_URL` | Where the website's links to the editor point. `/app/` by default.                                                                |
| the editor's dev server | `TANDEM_SERVER`   | The server it passes `/api` and `/ws` on to. `http://localhost:8787` by default; this one is for development, not for deployment. |

```sh
VITE_SERVER_URL=https://api.example.com TANDEM_BASE=/ pnpm --filter @tandem/editor build
VITE_EDITOR_URL=https://edit.example.com/ pnpm --filter @tandem/site build
CORS_ORIGIN=https://edit.example.com pnpm --filter @tandem/server start
```

What this server does for the pages it serves, the other host has to do for the editor:

- **HTTPS**, for the reason given above. This server must then be reached over HTTPS as well, or the
  browser blocks the editor's requests and sockets to it as mixed content.
- **Security headers.** The Content-Security-Policy and Permissions-Policy described under "Security
  model" are set on the pages this server sends, and on nothing else. Send them from the other host
  too (`documentSecurityHeaders` in [`src/static.ts`](src/static.ts) has the list), with this
  server's address added to `connect-src`, as `https://` and as `wss://`: the editor fetches
  everything it gets from the server, media included. Keep `microphone=(self)` in the
  Permissions-Policy, or voiceover recording is refused.
- **Caching.** `index.html` and `sw.js` must be revalidated on every load (`Cache-Control: no-cache`),
  or a deploy does not reach returning visitors. Everything under `assets/` has a hash of its
  content in its name and can be cached for good.
- **The service worker's reach** is the path the editor is served under. Nothing else should live
  under that path.

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
A new `PUT` for an asset supersedes one that is still open for it. A `.part` file that has not been
written to for `UPLOAD_EXPIRY_DAYS` is deleted (checked at startup and once a day); the upload then
starts over. Finished assets are never deleted by the server.

Only one server process may use a data directory at a time.

## Limits

Whoever holds a link, a viewer included, makes the server store and send things. Each of them is
bounded, so that the worst a link can do is use up its own allowance. Nothing over a limit is dropped
without a word: the client gets a control message of type `error` with the reason, and where the
connection cannot go on, a close code.

**Documents.** A document may grow to `MAX_PROJECT_DOC_BYTES` / `MAX_REVIEW_DOC_BYTES` (the encoded
size, which is also what is on disk and what a joining client downloads), and to one _struct_ per 16
bytes of that. Structs are Yjs's unit of change and what a document costs in memory: 250 to 700
bytes of heap each, however little they say. Ordinary projects average 13 to 25 bytes per struct, so
for them the two limits come to much the same (one that has been edited a lot reaches the second a
little earlier); a document made of minimal structs is stopped by the second one long before it
reaches the first. The server counts what an update would add before applying it,
including the structs it would cut in two (a few bytes of deletions can cut one struct into
thousands); a subdocument counts as nine structs. A document never shrinks by much: every edit leaves
about 15 bytes behind for good. A 2,000-clip project is a third of a megabyte when new and 1.5 MiB
after 80,000 edits.

- An update that would take a document over its limit is not applied. The sender gets
  `the project document has reached the size this server allows` and close code `1009`; everyone else
  keeps the document as it was. The editor reconnects and offers the same change again, with the same
  result, until the limit is raised. An update is judged by what it adds, also when it deletes more
  than that: replacing most of a document that is over half full does not fit.
- All documents in memory together stay within `MAX_OPEN_DOC_BYTES` (and one struct per 16 bytes of
  it). When that is used up, further projects cannot be opened (the upgrade is refused with `503`) and
  open ones take no changes that need more, until rooms are unloaded. The sender of such a change gets
  `the server has no memory to spare for more document data` and close code `1009`. In the worst case
  a document costs about 40 times its limit in heap, an ordinary one about 15 times its size; the
  default of 1 % of the heap keeps the worst case under half of it. Raise the heap
  (`node --max-old-space-size`) or this limit for a server with many busy projects.
- A document's limit is at most half of `MAX_OPEN_DOC_BYTES`, whatever `MAX_PROJECT_DOC_BYTES` and
  `MAX_REVIEW_DOC_BYTES` say. With the default of 1 % of the heap that is what decides on a heap
  under 6.4 GiB: 10 MiB for a project on a 2 GiB heap.
- A stored document of more than twice the limit, in bytes or in structs, is not loaded: upgrades
  for it are refused with `507`, the log names the project, the file and the settings, and nothing
  is changed on disk. Raise the limit to open it again. (Twice, because the size is kept as an
  estimate between snapshots, and a document this server wrote itself must always load. It always
  fits, since twice a limit is never more than `MAX_OPEN_DOC_BYTES`.) The same goes for a document
  whose snapshot and log together hold more than `MAX_OPEN_DOC_BYTES`, as data written under
  larger limits may: `503` is only ever the answer for a document that will fit once others are
  unloaded.

**Messages.** A connection that may write a document can send messages as large as that document may
be; every other connection 1 MiB, enough to ask for the document and to send presence. A larger
message closes the connection with code `1009` before it is read.

**Presence.** A connection publishes one presence entry, under the client id it announced first.
Entries about other ids are not taken: not states (`a connection can announce one presence entry`,
`the entry belongs to another participant`), and not removals either, which clients send when their
own copy timed a peer out; the room notices by itself who left. A client id belongs to the link it
was first announced with, for as long as the room is loaded: a connection opened with the same link
may take the entry over, which is what a tab does when it reconnects, while its old socket still
lingers or after it was away, and nobody with another link gets the id, also not when its entry has
lapsed or its holder is gone (the room remembers the ids of the last thousand or so who left).
Updates over `MAX_PRESENCE_BYTES`, more than 20 a second (40 at once) or more than twice
`MAX_PRESENCE_BYTES` a second are skipped. So is what goes beyond the share of a link: the
connections opened with one link may send 200 updates a second between them (400 at once), and the
updates their entries were last set by may come to `MAX_PRESENCE_BYTES` taken together
(`the connections made with this link already show as much as one link may`), so that a link has a
room relay 20 times `MAX_PRESENCE_BYTES` a second at the very most, on however many sockets. A room
keeps four times `MAX_PRESENCE_BYTES` in all. None of this closes the connection. States must be
JSON objects nested at most 32 levels deep; one that is not closes the connection like any other
malformed message (code `1007`), and no part of that update is kept or relayed. A client is told
who is in the room once the document it asked for has left for it, in one message of at most four
times `MAX_PRESENCE_BYTES`; one that never asks for the document is not told. A member whose
connection is behind is not sent every presence update in between, only the latest states once it
has caught up.

**Sending.** A client that asks for the document again while the answer to its last request is still
on its way gets one more answer when that one has arrived, not one per request. The copies on their
way to all clients together stay within `MAX_SYNC_BACKLOG_BYTES`; when that is used up, further
clients wait in line for theirs (a client that does not read loses its place at the next heartbeat,
after 30 to 60 s). A connection with more than twice its document's limit plus 32 MiB queued is
dropped, and synchronises from scratch when it reconnects.

**Connections.** Open WebSockets are capped per client address and per room; an upgrade over a cap is
refused before the handshake. A full room still admits a participant who outranks someone in it
(viewer < commenter < editor < owner): the most recent connection of the lowest role below theirs is
closed (code `1013`) to make way.

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
- Request limits: JSON bodies 64 KiB, assets `MAX_UPLOAD_BYTES`; project creation 30/hour and invites
  120/hour per client address (in memory, best effort). What a connection may send, and what a room
  holds and sends on its behalf, is bounded as described under "Limits".
- A lesser link cannot be used to keep people out: a full room makes way for whoever outranks someone
  in it, so viewers cannot lock out commenters, commenters cannot lock editors and the owner out of
  the review, and nobody can lock out the owner.
- A participant's presence entry is their own. Nobody holding a different link can rewrite or remove
  it, or take its place while they are away, a connection cannot publish entries for made-up
  participants, and the `role` in an entry is the role of the token it was published with, whatever
  the client wrote there. However many sockets are opened with a link, together they show no more
  than one connection could.
- Uploaded files are served as what they are only if that is video, audio or a raster image (PNG,
  JPEG, WebP, AVIF, GIF). Everything else, HTML and SVG included, is served as
  `application/octet-stream` with `Content-Disposition: attachment`, so opening its address saves a
  file instead of showing a page under this server's name. All of them carry
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- The pages themselves (site and editor) are served with a Content-Security-Policy that allows scripts,
  styles, media and connections from their own origin only, `frame-ancestors 'none'` / `X-Frame-Options:
DENY`, and a Permissions-Policy that grants the microphone (voiceover) and nothing else.

What it does **not** do — know this before exposing a server:

- **Tokens do not expire and cannot be revoked individually.** A leaked link is valid until the secret is
  replaced (delete `secret` and restart), which invalidates every token of every project.
- **Tokens in URLs leak** into proxy and access logs and browser history. Responses carry
  `Referrer-Policy: no-referrer`, but treat logs as sensitive, and always use TLS.
- **Presence is only as authentic as the link.** Any participant, viewers included, can publish any
  name and colour, and people who share one link can overwrite each other's presence. Never derive
  permissions from awareness; the role in the `hello` control message is the authoritative one.
- **Editors are trusted with the document.** The server relays Yjs updates without understanding the
  project model, so an editor can write anything into the document, up to its size limit. Uploads have
  no per-project quota, only the per-asset limit, so an editor can fill the disk.
- **Commenters are trusted with the review document, all of it.** "Write `review` doc" in the table
  above is meant literally: the server does not know whose comment is whose, so someone with a
  comment link and a raw client can rewrite or delete other people's comments and post under any name.
  The editor only offers people their own comments to delete. Tokens name a role, not a person, so
  this cannot be enforced without per-person links.
- **The limits bound what one link can do, not what many can.** Participants with the same rights can
  still fill a room and keep each other out (viewers other viewers, editors other editors) until they
  leave, and with `TANDEM_OPEN_CREATE=true` anyone can create projects and fill each to its limits:
  the server then refuses to open further documents rather than run out of memory, which is an outage
  for those projects all the same.
- **Almost nothing is ever deleted by the server.** The editor does not remove media from the server
  (removing an asset can be undone, and a version may still need it), and there is no way to delete a
  project or a named version over the API. Only automatic versions beyond the fiftieth and abandoned
  uploads go by themselves. Ordinary use only ever grows the data directory; clear it out by hand.
- **No encryption at rest**, and anyone who can read `DATA_DIR/secret` can mint any token.
- With `TANDEM_OPEN_CREATE=true` anyone who can reach the server can create projects. With `false` nobody
  can — create the projects you need first, then switch it off.

## HTTP details worth knowing

- Successful `POST`s answer `200` with JSON; errors are always `{ "error": string }`.
- `GET /api/projects/:id` returns `ProjectInfo` plus the project's `name`. Its `docs` field says, for
  `project` and `review`, whether a connection to that document would be opened right now: `ok`,
  `busy` (it does not fit next to the documents in memory at the moment: the upgrade gets `503`) or
  `too-large` (more is stored than the server loads: `507`, until `MAX_PROJECT_DOC_BYTES`,
  `MAX_REVIEW_DOC_BYTES` or `MAX_OPEN_DOC_BYTES` is raised). It is told from the size of the files and
  loads nothing; a document that is too heavy only in structs shows as `ok` until a connection has
  made the server read it. A full room is not part of it.
- `PUT …/media/:assetId` requires both `Upload-Offset` and `Upload-Length`; it answers `204` with
  `Upload-Offset` and `Upload-Complete: 1|0`. Also `400` (bad headers, more bytes than declared), `413`
  (over the limit), `507` (disk full). `DELETE` is idempotent.
- `GET …/media/:assetId` supports one byte range per request (`a-b`, `a-`, `-n`); a multi-range request
  gets the whole file with `200`.
- A WebSocket upgrade that is refused is answered with a normal HTTP status: `401` / `404` when
  authentication fails, `429` when the address has too many sockets open, `503` when the room is full
  or the server has too many documents open, `507` when the stored document is larger than the server
  loads. Browsers surface all of them only as a failed connection — validate the token with
  `GET /api/projects/:id` first if you need to tell a bad link from a busy server.
- WebSocket close codes the server uses: `1001` shutting down, `1007` malformed message, `1009`
  message too large or document full, `1012` room restarting, `1013` place given to someone of a
  higher role. Before `1007` and `1009` it sends `{ "type": "error", "message": … }`. The same control
  message without a close says that a presence update was skipped.
