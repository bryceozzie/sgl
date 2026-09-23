#!/usr/bin/env node
// Precomputes a real `LayoutInput` for `packages/layout-std/test/browser/
// grid.browser.test.ts` (Stage H fix round 1, item 3): `parse -> resolve ->
// compile -> resolveTheme -> styleGraph -> premeasure -> buildLayoutInput`,
// stopping one stage short of `bench/generate-render-fixtures.js`'s own
// pipeline — a `LayoutInput`, not a `LayoutResult`, because the whole point of
// that browser test is to run the real `gridEngine` itself, inside a real
// `Worker`, through `createWorkerHost`. Gate 1's rule ("no stage hand-builds a
// SemanticGraph") applies here exactly as it does to every other test level,
// so this reads a real `corpus/` document rather than a literal.
//
// Imports the **built** `@sgl/*` packages by relative path, same reasoning as
// `generate-render-fixtures.js`: bare `@sgl/*` specifiers don't resolve from
// `bench/` (the root `package.json` is deliberately "scripts only"), and
// `pnpm build` must already have run.
//
// Run with `node bench/generate-grid-fixture.js`, or via `pnpm
// generate:grid-fixture`. Output is gitignored, like every other file this
// directory generates.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));
const outFile = fileURLToPath(new URL('./grid-fixture.json', import.meta.url));

const { compile, parse, resolve } = await import('../packages/core/dist/index.js');
const { buildLayoutInput } = await import('../packages/layout-api/dist/index.js');
const { labelRunKey, premeasure, StaticMetricsMeasurer } = await import('../packages/measure/dist/index.js');
const { BUILT_IN, neutralLight, resolveTheme, styleGraph } = await import('../packages/theme/dist/index.js');

// grid never reads ctx.metrics for anything but arrowSize/spacing defaults on
// a host fallback path this test doesn't exercise (grid does its own packing);
// matches every other fixture's METRICS literal (pipeline.ts, grid.test.ts).
const METRICS = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

async function main() {
  // n50 — the smallest generated scale fixture. This test is proving the
  // worker/protocol plumbing works for the real engine, not re-proving grid's
  // own bitwise-over-the-whole-corpus gate (already Stage E's, in Node).
  const source = readFileSync(`${corpusDir}n50.sgl`, 'utf8');
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(neutralLight, (id) => BUILT_IN[id]);
  const { value: styled } = styleGraph(graph, theme, model.classes);

  const table = premeasure(styled, new StaticMetricsMeasurer());
  const labelSizes = {};
  for (const labelId of Object.keys(styled.graph.labels).sort()) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  const input = buildLayoutInput(styled, labelSizes);

  writeFileSync(outFile, JSON.stringify({ input, metrics: METRICS }), 'utf8');
  console.log('bench/generate-grid-fixture.js: wrote bench/grid-fixture.json');
}

await main();
