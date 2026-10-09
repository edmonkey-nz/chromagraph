import { LAYER_TYPE_TITLES } from '../../shared/layer-helpers.ts';
import { formatClock, formatValue, paramTitle } from '../../shared/modulation-helpers.ts';
import { wallMs, type Parameter, type TimelineSettings, type Transport } from '../../shared/modulators.ts';
import { applyOps, type PatchOp } from '../../shared/patch.ts';
import { ProjectSchema, type SyncDoc } from '../../shared/project-schema.ts';
import {
  addKeyOps,
  buildLane,
  clockState,
  deleteKeyOps,
  denormalise,
  emptyClock,
  formatTick,
  keyAtPlayheadOps,
  laneValue,
  moveKeyOps,
  moveRampOps,
  normalise,
  playbackTitle,
  reframeLane,
  removeLaneOps,
  tickStep,
  timelineSummary,
  timelineView,
  type ClockState,
  type CurveLane,
  type Lane,
  type TimelineGroup,
} from '../../shared/timeline-view.ts';
import { layerTimeline, playPauseEdit, projectTimeline, SCRUB_INTERVAL_MS, seekEdit, type TimelineTarget } from './timeline-panel.ts';
import { h, icon, iconButton, loadSetting, saveSetting } from './ui.ts';

/**
 * The Timeline tab (second tab of the right-hand zone): the project transport and ruler
 * with its playhead, then one group per layer (stack order) and the camera, each with a
 * lane per modulated parameter.
 *
 * Every group is drawn against the timeline that drives it: x runs over phase 0..1 of the
 * project timeline, or of the layer's own timeline (which then gets its own ruler, labelled
 * in its own seconds, its own playhead and its own Play/Pause). Groups that follow the
 * project line up with the master ruler. Ramps and keyframes are curves on that axis; LFO
 * and noise lanes are free-running (wall clock), so they are hatched, cover the playhead,
 * and show a scope of their last few seconds with "now" at the right edge.
 *
 * Editing: drag a key (Shift locks it to one axis), double-click a lane to add a key, select
 * one and press Delete; "key at playhead" per lane, and "Keyframe…" per group to animate any
 * other parameter. Edits are validated locally and sent as whole-modulator patches (throttled
 * while dragging, with the final value always sent). While a key is dragged, that lane
 * ignores incoming documents, so our own echoes never pull it back.
 *
 * Playheads move with requestAnimationFrame only while the tab is visible. Lanes are canvases
 * redrawn when their data changes; per frame only the playhead lines, live value dots,
 * readouts (10 times a second) and the LFO/noise scopes are updated.
 */

export interface TimelineViewDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
  showError(message: string): void;
  /** The user selected a layer (clicked its group name). */
  select(layerId: string): void;
}

/** Inset of phase 0 and 1 from the track edges, so keys at the ends are not clipped. */
const PAD_X = 10;
const PAD_Y = 8;
const CURVE_H = 58;
const WAVE_H = 44;
const RULER_H = 26;
/** Pointer distance (px) that picks a key. */
const HIT_PX = 8;
/** Movement (px) before Shift decides which axis a drag is locked to. */
const AXIS_PX = 4;
const READOUT_MS = 100;
const SCOPE_POINTS = 160;
const COLLAPSED_KEY = 'timeline-collapsed';

const KIND_CHIPS: Record<Lane['kind'], string> = { keyframes: 'keys', ramp: 'ramp', lfo: 'LFO', noise: 'noise' };

/** Last transport known for a timeline: the synced one, or one we just sent or are scrubbing. */
class TransportTrack {
  seen: Transport | null = null;
  local: Transport | null = null;
  scrubbing = false;
  lastSendMs = 0;

  sync(t: Transport): void {
    if (t === this.seen) return;
    this.seen = t;
    // Mid-scrub, echoes of our earlier seeks would pull the playhead back.
    if (!this.scrubbing) this.local = t;
  }
}

interface Colours {
  text: string;
  muted: string;
  line: string;
  grid: string;
  card: string;
  playhead: string;
  kinds: Record<Lane['kind'], string>;
}

interface RulerUi {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  head: HTMLElement;
  target: TimelineTarget;
  track: TransportTrack;
  settings: TimelineSettings;
  lastX: number;
}

interface LaneUi {
  lane: Lane;
  group: GroupUi;
  row: HTMLElement;
  track: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dot: HTMLElement | null;
  valueEl: HTMLElement;
  infoEl: HTMLElement;
  lastValue: string;
  /** The parameter object and base value the lane was built from (to spot changes). */
  param: Parameter | undefined;
  lastDotX: number;
  lastDotY: number;
}

interface GroupUi {
  g: TimelineGroup;
  root: HTMLElement;
  body: HTMLElement;
  /** The playhead line over the group's lanes. */
  line: HTMLElement;
  lanes: LaneUi[];
  ruler: RulerUi | null;
  clock: ClockState;
  track: TransportTrack;
  posEl: HTMLElement | null;
  playBtn: HTMLButtonElement | null;
  lastPos: string;
  lastLineX: number;
  /** Track geometry inside the group body: left edge and width (px). */
  left: number;
  width: number;
}

interface Drag {
  lu: LaneUi;
  id: string;
  /** The project when the drag began: every move is computed from it, so stale docs don't matter. */
  start: SyncDoc;
  index: number;
  startAt: number;
  startValue: number;
  x0: number;
  y0: number;
  lo: number;
  hi: number;
  axis: 'x' | 'y' | null;
  last: { at: number; value: number };
  pending: PatchOp[] | null;
  lastSendMs: number;
}

interface Selection {
  id: string;
  index: number;
}

function sizeCanvas(c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, hgt: number): void {
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(hgt * dpr));
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
  }
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function context(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

/** x (px, within a track of width w) of phase p. */
const xOf = (p: number, w: number) => PAD_X + p * Math.max(w - PAD_X * 2, 1);
/** Phase of x within a track of width w, clamped to 0..1. */
const phaseOf = (x: number, w: number) => Math.min(Math.max((x - PAD_X) / Math.max(w - PAD_X * 2, 1), 0), 1);
/** y (px) of lane position n (0 bottom, 1 top). */
const yOf = (n: number, hgt: number) => PAD_Y + (1 - n) * (hgt - PAD_Y * 2);
const nOf = (y: number, hgt: number) => 1 - (y - PAD_Y) / (hgt - PAD_Y * 2);

function isCurve(lane: Lane): lane is CurveLane {
  return lane.kind === 'ramp' || lane.kind === 'keyframes';
}

/** A key time for display: "7.5 s" on short timelines, "3:25" on long ones. */
function keyTime(phase: number, durationSec: number): string {
  const s = phase * durationSec;
  return durationSec < 120 ? `${formatValue(Math.round(s * 10) / 10)} s` : formatClock(s, durationSec);
}

export class TimelineView {
  private root = h('div', { className: 'tl-root' });
  private groupsEl = h('div', { className: 'tl-groups' });
  private emptyEl = h('p', { className: 'tl-empty muted', textContent: 'No layers yet.' });
  private masterTrack = h('div', { className: 'tl-track tl-ruler' });
  private masterRuler: RulerUi;
  private masterPlay: HTMLButtonElement;
  private masterPos = h('span', { className: 'tl-pos' });
  private masterMode = h('span', { className: 'tl-chip' });
  private masterLabelNote = h('span', { className: 'tl-sub' });
  private masterClock = emptyClock();
  private lastMasterPos = '';

  private doc: SyncDoc | null = null;
  private dirty = true;
  private visible = false;
  private raf = 0;
  private builtKey = '';
  private groups: GroupUi[] = [];
  private lanesById = new Map<string, LaneUi>();
  private tracks = new Map<string, TransportTrack>();
  private colours: Colours;
  private collapsed: Set<string>;
  private selectedLayer: string | null = null;
  private selection: Selection | null = null;
  private drag: Drag | null = null;
  private lastReadoutMs = 0;
  private trackWidth = 0;
  private scope = new Float32Array(SCOPE_POINTS);
  /** Our last sent edit applied locally, until a newer document arrives (see editDoc). */
  private optimistic: { base: SyncDoc; doc: SyncDoc } | null = null;

  constructor(
    host: HTMLElement,
    private deps: TimelineViewDeps,
  ) {
    let stored: unknown = [];
    try {
      stored = JSON.parse(loadSetting(COLLAPSED_KEY) ?? '[]');
    } catch {
      stored = [];
    }
    this.collapsed = new Set(Array.isArray(stored) ? stored.filter((s): s is string => typeof s === 'string') : []);

    this.masterPlay = iconButton('play', 'Play', () => this.playPause(projectTimeline, this.track('project')), 'tl-play');
    const restart = iconButton('restart', 'Restart (also restarts layers with their own timeline)', () => this.seek(projectTimeline, this.track('project'), 'restart'));
    const hint = h('span', { className: 'tl-hint', textContent: 'Drag keys (Shift: one axis) · double-click a lane to add a key · Delete removes it' });
    const masterCanvas = h('canvas');
    const masterHead = h('div', { className: 'tl-head-mark' });
    this.masterTrack.append(masterCanvas, masterHead);
    this.masterRuler = {
      canvas: masterCanvas,
      ctx: context(masterCanvas),
      head: masterHead,
      target: projectTimeline,
      track: this.track('project'),
      settings: { duration: 600, loop: true, playback: 'forward' },
      lastX: -1,
    };
    this.bindRuler(this.masterRuler, this.masterTrack);
    this.masterTrack.title = 'Click or drag to move the project playhead';
    const head = h(
      'div',
      { className: 'tl-header' },
      h('div', { className: 'tl-transport' }, this.masterPlay, restart, this.masterPos, this.masterMode, h('span', { className: 'spacer' }), hint),
      h(
        'div',
        { className: 'tl-row tl-master' },
        h('div', { className: 'tl-label' }, h('span', { className: 'tl-name', textContent: 'Project' }), this.masterLabelNote),
        this.masterTrack,
      ),
    );
    this.root.append(head, this.emptyEl, this.groupsEl);
    host.append(this.root);
    this.colours = this.readColours();

    new ResizeObserver(() => this.layout()).observe(this.root);
  }

  // ---- public ---------------------------------------------------------------------------------

  /** Reconcile with a new document (cheap while hidden: the work waits until the tab shows). */
  update(doc: SyncDoc, _external: boolean): void {
    this.doc = doc;
    if (!this.visible) {
      this.dirty = true;
      return;
    }
    this.render(doc);
  }

  /** The tab was shown or hidden: animate only while it is visible. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      const doc = this.doc ?? this.deps.getDoc();
      if (doc && (this.dirty || this.builtKey === '')) this.render(doc);
      this.layout();
      this.start();
    } else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  /** Highlight a layer's group (the layer selected in the Layers tab or the preview). */
  setSelected(layerId: string | null): void {
    this.selectedLayer = layerId;
    for (const gu of this.groups) gu.root.classList.toggle('selected', gu.g.kind === 'layer' && gu.g.key === layerId);
  }

  // ---- building -------------------------------------------------------------------------------

  private track(key: string): TransportTrack {
    let t = this.tracks.get(key);
    if (!t) {
      t = new TransportTrack();
      this.tracks.set(key, t);
    }
    return t;
  }

  private readColours(): Colours {
    const css = getComputedStyle(this.root);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
      text: v('--text', '#e3e6ec'),
      muted: v('--muted', '#7e8695'),
      line: v('--line', '#252a34'),
      grid: 'rgba(255, 255, 255, 0.05)',
      card: v('--card', '#161920'),
      playhead: v('--tl-playhead', '#f3f5f9'),
      kinds: {
        keyframes: v('--tl-keys', '#8db4ff'),
        ramp: v('--tl-ramp', '#6fd6b0'),
        lfo: v('--tl-lfo', '#e8bb5e'),
        noise: v('--tl-noise', '#c79bff'),
      },
    };
  }

  /** Identity of everything that needs the DOM rebuilt (not key positions or values). */
  private structureKey(groups: readonly TimelineGroup[]): string {
    return groups
      .map((g) =>
        [
          g.key,
          g.name,
          g.position,
          g.enabled,
          g.own ? timelineSummary(g.settings) : '',
          g.layerType ?? '',
          g.lanes.map((l) => `${l.id}:${l.kind}:${l.enabled}`).join(','),
          g.free.map((d) => d.id).join(','),
        ].join('\u0001'),
      )
      .join('\u0002');
  }

  private render(doc: SyncDoc): void {
    this.dirty = false;
    const now = wallMs();
    const view = timelineView(doc, now);
    this.track('project').sync(doc.session.transport);
    this.masterRuler.settings = view.project.settings;
    const key = this.structureKey(view.groups);
    if (key !== this.builtKey) this.build(doc, view.groups, key);
    else this.refresh(doc, view.groups);
    this.masterMode.textContent = `${playbackTitle(view.project.settings.playback)}${view.project.settings.loop ? ' · loop' : ' · once'}`;
    this.masterLabelNote.textContent = formatClock(view.project.settings.duration);
    this.drawRuler(this.masterRuler, this.masterTrack.clientWidth);
    this.emptyEl.hidden = doc.project.layers.length > 0;
  }

  private build(doc: SyncDoc, groups: readonly TimelineGroup[], key: string): void {
    const hadFocus = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.param : undefined;
    this.drag = null;
    this.builtKey = key;
    this.groups = groups.map((g) => this.buildGroup(doc, g));
    this.lanesById.clear();
    for (const gu of this.groups) for (const lu of gu.lanes) this.lanesById.set(lu.lane.id, lu);
    this.groupsEl.replaceChildren(...this.groups.map((gu) => gu.root));
    // Forget transports of layers that no longer have their own timeline.
    const owned = new Set(groups.filter((g) => g.own).map((g) => g.key));
    for (const k of [...this.tracks.keys()]) if (k !== 'project' && !owned.has(k)) this.tracks.delete(k);
    this.setSelected(this.selectedLayer);
    this.layout();
    if (hadFocus) this.lanesById.get(hadFocus)?.canvas.focus({ preventScroll: true });
  }

  private buildGroup(doc: SyncDoc, g: TimelineGroup): GroupUi {
    const isLayer = g.kind === 'layer';
    const collapsed = this.collapsed.has(g.key);
    const root = h('section', { className: `tl-group${g.own ? ' own' : ''}${g.enabled ? '' : ' off'}${collapsed ? ' collapsed' : ''}` });
    const body = h('div', { className: 'tl-gbody' });
    const line = h('div', { className: 'tl-line' });
    const track = g.own ? this.track(g.key) : this.track('project');
    track.sync(g.transport);
    const gu: GroupUi = {
      g,
      root,
      body,
      line,
      lanes: [],
      ruler: null,
      clock: emptyClock(),
      track,
      posEl: null,
      playBtn: null,
      lastPos: '',
      lastLineX: -1,
      left: 0,
      width: 0,
    };

    // Header: collapse, number, name (selects the layer), which timeline drives it, add lane.
    const chevron = h('button', { type: 'button', className: 'tl-fold', title: collapsed ? 'Expand' : 'Collapse' }, icon('chevron'));
    chevron.setAttribute('aria-expanded', String(!collapsed));
    chevron.addEventListener('click', () => this.toggleGroup(gu, chevron));
    const name = h('button', { type: 'button', className: 'tl-gname', textContent: g.name });
    if (isLayer) {
      name.title = 'Select this layer';
      name.addEventListener('click', () => this.deps.select(g.key));
    } else {
      name.disabled = true;
    }
    const badge = h('span', { className: 'card-badge', textContent: isLayer ? String(g.position) : '' });
    if (!isLayer) badge.append(icon('camera'));
    const type = h('span', { className: 'tl-type', textContent: g.layerType && g.layerType !== 'instancer' ? LAYER_TYPE_TITLES[g.layerType] : '' });
    const tag = h('span', {
      className: `tl-tag${g.own ? ' own' : ''}`,
      textContent: g.own ? `own timeline · ${timelineSummary(g.settings)}` : 'follows project',
      title: g.own
        ? 'This layer’s ramps, keyframes and data playhead run on its own timeline (set in its card’s Timeline folder)'
        : 'This layer’s ramps, keyframes and data playhead run on the project timeline',
    });
    const headEl = h('header', { className: 'tl-ghead' }, chevron, badge, name, type, tag, h('span', { className: 'spacer' }));
    if (g.own) {
      const target = layerTimeline(g.key);
      gu.playBtn = iconButton('play', 'Play', () => this.playPause(target, track), 'tl-play small');
      gu.posEl = h('span', { className: 'tl-pos small' });
      headEl.append(gu.playBtn, iconButton('restart', 'Restart this layer’s timeline', () => this.seek(target, track, 'restart')), gu.posEl);
    }
    headEl.append(this.addLaneSelect(g));
    root.append(headEl, body);

    if (g.own) {
      const t = h('div', { className: 'tl-track tl-ruler' });
      const canvas = h('canvas');
      const head = h('div', { className: 'tl-head-mark' });
      t.append(canvas, head);
      t.title = 'Click or drag to move this layer’s playhead';
      gu.ruler = { canvas, ctx: context(canvas), head, target: layerTimeline(g.key), track, settings: g.settings, lastX: -1 };
      this.bindRuler(gu.ruler, t);
      body.append(h('div', { className: 'tl-row tl-subruler' }, h('div', { className: 'tl-label' }, h('span', { className: 'tl-sub', textContent: 'own timeline' })), t));
    }
    for (const lane of g.lanes) gu.lanes.push(this.buildLane(doc, gu, lane));
    if (g.lanes.length === 0) {
      body.append(h('p', { className: 'tl-none muted', textContent: 'Nothing animated. Use “Keyframe…” to animate one of its parameters.' }));
    }
    // The playhead line over the lanes (none for an empty group following the project).
    if (g.own || g.lanes.length > 0) body.append(line);
    return gu;
  }

  private addLaneSelect(g: TimelineGroup): HTMLSelectElement {
    const select = h('select', { className: 'tl-add', title: 'Animate another parameter: adds a key at the playhead with its current value' });
    select.setAttribute('aria-label', `Keyframe a parameter of ${g.name}`);
    select.append(h('option', { value: '', textContent: 'Keyframe…' }));
    for (const d of g.free) select.append(h('option', { value: d.id, textContent: d.label }));
    select.disabled = g.free.length === 0;
    select.addEventListener('change', () => {
      const id = select.value;
      select.value = '';
      if (id) this.keyAtPlayhead(id);
    });
    return select;
  }

  private buildLane(doc: SyncDoc, gu: GroupUi, lane: Lane): LaneUi {
    const wave = lane.kind === 'lfo' || lane.kind === 'noise';
    const canvas = h('canvas', { tabIndex: 0 });
    canvas.dataset.param = lane.id;
    canvas.setAttribute('aria-label', `${lane.def.label}: ${wave ? 'free-running' : 'drag keys, double-click to add one, Delete to remove the selected key'}`);
    const track = h('div', { className: 'tl-track' }, canvas);
    let dot: HTMLElement | null = null;
    if (wave) {
      track.append(h('span', { className: 'tl-free', textContent: `free-running · last ${formatValue(Math.round(lane.windowSec * 10) / 10)} s` }));
      canvas.title = `${lane.kind === 'lfo' ? 'LFO' : 'Noise'}: runs on the wall clock, not the timeline. Edit it in the Modulation folder.`;
    } else {
      dot = h('span', { className: 'tl-dot' });
      track.append(dot);
      canvas.title = 'Drag a key (Shift: one axis) · double-click to add a key · select one and press Delete to remove it';
    }
    const valueEl = h('span', { className: 'tl-value' });
    const infoEl = h('span', { className: 'tl-sub' });
    const chip = h('span', { className: `tl-kind ${lane.kind}`, textContent: `${KIND_CHIPS[lane.kind]}${lane.enabled ? '' : ' (off)'}` });
    const keyBtn = iconButton('key', wave ? 'LFO and noise do not run on the timeline' : 'Key at playhead', () => this.keyAtPlayhead(lane.id), 'tl-mini');
    keyBtn.disabled = wave;
    const removeBtn = iconButton('close', 'Remove this modulator', () => this.send(removeLaneOps(lane.id), 'Remove'), 'tl-mini danger');
    const label = h(
      'div',
      { className: 'tl-label' },
      h('div', { className: 'tl-lrow' }, h('span', { className: 'tl-name', textContent: lane.def.label, title: paramTitle(lane.def) }), chip),
      h('div', { className: 'tl-lrow' }, valueEl, infoEl, h('span', { className: 'spacer' }), keyBtn, removeBtn),
    );
    const row = h('div', { className: `tl-row tl-lane ${wave ? 'wave' : 'curve'}${lane.enabled ? '' : ' disabled'}` }, label, track);
    gu.body.append(row);
    const lu: LaneUi = {
      lane,
      group: gu,
      row,
      track,
      canvas,
      ctx: context(canvas),
      dot,
      valueEl,
      infoEl,
      lastValue: '',
      param: doc.project.parameters[lane.id],
      lastDotX: -1,
      lastDotY: -1,
    };
    this.setInfo(lu);
    if (!wave) this.bindLane(lu);
    return lu;
  }

  private toggleGroup(gu: GroupUi, chevron: HTMLButtonElement): void {
    const collapsed = !gu.root.classList.contains('collapsed');
    gu.root.classList.toggle('collapsed', collapsed);
    chevron.setAttribute('aria-expanded', String(!collapsed));
    chevron.title = collapsed ? 'Expand' : 'Collapse';
    if (collapsed) this.collapsed.add(gu.g.key);
    else this.collapsed.delete(gu.g.key);
    saveSetting(COLLAPSED_KEY, JSON.stringify([...this.collapsed]));
    if (!collapsed) this.layout();
  }

  /** New data, same structure: update each group's timeline and redraw lanes whose modulator or base changed. */
  private refresh(doc: SyncDoc, groups: readonly TimelineGroup[]): void {
    groups.forEach((g, i) => {
      const gu = this.groups[i];
      if (!gu) return;
      const settingsChanged = gu.g.settings !== g.settings;
      gu.g = g;
      gu.track.sync(g.transport);
      if (gu.ruler) {
        gu.ruler.settings = g.settings;
        if (settingsChanged) this.drawRuler(gu.ruler, gu.width);
      }
      g.lanes.forEach((lane, j) => {
        const lu = gu.lanes[j];
        if (!lu || this.drag?.lu === lu) return;
        const param = doc.project.parameters[lane.id];
        if (!settingsChanged && param === lu.param && lane.base === lu.lane.base) return;
        lu.param = param;
        lu.lane = lane;
        this.clampSelection(lu);
        this.setInfo(lu);
        if (lane.kind === 'ramp' || lane.kind === 'keyframes') this.drawCurve(lu);
      });
    });
  }

  // ---- layout ---------------------------------------------------------------------------------

  /** Measure the tracks and redraw every canvas at the new size. */
  private layout(): void {
    if (!this.visible) return;
    const w = this.masterTrack.clientWidth;
    this.trackWidth = w;
    if (w > 0) {
      sizeCanvas(this.masterRuler.canvas, this.masterRuler.ctx, w, RULER_H);
      this.drawRuler(this.masterRuler, w);
    }
    for (const gu of this.groups) {
      const first = gu.ruler?.canvas.parentElement ?? gu.lanes[0]?.track;
      if (!first || gu.root.classList.contains('collapsed')) continue;
      gu.left = first.offsetLeft;
      gu.width = first.clientWidth;
      if (gu.ruler) {
        sizeCanvas(gu.ruler.canvas, gu.ruler.ctx, gu.width, RULER_H);
        this.drawRuler(gu.ruler, gu.width);
      }
      for (const lu of gu.lanes) {
        sizeCanvas(lu.canvas, lu.ctx, gu.width, lu.lane.kind === 'lfo' || lu.lane.kind === 'noise' ? WAVE_H : CURVE_H);
        if (lu.lane.kind === 'ramp' || lu.lane.kind === 'keyframes') this.drawCurve(lu);
      }
      gu.lastLineX = -1;
      if (gu.ruler) gu.ruler.lastX = -1;
      for (const lu of gu.lanes) lu.lastDotX = -1;
    }
    this.masterRuler.lastX = -1;
  }

  // ---- drawing ----------------------------------------------------------------------------------

  private drawRuler(r: RulerUi, w: number): void {
    if (w <= 0) return;
    const { ctx } = r;
    const c = this.colours;
    const d = r.settings.duration;
    ctx.clearRect(0, 0, w, RULER_H);
    const inner = Math.max(w - PAD_X * 2, 1);
    const step = tickStep(d, inner);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    // Minor ticks between labelled ones, when there is room.
    const minor = step / 5;
    if ((minor / d) * inner >= 6) {
      ctx.strokeStyle = c.line;
      ctx.beginPath();
      for (let s = minor, i = 1; s < d - 1e-9; i++, s = minor * i) {
        const x = Math.round(xOf(s / d, w)) + 0.5;
        ctx.moveTo(x, RULER_H - 5);
        ctx.lineTo(x, RULER_H);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = c.muted;
    ctx.fillStyle = c.muted;
    ctx.beginPath();
    let lastLabelEnd = -Infinity;
    for (let i = 0; ; i++) {
      const s = Math.min(step * i, d);
      const x = Math.round(xOf(s / d, w)) + 0.5;
      ctx.moveTo(x, RULER_H - 10);
      ctx.lineTo(x, RULER_H);
      const text = formatTick(s, step, d);
      const tw = ctx.measureText(text).width;
      const tx = Math.min(Math.max(x - tw / 2, 0), w - tw);
      if (tx > lastLabelEnd + 6) {
        ctx.fillText(text, tx, 3);
        lastLabelEnd = tx + tw;
      }
      if (s >= d) break;
    }
    ctx.stroke();
    // Baseline.
    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(xOf(0, w), RULER_H - 0.5);
    ctx.lineTo(xOf(1, w), RULER_H - 0.5);
    ctx.stroke();
  }

  /** Faint vertical lines at the ruler's labelled ticks, so lanes read against it. */
  private drawGrid(ctx: CanvasRenderingContext2D, settings: TimelineSettings, w: number, hgt: number): void {
    const d = settings.duration;
    const step = tickStep(d, Math.max(w - PAD_X * 2, 1));
    ctx.strokeStyle = this.colours.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; step * i <= d + 1e-9; i++) {
      const x = Math.round(xOf((step * i) / d, w)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hgt);
    }
    const end = Math.round(xOf(1, w)) + 0.5;
    ctx.moveTo(end, 0);
    ctx.lineTo(end, hgt);
    ctx.stroke();
  }

  private drawCurve(lu: LaneUi): void {
    const lane = lu.lane;
    if (lane.kind !== 'ramp' && lane.kind !== 'keyframes') return;
    const w = lu.group.width;
    if (w <= 0) return;
    const hgt = CURVE_H;
    const { ctx } = lu;
    const colour = this.colours.kinds[lane.kind];
    ctx.clearRect(0, 0, w, hgt);
    this.drawGrid(ctx, lu.group.g.settings, w, hgt);
    // The UI range's top and bottom.
    ctx.strokeStyle = this.colours.grid;
    ctx.beginPath();
    ctx.moveTo(0, PAD_Y - 0.5);
    ctx.lineTo(w, PAD_Y - 0.5);
    ctx.moveTo(0, hgt - PAD_Y + 0.5);
    ctx.lineTo(w, hgt - PAD_Y + 0.5);
    ctx.stroke();

    const s = lane.samples;
    const n = s.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i / (n - 1), w);
      const y = yOf(s[i]!, hgt);
      if (i === 0) {
        ctx.moveTo(0, y);
        ctx.lineTo(x, y);
      } else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, yOf(s[n - 1]!, hgt));
    // Soft fill under the curve.
    ctx.save();
    ctx.lineTo(w, hgt);
    ctx.lineTo(0, hgt);
    ctx.closePath();
    ctx.globalAlpha = lane.enabled ? 0.12 : 0.05;
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i / (n - 1), w);
      const y = yOf(s[i]!, hgt);
      if (i === 0) {
        ctx.moveTo(0, y);
        ctx.lineTo(x, y);
      } else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, yOf(s[n - 1]!, hgt));
    ctx.strokeStyle = colour;
    ctx.globalAlpha = lane.enabled ? 1 : 0.5;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(lane.enabled ? [] : [4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Keys (diamonds) or ramp endpoints (circles).
    const sel = this.selection?.id === lane.id ? this.selection.index : -1;
    lane.keys.forEach((k, i) => {
      const x = xOf(k.at, w);
      const y = yOf(Math.min(Math.max(normalise(lane, k.value), 0), 1), hgt);
      const selected = i === sel;
      ctx.beginPath();
      if (lane.kind === 'ramp') ctx.arc(x, y, selected ? 5.5 : 4.5, 0, Math.PI * 2);
      else {
        const r = selected ? 6.5 : 5.5;
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
      }
      ctx.fillStyle = selected ? colour : this.colours.card;
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.strokeStyle = selected ? this.colours.text : colour;
      ctx.stroke();
    });
  }

  /** An LFO or noise lane: hatched (not on the timeline), its band, and a scope of the last few seconds. */
  private drawWave(lu: LaneUi, nowMs: number): void {
    const lane = lu.lane;
    const w = lu.group.width;
    if (w <= 0 || (lane.kind !== 'lfo' && lane.kind !== 'noise')) return;
    const hgt = WAVE_H;
    const { ctx } = lu;
    const colour = this.colours.kinds[lane.kind];
    ctx.clearRect(0, 0, w, hgt);
    // Base value.
    const yb = Math.round(yOf(normalise(lane, lane.base), hgt)) + 0.5;
    ctx.strokeStyle = this.colours.muted;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yb);
    ctx.lineTo(w, yb);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // The signal over the last windowSec, now at the right edge (phase is unused by LFO and noise).
    const pts = this.scope;
    const n = pts.length;
    const span = lane.windowSec * 1000;
    for (let i = 0; i < n; i++) pts[i] = normalise(lane, laneValue(lane, nowMs - span * (1 - i / (n - 1)), 0));
    const x0 = PAD_X;
    const x1 = w - PAD_X;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = x0 + ((x1 - x0) * i) / (n - 1);
      const y = yOf(pts[i]!, hgt);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = colour;
    ctx.globalAlpha = lane.enabled ? 0.9 : 0.4;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    const y = yOf(pts[n - 1]!, hgt);
    ctx.beginPath();
    ctx.arc(x1, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }

  // ---- per frame ------------------------------------------------------------------------------

  private start(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (!this.visible) return;
    this.raf = requestAnimationFrame(this.frame);
    const doc = this.doc;
    if (!doc) return;
    const now = wallMs();
    const readouts = now - this.lastReadoutMs >= READOUT_MS;
    if (readouts) this.lastReadoutMs = now;

    const project = this.track('project');
    const pt = project.local ?? doc.session.transport;
    const settings = this.masterRuler.settings;
    clockState(pt, settings, now, this.masterClock);
    this.moveHead(this.masterRuler, this.masterClock.playhead, this.trackWidth);
    if (readouts) {
      const pos = `${formatClock(this.masterClock.playhead * settings.duration, settings.duration)} / ${formatClock(settings.duration)}`;
      if (pos !== this.lastMasterPos) {
        this.lastMasterPos = pos;
        this.masterPos.textContent = pos;
      }
      this.setPlayButton(this.masterPlay, pt.playing);
    }

    for (const gu of this.groups) {
      if (gu.root.classList.contains('collapsed') || gu.width <= 0) continue;
      const clock = gu.g.own ? clockState(gu.track.local ?? gu.g.transport, gu.g.settings, now, gu.clock) : this.masterClock;
      const phase = clock.playhead;
      const x = Math.round((gu.left + xOf(phase, gu.width)) * 2) / 2;
      if (x !== gu.lastLineX) {
        gu.lastLineX = x;
        gu.line.style.transform = `translateX(${x}px)`;
      }
      if (gu.ruler) this.moveHead(gu.ruler, phase, gu.width);
      if (readouts && gu.posEl && gu.playBtn) {
        const d = gu.g.settings.duration;
        const pos = `${formatClock(phase * d, d)} / ${formatClock(d)}`;
        if (pos !== gu.lastPos) {
          gu.lastPos = pos;
          gu.posEl.textContent = pos;
        }
        this.setPlayButton(gu.playBtn, (gu.track.local ?? gu.g.transport).playing);
      }
      for (const lu of gu.lanes) {
        const lane = lu.lane;
        if (lane.kind === 'lfo' || lane.kind === 'noise') this.drawWave(lu, now);
        const v = laneValue(lane, now, phase);
        if (lu.dot) {
          const dx = Math.round(xOf(phase, gu.width) * 2) / 2;
          const dy = Math.round(yOf(Math.min(Math.max(normalise(lane, v), 0), 1), CURVE_H) * 2) / 2;
          if (dx !== lu.lastDotX || dy !== lu.lastDotY) {
            lu.lastDotX = dx;
            lu.lastDotY = dy;
            lu.dot.style.transform = `translate(${dx}px, ${dy}px)`;
          }
        }
        if (readouts) {
          const text = formatValue(v);
          if (text !== lu.lastValue) {
            lu.lastValue = text;
            lu.valueEl.textContent = text;
          }
        }
      }
    }
  };

  private moveHead(r: RulerUi, phase: number, w: number): void {
    if (w <= 0) return;
    const x = Math.round(xOf(phase, w) * 2) / 2;
    if (x === r.lastX) return;
    r.lastX = x;
    r.head.style.transform = `translateX(${x}px)`;
  }

  private setPlayButton(b: HTMLButtonElement, playing: boolean): void {
    const want = playing ? 'Pause' : 'Play';
    if (b.title === want) return;
    b.title = want;
    b.setAttribute('aria-label', want);
    b.replaceChildren(icon(playing ? 'pause' : 'play'));
    b.classList.toggle('playing', playing);
  }

  // ---- transport ------------------------------------------------------------------------------

  private playPause(target: TimelineTarget, track: TransportTrack): void {
    const doc = this.deps.getDoc();
    const current = track.local ?? (doc ? target.transport(doc) : null);
    const edit = doc && current ? playPauseEdit(doc, target, current, wallMs()) : null;
    if (!edit) return;
    track.local = edit.next;
    this.deps.sendPatch(edit.ops);
  }

  private seek(target: TimelineTarget, track: TransportTrack, phase: number | 'restart', send = true): void {
    const doc = this.deps.getDoc();
    const current = track.local ?? (doc ? target.transport(doc) : null);
    const edit = doc && current ? seekEdit(doc, target, current, phase, wallMs()) : null;
    if (!edit) return;
    track.local = edit.next;
    if (send) this.deps.sendPatch(edit.ops);
  }

  /** Click or drag on a ruler to scrub: the playhead follows the pointer; seeks are throttled, the last always sent. */
  private bindRuler(r: RulerUi, el: HTMLElement): void {
    const phaseAt = (ev: PointerEvent) => phaseOf(ev.clientX - el.getBoundingClientRect().left, el.clientWidth);
    const scrub = (ev: PointerEvent, final: boolean) => {
      const now = wallMs();
      const send = final || now - r.track.lastSendMs >= SCRUB_INTERVAL_MS;
      if (send) r.track.lastSendMs = now;
      this.seek(r.target, r.track, phaseAt(ev), send);
    };
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      r.track.scrubbing = true;
      el.classList.add('scrubbing');
      scrub(ev, true);
    });
    el.addEventListener('pointermove', (ev) => {
      if (r.track.scrubbing && el.hasPointerCapture(ev.pointerId)) scrub(ev, false);
    });
    const end = (ev: PointerEvent) => {
      if (!r.track.scrubbing) return;
      scrub(ev, true);
      r.track.scrubbing = false;
      el.classList.remove('scrubbing');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => {
      r.track.scrubbing = false;
      el.classList.remove('scrubbing');
    });
  }

  // ---- editing --------------------------------------------------------------------------------

  /**
   * The document to edit: the synced one, or our last edit applied to it while its echo is
   * on the way (so two quick edits don't send the second without the first).
   */
  private editDoc(): SyncDoc | null {
    const doc = this.deps.getDoc();
    const o = this.optimistic;
    if (o && doc === o.base) return o.doc;
    this.optimistic = null;
    return doc;
  }

  /** Validate ops against the project schema, then send. Returns the patched doc, or null if refused. */
  private send(ops: PatchOp[], what: string): SyncDoc | null {
    const doc = this.editDoc();
    const synced = this.deps.getDoc();
    if (!doc || !synced || ops.length === 0) return null;
    let next: SyncDoc;
    try {
      next = applyOps(doc, ops);
      const r = ProjectSchema.safeParse(next.project);
      if (!r.success) {
        const issue = r.error.issues[0];
        this.deps.showError(`${what} not sent (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid value'}).`);
        return null;
      }
    } catch (err) {
      this.deps.showError(`${what} not sent (${String(err)}).`);
      return null;
    }
    this.deps.sendPatch(ops);
    this.optimistic = { base: synced, doc: next };
    return next;
  }

  /** Send ops, show their result straight away (the echo then changes nothing) and select a key. */
  private commit(ops: PatchOp[], what: string, select: Selection | null): void {
    if (select) this.selection = select;
    if (ops.length === 0) {
      const lu = select ? this.lanesById.get(select.id) : undefined;
      if (lu) {
        this.setInfo(lu);
        this.drawCurve(lu);
      }
      return;
    }
    const next = this.send(ops, what);
    if (next) {
      this.doc = next;
      this.render(next);
    }
    if (select) this.lanesById.get(select.id)?.canvas.focus({ preventScroll: true });
  }

  private keyAtPlayhead(id: string): void {
    const doc = this.editDoc();
    if (!doc) return;
    const edit = keyAtPlayheadOps(doc, id, wallMs());
    if (!edit) {
      this.deps.showError('No key added (the modulator is an LFO or noise, or already has 64 keys).');
      return;
    }
    this.commit(edit.ops, 'Key', { id, index: edit.index });
  }

  private clampSelection(lu: LaneUi): void {
    const s = this.selection;
    if (!s || s.id !== lu.lane.id) return;
    const keys = lu.lane.kind === 'ramp' || lu.lane.kind === 'keyframes' ? lu.lane.keys : [];
    if (s.index >= keys.length) this.selection = null;
  }

  /** The label's second line: the selected key (time and value), else the value range or the wave. */
  private setInfo(lu: LaneUi): void {
    const lane = lu.lane;
    const s = this.selection;
    if (!isCurve(lane)) {
      lu.infoEl.textContent = lane.summary.replace(/^(LFO|Noise) · /, '');
      return;
    }
    const key = s?.id === lane.id ? lane.keys[s.index] : undefined;
    if (key) {
      const what = lane.kind === 'ramp' ? (s!.index === 0 ? 'from' : 'to') : `key ${s!.index + 1}`;
      lu.infoEl.textContent = `${what} · ${keyTime(key.at, lu.group.g.settings.duration)} · ${formatValue(key.value)}`;
      lu.infoEl.classList.add('selected');
    } else {
      lu.infoEl.textContent = `${formatValue(lane.lo)} – ${formatValue(lane.hi)}`;
      lu.infoEl.classList.remove('selected');
    }
  }

  private hitKey(lu: LaneUi, x: number, y: number): number {
    const lane = lu.lane;
    if (lane.kind !== 'ramp' && lane.kind !== 'keyframes') return -1;
    let best = -1;
    let bestD = HIT_PX * HIT_PX;
    lane.keys.forEach((k, i) => {
      const dx = xOf(k.at, lu.group.width) - x;
      const dy = yOf(Math.min(Math.max(normalise(lane, k.value), 0), 1), CURVE_H) - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private select(lu: LaneUi, index: number | null): void {
    const prev = this.selection ? this.lanesById.get(this.selection.id) : undefined;
    this.selection = index === null ? null : { id: lu.lane.id, index };
    if (prev && prev !== lu) {
      this.setInfo(prev);
      this.drawCurve(prev);
    }
    this.setInfo(lu);
    this.drawCurve(lu);
  }

  private bindLane(lu: LaneUi): void {
    const c = lu.canvas;
    const local = (ev: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    c.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const { x, y } = local(ev);
      const i = this.hitKey(lu, x, y);
      c.focus({ preventScroll: true });
      if (i < 0) {
        this.select(lu, null);
        return;
      }
      ev.preventDefault();
      this.select(lu, i);
      const doc = this.editDoc();
      const lane = lu.lane;
      const key = lane.kind === 'ramp' || lane.kind === 'keyframes' ? lane.keys[i] : undefined;
      if (!doc || !key) return;
      c.setPointerCapture(ev.pointerId);
      this.drag = {
        lu,
        id: lane.id,
        start: doc,
        index: i,
        startAt: key.at,
        startValue: key.value,
        x0: x,
        y0: y,
        lo: lane.lo,
        hi: lane.hi,
        axis: null,
        last: { at: key.at, value: key.value },
        pending: null,
        lastSendMs: 0,
      };
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (ev) => {
      const { x, y } = local(ev);
      const d = this.drag;
      if (!d || d.lu !== lu || !c.hasPointerCapture(ev.pointerId)) {
        c.style.cursor = this.hitKey(lu, x, y) >= 0 ? 'grab' : 'crosshair';
        return;
      }
      this.dragTo(d, x, y, ev.shiftKey);
    });
    const end = (ev: PointerEvent) => {
      const d = this.drag;
      if (!d || d.lu !== lu) return;
      if (ev.type === 'pointerup') this.dragTo(d, local(ev).x, local(ev).y, ev.shiftKey);
      this.drag = null;
      c.classList.remove('dragging');
      // Always send where the key was let go.
      if (d.pending) this.flush(d);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (ev) => {
      const { x, y } = local(ev);
      if (this.hitKey(lu, x, y) >= 0) return;
      const doc = this.editDoc();
      const edit = doc ? addKeyOps(doc.project, lu.lane.id, phaseOf(x, lu.group.width)) : null;
      if (!edit) {
        this.deps.showError('No key added (64 keys is the most a lane can have).');
        return;
      }
      this.commit(edit.ops, 'New key', { id: lu.lane.id, index: edit.index });
    });
    c.addEventListener('keydown', (ev) => this.onLaneKey(lu, ev));
  }

  /** Move the dragged key to the pointer (Shift: along one axis), locally at once, sent at most every 50 ms. */
  private dragTo(d: Drag, x: number, y: number, shift: boolean): void {
    const w = d.lu.group.width;
    if (shift && d.axis === null && Math.hypot(x - d.x0, y - d.y0) >= AXIS_PX) d.axis = Math.abs(x - d.x0) >= Math.abs(y - d.y0) ? 'x' : 'y';
    if (!shift) d.axis = null;
    const lane = d.lu.lane;
    const at = lane.kind === 'ramp' || d.axis === 'y' ? d.startAt : phaseOf(xOf(d.startAt, w) + (x - d.x0), w);
    const n = Math.min(Math.max(nOf(yOf(normalise(d, d.startValue), CURVE_H) + (y - d.y0), CURVE_H), 0), 1);
    const value = d.axis === 'x' ? d.startValue : denormalise(d, n);
    if (at === d.last.at && value === d.last.value) return;
    d.last = { at, value };
    let ops: PatchOp[] | null;
    let index = d.index;
    if (lane.kind === 'ramp') ops = moveRampOps(d.start.project, d.id, d.index === 0 ? 'from' : 'to', value);
    else {
      const edit = moveKeyOps(d.start.project, d.id, d.index, at, value);
      ops = edit?.ops ?? null;
      if (edit) index = edit.index;
    }
    if (!ops) return;
    this.showLocal(d.lu, ops, index, d);
    d.pending = ops;
    const now = wallMs();
    if (now - d.lastSendMs >= SCRUB_INTERVAL_MS) this.flush(d);
  }

  private flush(d: Drag): void {
    const ops = d.pending;
    if (!ops) return;
    d.pending = null;
    d.lastSendMs = wallMs();
    if (!this.send(ops, 'Key change')) {
      // Refused: stop the drag and show the synced state again.
      this.drag = null;
      d.lu.canvas.classList.remove('dragging');
      const doc = this.deps.getDoc();
      if (doc) this.render(doc);
    }
  }

  /** Redraw a lane from the modulator in `ops` without waiting for the echo. */
  private showLocal(lu: LaneUi, ops: PatchOp[], index: number, frame: { lo: number; hi: number } | null): void {
    const op = ops[0];
    const value = op?.op === 'set' ? (op.value as Parameter | undefined) : undefined;
    if (!value) return;
    const lane = buildLane(lu.lane.def, value.modulator, lu.lane.base, wallMs(), lu.group.clock.playhead);
    if (lane.kind !== 'ramp' && lane.kind !== 'keyframes') return;
    if (frame) reframeLane(lane, frame.lo, frame.hi);
    lu.lane = lane;
    this.selection = { id: lane.id, index };
    this.setInfo(lu);
    this.drawCurve(lu);
  }

  /** Delete/Backspace removes the selected key; arrows nudge it (Shift: 10x); Escape deselects. */
  private onLaneKey(lu: LaneUi, ev: KeyboardEvent): void {
    const s = this.selection;
    const lane = lu.lane;
    if (!s || s.id !== lane.id || (lane.kind !== 'ramp' && lane.kind !== 'keyframes')) return;
    const doc = this.editDoc();
    const key = lane.keys[s.index];
    if (!doc || !key) return;
    if (ev.key === 'Escape') {
      this.select(lu, null);
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      if (lane.kind === 'ramp') return;
      const ops = deleteKeyOps(doc.project, lane.id, s.index);
      if (!ops) {
        this.deps.showError('A keyframes lane needs at least one key (remove the modulator instead).');
        return;
      }
      this.commit(ops, 'Delete key', null);
      this.selection = null;
      return;
    }
    const big = ev.shiftKey ? 10 : 1;
    let at = key.at;
    let value = key.value;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') at += (ev.key === 'ArrowLeft' ? -0.01 : 0.01) * big;
    else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const step = lane.def.integer ? 1 : (lane.hi - lane.lo) / 100;
      value += (ev.key === 'ArrowDown' ? -step : step) * big;
    } else return;
    ev.preventDefault();
    if (lane.kind === 'ramp') {
      const ops = moveRampOps(doc.project, lane.id, s.index === 0 ? 'from' : 'to', value);
      if (ops) this.commit(ops, 'Ramp change', s);
    } else {
      const edit = moveKeyOps(doc.project, lane.id, s.index, at, value);
      if (edit) this.commit(edit.ops, 'Key change', { id: lane.id, index: edit.index });
    }
  }
}
