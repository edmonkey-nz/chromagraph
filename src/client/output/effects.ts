import {
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
  type Texture,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import type { Effects } from '../../shared/project-schema.ts';

/*
 * Whole-output effects on the rendered 1080p image, before the keystone warp:
 *
 *   scene (MSAA target, resolved) -> bloom -> trails -> warp
 *
 * Bloom is a threshold -> five-level blurred mip chain -> weighted sum, at half the target
 * resolution. It is never written back into the scene target (three invalidates the MSAA
 * buffer after resolving it); instead the half-resolution bloom texture is added by whoever
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
 * Cost: with both effects off nothing here runs and nothing is allocated. Targets are made
 * on first enable and released after GRACE_MS of being off (so a toggle, a morph or a
 * modulator that briefly passes through zero does not thrash VRAM, but an installation that
 * stops using an effect gets its memory back). A context restore drops everything; it is
 * rebuilt lazily. setEffects() only copies numbers; the passes read them as uniforms.
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
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.05, l), 1.0);
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

interface Bloom {
  bright: WebGLRenderTarget;
  h: WebGLRenderTarget[];
  v: WebGLRenderTarget[];
  brightMaterial: ShaderMaterial;
  blurMaterial: ShaderMaterial;
  compositeMaterial: ShaderMaterial;
  weights: number[];
}

interface Trails {
  a: WebGLRenderTarget;
  b: WebGLRenderTarget;
  material: ShaderMaterial;
}

export class PostEffects {
  /** The image to present after process(), and the bloom to add to it (null when none). */
  image: Texture | null = null;
  bloomTexture: Texture | null = null;

  private bloomEnabled = false;
  private strength = 0;
  private radius = 0;
  private threshold = 1;
  private trailsEnabled = false;
  private persistence = 0;

  private bloom: Bloom | null = null;
  private trails: Trails | null = null;
  private bloomFailed = false;
  private trailsFailed = false;
  private bloomOffSince = -1;
  private trailsOffSince = -1;
  private trailsReset = true;

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
  ) {
    this.quad = new Mesh(this.quadGeometry);
    this.quad.frustumCulled = false;
    const ext = renderer.extensions;
    this.bufferType = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float') ? HalfFloatType : UnsignedByteType;
  }

  /** Copy the effect settings. Cheap (numbers only): called per frame when modulated. */
  set(effects: Effects): void {
    const b = effects.bloom;
    this.bloomEnabled = b.enabled;
    this.strength = b.strength;
    this.radius = b.radius;
    this.threshold = b.threshold;
    this.trailsEnabled = effects.trails.enabled;
    this.persistence = effects.trails.persistence;
  }

  /** True when process() would run any pass (otherwise the caller skips it entirely). */
  get active(): boolean {
    return this.bloomActive || this.trailsActive || this.bloom !== null || this.trails !== null;
  }

  private get bloomActive(): boolean {
    return this.bloomEnabled && this.strength > 0 && !this.bloomFailed;
  }

  private get trailsActive(): boolean {
    return this.trailsEnabled && this.persistence > 0 && !this.trailsFailed;
  }

  /**
   * Run the active effects on the resolved scene image. Sets `image` and `bloomTexture` for
   * the warp. `dt` in seconds from the frame clock, `nowMs` any monotonic clock.
   */
  process(scene: Texture, dt: number, nowMs: number): void {
    this.image = scene;
    this.bloomTexture = null;

    // Release resources of effects that have stayed off for the grace period.
    if (this.bloomActive) this.bloomOffSince = -1;
    else if (this.bloom) {
      if (this.bloomOffSince < 0) this.bloomOffSince = nowMs;
      else if (nowMs - this.bloomOffSince > GRACE_MS) this.disposeBloom();
    }
    if (this.trailsActive) this.trailsOffSince = -1;
    else {
      this.trailsReset = true; // turning trails back on must not show a stale history
      if (this.trails) {
        if (this.trailsOffSince < 0) this.trailsOffSince = nowMs;
        else if (nowMs - this.trailsOffSince > GRACE_MS) this.disposeTrails();
      }
    }

    if (this.bloomActive && this.ensureBloom()) {
      try {
        this.runBloom(scene);
      } catch (err) {
        this.failBloom(`bloom failed: ${describe(err)}`);
        this.bloomTexture = null;
      }
    }
    if (this.trailsActive && this.ensureTrails()) {
      try {
        this.runTrails(scene, dt);
      } catch (err) {
        this.failTrails(`trails failed: ${describe(err)}`);
        this.image = scene;
      }
    }
    this.renderer.setRenderTarget(null);
  }

  /** WebGL context restored: everything on the GPU is gone; rebuild lazily, retry failures. */
  contextRestored(): void {
    this.disposeBloom();
    this.disposeTrails();
    this.bloomFailed = false;
    this.trailsFailed = false;
    this.trailsReset = true;
  }

  dispose(): void {
    this.disposeBloom();
    this.disposeTrails();
    this.quadGeometry.dispose();
  }

  // ---- bloom ---------------------------------------------------------------------

  private ensureBloom(): boolean {
    if (this.bloom) return true;
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
      this.bloom = { bright, h, v, brightMaterial, blurMaterial, compositeMaterial, weights };
      const problem = this.check([brightMaterial, blurMaterial, compositeMaterial]);
      if (problem) {
        this.failBloom(`bloom disabled: shader failed: ${problem}`);
        return false;
      }
      return true;
    } catch (err) {
      this.failBloom(`bloom disabled: ${describe(err)}`);
      return false;
    }
  }

  private runBloom(scene: Texture): void {
    const b = this.bloom!;
    b.brightMaterial.uniforms.uImage!.value = scene;
    b.brightMaterial.uniforms.uThreshold!.value = this.threshold;
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
      b.weights[i] = this.strength * (f + (1.2 - 2 * f) * this.radius); // mix(f, 1.2 - f, radius)
    }
    this.draw(b.compositeMaterial, b.h[0]!);
    this.bloomTexture = b.h[0]!.texture;
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
    this.bloomOffSince = -1;
    b.bright.dispose();
    for (const t of b.h) t.dispose();
    for (const t of b.v) t.dispose();
    b.brightMaterial.dispose();
    b.blurMaterial.dispose();
    b.compositeMaterial.dispose();
  }

  // ---- trails --------------------------------------------------------------------

  private ensureTrails(): boolean {
    if (this.trails) return true;
    try {
      const a = this.makeTarget(this.width, this.height);
      const b = this.makeTarget(this.width, this.height);
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
      this.trails = { a, b, material };
      this.trailsReset = true;
      const problem = this.check([material]);
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

  private runTrails(scene: Texture, dt: number): void {
    const t = this.trails!;
    const u = t.material.uniforms;
    const step = Math.min(Math.max(dt, 0), MAX_DT) * 60;
    u.uCurrent!.value = scene;
    u.uPrevious!.value = t.a.texture;
    u.uBloom!.value = this.bloomTexture;
    u.uBloomOn!.value = this.bloomTexture ? 1 : 0;
    u.uKeep!.value = this.trailsReset ? 0 : Math.pow(this.persistence, step);
    this.trailsReset = false;
    this.draw(t.material, t.b);
    // Swap: b now holds the newest image and becomes next frame's history.
    const newest = t.b;
    t.b = t.a;
    t.a = newest;
    this.image = newest.texture;
    this.bloomTexture = null; // already added into the image
  }

  private failTrails(message: string): void {
    this.trailsFailed = true;
    this.disposeTrails();
    this.report(message);
  }

  private disposeTrails(): void {
    const t = this.trails;
    if (!t) return;
    this.trails = null;
    this.trailsOffSince = -1;
    t.a.dispose();
    t.b.dispose();
    t.material.dispose();
  }

  // ---- helpers -------------------------------------------------------------------

  private draw(material: ShaderMaterial, target: WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, this.quadCamera);
  }

  private makeTarget(width: number, height: number): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      type: this.bufferType,
      depthBuffer: false,
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
