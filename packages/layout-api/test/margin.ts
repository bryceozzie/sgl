import type { PathSeg, Point, Rect } from '@sgl/core';
import type { LayoutResult } from '../src/contract.js';

/**
 * A test-side, independent measure of what a `LayoutResult` draws (DD-06 §5,
 * F14): every frame, content frame, port, label frame and route, curves
 * sampled at 64 points each rather than solved, so it shares no code with
 * `bounds.ts`. `null` when nothing is drawn. Sampling can only undershoot a
 * curve's true extremum, and by far less than a pixel at these sizes.
 */
export function sampledExtent(result: LayoutResult): Rect | null {
  const pts: Point[] = [];
  const rect = (r: Rect): void => {
    pts.push({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h });
  };
  for (const n of Object.values(result.nodes)) {
    rect(n.frame);
    if (n.contentFrame !== undefined) rect(n.contentFrame);
    for (const p of Object.values(n.ports ?? {})) pts.push(p.point);
  }
  for (const l of result.labels) rect(l.frame);
  for (const e of Object.values(result.edges)) {
    let at = e.start;
    pts.push(at, e.end);
    for (const seg of e.route) {
      pts.push(...sample(at, seg));
      at = seg.to;
    }
  }
  if (pts.length === 0) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function sample(from: Point, seg: PathSeg): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= 64; i += 1) {
    const t = i / 64;
    const u = 1 - t;
    if (seg.t === 'C') {
      const f = (a: number, b: number, c: number, d: number): number => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
      out.push({ x: f(from.x, seg.c1.x, seg.c2.x, seg.to.x), y: f(from.y, seg.c1.y, seg.c2.y, seg.to.y) });
    } else if (seg.t === 'Q') {
      const f = (a: number, b: number, c: number): number => u * u * a + 2 * u * t * b + t * t * c;
      out.push({ x: f(from.x, seg.c.x, seg.to.x), y: f(from.y, seg.c.y, seg.to.y) });
    } else {
      out.push({ x: from.x + (seg.to.x - from.x) * t, y: from.y + (seg.to.y - from.y) * t });
    }
  }
  return out;
}

/** The four margins between `result.bounds` and what it draws. */
export function margins(result: LayoutResult): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null {
  const e = sampledExtent(result);
  if (e === null) return null;
  const b = result.bounds;
  return { left: e.x - b.x, top: e.y - b.y, right: b.x + b.w - (e.x + e.w), bottom: b.y + b.h - (e.y + e.h) };
}
