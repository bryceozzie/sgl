import { NotImplemented, type StageResult } from '@sgl/core';
import type { LayoutInput, LayoutResult, ResolvedThemeMetricsView } from './contract.js';

/** Default hard timeout. On expiry the host terminates the worker, respawns it,
 *  surfaces SGL4001 and keeps the previous layout (Architecture §4.4). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Runs an engine off the main thread.
 *
 * MVP: a plain `Worker` with a timeout and an `AbortController`. That is the half
 * that protects the *user* — from a hung layout. Cross-origin iframe isolation,
 * which protects the user from *malicious code*, ships with B17; the `LayoutHost`
 * interface is the same either way (06 §4, pitfall 5).
 */
export interface LayoutHost {
  run(
    engineId: string,
    input: LayoutInput,
    options: Readonly<Record<string, unknown>>,
    metrics: ResolvedThemeMetricsView,
    table: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<StageResult<LayoutResult | null>>;

  dispose(): void;
}

export function createWorkerHost(worker: Worker, timeoutMs = DEFAULT_TIMEOUT_MS): LayoutHost {
  void worker;
  void timeoutMs;
  throw new NotImplemented('createWorkerHost()', 'DD-06 §3');
}
