import { asNodeId, NO_SPAN, type GraphNode, type SemanticGraph } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { createWorkerHost } from '../../src/host.js';
import type { LayoutInput, ResolvedThemeMetricsView } from '../../src/contract.js';

/**
 * DD-06 §10 + the Stage H gate: the same four behaviours `host.test.ts` proves
 * against a fake `Worker` under Node, proven here against a **real** `Worker`
 * (via `fixture.worker.ts`) in Chromium and Firefox. `vitest.config.ts`'s
 * `browser` project (decision D3) is what runs this file twice, once per browser.
 */

function spawn(): Worker {
  return new Worker(new URL('./fixture.worker.ts', import.meta.url), { type: 'module' });
}

const A = asNodeId('a');

function node(): GraphNode {
  return {
    id: A,
    path: ['a'],
    parent: null,
    children: [],
    depth: 0,
    shape: 'rect',
    classes: [],
    labelId: null,
    ports: [],
    config: {},
    hidden: false,
    span: NO_SPAN,
  };
}

const GRAPH: SemanticGraph = {
  nodes: { [A]: node() },
  edges: [],
  rootChildren: [A],
  order: [A],
  labels: {},
  meta: { nodeCount: 1, edgeCount: 0, containerCount: 0 },
};

const INPUT: LayoutInput = { graph: GRAPH, scope: null, sizing: {}, labelSizes: {} };
const METRICS: ResolvedThemeMetricsView = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {}, arrowSize: 8 };

const OK_INPUT: LayoutInput = { graph: { ...GRAPH, nodes: {}, order: [], rootChildren: [] }, scope: null, sizing: {}, labelSizes: {} };

function run(
  host: ReturnType<typeof createWorkerHost>,
  engineId: string,
  input: LayoutInput,
  signal: AbortSignal = new AbortController().signal,
) {
  return host.run(engineId, input, {}, METRICS, {}, signal);
}

describe('createWorkerHost against a real Worker (DD-06 §10)', () => {
  it('timeout terminates and respawns the worker and yields SGL4001, then serves the next request', async () => {
    // A per-engine override, not the host-wide default: `timeoutMs` would also
    // apply to the follow-up `test.ok` request, and under CI/load a real
    // worker's cold boot + module import can eat a meaningful slice of a
    // short host-wide timeout, making that second request flaky (found by the
    // orchestrator: failed once under a full `pnpm check` run, passed 3/3
    // alone). `test.slow` alone gets the short budget; `test.ok` gets the
    // default (10 s), which is not the thing this test is timing.
    const host = createWorkerHost(spawn, { engineTimeoutMs: { 'test.slow': 300 } });
    try {
      const outcome = await run(host, 'test.slow', OK_INPUT);
      expect(outcome.value).toBeNull();
      expect(outcome.diagnostics).toHaveLength(1);
      expect(outcome.diagnostics[0]!.code).toBe('SGL4001');

      // The respawned worker still answers.
      const next = await run(host, 'test.ok', OK_INPUT);
      expect(next.value).not.toBeNull();
      expect(next.diagnostics).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('abort cancels the in-flight request, rejecting with AbortError', async () => {
    const host = createWorkerHost(spawn);
    try {
      const controller = new AbortController();
      const promise = run(host, 'test.slow', OK_INPUT, controller.signal);
      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      host.dispose();
    }
  });

  it('SGL4002: malformed engine output is rejected, and the host serves the next request', async () => {
    const host = createWorkerHost(spawn);
    try {
      const bad = await run(host, 'test.malformed', INPUT);
      expect(bad.value).toBeNull();
      expect(bad.diagnostics.some((d) => d.code === 'SGL4002')).toBe(true);

      const good = await run(host, 'test.ok', OK_INPUT);
      expect(good.value).not.toBeNull();
      expect(good.diagnostics).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('a table miss round-trips through the measure RPC', async () => {
    const host = createWorkerHost(spawn, {
      measure: (runs, box) => {
        expect(runs).toEqual([{ text: 'probe' }]);
        expect(box).toEqual({ maxWidth: 100 });
        return { size: { w: 33, h: 7 }, lines: [] };
      },
    });
    try {
      const outcome = await run(host, 'test.measuring', INPUT);
      expect(outcome.diagnostics).toEqual([]);
      expect(outcome.value?.nodes[A]?.frame).toEqual({ x: 16, y: 16, w: 33, h: 7 });
      expect(outcome.value?.bounds).toEqual({ x: 0, y: 0, w: 33 + 32, h: 7 + 32 });
    } finally {
      host.dispose();
    }
  });

  it('SGL4011: an engine that throws is reported and the host stays usable', async () => {
    const host = createWorkerHost(spawn);
    try {
      const outcome = await run(host, 'test.throws', OK_INPUT);
      expect(outcome.value).toBeNull();
      expect(outcome.diagnostics[0]!.code).toBe('SGL4011');

      const good = await run(host, 'test.ok', OK_INPUT);
      expect(good.value).not.toBeNull();
    } finally {
      host.dispose();
    }
  });
});
