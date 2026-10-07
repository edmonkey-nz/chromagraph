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

1. Server, project folders, two windows, state sync, reconnect behaviour.
2. Data layer with tests against the rainfall fixture.
3. Instancer layer with mappings and X/Y/Z offset. Tweakpane control.
4. Parameter registry, modulators, timeline and data playhead.
5. Keystone and output profiles.
6. Line, heat map and text layers.
7. Small multiples, dendrogram, 3D surface.

## Commands

- `npm run dev` : server plus Vite on :8080, control at `/control`, output at `/output`
- `npm run build` then `npm start` : production (built bundle, no HMR). Use this for
  installations, because in dev a source edit reloads the output.
- `npm test` : Vitest
- `npm run typecheck`

## Implementation notes

- **Offline boot (production only).** A service worker (`src/server/static/output-sw.js`)
  lets the output reload while the server is down. It is network-first with a cache fallback.
- **Parse worker in production.** It starts from a blob URL, because Chrome does not send a
  dedicated worker's script load through the service worker. URLs passed to the worker must
  be absolute.
- **Sync model.** Patches address `project.*` (saved) or `session.*` (live only: test pattern,
  debug overlay). The server validates every patch against the zod schema before applying it.