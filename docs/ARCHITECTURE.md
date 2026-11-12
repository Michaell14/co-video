# Architecture

This document explains how Tandem is put together and — more usefully — why. It is meant to be
read top to bottom once; after that the section headings should be enough to find things.

```
                          ┌────────────────────────── browser tab ───────────────────────────┐
                          │                                                                  │
   files ──► OPFS ──► MediaLibrary ──► decode cursors ──┐                                    │
                          │            (WebCodecs)      ▼                                    │
                          │                        Compositor ──► canvas (preview)           │
   Yjs doc ◄─► ProjectStore ──► Project ──► resolveFrame ─┘  (WebGL2, RGBA16F)               │
      ▲                   │      snapshot      (pure)     └──► VideoEncoder ──► muxer ──► file│
      │                   │         │                                                        │
      │                   │         └──► AudioGraph (Web Audio / OfflineAudioContext)        │
      │                   └──────────────────────────────────────────────────────────────────┘
      │  y-protocols over WebSocket
      ▼
   collaboration server ──► snapshot + append-only log on disk, media files, versions
```

## 1. The project model (`packages/core`)

A project is plain JSON: settings, assets, tracks, clips, markers. Three rules shape it.

**Timeline positions are integer frames; source offsets are seconds.** Integer frames make cuts
exact and comparisons trivial. Source media has its own timebase, so a clip stores `sourceIn` in
seconds and a `speed`. `changeFrameRate` re-times a whole sequence when the frame rate changes.

**Spatial values are resolution independent.** Positions are fractions of the frame, text sizes
are fractions of the frame height, blur radii are "pixels at 1080p". The compositor multiplies by
the actual render size. This is what lets one project preview at quarter resolution, export at 8K
and switch aspect ratio without touching a clip.

**The model is flat.** Clips live in one map keyed by id and carry a `trackId`. Transitions are
fields on the incoming clip (`transIn` / `transOut`), not separate objects that reference two
clips. Nothing in the document points at anything that could dangle after a concurrent delete.

### Edits are operations

Every mutation is a list of atomic `Edit`s (`addClip`, `updateClip`, `removeClip`, …). Functions in
`ops.ts` are pure: they read a `Project` snapshot and return edits. The same list can be

- committed to the store → one undo step, one network update;
- applied to a snapshot with `applyEdits` → a drag preview, without touching the document;
- asserted on in a unit test, with no browser and no CRDT.

Overwrite semantics, ripple, roll, slip, split, paste, speed changes and frame-rate conforming are
all implemented once, here, and covered by `packages/core/test`.

**Ripples are sync-locked.** A ripple takes time out of the sequence, or puts it in, and every
unlocked track follows — not only the one being edited — so picture, sound and titles further down
keep lining up. Two things never happen: an overlap, and a linked pair drifting apart. A track with
no room to follow stays exactly as it is, and so does one that would carry half a linked pair away
from a half that cannot move. When the half that has to move sits on the track being edited there
is no way to keep the pair together, and the ripple is refused: `RippleResult.refused` says why, in
words meant for the person editing ("Unlock A1 to ripple: a linked clip on it has to move too.").

### Frame resolution

`resolveFrame(project, frame)` turns "the project at frame N" into an ordered list of layers with
every animated value already evaluated: which clip is on each track, whether a transition window is
active (and its eased progress), each clip's source time, transform and text-animation modifiers.
The compositor never looks at tracks, keyframes or transition windows — it draws what it is given.
That boundary is why the renderer is deterministic and why frame logic is unit-testable.

Two-sided transitions are centred on the cut and use _handles_ (media beyond the clip's in / out
points). When a clip has no handle left the source time clamps, which holds the last frame.

## 2. Collaboration

### The document

`ProjectStore` binds a Yjs document to the immutable snapshot. Each asset, track and clip is its
own `Y.Map` of flat fields, so merging is last-writer-wins **per field**: one person can move a
clip while another changes its opacity and both edits survive. Structured values (an effect stack,
a curve) are stored as whole JSON values — two people editing the same effect list in the same
instant resolve to one of the two lists, which is the right trade for values that are edited as a
unit.

The store rebuilds only the entities a transaction touched and keeps every other object
referentially identical, so React can skip unchanged clips and the engine can cache by identity.

**Nothing is taken on trust.** The server relays updates without understanding them, so whatever is
read from the document is conformed against the default shape, field by field and all the way down:
keyframe lists, effect stacks, grades and their curves, titles, shapes, markers and folders are read
item by item; enumerations are checked against their lists; colours are hex or they are the
default, because a colour ends up in a style attribute; an asset poster is an inline image or
nothing; settings are clamped to what the engine can work with (a real frame rate, a size a texture
can have). An entity of a type this version does not know is left out. A value that is already
well-formed is handed back as it is, which is what keeps identities stable. A malformed or hostile
update can neither crash a peer's renderer nor make their browser fetch anything. Project files go
through the same readers.

**Clips can outlive their track.** Someone undoes "add track" after a collaborator dropped a clip
on it, or deletes a track while a clip is on its way there. Such a clip stays in the document and
is left out of the snapshot: nothing renders it, snaps to it or counts it towards the length of the
sequence, and it is back the moment its track is (an undo, a redo). `ProjectStore.hiddenClips()`
lists them. A frame-rate change re-times them with everything else, in the same transaction and
undo step, so one that returns later is where it was in real time.

### Undo

`Y.UndoManager` tracks only the local origin, so undo reverts _your_ edits and leaves everyone
else's alone. Continuous gestures (dragging a slider) commit with `merge: true` and collapse into
one step; `beginGesture()` starts the next.

Undo and redo put values back as they were written, and a frame number names a moment only at the
frame rate it was written at. Every step is therefore stamped with the rate it was recorded at, and
the store looks at each undo and redo once it is done:

- If the rate is no longer the one on the stamp (a collaborator changed it in between), what the
  step put back is re-timed to the present rate. A deleted track returns with its clips where they
  were in real time; so does a deleted marker, or a fade that was taken off a clip.
- If the step is itself a change of rate, what it did not put back is re-timed with it: the clip
  someone else added or moved in the meantime. Values that are the same at both rates are left
  alone, so undoing a change of rate on your own returns every number exactly.

The re-timing becomes part of the step it follows: the opposite step takes it back, and an earlier
step that removes a value finds the re-timed one in its place. A gesture that is still going when
the rate changes under it carries on in a step of its own, because a step holds the values of one
rate.

What nothing re-times is an edit made at the old rate while its author was offline: it merges with
the frame numbers it was written with.

### Presence

Awareness state carries each user's name, colour, role, playhead, selection, cursor and — while
they are dragging — the previewed positions of the clips in flight, so collaborators see a ghost of
the move before it is committed. Updates are coalesced to about twelve a second.

### Comments

Comments live in a second document so that a **commenter** can write there while the project
document stays read-only for them. Role enforcement is on the server: document updates from a
connection that may not write are dropped before they reach the room.

A comment is stored once, as it was posted. Replies and later changes to it (text, resolved, frame)
get keys of their own in two more maps, `commentReplies` and `commentFields`, instead of rewriting
the comment. Two people replying at once, or one resolving a thread while the other answers it,
both keep what they did. What a commenter writes is conformed like the project document.

### The server (`apps/server`)

Plain `node:http` and `ws`. Rooms hold a `Y.Doc` and awareness per (project, document). State is
persisted as a snapshot plus a checksummed append-only log, compacted when the log grows; a torn
final record after a crash is detected and discarded. Access is by HMAC-signed capability tokens
(`owner`, `editor`, `commenter`, `viewer`) carried in share links; the editor strips the token from
the address bar as soon as it has read it.

Media is uploaded with a small resumable protocol (`Upload-Offset` / `Upload-Length`) and served
with HTTP range support. That one feature does a lot of work: a collaborator can start playing a
clip seconds after joining, because the demuxer reads just the bytes it needs, while the full file
downloads into their browser's private file system in the background. When it lands, the decoders
switch to the local copy.

The server protects itself with a few plain limits rather than quotas. Open sockets are capped per
client address and per room, and an upgrade over a cap is answered before the handshake (`429` for
the address, `503` for a full room). A full room still admits someone who may write its document:
the most recent read-only connection is closed with code `1013` to make way, so a viewer link
cannot be used to keep editors out. Presence updates are limited in size and in how deeply they
nest, and project creation is limited per address and hour (`MAX_CREATES_PER_HOUR`).
[`apps/server/README.md`](../apps/server/README.md) has the numbers and the security model.

## 3. The render engine (`packages/engine`)

### Compositor

WebGL2, RGBA16F render targets, premultiplied alpha.

```
for each layer, bottom to top
    source texture
      → input transform + grade        (one pass; skipped when neutral)
      → layer-space effects            (at the source's on-screen size)
      → transform into the frame       (anti-aliased quad, crop, mask)
      → frame-space effects            (shadows, outlines: may paint outside the source)
      → blend onto the accumulator     (fixed-function for Normal, shader for 17 other modes)
accumulator → output transform → canvas   or   → packed 10-bit Y'CbCr for HDR encode
```

A layer with a normal blend mode and no frame-space effects is drawn straight onto the accumulator,
so the common case — full-frame video — costs one draw call.

Render targets come from a pool keyed by size. A pooled target nobody asks for within a few frames
is freed, and when the idle part of the pool passes 256 MB so is everything the frame just drawn
did not use; a cut to a clip of another shape does not leave the old shape's buffers behind. A layer
is processed in a buffer of the size it is drawn at. While its scale is animated that size is
rounded up to a coarse grid, so a whole zoom runs on a handful of pooled targets instead of asking
for a new one on every frame.

A source drawn much smaller than it is gets mipmaps, so downscaled 4K stays clean. Packed
high-bit-depth planes are the exception: a mip level would average the two bytes of a sample
separately. A planar source that has to shrink is unpacked at its own size first and taken down in
steps of at most 2×.

An adjustment layer has no picture of its own; it is what its grade and effects make of everything
below it. In a transition it stands for exactly that, so its look is brought in or out the way any
other clip is.

Internal buffers store row 0 at the top of the picture and are never flipped; only the final blit
to the canvas flips. `readPixels` therefore returns rows in image order.

**Losing the context.** A browser may take the graphics context away at any time (a GPU reset, too
many contexts, memory pressure). Programs, render targets and source textures go with it. The
player stops the decoders that fed those textures, draws nothing meanwhile, and when the context is
restored builds a new compositor and a new source manager and carries on from the same frame. A
lost context reads back blank frames without raising an error, so the exporter checks for it after
every frame and fails with a message instead of encoding black.

### Effects and transitions are data

An effect is a parameter schema plus one or more GLSL passes with optional per-pass scale and
uniforms (`packages/core/src/effects.ts`). A generic runner compiles and executes them. Wide blurs
down-sample first, so a 200-pixel blur costs about the same as a 4-pixel one. A shader that fails to
compile disables that one effect and logs once; it cannot take the frame down. Failures are
remembered per context, so a shader that could not be built on a context that was being lost is
tried again on the next one.

Because definitions are data, the inspector builds its controls from the schema, the library
renders its thumbnails with the real shader, and the test suite compiles and draws every entry.

### Colour

The working encoding is display-referred gamma (the sRGB curve, extended above 1.0), with Rec.709
primaries on SDR timelines and Rec.2020 on HDR ones. That choice is deliberate: blending, opacity
and text anti-aliasing behave the way editors expect, and on an SDR timeline with SDR sources the
input and output transforms are the identity — the picture is passed through untouched. Effects
that need linear light convert locally with `toLinear` / `fromLinear`.

The grade pass applies, in order: input transform → white balance, exposure and tonal zones in
linear light → highlights / shadows / contrast → lift, gamma, gain, offset → curves (baked to a
256×2 float texture with monotone cubic interpolation) → hue curves, saturation, vibrance → 3D LUT.

**HDR.** On an HDR timeline, working-space 1.0 is diffuse white (203 nits by default) and values
above it are kept through every pass. SDR sources are converted into Rec.2020 and placed at diffuse
white. HDR sources are _not_ taken through the browser's 8-bit path: 10/12-bit frames are read back
as planes, uploaded as packed RG8 textures (low byte, high byte — which keeps bilinear filtering
exact) and converted Y'CbCr → R'G'B' in the shader. For export the compositor packs 10-bit
limited-range Y'CbCr on the GPU and the encoder receives real `I420P10` frames tagged BT.2020 / PQ
or HLG. An end-to-end test checks that a PQ ramp comes out with the same code values it went in
with.

An SDR timeline is display-referred from the first pass to the last, so its finished picture is
not tone-mapped: the output transform passes it through. What needs rolling off is dealt with where
it comes in. HDR sources use the browser's own HDR→SDR conversion (zero-copy and exactly what
people expect to see), and log or linear-light footage is linearised with the camera's published
transfer and gamut and rolled off in its input transform, with the project's tone-map operator.
Only an HDR timeline shown on an SDR display is tone-mapped on the way out.

### Decoding

Each video clip on screen has a _cursor_: a forward-running WebCodecs pipeline (via Mediabunny)
with a few frames of look-ahead and back-pressure. Sequential playback never seeks; scrubbing
restarts the pipeline at the nearest keyframe, and a restart that is already in flight is allowed to
land before the next one starts so fast scrubbing always shows _something_. Clips that are about to
start are warmed up a second ahead so cuts play cleanly.

Going backwards — a reversed clip, the J key, stepping back while paused — is served from behind
the playhead. A paused cursor keeps about half a second of decoded picture there, so the first
steps back cost nothing. Beyond that, a run of about three quarters of a second is decoded forwards
and joined to the front of what is held, and the next run starts before the current one is used
up.

Decoded frames are not free to keep: a hardware decoder draws them from a pool of fixed size and
stops when all of it is held downstream. A cursor whose decoder delivers nothing for a while,
although it was asked to and frames of its own are being held, lets the furthest ones go, and takes
the number it held as what that file's decoder can spare.

A file has one time origin: its first video frame, or its first audio sample when it has no
picture. Picture and sound are both counted from it, so sound that begins a little before or after
the picture keeps its place against it, and files that do not start at zero (transport streams,
camera recordings) behave like the rest.

Stills are decoded at the resolution the frame can show — up to twice the texels the picture
covers, so a zoom or an effect that enlarges it has detail to work with — and the least recently
drawn are released when together they outgrow a memory budget.

Media that is not there is not an error for long. A collaborator may still be uploading it, so
cursors, audio voices, stills and LUTs each ask again every two or three seconds, and the session
tells the engine the moment a file lands.

Preview resolution follows the viewer: `auto` quality renders only as many pixels as the viewer
shows. While playing, if animation frames arrive well below the timeline's rate the player halves
the internal buffers (the canvas keeps its size and the present pass scales up), checks that the
step really helped, and returns to full preview size the moment playback stops. Shaders for the
effects and transitions a project uses are compiled during idle time, so the first frame that needs
one does not stall.

**Proxies.** A resolver may hand the media library a second, smaller file for an asset's picture
(`media/proxy.ts` makes one: preview-sized, half-second GOPs, original timestamps). The library then
decodes video from the proxy and audio from the original, and reports the proxy's frames at the
original's dimensions, so layout, crops and effects cannot tell the difference. Only the preview
resolver ever offers a proxy; the export resolver does not know they exist. HDR sources are never
proxied, because their whole point is the bit depth an 8-bit proxy would discard.

The compositor is synchronous and draws whatever is ready. The exporter calls `prepare(exact)`
first, which resolves only when every layer has precisely the right frame — so the export is
identical on a fast and a slow machine. Export time only moves forward, so after each frame the
exporter frees every decoder that frame did not use, instead of leaving one open for every clip a
fast render has passed.

Media that is missing or will not decode does not stop an export, and never passes in silence.
`checkExportMedia` finds the clips whose media cannot be had before a frame is rendered. During the
export each problem is reported once per clip as it is met (`onWarning`), and all of them are in
`ExportResult.warnings`: which clip, which file, what was wrong, from which frame.

### Audio

`AudioGraph` builds the same node graph on a live `AudioContext` and on an `OfflineAudioContext`.
During playback, buffers are decoded and scheduled a couple of seconds ahead; gain envelopes
(volume, keyframes, equal-power fades) are written as parameter automation. For export the mix is
rendered offline in four-second chunks with a discarded pre-roll so filters and compressors have
settled, and interleaved with the video as it is encoded.

The player's master clock is the audio clock, offset by output latency, so picture follows sound.
If the audio context is not running yet the player uses a monotonic clock and hands over cleanly
when it starts.

## 4. The editor (`apps/editor`)

- **Session** owns everything that exists while a project is open: documents, IndexedDB
  persistence, the sync providers, presence, media storage and the player.
- **Local state** (selection, zoom, tool, panels, the drag preview) lives in a small Zustand store
  and is never synced.
- **Commands** (`state/commands.ts`) are the single implementation behind the keyboard, menus,
  buttons and the command palette.
- **Panel sizes are preferences.** The widths and heights a person drags are stored as they set
  them and fitted to the window each time it is laid out (`features/editor/layout.ts`), so a layout
  made on a large monitor still shows every panel on a laptop and comes back when the window grows.
- **Dialogs, the palette, menus and popovers are a stack of layers** (`ui/layers.ts`). The topmost
  layer gets every key before anything else in the page, a modal one makes what is beneath it
  inert, and the editor's own shortcuts stand down while any layer is open.
- **The timeline** is DOM for clips (so hover, selection and drag feedback are just CSS) with one
  canvas per lane underneath for filmstrips and waveforms. Only clips near the viewport exist in
  the DOM; scrolling is a transform on one element; the playhead is moved outside React.
- **Media** is stored in the Origin Private File System. Thumbnails and waveform peaks are
  generated lazily by priority — what is on screen now is always computed before what you have
  scrolled past.

**Offline.** The production build ships a small generated service worker (see
`apps/editor/vite.config.ts`): the page is network-first with a cached fallback, hashed code and
fonts are cache-first, and API calls, sockets and media range requests are never intercepted.
Together with IndexedDB (documents) and OPFS (media) that makes a cold start with no network
complete. A session that opens offline keeps retrying the server with a growing delay and syncs
when it answers; only an explicit refusal (bad link, deleted project) stops it. The role a link
gave is remembered with the project, so a viewer who opens it offline is still a viewer.

**Access.** A link offers a token, and the server is the only judge of it. The session asks the
server about the token it has stored for the project and about the one the link offers, and keeps
the one that allows more: a link can add access but never take it away, and a token is stored only
once the server has accepted it. A server that is unreachable, busy or full is a state to wait in,
not an answer — the session says so and keeps knocking. A refusal is final. If the project is on
this device it stays, as a local copy that no longer syncs; if nothing of it is here, it leaves the
project list.

**Media transfers.** An import joins the media pool, and the document, as soon as the file has been
probed: the file serves the asset from memory while its copy is written to the device behind it.
Uploads and downloads go through one queue that runs two of each at a time, most urgent first —
which leaves connections free for the range requests the preview streams with — and tries a failed
transfer again by itself, at growing intervals.

The home screen deliberately does not import the engine, so it loads in a fraction of the editor's
bundle; the editor chunk is warmed in the background while you choose a project.

## 5. Testing strategy

| Layer   | What is checked                                                                                                                             | Where                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Model   | timecode, keyframes, every edit operation, CRDT convergence, per-user undo, hostile input                                                   | `packages/core/test`                                                     |
| Server  | auth, roles, sync, persistence across restart and torn logs, resumable media, versions, connection limits                                   | `apps/server/test`                                                       |
| Engine  | all shaders compile and draw, geometry and colour, frame accuracy, HDR exactness, memory held, context loss, exports inspected with ffprobe | `e2e/engine*.spec.ts`, `packages/engine/test`                            |
| Editor  | the parts that are plain functions: panel layout, layers and focus, access, the transfer queue, timing, shortcuts                           | `apps/editor/test`                                                       |
| Product | mouse-driven editing, reload persistence, panels and dialogs from the keyboard, export, multi-user sessions with roles                      | `e2e/editor.spec.ts`, `e2e/collab.spec.ts` and the other specs in `e2e/` |

The engine tests run through a bare "lab" page (`apps/editor/lab.html`) that exposes the engine
without the editor around it. WebGL runs on SwiftShader, so the suite needs no GPU.
