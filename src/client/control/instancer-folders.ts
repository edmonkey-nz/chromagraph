import type { BladeApi, FolderApi } from 'tweakpane';
import { budgetReadout, ridgelineCloner, visibleRowCount } from '../../shared/layer-helpers.ts';
import {
  ARRANGEMENTS,
  NUMERIC_CHANNELS,
  PRIMITIVES,
  X_MODES,
  type InstancerLayer,
  type LayerConfig,
  type NumericChannel,
} from '../../shared/layer-schema.ts';
import {
  addFitButton,
  addIdentity,
  addOpacityBlend,
  addRows,
  addTimeColumn,
  addVec3,
  buildMapping,
  buildTransform,
  colourColumns,
  fmt,
  numericColumns,
  options,
  vec3Obj,
  vec3Tuple,
  xyz,
  type LayerUi,
} from './layer-ui.ts';

/** Instancer folders: General, Layout, Look, Channels, Cloner, Transform. */

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
  buildChannels(ui, root, layer);
  buildCloner(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}

function buildGeneral(ui: LayerUi, parent: FolderApi, layer: InstancerLayer, titleOf: (l: LayerConfig) => string): void {
  const f = ui.folder(parent, 'General', 'General', true);
  addIdentity(ui, f, layer, titleOf);
  const m = { primitive: layer.primitive, xMode: layer.xMode, followRange: layer.followRange, arrangement: layer.arrangement };
  f.addBinding(m, 'primitive', { options: options(PRIMITIVES) }).on('change', (ev) => ui.set(['primitive'], ev.value));
  f.addBinding(m, 'xMode', { label: 'x mode', options: options(X_MODES) }).on('change', (ev) => ui.set(['xMode'], ev.value));
  addTimeColumn(ui, f, layer.timeColumn);
  addRows(ui, f, layer.rows);
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
