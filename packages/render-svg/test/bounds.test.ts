import type { PathSeg, Point, Rect } from '@sgl/core';
import type { LayoutEngine, LayoutResult } from '@sgl/layout-api';
import { elkEngine } from '@sgl/layout-elk';
import { gridEngine } from '@sgl/layout-std';
import { neutralLight } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { num } from '../src/num.js';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { corpusSource, runPipeline } from './pipeline.js';

/**
 * F14 (execution plan §2.1, DD-06 §5): `bounds` is computed by the host from
 * what the quantized result draws, plus `CANVAS_MARGIN` (16 px) on every side,
 * under **every** engine. Before, `grid`'s bounds had no margin and its
 * self-loop teardrops (DD-06 §4.5) reached above `y = 0`, outside the canvas,
 * so they were clipped; `elk`'s margin was ELK's own 12 px root padding.
 *
 * Checked over the corpus under both engines, end to end through `render()`:
 * every point of every frame, label and route — curves sampled along their
 * length, not just their end points — sits at least `CANVAS_MARGIN` inside the
 * canvas, the margin is exactly `CANVAS_MARGIN` on every side (the content
 * touches it), and the SVG's `viewBox`, size and canvas rect are those bounds.
 */

const ENGINES: readonly LayoutEngine[] = [gridEngine, elkEngine];
/** DD-06 §5's canvas margin, as a literal: the package's own `CANVAS_MARGIN`
 *  would move with the code under test (fix round 1, item 6). */
const CANVAS_MARGIN = 16;
const EPS = 1 / 64;

/** Every point `result` draws, curves sampled at 33 points each. */
function drawnPoints(result: LayoutResult): Point[] {
  const out: Point[] = [];
  const rect = (r: Rect): void => {
    out.push({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h });
  };
  for (const n of Object.values(result.nodes)) rect(n.frame);
  for (const l of result.labels) rect(l.frame);
  for (const e of Object.values(result.edges)) {
    let at = e.start;
    out.push(at);
    for (const seg of e.route) {
      out.push(...sample(at, seg));
      at = seg.to;
    }
  }
  return out;
}

function sample(from: Point, seg: PathSeg): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i <= 32; i += 1) {
    const t = i / 32;
    const u = 1 - t;
    if (seg.t === 'C') {
      const f = (a: number, b: number, c: number, d: number): number => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
      pts.push({ x: f(from.x, seg.c1.x, seg.c2.x, seg.to.x), y: f(from.y, seg.c1.y, seg.c2.y, seg.to.y) });
    } else if (seg.t === 'Q') {
      const f = (a: number, b: number, c: number): number => u * u * a + 2 * u * t * b + t * t * c;
      pts.push({ x: f(from.x, seg.c.x, seg.to.x), y: f(from.y, seg.c.y, seg.to.y) });
    } else {
      pts.push({ x: from.x + (seg.to.x - from.x) * t, y: from.y + (seg.to.y - from.y) * t });
    }
  }
  return pts;
}

describe('F14: host-computed bounds, under both engines (DD-06 §5)', () => {
  for (const engine of ENGINES) {
    for (const doc of CLEAN_DOCS) {
      it(`${doc} under ${engine.id}: everything drawn is at least ${CANVAS_MARGIN} px inside the canvas, and the margin is exactly that`, async () => {
        const { result, rendered } = await runPipeline(corpusSource(doc), neutralLight, engine);
        const { bounds } = result;
        expect(rendered.bounds).toEqual(bounds);
        expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 0, y: 0 });

        const svg = rendered.svg;
        const [w, h] = [num(bounds.w), num(bounds.h)];
        expect(svg).toContain(` width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"`);
        expect(svg).toContain(`<rect class="canvas" x="0" y="0" width="${w}" height="${h}"`);

        const points = drawnPoints(result);
        if (points.length === 0) {
          expect(bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
          return;
        }
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        expect(minX).toBeGreaterThanOrEqual(CANVAS_MARGIN - EPS);
        expect(minY).toBeGreaterThanOrEqual(CANVAS_MARGIN - EPS);
        expect(maxX).toBeLessThanOrEqual(bounds.w - CANVAS_MARGIN + EPS);
        expect(maxY).toBeLessThanOrEqual(bounds.h - CANVAS_MARGIN + EPS);
        // Tight: sampling can only undershoot a curve's extremum, by well
        // under a pixel at these sizes.
        expect(minX).toBeLessThanOrEqual(CANVAS_MARGIN + 0.5);
        expect(minY).toBeLessThanOrEqual(CANVAS_MARGIN + 0.5);
        expect(maxX).toBeGreaterThanOrEqual(bounds.w - CANVAS_MARGIN - 0.5);
        expect(maxY).toBeGreaterThanOrEqual(bounds.h - CANVAS_MARGIN - 0.5);
      }, 30_000);
    }
  }

  it("grid's self-loop teardrops are no longer clipped at the canvas edge (parallel-selfloop.sgl)", async () => {
    const { result, input } = await runPipeline(corpusSource('parallel-selfloop.sgl'), neutralLight, gridEngine);
    const loops = input.graph.edges.filter((e) => e.from.node === e.to.node);
    expect(loops.length).toBe(3);
    for (const edge of loops) {
      const layout = result.edges[edge.id]!;
      expect(layout.route.some((s) => s.t === 'C')).toBe(true);
      const pts = [layout.start];
      let at = layout.start;
      for (const seg of layout.route) {
        pts.push(...sample(at, seg));
        at = seg.to;
      }
      // The teardrop rises above its node; its apex used to be at y < 0.
      const frame = result.nodes[edge.from.node]!.frame;
      const apex = Math.min(...pts.map((p) => p.y));
      expect(apex).toBeLessThan(frame.y);
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(CANVAS_MARGIN - EPS);
        expect(p.y).toBeGreaterThanOrEqual(CANVAS_MARGIN - EPS);
        expect(p.x).toBeLessThanOrEqual(result.bounds.w - CANVAS_MARGIN + EPS);
        expect(p.y).toBeLessThanOrEqual(result.bounds.h - CANVAS_MARGIN + EPS);
      }
    }
  });
});
