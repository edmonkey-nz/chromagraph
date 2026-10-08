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

Status: phases 1–7 are done. All seven layer types work: instancer, line, heat map, text,
small multiples, hierarchy and 3D surface. Instancers and lines have cloners; lines have
area fill for ridgelines. Layers have transforms with gizmo editing; modulators and the
timeline work; the keystone works. Nothing has been checked on the target GTX 1650 yet.
`FUTURE.md` lists what the user wants next.

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
- `buildInstanceData` (pure, tested) turns columns into float32 per-row arrays. Missing
  values become the `MISSING` sentinel, and the shader hides those instances.
- **Data textures.** The instancer packs those arrays into three RGBA32F data textures,
  4096 texels wide. The vertex shader looks rows up with
  `texelFetch(row % 4096, row / 4096)` and maps `gl_InstanceID` to (row, clone).
  - Only visible rows × clones are drawn. Changing the row range, a domain, range or
    scale, or any cloner field is therefore a uniform update.
  - Instances are capped at 4M per draw.
- **Cloner** (`ClonerSchema`, MoGraph-style).
  - Clone k is offset by k × the position/rotation/scale steps, orbits the layer pivot,
    and fades by fade^k.
  - Clone k takes its mapped values from row i + k·dataStep, but its position from
    row i. That is what produces waterfalls and ridgelines.
  - Clones are drawn far to near, so the originals sit on top.
- **Layer transform.** Every layer has one (position/rotation/scale about a pivot),
  applied as an object matrix in `client/output/layers/transform.ts` and set by
  `LayerManager`. Editing it from the preview gizmo uses the postMessage protocol in
  `shared/editor-protocol.ts`. The preview reports drags, and the control window sends
  the patches.
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

**Layer types beyond the instancer (phases 6–7).** Each type has:
- a renderer in `client/output/layers/<type>.ts`,
- pure data prep with tests in `src/data/<type>-data.ts`,
- an entry in `LayerManager`'s `KINDS` registry (structure key, `needsData`, `create`),
- control folders in `client/control/<type>-folders.ts`,
- defaults and fit in `shared/layer-defaults.ts`.

Notes by type:
- **Heat map, small multiples and surface** keep values in data textures, so most edits
  are uniform updates.
- **Hierarchy** groups rows and runs the d3-hierarchy layout in
  `data/hierarchy.worker.ts`. The worker caches the grouped tree, so a layout or size
  change only re-lays out. The last layout keeps drawing until the next one arrives.
- **Text** uses troika-three-text; its template syntax is in `shared/text-template.ts`.
- **Lines** are screen-space quads. The line cloner draws far to near, with a fill, so
  nearer ridges hide farther ones.

Gap: layers can only report problems by throwing (which flags the layer). Non-fatal notes,
such as the hierarchy label cap or ungrouped rows, only reach the browser console.

**Parameters and modulation (phase 4).**
- `shared/parameters.ts` is the registry. It lists every modulatable number with its id
  (`layer.<layerId>.rows.1`, `camera.yaw`), slider range and hard valid range.
  `project.parameters[id]` holds that number's modulator (`shared/modulators.ts`).
- **Time.** Modulators are pure functions of wall-clock ms (`wallMs()`) and the timeline
  phase, never of summed frame times. That keeps them frame-rate independent, lets the
  output, the preview and the control window agree, and avoids drift over hours.
- **Transport.** `session.transport` drives the timeline. The server persists it in
  `server-state.json`, so a restart keeps the playhead where it was.
- **Output.** `ModulationEngine` (`client/output/modulation.ts`) builds its setters on
  deep-copied scratch configs whenever the project changes. Each frame it only writes
  numbers and calls `LayerManager.applyEffective`. When modulators are removed,
  `applyDoc` calls `reapplyBase()`.
- **Control.** `timeline-panel.ts` and `modulation-panel.ts`, with pure helpers in
  `shared/modulation-helpers.ts`. The "data playhead" is ramp modulators on a layer's
  `rows.0` and `rows.1`.

**Output profiles and keystone (phase 5).**
- The active profile (`shared/output-profile.ts`) is the third root of `SyncDoc`
  (`profile.*`). `ProfileStore` (`server/profiles.ts`) saves it to
  `output-profiles/<name>.json`. Only `default.json` is tracked in git.
- `Stage.setWarp` draws the 1080p target through an exact inverse homography
  (`shared/homography.ts`) in the warp fragment shader. Folded quads are rejected both
  in the control window and on the server.
- The preview is never warped.
- `client/control/calibration-panel.ts` is an SVG corner editor: drag the handles, or
  use the arrow keys (shift for 10 px). Like the other panels, it ignores echoes of its
  own patches.

**Offline boot (production only).**
- A service worker (`src/server/static/output-sw.js`, served at `/output/sw.js`) lets the
  output reload while the server is down. It is network-first with a cache fallback.
- After registering it, the page posts the URLs it has already loaded, plus each dataset
  URL, so a first-boot reload can still come from the cache.
- In production the parse worker starts from a blob URL, because Chrome does not send a
  dedicated worker's script load through the service worker. URLs passed to the worker
  must be absolute.
- Dev mode unregisters any leftover service worker.

**Control window layout.**
- `client/control/index.html` and `main.ts` lay the window out as: a header (project
  switcher, Save, Save As, Snapshots, the save indicator), then a top band with the
  preview top left and data tabs to its right (`tabs.ts`: Datasets, Output windows,
  Calibration, Problems, Log).
- Below that are cards in columns. Each card has its own Tweakpane pane, themed through
  `--tp-*` CSS variables. Shared card helpers are in `ui.ts`.
- The cards are Show (Scenes, Timeline, Modulation), Look (Output & effects, Camera) and
  Layers (double width, one card per layer).
- **Save state.** The save indicator (`shared/save-status.ts`) counts patches in flight
  until their echo arrives and the next `saved` message.

**Saving, Save As and snapshots.**
- Projects still autosave.
- Save now, Save As (`ProjectStore.duplicate`, which builds in a staging folder and
  renames it into place) and snapshots are protocol messages handled in `server/hub.ts`.
- Snapshots live in `projects/<name>/snapshots/<id>.json`.
- Restoring one first snapshots the current state ("before restore"), then applies the
  restored state as a validated patch.

**Scenes and morphing.**
- `project.scenes` holds captured looks: layers, camera, output and parameters.
  `shared/scene-helpers.ts` builds the "go to scene" ops.
- Going to a scene is one patch that copies the scene into the project and sets
  `session.morph`. The output then morphs from what is on screen: matching layers
  interpolate, others crossfade.
- The sender treats that patch's echo as external, so its own panes refresh.

**Control window start-up order.** `client/control/main.ts` creates `SyncedState` before
the panels, because some panels read `state.doc` while they are being built. In the
production bundle, getting this order wrong silently kills the control window.

**Persistence.**
- `writeFileAtomic` (`server/projects.ts`) writes to a temp file, fsyncs it and renames it
  into place. It makes `.bak` by hard-linking the old file.
- If `project.json` is unusable, loading falls back to `.bak`. The bad file is renamed to
  `project.json.corrupt-<time>`, so the next save can't rotate it over the good backup.
- `server-state.json` records the last opened project, so the output boots into it even
  when no control window is open.
- If that project fails to open at start-up, the server shows a fallback but keeps the
  failed project as `lastProject`, so it reopens once fixed.
