import type { Insets, ShapeId } from '@sgl/core';

/**
 * Per-shape content insets (DD-07 §4's table), duplicated here for the same reason
 * `anchor.ts` duplicates the anchor functions: `layout-api` may not import
 * `@sgl/render-svg` (DD-00 §2 rule 2), and `buildLayoutInput` (DD-06 §2) needs
 * `shape.contentInsets(label.width, label.height)` to size a node before any shape
 * has been drawn.
 *
 * `[top, right, bottom, left]`, matching `Insets` (DD-04 §3).
 */
export function contentInsets(shape: ShapeId, labelW: number, labelH: number): Insets {
  switch (shape) {
    case 'ellipse': {
      const x = labelW * (1 - 1 / Math.SQRT2) * 0.5;
      const y = labelH * (1 - 1 / Math.SQRT2) * 0.5;
      return [y, x, y, x];
    }
    case 'diamond': {
      const x = labelW / 4;
      const y = labelH / 4;
      return [y, x, y, x];
    }
    case 'hexagon': {
      const i = Math.min(labelH / 2, labelW * 0.25);
      return [0, i, 0, i];
    }
    case 'cylinder': {
      const ry = Math.min(8, labelH / 6);
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
