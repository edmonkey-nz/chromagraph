/**
 * Row splitting for small multiples layers. Pure (no GPU), so it is unit-tested; the output
 * packs the entries into an RGBA32F data texture and draws every mark of every panel in one
 * instanced draw, doing the placement and scale maths in the vertex shader.
 *
 * Each drawable row becomes an entry with a panel index and an x within its panel, 0..1:
 *   year      panel key = year; x = day of year / 366
 *   month     panel key = year * 12 + month (0-based); x = (day of month - 1) / 31
 *   decade    panel key = floor(year / 10); x = (year - decade start + day of year / 366) / 10
 *   category  panel key = the category code (dictionary order); x = index of the row within
 *             its category / the largest category's row count
 *   rows      panel key = floor(row / chunkRows); x = (row mod chunkRows) / chunkRows
 * Panels are numbered from the smallest key, so a key with no rows (a whole year missing)
 * still has its panel: gaps stay visible. Calendar fields are in the dataset timezone.
 *
 * A row with a missing split value or a missing value is not an entry: it is never drawn,
 * and never drawn as zero. The `rows` range is applied by the renderer as an entry range
 * (see visibleEntries), so a data playhead sweeping `rows` is a uniform update.
 */
import type { ScaleType, SmallMultiplesLayer } from '../shared/layer-schema.ts';
import type { CalendarFields } from './calendar.ts';
import type { Column, Table } from './columns.ts';
import { LayerDataError } from './instance-data.ts';

export type Split = SmallMultiplesLayer['splitBy'];

export const MAX_MULTIPLES_ROWS = 1_000_000;
/** More panels than this is almost certainly a misconfiguration (e.g. chunkRows 1). */
export const MAX_PANELS = 100_000;

const CUMULATIVE_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface MultiplesData {
  split: Split;
  /** Drawable entries, in row order. */
  count: number;
  /** Source row of each entry (ascending). */
  row: Int32Array;
  /** Panel index of each entry (0 = the smallest key). */
  panel: Int32Array;
  /** Position within the panel, 0..1 (the left edge of the row's slot). */
  x: Float32Array;
  /** Raw value of each entry (never missing). */
  value: Float32Array;
  /** Rows in the table, for the `rows` fractions. */
  rowCount: number;
  panelCount: number;
  /** Panel key of panel 0 (year, year * 12 + month, decade / 10, code or chunk). */
  firstKey: number;
  /**
   * Slots across a panel (366 days, 31 days, 3660 days, the chunk or the largest category),
   * so the per-row x step is panel width / slots.
   */
  slots: number;
  /** Per panel: min, max and smallest positive value of its entries (NaN when it has none). */
  panelMin: Float32Array;
  panelMax: Float32Array;
  panelMinPositive: Float32Array;
  /** Value column min/max and smallest positive value (shared auto domain). */
  valueMin: number;
  valueMax: number;
  valueMinPositive: number;
  /** True when panel indices never decrease along the entries (time-sorted data, rows split). */
  monotone: boolean;
  chunkRows: number;
  /** Category split: the dictionary, for labels. */
  dictionary: readonly string[] | null;
}

/** Fields whose change needs a new split (everything else is a uniform update). */
export function multiplesStructureKey(layer: SmallMultiplesLayer, timeZone: string): string {
  const calendar = layer.splitBy === 'year' || layer.splitBy === 'month' || layer.splitBy === 'decade';
  return JSON.stringify([
    layer.datasetId,
    layer.splitBy,
    layer.splitBy === 'rows' ? null : layer.splitColumn,
    layer.splitBy === 'rows' ? layer.chunkRows : 0,
    calendar ? timeZone : '',
    layer.valueColumn,
  ]);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 0-based month and 1-based day of month from a year and 0-based day of year (no Intl). */
export function monthDay(year: number, dayOfYear: number): [number, number] {
  const leap = isLeap(year) ? 1 : 0;
  for (let m = 11; m >= 0; m--) {
    const start = CUMULATIVE_DAYS[m]! + (m >= 2 ? leap : 0);
    if (dayOfYear >= start) return [m, dayOfYear - start + 1];
  }
  return [0, dayOfYear + 1];
}

function findColumn(table: Table, name: string, what: string): Column {
  const c = table.columns.find((col) => col.name === name);
  if (!c) throw new LayerDataError(`${what} "${name}" not found`);
  return c;
}

/**
 * Split the rows into panels. Returns null while the layer is not configured yet (no value
 * column, or a time/category split without a split column); throws LayerDataError for a
 * column that does not exist or has the wrong type.
 */
export function splitRows(layer: SmallMultiplesLayer, table: Table, calendars: Record<string, CalendarFields>): MultiplesData | null {
  if (!layer.valueColumn) return null;
  const split = layer.splitBy;
  if (split !== 'rows' && !layer.splitColumn) return null;
  const n = table.rowCount;
  if (n > MAX_MULTIPLES_ROWS) throw new LayerDataError(`${n} rows is more than the ${MAX_MULTIPLES_ROWS} row limit`);

  const vc = findColumn(table, layer.valueColumn, 'value column');
  if (vc.type !== 'number') throw new LayerDataError(`value column "${vc.name}" is a ${vc.type} column; small multiples need numbers`);
  const values = vc.values;

  // Panel key and slot (x * slots) per row; NaN key = no panel (missing split value).
  const key = new Float64Array(n);
  const slot = new Float64Array(n);
  let slots = 1;
  let dictionary: readonly string[] | null = null;
  const chunk = Math.max(1, Math.floor(layer.chunkRows));

  if (split === 'rows') {
    slots = chunk;
    for (let i = 0; i < n; i++) {
      key[i] = Math.floor(i / chunk);
      slot[i] = i % chunk;
    }
  } else if (split === 'category') {
    const sc = findColumn(table, layer.splitColumn!, 'split column');
    if (sc.type !== 'category') throw new LayerDataError(`split column "${sc.name}" is a ${sc.type} column; a category split needs a category column`);
    dictionary = sc.dictionary;
    const seen = new Int32Array(sc.dictionary.length);
    for (let i = 0; i < n; i++) {
      const code = sc.codes[i]!;
      if (code < 0) {
        key[i] = NaN;
        continue;
      }
      key[i] = code;
      slot[i] = seen[code]!;
      seen[code] = seen[code]! + 1;
    }
    for (let c = 0; c < seen.length; c++) slots = Math.max(slots, seen[c]!);
  } else {
    const tc = findColumn(table, layer.splitColumn!, 'split column');
    if (tc.type !== 'time') throw new LayerDataError(`split column "${tc.name}" is a ${tc.type} column; a ${split} split needs a time column`);
    const cal = calendars[tc.name];
    if (!cal) throw new LayerDataError(`calendar fields for "${tc.name}" are not available yet`);
    slots = split === 'year' ? 366 : split === 'month' ? 31 : 3660;
    for (let i = 0; i < n; i++) {
      const y = cal.year[i]!;
      const d = cal.dayOfYear[i]!;
      if (Number.isNaN(y) || Number.isNaN(d)) {
        key[i] = NaN;
        continue;
      }
      if (split === 'year') {
        key[i] = y;
        slot[i] = d;
      } else if (split === 'month') {
        const [m, dom] = monthDay(y, d);
        key[i] = y * 12 + m;
        slot[i] = dom - 1;
      } else {
        const decade = Math.floor(y / 10);
        key[i] = decade;
        slot[i] = (y - decade * 10) * 366 + d;
      }
    }
  }

  let firstKey = Infinity;
  let lastKey = -Infinity;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const k = key[i]!;
    if (Number.isNaN(k)) continue;
    if (k < firstKey) firstKey = k;
    if (k > lastKey) lastKey = k;
    if (!Number.isNaN(values[i]!)) count++;
  }
  const panelCount = Number.isFinite(firstKey) ? lastKey - firstKey + 1 : 0;
  if (panelCount > MAX_PANELS) throw new LayerDataError(`${panelCount} panels is more than the ${MAX_PANELS} panel limit`);
  if (!Number.isFinite(firstKey)) firstKey = 0;

  const row = new Int32Array(count);
  const panel = new Int32Array(count);
  const x = new Float32Array(count);
  const value = new Float32Array(count);
  const panelMin = new Float32Array(panelCount).fill(NaN);
  const panelMax = new Float32Array(panelCount).fill(NaN);
  const panelMinPositive = new Float32Array(panelCount).fill(NaN);
  let valueMin = Infinity;
  let valueMax = -Infinity;
  let valueMinPositive = Infinity;
  let monotone = true;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const k = key[i]!;
    const v = values[i]!;
    if (Number.isNaN(k) || Number.isNaN(v)) continue;
    const p = k - firstKey;
    if (e > 0 && p < panel[e - 1]!) monotone = false;
    row[e] = i;
    panel[e] = p;
    x[e] = slot[i]! / slots;
    value[e] = v;
    e++;
    const lo = panelMin[p]!;
    if (Number.isNaN(lo) || v < lo) panelMin[p] = v;
    const hi = panelMax[p]!;
    if (Number.isNaN(hi) || v > hi) panelMax[p] = v;
    const mp = panelMinPositive[p]!;
    if (v > 0 && (Number.isNaN(mp) || v < mp)) panelMinPositive[p] = v;
    if (v < valueMin) valueMin = v;
    if (v > valueMax) valueMax = v;
    if (v > 0 && v < valueMinPositive) valueMinPositive = v;
  }

  return {
    split,
    count,
    row,
    panel,
    x,
    value,
    rowCount: n,
    panelCount,
    firstKey,
    slots,
    panelMin,
    panelMax,
    panelMinPositive,
    valueMin: count ? valueMin : NaN,
    valueMax: count ? valueMax : NaN,
    valueMinPositive: Number.isFinite(valueMinPositive) ? valueMinPositive : NaN,
    monotone,
    chunkRows: chunk,
    dictionary,
  };
}

/** Panel title: "1923", "Mar 1923", "1920s", the category, or "rows 0–364" (inclusive). */
export function panelLabel(data: MultiplesData, p: number): string {
  const k = data.firstKey + p;
  switch (data.split) {
    case 'year':
      return String(k);
    case 'month':
      return `${MONTH_NAMES[((k % 12) + 12) % 12]} ${Math.floor(k / 12)}`;
    case 'decade':
      return `${k * 10}s`;
    case 'category':
      return data.dictionary?.[k] ?? String(k);
    case 'rows': {
      const start = k * data.chunkRows;
      const end = Math.min(start + data.chunkRows, data.rowCount) - 1;
      return `rows ${start}–${end}`;
    }
  }
}

/** Index of the first entry whose source row is >= `row` (binary search; count if none). */
export function firstEntryAtOrAfter(data: MultiplesData, row: number): number {
  let lo = 0;
  let hi = data.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data.row[mid]! < row) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Entries drawn for the visible rows [first, last] (inclusive, from rowRange): the entry
 * range [start, start + count). Rows outside `rows` are skipped this way, with no re-upload.
 */
export function visibleEntries(data: MultiplesData, first: number, last: number): [number, number] {
  if (last < first) return [0, 0];
  const start = firstEntryAtOrAfter(data, first);
  const end = firstEntryAtOrAfter(data, last + 1);
  return [start, Math.max(0, end - start)];
}

/**
 * Panels laid out for an entry range: [first panel, panel count]. The first visible panel
 * goes in the top-left slot, so a narrowed `rows` range starts at the top of the grid.
 * Category splits (or unsorted time columns) are not monotone and always show every panel.
 */
export function visiblePanels(data: MultiplesData, start: number, count: number): [number, number] {
  if (data.panelCount === 0 || count === 0) return [0, 0];
  if (!data.monotone) return [0, data.panelCount];
  const a = data.panel[start]!;
  const b = data.panel[start + count - 1]!;
  return [a, b - a + 1];
}

/** Top-left corner (px, y up) of the panel in layout slot `slot` (panel index - first panel). */
export function panelTopLeft(
  slot: number,
  columns: number,
  origin: readonly [number, number, number],
  panelSize: readonly [number, number],
  gap: readonly [number, number],
): [number, number] {
  const cols = Math.max(1, Math.floor(columns));
  const col = slot % cols;
  const line = Math.floor(slot / cols);
  return [origin[0] + col * (panelSize[0] + gap[0]), origin[1] - line * (panelSize[1] + gap[1])];
}

/**
 * Value domain for the shared scale: the explicit domain or the column's min/max (for log,
 * from the smallest positive value). Mirrors resolveDomain in instance-data.ts.
 */
export function multiplesDomain(scale: ScaleType, domain: readonly [number, number] | null, data: MultiplesData): [number, number] {
  if (domain) return [domain[0], domain[1]];
  return autoDomain(scale, data.valueMin, data.valueMax, data.valueMinPositive);
}

/** Per-panel auto domain (also computed in the vertex shader from the panel texture). */
export function panelDomain(scale: ScaleType, data: MultiplesData, p: number): [number, number] {
  return autoDomain(scale, data.panelMin[p]!, data.panelMax[p]!, data.panelMinPositive[p]!);
}

function autoDomain(scale: ScaleType, min: number, max: number, minPositive: number): [number, number] {
  let lo = min;
  let hi = max;
  if (scale === 'log' && !(lo > 0)) {
    lo = Number.isFinite(minPositive) ? minPositive : 1;
    if (!(hi > lo)) hi = lo * 10;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  return [lo, hi];
}
