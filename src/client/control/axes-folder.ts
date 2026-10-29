import type { BladeApi, FolderApi } from 'tweakpane';
import type { DatasetSummary } from '../../shared/layer-defaults.ts';
import { diffChanges } from '../../shared/layer-helpers.ts';
import { AXIS_SIDES, VALUE_LABEL_PLACES, type InstancerAxes, type LayerConfig } from '../../shared/layer-schema.ts';
import { addChoice, addFontCase, addNumber, addPlain, type LayerUi } from './layer-ui.ts';

/** What differs between the layer types that have "Axes & values" (instancer, line). */
export interface AxesFolderOptions {
  /** A chart preset button: a new config for the current layer, or null when it doesn't apply. */
  preset: { title: string; hint: string; make: (layer: LayerConfig, summary: DatasetSummary, timeZone: string) => LayerConfig | null };
  xTitle: string;
  /** The x labels' "no column" choice, e.g. "(the date)". */
  xNone: string;
  xHint: string;
  everyHint: string;
  valuesHint: string;
  valuesColumnHint: string;
  /** Notes shown in the folders when that part can't draw yet (null: none). */
  xNote: string | null;
  yNote: string | null;
  valuesNote: string | null;
}

function note(f: FolderApi, text: string): BladeApi {
  return f.addBlade({ view: 'text', label: '', parse: (v: string) => v, value: text, disabled: true });
}

/**
 * "Axes & values" (InstancerAxesSchema): value labels at the marks or points, an x axis with a
 * label per row (or bucket), a value axis, line colour and width, font, and the type's preset.
 */
export function buildAxesFolder(ui: LayerUi, parent: FolderApi, A: InstancerAxes, o: AxesFolderOptions): void {
  const f = ui.folder(parent, 'Axes & values', 'Axes', A.values.enabled || A.x.enabled || A.y.enabled);
  const columns = ui.summary?.columns.filter((c) => !c.empty) ?? [];
  const columnList = (none: string) => [{ text: none, value: '' }, ...columns.map((c) => ({ text: c.name, value: c.name }))];

  f.addButton({ title: ui.canFit ? o.preset.title : `${o.preset.title} (waiting for data)`, label: 'preset', disabled: !ui.canFit }).on('click', () => {
    const current = ui.entry.layer;
    const dataset = ui.getDoc()?.project.datasets.find((d) => d.id === current.datasetId);
    if (!ui.summary || !dataset) return;
    const next = o.preset.make(current, ui.summary, dataset.timeZone);
    if (next) ui.entry.forceRebuild = ui.send(diffChanges(current, next));
  }).element.title = o.preset.hint;
  addPlain(ui, f, A.colour, 'line colour', ['axes', 'colour']).element.title = 'Colour of the axis lines, ticks and gridlines';
  addNumber(ui, f, A.lineWidth, 'line width', ['axes', 'lineWidth'], { min: 1, max: 8, step: 0.5, hardMax: 20, hint: 'px; 2 is the projection minimum' });
  addFontCase(ui, f, A.font, A.uppercase, ['axes', 'font'], ['axes', 'uppercase']);

  // ---- value labels ----
  const v = ui.folder(f, 'Value labels', 'Axes/values', A.values.enabled);
  addPlain(ui, v, A.values.enabled, 'on', ['axes', 'values', 'enabled']).element.title = o.valuesHint;
  const vm = { column: A.values.column ?? '' };
  v.addBinding(vm, 'column', { label: 'column', options: columnList('(the mapped value)') }).on('change', (ev) =>
    ui.set(['axes', 'values', 'column'], ev.value === '' ? null : ev.value),
  ).element.title = o.valuesColumnHint;
  addChoice(ui, v, A.values.place, 'place', ['axes', 'values', 'place'], VALUE_LABEL_PLACES, {
    above: 'above',
    'inside-top': 'inside, at the top',
    'inside-middle': 'inside, in the middle',
    base: 'at the base',
  });
  addNumber(ui, v, A.values.size, 'size', ['axes', 'values', 'size'], { min: 6, max: 120, step: 1, hardMax: 200, hint: 'px at 1080p; 24 is the projection minimum' });
  addPlain(ui, v, A.values.colour, 'colour', ['axes', 'values', 'colour']);
  addNumber(ui, v, A.values.gap, 'gap', ['axes', 'values', 'gap'], { min: -50, max: 100, step: 1, hardMin: -200, hardMax: 200, hint: 'px from the end of the mark' });
  addNumber(ui, v, A.values.decimals, 'decimals', ['axes', 'values', 'decimals'], {
    min: -1,
    max: 6,
    step: 1,
    hardMax: 10,
    integer: true,
    hint: '-1 shows the values as the file writes them; 0 or more rounds to that many decimals',
  });
  addPlain(ui, v, A.values.prefix, 'prefix', ['axes', 'values', 'prefix']).element.title = 'Text before each value, e.g. $';
  addPlain(ui, v, A.values.suffix, 'suffix', ['axes', 'values', 'suffix']).element.title = 'Text after each value, e.g. %';
  if (o.valuesNote) note(v, o.valuesNote);

  // ---- x axis ----
  const x = ui.folder(f, o.xTitle, 'Axes/x', A.x.enabled);
  if (o.xNote) note(x, o.xNote);
  addPlain(ui, x, A.x.enabled, 'on', ['axes', 'x', 'enabled']).element.title = o.xHint;
  addPlain(ui, x, A.x.line, 'baseline', ['axes', 'x', 'line']);
  const xm = { column: A.x.column ?? '' };
  x.addBinding(xm, 'column', { label: 'labels', options: columnList(o.xNone) }).on('change', (ev) =>
    ui.set(['axes', 'x', 'column'], ev.value === '' ? null : ev.value),
  ).element.title = 'The column that names each row, e.g. Quarter';
  addNumber(ui, x, A.x.every, 'every', ['axes', 'x', 'every'], { min: 1, max: 100, step: 1, hardMax: 1_000_000, integer: true, hint: o.everyHint });
  addNumber(ui, x, A.x.size, 'size', ['axes', 'x', 'size'], { min: 6, max: 120, step: 1, hardMax: 200, hint: 'px at 1080p; 24 is the projection minimum' });
  addPlain(ui, x, A.x.colour, 'colour', ['axes', 'x', 'colour']);
  addNumber(ui, x, A.x.angle, 'angle', ['axes', 'x', 'angle'], { min: -90, max: 90, step: 15, hint: 'Turn the labels (degrees) so long or many labels fit' });
  addNumber(ui, x, A.x.gap, 'gap', ['axes', 'x', 'gap'], { min: 0, max: 100, step: 1, hardMax: 200, hint: 'px below the baseline' });
  addPlain(ui, x, A.x.title, 'title', ['axes', 'x', 'title']).element.title = 'Axis title, centred below the labels (empty: none)';

  // ---- value axis ----
  const y = ui.folder(f, 'Value axis', 'Axes/y', A.y.enabled);
  if (o.yNote) note(y, o.yNote);
  addPlain(ui, y, A.y.enabled, 'on', ['axes', 'y', 'enabled']).element.title = 'Ticks in the units of the mapped column, beside the marks';
  addPlain(ui, y, A.y.line, 'axis line', ['axes', 'y', 'line']);
  addNumber(ui, y, A.y.ticks, 'ticks', ['axes', 'y', 'ticks'], { min: 2, max: 20, step: 1, integer: true, hint: 'About how many round values to mark' });
  addPlain(ui, y, A.y.grid, 'gridlines', ['axes', 'y', 'grid']).element.title = 'A line across the chart at each tick';
  addNumber(ui, y, A.y.gridOpacity, 'grid opacity', ['axes', 'y', 'gridOpacity'], { min: 0, max: 1, step: 0.05 });
  addChoice(ui, y, A.y.side, 'side', ['axes', 'y', 'side'], AXIS_SIDES);
  addNumber(ui, y, A.y.size, 'size', ['axes', 'y', 'size'], { min: 6, max: 120, step: 1, hardMax: 200, hint: 'px at 1080p; 24 is the projection minimum' });
  addPlain(ui, y, A.y.colour, 'colour', ['axes', 'y', 'colour']);
  addNumber(ui, y, A.y.decimals, 'decimals', ['axes', 'y', 'decimals'], { min: -1, max: 6, step: 1, hardMax: 10, integer: true, hint: '-1 picks from the tick step' });
  addPlain(ui, y, A.y.suffix, 'suffix', ['axes', 'y', 'suffix']).element.title = 'Text after each tick value, e.g. %';
  addPlain(ui, y, A.y.title, 'title', ['axes', 'y', 'title']).element.title = 'Axis title, beside the tick labels (empty: none)';
}
