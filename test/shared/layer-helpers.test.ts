import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { defaultLineLayerFor, summarise, type DatasetSummary } from '../../src/shared/layer-defaults.ts';
import {
  budgetReadout,
  datasetSwitchChanges,
  diffChanges,
  FRAME_BUDGET,
  instanceCount,
  LINE_RIDGE_HEIGHT,
  lineSegmentCount,
  ridgelineCloner,
  ridgelineLine,
  visibleRowCount,
} from '../../src/shared/layer-helpers.ts';
import {
  blankHeatmapLayer,
  blankHierarchyLayer,
  blankInstancerLayer,
  blankLineLayer,
  blankMultiplesLayer,
  blankSurfaceLayer,
  blankTextLayer,
  ClonerSchema,
  LayerSchema,
  type LayerConfig,
} from '../../src/shared/layer-schema.ts';
import type { Dataset } from '../../src/shared/project-schema.ts';

const DAY = 86_400_000;
const DATASET: Dataset = { id: 'ds-rain', file: '3384__Rain__daily.csv', label: 'Rainfall', timeZone: 'Pacific/Auckland', source: '', url: '', attribution: '', missing: [] };

/** Summary of the rainfall fixture, as the control window builds it. */
function fixtureSummary(): DatasetSummary {
  const parsed = parseCsv(fs.readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
  const cadences: Record<string, { step: number }> = {};
  for (const c of parsed.table.columns) {
    if (c.type === 'time' && !c.empty) cadences[c.name] = detectCadence((c as TimeColumn).values);
  }
  return summarise(parsed.table, cadences);
}

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

  it('multiplies instancer rows and line segments by the clone count', () => {
    const l = blankInstancerLayer('a', 'A', 'ds');
    l.cloner.count = 4;
    l.rows = [0, 0.5];
    expect(instanceCount(l, 1000)).toBe(2000);
    const line = blankLineLayer('b', 'B', 'ds');
    expect(lineSegmentCount(1000, line.rows)).toBe(999);
    expect(lineSegmentCount(1, line.rows)).toBe(0);
    expect(instanceCount(line, 1000)).toBe(999);
    line.cloner.count = 40;
    expect(instanceCount(line, 1000)).toBe(999 * 40);
    expect(instanceCount(blankMultiplesLayer('m', 'M', 'ds'), 1000)).toBe(1000);
    expect(instanceCount(blankSurfaceLayer('s', 'S', 'ds'), 1000)).toBe(0);
    expect(instanceCount(blankHierarchyLayer('h', 'H', 'ds'), 1000)).toBe(0);
  });

  it('reads out the product and warns over the budget', () => {
    expect(budgetReadout(42748, 1, 42748)).toBe('instances: 42,748 rows × 1 = 42,748\nall layers 42,748 of 200,000');
    expect(budgetReadout(42748, 5, 213740)).toContain('WARNING: over the 200,000 frame budget');
    expect(budgetReadout(1000, 2, FRAME_BUDGET + 1)).toContain('WARNING: all layers 200,001');
    expect(budgetReadout(364, 40, 14560, 'segments')).toBe('instances: 364 segments × 40 = 14,560\nall layers 14,560 of 200,000');
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

describe('line ridgeline preset', () => {
  const rain = fixtureSummary();
  const TIME = 'Observation time UTC';

  it('stacks 40 years of daily rainfall, filled in the background colour', () => {
    const line = defaultLineLayerFor('ln', 'Line', DATASET, rain);
    const r = ridgelineLine(line, rain, '#101010');
    expect(LayerSchema.safeParse(r).success).toBe(true);
    expect(r.cloner).toEqual({ ...line.cloner, count: 40, position: [0, 14, 0], orbit: [0, 0, 0], dataStep: 365, fade: 1 });
    expect(r.fill).toEqual({ mode: 'below', colour: '#101010', opacity: 1 });
    expect([r.width, r.colour]).toEqual([2, '#ffffff']);
    expect(r.rows).toEqual([0, 365 / 42748]);
    expect(r.y.column).toBe('Rainfall [mm]');
    expect(r.y.range).toEqual([0, LINE_RIDGE_HEIGHT]);
    // The first year runs across the usable width, and the stack is centred vertically.
    expect(r.origin[0]).toBeCloseTo(60);
    const span = (rain.columns.find((c) => c.name === TIME)!.max - rain.columns.find((c) => c.name === TIME)!.min) / DAY;
    expect(r.step[0] * span * (365 / 42748)).toBeCloseTo(1800);
    const top = r.origin[1] + 39 * 14 + LINE_RIDGE_HEIGHT;
    expect(r.origin[1]).toBeCloseTo(1080 - top);
    // Every field change validates as a minimal patch.
    const changes = diffChanges(line, r);
    expect(changes.some((c) => c.path[0] === 'name')).toBe(false);
    expect(LayerSchema.safeParse(applyChanges(line, changes)).success).toBe(true);
    // 364 segments x 40 clones, well inside the budget.
    expect(instanceCount(r, 42748)).toBe(lineSegmentCount(42748, r.rows) * 40);
    expect(instanceCount(r, 42748)).toBeLessThan(FRAME_BUDGET);
  });

  it('steps 1/40 of the visible rows without a daily column, and copes without data', () => {
    const line = { ...blankLineLayer('b', 'B', 'ds'), rows: [0, 0.5] as [number, number] };
    const r = ridgelineLine(line, summary(), '#000000');
    expect(r.cloner.dataStep).toBe(13);
    expect(r.rows).toEqual([0, 13 / 1000]);
    expect(r.y.column).toBe('rain');
    expect(LayerSchema.safeParse(r).success).toBe(true);
    const none = ridgelineLine(line, null, '#000000');
    expect(none.cloner.dataStep).toBe(1);
    expect(none.rows).toEqual([0, 1]);
    expect(none.origin).toEqual(line.origin);
    expect(LayerSchema.safeParse(none).success).toBe(true);
    // Never mutates its input.
    expect(line.cloner.count).toBe(1);
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

  it('re-points or drops small multiples columns', () => {
    const m = { ...blankMultiplesLayer('m', 'M', 'ds'), splitBy: 'year' as const, splitColumn: 'date', valueColumn: 'rain', domain: [0, 5] as [number, number] };
    const ch = datasetSwitchChanges(m, 'ds2', other);
    expect(ch).toContainEqual({ path: ['splitBy'], value: 'rows' });
    expect(ch).toContainEqual({ path: ['splitColumn'], value: null });
    expect(ch).toContainEqual({ path: ['valueColumn'], value: null });
    expect(ch).toContainEqual({ path: ['domain'], value: null });
    expect(LayerSchema.safeParse(applyChanges(m, ch)).success).toBe(true);
    const renamed = summary({ columns: [{ name: 'when', type: 'time', min: 0, max: DAY, empty: false }, ...summary().columns.slice(1)] });
    expect(datasetSwitchChanges(m, 'ds3', renamed)).toEqual([
      { path: ['datasetId'], value: 'ds3' },
      { path: ['splitColumn'], value: 'when' },
    ]);
    expect(datasetSwitchChanges(m, 'ds', summary())).toEqual([{ path: ['datasetId'], value: 'ds' }]);
  });

  it('repairs hierarchy levels, keeping at least one', () => {
    const h = {
      ...blankHierarchyLayer('h', 'H', 'ds'),
      levels: [
        { kind: 'time' as const, column: 'date', unit: 'decade' as const },
        { kind: 'category' as const, column: 'site' },
      ],
      valueColumn: 'rain',
    };
    const withSite = summary({ columns: [...summary().columns, { name: 'site', type: 'category', min: NaN, max: NaN, empty: false, categories: 3 }] });
    expect(datasetSwitchChanges(h, 'ds', withSite)).toEqual([{ path: ['datasetId'], value: 'ds' }]);
    // The site column is gone: that level is dropped.
    expect(datasetSwitchChanges(h, 'ds', summary())).toContainEqual({ path: ['levels'], value: [h.levels[0]] });
    // Nothing to group by: the first level is kept as it is, and the value column dropped.
    const ch = datasetSwitchChanges(h, 'ds2', other);
    expect(ch).toContainEqual({ path: ['levels'], value: [h.levels[0]] });
    expect(ch).toContainEqual({ path: ['valueColumn'], value: null });
    expect(LayerSchema.safeParse(applyChanges(h, ch)).success).toBe(true);
    // A new blank level gets a real column.
    const blank = blankHierarchyLayer('b', 'B', null);
    expect(datasetSwitchChanges(blank, 'ds', summary())).toContainEqual({ path: ['levels'], value: [{ kind: 'time', column: 'date', unit: 'decade' }] });
  });

  it('treats a surface like a heat map', () => {
    const s = { ...blankSurfaceLayer('s', 'S', 'ds'), layout: 'calendar' as const, timeColumn: 'date', valueColumn: 'rain', domain: [0, 1] as [number, number] };
    const ch = datasetSwitchChanges(s, 'ds2', other);
    expect(ch).toContainEqual({ path: ['timeColumn'], value: null });
    expect(ch).toContainEqual({ path: ['layout'], value: 'grid' });
    expect(ch).toContainEqual({ path: ['valueColumn'], value: null });
    expect(LayerSchema.safeParse(applyChanges(s, ch)).success).toBe(true);
    expect(datasetSwitchChanges({ ...s, timeColumn: null }, 'ds', summary())).toContainEqual({ path: ['timeColumn'], value: 'date' });
  });

  it('only changes the id for text, a null dataset or an unparsed one', () => {
    expect(datasetSwitchChanges(blankTextLayer('t', 'T', null), 'ds', summary())).toEqual([{ path: ['datasetId'], value: 'ds' }]);
    expect(datasetSwitchChanges(blankInstancerLayer('a', 'A', 'ds'), null, null)).toEqual([{ path: ['datasetId'], value: null }]);
  });
});
