# data-wrangler

A realtime data-visualisation instrument. It loads CSV/JSON files, maps their columns onto
2D and 3D layers, and plays the result live to an HD projector. It is used both for
exploring at a desk and for unattended installations.

## Starting up (e.g. after a restart)

```bash
cd ~/Documents/Projects/dev/data-wrangler
npm run dev
```

- Control window: open http://127.0.0.1:8080/control in your normal Chrome.
- Output window: use the **Output** buttons at the top right of the control window.
  - **On projector** opens the output full screen on the second screen, on the NVIDIA GPU.
    If the output is already open, it closes it and opens it again, which also moves it to
    the projector.
  - **In a window** opens it in a normal window you can move (F11 for full screen).
  - **Close** closes it.

  The output gets its own Chrome profile (`~/.config/data-wrangler-output`), so it never
  mixes with your normal Chrome. It keeps running if the server restarts. If it ever lands
  on the wrong screen, click it and press **Super+Shift+→** (or ←). By hand, the output is
  at http://127.0.0.1:8080/output (press `f` for full screen).

The server reopens the last project you had open. The output also boots straight into it
with no control window present.

To stop the server, press **Ctrl+C** in its terminal. If you've lost the terminal, run:
`kill $(ss -ltnp | grep ':8080 ' | grep -o 'pid=[0-9]*' | cut -d= -f2)`.

### Installations

Use the production build. In dev mode, editing a source file reloads the output.

```bash
npm run build && npm start
```

Then open the control window and press **Output → On projector**.

In production the output caches itself and its data. If the server stops, the output keeps
rendering, and it can even reload while the server is down.

## GPU (check before a show)

The laptop has hybrid graphics: an AMD iGPU plus an NVIDIA GTX 1650. Chrome must render on
the NVIDIA GPU.

- In the control window, the **Output windows** tab shows the output's renderer, and a
  banner warns when it isn't NVIDIA. You can also check `chrome://gpu`.
- On 2026-10-08 the NVIDIA driver wasn't loading: the `nvidia-595-open` kernel modules
  were only installed up to kernel 7.0.0-30, but the machine was booted on 7.0.0-34. Fix it
  by installing the NVIDIA module package for the running kernel (or booting -30), then
  confirm with `nvidia-smi`.
- Even with the driver working, Chrome on Wayland picks the iGPU, because the desktop runs
  on the AMD chip. The **On projector** and **In a window** buttons handle this. By hand, run
  Chrome under X11 (XWayland) with PRIME offload:

  ```sh
  __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia \
  google-chrome --ozone-platform=x11 --kiosk http://127.0.0.1:8080/output/
  ```

  Quit every Chrome window first, or the flags are ignored and the URL opens in the
  running Chrome. What didn't work (tested 2026-10-09): staying on Wayland with
  `--render-node-override` pointing at the NVIDIA card crashes Chrome, because the desktop
  can't take its frames ("failed to import supplied dmabufs"). `--use-angle=vulkan` runs on
  the NVIDIA card, but WebGL fails to start.

## Saving your work

- **Autosave:** every change is written to `projects/<name>/project.json` within half a
  second. Saves are atomic, and the previous save is kept as `.bak`.
- **Save:** saves now. **Save as…** copies the project, data included, under a new name.
- **Snapshots:** named versions inside a project that you can restore. A restore first keeps
  a "before restore" snapshot.
- **Data:** imported files are copied into `projects/<name>/data/` and never modified.
- **Not in git:** `projects/` and `backups/`. Copy these folders to back up or move your work.
- **Projector calibration (keystone):** lives in `output-profiles/<name>.json`, one per
  venue, separate from projects.

## What it can do

- **Layers:**
  - instancer (points, squares, bars, boxes or spheres in linear, grid, calendar, radial or
    spiral layouts, with a MoGraph-style cloner)
  - line (with cloner and area fill: the Ridgeline preset)
  - heat map
  - text (live values at the playhead, or plain words)
  - small multiples
  - hierarchy (dendrogram, sunburst, treemap and more)
  - 3D surface
- **Small multiples** titles sit above the frame, inside along the top, or inside along the
  baseline (**title place**).
- **Text keeps the file's formatting:** numbers show the decimals the CSV writes ("0.0",
  "12.30") and dates pad the day ("02 Jan 1879"), so text doesn't jump as values change.
- **About:** the **?** after the title shows ABOUT.md.
- **Layers tab:** a list of layers with **Add layer** on top; click a layer to open its
  settings beside the list (or click it in the preview).
- **Fades and gap:** Scene tab → **Scene timeline** → fade in, fade out, fade length and gap
  before restart (0–5 s). The whole output fades to the background colour at the end of each
  pass and back in at the start. Only the project timeline has these.
- **Timeline strip:** under the preview, it shows where playback is. Click or drag its ruler
  to move the playhead; play/pause and restart are there too.
- **Labels on instancers:** in an instancer's **Labels** folder, label its points by year,
  decade or every N rows (date or a column's value). They follow the layer's spiral, ring,
  line or calendar, and are revealed by its data playhead. **Hide points** gives a
  labels-only layer.
- **Mappings:** any column to position, size, colour, opacity or rotation, through
  linear, log, sqrt or quantise scales and colour ramps.
- **Animation:** LFO, noise, ramp or keyframe modulators on almost any number, on a looping
  timeline of up to 24 h. Each layer's settings have their own **Modulation** folder (with the data
  playhead, which reveals the record over time); the camera's is in the Camera card.
- **Playback:** a timeline plays forward, in reverse, or ping-pong (there and back; each way
  takes the duration). This applies to the project timeline and to each layer's own.
- **Text:** the default font is a fixed-width 1970s terminal face (VT323). Sans is the
  alternative, and text layers can also take a font URL. Every text option has an
  **uppercase** switch.
- **Line charts:** a line layer's **Aggregate** folder draws one point per week, month, year
  or N rows (mean, sum, min, max or last), so daily data reads as a line chart. **Add layer
  → line chart (aggregated)** starts with monthly means.
- **Per-layer timelines:** in a layer's **Timeline** folder, tick **own timeline** to
  give that layer its own duration, loop, play/pause and scrub. The project Timeline
  card's Play/Pause and Restart still drive every layer.
- **Timeline tab:** the last tab on the right (after **Layers**) shows the project
  playhead and ruler (click or drag it to scrub), then each layer and the camera with a
  lane per animated parameter: keyframe curves, ramps, and LFO/noise as free-running scopes.
  A layer with its own timeline gets its own ruler and playhead. Drag keys (Shift locks one
  axis), double-click a lane to add a key, select one and press Delete to remove it, use the
  key button for a key at the playhead, and **Keyframe…** to animate another parameter.
  **range: fit to values** scales each lane to its own values. Click a layer's timeline tag
  ("follows project" / "own timeline …") to switch it and set its duration, loop and
  playback.
- **Control window:** the preview and camera on the left; the right side has tabs for
  **Scene** (scenes, timeline, background, projector calibration), **Datasets**, **Layers**
  and **Timeline**. Output windows, diagnostics, problems and the log are in the drawer
  along the bottom: click a drawer tab to open it, and click it again to close it.
- **Scenes:** capture looks, then morph between them (0.1–10 s).
- **Effects:** glow and motion trails, set per layer in each layer's **Glow** and
  **Trails** folders. Layers with the same settings cost nothing extra; each layer with
  its own trails costs about one more draw of that layer.
- **Shadow and blur:** each layer's **Shadow** folder adds a drop shadow (colour, opacity,
  spread for softness, and offset in px, y up). **Blur** blurs the layer by an amount in px.
- **Isometric and 3D looks:** Camera → **Isometric view** gives a flat-shaded isometric
  angle. Box instancers have an **Edges** folder (width in px, face opacity, edge glow) with
  **Red outline** and **Neon** presets. Add a **reflection plane** layer for a mirror floor;
  place it with the gizmo or **Lay flat as floor**. It costs one extra scene render.
- **Depth of field:** in the Camera card (3D only), tick **on** and set **focus** (px from
  the camera target, + further away), **sharp depth** and **blur**. **Focus on target** puts
  the sharp plane through the point the camera orbits. Layers fixed to the screen stay sharp.
  Focus and blur can be animated with modulators, for a rack focus.
- **Fixed to screen:** tick it in a layer's **Transform** folder to draw that layer with
  the 2D screen camera, so 3D camera moves don't affect it, as for titles.
- **Camera moves:** in the Camera card under Motion, pick a preset (orbit, swing, zoom, pan,
  tilt, drift, fly-around) and set its speed. Presets are camera modulators, so you can
  fine-tune them in the Camera card's Modulation folder.
- **Editing:** a 3D camera; the move/rotate/scale gizmo and orbit in the preview (tick
  **Edit**); four-corner keystone with a test pattern.

## Development

See `CLAUDE.md` for the constraints, architecture and code map, and `FUTURE.md` for the
wish list.

```bash
npm test            # Vitest (pure Node, no GPU)
npm run typecheck   # TypeScript 7, strict
```
