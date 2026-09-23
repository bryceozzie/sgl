import { createWorkerRuntime, EngineRegistry, type HostToWorker, type WorkerToHost } from '../../../layout-api/src/index.js';
import { elkEngine } from '../../src/index.js';

/**
 * The dedicated worker entry for `elk.browser.test.ts` (Stage K): the real
 * `elkEngine` — with elkjs loaded by its own dynamic `import()` on the first
 * request, as in the app — inside a real `Worker`, behind the real worker
 * runtime. Its own entry, like `layout-std/test/browser/grid.worker.ts`, so a
 * real engine's import graph never shares a file with `layout-api`'s
 * synthetic fixture engines.
 */

const registry = new EngineRegistry();
registry.register(elkEngine);

/** See `apps/web/src/layout.worker.ts` for why this is cast through `unknown`. */
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
scope.addEventListener('message', (ev) => {
  runtime.receive(ev.data);
});
