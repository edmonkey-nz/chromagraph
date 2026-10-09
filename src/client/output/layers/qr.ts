import {
  AdditiveBlending,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  NearestFilter,
  NormalBlending,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
} from 'three';
import { encodeQr, qrSide, qrTexels, type QrMatrix } from '../../../data/qr-data.ts';
import type { QrLayer } from '../../../shared/layer-schema.ts';
import type { FrameContext, LayerInstance } from './layer.ts';

/**
 * QR code: one quad `size` px wide centred on `position`, sampling a single-channel texture
 * of one texel per module (quiet-zone margin included) with nearest filtering, so module
 * edges stay hard at any size. Dark and light colours and opacity are uniforms.
 *
 * The text is fixed for the life of the instance: the manager resolves it (the layer's text,
 * or its dataset's url) and rebuilds the layer when it or the level changes (see
 * KINDS.qr in layer-manager.ts), so a code that was too long recovers on the next edit. A
 * margin change only re-lays the texture; everything else is a uniform or the transform.
 * With nothing to encode (`text` null) the quad is hidden.
 */

export interface QrInstance extends LayerInstance {
  apply(layer: QrLayer, cameraMode: '2d' | '3d'): void;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uModules;
  uniform vec3 uDark;
  uniform vec3 uLight;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(mix(uLight, uDark, texture2D(uModules, vUv).r), uOpacity);
  }
`;

function moduleTexture(data: Uint8Array, side: number): DataTexture {
  const texture = new DataTexture(data, side, side, RedFormat, UnsignedByteType);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  // Rows of `side` bytes: not a multiple of 4.
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** A scene morph interpolates the margin through fractions: texels need a whole number. */
function wholeMargin(margin: number): number {
  return Math.min(10, Math.max(0, Math.round(margin)));
}

/** `text`: what to encode (already resolved by the manager), or null for nothing. */
export function createQr(layer: QrLayer, text: string | null, cameraMode: '2d' | '3d'): QrInstance {
  const root = new Group();
  root.name = layer.name;
  // Throws (failing the build, so the layer is flagged) when the text is too long.
  const matrix: QrMatrix | null = text === null ? null : encodeQr(text, layer.level);

  let margin = wholeMargin(layer.margin);
  let texture = matrix ? moduleTexture(qrTexels(matrix, margin), qrSide(matrix, margin)) : moduleTexture(new Uint8Array(1), 1);
  const uniforms = {
    uModules: { value: texture },
    uDark: { value: new Color() },
    uLight: { value: new Color() },
    uOpacity: { value: 1 },
  };
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: DoubleSide });
  const geometry = new PlaneGeometry(1, 1);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = matrix !== null;
  root.add(mesh);

  function relay(next: number): void {
    if (!matrix || next === margin) return;
    margin = next;
    const side = qrSide(matrix, margin);
    // A new size needs a new texture (WebGL storage is sized once).
    texture.dispose();
    texture = moduleTexture(qrTexels(matrix, margin), side);
    uniforms.uModules.value = texture;
  }

  function apply(next: QrLayer, mode: '2d' | '3d'): void {
    root.name = next.name;
    relay(wholeMargin(next.margin));
    const size = Math.max(next.size, 1e-3);
    mesh.scale.set(size, size, 1);
    mesh.position.set(next.position[0], next.position[1], next.position[2]);
    uniforms.uDark.value.set(next.dark);
    uniforms.uLight.value.set(next.light);
    uniforms.uOpacity.value = next.opacity;
    const additive = next.blend === 'additive';
    const translucent = additive || next.opacity < 1;
    material.transparent = translucent;
    material.blending = additive ? AdditiveBlending : NormalBlending;
    material.depthTest = mode === '3d' && !additive;
    material.depthWrite = mode === '3d' && !translucent;
  }

  apply(layer, cameraMode);

  return {
    object: root,
    apply,
    update(_ctx: FrameContext) {},
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
