import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { LayerDataError } from '../../src/data/instance-data.ts';
import {
  buildLineData,
  cloneDataRow,
  cloneLinePositions,
  clonePointDrawable,
  cloneSegmentVisible,
  fillBaseline,
  firstPointAtOrAfter,
  lineCloneCount,
  MAX_LINE_DRAWN,
  lineStructureKey,
  linePositions,
  lineTStart,
  POINT_STRIDE,
  P_ROW,
  P_T,
  rowRange,
  segmentBroken,
  segmentRange,
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

describe('segmentRange', () => {
  it('covers exactly the segments with both ends in the rows range', () => {
    const d = buildLineData(withY(layer(), DEFICIT), table, cadences);
    const [first, last] = rowRange([0.3, 0.7], d.rowCount);
    const [start, count] = segmentRange(d, first, last);
    for (let i = start - 2; i < start + count + 2; i++) {
      const inRange = i >= start && i < start + count;
      expect(segmentVisible(d, i, first, last, false, 1.5)).toBe(inRange);
    }
    expect(segmentRange(d, 10, 5)).toEqual([0, 0]);
  });
});

describe('line cloner', () => {
  const rain = table.columns.find((c) => c.name === RAIN) as { values: Float32Array };

  it('steps data rows by k x dataStep and drops rows outside the data', () => {
    expect(cloneDataRow(10, 3, 365, 42_748)).toBe(1105);
    expect(cloneDataRow(10, 0, 365, 42_748)).toBe(10);
    expect(cloneDataRow(42_700, 1, 365, 42_748)).toBe(-1);
    expect(cloneDataRow(10, 1, -365, 42_748)).toBe(-1);
  });

  it('breaks a clone where its stepped row is missing', () => {
    const d = buildLineData(withY(layer(), DEFICIT), table, cadences);
    const deficit = table.columns.find((c) => c.name === DEFICIT) as { values: Float32Array };
    // Find a point whose row is valid but whose next row is missing.
    let p = -1;
    for (let i = 0; i < d.count - 1; i++) {
      const r = d.points[i * POINT_STRIDE + P_ROW]!;
      if (r + 1 < d.rowCount && Number.isNaN(deficit.values[r + 1]!)) {
        p = i;
        break;
      }
    }
    expect(p).toBeGreaterThanOrEqual(0);
    expect(clonePointDrawable(d, p, 0, 1)).toBe(true);
    expect(clonePointDrawable(d, p, 1, 1)).toBe(false);
    // Joining across gaps, the segment starting there is drawn by the original but clone 1
    // breaks: a clone's missing value always breaks it.
    const [first, last] = rowRange([0, 1], d.rowCount);
    expect(cloneSegmentVisible(d, p, 0, 1, first, last, false, 1.5)).toBe(true);
    expect(cloneSegmentVisible(d, p, 1, 1, first, last, false, 1.5)).toBe(false);
    // Stepping past the end breaks the far clones of the last points.
    expect(clonePointDrawable(d, d.count - 1, 1, 365)).toBe(false);
  });

  it('keeps positions from row i and takes values from row i + k x dataStep', () => {
    const l = withY(layer({ origin: [10, 100, 0], step: [2, 0, 0] }), RAIN);
    l.y = { ...l.y, domain: [0, 1000], range: [0, 1000] };
    l.cloner = { ...l.cloner, count: 3, position: [0, 14, 0], dataStep: 365 };
    const d = buildLineData(l, table, cadences);
    const k2 = cloneLinePositions(d, l, 2);
    const i = 100;
    expect(k2[i * 3]).toBe(10 + 2 * i);
    expect(k2[i * 3 + 1]).toBeCloseTo(100 + 2 * 14 + rain.values[i + 730]!, 3);
    // The original is the plain line.
    const k0 = cloneLinePositions(d, l, 0);
    expect(Array.from(k0)).toEqual(Array.from(linePositions(d, l)));
    // Points whose stepped row is past the data have no position.
    expect(Number.isNaN(k2[(d.count - 1) * 3 + 1]!)).toBe(true);
  });

  it('caps segments x pieces x clones at MAX_LINE_DRAWN', () => {
    expect(lineCloneCount(40, 364 * 2)).toBe(40);
    expect(lineCloneCount(1000, 42_747 * 2)).toBe(Math.floor(MAX_LINE_DRAWN / (42_747 * 2)));
    expect(lineCloneCount(1000, 42_747 * 2) * 42_747 * 2).toBeLessThanOrEqual(MAX_LINE_DRAWN);
    expect(lineCloneCount(5, 0)).toBe(5);
    expect(lineCloneCount(1, MAX_LINE_DRAWN * 2)).toBe(1);
  });

  it('structure key ignores cloner and fill', () => {
    const a = withY(layer(), RAIN);
    const b = { ...a, cloner: { ...a.cloner, count: 40, dataStep: 365 }, fill: { mode: 'below' as const, colour: '#123456', opacity: 0.5 } };
    expect(lineStructureKey(b)).toBe(lineStructureKey(a));
  });
});

describe('line fill', () => {
  it('drops to the clone baseline: origin.y plus the clone offset', () => {
    const l = layer({ origin: [0, 200, 0] });
    l.cloner = { ...l.cloner, position: [5, 14, 0] };
    expect(fillBaseline(l, 0)).toBe(200);
    expect(fillBaseline(l, 3)).toBe(242);
  });

  it('breaks at gaps with the line (fill pieces share the segment rule)', () => {
    const timeLine = buildLineData(withY(layer({ xMode: 'time', timeColumn: TIME }), RAIN), table, cadences);
    const big = segmentEndingAt(timeLine, rowOf('1996-06-02T21:00:00Z'));
    const [first, last] = rowRange([0, 1], timeLine.rowCount);
    expect(cloneSegmentVisible(timeLine, big, 0, 0, first, last, true, 1.5)).toBe(false);
    expect(cloneSegmentVisible(timeLine, big, 0, 0, first, last, false, 1.5)).toBe(true);
    expect(cloneSegmentVisible(timeLine, big - 1, 0, 0, first, last, true, 1.5)).toBe(true);
  });
});
