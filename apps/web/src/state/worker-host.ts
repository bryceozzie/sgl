import { createWorkerHost, type LayoutHost } from '@sgl/layout-api';
import type { BoxConstraints, StyledRun } from '@sgl/measure';
import type { AppMeasurer } from './types.js';

/**
 * Wires the real worker (task 3): `layout.worker.ts` (Stage H) is the one real
 * entry that registers `gridEngine` into a worker-side `EngineRegistry`; this is
 * the main-thread half, `createWorkerHost` from `@sgl/layout-api`, spawning it
 * lazily via a factory (so the host can respawn after a timeout, DD-06 §3).
 *
 * `measure` answers a worker `'measure'` RPC — a label an engine creates *during*
 * layout, which by construction cannot be in the pre-measured table (DD-06 §3).
 * No MVP engine does this (`grid` never calls `ctx.measure`), so this is here for
 * completeness/robustness rather than because anything currently exercises it.
 */
export function createAppWorkerHost(measurer: AppMeasurer): LayoutHost {
  return createWorkerHost(() => new Worker(new URL('../layout.worker.ts', import.meta.url), { type: 'module' }), {
    measure: (runs, box) => measurer.layoutRunsAsync(runs as readonly StyledRun[], box as BoxConstraints),
  });
}
