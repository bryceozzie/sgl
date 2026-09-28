import { createWorkerRuntime, EngineRegistry, type HostToWorker, type WorkerToHost } from '../../../layout-api/src/index.js';
import { fixedEngine, gridEngine } from '../../../layout-std/src/index.js';
import { elkEngine } from '../../src/index.js';

/**
 * The worker entry for `compose.browser.test.ts` (B8 branch 2): the real
 * engines `layout.worker.ts` registers that a plan can name here (`elk`,
 * `grid`, `fixed`), behind the real runtime, with the composer loaded by a
 * dynamic `import()` on the first request with a plan, as in the app.
 */

const registry = new EngineRegistry();
registry.register(elkEngine);
registry.register(gridEngine);
registry.register(fixedEngine);

/** See `apps/web/src/layout.worker.ts` for why this is cast through `unknown`. */
interface WorkerGlobalScopeLike {
  postMessage(message: WorkerToHost): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: HostToWorker }) => void): void;
}

const scope = self as unknown as WorkerGlobalScopeLike;
const runtime = createWorkerRuntime(
  registry,
  {
    post: (message) => {
      scope.postMessage(message);
    },
  },
  () => import('../../../layout-api/src/compose.js').then((m) => m.composeLayout),
);
scope.addEventListener('message', (ev) => {
  runtime.receive(ev.data);
});
