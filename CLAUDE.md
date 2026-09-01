# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read the two design documents first

`README.md` (1199 lines) was written by an agent, for agents — it is the primary
orientation document, not a user-facing readme. `docs/ARCHITECTURE.md` (1649
lines) is the design contract and numbers its invariants. **Do not summarize
them into this file; route to them.**

| Question | Where |
|---|---|
| Why is this module shaped like this? | `docs/ARCHITECTURE.md`, "Design rules" (invariants 1–10) |
| What is the frame loop? | ARCHITECTURE "Control & data flow (per frame)"; code in `src/orchestrator/orchestrator.ts` |
| Coordinate/aspect math | ARCHITECTURE "The view transform"; code in `src/particleSystem/coords.ts` + `src/shaders/common.wgsl` |
| Save format, hover-preview, history | ARCHITECTURE "Saving & loading", "Particle selection and history" |
| WebGPU-vs-OpenGL translation traps | README "The engine, and the two Y flips", "`common.wgsl` and the two-copy layout hazard" |
| Every deliberate difference from the retired desktop app | README "Known divergences from the desktop" (~40 entries, each also commented at its site) |
| Tweakpane pitfalls | README "THE RETAINED-MODE FEEDBACK LOOP" and "The panel" |
| Input capture / hotkeys | README "Input, and how capture is resolved" |
| Preset storage | README "Config storage: a manifest and IndexedDB" |

## Commands

```
npm install
npm run dev                       # Vite dev server, http://localhost:5173
npm test                          # node --test over tools/**/*.test.ts and src/**/*.test.ts
npm run typecheck                 # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run build                     # sync:configs:check && typecheck && vite build
npm run sync:configs              # configs/ -> public/configs/ + manifest.json
```

**Single test file:** `node --test src/config/shareLink.test.ts`
**Single test by name:** `node --test --test-name-pattern="<regex>" src/config/shareLink.test.ts`

**Node 22.6+ is required, not 20.** `npm test` and `tools/syncConfigs.ts` run
`.ts` entry points through Node's native type stripping. CI pins Node 24;
README's "Node 20+" line is wrong for those paths. Developed against v24.18.0.

### Browser-driven checks (never in CI)

These need a real GPU, a **headed** Chrome over CDP, and `npm run dev` already
running — headless Chrome returns a null adapter, so nothing in `npm test`
compiles a single line of WGSL.

```
node tools/browserCheck.mjs                      # loads the page, reports console + pipeline status
node tools/browserCheck.mjs --url "?debug&camera=particles" --shot out.png
node tools/fieldCheck.mjs --keep-shots ../field  # strafe field + its Y flip
node tools/configCheck.mjs                       # manifest + IndexedDB, across a reload
node tools/uiCheck.mjs                           # gated latch, reveal toggle
node tools/saveTransferCheck.mjs                 # save round trip through real IndexedDB
```

Other tools: `tools/linkToConfig.mjs` (share link → `.json` preset),
`tools/qrSurvival.mjs` + `tools/qrDecodeImage.mjs` (does the QR stamp survive a
social platform's re-encode), `tools/migrate_v7.py` + `tools/validateMigrated.ts`
(one-way v7→v8 migration, validated through the app's own reader).

## The invariants whose violation is SILENT

Everything here fails without an error, a crash, or a visible symptom. That is
why each is called out rather than left to the reader.

- **The Orchestrator is the sole broker** (ARCHITECTURE invariant 3). Modules
  never import each other's stateful classes. The sanctioned exception is
  `particleSystem`'s *pure leaves* — `coords`, `sizing`, `config`, `layout`,
  `pack`, `dispatch`, `pick`. Reaching past a leaf into `particleSystem.ts` is
  what the rule forbids.
- **Every struct crossing the host/GPU boundary is vec4-only** (invariant 7).
  Scalars ride in vec4 lanes; ints ride in float lanes via bitcast. std430 and
  WGSL disagree about mixed-scalar structs.
- **GPU struct layout is hand-authored in TWO files.** `src/shaders/common.wgsl`
  is what the GPU reads; `src/particleSystem/layout.fixture.json` is what the
  host packs against. **Change a struct and edit both in the same commit.**
  `common.wgsl.test.ts` and `assertLaneMap` (in `config.ts`) check them against
  each other in both directions. A divergence does not error — the host writes
  416 bytes to one plan, the shader reads them to another, and the physics is
  just subtly wrong.
- **Three fixtures are FROZEN and must never be regenerated from the
  TypeScript**: `src/testing/parity.fixture.json`, `src/config/presets.fixture.json`
  (both golden values from the deleted Python reference), and
  `src/particleSystem/layout.fixture.json` (hand-authored). Recomputing them
  from the port turns an independent check into a tautology — a symmetric error
  in a round trip still closes perfectly. A failure means the port changed.
- **In every Tweakpane handler, test `isRefreshing()` FIRST.** `pane.refresh()`
  fires `change` on every binding, and `ev.last` cannot distinguish a released
  drag from a programmatic push. Getting the order wrong folds an open gated
  slider away on the next frame, silently. See README "THE RETAINED-MODE
  FEEDBACK LOOP" for the measured bug (one `Next >` recorded four phantom
  history entries).
- **Panel visibility is `blade.hidden`, never a pane rebuild.** A rebuild drops
  folder state and replaces every DOM node, and looks identical in a screenshot.
  `uiCheck.mjs` asserts the element survives a toggle.
- **Nothing about a gated control's on/off state is stored** — it is derived from
  the value. That is what makes save, load, undo and hover-preview work without
  knowing gating exists. Do not add a flag.
- **The hotkey table is deliberately Ctrl-free.** `C`/`V`/`M`/`Z`/`Shift+Z` where
  the desktop had Ctrl combinations, so no app hotkey ever `preventDefault`s a
  browser one. This is a decision, not an oversight — read README "The hotkey
  table" before "restoring" any of them. `WASD`/`Q`/`E` are **not** in the table
  and must not be; they read `keysHeld` against `dt` in `applyCameraKeys`.
- **The strafe field's Y flip is the most dangerous one in the port**, because
  the debug overlay *confirms* the bug: `frameAssembly.wgsl` samples the field
  with the same unflipped uv the mouse produced, so a mirrored field still draws
  the stroke where you painted it while the physics pushes the other way. No
  screenshot catches it. That is what `tools/fieldCheck.mjs` is for.
- **`#include` in `.wgsl` is resolved by a Vite plugin** (`tools/wgslInclude.ts`),
  so any module importing a `.wgsl` file is untestable under `node --test`.
  That is why each has a **pure leaf beside it** (`blurSchedule`, `bloomChain`,
  `dispatch`, `fieldSize`, the uniform packers, `gating`, `reveal`,
  `previewSession`, `panelModel`). Keep new decidable logic in leaves.
- **Order is the enum** in the settings registry's dropdowns: a label's index is
  the value uploaded, so reordering a tuple silently changes what every saved
  config means.
- **A `Setting`'s `field` is an unchecked string.** An entry naming a field that
  does not exist renders, drags, and does nothing. `settingsSpec.test.ts` is what
  catches it — run it after touching `src/ui/settingsSpec.ts`.

## Repo facts worth knowing before you act

- **`All-Web` is both the main branch and the deploy trigger.** Pushing to it
  publishes to GitHub Pages via `.github/workflows/deploy.yml` (which runs
  `npm test` then `npm run build`). Treat a push as a release.
- **Presets are data, not code.** Drop a v8 `.json` into `configs/` and run
  `npm run sync:configs`. `syncConfigs.ts` parses every file through the app's
  own reader (so a malformed preset fails there with a real message) and mirrors
  the output directory (so a removed preset stops shipping). `npm run build`
  runs `sync:configs:check` and fails on a stale `public/configs/`.
  `configs/custom/` is local scratch and is never shipped.
- **Comments cite Python files that no longer exist** (`persistence.py:128`,
  `camera.py:14-18`). They are kept on purpose — each marks a non-obvious
  decision. Resolve one out of history:
  `git show 901c714^:particle_system/persistence.py | sed -n '120,135p'`
  (`901c714` removed the Python app).
- `src/orchestrator/featureFlags.ts` holds build-time flags for undecided
  experiments. A flag lives there only while the question is open; once answered
  both the flag and its branch go.

## Where README.md has drifted

Verified against the code as of this writing:

- **The default preset is `Tangle`** (`configStore.ts:86`, `DEFAULT_PRESET_NAME`),
  not `Starcrossedv8`. The README's `?preset=` examples name deleted files.
- **The Layout table predates five modules**: `src/recorder/` (lazily-loaded MP4
  export via mediabunny), `src/share/` (screenshot with the project QR-stamped
  into it — the image *is* the project), `src/calibration/` (first-run GPU ladder
  behind the splash), `src/perf/` (auto-calibrate physics rate against the open
  project), and the mobile/touch layer (`ui/mobile.ts`, `ui/touchBinding.ts`,
  `ui/touchGestures.ts`). Also newer: `src/config/shareLink.ts` + `shareCodec.ts`
  (a v8 document packed into a URL fragment) and `src/config/urlOptions.ts`.
- **The URL-parameter table is incomplete.** Still accurate: `?debug`,
  `?preset`, `?camera`, `?zoom`, `?pan`, `?nopanel`. Also live:
  `?mobile`, `?nosplash`, `?nocalibrate`, `?bus` (exposes the Orchestrator on
  `window.__fluoddity` for the verification tools), and `urlOptions.ts`'s
  `?splash`, `?name`, `?trailmap` plus per-preference numeric params. URL
  settings are **untrusted**: `urlOptions.ts` parses and clamps them into a
  *proposal*, and a dialog decides — a query parameter must not be the back door
  that does what a loaded config is forbidden to do.
- **`ui/settingsSpec.ts` has 40 entries**, not 35. The 35 in
  `settingsSpec.test.ts:132` is the *ported* subset, asserted separately.
- **`←`/`→` no longer cycle presets** (README's own hotkey section already
  records this); they drive the cohort stepper, with `Enter` to commit.
- **`COALESCE_WINDOW_MS` is 1500**, not the 500 the README's divergence bullet
  states (`src/project/history.ts:77`). ARCHITECTURE's "1.5s on the web" is the
  correct one, and explains why: nothing on the web slider path calls
  `breakCoalescing`, so a timeout is the only way a gesture ends.
