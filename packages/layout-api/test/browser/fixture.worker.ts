import { createWorkerRuntime, EngineRegistry, LAYOUT_API_VERSION, type HostToWorker, type LayoutEngine, type WorkerToHost } from '../../src/index.js';

/**
 * The browser project's own worker entry (decision D2's "browser tests use their
 * own test-fixture worker entry"), a real `Worker` this time rather than the Node
 * fake `host.test.ts` drives. It wires the same `createWorkerRuntime` the real
 * `apps/web/src/layout.worker.ts` uses, but registers small synthetic engines
 * instead of `gridEngine` so `host.browser.test.ts` can force each Stage H gate
 * condition on demand (a hang, a throw, malformed output, a measure miss)
 * without depending on `grid`'s own timing or geometry.
 *
 * Imports `../../src/index.js` (source), not the published `@sgl/layout-api`
 * package, so an edit to `host.ts`/`worker-runtime.ts` is picked up by Vite's dev
 * server on the next test run with no package rebuild — the same reason every
 * other `layout-api` test imports from `../src/*`.
 */

const EMPTY_RESULT = { bounds: { x: 0, y: 0, w: 10, h: 10 }, nodes: {}, edges: {}, labels: [] };

function capabilities(): LayoutEngine['capabilities'] {
  return { containers: false, edgeRouting: 'straight', ports: false, labelPlacement: false, incremental: false, determinism: 'bitwise' };
}

const registry = new EngineRegistry();

registry.register({
  id: 'test.ok',
  name: 'test.ok',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: capabilities(),
  layout: () => Promise.resolve(EMPTY_RESULT),
});

registry.register({
  id: 'test.slow',
  name: 'test.slow',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: capabilities(),
  // Never settles — forces the host's timeout path deterministically, with no
  // reliance on real timing tolerances the way a "just slow" engine would need.
  layout: () => new Promise(() => {}),
});

registry.register({
  id: 'test.throws',
  name: 'test.throws',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: capabilities(),
  layout: () => {
    throw new Error('fixture engine failure');
  },
});

registry.register({
  id: 'test.malformed',
  name: 'test.malformed',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: capabilities(),
  // Omits every node — `validateResult` rejects this with SGL4002 whenever the
  // caller's `SemanticGraph` has at least one visible node.
  layout: () => Promise.resolve({ bounds: { x: 0, y: 0, w: 1, h: 1 }, nodes: {}, edges: {}, labels: [] }),
});

registry.register({
  id: 'test.measuring',
  name: 'test.measuring',
  version: '0.0.0',
  apiVersion: LAYOUT_API_VERSION,
  capabilities: capabilities(),
  layout: async (_input, ctx) => {
    const layout = (await ctx.measure.layoutRunsAsync([{ text: 'probe' }], { maxWidth: 100 })) as { size: { w: number; h: number } };
    // The measured size comes back as node `a`'s frame: `bounds` itself is
    // recomputed by the host (DD-06 §5, F14), so it cannot carry it.
    return { bounds: { x: 0, y: 0, w: 1, h: 1 }, nodes: { a: { frame: { x: 0, y: 0, w: layout.size.w, h: layout.size.h } } }, edges: {}, labels: [] };
  },
});

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
