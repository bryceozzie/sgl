#!/usr/bin/env node
// Precomputes, for `packages/layout-std/test/browser/grid.browser.test.ts`:
// (1) a real `LayoutInput` (Stage H fix round 1, item 3) and (2) the
// **expected** `LayoutResult` for it (Stage H fix round 2, item 1) — computed
// in Node by exactly the path `host.ts`/`worker-runtime.ts` take for a real
// request: `gridEngine.layout(input, ctx) -> routeStraight -> placeLabels`
// (gated by `capabilities.labelPlacement`, same as `worker-runtime.ts`) `->
// quantize(..., 64)` (`host.ts`'s own constant). Shipping that expected value
// as data, not just re-running the double-run check per browser, is what lets
// the browser test assert Node's own output is bitwise-identical to what each
// browser's real `Worker` produces — proving Node ≡ Chromium ≡ Firefox, which
// a same-browser double-run alone does not (each browser could self-agree and
// still disagree with the others, or with Node).
//
// `parse -> resolve -> compile -> resolveTheme -> styleGraph -> premeasure ->
// buildLayoutInput`, same as fix round 1 — stopping one stage short of
// `bench/generate-render-fixtures.js`'s own pipeline until this point, then
// continuing through the engine and the fallbacks/quantize instead of
// `render()`. Gate 1's rule ("no stage hand-builds a SemanticGraph") applies
// here exactly as it does to every other test level, so this reads a real
// `corpus/` document rather than a literal.
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
const { buildLayoutInput, placeLabels, quantize, routeStraight } = await import('../packages/layout-api/dist/index.js');
const { gridEngine } = await import('../packages/layout-std/dist/index.js');
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

// `host.ts`'s own `SEED` constant — every real request is seeded with it.
// `grid` never calls `ctx.random` (confirmed: no reference in `grid.ts`), so
// this makes no difference to `grid`'s own output today, but mirrors the real
// path exactly rather than assuming that stays true.
const SEED = 1;

/** Line-for-line the same generator `worker-runtime.ts` uses — mulberry32,
 *  integer/bitwise arithmetic only (ADR-0004's "reproducible bit for bit"
 *  bar). Duplicated, not imported: this script runs in Node against built
 *  `dist/` packages, and `seededRandom` is not exported from
 *  `@sgl/layout-api` (it is worker-runtime-internal). */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CTX = {
  options: {},
  metrics: METRICS,
  measure: {
    layoutRuns() {
      throw new Error('grid never asks the host to measure a label it created.');
    },
    layoutRunsAsync() {
      throw new Error('grid never asks the host to measure a label it created.');
    },
  },
  random: seededRandom(SEED),
  signal: new AbortController().signal,
  log: () => {},
  sublayout() {
    throw new Error('sublayout is reserved, not implemented (DD-06 §2).');
  },
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

  // The exact sequence host.ts/worker-runtime.ts run for a real request.
  const raw = await gridEngine.layout(input, CTX);
  const routed = routeStraight(input, raw, METRICS);
  const withLabels = gridEngine.capabilities.labelPlacement ? routed : placeLabels(input, routed, METRICS);
  const expected = quantize(withLabels, 64);

  writeFileSync(outFile, JSON.stringify({ input, metrics: METRICS, expected }), 'utf8');
  console.log('bench/generate-grid-fixture.js: wrote bench/grid-fixture.json');
}

await main();
