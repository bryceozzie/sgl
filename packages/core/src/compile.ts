/**
 * The compiler (DD-03): fold the `DocumentModel` into the `SemanticGraph` — flatten
 * the container tree into an indexed node map with stable IDs, expand wildcard
 * edge endpoints, resolve every endpoint to a `NodeId` (+ port), linearise class
 * lists, extract labels, allocate stable edge IDs, and compute the pre-order
 * traversal.
 *
 * Two things not spelled out as tasks in the execution plan but required by the
 * frozen types and DD-02 §4 ("DD-03 computes `classes: string[]` in linearised
 * order per node"): class linearisation (`linearizeClasses` below) runs here, not
 * in the resolver, and it applies identically to a node's `@type` and an edge's
 * (the registry allows `@type` at edge scope too, and `GraphEdge.classes` is
 * frozen alongside `GraphNode.classes`).
 *
 * `@hidden` propagates down the subtree rather than being read literal-only: DD-03
 * §7 says a hidden node's "subtree is omitted" from `order`, and DD-06 §2 has the
 * layout host filter on each node's own `hidden` flag alone (no ancestor walk). The
 * two are only consistent if a node under a hidden container reports `hidden: true`
 * itself — so `hidden` here means "effectively hidden", not "has its own `@hidden`".
 *
 * Design: DD-03.
 */

import type { NameStep, PathExpr, PathStep, WildcardStep } from './ast.js';
import { matchesWildcard } from './ast.js';
import { diagnostic, type Diagnostic } from './diagnostics.js';
import type {
  GraphEdge,
  GraphEndpoint,
  GraphNode,
  LabelSpec,
  PortSpec,
  SemanticGraph,
  TextRun,
  ViewSelector,
} from './graph.js';
import { fnv1a64 } from './hash.js';
import { asEdgeId, asLabelId, asNodeId, asPortId, KNOWN_SHAPES, nodeIdFromPath, type NodeId, type ShapeId } from './ids.js';
import type { ClassModel, ConfigBag, ContainerModel, DocumentModel, EdgeModel } from './model.js';
import { NO_SPAN, type SourceSpan } from './span.js';

export interface CompileResult {
  readonly graph: SemanticGraph;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The most edges one wildcard statement may expand to (DD-03 §3.1).
 *
 * A cross product like `a.** -> b.**` is quadratic in a document that is already
 * allowed to hold 2 000 nodes, so the ceiling is a hard stop rather than a
 * suggestion: over it, the statement is skipped with SGL3005 and every other edge
 * survives. Chosen to sit an order of magnitude above any legible diagram.
 */
export const MAX_EDGE_EXPANSION = 1_000;

const isConfigBag = (v: unknown): v is ConfigBag => typeof v === 'object' && v !== null && !Array.isArray(v);

const typeNamesOf = (config: ConfigBag): readonly string[] => {
  const raw = config.type;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
};

const textRuns = (text: string): readonly TextRun[] => text.split('\n').map((line) => ({ text: line }));

// ---------------------------------------------------------------------------
// Class linearisation (DD-02 §4, DD-03 §4)
// ---------------------------------------------------------------------------

/**
 * Depth-first over `@extends`, left to right, de-duplicated keeping the last
 * occurrence: a name already in `order` is moved to the end rather than added
 * again. Bases are visited before the class itself, so in the common case (a
 * chain, no shared ancestor) a subclass always lands after its base. A class
 * reachable through two different siblings — a diamond — is the one case this
 * simple, literal reading of the rule does not keep monotonic: the ancestor's
 * *last* touch (via whichever sibling is processed second) can still land ahead
 * of a sibling processed first. No corpus fixture exercises that edge, and nothing
 * downstream depends on a particular tie-break there; a full C3-style merge would
 * remove the wrinkle but is not what the design doc describes.
 */
function linearizeClasses(typeNames: readonly string[], classes: Readonly<Record<string, ClassModel>>): string[] {
  const order: string[] = [];
  const visit = (name: string): void => {
    for (const base of classes[name]?.extends ?? []) visit(base);
    const idx = order.indexOf(name);
    if (idx !== -1) order.splice(idx, 1);
    order.push(name);
  };
  for (const name of typeNames) visit(name);
  return order;
}

// ---------------------------------------------------------------------------
// Shape and ports (DD-03 §4)
// ---------------------------------------------------------------------------

/** Inline `config.shape` wins; otherwise the first class in reverse linearised
 *  order (highest precedence first) that defines one. An unknown name — inline
 *  or from a class, `checkout.sgl`'s `@shape: cloud` among them — is `SGL3001`
 *  and falls back to `rect`; no shape anywhere is `rect` without a warning. */
function resolveShape(
  config: ConfigBag,
  classes: readonly string[],
  classTable: Readonly<Record<string, ClassModel>>,
  span: SourceSpan,
  diags: Diagnostic[],
): ShapeId {
  let raw: string | undefined = typeof config.shape === 'string' ? config.shape : undefined;
  if (raw === undefined) {
    for (let i = classes.length - 1; i >= 0; i -= 1) {
      const clsShape = classTable[classes[i] as string]?.config.shape;
      if (typeof clsShape === 'string') {
        raw = clsShape;
        break;
      }
    }
  }
  if (raw === undefined) return 'rect';
  if (KNOWN_SHAPES.has(raw)) return raw;
  diags.push(diagnostic('SGL3001', span, { name: raw }));
  return 'rect';
}

/** Ports come only from the node's own inline `@ports`; DD-03 §3's port rule
 *  ("must appear in the target node's `@ports`") never mentions a class's, and
 *  nothing downstream describes class ports flowing onto a node — the registry
 *  allowing `@ports` at class scope (DD-02 §7) reads as permitting the key in a
 *  class body without an `SGL2012`, not as specifying cascade behaviour for it. */
function buildPorts(config: ConfigBag): readonly PortSpec[] {
  if (!isConfigBag(config.ports)) return [];
  return Object.entries(config.ports).map(([id, side]) => ({
    id: asPortId(id),
    side: (typeof side === 'string' ? side : 'east') as PortSpec['side'],
  }));
}

// ---------------------------------------------------------------------------
// Flattening the container tree (DD-03 §2.1, §6, §7)
// ---------------------------------------------------------------------------

interface NodeMap {
  readonly nodes: Record<NodeId, GraphNode>;
  readonly containerByPath: ReadonlyMap<string, ContainerModel>;
  /** Pre-order, hidden subtrees omitted — the `order` field proper (§7). */
  readonly order: readonly NodeId[];
  /** Pre-order over every node, hidden or not — edges declared inside a hidden
   *  container still need a stable position for ID/parallelIndex purposes (§5),
   *  even though the container itself is missing from `order`. */
  readonly fullOrder: readonly NodeId[];
}

function buildNodeMap(model: DocumentModel, diags: Diagnostic[]): NodeMap {
  const nodes: Record<NodeId, GraphNode> = {};
  const containerByPath = new Map<string, ContainerModel>([['', model.root]]);
  const order: NodeId[] = [];
  const fullOrder: NodeId[] = [];

  const visit = (container: ContainerModel, parent: NodeId | null, depth: number, parentHidden: boolean): void => {
    const pathKey = nodeIdFromPath(container.path);
    const id = asNodeId(pathKey);
    containerByPath.set(pathKey, container);

    const classes = linearizeClasses(typeNamesOf(container.config), model.classes);
    const span = model.spans.get(`n:${pathKey}`) ?? NO_SPAN;
    const shape = resolveShape(container.config, classes, model.classes, span, diags);
    const hidden = parentHidden || container.config.hidden === true;
    const noLabel = hidden || container.config.label === '';
    const labelId = noLabel ? null : asLabelId(`l:${pathKey}`);

    nodes[id] = {
      id,
      path: container.path,
      parent,
      children: container.children.map((c) => asNodeId(nodeIdFromPath(c.path))),
      depth,
      shape,
      classes,
      labelId,
      ports: buildPorts(container.config),
      config: container.config,
      hidden,
      span,
    };

    fullOrder.push(id);
    if (!hidden) order.push(id);

    for (const child of container.children) visit(child, id, depth + 1, hidden);
  };

  for (const child of model.root.children) visit(child, null, 0, false);

  return { nodes, containerByPath, order, fullOrder };
}

// ---------------------------------------------------------------------------
// Path rendering for diagnostics (independent of resolve.ts's canonical printer,
// which also handles quoting for round-tripping — diagnostics just need to name
// the path the author wrote).
// ---------------------------------------------------------------------------

function renderStep(step: PathStep): string {
  return step.kind === 'Wildcard' ? (step.depth === 'descendants' ? '**' : `${step.prefix}*${step.suffix}`) : step.value;
}

function renderPath(path: PathExpr): string {
  return (path.root ? '/' : '') + '../'.repeat(path.parents) + path.segments.map(renderStep).join('.');
}

const OP_SYMBOL: Readonly<Record<EdgeModel['directed'], string>> = { forward: '->', both: '<->', none: '--' };

// ---------------------------------------------------------------------------
// Endpoint resolution and wildcard expansion (DD-03 §3, §3.1)
// ---------------------------------------------------------------------------

/** `base = root ? [] : cp; base = base[0 .. len(base) - parents]` — `undefined`
 *  when `parents` overruns the declaring path (the `SGL2001` case). */
function resolveBase(path: PathExpr, declaringPath: readonly string[]): readonly string[] | undefined {
  const start = path.root ? [] : declaringPath;
  return path.parents > start.length ? undefined : start.slice(0, start.length - path.parents);
}

function preorderDescendants(container: ContainerModel): readonly ContainerModel[] {
  const out: ContainerModel[] = [];
  const walk = (c: ContainerModel): void => {
    for (const child of c.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(container);
  return out;
}

/**
 * `expand()` from DD-03 §3.1, generalised to also cover the non-wildcard case (a
 * singleton result), so the cross-product code in `compileEdgeModel` needs no
 * special case for an ordinary endpoint. Returns `[]`, with a diagnostic already
 * pushed, on any failure.
 */
function expandEndpoint(
  path: PathExpr,
  declaringPath: readonly string[],
  declaringLabel: string,
  containerByPath: ReadonlyMap<string, ContainerModel>,
  isHidden: (path: readonly string[]) => boolean,
  stmtSpan: SourceSpan,
  diags: Diagnostic[],
): readonly (readonly string[])[] {
  const wildcardIdx = path.segments.findIndex((s) => s.kind === 'Wildcard');

  if (wildcardIdx === -1) {
    const base = resolveBase(path, declaringPath);
    const target = base && [...base, ...(path.segments as NameStep[]).map((s) => s.value)];
    if (base === undefined || !containerByPath.has(nodeIdFromPath(target as readonly string[]))) {
      diags.push(diagnostic('SGL2001', stmtSpan, { path: renderPath(path), container: declaringLabel }));
      return [];
    }
    return [target as readonly string[]];
  }

  if (wildcardIdx !== path.segments.length - 1) {
    diags.push(diagnostic('SGL3004', stmtSpan, { path: renderPath(path) }));
    return [];
  }

  const wildcard = path.segments[wildcardIdx] as WildcardStep;
  const base = resolveBase(path, declaringPath);
  const prefixPath = base && [...base, ...(path.segments.slice(0, -1) as NameStep[]).map((s) => s.value)];
  const prefixContainer = prefixPath && containerByPath.get(nodeIdFromPath(prefixPath));
  if (base === undefined || prefixContainer === undefined) {
    diags.push(diagnostic('SGL2001', stmtSpan, { path: renderPath(path), container: declaringLabel }));
    return [];
  }

  const candidates = wildcard.depth === 'children' ? prefixContainer.children : preorderDescendants(prefixContainer);
  const matches = candidates.filter((c) => !isHidden(c.path) && matchesWildcard(wildcard, c.key));
  if (matches.length === 0) {
    diags.push(diagnostic('SGL3003', stmtSpan, { path: renderPath(path) }));
    return [];
  }
  return matches.map((m) => m.path);
}

function isWildcardEndpoint(path: PathExpr): boolean {
  const last = path.segments[path.segments.length - 1];
  return last !== undefined && last.kind === 'Wildcard';
}

/** A resolved, not-yet-identified edge: concrete endpoints, validated ports, but
 *  no `EdgeId` yet — that needs the whole document's edges in order (§5). */
interface PendingEdge {
  readonly fromPath: readonly string[];
  readonly toPath: readonly string[];
  readonly fromPort?: string;
  readonly toPort?: string;
  readonly directed: EdgeModel['directed'];
  readonly classes: readonly string[];
  readonly config: ConfigBag;
  readonly declaredIn: NodeId | null;
  readonly span: SourceSpan;
}

/** `fromPort`/`toPort` must appear in the resolved node's own `@ports`; a miss is
 *  `SGL2003` and the port is dropped, once per matched node (DD-03 §3, §3.1). */
function validatePort(
  targetPath: readonly string[],
  port: string | undefined,
  containerByPath: ReadonlyMap<string, ContainerModel>,
  span: SourceSpan,
  diags: Diagnostic[],
): string | undefined {
  if (port === undefined) return undefined;
  const container = containerByPath.get(nodeIdFromPath(targetPath));
  const ports = container && isConfigBag(container.config.ports) ? container.config.ports : undefined;
  if (ports !== undefined && Object.hasOwn(ports, port)) return port;
  diags.push(diagnostic('SGL2003', span, { node: nodeIdFromPath(targetPath), port }));
  return undefined;
}

function compileEdgeModel(
  edgeModel: EdgeModel,
  declaringPath: readonly string[],
  declaringId: NodeId | null,
  stmtSpan: SourceSpan,
  ctx: NodeMap,
  classTable: Readonly<Record<string, ClassModel>>,
  diags: Diagnostic[],
): readonly PendingEdge[] {
  const declaringLabel = declaringPath.length === 0 ? 'the document root' : declaringPath.join('.');
  const isHidden = (p: readonly string[]): boolean => ctx.nodes[asNodeId(nodeIdFromPath(p))]?.hidden === true;

  const fromTargets = expandEndpoint(edgeModel.from, declaringPath, declaringLabel, ctx.containerByPath, isHidden, stmtSpan, diags);
  const toTargets = expandEndpoint(edgeModel.to, declaringPath, declaringLabel, ctx.containerByPath, isHidden, stmtSpan, diags);
  if (fromTargets.length === 0 || toTargets.length === 0) return [];

  const product = fromTargets.length * toTargets.length;
  if (product > MAX_EDGE_EXPANSION) {
    diags.push(
      diagnostic('SGL3005', stmtSpan, {
        from: renderPath(edgeModel.from),
        op: OP_SYMBOL[edgeModel.directed],
        to: renderPath(edgeModel.to),
        n: product,
        max: MAX_EDGE_EXPANSION,
      }),
    );
    return [];
  }

  // "Both sides wildcarded" excludes self-pairs (language spec §3); an ordinary
  // endpoint that happens to coincide with one member of the other side's
  // expansion is a legitimate edge, not a cross-product artefact.
  const bothWildcard = isWildcardEndpoint(edgeModel.from) && isWildcardEndpoint(edgeModel.to);
  const classes = linearizeClasses(typeNamesOf(edgeModel.config), classTable);

  const out: PendingEdge[] = [];
  for (const fromPath of fromTargets) {
    for (const toPath of toTargets) {
      if (bothWildcard && nodeIdFromPath(fromPath) === nodeIdFromPath(toPath)) continue;
      const fromPort = validatePort(fromPath, edgeModel.fromPort, ctx.containerByPath, stmtSpan, diags);
      const toPort = validatePort(toPath, edgeModel.toPort, ctx.containerByPath, stmtSpan, diags);
      out.push({
        fromPath,
        toPath,
        directed: edgeModel.directed,
        classes,
        config: edgeModel.config,
        declaredIn: declaringId,
        span: stmtSpan,
        ...(fromPort !== undefined ? { fromPort } : {}),
        ...(toPort !== undefined ? { toPort } : {}),
      });
    }
  }
  return out;
}

/** Every `EdgeModel` in the document, in the order DD-03 §5 wants: the
 *  declaring container in [traversal] order, then declaration order within it.
 *  `fullOrder` (not the hidden-filtered `order`) is what "traversal order" means
 *  here — an edge inside a hidden container still needs a stable position. */
function collectPendingEdges(
  model: DocumentModel,
  ctx: NodeMap,
  diags: Diagnostic[],
): readonly PendingEdge[] {
  const out: PendingEdge[] = [];
  const processContainer = (container: ContainerModel, declaringPath: readonly string[], declaringId: NodeId | null): void => {
    container.edges.forEach((edgeModel, i) => {
      const stmtSpan = model.spans.get(`e:${nodeIdFromPath(declaringPath)}#${i}`) ?? NO_SPAN;
      out.push(...compileEdgeModel(edgeModel, declaringPath, declaringId, stmtSpan, ctx, model.classes, diags));
    });
  };

  processContainer(model.root, [], null);
  for (const id of ctx.fullOrder) {
    processContainer(ctx.containerByPath.get(id) as ContainerModel, (ctx.nodes[id] as GraphNode).path, id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edge IDs (DD-03 §5) and labels (§6)
// ---------------------------------------------------------------------------

function finalizeEdges(pending: readonly PendingEdge[]): { edges: GraphEdge[]; labels: Record<string, LabelSpec> } {
  const parallelCounts = new Map<string, number>();
  const edges: GraphEdge[] = [];
  const labels: Record<string, LabelSpec> = {};

  for (const p of pending) {
    const fromId = asNodeId(nodeIdFromPath(p.fromPath));
    const toId = asNodeId(nodeIdFromPath(p.toPath));
    const baseKey = `${fromId}\x1f${p.fromPort ?? ''}\x1f${p.directed}\x1f${toId}\x1f${p.toPort ?? ''}`;
    const parallelIndex = parallelCounts.get(baseKey) ?? 0;
    parallelCounts.set(baseKey, parallelIndex + 1);
    const id = asEdgeId(`e-${fnv1a64(`${baseKey}\x1f${parallelIndex}`)}`);

    const from: GraphEndpoint = { node: fromId, ...(p.fromPort !== undefined ? { port: asPortId(p.fromPort) } : {}) };
    const to: GraphEndpoint = { node: toId, ...(p.toPort !== undefined ? { port: asPortId(p.toPort) } : {}) };

    // Edge label: DD-03 §6 gives it no key-derived fallback — only an explicit,
    // non-empty `@label` earns a `LabelSpec`.
    const labelText = typeof p.config.label === 'string' ? p.config.label : '';
    const labelId = labelText === '' ? null : asLabelId(`l:${id}`);

    edges.push({ id, from, to, directed: p.directed, classes: p.classes, labelId, config: p.config, declaredIn: p.declaredIn, span: p.span });
    if (labelId !== null) labels[labelId] = { id: labelId, owner: { kind: 'edge', id }, role: 'edge', runs: textRuns(labelText) };
  }

  return { edges, labels };
}

/** One `SGL3002` per hidden node with at least one incident edge, counting each
 *  edge once even when both endpoints are the same hidden node (a self-loop). */
function reportHiddenIncidence(edges: readonly GraphEdge[], nodes: Readonly<Record<NodeId, GraphNode>>, diags: Diagnostic[]): void {
  const counts = new Map<NodeId, number>();
  for (const e of edges) {
    const touched = e.from.node === e.to.node ? [e.from.node] : [e.from.node, e.to.node];
    for (const nid of touched) if (nodes[nid]?.hidden) counts.set(nid, (counts.get(nid) ?? 0) + 1);
  }
  for (const [nid, n] of counts) diags.push(diagnostic('SGL3002', (nodes[nid] as GraphNode).span, { node: nid, n }));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Compile the document model to the semantic graph: expand wildcard endpoints,
 * resolve edge endpoints to node IDs, allocate stable edge IDs, extract labels,
 * resolve shapes.
 *
 * Expansion happens here rather than in `resolve` for two reasons: it needs the
 * node tree, which only exists once the document model is built; and leaving the
 * wildcard intact in the model keeps `.sgl.json` a record of what the author wrote
 * rather than of what it expanded to (DD-02 §6).
 *
 * `view` is reserved for I1 (one model, many views) — see 04 §8.
 *
 * Design: DD-03.
 */
export function compile(model: DocumentModel, view?: ViewSelector): CompileResult {
  void view;
  const diags: Diagnostic[] = [];

  const nodeMap = buildNodeMap(model, diags);
  const pending = collectPendingEdges(model, nodeMap, diags);
  const { edges, labels: edgeLabels } = finalizeEdges(pending);

  const labels: Record<string, LabelSpec> = { ...edgeLabels };
  for (const node of Object.values(nodeMap.nodes)) {
    if (node.labelId === null) continue;
    const text = typeof node.config.label === 'string' ? node.config.label : (node.path[node.path.length - 1] as string);
    labels[node.labelId] = { id: node.labelId, owner: { kind: 'node', id: node.id }, role: 'title', runs: textRuns(text) };
  }

  reportHiddenIncidence(edges, nodeMap.nodes, diags);

  const rootChildren = model.root.children.map((c) => asNodeId(nodeIdFromPath(c.path)));
  const containerCount = Object.values(nodeMap.nodes).filter((n) => n.children.length > 0).length;
  const title = typeof model.root.config.title === 'string' ? model.root.config.title : undefined;

  const graph: SemanticGraph = {
    nodes: nodeMap.nodes,
    edges,
    rootChildren,
    order: nodeMap.order,
    labels,
    ...(title !== undefined ? { title } : {}),
    meta: { nodeCount: Object.keys(nodeMap.nodes).length, edgeCount: edges.length, containerCount },
  };

  return { graph, diagnostics: diags };
}
