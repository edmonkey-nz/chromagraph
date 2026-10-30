# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# chromagraph

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

- **As of 2026-10-09:** the NVIDIA driver (595.99.02) loads on kernel 7.0.0-38. Chrome on
  Wayland still defaults to the AMD iGPU, because it adds `--render-node-override` for the
  compositor's GPU. Forcing the NVIDIA node on Wayland crashes Chrome (the compositor rejects the
  NVIDIA frames), and ANGLE-Vulkan gives no WebGL. What works is `--ozone-platform=x11` with
  `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia` (see the README). Since 2026-10-10 the output has been checked on the GTX 1650: about
  214,000 isometric boxes ran at 227 fps uncapped, and spot checks with shadows, blur,
  reflections and depth of field held 60 fps.
- `README.md` has the start-up steps for the user; `FUTURE.md` is the user's wish list,
  with status notes.

- The laptop likely has hybrid graphics. Chrome must run on the NVIDIA GPU, not the
  integrated one. Check `chrome://gpu`. On Wayland the PRIME variables need
  `--ozone-platform=x11`; see the README's GPU section. Log the renderer
  string at start-up and warn in the control GUI if it is not NVIDIA.
- Installation mode: Chrome `--kiosk` on the projector display, screen blanking and
  notifications disabled, laptop on mains power.

## Build phases

Status: phases 1–7 are done, plus the first round of FUTURE.md: save, Save As and
snapshots; scenes with morphs; bloom and trails; and the redesigned control window. All seven layer types work: instancer, line, heat map, text,
small multiples, hierarchy and 3D surface. Instancers and lines have cloners; lines have
area fill for ridgelines. Layers have transforms with gizmo editing; modulators and the
timeline work; the keystone works. The second round of FUTURE.md added per-layer
shadow, blur and fixed to screen, an isometric camera, box edges, reflection planes and
camera depth of field.
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
   `data/infer.ts`: no coercion, and only empty or whitespace values count as missing, plus the
   dataset's own "treat as missing" markers (`Dataset.missing`, schema v24): cells equal to one
   after trimming are blanked in `buildResult` (`data/parse.ts`) before the type is decided, and
   the report notes how many each marker blanked, with rows. Both windows pass the markers to the
   parse worker and parse again when they change. A mostly-numeric warning carries its odd texts
   (`ParseIssue.markers`); the Datasets tab offers them as a one-click "Treat … as missing".
4. The output keeps tables in `DatasetStore` (`client/output/datasets.ts`), which holds on
   to the last good table if a reload fails.
5. Control shows the per-file report in `client/control/datasets-panel.ts`, and "View rows"
   opens a `TableViewer` (`client/control/table-viewer.ts`): virtualised (only rows in view
   are in the DOM), sortable by column, go to row. Cell text and sort order are pure and
   tested in `data/table-view.ts`. Row numbers count data rows from 1, as parse messages do.

**Rendering.**
- `Stage` (`client/output/stage.ts`) draws the scene into a 1920x1080 MSAA target, using a
  pixel-space orthographic camera (x 0..1920, y 0..1080, y up). It then draws that target
  to the screen through a quad, which will become the keystone warp mesh in phase 5.
- Layers implement `LayerInstance { object, update(ctx), dispose() }` and are owned by
  `LayerHost` (`client/output/layers/layer.ts`). `LayerHost` fences build, update and
  dispose, and compiles every new layer's shaders immediately via `Stage.verify`, so a
  shader error fails the layer instead of the frame.
- `client/output/layers/test-pattern.ts` is the simplest example of a layer.
- `camera.projection: 'isometric'` (schema v12) uses `Stage.isometricCamera`: orthographic,
  with the same orbit as the perspective camera, and distance scales the view
  (`isometricHalfSize`). The Camera card's "Isometric view" sets yaw 45 and pitch 35.26.

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
- **Box edges** (`layer.edges`, schema v12): the `EDGES` block is compiled into every box
  layer and switched by uniforms. Edge width is in screen pixels, from `fwidth` of the face
  UVs. Face opacity below 1 makes the layer translucent. Edge glow brightens the edge and adds
  an inward halo, because the 8-bit scene target clamps above 1.0. Presets are `edgePreset`
  in `layer-helpers.ts`.
  Width uses the UV gradient's length (not `fwidth`), and narrow faces get thinner edges. The
  edge's outer side is a triangle edge, so its smoothness comes from the MSAA; that is why the
  scene target uses 8× (measurements in `docs/LINE_QUALITY.md` §4).
- `normalise()` in the same file is the tested twin of the GLSL scale maths in
  `client/output/layers/instancer.ts`. Change both together.
- **Labels** (`InstancerLabelsSchema`, schema v9). An instancer can draw text at points of its
  own arrangement: years, decades, or every N rows with their date or a column's value.
  - `data/instance-labels.ts` (pure, tested) picks the rows and texts. Its `placeLabel` is the
    CPU twin of the shader's `arrange()`; change both together.
  - The labels are a troika `BatchedText` child of the mesh, so the transform, effects and
    visible rows (data playhead) apply. Slot k shows candidate k·stride; at most 500.
  - `hidePoints` draws the labels alone.
- **Axes and value labels** (`InstancerAxesSchema`, schema v15; the "Axes & values" folder).
  - `data/instance-axes.ts` (pure, tested) lays out line segments and texts in the layer's px
    space: value labels at each visible mark (above, inside at the top or middle, or at the
    base), and for the linear arrangement a category axis (baseline plus a label per row) and a
    value axis (d3-scale ticks in the mapped column's units, optional gridlines).
  - Mark extents are another CPU twin of the vertex shader (`placeLabel`, plus the y/z
    offsets, height × size, bars and boxes grown from the base). Change them together.
  - The output draws them as a quad mesh and a second `BatchedText`, both children of the
    mesh, rebuilt only when the axes settings or the numbers in `axisKey` change.
  - Every text has a stable `key` (`v:<row>`, `x:<row>`, `y:<tick text>`, `xt`, `yt`), and the
    output keeps one troika `Text` per key. A new row then lays out only its own labels; with
    texts assigned by list position, every label after it changed text and showed its old
    glyphs at the new place for a frame or two (troika lays out asynchronously).
  - `axes.span` (schema v16): 'full' lays the lines, ticks, gridlines and titles out over every
    row the layer's animation reaches (`rowsSpan` in `shared/reveal.ts`, pushed by
    `LayerManager` through `setRowsSpan`), so a reveal adds only the marks and their labels;
    'visible' grows them with the rows. New layers get 'full'; older projects kept 'visible'.
  - The "Bar chart" preset (`shared/chart-presets.ts`) lays out a linear bar chart with a
    zero-based, rounded height domain, room for both axes, and the row-naming column
    (`labelColumnFor`: a text column, a near-unique category, else the time column).
- Calendar fields (year, day of year in the dataset's timezone) are computed in the parse
  worker. The output's `DatasetStore` reloads a dataset when its timezone changes.
- On the control side, `shared/layer-defaults.ts` (`defaultLayerFor`, `fitLayer`) chooses
  the starting layout. `client/control/layers-panel.ts` is the Tweakpane UI: it sends
  minimal patches, finds a layer's index by id at send time, and checks every value
  against the schema before sending it.
- `/output/?preview` is the control window's embedded preview. It connects with role
  `preview`, renders at half resolution, and never reports status or logs, nor writes
  the output's state cache.

**Row filters** (`layer.filter`, schema v17; `data/row-filter.ts`, pure and tested).
- A list of `{column, values}` conditions on a category or text column: keep rows whose value
  is one of `values` (exact text; missing never matches). Conditions are ANDed. Empty list: every row.
- Filtering runs first, so the row range, aggregation, data playhead, cloner and Fit count the
  kept rows. Kept rows are copied in file order; min/max/null counts and time cadences are worked
  out again, calendar fields sliced, and category dictionaries kept whole (stable codes and colours).
- Output: `LayerManager.filtered` builds the view inside the host fence (cached per dataset
  version and filter, shared by layers), and the filter key is part of the layer key. A missing
  column, a number column or a filter that keeps nothing fails the layer with the reason.
- Control: `DatasetsPanel.summary(id, filter)` gives the kept rows' summary (cached, stable
  identity), so Fit and budgets see them. The "Filter" folder (`addFilterFolder` in
  `layers-panel.ts`, third in data layers' cards) offers `SummaryColumn.values`: category
  dictionaries and text columns with at most `FILTER_VALUES` distinct values. Switching
  dataset clears the filter.

**Text as written.** Number columns record the decimals the file writes
(`NumberColumn.decimals`, set in `data/infer.ts`). Text templates and labels show numbers
with that many decimals, so "12.30" stays "12.30". Dates pad the day ("02 Jan 1879"), so
text never changes width as the playhead moves.

**Dataset credits.** Datasets carry `source`, `url` and `attribution` (schema v14), edited in
the Datasets tab (`datasets-panel.ts`; the cards persist across renders, so echoes never
overwrite a box being typed in).
- Text templates show them with `{@source}`, `{@url}`, `{@attribution}` and `{@credit}`
  ("Source: <source> · <attribution>", empty parts dropped). An empty value or no dataset
  renders as ''. The tokens shadow columns named exactly `@source` etc.
- `LayerManager` passes the dataset entry to `create` and pushes changes through the
  optional `setCredits()` on the instance, so a credits edit never rebuilds a layer.
- Kinds with `needsData: false` build before their dataset loads (text column fields show
  "—" until then).

**About box.** The **?** after the title in the control header opens ABOUT.md (read by
`GET /api/about` on each open) in a `<dialog>`, rendered by `client/control/markdown.ts`.
That renderer is small, tested and escapes all HTML.

**Fonts and text case.** In-scene text (text layers and the labels of instancer, hierarchy and
small-multiples layers) has a font choice. 'terminal' is VT323, a fixed-width 1970s DEC
face (OFL, bundled in `client/output/fonts/`, precached for offline boots); it is the
default. 'sans' is troika's Roboto, fetched online. Text layers also accept a font URL.
Each has an uppercase switch. `client/output/fonts.ts` resolves both.

**Line split and band** (schema v18).
- `layer.split` (lines): one line per value of a category or text column. `data/line-split.ts`
  (pure, tested) cuts the table into one row-filtered view per value and aligns them: the whole
  table's min/max on every number and time column (shared time origin and auto domains) and the
  finest cadence step. Series `index` is the value's place in the full dictionary, so default
  colours (`seriesColour`, Tableau 10) match the control's list whatever is filtered out. At most
  `MAX_SPLIT` (24) values, else the layer fails with the reason.
- `layers/split-line.ts` builds every series' `LineData` first, unions the auto domains, then
  makes one `createLineFromData` instance per series, with per-series scratch configs written in
  place each apply. Labels are troika Texts at `lastVisiblePoint` (allocation-free CPU twin).
- `fill.mode: 'band'` (aggregated lines with y mapped, `wantsBand`): buckets also keep their
  min and max y (`LineData.band`), uploaded as a third texture; the fill pieces span them, and
  the y auto domain covers the band. Split lines draw their band in the series colour.

**Line axes** (`layer.axes` on lines, schema v20; the instancer's `InstancerAxesSchema`).
- `data/line-axes.ts` (pure, tested) lays out value labels, an x axis and a y axis from the line's
  own placement (`linePositions`), so labels sit on the drawn points. Aggregated points are named
  by their period ("Mar 1990", "1990") or rows ("1–30"), using `LineData.bucketStarts`. Split lines
  share one set of axes, with value labels per series (`v:<series>:<row>` keys). x labels thin
  themselves (multiples of `every`) until they don't overlap.
- Drawing is `AxesView` (`layers/axes-view.ts`), shared with the instancer: one quad mesh plus a
  BatchedText with one Text per key. `layers/line-axes-view.ts` keeps a numeric key so a modulated
  line lays its axes out again only when they change; `setRowsSpan` feeds span 'full'.
- The "Axes & values" folder is `control/axes-folder.ts` for both types. With an axis on,
  `fitLineLayer` uses the chart frame (`CHART_LEFT`, `CHART_BASE`, `CHART_HEIGHT`); the "Line chart"
  preset (`lineChartPreset`, also the Add layer "line chart (aggregated)" entry) aggregates and
  turns both axes on.

**Instancer x channel** (schema v18). `channels.x` is a px offset like y and z (texture 2, w).
With a zero step it gives scatter plots. `instance-axes.ts` adds the offset to mark extents, and
a mapped x turns the x axis into a value axis (`xv:<tick>` keys). Labels still ignore offsets.

**Density map** (`density`, schema v18; `layers/density.ts`, pure counting in `data/density-data.ts`).
- Rows are counted on the CPU into `bins` by x and y (number or time columns, time in days from
  the column min), smoothed by a separable gaussian (`radius` in bins), uploaded as one R32F
  texture and drawn as one quad; the fragment shader interpolates bin centres, applies the scale
  and ramp, and fades out below `threshold`.
- Bins, smoothing or domains re-count every row (the auto colour domain is 0..peak of all rows,
  so colours hold during a data playhead) and the visible rows; a new row range re-counts only
  the visible rows. Buffers are reused. Measured 2.7 ms per re-count at 100k rows, 320 × 160
  bins, smoothing 1.5 (a test prints it). If that is too slow: count only new rows for a
  build-up, or move counting to the GPU.
- Dots mode (`mode: 'dots'`, schema v19): every bin with a count is an instanced camera-facing
  soft dot holding (i, j, k, count); the vertex shader places, sizes and hides it, so position,
  size, depth, dot size, scatter, scale and threshold are uniforms and only a re-count refills
  the buffer (at most 500k dots). With `zColumn` the bins are 3D (`binsZ` deep; index
  (k·binsY + j)·binsX + i, and the smoothing gets a depth pass); without, dots rise by count.
  `jitter` moves each dot by a fixed hash of its bin, never outside it, so the grid doesn't show
  as a lattice. 3D bins are capped at `MAX_DENSITY_CELLS` (2M).

**Horizon chart** (`horizon`, schema v21; `layers/horizon.ts`, pure data in `data/horizon-data.ts`).
- Rows become t (index mode: each series counts its own rows; time mode: cadence steps), a value
  and a series (`seriesColumn`, one strip each, at most `MAX_HORIZON_SERIES`). A row covers its
  step [t, t + 1); the visible rows are combined by `fn` into `HORIZON_COLUMNS` (1920) columns per
  series, so a few rows fill wide blocks, many share a column, and gaps in time stay empty.
- One R32F texture (a row per series, MISSING for gaps) and one quad for all strips; the fragment
  shader shades by `horizonLevel` (CPU twin): the distance from `baseline` as a share of the range,
  cut into `bands` stacked in the strip, brighter per band, negatives in their own colour.
- The auto range is the largest combined column over all rows (not the single largest row), so
  the bands hold during a data playhead. Series names are troika Texts left of the strips.

**Stacked split lines** (`split.stack`, v21): `stackSeries` in `data/line-split.ts` (pure, tested)
turns each series into its slice: points at its top, `band` from the series below, so the line's
band fill draws the area ('stream' centres the pile). A point stacks only where every series it
needs has a point at the same t (within half a step); elsewhere the pile breaks. The split renderer
forces the band fill in the series colour. Value labels show slice tops; a streamgraph has no
value axis.

**Line aggregation.** `layer.aggregate` (line layers, v10) turns rows into one point per
week, month, year (calendar fields in the dataset timezone) or N rows, combined by mean,
sum, min, max or last. Missing values are left out, and a bucket with none is missing.
Buckets become the layer's rows, so the row range, data playhead and cloner count buckets.
`LineData.gapUnit` scales the gap rule to the bucket length. Tests are in
`test/data/line-aggregate.test.ts`.

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
- **QR code** (`qr`, `layers/qr.ts`; pure encoding in `data/qr-data.ts`, tested by decoding
  with jsQR): text, or the dataset's `url` from its credits, encoded as UTF-8 bytes with
  `qrcode-generator`. Drawn as one quad with a nearest-filtered texture of one texel per
  module (margin included). The encoded text and level are its structure key (`keyOf` passes
  the credits to `structureKey`), so a new link rebuilds it, and a text too long, which fails
  the layer, recovers on the next edit. It never needs the table. Glow and blur can make the
  code unreadable; the control folder warns but doesn't prevent it.
- **Reflection plane** (`reflector`, `layers/reflector.ts`): a mirror placed by the layer
  transform, with no dataset. It renders the scene from the mirrored camera into a
  half-resolution target with mipmaps and a depth texture, at most once a frame (on its first
  whole-scene draw, keyed by the frame number from `update`). It reflects every layer that is
  switched on (`userData.shown`, set by `LayerHost.place`), never reflection planes or
  screen-fixed layers. The target is cleared to transparent, so its alpha is coverage;
  translucent layers write depth for that render only, so the fade works. With the 2D camera
  it draws its colour alone. Cost: one extra scene render, about 3 ms at 200k boxes on the
  GTX 1650.

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
  `server-state.json`, so a restart keeps the playhead where it was. Opening a project from the
  list (or creating one) restarts the playheads (`Hub.restartPlayheads`): project timeline at
  phase 0, layer timelines and the camera clock at 0, play/pause kept, no morph. Save As keeps them.
- **Playback modes.** A timeline (project or layer) has `playback`: forward, reverse or
  pingpong (schema v10). The transport keeps progress u through one cycle; a ping-pong cycle
  is there and back, so it lasts twice the duration. `playhead()` in `shared/modulators.ts`
  maps u to the phase that modulators see. `progressFor()` maps a scrub back, staying on the
  current ping-pong leg. `reanchor()` keeps the playhead still when the settings change.
- **Fades and gap (project timeline only).** `project.timeline.gap` holds the playhead at the
  end of each looping pass for `gap` s before restarting.
  - The transport's `anchorPhase` is then the position through pass plus gap
    (`cyclePosition`), and progress is held at 1 in the gap. Pass `transportSeconds(tl)` to
    `setPlaying`, and pass the timeline to `seek`.
  - `outputFade` (modulation-helpers) gives a whole-output brightness from the transport:
    an eased fade in and out over `fadeLength` (at most half a pass), and 0 in the gap when
    fading out.
  - `Stage.setFade` applies it in the warp pass, mixing towards the background colour after
    bloom and trails.
  - A layer's own timeline has no fades or gap.
- **Per-layer timelines.** `layer.timeline = { own, duration, loop }` (schema v8). With
  `own` on, the layer's ramps, keyframes and data playhead run on its own timeline, played
  by `session.layerTransports[layerId]`. Without a transport yet, it falls back to the
  project's.
  - `layerPhase` / `paramPhase` in `shared/modulation-helpers.ts` pick the phase. The
    output's `ModulationEngine` computes one phase per owner each frame.
  - Control: each layer card has a "Timeline" folder. `TimelinePanel` drives either the
    project timeline or a layer's, through a `TimelineTarget`. `ownTimelineOps` switches a
    layer on at the project's current position, so nothing jumps.
  - The project transport's Play/Pause and Restart also drive every own timeline; scrubbing
    it does not.
  - Scene morphs switch `timeline` straight to the target's (no lerp).
- **Output.** `ModulationEngine` (`client/output/modulation.ts`) builds its setters on
  deep-copied scratch configs whenever the project changes. Each frame it only writes
  numbers and calls `LayerManager.applyEffective`. When modulators are removed,
  `applyDoc` calls `reapplyBase()`.
- **Control.** `timeline-panel.ts` and `modulation-panel.ts`, with pure helpers in
  `shared/modulation-helpers.ts`. The Timeline tab (see Control window layout) shows every
  modulator as a lane.
- **Animate folder (the data playhead).** Second in every layer card (`AnimatePanel`,
  `client/control/animate-panel.ts`; pure read/write in `shared/reveal.ts`, tested): the rows
  range ("rows from / to"), and "reveal": off, build up (a ramp on `rows.1` from "starts at" to
  "rows to") or window (also a ramp on `rows.0`, a width behind). There is no schema for it:
  `readReveal` reads the mode back from the modulators (anything else is "custom", left to
  Motion effects), and `revealOps` writes the base range and the ramps together. Text layers
  get "follow timeline" (a 0 -> 1 ramp on `row`). The layer's Timeline and Motion effects
  (its `ModulationPanel`) folders sit inside it.

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
- `client/control/index.html` and `main.ts` lay the window out as a header (project
  switcher, Save, Save As, Snapshots, the save indicator, the output buttons, then the server,
  output and GPU pills), the workspace, and a drawer along the bottom.
- The GPU pill (`renderGpuPill` in `main.ts`, names from `shared/gpu-name.ts`, tested) shows the
  GPU each output window reports (the worst if they differ): green NVIDIA, amber another GPU, red
  software rendering. With no output open it shows this window's own (the preview's), marked
  "preview". The tooltip has the full renderer strings.
- **Workspace.** Two columns of cards, each card with its own Tweakpane pane themed through
  `--tp-*` CSS variables. Shared card helpers are in `ui.ts`.
  - Left: the live preview and Camera (with its own Modulation folder). In edit mode the
    column widens for a bigger preview.
  - Under the preview is the project timeline strip (`TimelineStrip`,
    `client/control/timeline-strip.ts`): Play/Pause, Restart, position, a playback chip, and a
    ruler to scrub.
    - It uses the same `playPauseEdit` / `seekEdit` as the Timeline card and tab, and
      throttles scrubs to one every 50 ms (the last is always sent).
    - It ignores incoming transports while dragging, and until the echo of its last send.
    - It animates only while on screen and the page is visible. It stays when Live is off.
  - Right zone (`#zone-layers`), full height, in tabs (`Tabs`, remembered as `right-tab`):
    - **Scene** (`#panel-scene`): Scenes, Timeline, Output (background) and Calibration
      cards, flowing down CSS columns at least 400 px wide.
    - **Datasets** (`#panel-data`): the import button and `DatasetsPanel`.
    - **Layers** (`LayersPanel` in `#panel-layers`): a narrow list on the left (Add layer,
      then one row per layer: badge, title, move, duplicate, delete) and the open layer's
      settings on the right. Only the open layer has a Tweakpane pane (`entries` holds at
      most one); rows are plain DOM. Clicking a row selects and opens that layer, and
      selecting one elsewhere (the preview, the Timeline tab) opens it too. Under 720 px wide
      the list stacks above the settings.
      The Add layer type menu is a `ChoiceMenu` (`client/control/choice-menu.ts`): a popover
      listbox with a description under each name, from `TYPE_DESCRIPTIONS` in `layers-panel.ts`
      (a `Record<LayerType, …>`, so a new layer type must be given one).
    - **Timeline** (`TimelineView` in `#panel-timeline`).
    The zone itself doesn't scroll; each panel does.
  - The drawer keeps Output windows, Diagnostics, Problems and Log.
  - Body rows are placed explicitly, because the banner bar is `display: none` when empty.
- **Timeline tab** (`client/control/timeline-view.ts`, pure model and edits in
  `shared/timeline-view.ts`).
  - A sticky header holds the project transport and ruler. Below it come one group per layer
    (stack order) and the camera, each with a lane per modulated parameter.
  - A group's x axis is phase 0..1 of the timeline that drives it. Groups that follow the
    project line up with the master ruler. A layer with its own timeline gets its own ruler in
    its own seconds, its own playhead line (accent colour) and Play/Pause.
  - Ramps and keyframes are canvas curves. LFO and noise run on the wall clock, so their lanes
    are hatched, sit above the playhead line and show a scope of the last few seconds.
  - Transport actions use `playPauseEdit` / `seekEdit` from `timeline-panel.ts`, the same as
    the Timeline card. Key edits (`moveKeyOps`, `addKeyOps`, `deleteKeyOps`, `moveRampOps`,
    `keyAtPlayheadOps`) set the whole modulator and are validated against `ProjectSchema`
    before sending. Adding a key to a ramp first turns it into keyframes with the same curve.
  - A drag computes every step from the document at drag start, sends at most every 50 ms,
    and resends the final step when the key is let go. Until then its lane ignores incoming
    documents. The final step goes out with `sendPatch(ops, true)`, and `main.ts` then treats
    its echo as external (the `ownEchoes` queue), so the layer cards' Modulation folders
    refresh.
  - It animates with requestAnimationFrame only while the tab is shown, and rebuilds its DOM
    only when the structure (groups, lanes, kinds) changes. Per frame it moves the playhead
    lines and value dots, redraws the on-screen scopes, and updates readouts 10 times a second.
  - The header's "range" switch scales curve lanes to the slider range or fits them to their
    values (`laneRange`: padded, a minimum height, rounded outwards), remembered per viewer.
  - A group's timeline tag opens an inline editor: follow the project or use an own timeline
    (`ownTimelineOps`), and set duration, loop and playback. It re-anchors the transport
    through `layerTimeline(id)` and `reanchor`, as the Timeline card does, so nothing jumps.
  - The × on a lane asks before removing the modulator.
- **Modulation is per owner.** `ModulationPanel` takes a scope (`{kind:'layer', layerId}` or
  camera) and shows only that owner's modulators, an "Add modulator" for its parameters and
  its own orphans. `LayersPanel` puts one in each card's Animate folder ("Motion effects"),
  keeping its folder states across card rebuilds. Modulators of deleted layers are
  listed, with Remove buttons, under Problems.
- **Drawer** (`tabs.ts`: Datasets, Output windows, Calibration, Diagnostics, Problems, Log).
  Closed, it is just the tab strip with badges. A tab opens it upwards; clicking the shown
  tab or the chevron closes it. Its top edge drags to resize. Open state and height are
  kept in localStorage. Diagnostics holds the test-pattern and debug-overlay switches
  (session state).
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
- **Output side** (`client/output/morph.ts`, with pure lerp plans in `shared/morph-plan.ts`):
  - It freezes what is on screen, including any morph still in progress, and lerps
    towards the live target. Modulators keep running during a morph.
  - Layers with the same structure key interpolate; instancers can move between any two
    arrangements. Others crossfade, and their outgoing instances are kept until faded.
  - Splitting a scene change into two patches shows as a cut.

**Output effects** (`client/output/effects.ts`).
- Glow and trails are per layer: `layer.effects = { glow: {enabled, strength, radius,
  threshold}, trails: {enabled, persistence} }` (schema v7). `project.output` holds only
  the background. `LayerManager` copies the effects to the layer object's `userData.effects`.
  Every frame, `Stage` collects each visible layer's effective settings into a reused pool.
- `shared/effects-plan.ts` (pure, tested) picks the passes:
  - If every visible layer has the same settings, the whole-image chain runs: scene → MSAA
    target → bloom (a half-resolution glow added later) → trails (ping-pong history: the
    channel furthest from the background wins, faded by persistence^(dt·60)) → warp.
  - Otherwise `Stage.drawOnly` redraws chosen layers alone. Each trail layer (at most 8)
    gets its own history, keyed by its scene object, with its glow fed into the history,
    and is merged into the frame. Glow-only layers are grouped by identical settings,
    bloomed, and summed into one half-resolution texture.
- Render targets are created on first need and released 10 s after their last use. With
  no effect on anywhere, nothing runs.
- Scene morphs fade a layer's glow and trails in and out (`lerpEffects` in
  `shared/morph-plan.ts`).
- `Stage.verify` forces the shader error check at build time. In three 0.186,
  `compile()` alone doesn't run it.
- Control: each layer card has "Glow" and "Trails" folders (`buildEffects` in `layer-ui.ts`).
  Moving one of their sliders while the effect is off switches it on.

**Shadows, blur and fixed to screen** (`shared/compose-plan.ts`, `client/output/layer-image.ts`, schema v12).
- `layer.effects` also has `shadow {enabled, colour, opacity, spread, offset}` and
  `blur {enabled, amount}`; `layer.screenFixed` draws a layer with the 2D screen camera.
- When a visible layer has a shadow or a blur, or is fixed to the screen under a 3D camera,
  `Stage` draws the scene in segments, in stack order, into the same MSAA target. With none
  of these on, the scene is one render, as before.
  - A run of plain layers is one render, with the project camera or `orthoCamera`.
  - A shadow or blur layer is drawn alone into a transparent image. Its shadow (blurred
    coverage × colour × opacity, offset) is laid down with premultiplied blending, then
    the layer itself, or its blurred image instead.
  - Blur is a half-size pyramid plus a separable gaussian (sigma = setting / 2).
- `LayerManager` tags each layer's root with `effects`, `screenFixed` and `blend`, and
  applies screen-fixed layers with camera mode `'2d'`, so they ignore depth instead of
  needing a depth clear. Morph fade-outs keep that camera mode.
- The per-layer glow and trails passes (`drawOnly`) draw layers the same way.
- Targets are lazy and released after 10 s unused. A failure draws the layer plainly and is
  reported once.
- Limits: a blurred layer is laid over the layers below it, so it loses 3D occlusion.

**Camera depth of field** (`camera.dof`, schema v13; `client/output/dof.ts`, maths in `shared/dof.ts`).
- Settings: `focus` (px from the camera target along the view, + further), `depth` (the sharp
  zone) and `amount` (most blur, px at 1080p). The blur ramps over max(depth, 50) px beyond the
  zone. 3D camera only; scenes capture it, and morphs fade it in and out (`lerpDof`).
- `Stage.render`, when it shows: the scene target gets a depth texture (made the first time).
  Screen-fixed layers are held back. The scene is drawn as usual, then `writeMissingDepth`
  re-renders, depth only, the layers that drew without writing depth (text, labels,
  translucent layers) or as images (blurred layers), so each is focused where it is. Then
  `DepthOfField.apply` blurs the target in place: a half-size prepare (colour plus signed
  blur radius), a 40-tap golden-angle gather that won't spread a blurred background over a
  sharp object in front, and a full-size composite. Last, the held layers are drawn on top,
  sharp. Glow and trails run after it, on the blurred image.
- Limits: the per-layer glow and trails passes draw their layers sharp; an object in front
  of the focus blurs only within its own outline over a sharp background.
- Cost: about 1.5 ms a frame at 1080p on the GTX 1650; targets are released 10 s after it is
  switched off. A shader failure turns it off (reported once).
- Preview orbits keep it (`cameraFromOrbit` takes `dof`). Control: the Camera card's
  "Depth of field" folder; moving a slider while it is off switches it on.

**Follow camera** (`camera.follow`, schema v22; maths in `shared/camera-follow.ts`, tested).
- Each frame, after modulation and morphs, `updateFollow` in `client/output/main.ts` asks
  `LayerManager.followPoint` for the followed line's newest visible point (`followPoint` on line
  and split-line instances: `lastVisiblePoint`, the series furthest along for a split, then the
  layer's world matrix). `followGoal` adds `lead` along x and mixes the height by `height`;
  `easeToward` closes ~63 % per `smoothing` seconds (frame-rate independent; the first frame snaps).
- `Stage.setFollow(point | null)` replaces the camera target in `setCamera`; yaw, pitch and distance
  still place the eye, so camera modulators keep working. `displayedCamera` keeps the real target.
- Orbit editing, morphs and DOF use `OrbitCamera` (Camera without follow); `cameraPatch` keeps the
  project's follow when the preview sends an orbit.
- Road view (`ROAD_VIEW`, Camera → Follow) is yaw −70, pitch 14, distance 0.35: straight behind
  (−90) sees the chart edge on.
- Follow path (`followPathOps`, tested): the line becomes the whole path, dimmed towards the
  background; a copy "<name> · follow path" builds up over it and is followed, so the path ahead
  stays in view. Pressing it again follows the existing copy.
- Loop flight (`follow.loop`, schema v23): when the goal jumps back more than `RESTART_JUMP_PX`
  in a frame (a looping reveal restarting), `updateFollow` flies over `loopSeconds`: the look-at
  point eases from where it was to the restarted tip while `flightPose` adds whole turns of yaw
  and a mid-flight rise and pull-out, passed to `Stage.setFollow(point, view)`. It ends exactly on
  the plain follow view. A project timeline gap gives it time while the line holds at the end.

**Camera motion presets** (`shared/camera-motion.ts`, UI in `camera-panel.ts`).
- Presets (orbit, swing, zoom, pan, tilt, drift, fly-around) are plain LFO and noise
  modulators on `camera.*`, so the output needs nothing new and scenes capture them. A preset
  replaces every camera modulator, and choosing one switches the camera to 3D.
- Speed divides LFO periods and multiplies noise speeds.
- **Camera clock** (`session.cameraClock`, `ClockSchema` in `shared/modulators.ts`): camera LFO
  and noise run on it instead of the wall clock (`paramClockMs`; the output's camera owner,
  the Modulation monitors and the Timeline tab's camera lanes all use it). It is seconds,
  never wraps, and is persisted with the transports. A session saved without one gets
  `WALL_CLOCK`, which reads exactly as the wall clock. The Motion folder has Play/Pause, Reset
  and a position slider (seconds) over `cameraLoopSeconds` (the LFOs' common loop; 60 s for
  noise only). At clock 0 every preset LFO is at its base value (saws start at phase 0.5).
  A speed change rescales the clock by old / new speed, so the move (noise too) continues; a
  new preset restarts the clock at 0. Project Play/Pause and Restart don't touch it.
- The preset and speed aren't stored: `detectCameraMotion` reads them back from the
  modulators, ignoring phase. A hand-edited modulator reads as "custom".

**Randomise** (`shared/layer-random.ts`, pure and seeded; buttons at the end of every layer's
General folder, added by `LayersPanel.addRandomButtons`).
- `randomiseLayer(layer, summary, timeZone, background, scope, rng)`: a recipe per layer type,
  varied, then `fitAnyLayer`. `look` keeps the columns; `all` also picks them (preferring
  numbers whose typical 5–95 % range varies and that are mostly filled in; `SummaryColumn`
  carries `nullCount` and `typical` for this).
- Kept: id, name, on/off, dataset, transform, timeline, fixed to screen. Effects restart from
  off; only glow is used. Layers with more than `DENSE_MARKS` marks get no additive blend, a
  soft high-threshold glow and no box edges. Colours keep 4.5:1 contrast with the background.
  Clone counts are capped to `FRAME_BUDGET`.
- Back: `LayersPanel.randomHistory` keeps the last 10 configs per layer, in the window only.
  It restores the look but keeps the current name, on/off, dataset, transform and timeline.

**Launching the output** (`server/launcher.ts`, pure parts in `server/launch-args.ts`).
- The header's Output buttons POST to `/api/output/launch` (`projector` | `window`) and
  `/api/output/close`. The server spawns Chrome detached (so it survives server restarts)
  with its own profile (`~/.config/chromagraph-output`; a profile left in the old
  `~/.config/data-wrangler-output` is moved there on the next launch), `--ozone-platform=x11` and PRIME
  offload when `/proc/driver/nvidia` exists.
- The projector is the first non-primary monitor in `xrandr --listmonitors`. A launch first
  closes the running output Chrome, because a second launch would only open a tab in it.
- Close finds the main process by scanning `/proc/*/cmdline`. Chrome rewrites its process
  title with spaces, not NULs.

**Renamed from data-wrangler (2026-10-10).** Browser storage and the output's Chrome profile
moved to `chromagraph` names. The old names are still read once and carried over, so nothing
resets: the output state cache and remembered control settings (`state-cache.ts`, `ui.ts`),
the service worker's offline cache (copied on activate) and the output profile folder
(`launcher.ts`). Remove those fallbacks once every machine has run the new version.

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
