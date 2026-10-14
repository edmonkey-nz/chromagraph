import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/data/parse.ts';
import { BAR_BASE_Y, BAR_LEFT, BAR_MAX_PX, barChartPreset, labelColumnFor, zeroBasedDomain } from '../../src/shared/chart-presets.ts';
import { defaultLayerFor, FRAME_H, FRAME_W, summarise } from '../../src/shared/layer-defaults.ts';
import { LayerSchema } from '../../src/shared/layer-schema.ts';
import type { Dataset } from '../../src/shared/project-schema.ts';

// The Blocks project's dataset (28 June quarters, 1998-2025).
const rows = Array.from({ length: 28 }, (_, i) => `"Jun-${String((98 + i) % 100).padStart(2, '0')}",${(16.2 - i * 0.3).toFixed(1)}`);
const table = parseCsv(`"Quarter","Gender pay gap"\n${rows.join('\n')}\n`).table;
const summary = summarise(table, {});
const dataset: Dataset = { id: 'ds', label: 'pay gap', file: 'gap.csv', timeZone: 'Pacific/Auckland', source: '', url: '', attribution: '' };

describe('bar chart preset', () => {
  it('labels the bars with the quarter column (text: a value per row)', () => {
    expect(summary.columns[0]).toMatchObject({ name: 'Quarter', type: 'text' });
    expect(labelColumnFor(summary)).toEqual({ column: 'Quarter', time: null });
  });

  it('zero-based, rounded domains', () => {
    expect(zeroBasedDomain(8.1, 16.2)).toEqual([0, 20]);
    expect(zeroBasedDomain(-3, 7)).toEqual([-4, 8]);
    expect(zeroBasedDomain(0, 0)).toEqual([0, 1]);
  });

  it('a valid, honest bar chart that fits the frame with room for its axes', () => {
    const layer = defaultLayerFor('ly', 'bars', dataset, summary);
    const out = barChartPreset(layer, summary, 'Pacific/Auckland');
    expect(LayerSchema.safeParse(out).success).toBe(true);
    expect(out.arrangement).toBe('linear');
    expect(out.primitive).toBe('bar');
    expect(out.channels.height).toMatchObject({ column: 'Gender pay gap', scale: 'linear', domain: [0, 20], range: [0, BAR_MAX_PX] });
    // Bars from just right of the value axis to the right margin.
    const firstCentre = out.origin[0];
    const lastCentre = out.origin[0] + 27 * out.step[0];
    expect(firstCentre - out.size[0] / 2).toBeGreaterThan(BAR_LEFT);
    expect(lastCentre + out.size[0] / 2).toBeLessThan(FRAME_W);
    expect(out.origin[1]).toBe(BAR_BASE_Y);
    // The tallest bar plus its value label stays inside the frame.
    expect(BAR_BASE_Y + BAR_MAX_PX + out.axes.values.gap + out.axes.values.size).toBeLessThan(FRAME_H);
    expect(out.axes.values).toMatchObject({ enabled: true, place: 'above' });
    expect(out.axes.x).toMatchObject({ enabled: true, column: 'Quarter' });
    expect(out.axes.y).toMatchObject({ enabled: true, grid: true });
    // Identity and look are kept.
    expect([out.id, out.colour, out.transform]).toEqual([layer.id, layer.colour, layer.transform]);
  });

  it('keeps a partial row range in view', () => {
    const layer = defaultLayerFor('ly', 'bars', dataset, summary);
    layer.rows = [0.5, 1];
    const out = barChartPreset(layer, summary, 'Pacific/Auckland');
    const firstVisible = 14;
    expect(out.origin[0] + firstVisible * out.step[0] - out.size[0] / 2).toBeGreaterThan(BAR_LEFT);
    expect(out.origin[0] + 27 * out.step[0] + out.size[0] / 2).toBeLessThan(FRAME_W);
  });
});
