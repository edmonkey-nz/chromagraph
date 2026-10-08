import type { BladeApi, FolderApi, ListParamsOptions } from 'tweakpane';
import { timeColumns, type DatasetSummary, type SummaryColumn } from '../../shared/layer-defaults.ts';
import type { LayerChange } from '../../shared/layer-helpers.ts';
import {
  BLEND_MODES,
  COLOUR_RAMPS,
  FRAME_CENTRE,
  identityTransform,
  SCALE_TYPES,
  type ColourMapping,
  type LayerConfig,
  type LayerTransform,
  type Mapping,
} from '../../shared/layer-schema.ts';
import type { Path } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';

/**
 * Building blocks shared by the per-type layer folders (instancer-folders.ts,
 * line-folders.ts, heatmap-folders.ts, text-folders.ts). Each folder builder gets a `LayerUi`
 * for one layer: it sends minimal, validated `set` patches through it and registers the
 * modulatable fields so the panel can mark them " ~".
 */

/** Any binding: only its label is touched. */
export interface Labelled {
  label: string | null | undefined;
}

export interface Mark {
  api: Labelled;
  label: string;
  /** Parameter ids relative to the layer prefix, e.g. "rows.0". */
  fields: string[];
}

export interface Entry {
  /** The layer config the folder was last built from or reconciled with. */
  layer: LayerConfig;
  summary: DatasetSummary | null;
  folder: FolderApi;
  /** Every folder in this layer's tree, so expanded state survives a rebuild. */
  folders: { key: string; api: FolderApi }[];
  /** Rebuild on the next echo of our own patch (after a multi-field edit such as Fit). */
  forceRebuild: boolean;
  /** Bindings of modulatable fields, with their plain label and parameter id suffixes. */
  marks: Mark[];
  /** Show a new transform in the Transform folder without rebuilding (skips fields being edited). */
  showTransform: ((t: LayerTransform) => void) | null;
  /** Recompute the cloner's instance readout (instancers only). */
  refreshReadout: (() => void) | null;
  /** Show a new title on the layer's card. */
  retitle(title: string): void;
}

/** What a folder builder can do for its layer. */
export interface LayerUi {
  readonly id: string;
  readonly entry: Entry;
  readonly doc: SyncDoc;
  readonly summary: DatasetSummary | null;
  /** True when Fit to output can run (data layers need a parsed dataset). */
  readonly canFit: boolean;
  /** A sub-folder whose expanded state is kept under `key` (relative to the layer). */
  folder(parent: FolderApi, title: string, key: string, expanded: boolean): FolderApi;
  /** Send one field change (validated first; ignored while the panel writes its own bindings). */
  set(path: Path, value: unknown): void;
  /** Send several field changes in one patch. True if sent. */
  send(changes: LayerChange[]): boolean;
  /** Register a binding of modulatable fields (parameter id suffixes) for the " ~" mark. */
  mark<T extends Labelled>(api: T, label: string, ...fields: string[]): T;
  /** Run `fn` with change events suppressed. */
  quiet(fn: () => void): void;
  /** True while the panel is writing into its own bindings. */
  isQuiet(): boolean;
  fit(): void;
  changeDataset(datasetId: string | null): void;
  /** Instances drawn by all enabled layers (for the budget readouts; see instanceCount). */
  instanceTotal(): number;
  /** The current synced document (read at click time, e.g. for the project's background). */
  getDoc(): SyncDoc | null;
}

export type Vec3Obj = { x: number; y: number; z: number };

export const vec3Obj = (t: readonly [number, number, number]): Vec3Obj => ({ x: t[0], y: t[1], z: t[2] });
export const vec3Tuple = (v: Vec3Obj): [number, number, number] => [v.x, v.y, v.z];
export const xyz = (field: string): string[] => [0, 1, 2].map((i) => `${field}.${i}`);

/** Compact number display: whole numbers for big values, a few decimals for small ones. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1 || a === 0) return String(Number(v.toFixed(3)));
  return String(Number(v.toPrecision(3)));
}

export function options<T extends string>(values: readonly T[]): ListParamsOptions<T> {
  return values.map((v) => ({ text: v, value: v }));
}

export function columnOptions(columns: SummaryColumn[], current: string | null): ListParamsOptions<string> {
  const list: { text: string; value: string }[] = [{ text: 'none', value: '' }];
  for (const c of columns) list.push({ text: c.name, value: c.name });
  if (current !== null && !columns.some((c) => c.name === current)) list.push({ text: `${current} (missing)`, value: current });
  return list;
}

/** Domain for a column when the user switches auto domain off. */
export function initialDomain(col: SummaryColumn | undefined): [number, number] {
  if (col && Number.isFinite(col.min) && Number.isFinite(col.max)) {
    return col.max > col.min ? [col.min, col.max] : [col.min, col.min + 1];
  }
  return [0, 1];
}

/** Columns usable as numeric values (numbers and times), and for colour (plus categories). */
export function numericColumns(summary: DatasetSummary): SummaryColumn[] {
  return summary.columns.filter((c) => !c.empty && (c.type === 'number' || c.type === 'time'));
}

export function colourColumns(summary: DatasetSummary): SummaryColumn[] {
  return summary.columns.filter((c) => !c.empty && (c.type === 'number' || c.type === 'time' || c.type === 'category'));
}

/** True while the user is typing in one of the binding's text boxes. */
export function editingText(api: BladeApi): boolean {
  const a = document.activeElement;
  return (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && api.element.contains(a);
}

// ---- common fields ---------------------------------------------------------------------

/** Name, enabled and dataset. `allowNone` offers "(none)" as a dataset (text layers). */
export function addIdentity(ui: LayerUi, f: FolderApi, layer: LayerConfig, titleOf: (l: LayerConfig) => string, allowNone = false): void {
  const m = { name: layer.name, enabled: layer.enabled, dataset: layer.datasetId ?? '' };
  f.addBinding(m, 'name').on('change', (ev) => {
    ui.set(['name'], ev.value);
    ui.entry.retitle(titleOf({ ...ui.entry.layer, name: ev.value }));
  });
  f.addBinding(m, 'enabled').on('change', (ev) => {
    ui.set(['enabled'], ev.value);
    ui.entry.retitle(titleOf({ ...ui.entry.layer, enabled: ev.value }));
  });
  const datasets = ui.doc.project.datasets;
  const dsOptions: { text: string; value: string }[] = datasets.map((d) => ({ text: d.label || d.file, value: d.id }));
  if (allowNone) dsOptions.unshift({ text: '(none)', value: '' });
  if (!datasets.some((d) => d.id === layer.datasetId) && !(allowNone && layer.datasetId === null)) {
    dsOptions.unshift({ text: layer.datasetId === null ? '(none)' : `${layer.datasetId} (missing)`, value: m.dataset });
  }
  f.addBinding(m, 'dataset', { options: dsOptions }).on('change', (ev) => ui.changeDataset(ev.value || null));
}

/** Time column picker (or a placeholder while the dataset parses). */
export function addTimeColumn(ui: LayerUi, f: FolderApi, current: string | null): BladeApi {
  if (!ui.summary) return f.addButton({ title: 'Waiting for data…', label: 'time column', disabled: true });
  const m = { timeColumn: current ?? '' };
  return f
    .addBinding(m, 'timeColumn', { label: 'time column', options: columnOptions(timeColumns(ui.summary), current) })
    .on('change', (ev) => ui.set(['timeColumn'], ev.value || null));
}

/** Rows start/end sliders that keep start < end by pushing the other handle along. */
export function addRows(ui: LayerUi, f: FolderApi, rows: readonly [number, number]): void {
  const m = { rowStart: rows[0], rowEnd: rows[1] };
  const start = ui.mark(f.addBinding(m, 'rowStart', { label: 'rows start', min: 0, max: 1, step: 0.001 }), 'rows start', 'rows.0');
  const end = ui.mark(f.addBinding(m, 'rowEnd', { label: 'rows end', min: 0, max: 1, step: 0.001 }), 'rows end', 'rows.1');
  const MIN_GAP = 0.001;
  const sendRows = (moved: 'start' | 'end') => {
    if (ui.isQuiet()) return;
    if (m.rowStart > m.rowEnd - MIN_GAP) {
      if (moved === 'start') {
        m.rowEnd = Math.min(1, m.rowStart + MIN_GAP);
        m.rowStart = Math.min(m.rowStart, m.rowEnd - MIN_GAP);
      } else {
        m.rowStart = Math.max(0, m.rowEnd - MIN_GAP);
        m.rowEnd = Math.max(m.rowEnd, m.rowStart + MIN_GAP);
      }
      ui.quiet(() => {
        start.refresh();
        end.refresh();
      });
    }
    ui.set(['rows'], [m.rowStart, m.rowEnd]);
  };
  start.on('change', () => sendRows('start'));
  end.on('change', () => sendRows('end'));
}

/** A modulatable x/y/z field bound to a vec3 at `path` (parameter ids `<field>.0..2`). */
export function addVec3(ui: LayerUi, f: FolderApi, value: readonly [number, number, number], label: string, path: Path, field: string) {
  const m = { v: vec3Obj(value) };
  return ui.mark(
    f.addBinding(m, 'v', { label, format: fmt }).on('change', (ev) => ui.set(path, vec3Tuple(ev.value))),
    label,
    ...xyz(field),
  );
}

/** Layer opacity (modulatable) and blend mode. */
export function addOpacityBlend(ui: LayerUi, f: FolderApi, layer: LayerConfig): void {
  const m = { opacity: layer.opacity, blend: layer.blend };
  ui.mark(
    f.addBinding(m, 'opacity', { label: 'opacity', min: 0, max: 1, step: 0.01 }).on('change', (ev) => ui.set(['opacity'], ev.value)),
    'opacity',
    'opacity',
  );
  f.addBinding(m, 'blend', { options: options(BLEND_MODES) }).on('change', (ev) => ui.set(['blend'], ev.value));
}

export function addFitButton(ui: LayerUi, f: FolderApi): void {
  f.addButton({ title: ui.canFit ? 'Fit to output' : 'Fit to output (waiting for data)', disabled: !ui.canFit }).on('click', () => ui.fit());
}

// ---- plain fields --------------------------------------------------------------------------

export interface NumberOptions {
  /** Slider bounds (both given) or text-box limits. */
  min?: number;
  max?: number;
  step?: number;
  /** Hard limits the sent value is clamped to (the schema's), defaulting to min/max. */
  hardMin?: number;
  hardMax?: number;
  integer?: boolean;
  /** Parameter id suffix, for the " ~" modulation mark. */
  field?: string;
  /** Tooltip. */
  hint?: string;
}

/** A number field at `path`, clamped (and rounded) to its valid range before sending. */
export function addNumber(ui: LayerUi, f: FolderApi, value: number, label: string, path: Path, o: NumberOptions = {}) {
  const m = { v: value };
  const lo = o.hardMin ?? o.min ?? -Infinity;
  const hi = o.hardMax ?? o.max ?? Infinity;
  const params: Record<string, unknown> = { label };
  if (o.min !== undefined) params.min = o.min;
  if (o.max !== undefined) params.max = o.max;
  if (o.step !== undefined) params.step = o.step;
  else if (o.integer) params.step = 1;
  if (o.min === undefined || o.max === undefined) params.format = fmt;
  const api = f.addBinding(m, 'v', params).on('change', (ev) => {
    if (!Number.isFinite(ev.value)) return;
    const v = Math.min(hi, Math.max(lo, o.integer ? Math.round(ev.value) : ev.value));
    ui.set(path, v);
  });
  if (o.hint) api.element.title = o.hint;
  return o.field ? ui.mark(api, label, o.field) : api;
}

/**
 * Two number fields for a 2-tuple at `path` (sent whole), e.g. a size or a min/max pair.
 * `field` is the parameter id prefix, marked as `<field>.0` and `<field>.1`.
 */
export function addPair(
  ui: LayerUi,
  f: FolderApi,
  value: readonly [number, number],
  labels: readonly [string, string],
  path: Path,
  o: Pick<NumberOptions, 'min' | 'max' | 'step' | 'hardMin' | 'field' | 'hint'> = {},
): BladeApi[] {
  const m = { a: value[0], b: value[1] };
  const params: Record<string, unknown> = {};
  if (o.min !== undefined) params.min = o.min;
  if (o.max !== undefined) params.max = o.max;
  if (o.step !== undefined) params.step = o.step;
  if (o.min === undefined || o.max === undefined) params.format = fmt;
  const send = () => {
    if (!Number.isFinite(m.a) || !Number.isFinite(m.b)) return;
    const lo = o.hardMin ?? -Infinity;
    ui.set(path, [Math.max(lo, m.a), Math.max(lo, m.b)]);
  };
  return (['a', 'b'] as const).map((key, i) => {
    const label = labels[i]!;
    const api = f.addBinding(m, key, { ...params, label }).on('change', send);
    if (o.hint) api.element.title = o.hint;
    return o.field ? ui.mark(api, label, `${o.field}.${i}`) : api;
  });
}

/** A list field at `path`; `titles` optionally renames the values shown. */
export function addChoice<T extends string>(
  ui: LayerUi,
  f: FolderApi,
  value: T,
  label: string,
  path: Path,
  values: readonly T[],
  titles: Partial<Record<T, string>> = {},
) {
  const m = { v: value };
  return f
    .addBinding(m, 'v', { label, options: values.map((v) => ({ text: titles[v] ?? v, value: v })) })
    .on('change', (ev) => ui.set(path, ev.value));
}

/** A boolean or #rrggbb colour field at `path`. */
export function addPlain<T extends boolean | string>(ui: LayerUi, f: FolderApi, value: T, label: string, path: Path) {
  const m = { v: value };
  return f.addBinding(m, 'v', { label }).on('change', (ev) => ui.set(path, ev.value));
}

// ---- value column and domain (layers with top-level valueColumn / domain) -------------------

export interface DomainControl {
  /**
   * When the domain is manual, re-seed it from `column`'s range and return the change to send
   * with a value-column switch; null while the domain is auto.
   */
  reseed(column: string | null): LayerChange | null;
}

/** "auto domain" toggle plus manual min/max for the layer's `domain` (parameters domain.0/1). */
export function addDomain(ui: LayerUi, f: FolderApi, domain: readonly [number, number] | null, column: string | null, columns: SummaryColumn[]): DomainControl {
  const colOf = (name: string | null) => (name === null ? undefined : columns.find((c) => c.name === name));
  const [d0, d1] = domain ?? initialDomain(colOf(column));
  const m = { auto: domain === null, domainMin: d0, domainMax: d1 };
  let current = column;
  const sendDomain = () => ui.set(['domain'], [m.domainMin, m.domainMax]);
  const reset = () => {
    [m.domainMin, m.domainMax] = initialDomain(colOf(current));
    ui.quiet(() => {
      min.refresh();
      max.refresh();
    });
  };
  const show = () => {
    min.hidden = m.auto;
    max.hidden = m.auto;
  };
  f.addBinding(m, 'auto', { label: 'auto domain' }).on('change', (ev) => {
    if (ev.value) {
      ui.set(['domain'], null);
    } else {
      reset();
      sendDomain();
    }
    show();
  }).element.title = 'Auto: the value column’s min..max. Off: set the domain by hand (and modulate it).';
  const min = ui.mark(f.addBinding(m, 'domainMin', { label: 'domain min', format: fmt }).on('change', sendDomain), 'domain min', 'domain.0');
  const max = ui.mark(f.addBinding(m, 'domainMax', { label: 'domain max', format: fmt }).on('change', sendDomain), 'domain max', 'domain.1');
  show();
  return {
    reseed(next) {
      current = next;
      if (m.auto) return null;
      reset();
      return { path: ['domain'], value: [m.domainMin, m.domainMax] };
    },
  };
}

/**
 * Value column picker for `valueColumn` (or a placeholder while the dataset parses). `domain`
 * is read when the column changes, so it may be created after this field.
 */
export function addValueColumn(ui: LayerUi, f: FolderApi, current: string | null, columns: SummaryColumn[], domain: () => DomainControl | null): void {
  if (!ui.summary) {
    f.addButton({ title: 'Waiting for data…', label: 'value', disabled: true });
    return;
  }
  const m = { valueColumn: current ?? '' };
  f.addBinding(m, 'valueColumn', { label: 'value', options: columnOptions(columns, current) }).on('change', (ev) => {
    const column = ev.value || null;
    const changes: LayerChange[] = [{ path: ['valueColumn'], value: column }];
    const reseeded = domain()?.reseed(column);
    if (reseeded) changes.push(reseeded);
    ui.send(changes);
  });
}

/** Scale, ramp and reverse for a layer's top-level colour fields. */
export function addScaleRamp(
  ui: LayerUi,
  f: FolderApi,
  layer: { scale: (typeof SCALE_TYPES)[number]; ramp: (typeof COLOUR_RAMPS)[number]; reverse: boolean; steps: number },
) {
  const scale = addChoice(ui, f, layer.scale, 'scale', ['scale'], SCALE_TYPES);
  const sm = { steps: layer.steps };
  const steps = f.addBinding(sm, 'steps', { min: 2, max: 64, step: 1 });
  steps.hidden = layer.scale !== 'quantise';
  steps.on('change', (ev) => ui.set(['steps'], Math.min(64, Math.max(2, Math.round(ev.value)))));
  scale.on('change', (ev) => {
    steps.hidden = ev.value !== 'quantise';
  });
  const ramp = addChoice(ui, f, layer.ramp, 'ramp', ['ramp'], COLOUR_RAMPS);
  const reverse = addPlain(ui, f, layer.reverse, 'reverse', ['reverse']);
  return { scale, ramp, reverse, steps };
}

// ---- mappings --------------------------------------------------------------------------

/**
 * A mapping folder for a column -> channel mapping at `base` (e.g. ['channels', 'y'] or
 * ['colourMap']): column, scale, auto or manual domain, then range and clamp for numeric
 * mappings or ramp and reverse for colour, and quantise steps.
 */
export function buildMapping(
  ui: LayerUi,
  parent: FolderApi,
  title: string,
  key: string,
  base: Path,
  mapping: Mapping | ColourMapping,
  columns: SummaryColumn[],
): void {
  const f = ui.folder(parent, title, key, false);
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
  const path = (k: string): Path => [...base, k];
  const prefix = base.join('.');

  const resetDomain = () => {
    [m.domainMin, m.domainMax] = initialDomain(m.column ? colOf(m.column) : undefined);
    ui.quiet(() => {
      domainMin.refresh();
      domainMax.refresh();
    });
  };
  const showDomain = () => {
    domainMin.hidden = m.auto;
    domainMax.hidden = m.auto;
  };
  const sendDomain = () => ui.set(path('domain'), [m.domainMin, m.domainMax]);

  f.addBinding(m, 'column', { options: columnOptions(columns, mapping.column) }).on('change', (ev) => {
    const changes: LayerChange[] = [{ path: path('column'), value: ev.value || null }];
    // Auto domain stays null; a manual domain is re-seeded from the new column's range.
    if (!m.auto) {
      resetDomain();
      changes.push({ path: path('domain'), value: [m.domainMin, m.domainMax] });
    }
    ui.send(changes);
  });
  f.addBinding(m, 'scale', { options: options(SCALE_TYPES) }).on('change', (ev) => {
    steps.hidden = ev.value !== 'quantise';
    ui.set(path('scale'), ev.value);
  });
  f.addBinding(m, 'auto', { label: 'auto domain' }).on('change', (ev) => {
    if (ev.value) {
      ui.set(path('domain'), null);
    } else {
      resetDomain();
      sendDomain();
    }
    showDomain();
  });
  const domainMin = ui.mark(f.addBinding(m, 'domainMin', { label: 'domain min', format: fmt }).on('change', sendDomain), 'domain min', `${prefix}.domain.0`);
  const domainMax = ui.mark(f.addBinding(m, 'domainMax', { label: 'domain max', format: fmt }).on('change', sendDomain), 'domain max', `${prefix}.domain.1`);
  showDomain();

  let clampModel: { clamp: boolean } | null = null;
  if ('ramp' in mapping) {
    const c = { ramp: mapping.ramp, reverse: mapping.reverse };
    f.addBinding(c, 'ramp', { options: options(COLOUR_RAMPS) }).on('change', (ev) => ui.set(path('ramp'), ev.value));
    f.addBinding(c, 'reverse').on('change', (ev) => ui.set(path('reverse'), ev.value));
  } else {
    const r = { rangeMin: mapping.range[0], rangeMax: mapping.range[1] };
    const sendRange = () => ui.set(path('range'), [r.rangeMin, r.rangeMax]);
    ui.mark(f.addBinding(r, 'rangeMin', { label: 'range min', format: fmt }).on('change', sendRange), 'range min', `${prefix}.range.0`);
    ui.mark(f.addBinding(r, 'rangeMax', { label: 'range max', format: fmt }).on('change', sendRange), 'range max', `${prefix}.range.1`);
    clampModel = { clamp: mapping.clamp };
  }

  const steps = f.addBinding(m, 'steps', { min: 2, max: 64, step: 1 });
  steps.hidden = m.scale !== 'quantise';
  steps.on('change', (ev) => ui.set(path('steps'), Math.min(64, Math.max(2, Math.round(ev.value)))));

  // Colour mappings have no clamp field in the schema.
  if (clampModel) f.addBinding(clampModel, 'clamp').on('change', (ev) => ui.set(path('clamp'), ev.value));
}

// ---- transform -------------------------------------------------------------------------

/**
 * "Transform" folder (every layer): position, rotation, scale and pivot, plus Reset and
 * Pivot to centre. `entry.showTransform` refreshes the fields in place when the transform
 * changes from elsewhere (the preview gizmo, another window), skipping a field that is being
 * typed in and the whole folder while a pointer drag that started in it is in progress.
 */
export function buildTransform(ui: LayerUi, parent: FolderApi, t: LayerTransform): void {
  const f = ui.folder(parent, 'Transform', 'Transform', false);
  const m = { position: vec3Obj(t.position), rotation: vec3Obj(t.rotation), scale: vec3Obj(t.scale), pivot: vec3Obj(t.pivot) };
  const fields = [
    { key: 'position', label: 'position' },
    { key: 'rotation', label: 'rotation (°)' },
    { key: 'scale', label: 'scale' },
    { key: 'pivot', label: 'pivot' },
  ] as const;
  const apis = fields.map(({ key, label }) => {
    const opts = key === 'scale' ? { label, format: fmt, step: 0.01 } : { label, format: fmt };
    const api = f.addBinding(m, key, opts).on('change', (ev) => ui.set(['transform', key], vec3Tuple(ev.value)));
    return { key, api: ui.mark(api, label, ...xyz(`transform.${key}`)) };
  });
  f.addButton({ title: 'Reset transform' }).on('click', () => ui.set(['transform'], identityTransform()));
  f.addButton({ title: 'Pivot to centre' }).on('click', () => ui.set(['transform', 'pivot'], [...FRAME_CENTRE]));

  let dragging = false;
  f.element.addEventListener('pointerdown', () => (dragging = true));
  const release = () => (dragging = false);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  ui.entry.showTransform = (next) => {
    if (dragging) return;
    ui.quiet(() => {
      for (const { key, api } of apis) {
        if (editingText(api)) continue;
        const v = next[key];
        const cur = m[key];
        if (cur.x === v[0] && cur.y === v[1] && cur.z === v[2]) continue;
        m[key] = vec3Obj(v);
        api.refresh();
      }
    });
  };
}
