import type { FolderApi } from 'tweakpane';
import { X_MODES, type LayerConfig, type LineLayer } from '../../shared/layer-schema.ts';
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
  numericColumns,
  options,
  type LayerUi,
} from './layer-ui.ts';

/** Line folders: General, Layout, Look, Mapping, Transform. */
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
  buildTransform(ui, root, layer.transform);
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
