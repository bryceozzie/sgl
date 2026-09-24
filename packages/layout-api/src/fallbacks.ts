import type { EdgeId, GraphEdge, GraphNode, LabelId, LabelSpec, NodeId, PathSeg, Point, Rect } from '@sgl/core';
import { anchorPoint, centreOf, unit } from './anchor.js';
import type { EdgeLayout, LabelPlacement, LayoutInput, LayoutResult, ResolvedThemeMetricsView } from './contract.js';

/**
 * Host fallbacks — what fills the gaps an engine declares it does not cover.
 *
 * This is what turns `capabilities` from a rejection test into a negotiation, and
 * is the main reason a node-placement-only engine is a legitimate engine.
 *
 * Design: DD-06 §2, §4.
 */

/**
 * Applied when `capabilities.labelPlacement` is false (DD-06 §4.1). Replaces
 * `result.labels` outright — an engine declaring `labelPlacement: false` returns
 * none of its own — with a placement for every visible label.
 */
export function placeLabels(
  input: LayoutInput,
  result: LayoutResult,
  metrics: ResolvedThemeMetricsView,
): LayoutResult {
  const { graph } = input;
  const edgeById = new Map<EdgeId, GraphEdge>(graph.edges.map((e) => [e.id, e]));
  const placements: LabelPlacement[] = [];

  // DD-00 §3: never iterate a Record's keys without sorting.
  for (const labelId of Object.keys(graph.labels).sort() as LabelId[]) {
    const spec = graph.labels[labelId];
    if (spec === undefined) continue;
    const placement =
      spec.owner.kind === 'node'
        ? placeNodeLabel(input, result, spec, spec.owner.id)
        : placeEdgeLabel(input, result, spec, edgeById.get(spec.owner.id), metrics);
    if (placement !== null) placements.push(placement);
  }

  return { ...result, labels: placements };
}

function placeNodeLabel(
  input: LayoutInput,
  result: LayoutResult,
  spec: LabelSpec,
  nodeId: NodeId,
): LabelPlacement | null {
  const node = input.graph.nodes[nodeId];
  const frame = result.nodes[nodeId]?.frame;
  const sizing = input.sizing[nodeId];
  if (node === undefined || frame === undefined || sizing === undefined || node.hidden) return null;

  const label = input.labelSizes[spec.id] ?? { w: 0, h: 0 };
  const [t, r, b, l] = sizing.contentInset;
  const box: Rect = { x: frame.x + l, y: frame.y + t, w: frame.w - l - r, h: frame.h - t - b };

  const isContainer = node.children.length > 0;
  const labelFrame = isContainer
    ? { x: box.x, y: box.y, w: label.w, h: label.h }
    : { x: box.x + (box.w - label.w) / 2, y: box.y + (box.h - label.h) / 2, w: label.w, h: label.h };

  return {
    labelId: spec.id,
    frame: labelFrame,
    align: isContainer ? 'start' : 'middle',
    baseline: isContainer ? 'top' : 'middle',
  };
}

function placeEdgeLabel(
  input: LayoutInput,
  result: LayoutResult,
  spec: LabelSpec,
  edge: GraphEdge | undefined,
  metrics: ResolvedThemeMetricsView,
): LabelPlacement | null {
  if (edge === undefined || edge.hidden) return null;
  const layout = result.edges[edge.id];
  if (layout === undefined) return null;

  const label = input.labelSizes[spec.id] ?? { w: 0, h: 0 };
  const points = routePoints(layout);
  const selfLoop = edge.from.node === edge.to.node;

  const centre = selfLoop ? apexOf(points) : midpointByArcLength(points);
  const dir = selfLoop ? outwardDirection(points, centre) : directionNear(points, centre);
  const perp = awayFromCentroid(dir, points, centre);

  const offset = metrics.spacing.edgeLabel + label.h / 2;
  const cx = centre.x + perp.x * offset;
  const cy = centre.y + perp.y * offset;

  return {
    labelId: spec.id,
    frame: { x: cx - label.w / 2, y: cy - label.h / 2, w: label.w, h: label.h },
    align: 'middle',
    baseline: 'middle',
    occlusion: 'plate',
  };
}

/**
 * Every host fallback, in the order the worker runtime applies them after
 * `engine.layout()` returns (DD-06 §3, §4): finish the routes the engine
 * returned (`finishEngineRoutes`: §4.4, §4.5), route the edges it left out
 * (`routeStraight`: §4.2–§4.5), then place labels if the engine does not
 * (`placeLabels`: §4.1, which *replaces* `result.labels`, so it runs only for
 * `labelPlacement: false`).
 *
 * One sequence, shared by `worker-runtime.ts` and the conformance harness
 * (`conformance.ts`), so what the suite checks is what a real request gets.
 * The order is load-bearing: `finishEngineRoutes` runs *before*
 * `routeStraight`, so it sees only the engine's own routes, and an edge the
 * fallback routed (which already reserved its arrowhead) is never reserved a
 * second time.
 */
export function applyHostFallbacks(
  input: LayoutInput,
  raw: LayoutResult,
  capabilities: { readonly labelPlacement: boolean },
  metrics: ResolvedThemeMetricsView,
): LayoutResult {
  const finished = finishEngineRoutes(input, raw, metrics);
  const routed = routeStraight(input, finished, metrics);
  return capabilities.labelPlacement ? routed : placeLabels(input, routed, metrics);
}

/** A self-loop an engine routes shorter than this (its route's vertical
 *  extent) gets the host's teardrop instead (DD-06 §6.2: ELK's own loops are
 *  a tight box). */
export const MIN_SELF_LOOP_HEIGHT = 16;

/**
 * DD-06 §4.4 and §4.5 for the edges an engine routed itself (Stage K: DD-06
 * §6.2's "then the host applies §4.4 (arrow reserve) and §4.5 (self-loops)").
 * The contract is that an engine's route ends *on* the node or port boundary;
 * the host then pulls a directed end back by `arrowSize` along the final
 * segment so the marker tip, not the line, lands there — exactly what
 * `routeStraight` does for the routes it makes. A self-loop with fewer than
 * two segments, or under `MIN_SELF_LOOP_HEIGHT` tall, is replaced by the
 * teardrop (§4.5), which does its own reserve.
 *
 * Only edges present in `result.edges` are touched; run it before
 * `routeStraight` (see `applyHostFallbacks`).
 */
export function finishEngineRoutes(input: LayoutInput, result: LayoutResult, metrics: ResolvedThemeMetricsView): LayoutResult {
  let edges: Record<EdgeId, EdgeLayout> | null = null;
  const replacedLoops: GraphEdge[] = [];
  for (const edge of input.graph.edges) {
    const layout = result.edges[edge.id];
    if (edge.hidden || layout === undefined) continue;
    let finished: EdgeLayout | null;
    if (edge.from.node === edge.to.node && isShortLoop(layout)) {
      const node = input.graph.nodes[edge.from.node];
      const frame = result.nodes[edge.from.node]?.frame;
      finished = node === undefined || frame === undefined ? null : selfLoopLayout(node, frame, edge, metrics);
      if (finished !== null) replacedLoops.push(edge);
    } else {
      finished = reserveOnRoute(layout, edge.directed, metrics.arrowSize);
    }
    if (finished === null || finished === layout) continue;
    edges ??= { ...result.edges };
    edges[edge.id] = finished;
  }
  if (edges === null) return result;
  const next: LayoutResult = { ...result, edges };
  if (replacedLoops.length === 0) return next;

  // The host now owns these routes, so it owns their labels too: an engine's
  // label sat beside the loop the host just discarded. §4.5's "label at the
  // loop's apex", the same placement `placeLabels` gives a self-loop.
  const relabel = new Map<LabelId, LabelPlacement>();
  for (const edge of replacedLoops) {
    if (edge.labelId === null) continue;
    const spec = input.graph.labels[edge.labelId];
    const placement = spec === undefined ? null : placeEdgeLabel(input, next, spec, edge, metrics);
    if (placement !== null) relabel.set(edge.labelId, placement);
  }
  const labels = relabel.size === 0 ? next.labels : next.labels.map((l) => relabel.get(l.labelId) ?? l);

  // The teardrop reaches past the node, where the engine's `bounds` never
  // allowed for anything. No growth here: `quantize` recomputes `bounds` from
  // everything the result draws (DD-06 §5, F14), this loop and label included.
  return { ...next, labels };
}

function isShortLoop(layout: EdgeLayout): boolean {
  if (layout.route.length < 2) return true;
  const ys = routePoints(layout).map((p) => p.y);
  return Math.max(...ys) - Math.min(...ys) < MIN_SELF_LOOP_HEIGHT;
}

/** §4.4 on an engine's route: move `end` (and the route's final point) back
 *  along `endNormal`, and `start` along `startNormal` for `both`. A missing
 *  normal is taken from the end segment's own direction. */
function reserveOnRoute(layout: EdgeLayout, directed: GraphEdge['directed'], arrowSize: number): EdgeLayout {
  if (directed === 'none' || layout.route.length === 0) return layout;
  const points = routePoints(layout);
  const last = layout.route[layout.route.length - 1]!;
  const beforeEnd = last.t === 'C' ? last.c2 : last.t === 'Q' ? last.c : (points[points.length - 2] ?? layout.start);
  const first = layout.route[0]!;
  const afterStart = first.t === 'C' ? first.c1 : first.t === 'Q' ? first.c : first.to;
  const endNormal = layout.endNormal ?? unit(layout.end.x - beforeEnd.x, layout.end.y - beforeEnd.y) ?? { x: 1, y: 0 };
  const startNormal = layout.startNormal ?? unit(layout.start.x - afterStart.x, layout.start.y - afterStart.y) ?? { x: -1, y: 0 };
  // Fix round 1, item 6: an end segment shorter than `arrowSize` must not be
  // reversed or zeroed — the reserve is clamped to leave at least
  // `MIN_END_SEGMENT` of it, in its own direction. A single segment reserved
  // at both ends shares that budget between them.
  const headLen = Math.hypot(layout.end.x - beforeEnd.x, layout.end.y - beforeEnd.y);
  const tailLen = Math.hypot(afterStart.x - layout.start.x, afterStart.y - layout.start.y);
  const shared = directed === 'both' && layout.route.length === 1;
  const budget = (len: number): number => Math.max(0, shared ? (len - MIN_END_SEGMENT) / 2 : len - MIN_END_SEGMENT);
  const head = Math.min(arrowSize, budget(headLen));
  const tail = directed === 'both' ? Math.min(arrowSize, budget(tailLen)) : 0;
  const end = { x: layout.end.x - endNormal.x * head, y: layout.end.y - endNormal.y * head };
  const start = { x: layout.start.x - startNormal.x * tail, y: layout.start.y - startNormal.y * tail };
  const route = [...layout.route.slice(0, -1), { ...last, to: end }];
  return { ...layout, start, end, route, startNormal, endNormal };
}

/** The shortest an engine route's end segment may become after §4.4's
 *  reserve (fix round 1, item 6). */
const MIN_END_SEGMENT = 1;

/** Applied when an engine returns no route for an edge (DD-06 §4.2, §4.3, §4.5). */
export function routeStraight(input: LayoutInput, result: LayoutResult, metrics: ResolvedThemeMetricsView): LayoutResult {
  const edges: Record<EdgeId, EdgeLayout> = { ...result.edges };
  for (const edge of input.graph.edges) {
    if (edge.hidden || edges[edge.id] !== undefined) continue;
    const layout = routeOne(input, result, edge, metrics);
    if (layout !== null) edges[edge.id] = layout;
  }
  return { ...result, edges };
}

function routeOne(
  input: LayoutInput,
  result: LayoutResult,
  edge: GraphEdge,
  metrics: ResolvedThemeMetricsView,
): EdgeLayout | null {
  const fromNode = input.graph.nodes[edge.from.node];
  const toNode = input.graph.nodes[edge.to.node];
  const fromFrame = result.nodes[edge.from.node]?.frame;
  const toFrame = result.nodes[edge.to.node]?.frame;
  if (fromNode === undefined || toNode === undefined || fromFrame === undefined || toFrame === undefined) {
    return null;
  }

  if (edge.from.node === edge.to.node) return selfLoopLayout(fromNode, fromFrame, edge, metrics);

  const fromPort = edge.from.port !== undefined ? result.nodes[edge.from.node]?.ports?.[edge.from.port] : undefined;
  const toPort = edge.to.port !== undefined ? result.nodes[edge.to.node]?.ports?.[edge.to.port] : undefined;

  const fromCentre = centreOf(fromFrame);
  const toCentre = centreOf(toFrame);
  const rawStart = fromPort?.point ?? anchorPoint(fromNode.shape, fromFrame, toPort?.point ?? toCentre);
  const rawEnd = toPort?.point ?? anchorPoint(toNode.shape, toFrame, fromPort?.point ?? fromCentre);

  // `startNormal`/`endNormal` both mean "the direction of travel at that end" —
  // `endNormal` is where the arrowhead points continuing into the target, and
  // `startNormal` (only drawn for `directed: 'both'`) points the opposite way,
  // back out past the source. A port's own `normal` is its *outward* boundary
  // normal (pointing away from its node); at the head that is the reverse of
  // "direction of travel arriving", so it needs negating — at the tail it already
  // matches "pointing away from the source", so it does not.
  const startNormal = fromPort?.normal ?? unit(rawStart.x - rawEnd.x, rawStart.y - rawEnd.y) ?? { x: -1, y: 0 };
  const endNormal = toPort !== undefined ? negate(toPort.normal) : (unit(rawEnd.x - rawStart.x, rawEnd.y - rawStart.y) ?? { x: 1, y: 0 });

  const { start, end } = applyArrowReserve(rawStart, rawEnd, startNormal, endNormal, edge.directed, metrics.arrowSize);

  const route: PathSeg[] = [{ t: 'L', to: end }];
  return { start, end, route, startNormal, endNormal, clip: 'none' };
}

/** §4.4 — reserve room for the arrowhead so the marker tip lands on the boundary
 *  rather than the line poking through it: shorten the head end for `forward` and
 *  `both`, and the tail end too for `both`. Shared by the straight-edge path and
 *  the self-loop teardrop, which needs the same correction (see `selfLoopLayout`)
 *  and previously skipped it entirely. */
function applyArrowReserve(
  start: Point,
  end: Point,
  startNormal: Point,
  endNormal: Point,
  directed: GraphEdge['directed'],
  arrowSize: number,
): { readonly start: Point; readonly end: Point } {
  let s = start;
  let e = end;
  if (directed === 'forward' || directed === 'both') {
    e = { x: e.x - endNormal.x * arrowSize, y: e.y - endNormal.y * arrowSize };
  }
  if (directed === 'both') {
    s = { x: s.x - startNormal.x * arrowSize, y: s.y - startNormal.y * arrowSize };
  }
  return { start: s, end: e };
}

function negate(v: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } {
  return { x: -v.x, y: -v.y };
}

/** §4.5 — an engine's self-loop of fewer than two segments (grid never routes at
 *  all, so every self-loop reaches here) is replaced with a teardrop: exit the
 *  node's top-right at 45°, three `C` segments, re-enter at the right. The exact
 *  control-point placement below is this fallback's own choice — DD-06 §4.5 fixes
 *  the entry/exit points and the radius, not the curve's interior shape.
 *
 * §4.4's arrow reserve applies here too — a directed self-loop needs its
 * arrowhead pulled back from the boundary exactly as a straight edge does. Moving
 * `start`/`end` without recomputing the curve's own control points is a small,
 * accepted approximation (the same one every other engine's routing makes no
 * attempt to avoid): at `arrowSize` (a few px) against a loop radius of at least
 * 24, the resulting kink is not visible. */
function selfLoopLayout(node: GraphNode, frame: Rect, edge: GraphEdge, metrics: ResolvedThemeMetricsView): EdgeLayout {
  const r = Math.max(24, frame.h / 2);
  const c = centreOf(frame);
  const rawStart = anchorPoint(node.shape, frame, { x: c.x + 1, y: c.y - 1 });
  const rawEnd = anchorPoint(node.shape, frame, { x: c.x + 1, y: c.y });

  const p1: Point = { x: c.x + r * 1.6, y: c.y - r * 1.2 };
  const p2: Point = { x: c.x + r * 1.8, y: c.y + r * 0.2 };

  const endNormal = unit(rawEnd.x - p2.x, rawEnd.y - p2.y) ?? { x: 1, y: 0 };
  const startNormal = unit(rawStart.x - p1.x, rawStart.y - p1.y) ?? { x: -1, y: 0 };
  const { start, end } = applyArrowReserve(rawStart, rawEnd, startNormal, endNormal, edge.directed, metrics.arrowSize);

  const route: PathSeg[] = [
    { t: 'C', c1: { x: start.x + r * 0.8, y: start.y - r * 0.4 }, c2: { x: p1.x - r * 0.2, y: p1.y - r * 0.6 }, to: p1 },
    { t: 'C', c1: { x: p1.x + r * 0.5, y: p1.y + r * 0.3 }, c2: { x: p2.x + r * 0.1, y: p2.y - r * 0.6 }, to: p2 },
    { t: 'C', c1: { x: p2.x - r * 0.1, y: p2.y + r * 0.6 }, c2: { x: end.x + r * 0.6, y: end.y + r * 0.4 }, to: end },
  ];

  return { start, end, route, startNormal, endNormal, clip: 'none' };
}

function routePoints(layout: EdgeLayout): readonly Point[] {
  return [layout.start, ...layout.route.map((seg) => seg.to)];
}

/** Arc length via straight-line distance between successive route points — exact
 *  for the `L`-only routes this fallback itself produces, an approximation for a
 *  curved route an engine returned (DD-06 §4.1 does not require sub-curve
 *  precision). */
function midpointByArcLength(points: readonly Point[]): Point {
  const first = points[0];
  if (points.length < 2 || first === undefined) return first ?? { x: 0, y: 0 };
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    const len = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    lengths.push(len);
    total += len;
  }
  if (total === 0) return first;
  let target = total / 2;
  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i];
    const a = points[i];
    const b = points[i + 1];
    if (len === undefined || a === undefined || b === undefined) continue;
    if (target <= len) {
      const t = len === 0 ? 0 : target / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    target -= len;
  }
  return points[points.length - 1] ?? first;
}

function directionNear(points: readonly Point[], at: Point): { x: number; y: number } {
  let best: { a: Point; b: Point } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    const midx = (a.x + b.x) / 2;
    const midy = (a.y + b.y) / 2;
    const d = (midx - at.x) ** 2 + (midy - at.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = { a, b };
    }
  }
  if (best === null) return { x: 1, y: 0 };
  return unit(best.b.x - best.a.x, best.b.y - best.a.y) ?? { x: 1, y: 0 };
}

/** For a self-loop's teardrop, the outward direction at the apex is simply "away
 *  from the loop's own start point" — there is no other edge geometry to react to. */
function outwardDirection(points: readonly Point[], apex: Point): { x: number; y: number } {
  const start = points[0] ?? apex;
  return unit(apex.x - start.x, apex.y - start.y) ?? { x: 1, y: 0 };
}

function apexOf(points: readonly Point[]): Point {
  const start = points[0];
  if (start === undefined) return { x: 0, y: 0 };
  let best = start;
  let bestDist = -1;
  for (const p of points) {
    const d = (p.x - start.x) ** 2 + (p.y - start.y) ** 2;
    if (d > bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/**
 * Rotate `dir` a quarter turn each way and keep whichever candidate points away
 * from the route's own centroid (DD-06 §4.1). For a straight single-segment route
 * the centroid coincides with the midpoint — genuinely degenerate, since there is
 * no bend to be "away from" — so this falls back to a fixed, deterministic side
 * (rotate direction 90° counter-clockwise). The centroid-avoiding choice matters
 * for a multi-segment (e.g. orthogonal) route, where it is not degenerate.
 */
function awayFromCentroid(
  dir: { x: number; y: number },
  points: readonly Point[],
  at: Point,
): { x: number; y: number } {
  const centroid = centroidOf(points);
  const toCentroid = { x: centroid.x - at.x, y: centroid.y - at.y };
  const candidate = { x: -dir.y, y: dir.x };
  if (toCentroid.x === 0 && toCentroid.y === 0) return candidate;
  const dot = candidate.x * toCentroid.x + candidate.y * toCentroid.y;
  return dot > 0 ? { x: dir.y, y: -dir.x } : candidate;
}

function centroidOf(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}
