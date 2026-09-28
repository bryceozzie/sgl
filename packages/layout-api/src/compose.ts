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
 * **The per-box cache** (`LayoutCache`, C32, `perf/b8-cache`): in the worker,
 * a box whose view, options and engine are unchanged since one of the last
 * two requests reuses its result instead of running its engine again, so a
 * keystroke re-lays out only the boxes it changed (and the root's layer).
 *
 * **Branch 1 (`feat/b8-compose`):** crossing edges are straight end to end
 * under every parent (DD-14 C13's option (a)); the boundary ports and legs
 * are branch 3's. Nothing in the app calls this yet: the plan, the protocol
 * and the lazy chunk are branch 2's. Its own entry, so it is never on the
 * boot path.
 */

import type { EdgeId, GraphEdge, GraphNode, LabelId, LabelSpec, NodeId, SemanticGraph, Size, SourceSpan } from '@sgl/core';
import type { EngineNote, LabelPlacement, LayoutContext, LayoutEngine, LayoutInput, LayoutResult, NodeLayout, NodeSizing } from './contract.js';
import { applyHostFallbacks, placeLabels, routeStraight } from './fallbacks.js';
import { workerText } from './host.js';
import { checkResult, describeShapeError, mapGeometry } from './validate.js';

/** One boundary of a plan (DD-14 C8): the container, its engine's full id, and
 *  that engine's options, complete (the plan's builder resolved inheritance). */
export interface LayoutScope {
  readonly node: NodeId;
  readonly engine: string;
  readonly options: Readonly<Record<string, unknown>>;
  /** The span of the container's `@layout` `engine` key, where `SGL4013`
   *  is reported (fix round 1, item 1); the container's own span without it. */
  readonly span?: SourceSpan;
}

/** The boundaries of one request, in `graph.order` (DD-14 C8). */
export type LayoutPlan = readonly LayoutScope[];

/** The most boundaries one request may carry (`feat/b8-wire` fix round 1,
 *  item 5): far above any document the budgets allow (n2000 has 200). */
export const MAX_PLAN_SCOPES = 10_000;

/** Whether `plan` is what the host sends: an array of at most
 *  `MAX_PLAN_SCOPES` scopes, each with string `node` and `engine` and a
 *  plain-object `options`. The worker's message is untrusted input (B17's
 *  iframe host), as an engine's output is. A scope's `span` is not checked:
 *  it only reaches an `SGL4013` note, whose span the host checks
 *  (`engineNotes`). Here, in the lazy chunk, it costs the boot path nothing. */
function wellFormedPlan(plan: unknown): boolean {
  return (
    Array.isArray(plan) &&
    plan.length <= MAX_PLAN_SCOPES &&
    plan.every((s: { node?: unknown; engine?: unknown; options?: unknown } | null) => typeof s?.node === 'string' && typeof s.engine === 'string' && typeof s.options === 'object' && s.options !== null && !Array.isArray(s.options))
  );
}

/** A box's leaf sizing in its parent's view (C24): fixed at its own engine's
 *  size, with a leaf's insets (no title band: the title is already placed). */
function boxSizing(sizing: NodeSizing | undefined, size: Size): NodeSizing {
  const inset = sizing?.contentInset ?? ([0, 0, 0, 0] as const);
  return { intrinsic: size, fixed: size, contentInset: inset, padding: inset };
}

/** Lookups over one graph that `layoutView` reuses across a request's views:
 *  each node's position in `graph.order`, and the indices in `graph.edges` of
 *  the edges at each node. */
export interface ViewIndex {
  readonly position: ReadonlyMap<NodeId, number>;
  readonly incident: ReadonlyMap<NodeId, readonly number[]>;
}

export function viewIndex(graph: SemanticGraph): ViewIndex {
  const position = new Map<NodeId, number>();
  graph.order.forEach((id, i) => position.set(id, i));
  const incident = new Map<NodeId, number[]>();
  const add = (id: NodeId, i: number): void => {
    const list = incident.get(id);
    if (list === undefined) incident.set(id, [i]);
    else list.push(i);
  };
  graph.edges.forEach((e, i) => {
    add(e.from.node, i);
    if (e.to.node !== e.from.node) add(e.to.node, i);
  });
  return { position, incident };
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
 *
 * With an `index` of `input.graph` (`viewIndex`), the edges and the order are
 * found from the view's own nodes instead of by a pass over the whole graph:
 * the same view, in time proportional to it (`perf/b8-cache`: 200 views of
 * a 2 000-node document took ~150 ms without it).
 */
export function layoutView(input: LayoutInput, scope: NodeId | null, boxes: ReadonlyMap<NodeId, Size>, index?: ViewIndex): LayoutInput {
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
  const keep = (e: GraphEdge): boolean => present(e.from) && present(e.to) && !(e.from.node === scope && e.to.node === scope);
  let edges: GraphEdge[];
  let order: NodeId[];
  if (index === undefined) {
    edges = graph.edges.filter(keep);
    order = graph.order.filter((id) => nodes[id] !== undefined);
  } else {
    // The same two lists from the view's own nodes, not the whole graph's:
    // an edge the view keeps has its source in the view, and `graph.order`'s
    // positions sort the nodes back into its order.
    const ids = Object.keys(nodes) as NodeId[];
    const at = new Set<number>();
    for (const id of ids) for (const i of index.incident.get(id) ?? []) at.add(i);
    edges = [...at].sort((a, b) => a - b).map((i) => graph.edges[i]!).filter(keep);
    order = ids.filter((id) => index.position.has(id)).sort((a, b) => index.position.get(a)! - index.position.get(b)!);
  }
  for (const e of edges) addLabel(e.labelId);

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
 *  not a failure: it propagates.
 *
 *  With a `cache` (DD-14 C32), a box whose key is cached is not laid out: its
 *  stored outcome is returned, a copy. Only a success is stored, and only
 *  when the engine did not call `ctx.random`, `ctx.measure.layoutRunsAsync` or
 *  `ctx.log`: its result is then a function of the key alone (a random draw
 *  would also depend on the draws before it in the request). */
async function runScope(engine: LayoutEngine | undefined, view: LayoutInput, options: Readonly<Record<string, unknown>>, ctx: LayoutContext, cache?: LayoutCache): Promise<ScopeOutcome> {
  if (engine === undefined) return { ok: false, detail: 'not registered in this worker' };
  const key = cache === undefined ? '' : cacheKey(engine, view, options, ctx.metrics);
  const hit = cache?.lookup(key, view);
  if (hit !== undefined) return { ok: true, result: structuredClone(hit.result), determinism: hit.determinism };
  let pure = true;
  const scoped: LayoutContext =
    cache === undefined
      ? { ...ctx, options }
      : {
          ...ctx,
          options,
          random: () => {
            pure = false;
            return ctx.random();
          },
          measure: {
            layoutRuns: (runs, box) => ctx.measure.layoutRuns(runs, box),
            layoutRunsAsync: (runs, box) => {
              pure = false;
              return ctx.measure.layoutRunsAsync(runs, box);
            },
          },
          log: (level, message, nodeId) => {
            pure = false;
            ctx.log(level, message, nodeId);
          },
        };
  let raw: LayoutResult;
  try {
    raw = await engine.layout(view, scoped);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const shape = describeShapeError(raw);
  if (shape !== null) return { ok: false, detail: shape };
  const result = applyHostFallbacks(view, raw, engine.capabilities, ctx.metrics);
  // `SGL4003` (a warning) is left to the host's validation of the whole
  // result, which reports it once (C29); only an error fails the box.
  let invalid = false;
  checkResult(result, view.graph, (code) => {
    invalid ||= code === 'SGL4002';
  });
  if (invalid) return { ok: false, detail: 'returned invalid geometry' };
  if (pure) cache?.store(key, view, structuredClone(result), engine.capabilities.determinism);
  return { ok: true, result, determinism: engine.capabilities.determinism };
}

// ---------------------------------------------------------------------------
// The per-box cache (DD-14 C32; `perf/b8-cache`).
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** The box's checked result on its view (after the host fallbacks), before
   *  the composer moves it. Never handed out: `runScope` returns a copy. */
  readonly result: LayoutResult;
  readonly determinism: string;
  /** The view's node and edge spans, kept only when the result has notes: a
   *  note's span is the one place a result can carry a span (`fixed`'s
   *  `SGL4020`), so only then must the spans match too. */
  readonly spans: string | undefined;
  /** Estimated size in bytes: the key, the result's JSON and the spans, two
   *  bytes a character. */
  readonly bytes: number;
  /** The generation of the last request that used it. */
  used: number;
}

/** The cache's bounds (DD-14 C32): at most this many boxes, and this many
 *  bytes by `CacheEntry.bytes`. n2000's 200 boxes take ~400 entries (two
 *  generations) and ~4 MB. */
export interface LayoutCacheLimits {
  readonly entries: number;
  readonly bytes: number;
}

export const LAYOUT_CACHE_LIMITS: LayoutCacheLimits = { entries: 2_000, bytes: 32 * 1024 * 1024 };

/**
 * Each box's laid-out result, by its **key** (`cacheKey`): everything its
 * engine and the host fallbacks read (the engine's id, version, API version
 * and capabilities, the box's options, the theme's metrics, and its whole
 * view: nodes, sizes (an inner box's included), labels and their measured
 * sizes, edges, order), as exact JSON. Spans are left out, so an edit
 * elsewhere in the text, which moves every span after it, does not miss (a
 * result with notes also keeps its spans, and a hit needs them equal). Keys
 * are content, compared in full; never object identity across requests.
 *
 * **Policy: the last two requests** (C32, the A9 import cache's rule). An
 * entry used by a request that ran to the end, or by the one before it, is
 * kept; the rest are dropped when a request finishes. A superseded request
 * that stopped part-way ends no generation, so fast typing does not age out
 * the boxes it never reached. One edit at a time changes one box's key, and
 * the old entry stays one more generation (typing a character and deleting it
 * hits). **When full, a new entry is not stored** rather than evicting one
 * not yet reached in this request: a request scans its boxes in the same
 * order every time, and any recency policy over a scan larger than the cache
 * misses on every box (07 §2.1 F24's lesson with an LRU); keeping what is in
 * gives a larger document its partial hits.
 *
 * The cache is cleared when the document's own engine changes, and lives in
 * the worker's lazy `compose` chunk (`composeInWorker`), so a respawned worker
 * starts with an empty one.
 */
export class LayoutCache {
  readonly #entries = new Map<string, CacheEntry>();
  #bytes = 0;
  #generation = 0;
  #root: string | undefined;
  /** Boxes found, and laid out, since the cache was made (for tests and the bench). */
  hits = 0;
  misses = 0;

  constructor(readonly limits: LayoutCacheLimits = LAYOUT_CACHE_LIMITS) {}

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  /** A request begins, laid out under `root` (its engine's id and version). */
  begin(root: string): void {
    if (this.#root !== root) this.clear();
    this.#root = root;
  }

  lookup(key: string, view: LayoutInput): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry !== undefined && (entry.spans === undefined || entry.spans === spansOf(view))) {
      entry.used = this.#generation;
      this.hits += 1;
      return entry;
    }
    this.misses += 1;
    return undefined;
  }

  store(key: string, view: LayoutInput, result: LayoutResult, determinism: string): void {
    const spans = (result.notes?.length ?? 0) > 0 ? spansOf(view) : undefined;
    const bytes = 2 * (key.length + JSON.stringify(result).length + (spans?.length ?? 0));
    const old = this.#entries.get(key);
    const total = this.#bytes - (old?.bytes ?? 0) + bytes;
    if ((old === undefined && this.#entries.size >= this.limits.entries) || total > this.limits.bytes) return;
    this.#entries.set(key, { result, determinism, spans, bytes, used: this.#generation });
    this.#bytes = total;
  }

  /** A request ran to the end: drop what neither it nor the one before used. */
  finish(): void {
    for (const [key, entry] of this.#entries) {
      if (entry.used >= this.#generation - 1) continue;
      this.#entries.delete(key);
      this.#bytes -= entry.bytes;
    }
    this.#generation += 1;
  }
}

/** A box's cache key (`LayoutCache`): exact JSON of everything that decides
 *  its result, its nodes' and edges' spans left out. `-0`, `undefined` and
 *  non-finite numbers are kept apart from `0`, a missing key and `null`, and a
 *  string that starts with the marker is escaped, so two different inputs
 *  never share a key. */
function cacheKey(engine: LayoutEngine, view: LayoutInput, options: Readonly<Record<string, unknown>>, metrics: LayoutContext['metrics']): string {
  const own = new Set<unknown>(view.graph.edges);
  for (const id of Object.keys(view.graph.nodes)) own.add(view.graph.nodes[id as NodeId]);
  return JSON.stringify([engine.id, engine.version, engine.apiVersion, engine.capabilities, options, metrics, view], function (this: unknown, k: string, v: unknown) {
    if (k === 'span' && own.has(this)) return undefined;
    if (typeof v === 'number') return Object.is(v, -0) ? '\u0000-0' : Number.isFinite(v) ? v : `\u0000${v}`;
    if (v === undefined) return '\u0000u';
    return typeof v === 'string' && v.startsWith('\u0000') ? `\u0000${v}` : v;
  });
}

/** Every node's and edge's span in a view, as one string. */
function spansOf(view: LayoutInput): string {
  const { nodes, edges } = view.graph;
  return JSON.stringify([Object.keys(nodes).sort().map((id) => nodes[id as NodeId]!.span), edges.map((e) => e.span)]);
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
 *
 * With a `cache` (DD-14 C32; the worker's is `composeInWorker`'s), a box
 * whose key is cached reuses its stored result instead of running its engine;
 * the composed result is byte for byte what it is without one. The root's
 * layer is always laid out.
 */
export async function composeLayout(
  root: LayoutEngine,
  input: LayoutInput,
  options: Readonly<Record<string, unknown>>,
  plan: LayoutPlan,
  engines: (id: string) => LayoutEngine | undefined,
  ctx: LayoutContext,
  cache?: LayoutCache,
): Promise<LayoutResult> {
  // A malformed plan fails the request with one fixed reason (the worker
  // posts it; the host's SGL4011), never a raw TypeError.
  if (!wellFormedPlan(plan)) throw new Error('the request carried a malformed plan');
  cache?.begin(`${root.id}@${root.version}`);
  const { graph } = input;
  const index = viewIndex(graph);

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
  const failed = new Map<NodeId, string>();
  const assigned = new Set<EdgeId>();
  const dissolve = (id: NodeId, detail: string): void => {
    active.delete(id);
    sizes.delete(id);
    stored.delete(id);
    failed.set(id, detail);
  };
  /** Runs one scope; a box it placed at another size than its own engine gave
   *  it is dissolved and the scope run again (fix round 1, item 3): a box is
   *  never drawn at a size its parent did not place. */
  const runLayer = async (scope: NodeId | null, engine: LayoutEngine | undefined, opts: Readonly<Record<string, unknown>>): Promise<{ readonly view: LayoutInput; readonly outcome: ScopeOutcome }> => {
    for (;;) {
      const boxes = innerBoxes(graph, scope, sizes, active);
      const view = layoutView(input, scope, boxes, index);
      const outcome = await runScope(engine, view, opts, ctx, cache);
      if (!outcome.ok) return { view, outcome };
      const resized = [...boxes].filter(([id, size]) => {
        const f = outcome.result.nodes[id]?.frame;
        return f !== undefined && (Math.abs(f.w - size.w) > 1 / 64 || Math.abs(f.h - size.h) > 1 / 64);
      });
      if (resized.length === 0) return { view, outcome };
      for (const [id] of resized) dissolve(id, "resized by its parent's engine");
    }
  };
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    checkAbort(ctx.signal);
    const id = boundaries[i]!;
    const scope = byNode.get(id)!;
    const { view, outcome } = await runLayer(id, engines(scope.engine), scope.options);
    const frame = outcome.ok ? outcome.result.nodes[id]?.frame : undefined;
    if (outcome.ok && frame !== undefined) {
      const local = moved(outcome.result, -frame.x, -frame.y, outcome.determinism === 'quantized');
      stored.set(id, local);
      sizes.set(id, { w: local.nodes[id]!.frame.w, h: local.nodes[id]!.frame.h });
      for (const e of view.graph.edges) assigned.add(e.id);
      continue;
    }
    // C28: dissolve. Its layer joins its parent's view; its inner boxes stay.
    dissolve(id, outcome.ok ? 'returned invalid geometry' : outcome.detail);
  }

  // 3. The root. Its own failure is today's: a throw rejects, a bad shape is
  //    returned for the host to reject.
  checkAbort(ctx.signal);
  let rootView: LayoutInput;
  let rootRaw: LayoutResult;
  for (;;) {
    const boxes = innerBoxes(graph, null, sizes, active);
    rootView = layoutView(input, null, boxes, index);
    rootRaw = await root.layout(rootView, { ...ctx, options });
    if (describeShapeError(rootRaw) !== null) return rootRaw;
    const resized = [...boxes].filter(([id, size]) => {
      const f = rootRaw.nodes[id]?.frame;
      return f !== undefined && (Math.abs(f.w - size.w) > 1 / 64 || Math.abs(f.h - size.h) > 1 / 64);
    });
    if (resized.length === 0) break;
    for (const [id] of resized) dissolve(id, "resized by its parent's engine");
  }
  checkAbort(ctx.signal);
  const rootResult = applyHostFallbacks(rootView, rootRaw, root.capabilities, ctx.metrics);
  for (const e of rootView.graph.edges) assigned.add(e.id);

  // `{parent}` is the engine that really laid each dissolved box out: its
  // nearest enclosing boundary that is still one after every failure (fix
  // round 1, item 1), or the root's.
  const notesOf = new Map<NodeId, EngineNote>();
  for (const [id, detail] of failed) {
    const scope = byNode.get(id)!;
    const parent = enclosing(id);
    notesOf.set(id, {
      code: 'SGL4013',
      span: scope.span ?? graph.nodes[id]!.span,
      params: { id: scope.engine, node: id, detail: workerText(detail), parent: parent === null ? root.id : byNode.get(parent)!.engine },
    });
  }

  // 4. Pre-order: move each box by its place in its (already placed) parent.
  const nodes: Record<NodeId, NodeLayout> = { ...rootResult.nodes };
  const edges: Record<EdgeId, LayoutResult['edges'][EdgeId]> = { ...rootResult.edges };
  const labels: LabelPlacement[] = [...rootResult.labels];
  const notes: EngineNote[] = [...(rootResult.notes ?? [])];
  for (const id of boundaries) {
    const note = notesOf.get(id);
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

  let merged: LayoutResult = { bounds: rootResult.bounds, nodes, edges, labels, ...(notes.length > 0 && { notes }) };

  // 5. Edges across a boundary, end to end (C15), and their labels (C21).
  const crossing = graph.edges.filter((e) => !e.hidden && !assigned.has(e.id));
  if (crossing.length > 0) {
    merged = routeStraight(input, merged, ctx.metrics);
    const own: Record<LabelId, LabelSpec> = {};
    for (const e of crossing) if (e.labelId !== null && graph.labels[e.labelId] !== undefined) own[e.labelId] = graph.labels[e.labelId]!;
    labels.push(...placeLabels({ ...input, graph: { ...graph, labels: own } }, merged, ctx.metrics).labels);
  }

  // One canonical order, whichever scope placed what: nodes in `graph.order`,
  // edges in `graph.edges` order, labels by id (`placeLabels`' own order). So
  // a `grid` box in a `grid` document gives `grid`'s own result (C31).
  const orderedNodes: Record<NodeId, NodeLayout> = {};
  for (const id of graph.order) if (nodes[id] !== undefined) orderedNodes[id] = nodes[id]!;
  for (const id of Object.keys(nodes).sort() as NodeId[]) if (orderedNodes[id] === undefined) orderedNodes[id] = nodes[id]!;
  const orderedEdges: Record<EdgeId, LayoutResult['edges'][EdgeId]> = {};
  for (const e of graph.edges) if (merged.edges[e.id] !== undefined) orderedEdges[e.id] = merged.edges[e.id]!;
  labels.sort((a, b) => (a.labelId < b.labelId ? -1 : a.labelId > b.labelId ? 1 : 0));
  cache?.finish();
  return { ...merged, nodes: orderedNodes, edges: orderedEdges, labels };
}

/** The worker's cache: one per worker, because this module is loaded once per
 *  worker (the lazy `compose` chunk), so a respawned worker starts empty. */
const WORKER_CACHE = new LayoutCache();

/** `composeLayout` with the worker's cache (DD-14 C32): what the worker's
 *  lazy loader hands the runtime (`apps/web/src/layout.worker.ts`). */
export const composeInWorker: typeof composeLayout = (root, input, options, plan, engines, ctx) => composeLayout(root, input, options, plan, engines, ctx, WORKER_CACHE);

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
