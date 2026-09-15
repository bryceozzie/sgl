import type { Diagnostic } from '@sgl/core';
import type { LayoutInput, LayoutResult, ResolvedThemeMetricsView } from './contract.js';

/** The worker wire protocol (DD-06 §3). Every payload is `structuredClone`-able,
 *  which is why no public type uses a class or a `Map` (DD-00 §3). */

export type HostToWorker =
  | {
      readonly t: 'layout';
      readonly id: number;
      readonly engine: string;
      readonly input: LayoutInput;
      readonly options: Readonly<Record<string, unknown>>;
      readonly metrics: ResolvedThemeMetricsView;
      readonly table: Readonly<Record<string, unknown>>;
      readonly seed: number;
    }
  | { readonly t: 'abort'; readonly id: number }
  | { readonly t: 'measure-reply'; readonly id: number; readonly req: number; readonly layout: unknown };

export type WorkerToHost =
  | { readonly t: 'result'; readonly id: number; readonly result: LayoutResult; readonly ms: number }
  | { readonly t: 'error'; readonly id: number; readonly diagnostic: Diagnostic }
  /** Table miss — the host measures on the main thread and replies. */
  | { readonly t: 'measure'; readonly id: number; readonly req: number; readonly runs: readonly unknown[]; readonly box: Readonly<Record<string, unknown>> }
  | { readonly t: 'log'; readonly id: number; readonly level: 'info' | 'warn' | 'error'; readonly message: string; readonly nodeId?: string };
