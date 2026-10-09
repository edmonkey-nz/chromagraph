import { Pane } from 'tweakpane';
import { wallMs } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';
import type { LogEntry, OutputStatus, ProjectProblem } from '../../shared/protocol.ts';
import { orphanParamIds } from '../../shared/modulation-helpers.ts';
import { parseParamId } from '../../shared/parameters.ts';
import { touchesProject } from '../../shared/save-status.ts';
import { replacesProjectBranch } from '../../shared/scene-helpers.ts';
import { makeClientId, ReconnectingSocket, wsUrl, type ConnectionState } from '../common/socket.ts';
import { SyncedState } from '../common/synced-state.ts';
import { CalibrationPanel } from './calibration-panel.ts';
import { CameraPanel } from './camera-panel.ts';
import { DatasetsPanel } from './datasets-panel.ts';
import { EditMode } from './edit-mode.ts';
import { LayersPanel } from './layers-panel.ts';
import { ModulationPanel } from './modulation-panel.ts';
import { OutputPanel } from './output-panel.ts';
import { ProjectBar } from './project-bar.ts';
import { ScenesPanel } from './scenes-panel.ts';
import { Tabs } from './tabs.ts';
import { TimelinePanel } from './timeline-panel.ts';
import { TimelineStrip } from './timeline-strip.ts';
import { TimelineView } from './timeline-view.ts';
import { renderMarkdown } from './markdown.ts';
import { Card, h, icon, loadSetting, saveSetting } from './ui.ts';

/**
 * Control window composition.
 *
 *   header       project switcher, Save / Save as / Snapshots, save state, output buttons,
 *                connection pills
 *   workspace    two columns:
 *                  left    live preview (with edit-mode tools) and the project timeline
 *                          strip under it, Camera
 *                  right   tabs, full height: Scene (Scenes, Timeline, Output, Calibration),
 *                          Datasets, Layers (one card per layer, two columns when wide; each
 *                          card has the layer's own Modulation folder) and Timeline (the
 *                          project, layer and camera timelines with their lanes)
 *   drawer       tabs along the bottom: Output windows, Diagnostics, Problems, Log. Closed
 *                it is just the tab strip; a tab opens it upwards.
 *
 * Each card has its own Tweakpane pane. GUI values are only ever sent as patches; the
 * renderer never reads them.
 */

const MAX_LOG_LINES = 500;
const LIVE_TICK_MS = 100;

const clientId = makeClientId('control');
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  conn: $('conn'),
  outPill: $('out-pill'),
  banners: $('banners'),
  outputsBody: $('outputs-body'),
  problems: $('problems'),
  log: $('log'),
  datasets: $('datasets'),
  importButton: $<HTMLButtonElement>('import-button'),
  importFile: $<HTMLInputElement>('import-file'),
  previewToggle: $<HTMLInputElement>('preview-toggle'),
  previewBox: $('preview-box'),
  previewOff: $('preview-off'),
  editToggle: $<HTMLInputElement>('edit-toggle'),
  gizmoModes: $('gizmo-modes'),
  snapSelect: $<HTMLSelectElement>('snap-select'),
  editBadge: $('edit-badge'),
  panelScene: $('panel-scene'),
  zoneLook: $('zone-look'),
  panelLayers: $('panel-layers'),
  panelTimeline: $('panel-timeline'),
  badges: {
    datasets: $('badge-datasets'),
    outputs: $('badge-outputs'),
    problems: $('badge-problems'),
    log: $('badge-log'),
    layers: $('badge-layers'),
    timeline: $('badge-timeline'),
  },
};

const outputs = new Map<string, OutputStatus>();
let problems: ProjectProblem[] = [];
let lastError: string | null = null;

function showError(message: string): void {
  lastError = message;
  renderBanners();
}

// ---- state -------------------------------------------------------------------------
// Created before the panels: several read `state.doc` while they are being built. The change
// callback only runs once messages arrive, after everything below is initialised.

const state = new SyncedState(
  (doc, prev, info) => {
    // Our own patches are already reflected in the GUI; refreshing mid-drag would fight the
    // user. Going to a scene replaces whole branches, though, so its echo counts as external.
    let refresh = false;
    if (info.full) ownEchoes.length = 0;
    else if (info.origin === clientId) refresh = ownEchoes.shift() ?? false;
    const external = info.full || info.origin !== clientId || refresh || replacesProjectBranch(info.ops ?? []);
    projectBar.setCurrent(state.projectName);
    if (info.full) projectBar.tracker.resynced();
    else if (prev && doc.project !== prev.project && touchesProject(info.ops ?? [])) projectBar.tracker.changed(info.origin === clientId, Date.now());
    projectBar.renderState(Date.now());
    datasetsPanel.update(state.projectName, doc.project.datasets);
    el.badges.datasets.textContent = doc.project.datasets.length > 0 ? String(doc.project.datasets.length) : '';
    outputPanel.update(doc, external);
    renderDiagnostics(doc);
    cameraPanel.update(doc, external);
    timelinePanel.update(doc);
    scenesPanel.update(doc);
    layersPanel.update(doc, external);
    timelineView.update(doc, external);
    timelineStrip.update(doc);
    el.badges.layers.textContent = doc.project.layers.length > 0 ? String(doc.project.layers.length) : '';
    const animated = Object.keys(doc.project.parameters).filter((id) => hasOwner(doc, id)).length;
    el.badges.timeline.textContent = animated > 0 ? String(animated) : '';
    editMode.update(doc);
    cameraModulation.update(doc, external);
    cameraModulationFolder.title = cameraModulation.count > 0 ? `Modulation (${cameraModulation.count})` : 'Modulation';
    renderProblems();
    calibrationPanel.update(doc, external);
  },
  () => socket.send({ t: 'requestFull' }),
  (message) => addLog({ time: Date.now(), level: 'warn', source: 'control', message }),
);

/**
 * For each of our patches whose echo is still to come (in order): whether the panels should
 * treat that echo as external. The Timeline tab edits modulators that the layer cards'
 * Modulation folders also show, so its settled edits ask them to refresh. A rejected patch
 * gets no echo but a full resync, which clears the queue.
 */
const ownEchoes: boolean[] = [];

function sendPatch(ops: PatchOp[], refresh = false): void {
  if (!socket.send({ t: 'patch', ops })) {
    addLog({ time: Date.now(), level: 'warn', source: 'control', message: 'not connected; change not sent' });
    return;
  }
  ownEchoes.push(refresh);
  if (touchesProject(ops)) {
    projectBar.tracker.sent(Date.now());
    projectBar.renderState(Date.now());
  }
}

const getDoc = (): SyncDoc | null => state.doc;

// ---- header: project, save, snapshots ------------------------------------------------------

const projectBar = new ProjectBar(
  {
    select: $<HTMLSelectElement>('project-select'),
    newButton: $<HTMLButtonElement>('project-new'),
    saveButton: $<HTMLButtonElement>('save-button'),
    saveAsButton: $<HTMLButtonElement>('save-as-button'),
    snapshotsButton: $<HTMLButtonElement>('snapshots-button'),
    snapshotsCount: $('snapshots-count'),
    snapshotsPopover: $('snapshots-pop'),
    saveState: $('save-state'),
  },
  { send: (msg) => socket.send(msg), showError },
);

// ---- cards ---------------------------------------------------------------------------------

function card(zone: HTMLElement, key: string, title: string, collapsed = false): Card {
  const c = new Card({ title, storeKey: key, collapsed });
  zone.append(c.root);
  return c;
}

function paneIn(c: Card): Pane {
  return new Pane({ container: c.body });
}

// Scene tab (right zone): the scene as a whole: scenes, the project timeline, the output
// background, and the projector calibration (whose panel is built further down).
const scenesCard = card(el.panelScene, 'scenes', 'Scenes');
const scenesPanel = new ScenesPanel(scenesCard.body, { sendPatch, getDoc, showError });
const timelineCard = card(el.panelScene, 'timeline', 'Scene timeline');
const timelinePanel = new TimelinePanel(paneIn(timelineCard), { sendPatch, getDoc });
const outputCard = card(el.panelScene, 'output', 'Output');
const outputPanel = new OutputPanel(paneIn(outputCard), { sendPatch, getDoc });
const calibrationCard = card(el.panelScene, 'calibration', 'Calibration');

// Left column, under the preview: the camera.
const cameraCard = card(el.zoneLook, 'camera', 'Camera');
const cameraPane = paneIn(cameraCard);
const cameraPanel = new CameraPanel(cameraPane, sendPatch);
// The camera's own modulators (motion presets show here too).
const cameraModulationFolder = cameraPane.addFolder({ title: 'Modulation', expanded: loadSetting('camera-modulation') === 'open' });
cameraModulationFolder.on('fold', (ev) => saveSetting('camera-modulation', ev.expanded ? 'open' : 'closed'));
const cameraModulation = new ModulationPanel(cameraModulationFolder, { sendPatch, getDoc, showError }, { kind: 'camera' });

// ---- datasets ----------------------------------------------------------------------

const datasetsPanel = new DatasetsPanel(el.datasets, el.importFile, sendPatch, showError);
el.importButton.addEventListener('click', () => el.importFile.click());

// ---- layers ------------------------------------------------------------------------

const layersPanel = new LayersPanel(el.panelLayers, {
  sendPatch,
  getDoc,
  summary: (id) => datasetsPanel.summary(id),
  showError,
  select: (id) => editMode.select(id),
});
datasetsPanel.onChange = () => layersPanel.refreshSummaries();

// The right zone's second tab: every timeline, its playheads, keyframes and other modulators.
const timelineView = new TimelineView(el.panelTimeline, { sendPatch, getDoc, showError, select: (id) => editMode.select(id) });
// It animates (requestAnimationFrame) only while shown; the chosen tab is remembered.
new Tabs($('tab-layers').parentElement as HTMLElement, 'right-tab', (panel) => timelineView.setVisible(panel === 'panel-timeline'));

/** The live phase slider, modulator monitors and morph bars move locally, about 10 times a second. */
setInterval(() => {
  const now = wallMs();
  timelinePanel.tick(now);
  layersPanel.tick(now);
  if (cameraModulationFolder.expanded) cameraModulation.tick(now);
  scenesPanel.tick(now);
  projectBar.renderState(Date.now());
}, LIVE_TICK_MS);

// ---- live preview ------------------------------------------------------------------
// A small output window, top left. Hiding it removes the iframe, so it stops rendering and
// frees its GPU context.

function setPreview(on: boolean): void {
  el.previewToggle.checked = on;
  el.previewOff.hidden = on;
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
  saveSetting('preview', on ? 'on' : 'off');
}

el.previewToggle.addEventListener('change', () => {
  setPreview(el.previewToggle.checked);
  editMode.previewChanged(el.previewToggle.checked);
});
setPreview(loadSetting('preview') !== 'off');

// The project timeline under the preview (always shown, also with the preview off). It
// animates itself while on screen.
const timelineStrip = new TimelineStrip($('timeline-strip'), { sendPatch, getDoc });

// ---- edit mode (gizmo editing in the preview) ---------------------------------------------

const editMode = new EditMode(
  { toggle: el.editToggle, modes: el.gizmoModes, snap: el.snapSelect, badge: el.editBadge },
  {
    sendPatch,
    getDoc,
    frame: () => el.previewBox.querySelector('iframe'),
    showPreview: () => {
      if (!el.previewToggle.checked) setPreview(true);
    },
    showSelection: (id, reveal) => {
      layersPanel.setSelected(id, reveal);
      timelineView.setSelected(id);
    },
  },
);

// ---- output calibration (phase 5) -------------------------------------------------------

const calibrationPanel = new CalibrationPanel(calibrationCard.body, sendPatch, (msg) => socket.send(msg), showError);

// ---- output window buttons (header) ------------------------------------------------------
// The server starts and closes the output's Chrome (`server/launcher.ts`), on the NVIDIA GPU.

const outputButtons = {
  projector: $<HTMLButtonElement>('output-projector'),
  window: $<HTMLButtonElement>('output-window'),
  close: $<HTMLButtonElement>('output-close'),
};
outputButtons.window.append(icon('window'));
outputButtons.projector.append(icon('projector'));
outputButtons.close.append(icon('close'));

// ---- About box: ABOUT.md, fetched fresh each time it opens --------------------------------

const aboutDialog = $<HTMLDialogElement>('about-dialog');
const aboutBody = $('about-body');
$('about-button').append(icon('help'));
$('about-close').append(icon('close'));
$('about-button').addEventListener('click', () => void openAbout());
$('about-close').addEventListener('click', () => aboutDialog.close());
// A click on the backdrop (outside the box) closes it; Escape closes it natively.
aboutDialog.addEventListener('click', (ev) => {
  if (ev.target === aboutDialog) aboutDialog.close();
});

async function openAbout(): Promise<void> {
  aboutBody.textContent = 'Loading…';
  aboutDialog.showModal();
  try {
    const res = await fetch('/api/about', { cache: 'no-store' });
    const text = res.ok ? await res.text() : '';
    if (text.trim()) aboutBody.innerHTML = renderMarkdown(text);
    else aboutBody.replaceChildren(h('p', { className: 'muted', textContent: 'ABOUT.md (in the project folder) is empty. Write it in Markdown and it shows here.' }));
  } catch {
    aboutBody.replaceChildren(h('p', { className: 'muted', textContent: 'The server isn’t reachable, so ABOUT.md can’t be shown.' }));
  }
}

async function outputRequest(path: string, body: unknown, failure: string): Promise<void> {
  const all = Object.values(outputButtons);
  for (const b of all) b.disabled = true;
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const reply = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
      showError(`${failure}: ${reply?.error ?? reply?.message ?? res.statusText}`);
    }
  } catch {
    showError(`${failure}: the server isn't reachable`);
  } finally {
    for (const b of all) b.disabled = false;
  }
}

outputButtons.projector.addEventListener('click', () => void outputRequest('/api/output/launch', { mode: 'projector' }, 'Output not opened'));
outputButtons.window.addEventListener('click', () => void outputRequest('/api/output/launch', { mode: 'window' }, 'Output not opened'));
outputButtons.close.addEventListener('click', () => void outputRequest('/api/output/close', {}, 'Output not closed'));

// Clicking a Tweakpane checkbox's label toggles it, as a native <label> would.
document.addEventListener('click', (ev) => {
  const label = ev.target instanceof Element ? ev.target.closest('.tp-lblv_l') : null;
  const input = label?.parentElement?.querySelector<HTMLInputElement>(':scope > .tp-lblv_v .tp-ckbv_i');
  if (input && !input.disabled) input.click();
});

// ---- diagnostics tab ---------------------------------------------------------------------
// Session switches (never saved with the project). The calibration panel also drives the test pattern.

const diag = {
  testPattern: $<HTMLInputElement>('diag-test-pattern'),
  debugOverlay: $<HTMLInputElement>('diag-debug-overlay'),
};
diag.testPattern.addEventListener('change', () => sendPatch([{ op: 'set', path: ['session', 'testPattern'], value: diag.testPattern.checked }]));
diag.debugOverlay.addEventListener('change', () => sendPatch([{ op: 'set', path: ['session', 'debugOverlay'], value: diag.debugOverlay.checked }]));

function renderDiagnostics(doc: SyncDoc): void {
  diag.testPattern.checked = doc.session.testPattern;
  diag.debugOverlay.checked = doc.session.debugOverlay;
}

// ---- data tabs ---------------------------------------------------------------------------

/** The log follows new lines unless the user has scrolled up in it. */
let logFollow = true;
let unseenLogIssues = 0;
el.log.addEventListener('scroll', () => {
  if (el.log.clientHeight > 0) logFollow = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 4;
});

// The drawer along the bottom: a tab opens it (or, if already showing, closes it); the
// chevron toggles it; its top edge drags to resize. Open state and height are remembered.
const drawer = $('drawer');
const drawerToggle = $<HTMLButtonElement>('drawer-toggle');
function setDrawer(open: boolean): void {
  drawer.classList.toggle('open', open);
  drawerToggle.setAttribute('aria-expanded', String(open));
  saveSetting('drawer', open ? 'open' : 'closed');
  if (open && tabs.active === 'panel-log') seenLog();
}
drawerToggle.addEventListener('click', () => setDrawer(!drawer.classList.contains('open')));
{
  const stored = Number(loadSetting('drawer-h'));
  if (stored > 0) drawer.style.setProperty('--drawer-h', `${stored}px`);
  const handle = $('drawer-handle');
  handle.addEventListener('pointerdown', (down) => {
    const panels = $('drawer-panels');
    const startY = down.clientY;
    const startH = panels.getBoundingClientRect().height;
    handle.setPointerCapture(down.pointerId);
    const move = (ev: PointerEvent) => {
      const hgt = Math.round(Math.min(Math.max(startH + startY - ev.clientY, 120), window.innerHeight * 0.8));
      drawer.style.setProperty('--drawer-h', `${hgt}px`);
      saveSetting('drawer-h', String(hgt));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function seenLog(): void {
  unseenLogIssues = 0;
  el.badges.log.textContent = '';
  if (logFollow) el.log.scrollTop = el.log.scrollHeight;
}

const tabs = new Tabs(
  $('tab-outputs').parentElement as HTMLElement,
  'tab',
  (panel) => {
    if (panel === 'panel-log' && drawer.classList.contains('open')) seenLog();
  },
  (_panel, wasActive) => setDrawer(!(wasActive && drawer.classList.contains('open'))),
);
setDrawer(loadSetting('drawer') === 'open');

// ---- status, banners, log -----------------------------------------------------------

function setPill(node: HTMLElement, cls: 'ok' | 'warn' | 'err' | '', text: string): void {
  node.className = `pill ${cls}`;
  node.textContent = text;
}

function renderConnection(s: ConnectionState): void {
  if (s === 'open') setPill(el.conn, 'ok', 'Server');
  else if (s === 'connecting') setPill(el.conn, 'warn', 'Server connecting…');
  else setPill(el.conn, 'err', 'Server disconnected');
}

function renderOutputs(): void {
  const list = [...outputs.entries()];
  el.badges.outputs.textContent = list.length > 0 ? String(list.length) : '';
  if (list.length === 0) {
    setPill(el.outPill, 'err', 'No output');
    el.outputsBody.className = 'muted';
    el.outputsBody.textContent = 'No output window connected. Open /output on the projector machine.';
  } else {
    const bad = list.some(([, s]) => s.contextLost || s.layerErrors.length > 0);
    const slow = list.some(([, s]) => s.fps < 55);
    const fps = Math.min(...list.map(([, s]) => s.fps));
    setPill(el.outPill, bad ? 'err' : slow ? 'warn' : 'ok', `${list.length} output${list.length > 1 ? 's' : ''} · ${fps.toFixed(0)} fps`);
    const table = document.createElement('table');
    const head = table.insertRow();
    for (const t of ['id', 'fps', 'cpu ms', 'rev', 'renderer', 'errors']) head.append(h('th', { textContent: t }));
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
  const banners: { cls: 'warn' | 'err'; text: string; dismiss: boolean }[] = [];
  for (const [id, s] of outputs) {
    if (!s.vendorOk) {
      banners.push({
        cls: 'warn',
        text: `Output ${id} is rendering on "${s.renderer}", not the NVIDIA GPU. Close it and use Output → On projector, which starts Chrome on the NVIDIA GPU.`,
        dismiss: false,
      });
    }
  }
  if (lastError) banners.push({ cls: 'err', text: lastError, dismiss: true });
  el.banners.replaceChildren(
    ...banners.map((b) => {
      const d = h('div', { className: `banner ${b.cls}` }, b.text);
      if (b.dismiss) {
        const close = h('button', { type: 'button', className: 'btn small ghost', textContent: 'Dismiss' });
        close.addEventListener('click', () => {
          lastError = null;
          renderBanners();
        });
        d.append(close);
      }
      return d;
    }),
  );
}

/**
 * Project problems from the server, plus modulators left behind by deleted layers (a layer's
 * other orphans show in its own Modulation folder).
 */
function renderProblems(): void {
  const doc = state.doc;
  const orphans = doc ? orphanParamIds(doc.project).filter((id) => !hasOwner(doc, id)) : [];
  const count = problems.length + orphans.length;
  el.badges.problems.textContent = count > 0 ? String(count) : '';
  if (count === 0) {
    el.problems.className = 'muted';
    el.problems.textContent = 'None.';
    return;
  }
  el.problems.className = '';
  const rows: HTMLElement[] = problems.map((p) => h('div', { textContent: `${p.project}: ${p.message}` }));
  if (orphans.length > 0) {
    const removeAll = h('button', { type: 'button', className: 'btn small', textContent: 'Remove all' });
    removeAll.addEventListener('click', () => sendPatch(orphans.map((id) => ({ op: 'remove', path: ['project', 'parameters', id] }))));
    rows.push(h('div', { className: 'problem-row summary' }, `${orphans.length} modulator${orphans.length > 1 ? 's' : ''} of deleted layers`, removeAll));
    for (const id of orphans) {
      const remove = h('button', { type: 'button', className: 'btn small ghost', textContent: 'Remove' });
      remove.addEventListener('click', () => sendPatch([{ op: 'remove', path: ['project', 'parameters', id] }]));
      rows.push(h('div', { className: 'problem-row muted' }, id, remove));
    }
  }
  el.problems.replaceChildren(...rows);
}

/** True when a parameter id belongs to the camera or to a layer that still exists. */
function hasOwner(doc: SyncDoc, id: string): boolean {
  const t = parseParamId(id);
  return t?.kind === 'camera' || (t?.kind === 'layer' && doc.project.layers.some((l) => l.id === t.layerId));
}

function addLog(entry: LogEntry): void {
  const line = h('div', { className: entry.level }, h('span', { className: 'time', textContent: `${new Date(entry.time).toLocaleTimeString('en-NZ', { hour12: false })} ` }));
  line.append(`[${entry.source}] ${entry.message}`);
  el.log.append(line);
  while (el.log.childElementCount > MAX_LOG_LINES) el.log.firstElementChild?.remove();
  if (logFollow) el.log.scrollTop = el.log.scrollHeight;
  if (entry.level !== 'info' && !(tabs.active === 'panel-log' && drawer.classList.contains('open'))) {
    unseenLogIssues++;
    el.badges.log.textContent = String(unseenLogIssues);
  }
}

// ---- connection -----------------------------------------------------------------------

const socket = new ReconnectingSocket(wsUrl(), {
  hello: () => ({ t: 'hello', role: 'control', clientId }),
  message: (msg) => {
    if (state.handle(msg)) return;
    switch (msg.t) {
      case 'projects':
        projectBar.setProjects(msg.names);
        problems = msg.problems;
        renderProblems();
        return;
      case 'profiles':
        calibrationPanel.setProfiles(msg.names, msg.current);
        return;
      case 'saved':
        projectBar.saved(msg.project, msg.at);
        return;
      case 'snapshots':
        projectBar.setSnapshots(msg.project, msg.list);
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
        showError(msg.message);
        return;
    }
  },
  state: (s) => {
    renderConnection(s);
    if (s === 'open') {
      // The log ring is replayed on hello; clear to avoid duplicates.
      el.log.replaceChildren();
      unseenLogIssues = 0;
      el.badges.log.textContent = '';
      outputs.clear();
      renderOutputs();
    }
  },
});

renderConnection('connecting');
renderOutputs();
