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
  type EdgeId,
  type LabelId,
  type NodeId,
  type PathSeg,
  type Point,
  type Rect,
} from '@sgl/core';
import type { ComputedStyle, ResolvedTheme, StyledGraph } from '@sgl/theme';

import type { EdgeLayoutView, LabelPlacementView, LayoutView } from './layout-view.js';
import { isArrowhead, MarkerTable, type Arrowhead } from './markers.js';
import { num, nums } from './num.js';
import { escapeXml, edgeElementId, nodeElementId, safeUrl } from './security.js';
import { DEFAULT_SHAPE, resolveShape } from './shapes.js';
import { buildStyleBlock, buildTokenBlock, ClassTable } from './style.js';
import { renderText, textBlock } from './text.js';

export * from './layout-view.js';
export * from './markers.js';
export * from './num.js';
export * from './security.js';
export * from './shapes.js';
export * from './style.js';
export * from './text.js';

export interface RenderResult {
  readonly svg: string;
  /** The main `<style>` element's text: every rule that paints the diagram,
   *  with literal values and no custom property (F17, DD-07 §6).
   *  Returned separately for export and for re-theming an exported file. It is
   *  *not* a paint-only live-view swap key: `s-`/`t-`/`p-` class names embed
   *  `paintHash`, so a paint change also changes every element's `class`
   *  attribute, and a directed edge's marker id embeds the stroke colour too
   *  (`markers.ts`). See DD-07 §2, §6, §11 and DD-08 §3 for what is and is not
   *  implementable here. */
  readonly styleBlock: string;
  /** The token `<style>` element's text — one `svg.sgl{--…}` rule holding the
   *  theme tokens as custom properties, for a consumer to override. It is its
   *  own element, after the main one, because Inkscape discards a whole
   *  `<style>` element that declares a custom property (F17, DD-07 §6). */
  readonly tokenBlock: string;
  readonly bounds: Rect;
  readonly diagnostics: readonly Diagnostic[];
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
 * The label's lines, from its runs.
 *
 * `LabelSpec.runs` is already one plain run per line — `compile()`'s `textRuns`
 * splits on `\n` before a `TextRun` is ever created (DD-03), and no run's text
 * contains an embedded newline. `.map((r) => r.text)` is therefore the whole
 * function: the previous `.join('').split('\n')` concatenated every run's text
 * with no separator and then searched the result for a `\n` that could no longer
 * be there, silently collapsing every multi-line label — title and edge label
 * alike — onto one line (found via the golden churn Fix 2's baseline change
 * exposed: a label frame sized for two lines rendered as one).
 */
function labelLines(runs: readonly { readonly text: string }[]): readonly string[] {
  return runs.map((r) => r.text);
}

interface Ctx {
  readonly styled: StyledGraph;
  readonly layout: LayoutView;
  readonly classes: ClassTable;
  readonly markers: MarkerTable;
  readonly placements: ReadonlyMap<string, LabelPlacementView>;
  readonly diagnostics: Diagnostic[];
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
  const shapeClass = style === undefined ? '' : ctx.classes.shapeClasses(style);
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
      const block = textBlock(labelLines(title.runs), labelStyle, placement.text);
      parts.push(
        renderText(placement, block, ctx.classes.textClasses(labelStyle), `${kind}-title`, true),
      );
    }
  }

  const label = a11yLabel(node.config, title === null || title === undefined ? node.path[node.path.length - 1] ?? String(id) : labelLines(title.runs).join(' '));
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

  const attrs: string[] = [
    `class="${escapeXml(['e-path', style === undefined ? '' : ctx.classes.shapeClasses(style)].filter(Boolean).join(' '))}"`,
    `d="${routePath(geom)}"`,
  ];

  // `forward` puts a head at `to`; `both` puts one at each end; `none` neither.
  if (edge.directed === 'forward' || edge.directed === 'both') {
    const id = ctx.markers.add(arrowhead, stroke, size, false);
    if (id !== null) attrs.push(`marker-end="url(#${id})"`);
  }
  if (edge.directed === 'both') {
    const id = ctx.markers.add(arrowhead, stroke, size, true);
    if (id !== null) attrs.push(`marker-start="url(#${id})"`);
  }

  const from = String(edge.from.node);
  const to = String(edge.to.node);
  const joiner = edge.directed === 'none' ? 'and' : 'to';
  const labelSpec = edge.labelId === null ? undefined : ctx.styled.graph.labels[edge.labelId];
  const labelText = labelSpec === undefined ? '' : `: ${labelLines(labelSpec.runs).join(' ')}`;

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
function renderEdgeLabel(edgeId: EdgeId, labelId: LabelId, ctx: Ctx): string {
  const spec = ctx.styled.graph.labels[labelId];
  const placement = ctx.placements.get(labelId as string);
  const style = ctx.styled.labelStyles[labelId];
  if (spec === undefined || placement === undefined || style === undefined) return '';

  const block = textBlock(labelLines(spec.runs), style, placement.text);
  const parts: string[] = [];

  if (placement.occlusion === 'plate') {
    const edgeStyle = ctx.styled.styles[edgeId];
    const plate = edgeStyle === undefined ? '' : ctx.classes.plateClasses(edgeStyle);
    if (plate !== '') {
      parts.push(
        `<rect class="${escapeXml(`el-plate ${plate}`)}" x="${num(placement.frame.x)}" y="${num(placement.frame.y)}"` +
          ` width="${num(placement.frame.w)}" height="${num(placement.frame.h)}" aria-hidden="true"/>`,
      );
    }
  }

  parts.push(renderText(placement, block, ctx.classes.textClasses(style), 'el-text', true));
  return `<g class="el" aria-hidden="true">${parts.join('')}</g>`;
}

/**
 * Render the whole document.
 *
 * Layer order is fixed (DD-07 §2): containers, edges, nodes, edge labels. Document
 * order within the node layers is `graph.order`, so a screen reader walks the
 * diagram in declaration order — the author's intended reading order.
 */
export function render(styled: StyledGraph, layout: LayoutView, theme: ResolvedTheme): RenderResult {
  const ctx: Ctx = {
    styled,
    layout,
    classes: new ClassTable(),
    markers: new MarkerTable(),
    placements: new Map(layout.labels.map((p) => [p.labelId, p])),
    diagnostics: [],
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
    if (edge.labelId !== null) edgeLabels.push(renderEdgeLabel(edge.id, edge.labelId, ctx));
  });

  const { bounds } = layout;
  const { nodeCount, edgeCount, containerCount } = styled.graph.meta;
  const title = styled.graph.title ?? 'Diagram';
  const desc = `${nodeCount} nodes, ${edgeCount} connections, ${containerCount} groups.`;

  // Built after the layers, because rendering is what discovers which classes and
  // markers the document actually uses.
  const styleBlock = buildStyleBlock(styled.canvas.background, ctx.classes.emit());
  const tokenBlock = buildTokenBlock(theme, styled.canvas.background);
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
    `<style>${escapeXml(tokenBlock)}</style>` +
    `<defs>${defs}</defs>` +
    `<rect class="canvas" x="${num(bounds.x)}" y="${num(bounds.y)}" width="${num(bounds.w)}" height="${num(bounds.h)}" aria-hidden="true"/>` +
    `<g class="L-containers">${containers.join('')}</g>` +
    `<g class="L-edges">${edges.join('')}</g>` +
    `<g class="L-nodes">${nodes.join('')}</g>` +
    `<g class="L-labels">${edgeLabels.join('')}</g>` +
    `</svg>`;

  return { svg, styleBlock, tokenBlock, bounds, diagnostics: ctx.diagnostics };
}

export { DEFAULT_SHAPE };
