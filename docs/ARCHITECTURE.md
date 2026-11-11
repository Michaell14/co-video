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

### Frame resolution

`resolveFrame(project, frame)` turns "the project at frame N" into an ordered list of layers with
every animated value already evaluated: which clip is on each track, whether a transition window is
active (and its eased progress), each clip's source time, transform and text-animation modifiers.
The compositor never looks at tracks, keyframes or transition windows — it draws what it is given.
That boundary is why the renderer is deterministic and why frame logic is unit-testable.

Two-sided transitions are centred on the cut and use *handles* (media beyond the clip's in / out
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
Incoming data is conformed against the default shape field by field; a malformed or hostile update
can never crash a peer's renderer.

### Undo

`Y.UndoManager` tracks only the local origin, so undo reverts *your* edits and leaves everyone
else's alone. Continuous gestures (dragging a slider) commit with `merge: true` and collapse into
one step; `beginGesture()` starts the next.

### Presence

Awareness state carries each user's name, colour, role, playhead, selection, cursor and — while
they are dragging — the previewed positions of the clips in flight, so collaborators see a ghost of
the move before it is committed. Updates are coalesced to about twelve a second.

### Comments

Comments live in a second document so that a **commenter** can write there while the project
document stays read-only for them. Role enforcement is on the server: document updates from a
connection that may not write are dropped before they reach the room.

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

Render targets come from a pool keyed by size. A layer with a normal blend mode and no frame-space
effects is drawn straight onto the accumulator, so the common case — full-frame video — costs one
draw call.

Internal buffers store row 0 at the top of the picture and are never flipped; only the final blit
to the canvas flips. `readPixels` therefore returns rows in image order.

### Effects and transitions are data

An effect is a parameter schema plus one or more GLSL passes with optional per-pass scale and
uniforms (`packages/core/src/effects.ts`). A generic runner compiles and executes them. Wide blurs
down-sample first, so a 200-pixel blur costs about the same as a 4-pixel one. A shader that fails to
compile disables that one effect and logs once; it cannot take the frame down.

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
white. HDR sources are *not* taken through the browser's 8-bit path: 10/12-bit frames are read back
as planes, uploaded as packed RG8 textures (low byte, high byte — which keeps bilinear filtering
exact) and converted Y'CbCr → R'G'B' in the shader. For export the compositor packs 10-bit
limited-range Y'CbCr on the GPU and the encoder receives real `I420P10` frames tagged BT.2020 / PQ
or HLG. An end-to-end test checks that a PQ ramp comes out with the same code values it went in
with.

On an SDR timeline, HDR sources use the browser's own HDR→SDR conversion (zero-copy and exactly
what people expect to see), and log footage is linearised with the camera's published transfer and
gamut and rolled off with the project's tone-map operator.

### Decoding

Each video clip on screen has a *cursor*: a forward-running WebCodecs pipeline (via Mediabunny)
with a few frames of look-ahead and back-pressure. Sequential playback never seeks; scrubbing
restarts the pipeline at the nearest keyframe, and a restart that is already in flight is allowed to
land before the next one starts so fast scrubbing always shows *something*. Reverse playback
decodes a short run forwards and steps back through it. Clips that are about to start are warmed up
a second ahead so cuts play cleanly.

Preview resolution follows the viewer: `auto` quality renders only as many pixels as the viewer
shows. While playing, if animation frames arrive well below the timeline's rate the player halves
the internal buffers (the canvas keeps its size and the present pass scales up), checks that the
step really helped, and returns to full preview size the moment playback stops. Shaders for the
effects and transitions a project uses are compiled during idle time, so the first frame that needs
one does not stall.

The compositor is synchronous and draws whatever is ready. The exporter calls `prepare(exact)`
first, which resolves only when every layer has precisely the right frame — so the export is
identical on a fast and a slow machine.

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
- **The timeline** is DOM for clips (so hover, selection and drag feedback are just CSS) with one
  canvas per lane underneath for filmstrips and waveforms. Only clips near the viewport exist in
  the DOM; scrolling is a transform on one element; the playhead is moved outside React.
- **Media** is stored in the Origin Private File System. Thumbnails and waveform peaks are
  generated lazily by priority — what is on screen now is always computed before what you have
  scrolled past.

The home screen deliberately does not import the engine, so it loads in a fraction of the editor's
bundle; the editor chunk is warmed in the background while you choose a project.

## 5. Testing strategy

| Layer | What is checked | Where |
| --- | --- | --- |
| Model | timecode, keyframes, every edit operation, CRDT convergence, per-user undo, hostile input | `packages/core/test` |
| Server | auth, roles, sync, persistence across restart and torn logs, resumable media, versions | `apps/server/test` |
| Engine | all shaders compile and draw, geometry and colour, frame accuracy, HDR exactness, exports inspected with ffprobe | `e2e/engine.spec.ts` |
| Product | mouse-driven editing, reload persistence, export dialog, multi-user sessions with roles | `e2e/editor.spec.ts`, `e2e/collab.spec.ts` |

The engine tests run through a bare "lab" page (`apps/editor/lab.html`) that exposes the engine
without the editor around it. WebGL runs on SwiftShader, so the suite needs no GPU.
