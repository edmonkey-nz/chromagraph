/**
 * Cadence and gap detection for time (or any ordered numeric) columns. Pure, worker-safe.
 *
 * Gaps are reported, never filled: a layer in time mode shows them as they are.
 */

export interface Gap {
  /** Row where the gap ends (the first row after the missing span). */
  index: number;
  /** Value of the previous non-NaN row. */
  from: number;
  /** Value at `index`. */
  to: number;
  /** Whole steps missing between `from` and `to`: round(delta / step) - 1. */
  missingSteps: number;
}

export interface Cadence {
  /** Median of the positive successive deltas, or NaN when there are none. */
  step: number;
  gaps: Gap[];
  /** Number of successive deltas that are zero or negative. */
  nonMonotonic: number;
}

/**
 * Detect the regular step of a series and the gaps in it. NaN rows are skipped; deltas are
 * taken between successive non-NaN values. A gap is any delta greater than 1.5 × step.
 */
export function detectCadence(values: Float64Array): Cadence {
  const n = values.length;
  const deltas = new Float64Array(Math.max(0, n - 1));
  let count = 0;
  let nonMonotonic = 0;
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) continue;
    if (!Number.isNaN(prev)) {
      const d = v - prev;
      if (d > 0) deltas[count++] = d;
      else nonMonotonic++;
    }
    prev = v;
  }

  let step = NaN;
  if (count > 0) {
    const sorted = deltas.subarray(0, count).sort();
    const mid = count >> 1;
    step = count % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  const gaps: Gap[] = [];
  if (step > 0) {
    const threshold = 1.5 * step;
    prev = NaN;
    for (let i = 0; i < n; i++) {
      const v = values[i]!;
      if (Number.isNaN(v)) continue;
      if (!Number.isNaN(prev)) {
        const d = v - prev;
        if (d > threshold) gaps.push({ index: i, from: prev, to: v, missingSteps: Math.round(d / step) - 1 });
      }
      prev = v;
    }
  }

  return { step, gaps, nonMonotonic };
}
