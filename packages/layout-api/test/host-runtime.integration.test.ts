import { asNodeId, NO_SPAN, type GraphNode, type SemanticGraph } from '@sgl/core';
import { describe, expect, it, vi } from 'vitest';
import { LAYOUT_API_VERSION, type LayoutEngine, type LayoutInput, type ResolvedThemeMetricsView } from '../src/contract.js';
import { createWorkerHost } from '../src/host.js';
import type { HostToWorker, WorkerToHost } from '../src/protocol.js';
import { EngineRegistry } from '../src/registry.js';
import { createWorkerRuntime } from '../src/worker-runtime.js';

/**
 * Wires the **real** `createWorkerHost` to a **real** `createWorkerRuntime`
 * through an in-memory channel with genuinely asynchronous delivery
 * (`queueMicrotask`, not a synchronous `emit()` call the way `host.test.ts`'s
 * `FakeWorker` drives the host in isolation) — so protocol drift between the
 * two halves is caught by `pnpm test:unit`, at Node speed, not only by the
 * browser project against a real `Worker` (Stage H fix round 1, item 7).
 *
 * `host.test.ts` and `worker-runtime.test.ts` each already prove their own
 * half thoroughly with a fake counterpart; this file is deliberately thin —
 * the four gate conditions plus item 1's stale-`'measure'`-after-supersede
 * case, nothing `host.browser.test.ts` doesn't already cover more slowly in a
 * real browser.
 */

type MessageListener = (ev: { readonly data: WorkerToHost }) => void;

/** A `Worker`-shaped channel with a real `createWorkerRuntime` behind it,
 *  every hop delivered via `queueMicrotask` — closer to a real `postMessage`'s
 *  timing than a same-tick `FakeWorker.emit()` call. */
class InMemoryWorkerChannel {
  #hostListeners: MessageListener[] = [];
  readonly #runtime: ReturnType<typeof createWorkerRuntime>;
  #terminated = false;

  constructor(registry: EngineRegistry) {
    this.#runtime = createWorkerRuntime(registry, {
      post: (message) => {
        queueMicrotask(() => {
          if (this.#terminated) return;
          for (const listener of this.#hostListeners) listener({ data: message });
        });
      },
    });
  }

  postMessage(message: HostToWorker): void {
    queueMicrotask(() => {
      if (this.#terminated) return;
      this.#runtime.receive(message);
    });
  }

  addEventListener(_type: 'message', listener: MessageListener): void {
    this.#hostListeners.push(listener);
  }

  terminate(): void {
    this.#terminated = true;
  }
}

function capabilities(): LayoutEngine['capabilities'] {
  return { containers: false, edgeRouting: 'straight', ports: false, labelPlacement: false, incremental: false, determinism: 'bitwise' };
}

function makeRegistry(extra?: LayoutEngine): EngineRegistry {
  const registry = new EngineRegistry();
  const EMPTY_RESULT = { bounds: { x: 0, y: 0, w: 10, h: 10 }, nodes: {}, edges: {}, labels: [] };

  registry.register({ id: 'test.ok', name: 'test.ok', version: '0.0.0', apiVersion: LAYOUT_API_VERSION, capabilities: capabilities(), layout: () => Promise.resolve(EMPTY_RESULT) });
  registry.register({ id: 'test.slow', name: 'test.slow', version: '0.0.0', apiVersion: LAYOUT_API_VERSION, capabilities: capabilities(), layout: () => new Promise(() => {}) });
  registry.register({
    id: 'test.malformed',
    name: 'test.malformed',
    version: '0.0.0',
    apiVersion: LAYOUT_API_VERSION,
    capabilities: capabilities(),
    layout: () => Promise.resolve({ bounds: { x: 0, y: 0, w: 1, h: 1 }, nodes: {}, edges: {}, labels: [] }),
  });
  registry.register({
    id: 'test.measuring',
    name: 'test.measuring',
    version: '0.0.0',
    apiVersion: LAYOUT_API_VERSION,
    capabilities: capabilities(),
    layout: async (_input, ctx) => {
      const layout = (await ctx.measure.layoutRunsAsync([{ text: 'probe' }], { maxWidth: 100 })) as { size: { w: number; h: number } };
      // The measured size comes back as node `a`'s frame: `bounds` itself is
      // recomputed by the host (DD-06 §5, F14), so it cannot carry it.
      return { bounds: { x: 0, y: 0, w: 1, h: 1 }, nodes: { a: { frame: { x: 0, y: 0, w: layout.size.w, h: layout.size.h } } }, edges: {}, labels: [] };
    },
  });
  if (extra !== undefined) registry.register(extra);
  return registry;
}

function spawnFor(registry: EngineRegistry): () => Worker {
  return () => new InMemoryWorkerChannel(registry) as unknown as Worker;
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
const OK_INPUT: LayoutInput = { graph: { ...GRAPH, nodes: {}, order: [], rootChildren: [] }, scope: null, sizing: {}, labelSizes: {} };
const METRICS: ResolvedThemeMetricsView = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {}, arrowSize: 8 };

function run(host: ReturnType<typeof createWorkerHost>, engineId: string, input: LayoutInput, signal: AbortSignal = new AbortController().signal) {
  return host.run(engineId, input, {}, METRICS, {}, signal);
}

describe('createWorkerHost + createWorkerRuntime, wired through an async in-memory channel (Stage H fix round 1, item 7)', () => {
  it('timeout terminates and respawns, yields SGL4001, then serves the next request', async () => {
    const registry = makeRegistry();
    const host = createWorkerHost(spawnFor(registry), { engineTimeoutMs: { 'test.slow': 30 } });
    try {
      const outcome = await run(host, 'test.slow', OK_INPUT);
      expect(outcome.value).toBeNull();
      expect(outcome.diagnostics[0]!.code).toBe('SGL4001');

      const next = await run(host, 'test.ok', OK_INPUT);
      expect(next.value).not.toBeNull();
      expect(next.diagnostics).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('abort cancels the in-flight request, rejecting with AbortError', async () => {
    const registry = makeRegistry();
    const host = createWorkerHost(spawnFor(registry));
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
    const registry = makeRegistry();
    const host = createWorkerHost(spawnFor(registry));
    try {
      const bad = await run(host, 'test.malformed', INPUT);
      expect(bad.value).toBeNull();
      expect(bad.diagnostics.some((d) => d.code === 'SGL4002')).toBe(true);

      const good = await run(host, 'test.ok', OK_INPUT);
      expect(good.value).not.toBeNull();
    } finally {
      host.dispose();
    }
  });

  it('fix round 2, item 2: an engine resolving undefined gives SGL4002 (not SGL4011), and the host serves the next request', async () => {
    // Through the real worker, not a fake one that skips the fallbacks
    // entirely: `routeStraight`/`placeLabels` assume `result.edges` etc.
    // already exist, so without the worker-side shape guard this made
    // `routeStraight` throw inside `worker-runtime.ts`'s own try/catch,
    // turning a validation-shaped failure into a worker-side SGL4011 with a
    // raw TypeError message. `undefined` posted through unchanged is what
    // lets host.ts's validateResult produce the right SGL4002.
    const undefinedResult: LayoutEngine = {
      id: 'test.undefined-result',
      name: 'test.undefined-result',
      version: '0.0.0',
      apiVersion: LAYOUT_API_VERSION,
      capabilities: capabilities(),
      layout: () => Promise.resolve(undefined as never),
    };
    const registry = makeRegistry(undefinedResult);
    const host = createWorkerHost(spawnFor(registry));
    try {
      const bad = await run(host, 'test.undefined-result', OK_INPUT);
      expect(bad.value).toBeNull();
      expect(bad.diagnostics).toHaveLength(1);
      expect(bad.diagnostics[0]!.code).toBe('SGL4002');

      const good = await run(host, 'test.ok', OK_INPUT);
      expect(good.value).not.toBeNull();
    } finally {
      host.dispose();
    }
  });

  it('a table miss round-trips through the measure RPC', async () => {
    const registry = makeRegistry();
    const measure = vi.fn().mockResolvedValue({ size: { w: 33, h: 7 }, lines: [] });
    const host = createWorkerHost(spawnFor(registry), { measure });
    try {
      const outcome = await run(host, 'test.measuring', INPUT);
      expect(measure).toHaveBeenCalledWith([{ text: 'probe' }], { maxWidth: 100 });
      expect(outcome.diagnostics).toEqual([]);
      expect(outcome.value?.nodes[A]?.frame).toEqual({ x: 16, y: 16, w: 33, h: 7 });
      expect(outcome.value?.bounds).toEqual({ x: 0, y: 0, w: 33 + 32, h: 7 + 32 });
    } finally {
      host.dispose();
    }
  });

  it('item 1: a late "measure" from a superseded request is ignored — callback not called, the new request settles independently', async () => {
    let releaseFirst: (() => void) | undefined;
    const stalling: LayoutEngine = {
      id: 'test.stalling-measure',
      name: 'test.stalling-measure',
      version: '0.0.0',
      apiVersion: LAYOUT_API_VERSION,
      capabilities: capabilities(),
      layout: async (_input, ctx) => {
        // Waits to be released — simulating an engine that keeps running
        // after its request has been superseded (it never checks
        // `ctx.signal.aborted`, exactly like `elk`, DD-06 §3) — and only then
        // makes its (now-stale) 'measure' call.
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        await ctx.measure.layoutRunsAsync([{ text: 'stale' }], {});
        return { bounds: { x: 0, y: 0, w: 1, h: 1 }, nodes: {}, edges: {}, labels: [] };
      },
    };
    const registry = makeRegistry(stalling);
    const measure = vi.fn().mockResolvedValue({ size: { w: 1, h: 1 }, lines: [] });
    const host = createWorkerHost(spawnFor(registry), { measure });
    try {
      const first = run(host, 'test.stalling-measure', OK_INPUT);
      const firstRejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });

      // Let the first engine start (post its 'layout', reach the await) before
      // superseding it — otherwise there is nothing yet to supersede.
      await Promise.resolve();
      await Promise.resolve();

      const second = run(host, 'test.ok', OK_INPUT); // supersedes `first`
      await firstRejection;

      // Now let the superseded engine's stalled call proceed — its
      // `layoutRunsAsync` fires a 'measure' for a request the host no longer
      // considers current.
      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(measure).not.toHaveBeenCalled();
      expect((await second).value).not.toBeNull();
    } finally {
      host.dispose();
    }
  });
});
