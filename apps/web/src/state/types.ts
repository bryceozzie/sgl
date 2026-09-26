import type { CompileOptions, CompileResult, Document, DocumentModel, LabelId, ResolveResult, Size, TextRun } from '@sgl/core';
import type { EngineSchemas, LayoutHost, ResolvedThemeMetricsView } from '@sgl/layout-api';
import type { LineModel, Measurer, TextStyle } from '@sgl/measure';
import type { LayoutResult } from '@sgl/layout-api';
import type { PaintPlan } from '@sgl/render-svg';
import type { StyledGraph } from '@sgl/theme';

/** The main-thread `Measurer` the measure effect drives (DD-05 §4). Widened with
 *  `ready`, which `Measurer` itself does not declare (it is `CanvasMeasurer`'s own
 *  addition) but every real caller needs before the first pre-measure. */
export interface AppMeasurer extends Measurer {
  ready(styles: readonly TextStyle[]): Promise<void>;
  /** The line model (DD-11 §7): the pipeline hands it `layoutWrapped` once the
   *  lazy `rich-text` chunk has loaded (T53). */
  lineModel: LineModel;
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
  /** A9 (DD-08 §15, I25): loads the lazy `imports` chunk for the first
   *  document with `@imports`. Absent: such a document resolves without its
   *  imports, as `resolve()` does. */
  readonly loadImports?: () => Promise<ImportsRuntime>;
  /** A18 (DD-11 T53): loads the lazy `rich-text` chunk — the inline parser and
   *  the word breaker — for the first document with markup in a label
   *  (`needsInline`) or a label to wrap (`needsWrap`). Absent: labels compile
   *  without the parser (one plain run each), and nothing hands the measurer
   *  `layoutWrapped`, so a label with a box (`@size.maxWidth` or `@size.width`)
   *  makes the default `layoutLines` **throw** during pre-measure (DD-11 §7), a
   *  pipeline error. A caller without it must give its measurer `layoutWrapped`
   *  itself, as the Node test harnesses do. */
  readonly loadRichText?: () => Promise<RichText>;
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

/** A9's lazy `imports` chunk as the pipeline uses it (`state/imports.ts`):
 *  `@sgl/core/imports`' resolve and compile over the stored documents. */
export interface ImportsRuntime {
  /** `self` is the open document's id. */
  resolve(ast: Document, self: string): ResolveResult;
  compile(model: DocumentModel, options?: CompileOptions): CompileResult;
}

/** A18's lazy `rich-text` chunk (`state/rich-text.ts`, DD-11 T53). */
export interface RichText {
  /** `parseInline` from `@sgl/core/inline`. */
  readonly inline: (text: string) => readonly TextRun[];
  /** `layoutWrapped` from `@sgl/text/wrap`. */
  readonly lineModel: LineModel;
}

/** What the canvas shows (DD-08 §3, §6). Updated only when `svg` exists **and**
 *  `diags` has no error diagnostic — FR-E4 in one line. */
export interface LastGood {
  readonly styled: StyledGraph;
  readonly layout: LayoutResult;
  /** Exactly `render(styled, layout)`'s bytes. After a paint-only render
   *  (F9 P3) a getter that derives it on first read (P4): read it only where
   *  the string itself is needed (export, autosave, Save ▾ SVG), never on a
   *  theme switch's own path. */
  readonly svg: string;
  readonly styleBlock: string;
  /** The element tree this render is drawn as (`RenderResult.paintPlan`):
   *  two `LastGood`s with the same plan differ only in their `<style>` text,
   *  so the canvas can swap that text into the tree it already shows. */
  readonly paintPlan: PaintPlan;
}

/** A label's measured size, keyed by label id — what `buildLayoutInput` needs
 *  alongside a `StyledGraph`. */
export type LabelSizes = Readonly<Record<LabelId, Size>>;
