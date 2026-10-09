import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderTarget,
  Color,
  type OrthographicCamera,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { cameraFromOrbit, gizmoSnap, orbitFromCamera, PITCH_LIMIT, proxyFromTransform, Throttle, transformFromProxy } from '../../shared/editor-maths.ts';
import { unwrap, wrap, type ControlToPreview, type GizmoMode, type PreviewToControl } from '../../shared/editor-protocol.ts';
import type { LayerConfig } from '../../shared/layer-schema.ts';
import type { LayerTransform } from '../../shared/layer-schema.ts';
import { defaultDof, type Camera, type SyncDoc } from '../../shared/project-schema.ts';
import { applyLayerTransform } from './layers/transform.ts';
import { OUTPUT_HEIGHT, OUTPUT_WIDTH, type Stage } from './stage.ts';

/*
 * Direct-manipulation editor for the control window's embedded preview (`/output/?preview`).
 * It is only ever created in preview mode: the real output never shows editor UI.
 *
 * The preview never patches state. It reports drags to the control window (editor-protocol)
 * and, so the picture follows the mouse without waiting for the round trip, applies the
 * dragged transform / camera locally, ignoring echoes of stale state until shortly after
 * the final message.
 *
 * Everything here is fenced: nothing may throw into the render loop.
 */

const SEND_INTERVAL_MS = 33; // ~30 Hz
/** How long after a final message incoming state is ignored for what was dragged. */
const GRACE_MS = 500;
/** Wheel zoom sends `end` per notch; the final camera message waits for the wheel to settle. */
const CAMERA_FINAL_DELAY_MS = 150;
/** A press that moves less than this (CSS px) is a click. */
const CLICK_SLOP_PX = 4;
const PICK_SIZE = 4; // output px square read back around the pointer
const OUTLINE_COLOUR = 0xffb000;
const MODES: readonly GizmoMode[] = ['translate', 'rotate', 'scale'];

export interface EditorHost {
  canvas: HTMLCanvasElement;
  getStage(): Stage | null;
  getDoc(): SyncDoc | null;
  /** The built scene object of a layer, or null if it is not built (or failed). */
  getLayerObject(id: string): Object3D | null;
}

/** Per-stage GPU and DOM state, built when editing turns on and disposed when it turns off. */
interface Tools {
  stage: Stage;
  overlay: Scene;
  proxy: Object3D;
  gizmo: TransformControls;
  orbit: OrbitControls;
  orbitCamera: PerspectiveCamera;
  outline: LineSegments;
  pickTarget: WebGLRenderTarget | null;
  detach: () => void;
}

export class PreviewEditor {
  private edit: ControlToPreview = { t: 'edit', enabled: false, layerId: null, mode: 'translate', snap: 0 };
  private tools: Tools | null = null;

  // Gizmo drag state.
  private dragging = false;
  private dragLayerId: string | null = null;
  private dragPivot: [number, number, number] = [0, 0, 0];
  private dragRefRotation: [number, number, number] = [0, 0, 0];
  /** The transform being shown for `dragLayerId` instead of the state's. */
  private dragTransform: LayerTransform | null = null;
  private dragUntil = 0;
  private proxySource: LayerTransform | null = null;
  private proxyLayerId: string | null = null;

  // Orbit state.
  private orbiting = false;
  private orbitMoved = false;
  private orbitRefYaw = 0;
  /** The projection of the camera being orbited (kept: zooming an isometric view scales it). */
  private orbitProjection: Camera['projection'] = 'perspective';
  private orbitDof: Camera['dof'] = defaultDof();
  private cameraOverride: Camera | null = null;
  private cameraUntil = 0;
  private cameraFinalTimer: ReturnType<typeof setTimeout> | null = null;

  // Click-to-select.
  private down: { x: number; y: number; onGizmo: boolean } | null = null;
  private pickBuffer = new Uint8Array(PICK_SIZE * PICK_SIZE * 4);
  private clearColour = new Color();

  private transformThrottle = new Throttle<{ layerId: string; transform: LayerTransform }>(SEND_INTERVAL_MS, (m) =>
    this.post({ t: 'transform', layerId: m.layerId, transform: m.transform, final: false }),
  );
  private cameraThrottle = new Throttle<Camera>(SEND_INTERVAL_MS, (camera) => this.post({ t: 'camera', camera, final: false }));
  private lastWarning = '';

  constructor(private host: EditorHost) {
    window.addEventListener('message', this.onMessage);
    this.post({ t: 'ready' });
  }

  // ---- public hooks (called from the render loop; each one fenced) -----------------

  /** Before the scene renders: reassert local overrides and keep the tools in step with state. */
  frame(): void {
    try {
      this.frameUnsafe();
    } catch (err) {
      this.warn('frame', err);
    }
  }

  /** After the scene (and warp) has been drawn to the screen: draw the gizmo and outline on top. */
  renderOverlay(): void {
    const tools = this.tools;
    if (!tools || tools.stage.contextLost) return;
    const renderer = tools.stage.renderer;
    const autoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(tools.overlay, tools.gizmo.camera);
    } catch (err) {
      this.warn('overlay', err);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage);
    this.teardown();
  }

  // ---- messages ----------------------------------------------------------------------

  private onMessage = (ev: MessageEvent): void => {
    try {
      const msg = unwrap<ControlToPreview>(ev);
      if (!msg || msg.t !== 'edit') return;
      if (typeof msg.enabled !== 'boolean') return;
      this.edit = {
        t: 'edit',
        enabled: msg.enabled,
        layerId: typeof msg.layerId === 'string' ? msg.layerId : null,
        mode: MODES.includes(msg.mode) ? msg.mode : 'translate',
        snap: typeof msg.snap === 'number' && Number.isFinite(msg.snap) ? msg.snap : 0,
      };
      if (!this.edit.enabled) {
        this.teardown();
        return;
      }
      if (this.tools) this.configureGizmo(this.tools);
      // Otherwise the next frame builds the tools (the stage may not exist yet).
    } catch (err) {
      this.warn('message', err);
    }
  };

  private post(msg: PreviewToControl): void {
    try {
      if (window.parent === window) return; // opened on its own: nobody to tell
      window.parent.postMessage(wrap(msg), location.origin);
    } catch (err) {
      this.warn('post', err);
    }
  }

  // ---- per frame -----------------------------------------------------------------------

  private frameUnsafe(): void {
    const now = performance.now();
    const stage = this.host.getStage();
    if (!this.edit.enabled || !stage) {
      if (this.tools) this.teardown();
      return;
    }
    if (this.tools && this.tools.stage !== stage) this.teardown();
    const tools = this.tools ?? (this.tools = this.build(stage));
    const doc = this.host.getDoc();
    const is3d = doc?.project.camera.mode === '3d';

    // Camera: drive the preview's camera directly while orbiting and just after.
    if (this.cameraOverride) {
      if (this.orbiting || this.cameraFinalTimer !== null || now < this.cameraUntil) {
        stage.setCamera(this.cameraOverride);
      } else {
        this.cameraOverride = null;
        if (doc) stage.setCamera(doc.project.camera);
      }
    }
    // A layer fixed to the screen is drawn with the screen camera; so are its gizmo and outline.
    const selected = doc && this.edit.layerId ? findLayer(doc, this.edit.layerId) : null;
    tools.gizmo.camera = selected?.screenFixed ? stage.orthoCamera : stage.camera;
    tools.orbit.enabled = is3d && !this.dragging;

    // The dragged layer keeps its dragged transform until shortly after the final message.
    if (this.dragTransform && this.dragLayerId) {
      const obj = this.host.getLayerObject(this.dragLayerId);
      if (this.dragging || now < this.dragUntil) {
        if (obj) applyLayerTransform(obj, this.dragTransform);
      } else {
        const stateLayer = doc ? findLayer(doc, this.dragLayerId) : null;
        if (obj && stateLayer) applyLayerTransform(obj, stateLayer.transform);
        this.dragTransform = null;
        this.dragLayerId = null;
        this.proxySource = null; // the gizmo goes back to wherever the state says
      }
    }

    const layer = doc && this.edit.layerId ? findLayer(doc, this.edit.layerId) : null;
    if (!layer) {
      if (tools.gizmo.object) tools.gizmo.detach();
      tools.outline.visible = false;
      this.proxySource = null;
      return;
    }

    // Gizmo proxy follows the state's transform unless it is the one being dragged.
    const holding = this.dragTransform !== null && this.dragLayerId === layer.id;
    if (!holding && (layer.transform !== this.proxySource || this.proxyLayerId !== layer.id)) {
      const p = proxyFromTransform(layer.transform);
      tools.proxy.position.set(p.position[0], p.position[1], p.position[2]);
      tools.proxy.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2], 'XYZ');
      tools.proxy.scale.set(p.scale[0], p.scale[1], p.scale[2]);
      tools.proxy.updateMatrixWorld();
      this.proxySource = layer.transform;
      this.proxyLayerId = layer.id;
    }
    if (tools.gizmo.object !== tools.proxy) tools.gizmo.attach(tools.proxy);

    // Outline: the layer's frame (0..1920 x 0..1080) under its current matrix. Instanced
    // layers position in the shader, so their geometry bounds say nothing about the data.
    const obj = this.host.getLayerObject(layer.id);
    if (obj) {
      tools.outline.matrixAutoUpdate = false;
      tools.outline.matrix.copy(obj.matrix);
      tools.outline.matrixWorldNeedsUpdate = true;
    } else {
      applyLayerTransform(tools.outline, holding && this.dragTransform ? this.dragTransform : layer.transform);
    }
    tools.outline.visible = true;
  }

  // ---- building and tearing down ---------------------------------------------------------

  private build(stage: Stage): Tools {
    const canvas = this.host.canvas;
    const overlay = new Scene();
    overlay.background = null;

    const outline = makeFrameOutline();
    overlay.add(outline);

    const proxy = new Object3D();
    proxy.name = 'editor-proxy';
    overlay.add(proxy);

    // The gizmo is created before the orbit controls so its pointerdown runs first and can
    // switch orbiting off before a drag on a handle starts an orbit as well.
    const gizmo = new TransformControls(stage.camera, canvas);
    gizmo.size = 0.8;
    overlay.add(gizmo.getHelper());

    const orbitCamera = new PerspectiveCamera(45, OUTPUT_WIDTH / OUTPUT_HEIGHT, 1, 100_000);
    const orbit = new OrbitControls(orbitCamera, canvas);
    orbit.enableDamping = false;
    orbit.screenSpacePanning = true;
    orbit.minPolarAngle = ((90 - PITCH_LIMIT) * Math.PI) / 180;
    orbit.maxPolarAngle = ((90 + PITCH_LIMIT) * Math.PI) / 180;
    orbit.enabled = false;

    const onDraggingChanged = (ev: { value: unknown }) => this.fenced('drag', () => this.onDraggingChanged(ev.value === true));
    const onObjectChange = () => this.fenced('drag', () => this.onGizmoChange());
    const onOrbitStart = () => this.fenced('orbit', () => this.onOrbitStart());
    const onOrbitChange = () => this.fenced('orbit', () => this.onOrbitChange());
    const onOrbitEnd = () => this.fenced('orbit', () => this.onOrbitEnd());
    const onPointerDown = (ev: PointerEvent) => this.fenced('pointer', () => this.onPointerDown(ev));
    const onPointerUp = (ev: PointerEvent) => this.fenced('pointer', () => this.onPointerUp(ev));

    gizmo.addEventListener('dragging-changed', onDraggingChanged);
    gizmo.addEventListener('objectChange', onObjectChange);
    orbit.addEventListener('start', onOrbitStart);
    orbit.addEventListener('change', onOrbitChange);
    orbit.addEventListener('end', onOrbitEnd);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);

    // The output hides the cursor; the editing preview needs it.
    document.documentElement.style.cursor = 'auto';
    document.body.style.cursor = 'auto';

    const tools: Tools = {
      stage,
      overlay,
      proxy,
      gizmo,
      orbit,
      orbitCamera,
      outline,
      pickTarget: null,
      detach: () => {
        gizmo.removeEventListener('dragging-changed', onDraggingChanged);
        gizmo.removeEventListener('objectChange', onObjectChange);
        orbit.removeEventListener('start', onOrbitStart);
        orbit.removeEventListener('change', onOrbitChange);
        orbit.removeEventListener('end', onOrbitEnd);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointerup', onPointerUp);
      },
    };
    this.configureGizmo(tools);
    return tools;
  }

  private configureGizmo(tools: Tools): void {
    const { mode, snap } = this.edit;
    tools.gizmo.setMode(mode);
    tools.gizmo.setTranslationSnap(gizmoSnap('translate', snap));
    tools.gizmo.setRotationSnap(gizmoSnap('rotate', snap));
    tools.gizmo.setScaleSnap(gizmoSnap('scale', snap));
    if (this.edit.layerId !== this.proxyLayerId) this.proxySource = null;
  }

  /** Dispose everything and hand the preview back to the synced state. */
  private teardown(): void {
    const tools = this.tools;
    this.tools = null;
    if (this.cameraFinalTimer !== null) clearTimeout(this.cameraFinalTimer);
    this.cameraFinalTimer = null;
    this.transformThrottle.clear();
    this.cameraThrottle.clear();
    const doc = this.host.getDoc();
    try {
      if (this.dragTransform && this.dragLayerId) {
        const obj = this.host.getLayerObject(this.dragLayerId);
        const layer = doc ? findLayer(doc, this.dragLayerId) : null;
        if (obj && layer) applyLayerTransform(obj, layer.transform);
      }
      if (this.cameraOverride && doc && tools) tools.stage.setCamera(doc.project.camera);
    } catch (err) {
      this.warn('teardown', err);
    }
    this.dragging = false;
    this.dragTransform = null;
    this.dragLayerId = null;
    this.orbiting = false;
    this.cameraOverride = null;
    this.proxySource = null;
    this.proxyLayerId = null;
    this.down = null;
    if (!tools) return;
    try {
      tools.detach();
      tools.gizmo.detach();
      tools.gizmo.getHelper().removeFromParent();
      tools.gizmo.dispose();
      tools.orbit.dispose();
      tools.outline.geometry.dispose();
      (tools.outline.material as LineBasicMaterial).dispose();
      tools.pickTarget?.dispose();
      tools.overlay.clear();
    } catch (err) {
      this.warn('teardown', err);
    }
    document.documentElement.style.cursor = '';
    document.body.style.cursor = '';
  }

  // ---- gizmo -----------------------------------------------------------------------------

  private onDraggingChanged(dragging: boolean): void {
    const tools = this.tools;
    if (!tools) return;
    const doc = this.host.getDoc();
    if (dragging) {
      const layer = doc && this.edit.layerId ? findLayer(doc, this.edit.layerId) : null;
      if (!layer) return;
      this.dragging = true;
      this.dragLayerId = layer.id;
      this.dragPivot = [...layer.transform.pivot];
      this.dragRefRotation = [...layer.transform.rotation];
      this.dragTransform = layer.transform;
      tools.orbit.enabled = false;
      this.transformThrottle.clear();
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    this.transformThrottle.clear();
    const layerId = this.dragLayerId;
    if (layerId && this.dragTransform) {
      this.dragTransform = this.readProxy(tools);
      this.post({ t: 'transform', layerId, transform: this.dragTransform, final: true });
    }
    this.dragUntil = performance.now() + GRACE_MS;
  }

  private onGizmoChange(): void {
    const tools = this.tools;
    if (!tools || !this.dragging || !this.dragLayerId) return;
    const t = this.readProxy(tools);
    this.dragTransform = t;
    const obj = this.host.getLayerObject(this.dragLayerId);
    if (obj) applyLayerTransform(obj, t); // follow the mouse now; the frame hook keeps it there
    this.transformThrottle.push({ layerId: this.dragLayerId, transform: t });
  }

  private readProxy(tools: Tools): LayerTransform {
    const { position: p, rotation: r, scale: s } = tools.proxy;
    return transformFromProxy([p.x, p.y, p.z], [r.x, r.y, r.z], [s.x, s.y, s.z], this.dragPivot, this.dragRefRotation);
  }

  // ---- orbit camera (3D only) ------------------------------------------------------------

  private onOrbitStart(): void {
    const tools = this.tools;
    const doc = this.host.getDoc();
    if (!tools || !doc || doc.project.camera.mode !== '3d') return;
    if (this.cameraFinalTimer !== null) {
      clearTimeout(this.cameraFinalTimer);
      this.cameraFinalTimer = null;
    } else {
      this.orbitMoved = false;
    }
    // Start from what the preview shows: the pending local camera, else the state's.
    const cfg = this.cameraOverride ?? doc.project.camera;
    const { position, target } = orbitFromCamera(cfg);
    const cam = tools.orbitCamera;
    cam.fov = cfg.fov;
    cam.up.set(0, 1, 0);
    cam.position.set(position[0], position[1], position[2]);
    tools.orbit.target.set(target[0], target[1], target[2]);
    cam.lookAt(tools.orbit.target);
    cam.updateProjectionMatrix();
    this.orbitRefYaw = cfg.yaw;
    this.orbitProjection = cfg.projection;
    this.orbitDof = { ...cfg.dof };
    this.orbiting = true;
  }

  private onOrbitChange(): void {
    const tools = this.tools;
    if (!tools || !this.orbiting) return;
    const p = tools.orbitCamera.position;
    const t = tools.orbit.target;
    const cfg = cameraFromOrbit([p.x, p.y, p.z], [t.x, t.y, t.z], tools.orbitCamera.fov, this.orbitRefYaw, this.orbitProjection, this.orbitDof);
    if (!cfg) return;
    this.orbitRefYaw = cfg.yaw;
    this.cameraOverride = cfg;
    this.orbitMoved = true;
    tools.stage.setCamera(cfg);
    this.cameraThrottle.push(cfg);
  }

  private onOrbitEnd(): void {
    if (!this.orbiting) return;
    this.orbiting = false;
    if (!this.orbitMoved) return;
    if (this.cameraFinalTimer !== null) clearTimeout(this.cameraFinalTimer);
    this.cameraFinalTimer = setTimeout(() => {
      this.cameraFinalTimer = null;
      this.fenced('orbit', () => {
        this.cameraThrottle.clear();
        if (this.cameraOverride) this.post({ t: 'camera', camera: this.cameraOverride, final: true });
        this.orbitMoved = false;
        this.cameraUntil = performance.now() + GRACE_MS;
      });
    }, CAMERA_FINAL_DELAY_MS);
  }

  // ---- click to select -------------------------------------------------------------------

  private onPointerDown(ev: PointerEvent): void {
    const tools = this.tools;
    if (!tools || ev.button !== 0) {
      this.down = null;
      return;
    }
    // The gizmo's own listener has already run: a press on a handle is not a click.
    this.down = { x: ev.clientX, y: ev.clientY, onGizmo: tools.gizmo.dragging || tools.gizmo.axis !== null };
  }

  private onPointerUp(ev: PointerEvent): void {
    const down = this.down;
    this.down = null;
    if (!down || down.onGizmo || ev.button !== 0) return;
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_SLOP_PX) return;
    const id = this.pick(ev.clientX, ev.clientY);
    this.post({ t: 'select', layerId: id });
  }

  /**
   * The topmost layer with a drawn pixel under the pointer. Instanced layers place their
   * geometry in the shader, so raycasting cannot see them; instead each visible layer is
   * drawn on its own into a tiny target covering a few output pixels around the pointer
   * (a camera view offset), topmost first, and the first one that covers any of those
   * pixels wins. Click-only, so the read-back stall is acceptable.
   */
  private pick(clientX: number, clientY: number): string | null {
    const tools = this.tools;
    const doc = this.host.getDoc();
    if (!tools || !doc || tools.stage.contextLost) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ox = ((clientX - rect.left) / rect.width) * OUTPUT_WIDTH;
    const oy = ((clientY - rect.top) / rect.height) * OUTPUT_HEIGHT;
    const stage = tools.stage;
    const renderer = stage.renderer;
    const camera = stage.camera as PerspectiveCamera | OrthographicCamera;
    const screen = stage.orthoCamera; // for layers fixed to the screen
    const target = tools.pickTarget ?? (tools.pickTarget = new WebGLRenderTarget(PICK_SIZE, PICK_SIZE, { depthBuffer: true }));
    renderer.getClearColor(this.clearColour);
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    let hit: string | null = null;
    try {
      camera.setViewOffset(OUTPUT_WIDTH, OUTPUT_HEIGHT, ox - PICK_SIZE / 2, oy - PICK_SIZE / 2, PICK_SIZE, PICK_SIZE);
      if (screen !== camera) screen.setViewOffset(OUTPUT_WIDTH, OUTPUT_HEIGHT, ox - PICK_SIZE / 2, oy - PICK_SIZE / 2, PICK_SIZE, PICK_SIZE);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      const layers = doc.project.layers;
      for (let i = layers.length - 1; i >= 0 && hit === null; i--) {
        const layer = layers[i]!;
        const obj = this.host.getLayerObject(layer.id);
        if (!obj || !obj.visible) continue;
        renderer.render(obj, layer.screenFixed ? screen : camera);
        renderer.readRenderTargetPixels(target, 0, 0, PICK_SIZE, PICK_SIZE, this.pickBuffer);
        for (let k = 0; k < this.pickBuffer.length; k++) {
          if (this.pickBuffer[k] !== 0) {
            hit = layer.id;
            break;
          }
        }
      }
    } catch (err) {
      this.warn('pick', err);
      hit = null;
    } finally {
      renderer.setRenderTarget(null);
      renderer.setClearColor(this.clearColour, clearAlpha);
      renderer.autoClear = autoClear;
      camera.clearViewOffset();
      screen.clearViewOffset();
    }
    return hit;
  }

  // ---- fencing -------------------------------------------------------------------------

  private fenced(where: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.warn(where, err);
    }
  }

  /** The preview never reports to the server; console only, deduplicated. */
  private warn(where: string, err: unknown): void {
    const message = `preview editor (${where}): ${err instanceof Error ? err.message : String(err)}`;
    if (message === this.lastWarning) return;
    this.lastWarning = message;
    console.warn(message);
  }
}

function findLayer(doc: SyncDoc, id: string): LayerConfig | null {
  const layers = doc.project.layers;
  for (let i = 0; i < layers.length; i++) if (layers[i]!.id === id) return layers[i]!;
  return null;
}

/** Thin outline of the 1920x1080 frame at z = 0, drawn over everything. */
function makeFrameOutline(): LineSegments {
  const w = OUTPUT_WIDTH;
  const h = OUTPUT_HEIGHT;
  // prettier-ignore
  const corners = [
    0, 0, 0, w, 0, 0,
    w, 0, 0, w, h, 0,
    w, h, 0, 0, h, 0,
    0, h, 0, 0, 0, 0,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(corners, 3));
  const material = new LineBasicMaterial({ color: OUTLINE_COLOUR, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
  const outline = new LineSegments(geometry, material);
  outline.frustumCulled = false;
  outline.renderOrder = -1; // under the gizmo
  outline.matrixAutoUpdate = false;
  outline.visible = false;
  return outline;
}
