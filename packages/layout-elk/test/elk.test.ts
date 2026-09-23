import { asNodeId, type LabelId } from '@sgl/core';
import {
  createWorkerRuntime,
  EngineRegistry,
  placeLabels,
  quantize,
  validateResult,
  type LayoutInput,
  type WorkerToHost,
} from '@sgl/layout-api';
import { conformanceContext, hierarchyCrossings, runHostSequence } from '@sgl/layout-api/conformance';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { ELK_DEFAULT_OPTIONS } from '../src/descriptor.js';
import { elkEngine } from '../src/index.js';
import { toElkGraph } from '../src/mapping.js';
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

describe('elk over the corpus (DD-06 §6, Stage K gate)', () => {
  for (const doc of DOCS) {
    it(`${doc}: lays out with no layout diagnostics at all (errors or warnings)`, async () => {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      expect(validateResult(result, input.graph, elkEngine.id)).toEqual([]);
    });
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

describe('the hierarchy-crossing warning (DD-06 §6.3, K4)', () => {
  it('counts per corpus document, ORTHOGONAL (logged, never a failure)', async () => {
    const counts: Record<string, number> = {};
    for (const doc of DOCS) {
      const input = layoutInputFor(doc);
      const { result } = await runHostSequence(elkEngine, input, {}, METRICS);
      const n = hierarchyCrossings(input.graph, result).length;
      if (n > 0) counts[doc] = n;
    }
    console.warn(`[K4] hierarchy crossings under ORTHOGONAL, per document with any: ${JSON.stringify(counts)}`);
    expect(counts).toBeTypeOf('object');
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
    expect(Object.keys(out)).toEqual(['ORTHOGONAL', 'POLYLINE']);
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

  it("posts ELK's label placements, not placeLabels' — a centred container title the fallback never produces", async () => {
    const input = layoutInputFor('checkout.sgl');
    const posted = await throughRuntime(input);
    const direct = await engineOutput(input);
    const fallback = placeLabels(input, posted, METRICS);

    const containers = input.graph.order.filter((id) => (input.graph.nodes[id]?.children.length ?? 0) > 0);
    expect(containers.length).toBeGreaterThan(0);
    for (const id of containers) {
      const labelId = input.graph.nodes[id]!.labelId!;
      const got = posted.labels.find((l) => l.labelId === labelId);
      const elk = direct.labels.find((l) => l.labelId === labelId);
      const host = fallback.labels.find((l) => l.labelId === labelId);
      expect(got).toEqual(elk); // what the worker posts is ELK's …
      // … and not what the fallback would have placed: the fallback puts a
      // container title at the content box's left edge with align 'start';
      // ELK centres it over the container.
      expect(got?.align).toBe('middle');
      expect(host?.align).toBe('start');
      expect(got?.frame.x).not.toBe(host?.frame.x);
    }
    // Every other label too — none replaced, none dropped.
    expect(posted.labels).toEqual(direct.labels);
  });
});
