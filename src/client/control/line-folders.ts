import type { FolderApi } from 'tweakpane';
import { lineChartPreset } from '../../shared/chart-presets.ts';
import { buildAxesFolder } from './axes-folder.ts';
import { budgetReadout, diffChanges, lineSegmentCount, ridgelineLine } from '../../shared/layer-helpers.ts';
import { AGGREGATES, LINE_FILLS, MAX_SPLIT, seriesColour, type LayerConfig, type LineLayer, X_MODES } from '../../shared/layer-schema.ts';
import {
  addChoice,
  addFitButton,
  addIdentity,
  addNumber,
  addFontCase,
  addOpacityBlend,
  addPlain,
  addTimeColumn,
  addVec3,
  buildEffects,
  buildMapping,
  buildTransform,
  colourColumns,
  type LayerUi,
  numericColumns,
  options,
} from './layer-ui.ts';

/** Line folders: General, Aggregate, Split, Layout, Look, Mapping, Axes & values, Cloner, Fill, Transform. */
export function buildLine(ui: LayerUi, layer: LineLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;

  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf);
  const m = {
    xMode: layer.xMode,
    followRange: layer.followRange,
    width: layer.width,
    colour: layer.colour,
    breakOnGaps: layer.breakOnGaps,
    gapFactor: layer.gapFactor,
  };
  g.addBinding(m, 'xMode', { label: 'x mode', options: options(X_MODES) }).on('change', (ev) => ui.set(['xMode'], ev.value));
  addTimeColumn(ui, g, layer.timeColumn);
  g.addBinding(m, 'followRange', { label: 'follow range' }).on('change', (ev) => ui.set(['followRange'], ev.value));

  // Aggregate: one point per week / month / year / N rows, so dense data reads as a line chart.
  const a = ui.folder(root, 'Aggregate', 'Aggregate', layer.aggregate.by !== 'none');
  const am = { ...layer.aggregate };
  const by = a.addBinding(am, 'by', {
    label: 'one point per',
    options: [
      { text: 'row (no aggregation)', value: 'none' },
      { text: 'week', value: 'week' },
      { text: 'month', value: 'month' },
      { text: 'year', value: 'year' },
      { text: 'N rows', value: 'rows' },
    ],
  });
  by.element.title = 'Combine rows into one point per period, so spiky daily data reads as a line chart. Weeks, months and years need a time column.';
  const nRows = a.addBinding(am, 'rows', { label: 'N rows', min: 1, max: 5000, step: 1 });
  const fn = a.addBinding(am, 'fn', {
    label: 'combine by',
    options: AGGREGATES.map((f) => ({ text: f === 'last' ? 'last value' : f, value: f })),
  });
  const showAgg = () => {
    nRows.hidden = am.by !== 'rows';
    fn.hidden = am.by === 'none';
  };
  showAgg();
  by.on('change', (ev) => {
    showAgg();
    ui.set(['aggregate', 'by'], ev.value);
  });
  nRows.on('change', (ev) => ui.set(['aggregate', 'rows'], Math.max(1, Math.round(ev.value))));
  fn.on('change', (ev) => ui.set(['aggregate', 'fn'], ev.value));

  buildSplit(ui, root, layer);

  const l = ui.folder(root, 'Layout', 'Layout', false);
  addVec3(ui, l, layer.origin, 'origin', ['origin'], 'origin').element.title = 'Position of t = 0, and the zero of the y mapping';
  addVec3(ui, l, layer.step, 'step', ['step'], 'step').element.title = 'px per unit of t (per row, or per cadence step in time mode)';
  addFitButton(ui, l);

  const k = ui.folder(root, 'Look', 'Look', false);
  ui.mark(
    k.addBinding(m, 'width', { label: 'width (px)', min: 1, max: 40, step: 0.5 }).on('change', (ev) =>
      ui.set(['width'], Math.min(200, Math.max(1, ev.value))),
    ),
    'width (px)',
    'width',
  );
  k.addBinding(m, 'colour').on('change', (ev) => ui.set(['colour'], ev.value));
  addOpacityBlend(ui, k, layer);
  k.addBinding(m, 'breakOnGaps', { label: 'break on gaps' }).on('change', (ev) => {
    gap.hidden = !ev.value;
    ui.set(['breakOnGaps'], ev.value);
  }).element.title = 'Break the line at missing values and (time mode) across gaps longer than gap factor × the cadence step';
  const gap = k.addBinding(m, 'gapFactor', { label: 'gap factor', min: 1, max: 20, step: 0.1 });
  gap.on('change', (ev) => ui.set(['gapFactor'], Math.max(1, ev.value)));
  gap.hidden = !m.breakOnGaps;

  buildMappings(ui, root, layer);
  buildLineAxes(ui, root, layer);
  buildCloner(ui, root, layer);
  buildFill(ui, root, layer);
  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}

/** "Axes & values" for a line (shared builder in axes-folder.ts), with the Line chart preset. */
function buildLineAxes(ui: LayerUi, parent: FolderApi, layer: LineLayer): void {
  const aggregated = layer.aggregate.by !== 'none';
  buildAxesFolder(ui, parent, layer.axes, {
    preset: {
      title: 'Line chart',
      hint: 'Aggregated (monthly with a time column, else every 30 rows), each point named along the bottom, a value axis with gridlines, fitted with room for both',
      make: (current, summary) => (current.type === 'line' ? lineChartPreset(current, summary) : null),
    },
    xTitle: 'x axis',
    xNone: aggregated ? (layer.aggregate.by === 'month' || layer.aggregate.by === 'year' ? '(the period)' : '(the middle row’s date or rows)') : layer.timeColumn ? '(the date)' : '(row number)',
    xHint: 'A baseline under the line and a label per point (thinned so labels never overlap)',
    everyHint: aggregated ? 'Label every N-th point (period); labels are thinned further if they would overlap' : 'Label every N-th point; labels are thinned further if they would overlap',
    valuesHint: aggregated ? 'Each point’s combined value as text at it' : 'Each point’s value as text at it',
    valuesColumnHint: aggregated ? 'Aggregated lines always show the combined value' : 'What the labels say: the y value, or any other column',
    xNote: null,
    yNote:
      layer.y.column === null
        ? 'Map y in Mapping to get a value axis.'
        : layer.split.column !== null && layer.split.stack === 'stream'
          ? 'A streamgraph has no value axis: only the thickness of each slice means anything.'
          : null,
    valuesNote: layer.y.column === null ? 'Map y in Mapping first.' : null,
  });
}

const DATA_STEP_HINT =
  'Clone k keeps row i’s x position but takes its values (y, z, colour) from row i + k × data step, ' +
  'so stacked clones show later stretches of the data: ridgelines. 0 repeats the same rows.';

const RIDGELINE_HINT =
  '40 clones 14 px apart, no fade, each showing the data a year later (365 rows for a daily time column, ' +
  'otherwise 1/40 of the visible rows), over the first year’s rows; filled below in the background colour, ' +
  '2 px white, refitted to the frame (Joy Division style).';

/**
 * "Cloner" folder for a line: the whole line drawn `count` times, each clone offset, orbited
 * and faded per clone (per-clone rotation and scale don't apply to lines), with a live
 * "segments × count" readout against the frame budget and the Ridgeline preset.
 */
function buildCloner(ui: LayerUi, parent: FolderApi, layer: LineLayer): void {
  const f = ui.folder(parent, 'Cloner', 'Cloner', false);
  const c = layer.cloner;
  const m = { count: c.count, readout: '' };
  ui.mark(
    f.addBinding(m, 'count', { label: 'count', min: 1, max: 200, step: 1 }).on('change', (ev) => {
      ui.set(['cloner', 'count'], Math.min(1000, Math.max(1, Math.round(ev.value))));
      refresh(Math.round(ev.value));
    }),
    'count',
    'cloner.count',
  ).element.title = 'Copies of the whole line (1 = no cloning). Instances drawn = segments × count.';
  addVec3(ui, f, c.position, 'position step', ['cloner', 'position'], 'cloner.position').element.title = 'px added per clone';
  addVec3(ui, f, c.orbit, 'orbit step', ['cloner', 'orbit'], 'cloner.orbit').element.title =
    'degrees each clone turns about the layer pivot, per clone';
  addNumber(ui, f, c.fade, 'fade', ['cloner', 'fade'], { min: 0, max: 1, step: 0.001, field: 'cloner.fade', hint: 'Opacity multiplier per clone (clone k opacity × fade^k)' });
  addNumber(ui, f, c.dataStep, 'data step', ['cloner', 'dataStep'], {
    min: -100_000,
    max: 100_000,
    integer: true,
    field: 'cloner.dataStep',
    hint: DATA_STEP_HINT,
  });
  addPlain(ui, f, c.colourByClone, 'colour by clone', ['cloner', 'colourByClone']).element.title =
    'Colour clones along the colour mapping’s ramp by clone index instead of by data';

  f.addButton({ title: 'Ridgeline', label: 'preset' })
    .on('click', () => {
      const cur = ui.entry.layer;
      if (cur.type !== 'line') return;
      const background = (ui.getDoc() ?? ui.doc).project.output.background;
      ui.entry.forceRebuild = ui.send(diffChanges(cur, ridgelineLine(cur, ui.summary, background)));
    })
    .element.title = RIDGELINE_HINT;
  f.addButton({ title: 'No cloning', label: '' }).on('click', () => {
    ui.entry.forceRebuild = ui.send([{ path: ['cloner', 'count'], value: 1 }]);
  });

  const readout = f.addBinding(m, 'readout', { label: 'budget', readonly: true, multiline: true, rows: 2, interval: 0 });
  const refresh = (count?: number) => {
    const l = ui.entry.layer;
    if (l.type !== 'line') return;
    const segments = lineSegmentCount(ui.summary?.rowCount ?? 0, l.rows);
    const n = count ?? l.cloner.count;
    // Total across layers from the synced doc, with this layer's own count swapped for the live one.
    const own = l.enabled ? segments * l.cloner.count : 0;
    const total = ui.instanceTotal() - own + segments * n;
    const text = ui.summary ? budgetReadout(segments, n, total, 'segments') : 'instances: waiting for data…';
    if (text !== m.readout) {
      m.readout = text;
      readout.refresh();
    }
  };
  ui.entry.refreshReadout = () => refresh();
  refresh();
}

/**
 * "Split" folder: one line per value of a category or text column (e.g. Male / Female), each
 * in its own colour, with an optional name label at the end of each line.
 */
function buildSplit(ui: LayerUi, parent: FolderApi, layer: LineLayer): void {
  const split = layer.split;
  const f = ui.folder(parent, 'Split', 'Split', split.column !== null);
  if (!ui.summary) {
    f.addButton({ title: 'Waiting for data…', disabled: true });
    return;
  }
  const choices = ui.summary.columns.filter((c) => c.values !== undefined && c.values.length > 0);
  const m = { column: split.column ?? '' };
  const options = [{ text: 'none (one line)', value: '' }, ...choices.map((c) => ({ text: `${c.name} (${c.values!.length})`, value: c.name }))];
  if (split.column !== null && !choices.some((c) => c.name === split.column)) options.push({ text: `${split.column} (missing)`, value: split.column });
  f.addBinding(m, 'column', { label: 'one line per', options }).on('change', (ev) => {
    ui.entry.forceRebuild = ui.send([{ path: ['split', 'column'], value: ev.value === '' ? null : ev.value }]);
  }).element.title = `Draw one line for each value of a category column, on shared axes (at most ${MAX_SPLIT}). Filter first to leave some out.`;
  const column = choices.find((c) => c.name === split.column);
  if (!column) return;
  const st = { stack: split.stack };
  f.addBinding(st, 'stack', {
    label: 'stack',
    options: [
      { text: 'no (lines on shared axes)', value: 'none' },
      { text: 'stacked area', value: 'stack' },
      { text: 'streamgraph (centred)', value: 'stream' },
    ],
  }).on('change', (ev) => {
    ui.entry.forceRebuild = ui.send([{ path: ['split', 'stack'], value: ev.value }]);
  }).element.title =
    'Stacked area: each series filled from the one below to its own top, in order. Streamgraph: the same pile centred on the baseline. Points stack only where every series has a value at the same time; elsewhere the pile breaks. Value labels show the top of each slice.';

  const values = column.values!;
  if (values.length > MAX_SPLIT) {
    f.addButton({ title: `${values.length} values: filter to ${MAX_SPLIT} or fewer`, label: '', disabled: true });
  }
  values.slice(0, MAX_SPLIT).forEach((value, i) => {
    const c = { v: seriesColour(split, value, i) };
    f.addBinding(c, 'v', { label: value === '' ? '(blank)' : value }).on('change', (ev) => ui.set(['split', 'colours', value], ev.value));
  });
  f.addButton({ title: 'Default colours', label: '' }).on('click', () => {
    ui.entry.forceRebuild = ui.send([{ path: ['split', 'colours'], value: {} }]);
  });

  const L = split.labels;
  addPlain(ui, f, L.enabled, 'labels', ['split', 'labels', 'enabled']).element.title = 'Name each line at its last visible point, in its colour';
  addNumber(ui, f, L.size, 'label size', ['split', 'labels', 'size'], { min: 6, max: 200, step: 1 });
  addNumber(ui, f, L.gap, 'label gap', ['split', 'labels', 'gap'], { min: -200, max: 200, step: 1, hint: 'px from the end of the line' });
  addFontCase(ui, f, L.font, L.uppercase, ['split', 'labels', 'font'], ['split', 'labels', 'uppercase']);
}

const FILL_TITLES = { none: 'none', below: 'below the line', band: 'min–max band (aggregated)' } as const;

/** "Fill" folder: area between the line and each clone's baseline, or the min-max band. */
function buildFill(ui: LayerUi, parent: FolderApi, layer: LineLayer): void {
  const f = ui.folder(parent, 'Fill', 'Fill', false);
  const fill = layer.fill;
  const mode = addChoice(ui, f, fill.mode, 'mode', ['fill', 'mode'], LINE_FILLS, FILL_TITLES);
  mode.element.title =
    'Below: fill between the line and its baseline (origin y plus the clone’s offset); an opaque fill in the background colour hides the clones behind. ' +
    'Band: with aggregation on, a shaded area from each period’s lowest to highest value, so averaging doesn’t hide the extremes (split lines use their own colours).';
  if (fill.mode === 'band' && (layer.aggregate.by === 'none' || layer.y.column === null)) {
    f.addButton({ title: 'Band needs aggregation and a y column', label: '', disabled: true });
  }
  const colour = addPlain(ui, f, fill.colour, 'colour', ['fill', 'colour']);
  const opacity = addNumber(ui, f, fill.opacity, 'opacity', ['fill', 'opacity'], { min: 0, max: 1, step: 0.01, field: 'fill.opacity' });
  const show = (m: string) => {
    colour.hidden = m === 'none';
    opacity.hidden = m === 'none';
  };
  mode.on('change', (ev) => show(ev.value));
  f.addButton({ title: 'Use background colour', label: '' }).on('click', () => {
    const background = (ui.getDoc() ?? ui.doc).project.output.background;
    ui.entry.forceRebuild = ui.send([{ path: ['fill', 'colour'], value: background }]);
  });
  show(fill.mode);
}

function buildMappings(ui: LayerUi, root: FolderApi, layer: LineLayer): void {
  const f = ui.folder(root, 'Mapping', 'Mapping', false);
  if (!ui.summary) {
    f.addButton({ title: 'Waiting for data…', disabled: true });
    return;
  }
  const numeric = numericColumns(ui.summary);
  buildMapping(ui, f, 'y offset', 'Mapping/y', ['y'], layer.y, numeric);
  buildMapping(ui, f, 'z offset', 'Mapping/z', ['z'], layer.z, numeric);
  buildMapping(ui, f, 'colour', 'Mapping/colour', ['colourMap'], layer.colourMap, colourColumns(ui.summary));
}
