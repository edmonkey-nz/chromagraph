import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyPlacement, labelRows, placeLabel } from '../../src/data/instance-labels.ts';
import { blankInstancerLayer, defaultInstancerLabels, LayerSchema } from '../../src/shared/layer-schema.ts';
import { migrate } from '../../src/shared/project-schema.ts';

// Newest first, as the ozone file: 2021-03-01, 2021-01-05, 2020-12-31, 2020-02-10.
const t = Float32Array.from([425, 370, 365, 40]);
const calendar = { year: Float32Array.from([2021, 2021, 2020, 2020]), dayOfYear: Float32Array.from([59, 4, 365, 40]) };

describe('calendar labels', () => {
  it('label each year (and decade) at its earliest day, whatever the file order', () => {
    expect([...labelRows({ every: 'year', rows: 1 }, t, calendar)]).toEqual([1, 3]); // 2021-01-05, 2020-02-10
    expect([...labelRows({ every: 'decade', rows: 1 }, t, calendar)]).toEqual([3]); // the 2020s start at 2020-02-10
  });

  const layout = (align: 'point' | 'start' | 'end', offset = 16) => {
    const l = blankInstancerLayer('ly', 'L', null);
    return { ...l, arrangement: 'calendar' as const, origin: [100, 900, 0] as [number, number, number], cell: [4, 20] as [number, number], labels: { ...l.labels, offset, align } };
  };

  it('at its first point: left of that day’s cell', () => {
    const p = placeLabel(layout('point'), 0, 1, 40, emptyPlacement());
    expect([p.x, p.y, p.anchorX]).toEqual([100 + 40 * 4 - 16, 880, 'right']);
  });

  it('pinned to the start or end of the row, whatever the day', () => {
    const start = placeLabel(layout('start'), 0, 1, 200, emptyPlacement());
    expect([start.x, start.y, start.anchorX]).toEqual([100 - 16, 880, 'right']);
    const end = placeLabel(layout('end'), 0, 2, 3, emptyPlacement());
    expect([end.x, end.y, end.anchorX]).toEqual([100 + 366 * 4 + 16, 860, 'left']);
  });

  it('grid rows too; new layers pin to the start; older layers keep the point', () => {
    const l = { ...layout('end'), arrangement: 'grid' as const, gridColumns: 50 };
    expect(placeLabel(l, 75, 0, 0, emptyPlacement()).x).toBe(100 + 50 * 4 + 16);
    expect(defaultInstancerLabels().align).toBe('start');
    expect(LayerSchema.safeParse(blankInstancerLayer('a', 'a', null)).success).toBe(true);
    const r = migrate(JSON.parse(readFileSync(new URL('../fixtures/projects/v24.json', import.meta.url), 'utf8')));
    if (!r.ok) throw new Error(r.error);
    const inst = r.project.layers.find((x) => x.type === 'instancer');
    expect(inst?.type === 'instancer' && inst.labels.align).toBe('point');
  });
});
