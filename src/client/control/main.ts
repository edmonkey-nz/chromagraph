import { Pane } from 'tweakpane';
import { wallMs } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';
import type { LogEntry, OutputStatus, ProjectProblem } from '../../shared/protocol.ts';
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
import { Card, h, loadSetting, saveSetting } from './ui.ts';

/**
 * Control window composition.
 *
 *   header       project switcher, Save / Save as / Snapshots, save state, connection pills
 *   top band     live preview (top left, with edit-mode tools) | tabs: Datasets, Output
 *                windows, Calibration, Problems, Log
 *   workspace    cards in columns:
 *                  show    Scenes, Timeline, Modulation  (what changes over time)
 *                  look    Output & effects, Camera       (the whole frame)
 *                  layers  one card per layer, two columns when wide
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
  zoneShow: $('zone-show'),
  zoneLook: $('zone-look'),
  zoneLayers: $('zone-layers'),
  badges: { datasets: $('badge-datasets'), outputs: $('badge-outputs'), problems: $('badge-problems'), log: $('badge-log') },
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
    const external = info.full || info.origin !== clientId || replacesProjectBranch(info.ops ?? []);
    projectBar.setCurrent(state.projectName);
    if (info.full) projectBar.tracker.resynced();
    else if (prev && doc.project !== prev.project && touchesProject(info.ops ?? [])) projectBar.tracker.changed(info.origin === clientId, Date.now());
    projectBar.renderState(Date.now());
    datasetsPanel.update(state.projectName, doc.project.datasets);
    el.badges.datasets.textContent = doc.project.datasets.length > 0 ? String(doc.project.datasets.length) : '';
    outputPanel.update(doc, external);
    cameraPanel.update(doc, external);
    timelinePanel.update(doc);
    scenesPanel.update(doc);
    layersPanel.update(doc, external);
    editMode.update(doc);
    modulationPanel.update(doc, external);
    calibrationPanel.update(doc, external);
  },
  () => socket.send({ t: 'requestFull' }),
  (message) => addLog({ time: Date.now(), level: 'warn', source: 'control', message }),
);

function sendPatch(ops: PatchOp[]): void {
  if (!socket.send({ t: 'patch', ops })) {
    addLog({ time: Date.now(), level: 'warn', source: 'control', message: 'not connected; change not sent' });
    return;
  }
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

// Show column: what changes over time.
const scenesCard = card(el.zoneShow, 'scenes', 'Scenes');
const scenesPanel = new ScenesPanel(scenesCard.body, { sendPatch, getDoc, showError });
const timelineCard = card(el.zoneShow, 'timeline', 'Timeline');
const timelinePanel = new TimelinePanel(paneIn(timelineCard), { sendPatch, getDoc });
const modulationCard = card(el.zoneShow, 'modulation', 'Modulation');
const modulationPanel = new ModulationPanel(paneIn(modulationCard), { sendPatch, getDoc, showError });

// Look column: the whole frame.
const outputCard = card(el.zoneLook, 'output', 'Output & effects');
const outputPanel = new OutputPanel(paneIn(outputCard), { sendPatch, getDoc });
const cameraCard = card(el.zoneLook, 'camera', 'Camera');
const cameraPanel = new CameraPanel(paneIn(cameraCard), sendPatch);

// ---- datasets ----------------------------------------------------------------------

const datasetsPanel = new DatasetsPanel(el.datasets, el.importFile, sendPatch, showError);
el.importButton.addEventListener('click', () => el.importFile.click());

// ---- layers ------------------------------------------------------------------------

const layersPanel = new LayersPanel(el.zoneLayers, {
  sendPatch,
  getDoc,
  summary: (id) => datasetsPanel.summary(id),
  showError,
  select: (id) => editMode.select(id),
});
datasetsPanel.onChange = () => layersPanel.refreshSummaries();

/** The live phase slider, modulator monitors and morph bars move locally, about 10 times a second. */
setInterval(() => {
  const now = wallMs();
  timelinePanel.tick(now);
  modulationPanel.tick(now);
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
    showSelection: (id, reveal) => layersPanel.setSelected(id, reveal),
  },
);

// ---- output calibration (phase 5) -------------------------------------------------------

const calibrationPanel = new CalibrationPanel($('calibration'), sendPatch, (msg) => socket.send(msg), showError);

// ---- data tabs ---------------------------------------------------------------------------

/** The log follows new lines unless the user has scrolled up in it. */
let logFollow = true;
let unseenLogIssues = 0;
el.log.addEventListener('scroll', () => {
  if (el.log.clientHeight > 0) logFollow = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 4;
});

const tabs = new Tabs($('tab-datasets').parentElement as HTMLElement, 'tab', (panel) => {
  if (panel === 'panel-log') {
    unseenLogIssues = 0;
    el.badges.log.textContent = '';
    if (logFollow) el.log.scrollTop = el.log.scrollHeight;
  }
});

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
        text: `Output ${id} is rendering on "${s.renderer}", not the NVIDIA GPU. Check chrome://gpu and the PRIME offload notes.`,
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

function renderProblems(): void {
  el.badges.problems.textContent = problems.length > 0 ? String(problems.length) : '';
  if (problems.length === 0) {
    el.problems.className = 'muted';
    el.problems.textContent = 'None.';
    return;
  }
  el.problems.className = '';
  el.problems.replaceChildren(...problems.map((p) => h('div', { textContent: `${p.project}: ${p.message}` })));
}

function addLog(entry: LogEntry): void {
  const line = h('div', { className: entry.level }, h('span', { className: 'time', textContent: `${new Date(entry.time).toLocaleTimeString('en-NZ', { hour12: false })} ` }));
  line.append(`[${entry.source}] ${entry.message}`);
  el.log.append(line);
  while (el.log.childElementCount > MAX_LOG_LINES) el.log.firstElementChild?.remove();
  if (logFollow) el.log.scrollTop = el.log.scrollHeight;
  if (entry.level !== 'info' && tabs.active !== 'panel-log') {
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
