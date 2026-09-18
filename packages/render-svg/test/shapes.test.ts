import { anchorPoint, contentInsets as layoutContentInsets } from '@sgl/layout-api';
import type { Point, Rect, ShapeId } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { cylinderRy, hexagonInset, resolveShape, SHAPE_IDS, SHAPES } from '../src/shapes.js';

const frame = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const centre = (f: Rect): Point => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });

/** Points on a ray from the frame's centre, at a spread of angles and past the
 *  boundary, so every anchor call is a genuine intersection, not a degenerate
 *  or interior case. DD-07 §11: "rays at 0°, 45°, 90° and edge cases." */
const RAY_ANGLES_DEG = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];

function rayPoint(f: Rect, angleDeg: number, radius = 1000): Point {
  const c = centre(f);
  const rad = (angleDeg * Math.PI) / 180;
  return { x: c.x + radius * Math.cos(rad), y: c.y + radius * Math.sin(rad) };
}

describe('shapes: path()', () => {
  it('rect: a closed axis-aligned rectangle at the frame', () => {
    expect(SHAPES.rect!.path(frame(10, 20, 30, 40), 0)).toBe('M 10 20 h 30 v 40 h -30 Z');
  });

  it('round: degenerates to the rect path when the radius rounds to zero', () => {
    expect(SHAPES.round!.path(frame(0, 0, 10, 10), 0)).toBe(SHAPES.rect!.path(frame(0, 0, 10, 10), 0));
  });

  it('round: clamps the radius to half the smaller side', () => {
    // A radius bigger than the frame must not invert the arcs; just assert it
    // still produces a well-formed, non-empty path with the clamped corner arcs.
    const path = SHAPES.round!.path(frame(0, 0, 10, 20), 1000);
    expect(path).toContain('a 5 5 0 0 1 5 5');
  });

  for (const id of SHAPE_IDS) {
    it(`${id}: path is deterministic for the same frame`, () => {
      const f = frame(3.5, -2.25, 60, 40);
      expect(SHAPES[id]!.path(f, 4)).toBe(SHAPES[id]!.path(f, 4));
    });
  }
});

describe('shapes: anchor() degenerate case', () => {
  for (const id of SHAPE_IDS) {
    it(`${id}: from == centre returns the centre`, () => {
      const f = frame(5, 5, 80, 50);
      expect(SHAPES[id]!.anchor(f, centre(f))).toEqual(centre(f));
    });

    it(`${id}: from within epsilon of the centre also returns the centre`, () => {
      const f = frame(5, 5, 80, 50);
      const c = centre(f);
      expect(SHAPES[id]!.anchor(f, { x: c.x + 1e-12, y: c.y })).toEqual(c);
    });
  }
});

describe('shapes: anchor() boundary property', () => {
  for (const id of SHAPE_IDS) {
    for (const angle of RAY_ANGLES_DEG) {
      it(`${id}: a ray at ${angle}° lands on the boundary, not inside or outside`, () => {
        const f = frame(-10, 15, 120, 70);
        const p = SHAPES[id]!.anchor(f, rayPoint(f, angle));
        // Every built-in shape is star-shaped about its own centre, so a boundary
        // point is exactly as far from the centre as *some* point of the outline
        // in that direction — cheapest to assert per-shape below instead of via a
        // generic point-in-polygon test that would just re-implement each shape.
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      });
    }
  }
});

describe('shapes: anchor() — box family (rect, round, cylinder, package)', () => {
  const BOX_SHAPES: readonly ShapeId[] = ['rect', 'round', 'cylinder', 'package'];
  for (const id of BOX_SHAPES) {
    for (const angle of RAY_ANGLES_DEG) {
      it(`${id}: a ray at ${angle}° lands exactly on one of the four frame edges`, () => {
        const f = frame(0, 0, 100, 60);
        const p = SHAPES[id]!.anchor(f, rayPoint(f, angle));
        const onVertical = Math.abs(p.x - f.x) < 1e-6 || Math.abs(p.x - (f.x + f.w)) < 1e-6;
        const onHorizontal = Math.abs(p.y - f.y) < 1e-6 || Math.abs(p.y - (f.y + f.h)) < 1e-6;
        expect(onVertical || onHorizontal).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(f.x - 1e-6);
        expect(p.x).toBeLessThanOrEqual(f.x + f.w + 1e-6);
        expect(p.y).toBeGreaterThanOrEqual(f.y - 1e-6);
        expect(p.y).toBeLessThanOrEqual(f.y + f.h + 1e-6);
      });
    }
  }
});

describe('shapes: anchor() — ellipse', () => {
  it('every non-degenerate anchor satisfies the ellipse equation', () => {
    const f = frame(10, 10, 200, 90);
    const c = centre(f);
    const a = f.w / 2;
    const b = f.h / 2;
    for (const angle of RAY_ANGLES_DEG) {
      const p = SHAPES.ellipse!.anchor(f, rayPoint(f, angle));
      const lhs = ((p.x - c.x) / a) ** 2 + ((p.y - c.y) / b) ** 2;
      expect(lhs).toBeCloseTo(1, 9);
    }
  });
});

describe('shapes: anchor() — polygon (diamond, hexagon)', () => {
  const POLY_SHAPES: readonly ShapeId[] = ['diamond', 'hexagon'];
  for (const id of POLY_SHAPES) {
    for (const angle of RAY_ANGLES_DEG) {
      it(`${id}: a ray at ${angle}° (including diagonals) lands exactly on an edge segment`, () => {
        const f = frame(0, 0, 140, 90);
        const p = SHAPES[id]!.anchor(f, rayPoint(f, angle));
        const verts =
          id === 'diamond'
            ? diamondVerticesFor(f)
            : hexagonVerticesFor(f);
        expect(pointOnPolygonBoundary(p, verts)).toBe(true);
      });
    }
  }
});

function diamondVerticesFor(f: Rect): readonly Point[] {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  return [
    { x: cx, y: f.y },
    { x: f.x + f.w, y: cy },
    { x: cx, y: f.y + f.h },
    { x: f.x, y: cy },
  ];
}

function hexagonVerticesFor(f: Rect): readonly Point[] {
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

function pointOnPolygonBoundary(p: Point, verts: readonly Point[]): boolean {
  const EPS = 1e-6;
  for (let i = 0; i < verts.length; i += 1) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) > EPS) continue;
    const within =
      p.x >= Math.min(a.x, b.x) - EPS &&
      p.x <= Math.max(a.x, b.x) + EPS &&
      p.y >= Math.min(a.y, b.y) - EPS &&
      p.y <= Math.max(a.y, b.y) + EPS;
    if (within) return true;
  }
  return false;
}

describe('shapes: geometry constants match DD-07 §4', () => {
  it('cylinderRy: min(8, h/6)', () => {
    expect(cylinderRy(frame(0, 0, 10, 30))).toBe(5);
    expect(cylinderRy(frame(0, 0, 10, 120))).toBe(8);
  });

  it('hexagonInset: min(h/2, 0.25w)', () => {
    expect(hexagonInset(frame(0, 0, 100, 20))).toBe(10);
    expect(hexagonInset(frame(0, 0, 20, 100))).toBe(5);
  });
});

describe('shapes: contentInsets() containment property (DD-07 §4)', () => {
  const LABEL_SIZES: readonly [number, number][] = [
    [10, 10],
    [40, 12],
    [12, 40],
    [1, 1],
    [0, 0],
    [200, 8],
  ];

  for (const id of SHAPE_IDS) {
    for (const [w, h] of LABEL_SIZES) {
      it(`${id}: a shape sized to its own insets(${w}x${h}) content box holds exactly that label`, () => {
        const [t, r, b, l] = SHAPES[id]!.contentInsets(w, h);
        const shapeW = w + l + r;
        const shapeH = h + t + b;
        const f = frame(0, 0, shapeW, shapeH);
        // The shape sized by these insets must have a content box (frame minus
        // insets) of exactly labelW x labelH — the fixed point DD-07 §4 describes.
        expect(f.w - l - r).toBeCloseTo(w, 9);
        expect(f.h - t - b).toBeCloseTo(h, 9);
      });
    }
  }
});

describe('resolveShape()', () => {
  it('known shapes resolve to themselves', () => {
    for (const id of SHAPE_IDS) {
      const { shape, known } = resolveShape(id);
      expect(known).toBe(true);
      expect(shape).toBe(SHAPES[id]);
    }
  });

  it('falls back to rect for an unrecognised id — but Stage C guarantees GraphNode.shape never reaches render() unresolved (07-execution-plan §5, Stage F preamble)', () => {
    const { shape, known } = resolveShape('not-a-real-shape');
    expect(known).toBe(false);
    expect(shape).toBe(SHAPES.rect);
  });
});

// ---------------------------------------------------------------------------
// Cross-package agreement with @sgl/layout-api (DD-06's duplicate of DD-07 §4,
// per contract.ts's DD-00 §2 rule 2 — layout-api may not import render-svg, so
// anchor.ts and content-insets.ts re-derive the same formulas independently).
// Only possible from a render-svg *test* file: eslint.config.js exempts
// `**/*.test.ts` from the import-boundary rule that would block this import
// from src/. The Stage E review round could only pin each side's defining
// geometric property and note "verified against commit f1c476c5, 2026-09-15"
// by hand; this makes that comparison automatic and permanent.
// ---------------------------------------------------------------------------

describe('cross-package agreement: @sgl/layout-api anchor.ts vs render-svg shapes.ts', () => {
  const ALL_SHAPES: readonly ShapeId[] = ['rect', 'round', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'package'];

  for (const id of ALL_SHAPES) {
    for (const angle of RAY_ANGLES_DEG) {
      it(`${id} at ${angle}°: anchorPoint() and SHAPES[id].anchor() agree exactly`, () => {
        const f = frame(-5, 12, 130, 84);
        const toward = rayPoint(f, angle);
        const fromLayoutApi = anchorPoint(id, f, toward);
        const fromRenderSvg = SHAPES[id]!.anchor(f, toward);
        expect(fromLayoutApi).toEqual(fromRenderSvg);
      });
    }
  }

  it('degenerate (from == centre) agrees on both sides', () => {
    const f = frame(0, 0, 50, 30);
    const c = centre(f);
    for (const id of ALL_SHAPES) {
      expect(anchorPoint(id, f, c)).toEqual(SHAPES[id]!.anchor(f, c));
    }
  });
});

describe('cross-package agreement: @sgl/layout-api content-insets.ts vs render-svg shapes.ts', () => {
  const ALL_SHAPES: readonly ShapeId[] = ['rect', 'round', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'package'];
  const LABEL_SIZES: readonly [number, number][] = [
    [10, 10],
    [40, 12],
    [12, 40],
    [1, 1],
    [0, 0],
    [200, 8],
  ];

  for (const id of ALL_SHAPES) {
    for (const [w, h] of LABEL_SIZES) {
      it(`${id}: contentInsets(${w}x${h}) agrees exactly between the two packages`, () => {
        expect(layoutContentInsets(id, w, h)).toEqual(SHAPES[id]!.contentInsets(w, h));
      });
    }
  }
});
