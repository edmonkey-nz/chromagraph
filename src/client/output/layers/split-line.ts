import { DoubleSide, Group, MeshBasicMaterial } from 'three';
import { Text } from 'troika-three-text';
import type { ChannelData } from '../../../data/instance-data.ts';
import { buildLineData, lastVisiblePoint, type LineData } from '../../../data/line-data.ts';
import { splitSeries, stackSeries } from '../../../data/line-split.ts';
import { seriesColour, type LineLayer } from '../../../shared/layer-schema.ts';
import { displayText, fontUrl } from '../fonts.ts';
import type { FrameContext } from './layer.ts';
import { createLineAxes, type LineAxes } from './line-axes-view.ts';
import { createLineFromData, type LineInstance, type LineSource } from './line.ts';

/**
 * A line layer split by a category or text column (LineSplitSchema): one line per value,
 * each a full line instance (fill, band, cloner, aggregation all work per series) with the
 * layer's settings and its own colour. Every series' points are built first so they can share
 * one auto domain per channel; with the shared time origin and step from splitSeries, the
 * lines sit on one set of axes. A band takes its series' colour.
 *
 * Stacked ('stack' / 'stream', stackSeries): each series' points are the top of its slice and
 * its band the slice, filled in the series colour (at 0.85 opacity unless a fill is set).
 *
 * Labels name each line at its last visible point (troika Text, laid out again only when the
 * text, font or size changes; moved every apply, without allocating, so they follow a
 * modulated layer or a data playhead).
 */

const LABEL_BASE_PX = 32;

/** Union of the series' auto domains for one channel (category colour codes are already shared). */
function shareDomain(lines: LineData[], channel: 'y' | 'z' | 'colour'): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of lines) {
    const c = d[channel];
    if (!c || c.categories > 0) continue;
    if (Number.isFinite(c.autoDomain[0])) lo = Math.min(lo, c.autoDomain[0]);
    if (Number.isFinite(c.autoDomain[1])) hi = Math.max(hi, c.autoDomain[1]);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  for (const d of lines) {
    const c: ChannelData | null = d[channel];
    if (c && c.categories === 0) d[channel] = { ...c, autoDomain: [lo, hi] };
  }
}

export function createSplitLine(layer: LineLayer, source: LineSource, cameraMode: '2d' | '3d'): LineInstance {
  const series = splitSeries({ table: source.table, cadences: source.cadences, calendars: source.calendars ?? {} }, layer.split.column!);
  const built = series.map((s) => buildLineData(layer, s.data.table, s.data.cadences, s.data.calendars));
  // Stacked: each series becomes its slice of the pile (points at its top, band from the one below).
  const stacking = layer.split.stack !== 'none' && layer.y.column !== null;
  const data = stacking ? stackSeries(built, layer.split.stack as 'stack' | 'stream') : built;
  shareDomain(data, 'y');
  shareDomain(data, 'z');
  shareDomain(data, 'colour');

  const root = new Group();
  root.name = layer.name;
  // Per-series scratch configs, written in place every apply (no per-frame allocation).
  const configs = series.map(() => ({ ...layer }));
  const fills = series.map(() => ({ ...layer.fill }));
  const lines: LineInstance[] = [];
  let axesRef: LineAxes | null = null;
  const disposeAll = () => {
    axesRef?.dispose();
    for (const l of lines) l.dispose();
    for (const t of texts) t.dispose();
    labelMaterial.dispose();
  };
  const texts: Text[] = [];
  const labelMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const labelGroup = new Group();
  labelGroup.renderOrder = 2;

  const configure = (next: LineLayer, i: number): LineLayer => {
    const c = configs[i]!;
    const colour = seriesColour(next.split, series[i]!.value, series[i]!.index);
    Object.assign(c, next);
    // Never write into `next.fill` (the caller's config): each series has its own.
    c.fill = Object.assign(fills[i]!, next.fill);
    c.colour = colour;
    if (stacking) {
      // The slice is the fill: always on, in the series colour (fill opacity still applies).
      c.fill.mode = 'band';
      c.fill.colour = colour;
      if (next.fill.mode === 'none') c.fill.opacity = 0.85;
    } else if (next.fill.mode === 'band') c.fill.colour = colour;
    return c as LineLayer;
  };

  try {
    series.forEach((_, i) => {
      const line = createLineFromData(configure(layer, i), data[i]!, cameraMode);
      lines.push(line);
      root.add(line.object);
    });
  } catch (err) {
    disposeAll();
    throw err;
  }
  root.add(labelGroup);
  // One set of axes for every series (they share the time origin and the y domain).
  const axes = createLineAxes(root, series.map((s, i) => ({ data: data[i]!, table: s.data.table })), source.timeZone ?? 'UTC');
  axesRef = axes;

  const style = { font: '', uppercase: false };
  const at = [0, 0, 0];

  function apply(next: LineLayer, mode: '2d' | '3d'): void {
    root.name = next.name;
    for (let i = 0; i < lines.length; i++) lines[i]!.apply(configure(next, i), mode);
    axes.apply(next);

    const lab = next.split.labels;
    labelGroup.visible = lab.enabled;
    if (!lab.enabled) return;
    const restyle = lab.font !== style.font || lab.uppercase !== style.uppercase;
    style.font = lab.font;
    style.uppercase = lab.uppercase;
    for (let i = 0; i < series.length; i++) {
      let t = texts[i];
      if (!t) {
        t = new Text();
        t.material = labelMaterial;
        t.fontSize = LABEL_BASE_PX;
        t.anchorX = 'left';
        t.anchorY = 'middle';
        t.whiteSpace = 'nowrap';
        t.frustumCulled = false;
        t.renderOrder = 2;
        texts[i] = t;
        labelGroup.add(t);
      }
      if (restyle || t.text === '') {
        t.text = displayText(series[i]!.value, style.uppercase);
        t.font = fontUrl(style.font);
        t.sync();
      }
      const shown = lastVisiblePoint(data[i]!, configs[i]!, at);
      t.visible = shown;
      if (!shown) continue;
      t.position.set(at[0]! + lab.gap, at[1]!, at[2]!);
      t.scale.setScalar(lab.size / LABEL_BASE_PX);
      t.color = configs[i]!.colour;
      t.fillOpacity = next.opacity;
    }
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    setRowsSpan: (lo, hi) => axes.setRowsSpan(lo, hi),
    // The series furthest along (largest x) leads.
    followPoint(out) {
      let found = false;
      for (let i = 0; i < data.length; i++) {
        if (!lastVisiblePoint(data[i]!, configs[i]!, at)) continue;
        if (!found || at[0]! > out[0]!) {
          out[0] = at[0]!;
          out[1] = at[1]!;
          out[2] = at[2]!;
        }
        found = true;
      }
      return found;
    },
    update(ctx: FrameContext) {
      for (const l of lines) l.update(ctx);
    },
    dispose: disposeAll,
  };
}
