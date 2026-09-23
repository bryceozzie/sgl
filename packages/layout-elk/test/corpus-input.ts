import { asNodeId, type LabelId, type Size } from '@sgl/core';
import { buildLayoutInput, type LayoutInput, type ResolvedThemeMetricsView, type StyledGraphInput } from '@sgl/layout-api';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import { styleGraph, resolveTheme, BUILT_IN, neutralLight, type StyledGraph } from '@sgl/theme';
import { compile, parse, resolve } from '@sgl/core';
import { corpusStyledGraph } from '../../theme/test/corpus.js';

/** The metrics every Node-side layout fixture uses (`grid.test.ts`,
 *  `render-svg/test/pipeline.ts`, `bench/generate-grid-fixture.js`). */
export const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

function inputOf(styled: StyledGraph): LayoutInput {
  const table = premeasure(styled, new StaticMetricsMeasurer());
  const labelSizes: Record<LabelId, Size> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  return buildLayoutInput(styled as StyledGraphInput, labelSizes);
}

/** `parse -> resolve -> compile -> resolveTheme -> styleGraph -> premeasure ->
 *  buildLayoutInput` over a corpus document, with the deterministic
 *  `StaticMetricsMeasurer` — the same composition `grid.test.ts` uses. */
export function layoutInputFor(name: string): LayoutInput {
  return inputOf(corpusStyledGraph(name).styled);
}

/** The same, over source text rather than a corpus file. */
export function layoutInputForSource(source: string): LayoutInput {
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(neutralLight, (id) => BUILT_IN[id]);
  const { value: styled } = styleGraph(graph, theme, model.classes);
  return inputOf(styled);
}

/** `minWidth`/`minHeight` apply to leaves only in the style registry
 *  (`appliesTo: NODE`), so no document can give a container a minimum today;
 *  the mapping still has to honour one, so it is set on a real input here. */
export function withContainerMin(input: LayoutInput, id: string, min: { w: number; h: number }): LayoutInput {
  const node = asNodeId(id);
  return { ...input, sizing: { ...input.sizing, [node]: { ...input.sizing[node]!, min } } };
}
