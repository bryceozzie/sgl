import { asEdgeId, asLabelId, asNodeId, NO_SPAN, type GraphEdge, type GraphNode, type SemanticGraph } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import type { LayoutResult } from '../src/contract.js';
import { quantize, validateResult } from '../src/validate.js';

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

function twoNodeGraph(edges: readonly GraphEdge[] = [], hidden = false): SemanticGraph {
  const a = node({ id: A, path: ['a'] });
  const b = node({ id: B, path: ['b'], hidden });
  return {
    nodes: { [A]: a, [B]: b } as SemanticGraph['nodes'],
    edges,
    rootChildren: [A, B],
    order: hidden ? [A] : [A, B],
    labels: {},
    meta: { nodeCount: 2, edgeCount: edges.length, containerCount: 0 },
  };
}

const OK_RESULT = (): LayoutResult => ({
  bounds: { x: 0, y: 0, w: 100, h: 50 },
  nodes: {
    [A]: { frame: { x: 0, y: 0, w: 20, h: 20 } },
    [B]: { frame: { x: 30, y: 0, w: 20, h: 20 } },
  },
  edges: {},
  labels: [],
});

describe('validateResult (DD-06 §5)', () => {
  it('a well-formed result produces no diagnostics', () => {
    expect(validateResult(OK_RESULT(), twoNodeGraph(), 'sgl.grid')).toEqual([]);
  });

  it('SGL4002: a missing NodeLayout for a visible node', () => {
    const result = OK_RESULT();
    const { [B]: _drop, ...rest } = result.nodes;
    void _drop;
    const diags = validateResult({ ...result, nodes: rest }, twoNodeGraph(), 'sgl.grid');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('SGL4002');
  });

  it('a hidden node needs no NodeLayout', () => {
    const result = OK_RESULT();
    const { [B]: _drop, ...rest } = result.nodes;
    void _drop;
    expect(validateResult({ ...result, nodes: rest }, twoNodeGraph([], true), 'sgl.grid')).toEqual([]);
  });

  it('SGL4002: NaN in a frame', () => {
    const result = OK_RESULT();
    const bad = { ...result, nodes: { ...result.nodes, [A]: { frame: { x: NaN, y: 0, w: 20, h: 20 } } } };
    const diags = validateResult(bad, twoNodeGraph(), 'sgl.grid');
    expect(diags.some((d) => d.code === 'SGL4002')).toBe(true);
  });

  it('SGL4002: a negative frame size', () => {
    const result = OK_RESULT();
    const bad = { ...result, nodes: { ...result.nodes, [A]: { frame: { x: 0, y: 0, w: -1, h: 20 } } } };
    const diags = validateResult(bad, twoNodeGraph(), 'sgl.grid');
    expect(diags.some((d) => d.code === 'SGL4002')).toBe(true);
  });

  it('SGL4002: LayoutResult references a node unknown to the graph', () => {
    const result = OK_RESULT();
    const bad = { ...result, nodes: { ...result.nodes, [asNodeId('ghost')]: { frame: { x: 0, y: 0, w: 1, h: 1 } } } };
    const diags = validateResult(bad, twoNodeGraph(), 'sgl.grid');
    expect(diags.some((d) => d.code === 'SGL4002')).toBe(true);
  });

  it('SGL4002: a missing EdgeLayout for a visible edge', () => {
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
    const diags = validateResult(OK_RESULT(), twoNodeGraph([edge]), 'sgl.grid');
    expect(diags.some((d) => d.code === 'SGL4002')).toBe(true);
  });

  it('a hidden edge needs no EdgeLayout', () => {
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
    expect(validateResult(OK_RESULT(), twoNodeGraph([edge]), 'sgl.grid')).toEqual([]);
  });

  it('SGL4002: a LabelPlacement referencing an unknown label', () => {
    const result = { ...OK_RESULT(), labels: [{ labelId: asLabelId('l:ghost'), frame: { x: 0, y: 0, w: 1, h: 1 }, align: 'middle' as const, baseline: 'middle' as const }] };
    const diags = validateResult(result, twoNodeGraph(), 'sgl.grid');
    expect(diags.some((d) => d.code === 'SGL4002')).toBe(true);
  });

  it('SGL4003: a container contentFrame outside its own frame', () => {
    const container = node({ id: A, path: ['a'], children: [B] });
    const graph: SemanticGraph = {
      nodes: { [A]: container, [B]: node({ id: B, path: ['a', 'b'], parent: A, depth: 1 }) } as SemanticGraph['nodes'],
      edges: [],
      rootChildren: [A],
      order: [A, B],
      labels: {},
      meta: { nodeCount: 2, edgeCount: 0, containerCount: 1 },
    };
    const result: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: {
        [A]: { frame: { x: 0, y: 0, w: 50, h: 50 }, contentFrame: { x: -10, y: 0, w: 50, h: 50 } },
        [B]: { frame: { x: 0, y: 0, w: 10, h: 10 } },
      },
      edges: {},
      labels: [],
    };
    const diags = validateResult(result, graph, 'sgl.grid');
    expect(diags.some((d) => d.code === 'SGL4003')).toBe(true);
    // It is a warning, not rejected outright, and the result is not corrected
    // in place (see validate.ts's deviation note).
    expect(diags.find((d) => d.code === 'SGL4003')!.severity).toBe('warning');
  });
});

describe('quantize (ADR-0004)', () => {
  it('rounds to the nearest 1/places grid', () => {
    const result: LayoutResult = {
      bounds: { x: 0.0001, y: 0, w: 10, h: 10 },
      nodes: { [A]: { frame: { x: 1 / 3, y: 0, w: 10, h: 10 } } },
      edges: {
        [asEdgeId('e')]: {
          start: { x: 1 / 3, y: 0 },
          end: { x: 2 / 3, y: 1 },
          route: [{ t: 'L', to: { x: 2 / 3, y: 1 } }],
          clip: 'none',
        },
      },
      labels: [{ labelId: asLabelId('l:a'), frame: { x: 1 / 3, y: 0, w: 1, h: 1 }, align: 'middle', baseline: 'middle' }],
    };
    const q = quantize(result, 64);
    for (const v of [q.nodes[A]!.frame.x, q.bounds.x, q.edges[asEdgeId('e')]!.start.x, q.labels[0]!.frame.x]) {
      expect(v * 64).toBeCloseTo(Math.round(v * 64), 9);
    }
  });

  it('is idempotent — quantizing twice gives the same result as once', () => {
    const result: LayoutResult = {
      bounds: { x: 1 / 7, y: 0, w: 10, h: 10 },
      nodes: { [A]: { frame: { x: 1 / 7, y: 2 / 7, w: 10, h: 10 } } },
      edges: {},
      labels: [],
    };
    const once = quantize(result, 64);
    const twice = quantize(once, 64);
    expect(twice).toEqual(once);
  });
});
