import type { EdgeId, GraphEdge, NodeId, PathSeg, Point, Rect, SemanticGraph, Size } from '@sgl/core';
import {
  anchorPoint,
  centreOf,
  type EdgeLayout,
  type LayoutContext,
  type LayoutInput,
  type LayoutResult,
  type NodeLayout,
  type NodeSizing,
} from '@sgl/layout-api';
import { liftArcs, spanningForest, type LevelArc } from './forest.js';

/**
 * `tree`'s layout (DD-12 §8), in the lazy `std-trees` chunk (N52): the
 * worker's `treeEngine` (`lazy.ts`) loads it on its first request.
 *
 * - **Each container on its own, post-order (N24).** A container's visible
 *   children form one level: `forest.ts` lifts the edges to them (N25) and
 *   breaks cycles and second parents by a BFS (N27). The container is then
 *   one node of its parent's level, sized from its own layout plus padding,
 *   and at least as wide as its title plus the content insets (`fixed`'s
 *   and `elk`'s rule). A container whose children are all hidden is a leaf.
 * - **Buchheim, Jünger and Leipert (2002), N30**: Walker's tidy tree in
 *   linear time, for nodes of any size. Adjacent contours are kept
 *   `(s(a) + s(b)) / 2 + nodeSpacing` apart, where `s` is a node's breadth
 *   (its width for `down`/`up`, its height for `left`/`right`). A forest is
 *   the children of a virtual root whose own position is discarded, so its
 *   trees sit side by side, `nodeSpacing` apart. Every walk uses an explicit
 *   stack (N28).
 * - **Levels are bands (N31)**, `rankSpacing` apart, each as deep as its
 *   deepest node; a node is centred in its band.
 * - **The direction is applied last (N32)**: an axis swap for `left`/`right`,
 *   a flip for `up`/`left`. A container's own `@direction` (its
 *   `layout.direction` hint) applies to its subtree (N38); otherwise its
 *   parent's does, and at the root the `direction` option.
 * - **Elbows (N34).** A tree arc drawn by an edge between its own two nodes
 *   (not descendants lifted to them) is routed from the parent's outline down
 *   its centre line, across the middle of the gap between the two bands, and
 *   down the child's centre line to its outline. `finishEngineRoutes`
 *   reserves the arrowhead. Every other edge is left to the host's straight
 *   routing, as are all edges under `edgeRouting: straight`. Labels are the
 *   host's (N35); no ports (N36).
 * - **`bitwise` (N33)**: `+ - * /`, `max` and `min`, which ECMAScript
 *   specifies exactly. No trigonometry, no `ctx.random`.
 */

type Direction = 'down' | 'up' | 'left' | 'right';

export interface TreeOptions {
  readonly direction: Direction;
  readonly nodeSpacing: number;
  readonly rankSpacing: number;
  readonly edgeRouting: 'orthogonal' | 'straight';
}

const isDirection = (v: unknown): v is Direction => v === 'down' || v === 'up' || v === 'left' || v === 'right';

/** Every field filled from an untrusted bag: a value the schema allows is
 *  kept, anything else is the default (N37). */
export function normalizeTreeOptions(options: Readonly<Record<string, unknown>>): TreeOptions {
  const spacing = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  const d = options['direction'];
  return {
    direction: isDirection(d) ? d : 'down',
    nodeSpacing: spacing(options['nodeSpacing'], 40),
    rankSpacing: spacing(options['rankSpacing'], 70),
    edgeRouting: options['edgeRouting'] === 'straight' ? 'straight' : 'orthogonal',
  };
}

interface PlacedItem {
  readonly id: NodeId;
  /** Relative to the container's frame origin (its padding included). */
  readonly rel: Point;
  readonly size: Size;
}

/** An elbow to route once frames are absolute: the tree arc's edge, and the
 *  middle of the gap between its two bands, on the depth axis, relative to
 *  the container's frame origin. */
interface Elbow {
  readonly edge: GraphEdge;
  readonly mid: number;
  readonly direction: Direction;
}

interface Placed {
  readonly size: Size;
  readonly items: readonly PlacedItem[];
  readonly elbows: readonly Elbow[];
}

export function layoutTree(input: LayoutInput, ctx: LayoutContext): LayoutResult {
  const options = normalizeTreeOptions(ctx.options);
  const graph = input.graph;
  const topId = input.scope;
  if (topId !== null && graph.nodes[topId] === undefined) throw new Error(`tree: unknown scope '${topId}'.`);
  const arcs = liftArcs(graph);

  // Each container's direction, pre-order: its own hint, else its parent's (N38).
  const directionOf = new Map<NodeId | null, Direction>([[null, options.direction]]);
  for (const id of graph.order) {
    const node = graph.nodes[id]!;
    const layout = node.config['layout'];
    const own = typeof layout === 'object' && layout !== null ? (layout as Record<string, unknown>)['direction'] : undefined;
    directionOf.set(id, isDirection(own) ? own : directionOf.get(node.parent)!);
  }

  // Post-order without recursion (N28): graph.order is pre-order, so a
  // container comes after every container inside it once reversed.
  const placed = new Map<NodeId, Placed>();
  for (let i = graph.order.length - 1; i >= 0; i -= 1) {
    const id = graph.order[i]!;
    if (visibleChildren(id, graph).length > 0) placed.set(id, placeLevel(id, input, options, directionOf.get(id)!, arcs.get(id) ?? [], placed));
  }
  const top = topId === null ? placeLevel(null, input, options, options.direction, arcs.get(null) ?? [], placed) : placed.get(topId) ?? { size: leafSize(input.sizing[topId]), items: [], elbows: [] };

  const nodes: Record<NodeId, NodeLayout> = {};
  const edges: Record<EdgeId, EdgeLayout> = {};
  if (topId !== null) nodes[topId] = frameOf(topId, { x: 0, y: 0 }, top.size, input, top.items.length > 0);
  // Pre-order: absolute frames, then each level's elbows.
  const stack: [Point, Placed][] = [[{ x: 0, y: 0 }, top]];
  while (stack.length > 0) {
    const [origin, level] = stack.pop()!;
    for (const item of level.items) {
      const abs = { x: origin.x + item.rel.x, y: origin.y + item.rel.y };
      const inner = placed.get(item.id);
      nodes[item.id] = frameOf(item.id, abs, item.size, input, inner !== undefined);
      if (inner !== undefined) stack.push([abs, inner]);
    }
    for (const elbow of level.elbows) edges[elbow.edge.id] = elbowRoute(elbow, origin, graph, nodes);
  }

  return { bounds: { x: 0, y: 0, w: top.size.w, h: top.size.h }, nodes, edges, labels: [] };
}

function visibleChildren(id: NodeId | null, graph: SemanticGraph): readonly NodeId[] {
  const ids = id === null ? graph.rootChildren : (graph.nodes[id]?.children ?? []);
  return ids.filter((cid) => graph.nodes[cid]?.hidden === false);
}

/** One level: `id`'s children as a tidy forest in its content box, and `id`'s size. */
function placeLevel(
  id: NodeId | null,
  input: LayoutInput,
  options: TreeOptions,
  direction: Direction,
  levelArcs: readonly LevelArc[],
  placed: ReadonlyMap<NodeId, Placed>,
): Placed {
  const graph = input.graph;
  const kids = visibleChildren(id, graph);
  const sizing = id === null ? undefined : input.sizing[id];
  const padding = sizing?.padding ?? ([0, 0, 0, 0] as const);
  const vertical = direction === 'down' || direction === 'up';
  const flip = direction === 'up' || direction === 'left';

  const forest = spanningForest(kids, levelArcs, graph);

  // Index the forest: 0 is the virtual root; BFS order from the roots.
  const ids: (NodeId | null)[] = [null];
  const childIdx: number[][] = [[]];
  const parent: number[] = [-1];
  const order = new Map<NodeId, number>();
  for (const r of forest.roots) {
    order.set(r, ids.length);
    childIdx[0]!.push(ids.length);
    ids.push(r);
    childIdx.push([]);
    parent.push(0);
  }
  for (let v = 1; v < ids.length; v += 1) {
    for (const c of forest.children.get(ids[v]!) ?? []) {
      order.set(c, ids.length);
      childIdx[v]!.push(ids.length);
      ids.push(c);
      childIdx.push([]);
      parent.push(v);
    }
  }

  const n = ids.length;
  const sizes = new Array<Size>(n);
  sizes[0] = { w: 0, h: 0 };
  const breadth = new Float64Array(n);
  const depthExtent = new Float64Array(n);
  for (let v = 1; v < n; v += 1) {
    const nid = ids[v]!;
    const size = placed.get(nid)?.size ?? leafSize(input.sizing[nid]);
    sizes[v] = size;
    breadth[v] = vertical ? size.w : size.h;
    depthExtent[v] = vertical ? size.h : size.w;
  }

  const centre = buchheim(childIdx, parent, breadth, options.nodeSpacing);

  // Levels are bands (N31): level k starts at Σ_{j<k} (T_j + rankSpacing).
  const level = new Int32Array(n);
  let levels = 0;
  for (let v = 1; v < n; v += 1) {
    level[v] = forest.depth.get(ids[v]!)!;
    levels = Math.max(levels, level[v]! + 1);
  }
  const band = new Float64Array(levels);
  for (let v = 1; v < n; v += 1) band[level[v]!] = Math.max(band[level[v]!]!, depthExtent[v]!);
  const offset = new Float64Array(levels);
  let total = 0;
  for (let k = 0; k < levels; k += 1) {
    offset[k] = total;
    total += band[k]! + (k < levels - 1 ? options.rankSpacing : 0);
  }

  // The direction last (N32): breadth and depth, flipped for up and left,
  // swapped for left and right; then the content box re-based at (0, 0).
  const depthAt = new Float64Array(n);
  let minB = Number.POSITIVE_INFINITY;
  let minD = Number.POSITIVE_INFINITY;
  for (let v = 1; v < n; v += 1) {
    const t = depthExtent[v]!;
    const top = offset[level[v]!]! + (band[level[v]!]! - t) / 2;
    depthAt[v] = flip ? total - top - t : top;
    minB = Math.min(minB, centre[v]! - breadth[v]! / 2);
    minD = Math.min(minD, depthAt[v]!);
  }
  let spanB = 0;
  let spanD = 0;
  const items: PlacedItem[] = [];
  const content = new Array<Point>(n);
  for (let v = 1; v < n; v += 1) {
    const b = centre[v]! - breadth[v]! / 2 - minB;
    const d = depthAt[v]! - minD;
    spanB = Math.max(spanB, b + breadth[v]!);
    spanD = Math.max(spanD, d + depthExtent[v]!);
    content[v] = vertical ? { x: b, y: d } : { x: d, y: b };
  }
  // Declaration order, so the frames are emitted as grid and fixed emit them.
  for (const kid of kids) {
    const v = order.get(kid)!;
    items.push({ id: kid, rel: { x: padding[3] + content[v]!.x, y: padding[0] + content[v]!.y }, size: sizes[v]! });
  }

  // N34: the elbow of each tree arc drawn by its own two nodes.
  const elbows: Elbow[] = [];
  if (options.edgeRouting === 'orthogonal') {
    for (const arc of levelArcs) {
      if (arc.direct === undefined || forest.parent.get(arc.to) !== arc.from) continue;
      const k = level[order.get(arc.to)!]!;
      const mid = offset[k]! - options.rankSpacing / 2;
      elbows.push({ edge: arc.direct, mid: (vertical ? padding[0] : padding[3]) + (flip ? total - mid : mid) - minD, direction });
    }
  }

  const contentW = vertical ? spanB : spanD;
  const contentH = vertical ? spanD : spanB;
  let size: Size = { w: contentW, h: contentH };
  if (id !== null && sizing !== undefined) {
    const labelId = graph.nodes[id]?.labelId ?? null;
    const title = labelId === null ? undefined : input.labelSizes[labelId];
    const titleW = title === undefined ? 0 : title.w + sizing.contentInset[1] + sizing.contentInset[3];
    size = {
      w: Math.max(sizing.min?.w ?? 0, titleW, padding[3] + contentW + padding[1]),
      h: Math.max(sizing.min?.h ?? 0, padding[0] + contentH + padding[2]),
    };
  }
  return { size, items, elbows };
}

/**
 * Buchheim, Jünger and Leipert's linear-time Walker (N30), for breadths that
 * vary, over `children` (index 0 the virtual root). Returns each node's
 * breadth centre. Both walks use explicit stacks (N28).
 */
function buchheim(children: readonly (readonly number[])[], parent: readonly number[], breadth: Float64Array, spacing: number): Float64Array {
  const n = children.length;
  const prelim = new Float64Array(n);
  const mod = new Float64Array(n);
  const shift = new Float64Array(n);
  const change = new Float64Array(n);
  const thread = new Int32Array(n).fill(-1);
  const ancestor = new Int32Array(n);
  const number = new Int32Array(n);
  const defaultAncestor = new Int32Array(n);
  for (let v = 0; v < n; v += 1) {
    ancestor[v] = v;
    const kids = children[v]!;
    for (let i = 0; i < kids.length; i += 1) number[kids[i]!] = i;
  }
  const sep = (a: number, b: number): number => (breadth[a]! + breadth[b]!) / 2 + spacing;
  const leftSibling = (v: number): number => (parent[v]! < 0 || number[v] === 0 ? -1 : children[parent[v]!]![number[v]! - 1]!);
  const nextLeft = (v: number): number => children[v]![0] ?? thread[v]!;
  const nextRight = (v: number): number => children[v]![children[v]!.length - 1] ?? thread[v]!;

  const moveSubtree = (wl: number, wr: number, s: number): void => {
    const subtrees = number[wr]! - number[wl]!;
    change[wr] = change[wr]! - s / subtrees;
    shift[wr] = shift[wr]! + s;
    change[wl] = change[wl]! + s / subtrees;
    prelim[wr] = prelim[wr]! + s;
    mod[wr] = mod[wr]! + s;
  };

  const apportion = (v: number, da: number): number => {
    const w = leftSibling(v);
    if (w < 0) return da;
    let vir = v;
    let vor = v;
    let vil = w;
    let vol = children[parent[v]!]![0]!;
    let sir = mod[vir]!;
    let sor = mod[vor]!;
    let sil = mod[vil]!;
    let sol = mod[vol]!;
    while (nextRight(vil) >= 0 && nextLeft(vir) >= 0) {
      vil = nextRight(vil);
      vir = nextLeft(vir);
      vol = nextLeft(vol);
      vor = nextRight(vor);
      ancestor[vor] = v;
      const s = prelim[vil]! + sil - (prelim[vir]! + sir) + sep(vil, vir);
      if (s > 0) {
        const a = parent[ancestor[vil]!] === parent[v] ? ancestor[vil]! : da;
        moveSubtree(a, v, s);
        sir += s;
        sor += s;
      }
      sil += mod[vil]!;
      sir += mod[vir]!;
      sol += mod[vol]!;
      sor += mod[vor]!;
    }
    if (nextRight(vil) >= 0 && nextRight(vor) < 0) {
      thread[vor] = nextRight(vil);
      mod[vor] = mod[vor]! + sil - sor;
    }
    if (nextLeft(vir) >= 0 && nextLeft(vol) < 0) {
      thread[vol] = nextLeft(vir);
      mod[vol] = mod[vol]! + sir - sol;
      return v;
    }
    return da;
  };

  // First walk, post-order. Each child is apportioned as soon as its own
  // subtree is finished, before its right sibling's subtree is walked: the
  // order of the recursive original.
  const next = new Int32Array(n);
  const stack = [0];
  while (stack.length > 0) {
    const v = stack[stack.length - 1]!;
    const kids = children[v]!;
    if (next[v]! < kids.length) {
      if (next[v] === 0) defaultAncestor[v] = kids[0]!;
      stack.push(kids[next[v]!]!);
      next[v] = next[v]! + 1;
      continue;
    }
    stack.pop();
    const w = leftSibling(v);
    if (kids.length === 0) {
      prelim[v] = w < 0 ? 0 : prelim[w]! + sep(w, v);
    } else {
      // Execute the shifts, right to left.
      let s = 0;
      let c = 0;
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        const k = kids[i]!;
        prelim[k] = prelim[k]! + s;
        mod[k] = mod[k]! + s;
        c += change[k]!;
        s += shift[k]! + c;
      }
      const mid = (prelim[kids[0]!]! + prelim[kids[kids.length - 1]!]!) / 2;
      if (w < 0) prelim[v] = mid;
      else {
        prelim[v] = prelim[w]! + sep(w, v);
        mod[v] = prelim[v]! - mid;
      }
    }
    const p = parent[v]!;
    if (p >= 0) defaultAncestor[p] = apportion(v, defaultAncestor[p]!);
  }

  // Second walk, pre-order: sum the modifiers.
  const x = new Float64Array(n);
  const walk: [number, number][] = [[0, 0]];
  while (walk.length > 0) {
    const [v, m] = walk.pop()!;
    x[v] = prelim[v]! + m;
    for (const c of children[v]!) walk.push([c, m + mod[v]!]);
  }
  return x;
}

/** A leaf's size, as `grid`, `fixed` and `elk` size it. */
function leafSize(sizing: NodeSizing | undefined): Size {
  if (sizing === undefined) return { w: 0, h: 0 };
  return {
    w: sizing.fixed?.w ?? clamp(sizing.intrinsic.w, sizing.min?.w, sizing.max?.w),
    h: sizing.fixed?.h ?? clamp(sizing.intrinsic.h, sizing.min?.h, sizing.max?.h),
  };
}

function clamp(v: number, min: number | undefined, max: number | undefined): number {
  let out = v;
  if (min !== undefined) out = Math.max(out, min);
  if (max !== undefined) out = Math.min(out, max);
  return out;
}

function frameOf(id: NodeId, origin: Point, size: Size, input: LayoutInput, container: boolean): NodeLayout {
  const frame: Rect = { x: origin.x, y: origin.y, w: size.w, h: size.h };
  const sizing = input.sizing[id];
  if (!container || sizing === undefined) return { frame };
  const [t, r, b, l] = sizing.padding;
  return { frame, contentFrame: { x: frame.x + l, y: frame.y + t, w: frame.w - l - r, h: frame.h - t - b } };
}

/** The elbow of a tree arc (N34), `down`: from the parent's outline straight
 *  down its centre line to the middle of the gap between the bands, across
 *  to the child's centre line, and down to the child's outline. A
 *  zero-length segment is dropped. The ends are on each shape's outline
 *  (`anchorPoint` along the centre line). */
function elbowRoute(elbow: Elbow, origin: Point, graph: SemanticGraph, nodes: Readonly<Record<NodeId, NodeLayout>>): EdgeLayout {
  const { edge, direction } = elbow;
  const from = nodes[edge.from.node]!.frame;
  const to = nodes[edge.to.node]!.frame;
  const vertical = direction === 'down' || direction === 'up';
  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  const v = vertical ? { x: 0, y: sign } : { x: sign, y: 0 };
  const pc = centreOf(from);
  const cc = centreOf(to);
  const start = anchorPoint(graph.nodes[edge.from.node]!.shape, from, { x: pc.x + v.x, y: pc.y + v.y });
  const end = anchorPoint(graph.nodes[edge.to.node]!.shape, to, { x: cc.x - v.x, y: cc.y - v.y });
  const mid = (vertical ? origin.y : origin.x) + elbow.mid;
  const points: Point[] = vertical
    ? [{ x: pc.x, y: mid }, { x: cc.x, y: mid }, end]
    : [{ x: mid, y: pc.y }, { x: mid, y: cc.y }, end];
  const route: PathSeg[] = [];
  let at = start;
  for (const p of points) {
    if (p.x === at.x && p.y === at.y) continue;
    route.push({ t: 'L', to: p });
    at = p;
  }
  return { start, end, route, startNormal: { x: -v.x, y: -v.y }, endNormal: v, clip: 'none' };
}
