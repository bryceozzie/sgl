import {
  asNodeId,
  layoutDiagnostic,
  NO_SPAN,
  type Diagnostic,
  type PathSeg,
  type Point,
  type SemanticGraph,
  type SourceSpan,
} from '@sgl/core';
import { CANVAS_MARGIN, contentExtent } from './bounds.js';
import type { EdgeLayout, LabelPlacement, LayoutResult, NodeLayout } from './contract.js';
import { describeShapeError } from './shape.js';

export { describeShapeError };

type Missing = (span: SourceSpan, detail: string) => void;

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
  checkResult(result, graph, (code, span, v) => {
    diagnostics.push(code === 'SGL4002' ? layoutDiagnostic(code, span, { id: engineId, detail: v }) : layoutDiagnostic(code, span, { node: v }));
  });
  return diagnostics;
}

/** One problem `checkResult` finds: `SGL4002` with its detail, or `SGL4003`
 *  with the node's id. */
export type ResultProblem = (code: 'SGL4002' | 'SGL4003', span: SourceSpan, value: string) => void;

/**
 * `validateResult`'s checks, reporting each problem as a code and a value
 * instead of a diagnostic, so a caller that only needs to know whether a
 * result has an error (the composer, DD-14 C28) builds no message and carries
 * no catalogue row: the layout worker and its lazy chunks carry none (DD-10
 * §2, `check-core-chunks.mjs`).
 */
export function checkResult(result: LayoutResult, graph: SemanticGraph, report: ResultProblem): void {
  const missing = (span: SourceSpan, detail: string): void => report('SGL4002', span, detail);

  // `result`'s static type is the frozen `LayoutResult`, but that is a
  // compile-time guarantee only: a third party writes an engine directly
  // against `contract.ts`, and Stage H sends this value across a worker
  // boundary as JSON. A buggy `layout()` can resolve `undefined`, `null`, a
  // number, or `{}` just as easily as a malformed `LayoutResult` — every shape
  // this function otherwise assumes (`result.nodes`, `.edges`, `.labels`,
  // `.bounds`) must be checked before it is dereferenced, or a `TypeError`
  // escapes from inside `host.ts`'s message listener *after* it has already
  // cleared the request's timer, leaving `run()` unsettled forever (found in
  // review; DD-00 §3's "never throws" applies to untrusted external input
  // exactly as much as to a `.sgl` document). One `SGL4002` and an early
  // return, same as any other malformed result.
  const shapeError = describeShapeError(result);
  if (shapeError !== null) {
    missing(NO_SPAN, shapeError);
    return;
  }

  for (const id of graph.order) {
    const node = graph.nodes[id];
    if (node === undefined || node.hidden) continue;
    const layout = result.nodes[id];
    if (layout === undefined) {
      missing(node.span, `missing NodeLayout for '${id}'`);
      continue;
    }
    checkFrame(layout.frame, node.span, `'${id}'`, missing);
    if (node.children.length > 0 && layout.contentFrame !== undefined) {
      checkFrame(layout.contentFrame, node.span, `'${id}' contentFrame`, missing);
      if (!frameInside(layout.contentFrame, layout.frame)) {
        report('SGL4003', node.span, id);
      }
      // Not corrected — some engines overflow deliberately (DD-06 §5's own words
      // for the sibling case; applied here too for the same reason).
      for (const childId of node.children) {
        const child = graph.nodes[childId];
        const childLayout = result.nodes[childId];
        if (child === undefined || child.hidden || childLayout === undefined) continue;
        if (!frameInside(childLayout.frame, layout.contentFrame)) {
          report('SGL4003', child.span, childId);
        }
      }
    }
    for (const [portId, port] of Object.entries(layout.ports ?? {}).sort(byKey)) {
      if (!finitePoint(port.point) || !finiteVec(port.normal)) {
        missing(node.span, `non-finite geometry for '${id}' port '${portId}'`);
      }
    }
  }
  for (const id of Object.keys(result.nodes).sort()) {
    if (graph.nodes[asNodeId(id)] === undefined) {
      missing(NO_SPAN, `LayoutResult references unknown node '${id}'`);
    }
  }

  const knownEdges = new Set<string>(graph.edges.map((e) => e.id));
  for (const edge of graph.edges) {
    if (edge.hidden) continue;
    const layout = result.edges[edge.id];
    if (layout === undefined) {
      missing(edge.span, `missing EdgeLayout for '${edge.id}'`);
      continue;
    }
    checkEdgeLayout(layout, edge.span, edge.id, missing);
  }
  for (const id of Object.keys(result.edges).sort()) {
    if (!knownEdges.has(id)) missing(NO_SPAN, `LayoutResult references unknown edge '${id}'`);
  }

  for (const label of result.labels) {
    if (graph.labels[label.labelId] === undefined) {
      missing(NO_SPAN, `LayoutResult label references unknown label '${label.labelId}'`);
      continue;
    }
    checkFrame(label.frame, NO_SPAN, `label '${label.labelId}'`, missing);
    if (!VALID_ALIGN.has(label.align)) {
      missing(NO_SPAN, `label '${label.labelId}' has invalid align '${String(label.align)}'`);
    }
    if (!VALID_BASELINE.has(label.baseline)) {
      missing(NO_SPAN, `label '${label.labelId}' has invalid baseline '${String(label.baseline)}'`);
    }
    if (label.occlusion !== undefined && !VALID_OCCLUSION.has(label.occlusion)) {
      missing(NO_SPAN, `label '${label.labelId}' has invalid occlusion '${String(label.occlusion)}'`);
    }
  }

  checkFrame(result.bounds, NO_SPAN, 'bounds', missing);
}

function checkEdgeLayout(
  layout: EdgeLayout,
  span: SourceSpan,
  edgeId: string,
  missing: Missing,
): void {
  if (!finitePoint(layout.start) || !finitePoint(layout.end)) {
    missing(span, `non-finite start/end for edge '${edgeId}'`);
  }
  for (const seg of layout.route) {
    if (!finiteSeg(seg)) missing(span, `non-finite route segment for edge '${edgeId}'`);
  }
  if (layout.startNormal !== undefined && !finiteVec(layout.startNormal)) {
    missing(span, `non-finite startNormal for edge '${edgeId}'`);
  }
  if (layout.endNormal !== undefined && !finiteVec(layout.endNormal)) {
    missing(span, `non-finite endNormal for edge '${edgeId}'`);
  }
}

function checkFrame(
  frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  span: SourceSpan,
  what: string,
  missing: Missing,
): void {
  if (!isFiniteNum(frame.x) || !isFiniteNum(frame.y) || !isFiniteNum(frame.w) || !isFiniteNum(frame.h)) {
    missing(span, `non-finite frame for ${what}`);
    return;
  }
  if (frame.w < 0 || frame.h < 0) {
    missing(span, `negative frame size for ${what}`);
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

/** Quantize coordinates to the engine's declared determinism class (ADR-0004),
 *  and recompute `bounds` from the result (DD-06 §5, F14).
 *
 *  Every `x y w h`, path point, and label frame is rounded to a fixed grid — 1/64
 *  by default (`places = 64`) — as the final step of layout. Then the engine's
 *  `bounds` is discarded: the host measures what the quantized result draws
 *  (`contentExtent`, `bounds.ts`), grows it by `CANVAS_MARGIN` on every side,
 *  rounded outward to the same grid, and translates every coordinate so that
 *  box starts at the origin. The translation is a whole number of grid steps, so
 *  the result is still on the grid, and quantizing it again changes nothing. A
 *  result that draws nothing gets `{ x: 0, y: 0, w: 0, h: 0 }`. */
export function quantize(result: LayoutResult, places: number): LayoutResult {
  const q = (v: number): number => Math.round(v * places) / places;
  const quantized = mapGeometry(result, q, q, q);

  const extent = contentExtent(quantized);
  if (extent === null) return { ...quantized, bounds: { x: 0, y: 0, w: 0, h: 0 } };
  // Outward to the grid. The epsilon keeps a value already on the grid (every
  // frame and path point) exactly where it is despite floating-point noise in a
  // curve's extremum, which is what makes a second pass a no-op.
  const floorQ = (v: number): number => Math.floor(v * places + 1e-6) / places;
  const ceilQ = (v: number): number => Math.ceil(v * places - 1e-6) / places;
  const x0 = floorQ(extent.x) - CANVAS_MARGIN;
  const y0 = floorQ(extent.y) - CANVAS_MARGIN;
  const x1 = ceilQ(extent.x + extent.w) + CANVAS_MARGIN;
  const y1 = ceilQ(extent.y + extent.h) + CANVAS_MARGIN;
  const bounds = { x: 0, y: 0, w: x1 - x0, h: y1 - y0 };
  if (x0 === 0 && y0 === 0) return { ...quantized, bounds };
  const same = (v: number): number => v;
  return { ...mapGeometry(quantized, (x) => x - x0, (y) => y - y0, same), bounds };
}

/** `result` with every x coordinate through `fx`, every y through `fy` and
 *  every width, height and arc radius through `fLen`; `bounds` through the
 *  same (the caller replaces it). */
export function mapGeometry(
  result: LayoutResult,
  fx: (v: number) => number,
  fy: (v: number) => number,
  fLen: (v: number) => number,
): LayoutResult {
  const mPoint = (p: Point): Point => ({ x: fx(p.x), y: fy(p.y) });
  const mRect = <R extends { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>(
    r: R,
  ): R => ({ ...r, x: fx(r.x), y: fy(r.y), w: fLen(r.w), h: fLen(r.h) });

  const nodes: Record<string, NodeLayout> = {};
  for (const [id, layout] of Object.entries(result.nodes)) {
    const ports =
      layout.ports === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(layout.ports).map(([pid, p]) => [pid, { point: mPoint(p.point), normal: p.normal }]),
          );
    nodes[id] = {
      ...layout,
      frame: mRect(layout.frame),
      ...(layout.contentFrame !== undefined && { contentFrame: mRect(layout.contentFrame) }),
      ...(ports !== undefined && { ports }),
    };
  }

  const edges: Record<string, EdgeLayout> = {};
  for (const [id, layout] of Object.entries(result.edges)) {
    edges[id] = {
      ...layout,
      start: mPoint(layout.start),
      end: mPoint(layout.end),
      route: layout.route.map(mSeg(mPoint, fLen)),
    };
  }

  const labels: LabelPlacement[] = result.labels.map((l) => ({ ...l, frame: mRect(l.frame) }));

  return { ...result, bounds: mRect(result.bounds), nodes, edges, labels };
}

function mSeg(mp: (p: Point) => Point, fLen: (v: number) => number) {
  return (seg: PathSeg): PathSeg => {
    switch (seg.t) {
      case 'L':
        return { t: 'L', to: mp(seg.to) };
      case 'Q':
        return { t: 'Q', c: mp(seg.c), to: mp(seg.to) };
      case 'C':
        return { t: 'C', c1: mp(seg.c1), c2: mp(seg.c2), to: mp(seg.to) };
      case 'A':
        return { t: 'A', r: { w: fLen(seg.r.w), h: fLen(seg.r.h) }, sweep: seg.sweep, to: mp(seg.to) };
    }
  };
}
