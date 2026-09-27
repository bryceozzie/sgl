import type { NodeId, Point, Rect, SemanticGraph, Size } from '@sgl/core';
import {
  pinOf,
  type EngineNote,
  type LayoutContext,
  type LayoutEngine,
  type LayoutInput,
  type LayoutResult,
  type NodeLayout,
  type NodeSizing,
} from '@sgl/layout-api';
import { fixedDescriptor } from './descriptor.js';
import { packCells } from './pack.js';
import { placePorts } from './ports.js';

/**
 * `fixed` (DD-12 §4, B5): the escape hatch. Every node with a `@pin` goes
 * where the pin says: the top-left of its frame, relative to the top-left of
 * its parent's content box, or at the root to the diagram's origin (N1, N2,
 * H2). A node without one is packed below its pinned siblings, as `grid`
 * packs (`packCells`, N10: ⌈√n⌉ columns, the `gap` option, aligned to the
 * start), starting one `gap` below the lowest and at the leftmost pin, or at
 * the content origin when no sibling is pinned. Each such node is one
 * `SGL4020` warning, through `LayoutResult.notes` (N9, N11, H1).
 *
 * Post-order over containers, like `grid` (N7): a container's children are
 * placed in its content coordinates, and its size follows from them — the
 * content box runs from `(0, 0)` to the far edge of every child, plus
 * padding, and is at least as wide as its title plus the content insets
 * (N12, `elk`'s rule). A child pinned at a negative offset therefore lies
 * outside its container, which the host's validation reports (`SGL4003`). A
 * container whose children are all hidden is a leaf, as in `elk`. The root
 * has no padding (N13). Then a pre-order pass makes frames absolute.
 *
 * Leaves are sized as `grid` and `elk` size them (N8). Ports are spread on
 * the frame (N15, `placePorts`); edges and labels are the host's (N14, N16).
 *
 * Design: DD-12 §4; DD-06 §7a.
 */
export const fixedEngine: LayoutEngine = {
  ...fixedDescriptor,

  async layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult> {
    const g = ctx.options['gap'];
    const gap = typeof g === 'number' && Number.isFinite(g) && g >= 0 ? g : 24;
    const cache = new Map<NodeId, Placed>();
    const loose = new Set<NodeId>();
    const topId = input.scope;
    const top = placeChildren(topId, input, gap, cache, loose);

    const nodes: Record<NodeId, NodeLayout> = {};
    if (topId !== null) {
      if (input.graph.nodes[topId] === undefined) throw new Error(`fixed: unknown scope '${topId}'.`);
      nodes[topId] = frameOf(topId, { x: 0, y: 0 }, top.size, input, top.items.length > 0);
    }
    place({ x: 0, y: 0 }, top, input, cache, nodes);

    // One note per node without a pin, in declaration order (graph.order is
    // the only safe traversal, 07 §1).
    const notes: EngineNote[] = [];
    for (const id of input.graph.order) {
      const node = input.graph.nodes[id];
      if (node !== undefined && loose.has(id)) notes.push({ code: 'SGL4020', span: node.span, params: { node: id } });
    }

    return {
      bounds: { x: 0, y: 0, w: top.size.w, h: top.size.h },
      nodes,
      edges: {},
      labels: [],
      ...(notes.length > 0 && { notes }),
    };
  },
};

interface PlacedItem {
  readonly id: NodeId;
  /** Relative to the container's frame origin (padding included), as grid's. */
  readonly rel: Point;
  readonly size: Size;
}

interface Placed {
  readonly size: Size;
  readonly items: readonly PlacedItem[];
}

function visibleChildren(id: NodeId | null, graph: SemanticGraph): readonly NodeId[] {
  const ids = id === null ? graph.rootChildren : (graph.nodes[id]?.children ?? []);
  return ids.filter((cid) => graph.nodes[cid]?.hidden === false);
}

/** Post-order: `id`'s children in its content box, and `id`'s own size. */
function placeChildren(id: NodeId | null, input: LayoutInput, gap: number, cache: Map<NodeId, Placed>, loose: Set<NodeId>): Placed {
  const graph = input.graph;
  const kids = visibleChildren(id, graph);
  const sizing = id === null ? undefined : input.sizing[id];
  const padding = sizing?.padding ?? ([0, 0, 0, 0] as const);

  const sizes = kids.map((cid): Size => (visibleChildren(cid, graph).length > 0 ? placeChildren(cid, input, gap, cache, loose).size : leafSize(input.sizing[cid])));

  // Content coordinates: a pin, or the packing below the pinned siblings.
  const content = new Array<Point>(kids.length);
  const unpinned: number[] = [];
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  for (let k = 0; k < kids.length; k += 1) {
    const pin = pinOf(graph.nodes[kids[k]!]!.config);
    if (pin === undefined) {
      unpinned.push(k);
      continue;
    }
    content[k] = pin;
    bottom = Math.max(bottom, pin.y + sizes[k]!.h);
    left = Math.min(left, pin.x);
  }
  if (unpinned.length > 0) {
    const anyPinned = unpinned.length < kids.length;
    const packed = packCells(
      unpinned.map((k) => sizes[k]!),
      Math.ceil(Math.sqrt(unpinned.length)),
      gap,
      'start',
      anyPinned ? left : 0,
      anyPinned ? bottom + gap : 0,
    );
    unpinned.forEach((k, i) => {
      content[k] = packed.positions[i]!;
      loose.add(kids[k]!);
    });
  }

  let contentW = 0;
  let contentH = 0;
  const items: PlacedItem[] = [];
  for (let k = 0; k < kids.length; k += 1) {
    const c = content[k]!;
    const size = sizes[k]!;
    contentW = Math.max(contentW, c.x + size.w);
    contentH = Math.max(contentH, c.y + size.h);
    items.push({ id: kids[k]!, rel: { x: padding[3] + c.x, y: padding[0] + c.y }, size });
  }

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
  const result: Placed = { size, items };
  if (id !== null) cache.set(id, result);
  return result;
}

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
  const node = input.graph.nodes[id]!;
  const frame: Rect = { x: origin.x, y: origin.y, w: size.w, h: size.h };
  const sizing = input.sizing[id];
  const contentFrame =
    container && sizing !== undefined
      ? { x: frame.x + sizing.padding[3], y: frame.y + sizing.padding[0], w: frame.w - sizing.padding[3] - sizing.padding[1], h: frame.h - sizing.padding[0] - sizing.padding[2] }
      : undefined;
  return {
    frame,
    ...(contentFrame !== undefined && { contentFrame }),
    ...(node.ports.length > 0 && { ports: placePorts(frame, node.ports) }),
  };
}

/** Pre-order: absolute frames from each container's placements. `origin` is
 *  the container's frame origin; `rel` already includes its padding. */
function place(origin: Point, placed: Placed, input: LayoutInput, cache: ReadonlyMap<NodeId, Placed>, out: Record<NodeId, NodeLayout>): void {
  for (const item of placed.items) {
    const abs = { x: origin.x + item.rel.x, y: origin.y + item.rel.y };
    const inner = cache.get(item.id);
    out[item.id] = frameOf(item.id, abs, item.size, input, inner !== undefined);
    if (inner !== undefined) place(abs, inner, input, cache, out);
  }
}
