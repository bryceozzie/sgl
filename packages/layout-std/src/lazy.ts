import type { LayoutContext, LayoutEngine, LayoutInput, LayoutResult } from '@sgl/layout-api';
import { radialDescriptor, treeDescriptor, type EngineDescriptor } from './descriptor.js';

/**
 * Engines whose layout code is the lazy `std-trees` chunk (DD-12 N52, H9):
 * the descriptor is static, and `layout()` loads the chunk on its first
 * call, as `elkEngine` loads elkjs (DD-06 §6, K1).
 *
 * **A failed load degrades as `elk`'s does, and stays failed in that
 * worker.** The rejection propagates out of `layout()`, so the worker
 * runtime posts `'error'` and the host shows `SGL4011` with the previous
 * layout kept (DD-06 §3), and other engines go on working. `lazyEngine`
 * drops its rejected promise, so the next request calls `load` again, but
 * that is no retry: the browser's module map caches the failed dynamic
 * import for the life of the worker, so `import()` rejects again without a
 * fetch, even with the network back. The chunk loads only in the next
 * worker (a reload, or the host's respawn), as elkjs's does
 * (`e2e/tree.spec.ts` records both; 07 §2.1 F33, not fixed).
 */

export type LayoutFn = (input: LayoutInput, ctx: LayoutContext) => LayoutResult;

/** `descriptor` plus a `layout()` that runs what `load` resolves to, loading
 *  it once. A rejected load is dropped and the next call runs `load` again;
 *  in a browser the failed `import()` inside it is cached, so that call
 *  fails too (F33). */
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

/** The chunk's layout function `name`. The name is a parameter, not a
 *  property written out, so the bundler cannot tell which exports are used
 *  and keeps them all: the chunk also exports `sinTurn`/`cosTurn`, which
 *  `apps/web/test/std-trees-chunk.test.ts` checks, as built, against the
 *  trig golden (B5 branch 5, fix round 1, item 5). */
const fromTrees = async (name: 'layoutTree' | 'layoutRadial'): Promise<LayoutFn> => (await import('./std-trees.js'))[name];

/** `tree` (DD-12 §8): Buchheim–Walker over the spanning forest, elbow edges.
 *  Pure, so a bundle that imports this package without registering `tree`
 *  (the page, via `/descriptor`, or a test worker) carries neither the stub
 *  nor the chunk. */
export const treeEngine: LayoutEngine = /* @__PURE__ */ lazyEngine(treeDescriptor, () => fromTrees('layoutTree'));

/** `radial` (DD-12 §9): a wedge layout over the same spanning forest, from
 *  the same chunk (N52); pure, as `treeEngine` is. The two stubs load the
 *  chunk each on its own first call, but a module is imported once, so the
 *  second costs no fetch. */
export const radialEngine: LayoutEngine = /* @__PURE__ */ lazyEngine(radialDescriptor, () => fromTrees('layoutRadial'));
