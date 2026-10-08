import { AGGREGATES, COLOUR_RAMPS, HEATMAP_LAYOUTS, SCALE_TYPES, type HeatmapLayer, type LayerConfig } from '../../shared/layer-schema.ts';
import type { LayerChange } from '../../shared/layer-helpers.ts';
import {
  addFitButton,
  addIdentity,
  addOpacityBlend,
  addRows,
  addTimeColumn,
  addVec3,
  buildEffects,
  buildTransform,
  columnOptions,
  fmt,
  initialDomain,
  type LayerUi,
  numericColumns,
  options,
} from './layer-ui.ts';

const LAYOUT_TITLES = { calendar: 'calendar (year × day)', grid: 'grid (row order)' } as const;

/** Heat map folders: General, Layout, Colour, Look, Transform. */
export function buildHeatmap(ui: LayerUi, layer: HeatmapLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const calendar = layer.layout === 'calendar';
  const numeric = ui.summary ? numericColumns(ui.summary) : [];
  const colOf = (name: string) => numeric.find((c) => c.name === name);

  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf);
  const m = {
    layout: layer.layout,
    valueColumn: layer.valueColumn ?? '',
    gridColumns: layer.gridColumns,
    cellW: layer.cell[0],
    cellH: layer.cell[1],
    scale: layer.scale,
    auto: layer.domain === null,
    domainMin: 0,
    domainMax: 1,
    ramp: layer.ramp,
    reverse: layer.reverse,
    steps: layer.steps,
    aggregate: layer.aggregate,
    missing: layer.missing,
    missingColour: layer.missingColour,
  };
  [m.domainMin, m.domainMax] = layer.domain ?? initialDomain(layer.valueColumn === null ? undefined : colOf(layer.valueColumn));

  g.addBinding(m, 'layout', { options: HEATMAP_LAYOUTS.map((v) => ({ text: LAYOUT_TITLES[v], value: v })) }).on('change', (ev) =>
    ui.set(['layout'], ev.value),
  );
  addTimeColumn(ui, g, layer.timeColumn).hidden = !calendar;
  if (ui.summary) {
    g.addBinding(m, 'valueColumn', { label: 'value', options: columnOptions(numeric, layer.valueColumn) }).on('change', (ev) => {
      const changes: LayerChange[] = [{ path: ['valueColumn'], value: ev.value || null }];
      if (!m.auto) {
        resetDomain();
        changes.push({ path: ['domain'], value: [m.domainMin, m.domainMax] });
      }
      ui.send(changes);
    });
  } else {
    g.addButton({ title: 'Waiting for data…', label: 'value', disabled: true });
  }
  addRows(ui, g, layer.rows);

  const l = ui.folder(root, 'Layout', 'Layout', false);
  addVec3(ui, l, layer.origin, 'top-left', ['origin'], 'origin').element.title = 'Top-left corner of the map (px, y up)';
  const sendCell = () => ui.set(['cell'], [m.cellW, m.cellH]);
  ui.mark(l.addBinding(m, 'cellW', { label: 'cell w', format: fmt }).on('change', sendCell), 'cell w', 'cell.0');
  ui.mark(l.addBinding(m, 'cellH', { label: 'cell h', format: fmt }).on('change', sendCell), 'cell h', 'cell.1');
  ui.mark(
    l.addBinding(m, 'gridColumns', { label: 'grid columns', min: 1, step: 1 }).on('change', (ev) => ui.set(['gridColumns'], Math.max(1, Math.round(ev.value)))),
    'grid columns',
    'gridColumns',
  ).hidden = calendar;
  addFitButton(ui, l);

  const c = ui.folder(root, 'Colour', 'Colour', true);
  c.addBinding(m, 'scale', { options: options(SCALE_TYPES) }).on('change', (ev) => {
    steps.hidden = ev.value !== 'quantise';
    ui.set(['scale'], ev.value);
  });
  c.addBinding(m, 'auto', { label: 'auto domain' }).on('change', (ev) => {
    if (ev.value) {
      ui.set(['domain'], null);
    } else {
      resetDomain();
      sendDomain();
    }
    showDomain();
  });
  const sendDomain = () => ui.set(['domain'], [m.domainMin, m.domainMax]);
  const domainMin = ui.mark(c.addBinding(m, 'domainMin', { label: 'domain min', format: fmt }).on('change', sendDomain), 'domain min', 'domain.0');
  const domainMax = ui.mark(c.addBinding(m, 'domainMax', { label: 'domain max', format: fmt }).on('change', sendDomain), 'domain max', 'domain.1');
  const showDomain = () => {
    domainMin.hidden = m.auto;
    domainMax.hidden = m.auto;
  };
  const resetDomain = () => {
    [m.domainMin, m.domainMax] = initialDomain(m.valueColumn ? colOf(m.valueColumn) : undefined);
    ui.quiet(() => {
      domainMin.refresh();
      domainMax.refresh();
    });
  };
  showDomain();
  c.addBinding(m, 'ramp', { options: options(COLOUR_RAMPS) }).on('change', (ev) => ui.set(['ramp'], ev.value));
  c.addBinding(m, 'reverse').on('change', (ev) => ui.set(['reverse'], ev.value));
  const steps = c.addBinding(m, 'steps', { min: 2, max: 64, step: 1 });
  steps.hidden = m.scale !== 'quantise';
  steps.on('change', (ev) => ui.set(['steps'], Math.min(64, Math.max(2, Math.round(ev.value)))));
  const aggregate = c.addBinding(m, 'aggregate', { label: 'same day', options: options(AGGREGATES) });
  aggregate.on('change', (ev) => ui.set(['aggregate'], ev.value));
  aggregate.element.title = 'How several rows on the same calendar day combine';
  aggregate.hidden = !calendar;
  c.addBinding(m, 'missing', { label: 'no data', options: { transparent: 'transparent', colour: 'colour' } }).on('change', (ev) => {
    missingColour.hidden = ev.value !== 'colour';
    ui.set(['missing'], ev.value);
  });
  const missingColour = c.addBinding(m, 'missingColour', { label: 'no-data colour' });
  missingColour.on('change', (ev) => ui.set(['missingColour'], ev.value));
  missingColour.hidden = m.missing !== 'colour';

  const k = ui.folder(root, 'Look', 'Look', false);
  addOpacityBlend(ui, k, layer);

  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}
