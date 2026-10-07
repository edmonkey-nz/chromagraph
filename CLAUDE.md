# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# data-wrangler

Realtime data visualisation instrument. Loads static CSV/JSON files, maps columns onto
instanced 2D/3D visuals in a layer stack, and outputs live to an HD projector. Used both
for desk exploration and for unattended installation playback (hours at a time).

Use British/NZ spelling in UI text, comments and docs.

## Hard constraints

1. **Never fail dark.** The output window must keep rendering the last good frame state
   whatever else breaks (control window closed, server down, bad data file, bad layer
   config, shader compile failure). A failing layer is disabled and flagged in the control
   GUI; it never blanks the canvas or throws out of the render loop.
2. **Never block the render loop.** No synchronous file I/O, parsing or layout on the
   output's main thread. Parsing runs in a web worker. No per-frame allocations in hot paths.
3. **Output window is clean.** No GUI, no dialogs, no alerts, no scrollbars, no cursor.
   Diagnostics go to the control window and the server log only (optional debug overlay
   toggled from control, off by default).
4. **Target hardware:** laptop with NVIDIA GTX 1650 (4 GB VRAM), Ubuntu, Chrome,
   one 1920x1080 projector. Budget: 60 fps with 200,000 instances across all layers.
5. **WebGL2 is the baseline renderer.** Do not depend on WebGPU-only features (TSL-only
   nodes, compute shaders). WebGPU may be added later behind a flag.
6. **Data is never silently altered.** Missing values stay missing (NaN), gaps in time
   stay visible when a layer is in time mode. No interpolation unless a layer asks for it.
7. **No joins or consolidation.** Each dataset is independent. Layers reference exactly
   one dataset. Do not build cross-dataset resampling.
8. **Live only.** No video/PNG/SVG export, no live data sources, no MIDI/OSC yet. Do not
   add them, but do not design them out (see Parameter system).
9. **Saves are atomic.** Write to a temp file then rename. A crash mid-save must never
   corrupt a project.

## Stack

- TypeScript (strict), Vite, npm. No distributable packaging at this stage.
- Three.js (WebGLRenderer) for all rendering, 2D and 3D in one scene graph.
- D3 modules for maths only (d3-scale, d3-array, d3-hierarchy, d3-time). Never D3 DOM/SVG.
- Papa Parse in a web worker for CSV.
- troika-three-text for in-scene text overlays.
- Tweakpane for the control GUI.
- Node server (Fastify + ws): serves both windows, owns project files, relays state.
- Vitest for the data and mapping layers (pure functions, no GPU needed).

## Architecture

Three processes, one source of truth:

```
control window  <--ws-->  server (Node)  <--ws-->  output window
  (GUI, preview)        (project files, state)     (fullscreen on projector)
```

- The **server** holds authoritative project state and persists it.
- The **control window** sends state patches and shows a small live preview.
- The **output window** receives state, loads its own data, and renders. It caches the
  last full state locally and reconnects with backoff if the socket drops. It must boot
  into the last opened project with no control window present.

### Projects

```
projects/<name>/
  project.json      layers, mappings, parameters, timeline, camera, schema version
  data/             source CSV/JSON files, copied in on import, never modified
```

`project.json` carries a `version` field; write a migration whenever the schema changes.
Projector calibration is NOT in the project. It lives in `output-profiles/<name>.json`
(one per venue/projector) so a project can move between rooms.

### Data layer

- Files up to ~2 MB (roughly 50k-100k rows). Parse once, hold in memory as columns.
- Each column is a typed array plus metadata: inferred type (number, time, category,
  text), min, max, null count. Numbers are Float32Array, timestamps are epoch-ms
  Float64Array, missing values are NaN.
- Strip BOM, tolerate empty columns, trailing commas and blank lines. Report parse
  problems per file in the control GUI.
- Timestamps are kept in UTC; display timezone is a per-dataset setting (default
  Pacific/Auckland).
- Every layer picks an **x mode**: `index` (row order, gaps collapsed) or `time`
  (true time axis, gaps shown). Default is `time` when a time column exists.

Reference dataset: NIWA daily rainfall (`Observation time UTC`, `Rainfall [mm]`, mostly
empty deficit/runoff columns, irregular gaps). Keep a copy in `test/fixtures/`.
Readings are taken at 09:00 local time, but before 1941 NZ ran on NZ Mean Time (+11:30), so those
rows show as 08:30 Pacific/Auckland. That is correct, not a parsing bug.
`3384__Rain__daily-sample1.csv` has one corrupt row (row 24), so one of its columns parses as text.

GPU precision: time columns are epoch-ms float64. Upload offsets from the column's `min` to the
GPU, never raw epoch-ms, because at 1879 dates the float32 step is about 4 minutes.

### Layer stack

After Effects style ordered layers, not a node graph. Each layer is:

```
dataset -> row filter/range -> mapping -> primitive -> instancer -> transform -> blend
```

- **Mapping:** data column -> visual channel (x, y, z, scale, rotation, colour, opacity)
  through a scale (linear, log, sqrt, quantise, colour ramp).
- **Primitive:** point, quad, bar, line segment, box, sphere, text glyph, custom mesh.
- **Instancer:** one instance per row via InstancedMesh, with a per-instance offset step
  in X/Y/Z (e.g. 20 px per index) and optional grid/radial/spiral arrangement.
- Mapping maths runs in the vertex shader from per-instance attributes or data textures
  wherever possible, so changing a mapping parameter does not re-upload data.
- Lines are real geometry (screen-space quads) with a width in pixels, never GL 1 px lines.

Layer types, in build order: instancer (points/bars/shapes), line, heat map (data
texture, including year x day-of-year calendar), text overlay, small multiples (grid of
charts as one instanced draw), dendrogram (d3-hierarchy layout), 3D surface.

### Parameter system

Every tweakable value is a registered **parameter** with id, type, range and default.
Nothing reads a raw GUI value. This is what makes values saveable, animatable and later
mappable to MIDI/OSC.

- A parameter's value = base value + optional **modulator**: LFO, ramp, noise, or
  timeline keyframes.
- A global **timeline** playhead runs 0..1 over a set duration (seconds to hours) and
  loops. A "data playhead" modulator sweeps a layer's row range from it, giving slow
  playback through a record over N minutes.
- Time comes from one clock in the output window. Animations must be frame-rate
  independent and survive hours of running without drift or float precision loss.

### Output and keystone

- The scene renders to a 1920x1080 render target, then is drawn to the screen through a
  warp mesh. Phase 1: four-corner pin (homography). Later: grid warp, edge mask.
- Calibration UI lives in the control window and drives a test pattern on the output.
- Design text and line weights for projection: minimum line 2 px, minimum text 24 px
  at 1080p, high contrast, dark background by default.

## Robustness checklist (apply to every change)

- try/catch around each layer's update and build; on error disable the layer, log, report.
- Handle `webglcontextlost` / `webglcontextrestored` and rebuild GPU resources.
- Dispose geometries, materials and textures when layers are removed or rebuilt. Watch
  VRAM; 4 GB is the ceiling.
- Server restart must not disturb a running output window.
- Autosave on change (debounced), atomic write, keep the previous save as `.bak`.

## Machine notes

- The laptop likely has hybrid graphics. Chrome must run on the NVIDIA GPU, not the
  integrated one. Check `chrome://gpu`; launch with PRIME offload if needed
  (`__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`). Log the renderer
  string at start-up and warn in the control GUI if it is not NVIDIA.
- Installation mode: Chrome `--kiosk` on the projector display, screen blanking and
  notifications disabled, laptop on mains power.

## Build phases

Status: phases 1–3 are done (instancer layers, mappings, 3D camera, control preview).
Phase 4 is next.

1. Server, project folders, two windows, state sync, reconnect behaviour.
2. Data layer with tests against the rainfall fixture.
3. Instancer layer with mappings and X/Y/Z offset. Tweakpane control.
4. Parameter registry, modulators, timeline and data playhead.
5. Keystone and output profiles.
6. Line, heat map and text layers.
7. Small multiples, dendrogram, 3D surface.

## Commands

- `npm run dev` : one process on 127.0.0.1:8080 (override with `PORT` / `HOST`). Fastify
  serves the server routes and mounts Vite as middleware. Control is at `/control`, output
  at `/output`. `tsx watch` restarts the server on server-code edits; client edits go
  through Vite HMR, which reloads the page.
- `npm run build` then `npm start` : production (built bundle, no HMR). Use this for
  installations, because in dev a source edit reloads the output.
- `npm test` : runs all tests with Vitest. Tests are pure Node, with no browser or GPU.
- `npx vitest run test/data/parse.test.ts` : runs one test file. Add `-t "name"` to run a
  single test.
- `npm run typecheck` : TypeScript 7 (native `tsc`), strict, with `noUncheckedIndexedAccess`.
  Imports use explicit `.ts` extensions.

## Code map

`src/shared/` is imported by both the server and the browser, so it must stay free of DOM
and Node APIs. `src/data/` is pure apart from the worker and loader files, and runs inside
the parse worker.

**State flow.** The synced document is `SyncDoc = { project, session }`
(`shared/project-schema.ts`). Here is the path of a single change:
1. Control calls `sendPatch` with ops such as `{op:'set', path:['project','output','background'], value}`.
2. The server's `Hub.applyPatch` (`server/hub.ts`) applies the ops with structural sharing
   (`shared/patch.ts`), then validates the whole doc against the zod schemas. An invalid
   patch is rejected and the sender is resynced.
3. If it is valid, the hub bumps `rev` and broadcasts `{t:'patch', rev, ops, origin}`.
   Changes under `project.*` trigger a debounced atomic save; `session.*` is never saved.
4. Each window's `SyncedState` (`client/common/synced-state.ts`) applies the patch only if
   `rev === local + 1`. Otherwise it requests a full snapshot.
5. The output's `applyDoc(doc, prev)` in `client/output/main.ts` reconciles the scene by
   comparing references, so a full resync after a reconnect changes nothing visible.

Message shapes and their runtime guards are in `shared/protocol.ts`. A client must send
`hello` first; the server ignores anything before it. Only control windows may patch.

**Schema changes.** When `project.json` changes shape:
1. Edit `ProjectSchema` and bump `CURRENT_VERSION`.
2. Add a `migrations[n]` step.
3. Save an example of the old version as `test/fixtures/projects/vN.json`. A test migrates
   every fixture in that folder.

**Data flow.**
1. `POST /api/projects/:name/data` (`server/data-routes.ts`) writes the upload into `data/`
   unchanged and adds a dataset entry through `hub.applyPatch`.
2. Each window parses the file itself. `DatasetLoader` (`data/dataset-loader.ts`) hands
   the work to `parse.worker.ts`, which fetches the file, runs `parseText` and
   `detectCadence`, and transfers the typed-array buffers back.
3. Results use the column contract in `data/columns.ts`. Inference rules are in
   `data/infer.ts`: no coercion, and only empty or whitespace values count as missing.
4. The output keeps tables in `DatasetStore` (`client/output/datasets.ts`), which holds on
   to the last good table if a reload fails.
5. Control shows the per-file report in `client/control/datasets-panel.ts`.

**Rendering.**
- `Stage` (`client/output/stage.ts`) draws the scene into a 1920x1080 MSAA target, using a
  pixel-space orthographic camera (x 0..1920, y 0..1080, y up). It then draws that target
  to the screen through a quad, which will become the keystone warp mesh in phase 5.
- Layers implement `LayerInstance { object, update(ctx), dispose() }` and are owned by
  `LayerHost` (`client/output/layers/layer.ts`). `LayerHost` fences build, update and
  dispose, and compiles every new layer's shaders immediately via `Stage.verify`, so a
  shader error fails the layer instead of the frame.
- `client/output/layers/test-pattern.ts` is the simplest example of a layer.

**Instancer layers (phase 3).**
- The config contract is `shared/layer-schema.ts`. Its comments define the units and the
  arrangement maths: what "t" means, and the y-up pixel space.
- `LayerManager` (`client/output/layer-manager.ts`) compares each layer's `structureKey` (from
  `data/instance-data.ts`) plus the dataset version. A change there rebuilds the layer;
  any other change only updates uniforms through `InstancerInstance.apply`.
- `buildInstanceData` (pure, tested) turns columns into float32 instance arrays. Missing
  values become the `MISSING` sentinel, and the shader hides those instances.
- `normalise()` in the same file is the tested twin of the GLSL scale maths in
  `client/output/layers/instancer.ts`. Change both together.
- Calendar fields (year, day of year in the dataset's timezone) are computed in the parse
  worker. The output's `DatasetStore` reloads a dataset when its timezone changes.
- On the control side, `shared/layer-defaults.ts` (`defaultLayerFor`, `fitLayer`) chooses
  the starting layout. `client/control/layers-panel.ts` is the Tweakpane UI: it sends
  minimal patches, finds a layer's index by id at send time, and checks every value
  against the schema before sending it.
- `/output/?preview` is the control window's embedded preview. It connects with role
  `preview`, renders at half resolution, and never reports status or logs, nor writes
  the output's state cache.

**Offline boot (production only).**
- A service worker (`src/server/static/output-sw.js`, served at `/output/sw.js`) lets the
  output reload while the server is down. It is network-first with a cache fallback.
- After registering it, the page posts the URLs it has already loaded, plus each dataset
  URL, so a first-boot reload can still come from the cache.
- In production the parse worker starts from a blob URL, because Chrome does not send a
  dedicated worker's script load through the service worker. URLs passed to the worker
  must be absolute.
- Dev mode unregisters any leftover service worker.

**Persistence.**
- `writeFileAtomic` (`server/projects.ts`) writes to a temp file, fsyncs it and renames it
  into place. It makes `.bak` by hard-linking the old file.
- If `project.json` is unusable, loading falls back to `.bak`. The bad file is renamed to
  `project.json.corrupt-<time>`, so the next save can't rotate it over the good backup.
- `server-state.json` records the last opened project, so the output boots into it even
  when no control window is open.
