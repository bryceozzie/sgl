/**
 * F9 PHASE 1 PROTOTYPE: measurement only, not production code.
 *
 * A fork of `src/index.ts`'s `render()` whose class and marker naming is a
 * pluggable strategy (`tables.ts`): production's own naming, optionally
 * memoised (`renderMainProto`, byte-identical to `render()`), or theme-
 * invariant paint class names and marker ids (`renderInvariant`, via
 * `style-invariant.ts`, `markers-invariant.ts`). Everything
 * else (element order, geometry, ids, a11y, escaping) is copied verbatim from
 * `src/index.ts` at `c11a5ad` so the string it builds costs what production's
 * would. Two things differ from `render()`'s output:
 *
 * - `s-`/`t-`/`p-` class names are `{prefix}-{shortHash(signature)}`, where the
 *   signature is the element's cascade inputs (DD-04 §4: role, shape, author
 *   classes, inline `style`), not `paintHash`;
 * - marker ids are `m[-s]-{shortHash(edge signature | arrowSize)}`.
 *
 * It also returns `defs` (the `<defs>` inner markup) so the bench can swap it
 * alongside the `<style>` text. It would change every SVG golden (every
 * paint class and every marker id), which is why it is measured only.
 */

import {
  canonicalise,
  diagnostic,
  type ConfigBag,
  type Diagnostic,
  type EdgeId,
  type LabelId,
  type NodeId,
  type PathSeg,
  type Point,
  type Rect,
} from '@sgl/core';
import type { ComputedStyle, ResolvedTheme, StyledGraph } from '@sgl/theme';

import type { EdgeLayoutView, LabelPlacementView, LayoutView } from '../../../src/layout-view.js';
import { isArrowhead, type Arrowhead } from '../../../src/markers.js';
import { num, nums } from '../../../src/num.js';
import { escapeXml, edgeElementId, nodeElementId, safeUrl } from '../../../src/security.js';
import { resolveShape } from '../../../src/shapes.js';
import { buildStyleBlock, buildTokenBlock } from '../../../src/style.js';
import { renderText, textBlock } from '../../../src/text.js';
import { invariantTables, mainTables, type ClassNamer, type MarkerNamer, type Tables } from './tables.js';

export interface InvariantRenderResult {
  readonly svg: string;
  readonly styleBlock: string;
  readonly tokenBlock: string;
  /** The `<defs>` element's inner markup (the markers). */
  readonly defs: string;
  readonly bounds: Rect;
  readonly diagnostics: readonly Diagnostic[];
}

const NO_SPAN = { from: 0, to: 0 };

/**
 * The theme-invariant key: everything DD-04 §4's cascade reads from the
 * element itself (steps 1–5; step 6, `size`, is geometry only). Under a fixed
 * theme, equal signatures give equal `ComputedStyle`s.
 */
function signature(role: string, shape: string | undefined, classes: readonly string[], config: ConfigBag | undefined): string {
  const style = config?.['style'];
  const inline = typeof style === 'object' && style !== null && !Array.isArray(style) ? canonicalise(style as Record<string, unknown>) : '';
  return `${role}|${shape ?? ''}|${classes.join(',')}|${inline}`;
}

function geometryNumber(style: ComputedStyle | undefined, key: string, fallback: number): number {
  const v = style?.geometry[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function paintString(style: ComputedStyle | undefined, key: string): string | null {
  const v = style?.paint[key];
  return typeof v === 'string' ? v : null;
}

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

function labelLines(runs: readonly { readonly text: string }[]): readonly string[] {
  return runs.map((r) => r.text);
}

interface Ctx {
  readonly styled: StyledGraph;
  readonly layout: LayoutView;
  readonly classes: ClassNamer;
  readonly markers: MarkerNamer;
  readonly placements: ReadonlyMap<string, LabelPlacementView>;
  readonly diagnostics: Diagnostic[];
}

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

function a11yDescription(config: Readonly<Record<string, unknown>>): string | null {
  const a11y = config['a11y'];
  if (typeof a11y === 'object' && a11y !== null) {
    const d = (a11y as Record<string, unknown>)['description'];
    if (typeof d === 'string' && d !== '') return d;
  }
  return null;
}

function renderNode(id: NodeId, isContainer: boolean, ctx: Ctx): string {
  const node = ctx.styled.graph.nodes[id];
  const frame = ctx.layout.nodes[id as string]?.frame;
  if (node === undefined || frame === undefined) return '';

  const style = ctx.styled.styles[id];
  const { shape, known } = resolveShape(node.shape);
  if (!known) {
    ctx.diagnostics.push(diagnostic('SGL3001', node.span, { name: String(node.shape) }));
  }

  const role = isContainer ? 'container' : 'node';
  const sig = ctx.classes.needsSignature ? signature(role, node.shape, node.classes, node.config) : '';
  const radius = geometryNumber(style, 'radius', 0);
  const shapeClass = style === undefined ? '' : ctx.classes.shapeClasses(style, sig);
  const kind = isContainer ? 'c' : 'n';

  const parts: string[] = [
    `<path class="${escapeXml([`${kind}-shape`, shapeClass].filter(Boolean).join(' '))}" d="${shape.path(frame, radius)}"/>`,
  ];

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
        renderText(placement, block, ctx.classes.textClasses(labelStyle, `${sig}|title`), `${kind}-title`, true),
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

function edgeSignature(edgeIndex: number, ctx: Ctx): string {
  const edge = ctx.styled.graph.edges[edgeIndex]!;
  if (!ctx.classes.needsSignature) return '';
  return signature('edge', undefined, edge.classes, edge.config);
}

function renderEdge(edgeIndex: number, ctx: Ctx): string {
  const edge = ctx.styled.graph.edges[edgeIndex];
  if (edge === undefined) return '';
  const geom = ctx.layout.edges[edge.id as string];
  if (geom === undefined) return '';

  const sig = edgeSignature(edgeIndex, ctx);
  const style = ctx.styled.styles[edge.id];
  const stroke = paintString(style, 'stroke') ?? '#000000';
  const arrowValue = style?.paint['arrowhead'];
  const arrowhead: Arrowhead = isArrowhead(arrowValue) ? arrowValue : 'triangle';
  const size = geometryNumber(style, 'arrowSize', 8);

  const attrs: string[] = [
    `class="${escapeXml(['e-path', style === undefined ? '' : ctx.classes.shapeClasses(style, sig)].filter(Boolean).join(' '))}"`,
    `d="${routePath(geom)}"`,
  ];

  if (edge.directed === 'forward' || edge.directed === 'both') {
    const id = ctx.markers.add(arrowhead, stroke, size, false, sig);
    if (id !== null) attrs.push(`marker-end="url(#${id})"`);
  }
  if (edge.directed === 'both') {
    const id = ctx.markers.add(arrowhead, stroke, size, true, sig);
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

function renderEdgeLabel(edgeIndex: number, edgeId: EdgeId, labelId: LabelId, ctx: Ctx): string {
  const spec = ctx.styled.graph.labels[labelId];
  const placement = ctx.placements.get(labelId as string);
  const style = ctx.styled.labelStyles[labelId];
  if (spec === undefined || placement === undefined || style === undefined) return '';

  const sig = edgeSignature(edgeIndex, ctx);
  const block = textBlock(labelLines(spec.runs), style, placement.text);
  const parts: string[] = [];

  if (placement.occlusion === 'plate') {
    const edgeStyle = ctx.styled.styles[edgeId];
    const plate = edgeStyle === undefined ? '' : ctx.classes.plateClasses(edgeStyle, sig);
    if (plate !== '') {
      parts.push(
        `<rect class="${escapeXml(`el-plate ${plate}`)}" x="${num(placement.frame.x)}" y="${num(placement.frame.y)}"` +
          ` width="${num(placement.frame.w)}" height="${num(placement.frame.h)}" aria-hidden="true"/>`,
      );
    }
  }

  parts.push(renderText(placement, block, ctx.classes.textClasses(style, `${sig}|label`), 'el-text', true));
  return `<g class="el" aria-hidden="true">${parts.join('')}</g>`;
}

/** Theme-invariant class names and marker ids; `memo` caches per distinct style. */
export function renderInvariant(styled: StyledGraph, layout: LayoutView, theme: ResolvedTheme, memo = false): InvariantRenderResult {
  return renderProto(styled, layout, theme, invariantTables(memo));
}

/** Production's naming (byte-identical to `render()`); `memo` caches per distinct style. */
export function renderMainProto(styled: StyledGraph, layout: LayoutView, theme: ResolvedTheme, memo: boolean): InvariantRenderResult {
  return renderProto(styled, layout, theme, mainTables(memo));
}

function renderProto(styled: StyledGraph, layout: LayoutView, theme: ResolvedTheme, tables: Tables): InvariantRenderResult {
  const ctx: Ctx = {
    styled,
    layout,
    classes: tables.classes,
    markers: tables.markers,
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
    if (edge.labelId !== null) edgeLabels.push(renderEdgeLabel(i, edge.id, edge.labelId, ctx));
  });

  const { bounds } = layout;
  const { nodeCount, edgeCount, containerCount } = styled.graph.meta;
  const title = styled.graph.title ?? 'Diagram';
  const desc = `${nodeCount} nodes, ${edgeCount} connections, ${containerCount} groups.`;

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

  return { svg, styleBlock, tokenBlock, defs, bounds, diagnostics: ctx.diagnostics };
}

/**
 * Only the paint half of `renderInvariant`: the `<style>` texts and the
 * `<defs>` markup, discovered by the same walk but without building a single
 * element string. Measures what a paint-only live-view patch would cost if the
 * full `svg` string (still needed for export and for `lastGoodSvg` storage)
 * were built off the frame instead of before it.
 */
export function renderPaintOnly(
  styled: StyledGraph,
  layout: LayoutView,
  theme: ResolvedTheme,
  memo = false,
): Pick<InvariantRenderResult, 'styleBlock' | 'tokenBlock' | 'defs'> {
  const { classes, markers } = invariantTables(memo);
  const placed = new Set(layout.labels.map((p) => p.labelId as string));
  const plated = new Set(layout.labels.filter((p) => p.occlusion === 'plate').map((p) => p.labelId as string));

  for (const id of styled.graph.order) {
    const node = styled.graph.nodes[id];
    if (node === undefined || node.hidden || layout.nodes[id as string] === undefined) continue;
    const sig = signature(node.children.length > 0 ? 'container' : 'node', node.shape, node.classes, node.config);
    const style = styled.styles[id];
    if (style !== undefined) classes.shapeClasses(style, sig);
    if (node.labelId !== null && placed.has(node.labelId as string)) {
      const labelStyle = styled.labelStyles[node.labelId];
      if (labelStyle !== undefined) classes.textClasses(labelStyle, `${sig}|title`);
    }
  }
  for (const edge of styled.graph.edges) {
    if (layout.edges[edge.id as string] === undefined) continue;
    const sig = signature('edge', undefined, edge.classes, edge.config);
    const style = styled.styles[edge.id];
    if (style !== undefined) classes.shapeClasses(style, sig);
    const stroke = paintString(style, 'stroke') ?? '#000000';
    const arrowValue = style?.paint['arrowhead'];
    const arrowhead: Arrowhead = isArrowhead(arrowValue) ? arrowValue : 'triangle';
    const size = geometryNumber(style, 'arrowSize', 8);
    if (edge.directed === 'forward' || edge.directed === 'both') markers.add(arrowhead, stroke, size, false, sig);
    if (edge.directed === 'both') markers.add(arrowhead, stroke, size, true, sig);
    if (edge.labelId !== null && placed.has(edge.labelId as string)) {
      if (plated.has(edge.labelId as string) && style !== undefined) classes.plateClasses(style, sig);
      const labelStyle = styled.labelStyles[edge.labelId];
      if (labelStyle !== undefined) classes.textClasses(labelStyle, `${sig}|label`);
    }
  }
  return {
    styleBlock: buildStyleBlock(styled.canvas.background, classes.emit()),
    tokenBlock: buildTokenBlock(theme, styled.canvas.background),
    defs: markers.emit(),
  };
}
