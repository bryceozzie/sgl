import type { LabelId, Size } from '@sgl/core';
import type { EngineSchemas, LayoutHost, ResolvedThemeMetricsView } from '@sgl/layout-api';
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

/** The synchronous stages DD-08 §13's error boundary wraps individually —
 *  also the argument `PipelineDeps.unsafeInjectStageThrow` receives. */
export type GuardedStageName = 'parse' | 'resolve' | 'compile' | 'resolveTheme' | 'styleGraph' | 'render';

/** Everything the pipeline needs from the outside world, injected so it stays
 *  DOM-free and Node-testable (I3): the real layout host, the real measurer and
 *  the real debounce clock in the app; fakes in tests. */
export interface PipelineDeps {
  readonly measurer: AppMeasurer;
  readonly host: LayoutHost;
  readonly metrics: ResolvedThemeMetricsView;
  /** The engine the app starts with. Chosen by the caller from what is actually
   *  registered in the worker — `sgl.elk` since Stage K (ADR-0005), which is
   *  also `@sgl/layout-api`'s `DEFAULT_ENGINE_ID`. */
  readonly defaultEngineId: string;
  readonly defaultThemeId?: string;
  readonly schedule?: Schedule;
  /** The registered engines' option and hint schemas, by id — what SGL4010
   *  (`layoutConfigDiagnostics`, fix round 1 item 23) checks the document's
   *  `@layout` keys against. Absent: only the nested-engine case is checked. */
  readonly engineSchemas?: (engineId: string) => EngineSchemas | undefined;
  readonly debounceMs?: number;
  /**
   * Test-only fault injection for DD-08 §13's error boundary: called at the
   * start of every recompute of each guarded synchronous stage, with that
   * stage's name, so a test can make exactly one stage throw. `parse`/
   * `resolve`/`compile`/`resolveTheme`/`styleGraph`/`render` themselves are
   * plain module-level imports, not part of this injected-dependency surface
   * (DD-00 §1 says none of them throws on bad *document* input, so there is
   * no crafted document that provokes one) — this is the one deliberately
   * narrow seam that simulates one of them violating that contract without
   * reaching into `@sgl/*` internals. Never set outside a test.
   */
  readonly unsafeInjectStageThrow?: (stage: GuardedStageName) => void;
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
