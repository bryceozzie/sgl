import type { Point, Rect, ShapeId } from '@sgl/core';

/**
 * Boundary anchors for the host's straight-routing fallback (DD-06 §4.3).
 *
 * DD-07 §4 makes the renderer the owner of `Shape.anchor`, but `layout-api` may not
 * import `@sgl/render-svg` (DD-00 §2 rule 2), so the three anchor families — box,
 * ellipse and polygon — are implemented here over the same shape table. They agree
 * with DD-07 §4 by construction: same vertex sets, same parametric solve.
 *
 * Arithmetic is `+ - * /` and `sqrt` only, all of which ECMAScript specifies exactly
 * (ADR-0004), so a clipped route is reproducible bit for bit.
 */

export interface Ray {
  /** Where the ray starts — the shape's centre. */
  readonly from: Point;
  /** A point the ray passes through. */
  readonly toward: Point;
}

export function centreOf(frame: Rect): Point {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

/**
 * The point where the ray from the frame's centre towards `toward` leaves the shape.
 * Returns the centre for a degenerate ray or a zero-sized frame, which is what
 * DD-07 §4 specifies; self-loops are handled before this is reached (DD-06 §4.5).
 */
export function anchorPoint(shape: ShapeId, frame: Rect, toward: Point): Point {
  const c = centreOf(frame);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!isFiniteNumber(dx) || !isFiniteNumber(dy)) return c;
  if (dx === 0 && dy === 0) return c;
  if (frame.w <= 0 || frame.h <= 0) return c;

  switch (shape) {
    case 'ellipse':
      return ellipseAnchor(frame, c, dx, dy);
    case 'diamond':
    case 'hexagon':
      return polygonAnchor(vertices(shape, frame), c, dx, dy);
    // rect, round, cylinder, package and every unknown shape use the box anchor,
    // exactly as DD-07 §4's table says.
    default:
      return boxAnchor(frame, c, dx, dy);
  }
}

function boxAnchor(frame: Rect, c: Point, dx: number, dy: number): Point {
  const hw = frame.w / 2;
  const hh = frame.h / 2;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : hw / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  if (!isFiniteNumber(t)) return c;
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function ellipseAnchor(frame: Rect, c: Point, dx: number, dy: number): Point {
  const a = frame.w / 2;
  const b = frame.h / 2;
  const u = dx / a;
  const v = dy / b;
  const d = Math.sqrt(u * u + v * v);
  if (d === 0 || !isFiniteNumber(d)) return c;
  const t = 1 / d;
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Vertices in a fixed order, so the nearest-hit scan is order-stable. */
function vertices(shape: 'diamond' | 'hexagon', f: Rect): readonly Point[] {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  if (shape === 'diamond') {
    return [
      { x: cx, y: f.y },
      { x: f.x + f.w, y: cy },
      { x: cx, y: f.y + f.h },
      { x: f.x, y: cy },
    ];
  }
  const i = Math.min(f.h / 2, f.w / 4);
  return [
    { x: f.x + i, y: f.y },
    { x: f.x + f.w - i, y: f.y },
    { x: f.x + f.w, y: cy },
    { x: f.x + f.w - i, y: f.y + f.h },
    { x: f.x + i, y: f.y + f.h },
    { x: f.x, y: cy },
  ];
}

function polygonAnchor(poly: readonly Point[], c: Point, dx: number, dy: number): Point {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < poly.length; k += 1) {
    const p = poly[k];
    const q = poly[(k + 1) % poly.length];
    if (p === undefined || q === undefined) continue;
    const t = rayHit(c, dx, dy, p, q);
    if (t !== null && t >= 0 && t < best) best = t;
  }
  if (!isFiniteNumber(best)) return c;
  return { x: c.x + dx * best, y: c.y + dy * best };
}

/** Ray `c + t·d` against segment `p→q`; `t` at the hit, or null when parallel or
 *  the hit lies off the segment. */
function rayHit(c: Point, dx: number, dy: number, p: Point, q: Point): number | null {
  const ex = q.x - p.x;
  const ey = q.y - p.y;
  const denom = dx * ey - dy * ex;
  if (denom === 0) return null;
  const px = p.x - c.x;
  const py = p.y - c.y;
  const t = (px * ey - py * ex) / denom;
  const s = (px * dy - py * dx) / denom;
  if (!isFiniteNumber(t) || !isFiniteNumber(s)) return null;
  if (s < 0 || s > 1) return null;
  return t;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Unit vector, or `null` when the input is degenerate. */
export function unit(dx: number, dy: number): { x: number; y: number } | null {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!isFiniteNumber(len) || len === 0) return null;
  return { x: dx / len, y: dy / len };
}
