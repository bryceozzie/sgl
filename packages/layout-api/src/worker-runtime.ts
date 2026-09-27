import type { LayoutContext } from './contract.js';
import { applyHostFallbacks } from './fallbacks.js';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import type { EngineRegistry } from './registry.js';
import { describeShapeError } from './validate.js';

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
        reason: 'not registered in this worker',
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

    const start = now();
    try {
      const raw = await engine.layout(message.input, ctx);
      // Host fallbacks (DD-06 §4) — this is the only place in the whole
      // pipeline that has both the engine's `capabilities` (from the
      // registry, worker-side) and its `LayoutInput`/`LayoutResult`, so they
      // run here rather than in `host.ts`, which never sees either. Found
      // missing entirely in review (Stage H fix round 1, item 3): with no
      // fallback applied, `grid` — which declares `edgeRouting: 'straight'`
      // and returns no edges of its own — could never pass `validateResult`
      // through the real worker/host pipeline, only through the hand-rolled
      // composition `render-svg/test/pipeline.ts` and `layout-std/test/
      // grid.test.ts` each already did for their own purposes.
      // `routeStraight` only fills an edge the engine left out, so it is safe
      // to run unconditionally regardless of what `edgeRouting` declares (an
      // engine that already routed everything has nothing left for it to
      // fill); `placeLabels` *replaces* `result.labels` outright, so it may
      // only run for an engine that declares it does no placement of its own.
      //
      // Both fallbacks make exactly the same assumptions `validateResult`
      // does — `result.edges`, `.nodes`, `.labels` all already exist — which
      // `describeShapeError` (`validate.ts`, reused rather than duplicated
      // here) is what checks. Skip them for a malformed `raw` and post it
      // unchanged: `host.ts`'s `validateResult` is what should reject it with
      // `SGL4002`. Found in review (fix round 2, item 2): without this guard,
      // an engine resolving `undefined` made `routeStraight` throw inside
      // *this* `try`, turning a validation-shaped failure into `SGL4011` with
      // a raw `TypeError` message instead — round 1's shape guard in
      // `validateResult` was only ever reachable through a fake `Worker` that
      // skips the fallbacks entirely, never through the real protocol.
      //
      // Stage K: the sequence itself is `applyHostFallbacks` (`fallbacks.ts`),
      // shared with the conformance harness, and now also finishes the routes
      // an engine returned (§4.4's arrow reserve, §4.5's short self-loops)
      // before `routeStraight` fills the rest.
      const result = describeShapeError(raw) === null ? applyHostFallbacks(message.input, raw, engine.capabilities, message.metrics) : raw;
      port.post({ t: 'result', id: message.id, result, ms: now() - start });
    } catch (err) {
      port.post({
        t: 'error',
        id: message.id,
        reason: errorMessage(err),
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
 * DD-06 §3's `'result'` message carries `ms`, purely as telemetry the host may
 * display — it is never read back into anything an engine or the renderer
 * produces. That makes it the one sanctioned exception to §1's determinism ban
 * (`eslint.config.js` bans `performance.now` alongside `Math.random`/
 * `Date.now` precisely so an exception has to be written down like this one,
 * not just remembered); every other timing need in this codebase still goes
 * through an injected clock or `setTimeout`/`ctx.random`.
 */
function now(): number {
  // eslint-disable-next-line no-restricted-properties
  return performance.now();
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
