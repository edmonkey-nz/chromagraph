import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import type { TimeColumn } from '../../src/data/columns.ts';
import { detectCadence } from '../../src/data/gaps.ts';
import {
  buildInstanceData,
  firstDefinedT,
  LayerDataError,
  MISSING,
  normalise,
  resolveDomain,
  structureKey,
} from '../../src/data/instance-data.ts';
import { parseCsv } from '../../src/data/parse.ts';
import { blankInstancerLayer, type InstancerLayer } from '../../src/shared/layer-schema.ts';

const TIME = 'Observation time UTC';
const RAIN = 'Rainfall [mm]';
const DEFICIT = 'Deficit [mm]';

const { table } = parseCsv(readFileSync(new URL('../fixtures/3384__Rain__daily.csv', import.meta.url), 'utf8'));
const timeCol = table.columns.find((c) => c.name === TIME) as TimeColumn;
const cadences = { [TIME]: detectCadence(timeCol.values) };
const calendars = { [TIME]: calendarFields(timeCol.values, 'Pacific/Auckland') };

function layer(patch: Partial<InstancerLayer> = {}): InstancerLayer {
  return { ...blankInstancerLayer('l1', 'L', 'ds'), ...patch };
}

describe('buildInstanceData', () => {
  it('uses row index in index mode', () => {
    const d = buildInstanceData(layer(), table, cadences, calendars);
    expect(d.count).toBe(42_748);
    expect([d.t[0], d.t[1], d.t[42_747]]).toEqual([0, 1, 42_747]);
  });

  it('uses cadence steps in time mode, so gaps stay as gaps', () => {
    const d = buildInstanceData(layer({ xMode: 'time', timeColumn: TIME }), table, cadences, calendars);
    expect(d.t[0]).toBe(0);
    expect(d.t[1]).toBe(1);
    // The record has gaps, so the last t exceeds the row count.
    expect(d.t[d.count - 1]!).toBeGreaterThan(d.count - 1);
    for (let i = 1; i < d.count; i++) expect(d.t[i]!).toBeGreaterThan(d.t[i - 1]!);
  });

  it('builds calendar fields from the first year', () => {
    const d = buildInstanceData(layer({ arrangement: 'calendar', timeColumn: TIME }), table, cadences, calendars);
    expect(d.years).toBe(1997 - 1879 + 1);
    expect(d.yearIndex![0]).toBe(0);
    expect(d.dayOfYear![0]).toBe(1); // 2 Jan local
    expect(d.yearIndex![d.count - 1]).toBe(1997 - 1879);
  });

  it('keeps missing values missing', () => {
    const l = layer();
    l.channels = { ...l.channels, height: { ...l.channels.height, column: DEFICIT } };
    const d = buildInstanceData(l, table, cadences, calendars);
    const h = d.channels.height!;
    // Deficit runs only from 1928-02-13 to 1996-09-30.
    const row1928 = timeCol.values.indexOf(Date.parse('1928-02-13T21:00:00Z'));
    expect(h.values[0]).toBe(MISSING);
    expect(h.values[row1928]).toBeCloseTo(142.1, 3);
    expect(h.values[d.count - 1]).toBe(MISSING);
    expect(h.autoDomain[0]).toBe(0);
  });

  it('maps categories to codes, colour only', () => {
    const l = layer();
    l.channels = { ...l.channels, colour: { ...l.channels.colour, column: 'Data Source (rainfall)' } };
    const d = buildInstanceData(l, table, cadences, calendars);
    expect(d.channels.colour!.categories).toBe(2);
    const bad = layer();
    bad.channels = { ...bad.channels, y: { ...bad.channels.y, column: 'Data Source (rainfall)' } };
    expect(() => buildInstanceData(bad, table, cadences, calendars)).toThrow(LayerDataError);
  });

  it('reports configuration problems as LayerDataError', () => {
    expect(() => buildInstanceData(layer({ xMode: 'time', timeColumn: null }), table, cadences, calendars)).toThrow(LayerDataError);
    expect(() => buildInstanceData(layer({ xMode: 'time', timeColumn: RAIN }), table, cadences, calendars)).toThrow(/not a time column/);
    expect(() => buildInstanceData(layer({ arrangement: 'calendar', timeColumn: TIME }), table, cadences, {})).toThrow(/calendar/);
    const l = layer();
    l.channels = { ...l.channels, y: { ...l.channels.y, column: 'nope' } };
    expect(() => buildInstanceData(l, table, cadences, calendars)).toThrow(/not found/);
  });
});

describe('scales', () => {
  it('normalises linear, sqrt, log and quantise like the shader', () => {
    expect(normalise(5, [0, 10], 'linear', 5, true)).toBe(0.5);
    expect(normalise(20, [0, 10], 'linear', 5, false)).toBe(2);
    expect(normalise(20, [0, 10], 'linear', 5, true)).toBe(1);
    expect(normalise(25, [0, 100], 'sqrt', 5, true)).toBeCloseTo(0.5);
    expect(normalise(10, [1, 100], 'log', 5, true)).toBeCloseTo(0.5);
    expect(normalise(0.5, [0, 1], 'quantise', 3, true)).toBe(0.5);
    expect(normalise(1, [0, 1], 'quantise', 4, true)).toBe(1);
    expect(normalise(3, [3, 3], 'linear', 5, true)).toBe(0.5);
  });

  it('auto log domain starts at the smallest positive value', () => {
    const l = layer();
    l.channels = { ...l.channels, height: { ...l.channels.height, column: RAIN, scale: 'log' } };
    const d = buildInstanceData(l, table, cadences, calendars);
    const [lo, hi] = resolveDomain(l.channels.height, d.channels.height!);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeCloseTo(215.9, 3);
  });

  it('only structural fields change the structure key', () => {
    const a = layer();
    expect(structureKey({ ...a, opacity: 0.2, origin: [1, 2, 3] }, 'UTC')).toBe(structureKey(a, 'UTC'));
    expect(structureKey({ ...a, primitive: 'point' }, 'UTC')).not.toBe(structureKey(a, 'UTC'));
  });

  it('finds the first defined t for followRange', () => {
    expect(firstDefinedT(new Float32Array([MISSING, MISSING, 7, 8]), 0)).toBe(7);
    expect(firstDefinedT(new Float32Array([1, 2]), 5)).toBe(0);
  });
});
