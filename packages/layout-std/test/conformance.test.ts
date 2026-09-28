import type { LabelId, Size } from '@sgl/core';
import { compile, parse, resolve } from '@sgl/core';
import { buildLayoutInput, type LayoutInput, type ResolvedThemeMetricsView, type StyledGraphInput } from '@sgl/layout-api';
import { runConformance, siblingOverlaps, type ConformanceCase } from '@sgl/layout-api/conformance';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import { layoutWrapped } from '@sgl/text/wrap';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph, type StyledGraph } from '@sgl/theme';
import { expect, it } from 'vitest';
import { scaleDocument } from '../../../bench/scale-document.js';
import { corpusStyledGraph, listCorpusDocs } from '../../theme/test/corpus.js';
import { fixedEngine } from '../src/fixed.js';
import { gridEngine } from '../src/grid.js';
import { treeEngine } from '../src/lazy.js';

/**
 * DD-06 §8's conformance suite against `grid` — the other half of DD-06 §10's
 * "Conformance suite on both engines" (`elk`'s is
 * `layout-elk/test/conformance.test.ts`), over the same cases: every corpus
 * document plus the in-memory 1 000-node graph for check 4.
 */

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

function inputOf(styled: StyledGraph): LayoutInput {
  const table = premeasure(styled, new StaticMetricsMeasurer({ lineModel: layoutWrapped }));
  const labelSizes: Record<LabelId, Size> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  return buildLayoutInput(styled as StyledGraphInput, labelSizes);
}

function inputForSource(source: string): LayoutInput {
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(neutralLight, (id) => BUILT_IN[id]);
  return inputOf(styleGraph(graph, theme, model.classes).value);
}

const N1000 = 'n1000 (bench/scale-document.js)';

it('grid passes all five conformance checks over the corpus and the 1 000-node graph', async () => {
  const cases: ConformanceCase[] = [
    ...listCorpusDocs().map((name) => ({ name, input: inputOf(corpusStyledGraph(name).styled) })),
    { name: N1000, input: inputForSource(scaleDocument(1000) as string) },
  ];
  const report = await runConformance(gridEngine, cases, { metrics: METRICS, now: () => performance.now(), timedCase: N1000 });
  const timed = report.cases.find((c) => c.name === N1000)!;
  console.warn(`[conformance] grid, 1 000 nodes, Node: ${timed.ms.toFixed(0)} ms`);
  expect(report.failures).toEqual([]);
  expect(timed.withinTimeout).toBe(true);
  // `bitwise`: both the raw and the quantized results matched across runs.
  expect(report.cases.every((c) => c.deterministic === true)).toBe(true);
  // Check 7 (DD-14 C35): grid honours `scope` on every container of every case.
  expect(report.cases.find((c) => c.name === N1000)!.scopes).toHaveLength(100);
  expect(report.cases.find((c) => c.name === 'checkout.sgl')!.scopes).toEqual(['storefront', 'payments']);
}, 120_000);

/**
 * `fixed` (DD-12 §12 item 2): the same cases. The corpus now holds pinned
 * documents (`layout/pin-*.sgl`, `layout/forty-three-pinned.sgl`), so check 3
 * exercises both halves: two pinned siblings are exempt (F28), and every node
 * `fixed` packed itself must overlap nothing. Check 1 fails on errors only, so
 * `pin-negative.sgl`'s SGL4003 warning passes, and is asserted here.
 */
/** Fix round 1, item 5 (mutation M6): pinned siblings the author put on top
 *  of each other, at the root and inside a container, beside unpinned ones
 *  `fixed` packs. Check 3's F28 exemption must be what lets this pass. */
const OVERLAP = 'overlapping pins (fix round 1, item 5)';
const OVERLAP_SOURCE =
  'a: { @label: "A", @pin: { x: 0, y: 0 } }\nb: { @label: "B", @pin: { x: 10, y: 10 } }\nc: "C"\n' +
  'box: {\n  @pin: { x: 300, y: 0 }\n  p: { @label: "P", @pin: { x: 0, y: 0 } }\n  q: { @label: "Q", @pin: { x: 5, y: 5 } }\n  r: "R"\n}\na -> b\n';

it('fixed passes all six conformance checks over the corpus and the 1 000-node graph', async () => {
  const cases: ConformanceCase[] = [
    ...listCorpusDocs().map((name) => ({ name, input: inputOf(corpusStyledGraph(name).styled) })),
    { name: OVERLAP, input: inputForSource(OVERLAP_SOURCE) },
    { name: N1000, input: inputForSource(scaleDocument(1000) as string) },
  ];
  const report = await runConformance(fixedEngine, cases, { metrics: METRICS, now: () => performance.now(), timedCase: N1000 });
  const timed = report.cases.find((c) => c.name === N1000)!;
  console.warn(`[conformance] fixed, 1 000 nodes, Node: ${timed.ms.toFixed(0)} ms`);
  expect(report.failures).toEqual([]);
  expect(timed.withinTimeout).toBe(true);
  expect(report.cases.every((c) => c.deterministic === true)).toBe(true);
  // Check 7 (DD-14 C35): fixed honours `scope` on every container, pinned ones included.
  expect(report.cases.find((c) => c.name === N1000)!.scopes).toHaveLength(100);
  expect(report.cases.find((c) => c.name === 'layout/pin-nested.sgl')!.scopes.length).toBeGreaterThan(0);
  const warned = report.cases.filter((c) => c.validation.length > 0).map((c) => [c.name, c.validation.map((d) => d.code)]);
  expect(warned).toEqual([['layout/pin-negative.sgl', ['SGL4003']]]);
  // The overlap case really overlaps: without the exemption, check 3 would fail it.
  const overlap = report.cases.find((c) => c.name === OVERLAP)!;
  expect(siblingOverlaps(cases.find((c) => c.name === OVERLAP)!.input.graph, overlap.result)).toEqual([
    ['a', 'b'],
    ['box.p', 'box.q'],
  ]);
}, 120_000);

/**
 * `tree` (DD-12 §12 item 2, B5 branch 4): the same cases, through the lazy
 * engine (`treeEngine` loads `std-trees` on its first call). Every corpus
 * document, including the cycles, forests and DAGs of `layout/tree-*.sgl`,
 * plus a random-shaped tree and the 1 000-node graph for check 4 against its
 * 5 000 ms timeout. Check 6 holds the elbows to their nodes' outlines.
 */
it('tree passes all six conformance checks over the corpus and the 1 000-node graph', async () => {
  const lines = ['n0: "Root"'];
  for (let i = 1; i < 200; i += 1) lines.push(`n${i}: "${'W'.repeat(1 + ((i * 7) % 11))}"`, `n${(i * 37) % i} -> n${i}`);
  const cases: ConformanceCase[] = [
    ...listCorpusDocs().map((name) => ({ name, input: inputOf(corpusStyledGraph(name).styled) })),
    { name: 'a 200-node tree of mixed widths', input: inputForSource(`${lines.join('\n')}\n`) },
    { name: N1000, input: inputForSource(scaleDocument(1000) as string) },
  ];
  for (const direction of ['down', 'right']) {
    const report = await runConformance(treeEngine, cases, { metrics: METRICS, now: () => performance.now(), timedCase: N1000, options: { direction } });
    const timed = report.cases.find((c) => c.name === N1000)!;
    console.warn(`[conformance] tree (${direction}), 1 000 nodes, Node: ${timed.ms.toFixed(0)} ms`);
    expect(report.failures, direction).toEqual([]);
    expect(timed.withinTimeout).toBe(true);
    expect(report.cases.every((c) => c.deterministic === true)).toBe(true);
    // No validation warning at all: every child inside its container.
    expect(report.cases.filter((c) => c.validation.length > 0).map((c) => c.name)).toEqual([]);
  }
}, 120_000);
