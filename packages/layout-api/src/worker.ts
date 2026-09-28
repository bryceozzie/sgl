/**
 * `@sgl/layout-api/worker` — what the layout worker's entry needs and no more
 * (B8 branch 2, DD-10 §2): the runtime and the registry. Its own entry, so
 * the bundle splits the modules only the lazy composer uses (`validate.ts`,
 * `host.ts`) from the ones the worker's boot path uses, and the composer's
 * checks are carried by its lazy chunk alone (`check-core-chunks.mjs`).
 */

export type { HostToWorker, WorkerToHost } from './protocol.js';
export { EngineRegistry } from './registry.js';
export { createWorkerRuntime, type ComposeLoader, type WorkerRuntime, type WorkerRuntimePort } from './worker-runtime.js';
