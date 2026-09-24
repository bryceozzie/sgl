/**
 * Host-computed `bounds` (DD-06 §5, F14).
 *
 * An engine's own `bounds` is advisory: `quantize` (the host's last step on
 * every result, `validate.ts`) replaces it with the extent of what will
 * actually be drawn — every node frame (and content frame and port), every
 * label frame (rotated about its centre when it has a `rotation`, as the
 * renderer draws it), and every edge route's own curve — grown by
 * `CANVAS_MARGIN` on every side. The geometry is then translated so the
 * margin-grown box starts at the origin: `bounds` is always `{ x: 0, y: 0 }`,
 * which is what `apps/web`'s overlay and hit-testing assume (they place
 * `NodeLayout.frame` in the nested `<svg>`'s own coordinates, where
 * `viewBox="x y …"` maps `(x, y)` to its origin).
 *
 * So an engine may leave `bounds` approximate, a margin is the same 16 px under
 * every engine (before F14 it was ELK's 12 px root padding under `elk` and 0
 * under `grid`), and the host's self-loop teardrops (DD-06 §4.5), which reach
 * past the node an engine sized the canvas for, are never clipped.
 *
 * Curves are bounded by their own extrema, not their control polygon, so the
 * margin is the same 16 px round a teardrop as round a frame. The marker at a
 * directed end needs no extent of its own: DD-06 §4.4's reserve puts its tip on
 * the node boundary (inside a frame), and its half-width (`0.375 · arrowSize`)
 * is well inside the margin.
 */

import type { PathSeg, Point, Rect } from '@sgl/core';
import type { LayoutResult } from './contract.js';

/** DD-06 §5's `canvas.margin`, in diagram units, on every side. */
export const CANVAS_MARGIN = 16;

/** A running extent. `Infinity`/`-Infinity` until the first point. */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function addPoint(box: Box, x: number, y: number): void {
  if (x < box.x0) box.x0 = x;
  if (y < box.y0) box.y0 = y;
  if (x > box.x1) box.x1 = x;
  if (y > box.y1) box.y1 = y;
}

function addRect(box: Box, r: Rect): void {
  addPoint(box, r.x, r.y);
  addPoint(box, r.x + r.w, r.y + r.h);
}

/** A label frame as drawn: rotated about its own centre (DD-07 §5). */
function addLabelFrame(box: Box, r: Rect, rotation: number | undefined): void {
  if (rotation === undefined || rotation === 0 || !Number.isFinite(rotation)) {
    addRect(box, r);
    return;
  }
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const hw = (r.w * cos + r.h * sin) / 2;
  const hh = (r.w * sin + r.h * cos) / 2;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  addPoint(box, cx - hw, cy - hh);
  addPoint(box, cx + hw, cy + hh);
}

/** The roots in (0, 1) of `a t² + b t + c = 0`. */
function unitRoots(a: number, b: number, c: number): number[] {
  const eps = 1e-12;
  const out: number[] = [];
  if (Math.abs(a) < eps) {
    if (Math.abs(b) > eps) out.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

/** A cubic's extrema along one axis: where its derivative is zero. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  // B'(t) / 3 = a t² + b t + c.
  return unitRoots(a, b, c).map((t) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  });
}

function quadExtrema(p0: number, p1: number, p2: number): number[] {
  const d = p0 - 2 * p1 + p2;
  if (d === 0) return [];
  const t = (p0 - p1) / d;
  if (!(t > 0 && t < 1)) return [];
  const u = 1 - t;
  return [u * u * p0 + 2 * u * t * p1 + t * t * p2];
}

/** One route segment from `from`, extending `box`; returns its end point. */
function addSegment(box: Box, from: Point, seg: PathSeg): Point {
  switch (seg.t) {
    case 'L':
      break;
    case 'Q':
      for (const x of quadExtrema(from.x, seg.c.x, seg.to.x)) addPoint(box, x, from.y);
      for (const y of quadExtrema(from.y, seg.c.y, seg.to.y)) addPoint(box, from.x, y);
      break;
    case 'C':
      for (const x of cubicExtrema(from.x, seg.c1.x, seg.c2.x, seg.to.x)) addPoint(box, x, from.y);
      for (const y of cubicExtrema(from.y, seg.c1.y, seg.c2.y, seg.to.y)) addPoint(box, from.x, y);
      break;
    case 'A': {
      // The renderer draws `A rw rh 0 0 sweep` — never the large arc — so the
      // arc is at most a half-ellipse (radii too small for the chord are scaled
      // up to exactly span it) and strays from its chord by at most its larger
      // radius. No shipped engine emits one; this is a conservative bound.
      const reach = Math.max(seg.r.w, seg.r.h, Math.hypot(seg.to.x - from.x, seg.to.y - from.y) / 2);
      addPoint(box, Math.min(from.x, seg.to.x) - reach, Math.min(from.y, seg.to.y) - reach);
      addPoint(box, Math.max(from.x, seg.to.x) + reach, Math.max(from.y, seg.to.y) + reach);
      break;
    }
  }
  addPoint(box, seg.to.x, seg.to.y);
  return seg.to;
}

/** The extent of everything `result` draws, with no margin; `null` when it
 *  draws nothing. Coordinates are read as given (quantize them first). */
export function contentExtent(result: LayoutResult): Rect | null {
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const id of Object.keys(result.nodes).sort()) {
    const layout = result.nodes[id as keyof typeof result.nodes];
    if (layout === undefined) continue;
    addRect(box, layout.frame);
    if (layout.contentFrame !== undefined) addRect(box, layout.contentFrame);
    if (layout.ports !== undefined) {
      for (const pid of Object.keys(layout.ports).sort()) {
        const p = layout.ports[pid];
        if (p !== undefined) addPoint(box, p.point.x, p.point.y);
      }
    }
  }
  for (const id of Object.keys(result.edges).sort()) {
    const layout = result.edges[id as keyof typeof result.edges];
    if (layout === undefined) continue;
    addPoint(box, layout.start.x, layout.start.y);
    addPoint(box, layout.end.x, layout.end.y);
    let at: Point = layout.start;
    for (const seg of layout.route) at = addSegment(box, at, seg);
  }
  for (const label of result.labels) addLabelFrame(box, label.frame, label.rotation);
  if (!(box.x0 <= box.x1 && box.y0 <= box.y1)) return null;
  return { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 };
}
