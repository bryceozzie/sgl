import type { LayoutContext, LayoutEngine, LayoutInput, LayoutResult } from '@sgl/layout-api';
import { elkDescriptor, normalizeElkOptions } from './descriptor.js';
import { loadElk } from './load-elk.js';
import { fromElkGraph, toElkGraph, type ElkNode } from './mapping.js';

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
    // ELK writes its results (and GWT bookkeeping) into the object it is
    // given, so it gets its own deep copy; `graph` itself stays as sent.
    const out = await elk.layout(JSON.parse(JSON.stringify(graph)) as ElkNode);
    return fromElkGraph(input, out);
  },
};

export default elkEngine;
