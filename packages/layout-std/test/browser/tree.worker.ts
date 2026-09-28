import {
  createWorkerRuntime,
  EngineRegistry,
  type HostToWorker,
  type LayoutContext,
  type LayoutInput,
  type ResolvedThemeMetricsView,
  type WorkerToHost,
} from '../../../layout-api/src/index.js';
import { treeEngine } from '../../src/lazy.js';

/**
 * The worker entry for `tree.browser.test.ts` (feat/b5-tree): the real
 * `treeEngine` in a real `Worker`, registered alone, as `grid.worker.ts`
 * registers `grid` (see there for why each real engine has its own entry).
 * Its `layout()` imports the `std-trees` chunk inside this worker on the
 * first request, as the app's worker does. It also answers the test's
 * `raw-tree` message with the engine's raw output, computed here.
 */

const registry = new EngineRegistry();
registry.register(treeEngine);

/** Fix round 1, item 8: the test's own request for the engine's *raw*
 *  output computed in this worker, outside the protocol (which only returns
 *  the finished, quantized result). */
interface RawRequest {
  readonly t: 'raw-tree';
  readonly input: LayoutInput;
  readonly metrics: ResolvedThemeMetricsView;
}

interface WorkerGlobalScopeLike {
  postMessage(message: WorkerToHost | { readonly t: 'raw-tree'; readonly json: string }): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: HostToWorker | RawRequest }) => void): void;
}

const scope = self as unknown as WorkerGlobalScopeLike;
const runtime = createWorkerRuntime(registry, {
  post: (message) => {
    scope.postMessage(message);
  },
});
scope.addEventListener('message', (ev) => {
  const data = ev.data;
  if (data.t === 'raw-tree') {
    const ctx = { options: {}, metrics: data.metrics, measure: {}, random: () => 0, signal: new AbortController().signal, log: () => {} } as unknown as LayoutContext;
    void treeEngine.layout(data.input, ctx).then((result) => scope.postMessage({ t: 'raw-tree', json: JSON.stringify(result) }));
    return;
  }
  runtime.receive(data);
});
