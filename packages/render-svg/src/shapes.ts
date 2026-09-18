import type { Insets, Point, Rect } from '@sgl/core';
import { num, nums } from './num.js';

/**
 * A shape is three pure functions over a frame and a corner radius (DD-07 §4).
 *
 * ⟶ C7: user shapes are parameterised path templates whose `contentInsets` and
 * `anchor` come from a declared `anchor: box | ellipse | polygon`. This interface
 * does not change.
 */
export interface Shape {
  /** SVG path data, absolute coordinates. */
  path(f: Rect, r: number): string;
  /** Extra space the shape needs beyond padding. */
  contentInsets(labelW: number, labelH: number): Insets;
  /** Boundary intersection of the ray centre→`from`. */
  anchor(f: Rect, from: Point): Point;
}

/** Below this, a direction vector is not a direction and every anchor degenerates
 *  to the centre (DD-07 §4: "all three return the centre if `from` equals the
 *  centre"). Not zero, because a `from` a nanometre off the centre is the same
 *  self-loop and must not produce a wild boundary point from catastrophic
 *  cancellation. */
const EPS = 1e-9;

const SQRT2 = Math.SQRT2;
/** Half the width an inscribed rectangle gives back to an ellipse, per side:
 *  the largest axis-aligned rectangle in an ellipse of half-axes `a, b` is
 *  `a√2 × b√2`, so a label of width `L` needs `L√2` and the surplus is
 *  `L(√2 − 1)`, half of it on each side. */
const ELLIPSE_INSET_RATIO = (SQRT2 - 1) / 2;

/** Cylinder lid radius, DD-07 §4: `ry = min(8, h/6)`. */
const CYL_MAX_RY = 8;
/** Package tab, DD-07 §4: `w·0.35 × 14`. */
const PKG_TAB_H = 14;
const PKG_TAB_W_RATIO = 0.35;

const centre = (f: Rect): Point => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });

const insets = (t: number, r: number, b: number, l: number): Insets => [t, r, b, l];
const NO_INSETS: Insets = [0, 0, 0, 0];

// ---------------------------------------------------------------------------
// Anchors (DD-07 §4)
// ---------------------------------------------------------------------------

/**
 * Liang–Barsky clip of the ray centre→`from` against the frame.
 *
 * For a ray that starts at the centre of the rectangle the four Liang–Barsky
 * comparisons collapse to two: the near half-plane of each slab is behind the
 * origin, so only the far parameter of each axis can bound the exit, and the exit
 * is whichever comes first.
 */
export function boxAnchor(f: Rect, from: Point): Point {
  const c = centre(f);
  const dx = from.x - c.x;
  const dy = from.y - c.y;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return c;

  const tx = Math.abs(dx) > EPS ? f.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(dy) > EPS ? f.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty);
  if (!Number.isFinite(t)) return c;
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** DD-07 §4: `t = 1/√((dx/a)² + (dy/b)²)`, with `a = w/2`, `b = h/2`. */
export function ellipseAnchor(f: Rect, from: Point): Point {
  const c = centre(f);
  const a = f.w / 2;
  const b = f.h / 2;
  const dx = from.x - c.x;
  const dy = from.y - c.y;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return c;
  if (a < EPS || b < EPS) return c;

  const k = (dx / a) ** 2 + (dy / b) ** 2;
  if (k < EPS) return c;
  const t = 1 / Math.sqrt(k);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/**
 * Ray centre→`from` against each edge segment of a polygon; nearest hit wins.
 *
 * Solving `C + t·d = P + u·e` for each edge `P→Q` (`e = Q − P`, `w = P − C`):
 * with `D = dx·ey − dy·ex`, `t = (wx·ey − wy·ex)/D` and `u = (wx·dy − wy·dx)/D`.
 * A hit needs `t ≥ 0` and `u ∈ [0, 1]`. For a convex polygon containing the centre
 * there is exactly one, but taking the minimum keeps the function honest for the
 * concave templates C7 will allow.
 */
export function polygonAnchor(vertices: readonly Point[], c: Point, from: Point): Point {
  const dx = from.x - c.x;
  const dy = from.y - c.y;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return c;

  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i] as Point;
    const q = vertices[(i + 1) % vertices.length] as Point;
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const d = dx * ey - dy * ex;
    if (Math.abs(d) < EPS) continue; // parallel to this edge

    const wx = p.x - c.x;
    const wy = p.y - c.y;
    const t = (wx * ey - wy * ex) / d;
    const u = (wx * dy - wy * dx) / d;
    if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
  }

  if (!Number.isFinite(best)) return c;
  return { x: c.x + dx * best, y: c.y + dy * best };
}

// ---------------------------------------------------------------------------
// Vertex helpers, shared by the path and the polygon anchor so the two can never
// describe different shapes.
// ---------------------------------------------------------------------------

function diamondVertices(f: Rect): readonly Point[] {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  return [
    { x: cx, y: f.y },
    { x: f.x + f.w, y: cy },
    { x: cx, y: f.y + f.h },
    { x: f.x, y: cy },
  ];
}

/** DD-07 §4: `i = min(h/2, 0.25w)`. */
export function hexagonInset(f: Rect): number {
  return Math.min(f.h / 2, 0.25 * f.w);
}

function hexagonVertices(f: Rect): readonly Point[] {
  const i = hexagonInset(f);
  const cy = f.y + f.h / 2;
  return [
    { x: f.x + i, y: f.y },
    { x: f.x + f.w - i, y: f.y },
    { x: f.x + f.w, y: cy },
    { x: f.x + f.w - i, y: f.y + f.h },
    { x: f.x + i, y: f.y + f.h },
    { x: f.x, y: cy },
  ];
}

/** DD-07 §4: `ry = min(8, h/6)`. */
export function cylinderRy(f: Rect): number {
  return Math.min(CYL_MAX_RY, f.h / 6);
}

// ---------------------------------------------------------------------------
// The seven built-in shapes (DD-07 §4)
// ---------------------------------------------------------------------------

const rect: Shape = {
  // DD-07 §4 gives this one in relative form; kept verbatim.
  path: (f) => `M ${nums(f.x, f.y)} h ${num(f.w)} v ${num(f.h)} h ${num(-f.w)} Z`,
  contentInsets: () => NO_INSETS,
  anchor: boxAnchor,
};

const round: Shape = {
  path: (f, r) => {
    const k = Math.max(0, Math.min(r, f.w / 2, f.h / 2));
    if (k < EPS) return rect.path(f, 0);
    const { x, y, w, h } = f;
    const arc = `a ${nums(k, k)} 0 0 1`;
    return [
      `M ${nums(x + k, y)}`,
      `H ${num(x + w - k)}`,
      `${arc} ${nums(k, k)}`,
      `V ${num(y + h - k)}`,
      `${arc} ${nums(-k, k)}`,
      `H ${num(x + k)}`,
      `${arc} ${nums(-k, -k)}`,
      `V ${num(y + k)}`,
      `${arc} ${nums(k, -k)}`,
      'Z',
    ].join(' ');
  },
  // DD-07 §4: 0. The corner cuts into the content box by at most r(1 − 1/√2),
  // which the table accepts rather than pays for.
  contentInsets: () => NO_INSETS,
  anchor: boxAnchor,
};

const ellipse: Shape = {
  path: (f) => {
    const rx = f.w / 2;
    const ry = f.h / 2;
    const cy = f.y + ry;
    const arc = `A ${nums(rx, ry)} 0 0 1`;
    return `M ${nums(f.x, cy)} ${arc} ${nums(f.x + f.w, cy)} ${arc} ${nums(f.x, cy)} Z`;
  },
  contentInsets: (labelW, labelH) =>
    insets(
      labelH * ELLIPSE_INSET_RATIO,
      labelW * ELLIPSE_INSET_RATIO,
      labelH * ELLIPSE_INSET_RATIO,
      labelW * ELLIPSE_INSET_RATIO,
    ),
  anchor: ellipseAnchor,
};

const diamond: Shape = {
  path: (f) => {
    const [top, right, bottom, left] = diamondVertices(f) as [Point, Point, Point, Point];
    return `M ${nums(top.x, top.y)} L ${nums(right.x, right.y)} L ${nums(bottom.x, bottom.y)} L ${nums(left.x, left.y)} Z`;
  },
  // The largest centred rectangle in a diamond is half its width by half its
  // height, so a label of `L × H` needs a `2L × 2H` diamond: `L/2` per side.
  contentInsets: (labelW, labelH) => insets(labelH / 2, labelW / 2, labelH / 2, labelW / 2),
  anchor: (f, from) => polygonAnchor(diamondVertices(f), centre(f), from),
};

const hexagon: Shape = {
  path: (f) => {
    const v = hexagonVertices(f);
    const head = v[0] as Point;
    const tail = v.slice(1).map((p) => `L ${nums(p.x, p.y)}`);
    return `M ${nums(head.x, head.y)} ${tail.join(' ')} Z`;
  },
  // `i = min(h/2, 0.25w)` is stated in terms of the *shape's* w and h; solving it
  // for the label the shape has to hold (`h = H`, `w = L + 2i`) gives
  // `i = min(L, H)/2` in both branches.
  contentInsets: (labelW, labelH) => {
    const i = Math.min(labelW, labelH) / 2;
    return insets(0, i, 0, i);
  },
  anchor: (f, from) => polygonAnchor(hexagonVertices(f), centre(f), from),
};

const cylinder: Shape = {
  path: (f) => {
    const ry = cylinderRy(f);
    const rx = f.w / 2;
    const { x, y, w, h } = f;
    const top = y + ry;
    const bottom = y + h - ry;
    // One silhouette subpath and one lid seam, both traced clockwise so the
    // nonzero fill rule adds them instead of punching the lid out of the body.
    const body = [
      `M ${nums(x, top)}`,
      `A ${nums(rx, ry)} 0 0 1 ${nums(x + w, top)}`,
      `L ${nums(x + w, bottom)}`,
      `A ${nums(rx, ry)} 0 0 1 ${nums(x, bottom)}`,
      'Z',
    ].join(' ');
    const lid = `M ${nums(x + w, top)} A ${nums(rx, ry)} 0 0 1 ${nums(x, top)}`;
    return `${body} ${lid}`;
  },
  // Top `2·ry`, bottom `ry`, with `ry` solved for the label: `h = H + 3ry` and
  // `ry = min(8, h/6)` give `ry = min(8, H/3)`.
  contentInsets: (_labelW, labelH) => {
    const ry = Math.min(CYL_MAX_RY, labelH / 3);
    return insets(2 * ry, 0, ry, 0);
  },
  anchor: boxAnchor,
};

const packageShape: Shape = {
  path: (f) => {
    const { x, y, w, h } = f;
    // Clamped so a frame shorter or narrower than the tab folds flat instead of
    // self-intersecting. DD-07 §4 states the tab as a flat `w·0.35 × 14`.
    const tabH = Math.min(PKG_TAB_H, h);
    const tabW = Math.min(w * PKG_TAB_W_RATIO, w);
    return [
      `M ${nums(x, y)}`,
      `L ${nums(x + tabW, y)}`,
      `L ${nums(x + tabW, y + tabH)}`,
      `L ${nums(x + w, y + tabH)}`,
      `L ${nums(x + w, y + h)}`,
      `L ${nums(x, y + h)}`,
      'Z',
    ].join(' ');
  },
  contentInsets: () => insets(PKG_TAB_H, 0, 0, 0),
  anchor: boxAnchor,
};

/**
 * The built-in shapes.
 *
 * | id | content insets | anchor |
 * |---|---|---|
 * | `rect`     | 0                                   | box     |
 * | `round`    | 0                                   | box     |
 * | `ellipse`  | `w·(1−1/√2)/2` each side            | ellipse |
 * | `diamond`  | `w/4`, `h/4` each side              | polygon |
 * | `hexagon`  | `i = min(h/2, 0.25w)` left/right    | polygon |
 * | `cylinder` | top `2·ry`, bottom `ry`             | box     |
 * | `package`  | top 14                              | box     |
 *
 * The inset column of DD-07 §4 is written in terms of the *shape's* own width and
 * height; `contentInsets` is handed the *label's*, so each entry above is the
 * solution of the table's equation for the shape that has to hold that label. The
 * two agree at the fixed point, which the shape tests assert.
 */
export const SHAPES: Readonly<Record<string, Shape>> = Object.freeze({
  rect,
  round,
  ellipse,
  diamond,
  hexagon,
  cylinder,
  package: packageShape,
});

export const DEFAULT_SHAPE = 'rect';

/** Declaration order of `SHAPES`, for tests and for anything that needs to walk
 *  the built-ins without iterating object keys (DD-00 §3). */
export const SHAPE_IDS: readonly string[] = Object.freeze([
  'rect',
  'round',
  'ellipse',
  'diamond',
  'hexagon',
  'cylinder',
  'package',
]);

/** Look a shape up by id. An unknown shape falls back to `rect`; the caller emits
 *  `SGL3001` when `known` is false (DD-07 §4, `ShapeId` in `@sgl/core`). */
export function resolveShape(id: string): { readonly shape: Shape; readonly known: boolean } {
  const shape = Object.prototype.hasOwnProperty.call(SHAPES, id) ? SHAPES[id] : undefined;
  return shape === undefined
    ? { shape: SHAPES[DEFAULT_SHAPE] as Shape, known: false }
    : { shape, known: true };
}
