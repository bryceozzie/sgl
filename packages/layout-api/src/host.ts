import { LAYOUT_CATALOGUE, layoutDiagnostic, NO_SPAN, type Diagnostic, type LayoutDiagnosticCode, type StageResult } from '@sgl/core';
import type { LayoutPlan } from './compose.js';
import type { LayoutInput, LayoutResult, ResolvedThemeMetricsView } from './contract.js';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import { quantize, validateResult } from './validate.js';

/** Default hard timeout. On expiry the host terminates the worker, respawns it,
 *  surfaces SGL4001 and keeps the previous layout (Architecture §4.4). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** How long the host waits for a worker to acknowledge an `'abort'` (a `'result'`
 *  or `'error'` for that id) before concluding it is unresponsive and forcing a
 *  terminate + respawn (DD-06 §3). */
export const ABORT_ESCALATION_MS = 250;

/** Per-engine timeout overrides baked into the host (DD-06 §3: "default 10 000 ms;
 *  grid 2 000 ms"). `WorkerHostOptions.engineTimeoutMs` is merged on top, so a
 *  caller can override any of these without having to repeat the rest. */
export const DEFAULT_ENGINE_TIMEOUT_MS: Readonly<Record<string, number>> = {
  'sgl.grid': 2_000,
  // DD-12 N19: `fixed` does grid's arithmetic and less.
  'sgl.fixed': 2_000,
  // DD-12 N37: covers loading the lazy `std-trees` chunk on a slow device.
  'sgl.tree': 5_000,
  // DD-12 N47: the same chunk as `tree`.
  'sgl.radial': 5_000,
};

/** The MVP's seed for `ctx.random` (DD-00 §3, ADR-0004). `LayoutHost.run()` is a
 *  frozen signature with no slot for a per-call seed, so the host supplies one
 *  fixed, documented constant; a later stage that wants a per-document seed has
 *  to widen the interface, not this function. */
const SEED = 1;

/** The main-thread callback that answers a `'measure'` table-miss RPC (DD-06 §3),
 *  and the per-engine timeout overrides layered on top of `DEFAULT_ENGINE_TIMEOUT_MS`
 *  (decision D1). */
export interface WorkerHostOptions {
  /** Default hard timeout for an engine with no entry in `engineTimeoutMs`
   *  (including no `DEFAULT_ENGINE_TIMEOUT_MS` entry). Default `DEFAULT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Overrides/extends `DEFAULT_ENGINE_TIMEOUT_MS`, keyed by `LayoutEngine.id`. */
  readonly engineTimeoutMs?: Readonly<Record<string, number>>;
  /**
   * Answers a worker's `'measure'` RPC (a label an engine created during layout;
   * see `contract.ts`'s `MeasurerView.layoutRunsAsync`). May be sync or async.
   * Optional: a host whose registered engines never call `ctx.measure.layoutRunsAsync`
   * never needs it — omitting it degrades a real miss to an empty `TextLayout`-shaped
   * value rather than hanging forever. The returned value crosses back to the
   * worker via `postMessage`, so it must be `structuredClone`-safe plain data
   * (DD-00 §3) — no class instance, no function, no `Map`/`Set`.
   */
  readonly measure?: (runs: readonly unknown[], box: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>;
}

const DEGENERATE_MEASURE = (): unknown => ({ size: { w: 0, h: 0 }, lines: [] });

/**
 * Runs an engine off the main thread.
 *
 * MVP: a plain `Worker` with a timeout and an `AbortController`. That is the half
 * that protects the *user* — from a hung layout. Cross-origin iframe isolation,
 * which protects the user from *malicious code*, ships with B17; the `LayoutHost`
 * interface is the same either way (06 §4, pitfall 5).
 */
export interface LayoutHost {
  run(
    engineId: string,
    input: LayoutInput,
    options: Readonly<Record<string, unknown>>,
    metrics: ResolvedThemeMetricsView,
    table: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    /** The document's container engines (DD-14 C25): the worker composes
     *  the layout when it is not empty. */
    plan?: LayoutPlan,
  ): Promise<StageResult<LayoutResult | null>>;

  dispose(): void;
}

interface InFlight {
  readonly id: number;
  readonly engineId: string;
  readonly ms: number;
  /** SGL4001's `{what}`: the engine, or the composed layout (fix round 1, item 3). */
  readonly what: string;
  readonly input: LayoutInput;
  /** The `'layout'` message as posted, kept so a respawn can post it again. */
  readonly message: Extract<HostToWorker, { t: 'layout' }>;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (result: StageResult<LayoutResult | null>) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Decision D1: `createWorkerHost` takes a **factory**, not a `Worker` instance —
 * the original `createWorkerHost(worker, timeoutMs)` signature this stage
 * inherited cannot respawn after `terminate()`, since a terminated `Worker` stays
 * terminated. `spawn()` is called once up front and again every time the host
 * needs a fresh worker (timeout, or a 250 ms abort escalation). A Node unit test
 * supplies a fake conforming to the same `Worker` shape (`as unknown as Worker`);
 * the browser project (D3) exercises this against a real one.
 */
export function createWorkerHost(spawn: () => Worker, options: WorkerHostOptions = {}): LayoutHost {
  const engineTimeoutMs: Readonly<Record<string, number>> = { ...DEFAULT_ENGINE_TIMEOUT_MS, ...options.engineTimeoutMs };
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const measureCallback = options.measure ?? DEGENERATE_MEASURE;

  let worker = spawn();
  let current: InFlight | null = null;
  // Requests that were aborted/superseded/timed-out and are waiting (up to
  // ABORT_ESCALATION_MS) to see whether the worker still answers for that id —
  // if it does, the escalation is cancelled and the answer discarded; if it
  // doesn't, the worker is presumed stuck and gets terminated + respawned.
  const pendingAborts = new Map<number, { readonly timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0;
  let disposed = false;

  wireWorker(worker);

  /**
   * `w` is the specific worker instance this listener was attached to,
   * captured at registration time — not read from the mutable `worker`
   * variable, whose whole purpose is to be reassigned on respawn. `worker !==
   * w` inside the listener is therefore "this worker has already been
   * replaced": a message from a killed-or-superseded worker is ignored
   * outright, closing the gap a review round found — after a respawn, the new
   * worker's own `'measure'` `req` counter restarts at 0 (worker-side state,
   * `worker-runtime.ts`), so a late generation-0 `'measure'` reaching an
   * un-gated listener could resolve an unrelated `layoutRunsAsync` call in
   * generation 1 with the wrong data. DD-06 §3: "a late reply for an
   * already-aborted id is discarded" generalises to "a late reply from an
   * already-replaced worker is discarded," which this one check gives every
   * message type at once, not just `'result'`/`'error'`.
   */
  function wireWorker(w: Worker): void {
    w.addEventListener('message', (ev: MessageEvent) => {
      if (worker !== w) return; // stale — this worker was already replaced.
      onMessage(ev.data as WorkerToHost);
    });
  }

  function timeoutFor(engineId: string): number {
    return engineTimeoutMs[engineId] ?? defaultTimeoutMs;
  }

  /** Replaces the worker. The current request, if there is one, was posted
   *  to the worker being terminated, so it is posted again to the new one
   *  (F21): an abort escalation terminates the worker because it did not
   *  answer the *previous* request's abort in time — typically still importing
   *  elkjs or inside ELK's synchronous run — while the request that superseded
   *  it is queued behind on that same worker. Dropping it left the caller
   *  waiting for the full timeout and then an SGL4001 with no layout, for a
   *  request no engine had even started. It keeps its timer: the deadline runs
   *  from `run()` (§3's lifecycle), so a re-post cannot extend it, and a
   *  request is re-posted at most once per respawn. A timeout's respawn takes
   *  the request first (`takeCurrent`), so nothing is re-posted after one. */
  function respawn(): void {
    try {
      worker.terminate();
    } catch {
      // A worker that failed to terminate cleanly is still being replaced below;
      // nothing more to do with the reference being discarded.
    }
    for (const pending of pendingAborts.values()) clearTimeout(pending.timer);
    pendingAborts.clear();
    worker = spawn();
    wireWorker(worker);
    if (current !== null) worker.postMessage(current.message);
  }

  /** Detaches `id`'s timer/abort-listener and hands back its state, but only if
   *  `id` is still the active request — a stale message for an id that already
   *  settled (or was never `current`) is a no-op. */
  function takeCurrent(id: number): InFlight | null {
    if (current === null || current.id !== id) return null;
    const state = current;
    current = null;
    clearTimeout(state.timer);
    state.signal.removeEventListener('abort', state.onAbort);
    return state;
  }

  /** Posts `'abort'`, starts the 250 ms escalation, and rejects `state`'s promise
   *  immediately with `AbortError` — "AbortSignal fires on user edit so a
   *  superseded layout stops immediately" (Architecture §4.4); the escalation
   *  only decides whether the *worker* needs replacing, never how long the
   *  caller waits. */
  function beginAbort(state: InFlight): void {
    worker.postMessage({ t: 'abort', id: state.id });
    const timer = setTimeout(() => {
      pendingAborts.delete(state.id);
      respawn();
    }, ABORT_ESCALATION_MS);
    pendingAborts.set(state.id, { timer });
    state.reject(makeAbortError());
  }

  function onMessage(message: WorkerToHost): void {
    switch (message.t) {
      case 'result': {
        const pending = pendingAborts.get(message.id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          pendingAborts.delete(message.id);
          return; // superseded — the caller already saw an AbortError.
        }
        const state = takeCurrent(message.id);
        if (state === null) return;
        const diagnostics = validateResult(message.result, state.input.graph, state.engineId);
        const hasError = diagnostics.some((d) => d.severity === 'error');
        state.resolve(
          hasError
            ? { value: null, diagnostics }
            : { value: quantize(message.result, 64), diagnostics: [...diagnostics, ...engineNotes(message.result.notes)] },
        );
        return;
      }
      case 'error': {
        const pending = pendingAborts.get(message.id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          pendingAborts.delete(message.id);
          return;
        }
        const state = takeCurrent(message.id);
        if (state === null) return;
        // Fix round 1, item 4: built here, from the id this host asked for and
        // the cleaned reason; the worker's own code, message and span are
        // never read (DD-12 N20's rule, for the failure channel too).
        state.resolve({
          value: null,
          diagnostics: [
            layoutDiagnostic('SGL4011', NO_SPAN, {
              id: state.engineId,
              message: typeof message.reason === 'string' ? workerText(message.reason) : 'no reason given',
            }),
          ],
        });
        return;
      }
      case 'measure': {
        // The worker-identity check above already discards a `'measure'` from
        // an already-*respawned* worker; this catches the narrower case of a
        // live, not-yet-respawned worker whose in-flight request was
        // *superseded* (a new `run()` posts `'abort'` and a new `'layout'` to
        // the same worker instance without respawning it — respawn only
        // follows a 250 ms unanswered escalation or a hard timeout). An
        // engine that doesn't notice `ctx.signal` right away can still post a
        // `'measure'` for the request it no longer owns; answering it would
        // both leak the callback's work on dead output and risk colliding
        // with the *new* request's own `req` numbering.
        if (message.id !== current?.id) return;
        void Promise.resolve(measureCallback(message.runs, message.box)).then((layout) => {
          if (disposed || message.id !== current?.id) return;
          worker.postMessage({ t: 'measure-reply', id: message.id, req: message.req, layout });
        });
        return;
      }
      case 'log':
        // `ctx.log` is a developer channel with no code or span, so it is not
        // how an engine reports a document problem (DD-12 N21: `notes` is);
        // dropped here rather than thrown so a chatty engine cannot break the
        // host.
        return;
    }
  }

  return {
    run(engineId, input, options, metrics, table, signal, plan) {
      // Calling `run()` on a disposed host is a programming error, not a
      // runtime condition about the input or the engine — §1's "throwing is
      // reserved for a violated invariant." Rejecting a *fresh* `Promise`
      // (rather than throwing synchronously) keeps `run()`'s return type
      // honest for every caller that already does `await host.run(...)`; a
      // review round found this path previously posted to a terminated
      // worker, which never replies, so the request hung until timeout and
      // then spawned an orphan worker nothing would ever use.
      if (disposed) return Promise.reject(new Error('createWorkerHost: run() called after dispose().'));
      if (signal.aborted) return Promise.reject(makeAbortError());

      if (current !== null) {
        // "A single in-flight request at a time; a new request aborts the
        // previous one" (DD-06 §3) — the application never queues more than one
        // (DD-08 §3), so a second `run()` call means the first is superseded.
        const previous = takeCurrent(current.id);
        if (previous !== null) beginAbort(previous);
      }

      const id = nextId;
      nextId += 1;

      // DD-14 C26: one clock per request, the longest of its engines'.
      const composed = plan !== undefined && plan.length > 0;
      const ms = composed ? Math.max(timeoutFor(engineId), ...plan.map((s) => timeoutFor(s.engine))) : timeoutFor(engineId);
      // SGL4001 names what was stopped: a composed layout is not the root
      // engine's alone (fix round 1, item 3), "(`sgl.grid` with 2 `sgl.elk`
      // boxes and 1 `sgl.fixed` box)", engines in the plan's order.
      let what = `engine \`${engineId}\``;
      if (composed) {
        const counts = new Map<string, number>();
        for (const s of plan) counts.set(s.engine, (counts.get(s.engine) ?? 0) + 1);
        const boxes = [...counts].map(([id, n]) => `${n} \`${id}\` box${n === 1 ? '' : 'es'}`);
        what = `(\`${engineId}\` with ${boxes.join(' and ')})`;
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const state = takeCurrent(id);
          if (state === null) return;
          respawn();
          state.resolve({
            value: null,
            diagnostics: [layoutDiagnostic('SGL4001', NO_SPAN, { what: state.what, ms: state.ms })],
          });
        }, ms);

        const onAbort = (): void => {
          const state = takeCurrent(id);
          if (state === null) return;
          beginAbort(state);
        };
        signal.addEventListener('abort', onAbort, { once: true });

        const message: Extract<HostToWorker, { t: 'layout' }> = { t: 'layout', id, engine: engineId, input, options, metrics, table, seed: SEED, ...(composed && { plan }) };
        current = { id, engineId, ms, what, input, message, timer, signal, onAbort, resolve, reject };
        worker.postMessage(message);
      });
    },

    dispose() {
      disposed = true;
      const state = current !== null ? takeCurrent(current.id) : null;
      state?.reject(makeAbortError());
      for (const pending of pendingAborts.values()) clearTimeout(pending.timer);
      pendingAborts.clear();
      try {
        worker.terminate();
      } catch {
        // Already gone; nothing left to clean up.
      }
    },
  };
}

/** At most this many of an engine's notes are read (fix round 1, item 1). The
 *  rest are dropped silently: no catalogue row says "n more were dropped". */
export const MAX_ENGINE_NOTES = 100;

/**
 * Text from the worker, made fit for a catalogue template (fix round 1, item
 * 3): backticks, line breaks and every other control character become
 * spaces, so it cannot close the template's code span or start a new line,
 * and it is cut to 120 characters, the last an ellipsis, never splitting a
 * surrogate pair.
 */
export function workerText(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  const s = text.replace(/[`\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return s.length <= 120 ? s : `${s.slice(0, 119).replace(/[\ud800-\udbff]$/, '')}…`;
}

/**
 * An engine's `LayoutResult.notes` as diagnostics (DD-12 N20). The worker is
 * untrusted (B17), so each note is checked field by field: a `LAYOUT_CATALOGUE`
 * code whose row is not an error (an engine that fails throws, which is
 * `SGL4011`), a span of two non-negative integers with `from <= to`
 * (copied), and, for each of the
 * template's own placeholders only, a finite number or a string (through
 * `workerText`). The
 * message is the catalogue's, never the engine's. Anything else is dropped
 * without a word. Only the first `MAX_ENGINE_NOTES` entries are read, so a
 * huge or sparse array costs nothing (fix round 1, item 1).
 *
 * Past the cap, the host adds one `SGL4022` (info, human decision
 * 2026-09-27; `feat/b5-fixed` fix round 1, item 3) at the document start,
 * `{count}` being the entries it did not read. `SGL4022` is the host's
 * alone: a note with that code from an engine is dropped.
 */
export function engineNotes(notes: unknown): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!Array.isArray(notes)) return out;
  const n = Math.min(notes.length, MAX_ENGINE_NOTES);
  for (let i = 0; i < n; i++) {
    const note = notes[i] as { code?: unknown; span?: { from?: unknown; to?: unknown }; params?: Record<string, unknown> } | null | undefined;
    const code = note?.code;
    const from = note?.span?.from;
    const to = note?.span?.to;
    if (typeof code !== 'string' || !Object.hasOwn(LAYOUT_CATALOGUE, code) || code === 'SGL4022') continue;
    const row = LAYOUT_CATALOGUE[code as LayoutDiagnosticCode];
    if (row.severity === 'error') continue;
    // Non-negative integers, from <= to (fix round 1, item 2).
    if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) < (from as number)) continue;
    const params: Record<string, string | number> = {};
    for (const [, k] of row.template.matchAll(/\{(\w+)\}/g)) {
      const v = typeof note?.params === 'object' && note.params !== null && Object.hasOwn(note.params, k!) ? note.params[k!] : undefined;
      if (typeof v === 'string') params[k!] = workerText(v);
      else if (Number.isFinite(v)) params[k!] = v as number;
    }
    out.push(layoutDiagnostic(code as LayoutDiagnosticCode, { from: from as number, to: to as number }, params));
  }
  if (notes.length > MAX_ENGINE_NOTES) out.push(layoutDiagnostic('SGL4022', { from: 0, to: 0 }, { count: notes.length - MAX_ENGINE_NOTES }));
  return out;
}

/**
 * DD-06 §3's lifecycle says abort() "reject[s] with AbortError" — kept literally
 * rather than folded into the errors-are-values `{ value: null, diagnostics }`
 * shape every other failure path uses. Timeout, malformed output and an engine
 * throw are all conditions *about the input or the engine* that the caller needs
 * to see and can display; an abort is the host's own bookkeeping reacting to the
 * caller's **own** cancellation (a superseding `run()` call, or the caller's
 * `AbortSignal` firing) — the caller already knows it asked for this, so there is
 * nothing new to report as a diagnostic, and DD-08 §3's "the application never
 * queues more than one" means every call site is expected to `catch` exactly this
 * on every superseded request, the same idiom `fetch()` and every other abortable
 * web API already use. Resolving it instead would force every call site to
 * distinguish "cancelled because I asked" from "the document is broken" by
 * inspecting diagnostics rather than by a `catch`. Documented in DD-06 §3.
 */
function makeAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted.', 'AbortError');
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}
