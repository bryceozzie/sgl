import { runConformance, type ConformanceCase } from '@sgl/layout-api/conformance';
import { expect, it } from 'vitest';
// A plain-JS pure function shared with bench/generate.js (DD-06 §8's
// 1 000-node graph, built in memory rather than as one more corpus file).
import { scaleDocument } from '../../../bench/scale-document.js';
import { listCorpusDocs } from '../../theme/test/corpus.js';
import { elkEngine } from '../src/index.js';
import { layoutInputFor, layoutInputForSource, METRICS } from './corpus-input.js';

/**
 * DD-06 §8's conformance suite against `elk` (DD-06 §10: "Conformance suite
 * on both engines"; `grid`'s half is `layout-std/test/conformance.test.ts`).
 * The cases are every corpus document — which between them cover empty, one
 * node, one edge, self-loops, parallel edges, 3-deep nesting,
 * container-to-container and boundary-crossing edges, disconnected
 * components and the extreme-aspect `n2000.sgl` — plus a 1 000-node graph for
 * check 4 (K10: elk's time is reported, and the timeout is not raised).
 */

const N1000 = 'n1000 (bench/scale-document.js)';

it('elk passes all five conformance checks over the corpus and the 1 000-node graph', async () => {
  const cases: ConformanceCase[] = [
    ...listCorpusDocs().map((name) => ({ name, input: layoutInputFor(name) })),
    { name: N1000, input: layoutInputForSource(scaleDocument(1000) as string) },
  ];
  const report = await runConformance(elkEngine, cases, { metrics: METRICS, now: () => performance.now(), timedCase: N1000 });
  const timed = report.cases.find((c) => c.name === N1000)!;
  console.warn(`[K10] elk, 1 000 nodes, Node: ${timed.ms.toFixed(0)} ms (first run, host sequence included)`);
  console.warn(`[K4] elk crossing counts (conformance): ${JSON.stringify(report.crossingCounts)}`);
  expect(report.failures).toEqual([]);
  expect(timed.withinTimeout).toBe(true);
  expect(report.cases.every((c) => c.deterministic === true)).toBe(true);
  // Check 7 (DD-14 C35): elk honours `scope` on every container of every case.
  const scoped = report.cases.map((c) => c.scopes.length);
  console.warn(`[check 7] elk, containers laid out as a scope: ${scoped.reduce((a, b) => a + b, 0)}`);
  expect(report.cases.find((c) => c.name === N1000)!.scopes).toHaveLength(100);
  expect(report.cases.find((c) => c.name === 'checkout.sgl')!.scopes).toEqual(['storefront', 'payments']);
}, 120_000);
