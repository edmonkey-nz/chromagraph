import { AdditiveBlending, DoubleSide, Group, MeshBasicMaterial, NormalBlending } from 'three';
import { Text } from 'troika-three-text';
import type { Table } from '../../../data/columns.ts';
import type { TextLayer } from '../../../shared/layer-schema.ts';
import { bindTemplate, compileTemplate, renderTemplate, templateRow, type BoundTemplate } from '../../../shared/text-template.ts';
import type { FrameContext, LayerInstance } from './layer.ts';

/**
 * Text overlay: one troika-three-text SDF mesh. troika lays text out asynchronously in its
 * own worker and keeps drawing the previous layout until the new one is ready, so the
 * output never waits for it. sync() is called only when the text or a layout property
 * actually changed.
 *
 * The template is compiled and bound once per text (or dataset) change, and evaluated only
 * when the current row index changes, so a `row` modulator (data playhead) costs a few
 * comparisons per frame until the row really moves.
 */

export interface TextSource {
  table: Table;
  timeZone: string;
}

export interface TextInstance extends LayerInstance {
  apply(layer: TextLayer, cameraMode: '2d' | '3d'): void;
}

/** Template source plus the layout-affecting props, to detect when sync() is needed. */
interface LayoutState {
  text: string;
  font: string | null;
  fontSize: number;
  align: TextLayer['align'];
  anchorX: TextLayer['anchorX'];
  anchorY: TextLayer['anchorY'];
  maxWidth: number;
  lineHeight: number;
  letterSpacing: number;
}

/** `source` is null for a layer without a dataset: only static text shows. */
export function createTextLayer(layer: TextLayer, source: TextSource | null, cameraMode: '2d' | '3d'): TextInstance {
  const root = new Group();
  root.name = layer.name;
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  const text = new Text();
  text.material = material;
  // Glyph quads are positioned by troika; its bounds are not known until layout completes.
  text.frustumCulled = false;
  root.add(text);

  const rowCount = source?.table.rowCount ?? 0;
  let templateSource: string | null = null;
  let bound: BoundTemplate | null = null;
  let lastRow = -1;
  const laid: LayoutState = {
    text: '',
    font: null,
    fontSize: 0,
    align: 'left',
    anchorX: 'left',
    anchorY: 'top',
    maxWidth: 0,
    lineHeight: 0,
    letterSpacing: 0,
  };

  function apply(next: TextLayer, mode: '2d' | '3d'): void {
    if (next.text !== templateSource) {
      templateSource = next.text;
      bound = bindTemplate(compileTemplate(next.text), source?.table ?? null, source?.timeZone ?? 'UTC');
      lastRow = -1;
    }
    const row = bound!.dynamic ? templateRow(next.row, rowCount) : 0;
    let dirty = false;
    if (row !== lastRow) {
      lastRow = row;
      const s = renderTemplate(bound!, row);
      if (s !== laid.text) {
        laid.text = s;
        text.text = s;
        dirty = true;
      }
    }
    if (next.font !== laid.font) {
      laid.font = next.font;
      text.font = next.font;
      dirty = true;
    }
    if (next.fontSize !== laid.fontSize) {
      laid.fontSize = next.fontSize;
      text.fontSize = next.fontSize;
      dirty = true;
    }
    if (next.align !== laid.align) {
      laid.align = next.align;
      text.textAlign = next.align;
      dirty = true;
    }
    if (next.anchorX !== laid.anchorX) {
      laid.anchorX = next.anchorX;
      text.anchorX = next.anchorX;
      dirty = true;
    }
    if (next.anchorY !== laid.anchorY) {
      laid.anchorY = next.anchorY;
      text.anchorY = next.anchorY;
      dirty = true;
    }
    if (next.maxWidth !== laid.maxWidth) {
      laid.maxWidth = next.maxWidth;
      text.maxWidth = next.maxWidth > 0 ? next.maxWidth : Infinity;
      dirty = true;
    }
    if (next.lineHeight !== laid.lineHeight) {
      laid.lineHeight = next.lineHeight;
      text.lineHeight = next.lineHeight;
      dirty = true;
    }
    if (next.letterSpacing !== laid.letterSpacing) {
      laid.letterSpacing = next.letterSpacing;
      text.letterSpacing = next.letterSpacing;
      dirty = true;
    }
    if (dirty) text.sync();

    // Per-render uniforms in troika (no re-layout): colours, outline and opacity.
    text.color = next.colour;
    text.outlineWidth = next.outlineWidth;
    text.outlineColor = next.outlineColour;
    text.fillOpacity = next.opacity;
    text.outlineOpacity = next.opacity;
    text.position.set(next.position[0], next.position[1], next.position[2]);

    // troika's material inherits from this base material, so these follow it.
    const additive = next.blend === 'additive';
    material.blending = additive ? AdditiveBlending : NormalBlending;
    material.depthTest = mode === '3d' && !additive;
    root.name = next.name;
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    update(_ctx: FrameContext) {},
    dispose() {
      text.dispose(); // glyph geometry
      material.dispose(); // also disposes troika's derived (and outline) materials
    },
  };
}
