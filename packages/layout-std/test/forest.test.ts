import { asNodeId, type NodeId, type SemanticGraph } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { layoutInputForSource } from '../../layout-elk/test/corpus-input.js';
import { liftArcs, spanningForest, type Forest } from '../src/forest.js';

/**
 * The spanning forest `tree` and `radial` share (DD-12 §7, N24–N29): edges
 * lifted to the children of each container, then a BFS from the roots, in
 * order, that breaks cycles and second parents the same way on every run.
 */

const graphOf = (source: string): SemanticGraph => layoutInputForSource(source).graph;
const n = (id: string): NodeId => asNodeId(id);

/** The forest of one level: `null` for the root. */
function forestOf(source: string, level: string | null = null): Forest {
  const graph = graphOf(source);
  const kids = (level === null ? graph.rootChildren : graph.nodes[n(level)]!.children).filter((id) => !graph.nodes[id]!.hidden);
  return spanningForest(kids, liftArcs(graph).get(level === null ? null : n(level)) ?? [], graph);
}

/** Each node's tree children, by id, and the roots: a readable picture. */
function shape(f: Forest): { roots: string[]; children: Record<string, string[]> } {
  const children: Record<string, string[]> = {};
  for (const [id, kids] of f.children) if (kids.length > 0) children[id] = [...kids];
  return { roots: [...f.roots], children };
}

describe('liftArcs: the edges of one level (N25, N26)', () => {
  it('lifts an edge between descendants to the two children of the container that holds both', () => {
    const graph = graphOf('payments: {\n  api\n  db\n  api -> db\n}\npsp\npayments.api -> psp\n');
    const arcs = liftArcs(graph);
    expect(arcs.get(null)!.map((a) => [a.from, a.to])).toEqual([['payments', 'psp']]);
    expect(arcs.get(n('payments'))!.map((a) => [a.from, a.to])).toEqual([['payments.api', 'payments.db']]);
  });

  it('collapses duplicates, keeping the first in graph.edges order, and records the edge between the two nodes themselves', () => {
    const graph = graphOf('a: {\n  x\n}\nb\na.x -> b\na -> b\na -> b\n');
    const [arc, ...rest] = liftArcs(graph).get(null)!;
    expect(rest).toEqual([]);
    expect([arc!.from, arc!.to]).toEqual(['a', 'b']);
    expect(arc!.edge).toBe(graph.edges[0]);
    // The first edge whose endpoints are the arc's own two nodes (N34).
    expect(arc!.direct).toBe(graph.edges[1]);
  });

  it('keeps direction from -> to for every edge, undirected and both-ways alike (N26)', () => {
    const graph = graphOf('a\nb\nc\nb -- a\nc <-> b\n');
    expect(liftArcs(graph).get(null)!.map((a) => [a.from, a.to])).toEqual([
      ['b', 'a'],
      ['c', 'b'],
    ]);
  });

  it('skips self-loops, hidden edges, and edges between a container and its own descendant', () => {
    const graph = graphOf('a: {\n  x\n}\nb: { @hidden: true }\nc\na -> a\na -> a.x\na.x -> a\nc -> b\nc -> c\n');
    expect(liftArcs(graph).get(null) ?? []).toEqual([]);
    expect(liftArcs(graph).get(n('a')) ?? []).toEqual([]);
  });

  it('has no direct edge for an arc made only of lifted edges', () => {
    const [arc] = liftArcs(graphOf('a: {\n  x\n}\nb\na.x -> b\n')).get(null)!;
    expect(arc!.direct).toBeUndefined();
  });
});

describe('spanningForest: roots and BFS order (N27, N29)', () => {
  it('a tree: the node with no incoming arc is the root, and BFS gives each node its parent', () => {
    expect(shape(forestOf('r\na\nb\nc\nr -> a\nr -> b\na -> c\n'))).toEqual({ roots: ['r'], children: { r: ['a', 'b'], a: ['c'] } });
  });

  it('a forest: every node with no incoming arc is a root, in declaration order; an isolated node is a tree of its own', () => {
    expect(shape(forestOf('a\nb\nx\ny\nlone\na -> b\nx -> y\n'))).toEqual({ roots: ['a', 'x', 'lone'], children: { a: ['b'], x: ['y'] } });
  });

  it('a diamond DAG: the second parent loses; the first to reach a node is its parent', () => {
    const f = forestOf('top\nleft\nright\nbottom\ntop -> left\ntop -> right\nright -> bottom\nleft -> bottom\n');
    expect(shape(f)).toEqual({ roots: ['top'], children: { top: ['left', 'right'], left: ['bottom'] } });
    expect(f.parent.get(n('bottom'))).toBe('left');
  });

  it('BFS gives every node its least depth, so a shortcut beats a long path', () => {
    const f = forestOf('r\na\nb\nc\nr -> a\na -> b\nb -> c\nr -> c\n');
    expect(f.depth.get(n('c'))).toBe(1);
    expect(f.parent.get(n('c'))).toBe('r');
  });

  it('a cycle: with no node free of incoming arcs, the first in declaration order is the root', () => {
    expect(shape(forestOf('a\nb\nc\nb -> c\nc -> a\na -> b\n'))).toEqual({ roots: ['a'], children: { a: ['b'], b: ['c'] } });
  });

  it('a cycle hanging off a tree is entered from the tree, not rooted on its own', () => {
    expect(shape(forestOf('r\na\nb\nr -> a\na -> b\nb -> a\n'))).toEqual({ roots: ['r'], children: { r: ['a'], a: ['b'] } });
  });

  it('two disjoint cycles: each unreached one is rooted at its first node', () => {
    expect(shape(forestOf('a\nb\nc\nd\na -> b\nb -> a\nc -> d\nd -> c\n'))).toEqual({ roots: ['a', 'c'], children: { a: ['b'], c: ['d'] } });
  });

  it('@layout.root makes a node a root first, even with incoming arcs', () => {
    const f = forestOf('a\nb\nc\na -> b\nb -> c\nc: { @layout: { root: true } }\n');
    expect(shape(f)).toEqual({ roots: ['c', 'a'], children: { a: ['b'] } });
  });

  it('visits successors in @order ascending, then declaration order; a node without one comes after', () => {
    const source = 'r\na\nb: { @order: 2 }\nc: { @order: 1 }\nd\nr -> a\nr -> b\nr -> c\nr -> d\n';
    expect(forestOf(source).children.get(n('r'))).toEqual(['c', 'b', 'a', 'd']);
  });

  it('lays out a container’s own level from its lifted arcs', () => {
    const f = forestOf('box: {\n  a\n  b: {\n    x\n  }\n  c\n  b.x -> c\n  a -> b\n}\n', 'box');
    expect(shape(f)).toEqual({ roots: ['box.a'], children: { 'box.a': ['box.b'], 'box.b': ['box.c'] } });
  });

  it('is deterministic: the same input gives the same forest', () => {
    const source = 'a\nb\nc\nd\na -> b\nb -> c\nc -> a\nd -> b\nd -> c\n';
    expect(JSON.stringify(shape(forestOf(source)))).toBe(JSON.stringify(shape(forestOf(source))));
  });
});

describe('spanningForest: explicit stacks (N28)', () => {
  it('handles a 2 000-long path without recursion', () => {
    const lines = ['n0'];
    for (let i = 1; i < 2000; i += 1) lines.push(`n${i}`, `n${i - 1} -> n${i}`);
    const f = forestOf(`${lines.join('\n')}\n`);
    expect(f.roots).toEqual(['n0']);
    expect(f.depth.get(n('n1999'))).toBe(1999);
  });
});
