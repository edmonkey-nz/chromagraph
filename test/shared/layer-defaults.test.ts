import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { parseCsv } from '../../src/data/parse.ts';
import {
  defaultHeatmapLayerFor,
  defaultHierarchyLayerFor,
  defaultHierarchyLevels,
  defaultLayerFor,
  defaultMultiplesLayerFor,
  defaultSurfaceLayerFor,
  fitHierarchyLayer,
  fitMultiplesLayer,
  isRoundLayout,
  panelCount,
  panelGrid,
  panelLabelSize,
  defaultLayerOfType,
  defaultLineLayerFor,
  defaultTextLayerFor,
  fitAnyLayer,
  fitHeatmapLayer,
  fitLayer,
  fitLineLayer,
  fitTextLayer,
  summarise,
  textTemplateFor,
  tSpanOf,
  type DatasetSummary,
} from '../../src/shared/layer-defaults.ts';
import {
  ARRANGEMENTS,
  blankHeatmapLayer,
  blankHierarchyLayer,
  blankInstancerLayer,
  blankLineLayer,
  blankMultiplesLayer,
  blankSurfaceLayer,
  blankTextLayer,
  InstancerLayerSchema,
  LAYER_TYPES,
  LayerSchema,
  type InstancerLayer,
  type LayerConfig,
} from '../../src/shared/layer-schema.ts';
import type { Dataset } from '../../src/shared/project-schema.ts';

const FULL = fs.readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8');
const parsed = parseCsv(FULL);
const cadences: Record<string, { step: number }> = {};
for (const c of parsed.table.columns) {
  if (c.type === 'time' && !c.empty) cadences[c.name] = detectCadence((c as TimeColumn).values);
}
const rain = summarise(parsed.table, cadences);
const TZ = 'Pacific/Auckland';
const dataset: Dataset = { id: 'ds-rain', file: '3384__Rain__daily.csv', label: 'Rainfall', timeZone: TZ };

const DAY = 86_400_000;

/** Every number anywhere in the layer is finite. */
function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === 'object') return Object.values(v).every(allFinite);
  return true;
}

function expectValid(layer: InstancerLayer): void {
  const r = InstancerLayerSchema.safeParse(layer);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  expect(allFinite(layer)).toBe(true);
}

function syntheticSummary(over: Partial<DatasetSummary> = {}): DatasetSummary {
  return { rowCount: 0, columns: [], cadences: {}, ...over };
}

const timeCol = rain.columns.find((c) => c.name === 'Observation time UTC')!;
const yearsIn = (ms: number) => Number(new Intl.DateTimeFormat('en-NZ', { timeZone: TZ, year: 'numeric' }).format(ms));

describe('summarise', () => {
  it('keeps names, types, ranges and cadence steps', () => {
    expect(rain.rowCount).toBe(42748);
    expect(rain.columns.map((c) => c.name)).toEqual(parsed.table.columns.map((c) => c.name));
    expect(timeCol.type).toBe('time');
    expect(rain.cadences['Observation time UTC']!.step).toBe(DAY);
    expect(Object.keys(rain.cadences['Observation time UTC']!)).toEqual(['step']);
  });
});

describe('defaultLayerFor (rainfall fixture)', () => {
  const layer = defaultLayerFor('ly-1', 'Layer 1', dataset, rain);

  it('is the daily calendar view coloured by rainfall', () => {
    expect(layer.id).toBe('ly-1');
    expect(layer.name).toBe('Layer 1');
    expect(layer.datasetId).toBe('ds-rain');
    expect(layer.xMode).toBe('time');
    expect(layer.timeColumn).toBe('Observation time UTC');
    expect(layer.arrangement).toBe('calendar');
    expect(layer.primitive).toBe('square');
    expect(layer.channels.colour.column).toBe('Rainfall [mm]');
    expect(layer.channels.colour.scale).toBe('sqrt');
    expect(layer.channels.colour.ramp).toBe('viridis');
    expect(layer.channels.colour.domain).toBeNull();
    expect(layer.channels.height.column).toBeNull();
  });

  it('validates and fills the frame with one row per year', () => {
    expectValid(layer);
    const years = yearsIn(timeCol.max) - yearsIn(timeCol.min) + 1;
    expect(years).toBeGreaterThan(100);
    expect(layer.cell[0]).toBeCloseTo(1800 / 366);
    expect(layer.cell[1]).toBeCloseTo(960 / years);
    expect(layer.origin).toEqual([60, 1080 - 60 - layer.cell[1] / 2, 0]);
    expect(layer.size).toEqual([layer.cell[0], layer.cell[1], layer.cell[1]]);
    // Bottom row centre sits half a cell above the bottom margin.
    expect(layer.origin[1] - (years - 1) * layer.cell[1]).toBeCloseTo(60 + layer.cell[1] / 2);
  });

  it('uses linear bars for a non-daily time series', () => {
    const hourly: DatasetSummary = { ...rain, cadences: { 'Observation time UTC': { step: 3_600_000 } } };
    const l = defaultLayerFor('ly-2', 'Layer 2', dataset, hourly);
    expect(l.xMode).toBe('time');
    expect(l.arrangement).toBe('linear');
    expect(l.primitive).toBe('bar');
    expect(l.channels.height.column).toBe('Rainfall [mm]');
    expect(l.channels.colour.column).toBe('Rainfall [mm]');
    expectValid(l);
  });

  it('uses index-mode bars when there is no time column', () => {
    const noTime: DatasetSummary = { ...rain, columns: rain.columns.filter((c) => c.type !== 'time'), cadences: {} };
    const l = defaultLayerFor('ly-3', 'Layer 3', dataset, noTime);
    expect(l.xMode).toBe('index');
    expect(l.timeColumn).toBeNull();
    expect(l.arrangement).toBe('linear');
    expect(l.primitive).toBe('bar');
    expect(l.step[0]).toBeCloseTo(1800 / (42748 - 1));
    expectValid(l);
  });

  it('accepts a cadence within 10% of a day as daily', () => {
    const near: DatasetSummary = { ...rain, cadences: { 'Observation time UTC': { step: DAY * 1.09 } } };
    expect(defaultLayerFor('a', 'A', dataset, near).arrangement).toBe('calendar');
    const far: DatasetSummary = { ...rain, cadences: { 'Observation time UTC': { step: DAY * 1.2 } } };
    expect(defaultLayerFor('b', 'B', dataset, far).arrangement).toBe('linear');
  });
});

describe('fitLayer', () => {
  const base = defaultLayerFor('ly-1', 'Layer 1', dataset, rain);
  const tSpan = (timeCol.max - timeCol.min) / DAY;

  it('measures t in cadence steps in time mode and rows in index mode', () => {
    expect(tSpanOf(base, rain)).toBeCloseTo(tSpan);
    expect(tSpanOf({ ...base, xMode: 'index' }, rain)).toBe(42747);
  });

  it('linear spreads the span across the usable width', () => {
    const l = fitLayer({ ...base, arrangement: 'linear' }, rain, TZ);
    expectValid(l);
    expect(l.origin).toEqual([60, 140, 0]);
    expect(l.step[0] * tSpan).toBeCloseTo(1800);
    expect(l.step[1]).toBe(0);
    expect(l.size[0]).toBeGreaterThanOrEqual(2);
    expect(l.channels.height.range[1]).toBe(800);
    expect(140 + l.channels.height.range[1]).toBeLessThanOrEqual(1020);
  });

  it('linear bars are 80% of a wide step', () => {
    const tiny: DatasetSummary = syntheticSummary({ rowCount: 11 });
    const l = fitLayer(blankInstancerLayer('x', 'X', null), tiny, TZ);
    expect(l.step[0]).toBeCloseTo(180);
    expect(l.size[0]).toBeCloseTo(144);
    expectValid(l);
  });

  it('linear respects the visible row range', () => {
    const half = fitLayer({ ...base, arrangement: 'linear', rows: [0.5, 1] }, rain, TZ);
    expect(half.step[0] * tSpan * 0.5).toBeCloseTo(1800);
    // Without followRange the first visible row lands on the left margin.
    expect(half.origin[0] + tSpan * 0.5 * half.step[0]).toBeCloseTo(60);
    const follow = fitLayer({ ...base, arrangement: 'linear', rows: [0.5, 1], followRange: true }, rain, TZ);
    expect(follow.origin[0]).toBe(60);
    expectValid(half);
    expectValid(follow);
  });

  it('grid chooses columns for a 16:9 frame and stays inside it', () => {
    const l = fitLayer({ ...base, arrangement: 'grid' }, rain, TZ);
    expectValid(l);
    const n = Math.floor(tSpan) + 1;
    const rows = Math.ceil(n / l.gridColumns);
    expect(Number.isInteger(l.gridColumns)).toBe(true);
    expect(l.gridColumns * l.cell[0]).toBeCloseTo(1800);
    expect(rows * l.cell[1]).toBeCloseTo(960);
    // Cells come out roughly square.
    expect(l.cell[0] / l.cell[1]).toBeGreaterThan(0.8);
    expect(l.cell[0] / l.cell[1]).toBeLessThan(1.25);
    expect(l.origin[0] - l.cell[0] / 2).toBeCloseTo(60);
    expect(l.origin[1] + l.cell[1] / 2).toBeCloseTo(1020);
  });

  it('calendar counts only the visible years', () => {
    const recent = fitLayer({ ...base, rows: [0.9, 1], followRange: true }, rain, TZ);
    expectValid(recent);
    expect(recent.cell[1]).toBeGreaterThan(base.cell[1] * 5);
    expect(recent.origin[1]).toBeCloseTo(1020 - recent.cell[1] / 2);
  });

  it('radial centres a 400 px ring with one turn over the span', () => {
    const l = fitLayer({ ...base, arrangement: 'radial' }, rain, TZ);
    expectValid(l);
    expect(l.origin).toEqual([960, 540, 0]);
    expect(l.radius).toBe(400);
    expect(l.angleStep * tSpan).toBeCloseTo(360);
    expect(l.size[0]).toBeGreaterThanOrEqual(2);
  });

  it('spiral turns once a year for daily data and reaches 480 px', () => {
    const l = fitLayer({ ...base, arrangement: 'spiral' }, rain, TZ);
    expectValid(l);
    expect(l.origin).toEqual([960, 540, 0]);
    expect(l.radius).toBe(80);
    expect(l.angleStep).toBeCloseTo(360 / 365.2425);
    expect(l.radius + tSpan * l.radiusStep).toBeCloseTo(480);
  });

  it('spiral makes about 12 turns for non-daily data', () => {
    const l = fitLayer({ ...base, arrangement: 'spiral', xMode: 'index' }, rain, TZ);
    expectValid(l);
    expect((l.angleStep * 42747) / 360).toBeCloseTo(12);
    expect(l.radius + 42747 * l.radiusStep).toBeCloseTo(480);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(base);
    const fitted = fitLayer({ ...base, arrangement: 'grid' }, rain, TZ);
    fitted.channels.height.range[1] = -1;
    fitted.origin[0] = -1;
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('degenerate inputs', () => {
  const empty = syntheticSummary();
  const oneRow = syntheticSummary({
    rowCount: 1,
    columns: [
      { name: 't', type: 'time', min: 1e12, max: 1e12, empty: false },
      { name: 'v', type: 'number', min: 3, max: 3, empty: false },
    ],
    cadences: {},
  });
  const nanCadence = syntheticSummary({
    rowCount: 5,
    columns: [{ name: 't', type: 'time', min: 0, max: 4 * DAY, empty: false }],
    cadences: { t: { step: NaN } },
  });
  const allEmpty = syntheticSummary({
    rowCount: 100,
    columns: [{ name: 'x', type: 'number', min: NaN, max: NaN, empty: true }],
  });

  for (const [label, summary] of [
    ['no rows', empty],
    ['one row', oneRow],
    ['no cadence', nanCadence],
    ['only empty columns', allEmpty],
  ] as const) {
    it(`${label}: default and every arrangement stay valid and finite`, () => {
      const d = defaultLayerFor('ly', 'L', dataset, summary);
      expectValid(d);
      for (const arrangement of ARRANGEMENTS) {
        for (const xMode of ['index', 'time'] as const) {
          for (const rows of [[0, 1], [0.5, 0.5], [1, 0]] as [number, number][]) {
            const l = fitLayer({ ...d, arrangement, xMode, timeColumn: 't', rows }, summary, TZ);
            expectValid(l);
          }
        }
      }
    });
  }

  it('maps nothing when no numeric column varies', () => {
    const l = defaultLayerFor('ly', 'L', dataset, oneRow);
    expect(l.channels.colour.column).toBeNull();
    expect(l.channels.height.column).toBeNull();
    expect(l.xMode).toBe('time');
  });

  it('falls back to UTC for an unknown timezone', () => {
    const l = fitLayer(defaultLayerFor('ly', 'L', dataset, rain), rain, 'Not/AZone');
    expectValid(l);
    expect(l.arrangement).toBe('calendar');
  });

  it('uses linear colour for signed data on a daily calendar', () => {
    const signed = syntheticSummary({
      rowCount: 10,
      columns: [
        { name: 't', type: 'time', min: 0, max: 9 * DAY, empty: false },
        { name: 'v', type: 'number', min: -5, max: 5, empty: false },
      ],
      cadences: { t: { step: DAY } },
    });
    const l = defaultLayerFor('ly', 'L', dataset, signed);
    expect(l.arrangement).toBe('calendar');
    expect(l.channels.colour.scale).toBe('linear');
    expectValid(l);
  });
});

function expectLayerValid(layer: LayerConfig): void {
  const r = LayerSchema.safeParse(layer);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
  expect(allFinite(layer)).toBe(true);
}

const years = yearsIn(timeCol.max) - yearsIn(timeCol.min) + 1;
const tSpanDays = (timeCol.max - timeCol.min) / DAY;

describe('line defaults', () => {
  const line = defaultLineLayerFor('ln-1', 'Line', dataset, rain);

  it('runs in time mode on the time column with y from rainfall over ±300 px', () => {
    expectLayerValid(line);
    expect(line.type).toBe('line');
    expect(line.datasetId).toBe('ds-rain');
    expect(line.xMode).toBe('time');
    expect(line.timeColumn).toBe('Observation time UTC');
    expect(line.y.column).toBe('Rainfall [mm]');
    expect(line.y.range).toEqual([-300, 300]);
    expect(line.y.domain).toBeNull();
    expect(line.width).toBe(2);
  });

  it('fits the span to the usable width with its origin mid-frame', () => {
    expect(line.origin).toEqual([60, 540, 0]);
    expect(line.step[0] * tSpanDays).toBeCloseTo(1800);
    expect(line.step[1]).toBe(0);
  });

  it('uses index mode without a time column', () => {
    const noTime: DatasetSummary = { ...rain, columns: rain.columns.filter((c) => c.type !== 'time'), cadences: {} };
    const l = defaultLineLayerFor('ln', 'L', dataset, noTime);
    expectLayerValid(l);
    expect(l.xMode).toBe('index');
    expect(l.timeColumn).toBeNull();
    expect(l.step[0]).toBeCloseTo(1800 / 42747);
  });

  it('fit respects the visible rows and keeps the y range', () => {
    const half = fitLineLayer({ ...line, rows: [0.5, 1], y: { ...line.y, range: [-100, 50] } }, rain);
    expectLayerValid(half);
    expect(half.step[0] * tSpanDays * 0.5).toBeCloseTo(1800);
    expect(half.origin[0] + tSpanDays * 0.5 * half.step[0]).toBeCloseTo(60);
    expect(half.y.range).toEqual([-100, 50]);
    const follow = fitLineLayer({ ...line, rows: [0.5, 1], followRange: true }, rain);
    expect(follow.origin[0]).toBe(60);
  });
});

describe('heat map defaults', () => {
  const heat = defaultHeatmapLayerFor('hm-1', 'Heat', dataset, rain);

  it('is a calendar of rainfall for daily data', () => {
    expectLayerValid(heat);
    expect(heat.type).toBe('heatmap');
    expect(heat.layout).toBe('calendar');
    expect(heat.timeColumn).toBe('Observation time UTC');
    expect(heat.valueColumn).toBe('Rainfall [mm]');
    expect(heat.scale).toBe('sqrt');
    expect(heat.domain).toBeNull();
  });

  it('fits 366 days across and one row per year down, from the top-left margin', () => {
    expect(heat.cell[0]).toBeCloseTo(1800 / 366);
    expect(heat.cell[1]).toBeCloseTo(960 / years);
    expect(heat.origin).toEqual([60, 1020, 0]);
    expect(heat.origin[1] - years * heat.cell[1]).toBeCloseTo(60);
  });

  it('calendar fit counts only the visible years and lifts the origin to the first one', () => {
    const recent = fitHeatmapLayer({ ...heat, rows: [0.9, 1] }, rain, TZ);
    expectLayerValid(recent);
    expect(recent.cell[1]).toBeGreaterThan(heat.cell[1] * 5);
    const firstVisible = yearsIn(timeCol.min + (timeCol.max - timeCol.min) * 0.9) - yearsIn(timeCol.min);
    expect(recent.origin[1] - firstVisible * recent.cell[1]).toBeCloseTo(1020);
  });

  it('is a grid in row order without a daily column', () => {
    const hourly: DatasetSummary = { ...rain, cadences: { 'Observation time UTC': { step: 3_600_000 } } };
    const g = defaultHeatmapLayerFor('hm-2', 'Grid', dataset, hourly);
    expectLayerValid(g);
    expect(g.layout).toBe('grid');
    expect(g.valueColumn).toBe('Rainfall [mm]');
    const rows = Math.ceil(42748 / g.gridColumns);
    expect(g.gridColumns * g.cell[0]).toBeCloseTo(1800);
    expect(rows * g.cell[1]).toBeCloseTo(960);
    expect(g.cell[0] / g.cell[1]).toBeGreaterThan(0.8);
    expect(g.cell[0] / g.cell[1]).toBeLessThan(1.25);
    expect(g.origin).toEqual([60, 1020, 0]);
  });

  it('uses a linear scale for signed values', () => {
    const signed = syntheticSummary({
      rowCount: 10,
      columns: [{ name: 'v', type: 'number', min: -5, max: 5, empty: false }],
    });
    const g = defaultHeatmapLayerFor('hm', 'H', dataset, signed);
    expect(g.layout).toBe('grid');
    expect(g.scale).toBe('linear');
    expectLayerValid(g);
  });
});

describe('text defaults', () => {
  it('shows the date and rainfall at the current row, top left at 48 px', () => {
    const t = defaultTextLayerFor('tx-1', 'Caption', dataset, rain);
    expectLayerValid(t);
    expect(t.text).toBe('{Observation time UTC|date}  {Rainfall [mm]|fixed:1} mm');
    expect(t.fontSize).toBe(48);
    expect(t.position).toEqual([60, 1020, 0]);
    expect([t.anchorX, t.anchorY, t.align]).toEqual(['left', 'top', 'left']);
    expect(t.row).toBe(0);
    expect(t.datasetId).toBe('ds-rain');
  });

  it('is static text without a dataset', () => {
    const t = defaultTextLayerFor('tx-2', 'Title', null, null);
    expectLayerValid(t);
    expect(t.datasetId).toBeNull();
    expect(t.text).not.toContain('{');
  });

  it('builds templates from whatever columns exist', () => {
    expect(textTemplateFor(syntheticSummary({ columns: [{ name: 'v [°C]', type: 'number', min: 1, max: 2, empty: false }] }))).toBe(
      '{v [°C]|fixed:1} °C',
    );
    expect(textTemplateFor(syntheticSummary({ columns: [{ name: 'when', type: 'time', min: 0, max: DAY, empty: false }] }))).toBe('{when|date}');
    expect(textTemplateFor(syntheticSummary({ columns: [{ name: 'a{b}', type: 'number', min: 1, max: 2, empty: false }] }))).toBeNull();
    expect(textTemplateFor(syntheticSummary())).toBeNull();
  });

  it('fit puts the anchor at the matching margin point and wraps at the usable width', () => {
    const t = fitTextLayer({ ...blankTextLayer('t', 'T', null), position: [-500, 4000, 7], maxWidth: 0, anchorX: 'center', anchorY: 'bottom' });
    expectLayerValid(t);
    expect(t.position).toEqual([960, 60, 0]);
    expect(t.maxWidth).toBe(1800);
    const r = fitTextLayer({ ...t, anchorX: 'right', anchorY: 'middle' });
    expect(r.position).toEqual([1860, 540, 0]);
  });
});

describe('small multiples defaults', () => {
  it('splits the rainfall by year: 119 bar panels, 12 per line, filling the frame', () => {
    expect(rain.columns.find((c) => c.name === 'Frequency [D/H]')!.categories).toBeGreaterThan(0);
    const m = defaultMultiplesLayerFor('sm-1', 'Years', dataset, rain);
    expectLayerValid(m);
    expect(m.splitBy).toBe('year');
    expect(m.splitColumn).toBe('Observation time UTC');
    expect(m.valueColumn).toBe('Rainfall [mm]');
    expect(m.chart).toBe('bars');
    expect([m.colourByValue, m.scale, m.domain]).toEqual([true, 'sqrt', null]);
    expect(panelCount(m, rain, TZ)).toBe(119);
    expect(m.columns).toBe(12);
    const lines = Math.ceil(119 / m.columns);
    expect(m.columns * m.panelSize[0] + (m.columns - 1) * m.gap[0]).toBeCloseTo(1800);
    expect(lines * m.panelSize[1] + (lines - 1) * m.gap[1]).toBeCloseTo(960);
    expect(m.gap[0]).toBeGreaterThan(0);
    expect(m.gap[0]).toBeLessThanOrEqual(8);
    expect(m.origin).toEqual([60, 1020, 0]);
    expect(m.labelSize).toBe(14);
  });

  it('counts panels for every split and the visible rows', () => {
    const m = defaultMultiplesLayerFor('sm', 'S', dataset, rain);
    expect(panelCount({ ...m, splitBy: 'decade' }, rain, TZ)).toBe(13); // 1870s..1990s
    expect(panelCount({ ...m, splitBy: 'month' }, rain, TZ)).toBe(118 * 12 + 2 + 1); // Jan 1879 (NZ) .. Mar 1997 (NZ)
    expect(panelCount({ ...m, rows: [0, 0.5] }, rain, TZ)).toBeLessThan(62);
    expect(panelCount({ ...m, splitBy: 'rows', chunkRows: 1000 }, rain, TZ)).toBe(43);
    expect(panelCount({ ...m, splitBy: 'category', splitColumn: 'Frequency [D/H]' }, rain, TZ)).toBe(
      rain.columns.find((c) => c.name === 'Frequency [D/H]')!.categories,
    );
    expect(panelCount({ ...m, splitColumn: 'nope' }, rain, TZ)).toBe(1);
  });

  it('falls back to categories, then row chunks', () => {
    const cats = syntheticSummary({
      rowCount: 600,
      columns: [
        { name: 'site', type: 'category', min: NaN, max: NaN, empty: false, categories: 6 },
        { name: 'v', type: 'number', min: -1, max: 1, empty: false },
      ],
    });
    const c = defaultMultiplesLayerFor('sm', 'S', dataset, cats);
    expectLayerValid(c);
    expect([c.splitBy, c.splitColumn, c.scale]).toEqual(['category', 'site', 'linear']);
    expect(c.columns).toBe(3);
    expect(c.labelSize).toBe(24);
    const plain = syntheticSummary({ rowCount: 600, columns: [{ name: 'v', type: 'number', min: 0, max: 1, empty: false }] });
    const r = defaultMultiplesLayerFor('sm', 'S', dataset, plain);
    expectLayerValid(r);
    expect([r.splitBy, r.splitColumn, r.chunkRows]).toEqual(['rows', null, 10]);
    expect(panelCount(r, plain, TZ)).toBe(60);
  });

  it('turns labels off when the panels are small', () => {
    expect(panelLabelSize(200)).toBe(24);
    expect(panelLabelSize(88)).toBe(14);
    expect(panelLabelSize(30)).toBe(0);
    const tiny = defaultMultiplesLayerFor('sm', 'S', dataset, syntheticSummary({ rowCount: 5000, columns: [{ name: 'v', type: 'number', min: 0, max: 1, empty: false }] }));
    expect(fitMultiplesLayer({ ...tiny, chunkRows: 5 }, syntheticSummary({ rowCount: 5000 }), TZ).panelSize[1]).toBeLessThan(60);
  });

  it('panel grids always fill the usable frame', () => {
    for (const n of [1, 2, 7, 119, 1000, 42748]) {
      const g = panelGrid(n);
      const lines = Math.ceil(n / g.columns);
      expect(g.columns).toBeGreaterThanOrEqual(1);
      expect(g.columns * g.panel[0] + (g.columns - 1) * g.gap[0]).toBeCloseTo(1800);
      if (g.panel[1] > 1) expect(lines * g.panel[1] + (lines - 1) * g.gap[1]).toBeCloseTo(960);
    }
    expect(panelGrid(1).panel).toEqual([1800, 960]);
  });
});

describe('hierarchy defaults', () => {
  it('groups the rainfall by decade then year, summing rainfall, as a centred radial dendrogram', () => {
    const h = defaultHierarchyLayerFor('hi-1', 'Tree', dataset, rain);
    expectLayerValid(h);
    expect(h.levels).toEqual([
      { kind: 'time', column: 'Observation time UTC', unit: 'decade' },
      { kind: 'time', column: 'Observation time UTC', unit: 'year' },
    ]);
    expect([h.valueColumn, h.aggregate, h.layout, h.scale, h.colourBy]).toEqual(['Rainfall [mm]', 'sum', 'radial-dendrogram', 'sqrt', 'value']);
    expect(h.size).toEqual([960, 960]);
    expect(h.origin).toEqual([480, 1020, 0]);
    expect(h.origin[0] + h.size[0] / 2).toBe(960);
    expect(h.origin[1] - h.size[1] / 2).toBe(540);
  });

  it('uses a category level without a time column, and fills the frame for box layouts', () => {
    const cats = syntheticSummary({
      rowCount: 10,
      columns: [
        { name: 'site', type: 'category', min: NaN, max: NaN, empty: false, categories: 3 },
        { name: 'v', type: 'number', min: 0, max: 1, empty: false },
      ],
    });
    const h = defaultHierarchyLayerFor('hi', 'H', dataset, cats);
    expectLayerValid(h);
    expect(h.levels).toEqual([{ kind: 'category', column: 'site' }]);
    const box = fitHierarchyLayer({ ...h, layout: 'treemap' });
    expect([box.origin, box.size]).toEqual([[60, 1020, 0], [1800, 960]]);
    expect(isRoundLayout('sunburst')).toBe(true);
    expect(isRoundLayout('icicle')).toBe(false);
    expect(defaultHierarchyLevels(syntheticSummary())).toBeNull();
  });
});

describe('surface defaults', () => {
  it('is a calendar of daily rainfall, 0..200 px high on a sqrt scale, fitted like the heat map', () => {
    const s = defaultSurfaceLayerFor('sf-1', 'Relief', dataset, rain);
    expectLayerValid(s);
    expect([s.layout, s.timeColumn, s.valueColumn, s.scale]).toEqual(['calendar', 'Observation time UTC', 'Rainfall [mm]', 'sqrt']);
    expect(s.height).toEqual([0, 200]);
    const heat = defaultHeatmapLayerFor('hm', 'H', dataset, rain);
    expect([s.cell, s.origin]).toEqual([heat.cell, heat.origin]);
    expect(s.cell[1] * years).toBeCloseTo(960);
  });

  it('is a grid without a daily time column', () => {
    const hourly: DatasetSummary = { ...rain, cadences: { 'Observation time UTC': { step: 3_600_000 } } };
    const s = defaultSurfaceLayerFor('sf', 'S', dataset, hourly);
    expectLayerValid(s);
    expect(s.layout).toBe('grid');
    expect(s.gridColumns * s.cell[0]).toBeCloseTo(1800);
    const heat = fitHeatmapLayer({ ...blankHeatmapLayer('h', 'H', 'ds'), layout: 'grid' }, hourly, TZ);
    expect([s.gridColumns, s.cell]).toEqual([heat.gridColumns, heat.cell]);
  });
});

describe('any layer type', () => {
  for (const type of LAYER_TYPES) {
    it(`${type}: defaults with and without data, and every fit, validate`, () => {
      const withData = defaultLayerOfType(type, 'ly', 'L', dataset, rain);
      expect(withData.type).toBe(type);
      expectLayerValid(withData);
      expectLayerValid(defaultLayerOfType(type, 'ly', 'L', null, null));
      for (const summary of [rain, syntheticSummary(), syntheticSummary({ rowCount: 1 })]) {
        for (const rows of [[0, 1], [0.5, 0.5], [1, 0]] as [number, number][]) {
          const l = { ...withData, rows } as LayerConfig;
          expectLayerValid(fitAnyLayer(l, summary, TZ));
        }
      }
    });
  }

  it('fitAnyLayer leaves data layers alone without a summary and never mutates', () => {
    for (const l of [blankInstancerLayer('a', 'A', null), blankLineLayer('b', 'B', null), blankHeatmapLayer('c', 'C', null)]) {
      const before = JSON.stringify(l);
      const out = fitAnyLayer(l, null, TZ);
      expect(JSON.stringify(out)).toBe(before);
      expect(out).not.toBe(l);
    }
    const line = defaultLineLayerFor('ln', 'L', dataset, rain);
    const before = JSON.stringify(line);
    fitAnyLayer({ ...line, rows: [0.2, 0.4] }, rain, TZ);
    expect(JSON.stringify(line)).toBe(before);
  });

  it('dispatches to the per-type fits', () => {
    const heat = { ...defaultHeatmapLayerFor('h', 'H', dataset, rain), cell: [1, 1] as [number, number] };
    expect(fitAnyLayer(heat, rain, TZ)).toEqual(fitHeatmapLayer(heat, rain, TZ));
    const inst = defaultLayerFor('i', 'I', dataset, rain);
    expect(fitAnyLayer({ ...inst, arrangement: 'grid' }, rain, TZ)).toEqual(fitLayer({ ...inst, arrangement: 'grid' }, rain, TZ));
    const multiples = { ...defaultMultiplesLayerFor('m', 'M', dataset, rain), columns: 3, splitBy: 'decade' as const };
    expect(fitAnyLayer(multiples, rain, TZ)).toEqual(fitMultiplesLayer(multiples, rain, TZ));
    expect((fitAnyLayer(multiples, rain, TZ) as typeof multiples).columns).toBe(4); // 13 decades
    const tree = { ...defaultHierarchyLayerFor('t', 'T', dataset, rain), layout: 'icicle' as const };
    expect(fitAnyLayer(tree, rain, TZ)).toEqual(fitHierarchyLayer(tree));
    const surface = { ...defaultSurfaceLayerFor('s', 'S', dataset, rain), cell: [1, 1] as [number, number] };
    expect((fitAnyLayer(surface, rain, TZ) as typeof surface).cell).toEqual(defaultSurfaceLayerFor('s', 'S', dataset, rain).cell);
  });

  it('fitAnyLayer leaves phase 7 layers alone without a summary', () => {
    for (const l of [blankMultiplesLayer('a', 'A', null), blankHierarchyLayer('b', 'B', null), blankSurfaceLayer('c', 'C', null)]) {
      const before = JSON.stringify(l);
      expect(JSON.stringify(fitAnyLayer(l, null, TZ))).toBe(before);
    }
  });
});
