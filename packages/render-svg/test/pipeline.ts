import type { LabelId, Size } from '@sgl/core';
import {
  buildLayoutInput,
  placeLabels,
  quantize,
  routeStraight,
  type LayoutContext,
  type LayoutInput,
  type LayoutResult,
  type ResolvedThemeMetricsView,
  type StyledGraphInput,
} from '@sgl/layout-api';
import { gridEngine } from '@sgl/layout-std';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph, type ResolvedTheme, type StyledGraph, type ThemeDoc } from '@sgl/theme';
import { corpusGraph, corpusSource, listCorpusDocs } from '../../theme/test/corpus.js';
import { render, type RenderResult } from '../src/index.js';

export { corpusSource, listCorpusDocs };

/**
 * `parse -> resolve -> compile -> resolveTheme -> styleGraph -> premeasure ->
 * grid -> route/label/quantize -> render` over a corpus document, exactly the
 * `feat/pipeline` harness Stage G will formalise, run early because Stage F
 * needs it to golden-test the renderer against real geometry rather than a
 * hand-built `LayoutView`.
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
}

/**
 * `parse -> resolve -> compile -> resolveTheme -> styleGraph`, keeping every
 * diagnostic rather than asserting none: a "clean" corpus document (no error
 * diagnostics) can still carry warnings downstream of compile() — checkout.sgl's
 * `@style.stroke: $hot` is `SGL2xxx` at resolve time (Stage B's documented
 * placeholder for an unsubstituted variable) and `SGL5004` at style time (not a
 * color) — and this helper also runs over `malformed/`/`unresolved/` documents
 * for the "never throws" sweep, which are diagnostics by construction.
 */
function styledGraphFor(name: string, themeDoc: ThemeDoc): { readonly styled: StyledGraph; readonly theme: ResolvedTheme } {
  const { graph, classes } = corpusGraph(name);
  const { value: theme } = resolveTheme(themeDoc, (id) => BUILT_IN[id]);
  const { value: styled } = styleGraph(graph, theme, classes);
  return { styled, theme };
}

/** Lay a corpus document out under the host pipeline for an engine declaring
 *  `labelPlacement: false, edgeRouting: 'straight'` (DD-06 §4, §5) — the same
 *  fallback composition `grid.test.ts`'s `runPipeline` uses. */
async function layOut(styled: StyledGraph): Promise<{ readonly input: LayoutInput; readonly result: LayoutResult }> {
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
  return { input, result };
}

/** The whole pipeline, source to SVG, for one corpus document under one theme. */
export async function renderCorpusDoc(name: string, themeDoc: ThemeDoc = neutralLight): Promise<RenderedDoc> {
  const { styled, theme } = styledGraphFor(name, themeDoc);
  const { input, result } = await layOut(styled);
  const rendered = render(styled, result, theme);
  return { styled, input, result, theme, rendered };
}
