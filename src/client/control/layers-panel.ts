import { Pane, type FolderApi } from 'tweakpane';
import { lineChartPreset } from '../../shared/chart-presets.ts';
import { defaultLayerOfType, fitAnyLayer, type DatasetSummary } from '../../shared/layer-defaults.ts';
import { datasetSwitchChanges, diffChanges, instanceCount, LAYER_TYPE_TITLES, type LayerChange } from '../../shared/layer-helpers.ts';
import { LAYER_TYPES, LayerSchema, MAX_FILTERS, type LayerConfig, type LayerType, type RowFilter } from '../../shared/layer-schema.ts';
import { randomiseLayer, seededRng, type RandomScope } from '../../shared/layer-random.ts';
import { layerParamCopyOps, layerParamRemovalOps } from '../../shared/modulation-helpers.ts';
import { wallMs } from '../../shared/modulators.ts';
import { layerParamPrefix } from '../../shared/parameters.ts';
import { applyOps, type Path, type PatchOp } from '../../shared/patch.ts';
import type { Dataset, SyncDoc } from '../../shared/project-schema.ts';
import { ChoiceMenu, type Choice } from './choice-menu.ts';
import { buildDensity } from './density-folders.ts';
import { buildHeatmap } from './heatmap-folders.ts';
import { buildHierarchy } from './hierarchy-folders.ts';
import { buildInstancer } from './instancer-folders.ts';
import type { Entry, Labelled, LayerUi } from './layer-ui.ts';
import { AnimatePanel } from './animate-panel.ts';
import { ModulationPanel } from './modulation-panel.ts';
import { layerTimeline, ownTimelineOps, TimelinePanel } from './timeline-panel.ts';
import { buildLine } from './line-folders.ts';
import { buildMultiples } from './multiples-folders.ts';
import { buildSurface } from './surface-folders.ts';
import { buildQr } from './qr-folders.ts';
import { buildReflector } from './reflector-folders.ts';
import { buildText } from './text-folders.ts';
import { h, iconButton } from './ui.ts';

/**
 * "Layers" tab of the control window, in two columns:
 * - left (narrow): Add layer, then one compact row per layer in stack order (number, title,
 *   move up/down, duplicate, delete). A row is a button that opens the layer.
 * - right: the open layer's settings in one Tweakpane pane, editing the layer config through
 *   minimal `set` patches.
 * Under about 720 px the list sits above the settings.
 *
 * The GUI never holds authoritative state: every edit is sent to the server and the pane is
 * rebuilt from the synced document when the layer changes structurally or someone else edits
 * it. The per-type folders are built in instancer-folders.ts, line-folders.ts,
 * heatmap-folders.ts, text-folders.ts, multiples-folders.ts, hierarchy-folders.ts,
 * surface-folders.ts, reflector-folders.ts and qr-folders.ts.
 *
 * Only the open layer has a pane (so `entries` holds at most one layer); the other rows are
 * plain DOM, retitled as their layers change. Opening a layer selects it (for the preview's
 * transform gizmo), and selecting one elsewhere (the preview, the Timeline tab) opens it.
 * With nothing selected, the layer last open stays open (the first layer to begin with).
 */

export interface LayersPanelDeps {
  sendPatch(ops: PatchOp[]): void;
  /** The current synced document, read at send time so layer indices are never stale. */
  getDoc(): SyncDoc | null;
  /**
   * Parsed column summary of a dataset, or null while it is still loading. With a row filter,
   * the summary of the rows it keeps (null when none). Stable per dataset and filter.
   */
  summary(datasetId: string, filter?: readonly RowFilter[]): DatasetSummary | null;
  showError(message: string): void;
  /** The user selected a layer in the panel. */
  select(layerId: string): void;
}

/** Add-layer menu entry for a line layer preset (see the type menu). */
const LINE_CHART = 'line-chart';
type AddChoice = LayerType | typeof LINE_CHART;

/** What each layer type draws, in one sentence, under its name in the add-layer menu. */
const TYPE_DESCRIPTIONS: Record<LayerType, string> = {
  instancer: 'One shape per row (point, square, bar, box or sphere), placed, sized and coloured by columns.',
  line: 'A line through the rows, one point per row, with optional fill for ridgelines.',
  heatmap: 'Cells coloured by value, as a grid or a year × day-of-year calendar.',
  text: 'Titles, captions and live values or credits from the data.',
  multiples: 'A grid of small charts, one per year, month, decade, category or block of rows.',
  hierarchy: 'Rows grouped by time or category into a dendrogram, tree, sunburst or treemap.',
  surface: 'A 3D terrain whose height and colour come from the values.',
  reflector: 'A mirror floor or wall that reflects the other layers; needs no data.',
  qr: "A scannable code for a link, such as the dataset's source; needs no data.",
  density: 'Every row counted into a smoothed grid by two columns, so huge scatters read as a field.',
};

const ADD_CHOICES: readonly Choice<AddChoice>[] = LAYER_TYPES.flatMap((t): Choice<AddChoice>[] => {
  const choice = { value: t, label: LAYER_TYPE_TITLES[t], description: TYPE_DESCRIPTIONS[t] };
  // A line layer preset after the plain line: monthly means (or means of 30 rows without a
  // time column), which reads as a line chart rather than a spike per row.
  return t !== 'line' ? [choice] : [choice, { value: LINE_CHART, label: 'line chart (aggregated)', description: 'Monthly means (or every 30 rows) with an x axis, a value axis and gridlines.' }];
});

/** Appended to the label of a field whose parameter has a modulator. */
const MODULATED_SUFFIX = ' ~';

/** Randomises of a layer that Back can step through. */
const RANDOM_HISTORY = 10;

/** One layer's row in the list. */
interface Row {
  root: HTMLElement;
  /** The row's main button: opens the layer (focusable, Up/Down move between rows). */
  open: HTMLButtonElement;
  badge: HTMLElement;
  title: HTMLElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  /** The layer config the row was last labelled from. */
  layer: LayerConfig | null;
}

function randomId(): string {
  return `ly-${Math.random().toString(36).slice(2, 10)}`;
}

/** Edits to these need the folder rebuilt even for our own echo (fields shown or hidden). */
function shapeKey(layer: LayerConfig): string {
  switch (layer.type) {
    case 'instancer':
      // The primitive too: the Edges folder is for boxes only. Whether height or y is mapped
      // decides the Axes & values notes.
      return `instancer:${layer.arrangement}:${layer.primitive}:${layer.channels.height.column !== null}:${layer.channels.y.column !== null}`;
    case 'heatmap':
      return `heatmap:${layer.layout}`;
    case 'surface':
      return `surface:${layer.layout}`;
    case 'multiples':
      return `multiples:${layer.splitBy}`;
    case 'hierarchy':
      // Adding, removing or re-kinding a level changes which fields each level shows.
      return `hierarchy:${layer.levels.map((l) => l.kind).join(',')}`;
    case 'qr':
      // The text box or the dataset's link.
      return `qr:${layer.content}`;
    case 'density':
      // Dots mode shows its own fields; a z column shows bins deep.
      return `density:${layer.mode}:${layer.zColumn !== null}`;
    case 'line':
      // A split lists a colour per value; a band shows its own fill fields.
      return `line:${layer.split.column}:${layer.fill.mode}:${layer.aggregate.by}:${layer.y.column !== null}`;
    default:
      return layer.type;
  }
}

/** True when `next` differs from `prev` in its transform only (patches share the rest). */
function onlyTransformChanged(prev: LayerConfig, next: LayerConfig): boolean {
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  return keys.every((k) => k === 'transform' || a[k] === b[k]);
}

function titleOf(layer: LayerConfig): string {
  return `${layer.name || '(unnamed)'}${layer.type === 'instancer' ? '' : ` · ${LAYER_TYPE_TITLES[layer.type]}`}${layer.enabled ? '' : ' (off)'}`;
}

export class LayersPanel {
  /** The open layer's pane (at most one entry). */
  private entries = new Map<string, Entry>();
  private rows = new Map<string, Row>();
  private list = h('div', { className: 'layer-list', role: 'list' });
  private countNote = h('div', { className: 'sub-head layer-list-head' });
  private typeMenu = new ChoiceMenu<AddChoice>(ADD_CHOICES, 'instancer', 'Type of the new layer', (type) => (this.addModel.type = type));
  /** The open layer's settings: a card whose body holds the pane. */
  private settings = h('section', { className: 'card layer-card layer-settings' });
  private settingsBadge = h('span', { className: 'card-badge' });
  private settingsTitle = h('h3', { className: 'card-title' });
  private settingsBody = h('div', { className: 'card-body' });
  private settingsCol = h('div', { className: 'layers-settings-col' });
  private empty = h('div', { className: 'card empty-card' });
  private split = h('div', { className: 'layers-split' });
  private order: string[] = [];
  private datasets: readonly Dataset[] | null = null;
  /** Expanded state of every folder, by key (`<layer id>/<folder>`), kept while a layer is closed. */
  private expanded = new Map<string, boolean>();
  /** Expanded state inside the layers' Modulation folders (keys start with the parameter prefix). */
  private modulationExpanded = new Map<string, boolean>();
  /** Non-zero while the panel itself writes into bindings; change events are ignored then. */
  private quietDepth = 0;
  /** The modulators the field labels were last marked from. */
  private parameters: SyncDoc['project']['parameters'] | null = null;
  private addModel: { type: AddChoice } = { type: 'instancer' };
  private selected: string | null = null;
  /** The open layer (shown on the right), or null with no layers. */
  private shown: string | null = null;
  /** Stack position of the open layer, so a deleted one is followed by its neighbour. */
  private shownIndex = 0;
  /** A layer we just added or duplicated, to open once it arrives. */
  private pendingSelect: string | null = null;
  /** Each layer's configs from before its last randomises (newest last), for Back. Kept in this window only. */
  private randomHistory = new Map<string, LayerConfig[]>();

  constructor(zone: HTMLElement, private deps: LayersPanelDeps) {
    const add = h('button', { type: 'button', className: 'btn primary', textContent: 'Add layer' });
    add.addEventListener('click', () => this.addLayer());
    this.list.setAttribute('aria-label', 'Layers in stack order');
    this.empty.append(
      h('p', { className: 'muted', textContent: 'No layers yet. Import a dataset (Datasets tab), then choose a layer type and press Add layer.' }),
    );
    this.settings.append(h('header', { className: 'card-head' }, this.settingsBadge, this.settingsTitle), this.settingsBody);
    this.settings.setAttribute('aria-label', 'Layer settings');
    // Pointing anywhere in the settings, or tabbing into them, selects the open layer (the
    // pane is never rebuilt by this: the open layer stays the same).
    const select = () => {
      if (this.shown !== null && this.selected !== this.shown) this.deps.select(this.shown);
    };
    this.settings.addEventListener('pointerdown', select);
    this.settings.addEventListener('focusin', select);
    this.settings.hidden = true;
    this.settingsCol.append(this.empty, this.settings);
    const addRow = h('div', { className: 'layer-add' }, this.typeMenu.el, add);
    addRow.setAttribute('role', 'group');
    addRow.setAttribute('aria-label', 'Add layer');
    this.split.append(
      h('div', { className: 'layers-list-col' }, h('div', { className: 'sub-head', textContent: 'Add layer' }), addRow, this.countNote, this.list),
      this.settingsCol,
    );
    zone.append(this.split);
  }

  // ---- the list ------------------------------------------------------------------------

  private makeRow(id: string): Row {
    const badge = h('span', { className: 'card-badge' });
    const title = h('span', { className: 'card-title' });
    const open = h('button', { type: 'button', className: 'card-toggle layer-row-open' }, badge, title);
    open.addEventListener('keydown', (ev) => this.rowKey(ev, id));
    const up = iconButton('up', 'Move up (drawn earlier)', () => this.move(id, -1));
    const down = iconButton('down', 'Move down (drawn later)', () => this.move(id, 1));
    const actions = h('div', { className: 'card-actions' }, up, down, iconButton('copy', 'Duplicate', () => this.duplicate(id)), iconButton('trash', 'Delete…', () => this.remove(id), 'danger'));
    const root = h('div', { className: 'layer-row', role: 'listitem' }, open, actions);
    // A click anywhere on the row but its icon buttons (which stop it) opens the layer.
    root.addEventListener('click', () => {
      this.deps.select(id);
      // Stacked (narrow zone), the settings are under the list: bring their top into view.
      if (getComputedStyle(this.split).display === 'block') {
        const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.settings.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
      }
    });
    return { root, open, badge, title, up, down, layer: null };
  }

  /** Up/Down (and Home/End) move between rows; Enter/Space open one (it is a button). */
  private rowKey(ev: KeyboardEvent, id: string): void {
    const i = this.order.indexOf(id);
    let j: number;
    if (ev.key === 'ArrowUp') j = i - 1;
    else if (ev.key === 'ArrowDown') j = i + 1;
    else if (ev.key === 'Home') j = 0;
    else if (ev.key === 'End') j = this.order.length - 1;
    else return;
    ev.preventDefault();
    const next = this.rows.get(this.order[j] ?? '');
    next?.open.focus();
  }

  private labelRow(row: Row, layer: LayerConfig): void {
    row.layer = layer;
    this.retitleRow(row, titleOf(layer));
    row.root.dataset.type = layer.type;
  }

  private retitleRow(row: Row, title: string): void {
    row.title.textContent = title;
    // The full title as a tooltip, as the narrow column may cut it short.
    row.open.title = title;
    row.root.classList.toggle('off', title.endsWith('(off)'));
  }

  /** Bring the rows into line with the layer list (new, removed and moved layers). */
  private syncRows(layers: readonly LayerConfig[]): void {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.list.contains(active) ? active : null;
    const focusedAt = focused ? [...this.list.children].findIndex((el) => el.contains(focused)) : -1;
    const ids = new Set(layers.map((l) => l.id));
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      row.root.remove();
      this.rows.delete(id);
    }
    const want = layers.map((layer, i) => {
      let row = this.rows.get(layer.id);
      if (!row) {
        row = this.makeRow(layer.id);
        this.rows.set(layer.id, row);
      }
      if (row.layer !== layer) this.labelRow(row, layer);
      row.badge.textContent = String(i + 1);
      row.up.disabled = i <= 0;
      row.down.disabled = i >= layers.length - 1;
      return row.root;
    });
    const same = want.length === this.list.childElementCount && want.every((el, i) => this.list.children[i] === el);
    if (!same) this.list.replaceChildren(...want);
    // Moving a row drops keyboard focus: put it back (on the row itself if its button is now
    // disabled). After a delete, focus goes to the row that took the deleted one's place.
    if (focused && document.activeElement !== focused) {
      if (focused.isConnected) {
        const row = [...this.rows.values()].find((r) => r.root.contains(focused));
        (focused instanceof HTMLButtonElement && focused.disabled ? row?.open : focused)?.focus({ preventScroll: true });
      } else if (focusedAt >= 0) {
        this.rows.get(layers[Math.min(focusedAt, layers.length - 1)]?.id ?? '')?.open.focus({ preventScroll: true });
      }
    }
    this.countNote.textContent = layers.length === 0 ? '' : `${layers.length} layer${layers.length === 1 ? '' : 's'}`;
    this.countNote.hidden = layers.length === 0;
  }

  /** Highlight the open layer's row (and mark it selected when it is also the gizmo's layer). */
  private markRows(): void {
    for (const [id, row] of this.rows) {
      const open = id === this.shown;
      row.root.classList.toggle('open', open);
      row.root.classList.toggle('selected', open && id === this.selected);
      if (open) row.open.setAttribute('aria-current', 'true');
      else row.open.removeAttribute('aria-current');
    }
  }

  // ---- selection -----------------------------------------------------------------------

  /**
   * Select `id` (null clears) and open it on the right; with nothing selected, the open layer
   * stays open. With `reveal` (a selection made in the preview), also scroll its row into view.
   */
  setSelected(id: string | null, reveal = false): void {
    this.selected = id;
    const doc = this.deps.getDoc();
    if (doc) this.showLayer(doc);
    this.markRows();
    const row = id === null ? undefined : this.rows.get(id);
    if (row && reveal) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.root.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  /** The layer to show: the selected one, else the one already open, else its stack neighbour. */
  private pickShown(layers: readonly LayerConfig[]): string | null {
    if (this.selected !== null && layers.some((l) => l.id === this.selected)) return this.selected;
    if (this.shown !== null && layers.some((l) => l.id === this.shown)) return this.shown;
    return layers[Math.min(this.shownIndex, layers.length - 1)]?.id ?? null;
  }

  /** Open the layer `pickShown` names, building its pane if it isn't the open one. True if built. */
  private showLayer(doc: SyncDoc): boolean {
    const layers = doc.project.layers;
    const id = this.pickShown(layers);
    const at = layers.findIndex((l) => l.id === id);
    if (at >= 0) this.shownIndex = at;
    const open = this.entries.keys().next().value ?? null;
    const changed = id !== this.shown;
    this.shown = id;
    this.empty.hidden = layers.length > 0;
    this.settings.hidden = id === null;
    if (open === id) return false;
    if (open !== null) {
      const entry = this.entries.get(open);
      if (entry) this.disposeEntry(open, entry);
    }
    this.settingsBody.replaceChildren();
    const layer = layers[at];
    if (!layer) return false;
    this.settingsBody.append(this.build(doc, layer));
    this.settingsHead(layer, at);
    // A different layer starts at the top of its settings.
    if (changed) this.settingsCol.scrollTop = 0;
    return true;
  }

  private settingsHead(layer: LayerConfig, position: number): void {
    this.settingsBadge.textContent = String(position + 1);
    this.retitleSettings(titleOf(layer));
    this.settings.dataset.type = layer.type;
  }

  private retitleSettings(title: string): void {
    this.settingsTitle.textContent = title;
    this.settings.setAttribute('aria-label', `${title}: settings`);
    this.settings.classList.toggle('off', title.endsWith('(off)'));
  }

  // ---- reconciling with the synced document ------------------------------------------

  /**
   * Reconcile with a new document. `external` is true for full snapshots and for patches
   * from other clients; our own echoes only rebuild for structural or layout-changing edits,
   * so a slider drag is never interrupted. Transform changes (gizmo drags, Reset) refresh
   * just the Transform fields.
   */
  update(doc: SyncDoc, external: boolean): void {
    const layers = doc.project.layers;
    const structural =
      layers.length !== this.order.length || layers.some((l, i) => l.id !== this.order[i]) || doc.project.datasets !== this.datasets;
    let arrived: string | null = null;
    if (structural) {
      // New datasets change every layer's column lists: the open pane is rebuilt.
      if (doc.project.datasets !== this.datasets) this.closeSettings();
      this.order = layers.map((l) => l.id);
      this.datasets = doc.project.datasets;
      const ids = new Set(this.order);
      for (const key of [...this.expanded.keys()]) if (!ids.has(key.slice(0, key.indexOf('/')))) this.expanded.delete(key);
      this.syncRows(layers);
      if (this.pendingSelect !== null && ids.has(this.pendingSelect)) {
        // Open the new layer here, so selecting it below finds it already open.
        arrived = this.selected = this.pendingSelect;
        this.pendingSelect = null;
      }
    } else {
      layers.forEach((layer) => {
        const row = this.rows.get(layer.id);
        if (row && row.layer !== layer) this.labelRow(row, layer);
      });
    }
    const built = this.showLayer(doc);
    this.markRows();
    if (arrived !== null) this.deps.select(arrived);
    const at = layers.findIndex((l) => l.id === this.shown);
    const layer = layers[at];
    const entry = this.shown === null ? undefined : this.entries.get(this.shown);
    if (!layer || !entry) return;
    this.settingsHead(layer, at);
    const summary = this.summaryFor(layer);
    const prev = entry.layer;
    if (!built && (layer !== prev || summary !== entry.summary)) {
      const rebuild =
        entry.forceRebuild ||
        summary !== entry.summary ||
        layer.datasetId !== prev.datasetId ||
        layer.filter !== prev.filter ||
        shapeKey(layer) !== shapeKey(prev);
      if (rebuild || (external && !onlyTransformChanged(prev, layer))) {
        this.rebuildOne(doc, layer);
        this.parameters = doc.project.parameters;
        return;
      }
      entry.layer = layer;
      if (layer.transform !== prev.transform) entry.showTransform?.(layer.transform);
    }
    if (doc.project.parameters !== this.parameters) {
      this.parameters = doc.project.parameters;
      this.applyMarks(entry, doc);
    }
    if (built) return;
    entry.refreshReadout?.();
    entry.animate?.update(doc, external);
    this.updateTimeline(entry, doc);
    this.updateModulation(entry, doc, external);
  }

  private updateTimeline(entry: Entry, doc: SyncDoc): void {
    const t = entry.timeline;
    if (!t) return;
    t.panel.update(doc);
    const own = entry.layer.timeline.own;
    t.folder.title = own ? 'Timeline (own)' : 'Timeline';
    if (t.own.value !== own) {
      t.own.value = own;
      this.quiet(() => t.ownApi.refresh());
    }
  }

  /** Refresh the live values in the open layer's Modulation and Timeline folders (about 10 times a second). */
  tick(nowMs: number): void {
    for (const entry of this.entries.values()) {
      if (entry.modulationFolder?.expanded) entry.modulation?.tick(nowMs);
      if (entry.timeline?.folder.expanded) entry.timeline.panel.tick(nowMs);
    }
  }

  private updateModulation(entry: Entry, doc: SyncDoc, external: boolean): void {
    const m = entry.modulation;
    if (!m || !entry.modulationFolder) return;
    m.update(doc, external);
    entry.modulationFolder.title = m.count > 0 ? `Motion effects (${m.count})` : 'Motion effects';
  }

  /** Label each modulatable field " ~" when any of its parameters has a modulator. */
  private applyMarks(entry: Entry, doc: SyncDoc): void {
    const params = doc.project.parameters;
    const prefix = layerParamPrefix(entry.layer.id);
    for (const m of entry.marks) {
      const modulated = m.fields.some((f) => params[prefix + f] !== undefined);
      m.api.label = modulated ? m.label + MODULATED_SUFFIX : m.label;
    }
  }

  /** Call when a dataset finishes parsing, so layers waiting for its columns can rebuild. */
  refreshSummaries(): void {
    const doc = this.deps.getDoc();
    if (doc) this.update(doc, false);
  }

  private summaryFor(layer: LayerConfig): DatasetSummary | null {
    if (layer.datasetId === null) return null;
    // A filter that keeps no rows falls back to the whole dataset, so the card keeps its column
    // choices while the output flags the layer.
    return this.deps.summary(layer.datasetId, layer.filter) ?? this.deps.summary(layer.datasetId);
  }

  private saveExpanded(entry: Entry): void {
    for (const f of entry.folders) this.expanded.set(f.key, f.api.expanded);
  }

  /** Dispose a layer's pane and forget its entry (the caller removes or replaces the element). */
  private disposeEntry(id: string, entry: Entry): void {
    this.saveExpanded(entry);
    entry.folder.dispose();
    this.entries.delete(id);
  }

  /** Close the open pane, so the next `showLayer` builds it afresh. */
  private closeSettings(): void {
    for (const [id, entry] of [...this.entries]) this.disposeEntry(id, entry);
    this.settingsBody.replaceChildren();
  }

  private rebuildOne(doc: SyncDoc, layer: LayerConfig): void {
    const entry = this.entries.get(layer.id);
    if (!entry) return;
    // Build the new pane before dropping the old one and swap them in one go, so the settings
    // column keeps its scroll position.
    this.saveExpanded(entry);
    this.entries.delete(layer.id);
    const pane = this.build(doc, layer);
    entry.folder.dispose();
    this.settingsBody.replaceChildren(pane);
  }

  /** Run `fn` with change events suppressed (used when the panel writes to its own bindings). */
  private quiet(fn: () => void): void {
    this.quietDepth++;
    try {
      fn();
    } finally {
      this.quietDepth--;
    }
  }

  // ---- sending -----------------------------------------------------------------------

  private currentIndex(id: string): { doc: SyncDoc; index: number; layer: LayerConfig } | null {
    const doc = this.deps.getDoc();
    if (!doc) return null;
    const index = doc.project.layers.findIndex((l) => l.id === id);
    const layer = doc.project.layers[index];
    return layer ? { doc, index, layer } : null;
  }

  /**
   * Send `set` ops for fields of layer `id`, resolving its index from the current document.
   * The result is validated locally first, so the server never has to reject our patch.
   */
  private send(id: string, changes: LayerChange[]): boolean {
    if (this.quietDepth > 0 || changes.length === 0) return false;
    const cur = this.currentIndex(id);
    if (!cur) return false;
    const ops: PatchOp[] = changes.map((c) => ({ op: 'set', path: ['project', 'layers', cur.index, ...c.path], value: c.value }));
    let message: string | null = null;
    try {
      const next = applyOps(cur.doc, ops);
      const r = LayerSchema.safeParse(next.project.layers[cur.index]);
      if (!r.success) {
        const issue = r.error.issues[0];
        message = `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid value'}`;
      }
    } catch (err) {
      message = String(err);
    }
    if (message !== null) {
      this.deps.showError(`Layer "${cur.layer.name}" change not sent (${message}).`);
      // Put the GUI back to the synced values, outside the binding's own event handler.
      queueMicrotask(() => {
        const now = this.currentIndex(id);
        if (now) this.rebuildOne(now.doc, now.layer);
      });
      return false;
    }
    this.deps.sendPatch(ops);
    return true;
  }

  // ---- layer-level actions -------------------------------------------------------------

  private addLayer(): void {
    const doc = this.deps.getDoc();
    if (!doc) return;
    const chosen = this.addModel.type;
    const type: LayerType = chosen === LINE_CHART ? 'line' : chosen;
    const { datasets, layers } = doc.project;
    let dataset: Dataset | null = null;
    let summary: DatasetSummary | null = null;
    for (const d of datasets) {
      summary = this.deps.summary(d.id);
      if (summary) {
        dataset = d;
        break;
      }
    }
    // Text can be static, and a reflection plane and a QR code need no data; every other
    // type needs data to map.
    if (type !== 'text' && type !== 'reflector' && type !== 'qr') {
      if (datasets.length === 0) {
        this.deps.showError('Import a dataset before adding a layer.');
        return;
      }
      if (!dataset || !summary) {
        this.deps.showError('Datasets are still loading (or failed to load); try again once one has parsed.');
        return;
      }
    }
    const ids = new Set(layers.map((l) => l.id));
    let id = randomId();
    while (ids.has(id)) id = randomId();
    const names = new Set(layers.map((l) => l.name));
    let n = layers.length + 1;
    while (names.has(`Layer ${n}`)) n++;
    let layer = defaultLayerOfType(type, id, `Layer ${n}`, dataset, summary);
    if (chosen === LINE_CHART && layer.type === 'line' && summary) layer = lineChartPreset(layer, summary);
    this.pendingSelect = id;
    this.deps.sendPatch([{ op: 'set', path: ['project', 'layers', layers.length], value: layer }]);
  }

  private move(id: string, delta: -1 | 1): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    const layers = cur.doc.project.layers;
    const j = cur.index + delta;
    const other = layers[j];
    if (!other) return;
    this.deps.sendPatch([
      { op: 'set', path: ['project', 'layers', j], value: cur.layer },
      { op: 'set', path: ['project', 'layers', cur.index], value: other },
    ]);
  }

  private duplicate(id: string): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    const layers = cur.doc.project.layers;
    const ids = new Set(layers.map((l) => l.id));
    let newId = randomId();
    while (ids.has(newId)) newId = randomId();
    const copy: LayerConfig = { ...structuredClone(cur.layer), id: newId, name: `${cur.layer.name} copy` };
    // Shift the layers below down one slot, then drop the copy in just below the original.
    const ops: PatchOp[] = [];
    for (let k = layers.length; k > cur.index + 1; k--) ops.push({ op: 'set', path: ['project', 'layers', k], value: layers[k - 1] });
    ops.push({ op: 'set', path: ['project', 'layers', cur.index + 1], value: copy });
    // The copy gets the original's modulators (and own-timeline transport) too, in the same patch.
    ops.push(...layerParamCopyOps(cur.doc.project.parameters, id, newId));
    const transport = cur.doc.session.layerTransports[id];
    if (transport) ops.push({ op: 'set', path: ['session', 'layerTransports', newId], value: transport });
    // The copy opens with the original's folders expanded as they are now.
    const open = this.entries.get(id);
    if (open) this.saveExpanded(open);
    for (const [key, expanded] of [...this.expanded]) if (key.startsWith(`${id}/`)) this.expanded.set(`${newId}${key.slice(id.length)}`, expanded);
    this.pendingSelect = newId;
    this.deps.sendPatch(ops);
  }

  private remove(id: string): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    if (!window.confirm(`Delete layer "${cur.layer.name}"?`)) return;
    // Re-resolve: the document may have changed while the dialog was open.
    const now = this.currentIndex(id);
    // Its modulators go in the same patch, so none are left orphaned.
    if (now) {
      const ops: PatchOp[] = [{ op: 'remove', path: ['project', 'layers', now.index] }, ...layerParamRemovalOps(now.doc.project.parameters, id)];
      if (now.doc.session.layerTransports[id]) ops.push({ op: 'remove', path: ['session', 'layerTransports', id] });
      this.deps.sendPatch(ops);
    }
  }

  private fit(id: string): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    const summary = this.summaryFor(cur.layer);
    const dataset = cur.doc.project.datasets.find((d) => d.id === cur.layer.datasetId);
    if (cur.layer.type !== 'text' && cur.layer.type !== 'reflector' && cur.layer.type !== 'qr' && (!summary || !dataset)) return;
    const fitted = fitAnyLayer(cur.layer, summary, dataset?.timeZone ?? 'UTC');
    const entry = this.entries.get(id);
    if (this.send(id, diffChanges(cur.layer, fitted)) && entry) entry.forceRebuild = true;
  }

  /** Give layer `id` a random look (see layer-random.ts), keeping the old one for Back. */
  private randomise(id: string, scope: RandomScope): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    const summary = this.summaryFor(cur.layer);
    const dataset = cur.doc.project.datasets.find((d) => d.id === cur.layer.datasetId);
    if (cur.layer.type !== 'text' && cur.layer.type !== 'reflector' && cur.layer.type !== 'qr' && (!summary || !dataset)) return;
    const seed = Math.floor(Math.random() * 2 ** 32);
    const next = randomiseLayer(cur.layer, summary, dataset?.timeZone ?? 'UTC', cur.doc.project.output.background, scope, seededRng(seed));
    const changes = diffChanges(cur.layer, next);
    if (changes.length === 0 || !this.send(id, changes)) return;
    const stack = this.randomHistory.get(id) ?? [];
    stack.push(cur.layer);
    if (stack.length > RANDOM_HISTORY) stack.shift();
    this.randomHistory.set(id, stack);
    const entry = this.entries.get(id);
    if (entry) entry.forceRebuild = true;
  }

  /**
   * Back to the look before the last randomise. Name, on/off, dataset, transform, timeline and
   * fixed to screen stay as they are now (randomising never changes them; they may have been
   * edited since). Forgotten when the layer's dataset has changed since.
   */
  private randomBack(id: string): void {
    const cur = this.currentIndex(id);
    const stack = this.randomHistory.get(id);
    const prev = stack?.pop();
    if (!cur || !prev) return;
    if (prev.datasetId !== cur.layer.datasetId || prev.type !== cur.layer.type) {
      this.randomHistory.delete(id);
      return;
    }
    const { name, enabled, datasetId, transform, timeline, screenFixed } = cur.layer;
    const restored = { ...prev, name, enabled, datasetId, transform, timeline, screenFixed } as LayerConfig;
    this.send(id, diffChanges(cur.layer, restored));
    const entry = this.entries.get(id);
    if (entry) entry.forceRebuild = true;
  }

  /** Switch dataset, dropping column references the new dataset doesn't have. */
  private changeDataset(id: string, datasetId: string | null): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    this.send(id, datasetSwitchChanges(cur.layer, datasetId, datasetId ? this.deps.summary(datasetId) : null));
  }

  private instanceTotal(): number {
    const doc = this.deps.getDoc();
    if (!doc) return 0;
    let total = 0;
    for (const l of doc.project.layers) {
      if (!l.enabled || l.datasetId === null) continue;
      total += instanceCount(l, this.deps.summary(l.datasetId, l.filter)?.rowCount ?? 0);
    }
    return total;
  }

  // ---- building a layer's folder -------------------------------------------------------

  /** Randomise look / Randomise all / Back, at the end of the layer's General folder. */
  private addRandomButtons(entry: Entry, ui: LayerUi): void {
    const id = ui.id;
    const general = entry.folders.find((f) => f.key === `${id}/General`)?.api;
    if (!general) return;
    general.addBlade({ view: 'separator' });
    const ready = ui.canFit;
    const look = general.addButton({ title: ready ? 'Randomise look' : 'Randomise look (waiting for data)', label: 'random', disabled: !ready });
    look.on('click', () => this.randomise(id, 'look'));
    look.element.title = 'A new look from a few hand-made styles (colours, shapes, arrangement, glow), fitted to the output. The columns stay as they are';
    const all = general.addButton({ title: 'Randomise all', label: '', disabled: !ready });
    all.on('click', () => this.randomise(id, 'all'));
    all.element.title = 'As Randomise look, and also picks which columns are shown (and how lines and small multiples group them)';
    const depth = this.randomHistory.get(id)?.length ?? 0;
    const back = general.addButton({ title: depth > 0 ? `Back (${depth})` : 'Back', label: '', disabled: depth === 0 });
    back.on('click', () => this.randomBack(id));
    back.element.title = 'The look before the last randomise (up to 10 back; forgotten when this window reloads)';
  }

  /**
   * Third in a data layer's card, after Animate: which rows of the dataset the layer keeps
   * (column is one of the ticked values; every condition must hold). Each edit sends the whole
   * filter list; the echo changes the layer's summary, which rebuilds the card.
   */
  private addFilterFolder(entry: Entry, layer: LayerConfig): void {
    const id = layer.id;
    const full = layer.datasetId === null ? null : this.deps.summary(layer.datasetId);
    const kept = layer.filter.length > 0 && layer.datasetId !== null ? this.deps.summary(layer.datasetId, layer.filter) : null;
    const title =
      layer.filter.length === 0 || !full ? 'Filter' : `Filter (${kept ? kept.rowCount : 0} of ${full.rowCount} rows)`;
    const folder = this.folderIn(entry, entry.folder, title, `${id}/filter`, layer.filter.length > 0, 2);
    if (!full) {
      folder.addButton({ title: 'Waiting for data', label: 'filter', disabled: true });
      return;
    }
    const choices = full.columns.filter((c) => c.values !== undefined && c.values.length > 0);
    const sendFilter = (filter: RowFilter[]) => void this.send(id, [{ path: ['filter'], value: filter }]);
    const filter = layer.filter;

    filter.forEach((f, i) => {
      const column = choices.find((c) => c.name === f.column);
      const pick = { column: f.column };
      const options = choices.map((c) => ({ text: c.name, value: c.name }));
      if (!column) options.unshift({ text: `${f.column} (not in dataset)`, value: f.column });
      folder
        .addBinding(pick, 'column', { label: i === 0 ? 'keep rows where' : 'and where', options })
        .on('change', (ev) => {
          const values = choices.find((c) => c.name === ev.value)?.values ?? [];
          sendFilter(filter.map((g, k) => (k === i ? { column: ev.value, values: values.slice(0, 1) } : g)));
        });
      const ticked = new Set(f.values);
      for (const value of column?.values ?? []) {
        const box = { on: ticked.has(value) };
        folder.addBinding(box, 'on', { label: value === '' ? '(blank)' : value }).on('change', (ev) => {
          const next = column!.values!.filter((v) => (v === value ? ev.value : ticked.has(v)));
          sendFilter(filter.map((g, k) => (k === i ? { ...g, values: next } : g)));
        });
      }
      const all = folder.addButton({ title: 'Tick all', label: '', disabled: !column });
      all.on('click', () => sendFilter(filter.map((g, k) => (k === i ? { ...g, values: [...(column?.values ?? [])] } : g))));
      const remove = folder.addButton({ title: 'Remove this filter', label: '' });
      remove.on('click', () => sendFilter(filter.filter((_, k) => k !== i)));
      folder.addBlade({ view: 'separator' });
    });

    const unused = choices.find((c) => !filter.some((f) => f.column === c.name)) ?? choices[0];
    const add = folder.addButton({
      title: choices.length === 0 ? 'Add filter (no category columns)' : 'Add filter',
      label: filter.length === 0 ? 'filter' : '',
      disabled: !unused || filter.length >= MAX_FILTERS,
    });
    add.element.title = 'Keep only the rows whose column holds the ticked values. Row ranges, aggregation and Fit then count the kept rows.';
    add.on('click', () => {
      if (unused) sendFilter([...filter, { column: unused.name, values: (unused.values ?? []).slice(0, 1) }]);
    });
  }

  private folderIn(entry: Entry, parent: FolderApi, title: string, key: string, def: boolean, index?: number): FolderApi {
    const api = parent.addFolder({ title, expanded: this.expanded.get(key) ?? def, index });
    entry.folders.push({ key, api });
    return api;
  }

  /** Build the settings pane of a layer, returning its element (not yet placed). */
  private build(doc: SyncDoc, layer: LayerConfig): HTMLElement {
    const id = layer.id;
    const summary = this.summaryFor(layer);
    const dataset = doc.project.datasets.find((d) => d.id === layer.datasetId);
    const container = h('div', { className: 'layer-pane' });
    const pane = new Pane({ container });
    const entry: Entry = {
      layer,
      summary,
      folder: pane,
      folders: [],
      forceRebuild: false,
      marks: [],
      showTransform: null,
      refreshReadout: null,
      // Name and on/off edits show at once, before their echo.
      retitle: (title) => {
        if (this.shown === id) this.retitleSettings(title);
        const row = this.rows.get(id);
        if (row) this.retitleRow(row, title);
      },
      animate: null,
      modulation: null,
      modulationFolder: null,
      timeline: null,
    };
    this.entries.set(id, entry);

    const ui: LayerUi = {
      id,
      entry,
      doc,
      summary,
      canFit: layer.type === 'text' || layer.type === 'reflector' || layer.type === 'qr' || (summary !== null && dataset !== undefined),
      folder: (parent, title, key, expanded) => this.folderIn(entry, parent, title, `${id}/${key}`, expanded),
      set: (path: Path, value: unknown) => void this.send(id, [{ path, value }]),
      send: (changes) => this.send(id, changes),
      mark: <T extends Labelled>(api: T, label: string, ...fields: string[]): T => {
        entry.marks.push({ api, label, fields });
        return api;
      },
      quiet: (fn) => this.quiet(fn),
      isQuiet: () => this.quietDepth > 0,
      fit: () => this.fit(id),
      changeDataset: (datasetId) => this.changeDataset(id, datasetId),
      instanceTotal: () => this.instanceTotal(),
      getDoc: () => this.deps.getDoc(),
    };
    this.quiet(() => {
      switch (layer.type) {
        case 'instancer':
          buildInstancer(ui, layer, titleOf);
          break;
        case 'line':
          buildLine(ui, layer, titleOf);
          break;
        case 'heatmap':
          buildHeatmap(ui, layer, titleOf);
          break;
        case 'text':
          buildText(ui, layer, titleOf);
          break;
        case 'multiples':
          buildMultiples(ui, layer, titleOf);
          break;
        case 'hierarchy':
          buildHierarchy(ui, layer, titleOf);
          break;
        case 'surface':
          buildSurface(ui, layer, titleOf);
          break;
        case 'reflector':
          buildReflector(ui, layer, titleOf);
          break;
        case 'qr':
          buildQr(ui, layer, titleOf);
          break;
        case 'density':
          buildDensity(ui, layer, titleOf);
          break;
      }
    });
    this.addRandomButtons(entry, ui);
    this.applyMarks(entry, doc);
    // Second in the card, after General: which rows show and how they play out, then the
    // layer's timeline and its own modulators ("motion effects").
    const animated = Object.keys(doc.project.parameters).some((p) => p.startsWith(layerParamPrefix(id)));
    const animateFolder = this.folderIn(entry, pane, 'Animate', `${id}/animate`, animated, 1);
    entry.animate = new AnimatePanel(animateFolder, id, { sendPatch: this.deps.sendPatch, getDoc: this.deps.getDoc, showError: this.deps.showError }, doc);
    if (layer.datasetId !== null && layer.type !== 'qr' && layer.type !== 'reflector') this.addFilterFolder(entry, layer);
    if (animateFolder.children.length > 0) animateFolder.addBlade({ view: 'separator' });
    const timelineFolder = this.folderIn(entry, animateFolder, 'Timeline', `${id}/timeline`, false);
    const own = { value: layer.timeline.own };
    const ownApi = timelineFolder.addBinding(own, 'value', { label: 'own timeline' }).on('change', (ev) => {
      if (this.quietDepth > 0) return;
      const doc = this.deps.getDoc();
      if (doc) this.deps.sendPatch(ownTimelineOps(doc, id, ev.value, wallMs()));
    });
    ownApi.element.title = 'Off: this layer’s reveal, ramps and keyframes follow the project timeline. On: its own duration, loop and transport.';
    const timelinePanel = new TimelinePanel(timelineFolder, { sendPatch: this.deps.sendPatch, getDoc: this.deps.getDoc }, layerTimeline(id));
    entry.timeline = { panel: timelinePanel, own, ownApi, folder: timelineFolder };
    this.updateTimeline(entry, doc);

    const folder = this.folderIn(entry, animateFolder, 'Motion effects', `${id}/modulation`, false);
    entry.modulationFolder = folder;
    entry.modulation = new ModulationPanel(
      folder,
      { sendPatch: this.deps.sendPatch, getDoc: this.deps.getDoc, showError: this.deps.showError },
      { kind: 'layer', layerId: id },
      this.modulationExpanded,
    );
    this.updateModulation(entry, doc, true);
    return container;
  }
}
