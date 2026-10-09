import {
  AdditiveBlending,
  Color,
  DepthTexture,
  DoubleSide,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  NormalBlending,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FRAME_CENTRE, type ReflectorLayer } from '../../../shared/layer-schema.ts';
import { SCREEN_FIXED_TAG } from '../stage.ts';
import { SHOWN_TAG, type FrameContext, type LayerInstance } from './layer.ts';

/**
 * Reflection plane: a flat mirror placed by the layer transform. Before its first draw in a
 * frame, the scene is rendered from the camera mirrored in the plane into a half-resolution
 * target (with a depth texture), with the plane's own side of space clipped away by an
 * oblique near plane (as three's Reflector does). The target is cleared to transparent, so
 * its alpha is how much was reflected there (premultiplied colour), and translucent layers
 * write depth for this render only, so they fade like solid ones. The plane then samples that
 * image through its projective texture coordinates:
 *   blur          a 12-tap disc over the mipmapped reflection (roughness)
 *   fade          each tap's depth gives the reflected point's distance from the plane, so the
 *                 reflection fades out with height above the floor
 *   reflectivity  how far the plane colour mixes towards the reflection, where something is
 *                 reflected (empty sky leaves the plane colour)
 *
 * Cost: one extra scene render per frame at half the target's resolution, however many
 * passes draw the scene afterwards (the effects draw it again for glow and trails; they reuse
 * this frame's reflection). The reflection always shows every layer that is switched on, also
 * when a pass draws only some of them, but never a reflection plane (itself included) or a
 * layer fixed to the screen.
 *
 * With the 2D camera, or fixed to the screen itself, there is nothing to mirror in a
 * meaningful way: the plane is drawn in its colour alone and no extra render happens.
 */

export interface ReflectorInstance extends LayerInstance {
  apply(layer: ReflectorLayer, cameraMode: '2d' | '3d'): void;
}

/** Marks a reflector's root object: reflections never include reflection planes. */
export const REFLECTOR_TAG = 'reflector';

const TAPS = 12;
/** Blur radius at blur = 1, in reflection-target texels. */
const MAX_BLUR_TEXELS = 28;

const vertexShader = /* glsl */ `
  uniform mat4 uTextureMatrix;
  varying vec4 vProj;
  void main() {
    vProj = uTextureMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uReflection;
  uniform highp sampler2D uDepth;
  uniform mat4 uInverseProjection;
  uniform vec4 uPlane;          // the plane in the reflection camera's view space
  uniform vec2 uTexel;
  uniform float uOn;
  uniform vec3 uColour;
  uniform float uOpacity;
  uniform float uReflectivity;
  uniform float uBlur;
  uniform float uFade;
  varying vec4 vProj;

  // Weight of one tap, fading with the reflected point's distance from the plane (taps with no
  // depth, e.g. additive layers, are not faded).
  float tapWeight(vec2 uv) {
    if (uFade <= 0.0) return 1.0;
    float d = texture2D(uDepth, uv).r;
    if (d >= 1.0) return 1.0;
    vec4 v = uInverseProjection * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
    float dist = abs(dot(uPlane.xyz, v.xyz / v.w) + uPlane.w);
    float f = 1.0 - clamp(dist / uFade, 0.0, 1.0);
    return f * f;
  }

  void main() {
    vec3 col = uColour;
    if (uOn > 0.5 && uReflectivity > 0.0) {
      vec2 uv = vProj.xy / vProj.w;
      float radius = uBlur * ${MAX_BLUR_TEXELS.toFixed(1)};
      float lod = log2(1.0 + radius / 3.0);
      int taps = radius > 0.5 ? ${TAPS} : 1;
      vec3 sum = vec3(0.0);
      float cover = 0.0;
      for (int i = 0; i < ${TAPS}; i++) {
        if (i >= taps) break;
        // Golden-angle disc: even coverage for any tap count.
        float r = taps == 1 ? 0.0 : sqrt((float(i) + 0.5) / float(taps)) * radius;
        float a = float(i) * 2.39996;
        vec2 q = clamp(uv + vec2(cos(a), sin(a)) * r * uTexel, vec2(0.0), vec2(1.0));
        vec4 c = textureLod(uReflection, q, lod) * tapWeight(q);
        sum += c.rgb;
        cover += c.a;
      }
      // Premultiplied: mix towards the reflection by reflectivity x coverage, so empty or
      // faded taps leave the plane colour.
      float n = float(taps);
      col = col * (1.0 - uReflectivity * cover / n) + uReflectivity * sum / n;
    }
    gl_FragColor = vec4(col, uOpacity);
  }
`;

export function createReflector(layer: ReflectorLayer, cameraMode: '2d' | '3d'): ReflectorInstance {
  const root = new Group();
  root.name = layer.name;
  root.userData[REFLECTOR_TAG] = true;

  const target = new WebGLRenderTarget(2, 2, {
    depthBuffer: true,
    samples: 0,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
  });
  target.depthTexture = new DepthTexture(2, 2, UnsignedIntType);

  const textureMatrix = new Matrix4();
  const inverseProjection = new Matrix4();
  const planeUniform = new Vector4();
  const texel = new Vector2(0.5, 0.5);
  const colour = new Color();
  const uniforms = {
    uReflection: { value: target.texture },
    uDepth: { value: target.depthTexture },
    uTextureMatrix: { value: textureMatrix },
    uInverseProjection: { value: inverseProjection },
    uPlane: { value: planeUniform },
    uTexel: { value: texel },
    uOn: { value: 0 },
    uColour: { value: colour },
    uOpacity: { value: 1 },
    uReflectivity: { value: 0.5 },
    uBlur: { value: 0 },
    uFade: { value: 0 },
  };
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: DoubleSide });
  const geometry = new PlaneGeometry(1, 1);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.position.set(FRAME_CENTRE[0], FRAME_CENTRE[1], FRAME_CENTRE[2]);
  root.add(mesh);

  // ---- per-frame reflection (no allocation) ----
  const mirrorPerspective = new PerspectiveCamera();
  const mirrorOrtho = new OrthographicCamera();
  const plane = new Plane();
  const normal = new Vector3();
  const planePoint = new Vector3();
  const eye = new Vector3();
  const look = new Vector3();
  const rotation = new Matrix4();
  const clip = new Vector4();
  const q = new Vector4();
  const size = new Vector2();
  /** Scene children whose visibility the reflection render changed, and what it was. */
  const changed: Object3D[] = [];
  const was: boolean[] = [];
  /** Translucent materials made to write depth for the reflection render (restored after). */
  const forced: Material[] = [];
  const clearColour = new Color();
  let clearAlpha = 1;
  let background: Scene['background'] | undefined;
  const forceOne = (m: Material) => {
    if (m.transparent && !m.depthWrite && m.depthTest) {
      m.depthWrite = true;
      forced.push(m);
    }
  };
  /** Pre-bound for traverseVisible (no per-frame closures). */
  const forceDepth = (o: Object3D) => {
    const m = (o as Mesh).material as Material | Material[] | undefined;
    if (!m) return;
    if (Array.isArray(m)) for (let i = 0; i < m.length; i++) forceOne(m[i]!);
    else forceOne(m);
  };
  /** Reflect only with the 3D camera, and not when the plane itself is fixed to the screen. */
  let reflecting = false;
  let wantedFrame = 0;
  let renderedFrame = -1;
  let failure: unknown = null;

  mesh.onBeforeRender = (renderer: WebGLRenderer, scene: Scene, camera: Camera) => {
    // Only a whole-scene render counts (the preview's picking draws single layers), once a frame.
    if (!(scene as { isScene?: boolean }).isScene || renderedFrame === wantedFrame || failure) return;
    renderedFrame = wantedFrame;
    uniforms.uOn.value = 0;
    if (!reflecting || uniforms.uReflectivity.value <= 0) return;
    try {
      renderReflection(renderer, scene, camera);
    } catch (err) {
      failure = err; // reported (and the layer flagged) by the next update()
      uniforms.uOn.value = 0;
    }
  };

  function renderReflection(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    mesh.updateMatrixWorld();
    planePoint.setFromMatrixPosition(mesh.matrixWorld);
    eye.setFromMatrixPosition(camera.matrixWorld);
    rotation.extractRotation(mesh.matrixWorld);
    normal.set(0, 0, 1).applyMatrix4(rotation).normalize();
    // Mirror on whichever side the camera is (the plane is double-sided).
    if (look.subVectors(eye, planePoint).dot(normal) < 0) normal.negate();

    const ortho = (camera as OrthographicCamera).isOrthographicCamera === true;
    const mirror: PerspectiveCamera | OrthographicCamera = ortho ? mirrorOrtho : mirrorPerspective;
    // Mirrored eye.
    const view = look.subVectors(planePoint, eye).reflect(normal).negate().add(planePoint);
    mirror.position.copy(view);
    // Mirrored look-at point.
    rotation.extractRotation(camera.matrixWorld);
    look.set(0, 0, -1).applyMatrix4(rotation).add(eye);
    look.subVectors(planePoint, look).reflect(normal).negate().add(planePoint);
    mirror.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal);
    mirror.lookAt(look);
    mirror.far = (camera as PerspectiveCamera).far;
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(camera.projectionMatrix);

    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(mirror.projectionMatrix);
    textureMatrix.multiply(mirror.matrixWorldInverse);
    textureMatrix.multiply(mesh.matrixWorld);

    // Oblique near plane at the mirror (Lengyel), so nothing behind the mirror is reflected.
    plane.setFromNormalAndCoplanarPoint(normal, planePoint);
    plane.applyMatrix4(mirror.matrixWorldInverse);
    planeUniform.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const p = mirror.projectionMatrix.elements;
    q.x = (Math.sign(clip.x) + p[8]!) / p[0]!;
    q.y = (Math.sign(clip.y) + p[9]!) / p[5]!;
    if (ortho) {
      q.z = -mirror.far;
      q.w = 1;
    } else {
      q.z = -1;
      q.w = (1 + p[10]!) / p[14]!;
    }
    clip.multiplyScalar(2 / clip.dot(q));
    p[2] = clip.x;
    p[6] = clip.y;
    if (ortho) {
      p[10] = clip.z;
      p[14] = clip.w - 1;
    } else {
      p[10] = clip.z + 1;
      p[14] = clip.w;
    }
    inverseProjection.copy(mirror.projectionMatrix).invert();

    // Half the resolution of whatever the scene is being drawn into.
    const current = renderer.getRenderTarget();
    if (current) size.set(current.width, current.height);
    else renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.ceil(size.x / 2));
    const h = Math.max(1, Math.ceil(size.y / 2));
    if (target.width !== w || target.height !== h) target.setSize(w, h);
    texel.set(1 / w, 1 / h);

    // Every layer that is switched on, whatever this pass draws; no reflection planes and
    // no screen-fixed layers.
    const children = scene.children;
    try {
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const intended = child.userData[SHOWN_TAG] as boolean | undefined;
        const want = (intended ?? child.visible) && !child.userData[REFLECTOR_TAG] && !child.userData[SCREEN_FIXED_TAG];
        if (want === child.visible) continue;
        changed.push(child);
        was.push(child.visible);
        child.visible = want;
      }
      for (let i = 0; i < children.length; i++) if (children[i]!.visible) children[i]!.traverseVisible(forceDepth);
      // Cleared to transparent black (alpha = reflected coverage), not the background.
      background = scene.background;
      scene.background = null;
      renderer.getClearColor(clearColour);
      clearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(target);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear();
      renderer.render(scene, mirror);
    } finally {
      renderer.setRenderTarget(current);
      if (background !== undefined) {
        scene.background = background;
        renderer.setClearColor(clearColour, clearAlpha);
        background = undefined;
      }
      for (let i = 0; i < forced.length; i++) forced[i]!.depthWrite = false;
      forced.length = 0;
      for (let i = 0; i < changed.length; i++) changed[i]!.visible = was[i]!;
      changed.length = 0;
      was.length = 0;
    }
    uniforms.uOn.value = 1;
  }

  function apply(next: ReflectorLayer, mode: '2d' | '3d'): void {
    root.name = next.name;
    mesh.scale.set(Math.max(next.size[0], 1e-3), Math.max(next.size[1], 1e-3), 1);
    colour.set(next.colour);
    uniforms.uOpacity.value = next.opacity;
    uniforms.uReflectivity.value = next.reflectivity;
    uniforms.uBlur.value = next.blur;
    uniforms.uFade.value = next.fade;
    reflecting = mode === '3d' && !next.screenFixed;
    if (!reflecting) uniforms.uOn.value = 0;
    const additive = next.blend === 'additive';
    material.transparent = additive || next.opacity < 1;
    material.blending = additive ? AdditiveBlending : NormalBlending;
    material.depthTest = mode === '3d' && !additive;
    material.depthWrite = mode === '3d' && !material.transparent;
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    update(ctx: FrameContext) {
      if (failure) {
        const err = failure;
        failure = null;
        throw err instanceof Error ? new Error(`reflection failed: ${err.message}`) : new Error(`reflection failed: ${String(err)}`);
      }
      wantedFrame = ctx.frame;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      target.depthTexture?.dispose();
      target.dispose();
    },
  };
}
