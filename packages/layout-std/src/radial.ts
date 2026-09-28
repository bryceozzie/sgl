import type { EdgeId, NodeId, Point, Size } from '@sgl/core';
import type { EdgeLayout, LayoutContext, LayoutInput, LayoutResult, NodeLayout } from '@sgl/layout-api';
import { radialDescriptor } from './descriptor.js';
import { frameOf, leafSize, levelSize, liftArcs, spanningForest, visibleChildren, type LevelArc } from './forest.js';
import { cosTurn, sinTurn } from './trig.js';

/**
 * `radial`'s layout (DD-12 §9), in the lazy `std-trees` chunk (N52), beside
 * `tree`'s: the worker's `radialEngine` (`lazy.ts`) loads it on its first
 * request.
 *
 * - **Each container on its own, post-order (N45, N24),** over the spanning
 *   forest of its visible children (`forest.ts`: lifted arcs, BFS from the
 *   `@layout.root` hints and the nodes with no incoming arc, cycles broken
 *   the same way on every run). A container is one node of its parent's
 *   rings, sized from its own layout plus padding, and at least as wide as
 *   its title plus the content insets.
 * - **A wedge layout (Eades 1992, N41)** per tree. A node's weight is the
 *   sum, over the leaves under it, of `diag(leaf) + nodeSpacing`, `diag`
 *   being the frame's diagonal (never zero: fix round 1, item 1). The root's
 *   wedge is `[0, 1)` turn and its children split it; a non-root node's
 *   children split at most half a turn, centred on its own angle (Eades'
 *   bound, fix round 1, item 2), so a subtree fans away from the centre.
 *   Shares are in proportion to the weights, in BFS order.
 *   A node sits at the middle `α` of its wedge on ring `k` = its depth:
 *   centre `(R_k·sin 2πα, −R_k·cos 2πα)`, so angle 0 is 12 o'clock and
 *   angles run clockwise.
 * - **The smallest rings that fit (N42).** `R_0 = 0`; for `k ≥ 1`, `R_k` is
 *   the larger of `R_{k−1} + (E_{k−1} + E_k)/2 + gap` (`E_k` the
 *   largest diagonal on ring `k`) and, for each node `v` on ring `k`,
 *   `(diag(v) + nodeSpacing) / (2·sin(π·min(θ_v, ½)))` (`θ_v` its wedge's
 *   width). So each node's bounding circle, grown by `nodeSpacing / 2`,
 *   stays inside its own wedge, and neighbouring rings' circles are
 *   `gap` apart: no two nodes overlap. `gap` is `rankSpacing`, but at least
 *   `2 × arrowSize + 8` (fix round 1, item 6, as `tree`'s bands), so every
 *   spoke has room for its arrowhead. Eades' further limit on
 *   children's wedges (against crossings between subtrees) is left out of
 *   v1, as DD-12 says.
 * - **A forest is a row of discs (N43),** in their roots' declaration order,
 *   top-aligned, `nodeSpacing` apart; an isolated node is a disc of its own.
 * - **Edges and labels are the host's (N46):** straight spokes, and the host
 *   places the labels. No ports.
 * - **`bitwise` (N44, H8):** `+ - * /`, `max`, `min` and `Math.sqrt`, which
 *   ECMAScript specifies exactly, and `trig.ts`'s `sinTurn`/`cosTurn`, which
 *   use only those. Never `Math.sin`/`Math.cos`; no `ctx.random`. Every walk
 *   is a loop over a BFS order, never recursion (N28).
 */

export interface RadialOptions {
  readonly nodeSpacing: number;
  readonly rankSpacing: number;
}

/** Every field filled from an untrusted bag: a value the schema allows is
 *  kept, anything else is the descriptor's default (N47; fix round 1,
 *  item 8: read from its schema, not repeated here). */
export function normalizeRadialOptions(options: Readonly<Record<string, unknown>>): RadialOptions {
  const props = (radialDescriptor.optionsSchema as { readonly properties: Readonly<Record<string, { readonly default: number }>> }).properties;
  const spacing = (key: string): number => {
    const v = options[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : props[key]!.default;
  };
  return { nodeSpacing: spacing('nodeSpacing'), rankSpacing: spacing('rankSpacing') };
}

/** The share of a turn a non-root node's children may span, centred on its
 *  own angle (Eades' bound; fix round 1, item 2). */
const CHILD_SPAN = 0.5;

interface PlacedItem {
  readonly id: NodeId;
  /** Relative to the container's frame origin (its padding included). */
  readonly rel: Point;
  readonly size: Size;
}

interface Placed {
  readonly size: Size;
  readonly items: readonly PlacedItem[];
}

export function layoutRadial(input: LayoutInput, ctx: LayoutContext): LayoutResult {
  const options = normalizeRadialOptions(ctx.options);
  const graph = input.graph;
  const topId = input.scope;
  if (topId !== null && graph.nodes[topId] === undefined) throw new Error(`radial: unknown scope '${topId}'.`);
  const arcs = liftArcs(graph);
  // Fix round 1, item 6: as `tree`'s bands, rings at least 2 × arrowSize + 8
  // apart, so every spoke has room for its arrowhead.
  const arrow = ctx.metrics.arrowSize;
  const gap = Math.max(options.rankSpacing, 2 * (Number.isFinite(arrow) && arrow > 0 ? arrow : 0) + 8);

  // Post-order without recursion (N28): graph.order is pre-order, so a
  // container comes after every container inside it once reversed.
  const placed = new Map<NodeId, Placed>();
  for (let i = graph.order.length - 1; i >= 0; i -= 1) {
    const id = graph.order[i]!;
    if (visibleChildren(id, graph).length > 0) placed.set(id, placeLevel(id, input, options.nodeSpacing, gap, arcs.get(id) ?? [], placed));
  }
  const top = topId === null ? placeLevel(null, input, options.nodeSpacing, gap, arcs.get(null) ?? [], placed) : placed.get(topId) ?? { size: leafSize(input.sizing[topId]), items: [] };

  const nodes: Record<NodeId, NodeLayout> = {};
  if (topId !== null) nodes[topId] = frameOf(topId, { x: 0, y: 0 }, top.size, input, top.items.length > 0);
  const stack: [Point, Placed][] = [[{ x: 0, y: 0 }, top]];
  while (stack.length > 0) {
    const [origin, level] = stack.pop()!;
    for (const item of level.items) {
      const abs = { x: origin.x + item.rel.x, y: origin.y + item.rel.y };
      const inner = placed.get(item.id);
      nodes[item.id] = frameOf(item.id, abs, item.size, input, inner !== undefined);
      if (inner !== undefined) stack.push([abs, inner]);
    }
  }
  const edges: Record<EdgeId, EdgeLayout> = {};
  return { bounds: { x: 0, y: 0, w: top.size.w, h: top.size.h }, nodes, edges, labels: [] };
}

/** One level: `id`'s children as a row of discs in its content box, and `id`'s size. */
function placeLevel(id: NodeId | null, input: LayoutInput, spacing: number, gap: number, levelArcs: readonly LevelArc[], placed: ReadonlyMap<NodeId, Placed>): Placed {
  const graph = input.graph;
  const kids = visibleChildren(id, graph);
  const padding = (id === null ? undefined : input.sizing[id])?.padding ?? ([0, 0, 0, 0] as const);
  const forest = spanningForest(kids, levelArcs, graph);

  const sizeOf = new Map<NodeId, Size>();
  const diagOf = new Map<NodeId, number>();
  for (const kid of kids) {
    const size = placed.get(kid)?.size ?? leafSize(input.sizing[kid]);
    sizeOf.set(kid, size);
    diagOf.set(kid, Math.sqrt(size.w * size.w + size.h * size.h));
  }

  // One disc per tree: each node's frame origin relative to its root's
  // centre, and the disc's bounding box.
  const corner = new Map<NodeId, Point>();
  const discs: { root: NodeId; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const root of forest.roots) {
    // BFS order: parents before children, children in their wedge order.
    const order: NodeId[] = [root];
    for (let i = 0; i < order.length; i += 1) order.push(...(forest.children.get(order[i]!) ?? []));

    // Weights, children first (N41). Fix round 1, item 1: never zero, so no
    // wedge is empty. A subtree whose leaves weigh nothing (zero-size, at
    // nodeSpacing 0) weighs its own node's diag + nodeSpacing, or 1 when
    // that is zero too.
    const weight = new Map<NodeId, number>();
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const v = order[i]!;
      const children = forest.children.get(v) ?? [];
      let w = 0;
      if (children.length === 0) w = diagOf.get(v)! + spacing;
      else for (const c of children) w += weight.get(c)!;
      weight.set(v, w > 0 ? w : diagOf.get(v)! + spacing || 1);
    }

    // Wedges, parents first: each child's share of the span its parent's
    // children get. Fix round 1, item 2 (Eades' bound): the root's children
    // span the whole turn; a non-root node's at most CHILD_SPAN, centred on
    // its own angle (the middle of its wedge), so a subtree fans away from
    // the centre instead of wrapping round it. The span is inside the
    // node's wedge, so wedges at one depth stay disjoint.
    const start = new Map<NodeId, number>([[root, 0]]);
    const width = new Map<NodeId, number>([[root, 1]]);
    for (const v of order) {
      const children = forest.children.get(v) ?? [];
      const total = weight.get(v)!;
      const span = v === root ? 1 : Math.min(width.get(v)!, CHILD_SPAN);
      let at = v === root ? 0 : start.get(v)! + (width.get(v)! - span) / 2;
      for (const c of children) {
        const wc = span * (weight.get(c)! / total);
        start.set(c, at);
        width.set(c, wc);
        at += wc;
      }
    }

    // Rings (N42): the ring gap, and each node's room in its wedge.
    const depth = (v: NodeId): number => forest.depth.get(v)!; // 0 at every root
    const rings = depth(order[order.length - 1]!) + 1;
    const extent = new Float64Array(rings);
    const needed = new Float64Array(rings);
    for (const v of order) {
      const k = depth(v);
      const d = diagOf.get(v)!;
      extent[k] = Math.max(extent[k]!, d);
      if (k === 0 || d + spacing === 0) continue;
      needed[k] = Math.max(needed[k]!, (d + spacing) / (2 * sinTurn(Math.min(width.get(v)!, 0.5) / 2)));
    }
    const radius = new Float64Array(rings);
    for (let k = 1; k < rings; k += 1) radius[k] = Math.max(radius[k - 1]! + (extent[k - 1]! + extent[k]!) / 2 + gap, needed[k]!);

    const disc = { root, x0: Number.POSITIVE_INFINITY, y0: Number.POSITIVE_INFINITY, x1: Number.NEGATIVE_INFINITY, y1: Number.NEGATIVE_INFINITY };
    for (const v of order) {
      const r = radius[depth(v)]!;
      const alpha = start.get(v)! + width.get(v)! / 2;
      // `0 - …` so the root's centre is (0, 0), not (0, -0).
      const size = sizeOf.get(v)!;
      const at = { x: r * sinTurn(alpha) - size.w / 2, y: 0 - r * cosTurn(alpha) - size.h / 2 };
      corner.set(v, at);
      disc.x0 = Math.min(disc.x0, at.x);
      disc.y0 = Math.min(disc.y0, at.y);
      disc.x1 = Math.max(disc.x1, at.x + size.w);
      disc.y1 = Math.max(disc.y1, at.y + size.h);
    }
    discs.push(disc);
  }

  // N43: the discs in a row, in their roots' declaration order, top-aligned,
  // `nodeSpacing` apart. A disc's shift puts its left-most and top-most
  // frames exactly at the row's cursor and at 0.
  const index = new Map(kids.map((kid, i) => [kid, i]));
  discs.sort((a, b) => index.get(a.root)! - index.get(b.root)!);
  const shift = new Map<NodeId, Point>();
  let x = 0;
  for (const disc of discs) {
    shift.set(disc.root, { x: x - disc.x0, y: 0 - disc.y0 });
    x += disc.x1 - disc.x0 + spacing;
  }

  // The root of each node's tree, for its disc's shift.
  const rootOf = new Map<NodeId, NodeId>();
  for (const root of forest.roots) rootOf.set(root, root);
  for (const root of forest.roots) {
    const queue = [root];
    for (let i = 0; i < queue.length; i += 1) {
      for (const c of forest.children.get(queue[i]!) ?? []) {
        rootOf.set(c, root);
        queue.push(c);
      }
    }
  }

  // Declaration order, so the frames are emitted as the other engines emit them.
  // The content's size is its frames' extent, so it matches them exactly.
  const items: PlacedItem[] = [];
  let contentW = 0;
  let contentH = 0;
  for (const kid of kids) {
    const size = sizeOf.get(kid)!;
    const at = corner.get(kid)!;
    const s = shift.get(rootOf.get(kid)!)!;
    const rel = { x: s.x + at.x, y: s.y + at.y };
    contentW = Math.max(contentW, rel.x + size.w);
    contentH = Math.max(contentH, rel.y + size.h);
    items.push({ id: kid, rel: { x: padding[3] + rel.x, y: padding[0] + rel.y }, size });
  }
  return { size: levelSize(id, input, contentW, contentH), items };
}
