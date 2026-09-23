import { describe, expect, it } from 'vitest';
import { asNodeId, diagnostic, NO_SPAN, parse, type Diagnostic } from '@sgl/core';
import type { LayoutHost, LayoutInput, LayoutResult, ResolvedThemeMetricsView } from '@sgl/layout-api';
import type { StageResult } from '@sgl/core';
import { StaticMetricsMeasurer } from '@sgl/measure';
import { createPipeline } from '../src/state/pipeline.js';
import type { AppMeasurer, Cancel, Schedule } from '../src/state/types.js';

/**
 * DD-08 §3's signal graph and pipeline orchestration, driven with fakes for the
 * host, the measurer and the debounce clock (I3) — no `Worker`, no DOM, no real
 * timers, so every test below controls exactly when the debounce fires and when
 * the (fake) worker answers.
 */

const METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};

/** `StaticMetricsMeasurer` plus a no-op `ready` — deterministic, no canvas, no
 *  fonts to await (the same reasoning `packages/render-svg/test/pipeline.ts`
 *  already applies to run the real pipeline stages under Node). */
class TestMeasurer extends StaticMetricsMeasurer implements AppMeasurer {
  async ready(): Promise<void> {
    // No fonts to wait for.
  }
}

interface PendingRun {
  readonly engineId: string;
  readonly input: LayoutInput;
  readonly signal: AbortSignal;
  readonly resolve: (result: StageResult<LayoutResult | null>) => void;
  /** Not part of the real `LayoutHost` contract (DD-06 §3: `run()` only ever
   *  rejects with `AbortError`) — exposed anyway so the error-boundary tests
   *  can simulate a *broken* host violating its own contract, which is exactly
   *  the condition §13's effect boundary exists to catch. */
  readonly reject: (err: unknown) => void;
}

/** A `LayoutHost` whose `run()` promises are settled by hand from the test, so
 *  the exact moment a result (or a rejection) lands is under test control —
 *  mirroring the real `host.ts` contract (`run()` never rejects except
 *  `AbortError`; DD-06 §3) without a real worker behind it.
 *
 *  `ignoreAbort` leaves the promise pending on `'abort'` instead of the real
 *  host's own reject-on-abort behaviour — needed to test the *other* half of
 *  DD-06 §3's contract, "a late reply for an already-aborted id is
 *  discarded": a real worker can still answer a superseded request after the
 *  host has already moved on, and `pipeline.ts:runLayout`'s own generation
 *  check (not the host) is what has to discard it. */
function createFakeHost(options: { readonly ignoreAbort?: boolean } = {}): { readonly host: LayoutHost; readonly pending: PendingRun[] } {
  const pending: PendingRun[] = [];
  const host: LayoutHost = {
    run(engineId, input, _options, _metrics, _table, signal) {
      return new Promise<StageResult<LayoutResult | null>>((resolve, reject) => {
        pending.push({ engineId, input, signal, resolve, reject });
        if (!options.ignoreAbort) signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
      });
    },
    dispose() {
      // Nothing to release.
    },
  };
  return { host, pending };
}

function makeAbortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

interface ScheduledCall {
  readonly fn: () => void;
  readonly ms: number;
  cancelled: boolean;
}

/** A controllable debounce clock (I3): `schedule` records the call instead of
 *  starting a real timer; `fireLatest()` runs whichever scheduled call is still
 *  live, the same thing a real 120 ms timer firing would do. The pipeline now
 *  schedules two different delays on this same clock — the 120 ms debounce and
 *  the 300 ms "laying out…" chip delay — so `fireByMs` targets one specifically
 *  when a test needs to fire one without the other. */
function createManualSchedule(): {
  readonly schedule: Schedule;
  readonly calls: ScheduledCall[];
  fireLatest(): void;
  fireByMs(ms: number): void;
} {
  const calls: ScheduledCall[] = [];
  const schedule: Schedule = (fn, ms) => {
    const entry: ScheduledCall = { fn, ms, cancelled: false };
    calls.push(entry);
    const cancel: Cancel = () => {
      entry.cancelled = true;
    };
    return cancel;
  };
  return {
    schedule,
    calls,
    fireLatest() {
      const live = [...calls].reverse().find((c) => !c.cancelled);
      live?.fn();
    },
    fireByMs(ms: number) {
      const live = calls.filter((c) => !c.cancelled && c.ms === ms);
      for (const entry of live) entry.fn();
    },
  };
}

function fakeLayoutResult(nodeId: string, w = 100, h = 60): LayoutResult {
  return {
    bounds: { x: 0, y: 0, w, h },
    nodes: { [asNodeId(nodeId)]: { frame: { x: 0, y: 0, w, h } } },
    edges: {},
    labels: [],
  };
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** Flushes microtasks until `predicate()` is true or `maxTicks` is reached —
 *  more robust than a fixed `flush(n)` for state that now depends on the
 *  measure effect's own async chain completing *before* the layout effect
 *  schedules anything (`hasMeasuredOnce`, `pipeline.ts`), which takes a
 *  variable, environment-dependent number of microtask turns rather than a
 *  hardcoded one. */
async function flushUntil(predicate: () => boolean, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i += 1) await Promise.resolve();
}

function setup(
  source: string,
  extraDeps: Partial<Parameters<typeof createPipeline>[0]> = {},
  hostOptions: { readonly ignoreAbort?: boolean } = {},
) {
  const { host, pending } = createFakeHost(hostOptions);
  const { schedule, calls, fireLatest, fireByMs } = createManualSchedule();
  const measurer = new TestMeasurer();
  const pipeline = createPipeline({ measurer, host, metrics: METRICS, defaultEngineId: 'sgl.grid', schedule, ...extraDeps }, source);
  return { pipeline, host, pending, schedule, calls, fireLatest, fireByMs };
}

/** Drives the pipeline through one full successful layout: fires the scheduled
 *  debounce, lets the measure effect's async `ready()`/`premeasure()` settle,
 *  resolves the fake host's request, and lets the resulting signals propagate. */
async function completeOneLayout(env: ReturnType<typeof setup>, nodeId: string): Promise<void> {
  await flushUntil(() => env.calls.some((c) => !c.cancelled));
  env.fireLatest();
  await flush();
  const call = env.pending[env.pending.length - 1];
  expect(call).toBeDefined();
  call!.resolve({ value: fakeLayoutResult(nodeId), diagnostics: [] });
  await flush();
}

describe('pipeline (DD-08 §3)', () => {
  it('last-good survives a syntax error (FR-E4)', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');

    const goodSvg = env.pipeline.lastGood.value?.svg;
    expect(goodSvg).toBeTruthy();

    // An unterminated string is a syntax error (SGL1003).
    const broken = parse('a: "A');
    expect(broken.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    env.pipeline.setDocument(broken.tree, 'a: "A');
    await flush();

    expect(env.pipeline.diags.value.some((d) => d.severity === 'error')).toBe(true);
    expect(env.pipeline.lastGood.value?.svg).toBe(goodSvg);
  });

  it('a superseded layout is aborted and its result ignored', async () => {
    const env = setup('a: "A"');
    await flushUntil(() => env.calls.some((c) => !c.cancelled));
    env.fireLatest();
    await flush();
    expect(env.pending.length).toBe(1);
    const first = env.pending[0]!;
    expect(first.signal.aborted).toBe(false);

    const parsedB = parse('b: "B"');
    env.pipeline.setDocument(parsedB.tree, 'b: "B"');
    await flush();
    env.fireLatest();
    await flush();

    expect(env.pending.length).toBe(2);
    expect(first.signal.aborted).toBe(true);

    // The superseded request's own resolve (if the fake worker still answered
    // it late) must not win even if called after the abort.
    first.resolve({ value: fakeLayoutResult('a'), diagnostics: [] });
    env.pending[1]!.resolve({ value: fakeLayoutResult('b'), diagnostics: [] });
    await flush();

    expect(env.pipeline.layout.value?.nodes[asNodeId('b')]).toBeDefined();
    expect(env.pipeline.layout.value?.nodes[asNodeId('a')]).toBeUndefined();
    expect(env.pipeline.layoutDiags.value).toEqual([]);
  });

  it('a late-arriving *fulfilled* result for a superseded request never reaches layout/layoutDiags/lastGood', async () => {
    // The default fake host rejects on `'abort'` immediately, so a superseded
    // request's own promise is always already-settled by the time a test
    // calls `.resolve()` on it — Promise semantics make that resolve a no-op,
    // so the `generation !== layoutGeneration` guard at `pipeline.ts`'s
    // `runLayout().then(...)` was never actually exercised by a *fulfilled*
    // late reply. `ignoreAbort` leaves the promise genuinely pending past the
    // abort, matching a real worker/engine that has not noticed `ctx.signal`
    // yet (DD-06 §3 explicitly allows for this).
    const env = setup('a: "A"', {}, { ignoreAbort: true });
    await completeOneLayout(env, 'a'); // pending[0] — resolved, the baseline; not "superseded."

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"');
    await flush();
    env.fireLatest();
    await flush();
    expect(env.pending.length).toBe(2); // pending[1] — about to be superseded.

    const parsedC = parse('a: "A"\nb: "B"\nc: "C"');
    env.pipeline.setDocument(parsedC.tree, 'a: "A"\nb: "B"\nc: "C"');
    await flush();
    env.fireLatest();
    await flush();
    expect(env.pending.length).toBe(3); // pending[2] — issuing it aborts pending[1].

    const superseded = env.pending[1]!;
    const current = env.pending[2]!;
    expect(superseded.signal.aborted).toBe(true); // abort was requested...
    // ...but the fake host did not reject on it: the promise is still open.

    current.resolve({ value: fakeLayoutResult('both'), diagnostics: [] });
    await flush();
    expect(env.pipeline.layout.value?.nodes[asNodeId('both')]).toBeDefined();
    const layoutAfterCurrent = env.pipeline.layout.value;
    const lastGoodAfterCurrent = env.pipeline.lastGood.value;

    // The superseded request's own result finally arrives — a different,
    // bogus layout plus a diagnostic that must never surface.
    superseded.resolve({ value: fakeLayoutResult('a'), diagnostics: [diagnostic('SGL4003', NO_SPAN, { node: 'a' })] });
    await flush();

    expect(env.pipeline.layout.value).toBe(layoutAfterCurrent); // untouched by the stale reply.
    expect(env.pipeline.layout.value?.nodes[asNodeId('a')]).toBeUndefined();
    expect(env.pipeline.layoutDiags.value).toEqual([]); // the stale SGL4003 never lands.
    expect(env.pipeline.lastGood.value).toBe(lastGoodAfterCurrent);
  });

  it('a theme-only change skips layout but re-renders', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    expect(env.pending.length).toBe(1);

    const layoutBefore = env.pipeline.layout.value;
    const geometryHashBefore = env.pipeline.styled.value.value.geometryHash;
    const svgBefore = env.pipeline.lastGood.value?.svg;

    env.pipeline.themeId.value = 'neutral-dark';
    await flush();
    env.fireLatest();
    await flush();

    // Geometry is unchanged between the two built-in themes; no second host.run().
    expect(env.pipeline.styled.value.value.geometryHash).toBe(geometryHashBefore);
    expect(env.pending.length).toBe(1);
    expect(env.pipeline.layout.value).toBe(layoutBefore);

    // But the render itself is not skipped (DD-07 §11, F7 — a full re-render,
    // not a `<style>`-only swap), so lastGood picks up the new theme's paint.
    expect(env.pipeline.lastGood.value?.svg).not.toBe(svgBefore);
    expect(env.pipeline.lastGood.value?.styled.themeId).toBe('neutral-dark');
  });

  it('SGL4001 (timeout) keeps the previous layout and surfaces the diagnostic', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    const layoutBefore = env.pipeline.layout.value;

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"');
    await flush();
    env.fireLatest();
    await flush();

    const call = env.pending[env.pending.length - 1]!;
    const sgl4001 = diagnostic('SGL4001', NO_SPAN, { id: 'sgl.grid', ms: 2000 });
    call.resolve({ value: null, diagnostics: [sgl4001] });
    await flush();

    expect(env.pipeline.layout.value).toBe(layoutBefore); // unchanged — FR-E4.
    expect(env.pipeline.layoutDiags.value).toContainEqual(sgl4001);
    expect(env.pipeline.diags.value).toContainEqual(sgl4001);
  });

  it('SGL4002 (malformed result) keeps the previous layout and surfaces the diagnostic', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    const layoutBefore = env.pipeline.layout.value;

    const parsedB = parse('a: "A"\nc: "C"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nc: "C"');
    await flush();
    env.fireLatest();
    await flush();

    const call = env.pending[env.pending.length - 1]!;
    const sgl4002 = diagnostic('SGL4002', NO_SPAN, { id: 'sgl.grid', detail: 'missing bounds' });
    call.resolve({ value: null, diagnostics: [sgl4002] });
    await flush();

    expect(env.pipeline.layout.value).toBe(layoutBefore);
    expect(env.pipeline.layoutDiags.value).toContainEqual(sgl4002);
    expect(env.pipeline.diags.value.some((d: Diagnostic) => d.code === 'SGL4002')).toBe(true);
  });

  it('debounces: rapid edits before the timer fires issue only one request', async () => {
    const env = setup('a: "A"');
    await flushUntil(() => env.calls.some((c) => !c.cancelled)); // the initial boot's own first scheduling.
    // Two more edits before anything fires must each cancel the previous scheduling.
    const parsedB = parse('b: "B"');
    env.pipeline.setDocument(parsedB.tree, 'b: "B"');
    await flush();
    const parsedC = parse('c: "C"');
    env.pipeline.setDocument(parsedC.tree, 'c: "C"');
    await flush();

    expect(env.pending.length).toBe(0); // nothing has fired yet.
    const cancelledCount = env.calls.filter((c) => c.cancelled).length;
    expect(cancelledCount).toBeGreaterThanOrEqual(2); // the two superseded schedulings.
    expect(env.calls.every((c) => c.ms === 120)).toBe(true); // DD-08 §3: 120 ms.

    env.fireLatest();
    await flush();
    expect(env.pending.length).toBe(1); // only the latest edit's request ran.
    expect(env.pending[0]!.engineId).toBe('sgl.grid');
  });

  it('boot: exactly one layout request ever runs, and it carries real (non-zero) label sizes from premeasure', async () => {
    // Regression test for the `hasMeasuredOnce` guard (pipeline.ts:227-243,
    // 319-328): without it, the layout effect fires once immediately on boot
    // with `table` still `{}`, scheduling (and, once fired, running) a first
    // layout request whose label sizes are all `labelSizesOf`'s `{ w: 0, h: 0
    // }` fallback — before a *second*, correctly-sized request follows once
    // premeasure actually completes. A long label makes the difference
    // unmistakable: a zero-size label still gets *some* width from the
    // shape's own theme padding/minWidth floor (`neutral-light`'s node rule:
    // `minWidth: 72`), but nowhere near what a real 60-character label
    // measures to.
    const longLabel = 'A very long label so its measured width is unmistakably larger than the 72px minWidth floor';
    const env = setup(`a: "${longLabel}"`);
    await flushUntil(() => env.calls.some((c) => !c.cancelled));
    env.fireLatest();
    await flush();

    // `env.calls` records *every* scheduling ever made on the shared clock,
    // cancelled or not, including the unrelated 300 ms "laying out…" timer
    // `runLayout` starts once it sets `inFlight = true` — filtered to the
    // 120 ms debounce alone. A wasted zero-size first pass shows up here (two
    // 120 ms schedulings, the first cancelled by the second) even though
    // `fireLatest()` always resolves to the *latest* live one, so
    // `env.pending.length` alone cannot tell the two cases apart (microtask
    // ordering means the correctly-sized table often lands and supersedes
    // the empty one before the test ever fires anything, whether or not the
    // guard exists).
    const debounceSchedulings = env.calls.filter((c) => c.ms === 120);
    expect(debounceSchedulings).toHaveLength(1); // exactly one scheduling, ever — no wasted empty-table pass.
    expect(env.pending.length).toBe(1);
    const sizing = env.pending[0]!.input.sizing[asNodeId('a')];
    expect(sizing).toBeDefined();
    expect(sizing!.intrinsic.w).toBeGreaterThan(150); // real text measurement, not the padding floor alone.
  });
});

describe('document overrides (DD-08 §10)', () => {
  it('a document @theme wins over the picker signal', async () => {
    const env = setup('@theme: "neutral-dark"\na: "A"');
    expect(env.pipeline.documentThemeId.value).toBe('neutral-dark');
    expect(env.pipeline.effectiveThemeId.value).toBe('neutral-dark');
    env.pipeline.themeId.value = 'neutral-light'; // the picker's own preference
    expect(env.pipeline.effectiveThemeId.value).toBe('neutral-dark'); // document still wins
  });

  it('no document @theme falls through to the picker signal', () => {
    const env = setup('a: "A"');
    expect(env.pipeline.documentThemeId.value).toBeUndefined();
    expect(env.pipeline.effectiveThemeId.value).toBe(env.pipeline.themeId.value);
  });

  it('a document @layout.engine wins over the picker signal', () => {
    const env = setup('@layout.engine: "sgl.grid"\na: "A"');
    expect(env.pipeline.documentEngineId.value).toBe('sgl.grid');
    env.pipeline.engineId.value = 'sgl.elk';
    expect(env.pipeline.effectiveEngineId.value).toBe('sgl.grid');
  });

  it('@layout: { engine: "..." } (object form) is read the same as the dotted form', () => {
    const env = setup('@layout: { engine: "sgl.grid" }\na: "A"');
    expect(env.pipeline.documentEngineId.value).toBe('sgl.grid');
  });
});

describe('error boundary (DD-08 §13)', () => {
  it('a host.run() rejection other than AbortError is caught, not left unhandled, and surfaces on the chip', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    const layoutBefore = env.pipeline.layout.value;

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"');
    await flush();
    env.fireLatest();
    await flush();

    const call = env.pending[env.pending.length - 1]!;
    call.reject(new Error('engine module failed to load'));
    await flush();

    expect(env.pipeline.pipelineError.value?.message).toContain('engine module failed to load');
    expect(env.pipeline.pipelineError.value?.sourceHash).toBeTruthy();
    expect(env.pipeline.chip.value.kind).toBe('crashed');
    expect(env.pipeline.chip.value.message).toBe('Something went wrong rendering — your text is safe');
    // The last good layout is untouched — "the editor keeps working" (§13).
    expect(env.pipeline.layout.value).toBe(layoutBefore);
  });

  it('the crash clears once a later render succeeds', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"');
    await flush();
    env.fireLatest();
    await flush();
    env.pending[env.pending.length - 1]!.reject(new Error('boom'));
    await flush();
    expect(env.pipeline.pipelineError.value).not.toBeNull();

    const parsedC = parse('a: "A"\nc: "C"');
    env.pipeline.setDocument(parsedC.tree, 'a: "A"\nc: "C"');
    await flush();
    env.fireLatest();
    await flush();
    env.pending[env.pending.length - 1]!.resolve({ value: fakeLayoutResult('c'), diagnostics: [] });
    await flush();

    expect(env.pipeline.pipelineError.value).toBeNull();
    expect(env.pipeline.chip.value.kind).not.toBe('crashed');
  });

  it('a throw from measurer.ready() is caught, not left as an unhandled rejection', async () => {
    const host: LayoutHost = { run: () => new Promise(() => {}), dispose: () => {} };
    const throwingMeasurer: AppMeasurer = {
      layoutRuns: () => ({ width: 0, height: 0, lines: [], ascent: 0 }),
      layoutRunsAsync: async () => ({ width: 0, height: 0, lines: [], ascent: 0 }),
      has: () => true,
      ready: () => {
        throw new Error('fonts API unavailable');
      },
    };
    const pipeline = createPipeline({ measurer: throwingMeasurer, host, metrics: METRICS, defaultEngineId: 'sgl.grid' }, 'a: "A"');
    await flush();
    expect(pipeline.pipelineError.value?.message).toContain('fonts API unavailable');
    pipeline.dispose();
  });

  it('a throwing synchronous stage (K1: DD-08 §13 "anywhere in the pipeline") is caught, keeps parsed/model/graph/theme/styled and lastGood at their last-good values, and never crashes the app', async () => {
    let calls = 0;
    // `unsafeInjectStageThrow` runs once per synchronous recompute of the
    // guarded chain (`parsedOutcome`'s `compute()`) — call 1 is the
    // pipeline's own construction-time pass, call 2 is the first edit below
    // (left to succeed normally, so there is a real "last good" snapshot to
    // assert against), call 3 (the second edit) throws — simulating
    // `parse`/`resolve`/`compile`/`resolveTheme`/`styleGraph` violating their
    // own "never throws on document input" contract (§1), which nothing in
    // this codebase can otherwise provoke on purpose.
    const env = setup('a: "A"', { unsafeInjectStageThrow: () => {
      calls += 1;
      if (calls > 2) throw new Error('simulated stage invariant violation');
    } });
    await completeOneLayout(env, 'a'); // call 1.

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"'); // call 2 — succeeds.
    await flush();

    const parsedBefore = env.pipeline.parsed.value;
    const modelBefore = env.pipeline.model.value;
    const graphBefore = env.pipeline.graph.value;
    const themeBefore = env.pipeline.theme.value;
    const styledBefore = env.pipeline.styled.value;
    const layoutBefore = env.pipeline.layout.value;
    const lastGoodBefore = env.pipeline.lastGood.value;
    expect(parsedBefore.value.entries).toHaveLength(2); // sanity: this really is the post-edit ('a', 'b') state.

    const parsedC = parse('a: "A"\nb: "B"\nc: "C"');
    expect(() => env.pipeline.setDocument(parsedC.tree, 'a: "A"\nb: "B"\nc: "C"')).not.toThrow(); // call 3 — throws internally, caught.
    await flush();

    // Every guarded stage stayed frozen at its last successful value — the
    // whole chain, not just the one that happened to throw first.
    expect(env.pipeline.parsed.value).toBe(parsedBefore);
    expect(env.pipeline.model.value).toBe(modelBefore);
    expect(env.pipeline.graph.value).toBe(graphBefore);
    expect(env.pipeline.theme.value).toBe(themeBefore);
    expect(env.pipeline.styled.value).toBe(styledBefore);
    expect(env.pipeline.layout.value).toBe(layoutBefore);
    expect(env.pipeline.lastGood.value).toBe(lastGoodBefore); // "the last good render stays" (§13).

    expect(env.pipeline.pipelineError.value?.message).toContain('simulated stage invariant violation');
    expect(env.pipeline.chip.value.kind).toBe('crashed');

    // The editor keeps working: a document change still reaches `source`
    // (CodeMirror's own state, not gated by the pipeline crash) even though
    // the derived signals above are frozen.
    expect(env.pipeline.source.value).toBe('a: "A"\nb: "B"\nc: "C"');
  });
});

describe('status chip (DD-08 §11)', () => {
  it('shows nothing before 300 ms in flight, then "laying out…"', async () => {
    const env = setup('a: "A"');
    await flushUntil(() => env.calls.some((c) => !c.cancelled));
    env.fireLatest(); // fires the 120 ms debounce, starting the host.run() call
    await flush();
    expect(env.pipeline.chip.value.kind).toBe('idle');

    env.fireByMs(300); // the "laying out…" delay
    expect(env.pipeline.chip.value.kind).toBe('laying-out');
    expect(env.pipeline.chip.value.message).toBe('laying out…');
  });

  it('SGL4001 shows the timeout message', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"');
    await flush();
    env.fireLatest();
    await flush();
    env.pending[env.pending.length - 1]!.resolve({
      value: null,
      diagnostics: [diagnostic('SGL4001', NO_SPAN, { id: 'sgl.grid', ms: 2000 })],
    });
    await flush();

    expect(env.pipeline.chip.value.kind).toBe('timeout');
    expect(env.pipeline.chip.value.message).toBe('Layout timed out — showing previous');
  });

  it('a document error shows "Showing last good render · n errors"', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    const broken = parse('a: "A');
    env.pipeline.setDocument(broken.tree, 'a: "A');
    await flush();

    expect(env.pipeline.chip.value.kind).toBe('last-good');
    expect(env.pipeline.chip.value.message).toMatch(/^Showing last good render · \d+ errors?$/);
  });
});

describe('the "Fit" offer (DD-08 §6)', () => {
  it('is not offered before any fit has happened', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    expect(env.pipeline.chip.value.offerFit).toBe(false);
  });

  it('is offered once bounds change by more than 40% since the last fit, and fitDone() clears it', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a'); // 100x60 (fakeLayoutResult's default)
    env.pipeline.fitDone(); // simulate the canvas's initial auto-fit
    expect(env.pipeline.chip.value.offerFit).toBe(false);

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"');
    await flush();
    env.fireLatest();
    await flush();
    env.pending[env.pending.length - 1]!.resolve({ value: fakeLayoutResult('b', 300, 300), diagnostics: [] });
    await flush();

    expect(env.pipeline.chip.value.offerFit).toBe(true);
    env.pipeline.fitDone();
    expect(env.pipeline.chip.value.offerFit).toBe(false);
  });
});
