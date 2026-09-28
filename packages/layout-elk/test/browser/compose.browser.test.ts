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
import { editScaleDocument, scaleDocument } from '../../../../bench/scale-document.js';
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
 *   same graph (F15's measurement) beside them. Each on a fresh worker:
 *   the document's first request (cold), three repeats (warm), and three
 *   one-keystroke edits of each kind (`editScaleDocument`: inside one box,
 *   outside every box, a box's options), for the per-box cache
 *   (`perf/b8-cache`, DD-14 C32). Times are printed (`[B8-BENCH]`), not
 *   asserted beyond the request's own timeout: timing asserts are the
 *   nightly bench's (bench/README.md), and the cache's own CPU-time test is
 *   `layout-elk/test/compose-cache.test.ts`.
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

describe('the §8.2 bench: 2 000 nodes in 200 boxes (DD-14 C49, C32)', () => {
  it('prints the three mixed-engine variants and elk alone through the worker: cold, warm, and one edit of each kind', async () => {
    const variants = [
      ['elk alone (F15)', elkEngine, scaleDocument(2000)],
      ['elk root, grid boxes', elkEngine, scaleDocument(2000, { boxes: 'grid' })],
      ['grid root, elk boxes', gridEngine, scaleDocument(2000, { boxes: 'elk' })],
      ['elk root, elk boxes', elkEngine, scaleDocument(2000, { boxes: 'elk' })],
    ] as const;
    const browser = navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chromium';
    for (const [name, root, source] of variants) {
      const boxed = !name.startsWith('elk alone');
      // A fresh worker per variant, so its per-box cache (`perf/b8-cache`)
      // starts empty: "cold" is the document's first request, on a worker
      // that has already loaded elkjs's chunk and the composer's.
      const host = createHost();
      try {
        const warm = requestFor(ELK_IN_GRID as string, gridEngine);
        await host.run('sgl.grid', warm.input, warm.options, METRICS, {}, new AbortController().signal, warm.plan);
        const time = async (text: string): Promise<number> => {
          const { input, options, plan } = requestFor(text, root);
          expect(plan.length, name).toBe(boxed ? 200 : 0);
          const t0 = performance.now();
          const outcome = await host.run(root.id, input, options, METRICS, {}, new AbortController().signal, boxed ? plan : undefined);
          const ms = performance.now() - t0;
          expect(outcome.diagnostics.filter((d) => d.severity === 'error'), name).toEqual([]);
          expect(outcome.value, name).not.toBeNull();
          return ms;
        };
        const line = (what: string, times: readonly number[]): string => {
          const sorted = [...times].sort((a, b) => a - b);
          return `${what} best ${sorted[0]!.toFixed(0)} / median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms`;
        };
        const cold = await time(source);
        const parts = [`cold ${cold.toFixed(0)} ms`, line('warm', [await time(source), await time(source), await time(source)])];
        if (boxed) {
          for (const kind of ['inside', 'outside', 'options'] as const) {
            // Each edit is one keystroke away from the document just laid
            // out, on a different box each time; the way back is not timed.
            const times: number[] = [];
            for (const k of [50, 100, 150]) {
              times.push(await time(editScaleDocument(source, kind, k)));
              await time(source);
            }
            parts.push(line(`edit ${kind}`, times));
          }
        }
        console.warn(`[B8-BENCH] ${name}, 2 000 nodes, ${browser} worker, round trip: ${parts.join('; ')}`);
      } finally {
        host.dispose();
      }
    }
  }, 900_000);
});
