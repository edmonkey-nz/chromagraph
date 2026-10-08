import { Pane, type FolderApi } from 'tweakpane';
import { defaultLayerOfType, fitAnyLayer, type DatasetSummary } from '../../shared/layer-defaults.ts';
import { datasetSwitchChanges, diffChanges, instanceCount, LAYER_TYPE_TITLES, type LayerChange } from '../../shared/layer-helpers.ts';
import { LAYER_TYPES, LayerSchema, type LayerConfig, type LayerType } from '../../shared/layer-schema.ts';
import { layerParamCopyOps, layerParamRemovalOps } from '../../shared/modulation-helpers.ts';
import { layerParamPrefix } from '../../shared/parameters.ts';
import { applyOps, type Path, type PatchOp } from '../../shared/patch.ts';
import type { Dataset, SyncDoc } from '../../shared/project-schema.ts';
import { buildHeatmap } from './heatmap-folders.ts';
import { buildHierarchy } from './hierarchy-folders.ts';
import { buildInstancer } from './instancer-folders.ts';
import type { Entry, Labelled, LayerUi } from './layer-ui.ts';
import { buildLine } from './line-folders.ts';
import { buildMultiples } from './multiples-folders.ts';
import { buildSurface } from './surface-folders.ts';
import { buildText } from './text-folders.ts';
import { Card, h, iconButton } from './ui.ts';

/**
 * "Layers" zone of the control window: a header with Add layer, then one card per layer of
 * any type (each with its own Tweakpane pane), editing the layer config through minimal
 * `set` patches. The GUI never holds authoritative state: every
 * edit is sent to the server and the folder is rebuilt from the synced document when the
 * layer changes structurally or someone else edits it. The per-type folders are built in
 * instancer-folders.ts, line-folders.ts, heatmap-folders.ts, text-folders.ts,
 * multiples-folders.ts, hierarchy-folders.ts and surface-folders.ts.
 *
 * One layer can be selected (for the preview's transform gizmo): pointing anywhere in its
 * card selects it, and its card is highlighted.
 *
 * Cards are dealt into columns in stack order (layer 1 in the first column, layer 2 in the
 * second, ...), so a card never moves when another one is expanded or collapsed.
 */

export interface LayersPanelDeps {
  sendPatch(ops: PatchOp[]): void;
  /** The current synced document, read at send time so layer indices are never stale. */
  getDoc(): SyncDoc | null;
  /** Parsed column summary of a dataset, or null while it is still loading. */
  summary(datasetId: string): DatasetSummary | null;
  showError(message: string): void;
  /** The user selected a layer in the panel. */
  select(layerId: string): void;
}

/** Appended to the label of a field whose parameter has a modulator. */
const MODULATED_SUFFIX = ' ~';
/** Class on the selected layer's card (styled in index.html). */
const SELECTED_CLASS = 'selected';
/** The zone is split into two columns of cards when it is at least this wide. */
const TWO_COLUMNS_PX = 760;

function randomId(): string {
  return `ly-${Math.random().toString(36).slice(2, 10)}`;
}

/** Edits to these need the folder rebuilt even for our own echo (fields shown or hidden). */
function shapeKey(layer: LayerConfig): string {
  switch (layer.type) {
    case 'instancer':
      return `instancer:${layer.arrangement}`;
    case 'heatmap':
      return `heatmap:${layer.layout}`;
    case 'surface':
      return `surface:${layer.layout}`;
    case 'multiples':
      return `multiples:${layer.splitBy}`;
    case 'hierarchy':
      // Adding, removing or re-kinding a level changes which fields each level shows.
      return `hierarchy:${layer.levels.map((l) => l.kind).join(',')}`;
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
  private entries = new Map<string, Entry>();
  private cards = new Map<string, Card>();
  private columns: HTMLElement[];
  private columnHost = h('div', { className: 'layer-columns' });
  private empty = h('div', { className: 'card empty-card' });
  private countNote = h('span', { className: 'zone-note' });
  private typeSelect = h('select');
  private order: string[] = [];
  private datasets: readonly Dataset[] | null = null;
  private expanded = new Map<string, boolean>();
  /** Non-zero while the panel itself writes into bindings; change events are ignored then. */
  private quietDepth = 0;
  /** The modulators the field labels were last marked from. */
  private parameters: SyncDoc['project']['parameters'] | null = null;
  private addModel: { type: LayerType } = { type: 'instancer' };
  private selected: string | null = null;
  /** A layer we just added, to select once it arrives. */
  private pendingSelect: string | null = null;

  constructor(zone: HTMLElement, private deps: LayersPanelDeps) {
    this.typeSelect.append(...LAYER_TYPES.map((t) => h('option', { value: t, textContent: LAYER_TYPE_TITLES[t] })));
    this.typeSelect.setAttribute('aria-label', 'Type of the new layer');
    this.typeSelect.addEventListener('change', () => (this.addModel.type = this.typeSelect.value as LayerType));
    const add = h('button', { type: 'button', className: 'btn primary', textContent: 'Add layer' });
    add.addEventListener('click', () => this.addLayer());
    const collapseAll = h('button', { type: 'button', className: 'btn ghost', textContent: 'Collapse all' });
    collapseAll.addEventListener('click', () => this.collapseAll());
    this.empty.append(
      h('p', { className: 'muted', textContent: 'No layers yet. Import a dataset (Datasets tab), pick a layer type above and press Add layer.' }),
    );
    zone.append(
      h('div', { className: 'zone-head' }, h('h2', { className: 'zone-title', textContent: 'Layers' }), this.countNote, h('span', { className: 'spacer' }), collapseAll, this.typeSelect, add),
      this.empty,
      this.columnHost,
    );
    this.columns = [h('div', { className: 'layer-col' }), h('div', { className: 'layer-col' })];
    // Two columns when there is room; re-deal the cards when that changes.
    let count = 0;
    new ResizeObserver(() => {
      const n = zone.clientWidth >= TWO_COLUMNS_PX ? 2 : 1;
      if (n === count) return;
      count = n;
      this.columnHost.replaceChildren(...this.columns.slice(0, n));
      this.columnHost.dataset.columns = String(n);
      this.layout();
    }).observe(zone);
  }

  /** Put the cards into the visible columns in stack order (layer i into column i mod n). */
  private layout(): void {
    const n = Math.max(1, this.columnHost.childElementCount);
    const want: HTMLElement[][] = this.columns.map(() => []);
    this.order.forEach((id, i) => {
      const card = this.cards.get(id);
      if (card) want[i % n]!.push(card.root);
    });
    this.columns.forEach((col, c) => {
      const list = want[c]!;
      // Only touch a column whose contents changed: moving a card would drop keyboard focus.
      const same = list.length === col.childElementCount && list.every((el, i) => col.children[i] === el);
      if (!same) col.replaceChildren(...list);
    });
    this.cards.forEach((card, id) => card.setBadge(String(this.order.indexOf(id) + 1)));
    this.empty.hidden = this.order.length > 0;
    this.countNote.textContent = this.order.length === 0 ? '' : `${this.order.length} layer${this.order.length === 1 ? '' : 's'}`;
  }

  private collapseAll(): void {
    for (const [id, card] of this.cards) {
      card.setCollapsed(true);
      this.expanded.set(`${id}/`, false);
    }
  }

  // ---- selection -----------------------------------------------------------------------

  /**
   * Highlight `id`'s folder (null clears). With `reveal`, also expand and scroll to it (for a
   * selection made in the preview).
   */
  setSelected(id: string | null, reveal = false): void {
    this.selected = id;
    for (const [lid, card] of this.cards) card.root.classList.toggle(SELECTED_CLASS, lid === id);
    const card = id === null ? undefined : this.cards.get(id);
    if (card && id !== null && reveal) {
      card.setCollapsed(false);
      this.expanded.set(`${id}/`, true);
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.root.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    }
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
    if (structural) {
      this.rebuildAll(doc);
      this.parameters = doc.project.parameters;
      if (this.pendingSelect !== null && this.entries.has(this.pendingSelect)) {
        const id = this.pendingSelect;
        this.pendingSelect = null;
        this.deps.select(id);
      }
      return;
    }
    for (const layer of layers) {
      const entry = this.entries.get(layer.id);
      if (!entry) continue;
      const summary = this.summaryFor(layer);
      const prev = entry.layer;
      if (layer === prev && summary === entry.summary) continue;
      const rebuild =
        entry.forceRebuild || summary !== entry.summary || layer.datasetId !== prev.datasetId || shapeKey(layer) !== shapeKey(prev);
      if (rebuild || (external && !onlyTransformChanged(prev, layer))) {
        this.rebuildOne(doc, layer);
        continue;
      }
      entry.layer = layer;
      entry.retitle(titleOf(layer));
      if (layer.transform !== prev.transform) entry.showTransform?.(layer.transform);
    }
    if (doc.project.parameters !== this.parameters) {
      this.parameters = doc.project.parameters;
      for (const entry of this.entries.values()) this.applyMarks(entry, doc);
    }
    for (const entry of this.entries.values()) entry.refreshReadout?.();
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
    return layer.datasetId === null ? null : this.deps.summary(layer.datasetId);
  }

  private saveExpanded(entry: Entry): void {
    for (const f of entry.folders) this.expanded.set(f.key, f.api.expanded);
  }

  /** Dispose a layer's pane and forget its card (the caller removes or replaces the element). */
  private disposeEntry(id: string, entry: Entry): void {
    this.saveExpanded(entry);
    entry.folder.dispose();
    this.entries.delete(id);
    this.cards.delete(id);
  }

  private rebuildAll(doc: SyncDoc): void {
    for (const [id, entry] of [...this.entries]) this.disposeEntry(id, entry);
    for (const col of this.columns) col.replaceChildren();
    const layers = doc.project.layers;
    this.order = layers.map((l) => l.id);
    this.datasets = doc.project.datasets;
    const ids = new Set(this.order);
    for (const key of [...this.expanded.keys()]) if (!ids.has(key.slice(0, key.indexOf('/')))) this.expanded.delete(key);
    layers.forEach((layer, i) => this.build(doc, layer, i, layers.length));
    this.layout();
  }

  private rebuildOne(doc: SyncDoc, layer: LayerConfig): void {
    const entry = this.entries.get(layer.id);
    if (!entry) return;
    const old = this.cards.get(layer.id);
    const at = doc.project.layers.findIndex((l) => l.id === layer.id);
    this.disposeEntry(layer.id, entry);
    const card = this.build(doc, layer, at, doc.project.layers.length);
    // Swap in place, so no other card moves.
    if (old) old.root.replaceWith(card.root);
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
    const type = this.addModel.type;
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
    // Text can be static; every other type needs data to map.
    if (type !== 'text') {
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
    const layer = defaultLayerOfType(type, id, `Layer ${n}`, dataset, summary);
    this.expanded.set(`${id}/`, true);
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
    // The copy gets the original's modulators too, in the same patch.
    ops.push(...layerParamCopyOps(cur.doc.project.parameters, id, newId));
    for (const f of this.entries.get(id)?.folders ?? []) this.expanded.set(`${newId}${f.key.slice(id.length)}`, f.api.expanded);
    this.expanded.set(`${newId}/`, !(this.cards.get(id)?.collapsed ?? true));
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
      this.deps.sendPatch([{ op: 'remove', path: ['project', 'layers', now.index] }, ...layerParamRemovalOps(now.doc.project.parameters, id)]);
    }
  }

  private fit(id: string): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    const summary = cur.layer.datasetId === null ? null : this.deps.summary(cur.layer.datasetId);
    const dataset = cur.doc.project.datasets.find((d) => d.id === cur.layer.datasetId);
    if (cur.layer.type !== 'text' && (!summary || !dataset)) return;
    const fitted = fitAnyLayer(cur.layer, summary, dataset?.timeZone ?? 'UTC');
    const entry = this.entries.get(id);
    if (this.send(id, diffChanges(cur.layer, fitted)) && entry) entry.forceRebuild = true;
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
      total += instanceCount(l, this.deps.summary(l.datasetId)?.rowCount ?? 0);
    }
    return total;
  }

  // ---- building a layer's folder -------------------------------------------------------

  private folderIn(entry: Entry, parent: FolderApi, title: string, key: string, def: boolean): FolderApi {
    const api = parent.addFolder({ title, expanded: this.expanded.get(key) ?? def });
    entry.folders.push({ key, api });
    return api;
  }

  /** Build a layer's card (not yet placed in a column) and its pane. */
  private build(doc: SyncDoc, layer: LayerConfig, position: number, count: number): Card {
    const id = layer.id;
    const summary = this.summaryFor(layer);
    const dataset = doc.project.datasets.find((d) => d.id === layer.datasetId);
    const rootKey = `${id}/`;
    const card = new Card({
      title: titleOf(layer),
      className: 'layer-card',
      collapsed: !(this.expanded.get(rootKey) ?? false),
      onToggle: (collapsed) => this.expanded.set(rootKey, !collapsed),
    });
    card.root.classList.toggle(SELECTED_CLASS, id === this.selected);
    card.root.classList.toggle('off', !layer.enabled);
    card.setBadge(String(position + 1));
    card.root.dataset.type = layer.type;
    // Pointing anywhere in the layer's card (its header included), or tabbing into it, selects the layer.
    const select = () => {
      if (this.selected !== id) this.deps.select(id);
    };
    card.root.addEventListener('pointerdown', select);
    card.root.addEventListener('focusin', select);
    const up = iconButton('up', 'Move up (drawn earlier)', () => this.move(id, -1));
    const down = iconButton('down', 'Move down (drawn later)', () => this.move(id, 1));
    up.disabled = position <= 0;
    down.disabled = position >= count - 1;
    card.actions.append(up, down, iconButton('copy', 'Duplicate', () => this.duplicate(id)), iconButton('trash', 'Delete…', () => this.remove(id), 'danger'));
    const pane = new Pane({ container: card.body });
    const entry: Entry = {
      layer,
      summary,
      folder: pane,
      folders: [],
      forceRebuild: false,
      marks: [],
      showTransform: null,
      refreshReadout: null,
      retitle: (title) => {
        card.setTitle(title);
        card.root.classList.toggle('off', title.endsWith('(off)'));
      },
    };
    this.entries.set(id, entry);
    this.cards.set(id, card);

    const ui: LayerUi = {
      id,
      entry,
      doc,
      summary,
      canFit: layer.type === 'text' || (summary !== null && dataset !== undefined),
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
      }
    });
    this.applyMarks(entry, doc);
    return card;
  }
}
