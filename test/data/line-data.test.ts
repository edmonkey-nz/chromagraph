import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { LayerDataError } from '../../src/data/instance-data.ts';
import {
  buildLineData,
  firstPointAtOrAfter,
  lineStructureKey,
  linePositions,
  lineTStart,
  POINT_STRIDE,
  P_ROW,
  P_T,
  rowRange,
  segmentBroken,
  segmentVisible,
  type LineData,
} from '../../src/data/line-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankLineLayer, type LineLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';
const DEFICIT = 'Deficit [mm]';

const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const cadences = { [TIME]: detectCadence(timeCol.values) };

function layer(patch: Partial<LineLayer> = {}): LineLayer {
  return { ...blankLineLayer('l1', 'L', 'ds'), ...patch };
}

function withY(l: LineLayer, column: string): LineLayer {
  return { ...l, y: { ...l.y, column } };
}

const rowOf = (iso: string) => timeCol.values.indexOf(Date.parse(iso));

/** Index of the segment that ends at table row `row`. */
function segmentEndingAt(d: LineData, row: number): number {
  return firstPointAtOrAfter(d, row) - 1;
}

function brokenIn1996(d: LineData, breakOnGaps: boolean): number {
  let n = 0;
  for (let i = 0; i < d.count - 1; i++) {
    const year = new Date(timeCol.values[d.points[i * POINT_STRIDE + P_ROW]!]!).getUTCFullYear();
    if (year === 1996 && segmentBroken(d, i, breakOnGaps, 1.5)) n++;
  }
  return n;
}

describe('buildLineData', () => {
  it('makes one point per row in index mode', () => {
    const d = buildLineData(withY(layer(), RAIN), table, cadences);
    expect(d.count).toBe(42_748);
    expect(d.timeMode).toBe(false);
    expect(d.points[P_T]).toBe(0);
    expect(d.points[(d.count - 1) * POINT_STRIDE + P_T]).toBe(42_747);
  });

  it('uses cadence steps in time mode, so gaps stay as gaps', () => {
    const d = buildLineData(withY(layer({ xMode: 'time', timeColumn: TIME }), RAIN), table, cadences);
    expect(d.count).toBe(42_748);
    expect(d.points[(d.count - 1) * POINT_STRIDE + P_T]!).toBeGreaterThan(d.count - 1);
  });

  it('leaves rows with missing mapped values out (never drawn as zero)', () => {
    const d = buildLineData(withY(layer(), DEFICIT), table, cadences);
    const deficit = table.columns.find((c) => c.name === DEFICIT)!;
    expect(d.count).toBe(42_748 - deficit.nullCount);
    expect(d.points[P_ROW]).toBe(rowOf('1928-02-13T21:00:00Z'));
  });

  it('yields no points while time mode has no time column', () => {
    expect(buildLineData(layer({ xMode: 'time', timeColumn: null }), table, cadences).count).toBe(0);
  });

  it('reports bad columns as LayerDataError', () => {
    expect(() => buildLineData(withY(layer(), 'Nope'), table, cadences)).toThrow(LayerDataError);
    expect(() => buildLineData(withY(layer(), 'Data Source (rainfall)'), table, cadences)).toThrow(/only be mapped to colour/);
    expect(() => buildLineData(layer({ xMode: 'time', timeColumn: RAIN }), table, cadences)).toThrow(/not a time column/);
    const l = layer();
    const colour = buildLineData({ ...l, colourMap: { ...l.colourMap, column: 'Data Source (rainfall)' } }, table, cadences);
    expect(colour.colour!.categories).toBe(2);
  });
});

describe('gap rule', () => {
  const timeLine = buildLineData(withY(layer({ xMode: 'time', timeColumn: TIME }), RAIN), table, cadences);

  it('breaks across the 1996 time gaps in time mode', () => {
    // 1996-04-30 -> 1996-06-02 is 32 missing days.
    const big = segmentEndingAt(timeLine, rowOf('1996-06-02T21:00:00Z'));
    expect(segmentBroken(timeLine, big, true, 1.5)).toBe(true);
    // A one-day hole (1996-04-19 -> 04-21) is 2 steps: broken at 1.5, joined at 2.5.
    const small = segmentEndingAt(timeLine, rowOf('1996-04-21T21:00:00Z'));
    expect(segmentBroken(timeLine, small, true, 1.5)).toBe(true);
    expect(segmentBroken(timeLine, small, true, 2.5)).toBe(false);
    // Ordinary consecutive days are joined, including across a DST change (23/25 h).
    expect(segmentBroken(timeLine, small + 1, true, 1.5)).toBe(false);
    // Every gap starting in 1996 breaks the line (detectCadence finds the same ones).
    const gaps1996 = cadences[TIME]!.gaps.filter((g) => new Date(g.from).getUTCFullYear() === 1996).length;
    expect(brokenIn1996(timeLine, true)).toBe(gaps1996);
    expect(gaps1996).toBeGreaterThan(10);
  });

  it('joins across gaps when breakOnGaps is off', () => {
    expect(brokenIn1996(timeLine, false)).toBe(0);
  });

  it('ignores time gaps in index mode but still breaks at missing values', () => {
    const indexLine = buildLineData(withY(layer(), RAIN), table, cadences);
    for (let i = 0; i < indexLine.count - 1; i++) expect(segmentBroken(indexLine, i, true, 1.5)).toBe(false);

    const deficit = buildLineData(withY(layer(), DEFICIT), table, cadences);
    let broken = 0;
    for (let i = 0; i < deficit.count - 1; i++) if (segmentBroken(deficit, i, true, 1.5)) broken++;
    expect(broken).toBeGreaterThan(0);
    // The same segments join when gaps are not broken.
    for (let i = 0; i < deficit.count - 1; i++) expect(segmentBroken(deficit, i, false, 1.5)).toBe(false);
  });

  it('draws only segments with both ends in the rows range', () => {
    const [first, last] = rowRange([0.5, 0.6], timeLine.rowCount);
    expect(segmentVisible(timeLine, first - 1, first, last, false, 1.5)).toBe(false);
    expect(segmentVisible(timeLine, first, first, last, false, 1.5)).toBe(true);
    expect(segmentVisible(timeLine, last - 1, first, last, false, 1.5)).toBe(true);
    expect(segmentVisible(timeLine, last, first, last, false, 1.5)).toBe(false);
    expect(segmentVisible(timeLine, timeLine.count - 1, 0, timeLine.rowCount, false, 1.5)).toBe(false);
  });
});

describe('placement', () => {
  it('places points at origin + t * step plus the mapped y offset', () => {
    const l = withY(layer({ origin: [10, 100, 0], step: [2, 0, 0] }), RAIN);
    l.y = { ...l.y, domain: [0, 100], range: [0, 200] };
    const d = buildLineData(l, table, cadences);
    const p = linePositions(d, l);
    const rain = table.columns.find((c) => c.name === RAIN) as { values: Float32Array };
    const i = 1000;
    expect(p[i * 3]).toBe(10 + 2 * i);
    expect(p[i * 3 + 1]).toBeCloseTo(100 + Math.min(200, rain.values[i]! * 2), 3);
  });

  it('scrolls the range into place with followRange', () => {
    const d = buildLineData(layer(), table, cadences);
    const [first] = rowRange([0.25, 1], d.rowCount);
    expect(lineTStart(d, true, first)).toBe(first);
    expect(lineTStart(d, false, first)).toBe(0);
    const p = linePositions(d, layer({ rows: [0.25, 1], followRange: true, origin: [0, 0, 0], step: [1, 0, 0] }));
    expect(p[first * 3]).toBe(0);
  });
});

describe('lineStructureKey', () => {
  it('changes with columns only, not with rows, width or gap settings', () => {
    const a = layer();
    expect(lineStructureKey({ ...a, rows: [0.2, 0.4], width: 9, breakOnGaps: false, gapFactor: 3, colour: '#ff0000' })).toBe(lineStructureKey(a));
    expect(lineStructureKey(withY(a, RAIN))).not.toBe(lineStructureKey(a));
    expect(lineStructureKey({ ...a, xMode: 'time', timeColumn: TIME })).not.toBe(lineStructureKey(a));
  });
});
