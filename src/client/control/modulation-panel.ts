import type { BladeApi, FolderApi, ListParamsOptions } from 'tweakpane';
import {
  addKeyframe,
  dataPlayheadOps,
  defaultModulator,
  formatValue,
  MAX_KEYS,
  MIN_WINDOW,
  modulatedValue,
  orphanParamIds,
  paramTitle,
  PLAYHEAD_MODES,
  playheadKind,
  projectPhase,
  randomSeed,
  removeKeyframe,
  type PlayheadMode,
} from '../../shared/modulation-helpers.ts';
import {
  EASINGS,
  INTERPOLATIONS,
  LFO_SHAPES,
  MODULATOR_KINDS,
  ParameterSchema,
  sortKeys,
  type Modulator,
  type ModulatorKind,
  type Parameter,
} from '../../shared/modulators.ts';
import { parameterDefs, parseParamId, readParam, type ParamDef } from '../../shared/parameters.ts';
import { applyOps, type PatchOp } from '../../shared/patch.ts';
import { ProjectSchema, type SyncDoc } from '../../shared/project-schema.ts';

/**
 * "Modulation" folder of the control pane: add a modulator to any registered parameter,
 * edit or remove it, sweep a layer's rows with the data playhead helper, and clean up
 * modulators whose parameter has gone. Like the layers panel, the GUI holds no
 * authoritative state: every edit is a patch, and the folder is rebuilt from the synced
 * document on structural or remote changes only, so a drag is never interrupted by our
 * own echo.
 */

export interface ModulationPanelDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
  showError(message: string): void;
}

interface Entry {
  id: string;
  def: ParamDef;
  folder: FolderApi;
  /** Editable copy of the modulator; bindings write into it and it is sent whole. */
  model: Modulator;
  monitor: { value: number };
  monitorApi: BladeApi & { refresh(): void };
}

const KIND_TITLES: Record<ModulatorKind, string> = { lfo: 'LFO', noise: 'noise', ramp: 'ramp', keyframes: 'keyframes' };

function options<T extends string>(values: readonly T[]): ListParamsOptions<T> {
  return values.map((v) => ({ text: v, value: v }));
}

/** Slider range for a value field: the parameter's UI range, widened to include `values`. */
function valueRange(def: ParamDef, values: number[]): { min: number; max: number; step?: number } {
  const finite = values.filter(Number.isFinite);
  const r = { min: Math.min(def.min, ...finite), max: Math.max(def.max, ...finite) };
  return def.integer ? { ...r, step: 1 } : r;
}

/** Readable name for an orphaned parameter id: "deleted layer · opacity", "Rain · channels.y.range.0, unmapped". */
function orphanLabel(doc: SyncDoc, id: string): string {
  const target = parseParamId(id);
  if (target?.kind !== 'layer') return id;
  const field = target.path.join('.');
  const layer = doc.project.layers.find((l) => l.id === target.layerId);
  if (!layer) return `deleted layer · ${field}`;
  return `${layer.name || layer.id} · ${field}${field.startsWith('channels.') ? ', unmapped' : ''}`;
}

/** Changes that need the folders rebuilt even for our own echo (bindings no longer match). */
function shapeKey(m: Modulator): string {
  return m.kind === 'keyframes' ? `keyframes:${m.keys.length}` : m.kind;
}

export class ModulationPanel {
  private root: FolderApi;
  private entries = new Map<string, Entry>();
  /** Folder expanded state by key, kept across rebuilds. */
  private expanded = new Map<string, boolean>();
  private folders: { key: string; api: FolderApi }[] = [];
  private builtKey: string | null = null;
  private builtShapes = new Map<string, string>();
  private builtParams: SyncDoc['project']['parameters'] | null = null;
  /** Selections in the helper sections, kept across rebuilds. */
  private addModel = { param: '', kind: 'lfo' as ModulatorKind };
  private playheadModel = { layer: '', mode: 'reveal' as PlayheadMode, width: 0.1 };
  private quietDepth = 0;

  constructor(parent: FolderApi, private deps: ModulationPanelDeps) {
    this.root = parent.addFolder({ title: 'Modulation', expanded: false });
  }

  // ---- reconciling with the synced document ------------------------------------------------

  update(doc: SyncDoc, external: boolean): void {
    const project = doc.project;
    const defs = parameterDefs(project);
    const params = project.parameters;
    const key = [
      defs.map((d) => `${d.id}\u0001${d.group}\u0001${d.label}`).join('\u0002'),
      Object.keys(params).sort().join('\u0002'),
      project.layers.map((l) => `${l.id}\u0001${l.name}`).join('\u0002'),
    ].join('\u0003');
    const shapesChanged = Object.entries(params).some(([id, p]) => this.builtShapes.get(id) !== shapeKey(p.modulator));
    if (key !== this.builtKey || shapesChanged || (external && params !== this.builtParams)) {
      this.rebuild(doc, defs, key);
    }
    this.builtParams = params;
  }

  /** Refresh the live value monitors (call about 10 times a second). Sends nothing. */
  tick(nowMs: number): void {
    const doc = this.deps.getDoc();
    if (!doc || this.entries.size === 0) return;
    const phase = projectPhase(doc.project, doc.session.transport, nowMs);
    this.quiet(() => {
      for (const e of this.entries.values()) {
        const p = doc.project.parameters[e.id];
        if (!p) continue;
        const base = readParam(doc.project, e.id) ?? e.def.min;
        e.monitor.value = modulatedValue(e.def, p.modulator, base, nowMs, phase);
        e.monitorApi.refresh();
      }
    });
  }

  private rebuildFromDoc(): void {
    const doc = this.deps.getDoc();
    if (doc) this.rebuild(doc, parameterDefs(doc.project), null);
  }

  private rebuild(doc: SyncDoc, defs: ParamDef[], key: string | null): void {
    for (const f of this.folders) this.expanded.set(f.key, f.api.expanded);
    for (const child of [...this.root.children]) child.dispose();
    this.folders = [];
    this.entries.clear();
    this.builtShapes.clear();
    this.builtKey = key;
    this.builtParams = doc.project.parameters;

    const params = doc.project.parameters;
    this.quiet(() => {
      this.buildAdd(doc, defs);
      this.buildPlayhead(doc);
      for (const def of defs) {
        const p = params[def.id];
        if (p) this.buildEntry(doc, def, p.modulator);
      }
      this.buildOrphans(doc, defs);
    });
    for (const [id, p] of Object.entries(params)) this.builtShapes.set(id, shapeKey(p.modulator));
  }

  private folder(parent: FolderApi, title: string, key: string, def: boolean): FolderApi {
    const api = parent.addFolder({ title, expanded: this.expanded.get(key) ?? def });
    this.folders.push({ key, api });
    return api;
  }

  private quiet(fn: () => void): void {
    this.quietDepth++;
    try {
      fn();
    } finally {
      this.quietDepth--;
    }
  }

  // ---- sending ----------------------------------------------------------------------------

  /** Validate against the project schema locally, then send; on failure, report and resync the GUI. */
  private sendChecked(ops: PatchOp[], what: string): boolean {
    const doc = this.deps.getDoc();
    if (!doc) return false;
    let message: string | null = null;
    try {
      const r = ProjectSchema.safeParse(applyOps(doc, ops).project);
      if (!r.success) {
        const issue = r.error.issues[0];
        message = `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid value'}`;
      }
    } catch (err) {
      message = String(err);
    }
    if (message !== null) {
      this.deps.showError(`${what} not sent (${message}).`);
      queueMicrotask(() => this.rebuildFromDoc());
      return false;
    }
    this.deps.sendPatch(ops);
    return true;
  }

  /** Send an edited modulator for a parameter that still has one. */
  private sendModulator(id: string, m: Modulator): void {
    if (this.quietDepth > 0) return;
    const doc = this.deps.getDoc();
    if (!doc?.project.parameters[id]) return; // removed elsewhere meanwhile: don't resurrect it
    const value: Parameter = { modulator: m.kind === 'keyframes' ? { ...m, keys: sortKeys(m.keys).map((k) => ({ at: k.at, value: k.value })) } : { ...m } };
    const parsed = ParameterSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.deps.showError(`Modulator change not sent (${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid value'}).`);
      queueMicrotask(() => this.rebuildFromDoc());
      return;
    }
    this.deps.sendPatch([{ op: 'set', path: ['project', 'parameters', id], value: parsed.data }]);
  }

  private addModulator(): void {
    const doc = this.deps.getDoc();
    if (!doc) return;
    const id = this.addModel.param;
    const def = parameterDefs(doc.project).find((d) => d.id === id);
    if (!def || doc.project.parameters[id]) return;
    const base = readParam(doc.project, id) ?? def.min;
    const value: Parameter = { modulator: defaultModulator(this.addModel.kind, def, base) };
    this.expanded.set(`mod/${id}`, true);
    this.sendChecked([{ op: 'set', path: ['project', 'parameters', id], value }], 'New modulator');
  }

  private replaceKind(e: Entry, kind: ModulatorKind): void {
    if (this.quietDepth > 0) return;
    const doc = this.deps.getDoc();
    if (!doc?.project.parameters[e.id]) return;
    const base = readParam(doc.project, e.id) ?? e.def.min;
    this.sendModulator(e.id, defaultModulator(kind, e.def, base));
  }

  private removeModulator(id: string): void {
    this.deps.sendPatch([{ op: 'remove', path: ['project', 'parameters', id] }]);
  }

  private createPlayhead(): void {
    const doc = this.deps.getDoc();
    if (!doc) return;
    const { layer, mode, width } = this.playheadModel;
    const ops = dataPlayheadOps(doc.project, layer, mode, width);
    if (!ops) {
      this.deps.showError('Pick a layer for the data playhead.');
      return;
    }
    const target = doc.project.layers.find((l) => l.id === layer);
    if (target && playheadKind(target) === 'row') {
      this.expanded.set(`mod/layer.${layer}.row`, true);
    } else {
      this.expanded.set(`mod/layer.${layer}.rows.1`, true);
      if (mode === 'window') this.expanded.set(`mod/layer.${layer}.rows.0`, true);
    }
    this.sendChecked(ops, 'Data playhead');
  }

  // ---- building ---------------------------------------------------------------------------

  private buildAdd(doc: SyncDoc, defs: ParamDef[]): void {
    const f = this.folder(this.root, 'Add modulator', 'add', true);
    const free = defs.filter((d) => !doc.project.parameters[d.id]);
    const m = this.addModel;
    if (free.length === 0) {
      f.addButton({ title: 'Every parameter is modulated', disabled: true });
      return;
    }
    if (!free.some((d) => d.id === m.param)) m.param = free[0]!.id;
    f.addBinding(m, 'param', { label: 'parameter', options: free.map((d) => ({ text: paramTitle(d), value: d.id })) });
    f.addBinding(m, 'kind', { options: MODULATOR_KINDS.map((k) => ({ text: KIND_TITLES[k], value: k })) });
    f.addButton({ title: 'Add' }).on('click', () => this.addModulator());
  }

  /**
   * Layers with a row range (instancer, line, heat map, small multiples, hierarchy, 3D
   * surface) get reveal/window sweeps of `rows`; text layers, which show one row, get
   * "Follow playhead" (a 0 -> 1 ramp on `row`).
   */
  private buildPlayhead(doc: SyncDoc): void {
    const f = this.folder(this.root, 'Data playhead', 'playhead', false);
    const layers = doc.project.layers.filter((l) => playheadKind(l) !== null);
    const m = this.playheadModel;
    if (layers.length === 0) {
      f.addButton({ title: 'Add a layer first', disabled: true });
      return;
    }
    if (!layers.some((l) => l.id === m.layer)) m.layer = layers[0]!.id;
    const kindOf = (id: string) => {
      const l = layers.find((x) => x.id === id);
      return l ? playheadKind(l) : 'rows';
    };
    f.addBinding(m, 'layer', {
      options: layers.map((l) => ({ text: `${l.name || l.id}${playheadKind(l) === 'row' ? ' (text)' : ''}`, value: l.id })),
    }).on('change', () => show());
    const mode = f.addBinding(m, 'mode', {
      options: PLAYHEAD_MODES.map((v) => ({ text: v === 'reveal' ? 'reveal (rows grow)' : 'window (rows slide)', value: v })),
    });
    const width = f.addBinding(m, 'width', { label: 'window width', min: MIN_WINDOW, max: 1, step: 0.01 });
    mode.on('change', () => show());
    const create = f.addButton({ title: 'Create' });
    create.on('click', () => this.createPlayhead());
    const show = () => {
      const follow = kindOf(m.layer) === 'row';
      mode.hidden = follow;
      width.hidden = follow || m.mode !== 'window';
      create.title = follow ? 'Follow playhead' : 'Create';
      create.element.title = follow ? 'Ramp the text layer’s row 0 → 1 over the timeline, so it shows the row under the playhead' : '';
    };
    show();
  }

  private titleOf(def: ParamDef, m: Modulator): string {
    return `${paramTitle(def)} (${KIND_TITLES[m.kind]}${m.enabled ? '' : ', off'})`;
  }

  private buildEntry(doc: SyncDoc, def: ParamDef, mod: Modulator): void {
    const id = def.id;
    const model = structuredClone(mod);
    const folder = this.folder(this.root, this.titleOf(def, model), `mod/${id}`, false);
    const monitor = { value: readParam(doc.project, id) ?? def.min };
    const entry: Entry = { id, def, folder, model, monitor, monitorApi: null as unknown as Entry['monitorApi'] };
    this.entries.set(id, entry);
    const send = () => this.sendModulator(id, model);

    folder.addBinding(model, 'enabled').on('change', () => {
      folder.title = this.titleOf(def, model);
      send();
    });
    const kind = { kind: model.kind };
    folder
      .addBinding(kind, 'kind', { options: MODULATOR_KINDS.map((k) => ({ text: KIND_TITLES[k], value: k })) })
      .on('change', (ev) => this.replaceKind(entry, ev.value));

    const span = Math.max(def.max - def.min, 1e-9);
    switch (model.kind) {
      case 'lfo': {
        folder.addBinding(model, 'shape', { options: options(LFO_SHAPES) }).on('change', send);
        folder.addBinding(model, 'period', { label: 'period (s)', min: 0.01, format: formatValue }).on('change', send);
        folder.addBinding(model, 'phase', { label: 'phase offset', min: 0, max: 1, step: 0.01 }).on('change', send);
        const a = Math.max(span, Math.abs(model.amount));
        folder.addBinding(model, 'amount', { min: -a, max: a, format: formatValue }).on('change', send);
        break;
      }
      case 'noise': {
        const a = Math.max(span, Math.abs(model.amount));
        folder.addBinding(model, 'amount', { min: -a, max: a, format: formatValue }).on('change', send);
        folder.addBinding(model, 'speed', { label: 'speed (/s)', min: 0.0001, max: 100, format: formatValue }).on('change', send);
        const seedApi = folder.addBinding(model, 'seed', { step: 1 });
        seedApi.on('change', (ev) => {
          model.seed = Math.round(ev.value);
          send();
        });
        folder.addButton({ title: 'New seed', label: '' }).on('click', () => {
          model.seed = randomSeed();
          this.quiet(() => seedApi.refresh());
          send();
        });
        break;
      }
      case 'ramp': {
        const r = valueRange(def, [model.from, model.to]);
        folder.addBinding(model, 'from', { ...r, label: 'from (phase 0)', format: formatValue }).on('change', send);
        folder.addBinding(model, 'to', { ...r, label: 'to (phase 1)', format: formatValue }).on('change', send);
        folder.addBinding(model, 'easing', { options: options(EASINGS) }).on('change', send);
        break;
      }
      case 'keyframes': {
        folder.addBinding(model, 'interpolation', { options: options(INTERPOLATIONS) }).on('change', send);
        const r = valueRange(def, model.keys.map((k) => k.value));
        const keys = model.keys;
        keys.forEach((k, i) => {
          folder.addBlade({ view: 'separator' });
          folder.addBinding(k, 'at', { label: `key ${i + 1} at`, min: 0, max: 1, step: 0.001 }).on('change', send);
          folder.addBinding(k, 'value', { ...r, label: `key ${i + 1} value`, format: formatValue }).on('change', send);
          folder.addButton({ title: `Remove key ${i + 1}`, label: '', disabled: keys.length <= 1 }).on('click', () => {
            model.keys = removeKeyframe(model.keys, model.keys.indexOf(k));
            send();
          });
        });
        folder.addBlade({ view: 'separator' });
        folder.addButton({ title: 'Add key', disabled: keys.length >= MAX_KEYS }).on('click', () => {
          model.keys = addKeyframe(model.keys);
          send();
        });
        break;
      }
    }

    folder.addBlade({ view: 'separator' });
    entry.monitorApi = folder.addBinding(monitor, 'value', { label: 'value', readonly: true, interval: 0, format: formatValue });
    folder.addButton({ title: 'Remove modulator' }).on('click', () => this.removeModulator(id));
  }

  private buildOrphans(doc: SyncDoc, defs: ParamDef[]): void {
    const orphans = orphanParamIds(doc.project, defs);
    if (orphans.length === 0) return;
    // The folder title is the note; each label says why its parameter is gone.
    const f = this.folder(this.root, `Orphaned (${orphans.length})`, 'orphans', true);
    for (const id of orphans) {
      const kind = doc.project.parameters[id]?.modulator.kind;
      const button = f.addButton({ label: `${orphanLabel(doc, id)}${kind ? ` (${KIND_TITLES[kind]})` : ''}`, title: 'Remove' });
      button.element.title = id;
      button.on('click', () => this.removeModulator(id));
    }
    f.addButton({ title: 'Remove all orphans' }).on('click', () =>
      this.deps.sendPatch(orphans.map((id) => ({ op: 'remove', path: ['project', 'parameters', id] }))),
    );
  }
}
