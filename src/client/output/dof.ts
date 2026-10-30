import {
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
  type Camera as ThreeCamera,
  type OrthographicCamera as ThreeOrthographicCamera,
  type PerspectiveCamera,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import { DOF_MIN_RAMP, focusDistance } from '../../shared/dof.ts';
import type { OrbitCamera } from '../../shared/project-schema.ts';

/*
 * Camera depth of field (DofSchema; maths and its tested twin in shared/dof.ts). It runs on
 * the finished 3D scene image and its depth, in place:
 *
 *   1. prepare (half size): colour (a 2x2 box) and the signed blur radius in half-size px
 *      (negative in front of the focus, positive behind) from the depth.
 *   2. gather (half size): a golden-angle disc of TAPS samples out to the largest blur, turned
 *      per pixel so banding becomes fine noise. A sample counts where its own blur reaches this
 *      pixel. A sample behind this pixel counts only as far as this pixel's own blur, so a
 *      blurred background never spreads over a sharp object in front of it.
 *   3. composite (full size, into `out`): the sharp image where the blur is under a pixel,
 *      the gathered one (smoothed by four bilinear taps) where it is more.
 *   4. copy `out` back into the scene target (which may be the multisampled one, or a plain
 *      one in the preview, so it is never read and written in the same pass).
 *
 * Objects in front of the focus blur within their own outline over a sharp background
 * (there is no separate near-field layer); over a blurred background they spread.
 *
 * Cost: nothing until switched on. Then three half-size targets and one full-size target,
 * made on first need and released after GRACE_MS without use. Measured on the GTX 1650 at
 * 1080p: about 1.5 ms a frame, including Stage's depth-only pass for a text layer. A shader failure turns depth of field off (reported once) until a
 * context restore; the image is then left sharp.
 */

const GRACE_MS = 10_000;
const TAPS = 40;

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Blur radius from depth; twin of blurAt / viewDistance in shared/dof.ts. */
const COC = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uNear;
  uniform float uFar;
  uniform float uOrtho;
  uniform float uFocus;
  uniform float uZone;
  uniform float uRamp;
  uniform float uAmount;
  float viewDistance(float d) {
    return uOrtho > 0.5 ? uNear + d * (uFar - uNear) : (uNear * uFar) / (uFar - d * (uFar - uNear));
  }
  float cocAt(vec2 uv) {
    float z = viewDistance(texture2D(uDepth, uv).r);
    float t = clamp((abs(z - uFocus) - uZone * 0.5) / uRamp, 0.0, 1.0);
    return (z < uFocus ? -1.0 : 1.0) * t * uAmount;
  }
`;

const PREPARE_FRAGMENT = /* glsl */ `
  uniform sampler2D uColour;
  ${COC}
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(uColour, vUv).rgb, cocAt(vUv));
  }
`;

const GATHER_FRAGMENT = /* glsl */ `
  uniform sampler2D uPrep;
  uniform vec2 uTexel;
  uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vec4 centre = texture2D(uPrep, vUv);
    float c0 = centre.a;
    vec3 sum = centre.rgb;
    float total = 1.0;
    // Interleaved gradient noise: a different turn of the disc per pixel.
    float turn = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    for (int i = 0; i < ${TAPS}; i++) {
      float f = float(i);
      float r = uRadius * sqrt((f + 0.5) / float(${TAPS}));
      float a = f * 2.39996323 + turn;
      vec4 s = texture2D(uPrep, vUv + vec2(cos(a), sin(a)) * r * uTexel);
      float reach = s.a > c0 ? min(abs(s.a), abs(c0)) : abs(s.a);
      float w = clamp(reach - r + 0.5, 0.0, 1.0);
      sum += s.rgb * w;
      total += w;
    }
    gl_FragColor = vec4(sum / total, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D uColour;
  uniform sampler2D uGather;
  uniform vec2 uHalfTexel;
  ${COC}
  varying vec2 vUv;
  void main() {
    vec4 sharp = texture2D(uColour, vUv);
    vec2 o = 0.5 * uHalfTexel;
    vec3 blurred = 0.25 * (
      texture2D(uGather, vUv + vec2(o.x, o.y)).rgb + texture2D(uGather, vUv + vec2(-o.x, o.y)).rgb +
      texture2D(uGather, vUv + vec2(o.x, -o.y)).rgb + texture2D(uGather, vUv + vec2(-o.x, -o.y)).rgb);
    float t = smoothstep(0.5, 1.5, abs(cocAt(vUv)));
    gl_FragColor = vec4(mix(sharp.rgb, blurred, t), sharp.a);
  }
`;

const COPY_FRAGMENT = /* glsl */ `
  uniform sampler2D uImage;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uImage, vUv);
  }
`;

type Report = (message: string) => void;
type Verify = (scene: Scene) => string | null;

interface Resources {
  prep: WebGLRenderTarget;
  gather: WebGLRenderTarget;
  out: WebGLRenderTarget;
  prepare: ShaderMaterial;
  gatherMaterial: ShaderMaterial;
  composite: ShaderMaterial;
  copy: ShaderMaterial;
  lastUsed: number;
}

function cocUniforms(): ShaderMaterial['uniforms'] {
  return {
    uDepth: { value: null },
    uNear: { value: 1 },
    uFar: { value: 2 },
    uOrtho: { value: 0 },
    uFocus: { value: 0 },
    uZone: { value: 0 },
    uRamp: { value: DOF_MIN_RAMP },
    uAmount: { value: 0 },
  };
}

export class DepthOfField {
  private res: Resources | null = null;
  private failed = false;
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

  /** False once it has failed (until a context restore). */
  usable(): boolean {
    return !this.failed;
  }

  /**
   * Blur `target` (its resolved colour and depth texture) in place for `cfg`'s depth of field
   * as seen by `camera` (the 3D camera the scene was drawn with). False when unavailable.
   */
  apply(target: WebGLRenderTarget, camera: ThreeCamera, cfg: OrbitCamera, nowMs: number): boolean {
    if (!target.depthTexture) return false;
    const res = this.ensure(nowMs);
    if (!res) return false;
    res.lastUsed = nowMs;
    const halfAmount = (cfg.dof.amount * this.scale) / 2;
    this.setCoc(res.prepare, target, camera, cfg, halfAmount);
    res.prepare.uniforms.uColour!.value = target.texture;
    this.draw(res.prepare, res.prep);

    const g = res.gatherMaterial.uniforms;
    g.uPrep!.value = res.prep.texture;
    (g.uTexel!.value as Vector2).set(1 / res.prep.width, 1 / res.prep.height);
    g.uRadius!.value = halfAmount;
    this.draw(res.gatherMaterial, res.gather);

    this.setCoc(res.composite, target, camera, cfg, cfg.dof.amount * this.scale);
    const c = res.composite.uniforms;
    c.uColour!.value = target.texture;
    c.uGather!.value = res.gather.texture;
    (c.uHalfTexel!.value as Vector2).set(1 / res.gather.width, 1 / res.gather.height);
    this.draw(res.composite, res.out);

    res.copy.uniforms.uImage!.value = res.out.texture;
    this.draw(res.copy, target);
    return true;
  }

  /** The blur-radius uniforms of a prepare or composite pass; `amount` in that pass's pixels. */
  private setCoc(m: ShaderMaterial, target: WebGLRenderTarget, camera: ThreeCamera, cfg: OrbitCamera, amount: number): void {
    const lens = camera as PerspectiveCamera | ThreeOrthographicCamera;
    const u = m.uniforms;
    u.uDepth!.value = target.depthTexture;
    u.uNear!.value = lens.near;
    u.uFar!.value = lens.far;
    u.uOrtho!.value = (camera as ThreeOrthographicCamera).isOrthographicCamera === true ? 1 : 0;
    u.uFocus!.value = focusDistance(cfg);
    u.uZone!.value = cfg.dof.depth;
    u.uRamp!.value = Math.max(cfg.dof.depth, DOF_MIN_RAMP);
    u.uAmount!.value = amount;
  }

  /** Release everything when unused for GRACE_MS. */
  release(nowMs: number): void {
    if (this.res && nowMs - this.res.lastUsed > GRACE_MS) this.disposeResources();
  }

  /** WebGL context restored: everything on the GPU is gone; rebuild lazily, retry a failure. */
  contextRestored(): void {
    this.disposeResources();
    this.failed = false;
  }

  dispose(): void {
    this.disposeResources();
    this.quadGeometry.dispose();
  }

  private ensure(nowMs: number): Resources | null {
    if (this.failed) return null;
    if (this.res) return this.res;
    try {
      const hw = Math.max(1, Math.round(this.width / 2));
      const hh = Math.max(1, Math.round(this.height / 2));
      const prepare = quadMaterial(PREPARE_FRAGMENT, { ...cocUniforms(), uColour: { value: null } });
      const gatherMaterial = quadMaterial(GATHER_FRAGMENT, { uPrep: { value: null }, uTexel: { value: new Vector2() }, uRadius: { value: 0 } });
      const composite = quadMaterial(COMPOSITE_FRAGMENT, {
        ...cocUniforms(),
        uColour: { value: null },
        uGather: { value: null },
        uHalfTexel: { value: new Vector2() },
      });
      const copy = quadMaterial(COPY_FRAGMENT, { uImage: { value: null } });
      this.res = {
        prep: makeTarget(hw, hh, this.bufferType),
        gather: makeTarget(hw, hh, this.bufferType),
        out: makeTarget(this.width, this.height, UnsignedByteType),
        prepare,
        gatherMaterial,
        composite,
        copy,
        lastUsed: nowMs,
      };
      const problem = this.check([prepare, gatherMaterial, composite, copy]);
      if (problem) {
        this.fail(`depth of field disabled: shader failed: ${problem}`);
        return null;
      }
      return this.res;
    } catch (err) {
      this.fail(`depth of field disabled: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private draw(material: ShaderMaterial, target: WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      this.renderer.render(this.quad, this.quadCamera);
    } finally {
      this.renderer.autoClear = autoClear;
    }
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
    res.prep.dispose();
    res.gather.dispose();
    res.out.dispose();
    res.prepare.dispose();
    res.gatherMaterial.dispose();
    res.composite.dispose();
    res.copy.dispose();
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

function makeTarget(width: number, height: number, type: TextureDataType): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    type,
    depthBuffer: false,
    stencilBuffer: false,
    samples: 0,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
  });
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
