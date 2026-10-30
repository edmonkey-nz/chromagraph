import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { combineHorizon, horizonExtent, horizonLevel, horizonSpan, prepareHorizon } from '../../src/data/horizon-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { fitHorizonLayer, summarise } from '../../src/shared/layer-defaults.ts';
import { blankHorizonLayer, LayerSchema, type HorizonLayer } from '../../src/shared/layer-schema.ts';

const small = parseCsv(['v,s', '1,a', '-2,b', '3,a', ',b', '5,a', '6,b'].join('\n')).table;
const layer = (patch: Partial<HorizonLayer> = {}): HorizonLayer => ({ ...blankHorizonLayer('h', 'H', 'ds'), valueColumn: 'v', ...patch });

describe('horizon data', () => {
  it('needs a number value column (and a time column in time mode)', () => {
    expect(prepareHorizon(layer({ valueColumn: null }), small, {})).toBeNull();
    expect(prepareHorizon(layer({ xMode: 'time' }), small, {})).toBeNull();
    expect(() => prepareHorizon(layer({ valueColumn: 's' }), small, {})).toThrow(/needs numbers/);
  });

  it('series: one strip per value in first-seen order; none gives one strip', () => {
    expect(prepareHorizon(layer(), small, {})!.names).toEqual(['']);
    const src = prepareHorizon(layer({ seriesColumn: 's' }), small, {})!;
    expect(src.names).toEqual(['a', 'b']);
    expect([...src.series]).toEqual([0, 1, 0, 1, 0, 1]);
    // Index mode: each series counts its own rows, so both strips span the full width.
    expect([...src.t]).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('combines rows into columns per series; missing values are left out; empty columns are gaps', () => {
    const src = prepareHorizon(layer({ seriesColumn: 's' }), small, {})!;
    const out = new Float32Array(6);
    const count = new Float32Array(6);
    // Each series' steps [0, 3) into 3 columns: one row each.
    combineHorizon(src, 0, 5, 0, 3, 3, 'mean', out, count);
    expect([...out.slice(0, 3)]).toEqual([1, 3, 5]); // a
    expect(out[3]).toBe(-2); // b: its row 0
    expect(Number.isNaN(out[4]!)).toBe(true); // b: its row 1 is missing
    expect(out[5]).toBe(6);
    combineHorizon(src, 0, 5, 0, 3, 1, 'max', out, count);
    expect([out[0], out[1]]).toEqual([5, 6]);
  });

  it('few rows fill wide blocks; gaps in time stay empty', () => {
    // One series, rows at t 0, 1 and 3 (t 2 missing): 8 columns over [0, 4) are 2 per step.
    const src = { rowCount: 3, t: Float64Array.from([0, 1, 3]), v: Float32Array.from([10, 20, 40]), series: new Int32Array(3), names: [''] };
    const out = new Float32Array(8);
    combineHorizon(src, 0, 2, ...horizonSpan(src, 0, 2), 8, 'mean', out, new Float32Array(8));
    expect([...out].map((v) => (Number.isNaN(v) ? null : v))).toEqual([10, 10, 20, 20, null, null, 40, 40]);
  });

  it('the span comes from the rows; the auto range from the combined columns', () => {
    const src = prepareHorizon(layer(), small, {})!;
    expect(horizonSpan(src, 1, 3)).toEqual([1, 4]);
    const cols = new Float32Array(2);
    combineHorizon(src, 0, 5, 0, 6, 2, 'mean', cols, new Float32Array(2));
    // Columns: rows 0–2 (1, -2, 3) and rows 3–5 (missing, 5, 6): means 0.667 and 5.5.
    expect(horizonExtent(cols, 2, 0)).toBeCloseTo(5.5, 5);
    expect(horizonExtent(cols, 2, 6)).toBeCloseTo(5.333, 3);
    expect(horizonExtent(new Float32Array([NaN]), 1, 0)).toBe(1);
  });

  it('bands stack: the shade at height y counts the bands that reach it', () => {
    // 2.5 of 4 bands: two full, the third half way up.
    expect(horizonLevel(5, 0, 8, 4, 0.2)).toBe(3);
    expect(horizonLevel(5, 0, 8, 4, 0.8)).toBe(2);
    expect(horizonLevel(-5, 0, 8, 4, 0.2)).toBe(3); // negatives mirror up
    expect(horizonLevel(100, 0, 8, 4, 0.99)).toBe(4); // beyond the range fills every band
    expect(horizonLevel(0, 0, 8, 4, 0)).toBe(0);
  });

  it('time mode counts t in cadence steps, so gaps stay as empty columns', () => {
    const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
    const time = table.columns.find((c) => c.name === 'Observation time UTC') as TimeColumn;
    const src = prepareHorizon(layer({ xMode: 'time', timeColumn: time.name, valueColumn: 'Rainfall [mm]' }), table, { [time.name]: detectCadence(time.values) })!;
    const [lo, hi] = horizonSpan(src, 0, src.rowCount - 1);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(src.rowCount); // the record has gaps
  });

  it('fit sizes the strips to the frame and the schema accepts the layer', () => {
    const summary = summarise(small, {});
    const one = fitHorizonLayer(layer(), summary);
    const two = fitHorizonLayer(layer({ seriesColumn: 's' }), summary);
    expect(one.size[1]).toBe(160);
    expect(two.size[1]).toBeLessThanOrEqual(160);
    expect(LayerSchema.safeParse(two).success).toBe(true);
  });
});
