import type { Point, Rect } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { anchorPoint, centreOf, unit } from '../src/anchor.js';

const FRAME: Rect = { x: 0, y: 0, w: 100, h: 50 };
const EPS = 1e-6;

/** True if `p` lies on the boundary of `frame`, within tolerance. */
function onBoxBoundary(p: Point, frame: Rect): boolean {
  const onVerticalEdge = (p.x === frame.x || Math.abs(p.x - (frame.x + frame.w)) < EPS) && p.y >= frame.y - EPS && p.y <= frame.y + frame.h + EPS;
  const onHorizontalEdge = (p.y === frame.y || Math.abs(p.y - (frame.y + frame.h)) < EPS) && p.x >= frame.x - EPS && p.x <= frame.x + frame.w + EPS;
  return onVerticalEdge || onHorizontalEdge;
}

/** True if `p` lies on one of `vertices`' edges, within tolerance — a
 *  point-to-segment distance check, not just a bounding-box check. */
function onPolygonBoundary(p: Point, vertices: readonly Point[]): boolean {
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2));
    const cx = a.x + t * ex;
    const cy = a.y + t * ey;
    if (Math.hypot(p.x - cx, p.y - cy) < EPS) return true;
  }
  return false;
}

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

function hexagonVertices(f: Rect): readonly Point[] {
  const i = Math.min(f.h / 2, f.w / 4);
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

describe('anchorPoint (DD-07 §4)', () => {
  it('returns the centre for a degenerate ray (toward === centre)', () => {
    expect(anchorPoint('rect', FRAME, centreOf(FRAME))).toEqual(centreOf(FRAME));
  });

  it('returns the centre for a zero-sized frame', () => {
    const zero: Rect = { x: 10, y: 10, w: 0, h: 0 };
    expect(anchorPoint('rect', zero, { x: 100, y: 100 })).toEqual(centreOf(zero));
  });

  describe('box (rect, round, cylinder, package, and any unknown shape)', () => {
    it('clips straight right to the right edge midpoint', () => {
      expect(anchorPoint('rect', FRAME, { x: 1000, y: 25 })).toEqual({ x: 100, y: 25 });
    });

    it('clips straight down to the bottom edge midpoint', () => {
      expect(anchorPoint('rect', FRAME, { x: 50, y: 1000 })).toEqual({ x: 50, y: 50 });
    });

    it('an unknown shape id uses the box anchor', () => {
      expect(anchorPoint('some-future-shape', FRAME, { x: 1000, y: 25 })).toEqual({ x: 100, y: 25 });
    });

    it('a diagonal ray still lands exactly on an edge, not a rounded-off interior point', () => {
      const p = anchorPoint('rect', FRAME, { x: 1000, y: 1000 });
      expect(onBoxBoundary(p, FRAME)).toBe(true);
    });
  });

  describe('ellipse', () => {
    it('lies on the ellipse boundary along every cardinal direction', () => {
      const right = anchorPoint('ellipse', FRAME, { x: 1000, y: 25 });
      expect(right.x).toBeCloseTo(100, 6);
      expect(right.y).toBeCloseTo(25, 6);
      const down = anchorPoint('ellipse', FRAME, { x: 50, y: 1000 });
      expect(down.x).toBeCloseTo(50, 6);
      expect(down.y).toBeCloseTo(50, 6);
    });

    it('a diagonal ray lands strictly inside the box (an ellipse, not its bounding box)', () => {
      const p = anchorPoint('ellipse', FRAME, { x: 1000, y: 1000 });
      expect(p.x).toBeLessThan(100);
      expect(p.y).toBeLessThan(50);
      // On the ellipse: ((x-cx)/a)^2 + ((y-cy)/b)^2 = 1.
      const a = 50;
      const b = 25;
      const cx = 50;
      const cy = 25;
      const eq = ((p.x - cx) / a) ** 2 + ((p.y - cy) / b) ** 2;
      expect(eq).toBeCloseTo(1, 6);
    });
  });

  describe('polygon (diamond, hexagon)', () => {
    it('diamond: straight right hits the right vertex', () => {
      expect(anchorPoint('diamond', FRAME, { x: 1000, y: 25 })).toEqual({ x: 100, y: 25 });
    });

    it('hexagon: straight right hits the right vertex', () => {
      expect(anchorPoint('hexagon', FRAME, { x: 1000, y: 25 })).toEqual({ x: 100, y: 25 });
    });

    it('diamond: a diagonal ray lands exactly on one of the four edges', () => {
      const p = anchorPoint('diamond', FRAME, { x: 90, y: 40 });
      expect(onPolygonBoundary(p, diamondVertices(FRAME))).toBe(true);
    });

    it('hexagon: a diagonal ray lands exactly on one of the six edges', () => {
      const p = anchorPoint('hexagon', FRAME, { x: 90, y: 5 });
      expect(onPolygonBoundary(p, hexagonVertices(FRAME))).toBe(true);
    });
  });
});

describe('unit', () => {
  it('normalises to length 1', () => {
    const v = unit(3, 4)!;
    expect(v.x).toBeCloseTo(0.6, 10);
    expect(v.y).toBeCloseTo(0.8, 10);
  });

  it('returns null for a zero vector', () => {
    expect(unit(0, 0)).toBeNull();
  });
});
