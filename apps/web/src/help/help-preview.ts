import { effect } from '@preact/signals';
import type { EngineSchemas, LayoutHost, ResolvedThemeMetricsView } from '@sgl/layout-api';
import { createPipeline } from '../state/pipeline.js';
import type { AppMeasurer, Cancel, ImportsRuntime, RichText, Schedule } from '../state/types.js';

/**
 * Help's example previews (DD-13 P24–P27), the lazy `help-preview` chunk.
 *
 * - **The editor's own pipeline.** Each example runs through
 *   `createPipeline`, with the app's measurer, metrics, engine schemas and
 *   lazy loaders, and `debounceMs: 0`. A fresh pipeline is made per example,
 *   with the example's text as its document (parsed by `pipeline.ts`, the one
 *   module allowed to), so "this preview has finished" is simply "this
 *   pipeline has rendered, or failed", with nothing left of the previous
 *   example to tell apart.
 * - **A host of its own** (P25): the editor's host runs one request at a time
 *   and a new one supersedes the old, so sharing it would abort the editor's
 *   layout. It is made on the first preview (the app's `createAppWorkerHost`:
 *   the same worker script, a second instance), and disposed 60 s after the
 *   last help surface closes.
 * - **One at a time** (P26), in the order asked, with the results cached by
 *   (example id, theme, engine), least recently used, 64 entries.
 */

export const DISPOSE_AFTER_MS = 60_000;
export const PREVIEW_CACHE_SIZE = 64;
/** A preview that has neither rendered nor failed by then is given up. */
const PREVIEW_TIMEOUT_MS = 60_000;

export interface PreviewDeps {
  readonly measurer: AppMeasurer;
  readonly metrics: ResolvedThemeMetricsView;
  /** Makes help's own layout host (the app: `createAppWorkerHost(measurer)`). */
  readonly createHost: () => LayoutHost;
  /** For the disposal timer; `setTimeout` by default. */
  readonly schedule?: Schedule;
  readonly engineSchemas?: (engineId: string) => EngineSchemas | undefined;
  readonly loadRichText?: () => Promise<RichText>;
  readonly loadImports?: () => Promise<ImportsRuntime>;
}

export interface PreviewRequest {
  /** The example's id (`key/pin#2`). */
  readonly key: string;
  readonly source: string;
  /** A registered engine id: `previewEngineId`'s. */
  readonly engineId: string;
  readonly themeId: string;
}

export interface PreviewOutcome {
  /** `render()`'s SVG, or `null` when the example did not render. */
  readonly svg: string | null;
  /** The codes of every diagnostic the example produced, in the pipeline's order. */
  readonly codes: readonly string[];
  /** What it actually ran under: a document's own `@layout.engine` or `@theme` wins (DD-08 §10). */
  readonly engineId: string;
  readonly themeId: string;
}

export interface Previewer {
  /** Asks for a preview; `done` is called once, unless the returned cancel is called first. */
  render(req: PreviewRequest, done: (outcome: PreviewOutcome) => void): Cancel;
  /** A help surface is showing: keep the host. */
  open(): void;
  /** The last help surface closed: dispose the host in 60 s unless one opens again. */
  close(): void;
  hostAlive(): boolean;
}

function defaultSchedule(fn: () => void, ms: number): Cancel {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** The engine a preview runs under (P27): the example's own, by bare name (`grid`) or id, else the default (`elk`). */
export function previewEngineId(engine: string | undefined, engines: readonly { readonly id: string }[], fallback: string): string {
  if (engine === undefined) return fallback;
  return engines.find((e) => e.id === engine || e.id === `sgl.${engine}`)?.id ?? engine;
}

interface Job {
  readonly req: PreviewRequest;
  readonly cacheKey: string;
  readonly waiting: Set<(outcome: PreviewOutcome) => void>;
}

export function createPreviewer(deps: PreviewDeps): Previewer {
  const schedule = deps.schedule ?? defaultSchedule;
  const cache = new Map<string, PreviewOutcome>();
  const queue: Job[] = [];
  let running: Job | null = null;
  let host: LayoutHost | null = null;
  let disposeTimer: Cancel | null = null;

  const cacheKeyOf = (req: PreviewRequest): string => `${req.key}\n${req.themeId}\n${req.engineId}`;

  function remember(key: string, outcome: PreviewOutcome): void {
    cache.delete(key);
    cache.set(key, outcome);
    while (cache.size > PREVIEW_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }

  function run(job: Job): Promise<PreviewOutcome> {
    host ??= deps.createHost();
    const { req } = job;
    const pipeline = createPipeline(
      {
        measurer: deps.measurer,
        host,
        metrics: deps.metrics,
        defaultEngineId: req.engineId,
        defaultThemeId: req.themeId,
        debounceMs: 0,
        ...(deps.engineSchemas !== undefined && { engineSchemas: deps.engineSchemas }),
        ...(deps.loadRichText !== undefined && { loadRichText: deps.loadRichText }),
        ...(deps.loadImports !== undefined && { loadImports: deps.loadImports }),
      },
      req.source,
    );
    return new Promise<PreviewOutcome>((resolve) => {
      let settled = false;
      const finish = (svg: string | null): void => {
        if (settled) return;
        settled = true;
        const outcome: PreviewOutcome = { svg, codes: pipeline.diags.peek().map((d) => d.code), engineId: pipeline.effectiveEngineId.peek(), themeId: pipeline.effectiveThemeId.peek() };
        cancelTimeout();
        // Later, never inside the effect's own run (which may be its first,
        // before `stop` is assigned).
        queueMicrotask(() => {
          stop();
          pipeline.dispose();
        });
        resolve(outcome);
      };
      const cancelTimeout = defaultSchedule(() => finish(null), PREVIEW_TIMEOUT_MS);
      const stop = effect(() => {
        const good = pipeline.lastGood.value;
        const failed = pipeline.pipelineError.value !== null;
        const busy = pipeline.inFlight.value;
        const rendered = pipeline.svg.value !== null;
        const layoutFailed = pipeline.layout.value === null && pipeline.layoutDiags.value.length > 0;
        const hasError = pipeline.diags.value.some((d) => d.severity === 'error');
        if (good !== null) finish(good.svg);
        else if (failed || (!busy && hasError && (rendered || layoutFailed))) finish(null);
      });
    });
  }

  function pump(): void {
    if (running !== null) return;
    const job = queue.shift();
    if (job === undefined) return;
    running = job;
    void run(job).then((outcome) => {
      running = null;
      remember(job.cacheKey, outcome);
      for (const done of job.waiting) done(outcome);
      pump();
    });
  }

  return {
    render(req, done) {
      const cacheKey = cacheKeyOf(req);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        remember(cacheKey, cached);
        done(cached);
        return () => undefined;
      }
      let job = running?.cacheKey === cacheKey ? running : queue.find((j) => j.cacheKey === cacheKey);
      if (job === undefined) {
        job = { req, cacheKey, waiting: new Set() };
        queue.push(job);
      }
      const owner = job;
      owner.waiting.add(done);
      pump();
      return () => {
        owner.waiting.delete(done);
        const at = queue.indexOf(owner);
        if (at >= 0 && owner.waiting.size === 0) queue.splice(at, 1);
      };
    },
    open() {
      if (disposeTimer !== null) disposeTimer();
      disposeTimer = null;
    },
    close() {
      if (disposeTimer !== null) disposeTimer();
      disposeTimer = schedule(() => {
        disposeTimer = null;
        host?.dispose();
        host = null;
      }, DISPOSE_AFTER_MS);
    },
    hostAlive: () => host !== null,
  };
}
