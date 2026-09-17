import { describe, expect, it } from 'vitest';
import { contentInsets } from '../src/content-insets.js';

/**
 * DD-07 §4's inset column is stated in terms of the *shape's own* w/h, not the
 * label's — `contentInsets(labelW, labelH)` has to return the solved form for the
 * shape sized to hold that label. These tests pin the closed forms independently
 * (not by re-deriving them from `content-insets.ts` itself) and, more importantly,
 * assert the geometric property the formulas exist to satisfy: the label's
 * bounding box, centred in the resulting frame, must fit inside that shape.
 *
 * `feat/renderer`'s `packages/render-svg/src/shapes.ts` (verified against commit
 * f1c476c5, 2026-09-15) is the other copy of this table; until Stage F merges and
 * the two become one implementation, this file is the drift guard.
 */

/** Frame that exactly wraps a label under a shape's own content insets. */
function frameFor(shape: string, labelW: number, labelH: number): { w: number; h: number; inset: readonly [number, number, number, number] } {
  const inset = contentInsets(shape, labelW, labelH);
  return { w: labelW + inset[1] + inset[3], h: labelH + inset[0] + inset[2], inset };
}

const EPS = 1e-9;

describe('contentInsets (DD-07 §4)', () => {
  it('rect and round get no extra inset', () => {
    expect(contentInsets('rect', 40, 20)).toEqual([0, 0, 0, 0]);
    expect(contentInsets('round', 40, 20)).toEqual([0, 0, 0, 0]);
  });

  it('an unrecognised shape falls back to no inset, same as rect', () => {
    expect(contentInsets('made-up-shape', 40, 20)).toEqual([0, 0, 0, 0]);
  });

  const SIZES: readonly (readonly [number, number])[] = [
    [100, 50],
    [50, 100],
    [20.95, 16.91], // non-round numbers, closer to a real measured label
    [1, 1],
    [200, 5],
    [5, 200],
  ];

  describe('ellipse', () => {
    it.each(SIZES)('label %s×%s: insets each side by (√2−1)/2 of the label, independently computed', (labelW, labelH) => {
      const ratio = (Math.SQRT2 - 1) / 2;
      const [t, r, b, l] = contentInsets('ellipse', labelW, labelH);
      expect(r).toBeCloseTo(labelW * ratio, 10);
      expect(l).toBeCloseTo(labelW * ratio, 10);
      expect(t).toBeCloseTo(labelH * ratio, 10);
      expect(b).toBeCloseTo(labelH * ratio, 10);
    });

    it.each(SIZES)('label %s×%s: the label rectangle is inscribed in the ellipse', (labelW, labelH) => {
      const { w, h } = frameFor('ellipse', labelW, labelH);
      const a = w / 2;
      const b = h / 2;
      // The label's own corner is the point of an axis-aligned rectangle farthest
      // from the centre relative to the ellipse's axes; if it satisfies the
      // ellipse equation with <= 1, the whole rectangle is inside.
      const eq = (labelW / 2 / a) ** 2 + (labelH / 2 / b) ** 2;
      expect(eq).toBeLessThanOrEqual(1 + EPS);
    });
  });

  describe('diamond', () => {
    it.each(SIZES)('label %s×%s: insets each side by half the label (not a quarter)', (labelW, labelH) => {
      expect(contentInsets('diamond', labelW, labelH)).toEqual([labelH / 2, labelW / 2, labelH / 2, labelW / 2]);
    });

    it.each(SIZES)('label %s×%s: the label rectangle is inscribed in the diamond', (labelW, labelH) => {
      const { w, h } = frameFor('diamond', labelW, labelH);
      const a = w / 2;
      const b = h / 2;
      // A diamond |x/a| + |y/b| <= 1 contains an axis-aligned rectangle of
      // half-width u, half-height v iff u/a + v/b <= 1 (the corner is the binding
      // point, same argument as the ellipse).
      const eq = labelW / 2 / a + labelH / 2 / b;
      expect(eq).toBeLessThanOrEqual(1 + EPS);
    });
  });

  describe('hexagon', () => {
    it.each(SIZES)('label %s×%s: insets left/right only, by half the shorter of label w/h', (labelW, labelH) => {
      const i = Math.min(labelW, labelH) / 2;
      expect(contentInsets('hexagon', labelW, labelH)).toEqual([0, i, 0, i]);
    });

    it.each(SIZES)('label %s×%s: the label rectangle is inscribed in the hexagon', (labelW, labelH) => {
      const { w, h, inset } = frameFor('hexagon', labelW, labelH);
      // The hexagon's narrowest horizontal extent is at its top and bottom edges
      // (width w − 2·inset there; it is only ever wider moving toward the
      // vertical centre), so a full-height, (w − 2·inset)-wide rectangle is the
      // containment condition — no separate vertical inset is needed.
      const contentW = w - inset[1] - inset[3];
      expect(labelW).toBeLessThanOrEqual(contentW + EPS);
      expect(labelH).toBeLessThanOrEqual(h + EPS);
    });
  });

  describe('cylinder', () => {
    it.each(SIZES)('label %s×%s: ry = min(8, labelH/3), top 2·ry, bottom ry', (labelW, labelH) => {
      const ry = Math.min(8, labelH / 3);
      expect(contentInsets('cylinder', labelW, labelH)).toEqual([2 * ry, 0, ry, 0]);
    });

    it.each(SIZES)('label %s×%s: the label rectangle fits between the lid and the base', (labelW, labelH) => {
      const { h, inset } = frameFor('cylinder', labelW, labelH);
      const contentH = h - inset[0] - inset[2];
      expect(labelH).toBeLessThanOrEqual(contentH + EPS);
    });
  });

  it('package insets the top by 14, nothing else', () => {
    expect(contentInsets('package', 100, 40)).toEqual([14, 0, 0, 0]);
  });

  it('every shape returns finite insets for a zero-sized label', () => {
    for (const shape of ['rect', 'round', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'package']) {
      for (const v of contentInsets(shape, 0, 0)) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
