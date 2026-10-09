import type { Object3D } from 'three';
import { heatmapStructureKey } from '../../data/heatmap-data.ts';
import { hierarchyStructureKey } from '../../data/hierarchy-data.ts';
import { structureKey } from '../../data/instance-data.ts';
import { lineStructureKey } from '../../data/line-data.ts';
import { multiplesStructureKey } from '../../data/multiples-data.ts';
import { surfaceStructureKey } from '../../data/surface-data.ts';
import type { LayerConfig, LayerType } from '../../shared/layer-schema.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';
import type { DatasetStore, LoadedDataset } from './datasets.ts';
import { createHeatmap } from './layers/heatmap.ts';
import { createHierarchy } from './layers/hierarchy.ts';
import { createInstancer, instancerCalendarReady } from './layers/instancer.ts';
import type { LayerHost, LayerInstance } from './layers/layer.ts';
import { createLine } from './layers/line.ts';
import { createMultiples } from './layers/multiples.ts';
import { createReflector } from './layers/reflector.ts';
import { createSurface } from './layers/surface.ts';
import { createTextLayer } from './layers/text.ts';
import { applyLayerTransform } from './layers/transform.ts';
import { BLEND_TAG, EFFECTS_TAG, SCREEN_FIXED_TAG } from './stage.ts';

/** Layers draw above anything with a lower order; the test pattern stays on top of all. */
const LAYER_ORDER_BASE = 100;

export type CameraMode = '2d' | '3d';
type LayerOf<T extends LayerType> = Extract<LayerConfig, { type: T }>;

/** A built layer that takes uniform-only updates. */
export interface ApplicableLayer<L> extends LayerInstance {
  apply(layer: L, cameraMode: CameraMode): void;
}

/**
 * How one layer type is built. `structureKey` lists the fields whose change needs a rebuild
 * (new buffers or textures); every other change goes through the instance's apply().
 * `needsData` false means the type builds without a dataset when datasetId is null.
 */
interface LayerKind<L extends LayerConfig> {
  structureKey(layer: L, timeZone: string, data: LoadedDataset | null): string;
  needsData: boolean;
  create(layer: L, data: LoadedDataset | null, cameraMode: CameraMode): ApplicableLayer<L>;
}

function required(data: LoadedDataset | null): LoadedDataset {
  // The manager only builds data layers once their dataset has loaded.
  if (!data) throw new Error('dataset not loaded');
  return data;
}

const KINDS: { [T in LayerType]: LayerKind<LayerOf<T>> } = {
  instancer: {
    // With calendar fields available they are always uploaded (see instancer.ts), so the
    // arrangement is not structural and a morph can move marks between any two layouts.
    structureKey: (layer, timeZone, data) =>
      data && instancerCalendarReady(layer, data)
        ? `cal|${structureKey({ ...layer, arrangement: 'calendar' }, timeZone)}`
        : structureKey(layer, timeZone),
    needsData: true,
    create: (layer, data, mode) => createInstancer(layer, required(data), mode),
  },
  line: {
    structureKey: (layer) => lineStructureKey(layer),
    needsData: true,
    create: (layer, data, mode) => createLine(layer, required(data), mode),
  },
  heatmap: {
    structureKey: (layer, timeZone) => heatmapStructureKey(layer, timeZone),
    needsData: true,
    create: (layer, data, mode) => createHeatmap(layer, required(data), mode),
  },
  text: {
    // Template, row and every style property are applied in place (text layout is async).
    structureKey: (layer) => JSON.stringify([layer.datasetId]),
    needsData: false,
    create: (layer, data, mode) => createTextLayer(layer, data ? { table: data.table, timeZone: data.timeZone } : null, mode),
  },
  multiples: {
    structureKey: (layer, timeZone) => multiplesStructureKey(layer, timeZone),
    needsData: true,
    create: (layer, data, mode) => createMultiples(layer, required(data), mode),
  },
  hierarchy: {
    // Rows, layout and its sizes go to the layer's worker (regroup / re-layout), not a rebuild.
    structureKey: (layer, timeZone) => hierarchyStructureKey(layer, timeZone),
    needsData: true,
    create: (layer, data, mode) => createHierarchy(layer, required(data), mode),
  },
  surface: {
    structureKey: (layer, timeZone) => surfaceStructureKey(layer, timeZone),
    needsData: true,
    create: (layer, data, mode) => createSurface(layer, required(data), mode),
  },
  reflector: {
    // No data and no buffers to size: every field is applied in place.
    structureKey: () => '',
    needsData: false,
    create: (layer, _data, mode) => createReflector(layer, mode),
  },
};

/**
 * The camera mode a layer's materials are set up for: a layer fixed to the screen is drawn
 * with the 2D pixel camera (see Stage), so it is set up as in 2D whatever the project camera.
 */
function modeFor(layer: LayerConfig, projectMode: CameraMode): CameraMode {
  return layer.screenFixed ? '2d' : projectMode;
}

/** What the Stage reads from a layer's root object each frame (see the tags in stage.ts). */
function tag(object: Object3D, layer: LayerConfig): void {
  const data = object.userData;
  data[EFFECTS_TAG] = layer.effects;
  data[SCREEN_FIXED_TAG] = layer.screenFixed;
  data[BLEND_TAG] = layer.blend;
}

function kindOf(layer: LayerConfig): LayerKind<LayerConfig> {
  return KINDS[layer.type] as unknown as LayerKind<LayerConfig>;
}

/**
 * Reconciles the project's layer list with built layer instances. A layer is rebuilt only
 * when its type, its structure (see each kind's structureKey) or its dataset's version
 * changes; everything else is a uniform update through apply(). Layers whose dataset has
 * not loaded yet are simply not built (waiting is not an error); a text layer with no
 * dataset builds straight away and shows its static text.
 */
export class LayerManager {
  private keys = new Map<string, string>();
  private applied = new Map<string, LayerConfig>();
  /** Last config pushed into each instance (base, modulated or morphed): what is on screen. */
  private displayed = new Map<string, LayerConfig>();
  private orders = new Map<string, number>();
  private enabled = new Map<string, boolean>();
  /** Layers kept visible while a morph fades them, whatever their `enabled` says. */
  private forcedVisible = new Set<string>();
  private _cameraMode: CameraMode = '2d';

  constructor(
    private host: LayerHost,
    private datasets: DatasetStore,
  ) {}

  get cameraMode(): CameraMode {
    return this._cameraMode;
  }

  sync(doc: SyncDoc): void {
    const cameraMode = doc.project.camera.mode;
    const cameraChanged = cameraMode !== this._cameraMode;
    this._cameraMode = cameraMode;
    const timeZones = timeZonesOf(doc);
    const seen = new Set<string>();

    doc.project.layers.forEach((layer, index) => {
      const kind = kindOf(layer);
      if (!kind) return;
      seen.add(layer.id);
      const data = layer.datasetId ? this.datasets.get(layer.datasetId) : null;
      const key = this.keyOf(layer, timeZones);
      if (key === null) {
        this.drop(layer.id);
        return;
      }
      if (key !== this.keys.get(layer.id)) {
        this.keys.set(layer.id, key);
        this.applied.set(layer.id, layer);
        this.displayed.set(layer.id, layer);
        this.host.set(layer.id, () => kind.create(layer, data, modeFor(layer, cameraMode)));
      } else if (layer !== this.applied.get(layer.id) || cameraChanged) {
        this.applied.set(layer.id, layer);
        this.displayed.set(layer.id, layer);
        this.host.call<ApplicableLayer<LayerConfig>>(layer.id, (inst) => inst.apply(layer, modeFor(layer, cameraMode)));
      }
      this.orders.set(layer.id, LAYER_ORDER_BASE + index);
      this.enabled.set(layer.id, layer.enabled);
      this.host.place(layer.id, LAYER_ORDER_BASE + index, layer.enabled || this.forcedVisible.has(layer.id));
      this.host.call(layer.id, (inst) => {
        applyLayerTransform(inst.object, layer.transform);
        tag(inst.object, layer);
      });
    });

    for (const id of [...this.keys.keys()]) if (!seen.has(id)) this.drop(id);
  }

  /**
   * The key sync() would give `layer` under `doc` (type, structure, data version), or null
   * when it cannot be built yet (its dataset has not loaded).
   */
  keyFor(layer: LayerConfig, doc: SyncDoc): string | null {
    return this.keyOf(layer, timeZonesOf(doc));
  }

  /** The current key of a built layer, or undefined. */
  keyOfBuilt(id: string): string | undefined {
    return this.keys.get(id);
  }

  /** True when the layer has a working instance. */
  isBuilt(id: string): boolean {
    return this.keys.has(id) && this.host.get(id) !== null && !this.host.failed(id);
  }

  /** True when the layer is drawn now (enabled or kept visible by a morph, and not failed). */
  isVisible(id: string): boolean {
    return this.keys.has(id) && (this.host.get(id)?.object.visible ?? false);
  }

  /** What was last pushed into the layer's instance (see `displayed`). */
  displayedConfig(id: string): LayerConfig | undefined {
    return this.displayed.get(id);
  }

  /** Ids of the layers currently built. */
  builtIds(): string[] {
    return [...this.keys.keys()];
  }

  /**
   * Hand a built layer's instance over to the caller (a morph fading it out): it stays in
   * the scene, but this manager forgets it, so the next sync builds a fresh one and never
   * disposes this one. Returns null (and drops the layer normally) if it has no working instance.
   */
  detach(id: string): ApplicableLayer<LayerConfig> | null {
    if (!this.keys.has(id)) return null;
    const instance = this.host.failed(id) ? null : this.host.detach(id);
    this.keys.delete(id);
    this.applied.delete(id);
    this.displayed.delete(id);
    if (!instance) this.host.remove(id);
    return instance as ApplicableLayer<LayerConfig> | null;
  }

  /** Keep a layer drawn while a morph fades it, even if it is disabled. */
  setForcedVisible(id: string, on: boolean): void {
    if (on === this.forcedVisible.has(id)) return;
    if (on) this.forcedVisible.add(id);
    else this.forcedVisible.delete(id);
    const order = this.orders.get(id);
    if (order !== undefined) this.host.place(id, order, (this.enabled.get(id) ?? false) || on);
  }

  /** Run `fn` on a built layer's instance inside the host's fence. */
  call(id: string, fn: (instance: ApplicableLayer<LayerConfig>) => void): void {
    if (this.keys.has(id)) this.host.call<ApplicableLayer<LayerConfig>>(id, fn);
  }

  private keyOf(layer: LayerConfig, timeZones: Map<string, string>): string | null {
    const kind = kindOf(layer);
    if (!kind) return null;
    const data = layer.datasetId ? this.datasets.get(layer.datasetId) : null;
    if (!data && (kind.needsData || layer.datasetId)) return null;
    const timeZone = (layer.datasetId && timeZones.get(layer.datasetId)) || 'UTC';
    return `${layer.type}|${kind.structureKey(layer, timeZone, data)}|${data?.version ?? '-'}`;
  }

  /** Push modulated (effective) values for one layer; called every frame by the modulation engine. */
  applyEffective(id: string, effective: LayerConfig): void {
    const applied = this.applied.get(id);
    // A scratch config of another type (the layer was just replaced) is ignored until the
    // modulation engine recompiles.
    if (!this.keys.has(id) || applied?.type !== effective.type) return;
    this.displayed.set(id, effective);
    this.host.call(id, this.applyConfig, effective);
  }

  private readonly applyConfig = (inst: ApplicableLayer<LayerConfig>, config: LayerConfig): void => {
    inst.apply(config, modeFor(config, this._cameraMode));
    applyLayerTransform(inst.object, config.transform);
    tag(inst.object, config);
  };

  /** Re-apply every layer's base config (e.g. after its modulators were removed). */
  reapplyBase(): void {
    for (const [id, layer] of this.applied) {
      this.displayed.set(id, layer);
      this.host.call<ApplicableLayer<LayerConfig>>(id, (inst) => {
        inst.apply(layer, modeFor(layer, this._cameraMode));
        applyLayerTransform(inst.object, layer.transform);
        tag(inst.object, layer);
      });
    }
  }

  /** Forget everything, e.g. after a WebGL context restore, so the next sync rebuilds all. */
  reset(): void {
    for (const id of [...this.keys.keys()]) this.drop(id);
  }

  private drop(id: string): void {
    if (!this.keys.has(id)) return;
    this.keys.delete(id);
    this.applied.delete(id);
    this.displayed.delete(id);
    this.host.remove(id);
  }
}

function timeZonesOf(doc: SyncDoc): Map<string, string> {
  return new Map(doc.project.datasets.map((d) => [d.id, d.timeZone]));
}
