import {
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
  type Camera as ThreeCamera,
  type Object3D,
} from 'three';
import type { Camera } from '../../shared/project-schema.ts';

export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;

/**
 * Owns the WebGL renderer. The scene is drawn into a fixed 1920x1080 render target, which
 * is then drawn to the screen through `warp` (a full-screen quad for now; it becomes the
 * keystone mesh in phase 5).
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Pixel-space camera: x 0..1920, y 0..1080 (y up). */
  readonly orthoCamera = new OrthographicCamera(0, OUTPUT_WIDTH, OUTPUT_HEIGHT, 0, -10_000, 10_000);
  /** 3D camera; at yaw = pitch = 0, distance = 1 the z = 0 plane exactly fills the frame. */
  readonly perspectiveCamera = new PerspectiveCamera(45, OUTPUT_WIDTH / OUTPUT_HEIGHT, 1, 100_000);
  camera: ThreeCamera = this.orthoCamera;
  readonly rendererName: string;
  contextLost = false;

  private target: WebGLRenderTarget;
  private warpScene = new Scene();
  private warpCamera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
  private warpMaterial: MeshBasicMaterial;
  private warpGeometry = new PlaneGeometry(1, 1);
  private lastShaderError: string | null = null;
  private background = new Color(0x000000);

  constructor(
    private canvas: HTMLCanvasElement,
    private events: { lost(): void; restored(): void },
    /** Render-target scale; the control window's preview renders at reduced resolution. */
    private targetScale = 1,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = (s: WebGLShader) => gl.getShaderInfoLog(s)?.trim() ?? '';
      this.lastShaderError = [gl.getProgramInfoLog(program)?.trim(), log(vs), log(fs)].filter(Boolean).join(' | ') || 'shader compile failed';
    };
    this.rendererName = readRendererName(this.renderer.getContext());
    this.scene.background = this.background;
    this.orthoCamera.position.z = 1000;
    this.target = this.makeTarget();
    this.warpMaterial = new MeshBasicMaterial({ map: this.target.texture, toneMapped: false, depthTest: false });
    const quad = new Mesh(this.warpGeometry, this.warpMaterial);
    quad.frustumCulled = false;
    this.warpScene.add(quad);

    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    this.resize();
  }

  setBackground(hex: string): void {
    this.background.set(hex);
  }

  setCamera(cfg: Camera): void {
    if (cfg.mode === '2d') {
      this.camera = this.orthoCamera;
      return;
    }
    const cam = this.perspectiveCamera;
    cam.fov = cfg.fov;
    const fit = OUTPUT_HEIGHT / 2 / Math.tan((cfg.fov * Math.PI) / 360);
    const r = fit * cfg.distance;
    const yaw = (cfg.yaw * Math.PI) / 180;
    const pitch = (cfg.pitch * Math.PI) / 180;
    const tx = OUTPUT_WIDTH / 2 + cfg.target[0];
    const ty = OUTPUT_HEIGHT / 2 + cfg.target[1];
    const tz = cfg.target[2];
    cam.position.set(
      tx + r * Math.sin(yaw) * Math.cos(pitch),
      ty + r * Math.sin(pitch),
      tz + r * Math.cos(yaw) * Math.cos(pitch),
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, ty, tz);
    cam.near = Math.max(0.5, r * 0.01);
    cam.far = r * 20 + 10_000;
    cam.updateProjectionMatrix();
    this.camera = cam;
  }

  /** Compile an object's materials now so shader errors surface at build time, not mid-frame. */
  verify = (object: Object3D): string | null => {
    this.lastShaderError = null;
    try {
      this.renderer.compile(object, this.camera, this.scene);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return this.lastShaderError;
  };

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setSize(w, h, false);
  }

  render(): void {
    if (this.contextLost) return;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.warpScene, this.warpCamera);
  }

  private makeTarget(): WebGLRenderTarget {
    const w = Math.round(OUTPUT_WIDTH * this.targetScale);
    const h = Math.round(OUTPUT_HEIGHT * this.targetScale);
    return new WebGLRenderTarget(w, h, { samples: this.targetScale < 1 ? 0 : 4, depthBuffer: true });
  }

  private onLost = (ev: Event): void => {
    ev.preventDefault(); // allow the browser to restore the context
    this.contextLost = true;
    this.events.lost();
  };

  private onRestored = (): void => {
    // Three re-initialises its GL state; our own render target is recreated so nothing
    // references objects from the dead context, then the caller rebuilds the layers.
    this.target.dispose();
    this.target = this.makeTarget();
    this.warpMaterial.map = this.target.texture;
    this.warpMaterial.needsUpdate = true;
    this.contextLost = false;
    this.events.restored();
  };
}

export function readRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isPreferredGpu(name: string): boolean {
  return /nvidia/i.test(name);
}
