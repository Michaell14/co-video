# Contributing to Tandem

Thanks for wanting to help. Tandem is MIT-licensed and built in the open.

## Getting set up

```bash
pnpm install
pnpm dev          # server :8787, editor :5173, website :5174
```

You need Node 20+ and pnpm 10. No GPU is required to run the tests: WebGL falls back to
SwiftShader.

## Before you open a pull request

```bash
pnpm format       # Prettier; CI checks it
pnpm typecheck    # every package, and the tests and configuration files with them
pnpm test         # unit tests: model, edit operations, server, editor logic
pnpm test:e2e     # Playwright: real editor + real server + real render engine
pnpm test:smoke   # builds everything, then opens the production build in a browser
```

### The browser tests

End-to-end tests download nothing at run time; fixtures live in `e2e/fixtures`. A few export tests
inspect their output with `ffprobe` and skip themselves when it is not installed, and the tests
that need a shared project skip themselves when there is no collaboration server to make one. On
CI neither excuse holds, so there a run in which any test skipped fails, and lists what skipped
and why.

`pnpm test:e2e` uses the servers it finds on its ports (API on 8797, editor dev server on 5273)
and starts them itself when nothing is listening. To run beside servers you have open, or to
test a change to the server, give the run a pair of ports of its own. It then starts both
servers from your working tree and stops them when it is done:

```bash
TANDEM_E2E_SERVER_PORT=9697 TANDEM_E2E_EDITOR_PORT=9673 pnpm test:e2e e2e/collab.spec.ts
```

The editor's dev server reloads a page when a source file is saved. A test that is running at that
moment carries on in a page that has forgotten everything it set up, and fails in a way that has
nothing to do with the change. Do not edit while a run is going, or have the test call
`noReloads(page)` from `e2e/helpers.ts` before it opens the page.

To see the editor as it is without HTTPS, open it under a name that is not `localhost` (Chromium's
`--host-resolver-rules="MAP tandem.test 127.0.0.1"` makes one up). If `HTTPS_PROXY` is set on your
machine, start that browser without it: Chromium fetches the page directly but sends its WebSockets
to such a name through the proxy, and the editor then reports a project as offline that the server
is serving perfectly well.

A test that fails leaves a folder in `test-results/` with a screenshot, the page's accessibility
tree and a trace of everything the test did: `pnpm exec playwright show-trace` followed by the
path of the `trace.zip` opens it. CI keeps the same folder as an artifact of the failed job.

`pnpm test:smoke` is the one test of what actually ships. The rest of the suite runs on the dev
server, which has no service worker, no Content-Security-Policy, no bundling and no `/app/` path.
The smoke test builds the editor, the website and the server, starts the built server on port 8798
(`TANDEM_SMOKE_PORT` changes it) and goes once through the product: the site, a shared project, a
second person joining by link, an export, a reload with no network. It fails on any console error,
on any request for a file the build does not have, and on anything the pages' security policy
blocks.

## Where things live

| Path              | What it is                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | The project model, the Yjs store, edit operations, frame resolver, colour math, effect and transition definitions. Pure TypeScript, no DOM. |
| `packages/engine` | WebGL2 compositor, decode cursors, audio graph, player, exporter. Browser only.                                                             |
| `packages/design` | Design tokens shared by the editor and the website.                                                                                         |
| `apps/editor`     | The React editor.                                                                                                                           |
| `apps/server`     | Collaboration + media server.                                                                                                               |
| `apps/site`       | Marketing website.                                                                                                                          |
| `e2e`             | Playwright tests and media fixtures.                                                                                                        |

`docs/ARCHITECTURE.md` explains how the pieces fit together and why.

## Adding an effect or a transition

Effects and transitions are data. Append an entry to `packages/core/src/effects.ts` (or
`transitions.ts`): a parameter schema and one or more GLSL passes. The engine's generic runner
compiles it, the inspector builds its controls from the schema, the library shows a live thumbnail,
and the end-to-end suite automatically compiles and renders it. See the conventions at the top of
`packages/core/src/glsl.ts` (premultiplied alpha, working encoding, top-left UVs, the `u_px`
reference-pixel scale).

The website keeps its own copy of the catalogue's names and counts, because it is not built from
the editor's packages. Add an effect's name to `CATALOGUE` in `apps/site/src/sections/Effects.tsx`,
in the place it has in `effects.ts`; for a transition, raise the number in that file's
"transitions" heading. `pnpm test` fails, and says which of the two it wants, until the website
agrees with the catalogue. The feature list in `README.md` gives both counts as well, and the same
test fails until they are the catalogue's.

## Adding a dependency

Whatever ends up in the editor, the website or the server is somebody's work under somebody's
licence, and `apps/editor/public/THIRD_PARTY_NOTICES.txt` names all of it: it ships with every
build. Add the package there, with its licence and copyright line, and the licence's text if the
file does not have it yet. `pnpm test` fails, and says what is missing, until the notices cover
every package a build is made from.

The website can be hosted without the editor, so it carries a list of its own,
`apps/site/public/THIRD_PARTY_NOTICES.txt`, which its footer links to. It names what the website is
built from and nothing else: a package the website starts to use goes into both files, and one it
stops using comes out of this one. `pnpm test` checks that as well.

## Ground rules

- **Edits are operations.** Anything that changes a project returns `Edit[]` from
  `packages/core/src/ops.ts` and is committed through `ProjectStore.commit`. That is what gives
  every feature undo, multiplayer sync and drag previews for free. Do not write to the Yjs
  document from UI code.
- **The renderer is deterministic.** Given a project and a frame number it must draw the same
  pixels in preview and in export. Anything time-varying takes its time from the clip, never from
  the wall clock.
- **Collaborators run different hardware.** Never store device-specific values (pixels at a
  particular preview size, local file paths) in the project.
- **Say what you verified.** If something could not be tested on your machine (HEVC encode, an
  HDR display), say so in the pull request.
