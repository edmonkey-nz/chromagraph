/**
 * Grouping for hierarchy layers: rows are grouped level by level (calendar units of a time
 * column, or category columns) into a tree whose nodes aggregate a value column. Pure and
 * worker-safe (no DOM, no Intl): it runs in the hierarchy worker and is unit-tested.
 *
 *   leaves   aggregate the rows beneath them with `aggregate` (mean, sum, min, max, last)
 *   parents  sum: sum of the rows beneath; mean: sum / count of every row beneath (never a
 *            mean of means); min / max: extreme of the children; last: the value of the last
 *            child that has one
 *
 * Missing values are never filled in. Rows whose value is missing are left out of the
 * totals and counted per node (`missing`); a node with no values at all has value NaN.
 * Rows whose group key is missing (no time, or a missing category) cannot be placed in the
 * tree; they are counted as `ungrouped`. With no value column the tree counts rows
 * (value = row count).
 *
 * The tree comes back as flat typed arrays in pre-order (a parent before its children,
 * children in ascending key order: time order, or the category's first-seen order), so it
 * can be transferred between threads without copying.
 */
import type { AGGREGATES, HIERARCHY_TIME_UNITS, HierarchyLayer } from '../shared/layer-schema.ts';
import type { CalendarFields } from './calendar.ts';
import type { Table } from './columns.ts';
import { LayerDataError } from './instance-data.ts';

export type Aggregate = (typeof AGGREGATES)[number];
export type TimeUnit = (typeof HIERARCHY_TIME_UNITS)[number];

/** Most nodes a tree may have (the frame budget for instances across all layers). */
export const MAX_NODES = 200_000;
/** Label of the root node. */
export const ROOT_LABEL = 'All';

export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Day of year (0-based) on which each month starts, for common and leap years. */
const MONTH_START_COMMON = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const MONTH_START_LEAP = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Month (0..11) of a 0-based day of year, leap-year aware. */
export function monthOfDay(year: number, dayOfYear: number): number {
  const starts = isLeapYear(year) ? MONTH_START_LEAP : MONTH_START_COMMON;
  let m = 0;
  while (m < 11 && dayOfYear >= starts[m + 1]!) m++;
  return m;
}

/** Day of the month (1..31) of a 0-based day of year, leap-year aware. */
export function dayOfMonth(year: number, dayOfYear: number): number {
  const starts = isLeapYear(year) ? MONTH_START_LEAP : MONTH_START_COMMON;
  return dayOfYear - starts[monthOfDay(year, dayOfYear)]! + 1;
}

/** One grouping level, resolved to the arrays it reads. */
export type LevelInput =
  | { kind: 'time'; unit: TimeUnit; year: Float32Array; dayOfYear: Float32Array }
  | { kind: 'category'; codes: Int32Array; dictionary: string[] };

export interface GroupInputs {
  rowCount: number;
  levels: LevelInput[];
  /** Value per row (NaN where missing), or null to count rows. */
  values: Float32Array | null;
}

export interface HierarchyTree {
  nodeCount: number;
  /** Depth of the leaves (the number of levels). */
  levels: number;
  /** Parent node index per node; -1 for the root (node 0). */
  parent: Int32Array;
  depth: Uint8Array;
  /** Aggregated value per node; NaN when no row beneath it has a value. */
  value: Float64Array;
  /** Rows beneath the node that have a value. */
  count: Uint32Array;
  /** Rows beneath the node whose value is missing (left out of `value`). */
  missing: Uint32Array;
  /** Index into `labels` per node. */
  label: Int32Array;
  labels: string[];
  /** Rows with a missing value in the grouped range (= missing[0]). */
  missingTotal: number;
  /** Rows in the range that could not be grouped (a missing time or category). */
  ungrouped: number;
  /** Rows in the range that were grouped. */
  rows: number;
  /** True when areas should follow the value (sum or row counts), false to follow row counts. */
  sizeByValue: boolean;
}

/**
 * Fields whose change needs a new tree from new inputs (a rebuild of the layer). The row
 * range is deliberately absent: it is a modulatable parameter (data playhead), and a
 * modulated value never reaches the structure key, so the layer regroups it in its worker.
 */
export function hierarchyStructureKey(layer: HierarchyLayer, timeZone: string): string {
  const usesTime = layer.levels.some((l) => l.kind === 'time');
  return JSON.stringify([layer.datasetId, layer.levels, layer.valueColumn, layer.aggregate, usesTime ? timeZone : '']);
}

/** True until every level names a column (a fresh layer has none chosen yet). */
export function hierarchyUnconfigured(layer: HierarchyLayer): boolean {
  return layer.levels.length === 0 || layer.levels.some((l) => l.column === '');
}

/**
 * Validate a layer against the table and resolve the arrays grouping reads. The arrays are
 * the table's own (no copy). Returns null while the layer is not configured yet; throws
 * LayerDataError for an unknown column or a column of the wrong type.
 */
export function prepareHierarchyInputs(
  layer: HierarchyLayer,
  table: Table,
  calendars: Record<string, CalendarFields>,
): GroupInputs | null {
  if (hierarchyUnconfigured(layer)) return null;
  const levels: LevelInput[] = layer.levels.map((level, i) => {
    const what = `level ${i + 1}`;
    const c = table.columns.find((col) => col.name === level.column);
    if (!c) throw new LayerDataError(`${what}: column "${level.column}" not found`);
    if (level.kind === 'time') {
      if (c.type !== 'time') throw new LayerDataError(`${what}: "${c.name}" is a ${c.type} column; a ${level.unit} level needs a time column`);
      const cal = calendars[c.name];
      if (!cal) throw new LayerDataError(`${what}: calendar fields for "${c.name}" are not available`);
      return { kind: 'time', unit: level.unit, year: cal.year, dayOfYear: cal.dayOfYear };
    }
    if (c.type !== 'category') throw new LayerDataError(`${what}: "${c.name}" is a ${c.type} column; a category level needs a category column`);
    return { kind: 'category', codes: c.codes, dictionary: c.dictionary };
  });
  let values: Float32Array | null = null;
  if (layer.valueColumn) {
    const c = table.columns.find((col) => col.name === layer.valueColumn);
    if (!c) throw new LayerDataError(`value column "${layer.valueColumn}" not found`);
    if (c.type !== 'number') throw new LayerDataError(`value column "${c.name}" is a ${c.type} column; a hierarchy needs numbers`);
    values = c.values;
  }
  return { rowCount: table.rowCount, levels, values };
}

/**
 * Copies of the inputs for posting to the worker (the main thread keeps the table), with
 * the buffers to transfer. Arrays shared by several levels are copied once.
 */
export function copyInputs(inputs: GroupInputs): { inputs: GroupInputs; transfer: ArrayBuffer[] } {
  const copies = new Map<ArrayLike<number>, Float32Array | Int32Array>();
  const transfer: ArrayBuffer[] = [];
  function copy<T extends Float32Array | Int32Array>(a: T): T {
    let c = copies.get(a);
    if (!c) {
      c = a.slice();
      copies.set(a, c);
      transfer.push(c.buffer as ArrayBuffer);
    }
    return c as T;
  }
  const levels: LevelInput[] = inputs.levels.map((l) =>
    l.kind === 'time'
      ? { kind: 'time', unit: l.unit, year: copy(l.year), dayOfYear: copy(l.dayOfYear) }
      : { kind: 'category', codes: copy(l.codes), dictionary: l.dictionary },
  );
  return { inputs: { rowCount: inputs.rowCount, levels, values: inputs.values ? copy(inputs.values) : null }, transfer };
}

/** Buffers of a tree, for transferring it. */
export function treeTransferables(tree: HierarchyTree): ArrayBuffer[] {
  return [tree.parent, tree.depth, tree.value, tree.count, tree.missing, tree.label].map((a) => a.buffer as ArrayBuffer);
}

/** A deep copy whose buffers can be transferred while the original stays cached. */
export function cloneTree(tree: HierarchyTree): HierarchyTree {
  return {
    ...tree,
    parent: tree.parent.slice(),
    depth: tree.depth.slice(),
    value: tree.value.slice(),
    count: tree.count.slice(),
    missing: tree.missing.slice(),
    label: tree.label.slice(),
    labels: tree.labels.slice(),
  };
}

/** Group key of a row at one level, or NaN when it cannot be placed. */
function levelKey(level: LevelInput, row: number): number {
  if (level.kind === 'category') {
    const code = level.codes[row]!;
    return code < 0 ? NaN : code;
  }
  const y = level.year[row]!;
  const d = level.dayOfYear[row]!;
  if (Number.isNaN(y) || Number.isNaN(d)) return NaN;
  switch (level.unit) {
    case 'decade':
      return Math.floor(y / 10) * 10;
    case 'year':
      return y;
    case 'month':
      return monthOfDay(y, d);
    case 'day':
      return dayOfMonth(y, d);
  }
}

function levelLabel(level: LevelInput, key: number): string {
  if (level.kind === 'category') return level.dictionary[key] ?? String(key);
  switch (level.unit) {
    case 'decade':
      return `${key}s`;
    case 'year':
    case 'day':
      return String(key);
    case 'month':
      return MONTH_LABELS[key] ?? String(key);
  }
}

/**
 * Group rows first..last (inclusive, clamped to the table) into a tree. See the module
 * comment for the aggregation rules. Throws LayerDataError past MAX_NODES.
 */
export function groupHierarchy(inputs: GroupInputs, aggregate: Aggregate, first: number, last: number): HierarchyTree {
  const L = inputs.levels.length;
  const values = inputs.values;
  const lo = Math.max(0, Math.floor(first));
  const hi = Math.min(inputs.rowCount - 1, Math.floor(last));

  // Build in creation order; nodes are renumbered into pre-order afterwards.
  const bParent: number[] = [-1];
  const bKey: number[] = [0];
  const bDepth: number[] = [0];
  const bChildren: (Map<number, number> | null)[] = [L > 0 ? new Map() : null];
  // Leaf accumulators (creation order); only leaves receive rows.
  const sum: number[] = [0];
  const cnt: number[] = [0];
  const miss: number[] = [0];
  const mn: number[] = [NaN];
  const mx: number[] = [NaN];
  const lastV: number[] = [NaN];
  const keys = new Float64Array(L);
  let ungrouped = 0;
  let rows = 0;

  for (let r = lo; r <= hi; r++) {
    let placeable = true;
    for (let l = 0; l < L; l++) {
      const k = levelKey(inputs.levels[l]!, r);
      if (Number.isNaN(k)) {
        placeable = false;
        break;
      }
      keys[l] = k;
    }
    if (!placeable) {
      ungrouped++;
      continue;
    }
    rows++;
    let node = 0;
    for (let l = 0; l < L; l++) {
      const children = bChildren[node]!;
      const k = keys[l]!;
      let child = children.get(k);
      if (child === undefined) {
        child = bParent.length;
        if (child >= MAX_NODES) {
          throw new LayerDataError(`the hierarchy has more than ${MAX_NODES} nodes; use fewer levels or a narrower row range`);
        }
        children.set(k, child);
        bParent.push(node);
        bKey.push(k);
        bDepth.push(l + 1);
        bChildren.push(l + 1 < L ? new Map() : null);
        sum.push(0);
        cnt.push(0);
        miss.push(0);
        mn.push(NaN);
        mx.push(NaN);
        lastV.push(NaN);
      }
      node = child;
    }
    if (!values) {
      cnt[node]!++;
      continue;
    }
    const v = values[r]!;
    if (Number.isNaN(v)) {
      miss[node]!++;
      continue;
    }
    sum[node]! += v;
    cnt[node]!++;
    if (!(mn[node]! <= v)) mn[node] = v;
    if (!(mx[node]! >= v)) mx[node] = v;
    lastV[node] = v; // rows are visited in order, so the last write is the last row
  }

  // Renumber into pre-order with children in ascending key order.
  const n = bParent.length;
  const order = new Int32Array(n); // pre-order position -> creation index
  const stack: number[] = [0];
  let pos = 0;
  while (stack.length) {
    const b = stack.pop()!;
    order[pos++] = b;
    const children = bChildren[b];
    if (!children || children.size === 0) continue;
    const kids = [...children.entries()].sort((a, c) => a[0] - c[0]);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]![1]);
  }
  const position = new Int32Array(n); // creation index -> pre-order position
  for (let i = 0; i < n; i++) position[order[i]!] = i;

  const parent = new Int32Array(n);
  const depth = new Uint8Array(n);
  const value = new Float64Array(n);
  const count = new Uint32Array(n);
  const missing = new Uint32Array(n);
  const label = new Int32Array(n);
  const labels: string[] = [ROOT_LABEL];
  const labelIds = new Map<string, number>([[ROOT_LABEL, 0]]);
  // Working sums, minima, maxima and "last" per pre-order node.
  const wSum = new Float64Array(n);
  const wMin = new Float64Array(n).fill(NaN);
  const wMax = new Float64Array(n).fill(NaN);
  const wLast = new Float64Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const b = order[i]!;
    const p = bParent[b]!;
    parent[i] = p < 0 ? -1 : position[p]!;
    const d = bDepth[b]!;
    depth[i] = d;
    if (d > 0) {
      const text = levelLabel(inputs.levels[d - 1]!, bKey[b]!);
      let id = labelIds.get(text);
      if (id === undefined) {
        id = labels.length;
        labels.push(text);
        labelIds.set(text, id);
      }
      label[i] = id;
    }
    if (d === L) {
      wSum[i] = sum[b]!;
      count[i] = cnt[b]!;
      missing[i] = miss[b]!;
      wMin[i] = mn[b]!;
      wMax[i] = mx[b]!;
      wLast[i] = lastV[b]!;
    }
  }

  // Children come after their parent in pre-order, so walking backwards finishes every node
  // before it is folded into its parent; later children are met first (for `last`).
  for (let i = n - 1; i >= 0; i--) {
    const c = count[i]!;
    if (!values) value[i] = c;
    else if (c === 0) value[i] = NaN;
    else {
      switch (aggregate) {
        case 'sum':
          value[i] = wSum[i]!;
          break;
        case 'mean':
          value[i] = wSum[i]! / c;
          break;
        case 'min':
          value[i] = wMin[i]!;
          break;
        case 'max':
          value[i] = wMax[i]!;
          break;
        case 'last':
          value[i] = wLast[i]!;
          break;
      }
    }
    const p = parent[i]!;
    if (p < 0) continue;
    wSum[p] = wSum[p]! + wSum[i]!;
    count[p] = count[p]! + c;
    missing[p] = missing[p]! + missing[i]!;
    if (c > 0) {
      if (!(wMin[p]! <= wMin[i]!)) wMin[p] = wMin[i]!;
      if (!(wMax[p]! >= wMax[i]!)) wMax[p] = wMax[i]!;
      if (Number.isNaN(wLast[p]!)) wLast[p] = value[i]!;
    }
  }

  return {
    nodeCount: n,
    levels: L,
    parent,
    depth,
    value,
    count,
    missing,
    label,
    labels,
    missingTotal: missing[0]!,
    ungrouped,
    rows,
    sizeByValue: !values || aggregate === 'sum',
  };
}

/** Deepest node depth (the schema allows up to five levels below the root). */
export const MAX_DEPTH = 5;

/** Value range per depth (index = depth, 0..MAX_DEPTH); NaN where a depth has no values. */
export interface DepthStats {
  min: Float64Array;
  max: Float64Array;
  /** Smallest positive value per depth, for auto log domains. */
  minPositive: Float64Array;
}

export function depthStats(tree: HierarchyTree): DepthStats {
  const stats: DepthStats = {
    min: new Float64Array(MAX_DEPTH + 1).fill(NaN),
    max: new Float64Array(MAX_DEPTH + 1).fill(NaN),
    minPositive: new Float64Array(MAX_DEPTH + 1).fill(NaN),
  };
  for (let i = 0; i < tree.nodeCount; i++) {
    const d = Math.min(tree.depth[i]!, MAX_DEPTH);
    const v = tree.value[i]!;
    if (!Number.isFinite(v)) continue;
    if (!(stats.min[d]! <= v)) stats.min[d] = v;
    if (!(stats.max[d]! >= v)) stats.max[d] = v;
    if (v > 0 && !(stats.minPositive[d]! <= v)) stats.minPositive[d] = v;
  }
  return stats;
}

/**
 * The scale domain used for nodes at `depth`, written into `out` (no allocation, as it runs
 * per frame for a modulated layer). An explicit domain applies to every depth. An auto
 * domain is per depth when the tree adds up (sum or row counts: a parent is the total of
 * its children, so levels are not comparable and one shared range would saturate every
 * parent), and otherwise the leaves' range (a parent's mean, min, max or last lies within
 * its leaves' range, so one shared range keeps levels comparable). Log scales start at the
 * smallest positive value; an unusable range falls back to [0, 1].
 */
export function hierarchyDomainInto(
  out: Float64Array | number[],
  tree: Pick<HierarchyTree, 'levels' | 'sizeByValue'>,
  stats: DepthStats,
  scale: HierarchyLayer['scale'],
  domain: readonly [number, number] | null,
  depth: number,
): void {
  let lo: number;
  let hi: number;
  if (domain) {
    lo = domain[0];
    hi = domain[1];
  } else {
    const d = tree.sizeByValue ? Math.min(Math.max(0, depth), MAX_DEPTH) : Math.min(tree.levels, MAX_DEPTH);
    lo = stats.min[d]!;
    hi = stats.max[d]!;
    if (scale === 'log' && !(lo > 0)) {
      const p = stats.minPositive[d]!;
      lo = Number.isFinite(p) ? p : 1;
      if (!(hi > lo)) hi = lo * 10;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  out[0] = lo;
  out[1] = hi;
}
