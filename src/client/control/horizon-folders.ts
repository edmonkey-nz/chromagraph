import { AGGREGATES, MAX_HORIZON_SERIES, X_MODES, type HorizonLayer, type LayerConfig } from '../../shared/layer-schema.ts';
import {
  addFitButton,
  addFontCase,
  addIdentity,
  addNumber,
  addOpacityBlend,
  addPlain,
  addTimeColumn,
  addVec3,
  buildEffects,
  buildTransform,
  columnOptions,
  fmt,
  type LayerUi,
  options,
} from './layer-ui.ts';

/** Horizon chart folders: General, Bands, Layout, Labels, Look, Transform. */
export function buildHorizon(ui: LayerUi, layer: HorizonLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;

  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf);
  const m = { xMode: layer.xMode, value: layer.valueColumn ?? '', series: layer.seriesColumn ?? '', fn: layer.fn };
  g.addBinding(m, 'xMode', { label: 'x mode', options: options(X_MODES) }).on('change', (ev) => ui.set(['xMode'], ev.value)).element.title =
    'index: rows side by side, gaps closed up. time: along the time column, so gaps in time stay visible';
  addTimeColumn(ui, g, layer.timeColumn);
  if (ui.summary) {
    const numbers = ui.summary.columns.filter((c) => c.type === 'number' && !c.empty);
    g.addBinding(m, 'value', { label: 'value', options: columnOptions(numbers, layer.valueColumn) }).on('change', (ev) =>
      ui.send([
        { path: ['valueColumn'], value: ev.value || null },
        { path: ['domain'], value: null },
      ]),
    );
    const groups = ui.summary.columns.filter((c) => c.values !== undefined && c.values.length > 0);
    const seriesOptions = [{ text: 'none (one strip)', value: '' }, ...groups.map((c) => ({ text: `${c.name} (${c.values!.length})`, value: c.name }))];
    if (layer.seriesColumn !== null && !groups.some((c) => c.name === layer.seriesColumn)) seriesOptions.push({ text: `${layer.seriesColumn} (missing)`, value: layer.seriesColumn });
    g.addBinding(m, 'series', { label: 'one strip per', options: seriesOptions }).on('change', (ev) => {
      ui.entry.forceRebuild = ui.send([{ path: ['seriesColumn'], value: ev.value || null }]);
    }).element.title = `A strip for each value of a category column, stacked down the screen (at most ${MAX_HORIZON_SERIES}). Fit to output sizes them to the frame.`;
  } else {
    g.addButton({ title: 'Waiting for data…', label: 'value', disabled: true });
  }
  g.addBinding(m, 'fn', { label: 'combine by', options: options(AGGREGATES) }).on('change', (ev) => ui.set(['fn'], ev.value)).element.title =
    'Rows are combined into one value per pixel column across the strip; missing values are left out and an empty column is a gap';

  const b = ui.folder(root, 'Bands', 'Bands', true);
  addNumber(ui, b, layer.bands, 'bands', ['bands'], { min: 1, max: 8, step: 1, integer: true, hint: 'The value range is cut into this many bands, folded on top of each other, each a brighter shade' });
  addNumber(ui, b, layer.baseline, 'baseline', ['baseline'], { field: 'baseline', hint: 'The value treated as zero: above it in the colour, below it in the negative colour (mirrored up)' });
  const d = { auto: layer.domain === null, max: layer.domain ?? 1 };
  b.addBinding(d, 'auto', { label: 'auto range' }).on('change', (ev) => {
    ui.entry.forceRebuild = ui.send([{ path: ['domain'], value: ev.value ? null : d.max }]);
  }).element.title = 'On: the full range is the largest distance from the baseline in all rows. Off: set it (values beyond it fill every band)';
  if (!d.auto) b.addBinding(d, 'max', { label: 'range', min: 0, format: fmt }).on('change', (ev) => ev.value > 0 && ui.set(['domain'], ev.value));
  addPlain(ui, b, layer.colour, 'colour', ['colour']).element.title = 'Values above the baseline';
  addPlain(ui, b, layer.negativeColour, 'negative colour', ['negativeColour']).element.title = 'Values below the baseline';

  const l = ui.folder(root, 'Layout', 'Layout', false);
  addVec3(ui, l, layer.origin, 'top-left', ['origin'], 'origin').element.title = 'Top-left corner of the first strip (px, y up)';
  const size = { w: layer.size[0], h: layer.size[1] };
  const sendSize = () => ui.set(['size'], [Math.max(1, size.w), Math.max(1, size.h)]);
  ui.mark(l.addBinding(size, 'w', { label: 'width', format: fmt }).on('change', sendSize), 'width', 'size.0');
  ui.mark(l.addBinding(size, 'h', { label: 'strip height', format: fmt }).on('change', sendSize), 'strip height', 'size.1');
  addNumber(ui, l, layer.gap, 'gap', ['gap'], { min: 0, max: 200, step: 1, hardMax: 500, field: 'gap', hint: 'px between strips' });
  addFitButton(ui, l);

  const t = ui.folder(root, 'Labels', 'Labels', false);
  const L = layer.labels;
  addPlain(ui, t, L.enabled, 'on', ['labels', 'enabled']).element.title = 'Each strip’s series name, to its left';
  addNumber(ui, t, L.size, 'size', ['labels', 'size'], { min: 6, max: 120, step: 1, hardMax: 200, hint: 'px at 1080p; 24 is the projection minimum' });
  addPlain(ui, t, L.colour, 'colour', ['labels', 'colour']);
  addFontCase(ui, t, L.font, L.uppercase, ['labels', 'font'], ['labels', 'uppercase']);

  const k = ui.folder(root, 'Look', 'Look', false);
  addOpacityBlend(ui, k, layer);
  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}
