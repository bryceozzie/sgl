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
  // Test-only probe (fix round 1, item 19): report whether this worker's
  // global scope has a `document` — K11's stub must leave none behind.
  if ((ev.data as { t: string }).t === 'probe-document') {
    (scope as unknown as { postMessage(m: unknown): void }).postMessage({ t: 'probe-document', type: typeof (self as unknown as { document?: unknown }).document });
    return;
  }
  runtime.receive(ev.data);
});
