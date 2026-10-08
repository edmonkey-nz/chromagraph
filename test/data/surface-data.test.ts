import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { TimeColumn } from '../../src/data/columns.ts';
import { CALENDAR_DAYS, cellScratch, EMPTY_CELL, fillCells, VOID_CELL } from '../../src/data/heatmap-data.ts';
import { LayerDataError } from '../../src/data/instance-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import {
  isHole,
  prepareSurface,
  quadCount,
  surfaceGrid,
  surfaceHeight,
  surfaceStructureKey,
  vertexXY,
} from '../../src/data/surface-data.ts';
import { blankSurfaceLayer, type SurfaceLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';

const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const calendars = { [TIME]: calendarFields(timeCol.values, 'Pacific/Auckland') };

function layer(patch: Partial<SurfaceLayer> = {}): SurfaceLayer {
  return { ...blankSurfaceLayer('s1', 'S', 'ds'), layout: 'calendar', timeColumn: TIME, valueColumn: RAIN, ...patch };
}

describe('prepareSurface', () => {
  it('builds the rainfall calendar as 119 years x 366 days', () => {
    const src = prepareSurface(layer(), table, calendars)!;
    expect(src.years).toBe(119);
    expect(src.cellCount).toBe(119 * CALENDAR_DAYS);
    expect(surfaceGrid(src, 100)).toEqual([366, 119]);
    expect(quadCount(366, 119)).toBe(365 * 118);
  });

  it('wraps grid layout gridColumns per line', () => {
    const src = prepareSurface(layer({ layout: 'grid', gridColumns: 365 }), table, calendars)!;
    expect(surfaceGrid(src, 365)).toEqual([365, Math.ceil(table.rowCount / 365)]);
  });

  it('waits for its columns and rejects bad ones', () => {
    expect(prepareSurface(layer({ valueColumn: null }), table, calendars)).toBeNull();
    expect(prepareSurface(layer({ timeColumn: null }), table, calendars)).toBeNull();
    expect(() => prepareSurface(layer({ valueColumn: 'nope' }), table, calendars)).toThrow(LayerDataError);
    expect(() => prepareSurface(layer({ timeColumn: RAIN }), table, calendars)).toThrow(LayerDataError);
  });

  it('structure key ignores heights, scale, look and rows', () => {
    const a = surfaceStructureKey(layer(), 'Pacific/Auckland');
    const b = surfaceStructureKey(
      layer({ height: [0, 900], scale: 'log', domain: [1, 2], cell: [2, 2], origin: [0, 0, 0], lit: false, wireframe: true, rows: [0.1, 0.2], gridColumns: 7 }),
      'Pacific/Auckland',
    );
    expect(b).toBe(a);
    expect(surfaceStructureKey(layer(), 'UTC')).not.toBe(a);
    expect(surfaceStructureKey(layer({ layout: 'grid' }), 'UTC')).toBe(surfaceStructureKey(layer({ layout: 'grid' }), 'Pacific/Auckland'));
  });
});

describe('holes', () => {
  const src = prepareSurface(layer(), table, calendars)!;
  const cells = new Float32Array(src.cellCount);
  fillCells(src, 'mean', 0, src.rowCount - 1, cells, cellScratch(src));
  const [cols, rows] = surfaceGrid(src, 1);
  const all: [number, number] = [0, src.rowCount - 1];

  it('treats empty and not-a-date cells as holes, and filled cells as solid', () => {
    // 1879 is not a leap year: day 365 is not a date.
    expect(cells[365]).toBe(VOID_CELL);
    expect(isHole(cells, src, cols, rows, 365, 0, all)).toBe(true);
    // 1 January 1879 local has no reading (the first is 2 January 09:30 NZ Mean Time).
    expect(cells[0]).toBe(EMPTY_CELL);
    expect(isHole(cells, src, cols, rows, 0, 0, all)).toBe(true);
    expect(isHole(cells, src, cols, rows, 1, 0, all)).toBe(false);
  });

  it('treats cells off the grid as holes', () => {
    expect(isHole(cells, src, cols, rows, -1, 3, all)).toBe(true);
    expect(isHole(cells, src, cols, rows, 3, rows, all)).toBe(true);
  });

  it('grid layout: cells outside rows are holes', () => {
    const g = prepareSurface(layer({ layout: 'grid' }), table, calendars)!;
    const gc = new Float32Array(g.cellCount);
    fillCells(g, 'mean', 0, g.rowCount - 1, gc, cellScratch(g));
    const [gcols, grows] = surfaceGrid(g, 100);
    expect(isHole(gc, g, gcols, grows, 5, 0, [0, 10])).toBe(false);
    expect(isHole(gc, g, gcols, grows, 5, 1, [0, 10])).toBe(true);
    // Past the last row of data on the final line.
    expect(isHole(gc, g, gcols, grows, gcols - 1, grows - 1, [0, g.rowCount - 1])).toBe(g.cellCount % gcols !== 0);
  });
});

describe('placement', () => {
  it('puts vertices at cell centres, rows going down from origin', () => {
    expect(vertexXY([60, 1020, 0], [6, 4], 0, 0)).toEqual([63, 1018]);
    expect(vertexXY([60, 1020, 0], [6, 4], 2, 3)).toEqual([75, 1006]);
  });

  it('maps values onto the height range with the shared scale maths', () => {
    expect(surfaceHeight(0, [0, 100], 'linear', [10, 210])).toBe(10);
    expect(surfaceHeight(50, [0, 100], 'linear', [10, 210])).toBe(110);
    expect(surfaceHeight(400, [0, 100], 'linear', [10, 210])).toBe(210); // clamped
    expect(surfaceHeight(25, [0, 100], 'sqrt', [0, 100])).toBeCloseTo(50, 6);
  });
});
