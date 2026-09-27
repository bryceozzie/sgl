import type { Insets } from './geometry.js';
import type { ShapeId } from './ids.js';

/**
 * Per-shape content insets (DD-07 §4's table) and their inverse, `labelMaxWidth`
 * (DD-11 T4, T35). One copy, here, where `@sgl/layout-api` (node sizing), `@sgl/text`
 * (the wrap width) and `@sgl/render-svg` can all import it: before A18 layout-api
 * and render-svg each kept their own, and DD-07 §4 warns the two drifted once.
 *
 * DD-07 §4 writes each inset in terms of the *shape's own* `w`/`h`. This function
 * is handed the *label's* width and height and returns the inset for the shape that
 * has to hold that label, so each branch is DD-07 §4's formula solved for that:
 * diamond's `w/4` for a diamond of width `w` holding a label of width `L`
 * (`w = L + 2·inset`) gives `inset = L/2`. `shape-insets.test.ts` pins the closed
 * forms and the containment property.
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
    // rect, round and every unrecognised shape get no extra inset: `compile()`
    // resolves an unknown or undrawable `@shape` to `rect` (SGL3001/SGL3006).
    default:
      return [0, 0, 0, 0];
  }
}

/**
 * The wrap width (DD-11 T35): the widest label a node `width` wide can hold, given
 * its padding (`[top, right, bottom, left]`; anything else counts as none).
 *
 * - `rect`, `round`, `cylinder`, `package` and any other shape: the width inside
 *   the padding, since they add no horizontal inset.
 * - `ellipse`: that width over √2.
 * - `diamond`: half of it, exactly.
 * - `hexagon`: the whole of it, `A`, because a hexagon's side insets are
 *   `min(L, H)/2`, so how wide a label may be depends on how tall it is: it fits
 *   when `L + min(L, H) ≤ A`. The breaker settles that (`BoxConstraints.hexagon`,
 *   fix round 1, item 3); `A/2` was the conservative bound, and wrapped a
 *   one-line title that fits.
 *
 * With it, `label.w + contentInsets(...)` horizontally never exceeds `width` for a
 * label no wider than this (for a hexagon, one that keeps the rule above, T39),
 * which `label-max-width.test.ts` checks per shape.
 */
export function labelMaxWidth(shape: ShapeId, width: number, padding?: unknown): number {
  const p = Array.isArray(padding) ? (padding as unknown[]) : [];
  const avail = Math.max(0, width - num(p[1]) - num(p[3]));
  return shape === 'ellipse' ? avail / Math.SQRT2 : shape === 'diamond' ? avail / 2 : avail;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
