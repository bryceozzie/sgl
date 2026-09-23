#!/usr/bin/env node
// Precomputes the `render()` inputs the F9 browser bench needs — `StyledGraph`,
// `LayoutResult` and `ResolvedTheme` for n50/n500/n2000 under both built-in
// themes — and writes them as one JSON file the browser project can `import`.
//
// Why this exists rather than the bench computing its own inputs in-browser:
// building them needs `parse -> resolve -> compile -> resolveTheme -> styleGraph
// -> premeasure -> grid -> route/label/quantize -> validateResult`
// (`packages/render-svg/test/pipeline.ts`'s `runPipeline`, minus the final
// `render()` call — D4 asks the bench to time `render()` alone, not the whole
// pipeline), and every one of those stages after `parse` is unremarkable to time
// — the interesting, currently-unmeasured number is `render()`'s own cost (DD-09
// §2's paint-only-switch budget, F9, execution plan §2.1). Running the setup
// stages in Node, once, and shipping their *output* as data keeps the browser
// bench honest about what it is actually timing.
//
// `node:fs`/`node:url` mean this script runs in Node, not the browser — the same
// reason `bench/generate.js` writes `.sgl` text instead of the browser project
// computing it. It imports the **built** `@sgl/*` packages (`dist/`), so `pnpm
// build` must have already run (DD-00 §1's standing rule); wired into the root
// `test`/`check` scripts, after `generate:corpus` (which this depends on — it
// reads `corpus/n50.sgl` etc.) and only for the runs that reach the browser
// project, not `test:unit`.
//
// Run with `node bench/generate-render-fixtures.js`, or via `pnpm
// generate:bench-fixtures`. Output is gitignored (bench/README.md's reasoning
// for n50/n500/n2000.sgl applies here too: one decision, not a diff to review).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Bare `@sgl/*` specifiers don't resolve from `bench/` — the root package.json is
// deliberately "scripts only" (no runtime `dependencies`), so nothing hoists the
// workspace packages into the root `node_modules` the way an ordinary package's
// own `node_modules` would have them. Importing each package's **built** entry
// by relative path avoids adding a workspace package as a root dependency just
// for this script (D3: no new dependencies without saying so) and matches this
// script's own documented requirement that `pnpm build` already ran.
const { compile, parse, resolve } = await import('../packages/core/dist/index.js');
const { buildLayoutInput, placeLabels, quantize, routeStraight, validateResult } = await import('../packages/layout-api/dist/index.js');
const { gridEngine } = await import('../packages/layout-std/dist/index.js');
const { labelRunKey, premeasure, StaticMetricsMeasurer } = await import('../packages/measure/dist/index.js');
const { BUILT_IN, neutralDark, neutralLight, resolveTheme, styleGraph } = await import('../packages/theme/dist/index.js');

const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));
const outFile = fileURLToPath(new URL('./render-fixtures.json', import.meta.url));

const METRICS = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

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
  random: () => 0,
  signal: new AbortController().signal,
  log: () => {},
  sublayout() {
    throw new Error('sublayout is reserved, not implemented (DD-06 §2).');
  },
};

/** `parse -> resolve -> compile -> resolveTheme -> styleGraph -> premeasure ->
 *  grid -> route/label/quantize -> validateResult`, mirroring
 *  `render-svg/test/pipeline.ts`'s `runPipeline` up to (not including) `render()`
 *  itself — that call is what the browser bench times. */
async function buildRenderInput(source, themeDoc) {
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(themeDoc, (id) => BUILT_IN[id]);
  const { value: styled } = styleGraph(graph, theme, model.classes);

  const table = premeasure(styled, new StaticMetricsMeasurer());
  const labelSizes = {};
  for (const labelId of Object.keys(styled.graph.labels).sort()) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  const input = buildLayoutInput(styled, labelSizes);
  const raw = await gridEngine.layout(input, CTX);
  const routed = routeStraight(input, raw, METRICS);
  const labelled = placeLabels(input, routed, METRICS);
  const result = quantize(labelled, 64);
  const diagnostics = validateResult(result, styled.graph, gridEngine.id);
  if (diagnostics.some((d) => d.severity === 'error')) {
    throw new Error(`generate-render-fixtures: unexpected layout diagnostics: ${JSON.stringify(diagnostics)}`);
  }

  return { styled, result, theme };
}

async function main() {
  const docs = ['n50.sgl', 'n500.sgl', 'n2000.sgl'];
  const themes = [
    ['neutral-light', neutralLight],
    ['neutral-dark', neutralDark],
  ];

  const fixtures = [];
  for (const doc of docs) {
    const source = readFileSync(`${corpusDir}${doc}`, 'utf8');
    for (const [themeName, themeDoc] of themes) {
      const { styled, result, theme } = await buildRenderInput(source, themeDoc);
      fixtures.push({ doc, themeName, styled, result, theme });
    }
  }

  writeFileSync(outFile, JSON.stringify(fixtures), 'utf8');
  console.log(`bench/generate-render-fixtures.js: wrote ${fixtures.length} fixtures to bench/render-fixtures.json`);
}

await main();
