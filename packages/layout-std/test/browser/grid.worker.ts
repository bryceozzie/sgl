import { createWorkerRuntime, EngineRegistry, type HostToWorker, type WorkerToHost } from '../../../layout-api/src/index.js';
import { gridEngine } from '../../src/grid.js';

/**
 * The dedicated worker entry for `grid.browser.test.ts` (Stage H fix round 1,
 * item 3): the **real** `gridEngine`, run inside a **real** `Worker`, proving
 * `apps/web/src/layout.worker.ts`'s own goal — "layout runs off the main
 * thread" — for the one engine that ships. `layout-std` may import
 * `layout-api` (DD-00 §2 rule 3), so this imports both by relative path
 * (`../../src/*`, `../../../layout-api/src/*`) rather than the published
 * packages, the same reason every other in-repo worker/fixture entry does: an
 * edit to either package's source is picked up on the next test run with no
 * rebuild.
 *
 * This is a **second**, separate worker entry from `layout-api/test/browser/
 * fixture.worker.ts` — not that file with `gridEngine` added to it — because
 * `layout-api`'s own fixture worker exists specifically to force each Stage H
 * gate condition on demand with small synthetic engines (D2's "browser tests
 * use their own test-fixture worker entry"), and mixing a real engine's own
 * import graph into that shared file is exactly what looked like it broke
 * every engine in it during the first fix round — later shown to be an
 * unrelated, intermittent Vite dev-server cache issue (see this stage's
 * report), but keeping the real engine in its own dedicated worker avoids
 * ever depending on that not recurring.
 */

const registry = new EngineRegistry();
registry.register(gridEngine);

/** See `apps/web/src/layout.worker.ts` for why this is cast through `unknown`
 *  rather than pulling in `WebWorker` lib. */
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
