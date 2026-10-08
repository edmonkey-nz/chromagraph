import { heatmapStructureKey } from '../../data/heatmap-data.ts';
import { hierarchyStructureKey } from '../../data/hierarchy-data.ts';
import { structureKey } from '../../data/instance-data.ts';
import { lineStructureKey } from '../../data/line-data.ts';
import type { LayerConfig, LayerType } from '../../shared/layer-schema.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';
import type { DatasetStore, LoadedDataset } from './datasets.ts';
import { createHeatmap } from './layers/heatmap.ts';
import { createHierarchy } from './layers/hierarchy.ts';
import { createInstancer } from './layers/instancer.ts';
import type { LayerHost, LayerInstance } from './layers/layer.ts';
import { createLine } from './layers/line.ts';
import { createTextLayer } from './layers/text.ts';
import { applyLayerTransform } from './layers/transform.ts';

/** Layers draw above anything with a lower order; the test pattern stays on top of all. */
const LAYER_ORDER_BASE = 100;

type CameraMode = '2d' | '3d';
type LayerOf<T extends LayerType> = Extract<LayerConfig, { type: T }>;

/** A built layer that takes uniform-only updates. */
interface ApplicableLayer<L> extends LayerInstance {
  apply(layer: L, cameraMode: CameraMode): void;
}

/**
 * How one layer type is built. `structureKey` lists the fields whose change needs a rebuild
 * (new buffers or textures); every other change goes through the instance's apply().
 * `needsData` false means the type builds without a dataset when datasetId is null.
 */
interface LayerKind<L extends LayerConfig> {
  structureKey(layer: L, timeZone: string): string;
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
    structureKey: (layer, timeZone) => structureKey(layer, timeZone),
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
  // Phase 7 renderers replace these; until then such a layer shows as flagged, not built.
  multiples: notBuiltYet('small multiples'),
  hierarchy: {
    // Rows, layout and its sizes go to the layer's worker (regroup / re-layout), not a rebuild.
    structureKey: (layer, timeZone) => hierarchyStructureKey(layer, timeZone),
    needsData: true,
    create: (layer, data, mode) => createHierarchy(layer, required(data), mode),
  },
  surface: notBuiltYet('3D surface'),
};

function notBuiltYet<L extends LayerConfig>(what: string): LayerKind<L> {
  return {
    structureKey: (layer) => JSON.stringify(layer),
    needsData: false,
    create: () => {
      throw new Error(`${what} layers are not available in this build yet`);
    },
  };
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
  private cameraMode: CameraMode = '2d';

  constructor(
    private host: LayerHost,
    private datasets: DatasetStore,
  ) {}

  sync(doc: SyncDoc): void {
    const cameraMode = doc.project.camera.mode;
    const cameraChanged = cameraMode !== this.cameraMode;
    this.cameraMode = cameraMode;
    const timeZones = new Map(doc.project.datasets.map((d) => [d.id, d.timeZone]));
    const seen = new Set<string>();

    doc.project.layers.forEach((layer, index) => {
      const kind = kindOf(layer);
      if (!kind) return;
      seen.add(layer.id);
      const data = layer.datasetId ? this.datasets.get(layer.datasetId) : null;
      if (!data && (kind.needsData || layer.datasetId)) {
        this.drop(layer.id);
        return;
      }
      const timeZone = (layer.datasetId && timeZones.get(layer.datasetId)) || 'UTC';
      const key = `${layer.type}|${kind.structureKey(layer, timeZone)}|${data?.version ?? '-'}`;
      if (key !== this.keys.get(layer.id)) {
        this.keys.set(layer.id, key);
        this.applied.set(layer.id, layer);
        this.host.set(layer.id, () => kind.create(layer, data, cameraMode));
      } else if (layer !== this.applied.get(layer.id) || cameraChanged) {
        this.applied.set(layer.id, layer);
        this.host.call<ApplicableLayer<LayerConfig>>(layer.id, (inst) => inst.apply(layer, cameraMode));
      }
      this.host.place(layer.id, LAYER_ORDER_BASE + index, layer.enabled);
      this.host.call(layer.id, (inst) => applyLayerTransform(inst.object, layer.transform));
    });

    for (const id of [...this.keys.keys()]) if (!seen.has(id)) this.drop(id);
  }

  /** Push modulated (effective) values for one layer; called every frame by the modulation engine. */
  applyEffective(id: string, effective: LayerConfig): void {
    const applied = this.applied.get(id);
    // A scratch config of another type (the layer was just replaced) is ignored until the
    // modulation engine recompiles.
    if (!this.keys.has(id) || applied?.type !== effective.type) return;
    this.host.call<ApplicableLayer<LayerConfig>>(id, (inst) => {
      inst.apply(effective, this.cameraMode);
      applyLayerTransform(inst.object, effective.transform);
    });
  }

  /** Re-apply every layer's base config (e.g. after its modulators were removed). */
  reapplyBase(): void {
    for (const [id, layer] of this.applied) {
      this.host.call<ApplicableLayer<LayerConfig>>(id, (inst) => {
        inst.apply(layer, this.cameraMode);
        applyLayerTransform(inst.object, layer.transform);
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
    this.host.remove(id);
  }
}
