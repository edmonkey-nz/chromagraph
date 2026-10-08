import type { FolderApi } from 'tweakpane';
import { addLevel, levelColumns, levelOfKind, levelTitle, MAX_LEVELS, MIN_LEVELS, removeLevel } from '../../shared/level-helpers.ts';
import {
  AGGREGATES,
  HIERARCHY_LAYOUTS,
  HIERARCHY_TIME_UNITS,
  type HierarchyLayer,
  type HierarchyLevel,
  type LayerConfig,
} from '../../shared/layer-schema.ts';
import {
  addChoice,
  addDomain,
  addFitButton,
  addIdentity,
  addNumber,
  addOpacityBlend,
  addPair,
  addPlain,
  addRows,
  addScaleRamp,
  addValueColumn,
  addVec3,
  buildTransform,
  numericColumns,
  type DomainControl,
  type LayerUi,
} from './layer-ui.ts';

/** Hierarchy folders: General, Levels, Layout, Nodes, Links, Labels, Look, Transform. */

const LAYOUT_TITLES: Record<HierarchyLayer['layout'], string> = {
  dendrogram: 'dendrogram',
  'radial-dendrogram': 'radial dendrogram',
  tree: 'tree',
  sunburst: 'sunburst',
  icicle: 'icicle',
  pack: 'circle packing',
  treemap: 'treemap',
};

/** Layouts that fill areas (cells) rather than drawing nodes and links. */
const AREA_LAYOUTS: ReadonlySet<HierarchyLayer['layout']> = new Set(['sunburst', 'icicle', 'pack', 'treemap']);
/** Layouts with an inner radius. */
const RADIAL_LAYOUTS: ReadonlySet<HierarchyLayer['layout']> = new Set(['radial-dendrogram', 'sunburst']);

export function buildHierarchy(ui: LayerUi, layer: HierarchyLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const numeric = ui.summary ? numericColumns(ui.summary) : [];
  let domain: DomainControl | null = null;

  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf);
  addValueColumn(ui, g, layer.valueColumn, numeric, () => domain);
  addChoice(ui, g, layer.aggregate, 'aggregate', ['aggregate'], AGGREGATES).element.title =
    'How a leaf combines its rows, and a parent its children (sum adds up; min/max take the extreme). Rows with no value are left out and counted.';
  addRows(ui, g, layer.rows);

  buildLevels(ui, root, layer);

  // ---- Layout ----
  const l = ui.folder(root, 'Layout', 'Layout', false);
  const layout = addChoice(ui, l, layer.layout, 'layout', ['layout'], HIERARCHY_LAYOUTS, LAYOUT_TITLES);
  addVec3(ui, l, layer.origin, 'top-left', ['origin'], 'origin').element.title =
    'Top-left corner of the bounding box (px, y up). Radial layouts use the box’s centre and smaller half-size.';
  addPair(ui, l, layer.size, ['width', 'height'], ['size'], { hardMin: 1, field: 'size' });
  const inner = addNumber(ui, l, layer.innerRadius, 'inner radius', ['innerRadius'], {
    min: 0,
    max: 800,
    step: 1,
    hardMax: Infinity,
    field: 'innerRadius',
    hint: 'Radial layouts: px left clear at the centre',
  });
  const padding = addNumber(ui, l, layer.padding, 'padding', ['padding'], {
    min: 0,
    max: 40,
    step: 0.5,
    field: 'padding',
    hint: 'Area layouts (sunburst, icicle, pack, treemap): gap between cells, px',
  });
  addFitButton(ui, l);

  // ---- Nodes and colour ----
  const n = ui.folder(root, 'Nodes', 'Nodes', true);
  const nodeSize = addPair(ui, n, layer.nodeSize, ['marker min', 'marker max'], ['nodeSize'], {
    min: 0,
    max: 60,
    step: 0.5,
    hardMin: 0,
    field: 'nodeSize',
    hint: 'Node marker size range px, by value; equal for uniform markers',
  });
  const colourBy = addChoice(ui, n, layer.colourBy, 'colour by', ['colourBy'], ['value', 'depth', 'none'] as const, {
    value: 'value',
    depth: 'depth (level)',
    none: 'none (one colour)',
  });
  const colour = addPlain(ui, n, layer.colour, 'colour', ['colour']);
  const { scale, ramp, reverse } = addScaleRamp(ui, n, layer);
  scale.element.title = 'Value scale, for marker size and colour';
  domain = addDomain(ui, n, layer.domain, layer.valueColumn, numeric);
  const showColour = (by: HierarchyLayer['colourBy']) => {
    colour.hidden = by !== 'none';
    ramp.hidden = by === 'none';
    reverse.hidden = by === 'none';
  };
  colourBy.on('change', (ev) => showColour(ev.value));
  showColour(layer.colourBy);

  // ---- Links ----
  const k = ui.folder(root, 'Links', 'Links', false);
  addNumber(ui, k, layer.linkWidth, 'width (px)', ['linkWidth'], { min: 0, max: 20, step: 0.5, field: 'linkWidth', hint: '0 hides the links; 2 px is the projection minimum' });
  addPlain(ui, k, layer.linkColour, 'colour', ['linkColour']);
  addNumber(ui, k, layer.linkOpacity, 'opacity', ['linkOpacity'], { min: 0, max: 1, step: 0.01, field: 'linkOpacity' });

  // ---- Labels ----
  const t = ui.folder(root, 'Labels', 'Labels', false);
  addNumber(ui, t, layer.labelDepth, 'down to depth', ['labelDepth'], {
    min: -1,
    max: 5,
    integer: true,
    hint: 'Label nodes down to this depth: 0 is the root only, -1 none',
  });
  addNumber(ui, t, layer.labelSize, 'size (px)', ['labelSize'], { min: 8, max: 120, step: 1, hardMax: 200, field: 'labelSize', hint: '24 px is the projection minimum' });
  addPlain(ui, t, layer.labelColour, 'colour', ['labelColour']);

  const look = ui.folder(root, 'Look', 'Look', false);
  addOpacityBlend(ui, look, layer);

  buildTransform(ui, root, layer.transform);

  // Fields that only apply to some layouts, shown in place when the layout changes.
  const showLayout = (v: HierarchyLayer['layout']) => {
    const area = AREA_LAYOUTS.has(v);
    inner.hidden = !RADIAL_LAYOUTS.has(v);
    padding.hidden = !area;
    for (const api of nodeSize) api.hidden = area;
    k.hidden = area;
  };
  layout.on('change', (ev) => showLayout(ev.value));
  showLayout(layer.layout);
}

/**
 * "Levels" folder: the grouping levels, outermost first. Each is a kind (calendar unit of a
 * time column, or a category column), its column and (for time) its unit, with Remove; Add
 * level appends a sensible next level (see nextLevel). Always 1..5 levels. Kind changes and
 * adding or removing levels rebuild the folder (shapeKey), so each level shows the right fields.
 */
function buildLevels(ui: LayerUi, parent: FolderApi, layer: HierarchyLayer): void {
  const f = ui.folder(parent, 'Levels', 'Levels', true);
  /** The synced levels at click time (the layer may have changed since this folder was built). */
  const levelsNow = (): HierarchyLevel[] => {
    const l = ui.entry.layer;
    return l.type === 'hierarchy' ? l.levels : layer.levels;
  };
  layer.levels.forEach((level, i) => {
    const lf = ui.folder(f, `${i + 1} · ${levelTitle(level)}`, `Levels/${i}`, true);
    const m = { kind: level.kind, column: level.column, unit: level.kind === 'time' ? level.unit : 'year' };
    lf.addBinding(m, 'kind', { options: { 'time (calendar unit)': 'time', category: 'category' } }).on('change', (ev) => {
      const prev = levelsNow()[i];
      if (!prev) return;
      const next: HierarchyLevel = ui.summary
        ? levelOfKind(ev.value, prev, ui.summary)
        : ev.value === 'time'
          ? { kind: 'time', column: prev.column, unit: 'year' }
          : { kind: 'category', column: prev.column };
      ui.set(['levels', i], next);
    });
    if (ui.summary) {
      const columns = levelColumns(level.kind, ui.summary);
      const options = columns.map((c) => ({ text: c.name, value: c.name }));
      if (!columns.some((c) => c.name === level.column)) {
        options.unshift({ text: level.column ? `${level.column} (missing)` : '(choose a column)', value: level.column });
      }
      lf.addBinding(m, 'column', { options }).on('change', (ev) => {
        ui.set(['levels', i, 'column'], ev.value);
        lf.title = `${i + 1} · ${levelTitle({ ...level, column: ev.value } as HierarchyLevel)}`;
      });
    } else {
      lf.addButton({ title: 'Waiting for data…', label: 'column', disabled: true });
    }
    if (level.kind === 'time') {
      lf.addBinding(m, 'unit', { options: HIERARCHY_TIME_UNITS.map((u) => ({ text: u, value: u })) }).on('change', (ev) => {
        ui.set(['levels', i, 'unit'], ev.value);
        lf.title = `${i + 1} · ${levelTitle({ kind: 'time', column: m.column, unit: ev.value })}`;
      });
    }
    lf.addButton({ title: 'Remove level', disabled: layer.levels.length <= MIN_LEVELS }).on('click', () => {
      const levels = levelsNow();
      if (levels.length <= MIN_LEVELS) return;
      ui.set(['levels'], removeLevel(levels, i));
    });
  });
  f.addButton({ title: layer.levels.length >= MAX_LEVELS ? `Add level (${MAX_LEVELS} max)` : 'Add level', disabled: layer.levels.length >= MAX_LEVELS }).on(
    'click',
    () => {
      const levels = levelsNow();
      if (levels.length >= MAX_LEVELS) return;
      ui.set(['levels', levels.length], addLevel(levels, ui.summary ?? { rowCount: 0, columns: [], cadences: {} })[levels.length]);
    },
  );
}
