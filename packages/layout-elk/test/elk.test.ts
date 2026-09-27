import { asNodeId, type LabelId, type NodeId } from '@sgl/core';
import {
  applyHostFallbacks,
  createWorkerRuntime,
  EngineRegistry,
  MIN_SELF_LOOP_HEIGHT,
  placeLabels,
  quantize,
  validateResult,
  type EdgeLayout,
  type LayoutInput,
  type LayoutResult,
  type WorkerToHost,
} from '@sgl/layout-api';
import { conformanceContext, detachedEdges, hierarchyCrossings, runHostSequence, titleCrossings } from '@sgl/layout-api/conformance';
import { gridEngine } from '@sgl/layout-std';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { ELK_DEFAULT_OPTIONS, normalizeElkOptions } from '../src/descriptor.js';
import { elkEngine } from '../src/index.js';
import { loadElk } from '../src/load-elk.js';
import { fromElkGraph, toElkGraph, type ElkNode } from '../src/mapping.js';
import { layoutInputFor, layoutInputForSource, METRICS, withContainerMin } from './corpus-input.js';

/**
 * The real elkjs over the whole corpus (Stage K gate, T2): every document lays
 * out and validates, the input and output goldens (DD-06 §10), labels come
 * from ELK (K5), and the hierarchy-crossing warning count (K4).
 */

const DOCS = listCorpusDocs();

/** ELK's own output, quantized: the engine half of the seam, before any host
 *  fallback. */
async function engineOutput(input: LayoutInput, options: Readonly<Record<string, unknown>> = {}) {
  return (await runHostSequence(elkEngine, input, options, METRICS)).raw;
}

type Pt = { readonly x: number; readonly y: number };
const pointsOf = (layout: EdgeLayout): Pt[] => [layout.start, ...layout.route.map((s) => (s as { readonly to: Pt }).to)];
const within = (a: number, b: number, c: number, d: number): boolean => Math.max(Math.min(a, b), Math.min(c, d)) <= Math.min(Math.max(a, b), Math.max(c, d)) + 1e-6;
/** Whether the boxes spanned by `p–q` and `r–s` meet (touching counts). */
const meet = (p: Pt, q: Pt, r: Pt, s: Pt): boolean => within(p.x, q.x, r.x, s.x) && within(p.y, q.y, r.y, s.y);

/** Every pair of edges whose routes meet anywhere, as `a|b`. */
function meetingPairs(result: LayoutResult): Set<string> {
  const routes = Object.entries(result.edges).sort(([a], [b]) => (a < b ? -1 : 1));
  const out = new Set<string>();
  routes.forEach(([a, la], i) => {
    const pa = pointsOf(la);
    for (const [b, lb] of routes.slice(i + 1)) {
      const pb = pointsOf(lb);
      if (pa.some((p, k) => k > 0 && pb.some((q, l) => l > 0 && meet(pa[k - 1]!, p, pb[l - 1]!, q)))) out.add(`${a}|${b}`);
    }
  });
  return out;
}

/** ELK's own output mapped without and with F16's title detours. */
function mapBothWays(input: LayoutInput, out: ElkNode) {
  return {
    plain: fromElkGraph(input, JSON.parse(JSON.stringify(out)) as ElkNode),
    detoured: fromElkGraph(input, JSON.parse(JSON.stringify(out)) as ElkNode, METRICS.arrowSize),
  };
}

/** Every container's title text box, shrunk 0.5 px as `titleCrossings`
 *  tests it, by container. */
function containerTitles(input: LayoutInput, result: LayoutResult): [NodeId, { x: number; y: number; w: number; h: number }][] {
  const out: [NodeId, { x: number; y: number; w: number; h: number }][] = [];
  for (const id of input.graph.order) {
    const node = input.graph.nodes[id]!;
    if (node.hidden || node.labelId === null || !node.children.some((c) => input.graph.nodes[c]?.hidden === false)) continue;
    const f = result.labels.find((l) => l.labelId === node.labelId)!.frame;
    out.push([id, { x: f.x + 0.5, y: f.y + 0.5, w: f.w - 1, h: f.h - 1 }]);
  }
  return out;
}

const LONG = '"A rather long container title for this box"';
/** Documents for F16's fix round 1, each driving one detour shape. */
const F16_SOURCES: Readonly<Record<string, string>> = {
  // Item 1: `c` is narrower than the title and wholly under it, so the run
  // cannot end on its top right of the title: it enters `c`'s side.
  'f16-narrow': `top\nbox: {\n  @label: ${LONG}\n  c\n}\ntop -> box.c\n`,
  // A run that goes on to another bend (`top -> box.d`) turns back below the
  // title, beside `top -> box.c`, which enters `c`'s side.
  'f16-turn-back': `top\nbox: {\n  @label: ${LONG}\n  c\n  d\n}\ntop -> box.c\ntop -> box.d\nbox.c -> box.d\n`,
};

/** `finishEngineRoutes`' own test for a self-loop the host replaces (DD-06 §4.5). */
function isShortLoopRoute(layout: { readonly route: readonly { readonly to: { readonly y: number } }[]; readonly start: { readonly y: number } } | undefined): boolean {
  if (layout === undefined) return false;
  if (layout.route.length < 2) return true;
  const ys = [layout.start.y, ...layout.route.map((s) => s.to.y)];
  return Math.max(...ys) - Math.min(...ys) < MIN_SELF_LOOP_HEIGHT;
}

describe('loading elkjs (K1, K11)', () => {
  it('leaves no document stub behind once elk has loaded, and the layout succeeded', async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    const input = layoutInputFor('checkout.sgl');
    const raw = await elkEngine.layout(input, conformanceContext({}, METRICS));
    expect(Object.keys(raw.nodes).length).toBeGreaterThan(0);
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
  });
});

describe('elk over the corpus (DD-06 §6, Stage K gate)', () => {
  for (const doc of DOCS) {
    it(`${doc}: lays out with no layout diagnostics at all (errors or warnings)`, async () => {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      expect(validateResult(result, input.graph, elkEngine.id)).toEqual([]);
      // n2000.sgl takes ~2 s alone and past Vitest's 5 s default under the
      // full parallel run (fix round 1: seen failing at 5.5 s in a clean run).
    }, 30_000);
  }

  for (const doc of CLEAN_DOCS) {
    it(`${doc}: input golden (the ElkNode JSON sent to ELK)`, async () => {
      const graph = toElkGraph(layoutInputFor(doc), ELK_DEFAULT_OPTIONS, METRICS);
      await expect(`${JSON.stringify(graph, null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/input/${doc}.json`);
    });

    it(`${doc}: output golden (the engine's LayoutResult, quantized)`, async () => {
      const raw = await engineOutput(layoutInputFor(doc));
      await expect(`${JSON.stringify(quantize(raw, 64), null, 2)}\n`).toMatchFileSnapshot(`./__goldens__/result/${doc}.json`);
    });

    it(`${doc}: every label is ELK's, not the host fallback's (K5)`, async () => {
      const input = layoutInputFor(doc);
      const { raw, result: hosted } = await runHostSequence(elkEngine, input, {}, METRICS);
      // Compared before `quantize`: its host-computed `bounds` (DD-06 §5, F14)
      // translate every coordinate by an amount that depends on everything
      // drawn — the host's own teardrops included — so the engine-only and the
      // hosted results are translated differently.
      const result = applyHostFallbacks(input, raw, elkEngine.capabilities, METRICS);
      const fromElk = new Map(raw.labels.map((l) => [l.labelId, l]));
      // The one exception: a self-loop ELK drew under 16 px is replaced by the
      // host's teardrop (DD-06 §6.2), and its label follows the new route.
      const replaced = new Set<LabelId>(
        input.graph.edges
          .filter((e) => e.from.node === e.to.node && e.labelId !== null && isShortLoopRoute(raw.edges[e.id]))
          .map((e) => e.labelId!),
      );
      for (const label of result.labels) {
        if (replaced.has(label.labelId)) continue;
        expect(label).toEqual(fromElk.get(label.labelId));
      }
      expect(result.labels.map((l) => l.labelId).sort()).toEqual([...fromElk.keys()].sort());

      // And on the whole host path (fix round 1, item 9): the real
      // `runHostSequence` result, with `quantize`'s translation undone, still
      // carries ELK's own labels, quantized. The translation is read off a
      // node frame, which no host fallback moves.
      const q = (v: number): number => Math.round(v * 64) / 64;
      const anyNode = Object.keys(raw.nodes).sort()[0];
      if (anyNode === undefined) return;
      const rawFrame = raw.nodes[anyNode as keyof typeof raw.nodes]!.frame;
      const hostFrame = hosted.nodes[anyNode as keyof typeof hosted.nodes]!.frame;
      const dx = hostFrame.x - q(rawFrame.x);
      const dy = hostFrame.y - q(rawFrame.y);
      expect(Number.isInteger(dx * 64) && Number.isInteger(dy * 64)).toBe(true);
      for (const label of hosted.labels) {
        if (replaced.has(label.labelId)) continue;
        const elk = fromElk.get(label.labelId)!;
        expect({ ...label, frame: { ...label.frame, x: label.frame.x - dx, y: label.frame.y - dy } }).toEqual({
          ...elk,
          frame: { x: q(elk.frame.x), y: q(elk.frame.y), w: q(elk.frame.w), h: q(elk.frame.h) },
        });
      }
      expect(hosted.labels.map((l) => l.labelId).sort()).toEqual([...fromElk.keys()].sort());
    });
  }
});

/** The K4 baseline (fix round 1, item 10): documents with any hierarchy
 *  crossing under ORTHOGONAL. None today. */
const EXPECTED_HIERARCHY_CROSSINGS: Readonly<Record<string, number>> = {};

/** Item 2's baseline: edges through a container's title text, per document
 *  (any container, the endpoints' own ancestors included). Pinned at 13 over
 *  six documents until F16: ELK routes an edge into a container straight
 *  through the title band it does not know about, and `fromElkGraph` now
 *  detours those runs around the title inside the band (DD-06 §6.2). What is
 *  left cannot be detoured without meeting another route: in `wildcards`,
 *  ELK runs three more edges into `lane2` 0.4–20 px right of its title, and
 *  one more into `fan2` 0.8 px right of its title (F16 fix round 1, item 2). */
const EXPECTED_TITLE_CROSSINGS: Readonly<Record<string, number>> = { 'wildcards.sgl': 4 };

/** The same four, by edge (F16 fix round 1): the only edges left running
 *  through the title of a container that holds one of their ends. */
const EXPECTED_OWN_TITLE_CROSSINGS: readonly string[] = [
  "wildcards.sgl: fan1.x -> fan2.m through 'fan2'",
  "wildcards.sgl: lane1.a -> lane2.x through 'lane2'",
  "wildcards.sgl: lane1.b -> lane2.x through 'lane2'",
  "wildcards.sgl: lane1.b -> lane2.y through 'lane2'",
];

describe('the hierarchy-crossing warning (DD-06 §6.3, K4)', () => {
  it('title crossings per corpus document (fix round 1, item 2; logged and pinned, never a layout failure)', async () => {
    const counts: Record<string, number> = {};
    for (const doc of DOCS) {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      const n = titleCrossings(input, result).length;
      if (n > 0) counts[doc] = n;
    }
    console.warn(`[K4] title crossings under ORTHOGONAL, per document with any: ${JSON.stringify(counts)}`);
    expect(counts).toEqual(EXPECTED_TITLE_CROSSINGS);
  }, 60_000);

  it('no edge enters or leaves a container through that container’s own title, over the corpus, but the pinned ones (F16)', async () => {
    const offenders: string[] = [];
    for (const doc of DOCS) {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      const ancestors = (id: NodeId): Set<NodeId> => {
        const out = new Set<NodeId>();
        for (let at = input.graph.nodes[id]?.parent ?? null; at !== null; at = input.graph.nodes[at]?.parent ?? null) out.add(at);
        return out;
      };
      const byId = new Map(input.graph.edges.map((e) => [e.id, e]));
      for (const c of titleCrossings(input, result)) {
        const edge = byId.get(c.edge)!;
        if (ancestors(edge.from.node).has(c.container) || ancestors(edge.to.node).has(c.container)) {
          offenders.push(`${doc}: ${edge.from.node} -> ${edge.to.node} through '${c.container}'`);
        }
      }
    }
    expect(offenders.sort()).toEqual(EXPECTED_OWN_TITLE_CROSSINGS);
  }, 60_000);

  it('a title detour never makes two routes meet that did not meet before, over the corpus (F16 fix round 1, item 2)', async () => {
    const elk = await loadElk();
    const added: string[] = [];
    for (const doc of DOCS) {
      const input = layoutInputFor(doc);
      const { plain, detoured } = mapBothWays(input, (await elk.layout(toElkGraph(input, ELK_DEFAULT_OPTIONS, METRICS))) as ElkNode);
      const before = meetingPairs(plain);
      for (const pair of meetingPairs(detoured)) if (!before.has(pair)) added.push(`${doc}: ${pair}`);
    }
    expect(added).toEqual([]);
  }, 60_000);

  it('nested-crossing.sgl exercises an edge ELK reports in a non-root container, and it stays attached', async () => {
    const input = layoutInputFor('nested-crossing.sgl');
    const out = await (await loadElk()).layout(JSON.parse(JSON.stringify(toElkGraph(input, ELK_DEFAULT_OPTIONS, METRICS))) as ElkNode);
    const containers = (out.edges ?? []).map((e) => e.container);
    expect(containers.some((c) => c !== undefined && c !== 'root')).toBe(true);
    const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
    expect(detachedEdges(input.graph, result, METRICS.arrowSize)).toEqual([]);
    expect(validateResult(result, input.graph, elkEngine.id)).toEqual([]);
  });

  it('counts per corpus document, ORTHOGONAL (logged, never a failure)', async () => {
    const counts: Record<string, number> = {};
    for (const doc of DOCS) {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      const n = hierarchyCrossings(input.graph, result).length;
      if (n > 0) counts[doc] = n;
    }
    console.warn(`[K4] hierarchy crossings under ORTHOGONAL, per document with any: ${JSON.stringify(counts)}`);
    // Pinned (fix round 1, item 10): a warning, not a failure of the layout —
    // but a change in the count is a change to review, not to miss.
    expect(counts).toEqual(EXPECTED_HIERARCHY_CROSSINGS);
  }, 60_000);

  it('containers-edges.sgl under ORTHOGONAL and POLYLINE (the escape hatch, 06 §4 pitfall 8)', async () => {
    const input = layoutInputFor('containers-edges.sgl');
    const out: Record<string, number> = {};
    for (const edgeRouting of ['ORTHOGONAL', 'POLYLINE'] as const) {
      const { result } = await runHostSequence(elkEngine, input, { edgeRouting }, METRICS);
      expect(validateResult(result, input.graph, elkEngine.id)).toEqual([]);
      out[edgeRouting] = hierarchyCrossings(input.graph, result).length;
    }
    console.warn(`[K4] containers-edges.sgl crossings: ${JSON.stringify(out)}`);
    expect(out).toEqual({ ORTHOGONAL: 0, POLYLINE: 0 });
  });
});

describe('F16: routes round a container title, with the real ELK (DD-06 §6.2; F16 fix round 1)', () => {
  /** ELK's output for a source, mapped without and with the detours. */
  async function both(source: string, options: Readonly<Record<string, unknown>> = {}) {
    const input = layoutInputForSource(source);
    const out = (await (await loadElk()).layout(toElkGraph(input, normalizeElkOptions(options), METRICS))) as ElkNode;
    return { input, ...mapBothWays(input, out) };
  }
  const added = (plain: LayoutResult, detoured: LayoutResult): string[] => {
    const before = meetingPairs(plain);
    return [...meetingPairs(detoured)].filter((pair) => !before.has(pair));
  };

  it('item 2: parallel edges into one container are detoured where they fit, and never so as to meet another route', async () => {
    const children = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const sources = children.map((c) => `s${c}`);
    const doc = (title: string) =>
      `${sources.join('\n')}\nbox: {\n  @label: "${title}"\n  ${children.join('\n  ')}\n}\n${children.map((c, i) => `${sources[i]} -> box.${c}`).join('\n')}\n`;
    // A title wider than all six children: only the rightmost run can pass it.
    const wide = await both(doc('An extremely long container title that goes on and on and on, far wider than all six of its children put together, yes'));
    expect(titleCrossings(wide.input, wide.plain)).toHaveLength(6);
    expect(titleCrossings(wide.input, wide.detoured)).toHaveLength(5);
    expect(added(wide.plain, wide.detoured)).toEqual([]);
    // Three edges into one child wider than the title: all three fit.
    const fits = await both(
      's1\ns2\ns3\nbox: {\n  @label: "A rather longer medium container title here"\n  wide: "a wide child node with a rather long label indeed"\n}\ns1 -> box.wide\ns2 -> box.wide\ns3 -> box.wide\n',
    );
    expect(titleCrossings(fits.input, fits.plain)).toHaveLength(3);
    expect(titleCrossings(fits.input, fits.detoured)).toEqual([]);
    expect(added(fits.plain, fits.detoured)).toEqual([]);
  });

  describe('item 4: a thin band holds a detour when one fits, and leaves the route alone when none does', () => {
    for (const [style, room] of [
      ['@style.titleGap: 0', true],
      ['@style.titleGap: 1\n  @style.fontSize: 4', true],
      ['@style.padding: 0', false],
    ] as const) {
      it(style.replace('\n  ', ', '), async () => {
        const { input, plain, detoured } = await both(`top\nbox: {\n  @label: ${LONG}\n  ${style}\n  c\n}\ntop -> box.c\n`);
        expect(titleCrossings(input, plain)).toHaveLength(1);
        if (room) expect(titleCrossings(input, detoured)).toEqual([]);
        else expect(detoured).toEqual(plain);
      });
    }
  });

  it('item 5: detours under ORTHOGONAL and POLYLINE (vertices), never under SPLINES (control points)', async () => {
    const input = layoutInputFor('checkout.sgl');
    const elk = await loadElk();
    for (const edgeRouting of ['ORTHOGONAL', 'POLYLINE', 'SPLINES'] as const) {
      const out = (await elk.layout(toElkGraph(input, normalizeElkOptions({ edgeRouting }), METRICS))) as ElkNode;
      const { plain, detoured } = mapBothWays(input, out);
      // Not vacuous: in each mode the detour would change checkout's routes.
      expect(detoured, edgeRouting).not.toEqual(plain);
      const engine = await elkEngine.layout(input, conformanceContext({ edgeRouting }, METRICS));
      expect(engine, edgeRouting).toEqual(edgeRouting === 'SPLINES' ? plain : detoured);
    }
  });

  it('item 7: an upward run (direction up) is detoured at its source end', async () => {
    const { input, plain, detoured } = await both(`top\nbox: {\n  @label: ${LONG}\n  c\n}\nbox.c -> top\n`, { direction: 'up' });
    const [edge] = input.graph.edges;
    expect(titleCrossings(input, plain)).toHaveLength(1);
    expect(titleCrossings(input, detoured)).toEqual([]);
    // The end at `top` is ELK's; the start, in `c`, moved.
    expect(detoured.edges[edge!.id]!.end).toEqual(plain.edges[edge!.id]!.end);
    expect(detoured.edges[edge!.id]!.start).not.toEqual(plain.edges[edge!.id]!.start);
  });

  it('item 7: nested titles: the run is detoured round each, outer first, and ends in its node\'s side', async () => {
    const { input, plain, detoured } = await both(
      'top\nouter: {\n  @label: "A long outer container title here"\n  inner: {\n    @label: "A long inner title"\n    leaf\n  }\n}\ntop -> outer.inner.leaf\n',
    );
    const [edge] = input.graph.edges;
    expect(titleCrossings(input, plain)).toHaveLength(2);
    expect(titleCrossings(input, detoured)).toEqual([]);
    // Round the outer title and back (its end is deep enough for the
    // arrowhead), then round the inner one into the leaf's side. Each detour
    // stays in its own band, so taking the inner title first gives the same
    // route; this pins it.
    expect(pointsOf(detoured.edges[edge!.id]!).map((p) => [p.x, p.y])).toEqual([
      [80, 48],
      [80, 131],
      [212.09375, 131],
      [212.09375, 157.59375],
      [80, 157.59375],
      [80, 173.59375],
      [140.921875, 173.59375],
      [140.921875, 221.2],
      [116, 221.2],
    ]);
  });
});

describe('elk options reach ELK', () => {
  it('every option changes the layout of a document it can affect', async () => {
    const input = layoutInputFor('forty-three-level.sgl');
    const base = JSON.stringify(await engineOutput(input));
    for (const change of [
      { direction: 'right' },
      { nodeSpacing: 80 },
      { rankSpacing: 20 },
      { edgeRouting: 'POLYLINE' },
      { nodePlacement: 'LINEAR_SEGMENTS' },
    ]) {
      expect(JSON.stringify(await engineOutput(input, change)), JSON.stringify(change)).not.toBe(base);
    }
  });

  it('honours a container minimum size under DOWN and RIGHT (the swap in toElkGraph is needed and correct)', async () => {
    const input = withContainerMin(layoutInputForSource('box: {\n  a\n}\n'), 'box', { w: 300, h: 50 });
    for (const direction of ['down', 'right']) {
      const frame = (await engineOutput(input, { direction })).nodes[asNodeId('box')]?.frame;
      expect(frame?.w, direction).toBeGreaterThanOrEqual(300);
      expect(frame?.h, direction).toBeGreaterThanOrEqual(50);
      expect(frame?.h, direction).toBeLessThan(300);
    }
  });
});

describe('errors are values', () => {
  it('an ELK exception reaches the host as SGL4011 through the worker runtime, never an uncaught throw', async () => {
    const base = layoutInputFor('chains.sgl');
    const first = base.graph.edges[0]!;
    // An edge to a node ELK was never sent: ELK throws on it.
    const input: LayoutInput = { ...base, graph: { ...base.graph, edges: [{ ...first, to: { node: asNodeId('nowhere') } }] } };
    await expect(elkEngine.layout(input, conformanceContext({}, METRICS))).rejects.toThrow();

    const registry = new EngineRegistry();
    registry.register(elkEngine);
    const sent: WorkerToHost[] = [];
    const runtime = createWorkerRuntime(registry, { post: (m) => sent.push(m) });
    runtime.receive({ t: 'layout', id: 1, engine: elkEngine.id, input, options: {}, metrics: METRICS, table: {}, seed: 1 });
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ t: 'error', id: 1, diagnostic: { code: 'SGL4011', severity: 'error' } });
  });
});

describe('labels come from ELK through the real worker runtime (K5, second half)', () => {
  /** A `labelPlacement: true` engine must never have its labels replaced by
   *  `placeLabels` (DD-06 §4.1) — the seam Stage H fixed once already. The
   *  runtime is the real one; the engine is the real elk. */
  async function throughRuntime(input: LayoutInput) {
    const registry = new EngineRegistry();
    registry.register(elkEngine);
    const sent: WorkerToHost[] = [];
    const runtime = createWorkerRuntime(registry, { post: (m) => sent.push(m) });
    runtime.receive({ t: 'layout', id: 7, engine: elkEngine.id, input, options: {}, metrics: METRICS, table: {}, seed: 1 });
    await expect.poll(() => sent.length, { timeout: 10_000 }).toBe(1);
    const message = sent[0]!;
    if (message.t !== 'result') throw new Error(`expected a result, got ${JSON.stringify(message)}`);
    return message.result;
  }

  it("posts ELK's label placements, not placeLabels' — edge labels the fallback would put elsewhere", async () => {
    const input = layoutInputFor('checkout.sgl');
    const posted = await throughRuntime(input);
    const direct = await engineOutput(input);
    const fallback = placeLabels(input, posted, METRICS);

    // What the worker posts is exactly the engine's own output: nothing replaced, nothing dropped.
    expect(posted.labels).toEqual(direct.labels);
    // And it is not what the fallback would have placed: every edge label
    // ELK placed differs from placeLabels' midpoint-and-offset placement.
    const edgeLabels = input.graph.edges.filter((e) => e.labelId !== null).map((e) => e.labelId!);
    expect(edgeLabels.length).toBeGreaterThan(0);
    for (const labelId of edgeLabels) {
      const got = posted.labels.find((l) => l.labelId === labelId);
      const host = fallback.labels.find((l) => l.labelId === labelId);
      expect(got, labelId).toBeDefined();
      expect(got?.frame, labelId).not.toEqual(host?.frame);
    }
  });
});

describe('container titles top-left, as grid places them (fix round 1, item 1)', () => {
  for (const doc of CLEAN_DOCS) {
    it(`${doc}: every container title has grid's alignment and inset`, async () => {
      const input = layoutInputFor(doc);
      const elk = (await runHostSequence(elkEngine, input, {}, METRICS)).result;
      const grid = (await runHostSequence(gridEngine, input, {}, METRICS)).result;
      for (const id of input.graph.order) {
        const node = input.graph.nodes[id]!;
        if (node.hidden || node.labelId === null || !node.children.some((c) => input.graph.nodes[c]?.hidden === false)) continue;
        const inset = (r: typeof elk) => {
          const l = r.labels.find((p) => p.labelId === node.labelId)!;
          const f = r.nodes[id]!.frame;
          return { align: l.align, baseline: l.baseline, dx: l.frame.x - f.x, dy: l.frame.y - f.y, w: l.frame.w, h: l.frame.h };
        };
        expect(inset(elk), id).toEqual(inset(grid));
        expect(inset(elk).align).toBe('start');
      }
    });
  }

  it('the reviewer\'s [H_LEFT, V_TOP, INSIDE, V_PRIORITY] lays out byte-identically to sending no title at all (V_PRIORITY is not an ELK placement; ELK ignores the whole value)', async () => {
    const elk = await loadElk();
    for (const doc of ['checkout.sgl', 'nesting-3.sgl', 'forty-three-level.sgl']) {
      const input = layoutInputFor(doc);
      const graph = toElkGraph(input, ELK_DEFAULT_OPTIONS, METRICS);
      const withTitles = (n: ElkNode): ElkNode => {
        const node = input.graph.nodes[n.id as NodeId];
        const isContainer = (n.children?.length ?? 0) > 0;
        const size = node?.labelId ? input.labelSizes[node.labelId] : undefined;
        return {
          ...n,
          ...(isContainer && size !== undefined && node?.labelId
            ? { labels: [{ text: node.labelId, width: size.w, height: size.h, layoutOptions: { 'elk.nodeLabels.placement': '[H_LEFT, V_TOP, INSIDE, V_PRIORITY]' } }] }
            : {}),
          ...(n.children && { children: n.children.map(withTitles) }),
        };
      };
      const a = fromElkGraph(input, await elk.layout(JSON.parse(JSON.stringify(graph)) as ElkNode));
      const b = fromElkGraph(input, await elk.layout(withTitles(graph)));
      expect(JSON.stringify(b.nodes), doc).toBe(JSON.stringify(a.nodes));
      expect(JSON.stringify(b.edges), doc).toBe(JSON.stringify(a.edges));
    }
  });
});

describe('arrowheads are reserved exactly once, end to end (fix round 1, item 12)', () => {
  /** Distance from `p` to the nearest point of `r` (0 inside). */
  const toFrame = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) =>
    Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h)));

  // The corpus, and F16's detours that end on a node (F16 fix round 1,
  // item 1): into a node's side, and beside a run that turns back.
  const docs: [string, () => LayoutInput][] = [
    ...CLEAN_DOCS.map((doc): [string, () => LayoutInput] => [doc, () => layoutInputFor(doc)]),
    ...Object.entries(F16_SOURCES).map(([name, source]): [string, () => LayoutInput] => [name, () => layoutInputForSource(source)]),
  ];
  for (const [doc, inputOf] of docs) {
    it(`${doc}: every directed end sits arrowSize (±0.5) off its node's frame, and no arrowhead meets a container title`, async () => {
      const input = inputOf();
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      const titles = containerTitles(input, result);
      // Only a detour is ours: ELK's own routes may end with an arrowhead
      // beside a title (nesting-3, wildcard-paths).
      const { plain, detoured } = mapBothWays(input, (await (await loadElk()).layout(toElkGraph(input, ELK_DEFAULT_OPTIONS, METRICS))) as ElkNode);
      for (const edge of input.graph.edges) {
        if (edge.hidden || edge.directed === 'none' || edge.from.node === edge.to.node) continue;
        const layout = result.edges[edge.id]!;
        const head = toFrame(layout.end, result.nodes[edge.to.node]!.frame);
        expect(Math.abs(head - METRICS.arrowSize), `${edge.id} head ${head}`).toBeLessThanOrEqual(0.5);
        // The arrowhead: arrowSize long from the end, 0.75 x arrowSize wide.
        const n = layout.endNormal;
        const half = 0.375 * METRICS.arrowSize;
        const tip = { x: layout.end.x + n.x * METRICS.arrowSize, y: layout.end.y + n.y * METRICS.arrowSize };
        const lo = { x: Math.min(layout.end.x, tip.x) - half * Math.abs(n.y), y: Math.min(layout.end.y, tip.y) - half * Math.abs(n.x) };
        const hi = { x: Math.max(layout.end.x, tip.x) + half * Math.abs(n.y), y: Math.max(layout.end.y, tip.y) + half * Math.abs(n.x) };
        const ours = JSON.stringify(plain.edges[edge.id]) !== JSON.stringify(detoured.edges[edge.id]);
        for (const [id, r] of ours ? titles : []) {
          expect(meet(lo, hi, r, { x: r.x + r.w, y: r.y + r.h }), `${edge.id}'s arrowhead meets ${id}'s title`).toBe(false);
        }
        if (edge.directed === 'both') {
          const tail = toFrame(layout.start, result.nodes[edge.from.node]!.frame);
          expect(Math.abs(tail - METRICS.arrowSize), `${edge.id} tail ${tail}`).toBeLessThanOrEqual(0.5);
        }
      }
    });
  }
});

describe('abort (fix round 1, item 7)', () => {
  it('rejects with an AbortError once elk has loaded, before calling ELK, and keeps the loaded instance', async () => {
    const input = layoutInputFor('checkout.sgl');
    await loadElk();
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...conformanceContext({}, METRICS), signal: controller.signal };
    await expect(elkEngine.layout(input, ctx)).rejects.toMatchObject({ name: 'AbortError' });
    // The same instance serves the next request.
    const first = await loadElk();
    await elkEngine.layout(input, conformanceContext({}, METRICS));
    expect(await loadElk()).toBe(first);
  });

  it("through the worker runtime, an aborted request is an 'error' message, not a crash", async () => {
    const registry = new EngineRegistry();
    registry.register(elkEngine);
    const sent: WorkerToHost[] = [];
    const runtime = createWorkerRuntime(registry, { post: (m) => sent.push(m) });
    runtime.receive({ t: 'layout', id: 3, engine: elkEngine.id, input: layoutInputFor('checkout.sgl'), options: {}, metrics: METRICS, table: {}, seed: 1 });
    runtime.receive({ t: 'abort', id: 3 });
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ t: 'error', id: 3 });
  });
});
