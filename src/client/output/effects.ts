import {
  AdditiveBlending,
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
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
import { anyEffect, emptyPlan, planEffects, type FxLayer } from '../../shared/effects-plan.ts';

/*
 * Output effects on the rendered 1080p image, before the keystone warp. Every layer has its
 * own glow and trails settings; shared/effects-plan.ts decides the passes each frame.
 *
 * Whole-image chain (every visible layer has the same settings; the common case):
 *
 *   scene (MSAA target, resolved) -> bloom -> trails -> warp
 *
 * Bloom is a threshold -> five-level blurred mip chain -> weighted sum, at half the target
 * resolution. It is never written back into the scene target;
 * instead the half-resolution bloom texture is added by whoever
 * consumes the image next: the trails pass, or the warp shader when trails are off. That
 * saves a full-resolution copy pass.
 *
 * Trails keep a history image in a ping-pong pair of targets. Each frame
 *   out = background + pick(current - background, (previous - background) * keep)
 * per channel, where pick takes whichever deviation from the background is larger and
 * keep = persistence ^ (dt * 60). On a black background this is exactly
 * max(current, previous * keep): marks leave a decaying smear, nothing ever adds up, so a
 * still image never blows out and the background stays its own colour (a plain additive or
 * screen blend would brighten any non-black background towards white). Measuring from the
 * background also gives dark marks on a light background trails, which max() alone cannot.
 * dt comes from the output's frame clock (already clamped to 0.1 s; clamped again here),
 * so the decay per second is the same at any frame rate and a stall cannot wipe the history.
 * Bloom is added before trails, so the history holds the glow but is never bloomed again
 * (no feedback loop).
 *
 * Per-layer chain (settings differ between layers). `drawOnly` redraws chosen layers alone:
 *   - each trail layer is drawn into its own history (with its own glow added first, so the
 *     glow smears with it), and the history is merged into the frame with the same pick rule;
 *   - layers with glow but no trails are grouped by identical glow settings; each group is
 *     drawn once, bloomed, and the glows are summed into one half-resolution texture that
 *     the warp adds.
 * Each trail layer costs one more draw of that layer, three full-size passes and two
 * full-size history buffers (at most MAX_TRAIL_LAYERS); each glow group one more draw of its
 * layers plus the bloom passes. Histories are keyed by the layer's scene object, so a scene
 * morph's outgoing copy of a layer keeps its own.
 *
 * Cost: with no effect on anywhere nothing here runs and nothing is allocated. Targets are
 * made on first need and released after GRACE_MS without use (so a toggle, a morph or a
 * modulator that briefly passes through zero does not thrash VRAM, but an installation that
 * stops using an effect gets its memory back). A context restore drops everything; it is
 * rebuilt lazily. Per-frame work only writes numbers and uniforms.
 *
 * Failure: each effect's shaders are compiled and checked when it is first built. A failure
 * (or anything thrown while running it) disables that effect only, is reported once, and the
 * image is drawn without it. It is retried after a context restore.
 */

const GRACE_MS = 10_000;
const MIPS = 5;
/** Gaussian kernel radius (taps each side) per mip level; sigma = radius / 2. */
const KERNEL = [3, 5, 7, 9, 11] as const;
/** Unreal-style mip weights; `radius` bends them towards the wide mips. */
const FACTORS = [1.0, 0.8, 0.6, 0.4, 0.2] as const;
const MAX_DT = 0.1;
/** A history unused for longer than this (effect paused, layer hidden) starts afresh. */
const STALE_MS = 250;
/** How often unused per-layer histories are looked for (they are released after GRACE_MS). */
const PRUNE_MS = 1000;

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAGMENT = /* glsl */ `
  uniform sampler2D uImage;
  uniform float uThreshold;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(uImage, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Soft knee just below the threshold, so threshold 1 still lets pure white glow.
    gl_FragColor = vec4(c * smoothstep(uThreshold - 0.05, uThreshold, l), 1.0);
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D uImage;
  uniform vec2 uTexel;      // one texel of the input, along the blur direction
  uniform int uRadius;
  varying vec2 vUv;
  void main() {
    float sigma = float(uRadius) * 0.5;
    float k = -0.5 / (sigma * sigma);
    vec3 sum = texture2D(uImage, vUv).rgb;
    float total = 1.0;
    for (int i = 1; i <= 11; i++) {
      if (i > uRadius) break;
      float w = exp(float(i * i) * k);
      vec2 o = uTexel * float(i);
      sum += w * (texture2D(uImage, vUv + o).rgb + texture2D(uImage, vUv - o).rgb);
      total += 2.0 * w;
    }
    gl_FragColor = vec4(sum / total, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D uMip0;
  uniform sampler2D uMip1;
  uniform sampler2D uMip2;
  uniform sampler2D uMip3;
  uniform sampler2D uMip4;
  uniform float uWeights[${MIPS}];
  varying vec2 vUv;
  void main() {
    vec3 c = uWeights[0] * texture2D(uMip0, vUv).rgb
           + uWeights[1] * texture2D(uMip1, vUv).rgb
           + uWeights[2] * texture2D(uMip2, vUv).rgb
           + uWeights[3] * texture2D(uMip3, vUv).rgb
           + uWeights[4] * texture2D(uMip4, vUv).rgb;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Merge the trail history (some layers) with the full scene: larger deviation from the background wins. */
const COMBINE_FRAGMENT = /* glsl */ `
  uniform sampler2D uCurrent;
  uniform sampler2D uHistory;
  uniform vec3 uBackground;
  varying vec2 vUv;
  void main() {
    vec3 dc = texture2D(uCurrent, vUv).rgb - uBackground;
    vec3 dh = texture2D(uHistory, vUv).rgb - uBackground;
    gl_FragColor = vec4(uBackground + mix(dh, dc, step(abs(dh), abs(dc))), 1.0);
  }
`;

const TRAILS_FRAGMENT = /* glsl */ `
  uniform sampler2D uCurrent;
  uniform sampler2D uPrevious;
  uniform sampler2D uBloom;
  uniform float uBloomOn;
  uniform float uKeep;
  uniform vec3 uBackground;
  varying vec2 vUv;
  void main() {
    vec3 cur = texture2D(uCurrent, vUv).rgb;
    if (uBloomOn > 0.5) cur += texture2D(uBloom, vUv).rgb;
    vec3 dc = cur - uBackground;
    vec3 dp = (texture2D(uPrevious, vUv).rgb - uBackground) * uKeep;
    #ifdef LOW_PRECISION
      // 8-bit history: rounding would otherwise leave faint residues that never decay.
      dp = sign(dp) * max(abs(dp) - 1.0 / 255.0, 0.0);
    #endif
    gl_FragColor = vec4(uBackground + mix(dp, dc, step(abs(dp), abs(dc))), 1.0);
  }
`;

type Report = (message: string) => void;
type Verify = (scene: Scene) => string | null;
/** Draw only `objects[0..count)` (cleared to the background) into `target`. */
type DrawOnly = (target: WebGLRenderTarget, objects: readonly (Object3D | null)[], count: number) => void;

interface Bloom {
  bright: WebGLRenderTarget;
  h: WebGLRenderTarget[];
  v: WebGLRenderTarget[];
  brightMaterial: ShaderMaterial;
  blurMaterial: ShaderMaterial;
  compositeMaterial: ShaderMaterial;
  weights: number[];
  /** A glow group's image (full size, no MSAA) and the summed glow of all groups (half size). */
  source: WebGLRenderTarget | null;
  sum: WebGLRenderTarget | null;
  lastUsed: number;
}

/** A trail history: ping-pong pair, `a` holds the newest image. */
interface History {
  a: WebGLRenderTarget;
  b: WebGLRenderTarget;
  reset: boolean;
  lastUsed: number;
}

interface Trails {
  material: ShaderMaterial;
  combineMaterial: ShaderMaterial;
  /** History of the whole-image chain. */
  whole: History | null;
  /** Per-layer histories, keyed by the layer's scene object. */
  layers: Map<Object3D, History>;
  /** A trail layer drawn alone (MSAA, like the scene), and the frame merged with histories. */
  source: WebGLRenderTarget | null;
  merged: [WebGLRenderTarget, WebGLRenderTarget] | null;
  lastUsed: number;
}

export class PostEffects {
  /** The image to present after process(), and the bloom to add to it (null when none). */
  image: Texture | null = null;
  bloomTexture: Texture | null = null;

  private bloom: Bloom | null = null;
  private trails: Trails | null = null;
  private bloomFailed = false;
  private trailsFailed = false;
  private lastPrune = 0;
  private readonly plan = emptyPlan();
  /** Scratch list of objects for drawOnly (reused; cleared after use so nothing is kept alive). */
  private readonly drawList: (Object3D | null)[] = [];
  private readonly savedClear = new Color();
  private overflowReported = false;

  private readonly quadGeometry = new PlaneGeometry(2, 2);
  private readonly quad: Mesh;
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bufferType: TextureDataType;

  constructor(
    private renderer: WebGLRenderer,
    private width: number,
    private height: number,
    /** Linear background colour (the scene's clear colour), read every frame. */
    private background: Color,
    private report: Report,
    private verify: Verify,
    private drawOnly: DrawOnly,
    /** MSAA samples of the scene target, used for a trail layer drawn alone. */
    private sceneSamples: number,
  ) {
    this.quad = new Mesh(this.quadGeometry);
    this.quad.frustumCulled = false;
    const ext = renderer.extensions;
    this.bufferType = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float') ? HalfFloatType : UnsignedByteType;
  }

  /** True when process() has anything to do (otherwise the caller skips it entirely). */
  active(layers: readonly FxLayer[], count: number): boolean {
    return anyEffect(layers, count) || this.bloom !== null || this.trails !== null;
  }

  /**
   * Run the effects of the first `count` visible layers on the resolved scene image. Sets
   * `image` and `bloomTexture` for the warp. `dt` in seconds from the frame clock, `nowMs`
   * any monotonic clock.
   */
  process(scene: Texture, dt: number, nowMs: number, layers: readonly FxLayer[], count: number): void {
    this.image = scene;
    this.bloomTexture = null;
    const plan = planEffects(layers, count, this.plan);

    if (plan.whole >= 0) this.runWhole(scene, dt, nowMs, layers[plan.whole]!);
    else {
      if (plan.glowGroupCount > 0 && !this.bloomFailed && this.ensureBloom(nowMs)) {
        try {
          this.runGlowGroups(layers, count, nowMs);
        } catch (err) {
          this.failBloom(`glow failed: ${describe(err)}`);
          this.bloomTexture = null;
        }
      }
      if (plan.trailCount > 0 && !this.trailsFailed && this.ensureTrails(nowMs)) {
        try {
          for (let i = 0; i < plan.trailCount; i++) this.runLayerTrails(layers[plan.trails[i]!]!, scene, dt, nowMs);
        } catch (err) {
          this.failTrails(`trails failed: ${describe(err)}`);
          this.image = scene;
        }
      }
      if (plan.trailOverflow > 0 && !this.overflowReported) {
        this.overflowReported = true;
        this.report(`trails are limited to ${plan.trails.length} layers; ${plan.trailOverflow} more are drawn without trails`);
      }
    }
    this.release(nowMs);
    this.renderer.setRenderTarget(null);
  }

  /** WebGL context restored: everything on the GPU is gone; rebuild lazily, retry failures. */
  contextRestored(): void {
    this.disposeBloom();
    this.disposeTrails();
    this.bloomFailed = false;
    this.trailsFailed = false;
  }

  dispose(): void {
    this.disposeBloom();
    this.disposeTrails();
    this.quadGeometry.dispose();
  }

  // ---- the two chains ------------------------------------------------------------

  /** Every visible layer shares `fx`: bloom and trails on the whole image. */
  private runWhole(scene: Texture, dt: number, nowMs: number, fx: FxLayer): void {
    let glow: Texture | null = null;
    if (fx.glow && !this.bloomFailed && this.ensureBloom(nowMs)) {
      try {
        this.runBloom(scene, fx, null);
        glow = this.bloom!.h[0]!.texture;
      } catch (err) {
        this.failBloom(`glow failed: ${describe(err)}`);
      }
    }
    this.bloomTexture = glow;
    if (fx.trails && !this.trailsFailed && this.ensureTrails(nowMs)) {
      try {
        const t = this.trails!;
        t.whole ??= this.makeHistory();
        if (nowMs - t.whole.lastUsed > STALE_MS) t.whole.reset = true;
        t.whole.lastUsed = nowMs;
        this.image = this.runTrails(t.whole, scene, glow, fx.persistence, dt);
        this.bloomTexture = null; // already added into the image
      } catch (err) {
        this.failTrails(`trails failed: ${describe(err)}`);
        this.image = scene;
      }
    }
  }

  /** Layers with glow and no trails, by group: draw, bloom, and sum into one texture. */
  private runGlowGroups(layers: readonly FxLayer[], count: number, nowMs: number): void {
    const b = this.bloom!;
    const plan = this.plan;
    b.source ??= this.makeTarget(this.width, this.height, { type: UnsignedByteType, depth: true });
    b.sum ??= this.makeTarget(b.h[0]!.width, b.h[0]!.height);
    b.lastUsed = nowMs;
    const r = this.renderer;
    r.getClearColor(this.savedClear);
    const alpha = r.getClearAlpha();
    r.setRenderTarget(b.sum);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    r.setClearColor(this.savedClear, alpha);
    for (let g = 0; g < plan.glowGroupCount; g++) {
      const list = this.drawList;
      let n = 0;
      for (let i = 0; i < count; i++) if (plan.glowGroup[i] === g) list[n++] = layers[i]!.object as Object3D;
      this.drawOnly(b.source, list, n);
      this.runBloom(b.source.texture, layers[plan.glowLead[g]!]!, b.sum);
    }
    this.drawList.fill(null);
    this.bloomTexture = b.sum.texture;
  }

  /** One trail layer: draw it alone, add its glow, update its history, merge into the frame. */
  private runLayerTrails(fx: FxLayer, scene: Texture, dt: number, nowMs: number): void {
    const t = this.trails!;
    const object = fx.object as Object3D;
    t.source ??= this.makeTarget(this.width, this.height, { type: UnsignedByteType, depth: true, samples: this.sceneSamples });
    t.merged ??= [this.makeTarget(this.width, this.height), this.makeTarget(this.width, this.height)];
    this.drawList[0] = object;
    this.drawOnly(t.source, this.drawList, 1);
    this.drawList[0] = null;

    let glow: Texture | null = null;
    if (fx.glow && !this.bloomFailed && this.ensureBloom(nowMs)) {
      try {
        this.runBloom(t.source.texture, fx, null);
        glow = this.bloom!.h[0]!.texture;
      } catch (err) {
        this.failBloom(`glow failed: ${describe(err)}`);
      }
    }

    let history = t.layers.get(object);
    if (!history) {
      history = this.makeHistory();
      t.layers.set(object, history);
    }
    if (nowMs - history.lastUsed > STALE_MS) history.reset = true;
    history.lastUsed = nowMs;
    const newest = this.runTrails(history, t.source.texture, glow, fx.persistence, dt);

    // Merge: the frame so far (the scene, or the previous merge) with this layer's history.
    const out = this.image === t.merged[0].texture ? t.merged[1] : t.merged[0];
    const u = t.combineMaterial.uniforms;
    u.uCurrent!.value = this.image ?? scene;
    u.uHistory!.value = newest;
    this.draw(t.combineMaterial, out);
    this.image = out.texture;
  }

  // ---- bloom ---------------------------------------------------------------------

  private ensureBloom(nowMs: number): boolean {
    if (this.bloom) {
      this.bloom.lastUsed = nowMs;
      return true;
    }
    try {
      const w0 = Math.max(1, Math.round(this.width / 2));
      const h0 = Math.max(1, Math.round(this.height / 2));
      const bright = this.makeTarget(w0, h0);
      const h: WebGLRenderTarget[] = [];
      const v: WebGLRenderTarget[] = [];
      for (let i = 0; i < MIPS; i++) {
        const w = Math.max(1, Math.round(w0 / 2 ** i));
        const ht = Math.max(1, Math.round(h0 / 2 ** i));
        h.push(this.makeTarget(w, ht));
        v.push(this.makeTarget(w, ht));
      }
      const brightMaterial = quadMaterial(BRIGHT_FRAGMENT, { uImage: { value: null }, uThreshold: { value: 1 } });
      const blurMaterial = quadMaterial(BLUR_FRAGMENT, { uImage: { value: null }, uTexel: { value: new Vector2() }, uRadius: { value: 3 } });
      const weights = [0, 0, 0, 0, 0];
      const compositeMaterial = quadMaterial(COMPOSITE_FRAGMENT, {
        uMip0: { value: v[0]!.texture },
        uMip1: { value: v[1]!.texture },
        uMip2: { value: v[2]!.texture },
        uMip3: { value: v[3]!.texture },
        uMip4: { value: v[4]!.texture },
        uWeights: { value: weights },
      });
      this.bloom = { bright, h, v, brightMaterial, blurMaterial, compositeMaterial, weights, source: null, sum: null, lastUsed: nowMs };
      const problem = this.check([brightMaterial, blurMaterial, compositeMaterial]);
      if (problem) {
        this.failBloom(`glow disabled: shader failed: ${problem}`);
        return false;
      }
      return true;
    } catch (err) {
      this.failBloom(`glow disabled: ${describe(err)}`);
      return false;
    }
  }

  /**
   * Bloom `source` with `fx`'s settings. The result goes to h[0] (replacing it), or is added
   * into `sumInto` when given.
   */
  private runBloom(source: Texture, fx: FxLayer, sumInto: WebGLRenderTarget | null): void {
    const b = this.bloom!;
    b.brightMaterial.uniforms.uImage!.value = source;
    b.brightMaterial.uniforms.uThreshold!.value = fx.threshold;
    this.draw(b.brightMaterial, b.bright);

    const blur = b.blurMaterial.uniforms;
    let input = b.bright;
    for (let i = 0; i < MIPS; i++) {
      const h = b.h[i]!;
      const v = b.v[i]!;
      blur.uRadius!.value = KERNEL[i]!;
      // Horizontal pass samples its input; texel size is that of the target being written,
      // so each level blurs at its own scale (inputs are the same size or twice as large).
      blur.uImage!.value = input.texture;
      (blur.uTexel!.value as Vector2).set(1 / h.width, 0);
      this.draw(b.blurMaterial, h);
      blur.uImage!.value = h.texture;
      (blur.uTexel!.value as Vector2).set(0, 1 / v.height);
      this.draw(b.blurMaterial, v);
      input = v;
    }

    for (let i = 0; i < MIPS; i++) {
      const f = FACTORS[i]!;
      b.weights[i] = fx.strength * (f + (1.2 - 2 * f) * fx.radius); // mix(f, 1.2 - f, radius)
    }
    if (sumInto) {
      b.compositeMaterial.blending = AdditiveBlending;
      this.draw(b.compositeMaterial, sumInto, false);
      b.compositeMaterial.blending = NoBlending;
    } else {
      this.draw(b.compositeMaterial, b.h[0]!);
    }
  }

  private failBloom(message: string): void {
    this.bloomFailed = true;
    this.disposeBloom();
    this.report(message);
  }

  private disposeBloom(): void {
    const b = this.bloom;
    if (!b) return;
    this.bloom = null;
    b.bright.dispose();
    b.source?.dispose();
    b.sum?.dispose();
    for (const t of b.h) t.dispose();
    for (const t of b.v) t.dispose();
    b.brightMaterial.dispose();
    b.blurMaterial.dispose();
    b.compositeMaterial.dispose();
  }

  // ---- trails --------------------------------------------------------------------

  private ensureTrails(nowMs: number): boolean {
    if (this.trails) {
      this.trails.lastUsed = nowMs;
      return true;
    }
    try {
      const material = quadMaterial(
        TRAILS_FRAGMENT,
        {
          uCurrent: { value: null },
          uPrevious: { value: null },
          uBloom: { value: null },
          uBloomOn: { value: 0 },
          uKeep: { value: 0 },
          uBackground: { value: this.background },
        },
        this.bufferType === UnsignedByteType ? { LOW_PRECISION: '' } : {},
      );
      const combineMaterial = quadMaterial(COMBINE_FRAGMENT, {
        uCurrent: { value: null },
        uHistory: { value: null },
        uBackground: { value: this.background },
      });
      this.trails = { material, combineMaterial, whole: null, layers: new Map(), source: null, merged: null, lastUsed: nowMs };
      const problem = this.check([material, combineMaterial]);
      if (problem) {
        this.failTrails(`trails disabled: shader failed: ${problem}`);
        return false;
      }
      return true;
    } catch (err) {
      this.failTrails(`trails disabled: ${describe(err)}`);
      return false;
    }
  }

  private makeHistory(): History {
    return { a: this.makeTarget(this.width, this.height), b: this.makeTarget(this.width, this.height), reset: true, lastUsed: 0 };
  }

  /** Feed `current` (+ `bloom`) into `history`; returns the newest history image. */
  private runTrails(history: History, current: Texture, bloom: Texture | null, persistence: number, dt: number): Texture {
    const u = this.trails!.material.uniforms;
    const step = Math.min(Math.max(dt, 0), MAX_DT) * 60;
    u.uCurrent!.value = current;
    u.uPrevious!.value = history.a.texture;
    u.uBloom!.value = bloom;
    u.uBloomOn!.value = bloom ? 1 : 0;
    u.uKeep!.value = history.reset ? 0 : Math.pow(persistence, step);
    history.reset = false;
    this.draw(this.trails!.material, history.b);
    // Swap: b now holds the newest image and becomes next frame's history.
    const newest = history.b;
    history.b = history.a;
    history.a = newest;
    return newest.texture;
  }

  private failTrails(message: string): void {
    this.trailsFailed = true;
    this.disposeTrails();
    this.report(message);
  }

  private disposeHistory(h: History): void {
    h.a.dispose();
    h.b.dispose();
  }

  private disposeTrails(): void {
    const t = this.trails;
    if (!t) return;
    this.trails = null;
    if (t.whole) this.disposeHistory(t.whole);
    for (const h of t.layers.values()) this.disposeHistory(h);
    t.layers.clear();
    t.source?.dispose();
    t.merged?.[0].dispose();
    t.merged?.[1].dispose();
    t.material.dispose();
    t.combineMaterial.dispose();
  }

  /** Release what has not been used for GRACE_MS (checked at most once per PRUNE_MS). */
  private release(nowMs: number): void {
    if (nowMs - this.lastPrune < PRUNE_MS) return;
    this.lastPrune = nowMs;
    const b = this.bloom;
    if (b && nowMs - b.lastUsed > GRACE_MS) this.disposeBloom();
    const t = this.trails;
    if (!t) return;
    if (nowMs - t.lastUsed > GRACE_MS) {
      this.disposeTrails();
      return;
    }
    if (t.whole && nowMs - t.whole.lastUsed > GRACE_MS) {
      this.disposeHistory(t.whole);
      t.whole = null;
    }
    for (const [object, h] of t.layers) {
      if (nowMs - h.lastUsed > GRACE_MS) {
        this.disposeHistory(h);
        t.layers.delete(object);
      }
    }
  }

  // ---- helpers -------------------------------------------------------------------

  private draw(material: ShaderMaterial, target: WebGLRenderTarget, clear = true): void {
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

  private makeTarget(
    width: number,
    height: number,
    o: { type?: TextureDataType; depth?: boolean; samples?: number } = {},
  ): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      type: o.type ?? this.bufferType,
      depthBuffer: o.depth ?? false,
      samples: o.samples ?? 0,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
    });
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

function quadMaterial(
  fragmentShader: string,
  uniforms: ShaderMaterial['uniforms'],
  defines: Record<string, string> = {},
): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: QUAD_VERTEX,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
