import type { SyncDoc } from '../../shared/project-schema.ts';
import type { LogLevel, OutputStatus } from '../../shared/protocol.ts';
import { makeClientId, ReconnectingSocket, wsUrl, type ConnectionState } from '../common/socket.ts';
import { SyncedState } from '../common/synced-state.ts';
import { PARSE_WORKER_URL } from '../../data/dataset-loader.ts';
import { DatasetStore } from './datasets.ts';
import { LayerHost, type FrameContext } from './layers/layer.ts';
import { createTestPattern } from './layers/test-pattern.ts';
import { isPreferredGpu, OUTPUT_HEIGHT, OUTPUT_WIDTH, Stage } from './stage.ts';
import { readCache, writeCache } from './state-cache.ts';

/*
 * Output window. Rules: never fail dark, never block the loop, never show UI.
 * Everything that can fail is fenced and reported to the server; the last good frame
 * state keeps rendering whatever happens.
 */

const TEST_PATTERN_ID = '__test-pattern';
const STATUS_INTERVAL_MS = 2_000;
const REPORT_REPEAT_MS = 10_000;

const clientId = makeClientId('output');
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const debugEl = document.getElementById('debug') as HTMLDivElement;

let stage: Stage | null = null;
let layers: LayerHost | null = null;
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
  (_id, _table, url) => precache([url]),
);

// ---- state -----------------------------------------------------------------------

const state = new SyncedState(
  (doc, prev) => {
    try {
      applyDoc(doc, prev);
    } catch (err) {
      report('error', `applying state failed: ${String(err)}`);
    }
    writeCache(state.projectName, state.rev, doc);
  },
  () => socket?.send({ t: 'requestFull' }),
  (message) => report('warn', message),
);

/** Reconcile the scene with the state. Only touches what changed, so a resync is seamless. */
function applyDoc(doc: SyncDoc, prev: SyncDoc | null): void {
  debugEl.hidden = !doc.session.debugOverlay;
  if (!prev || doc.project.datasets !== prev.project.datasets || state.projectName !== datasets.currentProject) {
    datasets.sync(state.projectName, doc.project.datasets);
  }
  if (!stage || !layers) return;
  if (!prev || doc.project.output.background !== prev.project.output.background) {
    stage.setBackground(doc.project.output.background);
  }
  if (doc.session.testPattern) {
    if (!layers.get(TEST_PATTERN_ID)) layers.set(TEST_PATTERN_ID, () => createTestPattern(OUTPUT_WIDTH, OUTPUT_HEIGHT));
  } else {
    layers.remove(TEST_PATTERN_ID);
  }
}

const cached = readCache();
if (cached && state.seed(cached.projectName, cached.rev, cached.doc)) {
  console.info(`booted from cached state: "${cached.projectName}" rev ${cached.rev}`);
}

// ---- stage -----------------------------------------------------------------------

function createStage(): void {
  try {
    stage = new Stage(canvas, {
      lost: () => report('error', 'WebGL context lost; waiting for restore'),
      restored: () => {
        report('warn', 'WebGL context restored; rebuilding layers');
        layers?.rebuildAll((id) => (id === TEST_PATTERN_ID ? () => createTestPattern(OUTPUT_WIDTH, OUTPUT_HEIGHT) : null));
        if (state.doc) applyDoc(state.doc, null);
      },
    });
    layers = new LayerHost(stage.scene, (id, message) => report('error', `layer ${id}: ${message}`), stage.verify);
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
window.addEventListener('resize', () => stage?.resize());
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'f' && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => {});
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
      layers.update(ctx);
      stage.render();
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

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    navigator.serviceWorker
      .register('/output/sw.js', { scope: '/output/' })
      .then(() => {
        const loaded = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(location.origin));
        precache([location.href, new URL(PARSE_WORKER_URL, location.href).href, ...loaded]);
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
    role: 'output',
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
      socket?.send({ t: 'status', status: status() });
      datasets.reloadFailed();
    }
  },
});
