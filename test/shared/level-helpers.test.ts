import { describe, expect, it } from 'vitest';
import type { DatasetSummary } from '../../src/shared/layer-defaults.ts';
import { HierarchyLevelSchema, type HierarchyLevel } from '../../src/shared/layer-schema.ts';
import {
  addLevel,
  finerUnit,
  isTimeSplit,
  levelOfKind,
  levelTitle,
  MAX_LEVELS,
  nextLevel,
  removeLevel,
  repairLevels,
  repairSplit,
  splitColumnFor,
} from '../../src/shared/level-helpers.ts';

const DAY = 86_400_000;

const both: DatasetSummary = {
  rowCount: 100,
  columns: [
    { name: 'date', type: 'time', min: 0, max: 99 * DAY, empty: false },
    { name: 'blank time', type: 'time', min: NaN, max: NaN, empty: true },
    { name: 'site', type: 'category', min: NaN, max: NaN, empty: false, categories: 4 },
    { name: 'source', type: 'category', min: NaN, max: NaN, empty: false, categories: 2 },
    { name: 'rain', type: 'number', min: 0, max: 10, empty: false },
  ],
  cadences: { date: { step: DAY } },
};
const numbersOnly: DatasetSummary = { rowCount: 10, columns: [{ name: 'rain', type: 'number', min: 0, max: 1, empty: false }], cadences: {} };
const timeOnly: DatasetSummary = { ...both, columns: both.columns.filter((c) => c.type !== 'category') };
const catOnly: DatasetSummary = { ...both, columns: both.columns.filter((c) => c.type !== 'time'), cadences: {} };

const decade: HierarchyLevel = { kind: 'time', column: 'date', unit: 'decade' };
const site: HierarchyLevel = { kind: 'category', column: 'site' };

function allValid(levels: HierarchyLevel[]): boolean {
  return levels.every((l) => HierarchyLevelSchema.safeParse(l).success);
}

describe('hierarchy levels', () => {
  it('titles levels', () => {
    expect(levelTitle(decade)).toBe('decade of date');
    expect(levelTitle(site)).toBe('site');
    expect(levelTitle({ kind: 'time', column: '', unit: 'year' })).toBe('year of (no column)');
  });

  it('switches a level between kinds, keeping what still fits', () => {
    expect(levelOfKind('category', decade, both)).toEqual({ kind: 'category', column: 'site' });
    expect(levelOfKind('time', site, both)).toEqual({ kind: 'time', column: 'date', unit: 'year' });
    expect(levelOfKind('time', decade, both)).toEqual(decade);
    // Nothing suitable: keep the name, so the output can report it.
    expect(levelOfKind('category', decade, timeOnly)).toEqual({ kind: 'category', column: 'date' });
  });

  it('appends finer units, then unused categories, then unused units', () => {
    expect(finerUnit('decade')).toBe('year');
    expect(finerUnit('day')).toBeNull();
    expect(nextLevel([decade], both)).toEqual({ kind: 'time', column: 'date', unit: 'year' });
    expect(nextLevel([{ ...decade, unit: 'day' }], both)).toEqual(site);
    expect(nextLevel([site], both)).toEqual({ kind: 'category', column: 'source' });
    expect(nextLevel([site, { kind: 'category', column: 'source' }], both)).toEqual({ kind: 'time', column: 'date', unit: 'decade' });
    expect(nextLevel([{ ...decade, unit: 'day' }], timeOnly)).toEqual(decade);
    expect(nextLevel([site], numbersOnly)).toEqual(site);
  });

  it('keeps 1..5 levels when adding and removing', () => {
    let levels: HierarchyLevel[] = [decade];
    for (let i = 0; i < 10; i++) levels = addLevel(levels, both);
    expect(levels).toHaveLength(MAX_LEVELS);
    expect(levels.map(levelTitle)).toEqual(['decade of date', 'year of date', 'month of date', 'day of date', 'site']);
    expect(allValid(levels)).toBe(true);
    expect(removeLevel(levels, 1).map(levelTitle)).toEqual(['decade of date', 'month of date', 'day of date', 'site']);
    expect(removeLevel([decade], 0)).toEqual([decade]);
    expect(removeLevel([decade, site], 5)).toEqual([decade, site]);
  });

  it('repairs levels against a new dataset: re-point, drop, keep one', () => {
    const levels: HierarchyLevel[] = [
      { kind: 'time', column: 'when', unit: 'decade' },
      { kind: 'category', column: 'gone' },
      { kind: 'time', column: 'date', unit: 'year' },
    ];
    expect(repairLevels(levels, both)).toEqual([
      { kind: 'time', column: 'date', unit: 'decade' },
      { kind: 'category', column: 'site' },
      { kind: 'time', column: 'date', unit: 'year' },
    ]);
    // No category columns: that level goes.
    expect(repairLevels(levels, timeOnly)).toEqual([
      { kind: 'time', column: 'date', unit: 'decade' },
      { kind: 'time', column: 'date', unit: 'year' },
    ]);
    // No time columns: the time levels go, the category one is re-pointed.
    expect(repairLevels(levels, catOnly)).toEqual([{ kind: 'category', column: 'site' }]);
    // Only time levels and no time column: the first becomes a category level.
    expect(repairLevels([decade], catOnly)).toEqual([{ kind: 'category', column: 'site' }]);
    // Nothing to group by: the first level stays as it is.
    expect(repairLevels([decade, site], numbersOnly)).toEqual([decade]);
    // A blank level (new layer without data) is pointed at a real column.
    expect(repairLevels([{ kind: 'time', column: '', unit: 'decade' }], both)).toEqual([decade]);
    // An empty time column never counts.
    expect(repairLevels([{ kind: 'time', column: 'blank time', unit: 'year' }], both)).toEqual([{ kind: 'time', column: 'date', unit: 'year' }]);
  });
});

describe('small multiples split', () => {
  it('picks a column of the right type', () => {
    expect(isTimeSplit('decade')).toBe(true);
    expect(isTimeSplit('category')).toBe(false);
    expect(splitColumnFor('year', 'date', both)).toBe('date');
    expect(splitColumnFor('year', 'site', both)).toBe('date');
    expect(splitColumnFor('category', 'date', both)).toBe('site');
    expect(splitColumnFor('category', 'source', both)).toBe('source');
    expect(splitColumnFor('rows', 'date', both)).toBeNull();
    expect(splitColumnFor('month', null, catOnly)).toBeNull();
  });

  it('repairs a split that no longer works', () => {
    expect(repairSplit('year', 'gone', both)).toEqual({ splitBy: 'year', splitColumn: 'date' });
    expect(repairSplit('month', 'date', catOnly)).toEqual({ splitBy: 'category', splitColumn: 'site' });
    expect(repairSplit('category', 'site', timeOnly)).toEqual({ splitBy: 'year', splitColumn: 'date' });
    expect(repairSplit('decade', 'date', numbersOnly)).toEqual({ splitBy: 'rows', splitColumn: null });
    expect(repairSplit('rows', null, both)).toEqual({ splitBy: 'rows', splitColumn: null });
  });
});
