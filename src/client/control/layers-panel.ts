import type { BladeApi, FolderApi, ListParamsOptions } from 'tweakpane';
import { defaultLayerFor, fitLayer, timeColumns, type DatasetSummary, type SummaryColumn } from '../../shared/layer-defaults.ts';
import {
  ARRANGEMENTS,
  BLEND_MODES,
  COLOUR_RAMPS,
  InstancerLayerSchema,
  NUMERIC_CHANNELS,
  PRIMITIVES,
  SCALE_TYPES,
  X_MODES,
  type Arrangement,
  type InstancerLayer,
  type NumericChannel,
} from '../../shared/layer-schema.ts';
import { layerParamCopyOps, layerParamRemovalOps } from '../../shared/modulation-helpers.ts';
import { layerParamPrefix } from '../../shared/parameters.ts';
import { applyOps, type Path, type PatchOp } from '../../shared/patch.ts';
import type { Dataset, SyncDoc } from '../../shared/project-schema.ts';

/**
 * "Layers" folder of the control pane: one sub-folder per layer, editing the layer config
 * through minimal `set` patches. The GUI never holds authoritative state: every edit is
 * sent to the server and the folder is rebuilt from the synced document when the layer
 * changes structurally or someone else edits it.
 */

export interface LayersPanelDeps {
  sendPatch(ops: PatchOp[]): void;
  /** The current synced document, read at send time so layer indices are never stale. */
  getDoc(): SyncDoc | null;
  /** Parsed column summary of a dataset, or null while it is still loading. */
  summary(datasetId: string): DatasetSummary | null;
  showError(message: string): void;
}

interface Entry {
  /** The layer config the folder was last built from or reconciled with. */
  layer: InstancerLayer;
  summary: DatasetSummary | null;
  folder: FolderApi;
  /** Every folder in this layer's tree, so expanded state survives a rebuild. */
  folders: { key: string; api: FolderApi }[];
  /** Rebuild on the next echo of our own patch (after a multi-field edit such as Fit). */
  forceRebuild: boolean;
  /** Bindings of modulatable fields, with their plain label and parameter id suffixes. */
  marks: Mark[];
}

/** Any binding: only its label is touched. */
interface Labelled {
  label: string | null | undefined;
}

interface Mark {
  api: Labelled;
  label: string;
  /** Parameter ids relative to the layer prefix, e.g. "rows.0". */
  fields: string[];
}

/** Appended to the label of a field whose parameter has a modulator. */
const MODULATED_SUFFIX = ' ~';

interface Change {
  path: Path;
  value: unknown;
}

type Vec3Obj = { x: number; y: number; z: number };

const vec3Obj = (t: readonly [number, number, number]): Vec3Obj => ({ x: t[0], y: t[1], z: t[2] });

/** Compact number display: whole numbers for big values, a few decimals for small ones. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1 || a === 0) return String(Number(v.toFixed(3)));
  return String(Number(v.toPrecision(3)));
}

function options<T extends string>(values: readonly T[]): ListParamsOptions<T> {
  return values.map((v) => ({ text: v, value: v }));
}

function columnOptions(columns: SummaryColumn[], current: string | null): ListParamsOptions<string> {
  const list: { text: string; value: string }[] = [{ text: 'none', value: '' }];
  for (const c of columns) list.push({ text: c.name, value: c.name });
  if (current !== null && !columns.some((c) => c.name === current)) list.push({ text: `${current} (missing)`, value: current });
  return list;
}

/** Domain for a column when the user switches auto domain off. */
function initialDomain(col: SummaryColumn | undefined): [number, number] {
  if (col && Number.isFinite(col.min) && Number.isFinite(col.max)) {
    return col.max > col.min ? [col.min, col.max] : [col.min, col.min + 1];
  }
  return [0, 1];
}

function randomId(): string {
  return `ly-${Math.random().toString(36).slice(2, 10)}`;
}

const CHANNEL_TITLES: Record<NumericChannel | 'colour', string> = {
  y: 'y offset',
  z: 'z offset',
  height: 'height',
  size: 'size',
  rotation: 'rotation',
  opacity: 'opacity',
  colour: 'colour',
};

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

  constructor(parent: FolderApi, private deps: LayersPanelDeps) {
    this.root = parent.addFolder({ title: 'Layers' });
    this.root.addButton({ title: 'Add layer' }).on('click', () => this.addLayer());
  }

  // ---- reconciling with the synced document ------------------------------------------

  /**
   * Reconcile with a new document. `external` is true for full snapshots and for patches
   * from other clients; our own echoes only rebuild for structural or layout-changing edits,
   * so a slider drag is never interrupted.
   */
  update(doc: SyncDoc, external: boolean): void {
    const layers = doc.project.layers;
    const structural =
      layers.length !== this.order.length ||
      layers.some((l, i) => l.id !== this.order[i]) ||
      doc.project.datasets !== this.datasets;
    if (structural) {
      this.rebuildAll(doc);
      this.parameters = doc.project.parameters;
      return;
    }
    for (const layer of layers) {
      const entry = this.entries.get(layer.id);
      if (!entry) continue;
      const summary = this.summaryFor(layer);
      if (layer === entry.layer && summary === entry.summary) continue;
      if (
        external ||
        entry.forceRebuild ||
        summary !== entry.summary ||
        layer.datasetId !== entry.layer.datasetId ||
        layer.arrangement !== entry.layer.arrangement
      ) {
        this.rebuildOne(doc, layer);
      } else {
        entry.layer = layer;
        entry.folder.title = this.titleOf(layer);
      }
    }
    if (doc.project.parameters !== this.parameters) {
      this.parameters = doc.project.parameters;
      for (const entry of this.entries.values()) this.applyMarks(entry, doc);
    }
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

  private mark<T extends Labelled>(entry: Entry, api: T, label: string, ...fields: string[]): T {
    entry.marks.push({ api, label, fields });
    return api;
  }

  /** Call when a dataset finishes parsing, so layers waiting for its columns can rebuild. */
  refreshSummaries(): void {
    const doc = this.deps.getDoc();
    if (doc) this.update(doc, false);
  }

  private summaryFor(layer: InstancerLayer): DatasetSummary | null {
    return layer.datasetId === null ? null : this.deps.summary(layer.datasetId);
  }

  private titleOf(layer: InstancerLayer): string {
    return `${layer.name || '(unnamed)'}${layer.enabled ? '' : ' (off)'}`;
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

  private rebuildOne(doc: SyncDoc, layer: InstancerLayer): void {
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

  private currentIndex(id: string): { doc: SyncDoc; index: number; layer: InstancerLayer } | null {
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
  private send(id: string, changes: Change[]): boolean {
    if (this.quietDepth > 0 || changes.length === 0) return false;
    const cur = this.currentIndex(id);
    if (!cur) return false;
    const ops: PatchOp[] = changes.map((c) => ({ op: 'set', path: ['project', 'layers', cur.index, ...c.path], value: c.value }));
    let message: string | null = null;
    try {
      const next = applyOps(cur.doc, ops);
      const r = InstancerLayerSchema.safeParse(next.project.layers[cur.index]);
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

  private set(id: string, path: Path, value: unknown): void {
    this.send(id, [{ path, value }]);
  }

  // ---- layer-level actions -------------------------------------------------------------

  private addLayer(): void {
    const doc = this.deps.getDoc();
    if (!doc) return;
    const { datasets, layers } = doc.project;
    if (datasets.length === 0) {
      this.deps.showError('Import a dataset before adding a layer.');
      return;
    }
    let dataset: Dataset | undefined;
    let summary: DatasetSummary | null = null;
    for (const d of datasets) {
      summary = this.deps.summary(d.id);
      if (summary) {
        dataset = d;
        break;
      }
    }
    if (!dataset || !summary) {
      this.deps.showError('Datasets are still loading (or failed to load); try again once one has parsed.');
      return;
    }
    const ids = new Set(layers.map((l) => l.id));
    let id = randomId();
    while (ids.has(id)) id = randomId();
    const names = new Set(layers.map((l) => l.name));
    let n = layers.length + 1;
    while (names.has(`Layer ${n}`)) n++;
    const layer = defaultLayerFor(id, `Layer ${n}`, dataset, summary);
    this.expanded.set(`${id}/`, true);
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
    const copy: InstancerLayer = { ...structuredClone(cur.layer), id: newId, name: `${cur.layer.name} copy` };
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
    if (!cur || cur.layer.datasetId === null) return;
    const summary = this.deps.summary(cur.layer.datasetId);
    const dataset = cur.doc.project.datasets.find((d) => d.id === cur.layer.datasetId);
    if (!summary || !dataset) return;
    const fitted = fitLayer(cur.layer, summary, dataset.timeZone);
    const changes: Change[] = [];
    const keys = ['origin', 'step', 'gridColumns', 'cell', 'radius', 'angleStep', 'radiusStep', 'size'] as const;
    for (const k of keys) {
      if (JSON.stringify(fitted[k]) !== JSON.stringify(cur.layer[k])) changes.push({ path: [k], value: fitted[k] });
    }
    const h = fitted.channels.height.range;
    if (JSON.stringify(h) !== JSON.stringify(cur.layer.channels.height.range)) changes.push({ path: ['channels', 'height', 'range'], value: h });
    const entry = this.entries.get(id);
    if (this.send(id, changes) && entry) entry.forceRebuild = true;
  }

  /** Switch dataset, dropping column references the new dataset doesn't have. */
  private changeDataset(id: string, datasetId: string): void {
    const cur = this.currentIndex(id);
    if (!cur) return;
    const layer = cur.layer;
    const changes: Change[] = [{ path: ['datasetId'], value: datasetId || null }];
    const summary = datasetId ? this.deps.summary(datasetId) : null;
    if (summary) {
      const times = timeColumns(summary).map((c) => c.name);
      let timeColumn = layer.timeColumn;
      if (timeColumn !== null && !times.includes(timeColumn)) timeColumn = times[0] ?? null;
      if (timeColumn === null && layer.xMode === 'time') timeColumn = times[0] ?? null;
      if (timeColumn !== layer.timeColumn) changes.push({ path: ['timeColumn'], value: timeColumn });
      if (layer.xMode === 'time' && timeColumn === null) changes.push({ path: ['xMode'], value: 'index' });
      const names = new Set(summary.columns.filter((c) => !c.empty).map((c) => c.name));
      for (const ch of [...NUMERIC_CHANNELS, 'colour'] as const) {
        const col = layer.channels[ch].column;
        if (col !== null && !names.has(col)) {
          changes.push({ path: ['channels', ch, 'column'], value: null }, { path: ['channels', ch, 'domain'], value: null });
        }
      }
    }
    this.send(id, changes);
  }

  // ---- building a layer's folder -------------------------------------------------------

  private folderIn(entry: Entry, parent: FolderApi, title: string, key: string, def: boolean, index?: number): FolderApi {
    const expanded = this.expanded.get(key) ?? def;
    const api = parent.addFolder(index === undefined ? { title, expanded } : { title, expanded, index });
    entry.folders.push({ key, api });
    return api;
  }

  private build(doc: SyncDoc, layer: InstancerLayer, position: number, count: number): void {
    const id = layer.id;
    const summary = this.summaryFor(layer);
    const dataset = doc.project.datasets.find((d) => d.id === layer.datasetId);
    const entry: Entry = { layer, summary, folder: null as unknown as FolderApi, folders: [], forceRebuild: false, marks: [] };
    // Child 0 of the Layers folder is the "Add layer" button.
    entry.folder = this.folderIn(entry, this.root, this.titleOf(layer), `${id}/`, false, position + 1);
    this.entries.set(id, entry);
    this.quiet(() => {
      this.buildGeneral(entry, doc, layer, summary);
      this.buildLayout(entry, layer, summary !== null && dataset !== undefined);
      this.buildLook(entry, layer);
      this.buildChannels(entry, layer, summary);
      this.buildActions(entry, layer, position, count);
    });
    this.applyMarks(entry, doc);
  }

  private buildGeneral(entry: Entry, doc: SyncDoc, layer: InstancerLayer, summary: DatasetSummary | null): void {
    const id = layer.id;
    const f = this.folderIn(entry, entry.folder, 'General', `${id}/General`, true);
    const m = {
      name: layer.name,
      enabled: layer.enabled,
      dataset: layer.datasetId ?? '',
      primitive: layer.primitive,
      xMode: layer.xMode,
      timeColumn: layer.timeColumn ?? '',
      rowStart: layer.rows[0],
      rowEnd: layer.rows[1],
      followRange: layer.followRange,
      arrangement: layer.arrangement,
    };

    f.addBinding(m, 'name').on('change', (ev) => {
      this.set(id, ['name'], ev.value);
      entry.folder.title = this.titleOf({ ...entry.layer, name: ev.value });
    });
    f.addBinding(m, 'enabled').on('change', (ev) => {
      this.set(id, ['enabled'], ev.value);
      entry.folder.title = this.titleOf({ ...entry.layer, enabled: ev.value });
    });

    const dsOptions: { text: string; value: string }[] = doc.project.datasets.map((d) => ({ text: d.label || d.file, value: d.id }));
    if (!doc.project.datasets.some((d) => d.id === layer.datasetId)) {
      dsOptions.unshift({ text: layer.datasetId === null ? '(none)' : `${layer.datasetId} (missing)`, value: m.dataset });
    }
    f.addBinding(m, 'dataset', { options: dsOptions }).on('change', (ev) => this.changeDataset(id, ev.value));

    f.addBinding(m, 'primitive', { options: options(PRIMITIVES) }).on('change', (ev) => this.set(id, ['primitive'], ev.value));
    f.addBinding(m, 'xMode', { label: 'x mode', options: options(X_MODES) }).on('change', (ev) => this.set(id, ['xMode'], ev.value));

    if (summary) {
      f.addBinding(m, 'timeColumn', { label: 'time column', options: columnOptions(timeColumns(summary), layer.timeColumn) }).on(
        'change',
        (ev) => this.set(id, ['timeColumn'], ev.value || null),
      );
    } else {
      f.addButton({ title: 'Waiting for data…', label: 'time column', disabled: true });
    }

    const start = this.mark(entry, f.addBinding(m, 'rowStart', { label: 'rows start', min: 0, max: 1, step: 0.001 }), 'rows start', 'rows.0');
    const end = this.mark(entry, f.addBinding(m, 'rowEnd', { label: 'rows end', min: 0, max: 1, step: 0.001 }), 'rows end', 'rows.1');
    const MIN_GAP = 0.001;
    const sendRows = (moved: 'start' | 'end') => {
      if (this.quietDepth > 0) return;
      // Keep start < end by pushing the other handle along.
      if (m.rowStart > m.rowEnd - MIN_GAP) {
        if (moved === 'start') {
          m.rowEnd = Math.min(1, m.rowStart + MIN_GAP);
          m.rowStart = Math.min(m.rowStart, m.rowEnd - MIN_GAP);
        } else {
          m.rowStart = Math.max(0, m.rowEnd - MIN_GAP);
          m.rowEnd = Math.max(m.rowEnd, m.rowStart + MIN_GAP);
        }
        this.quiet(() => {
          start.refresh();
          end.refresh();
        });
      }
      this.set(id, ['rows'], [m.rowStart, m.rowEnd]);
    };
    start.on('change', () => sendRows('start'));
    end.on('change', () => sendRows('end'));

    f.addBinding(m, 'followRange', { label: 'follow range' }).on('change', (ev) => this.set(id, ['followRange'], ev.value));
    f.addBinding(m, 'arrangement', { options: options(ARRANGEMENTS) }).on('change', (ev) => this.set(id, ['arrangement'], ev.value));
  }

  private buildLayout(entry: Entry, layer: InstancerLayer, canFit: boolean): void {
    const id = layer.id;
    const f = this.folderIn(entry, entry.folder, 'Layout', `${id}/Layout`, false);
    const m = {
      origin: vec3Obj(layer.origin),
      step: vec3Obj(layer.step),
      gridColumns: layer.gridColumns,
      cellW: layer.cell[0],
      cellH: layer.cell[1],
      radius: layer.radius,
      angleStep: layer.angleStep,
      radiusStep: layer.radiusStep,
    };
    const a: Arrangement = layer.arrangement;
    const radial = a === 'radial' || a === 'spiral';
    const cells = a === 'grid' || a === 'calendar';

    const originLabel = radial ? 'centre' : cells ? 'top-left' : 'origin';
    const xyz = (field: string) => [0, 1, 2].map((i) => `${field}.${i}`);
    this.mark(
      entry,
      f.addBinding(m, 'origin', { label: originLabel, format: fmt }).on('change', (ev) => this.set(id, ['origin'], [ev.value.x, ev.value.y, ev.value.z])),
      originLabel,
      ...xyz('origin'),
    );
    const bindings: { api: BladeApi; show: boolean }[] = [];
    const add = (api: BladeApi, show: boolean) => bindings.push({ api, show });

    add(
      this.mark(
        entry,
        f.addBinding(m, 'step', { label: 'step', format: fmt }).on('change', (ev) => this.set(id, ['step'], [ev.value.x, ev.value.y, ev.value.z])),
        'step',
        ...xyz('step'),
      ),
      a === 'linear',
    );
    add(
      this.mark(
        entry,
        f.addBinding(m, 'gridColumns', { label: 'grid columns', min: 1, step: 1 }).on('change', (ev) =>
          this.set(id, ['gridColumns'], Math.max(1, Math.round(ev.value))),
        ),
        'grid columns',
        'gridColumns',
      ),
      a === 'grid',
    );
    const sendCell = () => this.set(id, ['cell'], [m.cellW, m.cellH]);
    add(this.mark(entry, f.addBinding(m, 'cellW', { label: 'cell w', format: fmt }).on('change', sendCell), 'cell w', 'cell.0'), cells);
    add(this.mark(entry, f.addBinding(m, 'cellH', { label: 'cell h', format: fmt }).on('change', sendCell), 'cell h', 'cell.1'), cells);
    add(
      this.mark(entry, f.addBinding(m, 'radius', { label: 'radius', format: fmt }).on('change', (ev) => this.set(id, ['radius'], ev.value)), 'radius', 'radius'),
      radial,
    );
    add(
      this.mark(
        entry,
        f.addBinding(m, 'angleStep', { label: 'angle step', format: fmt }).on('change', (ev) => this.set(id, ['angleStep'], ev.value)),
        'angle step',
        'angleStep',
      ),
      radial,
    );
    add(
      this.mark(
        entry,
        f.addBinding(m, 'radiusStep', { label: 'radius step', format: fmt }).on('change', (ev) => this.set(id, ['radiusStep'], ev.value)),
        'radius step',
        'radiusStep',
      ),
      a === 'spiral',
    );
    for (const b of bindings) b.api.hidden = !b.show;

    f.addButton({ title: canFit ? 'Fit to output' : 'Fit to output (waiting for data)', disabled: !canFit }).on('click', () => this.fit(id));
  }

  private buildLook(entry: Entry, layer: InstancerLayer): void {
    const id = layer.id;
    const f = this.folderIn(entry, entry.folder, 'Look', `${id}/Look`, false);
    const m = {
      size: vec3Obj(layer.size),
      heightAxis: layer.heightAxis,
      colour: layer.colour,
      opacity: layer.opacity,
      blend: layer.blend,
    };
    this.mark(
      entry,
      f.addBinding(m, 'size', { label: 'size', format: fmt }).on('change', (ev) => this.set(id, ['size'], [ev.value.x, ev.value.y, ev.value.z])),
      'size',
      'size.0',
      'size.1',
      'size.2',
    );
    f.addBinding(m, 'heightAxis', {
      label: 'height along',
      options: { 'y (up the frame)': 'y', 'z (out of the frame)': 'z' },
    }).on('change', (ev) => this.set(id, ['heightAxis'], ev.value));
    f.addBinding(m, 'colour').on('change', (ev) => this.set(id, ['colour'], ev.value));
    this.mark(
      entry,
      f.addBinding(m, 'opacity', { label: 'opacity', min: 0, max: 1, step: 0.01 }).on('change', (ev) => this.set(id, ['opacity'], ev.value)),
      'opacity',
      'opacity',
    );
    f.addBinding(m, 'blend', { options: options(BLEND_MODES) }).on('change', (ev) => this.set(id, ['blend'], ev.value));
  }

  private buildChannels(entry: Entry, layer: InstancerLayer, summary: DatasetSummary | null): void {
    const id = layer.id;
    const f = this.folderIn(entry, entry.folder, 'Channels', `${id}/Channels`, false);
    if (!summary) {
      f.addButton({ title: 'Waiting for data…', disabled: true });
      return;
    }
    const usable = summary.columns.filter((c) => !c.empty);
    const numeric = usable.filter((c) => c.type === 'number' || c.type === 'time');
    const forColour = usable.filter((c) => c.type === 'number' || c.type === 'time' || c.type === 'category');
    for (const ch of NUMERIC_CHANNELS) this.buildChannel(entry, f, layer, ch, numeric);
    this.buildChannel(entry, f, layer, 'colour', forColour);
  }

  private buildChannel(entry: Entry, parent: FolderApi, layer: InstancerLayer, ch: NumericChannel | 'colour', columns: SummaryColumn[]): void {
    const id = layer.id;
    const f = this.folderIn(entry, parent, CHANNEL_TITLES[ch], `${id}/Channels/${ch}`, false);
    const mapping = layer.channels[ch];
    const colOf = (name: string) => columns.find((c) => c.name === name);
    const [d0, d1] = mapping.domain ?? initialDomain(mapping.column === null ? undefined : colOf(mapping.column));
    const m = {
      column: mapping.column ?? '',
      scale: mapping.scale,
      auto: mapping.domain === null,
      domainMin: d0,
      domainMax: d1,
      steps: mapping.steps,
    };
    const path = (k: string): Path => ['channels', ch, k];

    const resetDomain = () => {
      [m.domainMin, m.domainMax] = initialDomain(m.column ? colOf(m.column) : undefined);
      this.quiet(() => {
        domainMin.refresh();
        domainMax.refresh();
      });
    };
    const showDomain = () => {
      domainMin.hidden = m.auto;
      domainMax.hidden = m.auto;
    };
    const sendDomain = () => this.set(id, path('domain'), [m.domainMin, m.domainMax]);

    f.addBinding(m, 'column', { options: columnOptions(columns, mapping.column) }).on('change', (ev) => {
      const changes: Change[] = [{ path: path('column'), value: ev.value || null }];
      // Auto domain stays null; a manual domain is re-seeded from the new column's range.
      if (!m.auto) {
        resetDomain();
        changes.push({ path: path('domain'), value: [m.domainMin, m.domainMax] });
      }
      this.send(id, changes);
    });
    f.addBinding(m, 'scale', { options: options(SCALE_TYPES) }).on('change', (ev) => {
      steps.hidden = ev.value !== 'quantise';
      this.set(id, path('scale'), ev.value);
    });
    f.addBinding(m, 'auto', { label: 'auto domain' }).on('change', (ev) => {
      if (ev.value) {
        this.set(id, path('domain'), null);
      } else {
        resetDomain();
        sendDomain();
      }
      showDomain();
    });
    const chPrefix = `channels.${ch}`;
    const domainMin = this.mark(
      entry,
      f.addBinding(m, 'domainMin', { label: 'domain min', format: fmt }).on('change', sendDomain),
      'domain min',
      `${chPrefix}.domain.0`,
    );
    const domainMax = this.mark(
      entry,
      f.addBinding(m, 'domainMax', { label: 'domain max', format: fmt }).on('change', sendDomain),
      'domain max',
      `${chPrefix}.domain.1`,
    );
    showDomain();

    let clampModel: { clamp: boolean } | null = null;
    if (ch === 'colour') {
      const cm = layer.channels.colour;
      const c = { ramp: cm.ramp, reverse: cm.reverse };
      f.addBinding(c, 'ramp', { options: options(COLOUR_RAMPS) }).on('change', (ev) => this.set(id, path('ramp'), ev.value));
      f.addBinding(c, 'reverse').on('change', (ev) => this.set(id, path('reverse'), ev.value));
    } else {
      const nm = layer.channels[ch];
      const r = { rangeMin: nm.range[0], rangeMax: nm.range[1] };
      const sendRange = () => this.set(id, path('range'), [r.rangeMin, r.rangeMax]);
      this.mark(entry, f.addBinding(r, 'rangeMin', { label: 'range min', format: fmt }).on('change', sendRange), 'range min', `${chPrefix}.range.0`);
      this.mark(entry, f.addBinding(r, 'rangeMax', { label: 'range max', format: fmt }).on('change', sendRange), 'range max', `${chPrefix}.range.1`);
      clampModel = { clamp: nm.clamp };
    }

    const steps = f.addBinding(m, 'steps', { min: 2, max: 64, step: 1 });
    steps.hidden = m.scale !== 'quantise';
    steps.on('change', (ev) => this.set(id, path('steps'), Math.min(64, Math.max(2, Math.round(ev.value)))));

    // The colour mapping has no clamp field in the schema.
    if (clampModel) f.addBinding(clampModel, 'clamp').on('change', (ev) => this.set(id, path('clamp'), ev.value));
  }

  private buildActions(entry: Entry, layer: InstancerLayer, position: number, count: number): void {
    const id = layer.id;
    const f = entry.folder;
    f.addBlade({ view: 'separator' });
    f.addButton({ title: 'Move up', disabled: position <= 0 }).on('click', () => this.move(id, -1));
    f.addButton({ title: 'Move down', disabled: position >= count - 1 }).on('click', () => this.move(id, 1));
    f.addButton({ title: 'Duplicate' }).on('click', () => this.duplicate(id));
    f.addButton({ title: 'Delete' }).on('click', () => this.remove(id));
  }
}
