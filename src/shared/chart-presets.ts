import { scaleLinear } from 'd3-scale';
import { categoryColumns, firstVaryingNumber, fitLayer, fitLineLayer, FRAME_W, MARGIN, timeColumns, type DatasetSummary } from './layer-defaults.ts';
import type { InstancerLayer, LineLayer } from './layer-schema.ts';

/**
 * The "Bar chart" preset for an instancer: a plain, honest bar chart of a small dataset with
 * its axes and value labels (InstancerAxesSchema), fitted to the output.
 *   - bars in a line, in row order (or on the time axis when the layer already uses one);
 *     height from the mapped column (or the first varying number)
 *   - the height domain starts at zero (or at a rounded minimum below zero) and ends at a
 *     rounded maximum, so bar lengths are proportional to the values; range 0..BAR_MAX_PX
 *   - room on the left for the value axis and below for the category labels
 *   - value labels above the bars, a category axis labelled from the best label column (a
 *     category with a value per row, else the time column, else the first category column)
 *     and a value axis with gridlines
 * Returns the new layer (diff it). Colour, effects and transform are left alone.
 */

/** px: the tallest bar, the baseline's height, and the space left of the bars for the value axis. */
export const BAR_MAX_PX = 720;
export const BAR_BASE_Y = 170;
export const BAR_LEFT = 200;
const BAR_RIGHT = 60;

/**
 * The column whose values name the rows best, or null for row numbers: a text column (a value
 * per row, like "Jun-98"), or a category with nearly a value per row; else the time column (as
 * dates); else the first category column.
 */
export function labelColumnFor(summary: DatasetSummary): { column: string | null; time: string | null } {
  const text = summary.columns.find((c) => c.type === 'text' && !c.empty);
  if (text) return { column: text.name, time: null };
  const cats = categoryColumns(summary);
  const unique = cats.find((c) => (c.categories ?? 0) >= summary.rowCount * 0.9);
  if (unique) return { column: unique.name, time: null };
  const time = timeColumns(summary)[0];
  if (time) return { column: null, time: time.name };
  return { column: cats[0]?.name ?? null, time: null };
}

/** Ticks the preset's value axis aims for (the domain is rounded to fit them). */
const BAR_TICKS = 5;

/** [low, high] that holds 0 and the column's range, rounded outwards to about BAR_TICKS round ticks. */
export function zeroBasedDomain(min: number, max: number): [number, number] {
  const lo = Math.min(0, Number.isFinite(min) ? min : 0);
  const hi = Math.max(0, Number.isFinite(max) ? max : 1);
  if (lo === hi) return [0, 1];
  const [a, b] = scaleLinear().domain([lo, hi]).nice(BAR_TICKS).domain() as [number, number];
  return [a, b];
}

export function barChartPreset(layer: InstancerLayer, summary: DatasetSummary, timeZone: string): InstancerLayer {
  let out = structuredClone(layer);
  out.arrangement = 'linear';
  if (out.primitive !== 'bar' && out.primitive !== 'box') out.primitive = 'bar';
  out.heightAxis = out.primitive === 'box' ? out.heightAxis : 'y';
  out.cloner = { ...out.cloner, count: 1 };
  const valueName = out.channels.height.column ?? firstVaryingNumber(summary)?.name ?? null;
  const value = summary.columns.find((c) => c.name === valueName);
  const labels = labelColumnFor(summary);
  if (labels.time !== null && out.timeColumn === null) out.timeColumn = labels.time;

  out = fitLayer(out, summary, timeZone);

  // The fit put t = tStart at the margin with `sx` px per unit of t over the usable width; lay
  // the same rows out between the value axis and the right margin instead, each bar centred
  // in its slot, on a raised baseline (room for the category labels).
  const sx = out.step[0] > 0 ? out.step[0] : 1;
  const span = (FRAME_W - 2 * MARGIN) / sx;
  const tStart = (MARGIN - out.origin[0]) / sx;
  const step = (FRAME_W - BAR_LEFT - BAR_RIGHT) / (span + 1);
  out.step = [step, 0, 0];
  out.origin = [BAR_LEFT + step / 2 - tStart * step, BAR_BASE_Y, 0];
  out.size = [Math.max(2, step * 0.7), out.size[1], Math.max(2, step * 0.7)];

  out.channels.height = {
    ...out.channels.height,
    column: valueName,
    scale: 'linear',
    domain: value ? zeroBasedDomain(value.min, value.max) : null,
    range: [0, BAR_MAX_PX],
    clamp: true,
  };
  out.channels.y = { ...out.channels.y, column: null };

  out.axes = {
    ...out.axes,
    values: { ...out.axes.values, enabled: true, column: null, place: 'above', decimals: -1 },
    x: { ...out.axes.x, enabled: true, line: true, column: labels.column, every: 1, angle: 0 },
    y: { ...out.axes.y, enabled: true, line: true, grid: true, side: 'left', ticks: BAR_TICKS },
  };
  return out;
}

/**
 * The "Line chart" preset for a line layer: aggregated (by month with a time column, else every
 * 30 rows, unless it already aggregates), the x axis naming each point and a value axis with
 * gridlines on, fitted with room for both (fitLineLayer's chart frame). The y domain stays auto,
 * so it follows the combined values. Colour, effects and transform are left alone.
 */
export function lineChartPreset(layer: LineLayer, summary: DatasetSummary): LineLayer {
  const out = structuredClone(layer);
  if (out.aggregate.by === 'none') out.aggregate = { ...out.aggregate, by: out.timeColumn ? 'month' : 'rows', rows: 30, fn: 'mean' };
  out.y = { ...out.y, domain: null };
  out.axes = {
    ...out.axes,
    x: { ...out.axes.x, enabled: true, line: true, angle: 0 },
    y: { ...out.axes.y, enabled: true, line: true, grid: true, side: 'left', ticks: 5 },
  };
  return fitLineLayer(out, summary);
}
