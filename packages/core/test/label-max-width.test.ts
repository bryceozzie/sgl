import { describe, expect, it } from 'vitest';
import { contentInsets, labelMaxWidth } from '../src/shape-insets.js';

describe('labelMaxWidth, the inverse of contentInsets (DD-11 T4, T35, T39)', () => {
  const SHAPES = ['rect', 'round', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'package', 'made-up-shape'];
  const PADDINGS: readonly (readonly number[] | undefined)[] = [[8, 12, 8, 12], [0, 0, 0, 0], [4, 30, 4, 2], undefined];

  it('the closed forms: padding off, then ellipse /√2, diamond and hexagon /2', () => {
    const p = [8, 12, 8, 12];
    expect(labelMaxWidth('rect', 124, p)).toBe(100);
    expect(labelMaxWidth('round', 124, p)).toBe(100);
    expect(labelMaxWidth('cylinder', 124, p)).toBe(100);
    expect(labelMaxWidth('package', 124, p)).toBe(100);
    expect(labelMaxWidth('ellipse', 124, p)).toBeCloseTo(100 / Math.SQRT2, 12);
    expect(labelMaxWidth('diamond', 124, p)).toBe(50);
    expect(labelMaxWidth('hexagon', 124, p)).toBe(50);
    expect(labelMaxWidth('rect', 20, p)).toBe(0);
    expect(labelMaxWidth('rect', 50)).toBe(50);
    expect(labelMaxWidth('rect', 50, 'not insets')).toBe(50);
  });

  // The containment property: a label no wider than the wrap width, at any height,
  // gives a node whose intrinsic width (label + padding + shape insets, DD-06 §2)
  // stays within the width the author set.
  for (const shape of SHAPES) {
    it(`${shape}: label + padding + contentInsets stays within the width, for every label up to labelMaxWidth`, () => {
      let checked = 0;
      for (const padding of PADDINGS) {
        for (const width of [40, 90, 124, 333.3]) {
          const wrap = labelMaxWidth(shape, width, padding);
          for (const f of [0, 0.25, 0.5, 0.999, 1]) {
            for (const labelH of [1, 16.9, 60, 400]) {
              const labelW = wrap * f;
              const inset = contentInsets(shape, labelW, labelH);
              const intrinsic = labelW + inset[1] + inset[3] + (padding?.[1] ?? 0) + (padding?.[3] ?? 0);
              expect(intrinsic, `${shape} ${width} ${labelW}x${labelH}`).toBeLessThanOrEqual(width + 1e-9);
              checked += 1;
            }
          }
        }
      }
      expect(checked).toBe(320);
    });
  }

  it('is exact where the shape allows it: the widest label fills the width (rect, ellipse, diamond)', () => {
    for (const shape of ['rect', 'ellipse', 'diamond']) {
      const wrap = labelMaxWidth(shape, 124, [0, 0, 0, 0]);
      const inset = contentInsets(shape, wrap, 10);
      expect(wrap + inset[1] + inset[3]).toBeCloseTo(124, 9);
    }
  });
});
