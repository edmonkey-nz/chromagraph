import type { BladeApi, FolderApi } from 'tweakpane';
import { barChartPreset } from '../../shared/chart-presets.ts';
import { budgetReadout, diffChanges, edgePreset, ridgelineCloner, visibleRowCount } from '../../shared/layer-helpers.ts';
import {
  ARRANGEMENTS,
  AXIS_SIDES,
  VALUE_LABEL_PLACES,
  LABEL_ORIENTATIONS,
  NUMERIC_CHANNELS,
  PRIMITIVES,
  X_MODES,
  type InstancerLayer,
  type LayerConfig,
  type NumericChannel,
} from '../../shared/layer-schema.ts';
import {
  addChoice,
  addFitButton,
  addFontCase,
  addNumber,
  addPlain,
  addIdentity,
  addOpacityBlend,
  addTimeColumn,
  addVec3,
  buildEffects,
  buildMapping,
  buildTransform,
  colourColumns,
  fmt,
  type LayerUi,
  numericColumns,
  options,
  vec3Obj,
  vec3Tuple,
  xyz,
} from './layer-ui.ts';

/** Instancer folders: General, Layout, Look, Edges, Channels, Cloner, Labels, Axes & values, Glow, Trails, Transform. */

const CHANNEL_TITLES: Record<NumericChannel | 'colour', string> = {
  y: 'y offset',
  z: 'z offset',
  height: 'height',
  size: 'size',
  rotation: 'rotation',
  opacity: 'opacity',
  colour: 'colour',
};

export function buildInstancer(ui: LayerUi, layer: InstancerLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  buildGeneral(ui, root, layer, titleOf);
  buildLayout(ui, root, layer);
  buildLook(ui, root, layer);
  buildEdges(ui, root, layer);
  buildChannels(ui, root, layer);
  buildCloner(ui, root, layer);
  buildLabels(ui, root, layer);
  buildAxes(ui, root, layer);
  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}

function buildGeneral(ui: LayerUi, parent: FolderApi, layer: InstancerLayer, titleOf: (l: LayerConfig) => string): void {
  const f = ui.folder(parent, 'General', 'General', true);
  addIdentity(ui, f, layer, titleOf);
  const m = { primitive: layer.primitive, xMode: layer.xMode, followRange: layer.followRange, arrangement: layer.arrangement };
  f.addBinding(m, 'primitive', { options: options(PRIMITIVES) }).on('change', (ev) => ui.set(['primitive'], ev.value));
  f.addBinding(m, 'xMode', { label: 'x mode', options: options(X_MODES) }).on('change', (ev) => ui.set(['xMode'], ev.value));
  addTimeColumn(ui, f, layer.timeColumn);
  f.addBinding(m, 'followRange', { label: 'follow range' }).on('change', (ev) => ui.set(['followRange'], ev.value));
  f.addBinding(m, 'arrangement', { options: options(ARRANGEMENTS) }).on('change', (ev) => ui.set(['arrangement'], ev.value));
}

function buildLayout(ui: LayerUi, parent: FolderApi, layer: InstancerLayer): void {
  const f = ui.folder(parent, 'Layout', 'Layout', false);
  const m = {
    gridColumns: layer.gridColumns,
    cellW: layer.cell[0],
    cellH: layer.cell[1],
    radius: layer.radius,
    angleStep: layer.angleStep,
    radiusStep: layer.radiusStep,
  };
  const a = layer.arrangement;
  const radial = a === 'radial' || a === 'spiral';
  const cells = a === 'grid' || a === 'calendar';

  addVec3(ui, f, layer.origin, radial ? 'centre' : cells ? 'top-left' : 'origin', ['origin'], 'origin');
  const bindings: { api: BladeApi; show: boolean }[] = [];
  const add = (api: BladeApi, show: boolean) => bindings.push({ api, show });

  add(addVec3(ui, f, layer.step, 'step', ['step'], 'step'), a === 'linear');
  add(
    ui.mark(
      f.addBinding(m, 'gridColumns', { label: 'grid columns', min: 1, step: 1 }).on('change', (ev) =>
        ui.set(['gridColumns'], Math.max(1, Math.round(ev.value))),
      ),
      'grid columns',
      'gridColumns',
    ),
    a === 'grid',
  );
  const sendCell = () => ui.set(['cell'], [m.cellW, m.cellH]);
  add(ui.mark(f.addBinding(m, 'cellW', { label: 'cell w', format: fmt }).on('change', sendCell), 'cell w', 'cell.0'), cells);
  add(ui.mark(f.addBinding(m, 'cellH', { label: 'cell h', format: fmt }).on('change', sendCell), 'cell h', 'cell.1'), cells);
  add(ui.mark(f.addBinding(m, 'radius', { label: 'radius', format: fmt }).on('change', (ev) => ui.set(['radius'], ev.value)), 'radius', 'radius'), radial);
  add(
    ui.mark(f.addBinding(m, 'angleStep', { label: 'angle step', format: fmt }).on('change', (ev) => ui.set(['angleStep'], ev.value)), 'angle step', 'angleStep'),
    radial,
  );
  add(
    ui.mark(
      f.addBinding(m, 'radiusStep', { label: 'radius step', format: fmt }).on('change', (ev) => ui.set(['radiusStep'], ev.value)),
      'radius step',
      'radiusStep',
    ),
    a === 'spiral',
  );
  for (const b of bindings) b.api.hidden = !b.show;
  addFitButton(ui, f);
}

function buildLook(ui: LayerUi, parent: FolderApi, layer: InstancerLayer): void {
  const f = ui.folder(parent, 'Look', 'Look', false);
  const m = { heightAxis: layer.heightAxis, colour: layer.colour };
  ui.mark(
    f.addBinding({ size: vec3Obj(layer.size) }, 'size', { label: 'size', format: fmt }).on('change', (ev) => ui.set(['size'], vec3Tuple(ev.value))),
    'size',
    ...xyz('size'),
  );
  f.addBinding(m, 'heightAxis', {
    label: 'height along',
    options: { 'y (up the frame)': 'y', 'z (out of the frame)': 'z' },
  }).on('change', (ev) => ui.set(['heightAxis'], ev.value));
  f.addBinding(m, 'colour').on('change', (ev) => ui.set(['colour'], ev.value));
  addOpacityBlend(ui, f, layer);
}

/**
 * "Edges": outlined 3D boxes (box primitive only; other primitives show a hint). Width is in
 * screen px at any distance; face opacity 0 leaves the outlines alone; edge glow brightens the
 * edges for the layer's glow to spread (the Neon preset switches that glow on too).
 */
function buildEdges(ui: LayerUi, parent: FolderApi, layer: InstancerLayer): void {
  const E = layer.edges;
  const f = ui.folder(parent, 'Edges', 'Edges', E.enabled && layer.primitive === 'box');
  if (layer.primitive !== 'box') {
    f.addBlade({ view: 'text', label: '', parse: (v: string) => v, value: 'Edges are for the box primitive (General).', disabled: true });
    return;
  }
  const m = { ...E };
  f.addBinding(m, 'enabled', { label: 'on' }).on('change', (ev) => ui.set(['edges', 'enabled'], ev.value));
  f.addBinding(m, 'colour').on('change', (ev) => ui.set(['edges', 'colour'], ev.value));
  ui.mark(
    f.addBinding(m, 'width', { label: 'width (px)', min: 0.5, max: 20, step: 0.5 }).on('change', (ev) => ui.set(['edges', 'width'], Math.min(20, Math.max(0.5, ev.value)))),
    'width (px)',
    'edges.width',
  ).element.title = 'Screen px, the same at any distance; 2 px is the projection minimum';
  ui.mark(
    f.addBinding(m, 'faceOpacity', { label: 'face opacity', min: 0, max: 1, step: 0.01 }).on('change', (ev) => ui.set(['edges', 'faceOpacity'], ev.value)),
    'face opacity',
    'edges.faceOpacity',
  ).element.title = 'The box faces under the edges: 1 = solid, 0 = outlines only (the boxes become see-through)';
  ui.mark(
    f.addBinding(m, 'glow', { label: 'edge glow', min: 0, max: 1, step: 0.01 }).on('change', (ev) => ui.set(['edges', 'glow'], ev.value)),
    'edge glow',
    'edges.glow',
  ).element.title = 'Brightens the edges towards white with a soft halo; switch on the layer’s Glow to make them bloom (neon)';
  const preset = (which: 'outline' | 'neon') => {
    const current = ui.entry.layer;
    if (current.type === 'instancer') ui.entry.forceRebuild = ui.send(diffChanges(current, edgePreset(current, which)));
  };
  f.addButton({ title: 'Red outline', label: 'preset' }).on('click', () => preset('outline')).element.title =
    'Dark solid boxes with 2 px red edges';
  f.addButton({ title: 'Neon', label: '' }).on('click', () => preset('neon')).element.title =
    'Glassy blue boxes with glowing 3 px cyan edges; switches the layer’s Glow on';
}

function buildChannels(ui: LayerUi, parent: FolderApi, layer: InstancerLayer): void {
  const f = ui.folder(parent, 'Channels', 'Channels', false);
  if (!ui.summary) {
    f.addButton({ title: 'Waiting for data…', disabled: true });
    return;
  }
  const numeric = numericColumns(ui.summary);
  for (const ch of NUMERIC_CHANNELS) buildMapping(ui, f, CHANNEL_TITLES[ch], `Channels/${ch}`, ['channels', ch], layer.channels[ch], numeric);
  buildMapping(ui, f, CHANNEL_TITLES.colour, 'Channels/colour', ['channels', 'colour'], layer.channels.colour, colourColumns(ui.summary));
}

const DATA_STEP_HINT =
  'Clone k keeps row i’s arranged position but takes its mapped values (height, colour…) from row i + k × data step, ' +
  'so stacked clones show later stretches of the data: waterfall and ridgeline plots. 0 repeats the same row.';

/**
 * "Labels": text at points of the arrangement (years, decades, or every N rows with their
 * date or a column's value), following the layer's layout. See InstancerLabelsSchema.
 */
function buildLabels(ui: LayerUi, parent: FolderApi, layer: InstancerLayer): void {
  const L = layer.labels;
  const f = ui.folder(parent, 'Labels', 'Labels', L.enabled);
  const m = { ...L, column: L.column ?? '' };
  const columns = ui.summary?.columns.filter((c) => !c.empty) ?? [];
  f.addBinding(m, 'enabled', { label: 'on' }).on('change', (ev) => ui.set(['labels', 'enabled'], ev.value));
  const every = f.addBinding(m, 'every', {
    label: 'label every',
    options: [
      { text: 'year', value: 'year' },
      { text: 'decade', value: 'decade' },
      { text: 'N rows', value: 'rows' },
    ],
  });
  const rows = f.addBinding(m, 'rows', { label: 'N rows', min: 1, max: 10000, step: 1 });
  const text = f.addBinding(m, 'text', {
    options: [
      { text: 'date', value: 'date' },
      { text: 'column value', value: 'value' },
    ],
  });
  const column = f.addBinding(m, 'column', {
    label: 'column',
    options: [{ text: '(choose)', value: '' }, ...columns.map((c) => ({ text: c.name, value: c.name }))],
  });
  const note = f.addBlade({ view: 'text', label: '', parse: (v: string) => v, value: 'Years and decades need a time column (General).', disabled: true });
  const show = () => {
    const byRows = m.every === 'rows';
    rows.hidden = !byRows;
    text.hidden = !byRows;
    column.hidden = !byRows || m.text !== 'value';
    note.hidden = byRows || layer.timeColumn !== null;
  };
  every.on('change', (ev) => {
    show();
    ui.set(['labels', 'every'], ev.value);
  });
  rows.on('change', (ev) => ui.set(['labels', 'rows'], Math.max(1, Math.round(ev.value))));
  text.on('change', (ev) => {
    show();
    ui.set(['labels', 'text'], ev.value);
  });
  column.on('change', (ev) => ui.set(['labels', 'column'], ev.value === '' ? null : ev.value));
  show();
  ui.mark(
    f.addBinding(m, 'size', { label: 'size', min: 6, max: 200, step: 1 }).on('change', (ev) => ui.set(['labels', 'size'], ev.value)),
    'size',
    'labels.size',
  );
  ui.mark(
    f.addBinding(m, 'offset', { label: 'offset', min: -200, max: 200, step: 1 }).on('change', (ev) => ui.set(['labels', 'offset'], ev.value)),
    'offset',
    'labels.offset',
  ).element.title = 'Distance from the points: outward on a ring or spiral, up from a line, left of a grid or calendar row';
  f.addBinding(m, 'orientation', {
    options: LABEL_ORIENTATIONS.map((o) => ({ text: o === 'along' ? 'along the layout' : o === 'outward' ? 'outward (rings, spirals)' : 'upright', value: o })),
  }).on('change', (ev) => ui.set(['labels', 'orientation'], ev.value));
  f.addBinding(m, 'colour').on('change', (ev) => ui.set(['labels', 'colour'], ev.value));
  addFontCase(ui, f, L.font, L.uppercase, ['labels', 'font'], ['labels', 'uppercase']);
  f.addBinding(m, 'hidePoints', { label: 'hide points' }).on('change', (ev) => ui.set(['labels', 'hidePoints'], ev.value)).element.title =
    'Draw only the labels (for a labels-only copy of a layer)';
}

/** A read-only note line in a folder. */
function note(f: FolderApi, text: string): BladeApi {
  return f.addBlade({ view: 'text', label: '', parse: (v: string) => v, value: text, disabled: true });
}

/**
 * "Axes & values": value labels at the marks, and for a linear arrangement a category axis
 * and a value axis (InstancerAxesSchema, laid out by data/instance-axes.ts), plus the Bar chart
 * preset that sets up all three on a zero-based height.
 */
function buildAxes(ui: LayerUi, parent: FolderApi, layer: InstancerLayer): void {
  const A = layer.axes;
  const f = ui.folder(parent, 'Axes & values', 'Axes', A.values.enabled || A.x.enabled || A.y.enabled);
  const columns = ui.summary?.columns.filter((c) => !c.empty) ?? [];
  const columnList = (none: string) => [{ text: none, value: '' }, ...columns.map((c) => ({ text: c.name, value: c.name }))];
  const linear = layer.arrangement === 'linear';
  const valued = layer.channels.height.column !== null || layer.channels.y.column !== null;

  f.addButton({ title: ui.canFit ? 'Bar chart' : 'Bar chart (waiting for data)', label: 'preset', disabled: !ui.canFit }).on('click', () => {
    const current = ui.entry.layer;
    const doc = ui.getDoc();
    const dataset = doc?.project.datasets.find((d) => d.id === current.datasetId);
    if (current.type !== 'instancer' || !ui.summary || !dataset) return;
    ui.entry.forceRebuild = ui.send(diffChanges(current, barChartPreset(current, ui.summary, dataset.timeZone)));
  }).element.title =
    'Bars in a line with heights from zero (proportional to the values), room for the axes, value labels on top, the rows named along the bottom and a value axis with gridlines';
  addPlain(ui, f, A.colour, 'line colour', ['axes', 'colour']).element.title = 'Colour of the axis lines, ticks and gridlines';
  addNumber(ui, f, A.lineWidth, 'line width', ['axes', 'lineWidth'], { min: 1, max: 8, step: 0.5, hardMax: 20, hint: 'px; 2 is the projection minimum' });
  addFontCase(ui, f, A.font, A.uppercase, ['axes', 'font'], ['axes', 'uppercase']);

  // ---- value labels ----
  const v = ui.folder(f, 'Value labels', 'Axes/values', A.values.enabled);
  addPlain(ui, v, A.values.enabled, 'on', ['axes', 'values', 'enabled']).element.title = 'Each row’s value as text at its mark';
  const vm = { column: A.values.column ?? '' };
  v.addBinding(vm, 'column', { label: 'column', options: columnList('(the mapped value)') }).on('change', (ev) =>
    ui.set(['axes', 'values', 'column'], ev.value === '' ? null : ev.value),
  ).element.title = 'What the labels say: the column the height (or y) is mapped from, or any other column';
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
  if (!valued && A.values.column === null) note(v, 'Map height (or y) in Channels, or choose a column.');

  // ---- category axis ----
  const x = ui.folder(f, 'Category axis', 'Axes/x', A.x.enabled);
  if (!linear) note(x, 'Axes need the linear arrangement (Layout).');
  addPlain(ui, x, A.x.enabled, 'on', ['axes', 'x', 'enabled']).element.title = 'A baseline under the marks and a label for each row';
  addPlain(ui, x, A.x.line, 'baseline', ['axes', 'x', 'line']);
  const xm = { column: A.x.column ?? '' };
  x.addBinding(xm, 'column', { label: 'labels', options: columnList(layer.timeColumn ? '(the date)' : '(row number)') }).on('change', (ev) =>
    ui.set(['axes', 'x', 'column'], ev.value === '' ? null : ev.value),
  ).element.title = 'The column that names each row, e.g. Quarter';
  addNumber(ui, x, A.x.every, 'every', ['axes', 'x', 'every'], { min: 1, max: 100, step: 1, hardMax: 1_000_000, integer: true, hint: 'Label every N-th row (rows whose number is a multiple of N)' });
  addNumber(ui, x, A.x.size, 'size', ['axes', 'x', 'size'], { min: 6, max: 120, step: 1, hardMax: 200, hint: 'px at 1080p; 24 is the projection minimum' });
  addPlain(ui, x, A.x.colour, 'colour', ['axes', 'x', 'colour']);
  addNumber(ui, x, A.x.angle, 'angle', ['axes', 'x', 'angle'], { min: -90, max: 90, step: 15, hint: 'Turn the labels (degrees) so long or many labels fit' });
  addNumber(ui, x, A.x.gap, 'gap', ['axes', 'x', 'gap'], { min: 0, max: 100, step: 1, hardMax: 200, hint: 'px below the baseline' });
  addPlain(ui, x, A.x.title, 'title', ['axes', 'x', 'title']).element.title = 'Axis title, centred below the labels (empty: none)';

  // ---- value axis ----
  const y = ui.folder(f, 'Value axis', 'Axes/y', A.y.enabled);
  if (!linear) note(y, 'Axes need the linear arrangement (Layout).');
  else if (!valued) note(y, 'Map height (or y) in Channels to get a value axis.');
  addPlain(ui, y, A.y.enabled, 'on', ['axes', 'y', 'enabled']).element.title = 'Ticks in the units of the mapped column, beside the marks';
  addPlain(ui, y, A.y.line, 'axis line', ['axes', 'y', 'line']);
  addNumber(ui, y, A.y.ticks, 'ticks', ['axes', 'y', 'ticks'], { min: 2, max: 20, step: 1, integer: true, hint: 'About how many round values to mark' });
  addPlain(ui, y, A.y.grid, 'gridlines', ['axes', 'y', 'grid']).element.title = 'A line across the marks at each tick';
  addNumber(ui, y, A.y.gridOpacity, 'grid opacity', ['axes', 'y', 'gridOpacity'], { min: 0, max: 1, step: 0.05 });
  addChoice(ui, y, A.y.side, 'side', ['axes', 'y', 'side'], AXIS_SIDES);
  addNumber(ui, y, A.y.size, 'size', ['axes', 'y', 'size'], { min: 6, max: 120, step: 1, hardMax: 200, hint: 'px at 1080p; 24 is the projection minimum' });
  addPlain(ui, y, A.y.colour, 'colour', ['axes', 'y', 'colour']);
  addNumber(ui, y, A.y.decimals, 'decimals', ['axes', 'y', 'decimals'], { min: -1, max: 6, step: 1, hardMax: 10, integer: true, hint: '-1 picks from the tick step' });
  addPlain(ui, y, A.y.suffix, 'suffix', ['axes', 'y', 'suffix']).element.title = 'Text after each tick value, e.g. %';
  addPlain(ui, y, A.y.title, 'title', ['axes', 'y', 'title']).element.title = 'Axis title, beside the tick labels (empty: none)';
}

/**
 * "Cloner" folder: every row drawn `count` times, each clone stepped by the offsets below,
 * with a live "visible rows × count" readout against the frame budget and a Ridgeline preset.
 */
function buildCloner(ui: LayerUi, parent: FolderApi, layer: InstancerLayer): void {
  const f = ui.folder(parent, 'Cloner', 'Cloner', false);
  const c = layer.cloner;
  const m = { count: c.count, fade: c.fade, dataStep: c.dataStep, colourByClone: c.colourByClone, readout: '' };
  const countApi = ui.mark(
    f.addBinding(m, 'count', { label: 'count', min: 1, max: 200, step: 1 }).on('change', (ev) => {
      ui.set(['cloner', 'count'], Math.min(1000, Math.max(1, Math.round(ev.value))));
      refresh(Math.round(ev.value));
    }),
    'count',
    'cloner.count',
  );
  countApi.element.title = 'Copies of every data point (1 = no cloning). Instances drawn = visible rows × count.';
  const steps = [
    { key: 'position', label: 'position step', title: 'px added per clone' },
    { key: 'rotation', label: 'rotation step', title: 'degrees added to each clone’s own rotation, per clone' },
    { key: 'scale', label: 'scale step', title: 'added to 1 per clone and axis (clone k scale = 1 + k × step)' },
    { key: 'orbit', label: 'orbit step', title: 'degrees each clone’s position turns about the layer pivot, per clone' },
  ] as const;
  for (const s of steps) {
    const api = addVec3(ui, f, c[s.key], s.label, ['cloner', s.key], `cloner.${s.key}`);
    api.element.title = s.title;
  }
  ui.mark(
    f.addBinding(m, 'fade', { label: 'fade', min: 0, max: 1, step: 0.001 }).on('change', (ev) => ui.set(['cloner', 'fade'], ev.value)),
    'fade',
    'cloner.fade',
  ).element.title = 'Opacity multiplier per clone (clone k opacity × fade^k)';
  const dataStepApi = ui.mark(
    f.addBinding(m, 'dataStep', { label: 'data step', step: 1, min: -100_000, max: 100_000 }).on('change', (ev) =>
      ui.set(['cloner', 'dataStep'], Math.round(ev.value)),
    ),
    'data step',
    'cloner.dataStep',
  );
  dataStepApi.element.title = DATA_STEP_HINT;
  f.addBinding(m, 'colourByClone', { label: 'colour by clone' })
    .on('change', (ev) => ui.set(['cloner', 'colourByClone'], ev.value))
    .element.title = 'Colour clones along the ramp by clone index instead of by data';

  f.addButton({ title: 'Ridgeline', label: 'preset' })
    .on('click', () => {
      const r = ridgelineCloner(ui.entry.layer as InstancerLayer, ui.summary);
      ui.entry.forceRebuild = ui.send(Object.entries(r).map(([k, v]) => ({ path: ['cloner', k], value: v })));
    })
    .element.title = '40 clones 12 px apart, fading 0.98 each; each clone shows the data a year later (365 rows for a daily time column, otherwise 1/40 of the visible rows). Watch the instance budget below.';
  f.addButton({ title: 'No cloning', label: '' }).on('click', () => {
    ui.entry.forceRebuild = ui.send([{ path: ['cloner', 'count'], value: 1 }]);
  });

  const readout = f.addBinding(m, 'readout', { label: 'budget', readonly: true, multiline: true, rows: 2, interval: 0 });
  const refresh = (count?: number) => {
    const l = ui.entry.layer;
    if (l.type !== 'instancer') return;
    const rowCount = ui.summary?.rowCount ?? 0;
    const rows = visibleRowCount(rowCount, l.rows);
    const n = count ?? l.cloner.count;
    // Total across layers from the synced doc, with this layer's own count swapped for the live one.
    const total = ui.instanceTotal() - rows * l.cloner.count + rows * n;
    const text = ui.summary ? budgetReadout(rows, n, total) : 'instances: waiting for data…';
    if (text !== m.readout) {
      m.readout = text;
      readout.refresh();
    }
  };
  ui.entry.refreshReadout = () => refresh();
  refresh();
}
