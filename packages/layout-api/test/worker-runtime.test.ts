import { asEdgeId, asNodeId, NO_SPAN, type GraphEdge, type GraphNode, type NodeId, type SemanticGraph } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { LAYOUT_API_VERSION, type LayoutEngine, type LayoutInput, type LayoutResult } from '../src/contract.js';
import type { WorkerToHost } from '../src/protocol.js';
import { EngineRegistry } from '../src/registry.js';
import { createWorkerRuntime, type WorkerRuntimePort } from '../src/worker-runtime.js';

/** A `WorkerRuntimePort` that just records everything posted, for assertions. */
function fakePort(): WorkerRuntimePort & { readonly sent: WorkerToHost[] } {
  const sent: WorkerToHost[] = [];
  return { sent, post: (m) => sent.push(m) };
}

const EMPTY_RESULT: LayoutResult = { bounds: { x: 0, y: 0, w: 0, h: 0 }, nodes: {}, edges: {}, labels: [] };

const EMPTY_GRAPH: SemanticGraph = {
  nodes: {},
  edges: [],
  rootChildren: [],
  order: [],
  labels: {},
  meta: { nodeCount: 0, edgeCount: 0, containerCount: 0 },
};

const INPUT: LayoutInput = { graph: EMPTY_GRAPH, scope: null, sizing: {}, labelSizes: {} };

function engine(id: string, layout: LayoutEngine['layout']): LayoutEngine {
  return {
    id,
    name: id,
    version: '0.0.0',
    apiVersion: LAYOUT_API_VERSION,
    capabilities: {
      containers: false,
      edgeRouting: 'straight',
      ports: false,
      labelPlacement: false,
      incremental: false,
      determinism: 'bitwise',
    },
    layout,
  };
}

function layoutMessage(overrides: Partial<{ id: number; engine: string; seed: number }> = {}) {
  return {
    t: 'layout' as const,
    id: overrides.id ?? 1,
    engine: overrides.engine ?? 'test.engine',
    input: INPUT,
    options: {},
    metrics: { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {}, arrowSize: 8 },
    table: {},
    seed: overrides.seed ?? 1,
  };
}

describe('createWorkerRuntime (DD-06 §3, Stage H decision D2)', () => {
  it('posts a result for an engine that resolves', async () => {
    const registry = new EngineRegistry();
    registry.register(engine('test.engine', () => Promise.resolve(EMPTY_RESULT)));
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage());
    await flush();

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ t: 'result', id: 1, result: EMPTY_RESULT });
    expect((port.sent[0] as { ms: number }).ms).toBeGreaterThanOrEqual(0);
  });

  it('applies the host fallbacks (routeStraight/placeLabels) before posting "result" — an engine declaring labelPlacement:false/edgeRouting:straight gets edges and labels it never computed', async () => {
    // Found missing entirely in review (Stage H fix round 1, item 3): with no
    // fallback applied here, `grid` — whose real capabilities are exactly
    // this shape — could never pass `validateResult` through the real
    // worker/host pipeline; every edge came back SGL4002 "missing
    // EdgeLayout".
    const a = asNodeId('a');
    const b = asNodeId('b');
    const node = (id: NodeId, path: string): GraphNode => ({
      id,
      path: [path],
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
    });
    const edge: GraphEdge = {
      id: asEdgeId('e-ab'),
      from: { node: a },
      to: { node: b },
      directed: 'forward',
      classes: [],
      labelId: null,
      config: {},
      declaredIn: null,
      hidden: false,
      span: NO_SPAN,
    };
    const graph: SemanticGraph = {
      nodes: { [a]: node(a, 'a'), [b]: node(b, 'b') },
      edges: [edge],
      rootChildren: [a, b],
      order: [a, b],
      labels: {},
      meta: { nodeCount: 2, edgeCount: 1, containerCount: 0 },
    };
    const input: LayoutInput = { graph, scope: null, sizing: {}, labelSizes: {} };

    const registry = new EngineRegistry();
    registry.register(
      engine('test.grid-like', () =>
        Promise.resolve({
          bounds: { x: 0, y: 0, w: 100, h: 50 },
          nodes: {
            [a]: { frame: { x: 0, y: 0, w: 20, h: 20 } },
            [b]: { frame: { x: 40, y: 0, w: 20, h: 20 } },
          },
          // No edges, no labels — exactly what a `labelPlacement: false,
          // edgeRouting: 'straight'` engine like `grid` returns.
          edges: {},
          labels: [],
        }),
      ),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive({ ...layoutMessage({ engine: 'test.grid-like' }), input });
    await flush();

    expect(port.sent).toHaveLength(1);
    const msg = port.sent[0]!;
    expect(msg.t).toBe('result');
    if (msg.t !== 'result') throw new Error('unreachable');
    expect(msg.result.edges[asEdgeId('e-ab')]).toBeDefined();
  });

  it('skips the fallbacks and posts a malformed result unchanged (as "result", not "error") — the host, not the worker, rejects it', async () => {
    // Fix round 2, item 2: `routeStraight`/`placeLabels` make exactly the
    // same assumptions `validateResult` does (`result.edges` etc. already
    // exist). Without the shape check, an engine resolving `undefined` made
    // `routeStraight` throw *inside this module's own try/catch*, so the
    // caller got `SGL4011` with a raw TypeError message instead of the
    // `SGL4002` `host.ts`'s `validateResult` is supposed to produce for a
    // malformed result. Posting `undefined` through unchanged, as a
    // `'result'` message, is what lets `validateResult` do its job.
    const registry = new EngineRegistry();
    registry.register(engine('test.undefined-result', () => Promise.resolve(undefined as never)));
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage({ engine: 'test.undefined-result' }));
    await flush();

    expect(port.sent).toHaveLength(1);
    const msg = port.sent[0]!;
    expect(msg.t).toBe('result');
    if (msg.t !== 'result') throw new Error('unreachable');
    expect(msg.result).toBeUndefined();
  });

  it('SGL4011: an engine that is not registered', async () => {
    const registry = new EngineRegistry();
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage({ engine: 'nope' }));
    await flush();

    expect(port.sent).toHaveLength(1);
    const msg = port.sent[0]!;
    expect(msg.t).toBe('error');
    expect(msg.t === 'error' && msg.diagnostic.code).toBe('SGL4011');
  });

  it('SGL4011: an engine that throws synchronously', async () => {
    const registry = new EngineRegistry();
    registry.register(
      engine('test.engine', () => {
        throw new Error('boom');
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage());
    await flush();

    const msg = port.sent[0]!;
    expect(msg.t).toBe('error');
    expect(msg.t === 'error' && msg.diagnostic.code).toBe('SGL4011');
    expect(msg.t === 'error' && msg.diagnostic.message).toContain('boom');
  });

  it('SGL4011: an engine whose promise rejects', async () => {
    const registry = new EngineRegistry();
    registry.register(engine('test.engine', () => Promise.reject(new Error('async boom'))));
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage());
    await flush();

    const msg = port.sent[0]!;
    expect(msg.t).toBe('error');
    expect(msg.t === 'error' && msg.diagnostic.message).toContain('async boom');
  });

  it("'abort' aborts the running request's signal", async () => {
    const registry = new EngineRegistry();
    let sawAborted = false;
    registry.register(
      engine('test.engine', (_input, ctx) => {
        return new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAborted = true;
            resolve(EMPTY_RESULT);
          });
        });
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage({ id: 7 }));
    runtime.receive({ t: 'abort', id: 7 });
    await flush();

    expect(sawAborted).toBe(true);
    expect(port.sent[0]).toMatchObject({ t: 'result', id: 7 });
  });

  it("an 'abort' for an unknown id is a no-op", () => {
    const registry = new EngineRegistry();
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);
    expect(() => {
      runtime.receive({ t: 'abort', id: 999 });
    }).not.toThrow();
    expect(port.sent).toHaveLength(0);
  });

  it('ctx.measure.layoutRuns() has no synchronous path and throws (SGL4011)', async () => {
    const registry = new EngineRegistry();
    registry.register(
      engine('test.engine', (_input, ctx) => {
        ctx.measure.layoutRuns([], {});
        return Promise.resolve(EMPTY_RESULT);
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage());
    await flush();

    const msg = port.sent[0]!;
    expect(msg.t).toBe('error');
    expect(msg.t === 'error' && msg.diagnostic.message).toContain('layoutRuns');
  });

  it("measure-miss round trip: 'measure' out, 'measure-reply' in, resumes the engine", async () => {
    const registry = new EngineRegistry();
    let received: unknown;
    registry.register(
      engine('test.engine', async (_input, ctx) => {
        received = await ctx.measure.layoutRunsAsync([{ text: 'hi' }], { maxWidth: 100 });
        return EMPTY_RESULT;
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage({ id: 3 }));
    await flush();

    // The engine is now suspended awaiting the RPC reply; a 'measure' request
    // has gone out and no 'result' yet.
    expect(port.sent).toHaveLength(1);
    const measureMsg = port.sent[0]!;
    expect(measureMsg.t).toBe('measure');
    if (measureMsg.t !== 'measure') throw new Error('unreachable');
    expect(measureMsg.id).toBe(3);
    expect(measureMsg.runs).toEqual([{ text: 'hi' }]);

    runtime.receive({ t: 'measure-reply', id: 3, req: measureMsg.req, layout: { size: { w: 42, h: 10 }, lines: [] } });
    await flush();

    expect(received).toEqual({ size: { w: 42, h: 10 }, lines: [] });
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]).toMatchObject({ t: 'result', id: 3 });
  });

  it('measure-reply routes by req, not by delivery order (two concurrent requests, replies out of order)', async () => {
    const registry = new EngineRegistry();
    const seen: Record<string, unknown> = {};
    registry.register(
      engine('test.engine', async (_input, ctx) => {
        const [first, second] = await Promise.all([
          ctx.measure.layoutRunsAsync([{ text: 'first' }], {}),
          ctx.measure.layoutRunsAsync([{ text: 'second' }], {}),
        ]);
        seen['first'] = first;
        seen['second'] = second;
        return EMPTY_RESULT;
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage({ id: 9 }));
    await flush();

    const measureMsgs = port.sent.filter((m): m is Extract<WorkerToHost, { t: 'measure' }> => m.t === 'measure');
    expect(measureMsgs).toHaveLength(2);
    const [m1, m2] = measureMsgs;
    expect(m1!.runs).toEqual([{ text: 'first' }]);
    expect(m2!.runs).toEqual([{ text: 'second' }]);
    expect(m1!.req).not.toBe(m2!.req);

    // Deliver replies in *reverse* order.
    runtime.receive({ t: 'measure-reply', id: 9, req: m2!.req, layout: { tag: 'second-reply' } });
    runtime.receive({ t: 'measure-reply', id: 9, req: m1!.req, layout: { tag: 'first-reply' } });
    await flush();

    expect(seen['first']).toEqual({ tag: 'first-reply' });
    expect(seen['second']).toEqual({ tag: 'second-reply' });
  });

  it('a measure-reply for an unknown req is a no-op', () => {
    const registry = new EngineRegistry();
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);
    expect(() => {
      runtime.receive({ t: 'measure-reply', id: 1, req: 999, layout: null });
    }).not.toThrow();
  });

  it('ctx.random is deterministic and seeded from the message', async () => {
    const registry = new EngineRegistry();
    const seen: number[][] = [];
    registry.register(
      engine('test.engine', (_input, ctx) => {
        seen.push([ctx.random(), ctx.random(), ctx.random()]);
        return Promise.resolve(EMPTY_RESULT);
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage({ id: 1, seed: 42 }));
    await flush();
    runtime.receive(layoutMessage({ id: 2, seed: 42 }));
    await flush();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    for (const v of seen[0]!) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('ctx.log() posts a log message', async () => {
    const registry = new EngineRegistry();
    registry.register(
      engine('test.engine', (_input, ctx) => {
        ctx.log('warn', 'careful', 'a' as NodeId);
        return Promise.resolve(EMPTY_RESULT);
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage());
    await flush();

    expect(port.sent[0]).toMatchObject({ t: 'log', level: 'warn', message: 'careful', nodeId: 'a' });
  });

  it('ctx.sublayout() rejects — reserved in apiVersion 1', async () => {
    const registry = new EngineRegistry();
    registry.register(
      engine('test.engine', async (_input, ctx) => {
        await expect(ctx.sublayout('x', 'y' as NodeId)).rejects.toThrow();
        return EMPTY_RESULT;
      }),
    );
    const port = fakePort();
    const runtime = createWorkerRuntime(registry, port);

    runtime.receive(layoutMessage());
    await flush();

    expect(port.sent[0]).toMatchObject({ t: 'result' });
  });
});

/** Flush the microtask queue enough times for a chain of `await`s inside the
 *  runtime to settle before assertions run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
