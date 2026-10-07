import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { defaultLayerFor, fitLayer, summarise, tSpanOf, type DatasetSummary } from '../../src/shared/layer-defaults.ts';
import { ARRANGEMENTS, blankInstancerLayer, InstancerLayerSchema, type InstancerLayer } from '../../src/shared/layer-schema.ts';
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
