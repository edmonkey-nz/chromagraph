import { describe, expect, it } from 'vitest';
import { calendarFields } from '../../src/data/calendar.ts';
import { divisions, layoutAcross, MONTH_STARTS, yearIndexRange } from '../../src/data/calendar-across.ts';
import { MISSING } from '../../src/data/instance-data.ts';
import { blankInstancerLayer, defaultInstancerLabels, type InstancerLayer } from '../../src/shared/layer-schema.ts';

function calendar(across: Partial<InstancerLayer['labels']['across']> = {}): InstancerLayer {
  const l = blankInstancerLayer('ly', 'L', 'ds');
  const labels = defaultInstancerLabels();
  return { ...l, arrangement: 'calendar', origin: [100, 1000, 0], cell: [5, 20], labels: { ...labels, offset: 10, across: { ...labels.across, enabled: true, ...across } } };
}

describe('calendar across labels', () => {
  it('month starts match the parse worker’s day of year in a leap year', () => {
    const cal = calendarFields(Float64Array.from(MONTH_STARTS.map((_, m) => Date.UTC(2024, m, 1))), 'UTC');
    expect([...cal.dayOfYear]).toEqual([...MONTH_STARTS]);
  });

  it('every unit tiles the 366 columns without gaps or overlaps', () => {
    for (const unit of ['days', 'weeks', 'months', 'quarters', 'seasons'] as const) {
      const all = divisions(unit, 'date');
      expect(all[0]!.start).toBe(0);
      expect(all.at(-1)!.end).toBe(366);
      for (let i = 1; i < all.length; i++) expect(all[i]!.start).toBe(all[i - 1]!.end);
    }
  });

  it('names: dates padded, day numbers from 1, weeks, quarters and southern seasons', () => {
    const days = divisions('days', 'date');
    expect([days[0]!.text, days[59]!.text, days[60]!.text, days[365]!.text]).toEqual(['01 Jan', '29 Feb', '01 Mar', '31 Dec']);
    expect(divisions('days', 'number')[31]!.text).toBe('32');
    expect(divisions('weeks', 'date').map((d) => d.text).slice(0, 2)).toEqual(['W1', 'W2']);
    expect(divisions('weeks', 'date')).toHaveLength(53);
    expect(divisions('quarters', 'date').map((d) => [d.text, d.start])).toEqual([['Q1', 0], ['Q2', 91], ['Q3', 182], ['Q4', 274]]);
    expect(divisions('seasons', 'date').map((d) => d.text)).toEqual(['Summer', 'Autumn', 'Winter', 'Spring', 'Summer']);
  });

  it('months are centred in each month, above the first year’s row', () => {
    const { texts, segments } = layoutAcross(calendar(), [0, 9]);
    expect(texts.map((t) => t.text)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(texts[0]!.key).toBe('months:0');
    expect(texts[0]!.x).toBe(100 + 15 * 5); // days 0..30
    expect(texts[11]!.x).toBe(100 + 350 * 5); // days 335..365
    // Year index 0 is centred at y 1000: top edge 1010, then the 10 px gap.
    expect(texts[0]).toMatchObject({ y: 1020, anchorY: 'bottom', anchorX: 'center' });
    expect(segments).toEqual([]);
  });

  it('every N picks divisions; days sit on their own column; lines start each labelled one', () => {
    const { texts, segments } = layoutAcross(calendar({ unit: 'days', every: 30, lines: true, side: 'bottom' }), [2, 9]);
    expect(texts.map((t) => t.text).slice(0, 3)).toEqual(['01 Jan', '31 Jan', '01 Mar']);
    expect(texts[2]!.x).toBe(100 + 60 * 5);
    expect(texts[2]!.key).toBe('days:60');
    // Year index 9 is at 1000 − 180 = 820; bottom edge 810; then the gap.
    expect(texts[0]).toMatchObject({ y: 800, anchorY: 'top' });
    // No line at the first column; one before each other labelled day, down the whole grid.
    expect(segments).toHaveLength(texts.length - 1);
    expect(segments[0]!.a[0]).toBe(100 + 29.5 * 5);
    expect([segments[0]!.a[1], segments[0]!.b[1]]).toEqual([1000 - 40 + 10, 810]);
    const q = layoutAcross(calendar({ unit: 'months', every: 3 }), [0, 0]).texts.map((t) => t.text);
    expect(q).toEqual(['Jan', 'Apr', 'Jul', 'Oct']);
  });

  it('nothing unless on, on a calendar, with dated rows', () => {
    expect(layoutAcross(calendar({ enabled: false }), [0, 1]).texts).toEqual([]);
    expect(layoutAcross({ ...calendar(), arrangement: 'grid' }, [0, 1]).texts).toEqual([]);
    expect(layoutAcross(calendar(), null).texts).toEqual([]);
  });

  it('year index range skips rows without a date', () => {
    expect(yearIndexRange(Float32Array.from([MISSING, 3, 1, MISSING, 7]))).toEqual([1, 7]);
    expect(yearIndexRange(Float32Array.from([MISSING]))).toBeNull();
    expect(yearIndexRange(null)).toBeNull();
  });
});
