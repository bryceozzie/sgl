import type { LayoutContext, LayoutEngine, LayoutInput, LayoutResult } from '@sgl/layout-api';
import { elkDescriptor, normalizeElkOptions } from './descriptor.js';
import { loadElk } from './load-elk.js';
import { fromElkGraph, toElkGraph } from './mapping.js';

export * from './descriptor.js';
export * from './mapping.js';

/**
 * The default engine (ADR-0005): an adapter over elkjs's layered algorithm.
 *
 * Uses `elk.bundled.js` — the synchronous, single-thread build — inside our own
 * layout worker. elkjs's worker build (`elk-worker.js`, or `elk-api.js` with a
 * `workerUrl`) would nest a worker inside a worker and cost two serialisation
 * hops (06 §4, pitfall 7). The random seed is pinned (`elk.randomSeed: '1'`,
 * `mapping.ts`): layered is deterministic by default, but pin it.
 *
 * **Lazy (Stage K, decision K1).** elkjs is ~1.6 MB minified. It is loaded by
 * a dynamic `import()` on the first `layout()` call and the `ELK` instance is
 * cached, so importing this module costs only the mapping code, and a
 * bundler emits elkjs as its own chunk (DD-10 §2's `elk` chunk), outside the
 * core bundle budget. The main thread imports `@sgl/layout-elk/descriptor`
 * instead of this module, so it never sees the dynamic import at all.
 * Loading, and the scoped `document` stub elkjs needs inside a worker
 * (decision K11), is `load-elk.ts`.
 *
 * Errors are values: anything ELK throws (or rejects with) propagates out of
 * `layout()`, and the worker runtime turns it into `SGL4011` (DD-06 §3).
 *
 * Design: DD-06 §6.
 */

export const elkEngine: LayoutEngine = {
  ...elkDescriptor,

  async layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult> {
    const graph = toElkGraph(input, normalizeElkOptions(ctx.options), ctx.metrics);
    const elk = await loadElk();
    // Fix round 1, item 7: the first request pays elkjs's import, which can
    // outlast an abort. ELK itself cannot be interrupted (it is synchronous
    // GWT code), so this is the last point to honour one: reject with an
    // AbortError, the runtime posts `'error'` promptly, and the host has no
    // reason to terminate the worker — which would throw away the loaded
    // elkjs instance and make the next request pay the import again.
    if (ctx.signal.aborted) throw abortError();
    // Fix round 1, item 8: no defensive copy. ELK does write its results
    // (and GWT bookkeeping) into the graph it is given, but `graph` is built
    // fresh above for this call alone and nothing reads it afterwards.
    const out = await elk.layout(graph);
    return fromElkGraph(input, out);
  },
};

/** `DOMException` exists in every worker and in Node ≥ 17, but `lib` here
 *  is ES2022 only, so it is reached through `globalThis`; a plain `Error`
 *  named `AbortError` is the fallback. */
function abortError(): Error {
  const Ctor = (globalThis as { DOMException?: new (message: string, name: string) => Error }).DOMException;
  if (Ctor !== undefined) return new Ctor('The layout request was aborted.', 'AbortError');
  const err = new Error('The layout request was aborted.');
  err.name = 'AbortError';
  return err;
}

export default elkEngine;
