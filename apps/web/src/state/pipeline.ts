import { computed, effect, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { Tree } from '@lezer/common';
import {
  buildAst,
  compile,
  parse,
  resolve,
  type CompileResult,
  type Diagnostic,
  type Document as SglDocument,
  type LabelId,
  type ResolveResult,
  type StageResult,
} from '@sgl/core';
import { buildLayoutInput, type LayoutInput, type LayoutResult } from '@sgl/layout-api';
import { labelRunKey, premeasure, type MeasureTable } from '@sgl/measure';
import { BUILT_IN, DEFAULT_THEME_ID, resolveTheme, styleGraph, type ResolvedTheme, type StyledGraph } from '@sgl/theme';
import { render, type RenderResult } from '@sgl/render-svg';
import { distinctTextStyles } from './measure-styles.js';
import type { Cancel, LabelSizes, LastGood, PipelineDeps, Schedule } from './types.js';

const DEFAULT_DEBOUNCE_MS = 120;

function defaultSchedule(fn: () => void, ms: number): Cancel {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
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
   *  never calls `parser.parse` itself. */
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

  // ---- async stage state ----------------------------------------------------
  readonly table: Signal<MeasureTable>;
  readonly layout: Signal<LayoutResult | null>;
  readonly layoutDiags: Signal<readonly Diagnostic[]>;
  readonly inFlight: Signal<boolean>;

  // ---- what the canvas shows -------------------------------------------------
  readonly svg: ReadonlySignal<RenderResult | null>;
  readonly lastGood: Signal<LastGood | null>;

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

  const parsed = computed<StageResult<SglDocument>>(() => buildAst(doc.value.tree, doc.value.source));
  const model = computed<ResolveResult>(() => resolve(parsed.value.value));
  const graph = computed<CompileResult>(() => compile(model.value.model));
  const theme = computed<StageResult<ResolvedTheme>>(() => resolveTheme(BUILT_IN[themeId.value] ?? BUILT_IN[DEFAULT_THEME_ID]!, (id) => BUILT_IN[id]));
  const styled = computed<StageResult<StyledGraph>>(() => styleGraph(graph.value.graph, theme.value.value, model.value.model.classes));

  const table = signal<MeasureTable>({});
  const layout = signal<LayoutResult | null>(null);
  const layoutDiags = signal<readonly Diagnostic[]>([]);
  const inFlight = signal(false);

  const svg = computed<RenderResult | null>(() => {
    const layoutValue = layout.value;
    if (layoutValue === null) return null;
    return render(styled.value.value, layoutValue, theme.value.value);
  });

  // DD-08 §3 names parsed/model/graph/layoutDiags; theme's and styled's own
  // diagnostics (a malformed theme token, an unknown style property) and the
  // renderer's (a disallowed link scheme) are real, user-visible diagnostics the
  // pseudocode's list simply omits — filled in per §1's "if a document is merely
  // incomplete, fill the gap the way the surrounding design implies."
  const diags = computed<readonly Diagnostic[]>(() => [
    ...parsed.value.diagnostics,
    ...model.value.diagnostics,
    ...graph.value.diagnostics,
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
  const disposeMeasureEffect = effect(() => {
    const styledSnapshot = styled.value.value;
    void themeId.value; // explicit dependency per DD-08 §3, alongside geometryHash below
    void styledSnapshot.geometryHash;
    const generation = (measureGeneration += 1);
    void (async () => {
      await deps.measurer.ready(distinctTextStyles(styledSnapshot));
      if (generation !== measureGeneration) return; // superseded by a newer edit
      table.value = premeasure(styledSnapshot, deps.measurer);
    })();
  });

  // -------------------------------------------------------------------------
  // Layout effect (DD-08 §3): debounced 120 ms, aborts an in-flight request
  // first, skips layout on a paint-only change and falls through to render.
  // -------------------------------------------------------------------------
  let debounceCancel: Cancel | null = null;
  let currentAbort: AbortController | null = null;
  let layoutGeneration = 0;
  // What the *last issued* layout request looked like, so the next change can
  // tell whether it is paint-only. DD-08 §3 names `lastGood?.styled.geometryHash`
  // for the geometry half of this comparison; `lastGood` has no field for the
  // engine id/options half (its documented shape is exactly
  // `{ styled, layout, svg, styleBlock }`), so that half is tracked here instead
  // — a gap the surrounding design implies (the skip condition explicitly checks
  // "engine/options unchanged") but does not say where to keep it.
  let lastRequest: { readonly geometryHash: string; readonly engineId: string; readonly optionsKey: string } | null = null;

  function runLayout(styledSnapshot: StyledGraph, tableSnapshot: MeasureTable, engine: string, options: Readonly<Record<string, unknown>>): void {
    const geometryHash = styledSnapshot.geometryHash;
    const key = optionsKey(options);
    const paintOnly =
      lastRequest !== null && lastRequest.geometryHash === geometryHash && lastRequest.engineId === engine && lastRequest.optionsKey === key;
    if (paintOnly) return; // fall through to render — the layout stays as is.

    if (currentAbort !== null) currentAbort.abort();
    const controller = new AbortController();
    currentAbort = controller;
    const generation = (layoutGeneration += 1);

    const labelSizes = labelSizesOf(styledSnapshot, tableSnapshot);
    const input: LayoutInput = buildLayoutInput(styledSnapshot, labelSizes);

    inFlight.value = true;
    void deps.host
      .run(engine, input, options, deps.metrics, tableSnapshot, controller.signal)
      .then((result) => {
        if (generation !== layoutGeneration) return; // superseded; the new request owns layoutDiags now
        layoutDiags.value = result.diagnostics;
        if (result.value !== null) {
          layout.value = result.value;
          lastRequest = { geometryHash, engineId: engine, optionsKey: key };
        }
        // else: keep layout.value as is (FR-E4) — layoutDiags already carries
        // SGL4001/SGL4002/SGL4011.
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return; // a newer request superseded us.
        throw err; // a violated invariant, not a document problem (§1).
      })
      .finally(() => {
        if (generation === layoutGeneration) inFlight.value = false;
        if (currentAbort === controller) currentAbort = null;
      });
  }

  const disposeLayoutEffect = effect(() => {
    const styledSnapshot = styled.value.value;
    const tableSnapshot = table.value;
    const engine = engineId.value;
    const options = engineOptions.value;

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
  const disposeLastGoodEffect = effect(() => {
    const svgResult = svg.value;
    const diagnostics = diags.value;
    if (svgResult === null) return;
    if (diagnostics.some((d) => d.severity === 'error')) return;
    const layoutValue = layout.value;
    if (layoutValue === null) return; // svg is only non-null when layout is; guards the type.
    lastGood.value = { styled: styled.value.value, layout: layoutValue, svg: svgResult.svg, styleBlock: svgResult.styleBlock };
  });

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
    table,
    layout,
    layoutDiags,
    inFlight,
    svg,
    lastGood,
    dispose() {
      disposeMeasureEffect();
      disposeLayoutEffect();
      disposeLastGoodEffect();
      if (debounceCancel !== null) debounceCancel();
      if (currentAbort !== null) currentAbort.abort();
    },
  };
}
