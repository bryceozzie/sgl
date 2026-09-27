import type { EdgeId, GraphEdge, GraphNode, Insets, LabelId, NodeId, PathSeg, Point, Rect, Size, Vec2 } from '@sgl/core';
import type {
  EdgeLayout,
  LabelPlacement,
  LayoutInput,
  LayoutResult,
  NodeLayout,
  NodeSizing,
  ResolvedThemeMetricsView,
} from '@sgl/layout-api';
import { ELK_PORT_CONSTRAINTS, type ElkDirection, type ElkOptions } from './descriptor.js';

/**
 * DD-06 §6.1 (input mapping) and §6.2 (output mapping), as two pure functions.
 * No elkjs import here: the JSON ELK takes and returns is described
 * structurally below, so these run and are tested without loading elkjs at
 * all, and the goldens (`test/__goldens__/`) are exactly what crosses the
 * boundary.
 *
 * Where this departs from DD-06 §6.1's pseudocode, it is because elkjs 0.11
 * behaves differently from what the pseudocode assumed — each case was found
 * by running ELK and is recorded in DD-06 §6.1 itself:
 *
 * - **A label with empty `text` is ignored**: ELK neither places it nor
 *   reserves room for it. Every label is sent with its `LabelId` as `text`
 *   (ELK never measures text; it only needs a non-empty string).
 * - **`[H_LEFT, V_TOP, INSIDE]` on a container reserves a left column as wide
 *   as the title**, as well as the top band, pushing every child right by the
 *   title's width (and ELK adds that band on top of `elk.padding.top`). So a
 *   container's title is **not sent to ELK** (fix round 1, item 1): the whole
 *   band is in `elk.padding.top` (`NodeSizing.padding.top`, once), the title's
 *   width is a minimum width, and `fromElkGraph` puts the title top-left in
 *   ELK's container frame, inset by `contentInset` (DD-06 §4.1), align
 *   `start`. The reviewer's `[H_LEFT, V_TOP, INSIDE, V_PRIORITY]` gives the
 *   byte-identical layout, but only because `V_PRIORITY` is not a member of
 *   ELK's `NodeLabelPlacement` and ELK then ignores the whole value
 *   (`elk.test.ts` pins that equivalence).
 * - **`elk.nodeLabels.padding` is read from a node's parent**, not the node,
 *   and defaults to 5 px; it is zeroed on the root and every container so the
 *   label boxes below are the only insets in play.
 * - **Spacing options are per graph level** under `INCLUDE_CHILDREN`, not
 *   inherited from the root, so they are repeated on every container.
 * - **`elk.nodeSize.minimum` is not transposed** for `DOWN`/`UP`: ELK applies
 *   the pair as (height, width) there. It is sent swapped for those directions.
 * - **An edge's coordinates (sections and labels) are relative to the node
 *   ELK reports in its `container` field** — the lowest common ancestor of its
 *   endpoints — not always the root it was declared on.
 *
 * **Label boxes.** DD-06 §4.1 puts a leaf's title at the centre of its
 * *content box* (the frame inset by `NodeSizing.contentInset`). ELK centres a label in the
 * *frame*. The two differ only where the insets are asymmetric (a cylinder's
 * top cap, a package's tab). So ELK is given a label box that is the measured
 * label grown by the asymmetric part of the insets, on the side that needs
 * it; ELK places that box, the `LabelPlacement` frame is exactly that box
 * (ELK's coordinates, unmodified), and `align`/`baseline` put the text at the
 * box's inner edge.
 */

// ---------------------------------------------------------------------------
// ELK's JSON graph, the subset this adapter writes and reads.
// ---------------------------------------------------------------------------

export type ElkLayoutOptions = Readonly<Record<string, string>>;

export interface ElkLabel {
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly layoutOptions?: ElkLayoutOptions;
  readonly x?: number;
  readonly y?: number;
}

export interface ElkPort {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly layoutOptions?: ElkLayoutOptions;
  readonly x?: number;
  readonly y?: number;
}

export interface ElkNode {
  readonly id: string;
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly layoutOptions?: ElkLayoutOptions;
  readonly labels?: readonly ElkLabel[];
  readonly ports?: readonly ElkPort[];
  readonly children?: readonly ElkNode[];
  readonly edges?: readonly ElkEdge[];
}

export interface ElkSection {
  readonly startPoint: Point;
  readonly endPoint: Point;
  readonly bendPoints?: readonly Point[];
}

export interface ElkEdge {
  readonly id: string;
  readonly sources: readonly string[];
  readonly targets: readonly string[];
  readonly labels?: readonly ElkLabel[];
  readonly layoutOptions?: ElkLayoutOptions;
  readonly sections?: readonly ElkSection[];
  /** Set by ELK on output: the node whose coordinate system the sections and
   *  labels are in. */
  readonly container?: string;
}

export const ELK_ROOT_ID = 'root';

/** DD-06 §6.1's `elk.randomSeed` (ADR-0005 spells the same option
 *  `org.eclipse.elk.randomSeed`; elkjs accepts either). Pinned (K2). */
export const ELK_RANDOM_SEED = '1';

const DIRECTION: Readonly<Record<ElkDirection, string>> = { down: 'DOWN', up: 'UP', left: 'LEFT', right: 'RIGHT' };
const PORT_SIDE: Readonly<Record<string, string>> = { north: 'NORTH', south: 'SOUTH', east: 'EAST', west: 'WEST' };
const ZERO_LABEL_PADDING = '[top=0,left=0,bottom=0,right=0]';
const LEAF_LABEL_PLACEMENT = '[H_CENTER, V_CENTER, INSIDE]';

/** ELK number options are strings; `String(n)` of a finite number is
 *  deterministic and round-trips. */
const num = (n: number): string => String(n);

// ---------------------------------------------------------------------------
// §6.1 — LayoutInput → ElkNode
// ---------------------------------------------------------------------------

/** The spacing options every graph level needs (they are not inherited). */
function levelOptions(options: ElkOptions, metrics: ResolvedThemeMetricsView): Record<string, string> {
  return {
    'elk.spacing.nodeNode': num(options.nodeSpacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': num(options.rankSpacing),
    'elk.spacing.edgeLabel': num(metrics.spacing.edgeLabel),
    'elk.nodeLabels.padding': ZERO_LABEL_PADDING,
  };
}

export function toElkGraph(input: LayoutInput, options: ElkOptions, metrics: ResolvedThemeMetricsView): ElkNode {
  const { graph } = input;
  const level = levelOptions(options, metrics);
  const vertical = options.direction === 'down' || options.direction === 'up';

  const visibleChildren = (ids: readonly NodeId[]): NodeId[] => ids.filter((id) => graph.nodes[id]?.hidden === false);
  const topIds = input.scope === null ? visibleChildren(graph.rootChildren) : [input.scope];
  const inScope = input.scope === null ? null : subtreeOf(input, input.scope);

  const toElkNode = (id: NodeId): ElkNode => {
    const node = graph.nodes[id];
    const sizing = input.sizing[id];
    if (node === undefined || sizing === undefined) throw new Error(`elk: no node or sizing for '${id}'.`);
    // A container whose children are all hidden is laid out as a leaf: ELK
    // sizes a node from its children only when it has some.
    const isContainer = visibleChildren(node.children).length > 0;
    const label = node.labelId === null ? null : (input.labelSizes[node.labelId] ?? { w: 0, h: 0 });
    // A container's title is not sent to ELK at all (fix round 1, item 1):
    // ELK leaves the band `elk.padding.top` reserves, and `fromElkGraph`
    // puts the title in it, top-left (DD-06 §4.1, §6.1).
    const labels = label === null || node.labelId === null || isContainer ? [] : [nodeLabel(node.labelId, label, sizing)];
    const ports = node.ports.map((p) => ({
      id: portId(id, p.id),
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': PORT_SIDE[p.side] ?? 'EAST' },
    }));
    const hints = hintsOf(node.config);
    const nodeOptions: Record<string, string> = {};
    const hinted = hints['portConstraints'];
    // DD-06 §6's enum; an unknown value is skipped (fix round 1, item 4).
    const constraints = typeof hinted === 'string' && (ELK_PORT_CONSTRAINTS as readonly string[]).includes(hinted) ? hinted : undefined;
    if (constraints !== undefined) nodeOptions['elk.portConstraints'] = constraints;
    else if (ports.length > 0) nodeOptions['elk.portConstraints'] = 'FIXED_SIDE';

    if (isContainer) {
      // `padding.top` already holds the title band (DD-06 §2), and ELK adds
      // nothing for a title it is not given: the band counts exactly once.
      const [t, r, b, l] = sizing.padding;
      nodeOptions['elk.padding'] = `[top=${num(t)},left=${num(l)},bottom=${num(b)},right=${num(r)}]`;
      // ELK sizes a container from its children only, so a title wider than
      // them would overflow: the title's own width is a minimum.
      const titleW = label === null ? undefined : label.w + sizing.contentInset[1] + sizing.contentInset[3];
      const minW = sizing.min?.w === undefined ? titleW : Math.max(sizing.min.w, titleW ?? 0);
      const minH = sizing.min?.h;
      if (minW !== undefined || minH !== undefined) {
        const w = minW ?? 0;
        const h = minH ?? 0;
        nodeOptions['elk.nodeSize.constraints'] = 'MINIMUM_SIZE';
        nodeOptions['elk.nodeSize.minimum'] = vertical ? `(${num(h)},${num(w)})` : `(${num(w)},${num(h)})`;
      }
      return {
        id,
        layoutOptions: { ...level, ...nodeOptions },
        ...(ports.length > 0 && { ports }),
        children: visibleChildren(node.children).map(toElkNode),
      };
    }

    const size = leafSize(sizing);
    return {
      id,
      width: size.w,
      height: size.h,
      ...(Object.keys(nodeOptions).length > 0 && { layoutOptions: nodeOptions }),
      labels,
      ...(ports.length > 0 && { ports }),
    };
  };

  const edges: ElkEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.hidden) continue;
    if (inScope !== null && (!inScope.has(edge.from.node) || !inScope.has(edge.to.node))) continue;
    edges.push(toElkEdge(input, edge));
  }

  return {
    id: ELK_ROOT_ID,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': DIRECTION[options.direction],
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.randomSeed': ELK_RANDOM_SEED,
      'elk.edgeRouting': options.edgeRouting,
      'elk.layered.nodePlacement.strategy': options.nodePlacement,
      ...level,
    },
    children: topIds.map(toElkNode),
    edges,
  };
}

function toElkEdge(input: LayoutInput, edge: GraphEdge): ElkEdge {
  const labelSize = edge.labelId === null ? undefined : (input.labelSizes[edge.labelId] ?? { w: 0, h: 0 });
  const hints = hintsOf(edge.config);
  const priority = hints['priority'];
  return {
    id: edge.id,
    sources: [edge.from.port !== undefined ? portId(edge.from.node, edge.from.port) : edge.from.node],
    targets: [edge.to.port !== undefined ? portId(edge.to.node, edge.to.port) : edge.to.node],
    labels:
      edge.labelId === null || labelSize === undefined
        ? []
        : [{ text: edge.labelId, width: labelSize.w, height: labelSize.h, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }],
    ...(typeof priority === 'number' && Number.isFinite(priority) && { layoutOptions: { 'elk.layered.priority.direction': num(priority) } }),
  };
}

/** `fixed ?? clamp(intrinsic, min, max)`, per axis (DD-06 §6.1). */
export function leafSize(sizing: NodeSizing): Size {
  const axis = (k: 'w' | 'h'): number => {
    const fixed = sizing.fixed?.[k];
    if (fixed !== undefined) return fixed;
    let v = sizing.intrinsic[k];
    const max = sizing.max?.[k];
    const min = sizing.min?.[k];
    if (max !== undefined) v = Math.min(v, max);
    if (min !== undefined) v = Math.max(v, min);
    return v;
  };
  return { w: axis('w'), h: axis('h') };
}

/** How the label box ELK is given sits around the measured label: the extra
 *  on each side, and the `align`/`baseline` that put the text back at the
 *  box's inner edge (see the file comment). */
export interface LabelBox {
  readonly extra: Insets;
  readonly align: LabelPlacement['align'];
  readonly baseline: LabelPlacement['baseline'];
}

export function labelBox(contentInset: Insets): LabelBox {
  const [t, r, b, l] = contentInset;
  const left = Math.max(0, l - r);
  const right = Math.max(0, r - l);
  const align: LabelPlacement['align'] = left > 0 ? 'end' : right > 0 ? 'start' : 'middle';
  const top = Math.max(0, t - b);
  const bottom = Math.max(0, b - t);
  const baseline: LabelPlacement['baseline'] = top > 0 ? 'bottom' : bottom > 0 ? 'top' : 'middle';
  return { extra: [top, right, bottom, left], align, baseline };
}

function nodeLabel(labelId: LabelId, label: Size, sizing: NodeSizing): ElkLabel {
  const { extra } = labelBox(sizing.contentInset);
  return {
    text: labelId,
    width: label.w + extra[1] + extra[3],
    height: label.h + extra[0] + extra[2],
    layoutOptions: { 'elk.nodeLabels.placement': LEAF_LABEL_PLACEMENT },
  };
}

/** ELK port ids are global, so a port is named after its node (DD-06 §6.1). */
export function portId(node: NodeId, port: string): string {
  return `${node}#${port}`;
}

function hintsOf(config: GraphNode['config']): Readonly<Record<string, unknown>> {
  const layout = config['layout'];
  return typeof layout === 'object' && layout !== null && !Array.isArray(layout) ? (layout as Readonly<Record<string, unknown>>) : {};
}

function subtreeOf(input: LayoutInput, top: NodeId): ReadonlySet<NodeId> {
  const out = new Set<NodeId>();
  const walk = (id: NodeId): void => {
    const node = input.graph.nodes[id];
    if (node === undefined || node.hidden) return;
    out.add(id);
    for (const child of node.children) walk(child);
  };
  walk(top);
  return out;
}

// ---------------------------------------------------------------------------
// §6.2 — ELK's laid-out ElkNode → LayoutResult
// ---------------------------------------------------------------------------

const SIDE_NORMAL: Readonly<Record<string, Vec2>> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

/**
 * Walks ELK's output, accumulating each node's parent offset into absolute
 * coordinates (ELK's are parent-relative). Engine output only: DD-06 §6.2's
 * "then the host applies §4.4 and §4.5" is `applyHostFallbacks`' job, in the
 * worker runtime, like every engine's.
 *
 * `arrowSize` turns on F16's detours round container titles (`avoidTitle`),
 * sized for that arrowhead; the engine leaves it out under SPLINES, whose
 * points are control points, not vertices (DD-06 §6.2).
 */
/** A coordinate ELK should have written. Missing is `NaN`, never `0`, so
 *  `validateResult` rejects the result (SGL4002) instead of the node quietly
 *  landing at its parent's origin (fix round 1, item 5). */
const coord = (v: number | undefined): number => v ?? Number.NaN;

export function fromElkGraph(input: LayoutInput, out: ElkNode, arrowSize?: number): LayoutResult {
  const { graph } = input;
  const nodes: Record<NodeId, NodeLayout> = {};
  const labels: LabelPlacement[] = [];
  const origin = new Map<string, Point>([[ELK_ROOT_ID, { x: 0, y: 0 }]]);
  const bands: TitleBand[] = [];

  const walk = (elk: ElkNode, parent: Point): void => {
    const id = elk.id as NodeId;
    const node = graph.nodes[id];
    const sizing = input.sizing[id];
    const abs: Point = { x: parent.x + coord(elk.x), y: parent.y + coord(elk.y) };
    origin.set(elk.id, abs);
    if (node === undefined || sizing === undefined) throw new Error(`elk: ELK returned unknown node '${elk.id}'.`);
    const frame: Rect = { x: abs.x, y: abs.y, w: coord(elk.width), h: coord(elk.height) };
    const isContainer = (elk.children?.length ?? 0) > 0;

    const ports: Record<string, { readonly point: Point; readonly normal: Vec2 }> = {};
    for (const spec of node.ports) {
      const port = elk.ports?.find((p) => p.id === portId(id, spec.id));
      if (port === undefined) continue;
      ports[spec.id] = {
        point: { x: abs.x + coord(port.x) + port.width / 2, y: abs.y + coord(port.y) + port.height / 2 },
        normal: SIDE_NORMAL[spec.side] ?? { x: 1, y: 0 },
      };
    }

    nodes[id] = {
      frame,
      ...(isContainer && { contentFrame: inset(frame, sizing.padding) }),
      ...(node.ports.length > 0 && { ports }),
    };

    if (node.labelId !== null && isContainer) {
      // DD-06 §4.1/§6.1: a container's title sits top-left in the band ELK
      // left (`elk.padding.top`), inset by `contentInset` — the same place
      // grid's host fallback puts it, align `start`, baseline `top`.
      const size = input.labelSizes[node.labelId] ?? { w: 0, h: 0 };
      const title: Rect = { x: frame.x + sizing.contentInset[3], y: frame.y + sizing.contentInset[0], w: size.w, h: size.h };
      bands.push({ id, frame, title, bottom: frame.y + sizing.padding[0] });
      labels.push({ labelId: node.labelId, frame: title, align: 'start', baseline: 'top' });
    }
    const elkLabel = elk.labels?.[0];
    if (node.labelId !== null && !isContainer && elkLabel !== undefined) {
      const box = labelBox(sizing.contentInset);
      labels.push({
        labelId: node.labelId,
        frame: { x: abs.x + coord(elkLabel.x), y: abs.y + coord(elkLabel.y), w: elkLabel.width, h: elkLabel.height },
        align: box.align,
        baseline: box.baseline,
      });
    }

    for (const child of elk.children ?? []) walk(child, abs);
  };
  for (const child of out.children ?? []) walk(child, { x: 0, y: 0 });

  const edgeById = new Map<EdgeId, GraphEdge>(graph.edges.map((e) => [e.id, e]));
  const routes: Route[] = [];
  for (const elkEdge of out.edges ?? []) {
    const edge = edgeById.get(elkEdge.id as EdgeId);
    if (edge === undefined) throw new Error(`elk: ELK returned unknown edge '${elkEdge.id}'.`);
    const offset = origin.get(elkEdge.container ?? ELK_ROOT_ID) ?? { x: 0, y: 0 };
    const points = edgePoints(elkEdge, offset);
    if (points !== null) routes.push({ edge, points });

    const elkLabel = elkEdge.labels?.[0];
    if (edge.labelId !== null && elkLabel !== undefined) {
      labels.push({
        labelId: edge.labelId,
        frame: { x: offset.x + coord(elkLabel.x), y: offset.y + coord(elkLabel.y), w: elkLabel.width, h: elkLabel.height },
        align: 'middle',
        baseline: 'top',
        occlusion: 'plate',
      });
    }
  }

  // F16: after every route is known, outer containers first (DD-06 §6.2).
  if (arrowSize !== undefined) for (const band of bands) avoidTitle(input, nodes, band, routes, arrowSize);
  const edges: Record<EdgeId, EdgeLayout> = {};
  for (const { edge, points } of routes) edges[edge.id] = edgeLayout(points);

  return {
    bounds: { x: 0, y: 0, w: out.width ?? 0, h: out.height ?? 0 },
    nodes,
    edges,
    labels,
  };
}

/** Every section in order: its start, then every bend point and the end point
 *  (DD-06 §6.2), dropping a point that repeats the previous one. A simple edge
 *  has exactly one section; an edge ELK did not route (no section) is `null`,
 *  left out, so the host's straight-routing fallback fills it. */
function edgePoints(elkEdge: ElkEdge, offset: Point): Point[] | null {
  const sections = elkEdge.sections ?? [];
  if (sections.length === 0) return null;
  const points: Point[] = [];
  for (const section of sections) {
    for (const p of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
      const last = points[points.length - 1];
      const at = { x: offset.x + p.x, y: offset.y + p.y };
      if (last === undefined || last.x !== at.x || last.y !== at.y) points.push(at);
    }
  }
  return points;
}

interface Route {
  readonly edge: GraphEdge;
  points: Point[];
}

/** A container, its frame, its title's text box, and the bottom of the band
 *  `elk.padding.top` left for the title. */
interface TitleBand {
  readonly id: NodeId;
  readonly frame: Rect;
  readonly title: Rect;
  readonly bottom: number;
}

/** Clearance from a title and from an arrowhead's line. */
const TITLE_GAP = 4;
/** Tolerance for every comparison of ELK's (and our) floating-point coordinates. */
const EPS = 1e-6;
const q64 = (v: number): number => Math.round(v * 64) / 64;

/** Whether the intervals `a–b` and `c–d` meet (touching counts). */
const span = (a: number, b: number, c: number, d: number): boolean =>
  Math.max(Math.min(a, b), Math.min(c, d)) <= Math.min(Math.max(a, b), Math.max(c, d)) + EPS;

/**
 * F16 (DD-06 §6.2). ELK is not given a container's title (§6.1 note 2), so a
 * route into the container (or out of it, upward) may run straight through
 * it. Each vertical run that passes the title from above to below, where the
 * container holds the run's far end, is detoured round the title's right:
 * it turns back to its own x below the title when what is left below is
 * long enough (before its end: room for the arrowhead); otherwise, ending on
 * its node (not a port) at the band's bottom, it ends on the node's top at
 * the new x, or enters the node's side. The m rightmost runs are stacked,
 * nested (the rightmost furthest right, turning highest and turning back
 * lowest); a detour that would meet another route, or another child, is not
 * made, and then one run fewer is tried, so the runs left alone are all left
 * of every detour. DD-06 §6.2. Orthogonal, on the 1/64 px grid, deterministic.
 */
function avoidTitle(input: LayoutInput, nodes: Readonly<Record<NodeId, NodeLayout>>, band: TitleBand, routes: readonly Route[], arrow: number): void {
  const { frame, title: t, bottom, id } = band;
  const under = t.y + t.h;
  const inside = (node: NodeId): boolean => {
    for (let at = input.graph.nodes[node]?.parent ?? null; at !== null; at = input.graph.nodes[at]?.parent ?? null) if (at === id) return true;
    return false;
  };
  // [route, its points oriented towards the run's far end, the run's index, that end]
  const runs: [Route, Point[], number, GraphEdge['to']][] = [];
  for (const route of routes) {
    for (const end of [route.edge.to, route.edge.from]) {
      const pts = end === route.edge.to ? route.points : [...route.points].reverse();
      const i = pts.findIndex((a, k) => {
        const b = pts[k + 1];
        return b !== undefined && Math.abs(a.x - b.x) < EPS && a.x > t.x + EPS && a.x < t.x + t.w - EPS && a.y < t.y + EPS && b.y > under - EPS;
      });
      if (i >= 0 && inside(end.node)) {
        runs.push([route, pts, i, end]);
        break;
      }
    }
  }
  // Rightmost first; stable.
  runs.sort((p, q) => q[1][q[2]]!.x - p[1][p[2]]!.x);
  const lane = Math.max(TITLE_GAP, 0.75 * arrow + 1);
  for (let m = runs.length; m > 0; m--) {
    const plan = new Map<Route, Point[]>();
    const fits = runs.slice(0, m).every(([route, pts, i, end], j) => {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const next = pts[i + 2];
      const f = nodes[end.node]!.frame;
      const top = Math.max(a.y, frame.y);
      const x = q64(t.x + t.w + TITLE_GAP + (m - 1 - j) * lane);
      const y = q64(top + ((t.y - top) * (j + 1)) / (m + 1));
      const back = q64(under + ((bottom - under) * (m - j)) / (m + 1));
      const side = q64(Math.max(x, f.x + f.w + arrow + TITLE_GAP));
      const mid = f.y + f.h / 2;
      // Turn back below the title when what is left of the run below it is
      // long enough: any length before another bend, and room for the
      // arrowhead and its clearance before the end. Otherwise end on the
      // node's top, or enter its side.
      const turn = back > under + EPS && b.y > back + (next === undefined ? arrow + TITLE_GAP - EPS : EPS);
      const chain = turn
        ? [
            { x: a.x, y },
            { x, y },
            { x, y: back },
            { x: a.x, y: back },
          ]
        : next === undefined &&
          end.port === undefined &&
          b.y < bottom + EPS &&
          b.y - y >= arrow + TITLE_GAP - EPS &&
          (x + 0.375 * arrow <= f.x + f.w + EPS
            ? [
                { x: a.x, y },
                { x, y },
                { x, y: b.y },
              ]
            : [
                { x: a.x, y },
                { x: side, y },
                { x: side, y: mid },
                { x: f.x + f.w, y: mid },
              ]);
      const meets = (p: Point, q: Point, r: Point, s: Point): boolean => span(p.x, q.x, r.x, s.x) && span(p.y, q.y, r.y, s.y);
      if (
        !chain ||
        t.y - top < EPS ||
        chain.some(
          (p, k) =>
            p.x > frame.x + frame.w - EPS ||
            (k > 0 &&
              (routes.some((r) => r !== route && (plan.get(r) ?? r.points).some((u, v, all) => v > 0 && meets(chain[k - 1]!, p, all[v - 1]!, u))) ||
                // Only a detour into its node's side leaves the band, into
                // the container's first layer: no other child may be in the way.
                input.graph.nodes[id]!.children.some((c) => {
                  const n = nodes[c]?.frame;
                  return c !== end.node && n !== undefined && meets(chain[k - 1]!, p, n, { x: n.x + n.w, y: n.y + n.h });
                }))),
        )
      ) {
        return false;
      }
      const done = [...pts.slice(0, i + 1), ...chain, ...(turn ? pts.slice(i + 1) : [])];
      plan.set(route, end === route.edge.to ? done : done.reverse());
      return true;
    });
    if (fits) {
      for (const [route, pts] of plan) route.points = pts;
      return;
    }
  }
}

function edgeLayout(points: readonly Point[]): EdgeLayout {
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const route: PathSeg[] = points.slice(1).map((to) => ({ t: 'L', to }));
  if (route.length === 0) route.push({ t: 'L', to: end });
  const second = points[1] ?? end;
  const penultimate = points[points.length - 2] ?? start;
  return {
    start,
    end,
    route,
    startNormal: direction(second, start) ?? { x: -1, y: 0 },
    endNormal: direction(penultimate, end) ?? { x: 1, y: 0 },
    clip: 'none',
  };
}

/** The unit vector from `a` to `b`, or `null` when they coincide. */
function direction(a: Point, b: Point): Vec2 | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  return len === 0 ? null : { x: dx / len, y: dy / len };
}

function inset(frame: Rect, [t, r, b, l]: Insets): Rect {
  return { x: frame.x + l, y: frame.y + t, w: Math.max(0, frame.w - l - r), h: Math.max(0, frame.h - t - b) };
}
