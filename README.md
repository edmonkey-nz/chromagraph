# data-wrangler

A realtime data-visualisation instrument. It loads CSV/JSON files, maps their columns onto
2D and 3D layers, and plays the result live to an HD projector. It is used both for
exploring at a desk and for unattended installations.

## Starting up (e.g. after a restart)

```bash
cd ~/Documents/Projects/dev/data-wrangler
npm run dev
```

- Control window: http://127.0.0.1:8080/control
- Output window: http://127.0.0.1:8080/output. Put it on the projector and press `f` for
  full screen.

The server reopens the last project you had open. The output also boots straight into it
with no control window present.

To stop the server, press **Ctrl+C** in its terminal. If you've lost the terminal, run:
`kill $(ss -ltnp | grep ':8080 ' | grep -o 'pid=[0-9]*' | cut -d= -f2)`.

### Installations

Use the production build. In dev mode, editing a source file reloads the output.

```bash
npm run build && npm start
google-chrome --kiosk http://127.0.0.1:8080/output/
```

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
- If Chrome still picks the iGPU, launch it with
  `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia google-chrome …`.

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
- **Mappings:** any column to position, size, colour, opacity or rotation, through
  linear, log, sqrt or quantise scales and colour ramps.
- **Animation:** LFO, noise, ramp or keyframe modulators on almost any number, on a looping
  timeline of up to 24 h. The data playhead reveals the record over time.
- **Scenes:** capture looks, then morph between them (0.1–10 s).
- **Effects:** bloom glow and motion trails.
- **Editing:** a 3D camera; the move/rotate/scale gizmo and orbit in the preview (tick
  **Edit**); four-corner keystone with a test pattern.

## Development

See `CLAUDE.md` for the constraints, architecture and code map, and `FUTURE.md` for the
wish list.

```bash
npm test            # Vitest (pure Node, no GPU)
npm run typecheck   # TypeScript 7, strict
```
