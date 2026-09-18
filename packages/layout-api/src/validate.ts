import {
  asNodeId,
  diagnostic,
  NO_SPAN,
  type Diagnostic,
  type PathSeg,
  type Point,
  type SemanticGraph,
  type SourceSpan,
} from '@sgl/core';
import type { EdgeLayout, LabelPlacement, LayoutResult, NodeLayout } from './contract.js';

type Missing = (span: SourceSpan, detail: string) => Diagnostic;

/**
 * `LabelPlacement.align`/`.baseline`/`.occlusion` are enumerated fields on the
 * frozen `contract.ts`, but that is a compile-time guarantee only — an engine's
 * output is untrusted at runtime (a third party writes against `contract.ts`
 * directly, and Stage H sends it across a worker boundary as JSON, which erases
 * the TypeScript union entirely). `@sgl/render-svg` reads all three; a value
 * outside the declared set must be caught here; the charter Stage E's own task 3
 * states is "a buggy engine must never corrupt the renderer" (DD-06 §4).
 */
const VALID_ALIGN: ReadonlySet<string> = new Set(['start', 'middle', 'end']);
const VALID_BASELINE: ReadonlySet<string> = new Set(['top', 'middle', 'bottom']);
const VALID_OCCLUSION: ReadonlySet<string> = new Set(['plate', 'none']);

/**
 * Validate an engine's output before the renderer is allowed to trust it.
 *
 * NaN/Infinity coordinates, unknown node IDs and missing entries are rejected with
 * SGL4002. A buggy third-party engine must never be able to corrupt the renderer.
 *
 * DEVIATION from DD-06 §5's table for the last two rows: the table describes a
 * container `contentFrame` outside its `frame` (SGL4003) as "corrected" — reset to
 * frame inset by padding. This function's signature, unchanged from the stub this
 * stage inherited, returns `readonly Diagnostic[]` only; it has no way to hand back
 * a corrected `LayoutResult`. Both SGL4003 rows are therefore implemented as
 * warnings with no correction, which is exactly what the table's own last row
 * already says for the sibling case ("not corrected — some engines overflow
 * deliberately"). A future stage wiring this into the real pipeline can apply the
 * correction itself once it has a code path that returns a new `LayoutResult`.
 *
 * `engineId` is only for the SGL4002 message text (DD-06 §9's template names the
 * engine); it plays no part in what is checked.
 *
 * Design: DD-06 §4, §5.
 */
export function validateResult(result: LayoutResult, graph: SemanticGraph, engineId: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const missing: Missing = (span, detail) => diagnostic('SGL4002', span, { id: engineId, detail });

  for (const id of graph.order) {
    const node = graph.nodes[id];
    if (node === undefined || node.hidden) continue;
    const layout = result.nodes[id];
    if (layout === undefined) {
      diagnostics.push(missing(node.span, `missing NodeLayout for '${id}'`));
      continue;
    }
    checkFrame(layout.frame, node.span, `'${id}'`, missing, diagnostics);
    if (node.children.length > 0 && layout.contentFrame !== undefined) {
      checkFrame(layout.contentFrame, node.span, `'${id}' contentFrame`, missing, diagnostics);
      if (!frameInside(layout.contentFrame, layout.frame)) {
        diagnostics.push(diagnostic('SGL4003', node.span, { node: id }));
      }
      // Not corrected — some engines overflow deliberately (DD-06 §5's own words
      // for the sibling case; applied here too for the same reason).
      for (const childId of node.children) {
        const child = graph.nodes[childId];
        const childLayout = result.nodes[childId];
        if (child === undefined || child.hidden || childLayout === undefined) continue;
        if (!frameInside(childLayout.frame, layout.contentFrame)) {
          diagnostics.push(diagnostic('SGL4003', child.span, { node: childId }));
        }
      }
    }
    for (const [portId, port] of Object.entries(layout.ports ?? {}).sort(byKey)) {
      if (!finitePoint(port.point) || !finiteVec(port.normal)) {
        diagnostics.push(missing(node.span, `non-finite geometry for '${id}' port '${portId}'`));
      }
    }
  }
  for (const id of Object.keys(result.nodes).sort()) {
    if (graph.nodes[asNodeId(id)] === undefined) {
      diagnostics.push(missing(NO_SPAN, `LayoutResult references unknown node '${id}'`));
    }
  }

  const knownEdges = new Set<string>(graph.edges.map((e) => e.id));
  for (const edge of graph.edges) {
    if (edge.hidden) continue;
    const layout = result.edges[edge.id];
    if (layout === undefined) {
      diagnostics.push(missing(edge.span, `missing EdgeLayout for '${edge.id}'`));
      continue;
    }
    checkEdgeLayout(layout, edge.span, edge.id, missing, diagnostics);
  }
  for (const id of Object.keys(result.edges).sort()) {
    if (!knownEdges.has(id)) diagnostics.push(missing(NO_SPAN, `LayoutResult references unknown edge '${id}'`));
  }

  for (const label of result.labels) {
    if (graph.labels[label.labelId] === undefined) {
      diagnostics.push(missing(NO_SPAN, `LayoutResult label references unknown label '${label.labelId}'`));
      continue;
    }
    checkFrame(label.frame, NO_SPAN, `label '${label.labelId}'`, missing, diagnostics);
    if (!VALID_ALIGN.has(label.align)) {
      diagnostics.push(missing(NO_SPAN, `label '${label.labelId}' has invalid align '${String(label.align)}'`));
    }
    if (!VALID_BASELINE.has(label.baseline)) {
      diagnostics.push(missing(NO_SPAN, `label '${label.labelId}' has invalid baseline '${String(label.baseline)}'`));
    }
    if (label.occlusion !== undefined && !VALID_OCCLUSION.has(label.occlusion)) {
      diagnostics.push(missing(NO_SPAN, `label '${label.labelId}' has invalid occlusion '${String(label.occlusion)}'`));
    }
  }

  checkFrame(result.bounds, NO_SPAN, 'bounds', missing, diagnostics);

  return diagnostics;
}

function checkEdgeLayout(
  layout: EdgeLayout,
  span: SourceSpan,
  edgeId: string,
  missing: Missing,
  diagnostics: Diagnostic[],
): void {
  if (!finitePoint(layout.start) || !finitePoint(layout.end)) {
    diagnostics.push(missing(span, `non-finite start/end for edge '${edgeId}'`));
  }
  for (const seg of layout.route) {
    if (!finiteSeg(seg)) diagnostics.push(missing(span, `non-finite route segment for edge '${edgeId}'`));
  }
  if (layout.startNormal !== undefined && !finiteVec(layout.startNormal)) {
    diagnostics.push(missing(span, `non-finite startNormal for edge '${edgeId}'`));
  }
  if (layout.endNormal !== undefined && !finiteVec(layout.endNormal)) {
    diagnostics.push(missing(span, `non-finite endNormal for edge '${edgeId}'`));
  }
}

function checkFrame(
  frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  span: SourceSpan,
  what: string,
  missing: Missing,
  diagnostics: Diagnostic[],
): void {
  if (!isFiniteNum(frame.x) || !isFiniteNum(frame.y) || !isFiniteNum(frame.w) || !isFiniteNum(frame.h)) {
    diagnostics.push(missing(span, `non-finite frame for ${what}`));
    return;
  }
  if (frame.w < 0 || frame.h < 0) {
    diagnostics.push(missing(span, `negative frame size for ${what}`));
  }
}

function frameInside(
  inner: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  outer: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
): boolean {
  const EPS = 0.5;
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  );
}

function finitePoint(p: Point): boolean {
  return isFiniteNum(p.x) && isFiniteNum(p.y);
}

function finiteVec(v: { readonly x: number; readonly y: number }): boolean {
  return isFiniteNum(v.x) && isFiniteNum(v.y);
}

function finiteSeg(seg: PathSeg): boolean {
  switch (seg.t) {
    case 'L':
      return finitePoint(seg.to);
    case 'Q':
      return finitePoint(seg.to) && finitePoint(seg.c);
    case 'C':
      return finitePoint(seg.to) && finitePoint(seg.c1) && finitePoint(seg.c2);
    case 'A':
      return finitePoint(seg.to) && isFiniteNum(seg.r.w) && isFiniteNum(seg.r.h);
  }
}

function isFiniteNum(v: number): boolean {
  return Number.isFinite(v);
}

function byKey<T>(a: readonly [string, T], b: readonly [string, T]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** Quantize coordinates to the engine's declared determinism class (ADR-0004).
 *  Every `x y w h`, path point, and label frame is rounded to a fixed grid — 1/64
 *  by default (`places = 64`) — as the final step of layout. */
export function quantize(result: LayoutResult, places: number): LayoutResult {
  const q = (v: number): number => Math.round(v * places) / places;
  const qPoint = (p: Point): Point => ({ x: q(p.x), y: q(p.y) });
  const qRect = <R extends { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>(
    r: R,
  ): R => ({ ...r, x: q(r.x), y: q(r.y), w: q(r.w), h: q(r.h) });

  const nodes: Record<string, NodeLayout> = {};
  for (const [id, layout] of Object.entries(result.nodes)) {
    const ports =
      layout.ports === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(layout.ports).map(([pid, p]) => [pid, { point: qPoint(p.point), normal: p.normal }]),
          );
    nodes[id] = {
      ...layout,
      frame: qRect(layout.frame),
      ...(layout.contentFrame !== undefined && { contentFrame: qRect(layout.contentFrame) }),
      ...(ports !== undefined && { ports }),
    };
  }

  const edges: Record<string, EdgeLayout> = {};
  for (const [id, layout] of Object.entries(result.edges)) {
    edges[id] = {
      ...layout,
      start: qPoint(layout.start),
      end: qPoint(layout.end),
      route: layout.route.map(qSeg(q)),
    };
  }

  const labels: LabelPlacement[] = result.labels.map((l) => ({ ...l, frame: qRect(l.frame) }));

  return { ...result, bounds: qRect(result.bounds), nodes, edges, labels };
}

function qSeg(q: (v: number) => number) {
  return (seg: PathSeg): PathSeg => {
    const qp = (p: Point): Point => ({ x: q(p.x), y: q(p.y) });
    switch (seg.t) {
      case 'L':
        return { t: 'L', to: qp(seg.to) };
      case 'Q':
        return { t: 'Q', c: qp(seg.c), to: qp(seg.to) };
      case 'C':
        return { t: 'C', c1: qp(seg.c1), c2: qp(seg.c2), to: qp(seg.to) };
      case 'A':
        return { t: 'A', r: { w: q(seg.r.w), h: q(seg.r.h) }, sweep: seg.sweep, to: qp(seg.to) };
    }
  };
}
