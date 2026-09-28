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
const { applyHostFallbacks, buildLayoutInput, placeLabels, quantize, routeStraight } = await import('../packages/layout-api/dist/index.js');
const { fixedEngine, gridEngine, radialEngine, treeEngine } = await import('../packages/layout-std/dist/index.js');
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

function inputFor(name) {
  return inputForSource(readFileSync(`${corpusDir}${name}`, 'utf8'));
}

function inputForSource(source) {
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
  return buildLayoutInput(styled, labelSizes);
}

/** B5 branch 2 (DD-12 §12 item 3): `fixed` through a real Worker, for
 *  `fixed.browser.test.ts` — every node pinned, containers and edges
 *  (`forty-three-pinned`), half pinned with SGL4020 notes (`pin-half`), and
 *  ports on the frame (`ports`). The sequence is `worker-runtime.ts`'s
 *  (`applyHostFallbacks`) then `host.ts`'s `quantize(…, 64)`. */
async function fixedCases() {
  const out = {};
  for (const name of ['layout/forty-three-pinned.sgl', 'layout/pin-half.sgl', 'ports.sgl']) {
    const input = inputFor(name);
    const raw = await fixedEngine.layout(input, { ...CTX, random: seededRandom(SEED) });
    out[name] = { input, expected: quantize(applyHostFallbacks(input, raw, fixedEngine.capabilities, METRICS), 64) };
  }
  return out;
}

/** Fix round 1 of B5 branch 4 (item 8): a 60-node tree, parsed from source,
 *  whose labels are one to three characters or thirty to fifty, so
 *  neighbouring subtrees differ strongly in breadth. A fixed LCG, so the
 *  source is the same on every run. */
function mixedWidthsTree() {
  let s = 7;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const lines = [];
  for (let i = 0; i < 60; i += 1) {
    const len = next() < 0.3 ? 30 + Math.floor(next() * 21) : 1 + Math.floor(next() * 3);
    lines.push(`n${i}: "${'W'.repeat(len)}"`);
    if (i > 0) lines.push(`n${Math.max(0, i - 1 - Math.floor(next() * Math.min(i, 6)))} -> n${i}`);
  }
  return `${lines.join('\n')}\n`;
}

/** B5 branch 4 (DD-12 §12 item 3): `tree` through a real Worker, for
 *  `tree.browser.test.ts` — nested containers with mixed directions
 *  (`tree-direction`), a DAG whose second parent is host-routed
 *  (`tree-diamond`), the 40-node criterion-1 document and `n50`. `bitwise`
 *  (N33), so the raw result is shipped too: the browser compares its own raw
 *  run with Node's, as well as the quantized result through the worker. */
async function treeCases() {
  const out = {};
  const inputs = ['layout/tree-direction.sgl', 'layout/tree-diamond.sgl', 'forty-three-level.sgl', 'n50.sgl'].map((name) => [name, inputFor(name)]);
  inputs.push(['mixed-widths', inputForSource(mixedWidthsTree())]);
  for (const [name, input] of inputs) {
    const raw = await treeEngine.layout(input, { ...CTX, random: seededRandom(SEED) });
    out[name] = { input, raw, expected: quantize(applyHostFallbacks(input, raw, treeEngine.capabilities, METRICS), 64) };
  }
  return out;
}

/** B5 branch 5 (DD-12 §12 item 3): `radial` through a real Worker, for
 *  `radial.browser.test.ts` — nested discs (`tree-direction`), a forest of
 *  discs in a row (`tree-forest`), the 40-node criterion-1 document, `n50`,
 *  and the mixed-widths tree, whose uneven wedges make nearly every angle a
 *  different one. `bitwise` (N44, H8), so the raw result is shipped too. */
async function radialCases() {
  const out = {};
  const inputs = ['layout/tree-direction.sgl', 'layout/tree-forest.sgl', 'forty-three-level.sgl', 'n50.sgl'].map((name) => [name, inputFor(name)]);
  inputs.push(['mixed-widths', inputForSource(mixedWidthsTree())]);
  for (const [name, input] of inputs) {
    const raw = await radialEngine.layout(input, { ...CTX, random: seededRandom(SEED) });
    out[name] = { input, raw, expected: quantize(applyHostFallbacks(input, raw, radialEngine.capabilities, METRICS), 64) };
  }
  return out;
}

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

  writeFileSync(outFile, JSON.stringify({ input, metrics: METRICS, expected, fixed: await fixedCases(), tree: await treeCases(), radial: await radialCases() }), 'utf8');
  console.log('bench/generate-grid-fixture.js: wrote bench/grid-fixture.json');
}

await main();
