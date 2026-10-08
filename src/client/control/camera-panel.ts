import type { BladeApi, FolderApi } from 'tweakpane';
import {
  CAMERA_MOTION_TITLES,
  CAMERA_MOTIONS,
  cameraMotionOps,
  detectCameraMotion,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  type CameraMotion,
} from '../../shared/camera-motion.ts';
import { wallMs } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import { defaultCamera, type Camera, type SyncDoc } from '../../shared/project-schema.ts';

/**
 * "Camera" card. Follows camera changes from the preview (orbit, zoom and pan in edit mode),
 * which echo back with our own origin, unless the user is typing or dragging in it.
 *
 * Motion: camera move presets with a speed (shared/camera-motion.ts). They are camera
 * modulators, so they also show (and can be fine-tuned) in the Modulation card.
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
  private motion = { preset: 'none' as CameraMotion | 'custom', speed: 1 };
  private motionFolder: FolderApi;
  private speedApi: BladeApi;
  private doc: SyncDoc | null = null;

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

    root.addButton({ title: 'Reset view' }).on('click', () => {
      const d = defaultCamera();
      this.sendPatch((['fov', 'yaw', 'pitch', 'distance', 'target'] as const).map((f) => ({ op: 'set', path: ['project', 'camera', f], value: d[f] })));
    });

    this.motionFolder = root.addFolder({ title: 'Motion', expanded: true });
    const presetOptions = [
      ...CAMERA_MOTIONS.map((m) => ({ text: CAMERA_MOTION_TITLES[m], value: m as CameraMotion | 'custom' })),
      { text: 'custom (edited in Modulation)', value: 'custom' as const },
    ];
    this.motionFolder
      .addBinding(this.motion, 'preset', { label: 'preset', options: presetOptions })
      .on('change', (ev) => {
        if (ev.value !== 'custom') this.sendMotion(ev.value, this.motion.speed);
        this.renderMotion();
      });
    this.speedApi = this.motionFolder
      .addBinding(this.motion, 'speed', { label: 'speed', min: SPEED_MIN, max: SPEED_MAX, step: SPEED_STEP, format: (v: number) => `${v.toFixed(2)}×` })
      .on('change', (ev) => {
        const preset = this.motion.preset;
        if (preset !== 'custom' && preset !== 'none') this.sendMotion(preset, ev.value);
      });
    this.renderMotion();

    root.element.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointercancel', () => (this.dragging = false));
  }

  private sendMotion(preset: CameraMotion, speed: number): void {
    if (this.quietDepth > 0 || !this.doc) return;
    const ops = cameraMotionOps(this.doc.project, preset, speed, wallMs());
    if (ops.length > 0) this.sendPatch(ops);
  }

  /** Speed only applies to a preset; it is greyed out for none / custom. */
  private renderMotion(): void {
    this.speedApi.disabled = this.motion.preset === 'none' || this.motion.preset === 'custom';
  }

  update(doc: SyncDoc, external: boolean): void {
    this.doc = doc;
    const c = doc.project.camera;
    if (doc.project.parameters !== this.seenParams) {
      this.seenParams = doc.project.parameters;
      const p = doc.project.parameters;
      for (const l of this.labelled) l.api.label = l.ids.some((id) => p[id]) ? l.label + MODULATED_SUFFIX : l.label;
      const found = detectCameraMotion(p);
      // Our own echo while the speed slider is held would pull it back to an older value.
      const holding = !external && this.dragging;
      if (!holding && (found.motion !== this.motion.preset || (found.speed !== null && Math.abs(found.speed - this.motion.speed) > 1e-6))) {
        this.motion.preset = found.motion;
        if (found.speed !== null) this.motion.speed = found.speed;
        this.quietDepth++;
        try {
          this.motionFolder.refresh();
        } finally {
          this.quietDepth--;
        }
        this.renderMotion();
      }
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
