#!/usr/bin/env node
// Writes `corpus/layout/forty-three-pinned.sgl` (DD-12 §12 item 5): the MVP
// criterion-1 document, `corpus/forty-three-level.sgl`, with a `@pin` on every
// node taken once from its `grid` layout, and `@layout: { engine: fixed }`.
// Under `fixed` every node is pinned, so the document lays out with no
// diagnostic at all, which is what `apps/web/e2e/criteria.spec.ts`'s
// criterion-1 case for `fixed` asserts.
//
// A pin is the frame's top-left relative to the top-left of the parent's
// content box (DD-12 H2): the node's grid frame minus its parent's frame and
// padding (at the root, the frame itself), rounded to whole pixels. The
// source's own lines are kept; a pin line is added to each node. The output
// is committed, not generated per run: `packages/layout-std/test/
// pinned-fixture.test.ts` checks that it still matches grid's layout and the
// source document, so a drift in either fails there.
//
// Like the other scripts here, it imports the built packages by relative
// path (`pnpm build` first). Run with `node bench/generate-pinned-fixture.js`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../corpus/forty-three-level.sgl', import.meta.url)), 'utf8');
const outFile = fileURLToPath(new URL('../corpus/layout/forty-three-pinned.sgl', import.meta.url));

const { compile, parse, resolve } = await import('../packages/core/dist/index.js');
const { buildLayoutInput } = await import('../packages/layout-api/dist/index.js');
const { gridEngine } = await import('../packages/layout-std/dist/index.js');
const { labelRunKey, premeasure, StaticMetricsMeasurer } = await import('../packages/measure/dist/index.js');
const { layoutWrapped } = await import('../packages/text/dist/wrap.js');
const { BUILT_IN, neutralLight, resolveTheme, styleGraph } = await import('../packages/theme/dist/index.js');
const { gridPins, pinnedSource } = await import('./pinned-fixture.js');

const METRICS = { spacing: { node: 40, rank: 70, edgeLabel: 4 }, stroke: { node: 1.5, edge: 1.5, container: 1 }, arrowSize: 8 };
const CTX = {
  options: {},
  metrics: METRICS,
  measure: {
    layoutRuns() {
      throw new Error('grid never measures.');
    },
    layoutRunsAsync() {
      throw new Error('grid never measures.');
    },
  },
  random: () => 0,
  signal: new AbortController().signal,
  log: () => {},
  sublayout() {
    throw new Error('sublayout is reserved.');
  },
};

const { model } = resolve(parse(source).ast);
const { graph } = compile(model);
const { value: theme } = resolveTheme(neutralLight, (id) => BUILT_IN[id]);
const { value: styled } = styleGraph(graph, theme, model.classes);
const table = premeasure(styled, new StaticMetricsMeasurer({ lineModel: layoutWrapped }));
const labelSizes = {};
for (const labelId of Object.keys(styled.graph.labels).sort()) {
  const layout = table[labelRunKey(styled, labelId)];
  labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
}
const input = buildLayoutInput(styled, labelSizes);
const result = await gridEngine.layout(input, CTX);

writeFileSync(outFile, pinnedSource(source, gridPins(input, result)), 'utf8');
console.log('bench/generate-pinned-fixture.js: wrote corpus/layout/forty-three-pinned.sgl');
