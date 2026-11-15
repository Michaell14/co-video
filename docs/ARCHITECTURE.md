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

**What stands at a frame follows a ripple.** Markers and review comments are pinned to frames
without being clips. Every ripple the editor plans also says what it did to time, as spans taken
out or put in, and `rippleFollower` (`apps/editor/src/state/edits.ts`) makes one rule for both out
of the project before the ripple, its edits and those spans: a thing on a shot goes where the shot
goes (the clip under it on the lowest picture track that has one, else on the first sound track),
and a thing on empty time, or in time the edit removed, moves with the time and lands on the cut.
`withMarkers` (`state/follow.ts`) adds the marker edits to the ripple's own and marks the list as a
ripple's; `commitEdits`, which `commit` goes through, commits a marked list and has the comments
moved. One switch, `markersFollow`, turns both off. A list that is copied or spread loses the mark,
so a ripple is committed as `commit(withMarkers(p, ripple))`, with anything else for the same step
passed as its third argument.

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

**Clips can land on each other.** No edit leaves two clips on the same frames of a track, but two
people can each put one there at the same moment, and both edits arrive.
`ProjectStore.resolveOverlaps` moves one of the two to a free track, outside the undo history. It is
moved by exactly one session, or two would each add a track for it: one of those that last wrote
where the clip is, and of these the one with the greatest client id, which every session works out
alike. The editor's session calls it when changes from others have stopped coming in for 400 ms,
and after each sync, never on the first update: a collaborator's undo arrives as several, and the
first of them is not yet the project they mean. It passes the client ids of everyone presence
shows with a role that edits, so a clip does not wait for a session that has left. With nobody
there who may move it, the clip stays, marked in the timeline, until someone does.

### Undo

`Y.UndoManager` tracks only the local origin, so undo reverts _your_ edits and leaves everyone
else's alone. Continuous gestures (dragging a slider) commit with `merge: true` and collapse into
one step; `beginGesture()` starts the next.

`ProjectStore.undo()` and `redo()` take back, or make again, one of your steps per call, and say
what came of it (`StepOutcome`). Between your step and its undo other people have been editing, and
the store decides what the step still means:

- A value the step replaced is put back, also when a collaborator wrote the same field at the same
  instant and lost the merge. Left to Yjs, undoing such a step deletes the field.
- A step of which nothing is left, because someone else has since replaced or removed every value
  it wrote, is dropped: the call goes on to the step before it, and `StepOutcome.dropped` counts
  what was passed over so that the editor can say so.
- A marker or a folder that someone else deleted stays deleted. Undoing your earlier change to it
  does not bring it back; that is theirs to undo.
- A clip that returns onto frames another clip has taken since moves to a free track of its kind,
  or to a new one, within the same step. A person working alone always gets back exactly the state
  before the step.

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

A change of rate writes the start and the duration of every clip, changed or not, so that of two
changes of rate made at the same moment one decides where every clip is. (Fades, keyframes and
transition lengths are written only where they change, and can still mix.) That also puts someone
else's change of rate on top of every move and trim you made before it. Those steps stay yours to
undo: the store recognises its own value re-timed, and what the undo puts back is re-timed in turn.
This reaches across one change of rate. After two in a row by other people, or after someone
deliberately moved or trimmed the same clip again, the step has nothing left to take back and is
dropped like any other.

What nothing re-times is an edit made at the old rate while its author was offline: it merges with
the frame numbers it was written with.

### Presence

Awareness state carries each user's name, colour, role, playhead, selection, cursor and — while
they are dragging — the previewed positions of the clips in flight, so collaborators see a ghost of
the move before it is committed. Updates are coalesced to about twelve a second.

Presence is announced by whoever is in the room and passed on to everyone, so it is never trusted.
Everything that draws a collaborator reads the room through `session/presence.ts`, which makes a
fully typed state out of whatever arrived, field by field, the way the stores read the documents;
an entry without a usable identity is nobody. The lists a state carries are cut on both sides (a
hundred selected clips, fifty in a drag, a hundred people). A client also ignores what the room
says about its own id and announces itself again if someone else spoke for it. The one thing in an
entry that can be relied on is `role`, which the server writes from the link the connection came
with.

The server meters presence and passes over an update that comes too soon after the last, with a
notice to its sender. The state it passed over may be the one a gesture ended on, so the session
announces its state once more a second after such a notice.

### Comments

Comments live in a second document so that a **commenter** can write there while the project
document stays read-only for them. Role enforcement is on the server: document updates from a
connection that may not write are dropped before they reach the room.

A comment is stored once, as it was posted. Replies and later changes to its text or its resolved
state get keys of their own in two more maps, `commentReplies` and `commentFields`, instead of
rewriting the comment. Two people replying at once, or one resolving a thread while the other
answers it, both keep what they did. The frame a comment was moved to, by a ripple, its undo or a
change of frame rate, is an entry `[commentId, frame]` in a list, `commentFrames`: a move appends
the entries of all its comments as one struct and deletes the ones they replace, so the document
does not grow with every edit that moves time, and of several entries for one comment the last
stands. What a commenter writes is conformed like the project document.

**Comments follow ripple edits.** A comment's frame is a value in the review document, so the
project document cannot carry it along in the edit's own transaction. `CommentMover`
(`packages/core/src/follow.ts`) does it for whoever makes the edit: it commits the edit and then
writes the frames of the comments it moves, in one transaction of the review document
(`ReviewStore.move`). Nobody else's client moves anything on seeing the edit arrive, so everyone
ends with the same frames. Only frames are written: author, text, replies and the resolved state
are untouched, also when someone changes them at the same moment. Two people who ripple at the same
moment each write a frame for a comment, and one of the two stands for everyone. Which one is
settled in the review document, apart from which of their clip positions stand in the project
document, so such a comment can end up beside its shot.

The moves are kept on the undo step of the edit (`tandem.comments` in the step's meta:
`[before, after]` for each comment, and the frame rate they count at). When the store has taken the
step back, each comment that still stands where the step left it returns to where the step found
it, and the redo moves it again. What happened in between is treated as the store treats the values
of a clip: a comment deleted since stays deleted, one that someone else's edit moved since stays
where that put it (the clip under it did not go back either), one made since is not touched, a step
that was dropped moves nothing, and after someone else's change of frame rate the noted frames are
read at the present rate. A commit that joins the step before it adds to that step's note.

The speed slider under ripple editing commits at every move of the pointer and plans each step from
where the drag began. Such an edit names its gesture (`FollowOptions.gesture`, a `GestureStep`), and
the mover keeps the frame each comment had when the gesture began with the gesture, not with an undo
step, because a gesture is not always recorded as one step. A comment that somebody makes or moves
while the drag is under way has no frame from where the drag began. The mover notes the frame it was
put at and the step it came after, and asks each later step where it takes a frame of that step's
timeline (`GestureStep.since`). `speedEdits` answers by planning that step again from the speed it
set. So such a comment stays on the shot it was put on, and comes back when time that was taken out
from under it is put back. The drag is not started anew for it: that would plan the clips again from
the middle of the drag, round their lengths a second time and lose the fades the drag had shortened.
Its first step is written at once and later ones when the drag rests for `GESTURE_REST_MS`, or
sooner when its undo or another edit needs the comments in place. A comment that somebody moves or
deletes in the meantime keeps what they did.

### The server (`apps/server`)

Plain `node:http` and `ws`. Rooms hold a `Y.Doc` and awareness per (project, document). State is
persisted as a snapshot plus a checksummed append-only log, compacted when the log grows; a torn
final record after a crash is detected and discarded. Access is by HMAC-signed capability tokens
(`owner`, `editor`, `commenter`, `viewer`) carried in share links; the editor takes the token out of
the address bar once the server has judged it (see "Access" below).

Media is uploaded with a small resumable protocol (`Upload-Offset` / `Upload-Length`) and served
with HTTP range support. That one feature does a lot of work: a collaborator can start playing a
clip seconds after joining, because the demuxer reads just the bytes it needs, while the full file
downloads into their browser's private file system in the background. When it lands, the decoders
switch to the local copy.

The server protects itself with budgets rather than quotas. Open sockets are capped per client
address and per room (`429` / `503` before the handshake), and a full room makes way for whoever
outranks someone in it (viewer < commenter < editor < owner; close code `1013`). A document may
reach a configured size and one Yjs struct per 16 bytes of it, all loaded documents together a
share of the heap; an update over that is refused before it is applied (close code `1009`), and a
stored document over twice the limit is not loaded (`507`). A connection publishes one presence
entry, metered in size and rate, and one copy of the document at a time is on its way to a client.
Project creation is limited per address and hour (`MAX_CREATES_PER_HOUR`).
[`apps/server/README.md`](../apps/server/README.md) has the numbers and the security model.

**Deleting.** The owner's link deletes a project for everyone (`DELETE /api/projects/:id`). The
server first records the id under `deleted/` and from that moment answers every request and
connection for the project with `410`; then it closes the rooms without saving them (close code
`4410`, `WS_CLOSE_PROJECT_DELETED` in `packages/core/src/protocol.ts`, from which the server and the
editor both take it and its message `PROJECT_DELETED`), cuts off the transfers under way and removes
the directory. The record is what makes this hold against everything still in flight:
`ProjectStore.dir`, the one place an id becomes a path, refuses a deleted project, so a late write
has nowhere to land, the id is never given out again, and a deletion that a crash cut short is
finished at the next start. A version is deleted by the owner or an editor (`DELETE
/api/projects/:id/versions/:versionId`).

**Unused media.** A media file leaves the server when nothing can need it any more: no asset of the
project document and no stored version refers to it (`sweep.ts`). For this the server reads one
thing out of a project document, the keys of its `assets` map (`references.ts`); a version records
its own when it is made. Taking a file out of a project does not delete it. A file goes only when
two sweeps a grace period apart (`UNUSED_MEDIA_EXPIRY_HOURS`) both found nothing referring to it,
and it is deleted in the same turn of the event loop in which the document was looked at, so an
undo inside the grace period always finds its file. What a sweep noted about a file is forgotten
the moment the document refers to its asset again.

A heartbeat every 30 seconds ends connections that have gone away without closing
(`Connection.beat` in `rooms.ts`). What counts as a sign of life depends on whether something is on
its way to the client. With nothing waiting to be sent, a pong counts, and so does anything else
that arrived, and the connection has two heartbeats of grace after the last of what it was sent
left the server. While something is waiting, a ping waits behind it, and a large document on a
slow link takes longer than a heartbeat: then the one sign of life is that the client took some of
it since the heartbeat before, measured on the socket itself (what its finished writes come to,
and how much of the write under way is still to go). Neither a pong nor incoming data counts then.
A client that sends but does not read would otherwise keep its place, and its copy of the document,
for as long as it liked.

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

The scopes work on a small copy of the last frame, read back through a pixel buffer and a fence
that is looked at from a timer (`gl/fence.ts`), so that a read does not hold up the render loop. A
fence is not waited for without end. One that has not signalled after two seconds is given up if
frames were drawn meanwhile, because the picture asked for is no longer the last, and its pixels are
fetched regardless if the picture was at rest, because nothing else would bring them.

**Losing the context.** A browser may take the graphics context away at any time (a GPU reset, too
many contexts, memory pressure). Programs, render targets and source textures go with it. The
player stops the decoders that fed those textures, draws nothing meanwhile, and when the context is
restored builds a new compositor and a new source manager and carries on from the same frame. A
lost context reads back blank frames without raising an error, so the exporter checks for it after
every frame and fails with a message instead of encoding black.

`Compositor.atRest` names one clip that is drawn without the animation it comes and goes with
(`layerAtRest`): the editor sets it for the title being typed into, and again on the compositor
that follows a lost context.

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
or HLG. An end-to-end test compares the picture that is handed to the encoder with a 10-bit PQ
ramp, to within one code value, and another checks that the exported file is laid out and tagged as
10-bit PQ. Nothing reads code values back out of an encoded file.

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

A clip that carries on in its file where the clip before it stops (a take cut into pieces) takes
that clip's cursor over instead of starting one of its own. Cuts inside a take therefore cost no
decoder start and no decode from the keyframe before, in the preview and in an export alike. A
cursor whose decoder broke on a damaged spot is never handed on.

Decoders are a scarce thing, so the ones no clip in the picture uses are not kept for long: for
four seconds at most, the three used last while paused (stepping back over a cut should not seek)
and none while playing. A viewer at rest is swept once a second.

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
tells the engine the moment a file lands. The asking is silent: the console names a file that
cannot be had once, not once per attempt.

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
`ExportResult.warnings`: which clip, which file, what was wrong, from which frame; for media that
would not decode, `lost` and `cause` say how much and why.

What the video encoder is set up with is built in one place, `videoEncoding`, and `encoderAccepts`
puts the same to the browser ahead of time: the question the export dialog asks before anything
starts is the one the export meets at its first frame, 10-bit HDR included. An export can be
cancelled until its file is finished. The abort signal is looked at once more after the muxer has
finalised; only the closing of a picked file, reported as the phase `saving`, is past stopping.

### Audio

`AudioGraph` builds the same node graph on a live `AudioContext` and on an `OfflineAudioContext`.
During playback, buffers are decoded and scheduled a couple of seconds ahead; gain envelopes
(volume, keyframes, equal-power fades) are written as parameter automation. For export the mix is
rendered offline in four-second chunks with a discarded pre-roll so filters and compressors have
settled, and interleaved with the video as it is encoded.

The mix is rendered in chunks, but each clip's sound is decoded in one pass over the whole export
(`AudioRuns` carries the decoders from chunk to chunk). A decoder does not always place sound after
a seek exactly where the decode before it placed the same sound, and where two stretches placed
differently meet there is a click.

Decoded sound reaches the mixer, an export and the waveforms through `Sound` (`audio/sound.ts`),
which wraps Mediabunny's `AudioBufferSink`. When the WebCodecs decoder fails, decoding starts again
behind the packet that stopped it, further on each time it fails at once and a bounded number of
times; what lies between stays silent, and the mixer's `AudioProblem` says how much was lost
(`lost`), from where (`at`) and what the decoder said (`cause`). Where the decoder gives none of the
file's sound (what it gives in front of it, the encoder's priming and the packet it needs to get
going, does not count), has used up its starts, or would start beyond what a read asked for, AAC
goes to the browser's other decoder (`audio/adts.ts`): the track's packets, 128 at a time behind the
three that lead up to them, through `decodeAudioData`, cut into one buffer per packet at the
packet's time. Plain AAC-LC above 24 kHz goes as an ADTS stream, once the browser has placed a
built-in test stream to the sample. Everything else (HE-AAC v1 and v2, AAC-LC at 24 kHz and below,
and plain AAC-LC where the test stream is not placed) goes as an MP4 file of its own
(`audio/mp4.ts`). That file carries the track's AudioSpecificConfig as it is, is timed in samples at
the rate the stream decodes to (twice a core of 24 kHz or less unless the config says there is no
band replication), and has an edit that leaves out the three packets in front. A stretch is used
only when it comes back with exactly the samples of its packets, or exactly those less the three in
front (a browser that follows the edit); anything else is not used. A hand-over that fails leaves
the WebCodecs decoder to go on as it would have. Which decoder a file is on is remembered per asset
for as long as the page lives and forgotten with `MediaLibrary.invalidate`. A clip that plays
backwards keeps the sound that did decode when its decoder stops: what could not be given is then a
stretch at the clip's start, and is reported as one.

In the preview the mixer's reports reach the editor through `Player.onAudioProblem`. The timeline's
media cache keeps them by clip and kind, a stretch or the rest (`TimelineMedia.heard`,
`features/timeline/soundLoss.ts`). Each is kept as a place in the clip's file, so it follows the
clip when it is moved, slipped or played at another speed, and however often the mixer says it again
(it does on every play) it is one mark. It is let go when the clip goes, is of another file or is
turned round, no longer plays the place, or when its file is read anew (`TimelineMedia.refresh`).
Sound of which nothing decodes is a fault of the file instead (`DecodeFault.sound`, with the
decoder's `cause`) and is not also kept by clip. Which of the two it is, the file's waveform finds
out, since it reads all of the file: a clip of which the preview heard nothing decode waits for it
(`TimelineMedia.heard`, `WaveformCache.done`), and is marked only if some of the file's sound
decodes. Normalise loudness reads through `Sound` too, so it measures what plays.

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
  The track heights set by someone who may not edit are kept the same way, per project
  (`laneHeights` in `state/ui.ts`); an editor's are part of the project. They leave with a project
  deleted from the device (`forgetLaneHeights`, called by `deleteLocalProject`), from storage at
  once, since the next save keeps what it finds stored for projects its tab did not size.
- **Dialogs, the palette, menus and popovers are a stack of layers** (`ui/layers.ts`). The topmost
  layer gets every key before anything else in the page, a modal one makes what is beneath it inert,
  and the editor's own shortcuts stand down while any layer is open. A command chosen in the palette
  runs once the palette is out of the page and within the same key press, so a dialog it opens finds
  the keyboard where the palette was called from, and a file chooser is opened by the person's own
  press as far as the browser is concerned.
- **A row's label names its controls.** `Labelled` and `LabelText` (`ui/core.tsx`) make a row of a
  panel or a form: the kit's fields, sliders, selects, switches and segmented controls inside it
  take their accessible name from the row's label unless they are given one, so a property is named
  once, where it is drawn. `ui/labels.ts` holds the wording of frame sizes and colour modes for
  every place that shows them.
- **Focus is handed on, not dropped.** A control whose own action removes it (Close with its panel,
  Delete with its card) would leave the keyboard on nothing. `handFocus` (`ui/layers.ts`) says where
  it goes instead, for people working from the keyboard; a pointer press decides about focus by
  itself. A button that waits for what its own press began is not switched off meanwhile, which
  would drop the keyboard the same way: `busy` on the kit's `Button` (`useBusy` for a button of
  another kind) keeps it in place, says that it is at work and takes no press. A key that is down as
  the work begins or ends is spent (`spendKeys`), so that the repeats of a held Enter do not start
  the work again once it is done; Space, which presses a button as it comes up, is refused as it
  goes down. The kit's `Button` shows nothing that turns while it is busy, because over a dialog's
  live backdrop blur whatever keeps moving has the whole page composited again for every frame.
- **Two tokens are about more than colour.** `--panel-pad` is the one distance between a panel's
  edge and its content, so rows, tiles and cards of every panel start on the same line.
  `--line-control` is the edge of a control that has nothing but its edge to be told by (an empty
  field, the chosen segment): it holds 3:1 against the surfaces around it, which the hairlines do
  not.
- **The timeline** is DOM for clips (so hover, selection and drag feedback are just CSS) with one
  canvas per lane underneath for filmstrips and waveforms. Only clips near the viewport exist in the
  DOM; scrolling is a transform on one element; the playhead is moved outside React.
- **Media** is stored in the Origin Private File System. Thumbnails and waveform peaks are
  generated lazily by priority — what is on screen now is always computed before what you have
  scrolled past.
- **A title is typed into on the picture, and the picture stays the renderer's.**
  `features/viewer/TitleEditor.tsx` lays a real `<textarea>` over the title. Its text is not
  painted, only its caret and selection are, and every input is written to the project at once,
  merged into one undo step, so the letters under the caret are the compositor's own and nothing
  changes when the typing ends. The field is laid out by the numbers the title is drawn by:
  `layoutText` (`packages/engine/src/generators.ts`) is the one function that measures a title
  (`rasterizeText` draws by it, `measureClip` sizes the layer by it), and `titleField` turns its
  measures and the layer's box into the field's size, padding, type size and CSS matrix. Type is
  laid out at the size it has on screen and only turned by the matrix, so the browser's caret stays
  a pixel wide in a 4K frame shown small. Canvas and field both set type with `geometricPrecision`,
  by the font's own measures at every size. The field's lines are broken by the browser and the
  title's by `wrapLines`, which follows Chromium's rules: all of them between ASCII characters
  (`breaksBetween`; a browser test compares every pair against a block styled as the field), and
  those for hyphens, dashes, the ellipsis, quotation marks and no-break spaces beyond ASCII. Like
  the browser it forgets what stood before the start of a line. Emoji, scripts written without
  spaces and currency signs count as letters. Whether a word that ends at the edge of the box fits
  is decided as Chromium decides it (`setLines`). After a space it fits by the line kerned against
  that space when the title is set from the left, and by the line without it when the title is
  centred or right-aligned. After a wide East Asian space it fits by the kerned line at any
  alignment, and after a tab never. A line that fits only by its kerned width is drawn by its own
  width but counts as no wider than the box, so the field over the title, which is as wide as the
  box, breaks in the same place. Chromium also rounds a line's width to a sixty-fourth of a pixel at
  the size the field is shown; the title, drawn alike at every size, does not follow that. The field
  starts from `all: initial`, because anything inherited (the page's font features) moves letters.
  Undo inside the field is its own (`TypingHistory`): Chromium keeps one undo history for all fields
  of a page and would go on to another field at the end of this one's. `cmd.editText` decides where
  a title is typed: on the picture when it is on show at the playhead, in the inspector's field
  otherwise.

**Offline.** The production build ships a small generated service worker (see
`apps/editor/serviceWorker.ts`): the page is network-first with a cached fallback, hashed code and
fonts are cache-first, and API calls, sockets and media range requests are never intercepted. Only
the editor's own page is ever kept as that fallback, whatever else inside the worker's reach is
opened as a page. A new version of the worker takes over the files the one before it holds, and
asks the browser's own cache before the network, so a first visit downloads nothing twice and a
deploy costs a returning visitor the files that changed.
Together with IndexedDB (documents) and OPFS (media) that makes a cold start with no network
complete. A session that opens offline keeps retrying the server with a growing delay and syncs
when it answers; only an explicit refusal (bad link, deleted project) stops it. The role a link
gave is remembered with the project, so a viewer who opens it offline is still a viewer.

**Access.** A link offers a token, and the server is the only judge of it. The session asks the
server about the token it has stored for the project and about the one the link offers, and keeps
the one that allows more: a link can add access but never take it away, and a token is stored only
once the server has accepted it. A server that is unreachable, busy or full is a state to wait in,
not an answer — the session says so and keeps knocking. While the server answers and has no place
(`SessionMeta.busy`) the top bar reads “Waiting for the server”; once it does not answer at all,
`busy` is over and the project is offline. A refusal ends the knocking. If the project
is on this device it stays, as a local copy that no longer syncs; if nothing of it is here, it
leaves the project list, unless it was made on this device. The refused link is not thrown away:
it is kept aside (`tandem.links-aside.v1` in local storage) and offered to the server again only
when the person asks (Share → Try again), when another link to the same project is being judged,
or when nothing of the project is on the device. A refusal is only what one server said at one
moment, and a link is not something its holder can get again by themselves.

A project its owner deleted is a third answer, and a final one: the server says `410` to a link that
was good, or closes the open connections with `4410`. `Session.projectDeleted` keeps what the device
holds as a local project, drops the link (it is not kept aside, there is nothing to try again) and,
on a guest's device, marks the entry (`ProjectEntry.deletedByOwner`), which its card shows as “No
longer shared”. `SessionMeta.deleted` records that answer. With nothing of the project on the
device, the “not available” screen (`Workspace` in `features/editor/Editor.tsx`) says that the owner
deleted it and offers no “Try again”, because asking again gets the same answer. “Delete for
everyone…” in the editor's menu leaves the project before anything is asked: the question is the
card's own, asked by the card as the home screen appears (`askToDeleteForEveryone` in
`features/home/deletion.ts`). So the session that had the project open is closed before the server
closes its rooms, and the owner is not told by their own editor that its owner deleted it. The
session also follows the project list: when the copy on the device has gone as well, deleted in
another tab, it stops writing and shows the project as not available, and never lists it again.

**Not saving.** A connection can be open and the work still not reach the server: the document has
reached the size the server allows, the server has no memory for more, or one change is more than
it takes in a message. The server ends such a connection with close code `1009` and says why first.
`SessionMeta.notSaving` then holds the reason as a sentence for the person (`session/saving.ts`
words it), the top bar reads “Not saving to the server”, and the connection, which would only send
the same thing again, tries once a minute instead of at once (`SyncProvider.patient`). The changes
stay in the local document meanwhile. The notice is withdrawn when a connection has synced and
stayed open for five seconds with nothing left to send. A document the server holds more of than
it loads is found out over HTTP (`docs` in `GET /api/projects/:id`), since a refused upgrade tells
a browser nothing; with nothing of the project on the device that is the “not available” screen,
because an empty document is not the project. For the same reason the editor stays on its opening
screen until a shared project the device holds nothing of has synced once (`Workspace` in
`features/editor/Editor.tsx`): on first opening a link, and after a copy the server would not take
has been thrown away.

**Replacing a project.** Restoring a version and replacing the open project with a file both go
through `Session.replaceProject`, the one place that swaps everything a project holds: it keeps
what is known about uploads, follows a change of frame rate (comments, playhead and range move
with it) and files the whole thing as one undo step.

**Upload flags.** `uploaded` on an asset is what tells everyone else that the file can be fetched,
and the document can be behind the server: a version from before an upload finished brings the
asset back unflagged, and so does undoing its removal, while the person who has the file may not be
around. A session that may edit therefore asks the server once (`HEAD …?probe`) about each file
that is neither on its device nor flagged, and sets the flag when the server holds it. The flag can
also be ahead of the server: media that nothing referred to for long enough is cleared away there,
and an asset can come back later than that. A session that may edit takes the flag back when the
server answers `404` for the file (`Session.serverLacks`); whoever still has the file then uploads
it again. `Session.publish` clears every flag in the copy it publishes.

**Media transfers.** An import joins the media pool, and the document, as soon as the file has been
probed: the file serves the asset from memory while its copy is written to the device behind it.
Uploads and downloads go through one queue that runs two of each at a time, most urgent first —
which leaves connections free for the range requests the preview streams with — and tries a failed
transfer again by itself, at growing intervals.

The home screen deliberately does not import the engine, so it loads in a fraction of the editor's
bundle; the editor chunk is warmed in the background while you choose a project.

## 5. Testing strategy

| Layer   | What is checked                                                                                                                                                                           | Where                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Model   | timecode, keyframes, every edit operation, CRDT convergence, per-user undo, hostile input                                                                                                 | `packages/core/test`                                                                                                    |
| Server  | auth, roles, sync, persistence across restart and torn logs, resumable media, versions, connection limits, deleting projects and versions, the sweep of unused media                      | `apps/server/test`                                                                                                      |
| Engine  | all shaders compile and draw, geometry and colour, frame accuracy, HDR code values, memory held, context loss, title wrapping, sound that will not decode, exports inspected with ffprobe | `e2e/engine*.spec.ts`, `packages/engine/test`                                                                           |
| Editor  | the parts that are plain functions: panel layout, layers and focus, access, the transfer queue, timing, shortcuts, the service worker, the title field's geometry, the typing history     | `apps/editor/test`                                                                                                      |
| Product | mouse-driven editing, reload persistence, panels and dialogs from the keyboard, export, multi-user sessions with roles, typing into titles, deleting                                      | `e2e/editor.spec.ts`, `e2e/collab.spec.ts`, `e2e/text-edit.spec.ts`, `e2e/delete.spec.ts` and the other specs in `e2e/` |
| Build   | the production build in a browser: the site, its menu and notices, the editor under `/app/`, security headers, service worker, no network                                                 | `e2e/smoke` (`pnpm test:smoke`)                                                                                         |

The engine tests run through a bare "lab" page (`apps/editor/lab.html`) that exposes the engine
without the editor around it. WebGL runs on SwiftShader, so the suite needs no GPU.
