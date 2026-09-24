import { effect } from '@preact/signals';
import { parse } from '@sgl/core';
import type { LayoutHost, ResolvedThemeMetricsView } from '@sgl/layout-api';
import { runHostSequence } from '@sgl/layout-api/conformance';
import { gridEngine } from '@sgl/layout-std';
import { StaticMetricsMeasurer } from '@sgl/measure';
import { createPipeline, type Pipeline } from '../src/state/pipeline.js';
import type { AppMeasurer, Cancel, PipelineDeps, Schedule } from '../src/state/types.js';

/**
 * The real pipeline over real stages and a real `grid` layout, run in
 * process: `StaticMetricsMeasurer` (deterministic, no canvas), a layout host
 * that runs `grid` through the worker's own host sequence
 * (`runHostSequence`: layout → host fallbacks → quantize) and answers on a
 * later macrotask, and a debounce clock `settle()` drives. For tests that need
 * genuine SVG out of the app's pipeline — the theme fast path's byte-equality
 * and render-count tests — where `pipeline.test.ts`'s hand-settled fake host
 * would give a single hand-made frame.
 */

export const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

class TestMeasurer extends StaticMetricsMeasurer implements AppMeasurer {
  async ready(): Promise<void> {
    // No fonts to wait for.
  }
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface Harness {
  readonly pipeline: Pipeline;
  /** Layout requests the host has received. */
  readonly layoutRequests: () => number;
  /** How many times `lastGood` has changed since the harness was built. */
  readonly lastGoodWrites: () => number;
  /** Replace the document, as the editor's `updateListener` does. */
  setSource(text: string): void;
  /** Run the pipeline to idle: every debounce fired, every layout answered. */
  settle(): Promise<void>;
  dispose(): void;
}

export async function createHarness(source: string, deps: Partial<PipelineDeps> = {}): Promise<Harness> {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const entry = { fn, ms, cancelled: false };
    timers.push(entry);
    const cancel: Cancel = () => {
      entry.cancelled = true;
    };
    return cancel;
  };
  let requests = 0;
  const host: LayoutHost = {
    async run(engineId, input, options) {
      requests += 1;
      if (engineId !== gridEngine.id) throw new Error(`the harness lays out with grid only, not ${engineId}`);
      await macrotask();
      const { result } = await runHostSequence(gridEngine, input, options, METRICS);
      return { value: result, diagnostics: [] };
    },
    dispose() {
      // Nothing to release.
    },
  };
  const pipeline = createPipeline({ measurer: new TestMeasurer(), host, metrics: METRICS, defaultEngineId: gridEngine.id, schedule, ...deps }, source);
  let writes = -1; // the effect's own first run is not a write
  const disposeCount = effect(() => {
    void pipeline.lastGood.value;
    writes += 1;
  });

  async function settle(): Promise<void> {
    for (let round = 0; round < 50; round += 1) {
      await macrotask();
      // The 120 ms layout debounce; the 300 ms "laying out…" chip delay is
      // left alone (it paints nothing).
      const due = timers.filter((t) => !t.cancelled && t.ms !== 300);
      for (const t of due) t.cancelled = true;
      for (const t of due) t.fn();
      await macrotask();
      if (due.length === 0 && !pipeline.inFlight.peek()) return;
    }
    throw new Error('the pipeline did not go idle');
  }

  const harness: Harness = {
    pipeline,
    layoutRequests: () => requests,
    lastGoodWrites: () => writes,
    setSource(text) {
      pipeline.setDocument(parse(text).tree, text);
    },
    settle,
    dispose() {
      disposeCount();
      pipeline.dispose();
    },
  };
  await settle();
  if (pipeline.lastGood.peek() === null) throw new Error(`no first render: ${JSON.stringify(pipeline.diags.peek().slice(0, 3))}`);
  return harness;
}
