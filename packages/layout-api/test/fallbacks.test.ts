import {
  asEdgeId,
  asLabelId,
  asNodeId,
  NO_SPAN,
  type GraphEdge,
  type GraphNode,
  type LabelSpec,
  type SemanticGraph,
} from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { placeLabels, routeStraight } from '../src/fallbacks.js';
import type { LayoutInput, LayoutResult, ResolvedThemeMetricsView } from '../src/contract.js';

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: {},
  arrowSize: 8,
};

const A = asNodeId('a');
const B = asNodeId('b');

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: A,
    path: ['a'],
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
    ...overrides,
  };
}

function twoNodeGraph(labels: SemanticGraph['labels'] = {}, edges: readonly GraphEdge[] = []): SemanticGraph {
  const a = node({ id: A, path: ['a'] });
  const b = node({ id: B, path: ['b'] });
  return {
    nodes: { [A]: a, [B]: b } as SemanticGraph['nodes'],
    edges,
    rootChildren: [A, B],
    order: [A, B],
    labels,
    meta: { nodeCount: 2, edgeCount: edges.length, containerCount: 0 },
  };
}

function baseInput(graph: SemanticGraph): LayoutInput {
  return {
    graph,
    scope: null,
    sizing: {
      [A]: { intrinsic: { w: 0, h: 0 }, contentInset: [4, 4, 4, 4], padding: [4, 4, 4, 4] },
      [B]: { intrinsic: { w: 0, h: 0 }, contentInset: [4, 4, 4, 4], padding: [4, 4, 4, 4] },
    } as LayoutInput['sizing'],
    labelSizes: {},
  };
}

describe('placeLabels (DD-06 §4.1)', () => {
  it('centres a leaf node title in its content box', () => {
    const labelId = asLabelId('l:a');
    const spec: LabelSpec = { id: labelId, owner: { kind: 'node', id: A }, role: 'title', runs: [{ text: 'a' }] };
    const graph = twoNodeGraph({ [labelId]: spec });
    const input: LayoutInput = { ...baseInput(graph), labelSizes: { [labelId]: { w: 20, h: 10 } } };
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: { [A]: { frame: { x: 0, y: 0, w: 100, h: 50 } }, [B]: { frame: { x: 0, y: 0, w: 10, h: 10 } } },
      edges: {},
      labels: [],
    };

    const out = placeLabels(input, result, METRICS);
    expect(out.labels).toHaveLength(1);
    const placement = out.labels[0]!;
    // Content box is frame inset by [4,4,4,4]: x in [4,96], y in [4,46].
    // Centred 20x10 label: x = 4 + (92-20)/2 = 40, y = 4 + (42-10)/2 = 20.
    expect(placement.frame).toEqual({ x: 40, y: 20, w: 20, h: 10 });
    expect(placement.align).toBe('middle');
    expect(placement.baseline).toBe('middle');
  });

  it('places a container title top-left, not centred', () => {
    const labelId = asLabelId('l:a');
    const spec: LabelSpec = { id: labelId, owner: { kind: 'node', id: A }, role: 'title', runs: [{ text: 'a' }] };
    const container = node({ id: A, path: ['a'], children: [B] });
    const graph: SemanticGraph = {
      nodes: { [A]: container, [B]: node({ id: B, path: ['a', 'b'], parent: A, depth: 1 }) } as SemanticGraph['nodes'],
      edges: [],
      rootChildren: [A],
      order: [A, B],
      labels: { [labelId]: spec },
      meta: { nodeCount: 2, edgeCount: 0, containerCount: 1 },
    };
    const input: LayoutInput = { ...baseInput(graph), labelSizes: { [labelId]: { w: 20, h: 10 } } };
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: { [A]: { frame: { x: 0, y: 0, w: 100, h: 80 } } },
      edges: {},
      labels: [],
    };

    const out = placeLabels(input, result, METRICS);
    expect(out.labels[0]!.frame).toEqual({ x: 4, y: 4, w: 20, h: 10 });
    expect(out.labels[0]!.align).toBe('start');
    expect(out.labels[0]!.baseline).toBe('top');
  });

  it('skips a label whose owner has no NodeLayout', () => {
    const labelId = asLabelId('l:a');
    const spec: LabelSpec = { id: labelId, owner: { kind: 'node', id: A }, role: 'title', runs: [{ text: 'a' }] };
    const graph = twoNodeGraph({ [labelId]: spec });
    const input: LayoutInput = { ...baseInput(graph), labelSizes: { [labelId]: { w: 20, h: 10 } } };
    const result: LayoutResult = { bounds: { x: 0, y: 0, w: 0, h: 0 }, nodes: {}, edges: {}, labels: [] };
    expect(placeLabels(input, result, METRICS).labels).toHaveLength(0);
  });

  it('places an edge label off the line, with a plate', () => {
    const labelId = asLabelId('l:e-ab');
    const edge: GraphEdge = {
      id: asEdgeId('e-ab'),
      from: { node: A },
      to: { node: B },
      directed: 'forward',
      classes: [],
      labelId,
      config: {},
      declaredIn: null,
      hidden: false,
      span: NO_SPAN,
    };
    const spec: LabelSpec = { id: labelId, owner: { kind: 'edge', id: edge.id }, role: 'edge', runs: [{ text: 'x' }] };
    const graph = twoNodeGraph({ [labelId]: spec }, [edge]);
    const input: LayoutInput = { ...baseInput(graph), labelSizes: { [labelId]: { w: 20, h: 10 } } };
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: { [A]: { frame: { x: 0, y: 0, w: 10, h: 10 } }, [B]: { frame: { x: 90, y: 0, w: 10, h: 10 } } },
      edges: {
        [edge.id]: { start: { x: 10, y: 5 }, end: { x: 90, y: 5 }, route: [{ t: 'L', to: { x: 90, y: 5 } }], clip: 'none' },
      },
      labels: [],
    };

    const out = placeLabels(input, result, METRICS);
    expect(out.labels).toHaveLength(1);
    const placement = out.labels[0]!;
    expect(placement.occlusion).toBe('plate');
    // Off the line (y === 5): perpendicular offset must move it away from y=5.
    expect(placement.frame.y + placement.frame.h / 2).not.toBeCloseTo(5, 3);
  });
});

describe('routeStraight (DD-06 §4.2, §4.3, §4.5)', () => {
  it('routes a straight edge clipped to both shape boundaries', () => {
    const edge: GraphEdge = {
      id: asEdgeId('e-ab'),
      from: { node: A },
      to: { node: B },
      directed: 'forward',
      classes: [],
      labelId: null,
      config: {},
      declaredIn: null,
      hidden: false,
      span: NO_SPAN,
    };
    const graph = twoNodeGraph({}, [edge]);
    const input = baseInput(graph);
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: { [A]: { frame: { x: 0, y: 0, w: 20, h: 20 } }, [B]: { frame: { x: 80, y: 0, w: 20, h: 20 } } },
      edges: {},
      labels: [],
    };

    const out = routeStraight(input, result, METRICS);
    const layout = out.edges[edge.id]!;
    // A is {x:0,y:0,w:20,h:20}: its right edge, at mid-height, is (20,10).
    // B is {x:80,y:0,w:20,h:20}: its left edge is (80,10), then shortened by
    // arrowSize=8 for the forward arrowhead.
    expect(layout.start).toEqual({ x: 20, y: 10 });
    expect(layout.end.x).toBeCloseTo(80 - 8, 6);
    expect(layout.end.y).toBeCloseTo(10, 6);
    expect(layout.route).toEqual([{ t: 'L', to: layout.end }]);
    expect(layout.clip).toBe('none');
  });

  it('never overwrites a route an engine already returned', () => {
    const edge: GraphEdge = {
      id: asEdgeId('e-ab'),
      from: { node: A },
      to: { node: B },
      directed: 'none',
      classes: [],
      labelId: null,
      config: {},
      declaredIn: null,
      hidden: false,
      span: NO_SPAN,
    };
    const graph = twoNodeGraph({}, [edge]);
    const input = baseInput(graph);
    const already = { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, route: [{ t: 'L' as const, to: { x: 3, y: 4 } }], clip: 'none' as const };
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: { [A]: { frame: { x: 0, y: 0, w: 20, h: 20 } }, [B]: { frame: { x: 80, y: 0, w: 20, h: 20 } } },
      edges: { [edge.id]: already },
      labels: [],
    };
    const out = routeStraight(input, result, METRICS);
    expect(out.edges[edge.id]).toBe(already);
  });

  it('produces a teardrop of at least two segments for a self-loop', () => {
    const edge: GraphEdge = {
      id: asEdgeId('e-aa'),
      from: { node: A },
      to: { node: A },
      directed: 'forward',
      classes: [],
      labelId: null,
      config: {},
      declaredIn: null,
      hidden: false,
      span: NO_SPAN,
    };
    const graph = twoNodeGraph({}, [edge]);
    const input = baseInput(graph);
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: { [A]: { frame: { x: 0, y: 0, w: 40, h: 40 } }, [B]: { frame: { x: 80, y: 0, w: 20, h: 20 } } },
      edges: {},
      labels: [],
    };

    const layout = routeStraight(input, result, METRICS).edges[edge.id]!;
    expect(layout.route.length).toBeGreaterThanOrEqual(2);
    for (const seg of layout.route) {
      expect(Number.isFinite(seg.to.x)).toBe(true);
      expect(Number.isFinite(seg.to.y)).toBe(true);
    }
  });

  it('skips a hidden edge', () => {
    const edge: GraphEdge = {
      id: asEdgeId('e-ab'),
      from: { node: A },
      to: { node: B },
      directed: 'forward',
      classes: [],
      labelId: null,
      config: {},
      declaredIn: null,
      hidden: true,
      span: NO_SPAN,
    };
    const graph = twoNodeGraph({}, [edge]);
    const input = baseInput(graph);
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: { [A]: { frame: { x: 0, y: 0, w: 20, h: 20 } }, [B]: { frame: { x: 80, y: 0, w: 20, h: 20 } } },
      edges: {},
      labels: [],
    };
    expect(routeStraight(input, result, METRICS).edges[edge.id]).toBeUndefined();
  });
});
