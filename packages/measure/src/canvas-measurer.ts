import { layoutLines, type MeasureRun, type RunMetrics } from './line-model.js';
import { hashRuns, UNCONSTRAINED } from './run-key.js';
import { staticRunMetrics } from './static-measurer.js';
import type { BoxConstraints, Measurer, StyledRun, TextLayout, TextStyle } from './types.js';

/**
 * The MVP `Measurer` (DD-05 §4, ADR-0003 amendment).
 *
 * The one place below `apps/web` that touches a DOM API, kept behind the `Measurer`
 * interface so DD-00 §2 rule 4 still holds. Nothing in this file is imported by the
 * arithmetic — the canvas supplies two numbers per run and the shared line model
 * does the rest.
 *
 * The package builds for Node as well as the browser, and `tsconfig.base.json` has
 * no `dom` lib, so the handful of DOM shapes used here are declared structurally
 * below rather than pulled in wholesale. That is also the honest description of the
 * dependency: two methods and one property, not the DOM.
 */

// ---------------------------------------------------------------------------
// The DOM surface, declared rather than imported
// ---------------------------------------------------------------------------

interface CanvasTextMetricsLike {
  readonly width: number;
  readonly fontBoundingBoxAscent?: number;
}

interface Canvas2DContextLike {
  font: string;
  measureText(text: string): CanvasTextMetricsLike;
}

interface CanvasLike {
  getContext(contextId: '2d'): Canvas2DContextLike | null;
}

interface FontFaceSetLike {
  load(font: string): Promise<unknown>;
  readonly ready: Promise<unknown>;
}

interface CanvasGlobals {
  readonly OffscreenCanvas?: new (width: number, height: number) => CanvasLike;
  readonly document?: {
    createElement(tagName: string): CanvasLike;
    readonly fonts?: FontFaceSetLike;
  };
}

const globals = (): CanvasGlobals => globalThis as unknown as CanvasGlobals;

/** DD-05 §3: when the browser will not tell us the ascent, assume this much of the
 *  em. Only used for the canvas path — `StaticMetricsMeasurer` has a real one. */
const FALLBACK_ASCENT_RATIO = 0.8;

/** DD-05 §4. Cleared wholesale rather than evicted one at a time: an LRU costs
 *  more than re-measuring on the rare document that overflows this. */
const MAX_CACHE_ENTRIES = 20_000;

/** True when a 2D canvas exists in this environment. False under Node, in a
 *  Worker without `OffscreenCanvas`, and wherever canvas is blocked. */
export function canvasIsAvailable(): boolean {
  return createContext() !== null;
}

function createContext(): Canvas2DContextLike | null {
  const g = globals();
  try {
    if (typeof g.OffscreenCanvas === 'function') {
      const ctx = new g.OffscreenCanvas(1, 1).getContext('2d');
      if (ctx !== null) return ctx;
    }
  } catch {
    // Some environments expose the constructor and then refuse the context.
  }
  try {
    const doc = g.document;
    if (doc !== undefined && typeof doc.createElement === 'function') {
      const ctx = doc.createElement('canvas').getContext('2d');
      if (ctx !== null) return ctx;
    }
  } catch {
    // Same, for a locked-down or partially stubbed `document`.
  }
  return null;
}

/** The CSS font shorthand the canvas wants. `ctx.letterSpacing` is deliberately
 *  not used — support is patchy, and DD-05 §4 adds spacing arithmetically. */
export function cssFont(style: TextStyle): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
}

export class CanvasMeasurer implements Measurer {
  /** `undefined` = not yet attempted; `null` = attempted and unavailable. */
  #ctx: Canvas2DContextLike | null | undefined = undefined;
  readonly #cache = new Map<string, RunMetrics>();

  /**
   * True when no canvas could be obtained and measurement has degraded to
   * `StaticMetricsMeasurer`'s advance tables.
   *
   * DD-05 §4 makes font readiness a precondition, not an option, so silently
   * measuring with the wrong metrics is exactly the failure this package exists to
   * prevent. Degrading rather than throwing keeps the pipeline running — an
   * approximately sized diagram beats a blank one — but the application should
   * surface this, so it is observable rather than buried.
   */
  get usingFallback(): boolean {
    return this.#context() === null;
  }

  layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout {
    return layoutLines(this.#measureRun, runs, box);
  }

  layoutRunsAsync(runs: readonly StyledRun[], box: BoxConstraints): Promise<TextLayout> {
    return Promise.resolve(this.layoutRuns(runs, box));
  }

  /** A canvas can measure any string, so this measurer never misses. The table
   *  lookup that can miss is `TableMeasurer`'s, inside the worker. */
  has(runs: readonly StyledRun[], box: BoxConstraints): boolean {
    void runs;
    void box;
    return true;
  }

  /**
   * Await the fonts these styles name before measuring (DD-05 §4).
   *
   * Measuring before the webfont has loaded silently measures the fallback face,
   * which is the classic "labels are the wrong size on first paint" bug. DD-08 §5
   * awaits this before the first pre-measure and again whenever the set of text
   * styles changes.
   *
   * A no-op where `document.fonts` does not exist, which includes every
   * environment where `usingFallback` is already true.
   */
  async ready(styles: readonly TextStyle[]): Promise<void> {
    const fonts = globals().document?.fonts;
    if (fonts === undefined) return;

    // Distinct family/weight/style; the size in the shorthand does not select a
    // different face. Sorted so the load order is deterministic (DD-00 §3).
    const byFace = new Map<string, string>();
    for (const style of styles) {
      byFace.set(`${style.fontStyle}|${style.fontWeight}|${style.fontFamily}`, cssFont(style));
    }
    const specs = [...byFace.values()].sort(compareStrings);

    await Promise.all(specs.map((spec) => fonts.load(spec).catch(() => undefined)));
    await fonts.ready;
  }

  #context(): Canvas2DContextLike | null {
    if (this.#ctx === undefined) this.#ctx = createContext();
    return this.#ctx;
  }

  readonly #measureRun: MeasureRun = (text, style) => {
    const key = hashRuns([{ text, style }], UNCONSTRAINED);
    const hit = this.#cache.get(key);
    if (hit !== undefined) return hit;

    const ctx = this.#context();
    const metrics = ctx === null ? staticRunMetrics(text, style) : measureOn(ctx, text, style);

    if (this.#cache.size >= MAX_CACHE_ENTRIES) this.#cache.clear();
    this.#cache.set(key, metrics);
    return metrics;
  };
}

function measureOn(ctx: Canvas2DContextLike, text: string, style: TextStyle): RunMetrics {
  ctx.font = cssFont(style);
  const tm = ctx.measureText(text);

  const width = Number.isFinite(tm.width) ? tm.width : 0;
  const reported = tm.fontBoundingBoxAscent;
  const ascent =
    typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? reported
      : style.fontSize * FALLBACK_ASCENT_RATIO;

  return { width, ascent };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
