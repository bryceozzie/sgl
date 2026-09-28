import { readFileSync } from 'node:fs';
import { asNodeId, type NodeId, type Point, type Rect } from '@sgl/core';
import { DEFAULT_ENGINE_TIMEOUT_MS, validateResult, type EdgeLayout, type LayoutContext, type LayoutInput, type LayoutResult } from '@sgl/layout-api';
import { conformanceContext, runHostSequence, siblingOverlaps } from '@sgl/layout-api/conformance';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { layoutInputFor, layoutInputForSource, METRICS } from '../../layout-elk/test/corpus-input.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { RADIAL_ENGINE_ID, radialDescriptor } from '../src/descriptor.js';
import { liftArcs, spanningForest, visibleChildren } from '../src/forest.js';
import { radialEngine } from '../src/lazy.js';
import { normalizeRadialOptions } from '../src/radial.js';

/**
 * `radial` (DD-12 §9, B5 branch 5): a wedge layout (Eades) over the spanning
 * forest of each container's children (§7), each tree's root at its disc's
 * centre, ring `k` for depth `k`, wedges in proportion to the leaves' sizes,
 * rings as small as fits; a forest's discs in a row; straight edges and
 * labels by the host; its own trigonometry, so `bitwise`.
 */

const ctx = (options: Readonly<Record<string, unknown>> = {}): LayoutContext => conformanceContext(options, METRICS);
const raw = (input: LayoutInput, options: Readonly<Record<string, unknown>> = {}): Promise<LayoutResult> => radialEngine.layout(input, ctx(options));
const n = (id: string): NodeId => asNodeId(id);
const frame = (r: LayoutResult, id: string): Rect => r.nodes[n(id)]!.frame;
const cx = (f: Rect): number => f.x + f.w / 2;
const cy = (f: Rect): number => f.y + f.h / 2;
const dist = (a: Rect, b: Rect): number => Math.hypot(cx(a) - cx(b), cy(a) - cy(b));
/** The clockwise angle from 12 o'clock of `b`'s centre around `a`'s, in turns [0, 1). */
const turnOf = (a: Rect, b: Rect): number => {
  const t = Math.atan2(cx(b) - cx(a), cy(a) - cy(b)) / (2 * Math.PI);
  return t < 0 ? t + 1 : t;
};

/** The tree documents the corpus holds, which `radial` also lays out. */
const TREE_DOCS = listCorpusDocs().filter((d) => d.startsWith('layout/tree-'));

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A random tree of `count` nodes with labels of 1–12 characters, and each node's depth. */
function randomTree(seed: number, count: number): { source: string; depth: Map<string, number> } {
  const next = lcg(seed);
  const lines: string[] = [];
  const depth = new Map<string, number>([['n0', 0]]);
  for (let i = 0; i < count; i += 1) {
    lines.push(`n${i}: "${'W'.repeat(1 + Math.floor(next() * 12))}"`);
    if (i > 0) {
      const p = `n${Math.floor(next() * i)}`;
      depth.set(`n${i}`, depth.get(p)! + 1);
      lines.push(`${p} -> n${i}`);
    }
  }
  return { source: `${lines.join('\n')}\n`, depth };
}

describe('radial: the descriptor (DD-12 N47)', () => {
  it('is radialEngine without layout()', () => {
    const { layout, ...rest } = radialEngine;
    expect(typeof layout).toBe('function');
    expect(rest).toEqual(radialDescriptor);
    expect('layout' in radialDescriptor).toBe(false);
  });

  it('declares the id, name, capabilities and schemas DD-12 gives', () => {
    expect(RADIAL_ENGINE_ID).toBe('sgl.radial');
    expect(radialDescriptor).toEqual({
      id: 'sgl.radial',
      name: 'Radial',
      version: '0.0.0',
      apiVersion: 1,
      capabilities: { containers: true, edgeRouting: 'straight', ports: false, labelPlacement: false, incremental: false, determinism: 'bitwise' },
      optionsSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodeSpacing: { type: 'number', minimum: 0, default: 40 },
          rankSpacing: { type: 'number', minimum: 0, default: 70 },
        },
      },
      hintsSchema: { type: 'object', properties: { root: { type: 'boolean' } } },
    });
    // N47: 5 000 ms, which covers loading the lazy chunk on a slow device.
    expect(DEFAULT_ENGINE_TIMEOUT_MS['sgl.radial']).toBe(5_000);
  });

  it('normalises an untrusted options bag field by field', () => {
    expect(normalizeRadialOptions({})).toEqual({ nodeSpacing: 40, rankSpacing: 70 });
    expect(normalizeRadialOptions({ nodeSpacing: 0, rankSpacing: 12.5, direction: 'up' })).toEqual({ nodeSpacing: 0, rankSpacing: 12.5 });
    expect(normalizeRadialOptions({ nodeSpacing: -1, rankSpacing: Number.NaN })).toEqual({ nodeSpacing: 40, rankSpacing: 70 });
    expect(normalizeRadialOptions({ nodeSpacing: '9', rankSpacing: Number.POSITIVE_INFINITY })).toEqual({ nodeSpacing: 40, rankSpacing: 70 });
  });

  it('uses no implementation-approximated Math function (H8, ADR-0004)', () => {
    for (const file of ['radial.ts', 'trig.ts', 'forest.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b|\*\*/);
      expect(source, file).not.toMatch(/\brandom\b/);
    }
  });
});

describe('radial: the wedge layout (N41, N42)', () => {
  it('puts the root at the centre and its children on one ring, from 12 o’clock, clockwise', async () => {
    const r = await raw(layoutInputForSource('r: "Root"\na: "X"\nb: "X"\nc: "X"\nd: "X"\nr -> a\nr -> b\nr -> c\nr -> d\n'));
    const root = frame(r, 'r');
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => frame(r, id));
    // Equal leaves split the circle equally, each at its wedge's middle.
    expect([a, b, c, d].map((f) => turnOf(root, f!))).toEqual([0.125, 0.375, 0.625, 0.875].map((t) => expect.closeTo(t, 12)));
    const radius = dist(root, a!);
    for (const f of [b, c, d]) expect(dist(root, f!)).toBeCloseTo(radius, 9);
  });

  it('puts an only child straight below its parent (the wedge [0, 1)’s middle, half a turn)', async () => {
    const r = await raw(layoutInputForSource('p: "Parent"\nc: "Child"\np -> c\n'));
    expect(cx(frame(r, 'c'))).toBeCloseTo(cx(frame(r, 'p')), 9);
    expect(frame(r, 'c').y).toBeGreaterThan(frame(r, 'p').y + frame(r, 'p').h);
  });

  it('gives a heavier subtree a wider wedge, in proportion to its leaves’ diagonals plus nodeSpacing', async () => {
    const r = await raw(layoutInputForSource('r: "R"\na: "A"\nb: "B"\nb1: "B1"\nb2: "B2"\nb3: "B3"\nr -> a\nr -> b\nb -> b1\nb -> b2\nb -> b3\n'));
    const root = frame(r, 'r');
    const leafWeight = (id: string): number => Math.hypot(frame(r, id).w, frame(r, id).h) + 40;
    const wa = leafWeight('a');
    const wb = leafWeight('b1') + leafWeight('b2') + leafWeight('b3');
    // a's wedge is [0, wa / (wa + wb)), so a sits at its middle.
    expect(turnOf(root, frame(r, 'a'))).toBeCloseTo(wa / (wa + wb) / 2, 9);
    expect(turnOf(root, frame(r, 'b'))).toBeCloseTo(wa / (wa + wb) + wb / (wa + wb) / 2, 9);
  });

  it('holds on random trees: radii grow with depth, rings a ring gap apart, no two nodes overlap', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { source, depth } = randomTree(seed, 60);
      const input = layoutInputForSource(source);
      for (const options of [{}, { nodeSpacing: 5, rankSpacing: 10 }]) {
        const r = await raw(input, options);
        const root = frame(r, 'n0');
        const byDepth = new Map<number, number[]>();
        const diag = new Map<number, number>();
        for (const [id, k] of depth) {
          byDepth.set(k, [...(byDepth.get(k) ?? []), dist(root, frame(r, id))]);
          diag.set(k, Math.max(diag.get(k) ?? 0, Math.hypot(frame(r, id).w, frame(r, id).h)));
        }
        const rs = (options as { rankSpacing?: number }).rankSpacing ?? 70;
        for (let k = 1; byDepth.has(k); k += 1) {
          const radii = byDepth.get(k)!;
          // One ring per depth: every node of depth k at the same radius.
          for (const x of radii) expect(x, `seed ${seed}, depth ${k}`).toBeCloseTo(radii[0]!, 6);
          const gap = radii[0]! - byDepth.get(k - 1)![0]!;
          expect(gap, `seed ${seed}, depth ${k}`).toBeGreaterThanOrEqual((diag.get(k - 1)! + diag.get(k)!) / 2 + rs - 1e-6);
        }
        expect(siblingOverlaps(input.graph, r), `seed ${seed}`).toEqual([]);
      }
    }
  });

  it('keeps each node inside its own wedge: a ring’s nodes, clockwise, in BFS order, bounding circles nodeSpacing apart', async () => {
    const { source, depth } = randomTree(11, 80);
    const input = layoutInputForSource(source);
    const r = await raw(input);
    const root = frame(r, 'n0');
    const ids = [...depth.keys()];
    for (const ring of new Set(depth.values())) {
      if (ring === 0) continue;
      const on = ids.filter((id) => depth.get(id) === ring).sort((p, q) => turnOf(root, frame(r, p)) - turnOf(root, frame(r, q)));
      for (let i = 0; i < on.length; i += 1) {
        const p = frame(r, on[i]!);
        const q = frame(r, on[(i + 1) % on.length]!);
        if (on.length === 1) continue;
        // Bounding circles of neighbours on a ring do not touch.
        expect(dist(p, q) + 1e-6, `${on[i]} / ${on[(i + 1) % on.length]}`).toBeGreaterThanOrEqual((Math.hypot(p.w, p.h) + Math.hypot(q.w, q.h)) / 2 + 40);
      }
    }
  });

  it('honours @order among siblings, as tree does (N29)', async () => {
    const r = await raw(layoutInputFor('layout/tree-order.sgl'));
    const head = frame(r, 'head');
    const turns = ['third', 'second', 'first', 'last'].map((id) => turnOf(head, frame(r, id)));
    expect([...turns].sort((p, q) => p - q)).toEqual(turns);
  });

  it('breaks a cycle as tree does, and places every node', async () => {
    const input = layoutInputFor('layout/tree-cycle.sgl');
    const r = await raw(input);
    // `a` is the root (the first in declaration order), at the disc's centre.
    const a = frame(r, 'a');
    expect(dist(a, frame(r, 'b'))).toBeLessThan(dist(a, frame(r, 'c')));
    expect(dist(a, frame(r, 'c'))).toBeCloseTo(dist(a, frame(r, 'd')), 9);
    expect(siblingOverlaps(input.graph, r)).toEqual([]);
  });

  it('starts the content box at (0, 0)', async () => {
    for (const doc of TREE_DOCS) {
      const r = await raw(layoutInputFor(doc));
      const frames = Object.values(r.nodes).map((l) => l.frame);
      expect(Math.min(...frames.map((f) => f.x)), doc).toBe(0);
      expect(Math.min(...frames.map((f) => f.y)), doc).toBe(0);
      expect(r.bounds.x).toBe(0);
      expect(r.bounds.w).toBe(Math.max(...frames.map((f) => f.x + f.w)));
      expect(r.bounds.h).toBe(Math.max(...frames.map((f) => f.y + f.h)));
    }
  });

  it('ring spacing and node spacing widen the layout', async () => {
    const input = layoutInputForSource('r: "R"\na: "A"\nb: "B"\nr -> a\nr -> b\nlone: "Lone"\n');
    const base = await raw(input);
    const wider = await raw(input, { rankSpacing: 170 });
    expect(dist(frame(wider, 'r'), frame(wider, 'a'))).toBeCloseTo(dist(frame(base, 'r'), frame(base, 'a')) + 100, 9);
    const apart = await raw(input, { nodeSpacing: 90 });
    const gap = (res: LayoutResult) => frame(res, 'lone').x - Math.max(...['r', 'a', 'b'].map((id) => frame(res, id).x + frame(res, id).w));
    expect(gap(base)).toBeCloseTo(40, 9);
    expect(gap(apart)).toBeCloseTo(90, 9);
  });
});

describe('radial: forests, roots and containers (N43, N45, N27)', () => {
  it('packs a forest’s discs in a row, in their roots’ declaration order, top-aligned, nodeSpacing apart', async () => {
    const r = await raw(layoutInputFor('layout/tree-forest.sgl'));
    const discs = [['ceo', 'cto', 'cfo', 'dev', 'ops'], ['board', 'audit'], ['lone']];
    const box = (ids: string[]) => ({
      x0: Math.min(...ids.map((id) => frame(r, id).x)),
      x1: Math.max(...ids.map((id) => frame(r, id).x + frame(r, id).w)),
      y0: Math.min(...ids.map((id) => frame(r, id).y)),
    });
    const boxes = discs.map(box);
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.x0 - boxes[i - 1]!.x1, discs[i]![0]).toBeCloseTo(40, 9);
    expect(boxes.map((b) => b.y0)).toEqual([0, 0, 0]);
    // Each root at its own disc's centre.
    expect(dist(frame(r, 'ceo'), frame(r, 'cto'))).toBeCloseTo(dist(frame(r, 'ceo'), frame(r, 'cfo')), 9);
    expect(cx(frame(r, 'audit'))).toBeCloseTo(cx(frame(r, 'board')), 9);
  });

  it('a @layout.root hint makes a root, whose disc keeps declaration order among the discs', async () => {
    const r = await raw(layoutInputFor('layout/tree-root.sgl'));
    const api = frame(r, 'api');
    expect(dist(api, frame(r, 'auth'))).toBeCloseTo(dist(api, frame(r, 'db')), 9);
    // `client` reaches nothing new: a disc of its own, first, as it is declared first.
    expect(frame(r, 'client').x).toBe(0);
    expect(frame(r, 'client').x + frame(r, 'client').w + 40).toBeCloseTo(Math.min(...['api', 'auth', 'db'].map((id) => frame(r, id).x)), 9);
  });

  it('lays out a container’s children as a disc inside its content box, and the container as one node of its parent’s rings', async () => {
    const input = layoutInputFor('layout/tree-direction.sgl');
    const r = await raw(input);
    // Validated as the host validates it, after its routing: no SGL4003.
    expect(validateResult((await runHostSequence(radialEngine, input, {}, METRICS)).result, input.graph, RADIAL_ENGINE_ID)).toEqual([]);
    expect(siblingOverlaps(input.graph, r)).toEqual([]);
    // hq -> sales.emea is lifted to hq -> sales: hq is the root, sales and ops on its ring.
    const hq = frame(r, 'hq');
    expect(dist(hq, frame(r, 'sales'))).toBeCloseTo(dist(hq, frame(r, 'ops')), 9);
    // Inside sales: lead at the centre of its disc, emea and amer on its ring.
    const lead = frame(r, 'sales.lead');
    expect(dist(lead, frame(r, 'sales.emea'))).toBeCloseTo(dist(lead, frame(r, 'sales.amer')), 9);
    const sales = r.nodes[n('sales')]!;
    expect(sales.contentFrame).toBeDefined();
    for (const id of ['sales.lead', 'sales.emea', 'sales.amer', 'sales.emea.uk', 'sales.emea.de']) {
      const f = frame(r, id);
      expect(f.x).toBeGreaterThanOrEqual(sales.contentFrame!.x);
      expect(f.y).toBeGreaterThanOrEqual(sales.contentFrame!.y);
      expect(f.x + f.w).toBeLessThanOrEqual(sales.contentFrame!.x + sales.contentFrame!.w + 1e-9);
      expect(f.y + f.h).toBeLessThanOrEqual(sales.contentFrame!.y + sales.contentFrame!.h + 1e-9);
    }
  });

  it('a container is at least as wide as its title plus the content insets', async () => {
    const input = layoutInputForSource('box: {\n  @label: "A container with a long title indeed"\n  a: "A"\n}\n');
    const r = await raw(input);
    const title = input.labelSizes[input.graph.nodes[n('box')]!.labelId!]!;
    const inset = input.sizing[n('box')]!.contentInset;
    expect(frame(r, 'box').w).toBeGreaterThanOrEqual(title.w + inset[1] + inset[3]);
  });

  it('lays out a scope: the container at (0, 0), its children inside', async () => {
    const input = { ...layoutInputFor('layout/tree-direction.sgl'), scope: n('ops') };
    const r = await raw(input);
    expect(frame(r, 'ops')).toMatchObject({ x: 0, y: 0 });
    expect(Object.keys(r.nodes).sort()).toEqual(['ops', 'ops.chief', 'ops.hr', 'ops.it']);
    await expect(raw({ ...input, scope: n('nope') })).rejects.toThrow('radial: unknown scope');
  });
});

describe('radial: edges and labels are the host’s (N46)', () => {
  it('returns no edge or label; the host routes every edge straight and places the labels', async () => {
    const input = layoutInputFor('layout/tree-cycle.sgl');
    const { raw: engine, result } = await runHostSequence(radialEngine, input, {}, METRICS);
    expect(engine.edges).toEqual({});
    expect(engine.labels).toEqual([]);
    const visible = input.graph.edges.filter((e) => !e.hidden);
    expect(Object.keys(result.edges).sort()).toEqual(visible.map((e) => e.id).sort());
    for (const e of visible) expect(result.edges[e.id]!.route, e.id).toHaveLength(1);
    expect(result.labels.length).toBeGreaterThan(0); // "second"
  });
});

describe('radial: no recursion, linear growth (N28)', () => {
  it('lays out a 2 000-node path and a 2 000-node star', async () => {
    const path = ['n0: "0"'];
    const star = ['hub: "Hub"'];
    for (let i = 1; i < 2000; i += 1) {
      path.push(`n${i}: "${i}"`, `n${i - 1} -> n${i}`);
      star.push(`s${i}: "${i}"`, `hub -> s${i}`);
    }
    for (const lines of [path, star]) {
      const input = layoutInputForSource(`${lines.join('\n')}\n`);
      const { result } = await runHostSequence(radialEngine, input, {}, METRICS);
      expect(validateResult(result, input.graph, RADIAL_ENGINE_ID)).toEqual([]);
      expect(Object.keys(result.nodes)).toHaveLength(2000);
    }
  }, 60_000);
});

describe('radial over the corpus (DD-12 §12)', () => {
  for (const doc of listCorpusDocs()) {
    it(`${doc}: bitwise-identical across two runs, raw and quantized (N44)`, async () => {
      const input = layoutInputFor(doc);
      const a = await runHostSequence(radialEngine, input, {}, METRICS);
      const b = await runHostSequence(radialEngine, input, {}, METRICS);
      expect(JSON.stringify(b.raw)).toBe(JSON.stringify(a.raw));
      expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
      expect(validateResult(a.result, input.graph, radialEngine.id)).toEqual([]);
    });
  }

  for (const doc of [...CLEAN_DOCS, ...TREE_DOCS]) {
    it(`${doc}: layout golden`, async () => {
      const { result } = await runHostSequence(radialEngine, layoutInputFor(doc), {}, METRICS);
      await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/radial/${doc}.json`);
    });
  }
});

/** Whether segment `pq` passes through the inside of `f` (shrunk by 1 px):
 *  Liang–Barsky, as `tree.test.ts` counts it. */
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

function runsOf(e: EdgeLayout): [Point, Point][] {
  const out: [Point, Point][] = [];
  let at = e.start;
  for (const s of e.route) {
    if (s.t === 'L') out.push([at, s.to]);
    at = s.to;
  }
  return out;
}

/** The ids of the edges that draw a tree arc: between two siblings, the
 *  second the first's child in the level's spanning forest. */
function treeArcEdges(input: LayoutInput): Set<string> {
  const graph = input.graph;
  const out = new Set<string>();
  const arcs = liftArcs(graph);
  for (const level of [null, ...graph.order]) {
    const kids = visibleChildren(level, graph);
    if (kids.length === 0) continue;
    const forest = spanningForest(kids, arcs.get(level) ?? [], graph);
    for (const e of graph.edges) {
      if (forest.parent.get(e.to.node) === e.from.node && kids.includes(e.from.node)) out.add(e.id);
    }
  }
  return out;
}

/** Edge runs through a leaf that is neither end, split into tree-arc spokes
 *  and every other edge. */
function throughLeaves(input: LayoutInput, result: LayoutResult): { spokes: string[]; others: string[] } {
  const graph = input.graph;
  const tree = treeArcEdges(input);
  const leaves = graph.order.filter((id) => result.nodes[id] !== undefined && !graph.nodes[id]!.children.some((c) => result.nodes[c] !== undefined));
  const out = { spokes: [] as string[], others: [] as string[] };
  for (const e of graph.edges) {
    const layout = result.edges[e.id];
    if (layout === undefined) continue;
    for (const [p, q] of runsOf(layout)) {
      for (const leaf of leaves) {
        if (leaf === e.from.node || leaf === e.to.node || !crossesFrame(p, q, result.nodes[leaf]!.frame)) continue;
        (tree.has(e.id) ? out.spokes : out.others).push(`${e.from.node}->${e.to.node} through ${leaf}`);
      }
    }
  }
  return out;
}

describe('radial, fix round 1', () => {
  it('item 1: a zero-weight subtree (a zero-size leaf at nodeSpacing 0) lays out finite and valid', async () => {
    const input = layoutInputForSource('r: "R"\na: "A"\nb: "B"\nz: { @size: { width: 0, height: 0 } }\nr -> a\nr -> b\na -> z\n');
    expect(input.sizing[n('z')]!.fixed).toEqual({ w: 0, h: 0 });
    const { raw: engine, result } = await runHostSequence(radialEngine, input, { nodeSpacing: 0 }, METRICS);
    for (const l of Object.values(engine.nodes)) for (const v of Object.values(l.frame)) expect(Number.isFinite(v)).toBe(true);
    expect(validateResult(result, input.graph, RADIAL_ENGINE_ID)).toEqual([]);
  });

  it('item 1 (M11): zero-size leaves at nodeSpacing 0 get distinct angles', async () => {
    const leaf = (id: string) => `${id}: { @size: { width: 0, height: 0 } }\n`;
    const input = layoutInputForSource(`r: "R"\n${leaf('p')}${leaf('q')}${leaf('s')}r -> p\nr -> q\nr -> s\n`);
    const r = await raw(input, { nodeSpacing: 0 });
    const root = frame(r, 'r');
    const turns = ['p', 'q', 's'].map((id) => turnOf(root, frame(r, id)));
    expect(new Set(turns.map((t) => t.toFixed(9))).size).toBe(3);
    expect(turns).toEqual([1 / 6, 1 / 2, 5 / 6].map((t) => expect.closeTo(t, 9)));
  });

  it('item 2: a node’s children lie within a quarter turn either side of its own angle (the root keeps the whole turn)', async () => {
    const lines = ['r: "R"', 'c: "C"', 'r -> c'];
    for (let i = 0; i < 12; i += 1) lines.push(`g${i}: "G${i}"`, `c -> g${i}`);
    const r = await raw(layoutInputForSource(`${lines.join('\n')}\n`));
    const root = frame(r, 'r');
    const own = turnOf(root, frame(r, 'c'));
    for (let i = 0; i < 12; i += 1) {
      const t = turnOf(root, frame(r, `g${i}`));
      const off = Math.abs(((t - own + 1.5) % 1) - 0.5);
      expect(off, `g${i}`).toBeLessThanOrEqual(0.25 + 1e-12);
    }
  });

  it('item 2: no tree-arc spoke passes through a node (a chain into a fan, and a fan below an only child)', async () => {
    const fan = ['r: "R"', 'c: "C"', 'r -> c'];
    for (let i = 0; i < 12; i += 1) fan.push(`g${i}: "G${i}"`, `c -> g${i}`);
    const chain = ['a: "A"', 'b: "B"', 'c: "C"', 'a -> b', 'b -> c'];
    for (let i = 0; i < 10; i += 1) chain.push(`f${i}: "F${i}"`, `c -> f${i}`);
    for (const lines of [fan, chain]) {
      const input = layoutInputForSource(`${lines.join('\n')}\n`);
      const { result } = await runHostSequence(radialEngine, input, {}, METRICS);
      const through = throughLeaves(input, result);
      expect(through.spokes, lines[0]).toEqual([]);
      expect(through.others).toEqual([]);
    }
  });

  /** Non-tree edges (a broken cycle arc, a second parent) are the host's
   *  straight chords and can cross a node, as under `tree` (07 §2.1 F34):
   *  pinned, to go only down. Tree-arc spokes: none. */
  const PINNED_OTHERS: Record<string, number> = {
    'layout/tree-cycle.sgl': 0,
    'layout/tree-diamond.sgl': 2, // right -> bottom (a second parent) through top and left
    'layout/tree-direction.sgl': 0,
    'layout/tree-forest.sgl': 0,
    'layout/tree-order.sgl': 0,
    'layout/tree-root.sgl': 1, // client -> api (api is a root by its hint) through db
  };
  it('item 2: pins every tree fixture', () => {
    expect(Object.keys(PINNED_OTHERS).sort()).toEqual([...TREE_DOCS].sort());
  });
  for (const doc of TREE_DOCS) {
    it(`item 2: ${doc}: no tree-arc spoke through a node; other edges at most as pinned`, async () => {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(radialEngine, input, {}, METRICS);
      const through = throughLeaves(input, result);
      expect(through.spokes).toEqual([]);
      expect(through.others.length, through.others.join('; ')).toBeLessThanOrEqual(PINNED_OTHERS[doc] ?? 0);
    });
  }

  it('item 2: no tree-arc spoke through a node over the corpus and random trees (a probe; reported)', async () => {
    const found: string[] = [];
    const inputs = listCorpusDocs().map((doc) => [doc, layoutInputFor(doc)] as const);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) inputs.push([`random ${seed}`, layoutInputForSource(randomTree(seed, 60).source)]);
    for (const [name, input] of inputs) {
      const { result } = await runHostSequence(radialEngine, input, {}, METRICS);
      for (const x of throughLeaves(input, result).spokes) found.push(`${name}: ${x}`);
    }
    console.warn(`[radial] tree-arc spokes through a node: ${found.length}${found.length > 0 ? ` (${found.slice(0, 5).join('; ')})` : ''}`);
    expect(found).toEqual([]);
  }, 60_000);

  it('item 6: the ring gap is at least 2 × arrowSize + 8 at rankSpacing 0 and nodeSpacing 0, so every spoke has room for its arrowhead', async () => {
    const input = layoutInputForSource('r: "R"\na: "A"\nb: "B"\nc: "C"\nr -> a\nr -> b\na -> c\n');
    const { raw: engine, result } = await runHostSequence(radialEngine, input, { nodeSpacing: 0, rankSpacing: 0 }, METRICS);
    const root = frame(engine, 'r');
    const floor = 2 * METRICS.arrowSize + 8;
    const diag = (id: string) => Math.hypot(frame(engine, id).w, frame(engine, id).h);
    const r1 = dist(root, frame(engine, 'a'));
    const r2 = dist(root, frame(engine, 'c'));
    expect(r1 - (diag('r') + Math.max(diag('a'), diag('b'))) / 2).toBeGreaterThanOrEqual(floor - 1e-9);
    expect(r2 - r1 - (Math.max(diag('a'), diag('b')) + diag('c')) / 2).toBeGreaterThanOrEqual(floor - 1e-9);
    for (const e of input.graph.edges) {
      const l = result.edges[e.id]!;
      expect(Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y), e.id).toBeGreaterThan(METRICS.arrowSize);
    }
  });

  it('item 7: wedges follow the leaves’ sizes, not their count', async () => {
    const r = await raw(layoutInputForSource('r: "R"\na: "A label much wider than the others are"\nb: "B"\nb1: "x"\nb2: "y"\nr -> a\nr -> b\nb -> b1\nb -> b2\n'));
    const root = frame(r, 'r');
    const w = (id: string): number => Math.hypot(frame(r, id).w, frame(r, id).h) + 40;
    const wa = w('a');
    const wb = w('b1') + w('b2');
    expect(wa).toBeGreaterThan(wb / 2 + 50); // the sizes differ enough for a count to be wrong
    expect(turnOf(root, frame(r, 'a'))).toBeCloseTo(wa / (wa + wb) / 2, 9);
    expect(Math.abs(turnOf(root, frame(r, 'a')) - 1 / 6)).toBeGreaterThan(0.01); // by count: 1/6
  });

  it('item 8: the defaults are the descriptor’s, read from its schema, not repeated', () => {
    const props = (radialDescriptor.optionsSchema as { properties: Record<string, { default: number }> }).properties;
    const was = [props['nodeSpacing']!.default, props['rankSpacing']!.default] as const;
    try {
      props['nodeSpacing']!.default = 33;
      props['rankSpacing']!.default = 77;
      expect(normalizeRadialOptions({})).toEqual({ nodeSpacing: 33, rankSpacing: 77 });
      expect(normalizeRadialOptions({ nodeSpacing: -1, rankSpacing: 5 })).toEqual({ nodeSpacing: 33, rankSpacing: 5 });
    } finally {
      props['nodeSpacing']!.default = was[0];
      props['rankSpacing']!.default = was[1];
    }
    expect(normalizeRadialOptions({})).toEqual({ nodeSpacing: 40, rankSpacing: 70 });
  });
});
