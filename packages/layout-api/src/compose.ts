/**
 * `@sgl/layout-api/compose` — per-container layout engines, composed by the
 * host (B8; DD-14 C23, ADR-0002's amendment of 2026-09-28).
 *
 * A container the plan names is a **boundary**: its engine lays out the
 * container and everything inside it down to the next boundary, and its
 * parent's engine sees it as one box of fixed size. `composeLayout` runs one
 * request's whole plan:
 *
 * 1. the boundaries are the plan's visible scopes with a visible child;
 * 2. each boundary, in post-order (reverse `graph.order`), is laid out by its
 *    engine on its **view** (`layoutView`, C24), with `scope` = the boundary;
 *    the host fallbacks are applied to the view, and the result is checked
 *    (`describeShapeError`, `validateResult`). It is stored moved so the
 *    boundary's frame starts at `(0, 0)`, snapped to the 1/64 grid when the
 *    engine is `quantized` (C31), and its size is what the parent's view gets;
 * 3. the root's engine lays out the root's view the same way;
 * 4. each box's stored result is moved by the box's place in its parent,
 *    pre-order, and the nodes, edges, labels and notes merged;
 * 5. an edge that no view holds (it crosses a boundary) is drawn straight from
 *    its real source to its real target over the merged result, and labelled
 *    then (C15, C21).
 *
 * A boundary whose engine fails (throws, is not registered, returns a shape
 * the host refuses or a result `validateResult` rejects against its view) is
 * **dissolved**: its layer joins its parent's view, its own inner boundaries
 * stay boundaries, and one `SGL4013` note says so (C28). The root's failure
 * is today's: a throw rejects (the worker's `SGL4011`) and a malformed result
 * is returned as is (the host's `SGL4002`).
 *
 * `ctx.signal` is checked before every scope, so a superseded request stops
 * at the next boundary (C27). No clock, no `ctx.random` of its own; every
 * traversal is ordered by `graph.order` (C31).
 *
 * **Branch 1 (`feat/b8-compose`):** crossing edges are straight end to end
 * under every parent (DD-14 C13's option (a)); the boundary ports and legs
 * are branch 3's. Nothing in the app calls this yet: the plan, the protocol
 * and the lazy chunk are branch 2's. Its own entry, so it is never on the
 * boot path.
 */

import type { EdgeId, GraphEdge, GraphNode, LabelId, LabelSpec, NodeId, SemanticGraph, Size } from '@sgl/core';
import type { EngineNote, LabelPlacement, LayoutContext, LayoutEngine, LayoutInput, LayoutResult, NodeLayout, NodeSizing } from './contract.js';
import { applyHostFallbacks, placeLabels, routeStraight } from './fallbacks.js';
import { workerText } from './host.js';
import { describeShapeError, mapGeometry, validateResult } from './validate.js';

/** One boundary of a plan (DD-14 C8): the container, its engine's full id, and
 *  that engine's options, complete (the plan's builder resolved inheritance). */
export interface LayoutScope {
  readonly node: NodeId;
  readonly engine: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/** The boundaries of one request, in `graph.order` (DD-14 C8). */
export type LayoutPlan = readonly LayoutScope[];

/** A box's leaf sizing in its parent's view (C24): fixed at its own engine's
 *  size, with a leaf's insets (no title band: the title is already placed). */
function boxSizing(sizing: NodeSizing | undefined, size: Size): NodeSizing {
  const inset = sizing?.contentInset ?? ([0, 0, 0, 0] as const);
  return { intrinsic: size, fixed: size, contentInset: inset, padding: inset };
}

/**
 * The `LayoutInput` one scope's engine sees (DD-14 C24). `scope` is the
 * boundary, or `null` for the root's layer; `boxes` are the inner boundaries
 * already laid out, with their sizes.
 *
 * - **Nodes:** the scope node (its view's only top node, `parent: null`, no
 *   ports: its ports are its parent's, C22), every node inside it down to the
 *   next box, hidden ones included (engines filter them, as they do today),
 *   and each box as a **leaf**: `children: []`, `labelId: null`, its author
 *   ports and its `config` (so its `@pin` and hints reach the parent).
 * - **Sizing:** as the document's, except a box's (`boxSizing`).
 * - **Edges:** those with both ends in the view (C14: a scope node or box
 *   counts as present, a port on the scope node does not), except a self-loop
 *   on the scope node, which belongs to its parent's view (the box's outside).
 *   Every other edge crosses a boundary and is drawn after composition.
 * - **Order:** `graph.order`, filtered in place (so traversal is unchanged).
 */
export function layoutView(input: LayoutInput, scope: NodeId | null, boxes: ReadonlyMap<NodeId, Size>): LayoutInput {
  const { graph } = input;
  const nodes: Record<NodeId, GraphNode> = {};
  const sizing: Record<NodeId, NodeSizing> = {};
  const labels: Record<LabelId, LabelSpec> = {};
  const labelSizes: Record<LabelId, Size> = {};
  const addLabel = (id: LabelId | null): void => {
    if (id === null) return;
    const spec = graph.labels[id];
    if (spec === undefined) return;
    labels[id] = spec;
    const size = input.labelSizes[id];
    if (size !== undefined) labelSizes[id] = size;
  };

  const stack: NodeId[] = [];
  if (scope === null) {
    for (let i = graph.rootChildren.length - 1; i >= 0; i -= 1) stack.push(graph.rootChildren[i]!);
  } else {
    const node = graph.nodes[scope];
    if (node !== undefined) {
      nodes[scope] = { ...node, parent: null, ports: [] };
      const s = input.sizing[scope];
      if (s !== undefined) sizing[scope] = s;
      addLabel(node.labelId);
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
    }
  }
  // Iterative (DD-12 N28): a document may nest deeper than the call stack.
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = graph.nodes[id];
    if (node === undefined) continue;
    const box = boxes.get(id);
    if (box !== undefined) {
      nodes[id] = { ...node, children: [], labelId: null };
      sizing[id] = boxSizing(input.sizing[id], box);
      continue;
    }
    nodes[id] = node;
    const s = input.sizing[id];
    if (s !== undefined) sizing[id] = s;
    addLabel(node.labelId);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
  }

  const present = (end: GraphEdge['from']): boolean => nodes[end.node] !== undefined && !(end.node === scope && end.port !== undefined);
  const edges = graph.edges.filter((e) => present(e.from) && present(e.to) && !(e.from.node === scope && e.to.node === scope));
  for (const e of edges) addLabel(e.labelId);

  const order = graph.order.filter((id) => nodes[id] !== undefined);
  const view: SemanticGraph = {
    ...graph,
    nodes,
    edges,
    rootChildren: scope === null ? graph.rootChildren : [scope],
    order,
    labels,
    meta: { nodeCount: order.length, edgeCount: edges.length, containerCount: order.filter((id) => nodes[id]!.children.length > 0).length },
  };
  return { graph: view, scope, sizing, labelSizes };
}

type ScopeOutcome = { readonly ok: true; readonly result: LayoutResult; readonly determinism: string } | { readonly ok: false; readonly detail: string };

/** One scope's engine on its view, the worker's sequence (DD-06 §3):
 *  `layout -> applyHostFallbacks`, then checked against the view. An abort is
 *  not a failure: it propagates. */
async function runScope(engine: LayoutEngine | undefined, view: LayoutInput, options: Readonly<Record<string, unknown>>, ctx: LayoutContext): Promise<ScopeOutcome> {
  if (engine === undefined) return { ok: false, detail: 'not registered in this worker' };
  let raw: LayoutResult;
  try {
    raw = await engine.layout(view, { ...ctx, options });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const shape = describeShapeError(raw);
  if (shape !== null) return { ok: false, detail: shape };
  const result = applyHostFallbacks(view, raw, engine.capabilities, ctx.metrics);
  // `SGL4003` (a warning) is left to the host's validation of the whole
  // result, which reports it once (C29); only an error fails the box.
  if (validateResult(result, view.graph, engine.id).some((d) => d.severity === 'error')) return { ok: false, detail: 'returned invalid geometry' };
  return { ok: true, result, determinism: engine.capabilities.determinism };
}

function checkAbort(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (typeof DOMException !== 'undefined') throw new DOMException('The operation was aborted.', 'AbortError');
  throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/** `result` moved by `(dx, dy)`; with `snap`, every coordinate and length
 *  on the 1/64 grid after the move (C31). */
function moved(result: LayoutResult, dx: number, dy: number, snap: boolean): LayoutResult {
  if (!snap && dx === 0 && dy === 0) return result;
  const q = snap ? (v: number): number => Math.round(v * 64) / 64 : (v: number): number => v;
  return mapGeometry(
    result,
    (x) => q(x + dx),
    (y) => q(y + dy),
    q,
  );
}

/**
 * Lays out `input` under `root` (the document's engine, with `options`) and
 * every boundary in `plan` under its own engine, and composes one raw
 * `LayoutResult` (DD-14 C23). `engines` looks an engine up by id (the
 * worker's registry). `ctx` is the request's: its `options` are replaced per
 * scope, its `signal` is checked between scopes.
 *
 * The result is raw, as an engine's is after the host fallbacks: the caller
 * validates it against the full graph and quantizes it (`host.ts`,
 * `runHostSequence`).
 */
export async function composeLayout(
  root: LayoutEngine,
  input: LayoutInput,
  options: Readonly<Record<string, unknown>>,
  plan: LayoutPlan,
  engines: (id: string) => LayoutEngine | undefined,
  ctx: LayoutContext,
): Promise<LayoutResult> {
  const { graph } = input;

  // 1. The boundaries: visible scopes with a visible child, one per node, in
  //    graph.order.
  const byNode = new Map<NodeId, LayoutScope>();
  for (const s of plan) {
    const node = graph.nodes[s.node];
    if (node === undefined || node.hidden || byNode.has(s.node)) continue;
    if (!node.children.some((c) => graph.nodes[c]?.hidden === false)) continue;
    byNode.set(s.node, s);
  }
  const boundaries = graph.order.filter((id) => byNode.has(id));
  const active = new Set<NodeId>(boundaries);
  const enclosing = (id: NodeId): NodeId | null => {
    for (let at = graph.nodes[id]?.parent ?? null; at !== null; at = graph.nodes[at]?.parent ?? null) if (active.has(at)) return at;
    return null;
  };

  // 2. Post-order: every box's size is known before its parent's view is built.
  const sizes = new Map<NodeId, Size>();
  const stored = new Map<NodeId, LayoutResult>();
  const failed = new Map<NodeId, EngineNote>();
  const assigned = new Set<EdgeId>();
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    checkAbort(ctx.signal);
    const id = boundaries[i]!;
    const scope = byNode.get(id)!;
    const view = layoutView(input, id, innerBoxes(graph, id, sizes, active));
    const outcome = await runScope(engines(scope.engine), view, scope.options, ctx);
    const frame = outcome.ok ? outcome.result.nodes[id]?.frame : undefined;
    if (outcome.ok && frame !== undefined) {
      const local = moved(outcome.result, -frame.x, -frame.y, outcome.determinism === 'quantized');
      stored.set(id, local);
      sizes.set(id, { w: local.nodes[id]!.frame.w, h: local.nodes[id]!.frame.h });
      for (const e of view.graph.edges) assigned.add(e.id);
      continue;
    }
    // C28: dissolve. Its layer joins its parent's view; its inner boxes stay.
    active.delete(id);
    const parent = enclosing(id);
    const parentEngine = parent === null ? root.id : byNode.get(parent)!.engine;
    const node = graph.nodes[id]!;
    const detail = outcome.ok ? 'returned invalid geometry' : outcome.detail;
    failed.set(id, { code: 'SGL4013', span: node.span, params: { id: scope.engine, node: id, detail: workerText(detail), parent: parentEngine } });
  }

  // 3. The root.
  checkAbort(ctx.signal);
  const rootView = layoutView(input, null, innerBoxes(graph, null, sizes, active));
  const rootRaw = await root.layout(rootView, { ...ctx, options });
  if (describeShapeError(rootRaw) !== null) return rootRaw;
  const rootResult = applyHostFallbacks(rootView, rootRaw, root.capabilities, ctx.metrics);
  for (const e of rootView.graph.edges) assigned.add(e.id);

  // 4. Pre-order: move each box by its place in its (already placed) parent.
  const nodes: Record<NodeId, NodeLayout> = { ...rootResult.nodes };
  const edges: Record<EdgeId, LayoutResult['edges'][EdgeId]> = { ...rootResult.edges };
  const labels: LabelPlacement[] = [...rootResult.labels];
  const notes: EngineNote[] = [...(rootResult.notes ?? [])];
  for (const id of boundaries) {
    const note = failed.get(id);
    if (note !== undefined) notes.push(note);
    const local = stored.get(id);
    const placed = nodes[id];
    if (local === undefined || placed === undefined) continue;
    const abs = moved(local, placed.frame.x, placed.frame.y, false);
    for (const [nid, layout] of Object.entries(abs.nodes)) nodes[nid as NodeId] = layout;
    // The box's own ports are its parent's (C22).
    nodes[id] = placed.ports === undefined ? abs.nodes[id]! : { ...abs.nodes[id]!, ports: placed.ports };
    Object.assign(edges, abs.edges);
    labels.push(...abs.labels);
    notes.push(...(abs.notes ?? []));
  }

  // Canonical order: nodes in graph.order, edges in graph.edges order.
  const orderedNodes: Record<NodeId, NodeLayout> = {};
  for (const id of graph.order) if (nodes[id] !== undefined) orderedNodes[id] = nodes[id]!;
  for (const id of Object.keys(nodes).sort() as NodeId[]) if (orderedNodes[id] === undefined) orderedNodes[id] = nodes[id]!;
  const orderedEdges: Record<EdgeId, LayoutResult['edges'][EdgeId]> = {};
  for (const e of graph.edges) if (edges[e.id] !== undefined) orderedEdges[e.id] = edges[e.id]!;
  let merged: LayoutResult = { bounds: rootResult.bounds, nodes: orderedNodes, edges: orderedEdges, labels, ...(notes.length > 0 && { notes }) };

  // 5. Edges across a boundary, end to end (C15), and their labels (C21).
  const crossing = graph.edges.filter((e) => !e.hidden && !assigned.has(e.id));
  if (crossing.length > 0) {
    merged = routeStraight(input, merged, ctx.metrics);
    const own: Record<LabelId, LabelSpec> = {};
    for (const e of crossing) if (e.labelId !== null && graph.labels[e.labelId] !== undefined) own[e.labelId] = graph.labels[e.labelId]!;
    const placed = placeLabels({ ...input, graph: { ...graph, labels: own } }, merged, ctx.metrics).labels;
    merged = { ...merged, labels: [...merged.labels, ...placed] };
  }
  return merged;
}

/** The active boxes directly inside `scope`'s layer that are laid out, with
 *  their sizes. */
function innerBoxes(graph: SemanticGraph, scope: NodeId | null, sizes: ReadonlyMap<NodeId, Size>, active: ReadonlySet<NodeId>): ReadonlyMap<NodeId, Size> {
  const out = new Map<NodeId, Size>();
  for (const [id, size] of sizes) {
    if (!active.has(id)) continue;
    let at = graph.nodes[id]?.parent ?? null;
    while (at !== null && !active.has(at)) at = graph.nodes[at]?.parent ?? null;
    if (at === scope) out.set(id, size);
  }
  return out;
}

/** The engine that places each node (DD-14 C3): its innermost enclosing
 *  boundary's, or the root's. For conformance check 3's pin exemption. */
export function placingEngines(graph: SemanticGraph, plan: LayoutPlan, rootEngine: string): (id: NodeId) => string {
  const byNode = new Map<NodeId, string>();
  for (const s of plan) if (!byNode.has(s.node)) byNode.set(s.node, s.engine);
  return (id) => {
    for (let at = graph.nodes[id]?.parent ?? null; at !== null; at = graph.nodes[at]?.parent ?? null) {
      const e = byNode.get(at);
      if (e !== undefined) return e;
    }
    return rootEngine;
  };
}
