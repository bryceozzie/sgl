import { asNodeId, type NodeId, type Point, type Rect } from '@sgl/core';
import {
  anchorPoint,
  DEFAULT_ENGINE_TIMEOUT_MS,
  validateResult,
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

  it('gives the elbow to the first edge between the arc’s own two nodes, once', async () => {
    const input = layoutInputForSource('p: "P"\nc: "C"\np -> c\np -> c: "again"\n');
    const r = await raw(input);
    expect(Object.keys(r.edges)).toEqual([input.graph.edges[0]!.id]);
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
