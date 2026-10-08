import type { SyncDoc } from '../../shared/project-schema.ts';
import type { LogLevel, OutputStatus } from '../../shared/protocol.ts';
import { makeClientId, ReconnectingSocket, wsUrl, type ConnectionState } from '../common/socket.ts';
import { SyncedState } from '../common/synced-state.ts';
import { PARSE_WORKER_URL } from '../../data/dataset-loader.ts';
import { HIERARCHY_WORKER_URL } from '../../data/hierarchy-client.ts';
import { DatasetStore } from './datasets.ts';
import { PreviewEditor } from './editor.ts';
import { LayerManager } from './layer-manager.ts';
import { ModulationEngine } from './modulation.ts';
import { LayerHost, type FrameContext } from './layers/layer.ts';
import { invalidateRampTextures } from './layers/ramps.ts';
import { createTestPattern } from './layers/test-pattern.ts';
import { isPreferredGpu, OUTPUT_HEIGHT, OUTPUT_WIDTH, Stage } from './stage.ts';
import { readCache, writeCache } from './state-cache.ts';

/*
 * Output window. Rules: never fail dark, never block the loop, never show UI.
 * Everything that can fail is fenced and reported to the server; the last good frame
 * state keeps rendering whatever happens.
 *
 * With ?preview this page is the control window's embedded preview: it renders at half
 * resolution and stays silent (no status, no logs, no state cache, no service worker), so
 * it never masquerades as the real output.
 */

const preview = new URLSearchParams(location.search).has('preview');

const TEST_PATTERN_ID = '__test-pattern';
const STATUS_INTERVAL_MS = 2_000;
const REPORT_REPEAT_MS = 10_000;

const clientId = makeClientId(preview ? 'preview' : 'output');
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const debugEl = document.getElementById('debug') as HTMLDivElement;

let stage: Stage | null = null;
let layers: LayerHost | null = null;
let layerManager: LayerManager | null = null;

const modulation = new ModulationEngine({
  applyLayer: (id, effective) => layerManager?.applyEffective(id, effective),
  applyCamera: (effective) => stage?.setCamera(effective),
  applyOutput: (effective) => stage?.setEffects(effective.effects),
});
let socket: ReconnectingSocket | null = null;
let connection: ConnectionState = 'closed';

// ---- reporting (deduplicated, never throws) -------------------------------------

const lastReported = new Map<string, number>();
const pendingLogs: { level: LogLevel; message: string }[] = [];

function report(level: LogLevel, message: string): void {
  try {
    const now = performance.now();
    const prev = lastReported.get(message);
    if (prev !== undefined && now - prev < REPORT_REPEAT_MS) return;
    lastReported.set(message, now);
    if (level === 'error') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.info(message);
    if (preview) return;
    if (!socket?.send({ t: 'log', level, message })) {
      pendingLogs.push({ level, message });
      if (pendingLogs.length > 50) pendingLogs.shift();
    }
  } catch {
    // reporting is best effort
  }
}

window.addEventListener('error', (ev) => report('error', `uncaught: ${ev.message}`));
window.addEventListener('unhandledrejection', (ev) => report('error', `unhandled rejection: ${String(ev.reason)}`));

// ---- data ------------------------------------------------------------------------

const datasets = new DatasetStore(
  (level, message) => report(level, message),
  (_id, url) => {
    precache([url]);
    if (state.doc) syncLayers(state.doc);
  },
);

// ---- state -----------------------------------------------------------------------

const state = new SyncedState(
  (doc, prev) => {
    try {
      applyDoc(doc, prev);
    } catch (err) {
      report('error', `applying state failed: ${String(err)}`);
    }
    if (!preview) writeCache(state.projectName, state.rev, doc);
  },
  () => socket?.send({ t: 'requestFull' }),
  (message) => report('warn', message),
);

/** Reconcile the scene with the state. Only touches what changed, so a resync is seamless. */
function applyDoc(doc: SyncDoc, prev: SyncDoc | null): void {
  debugEl.hidden = preview || !doc.session.debugOverlay;
  if (!prev || doc.project.datasets !== prev.project.datasets || state.projectName !== datasets.currentProject) {
    datasets.sync(state.projectName, doc.project.datasets);
  }
  if (!stage || !layers) return;
  if (!prev || doc.project.output.background !== prev.project.output.background) {
    stage.setBackground(doc.project.output.background);
  }
  if (!prev || doc.project.camera !== prev.project.camera) stage.setCamera(doc.project.camera);
  if (!prev || doc.project.output.effects !== prev.project.output.effects) stage.setEffects(doc.project.output.effects);
  // The preview shows the unwarped image; only the real output is keystoned.
  if (!preview && (!prev || doc.profile !== prev.profile) && !stage.setWarp(doc.profile.corners)) {
    report('warn', `output profile "${doc.profile.name}": corners do not form a usable shape; keeping the previous warp`);
  }
  syncLayers(doc);
  modulation.sync(doc);
  if (prev && doc.project.parameters !== prev.project.parameters) {
    // Removed or disabled modulators leave their last value behind; restore the bases
    // (modulators still present overwrite them again on the next frame).
    layerManager?.reapplyBase();
    stage.setCamera(doc.project.camera);
    stage.setEffects(doc.project.output.effects);
  }
  if (doc.session.testPattern) {
    if (!layers.get(TEST_PATTERN_ID)) layers.set(TEST_PATTERN_ID, () => createTestPattern(OUTPUT_WIDTH, OUTPUT_HEIGHT));
  } else {
    layers.remove(TEST_PATTERN_ID);
  }
}

function syncLayers(doc: SyncDoc): void {
  try {
    layerManager?.sync(doc);
  } catch (err) {
    report('error', `layer sync failed: ${String(err)}`);
  }
}

const cached = readCache();
if (cached && state.seed(cached.projectName, cached.rev, cached.doc)) {
  console.info(`booted from cached state: "${cached.projectName}" rev ${cached.rev}`);
}

// ---- stage -----------------------------------------------------------------------

function createStage(): void {
  try {
    stage = new Stage(
      canvas,
      {
        lost: () => report('error', 'WebGL context lost; waiting for restore'),
        report: (message) => report('error', `output effects: ${message}`),
        restored: () => {
          report('warn', 'WebGL context restored; rebuilding layers');
          invalidateRampTextures();
          layerManager?.reset();
          layers?.rebuildAll((id) => (id === TEST_PATTERN_ID ? () => createTestPattern(OUTPUT_WIDTH, OUTPUT_HEIGHT) : null));
          if (state.doc) applyDoc(state.doc, null);
        },
      },
      preview ? 0.5 : 1,
    );
    layers = new LayerHost(stage.scene, (id, message) => report('error', `layer ${id}: ${message}`), stage.verify);
    layerManager = new LayerManager(layers, datasets);
    report(isPreferredGpu(stage.rendererName) ? 'info' : 'warn', `renderer: ${stage.rendererName}`);
    if (state.doc) applyDoc(state.doc, null);
  } catch (err) {
    stage = null;
    layers = null;
    report('error', `WebGL initialisation failed: ${String(err)}; retrying in 5 s`);
    window.setTimeout(createStage, 5_000);
  }
}

createStage();

// Direct-manipulation editor (gizmo, orbit, click to select): preview only, never the output.
const editor = preview
  ? new PreviewEditor({
      canvas,
      getStage: () => stage,
      getDoc: () => state.doc,
      getLayerObject: (id) => layers?.get(id)?.object ?? null,
    })
  : null;

window.addEventListener('resize', () => stage?.resize());
window.addEventListener('keydown', (ev) => {
  if (!preview && ev.key === 'f' && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => {});
});

// ---- render loop (one clock, no per-frame allocation) ------------------------------

const ctx: FrameContext = { time: 0, dt: 0, frame: 0 };
const startTime = performance.now();
let lastFrame = startTime;
let fpsFrames = 0;
let fpsCpu = 0;
let fpsWindowStart = startTime;
let fps = 0;
let frameMs = 0;

function tick(now: number): void {
  requestAnimationFrame(tick); // schedule first: nothing below can stop the loop
  const t0 = performance.now();
  try {
    ctx.dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.1);
    ctx.time = (now - startTime) / 1000;
    ctx.frame++;
    lastFrame = now;
    if (stage && layers && !stage.contextLost) {
      modulation.frame(performance.timeOrigin + now);
      layers.update(ctx);
      editor?.frame();
      stage.render(ctx.dt);
      editor?.renderOverlay();
    }
  } catch (err) {
    report('error', `frame failed: ${String(err)}`);
  }
  fpsFrames++;
  fpsCpu += performance.now() - t0;
  if (now - fpsWindowStart >= 1000) {
    fps = (fpsFrames * 1000) / (now - fpsWindowStart);
    frameMs = fpsCpu / fpsFrames;
    fpsFrames = 0;
    fpsCpu = 0;
    fpsWindowStart = now;
  }
}
requestAnimationFrame(tick);

// ---- status + debug overlay --------------------------------------------------------

function status(): OutputStatus {
  return {
    fps: Math.round(fps * 10) / 10,
    frameMs: Math.round(frameMs * 100) / 100,
    renderer: stage?.rendererName ?? 'none',
    vendorOk: stage ? isPreferredGpu(stage.rendererName) : false,
    contextLost: stage?.contextLost ?? false,
    rev: state.rev,
    layerErrors: layers ? [...layers.errors] : [],
    datasetErrors: [...datasets.errors],
  };
}

window.setInterval(() => {
  if (preview) return;
  try {
    socket?.send({ t: 'status', status: status() });
  } catch {
    // ignore
  }
}, STATUS_INTERVAL_MS);

window.setInterval(() => {
  if (debugEl.hidden) return;
  debugEl.textContent =
    `${fps.toFixed(1)} fps  ${frameMs.toFixed(2)} ms cpu\n` +
    `${connection}  rev ${state.rev}  ${state.projectName}\n` +
    `timeline ${(modulation.phase * 100).toFixed(1)}%  ${modulation.active} modulated\n` +
    `${stage?.rendererName ?? 'no renderer'}` +
    (layers?.errors.length ? `\n${layers.errors.length} layer error(s)` : '');
}, 500);

// ---- offline boot ------------------------------------------------------------------
// In production a service worker caches the page, bundle and data files so the output can
// reload and keep rendering while the server is down. In dev it would cache Vite modules,
// so any registration left over from a production run is removed.

function precache(urls: string[]): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ t: 'precache', urls })).catch(() => {});
}

if ('serviceWorker' in navigator && !preview) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker
      .register('/output/sw.js', { scope: '/output/' })
      .then(() => {
        const loaded = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin));
        precache([
          location.href,
          new URL(PARSE_WORKER_URL, location.href).href,
          new URL(HIERARCHY_WORKER_URL, location.href).href,
          ...loaded,
        ]);
      })
      .catch((err: unknown) => {
        report('warn', `service worker registration failed: ${String(err)}`);
      });
  } else {
    void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => void r.unregister()));
  }
}

// ---- connection --------------------------------------------------------------------

socket = new ReconnectingSocket(wsUrl(), {
  hello: () => ({
    t: 'hello',
    role: preview ? 'preview' : 'output',
    clientId,
    ...(state.rev >= 0 ? { rev: state.rev, projectName: state.projectName } : {}),
  }),
  message: (msg) => {
    state.handle(msg);
  },
  state: (s) => {
    connection = s;
    if (s === 'open') {
      while (pendingLogs.length) {
        const entry = pendingLogs.shift()!;
        socket?.send({ t: 'log', ...entry });
      }
      if (!preview) socket?.send({ t: 'status', status: status() });
      datasets.reloadFailed();
    }
  },
});
