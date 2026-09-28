import type { GraphEdge, NodeId, Point, Rect, SemanticGraph, Size } from '@sgl/core';
import type { LayoutInput, NodeLayout, NodeSizing } from '@sgl/layout-api';

/**
 * The spanning forest `tree` and `radial` share (DD-12 §7). Part of the lazy
 * `std-trees` chunk (N52): only the engines' `layout()` reaches it.
 *
 * - **Each container is laid out on its own (N24).** Its visible children
 *   are the nodes of one level; a container is one node there.
 * - **The edges of a level are lifted (N25, N26).** `liftArcs` turns every
 *   visible edge that is not a self-loop into one arc `from -> to` between
 *   the two *children* of the lowest container holding both ends, whatever
 *   the edge's `directed`. An edge between a container and its own
 *   descendant lies under one child at every level, so it makes no arc.
 *   Duplicates collapse, keeping the first in `graph.edges` order.
 * - **The forest is a BFS from the roots, in order (N27).** The roots are
 *   the children with a `@layout.root: true` hint, then those with no
 *   incoming arc, both in declaration order; the BFS runs from all of them
 *   at once, so every node gets its least depth. While a child is still
 *   unreached (it lies in a cycle), the first unreached one in declaration
 *   order becomes a root and the BFS continues from it. A node's parent is
 *   whoever reaches it first; successors are visited in `@order` ascending,
 *   then declaration order (N29), a node without `@order` after those with
 *   one. So cycles and second parents are broken the same way on every run,
 *   with no randomness, and with no diagnostic: a graph that is not a tree
 *   is valid input.
 * - **Explicit stacks and queues, never recursion (N28).**
 */

/** One arc of a level: between two children of the level's container. */
export interface LevelArc {
  readonly from: NodeId;
  readonly to: NodeId;
  /** The first edge (in `graph.edges` order) that made this arc. */
  readonly edge: GraphEdge;
  /** The first edge whose endpoints are the arc's own two nodes, `from` to
   *  `to`, rather than descendants lifted to them: the one a tree arc draws
   *  as an elbow (N34). */
  readonly direct?: GraphEdge;
}

/** The arcs of every level, keyed by the level's container (`null`: the root). */
export function liftArcs(graph: SemanticGraph): Map<NodeId | null, LevelArc[]> {
  const out = new Map<NodeId | null, LevelArc[]>();
  const byPair = new Map<string, { from: NodeId; to: NodeId; edge: GraphEdge; direct?: GraphEdge }>();
  for (const edge of graph.edges) {
    if (edge.hidden) continue;
    let a = graph.nodes[edge.from.node];
    let b = graph.nodes[edge.to.node];
    if (a === undefined || b === undefined || a === b || a.hidden || b.hidden) continue;
    while (a.depth > b.depth) a = graph.nodes[a.parent!]!;
    while (b.depth > a.depth) b = graph.nodes[b.parent!]!;
    if (a === b) continue; // one end is the other's ancestor: one child at every level
    while (a.parent !== b.parent) {
      a = graph.nodes[a.parent!]!;
      b = graph.nodes[b.parent!]!;
    }
    const key = `${a.id}\u0000${b.id}`;
    let arc = byPair.get(key);
    if (arc === undefined) {
      arc = { from: a.id, to: b.id, edge };
      byPair.set(key, arc);
      const level = out.get(a.parent);
      if (level === undefined) out.set(a.parent, [arc]);
      else level.push(arc);
    }
    if (arc.direct === undefined && edge.from.node === a.id && edge.to.node === b.id) arc.direct = edge;
  }
  return out;
}

export interface Forest {
  /** The trees' roots, left to right. */
  readonly roots: readonly NodeId[];
  /** Each node's tree children, in BFS visiting order (`[]` for a leaf). */
  readonly children: ReadonlyMap<NodeId, readonly NodeId[]>;
  /** Each non-root node's tree parent. */
  readonly parent: ReadonlyMap<NodeId, NodeId>;
  /** Each node's depth: 0 for a root. */
  readonly depth: ReadonlyMap<NodeId, number>;
}

/** `@order` as a sort key: a finite number, or after every one that has it. */
function orderKey(graph: SemanticGraph, id: NodeId): number {
  const o = graph.nodes[id]?.config['order'];
  return typeof o === 'number' && Number.isFinite(o) ? o : Number.POSITIVE_INFINITY;
}

/** The spanning forest of one level: `kids` (its visible children, in
 *  declaration order) and `arcs` (`liftArcs`' for that level). */
export function spanningForest(kids: readonly NodeId[], arcs: readonly LevelArc[], graph: SemanticGraph): Forest {
  // By index into `kids` (declaration order), which is also the tie-break.
  const m = kids.length;
  const index = new Map<NodeId, number>();
  for (let i = 0; i < m; i += 1) index.set(kids[i]!, i);
  const succ: number[][] = kids.map(() => []);
  const incoming = new Uint8Array(m);
  for (const arc of arcs) {
    const a = index.get(arc.from);
    const b = index.get(arc.to);
    if (a === undefined || b === undefined) continue;
    succ[a]!.push(b);
    incoming[b] = 1;
  }
  const key = kids.map((id) => orderKey(graph, id));
  for (const list of succ) {
    if (list.length > 1) list.sort((x, y) => (key[x] !== key[y] ? (key[x]! < key[y]! ? -1 : 1) : x - y));
  }

  const roots: NodeId[] = [];
  const children = new Map<NodeId, NodeId[]>();
  const parent = new Map<NodeId, NodeId>();
  const depth = new Map<NodeId, number>();
  const level = new Int32Array(m).fill(-1);
  const queue: number[] = [];
  let head = 0;
  const addRoot = (i: number): void => {
    roots.push(kids[i]!);
    level[i] = 0;
    queue.push(i);
  };
  const bfs = (): void => {
    while (head < queue.length) {
      const v = queue[head++]!;
      const mine: NodeId[] = [];
      children.set(kids[v]!, mine);
      depth.set(kids[v]!, level[v]!);
      for (const w of succ[v]!) {
        if (level[w]! >= 0) continue;
        level[w] = level[v]! + 1;
        parent.set(kids[w]!, kids[v]!);
        mine.push(kids[w]!);
        queue.push(w);
      }
    }
  };

  for (let i = 0; i < m; i += 1) {
    const layout = graph.nodes[kids[i]!]?.config['layout'];
    if (typeof layout === 'object' && layout !== null && (layout as Record<string, unknown>)['root'] === true) addRoot(i);
  }
  for (let i = 0; i < m; i += 1) if (incoming[i] === 0 && level[i]! < 0) addRoot(i);
  bfs();
  for (let i = 0; i < m; i += 1) {
    if (level[i]! >= 0) continue;
    addRoot(i);
    bfs();
  }
  return { roots, children, parent, depth };
}

/* The rest is also shared by `tree` and `radial` (moved from `tree.ts` in
 * B5 branch 5, unchanged): a level's children, a leaf's size, a level's
 * size, and a node's layout. */

/** A level's visible children, in declaration order. */
export function visibleChildren(id: NodeId | null, graph: SemanticGraph): readonly NodeId[] {
  const ids = id === null ? graph.rootChildren : (graph.nodes[id]?.children ?? []);
  return ids.filter((cid) => graph.nodes[cid]?.hidden === false);
}

/** A leaf's size, as `grid`, `fixed` and `elk` size it. */
export function leafSize(sizing: NodeSizing | undefined): Size {
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

/** The size of level `id` whose content is `w × h`: the content itself at
 *  the root; for a container, the content plus padding, at least its `min`,
 *  and as wide as its title plus the content insets (`fixed`'s and `elk`'s
 *  rule). */
export function levelSize(id: NodeId | null, input: LayoutInput, w: number, h: number): Size {
  const sizing = id === null ? undefined : input.sizing[id];
  if (id === null || sizing === undefined) return { w, h };
  const padding = sizing.padding;
  const labelId = input.graph.nodes[id]?.labelId ?? null;
  const title = labelId === null ? undefined : input.labelSizes[labelId];
  const titleW = title === undefined ? 0 : title.w + sizing.contentInset[1] + sizing.contentInset[3];
  return {
    w: Math.max(sizing.min?.w ?? 0, titleW, padding[3] + w + padding[1]),
    h: Math.max(sizing.min?.h ?? 0, padding[0] + h + padding[2]),
  };
}

/** A node's layout at `origin`, with its content frame when it is a laid-out container. */
export function frameOf(id: NodeId, origin: Point, size: Size, input: LayoutInput, container: boolean): NodeLayout {
  const frame: Rect = { x: origin.x, y: origin.y, w: size.w, h: size.h };
  const sizing = input.sizing[id];
  if (!container || sizing === undefined) return { frame };
  const [t, r, b, l] = sizing.padding;
  return { frame, contentFrame: { x: frame.x + l, y: frame.y + t, w: frame.w - l - r, h: frame.h - t - b } };
}
