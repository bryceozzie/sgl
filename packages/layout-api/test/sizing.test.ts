import {
  asLabelId,
  asNodeId,
  NO_SPAN,
  type GraphNode,
  type LabelSpec,
  type SemanticGraph,
} from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { buildLayoutInput, type GeometryStyle, type StyledGraphInput } from '../src/sizing.js';

const A = asNodeId('a');
const C = asNodeId('c');
const LA = asLabelId('l:a');
const LC = asLabelId('l:c');

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

function label(id: string, ownerId: string, kind: 'node' | 'edge'): LabelSpec {
  return {
    id: asLabelId(id),
    owner: { kind, id: asNodeId(ownerId) } as LabelSpec['owner'],
    role: 'title',
    runs: [{ text: ownerId }],
  };
}

function graphOf(nodes: Readonly<Record<string, GraphNode>>, order: readonly string[], rootChildren: readonly string[]): SemanticGraph {
  return {
    nodes: nodes as SemanticGraph['nodes'],
    edges: [],
    rootChildren: rootChildren.map(asNodeId),
    order: order.map(asNodeId),
    labels: {
      [LA]: label(LA, 'a', 'node'),
      [LC]: label(LC, 'c', 'node'),
    },
    meta: { nodeCount: order.length, edgeCount: 0, containerCount: 1 },
  };
}

describe('buildLayoutInput (DD-06 §2)', () => {
  it('sizes a leaf: intrinsic = label + padding + shape content insets', () => {
    const leaf = node({ id: A, path: ['a'], labelId: LA, shape: 'rect' });
    const graph = graphOf({ a: leaf }, ['a'], ['a']);
    const styled: StyledGraphInput = {
      graph,
      styles: { a: { geometry: { padding: [4, 8, 4, 8] } } as GeometryStyle },
    };
    const input = buildLayoutInput(styled, { [LA]: { w: 40, h: 10 } });

    const sizing = input.sizing[A]!;
    expect(sizing.intrinsic).toEqual({ w: 40 + 8 + 8, h: 10 + 4 + 4 });
    expect(sizing.contentInset).toEqual([4, 8, 4, 8]);
    // A leaf never gets a title band, so `padding` and `contentInset` agree.
    expect(sizing.padding).toEqual(sizing.contentInset);
  });

  it('adds a title band to a container, but only to `padding`, not `contentInset`', () => {
    const leaf = node({ id: A, path: ['c', 'a'], parent: C, depth: 1, labelId: LA });
    const container = node({
      id: C,
      path: ['c'],
      children: [A],
      labelId: LC,
      shape: 'rect',
    });
    const graph = graphOf({ a: leaf, c: container }, ['c', 'a'], ['c']);
    const styled: StyledGraphInput = {
      graph,
      styles: {
        a: { geometry: { padding: [0, 0, 0, 0] } } as GeometryStyle,
        c: { geometry: { padding: [10, 10, 10, 10], titleGap: 6 } } as GeometryStyle,
      },
    };
    const input = buildLayoutInput(styled, { [LA]: { w: 20, h: 8 }, [LC]: { w: 30, h: 12 } });

    const sizing = input.sizing[C]!;
    expect(sizing.contentInset).toEqual([10, 10, 10, 10]);
    // padding.top = contentInset.top + labelHeight + titleGap = 10 + 12 + 6 = 28.
    expect(sizing.padding).toEqual([28, 10, 10, 10]);
  });

  it('reads min/max/fixed/aspectRatio straight from the geometry bag when present', () => {
    const leaf = node({ id: A, labelId: null });
    const graph = graphOf({ a: leaf }, ['a'], ['a']);
    const styled: StyledGraphInput = {
      graph,
      styles: { a: { geometry: { minWidth: 72, minHeight: 36, aspectRatio: 1 } } as GeometryStyle },
    };
    const input = buildLayoutInput(styled, {});
    const sizing = input.sizing[A]!;
    expect(sizing.min).toEqual({ w: 72, h: 36 });
    expect(sizing.max).toBeUndefined();
    expect(sizing.fixed).toBeUndefined();
    expect(sizing.aspectRatio).toBe(1);
  });

  it('a node with no label and no style entry still gets a well-formed, zero-ish sizing', () => {
    const leaf = node({ id: A });
    const graph = graphOf({ a: leaf }, ['a'], ['a']);
    const input = buildLayoutInput({ graph, styles: {} }, {});
    expect(input.sizing[A]).toEqual({ intrinsic: { w: 0, h: 0 }, contentInset: [0, 0, 0, 0], padding: [0, 0, 0, 0] });
  });
});
