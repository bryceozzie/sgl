import { diagnostic, NO_SPAN } from '@sgl/core';
import type { LayoutContext } from './contract.js';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import type { EngineRegistry } from './registry.js';

/**
 * The worker-side half of DD-06 §3's protocol (Stage H, decision D2).
 *
 * This module is deliberately `Worker`-free: it knows nothing about
 * `postMessage`/`onmessage`, `self`, or any other Worker-global. It takes a
 * registry and a small `WorkerRuntimePort` (post-only; receiving is the caller
 * feeding messages into `receive()`), so a Node test can drive it with a fake
 * port and assert on exactly what it posts, with no real `Worker` anywhere.
 *
 * `apps/web/src/layout.worker.ts` is the thin, real entry that registers the
 * concrete engines and wires this runtime to the actual worker global scope —
 * it belongs in `apps/web` rather than here because `@sgl/layout-api` may not
 * import `@sgl/layout-std` (DD-00 §2 rule 3), and the entry needs `gridEngine` to
 * register it.
 */

export interface WorkerRuntimePort {
  post(message: WorkerToHost): void;
}

export interface WorkerRuntime {
  /** Handle one message from the host. */
  receive(message: HostToWorker): void;
}

type LayoutMessage = Extract<HostToWorker, { t: 'layout' }>;

interface RunningRequest {
  readonly controller: AbortController;
}

export function createWorkerRuntime(registry: EngineRegistry, port: WorkerRuntimePort): WorkerRuntime {
  const running = new Map<number, RunningRequest>();
  const measureWaiters = new Map<number, (layout: unknown) => void>();
  let reqCounter = 0;

  function receive(message: HostToWorker): void {
    switch (message.t) {
      case 'layout':
        void runLayout(message);
        return;
      case 'abort':
        running.get(message.id)?.controller.abort();
        return;
      case 'measure-reply': {
        const waiter = measureWaiters.get(message.req);
        if (waiter === undefined) return;
        measureWaiters.delete(message.req);
        waiter(message.layout);
        return;
      }
    }
  }

  async function runLayout(message: LayoutMessage): Promise<void> {
    const engine = registry.get(message.engine);
    if (engine === undefined) {
      port.post({
        t: 'error',
        id: message.id,
        diagnostic: diagnostic('SGL4011', NO_SPAN, {
          id: message.engine,
          message: `engine '${message.engine}' is not registered in this worker`,
        }),
      });
      return;
    }

    const controller = new AbortController();
    running.set(message.id, { controller });

    const ctx: LayoutContext = {
      options: message.options,
      metrics: message.metrics,
      measure: {
        // The synchronous member only serves a pre-measured table lookup; a
        // worker has no synchronous path back to the main thread, so any call
        // here is a programming error in the caller, not a runtime condition to
        // report as a diagnostic (DD-00 §3's "throwing is reserved for a
        // violated invariant" — this is that case). Engines get their sizes
        // through `LayoutInput.labelSizes`/`sizing` instead; `layoutRunsAsync`
        // below is the only path for a label created during layout.
        layoutRuns(): never {
          throw new Error(
            'ctx.measure.layoutRuns() has no synchronous path to the host from inside a worker; use ctx.measure.layoutRunsAsync().',
          );
        },
        layoutRunsAsync: (runs, box) =>
          new Promise((resolve) => {
            reqCounter += 1;
            const req = reqCounter;
            measureWaiters.set(req, resolve);
            port.post({ t: 'measure', id: message.id, req, runs, box: box as Readonly<Record<string, unknown>> });
          }),
      },
      random: seededRandom(message.seed),
      signal: controller.signal,
      log: (level, text, nodeId) => {
        port.post({ t: 'log', id: message.id, level, message: text, ...(nodeId !== undefined && { nodeId }) });
      },
      sublayout: () => Promise.reject(new Error('sublayout is reserved, not implemented (DD-06 §2, Architecture §4.2).')),
    };

    const start = performance.now();
    try {
      const result = await engine.layout(message.input, ctx);
      port.post({ t: 'result', id: message.id, result, ms: performance.now() - start });
    } catch (err) {
      port.post({
        t: 'error',
        id: message.id,
        diagnostic: diagnostic('SGL4011', NO_SPAN, { id: message.engine, message: errorMessage(err) }),
      });
    } finally {
      running.delete(message.id);
    }
  }

  return { receive };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `ctx.random` must be seeded and deterministic (DD-00 §3 bans `Math.random`).
 * mulberry32 — small, integer/bitwise arithmetic only (ADR-0004's "reproducible
 * bit for bit" bar), seeded per request from `HostToWorker`'s `'layout'.seed`.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
