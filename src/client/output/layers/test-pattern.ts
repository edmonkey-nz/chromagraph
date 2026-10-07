import { Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import type { FrameContext, LayerInstance } from './layer.ts';

/**
 * Projector test pattern, drawn procedurally in the fragment shader at render-target
 * resolution:
 *   - a 120 px grid
 *   - a 4 px border
 *   - a centre cross and a circle (to check the aspect ratio)
 *   - colour-coded corner blocks (TL red, TR green, BR blue, BL yellow) for keystone orientation
 *   - a sweeping bar, so dropped frames are visible
 * All lines are at least 2 px wide.
 */
export function createTestPattern(width: number, height: number): LayerInstance {
  const material = new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: true,
    uniforms: {
      uSize: { value: new Vector2(width, height) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uSize;
      uniform float uTime;
      varying vec2 vUv;

      float band(float d, float halfWidth) { return step(d, halfWidth); }

      void main() {
        vec2 p = vUv * uSize;
        vec2 c = uSize * 0.5;
        float a = 0.0;
        vec3 col = vec3(1.0);

        vec2 g = abs(mod(p - c + 60.0, 120.0) - 60.0);
        a = max(a, 0.45 * band(min(g.x, g.y), 1.0));

        vec2 edge = min(p, uSize - p);
        a = max(a, band(min(edge.x, edge.y), 4.0));

        vec2 d = abs(p - c);
        a = max(a, band(d.x, 1.5) * band(d.y, 60.0));
        a = max(a, band(d.y, 1.5) * band(d.x, 60.0));
        a = max(a, band(abs(length(p - c) - 400.0), 1.5));

        float bx = fract(uTime / 8.0) * uSize.x;
        a = max(a, 0.6 * band(abs(p.x - bx), 3.0) * band(abs(p.y - 60.0), 30.0));

        float s = 90.0;
        if (p.x < s + 8.0 && p.y > uSize.y - s - 8.0 && p.x > 8.0 && p.y < uSize.y - 8.0) { col = vec3(1.0, 0.2, 0.2); a = 1.0; }
        if (p.x > uSize.x - s - 8.0 && p.y > uSize.y - s - 8.0 && p.x < uSize.x - 8.0 && p.y < uSize.y - 8.0) { col = vec3(0.2, 1.0, 0.2); a = 1.0; }
        if (p.x > uSize.x - s - 8.0 && p.y < s + 8.0 && p.x < uSize.x - 8.0 && p.y > 8.0) { col = vec3(0.3, 0.5, 1.0); a = 1.0; }
        if (p.x < s + 8.0 && p.y < s + 8.0 && p.x > 8.0 && p.y > 8.0) { col = vec3(1.0, 0.9, 0.2); a = 1.0; }

        if (a <= 0.0) discard;
        gl_FragColor = vec4(col, a);
      }
    `,
  });
  const geometry = new PlaneGeometry(1, 1);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1_000_000;
  const uTime = material.uniforms.uTime!;

  return {
    object: mesh,
    update(ctx: FrameContext) {
      // Wrap so the uniform stays small and precise however long the output runs.
      uTime.value = ctx.time % 3600;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
