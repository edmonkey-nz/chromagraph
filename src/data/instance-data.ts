/**
 * Per-instance arrays for an instancer layer, built from a parsed table. Pure (no GPU), so
 * it is unit-tested; the output uploads the arrays as instanced attributes and does the
 * scale maths in the vertex shader (changing a domain or range only touches uniforms).
 *
 * Missing values are never replaced with a real number. On the GPU they are encoded as the
 * MISSING sentinel and the shader hides any instance with a missing mapped value.
 */
import type { InstancerLayer, Mapping, ColourMapping, NumericChannel, ScaleType } from '../shared/layer-schema.ts';
import type { CalendarFields } from './calendar.ts';
import type { Column, Table } from './columns.ts';
import type { Cadence } from './gaps.ts';

/** GPU encoding of a missing value. Anything below MISSING_TEST is treated as missing. */
/** Exactly representable in float32, so it compares equal after upload. */
export const MISSING = Math.fround(-1e30);
export const MISSING_TEST = -1e29;
export const MAX_INSTANCES = 1_000_000;
const DAY_MS = 86_400_000;

export type ChannelName = NumericChannel | 'colour';

export class LayerDataError extends Error {}

export interface ChannelData {
  values: Float32Array;
  /** Auto domain from the column (category: [0, n - 1]; time: days from the column min). */
  autoDomain: [number, number];
  /** Number of categories when the source column is a category column, else 0. */
  categories: number;
}

export interface InstanceData {
  count: number;
  /** Arrangement coordinate per row (see layer-schema.ts), MISSING where it is undefined. */
  t: Float32Array;
  /** Calendar arrangement only: year index from the first year, and 0-based day of year. */
  yearIndex: Float32Array | null;
  dayOfYear: Float32Array | null;
  /** Number of calendar years spanned (calendar only, else 0). */
  years: number;
  channels: Partial<Record<ChannelName, ChannelData>>;
}

function column(table: Table, name: string, what: string): Column {
  const c = table.columns.find((col) => col.name === name);
  if (!c) throw new LayerDataError(`${what}: column "${name}" not found`);
  return c;
}

/** Column values as float32 for the GPU, with MISSING for missing values. */
function channelValues(c: Column): ChannelData {
  const n = c.length;
  const out = new Float32Array(n);
  switch (c.type) {
    case 'number':
      for (let i = 0; i < n; i++) {
        const v = c.values[i]!;
        out[i] = Number.isNaN(v) ? MISSING : v;
      }
      return { values: out, autoDomain: [c.min, c.max], categories: 0 };
    case 'time': {
      const min = c.min;
      for (let i = 0; i < n; i++) {
        const v = c.values[i]!;
        out[i] = Number.isNaN(v) ? MISSING : (v - min) / DAY_MS;
      }
      return { values: out, autoDomain: [0, (c.max - min) / DAY_MS], categories: 0 };
    }
    case 'category':
      for (let i = 0; i < n; i++) {
        const code = c.codes[i]!;
        out[i] = code < 0 ? MISSING : code;
      }
      return { values: out, autoDomain: [0, Math.max(0, c.dictionary.length - 1)], categories: c.dictionary.length };
    case 'text':
      throw new LayerDataError(`column "${c.name}" is text and cannot be mapped`);
  }
}

/**
 * Domain for a mapping: the explicit one, or the column's auto domain. For log scales an
 * auto domain starts at the smallest positive value (zero and negatives have no log).
 */
export function resolveDomain(m: Mapping | ColourMapping, data: ChannelData): [number, number] {
  if (m.domain) return [m.domain[0], m.domain[1]];
  let [lo, hi] = data.autoDomain;
  if (m.scale === 'log' && data.categories === 0 && !(lo > 0)) {
    let smallest = Infinity;
    const v = data.values;
    for (let i = 0; i < v.length; i++) {
      const x = v[i]!;
      if (x > 0 && x < smallest) smallest = x;
    }
    lo = Number.isFinite(smallest) ? smallest : 1;
    if (!(hi > lo)) hi = lo * 10;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  return [lo, hi];
}

/**
 * Reference implementation of the shader's scale maths: value -> 0..1 (unclamped unless
 * `clamp`). Kept in step with `normalise()` in the instancer's vertex shader.
 */
export function normalise(v: number, domain: [number, number], scale: ScaleType, steps: number, clamp: boolean): number {
  const f = (x: number) => (scale === 'log' ? Math.log(Math.max(x, 1e-30)) : scale === 'sqrt' ? Math.sign(x) * Math.sqrt(Math.abs(x)) : x);
  const a = f(domain[0]);
  const b = f(domain[1]);
  let n = b === a ? 0.5 : (f(v) - a) / (b - a);
  if (scale === 'quantise') {
    const c = Math.min(Math.max(n, 0), 0.99999);
    n = Math.floor(c * steps) / (steps - 1);
  } else if (clamp) {
    n = Math.min(Math.max(n, 0), 1);
  }
  return n;
}

/** Fields whose change needs new instance arrays (everything else is a uniform update). */
export function structureKey(layer: InstancerLayer, timeZone: string): string {
  const ch = layer.channels;
  return JSON.stringify([
    layer.datasetId,
    layer.primitive,
    layer.xMode,
    layer.timeColumn,
    layer.arrangement === 'calendar',
    layer.arrangement === 'calendar' ? timeZone : '',
    ch.y.column,
    ch.z.column,
    ch.height.column,
    ch.size.column,
    ch.rotation.column,
    ch.opacity.column,
    ch.colour.column,
  ]);
}

export function buildInstanceData(
  layer: InstancerLayer,
  table: Table,
  cadences: Record<string, Cadence>,
  calendars: Record<string, CalendarFields>,
): InstanceData {
  const n = table.rowCount;
  if (n > MAX_INSTANCES) throw new LayerDataError(`${n} rows is more than the ${MAX_INSTANCES} instance limit`);

  const t = new Float32Array(n);
  let timeCol: Column | null = null;
  if (layer.xMode === 'time' || layer.arrangement === 'calendar') {
    if (!layer.timeColumn) throw new LayerDataError('time x mode and the calendar arrangement need a time column');
    timeCol = column(table, layer.timeColumn, 'time column');
    if (timeCol.type !== 'time') throw new LayerDataError(`"${layer.timeColumn}" is not a time column`);
  }

  if (layer.xMode === 'time' && timeCol?.type === 'time') {
    const step = cadences[timeCol.name]?.step;
    const unit = step !== undefined && step > 0 && Number.isFinite(step) ? step : DAY_MS;
    const min = timeCol.min;
    for (let i = 0; i < n; i++) {
      const v = timeCol.values[i]!;
      t[i] = Number.isNaN(v) ? MISSING : (v - min) / unit;
    }
  } else {
    for (let i = 0; i < n; i++) t[i] = i;
  }

  let yearIndex: Float32Array | null = null;
  let dayOfYear: Float32Array | null = null;
  let years = 0;
  if (layer.arrangement === 'calendar' && timeCol) {
    const cal = calendars[timeCol.name];
    if (!cal) throw new LayerDataError(`calendar fields for "${timeCol.name}" are not available yet`);
    let first = Infinity;
    let last = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = cal.year[i]!;
      if (y < first) first = y;
      if (y > last) last = y;
    }
    yearIndex = new Float32Array(n);
    dayOfYear = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const y = cal.year[i]!;
      const missing = Number.isNaN(y);
      yearIndex[i] = missing ? MISSING : y - first;
      dayOfYear[i] = missing ? MISSING : cal.dayOfYear[i]!;
    }
    years = Number.isFinite(first) ? last - first + 1 : 0;
  }

  const channels: Partial<Record<ChannelName, ChannelData>> = {};
  for (const name of ['y', 'z', 'height', 'size', 'rotation', 'opacity', 'colour'] as const) {
    const m = layer.channels[name];
    if (!m.column) continue;
    const c = column(table, m.column, `${name} channel`);
    if (c.type === 'category' && name !== 'colour') {
      throw new LayerDataError(`category column "${c.name}" can only be mapped to colour`);
    }
    channels[name] = channelValues(c);
  }

  return { count: n, t, yearIndex, dayOfYear, years, channels };
}

/** Index of the first row at or after `fromRow` whose t is defined, for followRange. */
export function firstDefinedT(t: Float32Array, fromRow: number): number {
  for (let i = Math.max(0, fromRow); i < t.length; i++) {
    const v = t[i]!;
    if (v > MISSING_TEST) return v;
  }
  return 0;
}
