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
pnpm typecheck    # every package
pnpm test         # unit tests (core model, edit operations, server)
pnpm test:e2e     # Playwright: real editor + real server + real render engine
```

End-to-end tests download nothing at run time; fixtures live in `e2e/fixtures`. A few export tests
inspect their output with `ffprobe` and skip themselves when it is not installed.

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
agrees with the catalogue. The feature list in `README.md` gives both counts as well, and nothing
checks those.

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
