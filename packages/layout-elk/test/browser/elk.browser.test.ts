import { compile, parse, resolve, type LabelId, type Size } from '@sgl/core';
import { labelRunKey, premeasure, StaticMetricsMeasurer } from '@sgl/measure';
import { BUILT_IN, neutralLight, resolveTheme, styleGraph } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import type { LayoutInput, ResolvedThemeMetricsView, StyledGraphInput } from '../../../layout-api/src/contract.js';
import { runHostSequence } from '../../../layout-api/src/conformance.js';
import { createWorkerHost, DEFAULT_ENGINE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../../../layout-api/src/host.js';
import { buildLayoutInput } from '../../../layout-api/src/sizing.js';
import { placeLabels } from '../../../layout-api/src/fallbacks.js';
import { quantize } from '../../../layout-api/src/validate.js';
// Plain data and a plain-JS pure function, shared with the Node side.
import { scaleDocument } from '../../../../bench/scale-document.js';
import FORTY from '../../../../corpus/forty-three-level.sgl?raw';
import CHECKOUT from '../../../../corpus/checkout.sgl?raw';
import GOLDEN_FORTY from '../__goldens__/result/forty-three-level.sgl.json?raw';
import { elkEngine } from '../../src/index.js';

/**
 * `elk` in a real browser (Stage K): the real engine behind the real
 * `createWorkerHost`, in a real `Worker` (`elk.worker.ts`).
 *
 * - K2: two runs through the worker are identical after quantization, and
 *   ELK's own output here matches the golden Node wrote (Node ≡ this browser,
 *   after quantization — ADR-0004's `quantized` class).
 * - K5: the labels the worker posts are exactly ELK's, i.e. the host fallback
 *   (`placeLabels`) did not run for a `labelPlacement: true` engine.
 * - K10: the 1 000-node graph's time through the worker is printed; the
 *   timeout is elk's production one (the host default, 10 s), not raised.
 *
 * Inputs are built in the page from real `.sgl` text with
 * `StaticMetricsMeasurer`, exactly as the Node tests build them.
 */

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

function inputFor(source: string): LayoutInput {
  const { model } = resolve(parse(source).ast);
  const { graph } = compile(model);
  const { value: theme } = resolveTheme(neutralLight, (id) => BUILT_IN[id]);
  const { value: styled } = styleGraph(graph, theme, model.classes);
  const table = premeasure(styled, new StaticMetricsMeasurer());
  const labelSizes: Record<LabelId, Size> = {};
  for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
    const layout = table[labelRunKey(styled, labelId)];
    labelSizes[labelId] = layout === undefined ? { w: 0, h: 0 } : { w: layout.width, h: layout.height };
  }
  return buildLayoutInput(styled as StyledGraphInput, labelSizes);
}

function spawn(): Worker {
  return new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module' });
}

/** These tests prove determinism and where labels come from, not elk's
 *  production timeout: a first request pays the worker's cold module load and
 *  elkjs's chunk (and, on a cold Vite cache, dependency optimisation while the
 *  unit project saturates the CPU — the same reason `grid.browser.test.ts`
 *  gives grid 30 s). The K10 test below asserts the 1 000-node time against
 *  the production timeout itself, on a warm worker. */
const createHost = () => createWorkerHost(spawn, { engineTimeoutMs: { 'sgl.elk': 30_000 } });

describe('sgl.elk through a real Worker (Stage K)', () => {
  it('is identical across two runs after quantization, and equal to the in-page host sequence (K2)', async () => {
    const input = inputFor(FORTY as string);
    const host = createHost();
    try {
      const first = await host.run('sgl.elk', input, {}, METRICS, {}, new AbortController().signal);
      const second = await host.run('sgl.elk', input, {}, METRICS, {}, new AbortController().signal);
      expect(first.diagnostics).toEqual([]);
      expect(first.value).not.toBeNull();
      expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
      // The same sequence, run on this page's own thread.
      const inPage = await runHostSequence(elkEngine, input, {}, METRICS);
      expect(JSON.stringify(first.value)).toBe(JSON.stringify(inPage.result));
    } finally {
      host.dispose();
    }
  });

  it("elk's worker load leaves the worker's own onmessage in place: later requests still round-trip (K11)", async () => {
    // Without the scoped `document` stub (`load-elk.ts`), elkjs installs its
    // own dispatcher as `self.onmessage` on the worker it is loaded into. This
    // file's worker entry has no shim of its own: if an elkjs upgrade changes
    // that behaviour, this is the tripwire.
    const host = createHost();
    try {
      const small = inputFor(CHECKOUT as string);
      for (let i = 0; i < 3; i += 1) {
        const outcome = await host.run('sgl.elk', small, {}, METRICS, {}, new AbortController().signal);
        expect(outcome.diagnostics, `request ${i + 1}`).toEqual([]);
        expect(outcome.value, `request ${i + 1}`).not.toBeNull();
      }
    } finally {
      host.dispose();
    }
  });

  it('leaves no document behind in the worker after the first layout (K11, fix round 1, item 19)', async () => {
    const worker = spawn();
    try {
      const next = (t: string) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const on = (ev: MessageEvent) => {
            const data = ev.data as Record<string, unknown>;
            if (data['t'] === t || (t === 'result' && data['t'] === 'error')) {
              worker.removeEventListener('message', on);
              resolve(data);
            }
          };
          worker.addEventListener('message', on);
        });
      const input = inputFor(CHECKOUT as string);
      const done = next('result');
      worker.postMessage({ t: 'layout', id: 1, engine: 'sgl.elk', input, options: {}, metrics: METRICS, table: {}, seed: 1 });
      expect((await done)['t']).toBe('result'); // elk loaded and laid out …
      const probe = next('probe-document');
      worker.postMessage({ t: 'probe-document' });
      expect((await probe)['type']).toBe('undefined'); // … and the stub is gone.
    } finally {
      worker.terminate();
    }
  });

  it("ELK's own output here matches the golden Node produced, after quantization (Node ≡ this browser)", async () => {
    const { raw } = await runHostSequence(elkEngine, inputFor(FORTY as string), {}, METRICS);
    // If this differs, it is an ADR-0004 finding to report, not an assertion to loosen.
    expect(`${JSON.stringify(quantize(raw, 64), null, 2)}\n`).toBe(GOLDEN_FORTY as string);
  });

  it("posts ELK's labels, not the host fallback's (K5, through the real worker)", async () => {
    const input = inputFor(CHECKOUT as string);
    const host = createHost();
    try {
      const outcome = await host.run('sgl.elk', input, {}, METRICS, {}, new AbortController().signal);
      const { raw } = await runHostSequence(elkEngine, input, {}, METRICS);
      expect(outcome.value?.labels).toEqual(quantize(raw, 64).labels);
      // Edge labels are where ELK put them, not where the host fallback
      // (`placeLabels`, midpoint plus a perpendicular offset) would have.
      const fallback = placeLabels(input, outcome.value!, METRICS);
      const edgeLabels = input.graph.edges.filter((e) => e.labelId !== null).map((e) => e.labelId!);
      expect(edgeLabels.length).toBeGreaterThan(0);
      for (const id of edgeLabels) {
        const got = outcome.value!.labels.find((l) => l.labelId === id);
        expect(got?.frame).not.toEqual(fallback.labels.find((l) => l.labelId === id)?.frame);
      }
    } finally {
      host.dispose();
    }
  });

  it('lays out the 1 000-node graph inside its timeout (K10), and reports the time', async () => {
    const input = inputFor(scaleDocument(1000) as string);
    const host = createHost();
    try {
      // Warm the worker and elkjs's chunk first, so the timed run is layout.
      await host.run('sgl.elk', inputFor(FORTY as string), {}, METRICS, {}, new AbortController().signal);
      // The best of two timed runs (07 §2): ~1.6–1.8 s each here, quiet or
      // with 12 CPU hogs, so one run slowed by a busy machine does not fail
      // a layout that fits its production timeout.
      let ms = Number.POSITIVE_INFINITY;
      let outcome: Awaited<ReturnType<typeof host.run>> | undefined;
      for (let i = 0; i < 2; i += 1) {
        const t0 = performance.now();
        outcome = await host.run('sgl.elk', input, {}, METRICS, {}, new AbortController().signal);
        ms = Math.min(ms, performance.now() - t0);
      }
      if (outcome === undefined) throw new Error('unreachable');
      console.warn(`[K10] elk, 1 000 nodes, ${navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chromium'} worker: ${ms.toFixed(0)} ms (round trip)`);
      expect(outcome.diagnostics).toEqual([]);
      expect(outcome.value).not.toBeNull();
      // elk's production timeout: no per-engine entry, so the host default.
      expect(ms).toBeLessThan(DEFAULT_ENGINE_TIMEOUT_MS['sgl.elk'] ?? DEFAULT_TIMEOUT_MS);
    } finally {
      host.dispose();
    }
  }, 60_000);
});
