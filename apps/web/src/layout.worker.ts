import { createWorkerRuntime, EngineRegistry, type HostToWorker, type WorkerToHost } from '@sgl/layout-api';
import { elkEngine } from '@sgl/layout-elk';
import { fixedEngine, gridEngine, treeEngine } from '@sgl/layout-std';

/**
 * The real layout worker entry (Stage H, decision D2). Everything that runs
 * *inside* the worker lives in `@sgl/layout-api`'s `worker-runtime.ts`, which is
 * `Worker`-free so it can be driven by a Node unit test; this file is the thin,
 * Worker-only wiring DD-10 §2 describes — `new Worker(new URL('./layout.worker.ts',
 * import.meta.url), { type: 'module' })` from the host side — plus the engine
 * registration `@sgl/layout-api` itself may not do (DD-00 §2 rule 3: an engine
 * package may import `@sgl/layout-api` and `@sgl/core`, not the other way round,
 * so the registry has to be assembled somewhere both are visible — here).
 *
 * Stage K registers `elk` (ADR-0005's default engine). Importing it costs only
 * its mapping code: elkjs itself is a dynamic `import()` inside
 * `elkEngine.layout()`, emitted as its own `elk` chunk (`vite.config.ts`) and
 * fetched on the first elk request, with elkjs's scoped `document` stub
 * (decision K11) inside `@sgl/layout-elk`, not here.
 */

const registry = new EngineRegistry();
registry.register(elkEngine);
registry.register(gridEngine);
// B5 branch 2 (DD-12 H9): `fixed` is static in the worker, so the escape
// hatch works on the first request with no fetch.
registry.register(fixedEngine);
// B5 branch 4 (DD-12 H9, N52): `tree` is a static descriptor whose
// `layout()` imports the lazy `std-trees` chunk on the first tree request.
registry.register(treeEngine);

/** `self` in a module worker is typed as `Window & typeof globalThis` by this
 *  app's own `DOM` lib (needed for `App.tsx`'s use of `window`/`document`) rather
 *  than `DedicatedWorkerGlobalScope` — the two lib files conflict if both are
 *  listed for one `tsconfig`, and this app has exactly one. The narrow structural
 *  type below is all this file needs from the worker global scope, so it is cast
 *  through `unknown` rather than pulling in `WebWorker` lib for the whole app. */
interface WorkerGlobalScopeLike {
  postMessage(message: WorkerToHost): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: HostToWorker }) => void): void;
}

const scope = self as unknown as WorkerGlobalScopeLike;

const runtime = createWorkerRuntime(registry, {
  post: (message) => {
    scope.postMessage(message);
  },
});

scope.addEventListener('message', (ev: { readonly data: HostToWorker }) => {
  runtime.receive(ev.data);
});
