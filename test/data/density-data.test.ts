import { describe, expect, it } from 'vitest';
import { binDensity, blurDensity, densityDomain, gaussianKernel, gridMax, prepareDensity } from '../../src/data/density-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankDensityLayer, LayerSchema, type DensityLayer } from '../../src/shared/layer-schema.ts';

const table = parseCsv(['when,a,b,c', '2000-01-01T00:00:00Z,0,0,x', '2000-01-02T00:00:00Z,1,1,y', '2000-01-03T00:00:00Z,,2,x', '2000-01-05T00:00:00Z,4,4,y'].join('\n')).table;
const layer = (patch: Partial<DensityLayer> = {}): DensityLayer => ({ ...blankDensityLayer('d', 'D', 'ds'), xColumn: 'a', yColumn: 'b', ...patch });

describe('density data', () => {
  it('needs both columns; numbers and times only', () => {
    expect(prepareDensity(layer({ yColumn: null }), table)).toBeNull();
    expect(() => prepareDensity(layer({ xColumn: 'c' }), table)).toThrow(/numbers or times/);
    expect(() => prepareDensity(layer({ xColumn: 'nope' }), table)).toThrow(/not found/);
  });

  it('time columns count in days from their first value', () => {
    const s = prepareDensity(layer({ xColumn: 'when' }), table)!;
    expect([...s.x]).toEqual([0, 1, 2, 4]);
    expect(s.xAuto).toEqual([0, 4]);
  });

  it('bins rows bottom-left first; the domain top falls in the last bin; missing and outside rows are skipped', () => {
    const s = prepareDensity(layer(), table)!;
    const out = new Float32Array(4);
    // 2 × 2 bins over 0..4: (0,0) and (1,1) bottom-left, (4,4) top-right, row 2 has no x.
    expect(binDensity(s, 0, 3, [0, 4], [0, 4], 2, 2, out)).toBe(3);
    expect([...out]).toEqual([2, 0, 0, 1]);
    // Narrower domain: (4,4) is outside.
    expect(binDensity(s, 0, 3, [0, 2], [0, 2], 2, 2, out)).toBe(2);
    expect([...out]).toEqual([1, 0, 0, 1]);
    // The row range limits what is counted.
    expect(binDensity(s, 1, 1, [0, 4], [0, 4], 2, 2, out)).toBe(1);
  });

  it('domains: the layer’s, else the column’s; flat or broken ranges stay usable', () => {
    expect(densityDomain(null, [1, 5])).toEqual([1, 5]);
    expect(densityDomain([2, 3], [1, 5])).toEqual([2, 3]);
    expect(densityDomain(null, [3, 3])).toEqual([2.5, 3.5]);
    expect(densityDomain(null, [NaN, NaN])).toEqual([0, 1]);
  });

  it('the gaussian kernel is normalised; blurring keeps the total away from the edges', () => {
    const k = gaussianKernel(1.5);
    expect(k.length).toBe(11);
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(gaussianKernel(0).length).toBe(1);
    const w = 31;
    const grid = new Float32Array(w * w);
    grid[15 * w + 15] = 10;
    blurDensity(grid, w, w, k, new Float32Array(w * w));
    expect(grid.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 4);
    expect(gridMax(grid, grid.length)).toBeLessThan(10);
    expect(grid[15 * w + 15]).toBe(gridMax(grid, grid.length));
  });

  it('z counts only in dots mode; 3D bins index (k * binsY + j) * binsX + i from the front', () => {
    expect(prepareDensity(layer({ zColumn: 'b' }), table)!.z).toBeNull();
    const s = prepareDensity(layer({ mode: 'dots', zColumn: 'when' }), table)!;
    expect([...s.z!]).toEqual([0, 1, 2, 4]);
    const out = new Float32Array(8);
    // 2 × 2 × 2 over x, y 0..4 and z 0..4 days: (0,0,0) and (1,1,1) front-bottom-left; (4,4,4) back-top-right.
    expect(binDensity(s, 0, 3, [0, 4], [0, 4], 2, 2, out, [0, 4], 2)).toBe(3);
    expect([...out]).toEqual([2, 0, 0, 0, 0, 0, 0, 1]);
    // A narrower z range leaves the back row out.
    expect(binDensity(s, 0, 3, [0, 4], [0, 4], 2, 2, out, [0, 2], 2)).toBe(2);
  });

  it('3D smoothing spreads along z too and keeps the total away from the edges', () => {
    const w = 15;
    const grid = new Float32Array(w * w * w);
    const at = (i: number, j: number, k: number) => (k * w + j) * w + i;
    grid[at(7, 7, 7)] = 8;
    blurDensity(grid, w, w, gaussianKernel(1), new Float32Array(grid.length), w);
    expect(grid.reduce((a, b) => a + b, 0)).toBeCloseTo(8, 4);
    expect(grid[at(7, 7, 6)]).toBeCloseTo(grid[at(7, 6, 7)]!, 6);
    expect(grid[at(7, 7, 6)]).toBeCloseTo(grid[at(6, 7, 7)]!, 6);
    expect(grid[at(7, 7, 7)]).toBe(gridMax(grid, grid.length));
  });

  it('schema: blank layers validate; bins are capped', () => {
    expect(LayerSchema.safeParse(layer()).success).toBe(true);
    expect(LayerSchema.safeParse(layer({ bins: [2000, 100] })).success).toBe(false);
  });

  it('100k rows at 320 × 160 bins: count and blur well inside a frame', () => {
    const n = 100_000;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = Math.random();
      y[i] = Math.random() * Math.random();
    }
    const src = { rowCount: n, x, y, z: null, xAuto: [0, 1] as [number, number], yAuto: [0, 1] as [number, number], zAuto: [0, 1] as [number, number] };
    const grid = new Float32Array(320 * 160);
    const tmp = new Float32Array(320 * 160);
    const k = gaussianKernel(1.5);
    for (let i = 0; i < 5; i++) binDensity(src, 0, n - 1, [0, 1], [0, 1], 320, 160, grid); // warm up
    const runs = 20;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) {
      binDensity(src, 0, n - 1, [0, 1], [0, 1], 320, 160, grid);
      blurDensity(grid, 320, 160, k, tmp);
    }
    const ms = (performance.now() - t0) / runs;
    console.log(`density: ${ms.toFixed(2)} ms per count + blur (100k rows, 320 × 160 bins)`);
    expect(ms).toBeLessThan(16);
  });
});
