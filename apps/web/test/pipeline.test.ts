import { afterEach, describe, expect, it, vi } from 'vitest';
import { asNodeId, diagnostic, NO_SPAN, parse, type Diagnostic, type LabelId } from '@sgl/core';
import type { LayoutHost, LayoutInput, LayoutResult, ResolvedThemeMetricsView } from '@sgl/layout-api';
import type { StageResult } from '@sgl/core';
import { labelRunKey, StaticMetricsMeasurer } from '@sgl/measure';
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
  readonly options: object;
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
    run(engineId, input, engineOptions, _metrics, _table, signal) {
      return new Promise<StageResult<LayoutResult | null>>((resolve, reject) => {
        pending.push({ engineId, input, options: engineOptions, signal, resolve, reject });
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
  it('warns SGL4010 for a container engine and an undeclared @layout key (fix round 1, item 23; the e2e test checks the diagram stays)', async () => {
    const source = 'box: {\n  @layout: { engine: sgl.elk, columns: 2, gap: 4 }\n  a: "A"\n}\n';
    const env = setup(source, {
      engineSchemas: (id) => (id === 'sgl.grid' ? { id, optionsSchema: { properties: { columns: {}, gap: {}, align: {} } } } : undefined),
    });
    await completeOneLayout(env, 'box');
    const warnings = env.pipeline.diags.value.filter((d) => d.code === 'SGL4010');
    expect(warnings.map((d) => [source.slice(d.span.from, d.span.to), d.severity])).toEqual([['engine', 'warning']]);

    // Under an engine that does not declare `columns`/`gap`, those warn too.
    const env2 = setup(source.replace('sgl.elk', 'sgl.grid'), {
      defaultEngineId: 'sgl.elk',
      engineSchemas: (id) => (id === 'sgl.elk' ? { id, optionsSchema: { properties: { direction: {} } } } : undefined),
    });
    await flush();
    expect(env2.pipeline.diags.value.filter((d) => d.code === 'SGL4010').map((d) => source.replace('sgl.elk', 'sgl.grid').slice(d.span.from, d.span.to))).toEqual([
      'engine',
      'columns',
      'gap',
    ]);
  });

  it("sends the engine exactly the options its form shows, not the stored bag raw (fix round 1, item 3)", async () => {
    const env = setup('a: "A"');
    // A stored record's bag the grid form cannot show: it shows `auto`, 24, center.
    env.pipeline.engineOptions.value = { columns: 'x', gap: -3, align: 'sideways', stray: true };
    await completeOneLayout(env, 'a');
    expect(env.pending.at(-1)!.options).toEqual({ columns: 'auto', gap: 24, align: 'center' });

    env.pipeline.engineId.value = 'sgl.elk';
    env.pipeline.engineOptions.value = { direction: 'right', nodeSpacing: 'wide' };
    await completeOneLayout(env, 'a');
    expect(env.pending.at(-1)!.engineId).toBe('sgl.elk');
    expect(env.pending.at(-1)!.options).toEqual({ direction: 'right', nodeSpacing: 40, rankSpacing: 70, edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF' });

    // An engine with no hand-built form gets its bag unchanged.
    env.pipeline.engineId.value = 'org.example.other';
    env.pipeline.engineOptions.value = { anything: 1 };
    await completeOneLayout(env, 'a');
    expect(env.pending.at(-1)!.options).toEqual({ anything: 1 });
  });

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

  it('a superseded request whose *fulfilled* result arrives late never touches layout/layoutDiags/lastGood; the newer one does', async () => {
    // The default fake host rejects on `'abort'` at once, so a superseded
    // request's promise is already settled by the time a test resolves it —
    // that resolve is a no-op, and the `generation !== layoutGeneration` guard
    // in `runLayout`'s `.then` never sees a fulfilled late reply. `ignoreAbort`
    // leaves the promise open past the abort, as a real worker that has not yet
    // noticed `ctx.signal` would (DD-06 §3 allows for it), so the *pipeline's*
    // guard is the only thing standing between a stale result and the canvas.
    const env = setup('a: "A"', {}, { ignoreAbort: true });
    await completeOneLayout(env, 'a'); // pending[0]: the baseline.
    const baselineLayout = env.pipeline.layout.value;

    // Three edits, each fired: pending[1] and pending[2] are superseded by
    // pending[3], and none of the three has answered yet.
    for (const src of ['a: "A"\nb: "B"', 'a: "A"\nb: "B"\nc: "C"', 'a: "A"\nb: "B"\nc: "C"\nd: "D"']) {
      env.pipeline.setDocument(parse(src).tree, src);
      await flush();
      env.fireLatest();
      await flush();
    }
    expect(env.pending).toHaveLength(4);
    const [, staleEarly, staleLate, current] = env.pending as [PendingRun, PendingRun, PendingRun, PendingRun];
    expect(staleEarly.signal.aborted).toBe(true);
    expect(staleLate.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
    // Each edit already re-rendered against the baseline layout (a new
    // `styled`, the old frames) — this is what is on screen while all three
    // requests are out.
    expect(env.pipeline.layout.value).toBe(baselineLayout);
    const lastGoodBeforeReplies = env.pipeline.lastGood.value;
    expect(lastGoodBeforeReplies?.layout).toBe(baselineLayout);

    // 1. A stale reply lands while the current request is still in flight.
    staleEarly.resolve({ value: fakeLayoutResult('b'), diagnostics: [diagnostic('SGL4003', NO_SPAN, { node: 'b' })] });
    await flush();
    expect(env.pipeline.layout.value).toBe(baselineLayout);
    expect(env.pipeline.layoutDiags.value).toEqual([]);
    expect(env.pipeline.lastGood.value).toBe(lastGoodBeforeReplies);
    expect(env.pipeline.inFlight.value).toBe(true); // still waiting on `current`.

    // 2. The current reply lands and is adopted.
    const currentResult = fakeLayoutResult('d');
    current.resolve({ value: currentResult, diagnostics: [] });
    await flush();
    expect(env.pipeline.layout.value).toBe(currentResult);
    expect(env.pipeline.lastGood.value).not.toBe(lastGoodBeforeReplies);
    expect(env.pipeline.lastGood.value?.layout).toBe(currentResult);
    expect(env.pipeline.inFlight.value).toBe(false);
    const adoptedLastGood = env.pipeline.lastGood.value;

    // 3. Another stale reply lands after the current one: still ignored.
    staleLate.resolve({ value: fakeLayoutResult('c'), diagnostics: [diagnostic('SGL4003', NO_SPAN, { node: 'c' })] });
    await flush();
    expect(env.pipeline.layout.value).toBe(currentResult);
    expect(env.pipeline.layoutDiags.value).toEqual([]);
    expect(env.pipeline.lastGood.value).toBe(adoptedLastGood);
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

  it('boot: the first and only layout request carries the real premeasure table (hasMeasuredOnce)', async () => {
    // Regression test for the `hasMeasuredOnce` guard on the layout effect.
    // Without it the effect fires at construction with `table` still `{}`, and
    // that request lays every label out at `labelSizesOf`'s zero-size fallback
    // before a second, correctly-sized one follows. `fireLatest()` alone cannot
    // see that — the real table usually lands and re-schedules before a test
    // fires anything, coalescing the wasted request away — so this fires every
    // debounce *the moment it is scheduled*, starting synchronously after
    // construction, before the measure effect's async chain can have finished.
    const env = setup('a: "A very long label, measured far wider than any padding floor"\nb: "B"\na -> b: "edge label"');
    const fired = new Set<unknown>();
    const fireNewDebounces = (): void => {
      for (const call of env.calls) {
        if (call.ms !== 120 || call.cancelled || fired.has(call)) continue;
        fired.add(call);
        call.fn();
      }
    };

    fireNewDebounces(); // synchronously after construction: premeasure cannot have landed.
    await flushUntil(() => Object.keys(env.pipeline.table.value).length > 0);
    expect(Object.keys(env.pipeline.table.value).length).toBeGreaterThan(0);
    await flush();
    fireNewDebounces();
    await flush();

    // Exactly one layout ran, and exactly one was ever scheduled.
    expect(env.pending).toHaveLength(1);
    expect(env.calls.filter((c) => c.ms === 120)).toHaveLength(1);

    // Its label sizes are the real premeasure table's, for every label.
    const { input } = env.pending[0]!;
    const styled = env.pipeline.styled.value.value;
    const table = env.pipeline.table.value;
    const labelIds = Object.keys(styled.graph.labels).sort() as LabelId[];
    expect(labelIds.length).toBeGreaterThanOrEqual(3); // two node labels and the edge label.
    expect((Object.keys(input.labelSizes) as LabelId[]).sort()).toEqual(labelIds);
    for (const id of labelIds) {
      const measured = table[labelRunKey(styled, id)];
      expect(measured, `premeasure entry for ${id}`).toBeDefined();
      expect(input.labelSizes[id]).toEqual({ w: measured!.width, h: measured!.height });
      expect(input.labelSizes[id]!.w).toBeGreaterThan(0);
      expect(input.labelSizes[id]!.h).toBeGreaterThan(0);
    }
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** §13: "caught, **logged**, shown" — every boundary logs the original error
   *  object (stack intact), not a stringified copy. */
  function spyConsoleError() {
    return vi.spyOn(console, 'error').mockImplementation(() => {});
  }
  function loggedErrors(spy: ReturnType<typeof spyConsoleError>): unknown[] {
    return spy.mock.calls.map((args) => args[args.length - 1]);
  }

  it('a host.run() rejection other than AbortError is caught, not left unhandled, logged, and surfaces on the chip', async () => {
    const consoleError = spyConsoleError();
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    const layoutBefore = env.pipeline.layout.value;

    const parsedB = parse('a: "A"\nb: "B"');
    env.pipeline.setDocument(parsedB.tree, 'a: "A"\nb: "B"');
    await flush();
    env.fireLatest();
    await flush();

    const call = env.pending[env.pending.length - 1]!;
    const thrown = new Error('engine module failed to load');
    call.reject(thrown);
    await flush();

    expect(loggedErrors(consoleError)).toEqual([thrown]); // logged once, the original object.

    expect(env.pipeline.pipelineError.value?.message).toContain('engine module failed to load');
    expect(env.pipeline.pipelineError.value?.sourceHash).toBeTruthy();
    expect(env.pipeline.chip.value.kind).toBe('crashed');
    expect(env.pipeline.chip.value.message).toBe('Something went wrong rendering — your text is safe');
    // The last good layout is untouched — "the editor keeps working" (§13).
    expect(env.pipeline.layout.value).toBe(layoutBefore);
  });

  it('the crash clears once a later render succeeds', async () => {
    spyConsoleError();
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

  it.each([
    ['measurer.ready()', 'ready'],
    ['premeasure (the measurer itself)', 'layoutRuns'],
  ] as const)('the measure effect: a throw from %s is caught, logged and surfaced, not left as an unhandled rejection', async (_label, where) => {
    const consoleError = spyConsoleError();
    const thrown = new Error(`${where} failed`);
    const host: LayoutHost = { run: () => new Promise(() => {}), dispose: () => {} };
    const measurer = new TestMeasurer();
    const throwingMeasurer: AppMeasurer = {
      layoutRuns: (...args) => {
        if (where === 'layoutRuns') throw thrown;
        return measurer.layoutRuns(...args);
      },
      layoutRunsAsync: (...args) => measurer.layoutRunsAsync(...args),
      has: (...args) => measurer.has(...args),
      ready: () => {
        if (where === 'ready') throw thrown;
        return Promise.resolve();
      },
    };
    const pipeline = createPipeline({ measurer: throwingMeasurer, host, metrics: METRICS, defaultEngineId: 'sgl.grid' }, 'a: "A"');
    await flushUntil(() => pipeline.pipelineError.value !== null);
    expect(pipeline.pipelineError.value?.message).toBe(`${where} failed`);
    expect(pipeline.chip.value.kind).toBe('crashed');
    expect(loggedErrors(consoleError)).toEqual([thrown]);
    pipeline.dispose();
  });

  it('a throwing parse stage is caught and freezes the whole chain at last-good; the editor keeps working', async () => {
    const consoleError = spyConsoleError();
    let parseCalls = 0;
    const thrown = new Error('simulated parse invariant violation');
    // Call 1 is construction, call 2 the first edit (left to succeed, so there
    // is a real last-good snapshot), call 3 the second edit, which throws.
    const env = setup('a: "A"', {
      unsafeInjectStageThrow: (stage) => {
        if (stage !== 'parse') return;
        parseCalls += 1;
        if (parseCalls > 2) throw thrown;
      },
    });
    await completeOneLayout(env, 'a');

    env.pipeline.setDocument(parse('a: "A"\nb: "B"').tree, 'a: "A"\nb: "B"');
    await flush();

    const before = {
      parsed: env.pipeline.parsed.value,
      model: env.pipeline.model.value,
      graph: env.pipeline.graph.value,
      theme: env.pipeline.theme.value,
      styled: env.pipeline.styled.value,
      layout: env.pipeline.layout.value,
      lastGood: env.pipeline.lastGood.value,
    };
    expect(before.parsed.value.entries).toHaveLength(2); // really the post-edit state.

    expect(() => env.pipeline.setDocument(parse('a: "A"\nb: "B"\nc: "C"').tree, 'a: "A"\nb: "B"\nc: "C"')).not.toThrow();
    await flush();

    expect(env.pipeline.parsed.value).toBe(before.parsed);
    expect(env.pipeline.model.value).toBe(before.model);
    expect(env.pipeline.graph.value).toBe(before.graph);
    expect(env.pipeline.theme.value).toBe(before.theme);
    expect(env.pipeline.styled.value).toBe(before.styled);
    expect(env.pipeline.layout.value).toBe(before.layout);
    expect(env.pipeline.lastGood.value).toBe(before.lastGood); // "the last good render stays."
    expect(env.pipeline.pipelineError.value?.message).toBe('simulated parse invariant violation');
    expect(env.pipeline.chip.value.kind).toBe('crashed');
    expect(loggedErrors(consoleError)).toEqual([thrown]);
    // The editor keeps working: its text still reaches `source`…
    expect(env.pipeline.source.value).toBe('a: "A"\nb: "B"\nc: "C"');

    // …and once parsing stops throwing, the next edit recomputes the chain.
    parseCalls = Number.NEGATIVE_INFINITY;
    env.pipeline.setDocument(parse('a: "A"\nb: "B"\nc: "C"\nd: "D"').tree, 'a: "A"\nb: "B"\nc: "C"\nd: "D"');
    await flush();
    expect(env.pipeline.parsed.value.value.entries).toHaveLength(4);
    expect(env.pipeline.styled.value.value.graph.order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses a tree shorter than its text (F19): no render and no diagnostic from a parse cut short; the next whole tree recovers', async () => {
    const consoleError = spyConsoleError();
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    const before = { parsed: env.pipeline.parsed.value, diags: env.pipeline.diags.value, lastGood: env.pipeline.lastGood.value };

    // What an incremental parse that stopped early hands over: the tree of a
    // prefix of the text. Read as a document it would simply lack `c`.
    const text = 'a: "A"\nb: "B"\nc: "C"';
    const prefix = parse('a: "A"\nb: "B"').tree;
    expect(prefix.length).toBeLessThan(text.length);
    env.pipeline.setDocument(prefix, text);
    await flush();

    expect(env.pipeline.parsed.value).toBe(before.parsed);
    expect(env.pipeline.diags.value).toEqual(before.diags);
    expect(env.pipeline.lastGood.value).toBe(before.lastGood);
    expect(env.pipeline.pipelineError.value?.message).toBe("the editor's parse tree covers 13 of 20 characters (F19)");
    expect(env.pipeline.chip.value.kind).toBe('crashed');
    expect(loggedErrors(consoleError)).toHaveLength(1);

    env.pipeline.setDocument(parse(text).tree, text);
    await completeOneLayout(env, 'a');
    expect(env.pipeline.parsed.value.value.entries).toHaveLength(3);
    expect(env.pipeline.pipelineError.value).toBeNull();
  });

  it('a throwing compile stage freezes compile and everything below it, while parse and resolve keep updating; it recovers', async () => {
    const consoleError = spyConsoleError();
    let armed = false;
    const thrown = new Error('simulated compile invariant violation');
    const env = setup('a: "A"', {
      unsafeInjectStageThrow: (stage) => {
        if (armed && stage === 'compile') throw thrown;
      },
    });
    await completeOneLayout(env, 'a');
    const modelBefore = env.pipeline.model.value;
    const graphBefore = env.pipeline.graph.value;
    const styledBefore = env.pipeline.styled.value;
    const lastGoodBefore = env.pipeline.lastGood.value;
    const requestsBefore = env.pending.length;

    armed = true;
    env.pipeline.setDocument(parse('a: "A"\nb: "B"').tree, 'a: "A"\nb: "B"');
    await flush();

    // Upstream of the throw: fresh.
    expect(env.pipeline.parsed.value.value.entries).toHaveLength(2);
    expect(env.pipeline.model.value).not.toBe(modelBefore);
    // The throwing stage and everything downstream: frozen at last-good.
    expect(env.pipeline.graph.value).toBe(graphBefore);
    expect(env.pipeline.styled.value).toBe(styledBefore);
    expect(env.pipeline.lastGood.value).toBe(lastGoodBefore);
    env.fireLatest();
    await flush();
    expect(env.pending).toHaveLength(requestsBefore); // no layout for a frozen graph.
    expect(env.pipeline.pipelineError.value?.message).toBe('simulated compile invariant violation');
    expect(env.pipeline.chip.value.kind).toBe('crashed');

    // An unrelated recompute (a theme switch) re-runs the reporting effect but
    // does not log the same live error a second time.
    env.pipeline.themeId.value = 'neutral-dark';
    await flush();
    expect(loggedErrors(consoleError)).toEqual([thrown]);

    // Recovery: the next edit compiles, lays out and renders cleanly.
    armed = false;
    env.pipeline.setDocument(parse('a: "A"\nb: "B"\nc: "C"').tree, 'a: "A"\nb: "B"\nc: "C"');
    await flush();
    expect(env.pipeline.graph.value.graph.order).toContain('c');
    await completeOneLayout(env, 'c');
    expect(env.pipeline.pipelineError.value).toBeNull();
    expect(env.pipeline.chip.value.kind).not.toBe('crashed');
    expect(env.pipeline.lastGood.value).not.toBe(lastGoodBefore);
  });

  it('a stage that throws on the very first (boot) pass still constructs the pipeline, surfaces the error, and recovers', async () => {
    const consoleError = spyConsoleError();
    let armed = true;
    const thrown = new Error('simulated styleGraph invariant violation');
    let env: ReturnType<typeof setup> | undefined;
    expect(() => {
      env = setup('a: "A"', {
        unsafeInjectStageThrow: (stage) => {
          if (armed && stage === 'styleGraph') throw thrown;
        },
      });
    }).not.toThrow();
    const e = env!;
    // No last-good value exists yet, so `styled` falls back to the empty
    // document's styling rather than throwing out of the computed.
    expect(e.pipeline.styled.value.value.graph.order).toEqual([]);
    expect(e.pipeline.pipelineError.value?.message).toBe('simulated styleGraph invariant violation');
    expect(e.pipeline.chip.value.kind).toBe('crashed');
    expect(loggedErrors(consoleError)).toEqual([thrown]);

    armed = false;
    e.pipeline.setDocument(parse('a: "A"\nb: "B"').tree, 'a: "A"\nb: "B"');
    await flush();
    expect(e.pipeline.styled.value.value.graph.order).toEqual(['a', 'b']);
    await completeOneLayout(e, 'a');
    expect(e.pipeline.lastGood.value).not.toBeNull();
    expect(e.pipeline.pipelineError.value).toBeNull();
  });

  it('a throwing render() is caught, logged, and keeps the last good render', async () => {
    const consoleError = spyConsoleError();
    let armed = false;
    const thrown = new Error('simulated render invariant violation');
    const env = setup('a: "A"', {
      unsafeInjectStageThrow: (stage) => {
        if (armed && stage === 'render') throw thrown;
      },
    });
    await completeOneLayout(env, 'a');
    const lastGoodBefore = env.pipeline.lastGood.value;
    expect(lastGoodBefore).not.toBeNull();

    armed = true;
    env.pipeline.setDocument(parse('a: "A"\nb: "B"').tree, 'a: "A"\nb: "B"');
    await flush();
    await completeOneLayout(env, 'b');

    expect(env.pipeline.lastGood.value).toBe(lastGoodBefore);
    expect(env.pipeline.pipelineError.value?.message).toBe('simulated render invariant violation');
    expect(loggedErrors(consoleError)).toEqual([thrown]);
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
