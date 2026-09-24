import { asEdgeId, asLabelId, asNodeId, NO_SPAN, type GraphEdge, type GraphNode, type LabelSpec, type SemanticGraph } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { LAYOUT_API_VERSION, type EdgeLayout, type LayoutEngine, type LayoutInput, type LayoutResult, type ResolvedThemeMetricsView } from '../src/contract.js';
import { applyHostFallbacks, finishEngineRoutes, MIN_SELF_LOOP_HEIGHT } from '../src/fallbacks.js';
import { quantize } from '../src/validate.js';

import type { WorkerToHost } from '../src/protocol.js';
import { EngineRegistry } from '../src/registry.js';
import { createWorkerRuntime } from '../src/worker-runtime.js';

/** DD-06 §5's margin, a literal rather than the code's own constant. */
const CANVAS_MARGIN = 16;

/**
 * Stage K: DD-06 §6.2's "then the host applies §4.4 (arrow reserve) and §4.5
 * (self-loops)" for routes an *engine* returned — `finishEngineRoutes` — and
 * the one post-engine sequence (`applyHostFallbacks`) the worker runtime and
 * the conformance harness share. Both halves of the seam are tested: the
 * function alone, and through the real worker runtime, because this project
 * has already had one arrowhead reserved twice.
 */

const METRICS: ResolvedThemeMetricsView = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {}, arrowSize: 8 };
const A = asNodeId('a');
const B = asNodeId('b');

function node(id: string): GraphNode {
  return {
    id: asNodeId(id),
    path: [id],
    parent: null,
    children: [],
    depth: 0,
    shape: 'rect',
    classes: [],
    labelId: null,
    ports: [],
    config: {},
    hidden: false,
    span: NO_SPAN,
  };
}

function edge(id: string, from: string, to: string, directed: GraphEdge['directed'] = 'forward', labelId: string | null = null): GraphEdge {
  return {
    id: asEdgeId(id),
    from: { node: asNodeId(from) },
    to: { node: asNodeId(to) },
    directed,
    classes: [],
    labelId: labelId === null ? null : asLabelId(labelId),
    config: {},
    declaredIn: null,
    hidden: false,
    span: NO_SPAN,
  };
}

function inputOf(edges: readonly GraphEdge[], labels: SemanticGraph['labels'] = {}): LayoutInput {
  const graph: SemanticGraph = {
    nodes: { [A]: node('a'), [B]: node('b') } as SemanticGraph['nodes'],
    edges,
    rootChildren: [A, B],
    order: [A, B],
    labels,
    meta: { nodeCount: 2, edgeCount: edges.length, containerCount: 0 },
  };
  const sizing = { intrinsic: { w: 0, h: 0 }, contentInset: [0, 0, 0, 0] as const, padding: [0, 0, 0, 0] as const };
  const labelSizes = Object.fromEntries(Object.keys(labels).map((id) => [id, { w: 20, h: 10 }]));
  return { graph, scope: null, sizing: { [A]: sizing, [B]: sizing } as LayoutInput['sizing'], labelSizes };
}

/** `a` at (0,0) 40×20, `b` at (100,100) 40×20. */
const NODES: LayoutResult['nodes'] = {
  [A]: { frame: { x: 0, y: 0, w: 40, h: 20 } },
  [B]: { frame: { x: 100, y: 100, w: 40, h: 20 } },
};

/** An orthogonal engine route from `a`'s bottom to `b`'s top, ending on the boundary. */
const ORTHO: EdgeLayout = {
  start: { x: 20, y: 20 },
  end: { x: 120, y: 100 },
  route: [
    { t: 'L', to: { x: 20, y: 60 } },
    { t: 'L', to: { x: 120, y: 60 } },
    { t: 'L', to: { x: 120, y: 100 } },
  ],
  startNormal: { x: 0, y: -1 },
  endNormal: { x: 0, y: 1 },
  clip: 'none',
};

const result = (edges: LayoutResult['edges'], labels: LayoutResult['labels'] = []): LayoutResult => ({
  bounds: { x: 0, y: 0, w: 150, h: 130 },
  nodes: NODES,
  edges,
  labels,
});

describe('finishEngineRoutes (DD-06 §4.4 on an engine route)', () => {
  it('pulls a forward head back by arrowSize along the final segment, route and end together', () => {
    const input = inputOf([edge('e1', 'a', 'b')]);
    const out = finishEngineRoutes(input, result({ [asEdgeId('e1')]: ORTHO }), METRICS).edges[asEdgeId('e1')]!;
    expect(out.end).toEqual({ x: 120, y: 92 });
    expect(out.route.at(-1)).toEqual({ t: 'L', to: { x: 120, y: 92 } });
    expect(out.route.slice(0, -1)).toEqual(ORTHO.route.slice(0, -1));
    expect(out.start).toEqual(ORTHO.start);
  });

  it('pulls both ends back for `both`, neither for `none`', () => {
    const both = finishEngineRoutes(inputOf([edge('e1', 'a', 'b', 'both')]), result({ [asEdgeId('e1')]: ORTHO }), METRICS).edges[asEdgeId('e1')]!;
    expect(both.start).toEqual({ x: 20, y: 28 });
    expect(both.end).toEqual({ x: 120, y: 92 });
    const plain = result({ [asEdgeId('e1')]: ORTHO });
    expect(finishEngineRoutes(inputOf([edge('e1', 'a', 'b', 'none')]), plain, METRICS)).toBe(plain);
  });

  it('never reverses or zeroes a final segment shorter than arrowSize: it clamps, keeping the direction (fix round 1, item 6)', () => {
    // The last segment is 5 px long, against an 8 px arrowSize.
    const short: EdgeLayout = {
      start: { x: 20, y: 20 },
      end: { x: 120, y: 100 },
      route: [
        { t: 'L', to: { x: 20, y: 95 } },
        { t: 'L', to: { x: 120, y: 95 } },
        { t: 'L', to: { x: 120, y: 100 } },
      ],
      clip: 'none',
    };
    const out = finishEngineRoutes(inputOf([edge('e1', 'a', 'b')]), result({ [asEdgeId('e1')]: short }), METRICS).edges[asEdgeId('e1')]!;
    const before = { x: 120, y: 95 };
    // Still heading down (+y) from the previous point, and not onto it.
    expect(out.end.x).toBe(120);
    expect(out.end.y).toBeGreaterThan(before.y);
    expect(out.end.y).toBeLessThanOrEqual(100);
    expect(out.endNormal).toEqual({ x: 0, y: 1 });

    // One 6 px segment reserved at both ends: neither end crosses the other.
    const tiny: EdgeLayout = { start: { x: 0, y: 0 }, end: { x: 6, y: 0 }, route: [{ t: 'L', to: { x: 6, y: 0 } }], clip: 'none' };
    const both = finishEngineRoutes(inputOf([edge('e1', 'a', 'b', 'both')]), result({ [asEdgeId('e1')]: tiny }), METRICS).edges[asEdgeId('e1')]!;
    expect(both.start.x).toBeGreaterThanOrEqual(0);
    expect(both.end.x).toBeLessThanOrEqual(6);
    expect(both.end.x).toBeGreaterThan(both.start.x);
  });

  it('derives a missing end direction from the final segment', () => {
    const { startNormal: _s, endNormal: _e, ...bare } = ORTHO;
    void _s;
    void _e;
    const out = finishEngineRoutes(inputOf([edge('e1', 'a', 'b')]), result({ [asEdgeId('e1')]: bare }), METRICS).edges[asEdgeId('e1')]!;
    expect(out.endNormal).toEqual({ x: 0, y: 1 });
    expect(out.end).toEqual({ x: 120, y: 92 });
  });

  it('returns the very same result for an engine that routed nothing (grid), so its output cannot move', () => {
    const r = result({});
    expect(finishEngineRoutes(inputOf([edge('e1', 'a', 'b')]), r, METRICS)).toBe(r);
  });

  it(`replaces a self-loop under ${MIN_SELF_LOOP_HEIGHT} px with the teardrop and moves its label to the apex; the host bounds take both in`, () => {
    const labelId = asLabelId('l:loop');
    const spec: LabelSpec = { id: labelId, owner: { kind: 'edge', id: asEdgeId('loop') }, role: 'edge', runs: [{ text: 'x' }] };
    const input = inputOf([edge('loop', 'a', 'a', 'forward', 'l:loop')], { [labelId]: spec });
    // ELK's tight loop: 10 px above the node.
    const tight: EdgeLayout = {
      start: { x: 15, y: 0 },
      end: { x: 25, y: 0 },
      route: [
        { t: 'L', to: { x: 15, y: -10 } },
        { t: 'L', to: { x: 25, y: -10 } },
        { t: 'L', to: { x: 25, y: 0 } },
      ],
      clip: 'none',
    };
    const engineLabel = { labelId, frame: { x: 10, y: -30, w: 20, h: 10 }, align: 'middle' as const, baseline: 'top' as const, occlusion: 'plate' as const };
    const out = finishEngineRoutes(input, result({ [asEdgeId('loop')]: tight }, [engineLabel]), METRICS);
    const loop = out.edges[asEdgeId('loop')]!;
    expect(loop.route.every((s) => s.t === 'C')).toBe(true);
    expect(loop.route.length).toBeGreaterThanOrEqual(2);
    const moved = out.labels.find((l) => l.labelId === labelId)!;
    expect(moved.frame).not.toEqual(engineLabel.frame);
    // `finishEngineRoutes` leaves `bounds` alone; `quantize` recomputes it
    // from everything drawn (DD-06 §5, F14): the whole teardrop, sampled
    // along its curve, and its label sit at least CANVAS_MARGIN inside.
    expect(out.bounds).toEqual(result({}).bounds);
    const q = quantize(out, 64);
    const b = q.bounds;
    expect({ x: b.x, y: b.y }).toEqual({ x: 0, y: 0 });
    const inside = (p: { x: number; y: number }): void => {
      expect(p.x).toBeGreaterThanOrEqual(CANVAS_MARGIN - 1 / 64);
      expect(p.x).toBeLessThanOrEqual(b.w - CANVAS_MARGIN + 1 / 64);
      expect(p.y).toBeGreaterThanOrEqual(CANVAS_MARGIN - 1 / 64);
      expect(p.y).toBeLessThanOrEqual(b.h - CANVAS_MARGIN + 1 / 64);
    };
    const qLoop = q.edges[asEdgeId('loop')]!;
    let at = qLoop.start;
    for (const seg of qLoop.route) {
      if (seg.t !== 'C') throw new Error('teardrop is cubic');
      for (let i = 0; i <= 32; i += 1) {
        const t = i / 32;
        const u = 1 - t;
        const bez = (a: number, c1: number, c2: number, d: number): number => u * u * u * a + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * d;
        inside({ x: bez(at.x, seg.c1.x, seg.c2.x, seg.to.x), y: bez(at.y, seg.c1.y, seg.c2.y, seg.to.y) });
      }
      at = seg.to;
    }
    const qLabel = q.labels.find((l) => l.labelId === labelId)!;
    inside(qLabel.frame);
    inside({ x: qLabel.frame.x + qLabel.frame.w, y: qLabel.frame.y + qLabel.frame.h });
  });

  it('keeps a self-loop the engine drew at least 16 px tall (reserving its head), and its label', () => {
    const input = inputOf([edge('loop', 'a', 'a')]);
    const tall: EdgeLayout = {
      start: { x: 0, y: 5 },
      end: { x: 0, y: 15 },
      route: [
        { t: 'L', to: { x: -20, y: 5 } },
        { t: 'L', to: { x: -20, y: 25 } },
        { t: 'L', to: { x: -10, y: 25 } },
        { t: 'L', to: { x: -10, y: 15 } },
        { t: 'L', to: { x: 0, y: 15 } },
      ],
      clip: 'none',
    };
    const r = result({ [asEdgeId('loop')]: tall });
    const out = finishEngineRoutes(input, r, METRICS);
    expect(out.edges[asEdgeId('loop')]!.end).toEqual({ x: -8, y: 15 });
    expect(out.bounds).toEqual(r.bounds);
  });
});

describe('applyHostFallbacks: no route is reserved twice', () => {
  /** How far a route's end sits from `b`'s top edge (y = 100). */
  const gapToB = (l: EdgeLayout): number => 100 - l.end.y;

  it('an engine route and a fallback route both end exactly arrowSize short of the boundary', () => {
    const input = inputOf([edge('e1', 'a', 'b'), edge('e2', 'a', 'b')]);
    // The engine routed e1 and left e2 for the host.
    const out = applyHostFallbacks(input, result({ [asEdgeId('e1')]: ORTHO }), { labelPlacement: true }, METRICS);
    expect(gapToB(out.edges[asEdgeId('e1')]!)).toBe(8);
    // routeStraight's straight line meets `b` on its top edge too (it heads down-right).
    const e2 = out.edges[asEdgeId('e2')]!;
    const along = Math.hypot(e2.end.x - e2.start.x, e2.end.y - e2.start.y);
    expect(along).toBeGreaterThan(0);
    expect(e2.endNormal).toBeDefined();
    const tip = { x: e2.end.x + e2.endNormal!.x * 8, y: e2.end.y + e2.endNormal!.y * 8 };
    expect(tip.y).toBeCloseTo(100, 9);
  });

  it('through the real worker runtime: the posted route is reserved once', async () => {
    const engine: LayoutEngine = {
      id: 'test.routes',
      name: 'routes',
      version: '0.0.0',
      apiVersion: LAYOUT_API_VERSION,
      capabilities: { containers: false, edgeRouting: 'orthogonal', ports: false, labelPlacement: true, incremental: false, determinism: 'bitwise' },
      layout: () => Promise.resolve(result({ [asEdgeId('e1')]: ORTHO })),
    };
    const registry = new EngineRegistry();
    registry.register(engine);
    const sent: WorkerToHost[] = [];
    const runtime = createWorkerRuntime(registry, { post: (m) => sent.push(m) });
    runtime.receive({ t: 'layout', id: 1, engine: engine.id, input: inputOf([edge('e1', 'a', 'b')]), options: {}, metrics: METRICS, table: {}, seed: 1 });
    await expect.poll(() => sent.length).toBe(1);
    const message = sent[0]!;
    if (message.t !== 'result') throw new Error('expected a result');
    expect(gapToB(message.result.edges[asEdgeId('e1')]!)).toBe(8);
  });
});
