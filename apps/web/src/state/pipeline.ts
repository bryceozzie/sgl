import { computed, effect, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { Tree } from '@lezer/common';
import {
  buildAst,
  compile,
  hasImports,
  parse,
  resolve,
  type CompileResult,
  type Diagnostic,
  type Document as SglDocument,
  type LabelId,
  type ResolveResult,
  type StageResult,
} from '@sgl/core';
import { buildLayoutInput, layoutConfigDiagnostics, type LayoutInput, type LayoutResult } from '@sgl/layout-api';
import { labelRunKey, premeasure, type MeasureTable } from '@sgl/measure';
import { BUILT_IN, DEFAULT_THEME_ID, resolveTheme, styleGraph, type ResolvedTheme, type StyledGraph } from '@sgl/theme';
import { render, renderPaintOnly, type RenderResult } from '@sgl/render-svg';
import { boundsChangedSignificantly, type Extent } from '../canvas/viewport.js';
import { deriveChipState, type ChipState } from './chip.js';
import { optionsForEngine } from './engine-options.js';
import { distinctTextStyles } from './measure-styles.js';
import { documentEngineOverride, documentThemeOverride } from './overrides.js';
import { makePipelineError, type PipelineError } from './pipeline-error.js';
import type { Cancel, GuardedStageName, ImportsRuntime, LabelSizes, LastGood, PipelineDeps, Schedule } from './types.js';

const DEFAULT_DEBOUNCE_MS = 120;
/** DD-08 §11: the chip shows "laying out…" only after this long in flight, so
 *  a fast layout never flashes it. */
const LAYING_OUT_DELAY_MS = 300;

function defaultSchedule(fn: () => void, ms: number): Cancel {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** Thrown by a stage that holds, without an error (A9, I25): it blocks the
 *  stages below it like a throw, and nothing is reported. */
const HOLD = Symbol('hold');

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** One guarded stage's latest outcome: the value downstream computeds read,
 *  what (if anything) this recompute threw, and whether the stage is frozen —
 *  because it threw, or because a stage it reads from is frozen. */
interface StageOutcome<T> {
  readonly value: T;
  readonly error: unknown;
  readonly blocked: boolean;
}

/** DD-08 §13: "a thrown error **anywhere** in the pipeline… is caught at the
 *  effect boundary." `compute()` is one synchronous stage call.
 *
 *  - On success, `value` is the fresh result.
 *  - On a throw, `value` is whatever the *last successful* call produced, and
 *    `error` carries what was thrown, for the reporting effect to log and
 *    surface. Downstream computeds keep reading a stable, valid input.
 *  - While any `upstream` stage is blocked, this one does not run at all and
 *    holds its last value too — otherwise a fan-in stage (`styleGraph` reads
 *    `compile`'s graph *and* `resolve`'s classes) would recompute from one
 *    fresh input and one frozen one, a pairing no real document produces. So
 *    the chain freezes at last-good from the throwing stage down, exactly as a
 *    document error freezes `lastGood`.
 *
 *  With no successful call yet (a throw on the very first, boot-time pass),
 *  `value` is `fallback()` — the stage over the empty document — so the
 *  pipeline still constructs and the editor still mounts; the next edit that
 *  stops throwing recovers normally. The computed itself never throws. */
function guardedStage<T>(
  upstream: readonly ReadonlySignal<StageOutcome<unknown>>[],
  compute: () => T,
  fallback: () => T,
): ReadonlySignal<StageOutcome<T>> {
  let last: { readonly value: T } | null = null;
  const held = (): T => (last === null ? fallback() : last.value);
  return computed(() => {
    // Read every upstream outcome (not `.some`, which would stop at the first
    // and leave this computed unsubscribed from the rest).
    const upstreamBlocked = upstream.map((u) => u.value.blocked);
    if (upstreamBlocked.includes(true)) return { value: held(), error: undefined, blocked: true };
    try {
      const value = compute();
      last = { value };
      return { value, error: undefined, blocked: false };
    } catch (err) {
      return { value: held(), error: err, blocked: true };
    }
  });
}

/** Every synchronous stage run over the empty document with the default theme —
 *  `guardedStage`'s boot-time fallback. Built lazily, once, only if a stage
 *  ever throws before its first success; all real, pure calls on trivial
 *  input (DD-00 §1: none of them throws on a *document*, and this one is
 *  empty). */
interface EmptyStages {
  readonly parsed: StageResult<SglDocument>;
  readonly model: ResolveResult;
  readonly graph: CompileResult;
  readonly theme: StageResult<ResolvedTheme>;
  readonly styled: StageResult<StyledGraph>;
}
let emptyStagesMemo: EmptyStages | null = null;
function emptyStages(): EmptyStages {
  if (emptyStagesMemo === null) {
    const parsed = buildAst(parse('').tree, '');
    const model = resolve(parsed.value);
    const graph = compile(model.model);
    const theme = resolveTheme(BUILT_IN[DEFAULT_THEME_ID]!, (id) => BUILT_IN[id]);
    const styled = styleGraph(graph.graph, theme.value, model.model.classes);
    emptyStagesMemo = { parsed, model, graph, theme, styled };
  }
  return emptyStagesMemo;
}

/** A deterministic key for `engineOptions` equality — sorted so key order never
 *  matters (DD-00 §3's spirit, even though apps/web sits outside that lint ban). */
function optionsKey(options: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(options, Object.keys(options).sort());
}

/** The `LabelId -> Size` map `buildLayoutInput` needs, read out of the
 *  pre-measure `table` the same way `packages/render-svg/test/pipeline.ts`'s
 *  reference harness does — the one place this exact composition already exists
 *  end to end. */
function labelSizesOf(styled: StyledGraph, table: MeasureTable): LabelSizes {
  const sizes: Record<LabelId, { w: number; h: number }> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    sizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  return sizes;
}

export interface Pipeline {
  // ---- inputs (DD-08 §3) ---------------------------------------------------
  readonly engineId: Signal<string>;
  readonly engineOptions: Signal<Readonly<Record<string, unknown>>>;
  readonly themeId: Signal<string>;
  readonly docId: Signal<string>;

  /** The editor calls this from `EditorView.updateListener` with its own
   *  already-parsed tree (DD-01 §5) — `parsed` below reuses it and the pipeline
   *  never calls `parser.parse` itself. The tree must span the whole of
   *  `source` (F19, DD-08 §4); a shorter one is refused as a programming
   *  error rather than read as a document that ends early. */
  setDocument(tree: Tree, source: string): void;
  readonly source: ReadonlySignal<string>;

  // ---- synchronous derivations --------------------------------------------
  // Each holds the *whole* StageResult (value + diagnostics), not just the
  // unwrapped value — DD-08 §3's pseudocode already assumes this shape itself
  // (`graph.value.graph`), it just never shows the `.value`/`.diagnostics` split
  // for the stages in between; kept literal here rather than flattened, since
  // `diags` below needs every stage's diagnostics, not only the last one's.
  readonly parsed: ReadonlySignal<StageResult<SglDocument>>;
  readonly model: ReadonlySignal<ResolveResult>;
  readonly graph: ReadonlySignal<CompileResult>;
  readonly theme: ReadonlySignal<StageResult<ResolvedTheme>>;
  readonly styled: ReadonlySignal<StageResult<StyledGraph>>;
  readonly diags: ReadonlySignal<readonly Diagnostic[]>;
  /** A9 (DD-08 §15, I25): the document has `@imports` and the lazy chunk is
   *  still loading, so `model` and everything below it hold. */
  readonly held: ReadonlySignal<boolean>;
  /** The lazy `imports` runtime, once a document with `@imports` loaded it. */
  readonly imports: ReadonlySignal<ImportsRuntime | null>;

  // ---- document overrides (DD-08 §10) ----------------------------------------
  // `@theme` / `@layout.engine` in the document win over the pickers; `undefined`
  // means "no override, the picker's own signal above applies."
  readonly documentThemeId: ReadonlySignal<string | undefined>;
  readonly documentEngineId: ReadonlySignal<string | undefined>;
  /** What the pipeline actually runs under — the override if there is one,
   *  else the picker signal. */
  readonly effectiveThemeId: ReadonlySignal<string>;
  readonly effectiveEngineId: ReadonlySignal<string>;

  // ---- async stage state ----------------------------------------------------
  readonly table: Signal<MeasureTable>;
  readonly layout: Signal<LayoutResult | null>;
  readonly layoutDiags: Signal<readonly Diagnostic[]>;
  readonly inFlight: Signal<boolean>;

  // ---- what the canvas shows -------------------------------------------------
  readonly svg: ReadonlySignal<RenderResult | null>;
  readonly lastGood: Signal<LastGood | null>;

  // ---- DD-08 §11 status chip, §13 error boundary -----------------------------
  /** Caught at the effect boundary (§13); `null` when nothing has thrown. */
  readonly pipelineError: Signal<PipelineError | null>;
  /** DD-08 §6: offered when `lastGood.layout.bounds` changes by more than 40%
   *  since the last fit. The canvas clears it by calling `fitDone()`. */
  readonly chip: ReadonlySignal<ChipState>;
  /** Called by the canvas once it has fit the viewport (on open, or on the
   *  toolbar button), clearing the chip's "Fit" offer. */
  fitDone(): void;

  dispose(): void;
}

/**
 * Builds the signal graph and pipeline orchestration (DD-08 §3), DOM-free and
 * driven entirely by injected dependencies (I3) — safe to construct and drive
 * from a plain Vitest Node test with no `Worker`, no `document`, and full control
 * over the debounce clock.
 */
export function createPipeline(deps: PipelineDeps, initialSource = ''): Pipeline {
  const schedule: Schedule = deps.schedule ?? defaultSchedule;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const initial = parse(initialSource);
  const doc = signal<{ readonly tree: Tree; readonly source: string }>({ tree: initial.tree, source: initialSource });

  const engineId = signal(deps.defaultEngineId);
  const engineOptions = signal<Readonly<Record<string, unknown>>>({});
  const themeId = signal(deps.defaultThemeId ?? DEFAULT_THEME_ID);
  const docId = signal('');

  const source = computed(() => doc.value.source);
  const pipelineError = signal<PipelineError | null>(null);

  /** DD-08 §13's "caught, **logged**, shown": the original error object goes
   *  to the console (stack preserved — `console.error` keeps an `Error`'s own
   *  stack, where `describeError`'s message-only string would drop it), and
   *  `makePipelineError` builds the chip's copy (message + source hash, never
   *  the source). Every boundary below reports through this one function. */
  function reportPipelineError(err: unknown, srcSnapshot: string): void {
    console.error('[SGL] pipeline error (DD-08 §13):', err);
    pipelineError.value = makePipelineError(err, srcSnapshot);
  }

  const inject = (stage: GuardedStageName): void => deps.unsafeInjectStageThrow?.(stage);

  // §13's error boundary on every synchronous stage — "anywhere in the
  // pipeline," not just `render()`. Each stage is its own `guardedStage`, so a
  // throw in, say, `compile` freezes `graph`/`styled` (and everything below)
  // at their last good values while `parsed`/`model` upstream of it keep
  // updating normally. The public `parsed`/`model`/… signals keep DD-08 §3's
  // shape: each unwraps its outcome's `value`. Every stage reads its signal
  // inputs *before* the injection point (and so before the stage call itself,
  // as argument evaluation already guarantees for a real throw): a computed
  // that throws before reading a dependency never subscribes to it, and could
  // then never recompute to recover.
  const parsedOutcome = guardedStage(
    [],
    () => {
      const { tree, source: text } = doc.value;
      // F19: a tree shorter than its text is a parse cut short, never a
      // document. `buildAst` would read it as one that ends at the cut (an
      // SGL1001 there, every node after it gone); refusing it here holds the
      // last good stages and reports a programming error (§13) instead.
      if (tree.length !== text.length) throw new Error(`the editor's parse tree covers ${tree.length} of ${text.length} characters (F19)`);
      inject('parse');
      return buildAst(tree, text);
    },
    () => emptyStages().parsed,
  );
  const parsed = computed<StageResult<SglDocument>>(() => parsedOutcome.value.value);

  // A9 (DD-08 §15, I25): a document with `@imports` is resolved by the lazy
  // `imports` chunk, and until it has loaded the model stage holds — the
  // canvas keeps the stored picture, and no render missing the imported
  // classes can become `lastGood`. Loading failed: it resolves without them.
  const imports = signal<ImportsRuntime | null>(null);
  let importsLoad: Promise<void> | undefined;
  const modelOutcome = guardedStage(
    [parsedOutcome],
    () => {
      const ast = parsed.value.value;
      inject('resolve');
      if (hasImports(ast) && deps.loadImports) {
        const runtime = imports.value;
        if (runtime) return runtime.resolve(ast, docId.value);
        importsLoad ??= deps.loadImports().then(
          (loaded) => void (imports.value = loaded),
          (err: unknown) => {
            console.warn('[SGL] the imports could not be loaded.', err);
            imports.value = { resolve: (a) => resolve(a), compile: (m) => compile(m) };
          },
        );
        throw HOLD;
      }
      return resolve(ast);
    },
    () => emptyStages().model,
  );
  const model = computed<ResolveResult>(() => modelOutcome.value.value);
  const held = computed(() => modelOutcome.value.error === HOLD);

  // DD-08 §10: "@layout.engine / @theme in the document override the pickers."
  const documentThemeId = computed<string | undefined>(() => documentThemeOverride(model.value.model));
  const documentEngineId = computed<string | undefined>(() => documentEngineOverride(model.value.model));
  const effectiveThemeId = computed<string>(() => documentThemeId.value ?? themeId.value);
  const effectiveEngineId = computed<string>(() => documentEngineId.value ?? engineId.value);

  const graphOutcome = guardedStage(
    [modelOutcome],
    () => {
      const documentModel = model.value.model;
      inject('compile');
      const runtime = documentModel.imports && imports.value;
      return runtime ? runtime.compile(documentModel) : compile(documentModel);
    },
    () => emptyStages().graph,
  );
  const graph = computed<CompileResult>(() => graphOutcome.value.value);

  const themeOutcome = guardedStage(
    [modelOutcome], // `effectiveThemeId` reads the document's own `@theme`.
    () => {
      const themeSpec = BUILT_IN[effectiveThemeId.value] ?? BUILT_IN[DEFAULT_THEME_ID]!;
      inject('resolveTheme');
      return resolveTheme(themeSpec, (id) => BUILT_IN[id]);
    },
    () => emptyStages().theme,
  );
  const theme = computed<StageResult<ResolvedTheme>>(() => themeOutcome.value.value);

  const styledOutcome = guardedStage(
    [modelOutcome, graphOutcome, themeOutcome],
    () => {
      const semanticGraph = graph.value.graph;
      const resolvedTheme = theme.value.value;
      const classes = model.value.model.classes;
      inject('styleGraph');
      return styleGraph(semanticGraph, resolvedTheme, classes);
    },
    () => emptyStages().styled,
  );
  const styled = computed<StageResult<StyledGraph>>(() => styledOutcome.value.value);

  const table = signal<MeasureTable>({});
  const layout = signal<LayoutResult | null>(null);
  const layoutDiags = signal<readonly Diagnostic[]>([]);
  const inFlight = signal(false);

  // `render()` — the last synchronous stage, guarded the same way. Its
  // fallback is `null` ("nothing rendered"), which `lastGood`'s effect already
  // treats as "keep what is on screen". The outcome keeps the exact `styled`
  // and `layout` it rendered, so `lastGood` pairs an SVG with its own inputs
  // rather than with whatever `styled` holds by the time the effect runs.
  interface Rendered {
    readonly result: RenderResult;
    readonly styled: StyledGraph;
    readonly layout: LayoutResult;
  }
  //
  // The paint-only path (F9 P3, DD-08 §3): when only the effective theme has
  // changed since the last render — the same `graph` object (so the same
  // document), the same `layout` object and the same `geometryHash` — the
  // new render is made from the last one by `renderPaintOnly`, which
  // recomputes only the `<style>` text (one rule per distinct cascade
  // signature) and keeps the element tree (`paintPlan`); it also refuses
  // unless `structureHash` is unchanged. Anything else, or a refusal, is a
  // full `render()`. Either way the result is exactly what `render()` gives
  // for this `styled` and this `layout`; on the paint-only path its `svg` is
  // derived only when read (P4).
  //
  // "The same layout object" says the render is drawn with the layout the
  // full render was, not that this layout is current for the graph: after a
  // text edit, the full render is drawn with the old frames until the new
  // layout lands, and a theme switch in between restyles those same frames,
  // exactly as a full render would. Keeping the layout current is the layout
  // effect's job, which since fix round 1 (item 1) lays out again whenever
  // the `LayoutInput` differs from the one the landed layout was made from;
  // when it lands, `layout` is a new object and the next render is full.
  //
  // `geometryHash` below is also covered by `renderPaintOnly`'s own guard
  // (`structureHash` includes it): it is kept only as a cheap early exit
  // that skips hashing the structure when the geometry has visibly changed.
  let lastRendered: Rendered | null = null;
  const svgOutcome = guardedStage<Rendered | null>(
    [styledOutcome, themeOutcome],
    () => {
      const layoutValue = layout.value;
      if (layoutValue === null) return null;
      const styledValue = styled.value.value;
      const resolvedTheme = theme.value.value;
      inject('render');
      const previous = lastRendered;
      const paintOnly =
        previous !== null && previous.layout === layoutValue && previous.styled.graph === styledValue.graph && previous.styled.geometryHash === styledValue.geometryHash
          ? renderPaintOnly(previous.result, styledValue, layoutValue)
          : null;
      const rendered: Rendered = { result: paintOnly ?? render(styledValue, layoutValue, resolvedTheme), styled: styledValue, layout: layoutValue };
      lastRendered = rendered;
      return rendered;
    },
    () => null,
  );
  const svg = computed<RenderResult | null>(() => svgOutcome.value.value?.result ?? null);

  /** `lastGood` for a render. `svg` is a getter onto the result's own (P4):
   *  after a paint-only render it is derived from the last full string on
   *  first read, and nothing on the switch's own path reads it — the canvas
   *  swaps `styleBlock` into the tree it already shows (`paintPlan`), and
   *  autosave, Save ▾ SVG and the next boot read it later. */
  function lastGoodOf(rendered: Rendered): LastGood {
    const { result } = rendered;
    return {
      styled: rendered.styled,
      layout: rendered.layout,
      get svg(): string {
        return result.svg;
      },
      styleBlock: result.styleBlock,
      paintPlan: result.paintPlan,
    };
  }

  // One effect reports every guarded stage's `error` — kept as `{ value, error }`
  // pairs rather than written to `pipelineError` from inside a computed (a
  // computed's own callback stays a pure function of its dependencies). An
  // outcome only changes when its stage recomputes, but this effect also
  // re-runs when an *unrelated* stage recomputes; `lastReported` stops a
  // still-live error from being logged again on every such re-run. Clearing
  // `pipelineError` back to `null` is `disposeLastGoodEffect`'s job below —
  // "recovered" means a full clean cycle completed, not just "this one stage
  // stopped throwing while another still is."
  let lastReported: unknown = undefined;
  const disposeStageErrorEffect = effect(() => {
    const outcomes = [parsedOutcome.value, modelOutcome.value, graphOutcome.value, themeOutcome.value, styledOutcome.value, svgOutcome.value];
    const failed = outcomes.find((o) => o.error !== undefined && o.error !== HOLD);
    if (failed === undefined) {
      lastReported = undefined;
      return;
    }
    if (failed.error === lastReported) return;
    lastReported = failed.error;
    reportPipelineError(failed.error, doc.peek().source);
  });

  // DD-08 §3 names parsed/model/graph/layoutDiags; theme's and styled's own
  // diagnostics (a malformed theme token, an unknown style property) and the
  // renderer's (a disallowed link scheme) are real, user-visible diagnostics the
  // pseudocode's list simply omits — filled in per §1's "if a document is merely
  // incomplete, fill the gap the way the surrounding design implies."
  // SGL4010 (fix round 1, item 23; human decision 2026-09-23): the
  // document's `@layout` keys against the effective engine — a container's
  // own engine (B8/B9) and keys the engine does not declare are warned about
  // and ignored. From the parsed AST, where each key has its own span.
  const layoutConfigDiags = computed<readonly Diagnostic[]>(() => {
    const engineId = effectiveEngineId.value;
    return layoutConfigDiagnostics(parsed.value.value, deps.engineSchemas?.(engineId) ?? { id: engineId });
  });

  const diags = computed<readonly Diagnostic[]>(() => [
    ...parsed.value.diagnostics,
    ...model.value.diagnostics,
    ...graph.value.diagnostics,
    ...layoutConfigDiags.value,
    ...theme.value.diagnostics,
    ...styled.value.diagnostics,
    ...layoutDiags.value,
    ...(svg.value?.diagnostics ?? []),
  ]);

  const lastGood = signal<LastGood | null>(null);

  // -------------------------------------------------------------------------
  // Measure effect (DD-08 §3): fonts first, then pre-measure. `CanvasMeasurer`
  // (or any `AppMeasurer`) keeps its own per-run cache, which is what makes an
  // unchanged label's entry "reuse the previous table" in practice — the real
  // `premeasure(styled, measurer)` signature (`packages/measure/src/premeasure.ts`)
  // has no `previousTable` parameter to pass one through explicitly, unlike what
  // DD-08 §3's pseudocode calls it with; see the Stage I report for the deviation.
  // -------------------------------------------------------------------------
  let measureGeneration = 0;
  // Set once the *first* premeasure table has actually landed — the layout
  // effect below waits on it (found while chasing a real bug, not assumed up
  // front): `table` starts as `{}`, and without this guard the layout effect's
  // own dependency on `table` means it fires *immediately* on boot with that
  // empty table, laying out every label at `labelSizesOf`'s `{ w: 0, h: 0 }`
  // fallback — a real, briefly-visible "wrong size" layout that a *second*,
  // correctly-sized layout then overwrites once `ready()`/`premeasure()`
  // finish. DD-08 §14 test 8 (font gate) caught this: its "cold load" snapshot
  // landed on that first, wrongly-sized `lastGood` often enough to make the
  // cold/warm geometry comparison flaky. Fonts were never the issue — `document
  // .fonts` already reported every face "loaded" by the time either layout ran.
  let hasMeasuredOnce = false;
  // What the latest pre-measure was started for (F9). The table is a function
  // of the labels' text (the graph) and their text styles, which are
  // geometry (`geometryHash` covers every label style's geometry half), so a
  // styled graph with the same `graph` object and the same `geometryHash` —
  // a theme switch between themes of equal geometry — would produce the very
  // table already there: it is not measured again.
  let measuredFor: StyledGraph | null = null;
  const disposeMeasureEffect = effect(() => {
    const styledSnapshot = styled.value.value;
    void effectiveThemeId.value; // explicit dependency per DD-08 §3, alongside geometryHash below
    if (measuredFor !== null && measuredFor.graph === styledSnapshot.graph && measuredFor.geometryHash === styledSnapshot.geometryHash) return;
    measuredFor = styledSnapshot;
    const generation = (measureGeneration += 1);
    const sourceSnapshot = doc.peek().source;
    void (async () => {
      try {
        await deps.measurer.ready(distinctTextStyles(styledSnapshot));
        if (generation !== measureGeneration) return; // superseded by a newer edit
        // Set *before* writing `table.value`: `@preact/signals` reruns a
        // dependent effect synchronously, inline in this assignment — the
        // layout effect below reads `hasMeasuredOnce` on that same
        // synchronous re-run, so setting it after the write is one statement
        // too late and the guard never lifts (found by tracing exactly this).
        hasMeasuredOnce = true;
        table.value = premeasure(styledSnapshot, deps.measurer);
      } catch (err) {
        if (generation !== measureGeneration) return;
        if (measuredFor === styledSnapshot) measuredFor = null; // nothing landed: measure it again next time
        reportPipelineError(err, sourceSnapshot); // §13 effect boundary
      }
    })();
  });

  // -------------------------------------------------------------------------
  // Layout effect (DD-08 §3): debounced 120 ms, aborts an in-flight request
  // first, skips layout on a paint-only change and falls through to render.
  // -------------------------------------------------------------------------
  let debounceCancel: Cancel | null = null;
  let currentAbort: AbortController | null = null;
  let layoutGeneration = 0;
  // What the last layout that landed was computed from, so the next change
  // can tell whether its layout would be the same one (DD-08 §3's skip).
  //
  // Fix round 1, item 1: the skip compared only `geometryHash`, the engine
  // and its options, but the `LayoutInput` is also built from the graph (its
  // nodes, edges, labels and their spans) and the measured label sizes, so a
  // label text edit — same geometry, new size — never laid out again. A
  // layout is a function of exactly what `host.run` is handed: the engine,
  // its options, the `LayoutInput`, the metrics (a constant) and the measure
  // table (which an engine may read for runs it creates). So the skip now
  // compares those, as `inputKey`: the `LayoutInput`'s JSON (it is plain
  // data, built in a fixed order, so equal JSON is an equal input) and the
  // table's keys — with one exception, source spans. They are kept apart in
  // `spansKey`, because no engine and no host step reads a span to place
  // anything (only diagnostics carry them: `validateResult`'s, and any an
  // engine reports), so an edit that only moves text (a `@theme` value of
  // another length, a blank line) gives the same frames. They count only
  // when the landed layout reported diagnostics, whose spans would otherwise
  // go stale. Building the keys costs a few ms at 2 000 nodes, off the
  // keystroke path (this runs from the debounce timer). It is avoided when
  // it cannot differ: the same graph object, the same table object and the
  // same `geometryHash` give the same input (`buildLayoutInput` reads the
  // graph, the styles' geometry and the label sizes, which are read from the
  // table by label run keys, themselves from the graph's text and the label
  // styles' geometry) — a theme switch between themes of equal geometry.
  let lastRequest: {
    readonly engineId: string;
    readonly optionsKey: string;
    readonly inputKey: string;
    readonly spansKey: string;
    graph: StyledGraph['graph'];
    table: MeasureTable;
    geometryHash: string;
  } | null = null;

  function runLayout(styledSnapshot: StyledGraph, tableSnapshot: MeasureTable, engine: string, options: Readonly<Record<string, unknown>>): void {
    const geometryHash = styledSnapshot.geometryHash;
    const key = optionsKey(options);
    const sameRequest = lastRequest !== null && lastRequest.engineId === engine && lastRequest.optionsKey === key;
    // Skipping keeps the layout that landed, so a request still in flight
    // (for some other input, since superseded) must not land after it.
    const keep = (): void => {
      if (currentAbort === null) return;
      currentAbort.abort();
      currentAbort = null;
      layoutGeneration += 1;
      inFlight.value = false;
    };
    if (sameRequest && lastRequest!.graph === styledSnapshot.graph && lastRequest!.table === tableSnapshot && lastRequest!.geometryHash === geometryHash) return keep();

    let input: LayoutInput;
    let inputKey: string;
    const spans: unknown[] = [];
    try {
      // Inside the boundary: this runs from the debounce timer, so a throw
      // here (a `buildLayoutInput` invariant — e.g. an unknown node id) would
      // otherwise escape as an uncaught timer exception.
      input = buildLayoutInput(styledSnapshot, labelSizesOf(styledSnapshot, tableSnapshot));
      inputKey = `${JSON.stringify(input, (k, v: unknown) => (k === 'span' ? void spans.push(v) : v))}\n${Object.keys(tableSnapshot).join()}`;
    } catch (err) {
      reportPipelineError(err, doc.peek().source);
      return;
    }
    const spansKey = JSON.stringify(spans);
    if (sameRequest && lastRequest!.inputKey === inputKey && (layoutDiags.peek().length === 0 || lastRequest!.spansKey === spansKey)) {
      // The same layout: keep it, and remember this graph and table so the
      // next unchanged call skips without building the input.
      Object.assign(lastRequest!, { graph: styledSnapshot.graph, table: tableSnapshot, geometryHash, spansKey });
      return keep();
    }

    if (currentAbort !== null) currentAbort.abort();
    const controller = new AbortController();
    currentAbort = controller;
    const generation = (layoutGeneration += 1);

    const sourceSnapshot = doc.peek().source;

    inFlight.value = true;
    const settle = (): void => {
      if (generation === layoutGeneration) inFlight.value = false;
      if (currentAbort === controller) currentAbort = null;
    };
    try {
      void deps.host
        .run(engine, input, options, deps.metrics, tableSnapshot, controller.signal)
        .then((result) => {
          if (generation !== layoutGeneration) return; // superseded; the new request owns layoutDiags now
          layoutDiags.value = result.diagnostics;
          if (result.value !== null) {
            layout.value = result.value;
            lastRequest = { engineId: engine, optionsKey: key, inputKey, spansKey, graph: styledSnapshot.graph, table: tableSnapshot, geometryHash };
          }
          // else: keep layout.value as is (FR-E4) — layoutDiags already carries
          // SGL4001/SGL4002/SGL4011.
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return; // a newer request superseded us.
          // §13's effect boundary: `LayoutHost.run()`'s contract (DD-06 §3) says
          // it only ever rejects with `AbortError` — a different rejection is a
          // violated invariant, caught here rather than left as an unhandled
          // promise rejection.
          if (generation === layoutGeneration) reportPipelineError(err, sourceSnapshot);
        })
        .finally(settle);
    } catch (err) {
      // A host whose `run()` throws synchronously instead of returning a
      // rejected promise — it does not reach `.catch` above.
      reportPipelineError(err, sourceSnapshot);
      settle();
    }
  }

  const disposeLayoutEffect = effect(() => {
    const styledSnapshot = styled.value.value;
    const tableSnapshot = table.value;
    const engine = effectiveEngineId.value;
    // The engine gets exactly what the options form shows (fix round 1, item 3).
    const options = optionsForEngine(engine, engineOptions.value);

    // Reads `table.value` above regardless, so this effect is still subscribed
    // to it and re-runs the instant the first real table lands (see
    // `hasMeasuredOnce`'s own comment on the measure effect).
    if (!hasMeasuredOnce) return;

    if (debounceCancel !== null) {
      debounceCancel();
      debounceCancel = null;
    }
    debounceCancel = schedule(() => {
      debounceCancel = null;
      runLayout(styledSnapshot, tableSnapshot, engine, options);
    }, debounceMs);
  });

  // -------------------------------------------------------------------------
  // lastGood (FR-E4): updated only when `svg` exists and `diags` carries no
  // error.
  // -------------------------------------------------------------------------
  // `adopted` is the render already on screen: `diags` changing on its own (a
  // new edit whose render is frozen by a §13 stage throw, or a layout-only
  // warning) must not rebuild `lastGood` around the same SVG.
  let adopted: Rendered | null = null;
  const disposeLastGoodEffect = effect(() => {
    const rendered = svgOutcome.value.value;
    const diagnostics = diags.value;
    if (rendered === null || rendered === adopted) return;
    if (diagnostics.some((d) => d.severity === 'error')) return;
    adopted = rendered;
    lastGood.value = lastGoodOf(rendered);
    // "Recovered" (§13): a full clean cycle just completed — every guarded
    // stage succeeded and produced no error diagnostic. Clearing here, not
    // wherever an error was set, is what stops a fresh layout success from
    // wiping out a *stage* error that is still live, and vice versa.
    if (pipelineError.peek() !== null) pipelineError.value = null;
  });

  // -------------------------------------------------------------------------
  // DD-08 §11: "laying out…" only after 300 ms in flight, so a fast layout
  // never flashes it. Uses the same injected `schedule` the debounce does.
  // -------------------------------------------------------------------------
  let layingOutTimer: Cancel | null = null;
  const layingOutVisible = signal(false);
  const disposeLayingOutEffect = effect(() => {
    if (inFlight.value) {
      if (layingOutTimer === null) {
        layingOutTimer = schedule(() => {
          layingOutTimer = null;
          layingOutVisible.value = true;
        }, LAYING_OUT_DELAY_MS);
      }
    } else {
      if (layingOutTimer !== null) {
        layingOutTimer();
        layingOutTimer = null;
      }
      layingOutVisible.value = false;
    }
  });

  // -------------------------------------------------------------------------
  // DD-08 §6: offer "Fit" when `bounds` changes by more than 40% since the
  // last fit (on open, or the toolbar button — `fitDone()` records the
  // baseline either way; the canvas owns *when* a fit actually happens, this
  // only tracks *whether one is due*).
  // -------------------------------------------------------------------------
  let lastFitBounds: Extent | null = null;
  const fitOffered = signal(false);
  const disposeFitOfferEffect = effect(() => {
    const good = lastGood.value;
    if (good === null) return;
    const bounds: Extent = { w: good.layout.bounds.w, h: good.layout.bounds.h };
    if (boundsChangedSignificantly(lastFitBounds, bounds)) fitOffered.value = true;
  });

  const chip = computed<ChipState>(() =>
    deriveChipState({
      crashed: pipelineError.value !== null,
      layingOutVisible: layingOutVisible.value,
      diagnostics: diags.value,
      offerFit: fitOffered.value,
    }),
  );

  return {
    engineId,
    engineOptions,
    themeId,
    docId,
    setDocument(tree, src) {
      doc.value = { tree, source: src };
    },
    source,
    parsed,
    model,
    graph,
    theme,
    styled,
    diags,
    held,
    imports,
    documentThemeId,
    documentEngineId,
    effectiveThemeId,
    effectiveEngineId,
    table,
    layout,
    layoutDiags,
    inFlight,
    svg,
    lastGood,
    pipelineError,
    chip,
    fitDone() {
      const good = lastGood.peek();
      lastFitBounds = good === null ? null : { w: good.layout.bounds.w, h: good.layout.bounds.h };
      fitOffered.value = false;
    },
    dispose() {
      disposeMeasureEffect();
      disposeLayoutEffect();
      disposeLastGoodEffect();
      disposeStageErrorEffect();
      disposeLayingOutEffect();
      disposeFitOfferEffect();
      if (layingOutTimer !== null) layingOutTimer();
      if (debounceCancel !== null) debounceCancel();
      if (currentAbort !== null) currentAbort.abort();
    },
  };
}
