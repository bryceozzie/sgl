import { asNodeId, parse, resolve, type NodeId } from '@sgl/core';
import { layoutPlan, validateResult, type EngineSchemas, type LayoutEngine, type LayoutInput, type LayoutResult } from '@sgl/layout-api';
import type { LayoutPlan } from '@sgl/layout-api/compose';
import { detachedEdges, runConformance, runHostSequence } from '@sgl/layout-api/conformance';
import { fixedEngine, gridEngine, radialEngine, treeEngine } from '@sgl/layout-std';
import { describe, expect, it } from 'vitest';
import { scaleDocument } from '../../../bench/scale-document.js';
import { corpusSource, listCorpusDocs } from '../../theme/test/corpus.js';
import { elkEngine } from '../src/index.js';
import { documentOptionsFor, layoutInputFor, layoutInputForSource, METRICS } from './corpus-input.js';

/**
 * DD-14 §10 items 2–4, branch 1: the real engines composed by the host
 * (`@sgl/layout-api/compose`), through `runHostSequence` with a plan, as a
 * request with that plan runs. Here because this package's tests have all
 * three engines (`@sgl/layout-api` may not depend on them).
 *
 * The plan is built as DD-14 C8 describes, from each container's
 * `@layout.engine` (a bare name is `sgl.<name>`), its other `@layout` keys
 * being the options. `layoutPlan` (branch 2) adds inheritance (C6) and the
 * diagnostics; none of these documents needs either (`layoutPlan`'s own plan
 * for each is checked below). Since branch 2 the fixtures DD-14 §10 lists are
 * `corpus/layout/engine-*.sgl` (their text unchanged, so their goldens are
 * too), and so is `grid-in-tree` since F32's fix let a node be named `root`
 * under elk; `grid-in-fixed` and `tree-in-grid` stay here.
 */

const ENGINES: readonly LayoutEngine[] = [elkEngine, gridEngine, fixedEngine, treeEngine, radialEngine];
const engineById = (id: string): LayoutEngine | undefined => ENGINES.find((e) => e.id === id);
const fullId = (name: string): string => (engineById(name) !== undefined ? name : `sgl.${name}`);

/** C8's plan, without C6's inheritance: `{ node, engine, options }` per
 *  container naming an engine, in `graph.order`. */
function planOf(input: LayoutInput): LayoutPlan {
  const plan: { node: NodeId; engine: string; options: Record<string, unknown> }[] = [];
  for (const id of input.graph.order) {
    const bag = input.graph.nodes[id]?.config['layout'];
    if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) continue;
    const { engine, ...options } = bag as Record<string, unknown>;
    if (typeof engine === 'string') plan.push({ node: id, engine: fullId(engine), options });
  }
  return plan;
}

interface Fixture {
  readonly name: string;
  readonly root: LayoutEngine;
  readonly input: LayoutInput;
  readonly options: Readonly<Record<string, unknown>>;
}

const GRID_IN_FIXED = `@layout: { engine: fixed }
x: { @label: "X", @pin: { x: 0, y: 0 } }
cells: {
  @label: "Cells"
  @pin: { x: 120, y: 0 }
  @layout: { engine: grid, columns: 2 }
  c1: "1"
  c2: "2"
  c3: "3"
}
x -> cells.c1
x -> cells
`;

const TREE_IN_GRID = `@layout: { engine: grid }
note: "Note"
org: {
  @label: "Org"
  @layout: { engine: tree }
  ceo: "CEO"
  cto: "CTO"
  cfo: "CFO"
  dev: "Dev"
  ceo -> cto
  ceo -> cfo
  cto -> dev
}
note -> org.ceo
`;

const RADIAL_IN_GRID = `@layout: { engine: grid }
note: "Note"
hub: {
  @label: "Hub"
  @layout: { engine: radial }
  core: "Core"
  n: "North"
  e: "East"
  s: "South"
  w: "West"
  core -> n
  core -> e
  core -> s
  core -> w
}
note -> hub.core
`;

const FIXTURES: readonly Fixture[] = [
  // Spec §9's worked example: `payments` is a two-column grid in an elk document.
  { name: 'grid-in-elk', root: elkEngine, input: layoutInputFor('checkout.sgl'), options: documentOptionsFor('checkout.sgl') },
  { name: 'elk-in-grid', root: gridEngine, input: layoutInputFor('layout/engine-elk-in-grid.sgl'), options: {} },
  { name: 'fixed-in-elk', root: elkEngine, input: layoutInputFor('layout/engine-fixed-in-elk.sgl'), options: {} },
  { name: 'three-levels', root: fixedEngine, input: layoutInputFor('layout/engine-three-levels.sgl'), options: {} },
  { name: 'same-engine', root: elkEngine, input: layoutInputFor('layout/engine-same-engine.sgl'), options: {} },
  { name: 'grid-in-fixed', root: fixedEngine, input: layoutInputForSource(GRID_IN_FIXED), options: {} },
  { name: 'tree-in-grid', root: gridEngine, input: layoutInputForSource(TREE_IN_GRID), options: {} },
  { name: 'grid-in-tree', root: treeEngine, input: layoutInputFor('layout/engine-grid-in-tree.sgl'), options: {} },
  { name: 'radial-in-grid', root: gridEngine, input: layoutInputForSource(RADIAL_IN_GRID), options: {} },
];

const run = (f: Fixture) => runHostSequence(f.root, f.input, f.options, METRICS, { plan: planOf(f.input), engines: engineById });
const n = asNodeId;
const frameOf = (r: LayoutResult, id: string) => r.nodes[n(id)]!.frame;

describe('composed goldens (DD-14 §10 item 2)', () => {
  it('every fixture has the plan it is meant to have', () => {
    const plans = Object.fromEntries(FIXTURES.map((f) => [f.name, planOf(f.input).map((s) => `${s.node}:${s.engine}:${JSON.stringify(s.options)}`)]));
    expect(plans).toEqual({
      'grid-in-elk': ['payments:sgl.grid:{"columns":2}'],
      'elk-in-grid': ['pipeline:sgl.elk:{"direction":"right"}'],
      'fixed-in-elk': ['rack:sgl.fixed:{}'],
      'three-levels': ['outer:sgl.elk:{}', 'outer.inner:sgl.grid:{"columns":2}'],
      'same-engine': ['row:sgl.elk:{"direction":"right"}'],
      'grid-in-fixed': ['cells:sgl.grid:{"columns":2}'],
      'tree-in-grid': ['org:sgl.tree:{}'],
      'grid-in-tree': ['cells:sgl.grid:{"columns":2}'],
      'radial-in-grid': ['hub:sgl.radial:{}'],
    });
  });

  for (const f of FIXTURES) {
    it(`${f.name}: golden (quantized, as a request with the plan gives it)`, async () => {
      const { result } = await run(f);
      await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/composed/${f.name}.json`);
    });

    it(`${f.name}: two runs are identical, raw and quantized (DD-14 §10 item 4)`, async () => {
      const one = await run(f);
      const two = await run(f);
      expect(JSON.stringify(two.raw)).toBe(JSON.stringify(one.raw));
      expect(JSON.stringify(two.result)).toBe(JSON.stringify(one.result));
    });

    it(`${f.name}: every edge ends on its own node (check 6), crossing edges included`, async () => {
      const { result } = await run(f);
      expect(Object.keys(result.edges).length).toBe(f.input.graph.edges.length);
      expect(detachedEdges(f.input.graph, result, METRICS.arrowSize)).toEqual([]);
    });
  }
});

/**
 * B8 branch 2: the corpus's `engine-*.sgl` through the app's own plan
 * (`layoutPlan`, DD-14 C8, with C6's inheritance and the engines' defaults),
 * as a request carries it. The moved fixtures give exactly their goldens
 * above (their plans differ only in options the engines default anyway);
 * `crossing` and `options-inherit` are new goldens.
 */
describe('the corpus fixtures through layoutPlan (DD-14 §10 item 2)', () => {
  const schemas = (id: string): EngineSchemas | undefined => {
    const e = engineById(id);
    return e === undefined ? undefined : { id: e.id, ...(e.optionsSchema && { optionsSchema: e.optionsSchema }), ...(e.hintsSchema && { hintsSchema: e.hintsSchema }) };
  };
  const planned = (doc: string, root: LayoutEngine) => {
    const { ast } = parse(corpusSource(doc));
    const options = documentOptionsFor(doc);
    const plan = layoutPlan(ast, resolve(ast).model, { engine: root.id, options }, schemas);
    return { plan, options, input: layoutInputFor(doc) };
  };

  it.each([
    ['layout/engine-elk-in-grid.sgl', 'elk-in-grid', gridEngine],
    ['layout/engine-fixed-in-elk.sgl', 'fixed-in-elk', elkEngine],
    ['layout/engine-three-levels.sgl', 'three-levels', fixedEngine],
    ['layout/engine-same-engine.sgl', 'same-engine', elkEngine],
    ['checkout.sgl', 'grid-in-elk', elkEngine],
  ] as const)('%s gives the %s golden', async (doc, golden, root) => {
    const { plan, options, input } = planned(doc, root);
    expect(plan.diagnostics).toEqual([]);
    const { result } = await runHostSequence(root, input, options, METRICS, { plan: plan.scopes, engines: engineById });
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/composed/${golden}.json`);
  });

  it.each([
    ['layout/engine-crossing.sgl', 'crossing'],
    ['layout/engine-options-inherit.sgl', 'options-inherit'],
  ] as const)('%s: golden, two identical runs, every edge on its own node', async (doc, golden) => {
    const { plan, options, input } = planned(doc, elkEngine);
    expect(plan.diagnostics).toEqual([]);
    const run2 = () => runHostSequence(elkEngine, input, options, METRICS, { plan: plan.scopes, engines: engineById });
    const one = await run2();
    const two = await run2();
    expect(JSON.stringify(two.raw)).toBe(JSON.stringify(one.raw));
    expect(JSON.stringify(two.result)).toBe(JSON.stringify(one.result));
    expect(detachedEdges(input.graph, one.result, METRICS.arrowSize)).toEqual([]);
    expect(validateResult(one.result, input.graph, elkEngine.id).filter((d) => d.severity === 'error')).toEqual([]);
    await expect(`${JSON.stringify(one.result, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/composed/${golden}.json`);
  });

  it("options-inherit: each box's options, as C6 builds them", () => {
    const { plan } = planned('layout/engine-options-inherit.sgl', elkEngine);
    expect(plan.scopes.map((s) => [s.node, s.engine, s.options])).toEqual([
      ['cells', 'sgl.grid', { align: 'center', columns: 'auto', gap: 8 }],
      ['cells.lane', 'sgl.elk', { direction: 'right', edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF', nodeSpacing: 20, rankSpacing: 30 }],
      ['cells.lane.sub', 'sgl.grid', { align: 'center', columns: 1, gap: 8 }],
    ]);
  });

  it('options-inherit: `lane` flows right, as the root does, and `sub` is one column', async () => {
    const { plan, options, input } = planned('layout/engine-options-inherit.sgl', elkEngine);
    const { result } = await runHostSequence(elkEngine, input, options, METRICS, { plan: plan.scopes, engines: engineById });
    const f = (id: string) => frameOf(result, id);
    expect(f('cells.lane.y').x).toBeGreaterThan(f('cells.lane.x').x + f('cells.lane.x').w);
    expect(f('cells.lane.sub.q').x).toBe(f('cells.lane.sub.p').x);
    expect(f('cells.lane.sub.q').y).toBeGreaterThan(f('cells.lane.sub.p').y);
  });
});

describe('what the composed fixtures show', () => {
  it("grid-in-elk (spec §9): `payments`' three nodes are a two-column grid, and the edges across it end on `api`", async () => {
    const { result } = await run(FIXTURES[0]!);
    const api = frameOf(result, 'payments.api');
    const ledger = frameOf(result, 'payments.ledger');
    const outbox = frameOf(result, 'payments.outbox');
    // One row: `grid` centres each node in its cell (the cylinders are taller).
    expect(ledger.y + ledger.h / 2).toBeCloseTo(api.y + api.h / 2, 1);
    expect(ledger.x).toBeGreaterThan(api.x + api.w);
    expect(outbox.y).toBeGreaterThan(api.y + api.h);
    // `grid`'s centring puts the second row's first cell under the first's.
    expect(outbox.x + outbox.w / 2).toBe(api.x + api.w / 2);
    const graph = FIXTURES[0]!.input.graph;
    const crossing = graph.edges.filter((e) => e.to.node === 'payments.api' || (e.from.node === 'payments.api' && e.to.node === 'psp'));
    expect(crossing).toHaveLength(2);
    for (const e of crossing) {
      const end = e.to.node === 'payments.api' ? result.edges[e.id]!.end : result.edges[e.id]!.start;
      const inside = end.x >= api.x - 9 && end.x <= api.x + api.w + 9 && end.y >= api.y - 9 && end.y <= api.y + api.h + 9;
      expect(inside, e.id).toBe(true);
    }
  });

  it('fixed-in-elk: pins are honoured inside the box, relative to its content box (C10); `loose` is SGL4020', async () => {
    const { result } = await run(FIXTURES[2]!);
    const content = result.nodes[n('rack')]!.contentFrame!;
    expect(frameOf(result, 'rack.top')).toMatchObject({ x: content.x, y: content.y });
    expect(frameOf(result, 'rack.mid')).toMatchObject({ x: content.x + 40, y: content.y + 60 });
    expect(result.notes?.map((x) => `${x.code} ${String(x.params?.['node'])}`)).toEqual(['SGL4020 rack.loose']);
  });

  it("three-levels: `fixed` pins the elk box, which holds the grid box; each box's frame encloses its contents", async () => {
    const { result } = await run(FIXTURES[3]!);
    const outer = frameOf(result, 'outer');
    const a = frameOf(result, 'a');
    expect(outer.x - a.x).toBe(200);
    for (const [box, kids] of [
      ['outer', ['outer.head', 'outer.inner']],
      ['outer.inner', ['outer.inner.p', 'outer.inner.q', 'outer.inner.r']],
    ] as const) {
      const c = result.nodes[n(box)]!.contentFrame!;
      for (const k of kids) {
        const f = frameOf(result, k);
        expect(f.x >= c.x && f.y >= c.y && f.x + f.w <= c.x + c.w && f.y + f.h <= c.y + c.h, k).toBe(true);
      }
    }
    expect(frameOf(result, 'outer.inner.q').y).toBe(frameOf(result, 'outer.inner.p').y);
  });

  it('same-engine: an elk box laid out rightwards inside a downward elk document (C2)', async () => {
    const { result } = await run(FIXTURES[4]!);
    const [a, b, c] = ['row.a', 'row.b', 'row.c'].map((id) => frameOf(result, id));
    expect(a!.x + a!.w).toBeLessThan(b!.x);
    expect(b!.x + b!.w).toBeLessThan(c!.x);
    expect(frameOf(result, 'row').y).toBeGreaterThan(frameOf(result, 'top').y);
    expect(frameOf(result, 'bottom').y).toBeGreaterThan(frameOf(result, 'row').y);
  });
});

describe('tree, composed (after feat/b5-tree)', () => {
  const byName = (name: string) => FIXTURES.find((f) => f.name === name)!;

  it('tree-in-grid: the box is a tree (CTO and CFO one rank below CEO, Dev below CTO), with no SGL4013', async () => {
    const { result } = await run(byName('tree-in-grid'));
    const [ceo, cto, cfo, dev] = ['org.ceo', 'org.cto', 'org.cfo', 'org.dev'].map((id) => frameOf(result, id));
    expect(cto!.y).toBe(cfo!.y);
    expect(cto!.y).toBeGreaterThan(ceo!.y + ceo!.h);
    expect(dev!.y).toBeGreaterThan(cto!.y + cto!.h);
    expect(result.notes ?? []).toEqual([]);
  });

  it('grid-in-tree: tree places the grid box as a leaf of its size, one rank below the root', async () => {
    const { result } = await run(byName('grid-in-tree'));
    const root = frameOf(result, 'root');
    const cells = frameOf(result, 'cells');
    expect(cells.y).toBeGreaterThan(root.y + root.h);
    expect(frameOf(result, 'cells.c2').y).toBe(frameOf(result, 'cells.c1').y);
    expect(frameOf(result, 'cells.c3').y).toBeGreaterThan(frameOf(result, 'cells.c1').y);
    expect(result.notes ?? []).toEqual([]);
  });
});

describe('radial, composed (after feat/b5-radial)', () => {
  it('radial-in-grid: the box is a disc (Core at the centre, the four on one ring), with no SGL4013', async () => {
    const { result } = await run(FIXTURES.find((f) => f.name === 'radial-in-grid')!);
    const c = (id: string) => {
      const f = frameOf(result, id);
      return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
    };
    const core = c('hub.core');
    const radii = ['hub.n', 'hub.e', 'hub.s', 'hub.w'].map((id) => Math.hypot(c(id).x - core.x, c(id).y - core.y));
    for (const r of radii) expect(r).toBeCloseTo(radii[0]!, 1);
    expect(c('hub.n').y).toBeLessThan(core.y);
    expect(c('hub.s').y).toBeGreaterThan(core.y);
    expect(result.notes ?? []).toEqual([]);
  });
});

describe('fix round 1, item 4: a box is sized from its frame only', () => {
  it('content pinned outside a `fixed` box in a `grid` document stays outside it, and SGL4003 says so, as under `fixed` alone', async () => {
    const source = `@layout: { engine: grid }
a: "A"
rack: {
  @label: "Rack"
  @layout: { engine: fixed }
  out: { @label: "Out", @pin: { x: -60, y: 0 } }
  in: { @label: "In", @pin: { x: 0, y: 0 } }
}
b: "B"
`;
    const input = layoutInputForSource(source);
    const { result } = await runHostSequence(gridEngine, input, {}, METRICS, { plan: planOf(input), engines: engineById });
    const rack = result.nodes[n('rack')]!.contentFrame!;
    expect(frameOf(result, 'rack.out').x).toBe(rack.x - 60);
    expect(validateResult(result, input.graph, gridEngine.id).map((d) => `${d.code} ${d.message}`)).toEqual(['SGL4003 `rack.out` extends outside its container after layout.']);
    // `fixed` alone does the same.
    const alone = await runHostSequence(fixedEngine, input, {}, METRICS);
    expect(validateResult(alone.result, input.graph, fixedEngine.id).map((d) => d.code)).toEqual(['SGL4003']);
  });
});

describe('conformance on composed results (DD-14 C40, §10 item 3)', () => {
  it('checks 1–6 pass on every composed fixture, under its root engine', async () => {
    for (const f of FIXTURES) {
      const report = await runConformance(f.root, [{ name: f.name, input: f.input, plan: planOf(f.input) }], { metrics: METRICS, options: f.options, now: () => performance.now(), engines: engineById });
      expect(report.failures, f.name).toEqual([]);
      expect(report.cases[0]!.deterministic, f.name).toBe(true);
    }
  });

  it('a 1 000-node mixed graph: every container a `grid` box in an `elk` document', async () => {
    const input = layoutInputForSource(scaleDocument(1000) as string);
    const plan: LayoutPlan = input.graph.rootChildren.map((id) => ({ node: id, engine: 'sgl.grid', options: {} }));
    expect(plan).toHaveLength(100);
    const report = await runConformance(elkEngine, [{ name: 'n1000 mixed', input, plan }], { metrics: METRICS, now: () => performance.now(), engines: engineById, timedCase: 'n1000 mixed' });
    console.warn(`[B8] elk root over 100 grid boxes, 1 000 nodes, Node: ${report.cases[0]!.ms.toFixed(0)} ms`);
    expect(report.failures).toEqual([]);
    expect(report.cases[0]!.deterministic).toBe(true);
  }, 120_000);
});

/** `result` with each edge's unit normals rounded to 1e-12. `quantize` leaves
 *  normals alone, and an edge inside a box is routed in the box's own
 *  coordinates, so its normal can differ from the one-engine run in the last
 *  bits (4e-16 in `wildcards.sgl`). Every coordinate is byte-identical. */
function normalsRounded(result: LayoutResult): LayoutResult {
  const r = (v: { x: number; y: number } | undefined) => (v === undefined ? v : { x: Math.round(v.x * 1e12) / 1e12, y: Math.round(v.y * 1e12) / 1e12 });
  const edges = Object.fromEntries(Object.entries(result.edges).map(([id, e]) => [id, { ...e, startNormal: r(e.startNormal), endNormal: r(e.endNormal) }]));
  return { ...result, edges };
}

describe('C31: a grid box in a grid document composes to what grid alone gives', () => {
  const docs = listCorpusDocs().filter((d) => layoutInputFor(d).graph.meta.containerCount > 0);

  it.each(docs)('%s: every container a grid box, the quantized result unchanged', async (doc) => {
    const input = layoutInputFor(doc);
    const plan: LayoutPlan = input.graph.order.filter((id) => input.graph.nodes[id]!.children.length > 0).map((id) => ({ node: id, engine: 'sgl.grid', options: {} }));
    const today = await runHostSequence(gridEngine, input, {}, METRICS);
    const composed = await runHostSequence(gridEngine, input, {}, METRICS, { plan, engines: engineById });
    const strip = (x: LayoutResult) => JSON.stringify({ ...x, edges: Object.fromEntries(Object.entries(x.edges).map(([id, e]) => [id, { ...e, startNormal: 0, endNormal: 0 }])) });
    expect(strip(composed.result)).toBe(strip(today.result));
    expect(JSON.stringify(normalsRounded(composed.result))).toBe(JSON.stringify(normalsRounded(today.result)));
  });
});
