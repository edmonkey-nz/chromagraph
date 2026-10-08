import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { NumberColumn, Table, TimeColumn } from '../../src/data/columns.ts';
import {
  copyInputs,
  dayOfMonth,
  groupHierarchy,
  hierarchyStructureKey,
  isLeapYear,
  monthOfDay,
  prepareHierarchyInputs,
  type Aggregate,
  type HierarchyTree,
} from '../../src/data/hierarchy-data.ts';
import { LayerDataError } from '../../src/data/instance-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankHierarchyLayer, type HierarchyLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';
const DEFICIT = 'Deficit [mm]';
const ZONE = 'Pacific/Auckland';

const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const rain = table.columns.find((c) => c.name === RAIN) as NumberColumn;
const calendars = { [TIME]: calendarFields(timeCol.values, ZONE) };
const cal = calendars[TIME]!;

function layer(patch: Partial<HierarchyLayer> = {}): HierarchyLayer {
  return {
    ...blankHierarchyLayer('h1', 'H', 'ds'),
    levels: [
      { kind: 'time', column: TIME, unit: 'decade' },
      { kind: 'time', column: TIME, unit: 'year' },
      { kind: 'time', column: TIME, unit: 'month' },
    ],
    valueColumn: RAIN,
    ...patch,
  };
}

function group(l: HierarchyLayer, first = 0, last = Infinity, t: Table = table): HierarchyTree {
  const inputs = prepareHierarchyInputs(l, t, calendars)!;
  return groupHierarchy(inputs, l.aggregate, first, last);
}

function labelOf(tree: HierarchyTree, i: number): string {
  return tree.labels[tree.label[i]!]!;
}

function childrenOf(tree: HierarchyTree, p: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < tree.nodeCount; i++) if (tree.parent[i] === p) out.push(i);
  return out;
}

/** Path of labels from the root's child down to node i. */
function path(tree: HierarchyTree, i: number): string[] {
  const out: string[] = [];
  for (let n = i; n > 0; n = tree.parent[n]!) out.unshift(labelOf(tree, n));
  return out;
}

function findPath(tree: HierarchyTree, labels: string[]): number {
  for (let i = 0; i < tree.nodeCount; i++) if (path(tree, i).join('/') === labels.join('/')) return i;
  return -1;
}

/** Rows of a local calendar year (naive reference). */
function rowsOfYear(year: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < table.rowCount; r++) if (cal.year[r] === year) out.push(r);
  return out;
}

describe('calendar helpers', () => {
  it('derives months and days with leap years', () => {
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1924)).toBe(true);
    // 1 March is day 59 in a common year and day 60 in a leap year.
    expect(monthOfDay(1923, 58)).toBe(1);
    expect(monthOfDay(1923, 59)).toBe(2);
    expect(dayOfMonth(1923, 59)).toBe(1);
    expect(monthOfDay(1924, 59)).toBe(1);
    expect(dayOfMonth(1924, 59)).toBe(29);
    expect(monthOfDay(1924, 60)).toBe(2);
    expect(monthOfDay(1924, 365)).toBe(11);
    expect(dayOfMonth(1924, 365)).toBe(31);
    expect(dayOfMonth(1923, 0)).toBe(1);
  });
});

describe('prepareHierarchyInputs', () => {
  it('is unconfigured until every level has a column', () => {
    expect(prepareHierarchyInputs(blankHierarchyLayer('h', 'H', 'ds'), table, calendars)).toBeNull();
  });

  it('rejects unknown columns and wrong column types', () => {
    expect(() => prepareHierarchyInputs(layer({ levels: [{ kind: 'time', column: 'nope', unit: 'year' }] }), table, calendars)).toThrow(
      /column "nope" not found/,
    );
    expect(() => prepareHierarchyInputs(layer({ levels: [{ kind: 'time', column: RAIN, unit: 'year' }] }), table, calendars)).toThrow(
      LayerDataError,
    );
    expect(() => prepareHierarchyInputs(layer({ levels: [{ kind: 'time', column: RAIN, unit: 'year' }] }), table, calendars)).toThrow(
      /needs a time column/,
    );
    expect(() => prepareHierarchyInputs(layer({ levels: [{ kind: 'category', column: TIME }] }), table, calendars)).toThrow(
      /needs a category column/,
    );
    expect(() => prepareHierarchyInputs(layer({ valueColumn: 'missing' }), table, calendars)).toThrow(/value column "missing" not found/);
    expect(() => prepareHierarchyInputs(layer({ valueColumn: TIME }), table, calendars)).toThrow(/needs numbers/);
    expect(() => prepareHierarchyInputs(layer(), table, {})).toThrow(/calendar fields/);
  });

  it('copies inputs once per shared array, leaving the table intact', () => {
    const inputs = prepareHierarchyInputs(layer(), table, calendars)!;
    const { inputs: copy, transfer } = copyInputs(inputs);
    // year + dayOfYear shared by three levels, plus the values.
    expect(transfer).toHaveLength(3);
    const lv = copy.levels[0]!;
    expect(lv.kind === 'time' && lv.year).not.toBe(cal.year);
    expect(lv.kind === 'time' && Array.from(lv.year.slice(0, 5))).toEqual(Array.from(cal.year.slice(0, 5)));
    expect(copy.values).not.toBe(rain.values);
  });

  it('keys the structure on levels, value column, aggregate and timezone, not rows', () => {
    const a = hierarchyStructureKey(layer(), ZONE);
    expect(hierarchyStructureKey(layer({ rows: [0.2, 0.5] }), ZONE)).toBe(a);
    expect(hierarchyStructureKey(layer({ layout: 'treemap', size: [10, 10] }), ZONE)).toBe(a);
    expect(hierarchyStructureKey(layer({ aggregate: 'mean' }), ZONE)).not.toBe(a);
    expect(hierarchyStructureKey(layer(), 'UTC')).not.toBe(a);
    expect(hierarchyStructureKey(layer({ levels: [{ kind: 'time', column: TIME, unit: 'year' }] }), ZONE)).not.toBe(a);
  });
});

describe('groupHierarchy on the rainfall record', () => {
  const tree = group(layer());

  it('builds a pre-order tree with labelled time levels', () => {
    expect(tree.levels).toBe(3);
    expect(tree.parent[0]).toBe(-1);
    expect(labelOf(tree, 0)).toBe('All');
    for (let i = 1; i < tree.nodeCount; i++) {
      const p = tree.parent[i]!;
      expect(p).toBeLessThan(i);
      expect(tree.depth[i]).toBe(tree.depth[p]! + 1);
    }
    const decades = childrenOf(tree, 0).map((i) => labelOf(tree, i));
    expect(decades[0]).toBe('1870s');
    expect(decades).toContain('1920s');
    // Ascending order.
    expect([...decades].sort()).toEqual(decades);
    const y1923 = findPath(tree, ['1920s', '1923']);
    expect(y1923).toBeGreaterThan(0);
    const months = childrenOf(tree, y1923).map((i) => labelOf(tree, i));
    expect(months[0]).toBe('Jan');
    expect(months.at(-1)).toBe('Dec');
    expect(tree.rows + tree.ungrouped).toBe(table.rowCount);
  });

  it('sums rows into leaves and parents, leaving missing values out', () => {
    for (const year of [1879, 1923, 1990]) {
      const rows = rowsOfYear(year);
      let sum = 0;
      let missing = 0;
      for (const r of rows) {
        const v = rain.values[r]!;
        if (Number.isNaN(v)) missing++;
        else sum += v;
      }
      const decade = `${Math.floor(year / 10) * 10}s`;
      const node = findPath(tree, [decade, String(year)]);
      expect(node).toBeGreaterThan(0);
      expect(tree.value[node]).toBeCloseTo(sum, 6);
      expect(tree.missing[node]).toBe(missing);
      expect(tree.count[node]! + tree.missing[node]!).toBe(rows.length);
      // A year's months add up to the year.
      const months = childrenOf(tree, node);
      const monthSum = months.reduce((s, m) => s + (Number.isNaN(tree.value[m]!) ? 0 : tree.value[m]!), 0);
      expect(monthSum).toBeCloseTo(sum, 6);
    }
    let total = 0;
    let missing = 0;
    for (let r = 0; r < table.rowCount; r++) {
      const v = rain.values[r]!;
      if (Number.isNaN(v)) missing++;
      else total += v;
    }
    expect(tree.value[0]).toBeCloseTo(total, 3);
    expect(tree.missingTotal).toBe(missing);
    expect(tree.missing[0]).toBe(missing);
  });

  it('takes March from the calendar, not from UTC', () => {
    // The first local day of March 1923: its reading is filed under Mar, never under Feb.
    const node = findPath(tree, ['1920s', '1923', 'Mar']);
    let sum = 0;
    for (let r = 0; r < table.rowCount; r++) {
      if (cal.year[r] !== 1923) continue;
      const d = cal.dayOfYear[r]!;
      if (d >= 59 && d < 90 && !Number.isNaN(rain.values[r]!)) sum += rain.values[r]!;
    }
    expect(tree.value[node]).toBeCloseTo(sum, 6);
  });

  it('computes a parent mean from sums and counts, not a mean of means', () => {
    const mean = group(layer({ aggregate: 'mean' }));
    const rows = rowsOfYear(1923);
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const v = rain.values[r]!;
      if (!Number.isNaN(v)) {
        sum += v;
        n++;
      }
    }
    const node = findPath(mean, ['1920s', '1923']);
    expect(mean.value[node]).toBeCloseTo(sum / n, 9);
    const months = childrenOf(mean, node);
    const meanOfMeans = months.reduce((s, m) => s + mean.value[m]!, 0) / months.length;
    expect(Math.abs(meanOfMeans - sum / n)).toBeGreaterThan(1e-6);
  });

  it('takes min, max and last per the aggregate', () => {
    const rows = rowsOfYear(1923).filter((r) => !Number.isNaN(rain.values[r]!));
    const vals = rows.map((r) => rain.values[r]!);
    const node = (t: HierarchyTree) => findPath(t, ['1920s', '1923']);
    const mn = group(layer({ aggregate: 'min' }));
    const mx = group(layer({ aggregate: 'max' }));
    const ls = group(layer({ aggregate: 'last' }));
    expect(mn.value[node(mn)]).toBe(Math.min(...vals));
    expect(mx.value[node(mx)]).toBe(Math.max(...vals));
    expect(ls.value[node(ls)]).toBe(vals.at(-1));
    // A parent's last is its last child's value.
    const dec = findPath(ls, ['1920s']);
    const kids = childrenOf(ls, dec);
    expect(ls.value[dec]).toBe(ls.value[kids.at(-1)!]);
  });

  it('counts rows when there is no value column', () => {
    const counts = group(layer({ valueColumn: null }));
    const node = findPath(counts, ['1920s', '1923']);
    expect(counts.value[node]).toBe(rowsOfYear(1923).length);
    expect(counts.value[0]).toBe(counts.rows);
    expect(counts.missingTotal).toBe(0);
    expect(counts.sizeByValue).toBe(true);
  });

  it('leaves nodes with no values missing (NaN), never zero', () => {
    const deficit = group(layer({ valueColumn: DEFICIT }));
    const col = table.columns.find((c) => c.name === DEFICIT)!;
    expect(deficit.missingTotal).toBe(col.nullCount);
    // The 1870s have no deficit data at all.
    const node = findPath(deficit, ['1870s']);
    expect(deficit.value[node]).toBeNaN();
    expect(deficit.count[node]).toBe(0);
  });

  it('groups only the requested row range', () => {
    const part = group(layer(), 100, 199);
    expect(part.rows + part.ungrouped).toBe(100);
    let sum = 0;
    for (let r = 100; r <= 199; r++) if (!Number.isNaN(rain.values[r]!)) sum += rain.values[r]!;
    expect(part.value[0]).toBeCloseTo(sum, 6);
    const empty = group(layer(), 10, 5);
    expect(empty.nodeCount).toBe(1);
    expect(empty.value[0]).toBeNaN();
  });

  it('groups day of month under a month', () => {
    const days = group(layer({ levels: [{ kind: 'time', column: TIME, unit: 'year' }, { kind: 'time', column: TIME, unit: 'month' }, { kind: 'time', column: TIME, unit: 'day' }] }));
    const feb1924 = findPath(days, ['1924', 'Feb']);
    const labels = childrenOf(days, feb1924).map((i) => labelOf(days, i));
    expect(labels[0]).toBe('1');
    expect(labels).toContain('29');
    expect(labels).not.toContain('30');
  });
});

describe('groupHierarchy with categories', () => {
  const t: Table = {
    rowCount: 6,
    columns: [
      { name: 'kind', index: 0, length: 6, nullCount: 1, empty: false, min: NaN, max: NaN, type: 'category', codes: Int32Array.from([0, 1, 0, -1, 1, 0]), dictionary: ['b', 'a'] },
      { name: 'v', index: 1, length: 6, nullCount: 1, empty: false, min: 1, max: 6, type: 'number', values: Float32Array.from([1, 2, 3, 4, NaN, 6]) },
    ],
  };

  it('uses the dictionary, first-seen order, and counts ungrouped rows', () => {
    const l = layer({ levels: [{ kind: 'category', column: 'kind' }], valueColumn: 'v' });
    const tree = groupHierarchy(prepareHierarchyInputs(l, t, {})!, 'sum', 0, 5);
    expect(tree.nodeCount).toBe(3);
    expect(labelOf(tree, 1)).toBe('b');
    expect(labelOf(tree, 2)).toBe('a');
    expect(tree.value[1]).toBe(10);
    expect(tree.value[2]).toBe(2);
    expect(tree.missing[2]).toBe(1);
    expect(tree.ungrouped).toBe(1); // the row with a missing category
    expect(tree.value[0]).toBe(12);
    expect(tree.missingTotal).toBe(1);
    const mean = groupHierarchy(prepareHierarchyInputs(l, t, {})!, 'mean', 0, 5);
    expect(mean.value[0]).toBeCloseTo(12 / 4, 9);
    expect(mean.sizeByValue).toBe(false);
  });

  it('refuses trees past the node limit', () => {
    const n = 200_001;
    const big: Table = {
      rowCount: n,
      columns: [
        { name: 'id', index: 0, length: n, nullCount: 0, empty: false, min: NaN, max: NaN, type: 'category', codes: Int32Array.from({ length: n }, (_, i) => i), dictionary: [] },
      ],
    };
    const l = layer({ levels: [{ kind: 'category', column: 'id' }], valueColumn: null });
    expect(() => groupHierarchy(prepareHierarchyInputs(l, big, {})!, 'sum', 0, n - 1)).toThrow(/more than 200000 nodes/);
  });
});

it('treats every aggregate name', () => {
  const all: Aggregate[] = ['mean', 'sum', 'min', 'max', 'last'];
  for (const a of all) expect(Number.isFinite(group(layer({ aggregate: a })).value[0])).toBe(true);
});
