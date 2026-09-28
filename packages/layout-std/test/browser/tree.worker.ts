import { createWorkerRuntime, EngineRegistry, type HostToWorker, type WorkerToHost } from '../../../layout-api/src/index.js';
import { treeEngine } from '../../src/lazy.js';

/**
 * The worker entry for `tree.browser.test.ts` (feat/b5-tree): the real
 * `treeEngine` in a real `Worker`, registered alone, as `grid.worker.ts`
 * registers `grid` (see there for why each real engine has its own entry).
 * Its `layout()` imports the `std-trees` chunk inside this worker on the
 * first request, as the app's worker does.
 */

const registry = new EngineRegistry();
registry.register(treeEngine);

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
