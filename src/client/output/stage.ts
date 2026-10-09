import {
  Color,
  Mesh,
  Matrix3,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  WebGLRenderTarget,
  type Camera as ThreeCamera,
  type Object3D,
} from 'three';
import { emptyFxLayer, type FxLayer } from '../../shared/effects-plan.ts';
import { invert, isConvexQuad, squareToQuad, type Quad } from '../../shared/homography.ts';
import type { LayerEffects } from '../../shared/layer-schema.ts';
import { isometricHalfSize, ISOMETRIC_DEPTH } from '../../shared/editor-maths.ts';
import { defaultCamera, type Camera } from '../../shared/project-schema.ts';
import { PostEffects } from './effects.ts';

/** Full-screen quad; the fragment shader does the keystone mapping per pixel. */
const WARP_VERTEX = /* glsl */ `
  varying vec2 vScreen;
  void main() {
    vScreen = vec2(uv.x, 1.0 - uv.y); // normalised window coords, y down
    gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
  }
`;

/**
 * Inverse homography: window point -> image uv. Exact perspective-correct mapping (no mesh
 * subdivision), black outside the image, with a one-pixel anti-aliased edge.
 *
 * The timeline's output fade (outputFade in modulation-helpers.ts) is the last step, after
 * bloom and trails (whose histories it leaves alone): the image mixes towards the background
 * colour by 1 - uFade. It mixes in display (sRGB) space, so the eased fade looks even; the
 * area outside the keystoned image stays black.
 */
const WARP_FRAGMENT = /* glsl */ `
  uniform sampler2D uImage;
  uniform sampler2D uBloom;
  uniform float uBloomOn;
  uniform mat3 uInverse;
  uniform float uFade;
  uniform vec3 uFadeColour;
  varying vec2 vScreen;
  void main() {
    vec3 p = uInverse * vec3(vScreen, 1.0);
    vec2 uv = p.xy / p.z;
    float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    float inside = p.z > 0.0 ? clamp(edge / max(fwidth(edge), 1e-6) + 0.5, 0.0, 1.0) : 0.0;
    vec2 imageUv = vec2(uv.x, 1.0 - uv.y);
    vec4 colour = texture2D(uImage, imageUv);
    // Bloom (half resolution) is added here when no trails pass consumed it.
    if (uBloomOn > 0.5) colour.rgb += texture2D(uBloom, imageUv).rgb;
    gl_FragColor = vec4(colour.rgb * inside, 1.0);
    #include <colorspace_fragment>
    if (uFade < 1.0) gl_FragColor.rgb = mix(uFadeColour * inside, gl_FragColor.rgb, uFade);
  }
`;

/** Set by LayerManager on each layer's root object: the layer's glow and trails settings. */
export const EFFECTS_TAG = 'effects';

/** A top-level scene object's effects; untagged objects (the test pattern) have none. */
function effectsOf(object: Object3D): LayerEffects | undefined {
  return object.userData[EFFECTS_TAG] as LayerEffects | undefined;
}

export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;

/**
 * Owns the WebGL renderer. The scene is drawn into a fixed 1920x1080 MSAA render target,
 * then through the output effects (effects.ts: bloom, trails; skipped entirely when both
 * are off), then to the screen through the keystone warp (an inverse homography per pixel),
 * which also applies the timeline's fade towards the background (setFade).
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Pixel-space camera: x 0..1920, y 0..1080 (y up). */
  readonly orthoCamera = new OrthographicCamera(0, OUTPUT_WIDTH, OUTPUT_HEIGHT, 0, -10_000, 10_000);
  /** 3D camera; at yaw = pitch = 0, distance = 1 the z = 0 plane exactly fills the frame. */
  readonly perspectiveCamera = new PerspectiveCamera(45, OUTPUT_WIDTH / OUTPUT_HEIGHT, 1, 100_000);
  /**
   * 3D isometric camera (orthographic), orbiting like the perspective one; at distance 1 the
   * target's plane fills the frame and larger distances show more (isometricHalfSize).
   */
  readonly isometricCamera = new OrthographicCamera(-OUTPUT_WIDTH / 2, OUTPUT_WIDTH / 2, OUTPUT_HEIGHT / 2, -OUTPUT_HEIGHT / 2, 1, 2);
  camera: ThreeCamera = this.orthoCamera;
  readonly rendererName: string;
  contextLost = false;
  /**
   * What is on screen now (after modulation and morphs), kept so a scene morph can start
   * from it. Updated in place by setCamera; never replaced.
   */
  readonly displayedCamera: Camera = defaultCamera();

  private target: WebGLRenderTarget;
  private warpScene = new Scene();
  private warpCamera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
  private warpMaterial: ShaderMaterial;
  private warpInverse = new Matrix3();
  private warpGeometry = new PlaneGeometry(1, 1);
  private lastShaderError: string | null = null;
  private background = new Color(0x000000);
  /** The timeline's output fade, 0..1 (1: no fade), and the colour it fades to (sRGB components). */
  private fade = 1;
  private fadeColour = new Color(0x000000);
  private post: PostEffects;
  /** Per frame: visible layers and their effective glow / trails settings (a reused pool). */
  private readonly fx: FxLayer[] = [];
  private fxCount = 0;
  private readonly hidden: Object3D[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private events: { lost(): void; restored(): void; report?(message: string): void },
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
    this.warpMaterial = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uImage: { value: this.target.texture },
        uBloom: { value: null },
        uBloomOn: { value: 0 },
        uInverse: { value: this.warpInverse },
        uFade: { value: 1 },
        uFadeColour: { value: this.fadeColour },
      },
      vertexShader: WARP_VERTEX,
      fragmentShader: WARP_FRAGMENT,
    });
    this.post = new PostEffects(
      this.renderer,
      this.target.width,
      this.target.height,
      this.background,
      (message) => this.events.report?.(message),
      (scene) => this.verifyObject(scene),
      (target, objects, count) => this.drawOnly(target, objects, count),
      this.target.samples,
    );
    const quad = new Mesh(this.warpGeometry, this.warpMaterial);
    quad.frustumCulled = false;
    this.warpScene.add(quad);

    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    this.resize();
  }

  /**
   * Keystone: where the image's corners land in the window (TL, TR, BR, BL, normalised,
   * y down). Folded or degenerate quads are ignored, keeping the last good warp.
   */
  setWarp(corners: Quad): boolean {
    if (!isConvexQuad(corners)) return false;
    const inv = invert(squareToQuad(corners));
    if (!inv) return false;
    this.warpInverse.set(...inv);
    return true;
  }

  setBackground(hex: string): void {
    this.background.set(hex);
  }

  /** Background from sRGB components 0..1 (per-frame morphs; no string parsing). */
  setBackgroundRGB(r: number, g: number, b: number): void {
    this.background.setRGB(r, g, b, SRGBColorSpace);
  }

  /**
   * The timeline's output fade for the next frames: 1 shows the image, 0 only the background
   * colour (see outputFade). Applied in the warp pass, so the preview fades too.
   */
  setFade(f: number): void {
    // A bad value shows the image rather than blanking the output (never fail dark).
    this.fade = Number.isNaN(f) ? 1 : Math.min(Math.max(f, 0), 1);
  }

  /** The displayed background as sRGB components 0..1, written into `out`. */
  readBackground(out: { r: number; g: number; b: number }): void {
    this.background.getRGB(out as Color, SRGBColorSpace);
  }

  setCamera(cfg: Camera): void {
    // (Guarded: test/shared/editor-maths.test.ts calls this on a bare stand-in object.)
    const d = this.displayedCamera as Camera | undefined;
    if (d) {
      d.mode = cfg.mode;
      d.fov = cfg.fov;
      d.yaw = cfg.yaw;
      d.pitch = cfg.pitch;
      d.distance = cfg.distance;
      d.target[0] = cfg.target[0];
      d.target[1] = cfg.target[1];
      d.target[2] = cfg.target[2];
      d.projection = cfg.projection;
    }
    if (cfg.mode === '2d') {
      this.camera = this.orthoCamera;
      return;
    }
    const isometric = cfg.projection === 'isometric';
    const cam = isometric ? this.isometricCamera : this.perspectiveCamera;
    // The eye orbits the target in both projections (the orthographic one at the distance the
    // perspective eye would be, so orbiting, picking and the gizmo behave alike).
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
    if (isometric) {
      const iso = this.isometricCamera;
      const [hw, hh] = isometricHalfSize(cfg.distance);
      iso.left = -hw;
      iso.right = hw;
      iso.top = hh;
      iso.bottom = -hh;
      // Reaches ISOMETRIC_DEPTH past the target both ways, behind the eye too (near < 0).
      iso.near = r - ISOMETRIC_DEPTH;
      iso.far = r + ISOMETRIC_DEPTH;
    } else {
      const persp = this.perspectiveCamera;
      persp.fov = cfg.fov;
      persp.near = Math.max(0.5, r * 0.01);
      persp.far = r * 20 + 10_000;
    }
    cam.updateProjectionMatrix();
    this.camera = cam;
  }

  /** Compile an object's materials now so shader errors surface at build time, not mid-frame. */
  verify = (object: Object3D): string | null => this.verifyObject(object, this.scene);

  /**
   * Compile `root`'s materials and check them. three compiles lazily and only checks a
   * program's link status on its first use, so compile() alone never reports an error;
   * asking each compiled program for its uniforms runs that check now (onShaderError above).
   */
  verifyObject(root: Object3D, targetScene: Scene | null = null): string | null {
    this.lastShaderError = null;
    try {
      const materials = this.renderer.compile(root, this.camera, targetScene);
      for (const m of materials) {
        const props = this.renderer.properties.get(m) as { currentProgram?: { getUniforms(): unknown } };
        props.currentProgram?.getUniforms();
        if (this.lastShaderError) break;
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return this.lastShaderError;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setSize(w, h, false);
  }

  /** Draw one frame. `dt` is the frame clock's step in seconds (frame-rate independent trails). */
  render(dt: number): void {
    if (this.contextLost) return;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
    const warp = this.warpMaterial.uniforms;
    this.collectEffects();
    if (this.post.active(this.fx, this.fxCount)) {
      this.post.process(this.target.texture, dt, performance.now(), this.fx, this.fxCount);
      warp.uImage!.value = this.post.image ?? this.target.texture;
      warp.uBloom!.value = this.post.bloomTexture;
      warp.uBloomOn!.value = this.post.bloomTexture ? 1 : 0;
    } else {
      warp.uImage!.value = this.target.texture;
      warp.uBloom!.value = null;
      warp.uBloomOn!.value = 0;
    }
    warp.uFade!.value = this.fade;
    // Read each frame while fading, as a scene morph may be moving the background.
    if (this.fade < 1) this.background.getRGB(this.fadeColour, SRGBColorSpace);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.warpScene, this.warpCamera);
  }

  /** Each visible layer's effective glow and trails (the layers are the scene's children). */
  private collectEffects(): void {
    const children = this.scene.children;
    let n = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!child.visible) continue;
      const e = effectsOf(child);
      const fx = (this.fx[n] ??= emptyFxLayer());
      n++;
      fx.object = child;
      fx.glow = !!e && e.glow.enabled && e.glow.strength > 0;
      fx.strength = e?.glow.strength ?? 0;
      fx.radius = e?.glow.radius ?? 0;
      fx.threshold = e?.glow.threshold ?? 0;
      fx.trails = !!e && e.trails.enabled && e.trails.persistence > 0;
      fx.persistence = e?.trails.persistence ?? 0;
    }
    for (let i = n; i < this.fxCount; i++) this.fx[i]!.object = null; // keep nothing alive
    this.fxCount = n;
  }

  /** Draw only `objects[0..count)` into `target` (per-layer effects), then restore visibility. */
  private drawOnly(target: WebGLRenderTarget, objects: readonly (Object3D | null)[], count: number): void {
    const hidden = this.hidden;
    hidden.length = 0;
    try {
      const children = this.scene.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (!child.visible) continue;
        let keep = false;
        for (let k = 0; k < count && !keep; k++) keep = objects[k] === child;
        if (keep) continue;
        child.visible = false;
        hidden.push(child);
      }
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.camera);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i]!.visible = true;
      hidden.length = 0;
    }
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
    this.warpMaterial.uniforms.uImage!.value = this.target.texture;
    this.warpMaterial.uniforms.uBloom!.value = null;
    this.post.contextRestored();
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
