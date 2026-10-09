import {
  Color,
  CustomBlending,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type Object3D,
  type Texture,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import { chooseBlur, emptyBlurStep, MAX_LEVEL, MAX_TAPS, offsetToUv, type BlurStep } from '../../shared/compose-plan.ts';
import type { LayerEffects } from '../../shared/layer-schema.ts';

/*
 * Per-layer drop shadows and blur (see shared/compose-plan.ts for where they sit in the
 * draw order). For one layer at a time:
 *
 *   1. Stage draws the layer alone into `source` (full size, cleared to transparent), so it
 *      holds the layer's premultiplied colour and coverage (normal blending onto transparent
 *      black gives exactly that).
 *   2. A pyramid of half-size images (2x2 box each step, half float where the GPU can render
 *      to it) down to the level the blur needs, then a separable gaussian at that level
 *      (at most MAX_TAPS taps each side: 100 px of blur runs at a sixteenth of the size).
 *   3. Shadow: a full-screen quad of colour x blurred coverage x opacity, read `offset`
 *      pixels away, laid into the scene image with premultiplied "over" blending.
 *      Blur: the blurred premultiplied image laid in the same way (added, for additive
 *      layers), in place of the layer itself.
 *
 * Every layer reuses the same targets in turn (each is finished before the next starts), so
 * memory does not grow with the number of layers.
 *
 * Cost: nothing at all until a layer turns one on. Targets are made on first need and
 * released after GRACE_MS without use, like effects.ts; a context restore drops everything
 * and rebuilds lazily. Per layer and frame: one more draw of the layer, one full-size clear,
 * a few small passes, and one full-size quad into the scene per effect.
 *
 * Failure: the shaders are compiled and checked when first built. A failure there turns the
 * effects off (reported once) until a context restore; anything thrown while drawing a layer
 * turns them off for that layer only (reported once). Either way the layer is drawn plainly.
 */

const GRACE_MS = 10_000;
const PRUNE_MS = 1000;

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Downsample (a 2x2 box: one bilinear tap at the centre of each block) or plain copy. */
const COPY_FRAGMENT = /* glsl */ `
  uniform sampler2D uImage;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uImage, vUv);
  }
`;

/** One direction of a gaussian on premultiplied colour and alpha. */
const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D uImage;
  uniform vec2 uTexel;
  uniform float uSigma;
  uniform int uTaps;
  varying vec2 vUv;
  void main() {
    float k = -0.5 / max(uSigma * uSigma, 1e-4);
    vec4 sum = texture2D(uImage, vUv);
    float total = 1.0;
    for (int i = 1; i <= ${MAX_TAPS}; i++) {
      if (i > uTaps) break;
      float w = exp(float(i * i) * k);
      vec2 o = uTexel * float(i);
      sum += w * (texture2D(uImage, vUv + o) + texture2D(uImage, vUv - o));
      total += 2.0 * w;
    }
    gl_FragColor = sum / total;
  }
`;

/** The layer's blurred coverage, tinted and moved: premultiplied, transparent outside the image. */
const SHADOW_FRAGMENT = /* glsl */ `
  uniform sampler2D uImage;
  uniform vec2 uOffset;
  uniform vec3 uColour;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv - uOffset;
    float inside = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
    float a = min(texture2D(uImage, uv).a, 1.0) * uOpacity * inside;
    gl_FragColor = vec4(uColour * a, a);
  }
`;

type Report = (message: string) => void;
type Verify = (scene: Scene) => string | null;

interface Level {
  /** This level of the pyramid, the horizontal pass, and the finished blur. */
  down: WebGLRenderTarget;
  scratch: WebGLRenderTarget;
  out: WebGLRenderTarget;
  lastUsed: number;
}

interface Resources {
  source: WebGLRenderTarget;
  /** Index = level (1..MAX_LEVEL); made on first use. */
  levels: (Level | null)[];
  copy: ShaderMaterial;
  blur: ShaderMaterial;
  shadow: ShaderMaterial;
  /** Lays a premultiplied image into the scene (blending set per layer). */
  image: ShaderMaterial;
  lastUsed: number;
}

export class LayerImages {
  private res: Resources | null = null;
  private failed = false;
  /** Layers whose shadow or blur threw; drawn plainly from then on (until a context restore). */
  private failedLayers = new WeakSet<Object3D>();
  /** Highest pyramid level made from the current source this pass. */
  private built = 0;
  private lastPrune = 0;
  private readonly step: BlurStep = emptyBlurStep();
  private readonly offset = { x: 0, y: 0 };
  private readonly colours = new Map<string, Color>();

  private readonly quadGeometry = new PlaneGeometry(2, 2);
  private readonly quad: Mesh;
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bufferType: TextureDataType;

  constructor(
    private renderer: WebGLRenderer,
    /** Size of the scene image (the preview's is half). */
    private width: number,
    private height: number,
    /** Image texels per output pixel (blur amounts are in output pixels). */
    private scale: number,
    private report: Report,
    private verify: Verify,
  ) {
    this.quad = new Mesh(this.quadGeometry);
    this.quad.frustumCulled = false;
    const ext = renderer.extensions;
    this.bufferType = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float') ? HalfFloatType : UnsignedByteType;
  }

  /** False once the layer's effects have failed (it is then drawn plainly). */
  usable(object: Object3D): boolean {
    return !this.failed && !this.failedLayers.has(object);
  }

  /**
   * Start a layer: returns the target to draw it alone into (the caller clears it to
   * transparent and draws), or null when the effects are unavailable.
   */
  begin(nowMs: number): WebGLRenderTarget | null {
    const res = this.ensure(nowMs);
    if (!res) return null;
    res.lastUsed = nowMs;
    this.built = 0;
    return res.source;
  }

  /** Lay the layer's shadow into `target` (after begin() and the draw). */
  drawShadow(target: WebGLRenderTarget, shadow: LayerEffects['shadow'], nowMs: number): void {
    const res = this.res!;
    const blurred = this.blurred(chooseBlur(shadow.spread, this.scale, this.step), nowMs);
    const u = res.shadow.uniforms;
    u.uImage!.value = blurred;
    offsetToUv(shadow.offset, this.offset);
    (u.uOffset!.value as Vector2).set(this.offset.x, this.offset.y);
    (u.uColour!.value as Color).copy(this.colour(shadow.colour));
    u.uOpacity!.value = Math.min(Math.max(shadow.opacity, 0), 1);
    this.draw(res.shadow, target, false);
  }

  /**
   * Lay the layer blurred by `amount` px into `target`. False when that blur is too small to
   * see: the caller draws the layer plainly instead.
   */
  drawBlurred(target: WebGLRenderTarget, amount: number, additive: boolean, nowMs: number): boolean {
    const res = this.res!;
    const step = chooseBlur(amount, this.scale, this.step);
    if (step.level === 0) return false;
    res.image.uniforms.uImage!.value = this.blurred(step, nowMs);
    res.image.blendDst = additive ? OneFactor : OneMinusSrcAlphaFactor;
    res.image.blendDstAlpha = additive ? OneFactor : OneMinusSrcAlphaFactor;
    this.draw(res.image, target, false);
    return true;
  }

  /** Something threw while drawing `object`'s effects: draw it plainly from now on. */
  failLayer(object: Object3D, err: unknown): void {
    if (this.failedLayers.has(object)) return;
    this.failedLayers.add(object);
    const name = object.name ? `layer "${object.name}"` : 'a layer';
    this.report(`shadow / blur disabled for ${name}: ${describe(err)}`);
  }

  /** Release what has not been used for GRACE_MS (checked at most once per PRUNE_MS). */
  release(nowMs: number): void {
    const res = this.res;
    if (!res || nowMs - this.lastPrune < PRUNE_MS) return;
    this.lastPrune = nowMs;
    if (nowMs - res.lastUsed > GRACE_MS) {
      this.disposeResources();
      return;
    }
    for (let l = 1; l <= MAX_LEVEL; l++) {
      const level = res.levels[l];
      if (level && nowMs - level.lastUsed > GRACE_MS) {
        disposeLevel(level);
        res.levels[l] = null;
      }
    }
  }

  /** WebGL context restored: everything on the GPU is gone; rebuild lazily, retry failures. */
  contextRestored(): void {
    this.disposeResources();
    this.failed = false;
    this.failedLayers = new WeakSet();
  }

  dispose(): void {
    this.disposeResources();
    this.quadGeometry.dispose();
  }

  // ---- internals -----------------------------------------------------------------

  private ensure(nowMs: number): Resources | null {
    if (this.failed) return null;
    if (this.res) return this.res;
    try {
      const source = this.makeTarget(this.width, this.height, UnsignedByteType, true);
      const copy = quadMaterial(COPY_FRAGMENT, { uImage: { value: null } });
      const blur = quadMaterial(BLUR_FRAGMENT, { uImage: { value: null }, uTexel: { value: new Vector2() }, uSigma: { value: 1 }, uTaps: { value: 0 } });
      const shadow = quadMaterial(SHADOW_FRAGMENT, {
        uImage: { value: null },
        uOffset: { value: new Vector2() },
        uColour: { value: new Color() },
        uOpacity: { value: 0 },
      });
      const image = quadMaterial(COPY_FRAGMENT, { uImage: { value: null } });
      premultipliedOver(shadow);
      premultipliedOver(image);
      const levels: (Level | null)[] = [];
      for (let l = 0; l <= MAX_LEVEL; l++) levels.push(null);
      this.res = { source, levels, copy, blur, shadow, image, lastUsed: nowMs };
      const problem = this.check([copy, blur, shadow, image]);
      if (problem) {
        this.fail(`shadow / blur disabled: shader failed: ${problem}`);
        return null;
      }
      return this.res;
    } catch (err) {
      this.fail(`shadow / blur disabled: ${describe(err)}`);
      return null;
    }
  }

  /** The source blurred as `step` says (the source itself when no blur is needed). */
  private blurred(step: BlurStep, nowMs: number): Texture {
    const res = this.res!;
    if (step.level === 0) return res.source.texture;
    // Pyramid down to the level (levels made earlier in this pass are reused).
    for (let l = this.built + 1; l <= step.level; l++) {
      const level = this.level(l, nowMs);
      res.copy.uniforms.uImage!.value = l === 1 ? res.source.texture : res.levels[l - 1]!.down.texture;
      this.draw(res.copy, level.down, true);
      this.built = l;
    }
    const level = this.level(step.level, nowMs);
    if (step.taps === 0) return level.down.texture;
    const u = res.blur.uniforms;
    u.uSigma!.value = step.sigma;
    u.uTaps!.value = step.taps;
    u.uImage!.value = level.down.texture;
    (u.uTexel!.value as Vector2).set(1 / level.down.width, 0);
    this.draw(res.blur, level.scratch, true);
    u.uImage!.value = level.scratch.texture;
    (u.uTexel!.value as Vector2).set(0, 1 / level.down.height);
    this.draw(res.blur, level.out, true);
    return level.out.texture;
  }

  private level(l: number, nowMs: number): Level {
    const res = this.res!;
    let level = res.levels[l];
    if (!level) {
      const w = Math.max(1, Math.round(this.width / 2 ** l));
      const h = Math.max(1, Math.round(this.height / 2 ** l));
      level = {
        down: this.makeTarget(w, h, this.bufferType, false),
        scratch: this.makeTarget(w, h, this.bufferType, false),
        out: this.makeTarget(w, h, this.bufferType, false),
        lastUsed: nowMs,
      };
      res.levels[l] = level;
    }
    level.lastUsed = nowMs;
    return level;
  }

  /** Shadow colours, parsed once per colour (no string parsing per frame). */
  private colour(hex: string): Color {
    let c = this.colours.get(hex);
    if (!c) {
      if (this.colours.size > 64) this.colours.clear();
      c = new Color(hex);
      this.colours.set(hex, c);
    }
    return c;
  }

  private draw(material: ShaderMaterial, target: WebGLRenderTarget, clear: boolean): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = clear;
    try {
      this.renderer.render(this.quad, this.quadCamera);
    } finally {
      this.renderer.autoClear = autoClear;
    }
  }

  private makeTarget(width: number, height: number, type: TextureDataType, depth: boolean): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      type,
      depthBuffer: depth,
      stencilBuffer: false,
      samples: 0,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
    });
  }

  private fail(message: string): void {
    this.failed = true;
    this.disposeResources();
    this.report(message);
  }

  private disposeResources(): void {
    const res = this.res;
    if (!res) return;
    this.res = null;
    res.source.dispose();
    for (const level of res.levels) if (level) disposeLevel(level);
    res.copy.dispose();
    res.blur.dispose();
    res.shadow.dispose();
    res.image.dispose();
  }

  /** Compile the materials now and return a shader error, if any. */
  private check(materials: ShaderMaterial[]): string | null {
    const scene = new Scene();
    for (const m of materials) {
      const mesh = new Mesh(this.quadGeometry, m);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    return this.verify(scene);
  }
}

function disposeLevel(level: Level): void {
  level.down.dispose();
  level.scratch.dispose();
  level.out.dispose();
}

function quadMaterial(fragmentShader: string, uniforms: ShaderMaterial['uniforms']): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });
}

/** Premultiplied "over": out = src + dst * (1 - src alpha), for colour and alpha. */
function premultipliedOver(m: ShaderMaterial): void {
  m.transparent = true;
  m.blending = CustomBlending;
  m.blendSrc = OneFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = OneMinusSrcAlphaFactor;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
