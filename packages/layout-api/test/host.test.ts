import { asNodeId, NO_SPAN, type GraphNode, type SemanticGraph } from '@sgl/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutInput, LayoutResult, ResolvedThemeMetricsView } from '../src/contract.js';
import { ABORT_ESCALATION_MS, createWorkerHost, DEFAULT_TIMEOUT_MS } from '../src/host.js';
import type { HostToWorker, WorkerToHost } from '../src/protocol.js';

/**
 * `createWorkerHost` (DD-06 §3, Stage H decision D1) driven by a fake `Worker` and
 * fake timers, per DD-06 §10's "Host: timeout → terminate/respawn → SGL4001; abort
 * within 250 ms; abort escalation; single in-flight guarantee; measure-miss round
 * trip." The browser project (D3) repeats the same four behaviours against a real
 * `Worker` (`host.browser.test.ts`).
 */

type MessageListener = (ev: { readonly data: WorkerToHost }) => void;

class FakeWorker {
  readonly posted: HostToWorker[] = [];
  terminated = false;
  #listeners: MessageListener[] = [];

  postMessage(message: HostToWorker): void {
    this.posted.push(message);
  }

  addEventListener(_type: 'message', listener: MessageListener): void {
    this.#listeners.push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Test helper: simulate the worker posting a message back to the host. */
  emit(message: WorkerToHost): void {
    for (const listener of this.#listeners) listener({ data: message });
  }
}

function makeSpawn(): { readonly spawn: () => Worker; readonly workers: readonly FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn = (): Worker => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  };
  return { spawn, workers };
}

const A = asNodeId('a');
const B = asNodeId('b');

function node(overrides: Partial<GraphNode>): GraphNode {
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
    ...overrides,
  };
}

const GRAPH: SemanticGraph = {
  nodes: { [A]: node({ id: A }), [B]: node({ id: B, path: ['b'] }) },
  edges: [],
  rootChildren: [A, B],
  order: [A, B],
  labels: {},
  meta: { nodeCount: 2, edgeCount: 0, containerCount: 0 },
};

const INPUT: LayoutInput = { graph: GRAPH, scope: null, sizing: {}, labelSizes: {} };

const METRICS: ResolvedThemeMetricsView = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: {}, arrowSize: 8 };

const GOOD_RESULT: LayoutResult = {
  bounds: { x: 0, y: 0, w: 100, h: 50 },
  nodes: {
    [A]: { frame: { x: 0, y: 0, w: 20, h: 20 } },
    [B]: { frame: { x: 30, y: 0, w: 20, h: 20 } },
  },
  edges: {},
  labels: [],
};

const BAD_RESULT: LayoutResult = {
  bounds: { x: 0, y: 0, w: 100, h: 50 },
  nodes: { [A]: { frame: { x: 0, y: 0, w: 20, h: 20 } } }, // missing B
  edges: {},
  labels: [],
};

function run(host: ReturnType<typeof createWorkerHost>, signal: AbortSignal = new AbortController().signal) {
  return host.run('sgl.test', INPUT, {}, METRICS, {}, signal);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWorkerHost (DD-06 §3, Stage H decision D1)', () => {
  it('resolves a validated, quantized result on a well-formed "result" message', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);

    const promise = run(host);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted[0]).toMatchObject({ t: 'layout', id: 0, engine: 'sgl.test' });

    workers[0]!.emit({ t: 'result', id: 0, result: { ...GOOD_RESULT, bounds: { x: 0.001, y: 0, w: 100, h: 50 } }, ms: 5 });
    const outcome = await promise;

    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.value).not.toBeNull();
    // Quantized to 1/64.
    expect(outcome.value?.bounds.x).toBe(0);
  });

  it('a success can still carry warnings (e.g. SGL4003) alongside a non-null value', async () => {
    // DD-06 §3's lifecycle doc previously said a successful 'result' always
    // resolves `diagnostics: []` — wrong: §5's warnings (a container
    // contentFrame overflowing its own frame, SGL4003) pass through
    // `validateResult` on a success too, same as `runPipeline` already
    // exercises them outside the worker/host protocol.
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);

    const C = asNodeId('c');
    const container = node({ id: C, path: ['c'], children: [A] });
    const child = node({ id: A, path: ['c', 'a'], parent: C, depth: 1 });
    const graph: SemanticGraph = {
      nodes: { [C]: container, [A]: child },
      edges: [],
      rootChildren: [C],
      order: [C, A],
      labels: {},
      meta: { nodeCount: 2, edgeCount: 0, containerCount: 1 },
    };
    const warnInput: LayoutInput = { graph, scope: null, sizing: {}, labelSizes: {} };
    const warnResult: LayoutResult = {
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      nodes: {
        [C]: { frame: { x: 0, y: 0, w: 50, h: 50 }, contentFrame: { x: -10, y: 0, w: 50, h: 50 } }, // overflows its own frame
        [A]: { frame: { x: 0, y: 0, w: 10, h: 10 } },
      },
      edges: {},
      labels: [],
    };

    const promise = host.run('sgl.test', warnInput, {}, METRICS, {}, new AbortController().signal);
    workers[0]!.emit({ t: 'result', id: 0, result: warnResult, ms: 1 });
    const outcome = await promise;

    expect(outcome.value).not.toBeNull();
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]!.code).toBe('SGL4003');
    expect(outcome.diagnostics[0]!.severity).toBe('warning');
  });

  it('resolves { value: null, diagnostics: [SGL4011] } on an "error" message, and stays usable', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);

    const first = run(host);
    workers[0]!.emit({
      t: 'error',
      id: 0,
      diagnostic: { code: 'SGL4011', severity: 'error', message: "Layout engine `sgl.test` failed: boom.", span: NO_SPAN },
    });
    const firstOutcome = await first;
    expect(firstOutcome.value).toBeNull();
    expect(firstOutcome.diagnostics).toHaveLength(1);
    expect(firstOutcome.diagnostics[0]!.code).toBe('SGL4011');

    const second = run(host);
    workers[0]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });
    const secondOutcome = await second;
    expect(secondOutcome.value).not.toBeNull();
  });

  it('SGL4002: malformed engine output is rejected, and the host serves the next request', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);

    const first = run(host);
    workers[0]!.emit({ t: 'result', id: 0, result: BAD_RESULT, ms: 1 });
    const firstOutcome = await first;
    expect(firstOutcome.value).toBeNull();
    expect(firstOutcome.diagnostics.some((d) => d.code === 'SGL4002')).toBe(true);

    const second = run(host);
    workers[0]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });
    const secondOutcome = await second;
    expect(secondOutcome.value).not.toBeNull();
    expect(secondOutcome.diagnostics).toEqual([]);
  });

  it('timeout: terminates and respawns the worker and yields SGL4001', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn, { timeoutMs: 1_000 });

    const promise = run(host);
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await promise;

    expect(outcome.value).toBeNull();
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]!.code).toBe('SGL4001');
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2); // respawned

    // The respawned worker serves the next request.
    const next = run(host);
    expect(workers[1]!.posted).toHaveLength(1);
    workers[1]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });
    expect((await next).value).not.toBeNull();
  });

  it('DEFAULT_TIMEOUT_MS is 10 000 ms and DD-06 §3 grid override is 2 000 ms', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    const promise = host.run('sgl.grid', INPUT, {}, METRICS, {}, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await promise;
    expect(outcome.diagnostics[0]!.code).toBe('SGL4001');
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    void workers;
  });

  it('abort: cancels the in-flight request immediately, rejecting with AbortError', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    const controller = new AbortController();

    const promise = run(host, controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.posted.at(-1)).toMatchObject({ t: 'abort', id: 0 });
  });

  it('abort escalation: no reply within 250 ms terminates and respawns the worker', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    const controller = new AbortController();

    const promise = run(host, controller.signal);
    controller.abort();
    await promise.catch(() => {});

    expect(workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(ABORT_ESCALATION_MS);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toEqual([]); // nothing was current, so nothing is re-posted (F21)
  });

  it('abort: a reply within 250 ms cancels the escalation (no respawn), and is discarded', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    const controller = new AbortController();

    const promise = run(host, controller.signal);
    controller.abort();
    await promise.catch(() => {});

    workers[0]!.emit({ t: 'result', id: 0, result: GOOD_RESULT, ms: 1 });
    await vi.advanceTimersByTimeAsync(ABORT_ESCALATION_MS);

    expect(workers[0]!.terminated).toBe(false);
    expect(workers).toHaveLength(1);
  });

  it('a signal already aborted before run() is called rejects immediately with no worker traffic', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    const controller = new AbortController();
    controller.abort();

    await expect(run(host, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.posted).toHaveLength(0);
  });

  it('single in-flight: a second run() supersedes and aborts the first', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);

    const first = run(host);
    const second = run(host);

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.posted[0]).toMatchObject({ t: 'layout', id: 0 });
    expect(workers[0]!.posted[1]).toMatchObject({ t: 'abort', id: 0 });
    expect(workers[0]!.posted[2]).toMatchObject({ t: 'layout', id: 1 });

    workers[0]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });
    expect((await second).value).not.toBeNull();
  });

  // F21: the superseding request is posted to the same worker as the one it
  // aborts. When that worker cannot answer the abort within 250 ms (busy
  // importing elkjs, or inside ELK's synchronous run, under CPU load), the
  // escalation terminates it — and the superseding request with it. It must be
  // posted again to the respawned worker, not left to time out as SGL4001.
  it('abort escalation while a superseding request is in flight re-posts that request to the respawned worker', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn, { timeoutMs: 10_000 });

    const first = run(host);
    const second = run(host); // id 1 — posted to workers[0], which is still busy with id 0
    await first.catch(() => {});

    await vi.advanceTimersByTimeAsync(ABORT_ESCALATION_MS); // no answer for id 0: escalate
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toEqual([workers[0]!.posted[2]]); // the same 'layout' message for id 1
    expect(workers[1]!.posted[0]).toMatchObject({ t: 'layout', id: 1 });

    workers[1]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });
    const result = await second;
    expect(result.diagnostics).toEqual([]);
    expect(result.value).not.toBeNull();
    expect(workers).toHaveLength(2); // no further respawn
  });

  it('a re-posted request keeps its original deadline (the clock starts at run())', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn, { timeoutMs: 1_000 });

    void run(host).catch(() => {});
    const second = run(host);
    await vi.advanceTimersByTimeAsync(ABORT_ESCALATION_MS);
    expect(workers[1]!.posted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000 - ABORT_ESCALATION_MS);
    const result = await second;
    expect(result.value).toBeNull();
    expect(result.diagnostics.map((d) => d.code)).toEqual(['SGL4001']);
    expect(workers).toHaveLength(3); // the timeout respawns once more; nothing is re-posted to it
    expect(workers[2]!.posted).toEqual([]);
  });

  it('measure-miss round trip: the host answers a worker\'s "measure" RPC', async () => {
    const { spawn, workers } = makeSpawn();
    const measure = vi.fn().mockResolvedValue({ size: { w: 12, h: 4 }, lines: [] });
    const host = createWorkerHost(spawn, { measure });

    const promise = run(host);
    workers[0]!.emit({ t: 'measure', id: 0, req: 7, runs: [{ text: 'x' }], box: { maxWidth: 50 } });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(measure).toHaveBeenCalledWith([{ text: 'x' }], { maxWidth: 50 });
    expect(workers[0]!.posted.at(-1)).toMatchObject({ t: 'measure-reply', id: 0, req: 7, layout: { size: { w: 12, h: 4 }, lines: [] } });

    workers[0]!.emit({ t: 'result', id: 0, result: GOOD_RESULT, ms: 1 });
    expect((await promise).value).not.toBeNull();
  });

  it('a "measure" RPC with no configured callback degrades to an empty layout rather than hanging', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);

    run(host);
    workers[0]!.emit({ t: 'measure', id: 0, req: 1, runs: [], box: {} });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(workers[0]!.posted.at(-1)).toMatchObject({ t: 'measure-reply', id: 0, req: 1 });
  });

  it('a "log" message is accepted without affecting the in-flight request', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    const promise = run(host);
    workers[0]!.emit({ t: 'log', id: 0, level: 'info', message: 'hello' });
    workers[0]!.emit({ t: 'result', id: 0, result: GOOD_RESULT, ms: 1 });
    expect((await promise).value).not.toBeNull();
  });

  it('dispose(): rejects the in-flight request and terminates the worker', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    const promise = run(host);

    host.dispose();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.terminated).toBe(true);
  });

  it('a stale "result" for an id that already settled is ignored', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn, { timeoutMs: 1_000 });

    const promise = run(host);
    await vi.advanceTimersByTimeAsync(1_000); // times out, respawns
    await promise;

    // The old (now-terminated) worker's belated reply must not throw or resolve
    // anything a second time.
    expect(() => {
      workers[0]!.emit({ t: 'result', id: 0, result: GOOD_RESULT, ms: 1 });
    }).not.toThrow();
  });

  it('a stale "result" from a terminated (respawned-away) worker is ignored even though the next request reuses no id', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn, { timeoutMs: 1_000 });

    const promise = run(host);
    await vi.advanceTimersByTimeAsync(1_000); // times out, terminates workers[0], spawns workers[1]
    await promise;

    const next = run(host); // now being served by workers[1]
    // workers[0] is dead, but nothing stops it from firing a late event if the
    // real Worker implementation ever did (defence in depth: the listener is
    // bound to the worker instance it was registered on).
    workers[0]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });

    // workers[1] must be the one — and the only one — to settle `next`.
    expect(workers[1]!.posted).toHaveLength(1);
    workers[1]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });
    expect((await next).value).not.toBeNull();
  });

  it('a late "measure" after timeout+respawn is ignored: callback not called, nothing posted to the new worker', async () => {
    const { spawn, workers } = makeSpawn();
    const measure = vi.fn().mockResolvedValue({ size: { w: 1, h: 1 }, lines: [] });
    const host = createWorkerHost(spawn, { timeoutMs: 1_000, measure });

    const promise = run(host);
    await vi.advanceTimersByTimeAsync(1_000); // times out: workers[0] terminated, workers[1] spawned
    await promise;

    // workers[0]'s own `'measure'` req counter would restart at 0 in a fresh
    // worker too — this is the collision the fix closes.
    workers[0]!.emit({ t: 'measure', id: 0, req: 0, runs: [], box: {} });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(measure).not.toHaveBeenCalled();
    expect(workers[1]!.posted.some((m) => m.t === 'measure-reply')).toBe(false);
  });

  it('a late "measure" from a superseded (but not yet respawned) request on the same worker is ignored', async () => {
    const { spawn, workers } = makeSpawn();
    const measure = vi.fn().mockResolvedValue({ size: { w: 1, h: 1 }, lines: [] });
    const host = createWorkerHost(spawn, { measure });

    const first = run(host); // id 0
    const second = run(host); // id 1 — supersedes id 0 on the *same* workers[0] (no respawn yet)
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    // The superseded engine posts its own 'measure' late, for the request it no
    // longer owns.
    workers[0]!.emit({ t: 'measure', id: 0, req: 3, runs: [], box: {} });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(measure).not.toHaveBeenCalled();
    expect(workers[0]!.posted.some((m) => m.t === 'measure-reply')).toBe(false);

    workers[0]!.emit({ t: 'result', id: 1, result: GOOD_RESULT, ms: 1 });
    expect((await second).value).not.toBeNull();
  });

  it('run() after dispose() rejects immediately with no worker traffic', async () => {
    const { spawn, workers } = makeSpawn();
    const host = createWorkerHost(spawn);
    host.dispose();

    await expect(run(host)).rejects.toThrow(/dispose/i);

    expect(workers).toHaveLength(1); // no respawn/orphan
    expect(workers[0]!.posted).toHaveLength(0); // no 'layout' posted
  });
});
