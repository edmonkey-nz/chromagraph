import type { FolderApi } from 'tweakpane';
import type { SummaryColumn } from '../../shared/layer-defaults.ts';
import type { LayerChange } from '../../shared/layer-helpers.ts';
import { COLOUR_RAMPS, MAX_DENSITY_BINS, MAX_DENSITY_CELLS, SCALE_TYPES, type DensityLayer, type LayerConfig } from '../../shared/layer-schema.ts';
import {
  addFitButton,
  addIdentity,
  addNumber,
  addOpacityBlend,
  addVec3,
  buildEffects,
  buildTransform,
  columnOptions,
  fmt,
  type LayerUi,
  numericColumns,
  options,
} from './layer-ui.ts';

const DAY_MS = 86_400_000;

/** A column's range in the units the density map counts in (time: days from its first value). */
function columnRange(col: SummaryColumn | undefined): [number, number] {
  if (!col || !Number.isFinite(col.min) || !Number.isFinite(col.max)) return [0, 1];
  return col.type === 'time' ? [0, (col.max - col.min) / DAY_MS] : [col.min, col.max];
}

/** Density map folders: General, Layout, Dots (3D), Colour, Look, Transform. */
export function buildDensity(ui: LayerUi, layer: DensityLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const columns = ui.summary ? numericColumns(ui.summary) : [];
  const colOf = (name: string | null) => (name === null ? undefined : columns.find((c) => c.name === name));

  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf);
  if (ui.summary) {
    axis(ui, g, 'x', layer.xColumn, layer.xDomain, columns, colOf);
    axis(ui, g, 'y', layer.yColumn, layer.yDomain, columns, colOf);
  } else {
    g.addButton({ title: 'Waiting for data…', label: 'columns', disabled: true });
  }

  const l = ui.folder(root, 'Layout', 'Layout', false);
  addVec3(ui, l, layer.origin, 'bottom-left', ['origin'], 'origin').element.title = 'Bottom-left corner of the map (px, y up)';
  const size = { w: layer.size[0], h: layer.size[1] };
  const sendSize = () => ui.set(['size'], [Math.max(1, size.w), Math.max(1, size.h)]);
  ui.mark(l.addBinding(size, 'w', { label: 'width', format: fmt }).on('change', sendSize), 'width', 'size.0');
  ui.mark(l.addBinding(size, 'h', { label: 'height', format: fmt }).on('change', sendSize), 'height', 'size.1');
  const bins = { x: layer.bins[0], y: layer.bins[1] };
  const sendBins = () => ui.set(['bins'], [clampBins(bins.x), clampBins(bins.y)]);
  l.addBinding(bins, 'x', { label: 'bins across', min: 4, max: MAX_DENSITY_BINS, step: 1 }).on('change', sendBins).element.title =
    'More bins show finer detail; fewer read as a smoother field. Fit to output keeps the bins square.';
  l.addBinding(bins, 'y', { label: 'bins down', min: 4, max: MAX_DENSITY_BINS, step: 1 }).on('change', sendBins);
  addFitButton(ui, l);

  buildDots(ui, root, layer, columns, colOf);

  const c = ui.folder(root, 'Colour', 'Colour', true);
  addNumber(ui, c, layer.radius, 'smoothing', ['radius'], { min: 0, max: 20, step: 0.1, field: 'radius', hint: 'Gaussian blur of the counts, in bins (0: raw counts)' });
  const m = { scale: layer.scale, auto: layer.domain === null, lo: 0, hi: 1, ramp: layer.ramp, reverse: layer.reverse, steps: layer.steps };
  [m.lo, m.hi] = layer.domain ?? [0, 10];
  c.addBinding(m, 'scale', { options: options(SCALE_TYPES) }).on('change', (ev) => {
    steps.hidden = ev.value !== 'quantise';
    ui.set(['scale'], ev.value);
  }).element.title = 'sqrt or log bring out sparse areas next to crowded ones';
  c.addBinding(m, 'auto', { label: 'auto counts' }).on('change', (ev) => {
    ui.set(['domain'], ev.value ? null : [m.lo, m.hi]);
    lo.hidden = ev.value;
    hi.hidden = ev.value;
  }).element.title = 'On: colours run from 0 to the most crowded bin of all rows (so they hold during a data playhead)';
  const sendDomain = () => ui.set(['domain'], [m.lo, m.hi]);
  const lo = ui.mark(c.addBinding(m, 'lo', { label: 'count min', format: fmt }).on('change', sendDomain), 'count min', 'domain.0');
  const hi = ui.mark(c.addBinding(m, 'hi', { label: 'count max', format: fmt }).on('change', sendDomain), 'count max', 'domain.1');
  lo.hidden = m.auto;
  hi.hidden = m.auto;
  c.addBinding(m, 'ramp', { options: options(COLOUR_RAMPS) }).on('change', (ev) => ui.set(['ramp'], ev.value));
  c.addBinding(m, 'reverse').on('change', (ev) => ui.set(['reverse'], ev.value));
  const steps = c.addBinding(m, 'steps', { min: 2, max: 64, step: 1 });
  steps.hidden = m.scale !== 'quantise';
  steps.on('change', (ev) => ui.set(['steps'], Math.min(64, Math.max(2, Math.round(ev.value)))));
  addNumber(ui, c, layer.threshold, 'threshold', ['threshold'], { min: 0, max: 1, step: 0.005, field: 'threshold', hint: 'Bins below this share of the colour scale are left out (0 shows every bin with a count)' });

  const k = ui.folder(root, 'Look', 'Look', false);
  addOpacityBlend(ui, k, layer);
  buildEffects(ui, root, layer);
  buildTransform(ui, root, layer.transform);
}

/**
 * "Dots (3D)": each bin with a count drawn as a soft dot in 3D. With a z column the bins are 3D
 * (a cloud); without one the dots rise by their count (a hill).
 */
function buildDots(ui: LayerUi, root: FolderApi, layer: DensityLayer, columns: SummaryColumn[], colOf: (name: string | null) => SummaryColumn | undefined): void {
  const dotsOn = layer.mode === 'dots';
  const f = ui.folder(root, 'Dots (3D)', 'Dots', dotsOn);
  const m = { mode: layer.mode };
  f.addBinding(m, 'mode', { label: 'draw as', options: [{ text: 'flat map', value: 'flat' }, { text: 'dots in 3D', value: 'dots' }] }).on('change', (ev) => {
    ui.entry.forceRebuild = ui.send([{ path: ['mode'], value: ev.value }]);
  }).element.title = 'Dots: every bin with a count becomes a soft dot in 3D, coloured and sized by its count. Use the 3D camera to see the depth.';
  if (!dotsOn) return;
  if (ui.summary) axis(ui, f, 'z', layer.zColumn, layer.zDomain, columns, colOf);
  const bz = f.addBinding({ v: layer.binsZ }, 'v', { label: 'bins deep', min: 2, max: 256, step: 1 });
  bz.on('change', (ev) => ui.set(['binsZ'], Math.min(256, Math.max(2, Math.round(ev.value)))));
  bz.element.title = `Bins along z (with a z column). Across × down × deep must stay under ${MAX_DENSITY_CELLS.toLocaleString('en-NZ')}; 3D bins cost more to count, so keep them coarse.`;
  bz.hidden = layer.zColumn === null;
  addNumber(ui, f, layer.depth, 'depth (px)', ['depth'], {
    min: 0,
    max: 2000,
    step: 1,
    field: 'depth',
    hint: layer.zColumn === null ? 'How far the most crowded bins rise towards the camera' : 'Depth of the z range, from origin z',
  });
  addNumber(ui, f, layer.dotSize, 'dot size (px)', ['dotSize'], { min: 0.5, max: 100, step: 0.5, field: 'dotSize', hint: 'Diameter at the top of the colour scale (dots shrink to a third below it)' });
  addNumber(ui, f, layer.jitter, 'scatter', ['jitter'], { min: 0, max: 1, step: 0.01, field: 'jitter', hint: 'Moves each dot by a fixed random share of its bin, so the grid doesn’t show as a lattice (dots never leave their bin)' });
  if (ui.entry.layer.blend !== 'additive') {
    f.addButton({ title: 'Glowing dots (additive blend)', label: '' }).on('click', () => {
      ui.entry.forceRebuild = ui.send([{ path: ['blend'], value: 'additive' }]);
    }).element.title = 'Overlapping dots add up to brighter colour, and need no sorting, so the cloud reads well from any angle';
  }
}

function clampBins(v: number): number {
  return Math.min(MAX_DENSITY_BINS, Math.max(4, Math.round(v)));
}

/** Column and range for one axis. */
function axis(
  ui: LayerUi,
  f: FolderApi,
  name: 'x' | 'y' | 'z',
  column: string | null,
  domain: [number, number] | null,
  columns: SummaryColumn[],
  colOf: (name: string | null) => SummaryColumn | undefined,
): void {
  const m = { column: column ?? '', auto: domain === null, lo: 0, hi: 1 };
  [m.lo, m.hi] = domain ?? columnRange(colOf(column));
  const colKey = `${name}Column`;
  const domKey = `${name}Domain`;
  f.addBinding(m, 'column', { label: name === 'z' ? 'z (depth)' : name, options: columnOptions(columns, column) }).on('change', (ev) => {
    const changes: LayerChange[] = [{ path: [colKey], value: ev.value || null }];
    if (!m.auto) changes.push({ path: [domKey], value: columnRange(colOf(ev.value || null)) });
    ui.entry.forceRebuild = ui.send(changes);
  });
  const isTime = colOf(column)?.type === 'time';
  f.addBinding(m, 'auto', { label: `${name} auto range` }).on('change', (ev) => {
    ui.entry.forceRebuild = ui.send([{ path: [domKey], value: ev.value ? null : columnRange(colOf(column)) }]);
  }).element.title = `On: the ${name} column's whole range. Off: zoom to a range${isTime ? ' (in days from the first reading)' : ''}.`;
  const send = () => ui.set([domKey], [m.lo, m.hi]);
  const lo = f.addBinding(m, 'lo', { label: `${name} from`, format: fmt }).on('change', send);
  const hi = f.addBinding(m, 'hi', { label: `${name} to`, format: fmt }).on('change', send);
  lo.hidden = m.auto;
  hi.hidden = m.auto;
}
