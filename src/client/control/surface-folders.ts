import { AGGREGATES, HEATMAP_LAYOUTS, type LayerConfig, type SurfaceLayer } from '../../shared/layer-schema.ts';
import {
  addChoice,
  addDomain,
  addFitButton,
  addIdentity,
  addNumber,
  addOpacityBlend,
  addPair,
  addPlain,
  addScaleRamp,
  addTimeColumn,
  addValueColumn,
  addVec3,
  buildEffects,
  buildTransform,
  type DomainControl,
  type LayerUi,
  numericColumns,
} from './layer-ui.ts';

const LAYOUT_TITLES = { calendar: 'calendar (year × day)', grid: 'grid (row order)' } as const;

/**
 * 3D surface folders: General, Layout, Height & colour, Look, Transform. The grid lies in the
 * frame like the heat map and heights rise along +z, so the relief shows with a tilted 3D
 * camera. Layout changes rebuild the folder (shapeKey) to show the calendar or grid fields.
 */
export function buildSurface(ui: LayerUi, layer: SurfaceLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const calendar = layer.layout === 'calendar';
  const numeric = ui.summary ? numericColumns(ui.summary) : [];
  let domain: DomainControl | null = null;

  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf);
  addChoice(ui, g, layer.layout, 'layout', ['layout'], HEATMAP_LAYOUTS, LAYOUT_TITLES);
  addTimeColumn(ui, g, layer.timeColumn).hidden = !calendar;
  addValueColumn(ui, g, layer.valueColumn, numeric, () => domain);
  const aggregate = addChoice(ui, g, layer.aggregate, 'same day', ['aggregate'], AGGREGATES);
  aggregate.element.title = 'How several rows on the same calendar day combine';
  aggregate.hidden = !calendar;

  const l = ui.folder(root, 'Layout', 'Layout', false);
  addVec3(ui, l, layer.origin, 'top-left', ['origin'], 'origin').element.title = 'Top-left corner of the grid (px, y up)';
  addPair(ui, l, layer.cell, ['cell w', 'cell h'], ['cell'], { hardMin: 0.01, field: 'cell' });
  addNumber(ui, l, layer.gridColumns, 'grid columns', ['gridColumns'], { min: 1, integer: true, field: 'gridColumns' }).hidden = calendar;
  addFitButton(ui, l);

  const h = ui.folder(root, 'Height & colour', 'Height', true);
  addPair(ui, h, layer.height, ['height min', 'height max'], ['height'], {
    field: 'height',
    hint: 'px along +z for the bottom and top of the value domain (tilt the 3D camera to see relief)',
  });
  const { scale } = addScaleRamp(ui, h, layer);
  scale.element.title = 'Value scale, for height and colour';
  domain = addDomain(ui, h, layer.domain, layer.valueColumn, numeric);

  const k = ui.folder(root, 'Look', 'Look', false);
  addPlain(ui, k, layer.lit, 'lit', ['lit']).element.title = 'Shade with a fixed light; off draws flat ramp colours';
  const wire = addPlain(ui, k, layer.wireframe, 'wireframe', ['wireframe']);
  const wireColour = addPlain(ui, k, layer.wireColour, 'wire colour', ['wireColour']);
  wire.on('change', (ev) => (wireColour.hidden = !ev.value));
  wireColour.hidden = !layer.wireframe;
  addOpacityBlend(ui, k, layer);

  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}
