import {
  Color,
  DepthTexture,
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
  type Material,
  type Object3D,
} from 'three';
import {
  blurShows,
  emptyComposeLayer,
  emptyComposePlan,
  needsCompose,
  planCompose,
  type ComposeLayer,
  type ComposePlan,
} from '../../shared/compose-plan.ts';
import { emptyFxLayer, type FxLayer } from '../../shared/effects-plan.ts';
import { invert, isConvexQuad, squareToQuad, type Quad } from '../../shared/homography.ts';
import type { LayerEffects } from '../../shared/layer-schema.ts';
import { isometricHalfSize, ISOMETRIC_DEPTH } from '../../shared/editor-maths.ts';
import { dofShows } from '../../shared/dof.ts';
import { defaultCamera, type Camera } from '../../shared/project-schema.ts';
import { DepthOfField } from './dof.ts';
import { PostEffects } from './effects.ts';
import { LayerImages } from './layer-image.ts';

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

/** Set by LayerManager on each layer's root object: the layer's effects (glow, trails, shadow, blur). */
export const EFFECTS_TAG = 'effects';
/** Set by LayerManager: true when the layer is fixed to the screen (drawn with `orthoCamera`). */
export const SCREEN_FIXED_TAG = 'screenFixed';
/** Set by LayerManager: the layer's blend mode (its blurred image is laid in the same way). */
export const BLEND_TAG = 'blend';

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
 *
 * The scene is one render, unless a visible layer has a drop shadow or a blur, or is fixed
 * to the screen while the project camera is 3D. Then it is drawn in segments, in stack order,
 * into the same target (shared/compose-plan.ts; shadows and blur in layer-image.ts). Only the
 * first segment clears; the target keeps its multisampled image between renders (three only
 * invalidates it after resolving in the Oculus browser).
 *
 * Camera depth of field (dof.ts) blurs the 3D scene by its depth, in place, before the
 * effects. The target gets a depth texture the first time it is switched on. Layers that draw
 * without writing depth (text, labels, translucent layers) and blurred layers (drawn as
 * images) then have their depth written in a depth-only pass (writeMissingDepth), so they are
 * focused where they are, not by what is behind them. Screen-fixed layers are left out of
 * the scene for that, then drawn on top, sharp.
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
  private readonly hiddenInner: Object3D[] = [];
  private images: LayerImages;
  /** Per frame: visible scene objects as the compositor sees them (a reused pool), and the plan. */
  private readonly compose: ComposeLayer[] = [];
  private composeCount = 0;
  private readonly composePlan: ComposePlan = emptyComposePlan();
  /** The same for a drawOnly() subset. */
  private readonly subset: ComposeLayer[] = [];
  private readonly subsetPlan: ComposePlan = emptyComposePlan();
  private readonly savedClear = new Color();
  /** This frame's clock (performance.now()), for the layer images' release timing. */
  private now = 0;
  private dof: DepthOfField;
  /** True once the scene target has a depth texture (made when depth of field is first on). */
  private depthTextured = false;
  /** Per frame with depth of field: screen-fixed layers held back, then drawn on top. */
  private readonly held: Object3D[] = [];
  /** Materials forced to depth-only by writeMissingDepth, and their own settings. */
  private readonly forced: Material[] = [];
  private readonly forcedState: boolean[] = [];
  private needsDepth = false;

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
    this.images = new LayerImages(
      this.renderer,
      this.target.width,
      this.target.height,
      this.targetScale,
      (message) => this.events.report?.(message),
      (scene) => this.verifyObject(scene),
    );
    this.dof = new DepthOfField(
      this.renderer,
      this.target.width,
      this.target.height,
      this.targetScale,
      (message) => this.events.report?.(message),
      (scene) => this.verifyObject(scene),
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
      d.dof.enabled = cfg.dof.enabled;
      d.dof.focus = cfg.dof.focus;
      d.dof.depth = cfg.dof.depth;
      d.dof.amount = cfg.dof.amount;
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
    const now = performance.now();
    this.now = now;
    const dof = this.camera !== this.orthoCamera && dofShows(this.displayedCamera, this.targetScale) && this.dof.usable();
    if (dof && !this.depthTextured) {
      this.depthTextured = true;
      this.replaceTarget();
    }
    if (dof) this.holdScreenFixed();
    try {
      this.renderScene();
      if (dof) {
        this.writeMissingDepth();
        this.dof.apply(this.target, this.camera, this.displayedCamera, now);
      }
    } finally {
      if (dof) this.releaseHeld();
    }
    this.images.release(now);
    this.dof.release(now);
    const warp = this.warpMaterial.uniforms;
    this.collectEffects();
    if (this.post.active(this.fx, this.fxCount)) {
      this.post.process(this.target.texture, dt, now, this.fx, this.fxCount);
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

  /** The scene (its visible layers) into the target: one render, or in segments. */
  private renderScene(): void {
    if (this.collectCompose()) this.renderSegments(this.target, this.compose, this.composeCount, this.composePlan);
    else {
      this.renderer.setRenderTarget(this.target);
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Hide the visible screen-fixed layers (depth of field), keeping them in `held`. */
  private holdScreenFixed(): void {
    const children = this.scene.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!child.visible || !this.screenFixed(child)) continue;
      child.visible = false;
      this.held.push(child);
    }
  }

  /** Show the held layers again and draw them over the target, in stack order. */
  private releaseHeld(): void {
    const held = this.held;
    if (held.length === 0) return;
    for (let i = 0; i < held.length; i++) held[i]!.visible = true;
    try {
      this.drawOnly(this.target, held, held.length, true);
    } finally {
      held.length = 0;
    }
  }

  /**
   * Depth of field: write the depth of visible layers that drew colour without it (text,
   * labels, translucent layers, blurred layers) into the target, with every material of
   * those layers forced to depth only for one render.
   */
  private writeMissingDepth(): void {
    const children = this.scene.children;
    const hidden = this.hiddenInner;
    const forced = this.forced;
    const state = this.forcedState;
    hidden.length = 0;
    try {
      let any = false;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (!child.visible) continue;
        this.needsDepth = effectsOf(child)?.blur.enabled === true;
        if (!this.needsDepth) child.traverseVisible(this.findMissingDepth);
        if (this.needsDepth) {
          any = true;
          child.traverseVisible(this.forceDepthOnly);
        } else {
          child.visible = false;
          hidden.push(child);
        }
      }
      if (any) this.renderOver(this.target, this.camera);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i]!.visible = true;
      hidden.length = 0;
      for (let i = 0; i < forced.length; i++) {
        const m = forced[i]!;
        m.depthWrite = state[2 * i]!;
        m.colorWrite = state[2 * i + 1]!;
      }
      forced.length = 0;
      state.length = 0;
    }
  }

  private readonly findMissingDepth = (object: Object3D): void => {
    if (this.needsDepth) return;
    const m = (object as { material?: Material | Material[] }).material;
    if (!m) return;
    if (Array.isArray(m)) {
      for (let i = 0; i < m.length; i++) if (!m[i]!.depthWrite && m[i]!.depthTest) this.needsDepth = true;
    } else if (!m.depthWrite && m.depthTest) this.needsDepth = true;
  };

  private readonly forceDepthOnly = (object: Object3D): void => {
    const m = (object as { material?: Material | Material[] }).material;
    if (!m) return;
    if (Array.isArray(m)) for (let i = 0; i < m.length; i++) this.forceOne(m[i]!);
    else this.forceOne(m);
  };

  private forceOne(m: Material): void {
    if (!m.depthTest) return; // drawn over everything: no depth to give
    this.forced.push(m);
    this.forcedState.push(m.depthWrite, m.colorWrite);
    m.depthWrite = true;
    m.colorWrite = false;
  }

  /** True when a top-level object is fixed to the screen and the project camera is not the screen camera. */
  private screenFixed(object: Object3D): boolean {
    return this.camera !== this.orthoCamera && object.userData[SCREEN_FIXED_TAG] === true;
  }

  /** Fill `c` for a visible top-level object: its stack position, camera, shadow and blur. */
  private describeObject(c: ComposeLayer, object: Object3D): void {
    const e = effectsOf(object);
    c.object = object;
    c.order = object.renderOrder;
    c.screen = this.screenFixed(object);
    const usable = !!e && (e.shadow?.enabled || e.blur?.enabled) && this.images.usable(object);
    c.shadow = !!usable && e.shadow.enabled && e.shadow.opacity > 0;
    c.blur = !!usable && e.blur.enabled && blurShows(e.blur.amount, this.targetScale);
  }

  /**
   * Each visible object's shadow, blur and camera; true when the scene needs segmented
   * drawing. With none of those anywhere this loop is the only extra work.
   */
  private collectCompose(): boolean {
    const children = this.scene.children;
    let n = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!child.visible) continue;
      this.describeObject((this.compose[n] ??= emptyComposeLayer()), child);
      n++;
    }
    for (let i = n; i < this.composeCount; i++) this.compose[i]!.object = null; // keep nothing alive
    this.composeCount = n;
    return needsCompose(this.compose, n);
  }

  /**
   * Draw `layers[0..count)` (every object visible now, or all of them that are not hidden for
   * the caller) in segments (see shared/compose-plan.ts) into `target`, cleared to the
   * background first.
   */
  private renderSegments(target: WebGLRenderTarget, layers: readonly ComposeLayer[], count: number, plan: ComposePlan, clear = true): void {
    const r = this.renderer;
    planCompose(layers, count, plan);
    const autoClear = r.autoClear;
    r.getClearColor(this.savedClear);
    const clearAlpha = r.getClearAlpha();
    // A colour background makes three clear on every render; the one clear here is ours.
    this.scene.background = null;
    try {
      r.autoClear = false;
      r.setRenderTarget(target);
      if (clear) {
        r.setClearColor(this.background, 1);
        r.clear(true, true, true);
        r.setClearColor(this.savedClear, clearAlpha);
      }
      for (let s = 0; s < plan.segmentCount; s++) {
        const seg = plan.segments[s]!;
        const camera = seg.screen ? this.orthoCamera : this.camera;
        if (seg.image) this.drawImageSegment(target, layers, plan, seg.start, camera, clearAlpha);
        else this.drawRange(target, layers, plan, seg.start, seg.end, camera);
      }
    } finally {
      this.scene.background = this.background;
      r.autoClear = autoClear;
      r.setClearColor(this.savedClear, clearAlpha);
    }
  }

  /**
   * One layer with a shadow and/or a blur: drawn alone into the layer image, its shadow laid
   * down, then the layer itself (blurred, or plainly). Any failure draws it plainly.
   */
  private drawImageSegment(
    target: WebGLRenderTarget,
    layers: readonly ComposeLayer[],
    plan: ComposePlan,
    position: number,
    camera: ThreeCamera,
    clearAlpha: number,
  ): void {
    const c = layers[plan.sorted[position]!]!;
    const object = c.object as Object3D;
    const e = effectsOf(object)!;
    const now = this.now;
    let drawn = false;
    const source = this.images.begin(now);
    if (source) {
      const r = this.renderer;
      try {
        r.setRenderTarget(source);
        r.setClearColor(0x000000, 0);
        r.clear(true, true, false);
        r.setClearColor(this.savedClear, clearAlpha);
        this.drawRange(source, layers, plan, position, position + 1, camera);
        if (c.shadow) this.images.drawShadow(target, e.shadow, now);
        if (c.blur) drawn = this.images.drawBlurred(target, e.blur.amount, object.userData[BLEND_TAG] === 'additive', now);
      } catch (err) {
        this.images.failLayer(object, err);
      }
    }
    if (!drawn) this.drawRange(target, layers, plan, position, position + 1, camera);
  }

  /**
   * Render only the objects at plan positions [start, end) of `layers`: every other entry is
   * hidden for the render, then shown again. Clears only as the renderer's state says.
   */
  private drawRange(
    target: WebGLRenderTarget,
    layers: readonly ComposeLayer[],
    plan: ComposePlan,
    start: number,
    end: number,
    camera: ThreeCamera,
  ): void {
    const hidden = this.hiddenInner;
    hidden.length = 0;
    try {
      for (let p = 0; p < plan.count; p++) {
        if (p >= start && p < end) continue;
        const object = layers[plan.sorted[p]!]!.object as Object3D;
        if (!object.visible) continue;
        object.visible = false;
        hidden.push(object);
      }
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, camera);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i]!.visible = true;
      hidden.length = 0;
    }
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

  /**
   * Draw only `objects[0..count)` into `target`, cleared to the background (per-layer glow
   * and trails), then restore visibility. They are drawn as in the scene: screen-fixed ones
   * with the screen camera, with their shadows, blurred when blurred. With `over`, they are
   * drawn over what `target` holds instead (no clear).
   */
  private drawOnly(target: WebGLRenderTarget, objects: readonly (Object3D | null)[], count: number, over = false): void {
    const hidden = this.hidden;
    hidden.length = 0;
    let n = 0;
    try {
      const children = this.scene.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (!child.visible) continue;
        let keep = false;
        for (let k = 0; k < count && !keep; k++) keep = objects[k] === child;
        if (keep) {
          this.describeObject((this.subset[n] ??= emptyComposeLayer()), child);
          n++;
          continue;
        }
        child.visible = false;
        hidden.push(child);
      }
      if (needsCompose(this.subset, n)) this.renderSegments(target, this.subset, n, this.subsetPlan, !over);
      else if (over) this.renderOver(target, this.camera);
      else {
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, this.camera);
      }
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i]!.visible = true;
      hidden.length = 0;
      for (let i = 0; i < n; i++) this.subset[i]!.object = null;
    }
  }

  /** Render the scene over what `target` holds (no clear, no background). */
  private renderOver(target: WebGLRenderTarget, camera: ThreeCamera): void {
    const r = this.renderer;
    const autoClear = r.autoClear;
    this.scene.background = null;
    try {
      r.autoClear = false;
      r.setRenderTarget(target);
      r.render(this.scene, camera);
    } finally {
      r.autoClear = autoClear;
      this.scene.background = this.background;
    }
  }

  private makeTarget(): WebGLRenderTarget {
    const w = Math.round(OUTPUT_WIDTH * this.targetScale);
    const h = Math.round(OUTPUT_HEIGHT * this.targetScale);
    // 8× MSAA: thin box edges sit on triangle edges, where coverage comes from the samples, and
    // at 4× they shimmer as the camera turns (twice the flicker, measured). About 2 ms a frame
    // at 200k boxes on the GTX 1650; three clamps it to the GPU's MAX_SAMPLES.
    return new WebGLRenderTarget(w, h, {
      samples: this.targetScale < 1 ? 0 : 8,
      depthBuffer: true,
      depthTexture: this.depthTextured ? new DepthTexture(w, h) : null,
    });
  }

  /** A new scene target (depth of field needs one with a depth texture). */
  private replaceTarget(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.target = this.makeTarget();
    this.warpMaterial.uniforms.uImage!.value = this.target.texture;
  }

  private onLost = (ev: Event): void => {
    ev.preventDefault(); // allow the browser to restore the context
    this.contextLost = true;
    this.events.lost();
  };

  private onRestored = (): void => {
    // Three re-initialises its GL state; our own render target is recreated so nothing
    // references objects from the dead context, then the caller rebuilds the layers.
    this.replaceTarget();
    this.warpMaterial.uniforms.uBloom!.value = null;
    this.post.contextRestored();
    this.images.contextRestored();
    this.dof.contextRestored();
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
