import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { defaultLayerOfType, summarise } from '../../src/shared/layer-defaults.ts';
import { FRAME_BUDGET, instanceCount } from '../../src/shared/layer-helpers.ts';
import { contrast, hslHex, luminance, randomiseLayer, RANDOM_SCOPES, seededRng } from '../../src/shared/layer-random.ts';
import { LAYER_TYPES, LayerSchema, type LayerConfig } from '../../src/shared/layer-schema.ts';
import type { Dataset } from '../../src/shared/project-schema.ts';

const FULL = fs.readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8');
const parsed = parseCsv(FULL);
const cadences: Record<string, { step: number }> = {};
for (const c of parsed.table.columns) {
  if (c.type === 'time' && !c.empty) cadences[c.name] = detectCadence((c as TimeColumn).values);
}
const rain = summarise(parsed.table, cadences);
const dataset: Dataset = { id: 'ds', label: 'rain', file: 'rain.csv', timeZone: 'Pacific/Auckland', source: '', url: '', attribution: '' };
const TZ = 'Pacific/Auckland';

/** Every column a layer refers to, by field path. */
function columnRefs(l: LayerConfig): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string' && /column$|Column$/.test(key) && v !== '') out.push(v);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}.${i}`));
    else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(l, '');
  return out;
}

/** The columns that drive what the layer shows (time axis excluded). */
function mapping(l: LayerConfig): unknown {
  switch (l.type) {
    case 'instancer':
      return Object.fromEntries(Object.entries(l.channels).map(([k, m]) => [k, m.column]));
    case 'line':
      return [l.y.column, l.z.column, l.aggregate];
    case 'heatmap':
    case 'surface':
      return [l.valueColumn, l.aggregate];
    case 'multiples':
      return [l.valueColumn, l.splitBy, l.splitColumn];
    case 'hierarchy':
      return [l.valueColumn, l.levels, l.aggregate];
    default:
      return null;
  }
}

describe('randomise layer', () => {
  it('always gives a valid, fitted, in-budget layer that keeps its identity and placement', () => {
    for (const type of LAYER_TYPES) {
      const base = defaultLayerOfType(type, `ly-${type}`, `My ${type}`, type === 'reflector' ? null : dataset, rain);
      base.transform.position = [12, 34, 0];
      for (const scope of RANDOM_SCOPES) {
        for (let seed = 1; seed <= 40; seed++) {
          const out = randomiseLayer(base, rain, TZ, '#000000', scope, seededRng(seed));
          const where = `${type} ${scope} seed ${seed}`;
          expect(LayerSchema.safeParse(out).success, where).toBe(true);
          expect(out.type, where).toBe(type);
          expect([out.id, out.name, out.enabled, out.datasetId, out.screenFixed], where).toEqual([base.id, base.name, base.enabled, base.datasetId, base.screenFixed]);
          expect(out.transform, where).toEqual(base.transform);
          expect(out.timeline, where).toEqual(base.timeline);
          expect(instanceCount(out, rain.rowCount), where).toBeLessThanOrEqual(FRAME_BUDGET);
          // Costly effects stay off.
          expect([out.effects.trails.enabled, out.effects.blur.enabled, out.effects.shadow.enabled], where).toEqual([false, false, false]);
          for (const name of columnRefs(out)) expect(rain.columns.some((c) => c.name === name), `${where}: ${name}`).toBe(true);
          if (out.type === 'line') expect(out.width, where).toBeGreaterThanOrEqual(2);
          if (out.type === 'text') expect(out.fontSize, where).toBeGreaterThanOrEqual(24);
          if (out.type === 'hierarchy') expect(out.linkWidth, where).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("'look' keeps the data mapping; 'all' sometimes changes it", () => {
    for (const type of LAYER_TYPES) {
      const base = defaultLayerOfType(type, 'ly', 'L', type === 'reflector' ? null : dataset, rain);
      let changed = false;
      for (let seed = 1; seed <= 40; seed++) {
        const look = randomiseLayer(base, rain, TZ, '#000000', 'look', seededRng(seed));
        expect(mapping(look), `${type} seed ${seed}`).toEqual(mapping(base));
        const all = randomiseLayer(base, rain, TZ, '#000000', 'all', seededRng(seed));
        if (JSON.stringify(mapping(all)) !== JSON.stringify(mapping(base))) changed = true;
      }
      if (['instancer', 'line', 'heatmap', 'multiples', 'hierarchy', 'surface'].includes(type)) expect(changed, type).toBe(true);
    }
  });

  it('varies: different seeds give different looks', () => {
    for (const type of LAYER_TYPES) {
      const base = defaultLayerOfType(type, 'ly', 'L', type === 'reflector' ? null : dataset, rain);
      const looks = new Set<string>();
      for (let seed = 1; seed <= 10; seed++) looks.add(JSON.stringify(randomiseLayer(base, rain, TZ, '#000000', 'look', seededRng(seed))));
      expect(looks.size, type).toBeGreaterThan(5);
    }
  });

  it('is repeatable for a seed', () => {
    const base = defaultLayerOfType('instancer', 'ly', 'L', dataset, rain);
    expect(randomiseLayer(base, rain, TZ, '#000000', 'all', seededRng(7))).toEqual(randomiseLayer(base, rain, TZ, '#000000', 'all', seededRng(7)));
  });

  it('a mapped height keeps to recipes that show it', () => {
    const base = defaultLayerOfType('instancer', 'ly', 'L', dataset, rain);
    if (base.type !== 'instancer') throw new Error('expected an instancer');
    base.channels.height.column = 'Rainfall [mm]';
    for (let seed = 1; seed <= 40; seed++) {
      const out = randomiseLayer(base, rain, TZ, '#000000', 'look', seededRng(seed));
      if (out.type !== 'instancer') throw new Error('expected an instancer');
      expect(['bar', 'box'], `seed ${seed}`).toContain(out.primitive);
    }
  });

  it('a calendar or grid of boxes always has a column to colour or raise it', () => {
    const base = defaultLayerOfType('instancer', 'ly', 'L', dataset, rain);
    if (base.type !== 'instancer') throw new Error('expected an instancer');
    base.channels.colour.column = null;
    base.channels.height.column = null;
    for (const scope of RANDOM_SCOPES) {
      for (let seed = 1; seed <= 60; seed++) {
        const out = randomiseLayer(base, rain, TZ, '#000000', scope, seededRng(seed));
        if (out.type !== 'instancer') throw new Error('expected an instancer');
        if (out.arrangement === 'calendar' || out.arrangement === 'grid') {
          expect(out.channels.colour.column ?? out.channels.height.column, `${scope} seed ${seed}`).not.toBeNull();
        }
      }
    }
  });

  it("'all' prefers columns that are mostly filled in, and a ridgeline draws every row", () => {
    const deficit = rain.columns.find((c) => c.name === 'Deficit [mm]')!;
    expect(deficit.nullCount).toBeGreaterThan(0.2 * rain.rowCount);
    const period = rain.columns.find((c) => c.name === 'PERIOD [hrs]')!;
    expect(period.typical).toEqual([24, 24]);
    for (const type of LAYER_TYPES) {
      const base = defaultLayerOfType(type, 'ly', 'L', type === 'reflector' ? null : dataset, rain);
      for (let seed = 1; seed <= 40; seed++) {
        const out = randomiseLayer(base, rain, TZ, '#000000', 'all', seededRng(seed));
        expect(columnRefs(out), `${type} seed ${seed}`).not.toContain('Deficit [mm]');
        expect(columnRefs(out), `${type} seed ${seed}`).not.toContain('Runoff [mm]');
        expect(columnRefs(out), `${type} seed ${seed}`).not.toContain('PERIOD [hrs]'); // nearly always 24
        if (out.type === 'line' && out.cloner.count > 1) expect(out.aggregate.by, `seed ${seed}`).toBe('none');
      }
    }
  });

  it('the look after a ridgeline shows all the rows again', () => {
    const base = defaultLayerOfType('line', 'ly', 'L', dataset, rain);
    let ridge: LayerConfig | null = null;
    for (let seed = 1; seed <= 60 && !ridge; seed++) {
      const out = randomiseLayer(base, rain, TZ, '#000000', 'look', seededRng(seed));
      if (out.type === 'line' && out.cloner.count > 1) ridge = out;
    }
    if (ridge?.type !== 'line') throw new Error('expected a ridgeline among 60 seeds');
    expect(ridge.rows[1]).toBeLessThan(0.05);
    for (let seed = 1; seed <= 20; seed++) {
      const next = randomiseLayer(ridge, rain, TZ, '#000000', 'look', seededRng(seed));
      if (next.type === 'line' && next.cloner.count === 1) expect(next.rows, `seed ${seed}`).toEqual([0, 1]);
    }
  });

  it('picks colours that stand out from the background', () => {
    for (const [background, dark] of [
      ['#000000', true],
      ['#f4f4f0', false],
    ] as const) {
      for (let seed = 1; seed <= 30; seed++) {
        const base = defaultLayerOfType('line', 'ly', 'L', dataset, rain);
        const out = randomiseLayer(base, rain, TZ, background, 'look', seededRng(seed));
        if (out.type !== 'line') throw new Error('expected a line');
        expect(contrast(out.colour, background), `seed ${seed} ${out.colour}`).toBeGreaterThanOrEqual(4.5);
        expect(luminance(out.colour) > luminance(background), `seed ${seed}`).toBe(dark);
      }
    }
  });

  it('never washes a dense layer out: no additive blend, soft glow, no box edges', () => {
    // 42,748 rows: far past the dense threshold.
    for (const type of ['instancer', 'multiples'] as const) {
      const base = defaultLayerOfType(type, 'ly', 'L', dataset, rain);
      for (const scope of RANDOM_SCOPES) {
        for (let seed = 1; seed <= 60; seed++) {
          const out = randomiseLayer(base, rain, TZ, '#000000', scope, seededRng(seed));
          const where = `${type} ${scope} seed ${seed}`;
          expect(out.blend, where).toBe('normal');
          if (out.effects.glow.enabled) {
            expect(out.effects.glow.threshold, where).toBeGreaterThanOrEqual(0.5);
            expect(out.effects.glow.strength, where).toBeLessThanOrEqual(0.6);
          }
          if (out.type === 'instancer') expect(out.edges.enabled, where).toBe(false);
        }
      }
    }
    // A sparse layer (the first 2% of rows) may glow brightly and get edges.
    const sparse = defaultLayerOfType('instancer', 'ly', 'L', dataset, rain);
    if (sparse.type !== 'instancer') throw new Error('expected an instancer');
    sparse.rows = [0, 0.02];
    const looks = Array.from({ length: 60 }, (_, i) => randomiseLayer(sparse, rain, TZ, '#000000', 'look', seededRng(i + 1)));
    expect(looks.some((l) => l.blend === 'additive')).toBe(true);
    expect(looks.some((l) => l.type === 'instancer' && l.edges.enabled)).toBe(true);
  });

  it('leaves a data layer alone without its summary', () => {
    const base = defaultLayerOfType('heatmap', 'ly', 'L', dataset, rain);
    expect(randomiseLayer(base, null, TZ, '#000000', 'look', seededRng(1))).toEqual(base);
  });

  it('hslHex gives the expected colours', () => {
    expect(hslHex(0, 1, 0.5)).toBe('#ff0000');
    expect(hslHex(120, 1, 0.5)).toBe('#00ff00');
    expect(hslHex(240, 1, 0.25)).toBe('#000080');
    expect(luminance('#ffffff')).toBeCloseTo(1, 6);
  });
});
