import { asNodeId, type LabelId, type NodeId } from '@sgl/core';
import {
  createWorkerRuntime,
  EngineRegistry,
  placeLabels,
  quantize,
  validateResult,
  type LayoutInput,
  type WorkerToHost,
} from '@sgl/layout-api';
import { conformanceContext, detachedEdges, hierarchyCrossings, runHostSequence, titleCrossings } from '@sgl/layout-api/conformance';
import { gridEngine } from '@sgl/layout-std';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { ELK_DEFAULT_OPTIONS } from '../src/descriptor.js';
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
      const { raw, result } = await runHostSequence(elkEngine, input, {}, METRICS);
      const fromElk = new Map(quantize(raw, 64).labels.map((l) => [l.labelId, l]));
      // The one exception: a self-loop ELK drew under 16 px is replaced by the
      // host's teardrop (DD-06 §6.2), and its label follows the new route.
      const replaced = new Set<LabelId>(
        input.graph.edges
          .filter((e) => e.from.node === e.to.node && e.labelId !== null && JSON.stringify(result.edges[e.id]?.route) !== JSON.stringify(quantize(raw, 64).edges[e.id]?.route))
          .map((e) => e.labelId!),
      );
      for (const label of result.labels) {
        if (replaced.has(label.labelId)) continue;
        expect(label).toEqual(fromElk.get(label.labelId));
      }
      expect(result.labels.map((l) => l.labelId).sort()).toEqual([...fromElk.keys()].sort());
    });
  }
});

/** The K4 baseline (fix round 1, item 10): documents with any hierarchy
 *  crossing under ORTHOGONAL. None today. */
const EXPECTED_HIERARCHY_CROSSINGS: Readonly<Record<string, number>> = {};

/** Item 2's baseline: edges through a container's title text, per document
 *  (any container, the endpoints' own ancestors included). Measured after
 *  item 1 moved titles top-left; no ELK option tried removed the rest
 *  (DD-06 §6.3), so they are a pinned, counted warning. */
const EXPECTED_TITLE_CROSSINGS: Readonly<Record<string, number>> = {
  'checkout.sgl': 2,
  'containers-edges.sgl': 1,
  'nesting-3.sgl': 1,
  'wildcards.sgl': 4,
};

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

  for (const doc of CLEAN_DOCS) {
    it(`${doc}: every directed end sits arrowSize (±0.5) off its node's frame`, async () => {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      for (const edge of input.graph.edges) {
        if (edge.hidden || edge.directed === 'none' || edge.from.node === edge.to.node) continue;
        const layout = result.edges[edge.id]!;
        const head = toFrame(layout.end, result.nodes[edge.to.node]!.frame);
        expect(Math.abs(head - METRICS.arrowSize), `${edge.id} head ${head}`).toBeLessThanOrEqual(0.5);
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
