import { categoryColumns, timeColumns, type DatasetSummary, type SummaryColumn } from './layer-defaults.ts';
import { HIERARCHY_TIME_UNITS, type HierarchyLevel, type SmallMultiplesLayer } from './layer-schema.ts';

/**
 * Pure helpers for the columns that phase 7 layers group by: a hierarchy's levels and a
 * small multiples layer's split. They keep column references pointing at columns of the
 * right type (time columns for calendar units, category columns for categories), and are
 * shared by the control window's folders and the dataset-switch clean-up. No DOM.
 */

/** A hierarchy has 1..5 levels (HierarchyLayerSchema). */
export const MIN_LEVELS = 1;
export const MAX_LEVELS = 5;

type LevelKind = HierarchyLevel['kind'];
type TimeUnit = (typeof HIERARCHY_TIME_UNITS)[number];
type SplitBy = SmallMultiplesLayer['splitBy'];

/** Columns a level of `kind` (or a split by calendar unit / category) can group by. */
export function levelColumns(kind: LevelKind, summary: DatasetSummary): SummaryColumn[] {
  return kind === 'time' ? timeColumns(summary) : categoryColumns(summary);
}

function hasColumn(kind: LevelKind, name: string, summary: DatasetSummary): boolean {
  return levelColumns(kind, summary).some((c) => c.name === name);
}

/** "decade of Observation time UTC", or the category column's name. */
export function levelTitle(level: HierarchyLevel): string {
  const column = level.column || '(no column)';
  return level.kind === 'time' ? `${level.unit} of ${column}` : column;
}

/**
 * `prev` turned into a level of `kind`: it keeps its column when that suits the new kind,
 * otherwise takes the first suitable column (or keeps the old name when there is none, which
 * the output reports). A new time level keeps the old unit, or groups by year.
 */
export function levelOfKind(kind: LevelKind, prev: HierarchyLevel, summary: DatasetSummary): HierarchyLevel {
  const column = hasColumn(kind, prev.column, summary) ? prev.column : (levelColumns(kind, summary)[0]?.name ?? prev.column);
  if (kind === 'category') return { kind, column };
  return { kind, column, unit: prev.kind === 'time' ? prev.unit : 'year' };
}

/** The next finer calendar unit (decade -> year -> month -> day), or null after day. */
export function finerUnit(unit: TimeUnit): TimeUnit | null {
  return HIERARCHY_TIME_UNITS[HIERARCHY_TIME_UNITS.indexOf(unit) + 1] ?? null;
}

/**
 * A sensible level to append: the next finer unit of the last level's time column; else the
 * first category column not used yet; else the first time column at the finest unit not used
 * for it; else a copy of the last level.
 */
export function nextLevel(levels: readonly HierarchyLevel[], summary: DatasetSummary): HierarchyLevel {
  const last = levels[levels.length - 1];
  if (last?.kind === 'time') {
    const unit = finerUnit(last.unit);
    if (unit) return { kind: 'time', column: last.column, unit };
  }
  const used = new Set(levels.filter((l) => l.kind === 'category').map((l) => l.column));
  const category = categoryColumns(summary).find((c) => !used.has(c.name));
  if (category) return { kind: 'category', column: category.name };
  const time = timeColumns(summary)[0];
  if (time) {
    const units = new Set(levels.flatMap((l) => (l.kind === 'time' && l.column === time.name ? [l.unit] : [])));
    const unit = HIERARCHY_TIME_UNITS.find((u) => !units.has(u));
    if (unit) return { kind: 'time', column: time.name, unit };
  }
  return last ? structuredClone(last) : { kind: 'time', column: '', unit: 'year' };
}

/** Levels with `nextLevel` appended; unchanged (as a copy) at MAX_LEVELS. */
export function addLevel(levels: readonly HierarchyLevel[], summary: DatasetSummary): HierarchyLevel[] {
  if (levels.length >= MAX_LEVELS) return levels.slice();
  return [...levels, nextLevel(levels, summary)];
}

/** Levels without the one at `index`; never removes the last remaining level. */
export function removeLevel(levels: readonly HierarchyLevel[], index: number): HierarchyLevel[] {
  if (levels.length <= MIN_LEVELS || index < 0 || index >= levels.length) return levels.slice();
  return levels.filter((_, i) => i !== index);
}

/**
 * Levels checked against a dataset: a level whose column is gone (or no longer the right
 * type) is re-pointed to the first suitable column, or dropped when there is none. At least
 * one level is always kept: if every level would go, the first is switched to the other kind
 * when that kind has a column, otherwise left as it is (and reported by the output).
 */
export function repairLevels(levels: readonly HierarchyLevel[], summary: DatasetSummary): HierarchyLevel[] {
  const out: HierarchyLevel[] = [];
  for (const level of levels) {
    if (hasColumn(level.kind, level.column, summary)) {
      out.push(level);
      continue;
    }
    const first = levelColumns(level.kind, summary)[0];
    if (first) out.push({ ...level, column: first.name });
  }
  if (out.length > 0) return out;
  const head = levels[0];
  if (!head) return [];
  const other: LevelKind = head.kind === 'time' ? 'category' : 'time';
  return [levelColumns(other, summary).length > 0 ? levelOfKind(other, head, summary) : head];
}

/** True for splits by calendar unit (year, month, decade), which need a time column. */
export function isTimeSplit(splitBy: SplitBy): boolean {
  return splitBy === 'year' || splitBy === 'month' || splitBy === 'decade';
}

/**
 * The split column for `splitBy`: the current one if it suits (a time column for calendar
 * splits, a category column for `category`), else the first that does; null for `rows` or
 * when the dataset has no suitable column.
 */
export function splitColumnFor(splitBy: SplitBy, current: string | null, summary: DatasetSummary): string | null {
  if (splitBy === 'rows') return null;
  const kind: LevelKind = isTimeSplit(splitBy) ? 'time' : 'category';
  if (current !== null && hasColumn(kind, current, summary)) return current;
  return levelColumns(kind, summary)[0]?.name ?? null;
}

/**
 * A split that works with a dataset: the same split on a suitable column if there is one,
 * otherwise by year on the first time column, by the first category, or by row chunks.
 */
export function repairSplit(splitBy: SplitBy, current: string | null, summary: DatasetSummary): { splitBy: SplitBy; splitColumn: string | null } {
  const column = splitColumnFor(splitBy, current, summary);
  if (splitBy === 'rows' || column !== null) return { splitBy, splitColumn: column };
  const time = timeColumns(summary)[0];
  if (time) return { splitBy: 'year', splitColumn: time.name };
  const category = categoryColumns(summary)[0];
  if (category) return { splitBy: 'category', splitColumn: category.name };
  return { splitBy: 'rows', splitColumn: null };
}
