import { asNodeId, type GraphEdge, type NodeId, type Point, type Rect } from '@sgl/core';
import {
  anchorPoint,
  DEFAULT_ENGINE_TIMEOUT_MS,
  validateResult,
  type EdgeLayout,
  type LayoutContext,
  type LayoutInput,
  type LayoutResult,
} from '@sgl/layout-api';
import { conformanceContext, runHostSequence, siblingOverlaps } from '@sgl/layout-api/conformance';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { layoutInputFor, layoutInputForSource, METRICS } from '../../layout-elk/test/corpus-input.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { TREE_ENGINE_ID, treeDescriptor } from '../src/descriptor.js';
import { treeEngine } from '../src/lazy.js';
import { normalizeTreeOptions } from '../src/tree.js';

/**
 * `tree` (DD-12 §8, B5 branch 4): Buchheim–Walker over the spanning forest of
 * each container's children, levels as bands, the direction applied last,
 * elbow edges for tree arcs, and the host's labels.
 */

const ctx = (options: Readonly<Record<string, unknown>> = {}): LayoutContext => conformanceContext(options, METRICS);
const raw = (input: LayoutInput, options: Readonly<Record<string, unknown>> = {}): Promise<LayoutResult> => treeEngine.layout(input, ctx(options));
const n = (id: string): NodeId => asNodeId(id);
const frame = (r: LayoutResult, id: string): Rect => r.nodes[n(id)]!.frame;
const cx = (f: Rect): number => f.x + f.w / 2;
const cy = (f: Rect): number => f.y + f.h / 2;
const edgeOf = (input: LayoutInput, from: string, to: string) => input.graph.edges.find((e) => e.from.node === from && e.to.node === to)!;

/** The tree documents the corpus holds (DD-12 §12). */
const TREE_DOCS = listCorpusDocs().filter((d) => d.startsWith('layout/tree-'));

/** A deterministic PRNG for the random-shaped fixtures (lint bans `Math.random`). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A random tree of `count` nodes, each with a random label length, so the
 *  breadths vary (N30), and its parent map. */
function randomTree(seed: number, count: number): { source: string; parent: Map<string, string> } {
  const next = lcg(seed);
  const lines: string[] = [];
  const parent = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    lines.push(`n${i}: "${'W'.repeat(1 + Math.floor(next() * 12))}"`);
    if (i > 0) {
      const p = `n${Math.floor(next() * i)}`;
      parent.set(`n${i}`, p);
      lines.push(`${p} -> n${i}`);
    }
  }
  return { source: `${lines.join('\n')}\n`, parent };
}

describe('tree: the descriptor (DD-12 N37, N39)', () => {
  it('is treeEngine without layout()', () => {
    const { layout, ...rest } = treeEngine;
    expect(typeof layout).toBe('function');
    expect(rest).toEqual(treeDescriptor);
    expect('layout' in treeDescriptor).toBe(false);
  });

  it('declares the id, name, capabilities and schemas DD-12 gives', () => {
    expect(TREE_ENGINE_ID).toBe('sgl.tree');
    expect(treeDescriptor).toEqual({
      id: 'sgl.tree',
      name: 'Tree',
      version: '0.0.0',
      apiVersion: 1,
      capabilities: { containers: true, edgeRouting: 'orthogonal', ports: false, labelPlacement: false, incremental: false, determinism: 'bitwise' },
      optionsSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], default: 'down' },
          nodeSpacing: { type: 'number', minimum: 0, default: 40 },
          rankSpacing: { type: 'number', minimum: 0, default: 70 },
          edgeRouting: { type: 'string', enum: ['orthogonal', 'straight'], default: 'orthogonal' },
        },
      },
      hintsSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] }, root: { type: 'boolean' } } },
    });
    // N37: 5 000 ms, which covers loading the lazy chunk on a slow device.
    expect(DEFAULT_ENGINE_TIMEOUT_MS['sgl.tree']).toBe(5_000);
  });

  it('normalises an untrusted options bag field by field', () => {
    expect(normalizeTreeOptions({})).toEqual({ direction: 'down', nodeSpacing: 40, rankSpacing: 70, edgeRouting: 'orthogonal' });
    expect(normalizeTreeOptions({ direction: 'left', nodeSpacing: 0, rankSpacing: 12.5, edgeRouting: 'straight' })).toEqual({
      direction: 'left',
      nodeSpacing: 0,
      rankSpacing: 12.5,
      edgeRouting: 'straight',
    });
    expect(normalizeTreeOptions({ direction: 'sideways', nodeSpacing: -1, rankSpacing: Number.NaN, edgeRouting: 'SPLINES' })).toEqual({
      direction: 'down',
      nodeSpacing: 40,
      rankSpacing: 70,
      edgeRouting: 'orthogonal',
    });
  });
});

describe('tree: the tidy-tree invariants (N30, N31)', () => {
  it('puts a parent above its children, centred over them, and siblings nodeSpacing apart', async () => {
    const r = await raw(layoutInputForSource('r: "Root"\na: "A"\nb: "Bee"\nc: "C"\nr -> a\nr -> b\nr -> c\n'));
    const [a, b, c, root] = ['a', 'b', 'c', 'r'].map((id) => frame(r, id));
    expect(cx(root!)).toBe((cx(a!) + cx(c!)) / 2);
    expect(b!.x - (a!.x + a!.w)).toBe(40);
    expect(c!.x - (b!.x + b!.w)).toBe(40);
    // One band per level, rankSpacing apart; each node centred in its band.
    expect(a!.y - (root!.y + root!.h)).toBe(70);
    expect(cy(a!)).toBe(cy(b!));
  });

  it('holds on random trees: siblings’ subtrees apart, parents centred, bands in order', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { source, parent } = randomTree(seed, 60);
      const input = layoutInputForSource(source);
      const r = await raw(input);
      // No two nodes of one band overlap, and neighbours are nodeSpacing apart.
      const byBand = new Map<number, Rect[]>();
      for (const id of input.graph.order) {
        const f = frame(r, id);
        const band = byBand.get(cy(f)) ?? [];
        band.push(f);
        byBand.set(cy(f), band);
      }
      for (const band of byBand.values()) {
        band.sort((p, q) => p.x - q.x);
        for (let i = 1; i < band.length; i += 1) expect(band[i]!.x - (band[i - 1]!.x + band[i - 1]!.w), `seed ${seed}`).toBeGreaterThanOrEqual(40 - 1e-9);
      }
      // A parent is centred over its first and last child, one band up.
      const kids = new Map<string, string[]>();
      for (const [child, p] of parent) kids.set(p, [...(kids.get(p) ?? []), child]);
      for (const [p, list] of kids) {
        const xs = list.map((k) => cx(frame(r, k)));
        expect(cx(frame(r, p)), `seed ${seed}, ${p}`).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 9);
        for (const k of list) expect(frame(r, k).y, `seed ${seed}, ${k}`).toBeGreaterThan(frame(r, p).y + frame(r, p).h);
      }
      expect(siblingOverlaps(input.graph, r)).toEqual([]);
    }
  });

  it('draws identical subtrees identically', async () => {
    const sub = (p: string) => `${p}: "P"\n${p}1: "Long label"\n${p}2: "S"\n${p}3: "Medium"\n${p} -> ${p}1\n${p} -> ${p}2\n${p}1 -> ${p}3\n`;
    const r = await raw(layoutInputForSource(`r: "R"\n${sub('a')}${sub('b')}r -> a\nr -> b\n`));
    for (const k of ['1', '2', '3']) {
      expect(frame(r, `a${k}`).x - frame(r, 'a').x).toBeCloseTo(frame(r, `b${k}`).x - frame(r, 'b').x, 9);
      expect(frame(r, `a${k}`).y).toBe(frame(r, `b${k}`).y);
    }
  });

  it('sets a forest’s trees side by side, in their roots’ order, nodeSpacing apart where their contours are closest', async () => {
    const r = await raw(layoutInputFor('layout/tree-forest.sgl'));
    const TREES = [['ceo', 'cto', 'cfo', 'dev', 'ops'], ['board', 'audit'], ['lone']];
    // Per band (one y centre per level), the gap between neighbouring trees.
    const gaps = (left: string[], right: string[]): number[] => {
      const out: number[] = [];
      for (const band of new Set([...left, ...right].map((id) => cy(frame(r, id))))) {
        const l = left.filter((id) => cy(frame(r, id)) === band);
        const rr = right.filter((id) => cy(frame(r, id)) === band);
        if (l.length === 0 || rr.length === 0) continue;
        out.push(Math.min(...rr.map((id) => frame(r, id).x)) - Math.max(...l.map((id) => frame(r, id).x + frame(r, id).w)));
      }
      return out;
    };
    for (let i = 1; i < TREES.length; i += 1) {
      const g = gaps(TREES[i - 1]!, TREES[i]!);
      expect(Math.min(...g), TREES[i]![0]).toBe(40);
    }
    expect([frame(r, 'ceo').y, frame(r, 'board').y, frame(r, 'lone').y]).toEqual([0, 0, 0]);
    expect(frame(r, 'ceo').x).toBeLessThan(frame(r, 'board').x);
    expect(frame(r, 'board').x).toBeLessThan(frame(r, 'lone').x);
  });

  it('starts the content box at (0, 0)', async () => {
    for (const direction of ['down', 'up', 'left', 'right']) {
      const r = await raw(layoutInputFor('layout/tree-forest.sgl'), { direction });
      const frames = Object.values(r.nodes).map((l) => l.frame);
      expect(Math.min(...frames.map((f) => f.x)), direction).toBe(0);
      expect(Math.min(...frames.map((f) => f.y)), direction).toBe(0);
    }
  });
});

/**
 * A plain recursive Buchheim, Jünger and Leipert (2002), for breadths that
 * vary, as the paper writes it: the reference `tree.ts`'s explicit-stack
 * version must agree with (fix round 1, item 4). Returns each node's centre.
 */
function referenceBuchheim(children: readonly (readonly number[])[], breadth: readonly number[], spacing: number): number[] {
  const n = children.length;
  const parent = new Array<number>(n).fill(-1);
  const number = new Array<number>(n).fill(0);
  for (let v = 0; v < n; v += 1) children[v]!.forEach((c, i) => ((parent[c] = v), (number[c] = i)));
  const prelim = new Array<number>(n).fill(0);
  const mod = new Array<number>(n).fill(0);
  const shift = new Array<number>(n).fill(0);
  const change = new Array<number>(n).fill(0);
  const thread = new Array<number>(n).fill(-1);
  const ancestor = Array.from({ length: n }, (_, v) => v);
  const sep = (a: number, b: number) => (breadth[a]! + breadth[b]!) / 2 + spacing;
  const leftSibling = (v: number) => (parent[v]! < 0 || number[v] === 0 ? -1 : children[parent[v]!]![number[v]! - 1]!);
  const nextLeft = (v: number) => (children[v]!.length > 0 ? children[v]![0]! : thread[v]!);
  const nextRight = (v: number) => (children[v]!.length > 0 ? children[v]![children[v]!.length - 1]! : thread[v]!);
  const moveSubtree = (wl: number, wr: number, s: number) => {
    const subtrees = number[wr]! - number[wl]!;
    change[wr]! -= s / subtrees;
    shift[wr]! += s;
    change[wl]! += s / subtrees;
    prelim[wr]! += s;
    mod[wr]! += s;
  };
  const apportion = (v: number, defaultAncestor: number): number => {
    const w = leftSibling(v);
    if (w < 0) return defaultAncestor;
    let [vir, vor, vil, vol] = [v, v, w, children[parent[v]!]![0]!];
    let [sir, sor, sil, sol] = [mod[vir]!, mod[vor]!, mod[vil]!, mod[vol]!];
    while (nextRight(vil) >= 0 && nextLeft(vir) >= 0) {
      vil = nextRight(vil);
      vir = nextLeft(vir);
      vol = nextLeft(vol);
      vor = nextRight(vor);
      ancestor[vor] = v;
      const s = prelim[vil]! + sil - (prelim[vir]! + sir) + sep(vil, vir);
      if (s > 0) {
        moveSubtree(parent[ancestor[vil]!] === parent[v] ? ancestor[vil]! : defaultAncestor, v, s);
        sir += s;
        sor += s;
      }
      sil += mod[vil]!;
      sir += mod[vir]!;
      sol += mod[vol]!;
      sor += mod[vor]!;
    }
    if (nextRight(vil) >= 0 && nextRight(vor) < 0) {
      thread[vor] = nextRight(vil);
      mod[vor]! += sil - sor;
    }
    if (nextLeft(vir) >= 0 && nextLeft(vol) < 0) {
      thread[vol] = nextLeft(vir);
      mod[vol]! += sir - sol;
      return v;
    }
    return defaultAncestor;
  };
  const firstWalk = (v: number): void => {
    const kids = children[v]!;
    const w = leftSibling(v);
    if (kids.length === 0) {
      prelim[v] = w < 0 ? 0 : prelim[w]! + sep(w, v);
      return;
    }
    let defaultAncestor = kids[0]!;
    for (const c of kids) {
      firstWalk(c);
      defaultAncestor = apportion(c, defaultAncestor);
    }
    let s = 0;
    let c = 0;
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const k = kids[i]!;
      prelim[k]! += s;
      mod[k]! += s;
      c += change[k]!;
      s += shift[k]! + c;
    }
    const mid = (prelim[kids[0]!]! + prelim[kids[kids.length - 1]!]!) / 2;
    if (w < 0) prelim[v] = mid;
    else {
      prelim[v] = prelim[w]! + sep(w, v);
      mod[v] = prelim[v]! - mid;
    }
  };
  const x = new Array<number>(n).fill(0);
  const secondWalk = (v: number, m: number): void => {
    x[v] = prelim[v]! + m;
    for (const c of children[v]!) secondWalk(c, m + mod[v]!);
  };
  firstWalk(0);
  secondWalk(0, 0);
  return x;
}

describe('tree: Buchheim–Walker against a plain recursive reference (fix round 1, item 4)', () => {
  /** A random tree whose labels range from one character to fifty, so
   *  neighbouring subtrees differ strongly in breadth and the shifts are
   *  spread over the subtrees between (`moveSubtree`'s `change`). */
  function mixedTree(seed: number, count: number): { source: string; kids: number[][] } {
    const next = lcg(seed);
    const lines: string[] = [];
    const kids: number[][] = [];
    for (let i = 0; i < count; i += 1) {
      kids.push([]);
      const len = next() < 0.3 ? 30 + Math.floor(next() * 20) : 1 + Math.floor(next() * 3);
      lines.push(`n${i}: "${'W'.repeat(len)}"`);
      if (i > 0) {
        // Bias parents towards the recent nodes: deep trees with bushy levels.
        const p = Math.max(0, i - 1 - Math.floor(next() * Math.min(i, 6)));
        kids[p]!.push(i);
        lines.push(`n${p} -> n${i}`);
      }
    }
    return { source: `${lines.join('\n')}\n`, kids };
  }

  it('places every node where the reference does, on random trees with mixed widths', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { source, kids } = mixedTree(seed, 40);
      const r = await raw(layoutInputForSource(source));
      const centres = kids.map((_, i) => cx(frame(r, `n${i}`)));
      const want = referenceBuchheim(
        kids,
        kids.map((_, i) => frame(r, `n${i}`).w),
        40,
      );
      for (let i = 0; i < kids.length; i += 1) expect(centres[i]! - centres[0]!, `seed ${seed}, n${i}`).toBeCloseTo(want[i]! - want[0]!, 6);
    }
  });

  it('the reference spreads a shift over the subtrees between (the case the check needs)', () => {
    // r's children: a wide subtree, two small leaves, then a wide subtree
    // whose contour pushes against the first: the leaves between are spaced
    // evenly by `change`, not left against the first subtree.
    const kids = [[1, 4, 5, 6], [2, 3], [], [], [], [], [7, 8], [], []];
    const breadth = [10, 10, 60, 60, 10, 10, 10, 60, 60];
    const x = referenceBuchheim(kids, breadth, 10);
    expect(x[5]! - x[4]!).toBeCloseTo(x[6]! - x[5]!, 9);
    expect(x[4]! - x[1]!).toBeCloseTo(x[5]! - x[4]!, 9);
  });
});

describe('tree: the direction (N32, N38)', () => {
  const source = 'r: "Root"\na: "A"\nb: "B"\nr -> a\nr -> b\n';
  const at = async (direction: string) => {
    const r = await raw(layoutInputForSource(source), { direction });
    return { r: frame(r, 'r'), a: frame(r, 'a'), b: frame(r, 'b') };
  };

  it('down: children below; up: above; right: to the right; left: to the left', async () => {
    const down = await at('down');
    expect(down.a.y).toBeGreaterThan(down.r.y + down.r.h);
    expect(down.a.x).toBeLessThan(down.b.x);
    const up = await at('up');
    expect(up.a.y + up.a.h).toBeLessThan(up.r.y);
    expect(up.a.x).toBeLessThan(up.b.x);
    const right = await at('right');
    expect(right.a.x).toBeGreaterThan(right.r.x + right.r.w);
    expect(right.a.y).toBeLessThan(right.b.y);
    const left = await at('left');
    expect(left.a.x + left.a.w).toBeLessThan(left.r.x);
    expect(left.a.y).toBeLessThan(left.b.y);
  });

  it('flips exactly: up mirrors down, and left mirrors right, across the depth axis', async () => {
    const [down, up, right, left] = await Promise.all(['down', 'up', 'right', 'left'].map(at));
    const depth = (f: { r: Rect; a: Rect }) => f.a.y + f.a.h; // the whole depth, rank 1 being the last band
    for (const k of ['r', 'a', 'b'] as const) {
      expect(up![k].x).toBe(down![k].x);
      expect(up![k].y).toBe(depth(down!) - down![k].y - down![k].h);
      expect(left![k].y).toBe(right![k].y);
      expect(left![k].x).toBe(right!.a.x + right!.a.w - right![k].x - right![k].w);
    }
  });

  it('applies a container’s @direction to its subtree; a nested container inherits it', async () => {
    const input = layoutInputFor('layout/tree-direction.sgl');
    const r = await raw(input);
    // Root: down (the option). `sales`: right, and `emea` inherits it. `ops`: up.
    expect(frame(r, 'sales').y).toBeGreaterThan(frame(r, 'hq').y + frame(r, 'hq').h);
    expect(frame(r, 'sales.emea').x).toBeGreaterThan(frame(r, 'sales.lead').x + frame(r, 'sales.lead').w);
    expect(frame(r, 'sales.emea.de').x).toBeGreaterThan(frame(r, 'sales.emea.uk').x + frame(r, 'sales.emea.uk').w);
    expect(frame(r, 'ops.it').y + frame(r, 'ops.it').h).toBeLessThan(frame(r, 'ops.chief').y);
  });
});

describe('tree: containers are nested trees (N24)', () => {
  it('lays a container’s children out in its content box, and sizes it from them plus padding', async () => {
    const input = layoutInputForSource('box: {\n  @label: "Box"\n  a: "A"\n  b: "B"\n  a -> b\n}\n');
    const r = await raw(input);
    const box = r.nodes[n('box')]!;
    const [t, right, bottom, l] = input.sizing[n('box')]!.padding;
    expect(box.contentFrame).toEqual({ x: box.frame.x + l, y: box.frame.y + t, w: box.frame.w - l - right, h: box.frame.h - t - bottom });
    expect(frame(r, 'box.a').x).toBe(box.frame.x + l);
    expect(frame(r, 'box.a').y).toBe(box.frame.y + t);
    expect(box.frame.h).toBe(t + frame(r, 'box.b').y + frame(r, 'box.b').h - frame(r, 'box.a').y + bottom);
  });

  it('is at least as wide as its title plus its content insets', async () => {
    const input = layoutInputForSource('box: {\n  @label: "A very long container title indeed"\n  a: "A"\n}\n');
    const r = await raw(input);
    const title = input.labelSizes[input.graph.nodes[n('box')]!.labelId!]!;
    const inset = input.sizing[n('box')]!.contentInset;
    expect(frame(r, 'box').w).toBe(title.w + inset[1] + inset[3]);
  });

  it('lifts an edge into a container to the container itself (N25)', async () => {
    const r = await raw(layoutInputForSource('hq: "HQ"\nteam: {\n  a: "A"\n}\nhq -> team.a\n'));
    expect(frame(r, 'team').y).toBeGreaterThan(frame(r, 'hq').y + frame(r, 'hq').h);
  });

  it('treats a container whose children are all hidden as a leaf', async () => {
    const r = await raw(layoutInputForSource('box: {\n  @label: "Box"\n  a: { @hidden: true }\n}\n'));
    expect(r.nodes[n('box')]!.contentFrame).toBeUndefined();
    expect(r.nodes[n('box.a')]).toBeUndefined();
  });
});

describe('tree: elbows (N34)', () => {
  const SHAPES = ['rect', 'round', 'circle', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'package', 'note', 'document'];

  it('routes a tree arc from the parent’s outline, across the gap’s middle, to the child’s outline, on every shape', async () => {
    for (const shape of SHAPES) {
      const input = layoutInputForSource(`p: { @label: "Parent", @shape: ${shape} }\na: { @label: "A", @shape: ${shape} }\nb: { @label: "Bee bee", @shape: ${shape} }\np -> a\np -> b\n`);
      const r = await raw(input);
      const p = frame(r, 'p');
      const b = frame(r, 'b');
      const e = r.edges[edgeOf(input, 'p', 'b').id]!;
      // Both ends on the outline, on the centre line: anchorPoint's own answer.
      expect(e.start, shape).toEqual(anchorPoint(input.graph.nodes[n('p')]!.shape, p, { x: cx(p), y: cy(p) + 1 }));
      expect(e.end, shape).toEqual(anchorPoint(input.graph.nodes[n('b')]!.shape, b, { x: cx(b), y: cy(b) - 1 }));
      expect(e.start.x, shape).toBe(cx(p));
      expect(e.start.y, shape).toBeCloseTo(p.y + p.h, 9);
      expect(e.end.x, shape).toBe(cx(b));
      expect(e.end.y, shape).toBeCloseTo(b.y, 9);
      const mid = p.y + p.h + 35; // the middle of the 70 px gap between the bands
      expect(e.route.map((s) => (s.t === 'L' ? [s.to.x, s.to.y] : null)), shape).toEqual([
        [cx(p), mid],
        [cx(b), mid],
        [e.end.x, e.end.y],
      ]);
      expect(e.endNormal).toEqual({ x: 0, y: 1 });
    }
  });

  it('drops the zero-length run of a child straight below its parent', async () => {
    const input = layoutInputForSource('p: "Parent"\nc: "Child"\np -> c\n');
    const r = await raw(input);
    const e = r.edges[edgeOf(input, 'p', 'c').id]!;
    expect(e.route).toHaveLength(2);
    for (const seg of e.route) expect(seg.t === 'L' && seg.to.x === e.start.x).toBe(true);
  });

  it('turns with the direction: right runs across, then down or up, then across', async () => {
    const input = layoutInputForSource('p: "Parent"\na: "A"\nb: "B"\np -> a\np -> b\n');
    const r = await raw(input, { direction: 'right' });
    const p = frame(r, 'p');
    const b = frame(r, 'b');
    const e = r.edges[edgeOf(input, 'p', 'b').id]!;
    expect([e.start.x, e.start.y]).toEqual([p.x + p.w, cy(p)]);
    expect([e.end.x, e.end.y]).toEqual([b.x, cy(b)]);
    const mid = p.x + p.w + 35;
    expect(e.route.map((s) => (s.t === 'L' ? [s.to.x, s.to.y] : null))).toEqual([
      [mid, cy(p)],
      [mid, cy(b)],
      [b.x, cy(b)],
    ]);
  });

  it('leaves every other edge to the host: a second parent, a cycle’s back arc, a lifted edge, a self-loop', async () => {
    const input = layoutInputForSource('t: "T"\nl: "L"\nr: "R"\nb: "B"\nbox: {\n  x: "X"\n}\nt -> l\nt -> r\nl -> b\nr -> b\nb -> t\nt -> box.x\nb -> b\n');
    const r = await raw(input);
    const routed = input.graph.edges.filter((e) => r.edges[e.id] !== undefined).map((e) => `${e.from.node}->${e.to.node}`);
    expect(routed.sort()).toEqual(['l->b', 't->l', 't->r']);
    // The host fills the rest, straight (DD-06 §3), and every edge is attached.
    const { result } = await runHostSequence(treeEngine, input, {}, METRICS);
    expect(Object.keys(result.edges)).toHaveLength(input.graph.edges.length);
  });

  it('gives the centre lines to the first edge between the arc’s own two nodes, and the next one an elbow beside it (fix round 1)', async () => {
    const input = layoutInputForSource('p: "P"\nc: "C"\np -> c\np -> c: "again"\n');
    const r = await raw(input);
    const [first, second] = input.graph.edges.map((e) => r.edges[e.id]!);
    expect(first!.start.x).toBe(cx(frame(r, 'p')));
    expect(second!.start.x).toBe(cx(frame(r, 'p')) + 8);
    expect(second!.end.x).toBe(cx(frame(r, 'c')) + 8);
  });

  it('edgeRouting: straight turns the elbows off', async () => {
    const r = await raw(layoutInputFor('layout/tree-diamond.sgl'), { edgeRouting: 'straight' });
    expect(r.edges).toEqual({});
  });

  it('puts an edge label on the elbow’s horizontal run, by the host (N35)', async () => {
    const input = layoutInputForSource('p: "Parent"\na: "A"\nb: "B"\np -> a\np -> b: "label"\n');
    const { result } = await runHostSequence(treeEngine, input, {}, METRICS);
    const edge = edgeOf(input, 'p', 'b');
    const label = result.labels.find((l) => l.labelId === edge.labelId)!;
    const route = result.edges[edge.id]!.route.map((s) => (s.t === 'L' ? s.to : ({} as Point)));
    // The run across the gap is at route[0].y; the label sits beside it.
    expect(route[0]!.y).toBe(route[1]!.y);
    expect(Math.abs(label.frame.y + label.frame.h / 2 - route[0]!.y)).toBeLessThan(label.frame.h + 8);
    expect(label.frame.x + label.frame.w / 2).toBeGreaterThan(Math.min(route[0]!.x, route[1]!.x));
    expect(label.frame.x + label.frame.w / 2).toBeLessThan(Math.max(route[0]!.x, route[1]!.x));
  });
});

/** An edge's straight runs, `start` then each `L` segment's end (a curve —
 *  the host's self-loop teardrop — breaks the chain and is skipped). */
function runs(e: EdgeLayout): [Point, Point][] {
  const out: [Point, Point][] = [];
  let at = e.start;
  for (const s of e.route) {
    if (s.t === 'L') out.push([at, s.to]);
    at = s.to;
  }
  return out;
}

/** How long two segments run along one line together (0 if they are not
 *  collinear). */
function sharedRun([a, b]: [Point, Point], [c, d]: [Point, Point]): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return 0;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const off = (p: Point) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
  if (off(c) > 1e-6 || off(d) > 1e-6) return 0;
  const t = (p: Point) => (p.x - a.x) * ux + (p.y - a.y) * uy;
  const [c0, c1] = [t(c), t(d)].sort((p, q) => p - q) as [number, number];
  return Math.min(len, c1) - Math.max(0, c0);
}

const pairOf = (e: GraphEdge): string => [e.from.node, e.to.node].sort().join(' ');

/** Every pair of edges whose routes share a collinear run over 2 px, except
 *  two elbows of different arcs: they meet at the parent they share, whose
 *  trunk the org chart draws once by design (N34). */
function collinearPairs(input: LayoutInput, result: LayoutResult, raw: LayoutResult): string[] {
  const out: string[] = [];
  const edges = input.graph.edges.filter((e) => result.edges[e.id] !== undefined);
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const [p, q] = [edges[i]!, edges[j]!];
      // Two elbows of different arcs meet only at the parent they share.
      const trunk = raw.edges[p.id] !== undefined && raw.edges[q.id] !== undefined && pairOf(p) !== pairOf(q);
      if (trunk) continue;
      let worst = 0;
      for (const s of runs(result.edges[p.id]!)) for (const t of runs(result.edges[q.id]!)) worst = Math.max(worst, sharedRun(s, t));
      if (worst > 2) out.push(`${p.from.node}->${p.to.node} / ${q.from.node}->${q.to.node} (${worst.toFixed(1)} px)`);
    }
  }
  return out;
}

describe('tree: every edge between an arc’s two nodes gets its own elbow (fix round 1, item 1)', () => {
  const PAIRS = [
    'a: "A"\nb: "B"\na -> b\na -> b\n',
    'a: "A"\nb: "B"\na -> b\nb -> a\n',
    'a: "A"\nb: "B"\na -> b\na -> b: "again"\nb -> a\nb -> a\na -- b\n',
    'p: "Parent"\nx: "X"\nc: "Child"\np -> x\np -> c\np -> c\nc -> p\nc -> p: "back"\n',
    'p: { @label: "P", @shape: ellipse }\nc: { @label: "C", @shape: diamond }\nd: "D"\np -> c\np -> d\nc -> p\np -> c\nd -> p\n',
  ];

  for (const direction of ['down', 'up', 'left', 'right']) {
    it(`${direction}: no two routes share a collinear run over 2 px (tree fixtures and parallel/back edges)`, async () => {
      const inputs = [...TREE_DOCS.map((d) => ({ name: d, input: layoutInputFor(d) })), ...PAIRS.map((src, i) => ({ name: `pair ${i}`, input: layoutInputForSource(src) }))];
      for (const { name, input } of inputs) {
        const { raw: engine, result } = await runHostSequence(treeEngine, input, { direction }, METRICS);
        expect(collinearPairs(input, result, engine), name).toEqual([]);
      }
    });
  }

  it('routes the parallel and back edges of a pair itself, each an orthogonal elbow leaving and entering along the depth axis', async () => {
    const input = layoutInputForSource(PAIRS[2]!);
    const r = await raw(input);
    for (const e of input.graph.edges) {
      const layout = r.edges[e.id];
      expect(layout, `${e.from.node}->${e.to.node}`).toBeDefined();
      for (const [p, q] of runs(layout!)) expect(p.x === q.x || p.y === q.y).toBe(true);
      const back = e.from.node === 'b';
      const plain = (v: Point | undefined) => ({ x: v!.x + 0, y: v!.y + 0 }); // -0 is +0 here
      expect(plain(layout!.endNormal)).toEqual({ x: 0, y: back ? -1 : 1 });
      expect(plain(layout!.startNormal)).toEqual({ x: 0, y: back ? 1 : -1 });
    }
  });

  it('is deterministic: the same offsets on every run, in graph order', async () => {
    const input = layoutInputForSource(PAIRS[3]!);
    expect(JSON.stringify(await raw(input))).toBe(JSON.stringify(await raw(input)));
  });
});

/** Whether segment `pq` passes through the inside of `f` (shrunk by 1 px, so
 *  a route along or ending on an outline does not count): Liang–Barsky. */
function crossesFrame(p: Point, q: Point, f: Rect): boolean {
  const [x0, y0, x1, y1] = [f.x + 1, f.y + 1, f.x + f.w - 1, f.y + f.h - 1];
  if (x1 <= x0 || y1 <= y0) return false;
  let lo = 0;
  let hi = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [den, num] of [
    [-dx, p.x - x0],
    [dx, x1 - p.x],
    [-dy, p.y - y0],
    [dy, y1 - p.y],
  ] as const) {
    if (den === 0) {
      if (num <= 0) return false;
    } else {
      const t = num / den;
      if (den < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
    }
  }
  return hi - lo > 1e-9;
}

/** Edge runs through a leaf that is neither of the edge's ends, counted per
 *  run and leaf. */
function throughLeaves(input: LayoutInput, result: LayoutResult): string[] {
  const out: string[] = [];
  const leaves = input.graph.order.filter((id) => result.nodes[id] !== undefined && !input.graph.nodes[id]!.children.some((c) => result.nodes[c] !== undefined));
  for (const e of input.graph.edges) {
    const layout = result.edges[e.id];
    if (layout === undefined) continue;
    for (const [p, q] of runs(layout)) {
      for (const leaf of leaves) if (leaf !== e.from.node && leaf !== e.to.node && crossesFrame(p, q, result.nodes[leaf]!.frame)) out.push(`${e.from.node}->${e.to.node} through ${leaf}`);
    }
  }
  return out;
}

describe('tree: non-tree edges through unrelated nodes (fix round 1, item 2; DD-12 §8.2, a known limitation)', () => {
  /** Today's count per fixture, under the default options. The host routes
   *  a broken cycle arc or a skip-level edge straight (no obstacle routing
   *  yet: 07 §2.1 F34), so it can pass through a node. A pin may only go
   *  down: lower it when a change removes a crossing. */
  const PINNED: Record<string, number> = {
    'layout/tree-cycle.sgl': 1, // c -> a through B
    'layout/tree-diamond.sgl': 0,
    'layout/tree-direction.sgl': 0,
    'layout/tree-forest.sgl': 0,
    'layout/tree-order.sgl': 0,
    'layout/tree-root.sgl': 0,
  };

  it('pins every tree fixture', () => {
    expect(Object.keys(PINNED).sort()).toEqual([...TREE_DOCS].sort());
  });

  for (const doc of TREE_DOCS) {
    it(`${doc}: at most the pinned number of edge runs through a leaf that is not their end`, async () => {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(treeEngine, input, {}, METRICS);
      const through = throughLeaves(input, result);
      expect(through.length, through.join('; ')).toBeLessThanOrEqual(PINNED[doc] ?? 0);
    });
  }

  it('counts a broken cycle arc drawn straight through the node between', async () => {
    const input = layoutInputForSource('a: "A"\nb: "B"\nc: "C"\na -> b\nb -> c\nc -> a\n');
    const { result } = await runHostSequence(treeEngine, input, {}, METRICS);
    expect(throughLeaves(input, result)).toEqual(['c->a through b']);
  });
});

describe('tree: rankSpacing 0 keeps the elbow (fix round 1, item 6)', () => {
  for (const direction of ['down', 'up', 'left', 'right']) {
    it(`${direction}: the first and last runs follow the depth axis, and the arrowhead does too`, async () => {
      const input = layoutInputForSource('p: "Parent"\na: "A"\nb: "Bee bee bee"\nc: "C"\np -> a\np -> b\np -> c\nb -> p\n');
      const { raw: engine, result } = await runHostSequence(treeEngine, input, { direction, rankSpacing: 0 }, METRICS);
      for (const e of input.graph.edges) {
        for (const layout of [engine.edges[e.id]!, result.edges[e.id]!]) {
          const r = runs(layout);
          expect(r.length, `${e.from.node}->${e.to.node}`).toBeGreaterThan(0);
          const dir = ([p, q]: [Point, Point]) => {
            const len = Math.hypot(q.x - p.x, q.y - p.y);
            return { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
          };
          const last = dir(r[r.length - 1]!);
          expect(last.x, `${direction} ${e.from.node}->${e.to.node}`).toBeCloseTo(layout.endNormal!.x, 9);
          expect(last.y, `${direction} ${e.from.node}->${e.to.node}`).toBeCloseTo(layout.endNormal!.y, 9);
          const first = dir(r[0]!);
          expect(first.x).toBeCloseTo(-layout.startNormal!.x, 9);
          expect(first.y).toBeCloseTo(-layout.startNormal!.y, 9);
          for (const [p, q] of r) expect(p.x === q.x || p.y === q.y, `${direction} ${e.from.node}->${e.to.node}`).toBe(true);
        }
      }
    });
  }
});

describe('tree: forest order and hints (N27, N29)', () => {
  it('@order: siblings left to right as the fixture says', async () => {
    const r = await raw(layoutInputFor('layout/tree-order.sgl'));
    const xs = ['third', 'second', 'first', 'last'].map((id) => frame(r, id).x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('@layout.root: the hinted node is the first root, at the top', async () => {
    const r = await raw(layoutInputFor('layout/tree-root.sgl'));
    expect(frame(r, 'api').y).toBe(0);
    expect(frame(r, 'client').y).toBe(0);
    expect(frame(r, 'api').x).toBeLessThan(frame(r, 'client').x);
    expect(frame(r, 'auth').y).toBeGreaterThan(0);
  });
});

describe('tree: explicit stacks, linear time (N28, N30)', () => {
  it('lays out a 2 000-node path and a 2 000-node star', async () => {
    const path = ['n0: "N"'];
    for (let i = 1; i < 2000; i += 1) path.push(`n${i}: "N"`, `n${i - 1} -> n${i}`);
    const p = await raw(layoutInputForSource(`${path.join('\n')}\n`));
    expect(frame(p, 'n1999').y).toBeGreaterThan(frame(p, 'n1998').y);
    expect(frame(p, 'n1999').x).toBe(frame(p, 'n0').x);

    const star = ['hub: "Hub"'];
    for (let i = 0; i < 2000; i += 1) star.push(`s${i}: "S"`, `hub -> s${i}`);
    const s = await raw(layoutInputForSource(`${star.join('\n')}\n`));
    expect(frame(s, 's1999').x).toBeGreaterThan(frame(s, 's0').x);
  });

  it('grows linearly: a star 4× larger takes well under 16× as long (best of five)', async () => {
    const starOf = (count: number) => {
      const lines = ['hub: "Hub"'];
      for (let i = 0; i < count; i += 1) lines.push(`s${i}: "S"`, `hub -> s${i}`, `s${i}c: "C"`, `s${i} -> s${i}c`);
      return layoutInputForSource(`${lines.join('\n')}\n`);
    };
    const small = starOf(500);
    const large = starOf(2000);
    const best = async (input: LayoutInput) => {
      let min = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i += 1) {
        const t0 = performance.now();
        await raw(input);
        min = Math.min(min, performance.now() - t0);
      }
      return min;
    };
    await best(large); // warm the chunk and the JIT on both sizes
    await best(small);
    const ratio = (await best(large)) / Math.max(await best(small), 0.5);
    // Linear is 4×; Walker's naive apportion would be quadratic, 16×.
    expect(ratio).toBeLessThan(10);
  }, 60_000);
});

describe('tree over the corpus (DD-12 §12)', () => {
  it('holds the tree documents this suite assumes', () => {
    expect(TREE_DOCS).toEqual(
      expect.arrayContaining([
        'layout/tree-forest.sgl',
        'layout/tree-cycle.sgl',
        'layout/tree-diamond.sgl',
        'layout/tree-order.sgl',
        'layout/tree-direction.sgl',
        'layout/tree-root.sgl',
      ]),
    );
  });

  for (const doc of listCorpusDocs()) {
    it(`${doc}: bitwise-identical across two runs, raw and quantized (N33)`, async () => {
      const input = layoutInputFor(doc);
      const a = await runHostSequence(treeEngine, input, {}, METRICS);
      const b = await runHostSequence(treeEngine, input, {}, METRICS);
      expect(JSON.stringify(b.raw)).toBe(JSON.stringify(a.raw));
      expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
      expect(validateResult(a.result, input.graph, treeEngine.id)).toEqual([]);
    });
  }

  for (const doc of [...CLEAN_DOCS, ...TREE_DOCS]) {
    it(`${doc}: layout golden`, async () => {
      const { result } = await runHostSequence(treeEngine, layoutInputFor(doc), {}, METRICS);
      await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/tree/${doc}.json`);
    });
  }
});
