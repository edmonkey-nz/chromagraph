import type { FolderApi } from 'tweakpane';
import type { PatchOp } from '../../shared/patch.ts';
import type { Camera, SyncDoc } from '../../shared/project-schema.ts';

/**
 * "Camera" card. Follows camera changes from the preview (orbit, zoom and pan in edit mode),
 * which echo back with our own origin, unless the user is typing or dragging in it.
 */

const MODULATED_SUFFIX = ' ~';
const FIELDS = ['fov', 'yaw', 'pitch', 'distance'] as const;

export class CameraPanel {
  private cam = { mode: '2d' as Camera['mode'], fov: 45, yaw: 0, pitch: 0, distance: 1, target: { x: 0, y: 0, z: 0 } };
  private quietDepth = 0;
  private dragging = false;
  private seen: Camera | null = null;
  private seenParams: SyncDoc['project']['parameters'] | null = null;
  private labelled: { api: { label: string | null | undefined }; label: string; ids: string[] }[] = [];

  constructor(
    private root: FolderApi,
    private sendPatch: (ops: PatchOp[]) => void,
  ) {
    const cam = this.cam;
    const set = (field: keyof Camera, value: unknown) => {
      if (this.quietDepth === 0) this.sendPatch([{ op: 'set', path: ['project', 'camera', field], value }]);
    };
    root
      .addBinding(cam, 'mode', { options: [{ text: '2D', value: '2d' }, { text: '3D', value: '3d' }] })
      .on('change', (ev) => set('mode', ev.value));
    const ranges: Record<(typeof FIELDS)[number], { min: number; max: number; step: number }> = {
      fov: { min: 5, max: 120, step: 1 },
      yaw: { min: -180, max: 180, step: 0.5 },
      pitch: { min: -89, max: 89, step: 0.5 },
      distance: { min: 0.2, max: 5, step: 0.01 },
    };
    for (const f of FIELDS) {
      const api = root.addBinding(cam, f, ranges[f]).on('change', (ev) => set(f, ev.value));
      this.labelled.push({ api, label: f, ids: [`camera.${f}`] });
    }
    const target = root.addBinding(cam, 'target').on('change', (ev) => set('target', [ev.value.x, ev.value.y, ev.value.z]));
    this.labelled.push({ api: target, label: 'target', ids: [0, 1, 2].map((i) => `camera.target.${i}`) });

    root.element.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointercancel', () => (this.dragging = false));
  }

  update(doc: SyncDoc, external: boolean): void {
    const c = doc.project.camera;
    if (doc.project.parameters !== this.seenParams) {
      this.seenParams = doc.project.parameters;
      const p = doc.project.parameters;
      for (const l of this.labelled) l.api.label = l.ids.some((id) => p[id]) ? l.label + MODULATED_SUFFIX : l.label;
    }
    if (c === this.seen) return;
    this.seen = c;
    if (!external) {
      const a = document.activeElement;
      if (this.dragging || (a instanceof HTMLInputElement && this.root.element.contains(a))) return;
    }
    Object.assign(this.cam, { mode: c.mode, fov: c.fov, yaw: c.yaw, pitch: c.pitch, distance: c.distance });
    this.cam.target = { x: c.target[0], y: c.target[1], z: c.target[2] };
    this.quietDepth++;
    try {
      this.root.refresh();
    } finally {
      this.quietDepth--;
    }
  }
}
