import { IDENTITY_QUAD, isConvexQuad, type Quad } from '../../shared/homography.ts';
import type { OutputProfile } from '../../shared/output-profile.ts';
import type { PatchOp } from '../../shared/patch.ts';
import { PROJECT_NAME_RE, type SyncDoc } from '../../shared/project-schema.ts';
import type { ClientMessage } from '../../shared/protocol.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CORNER_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'];
const CORNER_COLOURS = ['#ff7070', '#70ff70', '#80a8ff', '#ffe070']; // match the test pattern
/** The editor draws the window 16:9: x 0..1, y 0..ASPECT (corner y values are scaled by it). */
const ASPECT = 9 / 16;
/** View box with a margin, so corners can sit slightly outside the window. */
const VIEW = { x: -0.12, y: -0.12, w: 1.24, h: ASPECT + 0.24 };
/** One output pixel at 1920 wide, for arrow-key nudges (shift = 10 px). */
const NUDGE = 1 / 1920;

type Corners = OutputProfile['corners'];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Output calibration (phase 5): choose or create an output profile and pin the image's
 * four corners onto the projection surface. Drag the handles, or click one and use the
 * arrow keys (1 px, shift for 10 px). While calibrating, the output shows the test
 * pattern. Folded shapes are never sent.
 */
export class CalibrationPanel {
  private corners: Corners = IDENTITY_QUAD.map(([x, y]) => [x, y]) as unknown as Corners;
  private profileName = '';
  private profileNames: string[] = [];
  private selected = 0;
  private dragging = -1;
  private calibrating = false;

  private select = h('select', { title: 'Output profile (one per venue or projector)' });
  private newName = h('input', { placeholder: 'new profile name', size: 14 });
  private calibrate = h('input', { type: 'checkbox' });
  private svgEl = svg('svg', { viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`, class: 'calib-svg', tabindex: 0 });
  private quadEl = svg('polygon', { class: 'calib-quad' });
  private handles: SVGCircleElement[] = [];
  private readout = h('div', { className: 'muted calib-readout' });

  constructor(
    root: HTMLElement,
    private sendPatch: (ops: PatchOp[]) => void,
    private send: (msg: ClientMessage) => void,
    private showError: (message: string) => void,
  ) {
    const create = h('button', { textContent: 'Create' });
    create.addEventListener('click', () => this.createProfile());
    const reset = h('button', { textContent: 'Reset corners', title: 'Fill the window again (no keystone)' });
    reset.addEventListener('click', () => this.commit(IDENTITY_QUAD.map(([x, y]) => [x, y]) as unknown as Corners));
    this.select.addEventListener('change', () => this.send({ t: 'openProfile', name: this.select.value }));
    this.calibrate.addEventListener('change', () => {
      this.calibrating = this.calibrate.checked;
      this.sendPatch([{ op: 'set', path: ['session', 'testPattern'], value: this.calibrating }]);
    });

    this.svgEl.append(svg('rect', { x: 0, y: 0, width: 1, height: ASPECT, class: 'calib-window' }), this.quadEl);
    CORNER_COLOURS.forEach((colour, i) => {
      const c = svg('circle', { r: 0.018, fill: colour, class: 'calib-handle' });
      c.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        this.selected = i;
        this.dragging = i;
        this.svgEl.setPointerCapture(ev.pointerId);
        this.svgEl.focus();
        this.render();
      });
      this.handles.push(c);
      this.svgEl.append(c);
    });
    this.svgEl.addEventListener('pointermove', (ev) => this.onDrag(ev));
    this.svgEl.addEventListener('pointerup', () => (this.dragging = -1));
    this.svgEl.addEventListener('pointercancel', () => (this.dragging = -1));
    this.svgEl.addEventListener('keydown', (ev) => this.onKey(ev));

    root.append(
      h(
        'div',
        { className: 'calib-toolbar' },
        h('label', {}, 'Profile ', this.select),
        this.newName,
        create,
        h('label', { title: 'Show the test pattern on the output while calibrating' }, this.calibrate, ' calibrate'),
        reset,
      ),
      this.svgEl,
      this.readout,
    );
    this.render();
  }

  /** Server's list of profiles (from the "profiles" message). */
  setProfiles(names: string[], current: string): void {
    this.profileNames = names;
    this.profileName = current;
    this.renderSelect();
  }

  /**
   * `external` is false for echoes of our own patches: those are already shown, and
   * adopting them would undo nudges made since (they arrive a round trip late).
   */
  update(doc: SyncDoc, external: boolean): void {
    const profileChanged = doc.profile.name !== this.profileName;
    this.profileName = doc.profile.name;
    if ((external || profileChanged) && this.dragging < 0) this.corners = doc.profile.corners;
    this.calibrating = doc.session.testPattern;
    this.calibrate.checked = this.calibrating;
    this.renderSelect();
    this.render();
  }

  private renderSelect(): void {
    const names = this.profileNames.includes(this.profileName) ? this.profileNames : [...this.profileNames, this.profileName];
    this.select.replaceChildren(...names.filter(Boolean).map((n) => h('option', { value: n, textContent: n, selected: n === this.profileName })));
  }

  private createProfile(): void {
    const name = this.newName.value.trim();
    if (!PROJECT_NAME_RE.test(name)) {
      this.showError('Profile names use letters, digits, spaces, "-" and "_" (up to 64 characters).');
      return;
    }
    this.send({ t: 'createProfile', name });
    this.newName.value = '';
  }

  private toView(ev: PointerEvent): [number, number] | null {
    const ctm = this.svgEl.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  }

  private onDrag(ev: PointerEvent): void {
    if (this.dragging < 0) return;
    const p = this.toView(ev);
    if (!p) return;
    const x = p[0];
    const y = p[1] / ASPECT;
    this.move(this.dragging, Math.min(Math.max(x, -1), 2), Math.min(Math.max(y, -1), 2));
  }

  private onKey(ev: KeyboardEvent): void {
    const step = ev.shiftKey ? NUDGE * 10 : NUDGE;
    // One output pixel is 1/1920 of the width but 1/1080 of the height.
    const dy = ev.shiftKey ? 10 / 1080 : 1 / 1080;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -dy], ArrowDown: [0, dy] };
    if (ev.key === 'Tab') return;
    if (/^[1-4]$/.test(ev.key)) {
      this.selected = Number(ev.key) - 1;
      this.render();
      ev.preventDefault();
      return;
    }
    const delta = d[ev.key];
    if (!delta) return;
    ev.preventDefault();
    const [x, y] = this.corners[this.selected]!;
    this.move(this.selected, x + delta[0], y + delta[1]);
  }

  private move(i: number, x: number, y: number): void {
    const next = this.corners.map((c, j) => (j === i ? [x, y] : [c[0], c[1]])) as unknown as Corners;
    if (!isConvexQuad(next as unknown as Quad)) return; // never send a folded shape
    this.commit(next);
  }

  private commit(next: Corners): void {
    this.corners = next;
    this.render();
    this.sendPatch([{ op: 'set', path: ['profile', 'corners'], value: next.map(([x, y]) => [round(x), round(y)]) }]);
  }

  private render(): void {
    const ys = ASPECT;
    const pts = this.corners.map(([x, y]) => `${x},${y * ys}`).join(' ');
    this.quadEl.setAttribute('points', pts);
    this.corners.forEach(([x, y], i) => {
      const c = this.handles[i]!;
      c.setAttribute('cx', String(x));
      c.setAttribute('cy', String(y * ys));
      c.setAttribute('stroke', i === this.selected ? '#ffffff' : 'none');
      c.setAttribute('stroke-width', '0.008');
    });
    const [sx, sy] = this.corners[this.selected]!;
    this.readout.textContent =
      `Selected: ${CORNER_NAMES[this.selected]} (${Math.round(sx * 1920)}, ${Math.round(sy * 1080)}) px. ` +
      'Drag a handle, or click one and use the arrow keys (shift: 10 px, 1–4 picks a corner).';
  }
}

function round(v: number): number {
  return Math.round(v * 100_000) / 100_000;
}
