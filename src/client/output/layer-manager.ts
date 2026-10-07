import { structureKey } from '../../data/instance-data.ts';
import type { InstancerLayer } from '../../shared/layer-schema.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';
import type { DatasetStore } from './datasets.ts';
import { createInstancer, type InstancerInstance } from './layers/instancer.ts';
import type { LayerHost } from './layers/layer.ts';

/** Layers draw above anything with a lower order; the test pattern stays on top of all. */
const LAYER_ORDER_BASE = 100;

/**
 * Reconciles the project's layer list with built layer instances. A layer is rebuilt only
 * when its structure changes (dataset, columns, primitive…, see structureKey) or its
 * dataset is reloaded; everything else is a uniform update. Layers whose dataset has not
 * loaded yet are simply not built (waiting is not an error).
 */
export class LayerManager {
  private keys = new Map<string, string>();
  private applied = new Map<string, InstancerLayer>();
  private cameraMode: '2d' | '3d' = '2d';

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
      if (layer.type !== 'instancer') return;
      seen.add(layer.id);
      const data = layer.datasetId ? this.datasets.get(layer.datasetId) : null;
      if (!data) {
        this.drop(layer.id);
        return;
      }
      const key = `${structureKey(layer, timeZones.get(layer.datasetId!) ?? 'UTC')}|${data.version}`;
      if (key !== this.keys.get(layer.id)) {
        this.keys.set(layer.id, key);
        this.applied.set(layer.id, layer);
        this.host.set(layer.id, () => createInstancer(layer, data, cameraMode));
      } else if (layer !== this.applied.get(layer.id) || cameraChanged) {
        this.applied.set(layer.id, layer);
        this.host.call<InstancerInstance>(layer.id, (inst) => inst.apply(layer, cameraMode));
      }
      this.host.place(layer.id, LAYER_ORDER_BASE + index, layer.enabled);
    });

    for (const id of [...this.keys.keys()]) if (!seen.has(id)) this.drop(id);
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
