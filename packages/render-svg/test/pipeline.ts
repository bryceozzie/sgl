import type { Diagnostic, LabelId, Size } from '@sgl/core';
import { compile, parse, resolve } from '@sgl/core';
import {
  buildLayoutInput,
  placeLabels,
  quantize,
  routeStraight,
  validateResult,
  type LayoutContext,
  type LayoutInput,
  type LayoutResult,
  type ResolvedThemeMetricsView,
  type StyledGraphInput,
} from '@sgl/layout-api';
import { gridEngine } from '@sgl/layout-std';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph, type ResolvedTheme, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { corpusSource, listCorpusDocs } from '../../theme/test/corpus.js';
import { render, type RenderResult } from '../src/index.js';

export { corpusSource, listCorpusDocs };

/**
 * `source -> RenderResult`: `parse -> resolve -> compile -> resolveTheme ->
 * styleGraph -> premeasure -> grid -> route/label/quantize -> validateResult
 * -> render`. This is Stage G's own "one function, source to RenderResult,
 * running synchronously in Node" harness (07-execution-plan.md §5) — formalised
 * here from the version Stage F wrote early (as `renderCorpusDoc`, corpus-file
 * only) because Stage F needed it to golden-test the renderer against real
 * geometry rather than a hand-built `LayoutView`. "Synchronously" means no
 * Worker and no `postMessage` round trip, not literally no `Promise`:
 * `LayoutEngine.layout` is `async` by the frozen `@sgl/layout-api` contract, so
 * this awaits it in-process exactly as a synchronous call site would.
 *
 * Uses `StaticMetricsMeasurer` (deterministic, no canvas) so this runs under
 * Node exactly like CI — the same choice `grid.test.ts` makes.
 */

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

const CTX: LayoutContext = {
  options: {},
  metrics: METRICS,
  measure: {
    layoutRuns(): never {
      throw new Error('grid never asks the host to measure a label it created.');
    },
  },
  random: () => 0,
  signal: new AbortController().signal,
  log: () => {},
  sublayout(): never {
    throw new Error('sublayout is reserved, not implemented (DD-06 §2).');
  },
};

export interface RenderedDoc {
  readonly styled: StyledGraph;
  readonly input: LayoutInput;
  readonly result: LayoutResult;
  readonly theme: ResolvedTheme;
  readonly rendered: RenderResult;
  /** Every diagnostic from every stage — parse, resolve, compile, resolveTheme,
   *  styleGraph, validateResult, render — not just the renderer's own slice
   *  (`rendered.diagnostics`). A "clean" corpus document (no *error*
   *  diagnostics) can still carry warnings downstream of compile(): checkout.sgl's
   *  `@style.stroke: $hot` is `SGL2xxx` at resolve time (Stage B's documented
   *  placeholder for an unsubstituted variable) and `SGL5004` at style time (not
   *  a color). This field is what the pipeline-level "no unexpected diagnostics"
   *  gate (Stage G) and the diagnostics coverage gate's theme/renderer half
   *  (`diagnostics-coverage.test.ts`) both read. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Lay a `StyledGraph` out under the host pipeline for an engine declaring
 *  `labelPlacement: false, edgeRouting: 'straight'` (DD-06 §4, §5) — the same
 *  fallback composition `grid.test.ts`'s `runPipeline` uses — then
 *  `validateResult` (DD-06 §4), so a corrupt engine result is guarded before
 *  the renderer ever sees it, exactly as the design intends. */
async function layOut(
  styled: StyledGraph,
): Promise<{ readonly input: LayoutInput; readonly result: LayoutResult; readonly diagnostics: readonly Diagnostic[] }> {
  const table = premeasure(styled, new StaticMetricsMeasurer());
  const labelSizes: Record<LabelId, Size> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  const input = buildLayoutInput(styled as StyledGraphInput, labelSizes);
  const raw = await gridEngine.layout(input, CTX);
  const routed = routeStraight(input, raw, METRICS);
  const labelled = placeLabels(input, routed, METRICS);
  const result = quantize(labelled, 64);
  const diagnostics = validateResult(result, styled.graph, gridEngine.id);
  return { input, result, diagnostics };
}

/** The whole pipeline, `source -> RenderResult`, under one theme. Calls the
 *  engine directly, in-process — no worker (Stage G). */
export async function runPipeline(source: string, themeDoc: ThemeDoc = neutralLight): Promise<RenderedDoc> {
  const { ast, diagnostics: d1 } = parse(source);
  const { model, diagnostics: d2 } = resolve(ast);
  const { graph, diagnostics: d3 } = compile(model);
  const { value: theme, diagnostics: d4 } = resolveTheme(themeDoc, (id) => BUILT_IN[id]);
  const { value: styled, diagnostics: d5 } = styleGraph(graph, theme, model.classes);
  const { input, result, diagnostics: d6 } = await layOut(styled);
  const rendered = render(styled, result, theme);
  return {
    styled,
    input,
    result,
    theme,
    rendered,
    diagnostics: [...d1, ...d2, ...d3, ...d4, ...d5, ...d6, ...rendered.diagnostics],
  };
}

/** The whole pipeline for one corpus document under one theme — `runPipeline`
 *  plus reading the fixture off disk. */
export async function renderCorpusDoc(name: string, themeDoc: ThemeDoc = neutralLight): Promise<RenderedDoc> {
  return runPipeline(corpusSource(name), themeDoc);
}
