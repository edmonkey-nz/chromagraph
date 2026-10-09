import {
  cameraPatch,
  GIZMO_MODES,
  GIZMO_TITLES,
  gizmoModeForKey,
  LatestThrottle,
  parsePreviewMessage,
  SNAP_LEVELS,
  snapFor,
  snapLabel,
  transformPatch,
  type SnapLevel,
} from '../../shared/editor-helpers.ts';
import { unwrap, wrap, type ControlToPreview, type GizmoMode } from '../../shared/editor-protocol.ts';
import type { Camera } from '../../shared/project-schema.ts';
import type { LayerTransform } from '../../shared/layer-schema.ts';
import type { PatchOp } from '../../shared/patch.ts';
import type { SyncDoc } from '../../shared/project-schema.ts';

/**
 * Control side of the preview editor (`shared/editor-protocol.ts`). Owns edit mode, the
 * selected layer, the gizmo mode and snap; tells the preview iframe about them with `edit`
 * messages; and turns the preview's `transform` / `camera` reports into patches (throttled
 * to ~30 Hz, the final one always sent), so the server stays the only writer.
 */

export interface EditModeDeps {
  sendPatch(ops: PatchOp[]): void;
  getDoc(): SyncDoc | null;
  /** The preview iframe, or null while the preview is hidden. */
  frame(): HTMLIFrameElement | null;
  /** Show the preview (edit mode needs it). */
  showPreview(): void;
  /** Highlight the selected layer in the Layers panel; `reveal` expands and scrolls to it. */
  showSelection(layerId: string | null, reveal: boolean): void;
}

export interface EditModeElements {
  toggle: HTMLInputElement;
  modes: HTMLElement;
  snap: HTMLSelectElement;
  badge: HTMLElement;
}

/** Patches from a drag go out at most this often (~30 Hz). */
const SEND_INTERVAL_MS = 33;

export class EditMode {
  private enabled = false;
  private layerId: string | null = null;
  private mode: GizmoMode = 'translate';
  private snap: SnapLevel = 'off';
  private modeButtons = new Map<GizmoMode, HTMLButtonElement>();
  private pendingLayer: string | null = null;
  private transforms = new LatestThrottle<{ layerId: string; transform: LayerTransform }>(SEND_INTERVAL_MS, (v) => this.sendTransform(v));
  private cameras = new LatestThrottle<Camera>(SEND_INTERVAL_MS, (c) => this.sendCamera(c));

  constructor(
    private el: EditModeElements,
    private deps: EditModeDeps,
  ) {
    el.toggle.addEventListener('change', () => this.setEnabled(el.toggle.checked));
    for (const mode of GIZMO_MODES) {
      const { title, key } = GIZMO_TITLES[mode];
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = title;
      b.title = `${title} (${key.toUpperCase()})`;
      b.addEventListener('click', () => this.setMode(mode));
      this.modeButtons.set(mode, b);
      el.modes.append(b);
    }
    el.snap.replaceChildren(
      ...SNAP_LEVELS.map((level) => {
        const o = document.createElement('option');
        o.value = level;
        o.textContent = level;
        return o;
      }),
    );
    el.snap.addEventListener('change', () => this.setSnap(el.snap.value as SnapLevel));
    window.addEventListener('message', (ev) => this.onMessage(ev));
    window.addEventListener('keydown', (ev) => this.onKey(ev));
    this.render();
  }

  get selected(): string | null {
    return this.layerId;
  }

  // ---- state changes ---------------------------------------------------------------------

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.deps.showPreview();
      // Start with something to edit.
      const first = this.deps.getDoc()?.project.layers[0];
      if (this.layerId === null && first) this.select(first.id, false);
    } else {
      this.transforms.flush();
      this.cameras.flush();
    }
    this.changed();
  }

  setMode(mode: GizmoMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.changed();
  }

  setSnap(level: SnapLevel): void {
    if (level === this.snap || !SNAP_LEVELS.includes(level)) return;
    this.snap = level;
    this.changed();
  }

  /** Select a layer (null clears). `reveal` expands and scrolls to it in the Layers panel. */
  select(layerId: string | null, reveal = false): void {
    const doc = this.deps.getDoc();
    const id = layerId !== null && doc && !doc.project.layers.some((l) => l.id === layerId) ? null : layerId;
    this.deps.showSelection(id, reveal);
    if (id === this.layerId) return;
    this.layerId = id;
    this.changed();
  }

  /** Reconcile with the synced document: a deleted selected layer is deselected. */
  update(doc: SyncDoc): void {
    if (this.layerId !== null && !doc.project.layers.some((l) => l.id === this.layerId)) this.select(null);
    else this.render();
  }

  /** The preview iframe was (re)created or removed: drop edit mode when it went away. */
  previewChanged(visible: boolean): void {
    if (!visible) this.setEnabled(false);
  }

  private changed(): void {
    this.render();
    this.sendEdit();
  }

  // ---- messages ----------------------------------------------------------------------------

  private message(): ControlToPreview {
    return { t: 'edit', enabled: this.enabled, layerId: this.layerId, mode: this.mode, snap: snapFor(this.mode, this.snap) };
  }

  private sendEdit(): void {
    try {
      this.deps.frame()?.contentWindow?.postMessage(wrap(this.message()), location.origin);
    } catch (err) {
      console.warn('edit message not delivered', err);
    }
  }

  private onMessage(ev: MessageEvent): void {
    const frame = this.deps.frame();
    if (!frame || ev.source !== frame.contentWindow) return;
    const msg = parsePreviewMessage(unwrap(ev));
    if (!msg) return;
    switch (msg.t) {
      case 'ready':
        this.sendEdit();
        return;
      case 'select':
        this.select(msg.layerId, true);
        return;
      case 'transform':
        // A drag on a different layer: send what is waiting for the old one first.
        if (this.pendingLayer !== null && this.pendingLayer !== msg.layerId) this.transforms.flush();
        this.pendingLayer = msg.layerId;
        this.transforms.push({ layerId: msg.layerId, transform: msg.transform }, msg.final);
        return;
      case 'camera':
        this.cameras.push(msg.camera, msg.final);
        return;
    }
  }

  /** Index resolved by id at send time; invalid or no-op transforms are dropped quietly. */
  private sendTransform(v: { layerId: string; transform: LayerTransform }): void {
    this.pendingLayer = null;
    const doc = this.deps.getDoc();
    const ops = doc ? transformPatch(doc.project, v.layerId, v.transform) : null;
    if (ops) this.deps.sendPatch(ops);
  }

  private sendCamera(camera: Camera): void {
    const doc = this.deps.getDoc();
    const ops = doc ? cameraPatch(doc.project, camera) : null;
    if (ops) this.deps.sendPatch(ops);
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.enabled || ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
    const t = ev.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (t instanceof HTMLElement && t.isContentEditable) return;
    const mode = gizmoModeForKey(ev.key);
    if (!mode) return;
    ev.preventDefault();
    this.setMode(mode);
  }

  // ---- rendering -----------------------------------------------------------------------------

  private render(): void {
    const { toggle, snap, badge } = this.el;
    toggle.checked = this.enabled;
    document.body.classList.toggle('editing', this.enabled);
    for (const [mode, b] of this.modeButtons) {
      b.classList.toggle('active', mode === this.mode);
      b.setAttribute('aria-pressed', String(mode === this.mode));
    }
    snap.value = this.snap;
    const layer = this.deps.getDoc()?.project.layers.find((l) => l.id === this.layerId);
    const target = layer ? `“${layer.name || layer.id}”` : 'no layer selected (click a layer in the Layers tab)';
    badge.textContent = `Editing · ${GIZMO_TITLES[this.mode].title} · snap ${snapLabel(this.mode, this.snap)} · ${target}`;
  }
}
