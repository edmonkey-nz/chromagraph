import { Pane } from 'tweakpane';
import { wallMs } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import { PROJECT_NAME_RE, type Camera, type SyncDoc } from '../../shared/project-schema.ts';
import type { LogEntry, OutputStatus, ProjectProblem } from '../../shared/protocol.ts';
import { makeClientId, ReconnectingSocket, wsUrl, type ConnectionState } from '../common/socket.ts';
import { SyncedState } from '../common/synced-state.ts';
import { DatasetsPanel } from './datasets-panel.ts';
import { LayersPanel } from './layers-panel.ts';
import { ModulationPanel } from './modulation-panel.ts';
import { TimelinePanel } from './timeline-panel.ts';

const MAX_LOG_LINES = 500;

const clientId = makeClientId('control');
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  projectSelect: $<HTMLSelectElement>('project-select'),
  projectNew: $<HTMLInputElement>('project-new'),
  projectCreate: $<HTMLButtonElement>('project-create'),
  conn: $('conn'),
  outPill: $('out-pill'),
  banners: $('banners'),
  pane: $('pane'),
  outputsBody: $('outputs-body'),
  problems: $('problems'),
  log: $('log'),
  datasets: $('datasets'),
  importButton: $<HTMLButtonElement>('import-button'),
  importFile: $<HTMLInputElement>('import-file'),
  previewToggle: $<HTMLInputElement>('preview-toggle'),
  previewSection: $('preview-section'),
  previewBox: $('preview-box'),
};

const outputs = new Map<string, OutputStatus>();
let problems: ProjectProblem[] = [];
let lastError: string | null = null;

// ---- Tweakpane ---------------------------------------------------------------------
// GUI values live in `params` and are only ever sent to the server as patches. The
// renderer never reads them.

const params = {
  background: '#000000',
  testPattern: false,
  debugOverlay: false,
  camera: { mode: '2d' as Camera['mode'], fov: 45, yaw: 0, pitch: 0, distance: 1, target: { x: 0, y: 0, z: 0 } },
};
const pane = new Pane({ container: el.pane, title: 'Controls' });

const outputFolder = pane.addFolder({ title: 'Output' });
outputFolder
  .addBinding(params, 'background', { label: 'background' })
  .on('change', (ev) => sendPatch([{ op: 'set', path: ['project', 'output', 'background'], value: ev.value }]));

const diagFolder = pane.addFolder({ title: 'Diagnostics' });
diagFolder
  .addBinding(params, 'testPattern', { label: 'test pattern' })
  .on('change', (ev) => sendPatch([{ op: 'set', path: ['session', 'testPattern'], value: ev.value }]));
diagFolder
  .addBinding(params, 'debugOverlay', { label: 'debug overlay' })
  .on('change', (ev) => sendPatch([{ op: 'set', path: ['session', 'debugOverlay'], value: ev.value }]));

const cameraFolder = pane.addFolder({ title: 'Camera', expanded: false });
const cam = params.camera;
const setCamera = (field: keyof Camera, value: unknown) => sendPatch([{ op: 'set', path: ['project', 'camera', field], value }]);
cameraFolder
  .addBinding(cam, 'mode', { options: [{ text: '2D', value: '2d' }, { text: '3D', value: '3d' }] })
  .on('change', (ev) => setCamera('mode', ev.value));
cameraFolder.addBinding(cam, 'fov', { label: 'fov', min: 5, max: 120, step: 1 }).on('change', (ev) => setCamera('fov', ev.value));
cameraFolder.addBinding(cam, 'yaw', { min: -180, max: 180, step: 0.5 }).on('change', (ev) => setCamera('yaw', ev.value));
cameraFolder.addBinding(cam, 'pitch', { min: -89, max: 89, step: 0.5 }).on('change', (ev) => setCamera('pitch', ev.value));
cameraFolder.addBinding(cam, 'distance', { min: 0.2, max: 5, step: 0.01 }).on('change', (ev) => setCamera('distance', ev.value));
cameraFolder
  .addBinding(cam, 'target', { label: 'target' })
  .on('change', (ev) => setCamera('target', [ev.value.x, ev.value.y, ev.value.z]));

// Pane order: Output, Diagnostics, Camera, Timeline, Layers, Modulation (folders are added
// in that order below).
const timelinePanel = new TimelinePanel(pane, { sendPatch, getDoc: () => state.doc });

/** Set while copying server state into the GUI, so the resulting change events don't echo back. */
let syncingGui = false;

function sendPatch(ops: PatchOp[]): void {
  if (syncingGui) return;
  if (!socket.send({ t: 'patch', ops })) addLog({ time: Date.now(), level: 'warn', source: 'control', message: 'not connected; change not sent' });
}

function syncGui(doc: SyncDoc): void {
  params.background = doc.project.output.background;
  params.testPattern = doc.session.testPattern;
  params.debugOverlay = doc.session.debugOverlay;
  const c = doc.project.camera;
  Object.assign(cam, { mode: c.mode, fov: c.fov, yaw: c.yaw, pitch: c.pitch, distance: c.distance });
  cam.target = { x: c.target[0], y: c.target[1], z: c.target[2] };
  syncingGui = true;
  try {
    pane.refresh();
  } finally {
    syncingGui = false;
  }
}

// ---- datasets ----------------------------------------------------------------------

const datasetsPanel = new DatasetsPanel(el.datasets, el.importFile, sendPatch, (message) => {
  lastError = message;
  renderBanners();
});
el.importButton.addEventListener('click', () => el.importFile.click());

// ---- layers ------------------------------------------------------------------------

const layersPanel = new LayersPanel(pane, {
  sendPatch,
  getDoc: () => state.doc,
  summary: (id) => datasetsPanel.summary(id),
  showError: (message) => {
    lastError = message;
    renderBanners();
  },
});
datasetsPanel.onChange = () => layersPanel.refreshSummaries();

// ---- modulation --------------------------------------------------------------------

const modulationPanel = new ModulationPanel(pane, {
  sendPatch,
  getDoc: () => state.doc,
  showError: (message) => {
    lastError = message;
    renderBanners();
  },
});

/** The live phase slider and modulator value monitors move locally, about 10 times a second. */
const LIVE_TICK_MS = 100;
setInterval(() => {
  const now = wallMs();
  timelinePanel.tick(now);
  modulationPanel.tick(now);
}, LIVE_TICK_MS);

// ---- live preview ------------------------------------------------------------------
// A small output window embedded in the side column. Hiding it removes the iframe, so it
// stops rendering and frees its GPU context.

const PREVIEW_KEY = 'data-wrangler.control.preview';

function loadPreviewSetting(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== 'off';
  } catch {
    return true;
  }
}

function setPreview(on: boolean): void {
  el.previewToggle.checked = on;
  el.previewSection.hidden = !on;
  const existing = el.previewBox.querySelector('iframe');
  if (on && !existing) {
    const frame = document.createElement('iframe');
    frame.src = '/output/?preview';
    frame.title = 'Output preview';
    frame.tabIndex = -1;
    el.previewBox.append(frame);
  } else if (!on && existing) {
    existing.src = 'about:blank';
    existing.remove();
  }
  try {
    localStorage.setItem(PREVIEW_KEY, on ? 'on' : 'off');
  } catch {
    // Storage unavailable (private window, blocked site data): the setting just isn't kept.
  }
}

el.previewToggle.addEventListener('change', () => setPreview(el.previewToggle.checked));
setPreview(loadPreviewSetting());

// ---- state -------------------------------------------------------------------------

const state = new SyncedState(
  (doc, _prev, info) => {
    // Our own patches are already reflected in the GUI; refreshing mid-drag would fight the user.
    const external = info.full || info.origin !== clientId;
    if (external) syncGui(doc);
    renderProjects();
    datasetsPanel.update(state.projectName, doc.project.datasets);
    timelinePanel.update(doc);
    layersPanel.update(doc, external);
    modulationPanel.update(doc, external);
  },
  () => socket.send({ t: 'requestFull' }),
  (message) => addLog({ time: Date.now(), level: 'warn', source: 'control', message }),
);

let projectNames: string[] = [];

function renderProjects(): void {
  const current = state.projectName;
  const names = projectNames.includes(current) || !current ? projectNames : [...projectNames, current];
  el.projectSelect.replaceChildren(
    ...names.map((n) => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      o.selected = n === current;
      return o;
    }),
  );
}

el.projectSelect.addEventListener('change', () => {
  socket.send({ t: 'openProject', name: el.projectSelect.value });
});

function createProject(): void {
  const name = el.projectNew.value.trim();
  if (!PROJECT_NAME_RE.test(name)) {
    lastError = 'Project names use letters, digits, spaces, "-" and "_" (up to 64 characters).';
    renderBanners();
    return;
  }
  socket.send({ t: 'createProject', name });
  el.projectNew.value = '';
}
el.projectCreate.addEventListener('click', createProject);
el.projectNew.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') createProject();
});

// ---- status, banners, log -----------------------------------------------------------

function setPill(node: HTMLElement, cls: 'ok' | 'warn' | 'err' | '', text: string): void {
  node.className = `pill ${cls}`;
  node.textContent = text;
}

function renderConnection(s: ConnectionState): void {
  if (s === 'open') setPill(el.conn, 'ok', 'server connected');
  else if (s === 'connecting') setPill(el.conn, 'warn', 'server connecting…');
  else setPill(el.conn, 'err', 'server disconnected');
}

function renderOutputs(): void {
  const list = [...outputs.entries()];
  if (list.length === 0) {
    setPill(el.outPill, 'err', 'no output');
    el.outputsBody.className = 'muted';
    el.outputsBody.textContent = 'No output window connected.';
  } else {
    const bad = list.some(([, s]) => s.contextLost || s.layerErrors.length > 0);
    const slow = list.some(([, s]) => s.fps < 55);
    setPill(el.outPill, bad ? 'err' : slow ? 'warn' : 'ok', `${list.length} output${list.length > 1 ? 's' : ''}`);
    const table = document.createElement('table');
    const head = table.insertRow();
    for (const h of ['id', 'fps', 'cpu ms', 'rev', 'renderer', 'errors']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.append(th);
    }
    for (const [id, s] of list) {
      const row = table.insertRow();
      const errors = [...s.layerErrors, ...s.datasetErrors].map((e) => `${e.id}: ${e.message}`);
      if (s.contextLost) errors.unshift('WebGL context lost');
      for (const v of [id, s.fps.toFixed(1), s.frameMs.toFixed(2), String(s.rev), s.renderer, errors.join('; ') || '—']) {
        row.insertCell().textContent = v;
      }
    }
    el.outputsBody.className = '';
    el.outputsBody.replaceChildren(table);
  }
  renderBanners();
}

function renderBanners(): void {
  const banners: { cls: 'warn' | 'err'; text: string }[] = [];
  for (const [id, s] of outputs) {
    if (!s.vendorOk) {
      banners.push({
        cls: 'warn',
        text: `Output ${id} is rendering on "${s.renderer}", not the NVIDIA GPU. Check chrome://gpu and the PRIME offload notes.`,
      });
    }
  }
  if (lastError) banners.push({ cls: 'err', text: lastError });
  el.banners.replaceChildren(
    ...banners.map((b) => {
      const d = document.createElement('div');
      d.className = `banner ${b.cls}`;
      d.textContent = b.text;
      if (b.text === lastError) {
        d.title = 'Click to dismiss';
        d.style.cursor = 'pointer';
        d.addEventListener('click', () => {
          lastError = null;
          renderBanners();
        });
      }
      return d;
    }),
  );
}

function renderProblems(): void {
  if (problems.length === 0) {
    el.problems.className = 'muted';
    el.problems.textContent = 'None.';
    return;
  }
  el.problems.className = '';
  el.problems.replaceChildren(
    ...problems.map((p) => {
      const d = document.createElement('div');
      d.textContent = `${p.project}: ${p.message}`;
      return d;
    }),
  );
}

function addLog(entry: LogEntry): void {
  const atBottom = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 4;
  const line = document.createElement('div');
  line.className = entry.level;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = `${new Date(entry.time).toLocaleTimeString('en-NZ', { hour12: false })} `;
  line.append(time, `[${entry.source}] ${entry.message}`);
  el.log.append(line);
  while (el.log.childElementCount > MAX_LOG_LINES) el.log.firstElementChild?.remove();
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
}

// ---- connection -----------------------------------------------------------------------

const socket = new ReconnectingSocket(wsUrl(), {
  hello: () => ({ t: 'hello', role: 'control', clientId }),
  message: (msg) => {
    if (state.handle(msg)) return;
    switch (msg.t) {
      case 'projects':
        projectNames = msg.names;
        problems = msg.problems;
        renderProjects();
        renderProblems();
        return;
      case 'outputStatus':
        if (msg.status) outputs.set(msg.clientId, msg.status);
        else outputs.delete(msg.clientId);
        renderOutputs();
        return;
      case 'log':
        for (const e of msg.entries) addLog(e);
        return;
      case 'error':
        lastError = msg.message;
        renderBanners();
        return;
    }
  },
  state: (s) => {
    renderConnection(s);
    if (s === 'open') {
      // The log ring is replayed on hello; clear to avoid duplicates.
      el.log.replaceChildren();
      outputs.clear();
      renderOutputs();
    }
  },
});

renderConnection('connecting');
renderOutputs();
