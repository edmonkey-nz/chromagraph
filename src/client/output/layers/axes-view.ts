import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, type Object3D } from 'three';
import { BatchedText, Text } from 'troika-three-text';
import type { AxesLayout, AxisSegment } from '../../../data/instance-axes.ts';
import type { InstancerAxes } from '../../../shared/layer-schema.ts';
import { displayText, fontUrl } from '../fonts.ts';

/**
 * Draws an AxesLayout (data/instance-axes.ts, data/line-axes.ts) as children of a layer's
 * object, so the layer transform applies: the segments as one non-indexed mesh of quads with RGBA
 * vertex colours, the texts as one BatchedText. Each text key keeps its own troika Text, so a
 * label is only laid out again when its own text changes (troika lays out asynchronously; texts
 * assigned by list position showed old glyphs at new places for a frame or two).
 */
export class AxesView {
  private readonly material = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  private readonly geometry = new BufferGeometry();
  private readonly lines = new Mesh(this.geometry, this.material);
  private readonly textMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false });
  private readonly batch = new BatchedText();
  private readonly texts = new Map<string, Text>();
  /** Texts whose key went away, cleared, for the next new key. */
  private readonly spare: Text[] = [];
  private readonly colour = new Color();

  constructor(parent: Object3D) {
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;
    this.lines.visible = false;
    parent.add(this.lines);
    this.batch.material = this.textMaterial;
    this.batch.frustumCulled = false;
    this.batch.renderOrder = 2;
    this.batch.visible = false;
    parent.add(this.batch);
  }

  hide(): void {
    this.lines.visible = false;
    this.batch.visible = false;
  }

  draw(layout: AxesLayout, axes: InstancerAxes, opacity: number): void {
    this.buildLines(layout.segments, opacity);
    // Keys that went away free their text (cleared, so nothing stale shows when it is reused).
    const keep = new Set<string>();
    for (const t of layout.texts) keep.add(t.key);
    for (const [key, text] of this.texts) {
      if (keep.has(key)) continue;
      this.texts.delete(key);
      if (text.text !== '') text.text = '';
      this.spare.push(text);
    }
    const font = fontUrl(axes.font);
    for (const t of layout.texts) {
      let text = this.texts.get(t.key);
      if (!text) {
        text = this.spare.pop();
        if (!text) {
          text = new Text();
          text.whiteSpace = 'nowrap';
          this.batch.addText(text);
        }
        this.texts.set(t.key, text);
      }
      const shown = displayText(t.text, axes.uppercase);
      if (text.text !== shown) text.text = shown;
      text.font = font;
      text.fontSize = t.size;
      text.color = t.colour;
      text.fillOpacity = opacity;
      text.anchorX = t.anchorX;
      text.anchorY = t.anchorY;
      text.position.set(t.x, t.y, t.z);
      text.rotation.z = t.rotation;
    }
    this.batch.visible = layout.texts.length > 0;
  }

  /** Quads for the segments, `width` px across, coloured with the layer opacity applied. */
  private buildLines(segments: readonly AxisSegment[], opacity: number): void {
    const pos = new Float32Array(segments.length * 18);
    const col = new Float32Array(segments.length * 24);
    let p = 0;
    let c = 0;
    for (const sg of segments) {
      const [ax, ay, az] = sg.a;
      const [bx, by, bz] = sg.b;
      // Across the line in the x/y plane; a line straight along z widens along x.
      let px = by - ay;
      let py = -(bx - ax);
      const len = Math.hypot(px, py);
      if (len > 1e-9) {
        px /= len;
        py /= len;
      } else {
        px = 1;
        py = 0;
      }
      const hw = sg.width / 2;
      const corners = [
        [ax - px * hw, ay - py * hw, az],
        [bx - px * hw, by - py * hw, bz],
        [bx + px * hw, by + py * hw, bz],
        [ax - px * hw, ay - py * hw, az],
        [bx + px * hw, by + py * hw, bz],
        [ax + px * hw, ay + py * hw, az],
      ];
      this.colour.set(sg.colour);
      for (const v of corners) {
        pos[p++] = v[0]!;
        pos[p++] = v[1]!;
        pos[p++] = v[2]!;
        col[c++] = this.colour.r;
        col[c++] = this.colour.g;
        col[c++] = this.colour.b;
        col[c++] = sg.opacity * opacity;
      }
    }
    this.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.geometry.setAttribute('color', new Float32BufferAttribute(col, 4));
    this.geometry.computeBoundingSphere();
    this.lines.visible = segments.length > 0;
  }

  dispose(): void {
    for (const text of [...this.texts.values(), ...this.spare]) {
      this.batch.removeText(text);
      text.dispose();
    }
    this.batch.dispose();
    this.textMaterial.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
