import { describe, expect, it } from 'vitest';
import { apply, IDENTITY_QUAD, invert, isConvexQuad, squareToQuad, type Quad } from '../../src/shared/homography.ts';

const keystone: Quad = [
  [0.08, 0.02],
  [0.95, 0.07],
  [0.9, 0.97],
  [0.03, 0.9],
];

describe('homography', () => {
  it('maps the unit square corners onto the quad', () => {
    const h = squareToQuad(keystone);
    const unit: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    unit.forEach(([x, y], i) => {
      const [px, py] = apply(h, x, y);
      expect(px).toBeCloseTo(keystone[i]![0], 12);
      expect(py).toBeCloseTo(keystone[i]![1], 12);
    });
  });

  it('is the identity for the identity quad, and handles the affine case', () => {
    const h = squareToQuad(IDENTITY_QUAD);
    expect(apply(h, 0.3, 0.7)).toEqual([0.3, 0.7]);
    const para: Quad = [
      [0.1, 0.1],
      [0.9, 0.2],
      [0.9, 0.9],
      [0.1, 0.8],
    ];
    expect(apply(squareToQuad(para), 1, 1)[0]).toBeCloseTo(0.9);
  });

  it('inverts exactly (screen point back to image uv)', () => {
    const h = squareToQuad(keystone);
    const inv = invert(h)!;
    for (const [x, y] of [
      [0.5, 0.5],
      [0.1, 0.9],
      [0.77, 0.03],
    ] as const) {
      const [sx, sy] = apply(h, x, y);
      const [u, v] = apply(inv, sx, sy);
      expect(u).toBeCloseTo(x, 10);
      expect(v).toBeCloseTo(y, 10);
    }
  });

  it('detects folded or degenerate quads', () => {
    expect(isConvexQuad(keystone)).toBe(true);
    expect(isConvexQuad([[0, 0], [1, 1], [1, 0], [0, 1]])).toBe(false);
    expect(isConvexQuad([[0, 0], [0, 0], [1, 1], [0, 1]])).toBe(false);
    expect(invert([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });
});
