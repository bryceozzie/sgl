import type { LabelId, Size } from '@sgl/core';
import type { LayoutHost, ResolvedThemeMetricsView } from '@sgl/layout-api';
import type { Measurer, TextStyle } from '@sgl/measure';
import type { LayoutResult } from '@sgl/layout-api';
import type { StyledGraph } from '@sgl/theme';

/** The main-thread `Measurer` the measure effect drives (DD-05 §4). Widened with
 *  `ready`, which `Measurer` itself does not declare (it is `CanvasMeasurer`'s own
 *  addition) but every real caller needs before the first pre-measure. */
export interface AppMeasurer extends Measurer {
  ready(styles: readonly TextStyle[]): Promise<void>;
}

/** Cancels a scheduled callback. */
export type Cancel = () => void;

/** Schedules `fn` to run once, `ms` after this call, returning a canceller.
 *  Injected (I3) so the layout effect's 120 ms debounce is Node-testable without
 *  real timers: a test supplies a scheduler it can fire on demand instead of
 *  waiting on the clock. Defaults to real `setTimeout`/`clearTimeout`. */
export type Schedule = (fn: () => void, ms: number) => Cancel;

/** Everything the pipeline needs from the outside world, injected so it stays
 *  DOM-free and Node-testable (I3): the real layout host, the real measurer and
 *  the real debounce clock in the app; fakes in tests. */
export interface PipelineDeps {
  readonly measurer: AppMeasurer;
  readonly host: LayoutHost;
  readonly metrics: ResolvedThemeMetricsView;
  /** The engine the app starts with. Chosen by the caller from what is actually
   *  registered in the worker (I1) — `@sgl/layout-api`'s frozen
   *  `DEFAULT_ENGINE_ID` names `sgl.elk`, which is not registered until Stage K. */
  readonly defaultEngineId: string;
  readonly defaultThemeId?: string;
  readonly schedule?: Schedule;
  readonly debounceMs?: number;
}

/** What the canvas shows (DD-08 §3, §6). Updated only when `svg` exists **and**
 *  `diags` has no error diagnostic — FR-E4 in one line. */
export interface LastGood {
  readonly styled: StyledGraph;
  readonly layout: LayoutResult;
  readonly svg: string;
  readonly styleBlock: string;
}

/** A label's measured size, keyed by label id — what `buildLayoutInput` needs
 *  alongside a `StyledGraph`. */
export type LabelSizes = Readonly<Record<LabelId, Size>>;
