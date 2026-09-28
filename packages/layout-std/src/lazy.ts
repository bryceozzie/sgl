import type { LayoutContext, LayoutEngine, LayoutInput, LayoutResult } from '@sgl/layout-api';
import { treeDescriptor, type EngineDescriptor } from './descriptor.js';

/**
 * Engines whose layout code is the lazy `std-trees` chunk (DD-12 N52, H9):
 * the descriptor is static, and `layout()` loads the chunk on its first
 * call, as `elkEngine` loads elkjs (DD-06 §6, K1).
 *
 * **A failed load degrades as `elk`'s does, and is not cached.** The
 * rejection propagates out of `layout()`, so the worker runtime posts
 * `'error'` and the host shows `SGL4011` with the previous layout kept
 * (DD-06 §3); the next request tries the load again, so a chunk that failed
 * to fetch (offline before the precache was filled, a deploy that renamed
 * it) is fetched afresh rather than failing for the rest of the session.
 */

export type LayoutFn = (input: LayoutInput, ctx: LayoutContext) => LayoutResult;

/** `descriptor` plus a `layout()` that runs what `load` resolves to, loading
 *  it once; a failed load is forgotten, so the next call retries it. */
export function lazyEngine(descriptor: EngineDescriptor, load: () => Promise<LayoutFn>): LayoutEngine {
  let loading: Promise<LayoutFn> | null = null;
  return {
    ...descriptor,
    async layout(input, ctx) {
      loading ??= load().catch((err: unknown) => {
        loading = null;
        throw err;
      });
      return (await loading)(input, ctx);
    },
  };
}

/** `tree` (DD-12 §8): Buchheim–Walker over the spanning forest, elbow edges.
 *  Pure, so a bundle that imports this package without registering `tree`
 *  (the page, via `/descriptor`, or a test worker) carries neither the stub
 *  nor the chunk. */
export const treeEngine: LayoutEngine = /* @__PURE__ */ lazyEngine(treeDescriptor, async () => (await import('./std-trees.js')).layoutTree);
