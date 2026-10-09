import { describe, expect, it } from 'vitest';
import { DateLabels, emptyPlacement, labelRows, labelText, MAX_LABELS, placeLabel, visibleLabels } from '../../src/data/instance-labels.ts';
import { MISSING } from '../../src/data/instance-data.ts';
import type { Table } from '../../src/data/columns.ts';
import { blankInstancerLayer, defaultInstancerLabels } from '../../src/shared/layer-schema.ts';

const cal = (years: number[]) => ({ year: Float32Array.from(years), dayOfYear: new Float32Array(years.length) });

describe('labelRows', () => {
  it('marks the first row of each year or decade, skipping missing times', () => {
    const t = Float32Array.from([0, 1, MISSING, 3, 4, 5]);
    const years = cal([1879, 1879, NaN, 1880, 1890, 1890]);
    expect([...labelRows({ every: 'year', rows: 1 }, t, years)]).toEqual([0, 3, 4]);
    expect([...labelRows({ every: 'decade', rows: 1 }, t, years)]).toEqual([0, 3, 4]);
    expect([...labelRows({ every: 'decade', rows: 1 }, t, cal([1879, 1880, 1881, 1889, 1890, 1899]))]).toEqual([0, 1, 4]);
  });
  it('every N rows, only where t is defined; nothing for years without calendar fields', () => {
    const t = Float32Array.from([0, 1, 2, MISSING, 4, 5, 6]);
    expect([...labelRows({ every: 'rows', rows: 3 }, t, null)]).toEqual([0, 6]);
    expect([...labelRows({ every: 'year', rows: 1 }, t, null)]).toEqual([]);
  });
});

describe('labelText', () => {
  const table: Table = {
    rowCount: 2,
    columns: [
      { name: 'time', index: 0, length: 2, nullCount: 0, empty: false, min: 0, max: 0, type: 'time', values: Float64Array.from([Date.UTC(1879, 0, 1, 21), NaN]), assumedUtc: false },
      { name: 'rain', index: 1, length: 2, nullCount: 1, empty: false, min: 0, max: 0, type: 'number', values: Float32Array.from([12.25, NaN]) },
    ],
  };
  const dates = new DateLabels('Pacific/Auckland');
  it('years, decades, dates (in the dataset timezone) and values; missing is empty', () => {
    const c = cal([1879, 1880]);
    expect(labelText({ every: 'year', text: 'date', column: null }, 0, table, 'time', c, dates)).toBe('1879');
    expect(labelText({ every: 'decade', text: 'date', column: null }, 1, table, 'time', c, dates)).toBe('1880s');
    // 21:00 UTC on 1 Jan is 2 Jan in Auckland.
    expect(labelText({ every: 'rows', text: 'date', column: null }, 0, table, 'time', c, dates)).toBe('02 Jan 1879');
    expect(labelText({ every: 'rows', text: 'value', column: 'rain' }, 0, table, 'time', c, dates)).toBe('12.25');
    expect(labelText({ every: 'rows', text: 'value', column: 'rain' }, 1, table, 'time', c, dates)).toBe('');
  });
});

describe('placeLabel', () => {
  const spiral = { ...blankInstancerLayer('a', 'a', null), arrangement: 'spiral' as const, origin: [960, 540, 0] as [number, number, number], radius: 100, angleStep: 90, radiusStep: 10 };
  const fx = (orientation: 'along' | 'outward' | 'upright', offset = 20) => ({ ...spiral, labels: { ...defaultInstancerLabels(), orientation, offset } });

  it('sits on the spiral (as the shader places points), pushed outward by the offset', () => {
    // t = 1: a quarter turn clockwise from 12 o'clock (3 o'clock), radius 110.
    const p = placeLabel(fx('upright'), 1, 0, 0, emptyPlacement());
    expect(p.x).toBeCloseTo(960 + 130);
    expect(p.y).toBeCloseTo(540);
  });

  it('along the spiral reads left to right, outside the ring, and flips at the bottom', () => {
    const top = placeLabel(fx('along'), 0, 0, 0, emptyPlacement()); // 12 o'clock
    expect(top.rotation).toBeCloseTo(0);
    expect(top.anchorY).toBe('bottom');
    const bottom = placeLabel(fx('along'), 2, 0, 0, emptyPlacement()); // 6 o'clock: flipped
    expect(Math.cos(bottom.rotation)).toBeGreaterThan(0);
    expect(bottom.anchorY).toBe('top');
  });

  it('outward labels point along the radius and flip on the left', () => {
    const right = placeLabel(fx('outward'), 1, 0, 0, emptyPlacement()); // 3 o'clock
    expect(right.rotation).toBeCloseTo(0);
    expect(right.anchorX).toBe('left');
    const left = placeLabel(fx('outward'), 3, 0, 0, emptyPlacement()); // 9 o'clock
    expect(Math.cos(left.rotation)).toBeGreaterThan(0);
    expect(left.anchorX).toBe('right');
  });

  it('calendar labels sit left of the year row', () => {
    const l = { ...spiral, arrangement: 'calendar' as const, origin: [100, 900, 0] as [number, number, number], cell: [4, 10] as [number, number], labels: { ...defaultInstancerLabels(), offset: 8 } };
    const p = placeLabel(l, 0, 3, 0, emptyPlacement());
    expect([p.x, p.y, p.anchorX]).toEqual([92, 870, 'right']);
  });
});

describe('visibleLabels', () => {
  it('finds the candidates in the visible rows, thinning to the label limit', () => {
    const rows = Int32Array.from([0, 10, 20, 30, 40]);
    expect(visibleLabels(rows, 5, 30)).toEqual({ from: 1, to: 4, stride: 1 });
    const many = Int32Array.from({ length: MAX_LABELS * 2 + 1 }, (_, i) => i);
    expect(visibleLabels(many, 0, many.length).stride).toBe(3);
  });
});
