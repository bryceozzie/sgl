import { createWorkerRuntime, EngineRegistry, type HostToWorker, type WorkerToHost } from '../../../layout-api/src/index.js';
import { fixedEngine } from '../../src/fixed.js';

/**
 * The worker entry for `fixed.browser.test.ts` (feat/b5-fixed): the real
 * `fixedEngine` in a real `Worker`, registered alone, as `grid.worker.ts`
 * registers `grid` (see there for why each real engine has its own entry).
 */

const registry = new EngineRegistry();
registry.register(fixedEngine);

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
