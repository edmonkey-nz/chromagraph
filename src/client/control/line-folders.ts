import type { FolderApi } from 'tweakpane';
import { budgetReadout, diffChanges, lineSegmentCount, ridgelineLine } from '../../shared/layer-helpers.ts';
import { X_MODES, type LayerConfig, type LineLayer } from '../../shared/layer-schema.ts';
import {
  addChoice,
  addFitButton,
  addIdentity,
  addNumber,
  addOpacityBlend,
  addPlain,
  addRows,
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

/** Line folders: General, Layout, Look, Mapping, Cloner, Fill, Transform. */
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
  addRows(ui, g, layer.rows);
  g.addBinding(m, 'followRange', { label: 'follow range' }).on('change', (ev) => ui.set(['followRange'], ev.value));

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
  buildCloner(ui, root, layer);
  buildFill(ui, root, layer);
  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
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

/** "Fill" folder: area between the line and each clone's baseline. */
function buildFill(ui: LayerUi, parent: FolderApi, layer: LineLayer): void {
  const f = ui.folder(parent, 'Fill', 'Fill', false);
  const fill = layer.fill;
  const mode = addChoice(ui, f, fill.mode, 'mode', ['fill', 'mode'], ['none', 'below'] as const, { none: 'none', below: 'below the line' });
  mode.element.title =
    'Fill between the line and its baseline (origin y plus the clone’s offset). An opaque fill in the background colour hides the clones behind.';
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
