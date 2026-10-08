import { describe, expect, it } from 'vitest';
import type { DatasetSummary } from '../../src/shared/layer-defaults.ts';
import {
  budgetReadout,
  datasetSwitchChanges,
  diffChanges,
  FRAME_BUDGET,
  instanceCount,
  ridgelineCloner,
  visibleRowCount,
} from '../../src/shared/layer-helpers.ts';
import {
  blankHeatmapLayer,
  blankInstancerLayer,
  blankLineLayer,
  blankTextLayer,
  ClonerSchema,
  LayerSchema,
  type LayerConfig,
} from '../../src/shared/layer-schema.ts';

const DAY = 86_400_000;

function summary(over: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    rowCount: 1000,
    columns: [
      { name: 'date', type: 'time', min: 0, max: 999 * DAY, empty: false },
      { name: 'rain', type: 'number', min: 0, max: 10, empty: false },
    ],
    cadences: { date: { step: DAY } },
    ...over,
  };
}

/** Apply relative changes to a layer copy (for checking the result validates). */
function applyChanges(layer: LayerConfig, changes: { path: (string | number)[]; value: unknown }[]): LayerConfig {
  const out = structuredClone(layer) as unknown as Record<string, unknown>;
  for (const c of changes) {
    let node = out;
    for (const k of c.path.slice(0, -1)) node = node[k] as Record<string, unknown>;
    node[c.path[c.path.length - 1]!] = c.value;
  }
  return out as unknown as LayerConfig;
}

describe('instance budget', () => {
  it('counts visible rows as the output does', () => {
    expect(visibleRowCount(1000, [0, 1])).toBe(1000);
    expect(visibleRowCount(1000, [0.25, 0.5])).toBe(250);
    expect(visibleRowCount(1000, [0.5, 0.25])).toBe(250);
    expect(visibleRowCount(1000, [0.5, 0.5])).toBe(0);
    expect(visibleRowCount(0, [0, 1])).toBe(0);
    expect(visibleRowCount(Number.NaN, [0, 1])).toBe(0);
  });

  it('multiplies instancer rows by the clone count; other types draw no instances', () => {
    const l = blankInstancerLayer('a', 'A', 'ds');
    l.cloner.count = 4;
    l.rows = [0, 0.5];
    expect(instanceCount(l, 1000)).toBe(2000);
    expect(instanceCount(blankLineLayer('b', 'B', 'ds'), 1000)).toBe(0);
  });

  it('reads out the product and warns over the budget', () => {
    expect(budgetReadout(42748, 1, 42748)).toBe('instances: 42,748 rows × 1 = 42,748\nall layers 42,748 of 200,000');
    expect(budgetReadout(42748, 5, 213740)).toContain('WARNING: over the 200,000 frame budget');
    expect(budgetReadout(1000, 2, FRAME_BUDGET + 1)).toContain('WARNING: all layers 200,001');
  });
});

describe('ridgeline preset', () => {
  it('steps a year of daily rows per clone', () => {
    const l = { ...blankInstancerLayer('a', 'A', 'ds'), xMode: 'time' as const, timeColumn: 'date' };
    const r = ridgelineCloner(l, summary());
    expect(r).toEqual({ count: 40, position: [0, 12, 0], dataStep: 365, fade: 0.98 });
    expect(ClonerSchema.safeParse({ ...l.cloner, ...r }).success).toBe(true);
  });

  it('uses 1/40 of the visible rows otherwise', () => {
    const l = { ...blankInstancerLayer('a', 'A', 'ds'), rows: [0, 0.5] as [number, number] };
    expect(ridgelineCloner(l, summary()).dataStep).toBe(13);
    expect(ridgelineCloner({ ...l, timeColumn: 'date' }, summary({ cadences: { date: { step: 3_600_000 } } })).dataStep).toBe(13);
    expect(ridgelineCloner(l, null).dataStep).toBe(1);
  });
});

describe('diffChanges', () => {
  it('produces minimal field paths, tuples whole', () => {
    const a = { x: 1, t: [1, 2], o: { p: 'a', q: [0, 0] } };
    const b = { x: 1, t: [1, 3], o: { p: 'a', q: [0, 1] } };
    expect(diffChanges(a, b)).toEqual([
      { path: ['t'], value: [1, 3] },
      { path: ['o', 'q'], value: [0, 1] },
    ]);
    expect(diffChanges(a, structuredClone(a))).toEqual([]);
    expect(diffChanges({ d: null }, { d: [0, 1] })).toEqual([{ path: ['d'], value: [0, 1] }]);
  });
});

describe('datasetSwitchChanges', () => {
  const other = summary({
    columns: [{ name: 'value', type: 'number', min: 0, max: 1, empty: false }],
    cadences: {},
  });

  it('drops missing columns and time mode on an instancer', () => {
    const l = { ...blankInstancerLayer('a', 'A', 'ds'), xMode: 'time' as const, timeColumn: 'date' };
    l.channels.colour.column = 'rain';
    l.channels.colour.domain = [0, 5];
    const ch = datasetSwitchChanges(l, 'ds2', other);
    expect(ch).toContainEqual({ path: ['datasetId'], value: 'ds2' });
    expect(ch).toContainEqual({ path: ['timeColumn'], value: null });
    expect(ch).toContainEqual({ path: ['xMode'], value: 'index' });
    expect(ch).toContainEqual({ path: ['channels', 'colour', 'column'], value: null });
    expect(LayerSchema.safeParse(applyChanges(l, ch)).success).toBe(true);
  });

  it('handles line mappings', () => {
    const l = blankLineLayer('b', 'B', 'ds');
    l.y.column = 'rain';
    l.colourMap.column = 'value';
    const ch = datasetSwitchChanges(l, 'ds2', other);
    expect(ch).toContainEqual({ path: ['y', 'column'], value: null });
    expect(ch).not.toContainEqual({ path: ['colourMap', 'column'], value: null });
  });

  it('turns a heat map calendar into a grid without a time column, and picks a daily one with', () => {
    const h = { ...blankHeatmapLayer('c', 'C', 'ds'), layout: 'calendar' as const, timeColumn: 'date', valueColumn: 'rain', domain: [0, 1] as [number, number] };
    const ch = datasetSwitchChanges(h, 'ds2', other);
    expect(ch).toContainEqual({ path: ['layout'], value: 'grid' });
    expect(ch).toContainEqual({ path: ['valueColumn'], value: null });
    expect(ch).toContainEqual({ path: ['domain'], value: null });
    expect(LayerSchema.safeParse(applyChanges(h, ch)).success).toBe(true);
    const back = datasetSwitchChanges({ ...h, timeColumn: null }, 'ds', summary());
    expect(back).toContainEqual({ path: ['timeColumn'], value: 'date' });
  });

  it('only changes the id for text, a null dataset or an unparsed one', () => {
    expect(datasetSwitchChanges(blankTextLayer('t', 'T', null), 'ds', summary())).toEqual([{ path: ['datasetId'], value: 'ds' }]);
    expect(datasetSwitchChanges(blankInstancerLayer('a', 'A', 'ds'), null, null)).toEqual([{ path: ['datasetId'], value: null }]);
  });
});
