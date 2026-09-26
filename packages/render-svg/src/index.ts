/**
 * @sgl/render-svg — `StyledGraph` + `LayoutResult` + `ResolvedTheme` → accessible SVG.
 *
 * A pure string renderer. No DOM, no virtual DOM: the document is regenerated
 * whole, so a virtual DOM buys nothing. The same function serves the live view,
 * export, the CLI and, later, the Worker.
 *
 * Design: DD-07.
 */

import {
  diagnostic,
  type Diagnostic,
  type GraphEdge,
  type LabelId,
  type NodeId,
  type PathSeg,
  type Point,
  type Rect,
  type SemanticGraph,
  type TextRun,
} from '@sgl/core';
import { labelRunKey, plainText } from '@sgl/text';
import type { ComputedStyle, ResolvedTheme, StyledGraph } from '@sgl/theme';

import type { EdgeLayoutView, LabelPlacementView, LayoutView, RunView, TextLayoutView } from './layout-view.js';
import { isArrowhead, markerPaintClass, MarkerTable, type Arrowhead } from './markers.js';
import { num, nums } from './num.js';
import { paintOnlyStyleBlock, withStyleBlock, type PaintPlan } from './paint-plan.js';
import { escapeXml, edgeElementId, nodeElementId, safeUrl } from './security.js';
import { DEFAULT_SHAPE, resolveShape } from './shapes.js';
import { buildStyleBlock, cascadeSignature, ClassTable } from './style.js';
import { markBits, renderText, textBlock } from './text.js';

export * from './layout-view.js';
export * from './markers.js';
export * from './num.js';
export * from './paint-plan.js';
export * from './security.js';
export * from './shapes.js';
export * from './style.js';
export * from './text.js';

export interface RenderResult {
  readonly svg: string;
  /** The `<style>` element's text: every rule that paints the diagram, with
   *  literal values and no custom property (F17, DD-07 §6). Every paint the
   *  output carries is here, markers' included (F7). */
  readonly styleBlock: string;
  /** `structureHash(styled)` (DD-07 §6): of two renders of the same
   *  `LayoutResult`, equal `structureHash` ⇒ the SVG outside the `<style>` and
   *  `<defs>` text is byte-identical, so swapping those two texts alone turns
   *  one into the other (F7; DD-07 §11). Conservative: unequal hashes may
   *  still render the same bytes. */
  readonly structureHash: string;
  readonly bounds: Rect;
  readonly diagnostics: readonly Diagnostic[];
  /** What `renderPaintOnly` needs to restyle this render (F9 P3,
   *  `paint-plan.ts`). Its identity names the element tree: results that
   *  share a plan differ only in their `<style>` text. Not output. */
  readonly paintPlan: PaintPlan;
}

const NO_SPAN = { from: 0, to: 0 };

function geometryNumber(style: ComputedStyle | undefined, key: string, fallback: number): number {
  const v = style?.geometry[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function paintString(style: ComputedStyle | undefined, key: string): string | null {
  const v = style?.paint[key];
  return typeof v === 'string' ? v : null;
}

/** The config keys `render()` writes into the output (links, a11y text). */
const RENDERED_CONFIG = ['link', 'a11y'] as const;

function renderedConfig(config: Readonly<Record<string, unknown>>): string {
  let out = '';
  for (const key of RENDERED_CONFIG) {
    const v = config[key];
    if (v !== undefined) out += `${key}=${JSON.stringify(v)};`;
  }
  return out;
}

/** The measure table `render()` may be given (DD-11 T42): `TextLayout`s by
 *  `labelRunKey`. */
export type TextTable = Readonly<Record<string, TextLayoutView>>;

/**
 * A label's fields of `structureHash`: its plain text, exactly as before A18,
 * and — only when some run is marked — one more field holding each run's
 * marks and length (DD-11 T45). The next field hashed is the rendered config,
 * which never starts with `\0`, so a marked label cannot hash as an unmarked
 * one, and the marks plus the lengths say exactly how the text is split.
 */
function addLabel(h: StructureHasher, graph: SemanticGraph, labelId: LabelId | null): void {
  const runs = labelId === null ? undefined : graph.labels[labelId]?.runs;
  h.add(runs === undefined ? '' : plainText(runs));
  if (runs?.some((r) => markBits(r))) h.add(`\0${runs.map((r) => `${markBits(r)}:${r.text.length}`).join()}`);
}

/**
 * A hash of everything that decides the output **outside** the `<style>`
 * and `<defs>` text, except the layout (DD-07 §6): the geometry of every style
 * (`geometryHash` — the `g-` classes, text metrics, radii, arrow sizes); per
 * element, in document order, its id, its cascade signature (which names its
 * paint classes and, for an edge, its markers, and carries the element's
 * shape and classes), its hidden flag, its label text and the config the
 * output shows (`@link`, `@a11y`); per edge, its endpoints, direction and
 * arrowhead kind (it names the marker; `none` drops the attribute); and the
 * title. So, for the same `LayoutResult`, **equal `structureHash` ⇒ the
 * output outside `<style>`/`<defs>` is byte-identical** (a hash is
 * conservative: unequal hashes can still render the same bytes). A theme
 * switch between themes of equal geometry and arrowheads leaves it unchanged;
 * an inline `@style` edit, a class, a label or a link changes it (fix round 1,
 * item 4).
 *
 * Everything but `geometryHash` and the arrowhead kinds is a function of the
 * `SemanticGraph` alone, which is immutable, so that part is hashed once per
 * graph object and kept (F9: a theme switch re-styles the same graph, and
 * then this costs one pass over the edges). DD-07 §6 has the cost.
 */
export function structureHash(styled: StyledGraph): string {
  const { graph } = styled;
  const h = new StructureHasher();
  h.add(styled.geometryHash);
  h.add(graphStructure(graph));
  for (const edge of graph.edges) {
    const value = styled.styles[edge.id]?.paint['arrowhead'];
    h.add(edge.directed === 'none' ? '' : isArrowhead(value) ? value : 'triangle');
  }
  return h.digest();
}

/** `structureHash`'s graph-only part, by graph object. */
const GRAPH_STRUCTURE = new WeakMap<SemanticGraph, string>();

function graphStructure(graph: SemanticGraph): string {
  let digest = GRAPH_STRUCTURE.get(graph);
  if (digest !== undefined) return digest;
  const h = new StructureHasher();
  h.add(graph.title ?? '');
  for (const id of graph.order) {
    const node = graph.nodes[id];
    if (node === undefined) continue;
    const role = node.children.length > 0 ? 'container' : 'node';
    h.add('n');
    h.add(id);
    h.add(node.hidden ? '1' : '0');
    h.add(cascadeSignature(role, node.shape, node.classes, node.config));
    addLabel(h, graph, node.labelId);
    h.add(renderedConfig(node.config));
  }
  for (const edge of graph.edges) {
    h.add('e');
    h.add(edge.id);
    h.add(edge.from.node);
    h.add(edge.to.node);
    h.add(edge.directed);
    h.add(cascadeSignature('edge', undefined, edge.classes, edge.config));
    addLabel(h, graph, edge.labelId);
    h.add(renderedConfig(edge.config));
  }
  digest = h.digest();
  GRAPH_STRUCTURE.set(graph, digest);
  return digest;
}

/**
 * The render of `styled` drawn with `layout`, made from `previous` — a render
 * of the **same** `layout` object — by recomputing only its `<style>` text
 * (F9 P3; DD-07 §6, §11): one style per paint rule `previous` emitted, i.e.
 * one per distinct cascade signature, never a walk over the elements. Its
 * `svg` is derived from the full render's string on first read
 * (`withStyleBlock`, P4) and is then exactly `render(styled, layout).svg`,
 * as is every other field.
 *
 * `null` — do a full `render()` — unless it is safe: `previous` was drawn with
 * this very `layout` object (a copy, however equal, is refused) and
 * `structureHash(styled)` equals `previous.structureHash` (so the geometry,
 * the graph content the output shows — marks included — and every arrowhead
 * kind are the same), and `text` is the very measure table `previous` was
 * drawn with (DD-11 T42: it says which fragments sit on which line).
 * The `<defs>` text needs no recomputing under that guard: a marker is named
 * and drawn from its arrowhead kind, size and edge signature token alone.
 */
export function renderPaintOnly(previous: RenderResult, styled: StyledGraph, layout: LayoutView, text?: TextTable): RenderResult | null {
  const plan = previous.paintPlan;
  if (plan.layout !== layout || plan.text !== text) return null;
  const hash = structureHash(styled);
  if (hash !== previous.structureHash) return null;
  const styleBlock = paintOnlyStyleBlock(plan, styled);
  if (styleBlock === null) return null;
  let svg: string | undefined;
  return {
    get svg(): string {
      return (svg ??= withStyleBlock(plan.svg, styleBlock));
    },
    styleBlock,
    structureHash: hash,
    bounds: previous.bounds,
    diagnostics: previous.diagnostics,
    paintPlan: plan,
  };
}

/**
 * Two independent 32-bit multiplicative hashes over UTF-16 code units, with a
 * separator after every field, as 16 hex digits. Not `fnv1a64`: that is part
 * of the output's compatibility surface (DD-00 §3) and byte-at-a-time over
 * UTF-8, ~12 ns a character; this never leaves the process, and at 2 000
 * nodes it is the difference between ~7 ms and well under 1 ms.
 */
class StructureHasher {
  private a = 0x811c9dc5;
  private b = 0x01000193;

  add(text: string): void {
    let a = this.a;
    let b = this.b;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
      b ^= b >>> 15;
    }
    // A separator no string can forge: the field length, then a sentinel.
    a = Math.imul(a ^ (text.length + 0x10000), 0x01000193);
    b = Math.imul(b ^ (text.length + 0x10000), 0x5bd1e995);
    b ^= b >>> 15;
    this.a = a;
    this.b = b;
  }

  digest(): string {
    const hex = (v: number): string => (v >>> 0).toString(16).padStart(8, '0');
    return hex(this.a) + hex(this.b);
  }
}

/** Path data for an edge route: `M start` then each segment (DD-06 §2). */
function routePath(edge: EdgeLayoutView): string {
  const parts: string[] = [`M${nums(edge.start.x, edge.start.y)}`];
  for (const seg of edge.route) parts.push(segment(seg));
  if (edge.route.length === 0) parts.push(`L${nums(edge.end.x, edge.end.y)}`);
  return parts.join('');
}

function segment(seg: PathSeg): string {
  switch (seg.t) {
    case 'L':
      return `L${nums(seg.to.x, seg.to.y)}`;
    case 'Q':
      return `Q${nums(seg.c.x, seg.c.y, seg.to.x, seg.to.y)}`;
    case 'C':
      return `C${nums(seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y, seg.to.x, seg.to.y)}`;
    case 'A':
      return `A${nums(seg.r.w, seg.r.h)} 0 0 ${seg.sweep} ${nums(seg.to.x, seg.to.y)}`;
  }
}

/**
 * A label's lines, each its fragments with their marks (DD-11 T42): the lines
 * the measure table holds for the label (`labelRunKey`, as `premeasure` keyed
 * it), so a wrapped label is drawn on exactly the lines that sized its node;
 * with no table, or on a miss, its runs split at every `\n` (T21, T34).
 */
function labelLines(ctx: Ctx, labelId: LabelId, runs: readonly TextRun[]): readonly (readonly RunView[])[] {
  const measured = ctx.text?.[labelRunKey(ctx.styled, labelId)];
  if (measured) return measured.lines.map((l) => l.runs);
  const lines: RunView[][] = [[]];
  for (const r of runs) {
    r.text.split('\n').forEach((text, i) => {
      if (i) lines.push([]);
      if (text) lines[lines.length - 1]!.push({ text, marks: r });
    });
  }
  return lines;
}

/** The accessible name's text (T48): the plain text, breaks as spaces. */
const a11yText = (runs: readonly TextRun[]): string => plainText(runs).split('\n').join(' ');

interface Ctx {
  readonly styled: StyledGraph;
  readonly layout: LayoutView;
  readonly classes: ClassTable;
  readonly markers: MarkerTable;
  readonly placements: ReadonlyMap<string, LabelPlacementView>;
  readonly diagnostics: Diagnostic[];
  readonly text: TextTable | undefined;
}

/**
 * Wrap an element in an `<a>` when `@link` is present and its scheme is allowed.
 * Anything else is dropped with SGL6001 — the element still renders, it just is
 * not a link (DD-07 §8).
 */
function withLink(inner: string, config: Readonly<Record<string, unknown>>, element: string, ctx: Ctx): string {
  const raw = config['link'];
  if (typeof raw !== 'string' || raw === '') return inner;
  const { href, scheme } = safeUrl(raw);
  if (href === null) {
    ctx.diagnostics.push(diagnostic('SGL6001', NO_SPAN, { element, scheme: scheme || 'unknown' }));
    return inner;
  }
  return `<a href="${escapeXml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

function a11yLabel(config: Readonly<Record<string, unknown>>, fallback: string): string {
  const a11y = config['a11y'];
  if (typeof a11y === 'object' && a11y !== null) {
    const l = (a11y as Record<string, unknown>)['label'];
    if (typeof l === 'string' && l !== '') return l;
  }
  return fallback;
}

/** `@a11y.description` adds `aria-description` alongside `aria-label`; absent when
 *  not given (DD-07 §7). Found missing entirely during Stage F verification. */
function a11yDescription(config: Readonly<Record<string, unknown>>): string | null {
  const a11y = config['a11y'];
  if (typeof a11y === 'object' && a11y !== null) {
    const d = (a11y as Record<string, unknown>)['description'];
    if (typeof d === 'string' && d !== '') return d;
  }
  return null;
}

/** A node or container. Containers go in the first layer, leaves in the third. */
function renderNode(id: NodeId, isContainer: boolean, ctx: Ctx): string {
  const node = ctx.styled.graph.nodes[id];
  const frame = ctx.layout.nodes[id as string]?.frame;
  if (node === undefined || frame === undefined) return '';

  const style = ctx.styled.styles[id];
  const { shape, known } = resolveShape(node.shape);
  if (!known) {
    ctx.diagnostics.push(diagnostic('SGL3001', node.span, { name: String(node.shape) }));
  }

  const radius = geometryNumber(style, 'radius', 0);
  const role = isContainer ? 'container' : 'node';
  const shapeClass = style === undefined ? '' : ctx.classes.shapeClasses(style, cascadeSignature(role, node.shape, node.classes, node.config), id);
  const kind = isContainer ? 'c' : 'n';

  const parts: string[] = [
    `<path class="${escapeXml([`${kind}-shape`, shapeClass].filter(Boolean).join(' '))}" d="${shape.path(frame, radius)}"/>`,
  ];

  // Ports are decorative: the geometry they mark is already expressed by the edges
  // that attach to them (DD-07 §7).
  const ports = ctx.layout.nodes[id as string]?.ports;
  if (ports !== undefined && !isContainer) {
    const r = geometryNumber(style, 'portSize', 3);
    for (const portId of Object.keys(ports).sort()) {
      const p = ports[portId] as { point: Point };
      parts.push(
        `<circle class="n-port" cx="${num(p.point.x)}" cy="${num(p.point.y)}" r="${num(r)}" aria-hidden="true"/>`,
      );
    }
  }

  const title = node.labelId === null ? null : ctx.styled.graph.labels[node.labelId];
  if (title !== null && title !== undefined) {
    const placement = ctx.placements.get(title.id as string);
    const labelStyle = ctx.styled.labelStyles[title.id];
    if (placement !== undefined && labelStyle !== undefined) {
      const block = textBlock(labelLines(ctx, title.id, title.runs), labelStyle);
      parts.push(
        renderText(placement, block, ctx.classes.textClasses(labelStyle, cascadeSignature(`${role}.title`, undefined, node.classes, node.config), title.id), `${kind}-title`, true, ctx.classes),
      );
    }
  }

  const label = a11yLabel(node.config, title === null || title === undefined ? node.path[node.path.length - 1] ?? String(id) : a11yText(title.runs));
  const description = a11yDescription(node.config);
  const classAttr = escapeXml([kind, isContainer ? '' : `sh-${node.shape}`, ...node.classes].filter(Boolean).join(' '));
  const g =
    `<g id="${escapeXml(nodeElementId(id as string))}" class="${classAttr}"` +
    ` role="group" aria-label="${escapeXml(label)}"` +
    (description === null ? '' : ` aria-description="${escapeXml(description)}"`) +
    `>${parts.join('')}</g>`;

  return withLink(g, node.config, String(id), ctx);
}

function renderEdge(edgeIndex: number, ctx: Ctx): string {
  const edge = ctx.styled.graph.edges[edgeIndex];
  if (edge === undefined) return '';
  const geom = ctx.layout.edges[edge.id as string];
  if (geom === undefined) return '';

  const style = ctx.styled.styles[edge.id];
  const stroke = paintString(style, 'stroke') ?? '#000000';
  const arrowValue = style?.paint['arrowhead'];
  const arrowhead: Arrowhead = isArrowhead(arrowValue) ? arrowValue : 'triangle';
  const size = geometryNumber(style, 'arrowSize', 8);
  const signature = cascadeSignature('edge', undefined, edge.classes, edge.config);

  const attrs: string[] = [
    `class="${escapeXml(['e-path', style === undefined ? '' : ctx.classes.shapeClasses(style, signature, edge.id)].filter(Boolean).join(' '))}"`,
    `d="${routePath(geom)}"`,
  ];

  // `forward` puts a head at `to`; `both` puts one at each end; `none` neither.
  // The marker is named after the edge's paint-class token, never its colour;
  // the colour is a `<style>` rule on the marker's own shape (DD-07 §6).
  if (edge.directed === 'forward' || edge.directed === 'both') {
    const token = ctx.classes.token(signature);
    const end = ctx.markers.add(arrowhead, size, false, token);
    const start = edge.directed === 'both' ? ctx.markers.add(arrowhead, size, true, token) : null;
    if (end !== null) attrs.push(`marker-end="url(#${end})"`);
    if (start !== null) attrs.push(`marker-start="url(#${start})"`);
    if (end !== null || start !== null) ctx.classes.markerPaint(markerPaintClass(arrowhead, token), arrowhead === 'open', stroke, edge.id);
  }

  const from = String(edge.from.node);
  const to = String(edge.to.node);
  const joiner = edge.directed === 'none' ? 'and' : 'to';
  const labelSpec = edge.labelId === null ? undefined : ctx.styled.graph.labels[edge.labelId];
  const labelText = labelSpec === undefined ? '' : `: ${a11yText(labelSpec.runs)}`;

  const edgeDescription = a11yDescription(edge.config);
  const g =
    `<g id="${escapeXml(edgeElementId(edge.id as string))}"` +
    ` class="${escapeXml(['e', ...edge.classes].filter(Boolean).join(' '))}"` +
    ` role="graphics-symbol"` +
    ` aria-label="${escapeXml(a11yLabel(edge.config, `${from} ${joiner} ${to}${labelText}`))}"` +
    (edgeDescription === null ? '' : ` aria-description="${escapeXml(edgeDescription)}"`) +
    `>` +
    `<path ${attrs.join(' ')}/></g>`;

  return withLink(g, edge.config, String(edge.id), ctx);
}

/** Edge labels are their own top layer so a plate never sits under a node. */
function renderEdgeLabel(edge: GraphEdge, labelId: LabelId, ctx: Ctx): string {
  const spec = ctx.styled.graph.labels[labelId];
  const placement = ctx.placements.get(labelId as string);
  const style = ctx.styled.labelStyles[labelId];
  if (spec === undefined || placement === undefined || style === undefined) return '';

  const block = textBlock(labelLines(ctx, labelId, spec.runs), style);
  const parts: string[] = [];
  const labelSignature = cascadeSignature('edge.label', undefined, edge.classes, edge.config);

  // The plate is drawn whenever the placement asks for one, whatever the
  // theme's `labelPlate` (F7: `none` is `fill:none`, DD-07 §6).
  if (placement.occlusion === 'plate') {
    const edgeStyle = ctx.styled.styles[edge.id];
    const plate = edgeStyle === undefined ? '' : ctx.classes.plateClasses(edgeStyle, cascadeSignature('edge', undefined, edge.classes, edge.config), edge.id);
    if (plate !== '') {
      parts.push(
        `<rect class="${escapeXml(`el-plate ${plate}`)}" x="${num(placement.frame.x)}" y="${num(placement.frame.y)}"` +
          ` width="${num(placement.frame.w)}" height="${num(placement.frame.h)}" aria-hidden="true"/>`,
      );
    }
  }

  parts.push(renderText(placement, block, ctx.classes.textClasses(style, labelSignature, labelId), 'el-text', true, ctx.classes));
  return `<g class="el" aria-hidden="true">${parts.join('')}</g>`;
}

/**
 * Render the whole document.
 *
 * Layer order is fixed (DD-07 §2): containers, edges, nodes, edge labels. Document
 * order within the node layers is `graph.order`, so a screen reader walks the
 * diagram in declaration order — the author's intended reading order.
 *
 * `_theme` is part of DD-07's signature but no longer read: everything the
 * output needs from it is already resolved into `styled` (its only reader was
 * the token `<style>` element, removed with F18).
 *
 * `text` is the measure table the layout was sized from (DD-11 T42): each
 * label is drawn on the lines it holds for it, marks included. Without it, or
 * on a miss, a label is drawn on its hard lines. A label with no marks draws
 * exactly what it drew before A18.
 */
export function render(styled: StyledGraph, layout: LayoutView, _theme: ResolvedTheme, text?: TextTable): RenderResult {
  const ctx: Ctx = {
    styled,
    layout,
    classes: new ClassTable(),
    markers: new MarkerTable(),
    placements: new Map(layout.labels.map((p) => [p.labelId, p])),
    diagnostics: [],
    text,
  };

  const containers: string[] = [];
  const nodes: string[] = [];
  for (const id of styled.graph.order) {
    const node = styled.graph.nodes[id];
    if (node === undefined || node.hidden) continue;
    const isContainer = node.children.length > 0;
    const svg = renderNode(id, isContainer, ctx);
    if (svg !== '') (isContainer ? containers : nodes).push(svg);
  }

  const edges: string[] = [];
  const edgeLabels: string[] = [];
  styled.graph.edges.forEach((edge, i) => {
    const svg = renderEdge(i, ctx);
    if (svg === '') return;
    edges.push(svg);
    if (edge.labelId !== null) edgeLabels.push(renderEdgeLabel(edge, edge.labelId, ctx));
  });

  const { bounds } = layout;
  const { nodeCount, edgeCount, containerCount } = styled.graph.meta;
  const title = styled.graph.title ?? 'Diagram';
  const desc = `${nodeCount} nodes, ${edgeCount} connections, ${containerCount} groups.`;

  // Built after the layers, because rendering is what discovers which classes and
  // markers the document actually uses.
  const styleBlock = buildStyleBlock(styled.canvas.background, ctx.classes.emit());
  const defs = ctx.markers.emit();

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
    ` class="sgl" data-sgl="1.0"` +
    ` width="${num(bounds.w)}" height="${num(bounds.h)}"` +
    ` viewBox="${nums(bounds.x, bounds.y, bounds.w, bounds.h)}"` +
    ` role="img" aria-labelledby="sgl-t sgl-d">` +
    `<title id="sgl-t">${escapeXml(title)}</title>` +
    `<desc id="sgl-d">${escapeXml(desc)}</desc>` +
    `<style>${escapeXml(styleBlock)}</style>` +
    `<defs>${defs}</defs>` +
    `<rect class="canvas" x="${num(bounds.x)}" y="${num(bounds.y)}" width="${num(bounds.w)}" height="${num(bounds.h)}" aria-hidden="true"/>` +
    `<g class="L-containers">${containers.join('')}</g>` +
    `<g class="L-edges">${edges.join('')}</g>` +
    `<g class="L-nodes">${nodes.join('')}</g>` +
    `<g class="L-labels">${edgeLabels.join('')}</g>` +
    `</svg>`;

  return {
    svg,
    styleBlock,
    structureHash: structureHash(styled),
    bounds,
    diagnostics: ctx.diagnostics,
    paintPlan: { layout, text, svg, rules: ctx.classes.paintRules, runs: ctx.classes.runs },
  };
}

export { DEFAULT_SHAPE };
