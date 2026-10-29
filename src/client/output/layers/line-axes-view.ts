import type { Object3D } from 'three';
import { DateLabels } from '../../../data/instance-labels.ts';
import { layoutLineAxes, type LineSeriesInput } from '../../../data/line-axes.ts';
import type { InstancerAxes, LineLayer, ScaleType } from '../../../shared/layer-schema.ts';
import { AxesView } from './axes-view.ts';

const SCALE_CODE: Record<ScaleType, number> = { linear: 0, log: 1, sqrt: 2, quantise: 3 };
const KEY_LENGTH = 24;

export interface LineAxes {
  apply(next: LineLayer): void;
  /** Rows fractions the layer's animation reaches (axes span 'full'). */
  setRowsSpan(lo: number, hi: number): void;
  dispose(): void;
}

/**
 * A line layer's axes and value labels (data/line-axes.ts), drawn by an AxesView under `parent`.
 * apply() runs every frame for a modulated layer, so it only refills a numeric key (no
 * allocation) and lays the axes out again when that key or the axes settings change.
 */
export function createLineAxes(parent: Object3D, series: LineSeriesInput[], timeZone: string): LineAxes {
  const view = new AxesView(parent);
  const dates = new DateLabels(timeZone);
  const key = new Float64Array(KEY_LENGTH);
  const seen = new Float64Array(KEY_LENGTH).fill(Number.NaN);
  let axesFor: InstancerAxes | null = null;
  let span: [number, number] | null = null;
  let last: LineLayer | null = null;

  function fill(next: LineLayer): void {
    const y = next.y;
    let i = 0;
    key[i++] = next.rows[0];
    key[i++] = next.rows[1];
    for (let j = 0; j < 3; j++) key[i++] = next.origin[j]!;
    for (let j = 0; j < 3; j++) key[i++] = next.step[j]!;
    key[i++] = next.width;
    key[i++] = next.followRange ? 1 : 0;
    key[i++] = y.range[0];
    key[i++] = y.range[1];
    key[i++] = y.domain ? y.domain[0] : Number.NaN;
    key[i++] = y.domain ? y.domain[1] : Number.NaN;
    key[i++] = SCALE_CODE[y.scale];
    key[i++] = y.steps;
    key[i++] = y.clamp ? 1 : 0;
    key[i++] = span ? span[0] : Number.NaN;
    key[i++] = span ? span[1] : Number.NaN;
    key[i++] = next.opacity;
  }

  function same(): boolean {
    for (let i = 0; i < KEY_LENGTH; i++) {
      const a = key[i]!;
      const b = seen[i]!;
      if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) return false;
    }
    return true;
  }

  function apply(next: LineLayer): void {
    last = next;
    const A = next.axes;
    if (!A.values.enabled && !A.x.enabled && !A.y.enabled) {
      if (axesFor !== A) view.hide();
      axesFor = A;
      return;
    }
    fill(next);
    if (A === axesFor && same()) return;
    axesFor = A;
    seen.set(key);
    view.draw(layoutLineAxes({ layer: next, series, dates, timeZone, span: span ?? undefined }), A, next.opacity);
  }

  return {
    apply,
    setRowsSpan(lo, hi) {
      span = [lo, hi];
      if (last) apply(last);
    },
    dispose: () => view.dispose(),
  };
}
