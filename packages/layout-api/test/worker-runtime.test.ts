import type { NodeId, SemanticGraph } from '@sgl/core';
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
