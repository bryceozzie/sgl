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

import type { NameStep, PathExpr, PathStep } from './ast.js';
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
import { LANGUAGE_SHAPES } from './config-registry.js';
import { fnv1a64 } from './hash.js';
import { asEdgeId, asLabelId, asNodeId, asPortId, DRAWABLE_SHAPES, nodeIdFromPath, type NodeId, type ShapeId } from './ids.js';
import type { ClassModel, ConfigBag, ConfigValue, ContainerModel, DocumentModel, EdgeModel, SpanTable } from './model.js';
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
 *
 * F3: a class already on the current path is a cycle. `resolve()` splices every
 * back-edge before a model gets here, but a second producer of class tables
 * (A9 imports) need not, so the walk skips the back-edge and reports it with the
 * resolver's `SGL2004` rather than overflowing the stack. The cycle is rotated
 * to start at its least member, so it reads the same from every node and edge
 * that reaches it, and is reported once.
 */
function linearizeClasses(
  typeNames: readonly string[],
  classes: Readonly<Record<string, ClassModel>>,
  spans: SpanTable,
  diags: Diagnostic[],
): string[] {
  const order: string[] = [];
  const path: string[] = [];
  const visit = (name: string): void => {
    path.push(name);
    for (const base of classes[name]?.extends ?? []) {
      const at = path.indexOf(base);
      if (at === -1) {
        visit(base);
        continue;
      }
      const cycle = path.slice(at);
      const start = cycle.indexOf([...cycle].sort()[0] as string);
      const members = [...cycle.slice(start), ...cycle.slice(0, start)];
      const d = diagnostic('SGL2004', spans.get(`c:${members[0]}`) ?? NO_SPAN, {
        a: members[0] as string,
        cycle: [...members, members[0]].join(' -> '),
      });
      if (!diags.some((x) => x.message === d.message)) diags.push(d);
    }
    path.pop();
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

/** F2 (execution plan §2.1): a value that came from a class — not the node's own
 *  inline `@`-key — carries a `related` span pointing at that class's
 *  declaration (`model.spans.get('c:<name>')`, populated by `resolve()`'s
 *  `buildClasses`), so three nodes extending one bad class produce three
 *  diagnostics that all point back at the one place to fix, instead of three
 *  that point nowhere useful. `undefined` (an inline value, or a class whose
 *  span was somehow missing — never in practice, defensive only) omits
 *  `related` entirely rather than passing an empty array, matching
 *  `diagnostic()`'s own optional-parameter contract. */
function classDeclarationRelated(
  sourceClass: string | undefined,
  spans: SpanTable,
): readonly { readonly span: SourceSpan; readonly message: string }[] | undefined {
  if (sourceClass === undefined) return undefined;
  const span = spans.get(`c:${sourceClass}`);
  return span === undefined ? undefined : [{ span, message: `Class '${sourceClass}' declared here.` }];
}

/** Inline `config.shape` wins; otherwise the first class in reverse linearised
 *  order (highest precedence first) that defines one. A name in neither list
 *  (`SGL3001`, "unknown") or a name the language recognises but this version's
 *  renderer does not yet draw (`SGL3006`, `checkout.sgl`'s `@shape: cloud`
 *  among them) both fall back to `rect`; no shape anywhere is `rect` without a
 *  warning. Whichever code fires, the guarantee downstream stages rely on
 *  (DD-03 §4) is total: `GraphNode.shape` is always one DD-07 §4 can draw. */
function resolveShape(
  config: ConfigBag,
  classes: readonly string[],
  classTable: Readonly<Record<string, ClassModel>>,
  span: SourceSpan,
  spans: SpanTable,
  diags: Diagnostic[],
): ShapeId {
  let raw: string | undefined = typeof config.shape === 'string' ? config.shape : undefined;
  let sourceClass: string | undefined;
  if (raw === undefined) {
    for (let i = classes.length - 1; i >= 0; i -= 1) {
      const clsName = classes[i] as string;
      const clsShape = classTable[clsName]?.config.shape;
      if (typeof clsShape === 'string') {
        raw = clsShape;
        sourceClass = clsName;
        break;
      }
    }
  }
  if (raw === undefined) return 'rect';
  if (DRAWABLE_SHAPES.has(raw)) return raw;
  const related = classDeclarationRelated(sourceClass, spans);
  if (LANGUAGE_SHAPES.has(raw)) {
    diags.push(diagnostic('SGL3006', span, { name: raw }, related));
    return 'rect';
  }
  diags.push(diagnostic('SGL3001', span, { name: raw }, related));
  return 'rect';
}

/** A port's merged value plus which class (if any — `undefined` means the
 *  node's own inline `@ports`) last contributed it, for F2's `related` span. */
interface PortSource {
  readonly side: ConfigValue;
  readonly sourceClass: string | undefined;
}

/** Ports merge across the linearised class chain (low → high precedence, same
 *  order as `classes`) and then inline, per port id, with inline winning — the
 *  same precedence `resolveShape` uses, applied per-key instead of to a single
 *  scalar (DD-02 §7's `ports | node, class`, cascade documented at DD-03 §3). */
function mergePorts(
  config: ConfigBag,
  classes: readonly string[],
  classTable: Readonly<Record<string, ClassModel>>,
): Record<string, PortSource> | undefined {
  let merged: Record<string, PortSource> | undefined;
  for (const cls of classes) {
    const clsPorts = classTable[cls]?.config.ports;
    if (!isConfigBag(clsPorts)) continue;
    merged = merged ?? {};
    for (const [id, side] of Object.entries(clsPorts)) merged[id] = { side, sourceClass: cls };
  }
  if (isConfigBag(config.ports)) {
    merged = merged ?? {};
    for (const [id, side] of Object.entries(config.ports)) merged[id] = { side, sourceClass: undefined };
  }
  return merged;
}

const PORT_SIDES: ReadonlySet<string> = new Set(['north', 'south', 'east', 'west']);

/** A port whose value isn't one of the frozen four sides is `SGL3007` and falls
 *  back to `east` — the compiler's job, exactly as it owns `shape` (DD-02 §7's
 *  registry deliberately doesn't validate enum *values*). Covers a non-string
 *  value too, which used to be coerced to `east` in silence. */
function buildPorts(
  nodeId: NodeId,
  ports: Record<string, PortSource> | undefined,
  span: SourceSpan,
  spans: SpanTable,
  diags: Diagnostic[],
): readonly PortSpec[] {
  if (ports === undefined) return [];
  return Object.entries(ports).map(([id, { side, sourceClass }]) => {
    if (typeof side === 'string' && PORT_SIDES.has(side)) return { id: asPortId(id), side: side as PortSpec['side'] };
    const related = classDeclarationRelated(sourceClass, spans);
    diags.push(diagnostic('SGL3007', span, { node: nodeId, port: id, side: typeof side === 'string' ? side : JSON.stringify(side) }, related));
    return { id: asPortId(id), side: 'east' as const };
  });
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

    const classes = linearizeClasses(typeNamesOf(container.config), model.classes, model.spans, diags);
    const span = model.spans.get(`n:${pathKey}`) ?? NO_SPAN;
    const shape = resolveShape(container.config, classes, model.classes, span, model.spans, diags);
    const hidden = parentHidden || container.config.hidden === true;
    const noLabel = hidden || container.config.label === '';
    const labelId = noLabel ? null : asLabelId(`l:${pathKey}`);
    const ports = buildPorts(id, mergePorts(container.config, classes, model.classes), span, model.spans, diags);

    nodes[id] = {
      id,
      path: container.path,
      parent,
      children: container.children.map((c) => asNodeId(nodeIdFromPath(c.path))),
      depth,
      shape,
      classes,
      labelId,
      ports,
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
 *
 * A wildcard may sit in any segment (language spec §3, human decision
 * 2026-09-24); only `**` is confined to the last one. The literal prefix before
 * the first wildcard resolves exactly as an ordinary path does, so `../` and `/`
 * and an unresolvable prefix (`SGL2001`) behave as before.
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
    const target = base === undefined ? undefined : [...base, ...(path.segments as NameStep[]).map((s) => s.value)];
    // A target of length 0 resolves to the document root, which DD-03 §2.1 says
    // is never a node (`inner -> ../` from a one-level-deep container: `base`
    // and `segments` are both empty). `containerByPath` still has root registered
    // under `''`, so this needs its own check — `.has('')` would otherwise read
    // as a hit. The analogous check does not apply to the wildcard branch below:
    // there, an empty prefix legitimately means "root", used to enumerate root's
    // own children, never as an edge target in itself.
    if (target === undefined || target.length === 0 || !containerByPath.has(nodeIdFromPath(target))) {
      diags.push(diagnostic('SGL2001', stmtSpan, { path: renderPath(path), container: declaringLabel }));
      return [];
    }
    return [target];
  }

  // `**` is final-only: a descendants step anywhere else is a search, not a
  // shorthand (language spec §7), and stays SGL3004.
  const lastIdx = path.segments.length - 1;
  if (path.segments.some((s, i) => s.kind === 'Wildcard' && s.depth === 'descendants' && i !== lastIdx)) {
    diags.push(diagnostic('SGL3004', stmtSpan, { path: renderPath(path) }));
    return [];
  }

  const base = resolveBase(path, declaringPath);
  const prefixPath = base && [...base, ...(path.segments.slice(0, wildcardIdx) as NameStep[]).map((s) => s.value)];
  const prefixContainer = prefixPath && containerByPath.get(nodeIdFromPath(prefixPath));
  if (base === undefined || prefixContainer === undefined) {
    diags.push(diagnostic('SGL2001', stmtSpan, { path: renderPath(path), container: declaringLabel }));
    return [];
  }

  // Apply every step from the first wildcard on to each node the previous step
  // reached. The frontier stays in order and each parent contributes its
  // children in declaration order, so the result is depth-first in declaration
  // order. A reached node with no matching child (a leaf, or a parent whose
  // children all miss) just drops out; hidden nodes never enter the frontier.
  let frontier: readonly ContainerModel[] = [prefixContainer];
  for (const step of path.segments.slice(wildcardIdx)) {
    const next: ContainerModel[] = [];
    for (const parent of frontier) {
      const candidates = step.kind === 'Wildcard' && step.depth === 'descendants' ? preorderDescendants(parent) : parent.children;
      for (const c of candidates) {
        if (isHidden(c.path)) continue;
        if (step.kind === 'Name' ? c.key === step.value : matchesWildcard(step, c.key)) next.push(c);
      }
    }
    frontier = next;
  }

  // Only a whole endpoint expanding to nothing is worth a warning.
  if (frontier.length === 0) {
    diags.push(diagnostic('SGL3003', stmtSpan, { path: renderPath(path) }));
    return [];
  }
  return frontier.map((m) => m.path);
}

/** A wildcard in any segment makes the endpoint a generated set, for the
 *  both-sides self-pair rule (language spec §3). */
function isWildcardEndpoint(path: PathExpr): boolean {
  return path.segments.some((s) => s.kind === 'Wildcard');
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
  readonly hidden: boolean;
  readonly span: SourceSpan;
}

/** `fromPort`/`toPort` must appear in the target node's *merged* `@ports` set
 *  (class chain then inline, `mergePorts`) — consulting `GraphNode.ports`
 *  rather than re-reading `container.config.ports` is what makes that cascade
 *  visible here; the latter would wrongly reject a class-provided port. A miss
 *  is `SGL2003` and the port is dropped, once per *distinct* matched node
 *  (DD-03 §3, §3.1) — callers must call this once per unique target, not once
 *  per edge, or a wildcard fan-out reports the same miss many times over. */
function validatePort(
  targetPath: readonly string[],
  port: string | undefined,
  nodes: Readonly<Record<NodeId, GraphNode>>,
  span: SourceSpan,
  diags: Diagnostic[],
): string | undefined {
  if (port === undefined) return undefined;
  const node = nodes[asNodeId(nodeIdFromPath(targetPath))];
  if (node?.ports.some((p) => p.id === port)) return port;
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
  spans: SpanTable,
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
  const classes = linearizeClasses(typeNamesOf(edgeModel.config), classTable, spans, diags);
  const configHidden = edgeModel.config.hidden === true;

  // Resolve each side's port once per *distinct* target, before the cross
  // product, and reuse the result (DD-03 §3.1) — validating inside the nested
  // loop below would re-check (and re-warn on) the same node once per edge it
  // participates in, so `lane1.*[out] -> lane2.*[in]` over 3x2 nodes reported
  // six SGL2003s for two actually-portless nodes instead of two.
  const fromPortByTarget = new Map<string, string | undefined>();
  for (const fromPath of fromTargets) {
    const key = nodeIdFromPath(fromPath);
    if (!fromPortByTarget.has(key)) fromPortByTarget.set(key, validatePort(fromPath, edgeModel.fromPort, ctx.nodes, stmtSpan, diags));
  }
  const toPortByTarget = new Map<string, string | undefined>();
  for (const toPath of toTargets) {
    const key = nodeIdFromPath(toPath);
    if (!toPortByTarget.has(key)) toPortByTarget.set(key, validatePort(toPath, edgeModel.toPort, ctx.nodes, stmtSpan, diags));
  }

  const out: PendingEdge[] = [];
  for (const fromPath of fromTargets) {
    for (const toPath of toTargets) {
      const fromKey = nodeIdFromPath(fromPath);
      const toKey = nodeIdFromPath(toPath);
      if (bothWildcard && fromKey === toKey) continue;
      const fromPort = fromPortByTarget.get(fromKey);
      const toPort = toPortByTarget.get(toKey);
      // Effectively hidden (DD-03 §6): the edge's own `@hidden`, or either
      // resolved endpoint's node is hidden — mirrors the node rule so a hidden
      // node's incident edges agree with it without an extra ancestor walk.
      const hidden = configHidden || ctx.nodes[asNodeId(fromKey)]?.hidden === true || ctx.nodes[asNodeId(toKey)]?.hidden === true;
      out.push({
        fromPath,
        toPath,
        directed: edgeModel.directed,
        classes,
        config: edgeModel.config,
        declaredIn: declaringId,
        hidden,
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
      out.push(...compileEdgeModel(edgeModel, declaringPath, declaringId, stmtSpan, ctx, model.classes, model.spans, diags));
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
    // non-empty `@label` earns a `LabelSpec`, and a hidden edge gets none at
    // all, same as a hidden node.
    const labelText = typeof p.config.label === 'string' ? p.config.label : '';
    const labelId = p.hidden || labelText === '' ? null : asLabelId(`l:${id}`);

    edges.push({ id, from, to, directed: p.directed, classes: p.classes, labelId, config: p.config, declaredIn: p.declaredIn, hidden: p.hidden, span: p.span });
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
