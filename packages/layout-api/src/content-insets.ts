import type { Insets, ShapeId } from '@sgl/core';

/**
 * Per-shape content insets (DD-07 §4's table), duplicated here for the same reason
 * `anchor.ts` duplicates the anchor functions: `layout-api` may not import
 * `@sgl/render-svg` (DD-00 §2 rule 2), and `buildLayoutInput` (DD-06 §2) needs
 * `shape.contentInsets(label.width, label.height)` to size a node before any shape
 * has been drawn.
 *
 * DD-07 §4's table writes each inset in terms of the *shape's own* `w`/`h` — the
 * same `w`/`h` its `path` column draws with — but this function is handed the
 * *label's* width and height and must return the inset for the shape that has to
 * hold that label. Each branch below is DD-07 §4's formula solved for that: e.g.
 * diamond's `w/4` inset is stated for a diamond of width `w`, so for a diamond
 * sized to exactly fit a label of width `L` (`w = L + 2·inset`), solving
 * `inset = w/4 = (L + 2·inset)/4` gives `inset = L/2`, not `L/4`. This mirrors
 * `feat/renderer`'s `packages/render-svg/src/shapes.ts` (verified against commit
 * f1c476c5, 2026-09-15) derivation-for-derivation; `content-insets.test.ts` pins
 * both the closed forms and the underlying containment property so the two copies
 * cannot drift apart unnoticed before Stage F merges and this becomes a single
 * shared implementation.
 *
 * `[top, right, bottom, left]`, matching `Insets` (DD-04 §3).
 */
export function contentInsets(shape: ShapeId, labelW: number, labelH: number): Insets {
  switch (shape) {
    case 'ellipse': {
      // The largest axis-aligned rectangle inscribed in an ellipse of half-axes
      // a, b is a√2 × b√2, so a label of width L needs an ellipse of width L√2;
      // the surplus L(√2−1) splits evenly between the two sides.
      const ratio = (Math.SQRT2 - 1) / 2;
      const x = labelW * ratio;
      const y = labelH * ratio;
      return [y, x, y, x];
    }
    case 'diamond': {
      // The largest centred rectangle inscribed in a diamond is half its width by
      // half its height, so a label of L × H needs a 2L × 2H diamond: L/2 per side.
      const x = labelW / 2;
      const y = labelH / 2;
      return [y, x, y, x];
    }
    case 'hexagon': {
      // `i = min(h/2, 0.25w)` stated in terms of the shape's own w/h; solving for
      // the label it holds (h = H, w = L + 2i) gives `i = min(L, H)/2` either way.
      const i = Math.min(labelW, labelH) / 2;
      return [0, i, 0, i];
    }
    case 'cylinder': {
      // Top 2·ry, bottom ry, with ry = min(8, h/6) stated in shape terms; solving
      // for the label (h = H + 3ry) gives ry = min(8, H/3).
      const ry = Math.min(8, labelH / 3);
      return [2 * ry, 0, ry, 0];
    }
    case 'package':
      return [14, 0, 0, 0];
    // rect, round and every unrecognised shape get no extra inset — Stage C already
    // resolves an unknown/undrawable `@shape` to `rect` (SGL3001/SGL3006) before this
    // is ever reached, so the fallback here is only ever exercised for rect/round.
    default:
      return [0, 0, 0, 0];
  }
}
