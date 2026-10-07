import { Euler, Matrix4, Quaternion, Vector3, type Object3D } from 'three';
import type { LayerTransform } from '../../../shared/layer-schema.ts';

const DEG = Math.PI / 180;
const euler = new Euler();
const quat = new Quaternion();
const scale = new Vector3();
const pos = new Vector3();
const unpivot = new Matrix4();

/**
 * Set a layer object's matrix from its transform:
 *   M = T(position + pivot) * R(rotation, XYZ) * S(scale) * T(-pivot)
 * i.e. scale and rotate about the pivot, then move. No allocation (runs per frame when
 * the transform is modulated).
 */
export function applyLayerTransform(object: Object3D, t: LayerTransform): void {
  object.matrixAutoUpdate = false;
  euler.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ');
  quat.setFromEuler(euler);
  scale.set(t.scale[0], t.scale[1], t.scale[2]);
  pos.set(t.position[0] + t.pivot[0], t.position[1] + t.pivot[1], t.position[2] + t.pivot[2]);
  object.matrix.compose(pos, quat, scale);
  unpivot.makeTranslation(-t.pivot[0], -t.pivot[1], -t.pivot[2]);
  object.matrix.multiply(unpivot);
  object.matrixWorldNeedsUpdate = true;
}
