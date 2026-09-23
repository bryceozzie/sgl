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
import type { ElkDirection, ElkOptions } from './descriptor.js';

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
 *   title's width. Container titles use `[H_CENTER, V_TOP, INSIDE]`, which
 *   reserves the top band only: ELK centres the title over the container.
 * - **ELK adds the title band itself**: a child starts at `elk.padding.top +
 *   label height` (with `elk.nodeLabels.padding` zeroed). So `elk.padding.top`
 *   is `NodeSizing.padding.top` *minus* the title band, not all of it, or the
 *   band would be counted twice.
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
 * *content box* (the frame inset by `NodeSizing.contentInset`), and a
 * container's title at the content box's top edge. ELK centres a label in the
 * *frame*. The two differ only where the insets are asymmetric (a cylinder's
 * top cap, a package's tab). So ELK is given a label box that is the measured
 * label grown by the asymmetric part of the insets, on the side that needs
 * it; ELK places that box, the `LabelPlacement` frame is exactly that box
 * (ELK's coordinates, unmodified), and `align`/`baseline` put the text at the
 * box's inner edge. A container's box also absorbs `contentInset.top`, since
 * ELK puts a `V_TOP` label at the very top of the node.
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
const CONTAINER_LABEL_PLACEMENT = '[H_CENTER, V_TOP, INSIDE]';

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
    const labels = label === null || node.labelId === null ? [] : [nodeLabel(node.labelId, label, sizing, isContainer)];
    const ports = node.ports.map((p) => ({
      id: portId(id, p.id),
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': PORT_SIDE[p.side] ?? 'EAST' },
    }));
    const hints = hintsOf(node.config);
    const nodeOptions: Record<string, string> = {};
    if (ports.length > 0 || typeof hints['portConstraints'] === 'string') {
      nodeOptions['elk.portConstraints'] = typeof hints['portConstraints'] === 'string' ? hints['portConstraints'] : 'FIXED_SIDE';
    }

    if (isContainer) {
      const [, r, b, l] = sizing.padding;
      const titleBand = labels.length > 0 ? (labels[0]?.height ?? 0) : 0;
      const top = Math.max(0, sizing.padding[0] - titleBand);
      nodeOptions['elk.padding'] = `[top=${num(top)},left=${num(l)},bottom=${num(b)},right=${num(r)}]`;
      const minW = sizing.min?.w;
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
        labels,
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

export function labelBox(contentInset: Insets, isContainer: boolean): LabelBox {
  const [t, r, b, l] = contentInset;
  const left = Math.max(0, l - r);
  const right = Math.max(0, r - l);
  const align: LabelPlacement['align'] = left > 0 ? 'end' : right > 0 ? 'start' : 'middle';
  if (isContainer) {
    // V_TOP puts the box at the node's top edge: the whole top inset goes in.
    return { extra: [t, right, 0, left], align, baseline: 'bottom' };
  }
  const top = Math.max(0, t - b);
  const bottom = Math.max(0, b - t);
  const baseline: LabelPlacement['baseline'] = top > 0 ? 'bottom' : bottom > 0 ? 'top' : 'middle';
  return { extra: [top, right, bottom, left], align, baseline };
}

function nodeLabel(labelId: LabelId, label: Size, sizing: NodeSizing, isContainer: boolean): ElkLabel {
  const { extra } = labelBox(sizing.contentInset, isContainer);
  return {
    text: labelId,
    width: label.w + extra[1] + extra[3],
    height: label.h + extra[0] + extra[2],
    layoutOptions: { 'elk.nodeLabels.placement': isContainer ? CONTAINER_LABEL_PLACEMENT : LEAF_LABEL_PLACEMENT },
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
 */
export function fromElkGraph(input: LayoutInput, out: ElkNode): LayoutResult {
  const { graph } = input;
  const nodes: Record<NodeId, NodeLayout> = {};
  const labels: LabelPlacement[] = [];
  const origin = new Map<string, Point>([[ELK_ROOT_ID, { x: 0, y: 0 }]]);

  const walk = (elk: ElkNode, parent: Point): void => {
    const id = elk.id as NodeId;
    const node = graph.nodes[id];
    const sizing = input.sizing[id];
    const abs: Point = { x: parent.x + (elk.x ?? 0), y: parent.y + (elk.y ?? 0) };
    origin.set(elk.id, abs);
    if (node === undefined || sizing === undefined) throw new Error(`elk: ELK returned unknown node '${elk.id}'.`);
    const frame: Rect = { x: abs.x, y: abs.y, w: elk.width ?? 0, h: elk.height ?? 0 };
    const isContainer = (elk.children?.length ?? 0) > 0;

    const ports: Record<string, { readonly point: Point; readonly normal: Vec2 }> = {};
    for (const spec of node.ports) {
      const port = elk.ports?.find((p) => p.id === portId(id, spec.id));
      if (port === undefined) continue;
      ports[spec.id] = {
        point: { x: abs.x + (port.x ?? 0) + port.width / 2, y: abs.y + (port.y ?? 0) + port.height / 2 },
        normal: SIDE_NORMAL[spec.side] ?? { x: 1, y: 0 },
      };
    }

    nodes[id] = {
      frame,
      ...(isContainer && { contentFrame: inset(frame, sizing.padding) }),
      ...(node.ports.length > 0 && { ports }),
    };

    const elkLabel = elk.labels?.[0];
    if (node.labelId !== null && elkLabel !== undefined) {
      const box = labelBox(sizing.contentInset, isContainer);
      labels.push({
        labelId: node.labelId,
        frame: { x: abs.x + (elkLabel.x ?? 0), y: abs.y + (elkLabel.y ?? 0), w: elkLabel.width, h: elkLabel.height },
        align: box.align,
        baseline: box.baseline,
      });
    }

    for (const child of elk.children ?? []) walk(child, abs);
  };
  for (const child of out.children ?? []) walk(child, { x: 0, y: 0 });

  const edgeById = new Map<EdgeId, GraphEdge>(graph.edges.map((e) => [e.id, e]));
  const edges: Record<EdgeId, EdgeLayout> = {};
  for (const elkEdge of out.edges ?? []) {
    const edge = edgeById.get(elkEdge.id as EdgeId);
    if (edge === undefined) throw new Error(`elk: ELK returned unknown edge '${elkEdge.id}'.`);
    const offset = origin.get(elkEdge.container ?? ELK_ROOT_ID) ?? { x: 0, y: 0 };
    const layout = edgeLayout(elkEdge, offset);
    if (layout !== null) edges[edge.id] = layout;

    const elkLabel = elkEdge.labels?.[0];
    if (edge.labelId !== null && elkLabel !== undefined) {
      labels.push({
        labelId: edge.labelId,
        frame: { x: offset.x + (elkLabel.x ?? 0), y: offset.y + (elkLabel.y ?? 0), w: elkLabel.width, h: elkLabel.height },
        align: 'middle',
        baseline: 'top',
        occlusion: 'plate',
      });
    }
  }

  return {
    bounds: { x: 0, y: 0, w: out.width ?? 0, h: out.height ?? 0 },
    nodes,
    edges,
    labels,
  };
}

/** `sections[0]`: start, then every bend point and the end point as `L`
 *  segments (DD-06 §6.2). A simple edge has exactly one section; an edge ELK
 *  did not route (no section) is left out, so the host's straight-routing
 *  fallback fills it. */
function edgeLayout(elkEdge: ElkEdge, offset: Point): EdgeLayout | null {
  const sections = elkEdge.sections ?? [];
  const first = sections[0];
  if (first === undefined) return null;
  const shift = (p: Point): Point => ({ x: offset.x + p.x, y: offset.y + p.y });
  const points: Point[] = [];
  for (const section of sections) {
    const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(shift);
    for (const p of pts) {
      const last = points[points.length - 1];
      if (last === undefined || last.x !== p.x || last.y !== p.y) points.push(p);
    }
  }
  const start = points[0] ?? shift(first.startPoint);
  const end = points[points.length - 1] ?? shift(first.endPoint);
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
