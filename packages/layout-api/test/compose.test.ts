import {
  asEdgeId,
  asLabelId,
  asNodeId,
  type GraphEdge,
  type GraphNode,
  type LabelId,
  type LabelSpec,
  type NodeId,
  type PortId,
  type SemanticGraph,
  type Size,
} from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { composeInWorker, composeLayout, LayoutCache, layoutView, type LayoutPlan } from '../src/compose.js';
import { conformanceContext, detachedEdges, runConformance, runHostSequence } from '../src/conformance.js';
import {
  LAYOUT_API_VERSION,
  type LayoutContext,
  type LayoutEngine,
  type LayoutInput,
  type EdgeLayout,
  type LayoutResult,
  type NodeLayout,
  type NodeSizing,
  type ResolvedThemeMetricsView,
} from '../src/contract.js';
import { engineNotes } from '../src/host.js';
import { quantize } from '../src/validate.js';

/**
 * DD-14 §10 item 1: the composer (`@sgl/layout-api/compose`) with small
 * in-memory engines, so each rule is seen on geometry that can be worked out
 * by hand. The real engines' composed goldens are in
 * `layout-elk/test/compose.test.ts` (it has `grid`, `fixed` and `elk`).
 */

const METRICS: ResolvedThemeMetricsView = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {}, arrowSize: 8 };

// ---------------------------------------------------------------------------
// A document builder: `tree` is `{ id: children }`, ids dotted as SGL's are.
// ---------------------------------------------------------------------------

interface Spec {
  readonly tree: Readonly<Record<string, readonly string[]>>;
  readonly edges?: readonly (readonly [string, string, string?])[];
  readonly hidden?: readonly string[];
  readonly ports?: Readonly<Record<string, readonly string[]>>;
  readonly config?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly edgeLabels?: readonly string[];
}

const LEAF: Size = { w: 20, h: 10 };
const LABEL: Size = { w: 12, h: 6 };

function inputOf(spec: Spec): LayoutInput {
  const nodes: Record<string, GraphNode> = {};
  const parentOf = new Map<string, string>();
  for (const [id, kids] of Object.entries(spec.tree)) for (const k of kids) parentOf.set(k, id);
  const all = new Set<string>([...Object.keys(spec.tree), ...parentOf.keys()]);
  const hidden = new Set(spec.hidden ?? []);
  const labels: Record<LabelId, LabelSpec> = {};
  const labelSizes: Record<LabelId, Size> = {};
  const sizing: Record<NodeId, NodeSizing> = {};
  for (const id of all) {
    const kids = spec.tree[id] ?? [];
    const isHidden = hidden.has(id);
    const labelId = isHidden ? null : asLabelId(`l:${id}`);
    if (labelId !== null) {
      labels[labelId] = { id: labelId, owner: { kind: 'node', id: asNodeId(id) }, role: 'title', runs: [{ text: id }] };
      labelSizes[labelId] = LABEL;
    }
    nodes[id] = {
      id: asNodeId(id),
      path: id.split('.'),
      parent: parentOf.has(id) ? asNodeId(parentOf.get(id)!) : null,
      children: kids.map(asNodeId),
      depth: id.split('.').length - 1,
      shape: 'rect',
      classes: [],
      labelId,
      ports: (spec.ports?.[id] ?? []).map((p) => ({ id: p as PortId, side: 'east' as const })),
      config: spec.config?.[id] ?? {},
      hidden: isHidden,
      span: { from: id.length, to: id.length * 2 },
    };
    sizing[asNodeId(id)] =
      kids.length > 0
        ? { intrinsic: LABEL, contentInset: [2, 3, 4, 5], padding: [10, 3, 4, 5] }
        : { intrinsic: LEAF, contentInset: [1, 1, 1, 1], padding: [1, 1, 1, 1] };
  }
  const roots = [...all].filter((id) => !parentOf.has(id));
  const order: NodeId[] = [];
  const walk = (id: string): void => {
    if (hidden.has(id)) return;
    order.push(asNodeId(id));
    for (const k of spec.tree[id] ?? []) walk(k);
  };
  for (const r of roots) walk(r);
  const edgeLabels = new Set(spec.edgeLabels ?? []);
  const edges: GraphEdge[] = (spec.edges ?? []).map(([from, to, id]) => {
    const eid = asEdgeId(id ?? `${from}>${to}`);
    const [fn, fp] = from.split('#');
    const [tn, tp] = to.split('#');
    const labelId = edgeLabels.has(eid) ? asLabelId(`l:${eid}`) : null;
    if (labelId !== null) {
      labels[labelId] = { id: labelId, owner: { kind: 'edge', id: eid }, role: 'edge', runs: [{ text: eid }] };
      labelSizes[labelId] = LABEL;
    }
    return {
      id: eid,
      from: { node: asNodeId(fn!), ...(fp !== undefined && { port: fp as PortId }) },
      to: { node: asNodeId(tn!), ...(tp !== undefined && { port: tp as PortId }) },
      directed: 'forward',
      classes: [],
      labelId,
      config: {},
      declaredIn: null,
      hidden: hidden.has(fn!) || hidden.has(tn!),
      span: { from: 0, to: 1 },
    };
  });
  const graph: SemanticGraph = {
    nodes: nodes as SemanticGraph['nodes'],
    edges,
    rootChildren: roots.map(asNodeId),
    order,
    labels,
    meta: { nodeCount: order.length, edgeCount: edges.length, containerCount: order.filter((id) => nodes[id]!.children.length > 0).length },
  };
  return { graph, scope: null, sizing, labelSizes };
}

// ---------------------------------------------------------------------------
// Engines.
// ---------------------------------------------------------------------------

/** `col`: every layer in one column, `gap` apart, starting at the padding;
 *  a leaf is `fixed ?? intrinsic`. The scope node (if any) at `origin`.
 *  Straight routing and label placement are left to the host. */
interface ColumnOptions {
  readonly origin?: { x: number; y: number };
  readonly gap?: number;
  readonly determinism?: 'bitwise' | 'quantized';
  readonly pins?: boolean;
  /** Places each node's ports on its east side, evenly. */
  readonly ports?: boolean;
  /** Routes every edge of its view itself: two segments via the midpoint. */
  readonly routes?: boolean;
  /** Grows a leaf with a fixed size by this much (a parent that resizes a box). */
  readonly resize?: number;
  /** Takes a leaf's intrinsic size even when it has a fixed one. */
  readonly ignoreFixed?: boolean;
}

function column(id: string, opts: ColumnOptions = {}): LayoutEngine & { calls: (NodeId | null)[] } {
  const calls: (NodeId | null)[] = [];
  return {
    id,
    name: id,
    version: '0.0.0',
    apiVersion: LAYOUT_API_VERSION,
    capabilities: { containers: true, edgeRouting: opts.routes === true ? 'orthogonal' : 'straight', ports: opts.ports === true, labelPlacement: false, incremental: false, determinism: opts.determinism ?? 'bitwise', ...(opts.pins === true && { pins: true }) },
    calls,
    async layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult> {
      calls.push(input.scope);
      const gap = typeof ctx.options['gap'] === 'number' ? ctx.options['gap'] : (opts.gap ?? 10);
      const { graph, sizing } = input;
      const out: Record<NodeId, NodeLayout> = {};
      const sizeOf = (nid: NodeId): Size => {
        const n = graph.nodes[nid]!;
        const kids = n.children.filter((k) => graph.nodes[k]?.hidden === false);
        const s = sizing[nid]!;
        if (kids.length === 0) {
          if (opts.ignoreFixed === true) return s.intrinsic;
          if (s.fixed?.w !== undefined && opts.resize !== undefined) return { w: s.fixed.w + opts.resize, h: s.fixed.h ?? s.intrinsic.h };
          return { w: s.fixed?.w ?? s.intrinsic.w, h: s.fixed?.h ?? s.intrinsic.h };
        }
        const sizes = kids.map(sizeOf);
        return {
          w: Math.max(...sizes.map((z) => z.w)) + s.padding[3] + s.padding[1],
          h: sizes.reduce((a, z) => a + z.h, 0) + gap * (sizes.length - 1) + s.padding[0] + s.padding[2],
        };
      };
      const place = (ids: readonly NodeId[], x0: number, y0: number): void => {
        let y = y0;
        for (const nid of ids) {
          const n = graph.nodes[nid]!;
          if (n.hidden) continue;
          const size = sizeOf(nid);
          const frame = { x: x0, y, w: size.w, h: size.h };
          const kids = n.children.filter((k) => graph.nodes[k]?.hidden === false);
          const s = sizing[nid]!;
          const ports =
            opts.ports === true && n.ports.length > 0
              ? Object.fromEntries(n.ports.map((p, i) => [p.id, { point: { x: frame.x + frame.w, y: frame.y + ((i + 1) * frame.h) / (n.ports.length + 1) }, normal: { x: 1, y: 0 } }]))
              : undefined;
          out[nid] = {
            frame,
            ...(kids.length > 0 && { contentFrame: { x: x0 + s.padding[3], y: y + s.padding[0], w: size.w - s.padding[3] - s.padding[1], h: size.h - s.padding[0] - s.padding[2] } }),
            ...(ports !== undefined && { ports }),
          };
          if (kids.length > 0) place(kids, x0 + s.padding[3], y + s.padding[0]);
          y += size.h + gap;
        }
      };
      const o = opts.origin ?? { x: 0, y: 0 };
      if (input.scope === null) place(graph.rootChildren, o.x, o.y);
      else place([input.scope], o.x, o.y);
      const edges: Record<string, EdgeLayout> = {};
      if (opts.routes === true) {
        for (const e of graph.edges) {
          const a = out[e.from.node]?.frame;
          const b = out[e.to.node]?.frame;
          if (a === undefined || b === undefined || e.from.node === e.to.node) continue;
          const start = { x: a.x + a.w / 2, y: a.y + a.h };
          const end = { x: b.x + b.w / 2, y: b.y };
          const mid = { x: start.x, y: (start.y + end.y) / 2 };
          edges[e.id] = { start, end, route: [{ t: 'L', to: mid }, { t: 'L', to: end }] };
        }
      }
      return { bounds: { x: 0, y: 0, w: 0, h: 0 }, nodes: out, edges, labels: [] };
    },
  };
}

function failing(id: string, how: 'throw' | 'shape' | 'missing' | 'abort'): LayoutEngine & { calls: number } {
  const inner = column(`${id}.inner`);
  const engine = {
    id,
    name: id,
    version: '0.0.0',
    apiVersion: LAYOUT_API_VERSION,
    capabilities: inner.capabilities,
    calls: 0,
    async layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult> {
      engine.calls += 1;
      if (how === 'throw') throw new Error('boom `x`\nline two');
      if (how === 'shape') return undefined as unknown as LayoutResult;
      const r = await inner.layout(input, ctx);
      if (how === 'abort') {
        abortNow();
        return r;
      }
      const nodes = { ...r.nodes };
      delete nodes[input.scope!];
      return { ...r, nodes };
    },
  };
  return engine;
}

let abortNow: () => void = () => {};

function registry(...engines: LayoutEngine[]): (id: string) => LayoutEngine | undefined {
  const byId = new Map(engines.map((e) => [e.id, e]));
  return (id) => byId.get(id);
}

function ctx(controller = new AbortController()): LayoutContext {
  return { ...conformanceContext({}, METRICS), signal: controller.signal };
}

const n = asNodeId;
const plan = (...scopes: [string, string, Record<string, unknown>?][]): LayoutPlan =>
  scopes.map(([node, engine, options]) => ({ node: n(node), engine, options: options ?? {} }));

// ---------------------------------------------------------------------------

/** root: `a`, box `b` (`b.x`, `b.y`), `c`. */
const BASIC: Spec = { tree: { a: [], b: ['b.x', 'b.y'], c: [] } };

describe('layoutView (DD-14 C24)', () => {
  const input = inputOf({
    tree: { a: [], b: ['b.x', 'b.y'], c: [] },
    edges: [['b.x', 'b.y'], ['a', 'b.x'], ['a', 'b'], ['b', 'b'], ['b.x', 'b'], ['b.y', 'b#p'], ['a', 'c']],
    ports: { b: ['p'] },
    config: { b: { layout: { engine: 'x' }, pin: { x: 1, y: 2 } } },
  });

  it("the parent's view: a box is a leaf of its size, with no title, its own ports and config", () => {
    const view = layoutView(input, null, new Map([[n('b'), { w: 50, h: 40 }]]));
    const g = view.graph;
    expect(view.scope).toBeNull();
    expect(g.order).toEqual(['a', 'b', 'c']);
    expect(g.rootChildren).toEqual(['a', 'b', 'c']);
    expect(g.nodes[n('b')]).toMatchObject({ children: [], labelId: null, ports: [{ id: 'p', side: 'east' }], config: { layout: { engine: 'x' }, pin: { x: 1, y: 2 } } });
    expect(g.nodes[n('b.x')]).toBeUndefined();
    expect(view.sizing[n('b')]).toEqual({ intrinsic: { w: 50, h: 40 }, fixed: { w: 50, h: 40 }, contentInset: [2, 3, 4, 5], padding: [2, 3, 4, 5] });
    expect(Object.keys(g.labels).sort()).toEqual(['l:a', 'l:c']);
    expect(Object.keys(view.labelSizes).sort()).toEqual(['l:a', 'l:c']);
    // C14: box to box, a self-loop on a box, and two ends in this layer.
    expect(g.edges.map((e) => e.id)).toEqual(['a>b', 'b>b', 'a>c']);
    expect(g.meta).toEqual({ nodeCount: 3, edgeCount: 3, containerCount: 0 });
  });

  it("the box's own view: the scope is its view's root, with no ports (C22); edges inside it and to the box itself", () => {
    const view = layoutView(input, n('b'), new Map());
    const g = view.graph;
    expect(view.scope).toBe('b');
    expect(g.rootChildren).toEqual(['b']);
    expect(g.order).toEqual(['b', 'b.x', 'b.y']);
    expect(g.nodes[n('b')]).toMatchObject({ parent: null, ports: [], children: ['b.x', 'b.y'], labelId: 'l:b' });
    expect(g.nodes[n('a')]).toBeUndefined();
    expect(view.sizing[n('b')]).toBe(input.sizing[n('b')]);
    expect(Object.keys(g.labels).sort()).toEqual(['l:b', 'l:b.x', 'l:b.y']);
    // `b.y -> b[p]` ends on a port the parent places: not this view's edge.
    expect(g.edges.map((e) => e.id)).toEqual(['b.x>b.y', 'b.x>b']);
  });

  it('an inner box inside a scope is a leaf there too, and hidden children stay (engines filter them)', () => {
    const nested = inputOf({ tree: { o: ['o.i', 'o.h', 'o.z'], 'o.i': ['o.i.k'] }, hidden: ['o.h'] });
    const view = layoutView(nested, n('o'), new Map([[n('o.i'), { w: 7, h: 9 }]]));
    expect(view.graph.order).toEqual(['o', 'o.i', 'o.z']);
    expect(view.graph.nodes[n('o.h')]?.hidden).toBe(true);
    expect(view.graph.nodes[n('o.i')]?.children).toEqual([]);
    expect(view.graph.nodes[n('o.i.k')]).toBeUndefined();
  });
});

describe('composeLayout (DD-14 C23, C5)', () => {
  it('sizes the box by its own engine, places it as one box by the parent, and moves its contents', async () => {
    const outer = column('t.outer', { gap: 5 });
    const inner = column('t.inner', { gap: 3 });
    const input = inputOf(BASIC);
    const r = await composeLayout(outer, input, {}, plan(['b', 't.inner']), registry(outer, inner), ctx());
    expect(inner.calls).toEqual(['b']);
    expect(outer.calls).toEqual([null]);
    // The box: [10,3,4,5] padding, two 20x10 leaves 3 apart: 28 x 37.
    expect(r.nodes[n('a')]!.frame).toEqual({ x: 0, y: 0, w: 20, h: 10 });
    expect(r.nodes[n('b')]!.frame).toEqual({ x: 0, y: 15, w: 28, h: 37 });
    expect(r.nodes[n('b')]!.contentFrame).toEqual({ x: 5, y: 25, w: 20, h: 23 });
    expect(r.nodes[n('b.x')]!.frame).toEqual({ x: 5, y: 25, w: 20, h: 10 });
    expect(r.nodes[n('b.y')]!.frame).toEqual({ x: 5, y: 38, w: 20, h: 10 });
    expect(r.nodes[n('c')]!.frame).toEqual({ x: 0, y: 57, w: 20, h: 10 });
    // The box's title is its own engine's (placed by the host for it), moved with it.
    expect(r.labels.find((l) => l.labelId === 'l:b')!.frame).toEqual({ x: 5, y: 17, w: 12, h: 6 });
    expect(r.labels.map((l) => l.labelId).sort()).toEqual(['l:a', 'l:b', 'l:b.x', 'l:b.y', 'l:c']);
    // Nodes in graph.order.
    expect(Object.keys(r.nodes)).toEqual(['a', 'b', 'b.x', 'b.y', 'c']);
  });

  it("a box's options are its own (C6: the plan carries them complete)", async () => {
    const outer = column('t.outer');
    const inner = column('t.inner');
    const r = await composeLayout(outer, inputOf(BASIC), { gap: 1 }, plan(['b', 't.inner', { gap: 20 }]), registry(outer, inner), ctx());
    expect(r.nodes[n('b.y')]!.frame.y - r.nodes[n('b.x')]!.frame.y).toBe(30);
    expect(r.nodes[n('c')]!.frame.y - (r.nodes[n('b')]!.frame.y + r.nodes[n('b')]!.frame.h)).toBe(1);
  });

  it('nesting composes: three levels, each moved by its box position, bottom-up (C5)', async () => {
    const e1 = column('t.one', { gap: 5 });
    const e2 = column('t.two', { gap: 7 });
    const e3 = column('t.three', { gap: 2 });
    const input = inputOf({ tree: { p: ['p.q'], 'p.q': ['p.q.r', 'p.q.s'], z: [] } });
    const order: string[] = [];
    for (const e of [e1, e2, e3]) {
      const f = e.layout.bind(e);
      e.layout = (i, c) => {
        order.push(`${e.id}:${i.scope ?? 'root'}`);
        return f(i, c);
      };
    }
    const r = await composeLayout(e1, input, {}, plan(['p', 't.two'], ['p.q', 't.three']), registry(e1, e2, e3), ctx());
    expect(order).toEqual(['t.three:p.q', 't.two:p', 't.one:root']);
    // p.q: two leaves 2 apart + padding => 28 x 36. p: p.q + padding => 36 x 50.
    expect(r.nodes[n('p')]!.frame).toEqual({ x: 0, y: 0, w: 36, h: 50 });
    expect(r.nodes[n('p.q')]!.frame).toEqual({ x: 5, y: 10, w: 28, h: 36 });
    expect(r.nodes[n('p.q.r')]!.frame).toEqual({ x: 10, y: 20, w: 20, h: 10 });
    expect(r.nodes[n('p.q.s')]!.frame).toEqual({ x: 10, y: 32, w: 20, h: 10 });
    expect(r.nodes[n('z')]!.frame).toEqual({ x: 0, y: 55, w: 20, h: 10 });
  });

  it("a box's result is moved so its frame starts at the origin, then by its place in the parent (translation is exact)", async () => {
    const outer = column('t.outer', { origin: { x: 100, y: 1000 } });
    const inner = column('t.inner', { origin: { x: 12, y: 12 } });
    const r = await composeLayout(outer, inputOf(BASIC), {}, plan(['b', 't.inner']), registry(outer, inner), ctx());
    expect(r.nodes[n('b')]!.frame).toEqual({ x: 100, y: 1020, w: 28, h: 44 });
    expect(r.nodes[n('b.x')]!.frame).toEqual({ x: 105, y: 1030, w: 20, h: 10 });
  });

  it('a `quantized` box is snapped to the 1/64 grid before its size reaches its parent; a `bitwise` one is not (C31)', async () => {
    const outer = column('t.outer', { gap: 0.3 });
    const q = column('t.q', { gap: 0.1, origin: { x: 0.004, y: 0 }, determinism: 'quantized' });
    const b = column('t.b', { gap: 0.1, origin: { x: 0.004, y: 0 } });
    const rq = await composeLayout(outer, inputOf(BASIC), {}, plan(['b', 't.q']), registry(outer, q), ctx());
    const rb = await composeLayout(outer, inputOf(BASIC), {}, plan(['b', 't.b']), registry(outer, b), ctx());
    // 0.1 is 6.4/64: snapped to 6/64 = 0.09375.
    expect(rq.nodes[n('b.y')]!.frame.y - rq.nodes[n('b.x')]!.frame.y).toBe(10 + 6 / 64);
    // 34.1 is 2182.4/64: snapped to 34.09375, the size the parent packs.
    expect(rq.nodes[n('b')]!.frame.h).toBe(34.09375);
    expect(rq.nodes[n('c')]!.frame.y).toBeCloseTo(10.3 + 34.09375 + 0.3, 12);
    // `bitwise`: raw sums, the origin removed by subtraction only.
    expect(rb.nodes[n('b.y')]!.frame.y - rb.nodes[n('b.x')]!.frame.y).toBeCloseTo(10.1, 12);
    expect(rb.nodes[n('b')]!.frame.h).toBe(20 + 0.1 + 10 + 4);
  });

  it('an edge across a boundary is drawn straight end to end after composition, and labelled then (C15, C21)', async () => {
    const outer = column('t.outer', { gap: 5 });
    const inner = column('t.inner');
    const input = inputOf({ ...BASIC, edges: [['a', 'b.y', 'in'], ['b.x', 'b.y', 'inside'], ['a', 'b', 'box']], edgeLabels: ['in'] });
    const r = await composeLayout(outer, input, {}, plan(['b', 't.inner']), registry(outer, inner), ctx());
    // `a` (0,0,20,10) centre (10,5); `b.y` at (5,45,20,10) centre (15,50).
    expect(r.nodes[n('b.y')]!.frame).toEqual({ x: 5, y: 45, w: 20, h: 10 });
    const e = r.edges[asEdgeId('in')]!;
    expect(e.start.y).toBe(10);
    expect(e.end.y).toBeCloseTo(45 - 8 * (45 / Math.hypot(5, 45)), 9);
    expect(r.labels.some((l) => l.labelId === 'l:in')).toBe(true);
    expect(Object.keys(r.edges).sort()).toEqual(['box', 'in', 'inside']);
  });

  it('merges engine notes in scope order: the root, then each box in document order (C29)', async () => {
    const noting = (id: string, code: 'SGL4020'): LayoutEngine => {
      const base = column(id);
      return {
        ...base,
        async layout(i, c) {
          const r = await base.layout(i, c);
          return { ...r, notes: [{ code, span: { from: 0, to: 0 }, params: { node: i.scope ?? 'root' } }] };
        },
      };
    };
    const root = noting('t.root', 'SGL4020');
    const box = noting('t.box', 'SGL4020');
    const input = inputOf({ tree: { b1: ['b1.x'], b2: ['b2.x'] } });
    const r = await composeLayout(root, input, {}, plan(['b1', 't.box'], ['b2', 't.box']), registry(root, box), ctx());
    expect(r.notes!.map((x) => x.params!['node'])).toEqual(['root', 'b1', 'b2']);
  });

  it('two runs are identical (determinism)', async () => {
    const outer = column('t.outer');
    const inner = column('t.inner', { determinism: 'quantized', gap: 0.37 });
    const input = inputOf({ ...BASIC, edges: [['a', 'b.x'], ['b.x', 'b.y']] });
    const p = plan(['b', 't.inner']);
    const one = await composeLayout(outer, input, {}, p, registry(outer, inner), ctx());
    const two = await composeLayout(outer, input, {}, p, registry(outer, inner), ctx());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('a hidden box, or one whose children are all hidden, is not a boundary (DD-14 §3.7)', async () => {
    const outer = column('t.outer');
    const inner = column('t.inner');
    const input = inputOf({ tree: { a: ['a.x'], h: ['h.x'], e: ['e.x'] }, hidden: ['h', 'h.x', 'e.x'] });
    await composeLayout(outer, input, {}, plan(['h', 't.inner'], ['e', 't.inner'], ['nope', 't.inner']), registry(outer, inner), ctx());
    expect(inner.calls).toEqual([]);
  });
});

describe('a box whose engine fails is laid out by its parent (DD-14 C28, SGL4013)', () => {
  const message = (r: LayoutResult): string[] => engineNotes(r.notes).map((d) => `${d.code} ${d.severity} ${JSON.stringify(d.span)} ${d.message}`);

  it.each([
    ['throw', 'boom  x  line two'],
    ['shape', 'engine returned undefined, not a LayoutResult object'],
    ['missing', 'returned invalid geometry'],
  ] as const)('%s: the box is dissolved into its parent\'s view, with one SGL4013', async (how, detail) => {
    const outer = column('t.outer', { gap: 5 });
    const bad = failing('t.bad', how);
    const r = await composeLayout(outer, inputOf(BASIC), {}, plan(['b', 't.bad']), registry(outer, bad), ctx());
    expect(bad.calls).toBe(1);
    // The parent's engine laid the box out as an ordinary container.
    expect(r.nodes[n('b.x')]!.frame).toEqual({ x: 5, y: 25, w: 20, h: 10 });
    expect(r.nodes[n('b.y')]!.frame).toEqual({ x: 5, y: 40, w: 20, h: 10 });
    expect(message(r)).toEqual([`SGL4013 warning {"from":1,"to":2} Layout engine \`t.bad\` failed for \`b\` (${detail}); it is laid out by \`t.outer\` instead.`]);
  });

  it('an engine that is not registered fails the same way', async () => {
    const outer = column('t.outer');
    const r = await composeLayout(outer, inputOf(BASIC), {}, plan(['b', 't.nope']), registry(outer), ctx());
    expect(message(r)).toEqual(['SGL4013 warning {"from":1,"to":2} Layout engine `t.nope` failed for `b` (not registered in this worker); it is laid out by `t.outer` instead.']);
    expect(r.nodes[n('b.x')]).toBeDefined();
  });

  it("names the parent box's engine, and the failed box's inner boxes stay boxes", async () => {
    const root = column('t.root', { gap: 5 });
    const mid = column('t.mid', { gap: 7 });
    const leaf = column('t.leaf', { gap: 1 });
    const bad = failing('t.bad', 'throw');
    const input = inputOf({ tree: { o: ['o.b'], 'o.b': ['o.b.i', 'o.b.z'], 'o.b.i': ['o.b.i.k', 'o.b.i.m'] } });
    const r = await composeLayout(root, input, {}, plan(['o', 't.mid'], ['o.b', 't.bad'], ['o.b.i', 't.leaf']), registry(root, mid, leaf, bad), ctx());
    expect(message(r)[0]).toContain('it is laid out by `t.mid` instead.');
    // `o.b.i` is still `t.leaf`'s: its two leaves 1 apart.
    expect(r.nodes[n('o.b.i.m')]!.frame.y - r.nodes[n('o.b.i.k')]!.frame.y).toBe(11);
    // `o.b`'s layer is `t.mid`'s now: 7 apart.
    expect(r.nodes[n('o.b.z')]!.frame.y - (r.nodes[n('o.b.i')]!.frame.y + r.nodes[n('o.b.i')]!.frame.h)).toBe(7);
  });

  it("the root's failure is today's: a throw rejects (SGL4011), a bad shape is returned for the host to reject (SGL4002)", async () => {
    const inner = column('t.inner');
    await expect(composeLayout(failing('t.bad', 'throw'), inputOf(BASIC), {}, plan(['b', 't.inner']), registry(inner), ctx())).rejects.toThrow('boom');
    const r = await composeLayout(failing('t.bad', 'shape'), inputOf(BASIC), {}, plan(['b', 't.inner']), registry(inner), ctx());
    expect(r).toBeUndefined();
  });
});

describe('a superseded request stops between scopes (DD-14 C27)', () => {
  it('an abort during one box stops before the next engine runs, with an AbortError', async () => {
    const controller = new AbortController();
    abortNow = () => controller.abort();
    const root = column('t.root');
    const later = column('t.later');
    const first = failing('t.first', 'abort');
    const input = inputOf({ tree: { b1: ['b1.x'], b2: ['b2.x'] } });
    // Post-order: `b2` is laid out first.
    const run = composeLayout(root, input, {}, plan(['b1', 't.later'], ['b2', 't.first']), registry(root, later, first), ctx(controller));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.calls).toBe(1);
    expect(later.calls).toEqual([]);
    expect(root.calls).toEqual([]);
  });

  it('an engine that rejects because it saw the abort is not degraded (no SGL4013)', async () => {
    const controller = new AbortController();
    const root = column('t.root');
    const aborting: LayoutEngine = {
      ...column('t.ab'),
      async layout() {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    };
    await expect(composeLayout(root, inputOf(BASIC), {}, plan(['b', 't.ab']), registry(root, aborting), ctx(controller))).rejects.toMatchObject({ name: 'AbortError' });
    expect(root.calls).toEqual([]);
  });
});

describe('runHostSequence and runConformance take a plan (DD-14 C40)', () => {
  it('with a plan, the composed result is quantized as a request is; with an empty one, today\'s path', async () => {
    const outer = column('t.outer', { gap: 0.3 });
    const inner = column('t.inner', { gap: 0.1 });
    const input = inputOf({ ...BASIC, edges: [['a', 'b.x']] });
    const engines = registry(outer, inner);
    const composed = await composeLayout(outer, input, {}, plan(['b', 't.inner']), engines, conformanceContext({}, METRICS));
    const seq = await runHostSequence(outer, input, {}, METRICS, { plan: plan(['b', 't.inner']), engines });
    expect(seq.raw).toEqual(composed);
    expect(seq.result).toEqual(quantize(composed, 64));
    const today = await runHostSequence(outer, input, {}, METRICS);
    expect(await runHostSequence(outer, input, {}, METRICS, { plan: [], engines })).toEqual(today);
  });

  it('checks 1–6 run on the composed result of a case with a plan', async () => {
    const outer = column('t.outer');
    const inner = column('t.inner');
    const input = inputOf({ ...BASIC, edges: [['a', 'b.x'], ['b.x', 'b.y']] });
    const report = await runConformance(outer, [{ name: 'composed', input, plan: plan(['b', 't.inner']) }], { metrics: METRICS, now: () => 0, engines: registry(outer, inner) });
    expect(report.failures).toEqual([]);
    const composed = await composeLayout(outer, input, {}, plan(['b', 't.inner']), registry(outer, inner), conformanceContext({}, METRICS));
    expect(report.cases[0]!.result).toEqual(quantize(composed, 64));
    expect(report.cases[0]!.deterministic).toBe(true);
    // A composed result the checks reject: an outer engine that stacks its
    // layer on one spot overlaps the box and its siblings (check 3).
    const stacking: LayoutEngine = { ...column('t.stack'), layout: (i, c) => column('t.stack').layout(i, { ...c, options: { gap: -10 } }) };
    const bad = await runConformance(stacking, [{ name: 'composed', input, plan: plan(['b', 't.inner']) }], { metrics: METRICS, now: () => 0, engines: registry(stacking, inner) });
    expect(bad.failures).toContain("composed: check 3 (siblings 'a' and 'b' overlap)");
  });
});

describe("conformance check 7: an engine honours `scope` (DD-14 C35)", () => {
  const input = inputOf({ tree: { a: [], b: ['b.x', 'b.y'], c: ['c.k'], 'c.k': ['c.k.z'] }, edges: [['b.x', 'b.y'], ['a', 'c.k.z']] });

  it('an engine that places exactly the view\'s nodes passes, for every container', async () => {
    const report = await runConformance(column('t.col'), [{ name: 'doc', input }], { metrics: METRICS, now: () => 0 });
    expect(report.failures).toEqual([]);
    expect(report.cases[0]!.scopes).toEqual(['b', 'c', 'c.k']);
  });

  it("an engine that leaves out the scope's own frame fails it, naming the container", async () => {
    const col = column('t.col');
    const childrenOnly: LayoutEngine = {
      ...col,
      async layout(i, c) {
        const r = await col.layout(i, c);
        if (i.scope === null) return r;
        const nodes = { ...r.nodes };
        delete nodes[i.scope];
        return { ...r, nodes };
      },
    };
    const report = await runConformance(childrenOnly, [{ name: 'doc', input }], { metrics: METRICS, now: () => 0 });
    expect(report.failures).toContain("doc: check 7 (scope 'b': missing 'b'; whole graph: missing 'b')");
  });

  it('an engine that throws for a scope fails it', async () => {
    const col = column('t.col');
    const throwing: LayoutEngine = { ...col, layout: (i, c) => (i.scope === null ? col.layout(i, c) : Promise.reject(new Error('no scopes here'))) };
    const report = await runConformance(throwing, [{ name: 'doc', input }], { metrics: METRICS, now: () => 0 });
    expect(report.failures).toContain("doc: check 7 (scope 'b': threw: no scopes here)");
  });

  it('an engine that places too much fails it', async () => {
    const col = column('t.col');
    const extra: LayoutEngine = {
      ...col,
      async layout(i, c) {
        const r = await col.layout(i, c);
        return i.scope === null ? r : { ...r, nodes: { ...r.nodes, [n('zz')]: { frame: { x: 0, y: 0, w: 1, h: 1 } } } };
      },
    };
    const report = await runConformance(extra, [{ name: 'doc', input }], { metrics: METRICS, now: () => 0 });
    expect(report.failures.filter((f) => f.includes('check 7'))).toEqual([
      "doc: check 7 (scope 'b': extra 'zz'; whole graph: extra 'zz')",
      "doc: check 7 (scope 'c': extra 'zz'; whole graph: extra 'zz')",
      "doc: check 7 (scope 'c.k': extra 'zz'; whole graph: extra 'zz')",
    ]);
  });

  it('an engine that ignores `scope` fails it: given the whole graph and a scope, it lays out everything (M12)', async () => {
    const col = column('t.col');
    const ignoring: LayoutEngine = { ...col, layout: (i, c) => col.layout({ ...i, scope: null }, c) };
    const report = await runConformance(ignoring, [{ name: 'doc', input }], { metrics: METRICS, now: () => 0 });
    expect(report.failures).toEqual([
      "doc: check 7 (scope 'b': whole graph: extra 'a', 'c', 'c.k', 'c.k.z')",
      "doc: check 7 (scope 'c': whole graph: extra 'a', 'b', 'b.x', 'b.y')",
      "doc: check 7 (scope 'c.k': whole graph: extra 'a', 'b', 'b.x', 'b.y', 'c')",
    ]);
  });

  it("an engine that ignores a box's `sizing.fixed` fails it: inner containers are boxes of an odd size", async () => {
    const report = await runConformance(column('t.col', { ignoreFixed: true }), [{ name: 'doc', input }], { metrics: METRICS, now: () => 0 });
    expect(report.failures).toEqual(["doc: check 7 (scope 'c': box 'c.k' is 1x1, not 37.25x23.5)"]);
  });
});

describe('fix round 1', () => {
  it('item 1: nested failures name the engine that really lays the box out, and SGL4013 sits at the `engine` key', async () => {
    const root = column('t.root', { gap: 5 });
    const leaf = column('t.leaf', { gap: 1 });
    const bad1 = failing('t.bad1', 'throw');
    const bad2 = failing('t.bad2', 'throw');
    const input = inputOf({ tree: { o: ['o.b'], 'o.b': ['o.b.i', 'o.b.z'], 'o.b.i': ['o.b.i.k', 'o.b.i.m'] } });
    const p: LayoutPlan = [
      { node: n('o'), engine: 't.bad1', options: {}, span: { from: 100, to: 106 } },
      { node: n('o.b'), engine: 't.bad2', options: {} },
      { node: n('o.b.i'), engine: 't.leaf', options: {} },
    ];
    const r = await composeLayout(root, input, {}, p, registry(root, leaf, bad1, bad2), ctx());
    expect(engineNotes(r.notes).map((d) => `${JSON.stringify(d.span)} ${d.message}`)).toEqual([
      '{"from":100,"to":106} Layout engine `t.bad1` failed for `o` (boom  x  line two); it is laid out by `t.root` instead.',
      '{"from":3,"to":6} Layout engine `t.bad2` failed for `o.b` (boom  x  line two); it is laid out by `t.root` instead.',
    ]);
    expect(r.nodes[n('o.b.i.m')]!.frame.y - r.nodes[n('o.b.i.k')]!.frame.y).toBe(11);
  });

  it('item 1: three levels, the middle one surviving: both failures name it', async () => {
    const root = column('t.root');
    const mid = column('t.mid');
    const leaf = column('t.leaf');
    const input = inputOf({ tree: { a: ['a.b'], 'a.b': ['a.b.c'], 'a.b.c': ['a.b.c.d'], 'a.b.c.d': ['a.b.c.d.e'] } });
    const r = await composeLayout(root, input, {}, plan(['a', 't.mid'], ['a.b', 't.bad1'], ['a.b.c', 't.bad2'], ['a.b.c.d', 't.leaf']), registry(root, mid, leaf, failing('t.bad1', 'throw'), failing('t.bad2', 'throw')), ctx());
    expect(engineNotes(r.notes).map((d) => d.message.replace(/ \(.*\)/, ''))).toEqual([
      'Layout engine `t.bad1` failed for `a.b`; it is laid out by `t.mid` instead.',
      'Layout engine `t.bad2` failed for `a.b.c`; it is laid out by `t.mid` instead.',
    ]);
    expect(mid.calls).toEqual(['a']);
    expect(leaf.calls).toEqual(['a.b.c.d']);
  });

  it("item 3: a box its parent's engine resizes is dissolved into the parent, with SGL4013, and no edge is left detached", async () => {
    const outer = column('t.outer', { resize: 5 });
    const inner = column('t.inner');
    const input = inputOf({ ...BASIC, edges: [['b.x', 'b.y', 'inside'], ['a', 'b.x', 'cross']] });
    const r = await composeLayout(outer, input, {}, plan(['b', 't.inner']), registry(outer, inner), ctx());
    expect(engineNotes(r.notes).map((d) => d.message)).toEqual(["Layout engine `t.inner` failed for `b` (resized by its parent's engine); it is laid out by `t.outer` instead."]);
    expect(outer.calls).toEqual([null, null]);
    // `t.outer` laid `b` out as a container: its own gap (10) and padding.
    expect(r.nodes[n('b')]!.frame).toEqual({ x: 0, y: 20, w: 28, h: 44 });
    expect(detachedEdges(input.graph, quantize(r, 64), METRICS.arrowSize)).toEqual([]);
  });

  it("item 6: an abort during the root's own layout stops the request", async () => {
    const controller = new AbortController();
    abortNow = () => controller.abort();
    const run = composeLayout(failing('t.r', 'abort'), inputOf(BASIC), {}, plan(['b', 't.inner']), registry(column('t.inner')), ctx(controller));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it("item 7: a crossing edge to the box's own port ends at the port its parent placed (C22)", async () => {
    const outer = column('t.outer', { ports: true });
    const inner = column('t.inner');
    const input = inputOf({ ...BASIC, ports: { b: ['p'] }, edges: [['b.y', 'b#p', 'toport']] });
    const r = await composeLayout(outer, input, {}, plan(['b', 't.inner']), registry(outer, inner), ctx());
    const port = r.nodes[n('b')]!.ports!['p']!;
    expect(port.point).toEqual({ x: 28, y: 20 + 44 / 2 });
    const end = r.edges[asEdgeId('toport')]!.end;
    expect(Math.hypot(end.x - port.point.x, end.y - port.point.y)).toBeCloseTo(8, 9);
  });

  it("item 7: an edge a box's view holds is its engine's (routed once, labelled once); labels come out by id", async () => {
    const outer = column('t.outer');
    const inner = column('t.inner', { routes: true });
    const input = inputOf({ ...BASIC, edges: [['b.x', 'b.y', 'inside'], ['a', 'b.y', 'cross']], edgeLabels: ['inside', 'cross'] });
    const r = await composeLayout(outer, input, {}, plan(['b', 't.inner']), registry(outer, inner), ctx());
    expect(r.edges[asEdgeId('inside')]!.route).toHaveLength(2);
    expect(r.edges[asEdgeId('cross')]!.route).toHaveLength(1);
    expect(r.labels.map((l) => l.labelId)).toEqual(['l:a', 'l:b', 'l:b.x', 'l:b.y', 'l:c', 'l:cross', 'l:inside']);
  });
});

// ---------------------------------------------------------------------------
// The per-box cache (DD-14 C32, `perf/b8-cache`).
// ---------------------------------------------------------------------------

describe('the per-box cache (DD-14 C32)', () => {
  /** root: `a`, boxes `b` (`b.x`, `b.y`) and `c` (`c.x`), and `d`. */
  const TWO: Spec = { tree: { a: [], b: ['b.x', 'b.y'], c: ['c.x'], d: [] }, edges: [['b.x', 'b.y'], ['a', 'c.x'], ['a', 'd']], edgeLabels: ['b.x>b.y'] };
  const PLAN = plan(['b', 't.box'], ['c', 't.box']);

  /** Every node's and edge's span moved by `d`: an edit earlier in the text. */
  const shifted = (input: LayoutInput, d: number): LayoutInput => {
    const nodes: Record<string, GraphNode> = {};
    for (const [id, node] of Object.entries(input.graph.nodes)) nodes[id] = { ...node, span: { from: node.span.from + d, to: node.span.to + d } };
    const edges = input.graph.edges.map((e) => ({ ...e, span: { from: e.span.from + d, to: e.span.to + d } }));
    return { ...input, graph: { ...input.graph, nodes: nodes as SemanticGraph['nodes'], edges } };
  };

  /** Composes `input` with and without `cache`; they must agree exactly
   *  (`toStrictEqual` compares numbers with `Object.is`, so `-0` too), and
   *  the fresh run's box calls are returned. */
  const both = async (root: LayoutEngine, box: LayoutEngine & { calls: (NodeId | null)[] }, input: LayoutInput, cache: LayoutCache, p: LayoutPlan = PLAN) => {
    const before = box.calls.length;
    const cached = await composeLayout(root, input, {}, p, registry(root, box), ctx(), cache);
    const calls = box.calls.slice(before);
    const fresh = await composeLayout(root, input, {}, p, registry(root, box), ctx());
    expect(JSON.stringify(cached)).toBe(JSON.stringify(fresh));
    expect(cached).toStrictEqual(fresh);
    return calls;
  };

  it('a repeated request runs no box engine, and its result is exactly the uncached one', async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    const input = inputOf(TWO);
    expect(await both(root, box, input, cache)).toEqual(['c', 'b']);
    expect(await both(root, box, input, cache)).toEqual([]);
    expect(await both(root, box, input, cache)).toEqual([]);
    expect(cache.size).toBe(2);
    expect([cache.hits, cache.misses]).toEqual([4, 2]);
  });

  it('an edit inside one box lays out that box alone; the other is reused, moved into place', async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    await both(root, box, inputOf(TWO), cache);
    // `b` gains a child: it grows, so `c` moves down, and is reused there.
    const edited = inputOf({ ...TWO, tree: { ...TWO.tree, b: ['b.x', 'b.y', 'b.z'] } });
    expect(await both(root, box, edited, cache)).toEqual(['b']);
  });

  it('an edit outside every box, which moves every span after it, lays out no box', async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    await both(root, box, inputOf(TWO), cache);
    const edited = shifted(inputOf({ ...TWO, tree: { e: [], ...TWO.tree } }), 17);
    expect(await both(root, box, edited, cache)).toEqual([]);
  });

  it("an edit to one box's options, engine version, or the theme's metrics lays out what it reaches", async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    const input = inputOf(TWO);
    await both(root, box, input, cache);
    expect(await both(root, box, input, cache, plan(['b', 't.box', { gap: 9 }], ['c', 't.box']))).toEqual(['b']);
    const next = { ...box, version: '0.0.1', calls: box.calls };
    expect(await both(root, next, input, cache)).toEqual(['c', 'b']);
    const before = box.calls.length;
    await composeLayout(root, input, {}, PLAN, registry(root, box), { ...ctx(), metrics: { ...METRICS, arrowSize: 9 } }, cache);
    expect(box.calls.slice(before)).toEqual(['c', 'b']);
  });

  it("an inner box that changes size lays out its parent box again; a sibling's contents do not", async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    const nested: Spec = { tree: { o: ['o.i', 'o.k'], 'o.i': ['o.i.x'], s: ['s.x'] } };
    const p = plan(['o', 't.box'], ['o.i', 't.box'], ['s', 't.box']);
    expect(await both(root, box, inputOf(nested), cache, p)).toEqual(['s', 'o.i', 'o']);
    expect(await both(root, box, inputOf({ tree: { ...nested.tree, 'o.i': ['o.i.x', 'o.i.y'] } }), cache, p)).toEqual(['o.i', 'o']);
    // A leaf of `o` itself changes `o` alone.
    expect(await both(root, box, inputOf({ tree: { ...nested.tree, o: ['o.i', 'o.k', 'o.m'] } }), cache, p)).toEqual(['o']);
  });

  it('a result with notes is reused only when the spans are the same too; one without, whatever the spans', async () => {
    const noting = column('t.note');
    const note: LayoutEngine & { calls: (NodeId | null)[] } = {
      ...noting,
      async layout(i, c) {
        const r = await noting.layout(i, c);
        return i.scope === n('b') ? { ...r, notes: [{ code: 'SGL4020', span: i.graph.nodes[n('b.x')]!.span, params: { node: 'b.x' } }] } : r;
      },
    };
    const root = column('t.root');
    const cache = new LayoutCache();
    const p = plan(['b', 't.note'], ['c', 't.note']);
    await both(root, note, inputOf(TWO), cache, p);
    expect(await both(root, note, shifted(inputOf(TWO), 5), cache, p)).toEqual(['b']);
    expect(await both(root, note, shifted(inputOf(TWO), 5), cache, p)).toEqual([]);
  });

  it('a box whose engine draws on ctx.random, ctx.log or ctx.measure is never stored; nor is a failure', async () => {
    const root = column('t.root');
    for (const use of ['random', 'log', 'measure'] as const) {
      const base = column('t.box');
      const impure: LayoutEngine & { calls: (NodeId | null)[] } = {
        ...base,
        async layout(i, c) {
          if (use === 'random') c.random();
          else if (use === 'log') c.log('info', 'hello');
          else await c.measure.layoutRunsAsync([], {});
          return base.layout(i, c);
        },
      };
      const cache = new LayoutCache();
      const context = { ...ctx(), measure: { layoutRuns: () => ({}), layoutRunsAsync: () => Promise.resolve({}) } };
      for (let i = 0; i < 2; i += 1) await composeLayout(root, inputOf(TWO), {}, PLAN, registry(root, impure), context, cache);
      expect(base.calls, use).toEqual(['c', 'b', 'c', 'b']);
      expect(cache.size, use).toBe(0);
    }
    const bad = failing('t.box', 'throw');
    const cache = new LayoutCache();
    for (let i = 0; i < 2; i += 1) await composeLayout(root, inputOf(TWO), {}, PLAN, registry(root, bad), ctx(), cache);
    expect(bad.calls).toBe(4);
    expect(cache.size).toBe(0);
  });

  it('keeps what the last two finished requests used; a request stopped part-way ends no generation', async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    const a = inputOf(TWO);
    const b = inputOf({ ...TWO, tree: { ...TWO.tree, b: ['b.x'] } });
    const c = inputOf({ ...TWO, tree: { ...TWO.tree, b: ['b.y'] } });
    await both(root, box, a, cache); // b@a, c
    await both(root, box, b, cache); // b@b; b@a is kept one more request
    expect(await both(root, box, a, cache)).toEqual([]); // an edit undone hits
    await both(root, box, c, cache); // b@c; b@b was last used two requests ago
    expect(cache.size).toBe(3); // b@a, b@c, c
    await both(root, box, c, cache); // now b@a was too
    expect(cache.size).toBe(2);
    expect(await both(root, box, b, cache)).toEqual(['b']);
    expect(await both(root, box, a, cache)).toEqual(['b']);

    // Superseded: the controller fires once the first box ran.
    const fresh = new LayoutCache();
    await composeLayout(root, a, {}, PLAN, registry(root, box), ctx(), fresh);
    const controller = new AbortController();
    const stopping = { ...box, calls: box.calls, layout: async (i: LayoutInput, x: LayoutContext) => { const r = await box.layout(i, x); controller.abort(); return r; } };
    for (let i = 0; i < 3; i += 1) await expect(composeLayout(root, b, {}, PLAN, registry(root, stopping), ctx(controller), fresh)).rejects.toThrow(/abort/i);
    expect(fresh.size).toBe(3); // b@a and c are still there
    const before = box.calls.length;
    await composeLayout(root, a, {}, PLAN, registry(root, box), ctx(), fresh);
    expect(box.calls.slice(before)).toEqual([]);
  });

  it('when full, stores nothing new and keeps what it has: a scan larger than the cache still hits (07 §2.1 F24)', async () => {
    const root = column('t.root');
    const box = column('t.box');
    const cache = new LayoutCache({ entries: 3, bytes: Number.POSITIVE_INFINITY });
    const spec: Spec = { tree: Object.fromEntries(['p', 'q', 'r', 's', 't'].map((id) => [id, [`${id}.x`]])) };
    const p = plan(['p', 't.box'], ['q', 't.box'], ['r', 't.box'], ['s', 't.box'], ['t', 't.box']);
    expect(await both(root, box, inputOf(spec), cache, p)).toEqual(['t', 's', 'r', 'q', 'p']);
    for (let i = 0; i < 3; i += 1) expect(await both(root, box, inputOf(spec), cache, p)).toEqual(['q', 'p']);
    expect(cache.size).toBe(3);

    const small = new LayoutCache({ entries: 100, bytes: 1 });
    await both(root, box, inputOf(spec), small, p);
    expect([small.size, small.bytes]).toEqual([0, 0]);
    const sized = new LayoutCache();
    await both(root, box, inputOf(spec), sized, p);
    expect(sized.bytes).toBeGreaterThan(0);
    const room = new LayoutCache({ entries: 100, bytes: sized.bytes - 1 });
    await both(root, box, inputOf(spec), room, p);
    expect(room.size).toBe(4);
  });

  it("is cleared when the document's engine changes", async () => {
    const root = column('t.root');
    const other = column('t.other');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    await both(root, box, inputOf(TWO), cache);
    expect(await both(other, box, inputOf(TWO), cache)).toEqual(['c', 'b']);
    expect(await both(other, box, inputOf(TWO), cache)).toEqual([]);
    expect(await both(root, box, inputOf(TWO), cache)).toEqual(['c', 'b']);
  });

  it('keys are exact: -0 is not 0, and a missing key is not an undefined one', async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    const input = inputOf(TWO);
    const withSizing = (s: NodeSizing): LayoutInput => ({ ...input, sizing: { ...input.sizing, [n('b.x')]: s } });
    const base = input.sizing[n('b.x')]!;
    await both(root, box, withSizing({ ...base, contentInset: [0, 1, 1, 1] }), cache);
    expect(await both(root, box, withSizing({ ...base, contentInset: [-0, 1, 1, 1] }), cache)).toEqual(['b']);
    await both(root, box, withSizing(base), cache);
    expect(await both(root, box, withSizing({ ...base, aspectRatio: undefined } as unknown as NodeSizing), cache)).toEqual(['b']);
  });

  it('what it hands out is a copy: changing a composed result changes nothing cached', async () => {
    const root = column('t.root');
    const box = column('t.box', { gap: 3 });
    const cache = new LayoutCache();
    const first = await composeLayout(root, inputOf(TWO), {}, PLAN, registry(root, box), ctx(), cache);
    const expected = JSON.stringify(first);
    (first.nodes[n('b.x')]!.frame as { x: number }).x = 999;
    const second = await composeLayout(root, inputOf(TWO), {}, PLAN, registry(root, box), ctx(), cache);
    (second.nodes[n('c.x')]!.frame as { y: number }).y = 999;
    expect(JSON.stringify(await composeLayout(root, inputOf(TWO), {}, PLAN, registry(root, box), ctx(), cache))).toBe(expected);
    expect(box.calls).toEqual(['c', 'b']);
  });

  it("composeInWorker keeps one cache across the worker's requests", async () => {
    const root = column('t.root');
    const box = column('t.worker-box', { gap: 3 });
    const p = plan(['b', 't.worker-box'], ['c', 't.worker-box']);
    await composeInWorker(root, inputOf(TWO), {}, p, registry(root, box), ctx());
    await composeInWorker(root, inputOf(TWO), {}, p, registry(root, box), ctx());
    expect(box.calls).toEqual(['c', 'b']);
  });
});

