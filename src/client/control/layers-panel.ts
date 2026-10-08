import type { FolderApi } from 'tweakpane';
import { defaultLayerOfType, fitAnyLayer, type DatasetSummary } from '../../shared/layer-defaults.ts';
import { datasetSwitchChanges, diffChanges, instanceCount, LAYER_TYPE_TITLES, type LayerChange } from '../../shared/layer-helpers.ts';
import { LAYER_TYPES, LayerSchema, type LayerConfig, type LayerType } from '../../shared/layer-schema.ts';
import { layerParamCopyOps, layerParamRemovalOps } from '../../shared/modulation-helpers.ts';
import { layerParamPrefix } from '../../shared/parameters.ts';
import { applyOps, type Path, type PatchOp } from '../../shared/patch.ts';
import type { Dataset, SyncDoc } from '../../shared/project-schema.ts';
import { buildHeatmap } from './heatmap-folders.ts';
import { buildInstancer } from './instancer-folders.ts';
import type { Entry, Labelled, LayerUi } from './layer-ui.ts';
import { buildLine } from './line-folders.ts';
import { buildText } from './text-folders.ts';

/**
 * "Layers" folder of the control pane: one sub-folder per layer of any type, editing the
 * layer config through minimal `set` patches. The GUI never holds authoritative state: every
 * edit is sent to the server and the folder is rebuilt from the synced document when the
 * layer changes structurally or someone else edits it. The per-type folders are built in
 * instancer-folders.ts, line-folders.ts, heatmap-folders.ts and text-folders.ts.
 *
 * One layer can be selected (for the preview's transform gizmo): pointing anywhere in its
 * folder selects it, and its folder is highlighted.
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
/** Class on the selected layer's folder element (styled in index.html). */
const SELECTED_CLASS = 'dw-layer-selected';
/** Children of the Layers folder before the first layer folder (type list, Add button). */
const HEAD = 2;

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
  private root: FolderApi;
  private entries = new Map<string, Entry>();
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

  constructor(parent: FolderApi, private deps: LayersPanelDeps) {
    this.root = parent.addFolder({ title: 'Layers' });
    this.root.addBinding(this.addModel, 'type', {
      label: 'new layer',
      options: LAYER_TYPES.map((t) => ({ text: LAYER_TYPE_TITLES[t], value: t })),
    });
    this.root.addButton({ title: 'Add layer' }).on('click', () => this.addLayer());
  }

  // ---- selection -----------------------------------------------------------------------

  /**
   * Highlight `id`'s folder (null clears). With `reveal`, also expand and scroll to it (for a
   * selection made in the preview).
   */
  setSelected(id: string | null, reveal = false): void {
    this.selected = id;
    for (const [lid, e] of this.entries) e.folder.element.classList.toggle(SELECTED_CLASS, lid === id);
    const entry = id === null ? undefined : this.entries.get(id);
    if (entry && reveal) {
      entry.folder.expanded = true;
      entry.folder.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      entry.folder.title = titleOf(layer);
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

  private rebuildAll(doc: SyncDoc): void {
    for (const entry of this.entries.values()) {
      this.saveExpanded(entry);
      entry.folder.dispose();
    }
    this.entries.clear();
    const layers = doc.project.layers;
    this.order = layers.map((l) => l.id);
    this.datasets = doc.project.datasets;
    const ids = new Set(this.order);
    for (const key of [...this.expanded.keys()]) if (!ids.has(key.slice(0, key.indexOf('/')))) this.expanded.delete(key);
    layers.forEach((layer, i) => this.build(doc, layer, i, layers.length));
  }

  private rebuildOne(doc: SyncDoc, layer: LayerConfig): void {
    const entry = this.entries.get(layer.id);
    if (!entry) return;
    this.saveExpanded(entry);
    const at = doc.project.layers.findIndex((l) => l.id === layer.id);
    entry.folder.dispose();
    this.entries.delete(layer.id);
    this.build(doc, layer, at, doc.project.layers.length);
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

  private folderIn(entry: Entry, parent: FolderApi, title: string, key: string, def: boolean, index?: number): FolderApi {
    const expanded = this.expanded.get(key) ?? def;
    const api = parent.addFolder(index === undefined ? { title, expanded } : { title, expanded, index });
    entry.folders.push({ key, api });
    return api;
  }

  private build(doc: SyncDoc, layer: LayerConfig, position: number, count: number): void {
    const id = layer.id;
    const summary = this.summaryFor(layer);
    const dataset = doc.project.datasets.find((d) => d.id === layer.datasetId);
    const entry: Entry = {
      layer,
      summary,
      folder: null as unknown as FolderApi,
      folders: [],
      forceRebuild: false,
      marks: [],
      showTransform: null,
      refreshReadout: null,
    };
    entry.folder = this.folderIn(entry, this.root, titleOf(layer), `${id}/`, false, position + HEAD);
    entry.folder.element.classList.toggle(SELECTED_CLASS, id === this.selected);
    // Pointing anywhere in the layer's folder (its title included) selects the layer.
    entry.folder.element.addEventListener('pointerdown', () => {
      if (this.selected !== id) this.deps.select(id);
    });
    this.entries.set(id, entry);

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
      }
      this.buildActions(entry, id, position, count);
    });
    this.applyMarks(entry, doc);
  }

  private buildActions(entry: Entry, id: string, position: number, count: number): void {
    const f = entry.folder;
    f.addBlade({ view: 'separator' });
    f.addButton({ title: 'Move up', disabled: position <= 0 }).on('click', () => this.move(id, -1));
    f.addButton({ title: 'Move down', disabled: position >= count - 1 }).on('click', () => this.move(id, 1));
    f.addButton({ title: 'Duplicate' }).on('click', () => this.duplicate(id));
    f.addButton({ title: 'Delete' }).on('click', () => this.remove(id));
  }
}
