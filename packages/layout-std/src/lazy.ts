import type { LayoutContext, LayoutEngine, LayoutInput, LayoutResult } from '@sgl/layout-api';
import { treeDescriptor, type EngineDescriptor } from './descriptor.js';

/**
 * Engines whose layout code is the lazy `std-trees` chunk (DD-12 N52, H9):
 * the descriptor is static, and `layout()` loads the chunk on its first
 * call, as `elkEngine` loads elkjs (DD-06 §6, K1).
 *
 * **A failed load degrades as `elk`'s does, and is not cached here.** The
 * rejection propagates out of `layout()`, so the worker runtime posts
 * `'error'` and the host shows `SGL4011` with the previous layout kept
 * (DD-06 §3), and other engines go on working. The next request calls
 * `load` again. In a browser that is not yet a retry: the module map keeps a
 * failed dynamic import for the life of the worker, so the chunk is fetched
 * afresh by the next worker (a reload, or the host's respawn), as elkjs's is
 * (`e2e/tree.spec.ts` shows both halves).
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
