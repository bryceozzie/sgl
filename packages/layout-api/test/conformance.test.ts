import { asEdgeId, asLabelId, asNodeId, NO_SPAN, type GraphEdge, type GraphNode, type LabelSpec, type NodeId, type SemanticGraph } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import {
  hierarchyCrossings,
  missingLabelPlacements,
  runConformance,
  siblingLeafOverlaps,
} from '../src/conformance.js';
import { LAYOUT_API_VERSION, type LayoutEngine, type LayoutInput, type LayoutResult, type ResolvedThemeMetricsView } from '../src/contract.js';

/**
 * The harness itself (DD-06 §8): each check fails when it should, and the K4
 * crossing detector finds a real crossing and ignores a related container.
 * The engines it is *for* are exercised in `layout-std/test/` and
 * `layout-elk/test/conformance.test.ts`, over the corpus.
 */

const METRICS: ResolvedThemeMetricsView = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {}, arrowSize: 8 };

function node(id: string, parent: string | null = null, children: string[] = []): GraphNode {
  return {
    id: asNodeId(id),
    path: id.split('.'),
    parent: parent === null ? null : asNodeId(parent),
    children: children.map(asNodeId),
    depth: parent === null ? 0 : 1,
    shape: 'rect',
    classes: [],
    labelId: null,
    ports: [],
    config: {},
    hidden: false,
    span: NO_SPAN,
  };
}

function edge(id: string, from: string, to: string, labelId: string | null = null): GraphEdge {
  return {
    id: asEdgeId(id),
    from: { node: asNodeId(from) },
    to: { node: asNodeId(to) },
    directed: 'none',
    classes: [],
    labelId: labelId === null ? null : asLabelId(labelId),
    config: {},
    declaredIn: null,
    hidden: false,
    span: NO_SPAN,
  };
}

/** `x`, `y` at the root; container `c` holding `c.k` between them. */
function graph(edges: GraphEdge[] = [], labels: SemanticGraph['labels'] = {}): SemanticGraph {
  const nodes = [node('x'), node('y'), node('c', null, ['c.k']), node('c.k', 'c')];
  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) as SemanticGraph['nodes'],
    edges,
    rootChildren: [asNodeId('x'), asNodeId('c'), asNodeId('y')],
    order: [asNodeId('x'), asNodeId('c'), asNodeId('c.k'), asNodeId('y')],
    labels,
    meta: { nodeCount: 4, edgeCount: edges.length, containerCount: 1 },
  };
}

const frames: Record<string, { x: number; y: number; w: number; h: number }> = {
  x: { x: 0, y: 0, w: 20, h: 20 },
  c: { x: 50, y: -20, w: 60, h: 60 },
  'c.k': { x: 60, y: 0, w: 20, h: 20 },
  y: { x: 150, y: 0, w: 20, h: 20 },
};

function layoutOf(g: SemanticGraph, routes: LayoutResult['edges'] = {}, labels: LayoutResult['labels'] = []): LayoutResult {
  const nodes: Record<NodeId, { frame: (typeof frames)[string] }> = {};
  for (const id of g.order) nodes[id] = { frame: frames[id]! };
  return { bounds: { x: -20, y: -20, w: 200, h: 80 }, nodes, edges: routes, labels };
}

describe('hierarchyCrossings (DD-06 §6.3, K4)', () => {
  it('finds a route through an unrelated container', () => {
    const g = graph([edge('xy', 'x', 'y')]);
    const straight = { start: { x: 20, y: 10 }, end: { x: 150, y: 10 }, route: [{ t: 'L' as const, to: { x: 150, y: 10 } }] };
    expect(hierarchyCrossings(g, layoutOf(g, { [asEdgeId('xy')]: straight }))).toEqual([{ edge: 'xy', container: 'c' }]);
  });

  it('ignores a container that holds an endpoint, and a route that only runs along a border', () => {
    const g = graph([edge('xk', 'x', 'c.k'), edge('xy', 'x', 'y')]);
    const into = { start: { x: 20, y: 10 }, end: { x: 60, y: 10 }, route: [{ t: 'L' as const, to: { x: 60, y: 10 } }] };
    const along = {
      start: { x: 10, y: 20 },
      end: { x: 160, y: 20 },
      route: [
        { t: 'L' as const, to: { x: 10, y: 40 } },
        { t: 'L' as const, to: { x: 160, y: 40 } },
        { t: 'L' as const, to: { x: 160, y: 20 } },
      ],
    };
    expect(hierarchyCrossings(g, layoutOf(g, { [asEdgeId('xk')]: into, [asEdgeId('xy')]: along }))).toEqual([]);
  });
});

describe('siblingLeafOverlaps and missingLabelPlacements', () => {
  it('reports overlapping sibling leaves, not a container over its child', () => {
    const g = graph();
    expect(siblingLeafOverlaps(g, layoutOf(g))).toEqual([]);
    const moved = layoutOf(g);
    const overlapping: LayoutResult = { ...moved, nodes: { ...moved.nodes, [asNodeId('y')]: { frame: { x: 10, y: 10, w: 20, h: 20 } } } };
    expect(siblingLeafOverlaps(g, overlapping)).toEqual([['x', 'y']]);
  });

  it('lists every visible label without a placement', () => {
    const id = asLabelId('l:xy');
    const spec: LabelSpec = { id, owner: { kind: 'edge', id: asEdgeId('xy') }, role: 'edge', runs: [{ text: 'q' }] };
    const g = graph([edge('xy', 'x', 'y', 'l:xy')], { [id]: spec });
    expect(missingLabelPlacements(g, layoutOf(g))).toEqual(['l:xy']);
    expect(missingLabelPlacements(g, layoutOf(g, {}, [{ labelId: id, frame: { x: 0, y: 0, w: 1, h: 1 }, align: 'middle', baseline: 'top' }]))).toEqual([]);
  });
});

describe('runConformance (DD-06 §8)', () => {
  const input = (g: SemanticGraph): LayoutInput => ({
    graph: g,
    scope: null,
    sizing: Object.fromEntries(g.order.map((id) => [id, { intrinsic: { w: 0, h: 0 }, contentInset: [0, 0, 0, 0], padding: [0, 0, 0, 0] }])),
    labelSizes: {},
  });

  function engineWith(layout: LayoutEngine['layout'], labelPlacement = false): LayoutEngine {
    return {
      id: 'test.engine',
      name: 'test',
      version: '0.0.0',
      apiVersion: LAYOUT_API_VERSION,
      capabilities: { containers: true, edgeRouting: 'straight', ports: false, labelPlacement, incremental: false, determinism: 'quantized' },
      layout,
    };
  }

  it('passes a well-behaved engine, with a crossing reported as a warning only', async () => {
    const g = graph([edge('xy', 'x', 'y')]);
    const straight = { start: { x: 20, y: 10 }, end: { x: 150, y: 10 }, route: [{ t: 'L' as const, to: { x: 150, y: 10 } }] };
    const engine = engineWith(() => Promise.resolve(layoutOf(g, { [asEdgeId('xy')]: straight })));
    const report = await runConformance(engine, [{ name: 'g', input: input(g) }], { metrics: METRICS, now: () => 0, timedCase: 'g' });
    expect(report.failures).toEqual([]);
    expect(report.crossingCounts).toEqual({ g: 1 });
    expect(report.cases[0]).toMatchObject({ deterministic: true, withinTimeout: true });
  });

  it('fails checks 1, 2, 4 and 5 when an engine breaks each', async () => {
    const id = asLabelId('l:xy');
    const spec: LabelSpec = { id, owner: { kind: 'edge', id: asEdgeId('xy') }, role: 'edge', runs: [{ text: 'q' }] };
    const g = graph([edge('xy', 'x', 'y', 'l:xy')], { [id]: spec });
    let calls = 0;
    const drifting = engineWith(() => {
      calls += 1;
      const r = layoutOf(g);
      // Missing `c.k` (check 1), a different x every run (check 2), no labels (check 5).
      const { [asNodeId('c.k')]: _gone, ...nodes } = r.nodes;
      void _gone;
      return Promise.resolve({ ...r, nodes: { ...nodes, [asNodeId('x')]: { frame: { x: calls, y: 0, w: 20, h: 20 } } } });
    }, true);
    let t = 0;
    const report = await runConformance(drifting, [{ name: 'g', input: input(g) }], {
      metrics: METRICS,
      now: () => (t += 20_000),
      timedCase: 'g',
    });
    const text = report.failures.join('\n');
    expect(text).toContain('check 1');
    expect(text).toContain('check 2');
    expect(text).toContain('check 4');
    expect(text).toContain('check 5');
  });
});
