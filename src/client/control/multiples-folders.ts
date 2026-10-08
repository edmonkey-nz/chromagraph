import type { FolderApi } from 'tweakpane';
import { panelCount } from '../../shared/layer-defaults.ts';
import type { LayerChange } from '../../shared/layer-helpers.ts';
import { isTimeSplit, levelColumns, splitColumnFor } from '../../shared/level-helpers.ts';
import { SPLITS, type LayerConfig, type SmallMultiplesLayer } from '../../shared/layer-schema.ts';
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

/** Small multiples folders: General, Layout, Chart, Labels, Look, Transform. */

const SPLIT_TITLES: Record<(typeof SPLITS)[number], string> = {
  year: 'year',
  month: 'month',
  decade: 'decade',
  category: 'category',
  rows: 'rows (fixed chunks)',
};

const CHART_TITLES = { bars: 'bars', dots: 'dots', cells: 'cells (heat strip)' } as const;

export function buildMultiples(ui: LayerUi, layer: SmallMultiplesLayer, titleOf: (l: LayerConfig) => string): void {
  const root = ui.entry.folder;
  const numeric = ui.summary ? numericColumns(ui.summary) : [];
  let domain: DomainControl | null = null;

  // ---- General: what is split, and by what ----
  const g = ui.folder(root, 'General', 'General', true);
  addIdentity(ui, g, layer, titleOf);
  // Switching between time and category splits re-points the column in the same patch.
  const sm = { splitBy: layer.splitBy };
  g.addBinding(sm, 'splitBy', { label: 'split by', options: SPLITS.map((v) => ({ text: SPLIT_TITLES[v], value: v })) })
    .on('change', (ev) => ui.send(splitChanges(ui, ev.value)))
    .element.title = 'One panel per year, month or decade of a time column, per category, or per fixed chunk of rows';
  buildSplitColumn(ui, g, layer);
  addNumber(ui, g, layer.chunkRows, 'rows per panel', ['chunkRows'], { min: 1, integer: true }).hidden = layer.splitBy !== 'rows';
  addValueColumn(ui, g, layer.valueColumn, numeric, () => domain);
  addRows(ui, g, layer.rows);

  // ---- Layout: the panel grid ----
  const l = ui.folder(root, 'Layout', 'Layout', false);
  addNumber(ui, l, layer.columns, 'panels per line', ['columns'], { min: 1, max: 60, hardMax: Infinity, integer: true, field: 'columns' });
  addVec3(ui, l, layer.origin, 'top-left', ['origin'], 'origin').element.title = 'Top-left corner of the first panel (px, y up; panels fill downward)';
  addPair(ui, l, layer.panelSize, ['panel w', 'panel h'], ['panelSize'], { hardMin: 1, field: 'panelSize' });
  addPair(ui, l, layer.gap, ['gap x', 'gap y'], ['gap'], { hardMin: 0, field: 'gap', hint: 'px between panels' });
  addPanelReadout(ui, l);
  addFitButton(ui, l);

  // ---- Chart: marks, value scale and colour ----
  const c = ui.folder(root, 'Chart', 'Chart', true);
  addChoice(ui, c, layer.chart, 'chart', ['chart'], ['bars', 'dots', 'cells'] as const, CHART_TITLES);
  addNumber(ui, c, layer.markSize, 'mark size', ['markSize'], {
    min: 0.05,
    max: 20,
    step: 0.05,
    hardMax: 50,
    field: 'markSize',
    hint: 'Bars: width as a fraction of the per-row x step. Dots: diameter in px.',
  });
  addChoice(ui, c, layer.domainMode, 'domain', ['domainMode'], ['shared', 'per-panel'] as const, {
    shared: 'shared by all panels',
    'per-panel': 'each panel its own',
  }).element.title = 'Scale every panel to the same domain (comparable), or each to its own range (shape only)';
  domain = addDomain(ui, c, layer.domain, layer.valueColumn, numeric);
  const colourByValue = addPlain(ui, c, layer.colourByValue, 'colour by value', ['colourByValue']);
  const colour = addPlain(ui, c, layer.colour, 'colour', ['colour']);
  const { scale, ramp, reverse } = addScaleRamp(ui, c, layer);
  scale.element.title = 'Value scale, for heights and for colour';
  const showColour = (byValue: boolean) => {
    colour.hidden = byValue;
    ramp.hidden = !byValue;
    reverse.hidden = !byValue;
  };
  colourByValue.on('change', (ev) => showColour(ev.value));
  showColour(layer.colourByValue);

  // ---- Labels and frame ----
  const t = ui.folder(root, 'Labels', 'Labels', false);
  addNumber(ui, t, layer.labelSize, 'title size', ['labelSize'], {
    min: 0,
    max: 120,
    step: 1,
    hardMax: 200,
    field: 'labelSize',
    hint: 'Panel titles (e.g. "1923", "Mar 1923", the category) in px at 1080p; 0 hides them. 24 px is the projection minimum.',
  });
  addPlain(ui, t, layer.labelColour, 'title colour', ['labelColour']);
  addPlain(ui, t, layer.frame, 'frame', ['frame']).element.title = 'Faint frame around each panel';

  const k = ui.folder(root, 'Look', 'Look', false);
  addOpacityBlend(ui, k, layer);

  buildTransform(ui, root, layer.transform);
}

/**
 * Split column picker: time columns for year/month/decade, category columns for `category`,
 * none for `rows`. The panel rebuilds when the split changes (shapeKey), so the list matches.
 */
function buildSplitColumn(ui: LayerUi, f: FolderApi, layer: SmallMultiplesLayer): void {
  if (layer.splitBy === 'rows') return;
  if (!ui.summary) {
    f.addButton({ title: 'Waiting for data…', label: 'split column', disabled: true });
    return;
  }
  const columns = levelColumns(isTimeSplit(layer.splitBy) ? 'time' : 'category', ui.summary);
  const m = { column: layer.splitColumn ?? '' };
  // No "none": a calendar or category split needs a column.
  const options = columns.map((c) => ({ text: c.name, value: c.name }));
  if (!columns.some((c) => c.name === layer.splitColumn)) {
    options.unshift({ text: layer.splitColumn === null ? '(no suitable column)' : `${layer.splitColumn} (missing)`, value: m.column });
  }
  f.addBinding(m, 'column', { label: 'split column', options }).on('change', (ev) => ui.set(['splitColumn'], ev.value || null));
}

/** Read-only "panels: 119 in 10 lines" for the current split, rows and panels per line. */
function addPanelReadout(ui: LayerUi, f: FolderApi): void {
  const m = { panels: '' };
  const api = f.addBinding(m, 'panels', { label: 'panels', readonly: true, interval: 0 });
  api.element.title = 'Panels for the visible rows (calendar splits count every year, month or decade spanned)';
  const timeZone = ui.doc.project.datasets.find((d) => d.id === ui.entry.layer.datasetId)?.timeZone ?? 'UTC';
  const refresh = () => {
    const l = ui.entry.layer;
    if (l.type !== 'multiples') return;
    let text = 'waiting for data…';
    if (ui.summary) {
      const n = panelCount(l, ui.summary, timeZone);
      const lines = Math.ceil(n / Math.max(1, l.columns));
      text = `${n.toLocaleString('en-NZ')} in ${lines.toLocaleString('en-NZ')} line${lines === 1 ? '' : 's'}`;
    }
    if (text !== m.panels) {
      m.panels = text;
      api.refresh();
    }
  };
  ui.entry.refreshReadout = refresh;
  refresh();
}

/** Changes for switching the split: the split plus, when needed, a suitable column. */
function splitChanges(ui: LayerUi, splitBy: SmallMultiplesLayer['splitBy']): LayerChange[] {
  const l = ui.entry.layer;
  if (l.type !== 'multiples') return [];
  const changes: LayerChange[] = [{ path: ['splitBy'], value: splitBy }];
  const column = ui.summary ? splitColumnFor(splitBy, l.splitColumn, ui.summary) : splitBy === 'rows' ? null : l.splitColumn;
  if (column !== l.splitColumn) changes.push({ path: ['splitColumn'], value: column });
  return changes;
}
