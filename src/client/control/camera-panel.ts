import type { BladeApi, ButtonApi, FolderApi } from 'tweakpane';
import {
  CAMERA_MOTION_TITLES,
  CAMERA_MOTIONS,
  cameraLoopSeconds,
  cameraMotionOps,
  detectCameraMotion,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  type CameraMotion,
} from '../../shared/camera-motion.ts';
import { formatClock } from '../../shared/modulation-helpers.ts';
import { clockMs, seekClock, setClockPlaying, wallMs, type Clock } from '../../shared/modulators.ts';
import type { PatchOp } from '../../shared/patch.ts';
import { defaultCamera, type Camera, type SyncDoc } from '../../shared/project-schema.ts';
import { SCRUB_INTERVAL_MS } from './timeline-panel.ts';

/**
 * "Camera" card. Follows camera changes from the preview (orbit, zoom and pan in edit mode),
 * which echo back with our own origin, unless the user is typing or dragging in it.
 *
 * Motion: camera move presets with a speed (shared/camera-motion.ts). They are camera
 * modulators, so they also show (and can be fine-tuned) in the Modulation card. Below them,
 * the camera clock (session.cameraClock) that the moves run on: Play/Pause, Reset (back to
 * the start of the move, the framing set above) and a position slider over one loop of the
 * move (cameraLoopSeconds). Like the timeline's phase slider, it follows the clock locally
 * (`tick`) and only a drag sends, at most every SCRUB_INTERVAL_MS.
 *
 * Depth of field (DofSchema, 3D only): moving a slider while it is off switches it on, as
 * the layers' effect folders do.
 */

const MODULATED_SUFFIX = ' ~';
/** The classic isometric view: pitch atan(1 / sqrt 2), so the three axes look equally foreshortened. */
const ISOMETRIC_VIEW: [keyof Camera, unknown][] = [
  ['mode', '3d'],
  ['projection', 'isometric'],
  ['yaw', 45],
  ['pitch', 35.26],
];
const FIELDS = ['fov', 'yaw', 'pitch', 'distance'] as const;

/** "0:23 / 1:00"; tenths of a second for a loop under a minute ("3.2 / 16.0 s"). */
function formatLoop(sec: number, loopSec: number): string {
  if (loopSec < 60) return `${sec.toFixed(1)} / ${loopSec.toFixed(1)} s`;
  return `${formatClock(sec, loopSec)} / ${formatClock(loopSec)}`;
}

export class CameraPanel {
  private cam = { mode: '2d' as Camera['mode'], projection: 'perspective' as Camera['projection'], fov: 45, yaw: 0, pitch: 0, distance: 1, target: { x: 0, y: 0, z: 0 } };
  private quietDepth = 0;
  private dragging = false;
  private seen: Camera | null = null;
  private seenParams: SyncDoc['project']['parameters'] | null = null;
  private labelled: { api: { label: string | null | undefined }; label: string; ids: string[] }[] = [];
  private motion = { preset: 'none' as CameraMotion | 'custom', speed: 1 };
  private motionFolder: FolderApi;
  private speedApi: BladeApi;
  private doc: SyncDoc | null = null;
  private dof = { enabled: false, focus: 0, depth: 200, amount: 12 };
  /** The camera clock: the synced one, or the one we just sent (until it echoes). */
  private clock: Clock | null = null;
  private seenClock: Clock | null = null;
  /** Seconds one loop of the current move lasts (the position slider's span). */
  private loopSeconds = 60;
  /** Seconds into the current loop. */
  private clockModel = { position: 0 };
  private clockApis: BladeApi[] = [];
  private playButton: ButtonApi;
  private positionApi: BladeApi & { refresh(): void };
  /** The loop length the position slider was built for (its max). */
  private positionLoop = 0;
  private scrubbing = false;
  private lastScrubMs = 0;

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
    root
      .addBinding(cam, 'projection', {
        options: [
          { text: 'perspective', value: 'perspective' },
          { text: 'isometric', value: 'isometric' },
        ],
      })
      .on('change', (ev) => set('projection', ev.value)).element.title =
      '3D only. Isometric is orthographic: parallel edges stay parallel and distance zooms the view';
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

    root.addButton({ title: 'Isometric view' }).on('click', () => {
      const ops: PatchOp[] = [];
      for (const [field, value] of ISOMETRIC_VIEW) ops.push({ op: 'set', path: ['project', 'camera', field], value });
      this.sendPatch(ops);
    }).element.title = '3D, isometric projection, yaw 45°, pitch 35.26° (the classic isometric angle)';
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
    const mf = this.motionFolder;
    const clockApi = <T extends BladeApi>(api: T, hint: string): T => {
      api.element.title = hint;
      this.clockApis.push(api);
      return api;
    };
    clockApi(mf.addBlade({ view: 'separator' }), '');
    this.playButton = clockApi(mf.addButton({ title: 'Pause', label: 'clock' }), 'Pause or play the camera move (the scene timeline is not affected)');
    this.playButton.on('click', () => this.togglePlay());
    clockApi(mf.addButton({ title: 'Reset', label: '' }), 'Back to the start of the move: the framing set above').on('click', () => this.seekTo(0));
    this.positionApi = this.buildPosition();
    window.addEventListener('pointerup', () => (this.scrubbing = false));
    window.addEventListener('pointercancel', () => (this.scrubbing = false));
    this.renderMotion();

    const dofFolder = root.addFolder({ title: 'Depth of field', expanded: false });
    const dof = this.dof;
    const setDof = (field: keyof Camera['dof'], value: unknown) => {
      if (this.quietDepth > 0) return;
      const ops: PatchOp[] = [{ op: 'set', path: ['project', 'camera', 'dof', field], value }];
      if (field !== 'enabled' && !dof.enabled) {
        dof.enabled = true;
        ops.push({ op: 'set', path: ['project', 'camera', 'dof', 'enabled'], value: true });
        this.quietDepth++;
        try {
          dofFolder.refresh();
        } finally {
          this.quietDepth--;
        }
      }
      this.sendPatch(ops);
    };
    dofFolder.addBinding(dof, 'enabled', { label: 'on' }).on('change', (ev) => setDof('enabled', ev.value)).element.title =
      '3D camera only. Blurs what is nearer or further than the focus. Layers fixed to the screen stay sharp, on top';
    const dofSliders: [keyof typeof dof & ('focus' | 'depth' | 'amount'), string, { min: number; max: number; step: number }, string][] = [
      ['focus', 'focus', { min: -2000, max: 2000, step: 1 }, 'Where the sharp plane is: px from the camera target, + further away'],
      ['depth', 'sharp depth', { min: 0, max: 2000, step: 1 }, 'How deep the sharp zone is (px); the blur then grows over the same depth again'],
      ['amount', 'blur', { min: 0, max: 40, step: 0.5 }, 'Most blur, in px at 1080p'],
    ];
    for (const [field, label, range, hint] of dofSliders) {
      const api = dofFolder.addBinding(dof, field, { label, ...range }).on('change', (ev) => setDof(field, ev.value));
      api.element.title = hint;
      this.labelled.push({ api, label, ids: [`camera.dof.${field}`] });
    }
    dofFolder.addButton({ title: 'Focus on target' }).on('click', () => setDof('focus', 0)).element.title =
      'Put the sharp plane through the camera target (the point it orbits)';

    root.element.addEventListener('pointerdown', () => (this.dragging = true));
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointercancel', () => (this.dragging = false));
  }

  private sendMotion(preset: CameraMotion, speed: number): void {
    if (this.quietDepth > 0 || !this.doc) return;
    const clock = this.clock ?? this.doc.session.cameraClock;
    const ops = cameraMotionOps(this.doc.project, preset, speed, { clock, nowMs: wallMs() });
    if (ops.length === 0) return;
    for (const op of ops) if (op.op === 'set' && op.path[0] === 'session' && op.path[1] === 'cameraClock') this.clock = op.value as Clock;
    this.sendPatch(ops);
  }

  /** Speed only applies to a preset; it is greyed out for none / custom. The clock only matters with LFO or noise moves. */
  private renderMotion(): void {
    this.speedApi.disabled = this.motion.preset === 'none' || this.motion.preset === 'custom';
    const params = this.doc?.project.parameters ?? {};
    const moving = Object.entries(params).some(([id, p]) => id.startsWith('camera.') && (p.modulator.kind === 'lfo' || p.modulator.kind === 'noise'));
    for (const api of this.clockApis) api.disabled = !moving;
  }

  // ---- the camera clock ------------------------------------------------------------------

  /**
   * The position slider, in seconds over one loop. Tweakpane fixes a slider's range when it is
   * made, so a new loop length (preset or speed) replaces it in place.
   */
  private buildPosition(): BladeApi & { refresh(): void } {
    const mf = this.motionFolder;
    const old = this.positionApi as (BladeApi & { refresh(): void }) | undefined;
    const index = old ? mf.children.indexOf(old) : mf.children.length;
    if (old) {
      this.clockApis = this.clockApis.filter((a) => a !== old);
      old.dispose();
    }
    const loop = this.loopSeconds;
    this.positionLoop = loop;
    this.clockModel.position = Math.min(this.clockModel.position, loop);
    const api = mf
      .addBinding(this.clockModel, 'position', { label: 'position', min: 0, max: loop, step: 0.01, index, format: (v: number) => formatLoop(v, loop) })
      .on('change', (ev) => {
        if (this.quietDepth > 0) return;
        const now = wallMs();
        // Jog live while dragging (throttled); always send the final position.
        if (!ev.last && now - this.lastScrubMs < SCRUB_INTERVAL_MS) return;
        this.lastScrubMs = now;
        this.seekTo(ev.value);
      });
    api.element.title = 'Where the camera is in one loop of its move (seconds). Drag to jog';
    api.element.addEventListener('pointerdown', () => (this.scrubbing = true));
    this.clockApis.push(api);
    return api;
  }

  /** Move the position slider on (call about 10 times a second). Sends nothing. */
  tick(nowMs: number): void {
    const clock = this.clock;
    if (!clock || !this.motionFolder.expanded) return;
    const loop = this.loopSeconds;
    const interacting = this.scrubbing || this.editingText(this.positionApi);
    if (loop !== this.positionLoop && !interacting) {
      this.positionApi = this.buildPosition();
      this.renderMotion();
    }
    if (interacting) return;
    const t = clockMs(clock, nowMs) / 1000;
    const within = ((t % loop) + loop) % loop;
    this.quiet(() => {
      this.clockModel.position = within;
      this.positionApi.refresh();
    });
  }

  private togglePlay(): void {
    const clock = this.clock;
    if (!clock || this.quietDepth > 0) return;
    this.sendClock(setClockPlaying(clock, !clock.playing, wallMs()));
  }

  private seekTo(seconds: number): void {
    const clock = this.clock;
    if (!clock || this.quietDepth > 0) return;
    this.sendClock(seekClock(clock, seconds, wallMs()));
  }

  private sendClock(next: Clock): void {
    this.clock = next;
    this.playButton.title = next.playing ? 'Pause' : 'Play';
    this.sendPatch([{ op: 'set', path: ['session', 'cameraClock'], value: next }]);
    this.tick(wallMs());
  }

  private quiet(fn: () => void): void {
    this.quietDepth++;
    try {
      fn();
    } finally {
      this.quietDepth--;
    }
  }

  private editingText(api: BladeApi): boolean {
    const a = document.activeElement;
    return a instanceof HTMLInputElement && api.element.contains(a);
  }

  update(doc: SyncDoc, external: boolean): void {
    this.doc = doc;
    if (doc.session.cameraClock !== this.seenClock) {
      this.seenClock = doc.session.cameraClock;
      this.clock = doc.session.cameraClock;
      this.playButton.title = this.clock.playing ? 'Pause' : 'Play';
    }
    const c = doc.project.camera;
    if (doc.project.parameters !== this.seenParams) {
      this.seenParams = doc.project.parameters;
      const p = doc.project.parameters;
      for (const l of this.labelled) l.api.label = l.ids.some((id) => p[id]) ? l.label + MODULATED_SUFFIX : l.label;
      this.loopSeconds = cameraLoopSeconds(p);
      this.renderMotion();
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
    Object.assign(this.cam, { mode: c.mode, projection: c.projection, fov: c.fov, yaw: c.yaw, pitch: c.pitch, distance: c.distance });
    this.cam.target = { x: c.target[0], y: c.target[1], z: c.target[2] };
    Object.assign(this.dof, c.dof);
    this.quietDepth++;
    try {
      this.root.refresh();
    } finally {
      this.quietDepth--;
    }
  }
}
