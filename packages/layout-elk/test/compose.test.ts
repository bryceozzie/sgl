import { asNodeId, type NodeId } from '@sgl/core';
import type { LayoutEngine, LayoutInput, LayoutResult } from '@sgl/layout-api';
import type { LayoutPlan } from '@sgl/layout-api/compose';
import { detachedEdges, runConformance, runHostSequence } from '@sgl/layout-api/conformance';
import { fixedEngine, gridEngine } from '@sgl/layout-std';
import { describe, expect, it } from 'vitest';
import { scaleDocument } from '../../../bench/scale-document.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
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
 * being the options. Branch 2's `layoutPlan` adds inheritance (C6) and the
 * diagnostics; none of these documents needs either. The fixtures are here,
 * not in `corpus/`, until the app and the render harness run plans (branch 2):
 * in the corpus today they would be laid out by one engine and warn `SGL4010`.
 */

const ENGINES: readonly LayoutEngine[] = [elkEngine, gridEngine, fixedEngine];
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

const ELK_IN_GRID = `@layout: { engine: grid }
intro: "Intro"
pipeline: {
  @label: "Pipeline"
  @layout: { engine: elk, direction: right }
  fetch: "Fetch"
  parse: "Parse"
  emit: "Emit"
  fetch -> parse
  parse -> emit: "tokens"
}
out: "Out"
intro -> pipeline.fetch
pipeline.emit -> out: "done"
intro -> pipeline
`;

const FIXED_IN_ELK = `@layout: { engine: elk }
client: "Client"
rack: {
  @label: "Rack"
  @layout: { engine: fixed }
  top: { @label: "Top", @pin: { x: 0, y: 0 } }
  mid: { @label: "Mid", @pin: { x: 40, y: 60 } }
  loose: "Loose"
}
db: { @label: "DB", @shape: cylinder }
client -> rack.top
rack.mid -> db
client -> db
client -> rack
`;

const THREE_LEVELS = `@layout: { engine: fixed }
a: { @label: "A", @pin: { x: 0, y: 0 } }
outer: {
  @label: "Outer"
  @pin: { x: 200, y: 0 }
  @layout: { engine: elk }
  head: "Head"
  inner: {
    @label: "Inner"
    @layout: { engine: grid, columns: 2 }
    p: "P"
    q: "Q"
    r: "R"
  }
  head -> inner
  head -> inner.p
}
a -> outer.head
`;

const SAME_ENGINE = `@layout: { engine: elk }
top: "Top"
row: {
  @label: "Row"
  @layout: { engine: elk, direction: right }
  a: "A"
  b: "B"
  c: "C"
  a -> b
  b -> c
}
bottom: "Bottom"
top -> row
row -> bottom
top -> row.a
`;

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

const FIXTURES: readonly Fixture[] = [
  // Spec §9's worked example: `payments` is a two-column grid in an elk document.
  { name: 'grid-in-elk', root: elkEngine, input: layoutInputFor('checkout.sgl'), options: documentOptionsFor('checkout.sgl') },
  { name: 'elk-in-grid', root: gridEngine, input: layoutInputForSource(ELK_IN_GRID), options: {} },
  { name: 'fixed-in-elk', root: elkEngine, input: layoutInputForSource(FIXED_IN_ELK), options: {} },
  { name: 'three-levels', root: fixedEngine, input: layoutInputForSource(THREE_LEVELS), options: {} },
  { name: 'same-engine', root: elkEngine, input: layoutInputForSource(SAME_ENGINE), options: {} },
  { name: 'grid-in-fixed', root: fixedEngine, input: layoutInputForSource(GRID_IN_FIXED), options: {} },
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
