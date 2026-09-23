/**
 * `@sgl/layout-api/conformance` — the harness every engine is held to (DD-06 §8).
 *
 * For each case (a `LayoutInput` the caller built from a corpus document —
 * this package may not import `@sgl/theme`/`@sgl/measure`, so it cannot build
 * one itself), the engine is run through exactly the sequence a real request
 * takes in the worker (`engine.layout -> applyHostFallbacks -> quantize`,
 * `worker-runtime.ts` and `host.ts`), and five checks are made:
 *
 * 1. the result passes `validateResult` (no error; warnings are reported);
 * 2. two runs are byte-identical after quantization (`bitwise` engines also
 *    before it; `best-effort` engines are skipped, ADR-0004);
 * 3. no two sibling leaf frames overlap (containers may enclose);
 * 4. the case named `timedCase` (the 1 000-node graph) finishes inside the
 *    engine's timeout;
 * 5. an engine claiming `labelPlacement: true` returns a `LabelPlacement` for
 *    every visible label.
 *
 * Plus one *warning*, not a check (DD-06 §6.3, Stage K decision K4): route
 * segments that cross the frame of a container unrelated to the edge — one
 * that encloses neither endpoint. ELK's orthogonal router across hierarchy
 * boundaries is the known source; the count is collected and reported, not
 * failed, until the rate is known.
 *
 * Pure apart from the injected clock, so it runs the same under Node and in a
 * browser. Design: Architecture §4.6, DD-06 §8. Grows to ~40 graphs; the MVP
 * set is the `corpus/` documents.
 */

import type { EdgeId, GraphNode, LabelId, NodeId, PathSeg, Point, Rect, SemanticGraph } from '@sgl/core';
import type { LayoutContext, LayoutEngine, LayoutInput, LayoutResult, ResolvedThemeMetricsView } from './contract.js';
import { applyHostFallbacks } from './fallbacks.js';
import { DEFAULT_ENGINE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from './host.js';
import { describeShapeError, quantize, validateResult } from './validate.js';

export interface ConformanceCase {
  readonly name: string;
  readonly input: LayoutInput;
}

export interface ConformanceOptions {
  readonly metrics: ResolvedThemeMetricsView;
  /** The engine options bag (`ctx.options`). Default `{}`. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Check 4's budget. Default: the host's own timeout for this engine
   *  (`DEFAULT_ENGINE_TIMEOUT_MS[engine.id] ?? DEFAULT_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
  /** The case check 4 is made on. */
  readonly timedCase?: string;
  /** A millisecond clock for check 4 (injected: `performance.now` is banned
   *  below `apps/web`, DD-00 §3). */
  readonly now: () => number;
}

export interface HierarchyCrossing {
  readonly edge: EdgeId;
  readonly container: NodeId;
}

export interface CaseReport {
  readonly name: string;
  /** Check 1: every diagnostic `validateResult` gave (errors fail). */
  readonly validation: ReturnType<typeof validateResult>;
  /** Check 2; `null` for a `best-effort` engine (not checked). */
  readonly deterministic: boolean | null;
  /** Check 3. */
  readonly siblingOverlaps: readonly (readonly [NodeId, NodeId])[];
  /** Check 4: the first run's wall time; `withinTimeout` only on `timedCase`. */
  readonly ms: number;
  readonly withinTimeout: boolean | null;
  /** Check 5; empty for an engine with `labelPlacement: false`. */
  readonly missingLabels: readonly LabelId[];
  /** The K4 warning (not a failure). */
  readonly crossings: readonly HierarchyCrossing[];
  /** The quantized result of the first run, for callers that assert more. */
  readonly result: LayoutResult;
}

export interface ConformanceReport {
  readonly engine: string;
  readonly cases: readonly CaseReport[];
  /** Human-readable failures of checks 1–5; empty means the engine passes. */
  readonly failures: readonly string[];
  /** Crossings per case (only cases with any). */
  readonly crossingCounts: Readonly<Record<string, number>>;
}

const SEED = 1;

/** A `LayoutContext` for an in-process run: seeded `random` (mulberry32, the
 *  worker runtime's generator), no measure RPC (an engine that needs one is
 *  outside the MVP corpus), no `sublayout`. */
export function conformanceContext(options: Readonly<Record<string, unknown>>, metrics: ResolvedThemeMetricsView): LayoutContext {
  return {
    options,
    metrics,
    measure: {
      layoutRuns(): never {
        throw new Error('conformance: ctx.measure is not available in-process.');
      },
      layoutRunsAsync(): Promise<never> {
        return Promise.reject(new Error('conformance: ctx.measure is not available in-process.'));
      },
    },
    random: seeded(SEED),
    signal: new AbortController().signal,
    log: () => {},
    sublayout: () => Promise.reject(new Error('sublayout is reserved, not implemented (DD-06 §2).')),
  };
}

/** What a real request produces: `engine.layout -> applyHostFallbacks ->
 *  quantize(…, 64)` — `worker-runtime.ts` then `host.ts`, in one process.
 *  `raw` is the engine's own output, before any fallback. */
export async function runHostSequence(
  engine: LayoutEngine,
  input: LayoutInput,
  options: Readonly<Record<string, unknown>>,
  metrics: ResolvedThemeMetricsView,
): Promise<{ readonly raw: LayoutResult; readonly result: LayoutResult }> {
  const raw = await engine.layout(input, conformanceContext(options, metrics));
  if (describeShapeError(raw) !== null) return { raw, result: raw };
  return { raw, result: quantize(applyHostFallbacks(input, raw, engine.capabilities, metrics), 64) };
}

export async function runConformance(
  engine: LayoutEngine,
  cases: readonly ConformanceCase[],
  opts: ConformanceOptions,
): Promise<ConformanceReport> {
  const options = opts.options ?? {};
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS[engine.id] ?? DEFAULT_TIMEOUT_MS;
  const failures: string[] = [];
  const reports: CaseReport[] = [];
  const crossingCounts: Record<string, number> = {};

  for (const c of cases) {
    const t0 = opts.now();
    const first = await runHostSequence(engine, c.input, options, opts.metrics);
    const ms = opts.now() - t0;
    const second = await runHostSequence(engine, c.input, options, opts.metrics);

    const validation = validateResult(first.result, c.input.graph, engine.id);
    for (const d of validation) if (d.severity === 'error') failures.push(`${c.name}: check 1 (validateResult): ${d.message}`);

    let deterministic: boolean | null = null;
    if (engine.capabilities.determinism !== 'best-effort') {
      deterministic = JSON.stringify(first.result) === JSON.stringify(second.result);
      if (engine.capabilities.determinism === 'bitwise') deterministic &&= JSON.stringify(first.raw) === JSON.stringify(second.raw);
      if (!deterministic) failures.push(`${c.name}: check 2 (two runs differ after quantization)`);
    }

    const siblingOverlaps = describeShapeError(first.result) === null ? siblingLeafOverlaps(c.input.graph, first.result) : [];
    for (const [a, b] of siblingOverlaps) failures.push(`${c.name}: check 3 (sibling leaves '${a}' and '${b}' overlap)`);

    const withinTimeout = c.name === opts.timedCase ? ms <= timeoutMs : null;
    if (withinTimeout === false) failures.push(`${c.name}: check 4 (${Math.round(ms)} ms, over the ${timeoutMs} ms timeout)`);

    const missingLabels = engine.capabilities.labelPlacement ? missingLabelPlacements(c.input.graph, first.raw) : [];
    for (const id of missingLabels) failures.push(`${c.name}: check 5 (no LabelPlacement for '${id}')`);

    const crossings = describeShapeError(first.result) === null ? hierarchyCrossings(c.input.graph, first.result) : [];
    if (crossings.length > 0) crossingCounts[c.name] = crossings.length;

    reports.push({ name: c.name, validation, deterministic, siblingOverlaps, ms, withinTimeout, missingLabels, crossings, result: first.result });
  }

  if (opts.timedCase !== undefined && !cases.some((c) => c.name === opts.timedCase)) {
    failures.push(`check 4: no case named '${opts.timedCase}'`);
  }
  return { engine: engine.id, cases: reports, failures, crossingCounts };
}

/** Check 3: no two *sibling leaf* frames overlap, at every level including
 *  the root. Touching edges are not an overlap. */
export function siblingLeafOverlaps(graph: SemanticGraph, result: LayoutResult): readonly (readonly [NodeId, NodeId])[] {
  const violations: (readonly [NodeId, NodeId])[] = [];
  const EPS = 1e-6;
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x + EPS < b.x + b.w && b.x + EPS < a.x + a.w && a.y + EPS < b.y + b.h && b.y + EPS < a.y + a.h;
  const check = (ids: readonly NodeId[]): void => {
    const leaves = ids.filter((id) => {
      const n = graph.nodes[id];
      return n !== undefined && !n.hidden && n.children.every((c) => graph.nodes[c]?.hidden !== false);
    });
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        const a = result.nodes[leaves[i]!];
        const b = result.nodes[leaves[j]!];
        if (a !== undefined && b !== undefined && overlaps(a.frame, b.frame)) violations.push([leaves[i]!, leaves[j]!]);
      }
    }
  };
  check(graph.rootChildren);
  for (const id of graph.order) {
    const n = graph.nodes[id];
    if (n !== undefined && !n.hidden && n.children.length > 0) check(n.children);
  }
  return violations;
}

/** Check 5: visible labels (a visible node's, or a visible edge's) with no
 *  placement in the engine's own output. */
export function missingLabelPlacements(graph: SemanticGraph, raw: LayoutResult): readonly LabelId[] {
  const placed = new Set<LabelId>(raw.labels.map((l) => l.labelId));
  const visibleEdges = new Set<string>(graph.edges.filter((e) => !e.hidden).map((e) => e.id));
  const missing: LabelId[] = [];
  for (const id of Object.keys(graph.labels).sort() as LabelId[]) {
    const spec = graph.labels[id];
    if (spec === undefined) continue;
    const visible = spec.owner.kind === 'node' ? graph.nodes[spec.owner.id]?.hidden === false : visibleEdges.has(spec.owner.id);
    if (visible && !placed.has(id)) missing.push(id);
  }
  return missing;
}

/**
 * The K4 warning (DD-06 §6.3): each (edge, container) pair where a segment of
 * the edge's route passes through the frame of a container that is neither
 * endpoint nor an ancestor of one. The frame is shrunk by half a pixel first,
 * so a route running along a border does not count. Curves are sampled.
 */
export function hierarchyCrossings(graph: SemanticGraph, result: LayoutResult): readonly HierarchyCrossing[] {
  const containers = graph.order.filter((id) => {
    const n = graph.nodes[id];
    return n !== undefined && !n.hidden && n.children.some((c) => graph.nodes[c]?.hidden === false);
  });
  const out: HierarchyCrossing[] = [];
  for (const edge of graph.edges) {
    const layout = result.edges[edge.id];
    if (edge.hidden || layout === undefined) continue;
    const related = new Set<NodeId>([...lineage(graph, edge.from.node), ...lineage(graph, edge.to.node)]);
    const polyline = flatten(layout.start, layout.route);
    for (const id of containers) {
      if (related.has(id)) continue;
      const frame = result.nodes[id]?.frame;
      if (frame === undefined) continue;
      const box = { x: frame.x + 0.5, y: frame.y + 0.5, w: frame.w - 1, h: frame.h - 1 };
      if (box.w <= 0 || box.h <= 0) continue;
      for (let i = 1; i < polyline.length; i += 1) {
        if (segmentHitsRect(polyline[i - 1]!, polyline[i]!, box)) {
          out.push({ edge: edge.id, container: id });
          break;
        }
      }
    }
  }
  return out;
}

/** The node and every ancestor. */
function lineage(graph: SemanticGraph, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  let at: GraphNode | undefined = graph.nodes[id];
  while (at !== undefined) {
    out.push(at.id);
    at = at.parent === null ? undefined : graph.nodes[at.parent];
  }
  return out;
}

function flatten(start: Point, route: readonly PathSeg[]): Point[] {
  const pts: Point[] = [start];
  let prev = start;
  for (const seg of route) {
    if (seg.t === 'C' || seg.t === 'Q') {
      const c1 = seg.t === 'C' ? seg.c1 : seg.c;
      const c2 = seg.t === 'C' ? seg.c2 : seg.c;
      for (let k = 1; k <= 16; k += 1) {
        const t = k / 16;
        const u = 1 - t;
        pts.push({
          x: u * u * u * prev.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * seg.to.x,
          y: u * u * u * prev.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * seg.to.y,
        });
      }
    } else {
      pts.push(seg.to);
    }
    prev = seg.to;
  }
  return pts;
}

/** Liang–Barsky: does segment `a`–`b` meet the (closed) rectangle? */
function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t0 <= t1;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
