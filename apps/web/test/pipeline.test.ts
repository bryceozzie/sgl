import { readFileSync } from 'node:fs';
import { effect } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asNodeId, diagnostic, NO_SPAN, parse, type Diagnostic, type LabelId } from '@sgl/core';
import type { LayoutEngine, LayoutHost, LayoutInput, LayoutPlan, LayoutResult, ResolvedThemeMetricsView } from '@sgl/layout-api';
import { gridEngine } from '@sgl/layout-std';
import { elkEngine } from '@sgl/layout-elk';
import { runHostSequence } from '@sgl/layout-api/conformance';
import type { StageResult } from '@sgl/core';
import { labelRunKey, StaticMetricsMeasurer } from '@sgl/measure';
import { DEFAULT_THEME_ID } from '@sgl/theme';
import { REGISTERED_ENGINES, registeredEngine } from '../src/io/app-boot.js';
import { createImportsRuntime } from '../src/state/imports.js';
import { createPipeline } from '../src/state/pipeline.js';
import { createMemoryStore, type DocumentRecord, type DocumentStore } from '../src/state/storage.js';
import type { AppMeasurer, Cancel, ImportsRuntime, Schedule } from '../src/state/types.js';
import { createHarness, type Harness } from './harness.js';

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
  /** The plan, when `run()` was given one (DD-14 C25). */
  readonly plan?: LayoutPlan;
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
    run(engineId, input, engineOptions, _metrics, _table, signal, plan) {
      return new Promise<StageResult<LayoutResult | null>>((resolve, reject) => {
        pending.push({ engineId, input, options: engineOptions, ...(plan !== undefined && { plan }), signal, resolve, reject });
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
  it('warns SGL4010 for an undeclared @layout key on a boundary, and SGL4012 for a container engine that is not registered (DD-14 C11, C12)', async () => {
    const source = 'box: {\n  @layout: { engine: sgl.elk, columns: 2, gap: 4 }\n  a: "A"\n}\n';
    const env = setup(source, {
      engineSchemas: (id) => (id === 'sgl.grid' ? { id, optionsSchema: { properties: { columns: {}, gap: {}, align: {} } } } : undefined),
    });
    await completeOneLayout(env, 'box');
    // `sgl.elk` is not registered here: SGL4012, and `box`'s keys are hints
    // for grid, which has none.
    expect(env.pipeline.diags.value.map((d) => [d.code, source.slice(d.span.from, d.span.to), d.severity])).toEqual([
      ['SGL4010', 'columns', 'warning'],
      ['SGL4010', 'gap', 'warning'],
      ['SGL4012', 'engine', 'warning'],
    ]);
    expect(env.pending.at(-1)!.plan).toBeUndefined();

    // Under an engine that does not declare `columns`/`gap`, the boundary's own engine's options are what count.
    const source2 = source.replace('sgl.elk', 'sgl.grid');
    const env2 = setup(source2, {
      defaultEngineId: 'sgl.elk',
      engineSchemas: (id) =>
        id === 'sgl.elk' ? { id, optionsSchema: { properties: { direction: {} } } } : id === 'sgl.grid' ? { id, optionsSchema: { properties: { columns: {} } } } : undefined,
    });
    await flush();
    expect(env2.pipeline.diags.value.map((d) => [d.code, source2.slice(d.span.from, d.span.to), d.message])).toEqual([
      ['SGL4010', 'gap', '`@layout.gap` is not an option of engine `sgl.grid`; ignored.'],
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

  describe('root @layout options reach the engine (DD-12 H6)', () => {
    const engineSchemas = (id: string) => REGISTERED_ENGINES.find((e) => e.id === id);

    it("override the form's bag key by key, for this document only; the stored bag is left alone", async () => {
      const source = '@layout: { engine: elk, direction: right, rankSpacing: 20 }\na: "A"\n';
      const env = setup(source, { engineSchemas });
      env.pipeline.engineOptions.value = { direction: 'down', nodeSpacing: 12, rankSpacing: 90 };
      await completeOneLayout(env, 'a');
      expect(env.pending.at(-1)!.engineId).toBe('sgl.elk');
      expect(env.pending.at(-1)!.options).toEqual({ direction: 'right', nodeSpacing: 12, rankSpacing: 20, edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF' });
      expect(env.pipeline.documentOptions.value).toEqual({ direction: 'right', rankSpacing: 20 });
      expect(env.pipeline.engineOptions.value).toEqual({ direction: 'down', nodeSpacing: 12, rankSpacing: 90 });
      expect(env.pipeline.diags.value).toEqual([]);

      // Without them, the form's bag applies again.
      const plain = '@layout: { engine: elk }\na: "A"\n';
      env.pipeline.setDocument(parse(plain).tree, plain);
      await completeOneLayout(env, 'a');
      expect(env.pending.at(-1)!.options).toEqual({ direction: 'down', nodeSpacing: 12, rankSpacing: 90, edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF' });
      expect(env.pipeline.documentOptions.value).toEqual({});
    });

    it('under the editor\'s engine too, and `@direction` sugar counts', async () => {
      const source = '@direction: left\n@layout.columns: 3\na: "A"\n';
      const env = setup(source, { engineSchemas, defaultEngineId: 'sgl.grid' });
      await completeOneLayout(env, 'a');
      // `direction` is not grid's (SGL4010, ignored); `columns` is.
      expect(env.pending.at(-1)!.options).toEqual({ columns: 3, gap: 24, align: 'center' });
      expect(env.pipeline.diags.value.map((d) => [d.code, source.slice(d.span.from, d.span.to)])).toEqual([['SGL4010', '@direction']]);
    });

    it('reach tree too (feat/b5-tree): direction and edgeRouting from the document; an elk-only value is SGL2011', async () => {
      const source = '@layout: { engine: tree, direction: right, edgeRouting: straight, nodePlacement: LINEAR_SEGMENTS }\na: "A"\n';
      const env = setup(source, { engineSchemas });
      await completeOneLayout(env, 'a');
      expect(env.pending.at(-1)!.engineId).toBe('sgl.tree');
      expect(env.pending.at(-1)!.options).toEqual({ direction: 'right', nodeSpacing: 40, rankSpacing: 70, edgeRouting: 'straight' });
      expect(env.pipeline.diags.value.map((d) => [d.code, source.slice(d.span.from, d.span.to)])).toEqual([['SGL4010', 'nodePlacement']]);

      const bad = '@layout: { engine: tree, edgeRouting: ORTHOGONAL }\na: "A"\n';
      env.pipeline.setDocument(parse(bad).tree, bad);
      await completeOneLayout(env, 'a');
      expect(env.pending.at(-1)!.options).toEqual({ direction: 'down', nodeSpacing: 40, rankSpacing: 70, edgeRouting: 'orthogonal' });
      expect(env.pipeline.diags.value.map((d) => [d.code, bad.slice(d.span.from, d.span.to)])).toEqual([['SGL2011', 'edgeRouting']]);
    });

    it('an undeclared key is SGL4010 and an invalid value SGL2011, each at its key; neither is sent', async () => {
      const source = '@layout: { engine: elk, columns: 2, nodeSpacing: 900, direction: sideways }\na: "A"\n';
      const env = setup(source, { engineSchemas });
      await completeOneLayout(env, 'a');
      expect(env.pending.at(-1)!.options).toEqual({ direction: 'down', nodeSpacing: 40, rankSpacing: 70, edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF' });
      expect(env.pipeline.documentOptions.value).toEqual({});
      expect(env.pipeline.diags.value.map((d) => [d.code, source.slice(d.span.from, d.span.to)]).sort()).toEqual([
        ['SGL2011', 'direction'],
        ['SGL2011', 'nodeSpacing'],
        ['SGL4010', 'columns'],
      ]);
    });
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

  it('a theme-only change skips layout and repaints the same element tree (F9 P3)', async () => {
    const env = setup('a: "A"');
    await completeOneLayout(env, 'a');
    expect(env.pending.length).toBe(1);

    const layoutBefore = env.pipeline.layout.value;
    const geometryHashBefore = env.pipeline.styled.value.value.geometryHash;
    const svgBefore = env.pipeline.lastGood.value?.svg;
    const planBefore = env.pipeline.lastGood.value?.paintPlan;

    env.pipeline.themeId.value = 'neutral-dark';
    await flush();
    env.fireLatest();
    await flush();

    // Geometry is unchanged between the two built-in themes; no second host.run().
    expect(env.pipeline.styled.value.value.geometryHash).toBe(geometryHashBefore);
    expect(env.pending.length).toBe(1);
    expect(env.pipeline.layout.value).toBe(layoutBefore);

    // The paint changes, as a new `<style>` text over the same element tree
    // (`paintPlan`, DD-07 §11; `theme-fast-path.test.ts` has the rest), so
    // lastGood picks up the new theme's paint.
    expect(env.pipeline.lastGood.value?.svg).not.toBe(svgBefore);
    expect(env.pipeline.lastGood.value?.paintPlan).toBe(planBefore);
    expect(env.pipeline.lastGood.value?.styled.themeId).toBe('neutral-dark');
  });

  it('a label text edit lays out again; undoing it while that layout is out keeps the landed one and drops the other (fix round 1, item 1)', async () => {
    const env = setup('a: "short"');
    // The latest live debounce only (`fireByMs` would re-run fired ones too).
    const fireDebounce = (): void => [...env.calls].reverse().find((c) => !c.cancelled && c.ms === 120)?.fn();
    await completeOneLayout(env, 'a');
    expect(env.pending).toHaveLength(1);
    const landed = env.pipeline.layout.value;

    // Same geometryHash, a longer label: a new request (the old skip made none).
    const tableShort = env.pipeline.table.value;
    env.pipeline.setDocument(parse('a: "a much longer label"').tree, 'a: "a much longer label"');
    await flushUntil(() => env.pipeline.table.value !== tableShort);
    fireDebounce();
    await flush();
    expect(env.pending).toHaveLength(2);
    const longer = env.pending[1]!;
    expect(env.pipeline.inFlight.value).toBe(true);

    // Undo before it answers: the input is the landed one's again, so no new
    // request, and the one in flight is aborted and can never land.
    const tableBefore = env.pipeline.table.value;
    env.pipeline.setDocument(parse('a: "short"').tree, 'a: "short"');
    await flushUntil(() => env.pipeline.table.value !== tableBefore);
    fireDebounce();
    await flush();
    expect(env.pending).toHaveLength(2);
    expect(longer.signal.aborted).toBe(true);
    expect(env.pipeline.inFlight.value).toBe(false);
    longer.resolve({ value: fakeLayoutResult('a', 999, 60), diagnostics: [] });
    await flush();
    expect(env.pipeline.layout.value).toBe(landed);
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

describe('container engines (DD-14, B8 branch 2)', () => {
  const engineSchemas = (id: string) => REGISTERED_ENGINES.find((e) => e.id === id);
  const SPEC_9 = '@layout: { engine: elk, direction: right }\npayments: {\n  @label: "Payments"\n  @layout: { engine: grid, columns: 2 }\n  api\n  ledger\n  outbox\n}\npsp\npayments.api -> psp\n';

  it("spec §9: no diagnostics, and the plan reaches run() beside the root's engine and options", async () => {
    const env = setup(SPEC_9, { engineSchemas });
    await completeOneLayout(env, 'payments');
    expect(env.pipeline.diags.value).toEqual([]);
    const call = env.pending.at(-1)!;
    expect(call.engineId).toBe('sgl.elk');
    expect(call.options).toMatchObject({ direction: 'right' });
    expect(call.plan!.map((s) => [s.node, s.engine, s.options, SPEC_9.slice(s.span!.from, s.span!.to)])).toEqual([
      ['payments', 'sgl.grid', { align: 'center', columns: 2, gap: 24 }, 'engine'],
    ]);
  });

  it('spec §9 itself, through the real engines: no warning, only the two SGL3006 infos for `cloud`; `payments` is a two-column grid (F29 cleared)', async () => {
    const spec = readFileSync(new URL('../../../docs/02-language-spec.md', import.meta.url), 'utf8');
    const example = /## 9\. Worked example\n\n```sgl\n([\s\S]*?)```/.exec(spec)![1]!;
    const corpus = readFileSync(new URL('../../../corpus/checkout.sgl', import.meta.url), 'utf8');
    // `corpus/checkout.sgl` is the example, after its one comment line.
    expect(corpus.slice(corpus.indexOf('\n') + 1)).toBe(example);
    // Load elkjs first: its first import can outlast the harness's settle on a busy machine.
    const empty = { nodes: {}, edges: [], rootChildren: [], order: [], labels: {}, meta: { nodeCount: 0, edgeCount: 0, containerCount: 0 } };
    await runHostSequence(elkEngine, { graph: empty, scope: null, sizing: {}, labelSizes: {} }, {}, METRICS);
    const h = await createHarness(example, { engineSchemas, defaultEngineId: 'sgl.elk' });
    try {
      // `cloud` is a shape name this version does not draw (SGL3006, info;
      // corpus/README.md), not a layout matter: nothing else, and no warning.
      expect(h.pipeline.diags.value.map((d) => [d.code, d.severity])).toEqual([
        ['SGL3006', 'info'],
        ['SGL3006', 'info'],
      ]);
      const layout = h.pipeline.lastGood.value!.layout;
      const f = (id: string) => layout.nodes[asNodeId(id)]!.frame;
      expect(f('payments.ledger').y + f('payments.ledger').h / 2).toBeCloseTo(f('payments.api').y + f('payments.api').h / 2, 1);
      expect(f('payments.ledger').x).toBeGreaterThan(f('payments.api').x + f('payments.api').w);
      expect(f('payments.outbox').y).toBeGreaterThan(f('payments.api').y + f('payments.api').h);
      expect(f('payments.outbox').x + f('payments.outbox').w / 2).toBe(f('payments.api').x + f('payments.api').w / 2);
    } finally {
      h.dispose();
    }
  });

  it("a boundary using the root's engine inherits the toolbar's options (C6, C7)", async () => {
    const source = 'row: {\n  @layout: { engine: elk, direction: right }\n  a\n  b\n}\n';
    const env = setup(source, { engineSchemas, defaultEngineId: 'sgl.elk' });
    env.pipeline.engineOptions.value = { nodeSpacing: 12 };
    await completeOneLayout(env, 'row');
    expect(env.pending.at(-1)!.plan![0]!.options).toEqual({ direction: 'right', edgeRouting: 'ORTHOGONAL', nodePlacement: 'BRANDES_KOEPF', nodeSpacing: 12, rankSpacing: 70 });
  });

  it("a document without a container engine gives run() no plan", async () => {
    const env = setup('box: {\n  a\n}\n', { engineSchemas });
    await completeOneLayout(env, 'box');
    expect(env.pending.at(-1)!.plan).toBeUndefined();
  });

  it("the skip key includes the plan (C43): a container's engine or option lays out again; the same plan does not", async () => {
    const env = setup(SPEC_9, { engineSchemas });
    await completeOneLayout(env, 'payments');
    const requests = env.pending.length;
    const other = SPEC_9.replace('columns: 2', 'columns: 3');
    env.pipeline.setDocument(parse(other).tree, other);
    await completeOneLayout(env, 'payments');
    expect(env.pending.length).toBe(requests + 1);
    expect(env.pending.at(-1)!.plan![0]!.options['columns']).toBe(3);
    const fixedBox = other.replace('engine: grid, columns: 3', 'engine: fixed');
    env.pipeline.setDocument(parse(fixedBox).tree, fixedBox);
    await completeOneLayout(env, 'payments');
    expect(env.pending.at(-1)!.plan![0]!.engine).toBe('sgl.fixed');
    // Moving text without changing the plan or the input: no new request.
    const moved = `// a comment\n${fixedBox}`;
    const before = env.pending.length;
    env.pipeline.setDocument(parse(moved).tree, moved);
    await flushUntil(() => env.calls.some((c) => !c.cancelled));
    env.fireLatest();
    await flush();
    expect(env.pending.length).toBe(before);
  });

  it('SGL4012 for an engine that is not available, and C9\'s SGL4010 for a plain container\'s option, each at its key', () => {
    const source = 'a: {\n  @layout.engine: dagre\n  x\n}\nb: {\n  @direction: right\n  y\n}\n';
    const env = setup(source, { engineSchemas, defaultEngineId: 'sgl.elk' });
    expect(env.pipeline.diags.value.map((d) => [d.code, source.slice(d.span.from, d.span.to), d.message])).toEqual([
      ['SGL4010', '@direction', '`@layout.direction` is not an option of engine `sgl.elk`; ignored.'],
      ['SGL4012', '@layout.engine', 'Layout engine `dagre` is not available; `a` is laid out by `sgl.elk`.'],
    ]);
  });

  it('SGL4013 from an engine that fails on a box, through the host, at its `engine` key (C28)', async () => {
    const broken: LayoutEngine = {
      ...gridEngine,
      id: 'test.broken',
      name: 'Broken',
      layout: () => Promise.reject(new Error('boom')),
    };
    const schemas = (id: string) => (id === broken.id ? registeredEngine(broken) : engineSchemas(id));
    const source = '@layout.engine: grid\nbox: {\n  @layout.engine: "test.broken"\n  a\n  b\n}\n';
    const h = await createHarness(source, { engineSchemas: schemas }, { engines: [broken] });
    try {
      expect(h.pipeline.diags.value.map((d) => [d.code, source.slice(d.span.from, d.span.to), d.message])).toEqual([
        ['SGL4013', '@layout.engine', 'Layout engine `test.broken` failed for `box` (boom); it is laid out by `sgl.grid` instead.'],
      ]);
      expect(h.pipeline.lastGood.value!.layout.nodes[asNodeId('box.a')]).toBeDefined();
    } finally {
      h.dispose();
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

  // F31 (human decision 2026-09-27): an unknown name is SGL5007 at the key,
  // and the document still draws in the default theme, whatever the picker.
  it('an unknown document @theme warns SGL5007 at the key and still draws in the default theme', () => {
    const source = 'a: "A"\n@theme: "neutral-drak"\n';
    const env = setup(source);
    env.pipeline.themeId.value = 'neutral-dark'; // the picker's preference does not rescue a typo
    expect(env.pipeline.diags.value.map((d) => [d.code, d.severity, d.message, source.slice(d.span.from, d.span.to)])).toEqual([
      ['SGL5007', 'warning', 'Unknown theme `neutral-drak`; using the default.', '@theme'],
    ]);
    expect(env.pipeline.theme.value.value.id).toBe(DEFAULT_THEME_ID);

    // Fixing the typo clears it.
    const fixed = 'a: "A"\n@theme: "neutral-dark"\n';
    env.pipeline.setDocument(parse(fixed).tree, fixed);
    expect(env.pipeline.diags.value).toEqual([]);
    expect(env.pipeline.theme.value.value.id).toBe('neutral-dark');
  });

  // What the warning says must be so: a name that is only an Object property
  // drew a malformed theme (no id, an SGL5004) instead of the default.
  it.each(['constructor', 'toString', '__proto__'])('@theme: "%s" is unknown too: SGL5007 alone, and the default theme', (name) => {
    const env = setup(`@theme: "${name}"\na: "A"`);
    expect(env.pipeline.diags.value.map((d) => d.code)).toEqual(['SGL5007']);
    expect(env.pipeline.theme.value.value.id).toBe(DEFAULT_THEME_ID);
  });

  it.each([
    ['a known @theme', '@theme: "print"\na: "A"'],
    ['no @theme', 'a: "A"'],
  ])('%s: no SGL5007', (_, source) => {
    expect(setup(source).pipeline.diags.value).toEqual([]);
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

  // DD-12 N22 (orchestrator's bug fix): with the app's real registered
  // engines, a bare name reaches the host as the full id; before, `grid` went
  // to the worker as `grid` and came back SGL4011 with no layout.
  const registered = { engineSchemas: (id: string) => REGISTERED_ENGINES.find((e) => e.id === id) };

  it.each([
    ['@layout: { engine: grid }', 'sgl.grid'],
    ['@layout.engine: "elk"', 'sgl.elk'],
  ])('a bare engine name (%s) reaches the host as %s', async (config, id) => {
    const env = setup(`${config}\na: "A"`, { ...registered, defaultEngineId: id === 'sgl.grid' ? 'sgl.elk' : 'sgl.grid' });
    expect(env.pipeline.effectiveEngineId.value).toBe(id);
    await completeOneLayout(env, 'a');
    expect(env.pending.at(-1)!.engineId).toBe(id);
  });

  it('an empty `engine` is not set: the editor\'s engine lays out, with one SGL2011 at the key (fix round 1, item 8)', async () => {
    const source = '@layout: { engine: "" }\nbox: {\n  @layout.engine: ""\n  a: "A"\n}\n';
    const env = setup(source, { ...registered, defaultEngineId: 'sgl.grid' });
    expect(env.pipeline.documentEngineId.value).toBeUndefined();
    expect(env.pipeline.effectiveEngineId.value).toBe('sgl.grid');
    expect(env.pipeline.diags.value.map((d) => [d.code, source.slice(d.span.from, d.span.to)])).toEqual([
      ['SGL2011', '@layout'],
      ['SGL2011', '@layout.engine'],
    ]);
    await completeOneLayout(env, 'box');
    expect(env.pending.at(-1)!.engineId).toBe('sgl.grid');
  });

  it('an unknown bare name reaches the host unchanged, as an unknown id does (`layered` is not `elk`, H7)', async () => {
    const env = setup('@layout: { engine: "layered" }\na: "A"', registered);
    await completeOneLayout(env, 'a');
    expect(env.pending.at(-1)!.engineId).toBe('layered');
  });
});

describe('@pin under the registered engines (DD-12 N6, H4)', () => {
  const registered = { engineSchemas: (id: string) => REGISTERED_ENGINES.find((e) => e.id === id) };

  it('fixed is registered and honours pins: no SGL4021 under it, by id or bare name (feat/b5-fixed)', () => {
    expect(REGISTERED_ENGINES.find((e) => e.id === 'sgl.fixed')?.pins).toBe(true);
    const env = setup('a: { @pin: { x: 10, y: 20 } }\nb: "B"\n', { ...registered, defaultEngineId: 'sgl.fixed' });
    expect(env.pipeline.diags.value).toEqual([]);
    const bare = setup('@layout: { engine: fixed }\na: { @pin: { x: 10, y: 20 } }\n', { ...registered, defaultEngineId: 'sgl.elk' });
    expect(bare.pipeline.effectiveEngineId.value).toBe('sgl.fixed');
    expect(bare.pipeline.diags.value).toEqual([]);
  });

  it('tree is registered, by id and bare name, with its hints: a container @direction and @layout.root are not SGL4010 (feat/b5-tree)', () => {
    const tree = REGISTERED_ENGINES.find((e) => e.id === 'sgl.tree');
    expect(tree).toMatchObject({ id: 'sgl.tree', name: 'Tree', determinism: 'bitwise' });
    expect(tree?.pins).toBeUndefined();
    const source = '@layout: { engine: tree }\nbox: {\n  @direction: right\n  a\n}\nr: { @layout: { root: true } }\n';
    const env = setup(source, { ...registered, defaultEngineId: 'sgl.elk' });
    expect(env.pipeline.effectiveEngineId.value).toBe('sgl.tree');
    expect(env.pipeline.diags.value).toEqual([]);
    // Tree does not honour pins (DD-12 N39): SGL4021, as under elk and grid.
    const pinned = setup('@layout: { engine: tree }\na: { @pin: { x: 1, y: 2 } }\n', { ...registered, defaultEngineId: 'sgl.elk' });
    expect(pinned.pipeline.diags.value.map((d) => d.code)).toEqual(['SGL4021']);
  });

  it.each(['sgl.grid', 'sgl.elk'])('neither grid nor elk honours pins: SGL4021 at the key under %s', (id) => {
    const source = 'a: { @pin: { x: 10, y: 20 } }\nb: "B"\n';
    const env = setup(source, { ...registered, defaultEngineId: id });
    const warnings = env.pipeline.diags.value.filter((d) => d.code === 'SGL4021');
    expect(warnings.map((d) => [source.slice(d.span.from, d.span.to), d.message])).toEqual([['@pin', `\`@pin\` is not honoured by engine \`${id}\`; ignored.`]]);
    // The resolver accepted it: no SGL2010 ("unknown key") any more.
    expect(env.pipeline.diags.value.map((d) => d.code)).toEqual(['SGL4021']);
  });

  // Fix round 1, item 5 (mutation M9): a `pins: true` engine, listed through
  // the same mapping REGISTERED_ENGINES uses, silences SGL4021.
  it('an engine whose capabilities declare pins is not warned about', () => {
    const capabilities = { containers: true, edgeRouting: 'straight', ports: false, labelPlacement: false, incremental: false, determinism: 'bitwise' } as const;
    const stub = registeredEngine({ id: 'test.pinning', name: 'Pinning', capabilities: { ...capabilities, pins: true } });
    expect(stub.pins).toBe(true);
    const source = 'a: { @pin: { x: 10, y: 20 } }\n';
    const env = setup(source, { defaultEngineId: 'test.pinning', engineSchemas: (id) => (id === stub.id ? stub : undefined) });
    expect(env.pipeline.diags.value).toEqual([]);
    // The control: the same stub without pins warns.
    const plain = registeredEngine({ id: 'test.pinning', name: 'Pinning', capabilities });
    const env2 = setup(source, { defaultEngineId: 'test.pinning', engineSchemas: (id) => (id === plain.id ? plain : undefined) });
    expect(env2.pipeline.diags.value.map((d) => d.code)).toEqual(['SGL4021']);
  });

  it('the pin reaches the layout input unchanged, relative to its parent (H2)', async () => {
    const env = setup('box: {\n  @pin: { x: 5, y: 6 }\n  a: { @pin: { x: -1, y: 2.5 } }\n}\n', registered);
    await completeOneLayout(env, 'box');
    const { graph } = env.pending.at(-1)!.input;
    expect(graph.nodes[asNodeId('box')]!.config.pin).toEqual({ x: 5, y: 6 });
    expect(graph.nodes[asNodeId('box.a')]!.config.pin).toEqual({ x: -1, y: 2.5 });
  });

  it('a malformed pin is reported once, by the resolver (SGL2011), not again as SGL4021 (fix round 1, item 6)', () => {
    const env = setup('a: { @pin: { x: 1 } }\nb: { @pin: { x: 1, y: 2 } }\n', registered);
    expect(env.pipeline.diags.value.map((d) => d.code).sort()).toEqual(['SGL2011', 'SGL4021']);
  });

  it('a malformed pin never reaches the layout input', async () => {
    const env = setup('a: { @pin: { x: 1 } }\n', registered);
    await completeOneLayout(env, 'a');
    expect(env.pending.at(-1)!.input.graph.nodes[asNodeId('a')]!.config.pin).toBeUndefined();
  });

  it("an engine's warning from the host reaches the document's diagnostics beside a landed layout (DD-12 N20, the app half)", async () => {
    const env = setup('a: "A"');
    await flushUntil(() => env.calls.some((c) => !c.cancelled));
    env.fireLatest();
    await flush();
    const note = diagnostic('SGL4021', { from: 0, to: 1 }, { id: 'sgl.grid' });
    env.pending.at(-1)!.resolve({ value: fakeLayoutResult('a'), diagnostics: [note] });
    await flush();
    expect(env.pipeline.layout.value).not.toBeNull();
    expect(env.pipeline.diags.value).toContainEqual(note);
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

describe('imports (A9, DD-08 §15: I24, I25)', () => {
  const LIB = '@title: "lib"\n@classes: { Svc: { @shape: diamond } }\n';
  const MAIN = '@imports: ["./lib.sgl"]\napi: Svc\n';
  const record = (id: string, source: string, updatedAt = 1): DocumentRecord => ({
    id,
    title: id,
    source,
    engineId: 'sgl.grid',
    engineOptions: {},
    themeId: 'neutral-light',
    createdAt: 1,
    updatedAt,
  });

  /** The real runtime over a memory store, its resolves counted, loaded
   *  when the test says so. */
  function lazyRuntime(store: DocumentStore) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counts = { loads: 0, resolves: 0 };
    const loadImports = vi.fn(async (): Promise<ImportsRuntime> => {
      counts.loads += 1;
      await gate;
      const runtime = await createImportsRuntime(store, undefined);
      return {
        ...runtime,
        resolve(ast, self) {
          counts.resolves += 1;
          return runtime.resolve(ast, self);
        },
      };
    });
    return { loadImports, counts, release };
  }

  const shapeOf = (h: Harness, id: string): string | undefined => h.pipeline.lastGood.value?.styled.graph.nodes[asNodeId(id)]?.shape;

  it('a document with @imports holds its first resolve until the imports are loaded, and never adopts a render without them (I25)', async () => {
    const store = createMemoryStore({ documents: [record('lib', LIB), record('main', MAIN)] });
    const lazy = lazyRuntime(store);
    const h = await createHarness(MAIN, { loadImports: lazy.loadImports }, { firstRender: false });
    // Every render the canvas is ever given.
    const adopted: (string | undefined)[] = [];
    const stop = effect(() => {
      const good = h.pipeline.lastGood.value;
      if (good !== null) adopted.push(good.styled.graph.nodes[asNodeId('api')]?.shape);
    });
    h.pipeline.docId.value = 'main';
    await h.settle();
    expect(lazy.counts.loads).toBe(1);
    expect(h.pipeline.lastGood.value).toBeNull();
    expect(h.pipeline.diags.value).toEqual([]);
    expect(h.pipeline.held.value).toBe(true);
    expect(h.pipeline.pipelineError.value).toBeNull();

    lazy.release();
    await h.settle();
    expect(h.pipeline.held.value).toBe(false);
    expect(h.pipeline.diags.value).toEqual([]);
    expect(shapeOf(h, 'api')).toBe('diamond');
    expect(adopted.length).toBeGreaterThan(0);
    expect(adopted.every((shape) => shape === 'diamond')).toBe(true);
    stop();
    h.dispose();
  });

  it('a document without @imports never loads them', async () => {
    const lazy = lazyRuntime(createMemoryStore());
    const h = await createHarness('a\nb\na -> b\n', { loadImports: lazy.loadImports });
    h.setSource('a\nb\nc\na -> b -> c\n');
    await h.settle();
    expect(lazy.loadImports).not.toHaveBeenCalled();
    h.dispose();
  });

  it('writing an imported document re-resolves the importer; its own autosave does not (I24)', async () => {
    const store = createMemoryStore({ documents: [record('lib', LIB), record('main', MAIN)] });
    const lazy = lazyRuntime(store);
    lazy.release();
    const h = await createHarness(MAIN, { loadImports: lazy.loadImports }, { firstRender: false });
    h.pipeline.docId.value = 'main';
    await h.settle();
    expect(shapeOf(h, 'api')).toBe('diamond');

    const before = lazy.counts.resolves;
    await store.putDocument(record('main', MAIN, 2));
    await store.putDocument(record('main', MAIN, 3));
    expect(lazy.counts.resolves).toBe(before);

    await store.putDocument(record('lib', LIB.replace('diamond', 'hexagon'), 2));
    expect(lazy.counts.resolves).toBe(before + 1);
    await h.settle();
    expect(shapeOf(h, 'api')).toBe('hexagon');
    h.dispose();
  });

  it('an unresolved import is a warning, and the rest renders (I17)', async () => {
    const store = createMemoryStore({ documents: [record('main', MAIN)] });
    const lazy = lazyRuntime(store);
    lazy.release();
    const h = await createHarness('@imports: ["./nope.sgl"]\napi\n', { loadImports: lazy.loadImports }, { firstRender: false });
    h.pipeline.docId.value = 'main';
    await h.settle();
    expect(h.pipeline.diags.value.map((d) => `${d.code} ${d.severity}`)).toEqual(['SGL2017 warning']);
    expect(h.pipeline.lastGood.value).not.toBeNull();
    h.dispose();
  });

  it('if the imports cannot be loaded: one SGL2027 warning, no errors, the picture adopted; retried on the next change, not in a loop (I17; fix round 1, item 4)', async () => {
    const KIT = '@vars: { tier: "prod" }\n@classes: { K: {} }\nx\n';
    const store = createMemoryStore({ documents: [record('lib', LIB), record('kit', KIT), record('main', MAIN)] });
    let attempts = 0;
    const loadImports = vi.fn(async (): Promise<ImportsRuntime> => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline, and not cached');
      return createImportsRuntime(store, undefined);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // An imported class, an imported variable and an edge into a namespace:
    // without the chunk, none of them may be an error.
    const source = '@imports: ["./lib.sgl", { path: "./kit.sgl", as: kit }]\napi: Svc\nl: kit.K\ndb: { @label: $kit.tier }\napi -> kit.x\n';
    const h = await createHarness(source, { loadImports }, { firstRender: false });
    h.pipeline.docId.value = 'main';
    await h.settle();
    expect(h.pipeline.held.value).toBe(false);
    expect(h.pipeline.diags.value.map((d) => `${d.code} ${d.severity}`)).toEqual(['SGL2027 warning']);
    expect(h.pipeline.lastGood.value).not.toBeNull();
    await h.settle();
    expect(attempts).toBe(1); // no retry without a change

    h.setSource(`${source}more\n`);
    await h.settle();
    expect(attempts).toBe(2);
    await h.settle();
    expect(h.pipeline.diags.value).toEqual([]);
    expect(shapeOf(h, 'api')).toBe('diamond');
    h.dispose();
  });
});
