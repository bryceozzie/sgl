import type { GraphNode, NodeId, Rect, SemanticGraph, Size } from '@sgl/core';
import type { LayoutContext, LayoutEngine, LayoutInput, LayoutResult, NodeLayout, NodeSizing } from '@sgl/layout-api';
import { gridDescriptor } from './descriptor.js';
import { packCells } from './pack.js';

/**
 * Deterministic row/column packing. The second engine exists to prove that two
 * engines sit behind one interface, and it is the phase-0 spike engine.
 *
 * It declares `labelPlacement: false` and `edgeRouting: 'straight'` deliberately:
 * the host's fallbacks then do label placement and routing, which exercises the
 * negotiation path that makes third-party engines approachable. Its id, name,
 * capabilities and schemas are `gridDescriptor` (`descriptor.ts`, F20), which the
 * main thread imports on its own.
 *
 * Exit criterion (DD-00 §6): bitwise identical across two runs and across
 * Chrome and Firefox.
 *
 * Design: DD-06 §7.
 */
export const gridEngine: LayoutEngine = {
  ...gridDescriptor,

  // `LayoutEngine.layout` is async by contract; grid's own work is pure and
  // synchronous, so this never actually awaits anything.
  async layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult> {
    const options: GridOptions = {
      columns: ctx.options['columns'] === undefined || ctx.options['columns'] === 'auto' ? 'auto' : Number(ctx.options['columns']),
      gap: typeof ctx.options['gap'] === 'number' ? ctx.options['gap'] : 24,
      align: ctx.options['align'] === 'start' ? 'start' : 'center',
    };

    const cache = new Map<NodeId, PackedContainer>();
    const topId = input.scope;
    const top = pack(topId, input, options, cache);

    const nodes: Record<NodeId, NodeLayout> = {};
    if (topId !== null) {
      const node = input.graph.nodes[topId];
      if (node === undefined) throw new Error(`grid: unknown scope '${topId}'.`);
      nodes[topId] = frameOf({ x: 0, y: 0 }, top.size, node, input.sizing[topId]);
    }
    // `top`'s own items are already relative to its own frame origin — `pack()`'s
    // `colX`/`rowY` start at `padding[3]`/`padding[0]`, not at 0 — so `place` starts
    // from that frame's origin, (0,0) either way here (root has none; `scope`'s own
    // frame was just set to one).
    place({ x: 0, y: 0 }, top, input, cache, nodes);

    return {
      bounds: { x: 0, y: 0, w: top.size.w, h: top.size.h },
      nodes,
      edges: {},
      labels: [],
    };
  },
};

interface GridOptions {
  readonly columns: number | 'auto';
  readonly gap: number;
  readonly align: 'start' | 'center';
}

interface PackedItem {
  readonly id: NodeId;
  /** Relative to the packing container's content origin. */
  readonly rel: { readonly x: number; readonly y: number };
  readonly size: Size;
}

interface PackedContainer {
  readonly size: Size;
  readonly items: readonly PackedItem[];
}

/** Post-order: a container's own size depends on its already-packed children. */
function pack(id: NodeId | null, input: LayoutInput, options: GridOptions, cache: Map<NodeId, PackedContainer>): PackedContainer {
  if (id !== null) {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
  }

  const graph = input.graph;
  const childIds = childrenOf(id, graph);
  const n = childIds.length;

  const itemSizes = childIds.map((cid): Size => {
    const node = graph.nodes[cid];
    if (node === undefined) throw new Error(`grid: unknown node '${cid}'.`);
    return node.children.length > 0 ? pack(cid, input, options, cache).size : leafSize(input.sizing[cid]);
  });

  const sizing = id === null ? undefined : input.sizing[id];
  const padding = sizing?.padding ?? ([0, 0, 0, 0] as const);
  const min = sizing?.min;

  if (n === 0) {
    const size: Size = {
      w: Math.max(min?.w ?? 0, padding[3] + padding[1]),
      h: Math.max(min?.h ?? 0, padding[0] + padding[2]),
    };
    const result: PackedContainer = { size, items: [] };
    if (id !== null) cache.set(id, result);
    return result;
  }

  // `id === null` (root) has no `@layout.columns` hint to read: `compile()` keeps
  // only `model.root.config.title` from the root's config bag, so a root-level
  // `@layout` hint never reaches `SemanticGraph` at all. Out of Stage E's scope —
  // this is `compile()` (DD-03), frozen since Gate 1 — flagged in the stage report.
  const config = id === null ? undefined : graph.nodes[id]?.config;
  const layoutHint = config?.['layout'];
  // `!Array.isArray(x)` cannot narrow a *readonly* array member out of a union
  // (it is not a subtype of the mutable `any[]` the guard excludes), so the
  // runtime check stands on its own and the property read is cast rather than
  // narrowed.
  const hintColumns =
    typeof layoutHint === 'object' && layoutHint !== null && !Array.isArray(layoutHint)
      ? (layoutHint as Readonly<Record<string, unknown>>)['columns']
      : undefined;

  const cols = Math.max(
    1,
    Math.floor(
      typeof hintColumns === 'number'
        ? hintColumns
        : options.columns === 'auto'
          ? Math.ceil(Math.sqrt(n))
          : options.columns,
    ),
  );
  const gap = options.gap;
  // DD-12 N10: the packing itself is `packCells`, shared with `fixed`. It
  // starts at the padding, as this function always did, so the sums are the
  // same and so are the goldens.
  const packed = packCells(itemSizes, cols, gap, options.align, padding[3], padding[0]);

  const items: PackedItem[] = [];
  for (let k = 0; k < n; k += 1) {
    const cid = childIds[k];
    const size = itemSizes[k];
    const rel = packed.positions[k];
    if (cid === undefined || size === undefined || rel === undefined) continue;
    items.push({ id: cid, rel, size });
  }

  const size: Size = {
    w: Math.max(min?.w ?? 0, packed.w + padding[3] + padding[1]),
    h: Math.max(min?.h ?? 0, packed.h + padding[0] + padding[2]),
  };

  const result: PackedContainer = { size, items };
  if (id !== null) cache.set(id, result);
  return result;
}

function childrenOf(id: NodeId | null, graph: SemanticGraph): readonly NodeId[] {
  const ids = id === null ? graph.rootChildren : (graph.nodes[id]?.children ?? []);
  // F1 (07 §2.1): `children`/`rootChildren` list hidden nodes; only `order` filters
  // them. A container-packing consumer must filter itself.
  return ids.filter((cid) => graph.nodes[cid]?.hidden !== true);
}

function leafSize(sizing: NodeSizing | undefined): Size {
  if (sizing === undefined) return { w: 0, h: 0 };
  const w = sizing.fixed?.w ?? clamp(sizing.intrinsic.w, sizing.min?.w, sizing.max?.w);
  const h = sizing.fixed?.h ?? clamp(sizing.intrinsic.h, sizing.min?.h, sizing.max?.h);
  return { w, h };
}

function clamp(v: number, min: number | undefined, max: number | undefined): number {
  let out = v;
  if (min !== undefined) out = Math.max(out, min);
  if (max !== undefined) out = Math.min(out, max);
  return out;
}

function frameOf(origin: { readonly x: number; readonly y: number }, size: Size, node: GraphNode, sizing: NodeSizing | undefined): NodeLayout {
  const frame: Rect = { x: origin.x, y: origin.y, w: size.w, h: size.h };
  if (node.children.length === 0 || sizing === undefined) return { frame };
  const [t, r, b, l] = sizing.padding;
  const contentFrame: Rect = { x: frame.x + l, y: frame.y + t, w: frame.w - l - r, h: frame.h - t - b };
  return { frame, contentFrame };
}

/** Pre-order: assign absolute frames from each container's already-packed relative
 *  placements. `origin` is the container's own **frame** origin, not its content
 *  origin — `pack()`'s `colX`/`rowY` already start at `padding[3]`/`padding[0]`, so
 *  `item.rel` is relative to the frame, and adding a content-origin offset here on
 *  top of that would double-count the padding. `cache` is the same map `pack()`
 *  filled bottom-up from the single top-level call in `layout()` — every container
 *  in scope is already in it, so this never re-packs. */
function place(
  origin: { readonly x: number; readonly y: number },
  packed: PackedContainer,
  input: LayoutInput,
  cache: ReadonlyMap<NodeId, PackedContainer>,
  out: Record<NodeId, NodeLayout>,
): void {
  for (const item of packed.items) {
    const abs = { x: origin.x + item.rel.x, y: origin.y + item.rel.y };
    const node = input.graph.nodes[item.id];
    if (node === undefined) continue;
    const sizing = input.sizing[item.id];
    const layout = frameOf(abs, item.size, node, sizing);
    out[item.id] = layout;
    if (node.children.length > 0 && sizing !== undefined) {
      const childPacked = cache.get(item.id);
      if (childPacked !== undefined) place(abs, childPacked, input, cache, out);
    }
  }
}
