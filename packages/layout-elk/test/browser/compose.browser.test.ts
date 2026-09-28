import { compile, parse, resolve, type LabelId, type Size } from '@sgl/core';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import type { LayoutPlan } from '../../../layout-api/src/compose.js';
import type { LayoutEngine, LayoutInput, ResolvedThemeMetricsView, StyledGraphInput } from '../../../layout-api/src/contract.js';
import { runHostSequence } from '../../../layout-api/src/conformance.js';
import { createWorkerHost } from '../../../layout-api/src/host.js';
import { layoutPlan, rootLayoutOptions, type EngineSchemas } from '../../../layout-api/src/layout-config.js';
import { buildLayoutInput } from '../../../layout-api/src/sizing.js';
import { fixedEngine, gridEngine } from '../../../layout-std/src/index.js';
// Plain data and a plain-JS pure function, shared with the Node side.
import { scaleDocument } from '../../../../bench/scale-document.js';
import CHECKOUT from '../../../../corpus/checkout.sgl?raw';
import ELK_IN_GRID from '../../../../corpus/layout/engine-elk-in-grid.sgl?raw';
import { elkEngine } from '../../src/index.js';

/**
 * B8 branch 2 in a real browser (DD-14 §10 items 4 and 8): a request with a
 * plan, composed inside a real `Worker` (`compose.worker.ts`, the composer
 * loaded lazily, as in the app) behind the real `createWorkerHost`.
 *
 * - Chromium equals Node: `grid-in-elk` (spec §9, `checkout.sgl`) and
 *   `elk-in-grid` give, through the worker, exactly what the host sequence
 *   gives on this page's own thread, and two runs agree.
 * - The §8.2 bench (C49): 2 000 nodes, 200 containers of 10, in three
 *   variants: an `elk` document of `grid` boxes, a `grid` document of `elk`
 *   boxes, and an `elk` document of `elk` boxes; with `elk` alone over the
 *   same graph (F15's measurement) beside them. Times are printed
 *   (`[B8-BENCH]`), not asserted beyond the request's own timeout: timing
 *   asserts are the nightly bench's (bench/README.md).
 */

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

const ENGINES: readonly LayoutEngine[] = [elkEngine, gridEngine, fixedEngine];
const engineById = (id: string): LayoutEngine | undefined => ENGINES.find((e) => e.id === id);
const schemasOf = (id: string): EngineSchemas | undefined => {
  const e = engineById(id);
  return e === undefined ? undefined : { id: e.id, ...(e.optionsSchema && { optionsSchema: e.optionsSchema }), ...(e.hintsSchema && { hintsSchema: e.hintsSchema }) };
};

/** The input, the root's options and the plan, as the app builds them. */
function requestFor(source: string, root: LayoutEngine): { readonly input: LayoutInput; readonly options: Readonly<Record<string, unknown>>; readonly plan: LayoutPlan } {
  const { ast } = parse(source);
  const { model } = resolve(ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(neutralLight, (id) => BUILT_IN[id]);
  const { value: styled } = styleGraph(graph, theme, model.classes);
  const table = premeasure(styled, new StaticMetricsMeasurer());
  const labelSizes: Record<LabelId, Size> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  const options = rootLayoutOptions(ast, model.root.config, schemasOf(root.id)!).options;
  const plan = layoutPlan(ast, model, { engine: root.id, options }, schemasOf).scopes;
  return { input: buildLayoutInput(styled as StyledGraphInput, labelSizes), options, plan };
}

function spawn(): Worker {
  return new Worker(new URL('./compose.worker.ts', import.meta.url), { type: 'module' });
}

/** A first request pays the worker's cold load, elkjs's chunk and the
 *  composer's (and, on a cold Vite cache, dependency optimisation), so these
 *  tests give elk 60 s; the plan's clock is its longest engine's (C26). */
const createHost = () => createWorkerHost(spawn, { engineTimeoutMs: { 'sgl.elk': 60_000 } });

describe('a plan through a real Worker (DD-14 §10 item 4)', () => {
  it.each([
    ['grid-in-elk (spec §9)', CHECKOUT as string, elkEngine],
    ['elk-in-grid', ELK_IN_GRID as string, gridEngine],
  ] as const)('%s: the worker equals the host sequence on this page, and two runs agree', async (_name, source, root) => {
    const { input, options, plan } = requestFor(source, root);
    expect(plan.length).toBe(1);
    const host = createHost();
    try {
      const first = await host.run(root.id, input, options, METRICS, {}, new AbortController().signal, plan);
      const second = await host.run(root.id, input, options, METRICS, {}, new AbortController().signal, plan);
      expect(first.diagnostics).toEqual([]);
      expect(first.value).not.toBeNull();
      expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
      const inPage = await runHostSequence(root, input, options, METRICS, { plan, engines: engineById });
      expect(JSON.stringify(first.value)).toBe(JSON.stringify(inPage.result));
    } finally {
      host.dispose();
    }
  }, 120_000);
});

describe('the §8.2 bench: 2 000 nodes in 200 boxes (DD-14 C49)', () => {
  it('prints the three mixed-engine variants and elk alone, each through the worker, warm', async () => {
    const variants = [
      ['elk alone (F15)', elkEngine, scaleDocument(2000)],
      ['elk root, grid boxes', elkEngine, scaleDocument(2000, { boxes: 'grid' })],
      ['grid root, elk boxes', gridEngine, scaleDocument(2000, { boxes: 'elk' })],
      ['elk root, elk boxes', elkEngine, scaleDocument(2000, { boxes: 'elk' })],
    ] as const;
    const host = createHost();
    const browser = navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chromium';
    try {
      // Warm the worker, elkjs's chunk and the composer's, so the timed runs are layout.
      const warm = requestFor(ELK_IN_GRID as string, gridEngine);
      await host.run('sgl.grid', warm.input, warm.options, METRICS, {}, new AbortController().signal, warm.plan);
      for (const [name, root, source] of variants) {
        const { input, options, plan } = requestFor(source, root);
        expect(plan.length, name).toBe(name.startsWith('elk alone') ? 0 : 200);
        const times: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const t0 = performance.now();
          const outcome = await host.run(root.id, input, options, METRICS, {}, new AbortController().signal, plan.length > 0 ? plan : undefined);
          times.push(performance.now() - t0);
          expect(outcome.diagnostics.filter((d) => d.severity === 'error'), name).toEqual([]);
          expect(outcome.value, name).not.toBeNull();
        }
        const sorted = [...times].sort((a, b) => a - b);
        console.warn(`[B8-BENCH] ${name}, 2 000 nodes, ${browser} worker: best ${sorted[0]!.toFixed(0)} ms, median ${sorted[1]!.toFixed(0)} ms (round trip, 3 runs)`);
      }
    } finally {
      host.dispose();
    }
  }, 300_000);
});
