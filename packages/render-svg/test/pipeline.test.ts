import type { DiagnosticCode } from '@sgl/core';
import { neutralDark, neutralLight } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { edgeElementId } from '../src/security.js';
import { corpusPath, corpusSource, listCorpusDocs, runPipeline } from './pipeline.js';

/**
 * Stage G — the end-to-end seam (07-execution-plan.md §5). Gate 2's own words:
 * "text in, deterministic accessible SVG out, end to end, in CI." The corpus
 * goldens and per-package double-run sweeps that prove most of this already
 * exist (Stages D–F); what is new here is the two properties that only make
 * sense read at the *pipeline* level, not one stage's slice of it.
 */

/**
 * "Every corpus document goes source -> SVG with no unexpected diagnostics."
 * A `CLEAN_DOCS` member does not mean "zero diagnostics" — `checkout.sgl`,
 * `wildcards.sgl`, `wildcard-globs.sgl` and `hidden.sgl` all carry documented,
 * intentional warnings (see corpus/README.md and each document's own comments)
 * — it means "renders with exactly its audited set and nothing new." This
 * table is that audit, taken directly from a real `runPipeline` run rather
 * than guessed; a stage that starts emitting an extra diagnostic for one of
 * these documents fails here instead of silently passing.
 */
const EXPECTED_DIAGNOSTICS: Readonly<Record<string, readonly DiagnosticCode[]>> = {
  // SGL3006 x2 (the `External` class's `cloud` shape is not drawn this
  // version — see corpus/README.md's "A note on checkout.sgl").
  // SGL4010 (Stage K fix round 1, item 23): the root's `@layout: { …,
  // direction: right }` under grid, which does not declare `direction`. The
  // nested `engine: grid` names the harness's own engine, so it is not one.
  // Since A8 `@style.stroke: $hot` substitutes to a real colour: the SGL2009
  // placeholder, the SGL2010 for an unregistered `@vars` and the SGL5004 for
  // `$hot` as literal text are all gone.
  'checkout.sgl': ['SGL3006', 'SGL3006', 'SGL4010'],
  // Three portless nodes attach to their node instead of a named port (SGL2003
  // x3) and one wildcard matches nothing (SGL3003) — both documented in the
  // file's own comments as intentional near-misses, not defects.
  'wildcards.sgl': ['SGL2003', 'SGL2003', 'SGL2003', 'SGL3003'],
  'wildcard-globs.sgl': ['SGL2003', 'SGL2003', 'SGL2003', 'SGL2003'],
  // A node under a hidden container is itself effectively hidden (DD-03) —
  // one SGL3002 for the edge that becomes unreachable as a result.
  'hidden.sgl': ['SGL3002'],
};

function codesOf(diagnostics: readonly { readonly code: DiagnosticCode }[]): DiagnosticCode[] {
  return diagnostics.map((d) => d.code).sort();
}

/**
 * A dirty document's *own* expected code(s) — the same `// expects: SGLnnnn`
 * header `parse.test.ts`/`resolve.test.ts`/`compile.test.ts` already read for
 * `malformed/`/`unresolved/*.sgl`, plus `injection/js-url-link.sgl`'s
 * (renderer-owned `SGL6001`). A document with no header (every other
 * `injection/*.sgl` fixture, and the generated `n50`/`n500`/`n2000.sgl` scale
 * documents) expects nothing on its own.
 */
function ownExpected(src: string): readonly DiagnosticCode[] {
  const m = /\/\/ expects: (SGL\d+)/.exec(src);
  return m === null ? [] : [m[1] as DiagnosticCode];
}

/**
 * Codes a *later* stage adds beyond a dirty document's own `// expects:` code —
 * a side effect of running the whole pipeline over a document a single-stage
 * test only partially exercises. Both entries here are pre-existing, harmless
 * parser-recovery artefacts that `parse.test.ts`'s own malformed-corpus check
 * already tolerates (it asserts the expected code is *present*, not that it is
 * the *only* one) — Stage G is the first place they get written down instead
 * of silently passing through a subset check. An empty entry is the default;
 * anything else must be listed here explicitly, by a human, not inferred.
 */
const DOWNSTREAM_EXTRA: Readonly<Record<string, readonly DiagnosticCode[]>> = {
  // A9 (DD-02 I17): the class and the edge through the import that failed,
  // one SGL2024 each, from the resolve and from the compile.
  'imports/unresolved.sgl': ['SGL2024', 'SGL2024'],
  // The unterminated string swallows the rest of the line looking for its
  // closing quote, which the parser then recovers from as a second, unrelated
  // syntax error one token later.
  'malformed/unterminated-string.sgl': ['SGL1001'],
  // The parser's recovery from the doubled wildcard leaves a partial edge
  // statement whose surviving wildcard matches nothing once compiled.
  'malformed/wildcard-two-stars.sgl': ['SGL3003'],
};

describe('the pipeline, source to SVG: no unexpected diagnostics (Stage G, T3 gate)', () => {
  it('EXPECTED_DIAGNOSTICS and DOWNSTREAM_EXTRA name only real documents', () => {
    const docs = new Set(listCorpusDocs());
    for (const doc of Object.keys(EXPECTED_DIAGNOSTICS)) {
      expect(CLEAN_DOCS, `${doc} is a stale EXPECTED_DIAGNOSTICS key — not in CLEAN_DOCS`).toContain(doc);
    }
    for (const doc of Object.keys(DOWNSTREAM_EXTRA)) {
      expect(docs, `${doc} is a stale DOWNSTREAM_EXTRA key — not in the corpus`).toContain(doc);
      expect(CLEAN_DOCS, `${doc} is in both CLEAN_DOCS and DOWNSTREAM_EXTRA`).not.toContain(doc);
    }
  });

  for (const doc of CLEAN_DOCS) {
    it(`${doc}: emits exactly its audited diagnostic set`, async () => {
      const expected = [...(EXPECTED_DIAGNOSTICS[doc] ?? [])].sort();
      const { diagnostics } = await runPipeline(corpusSource(doc), neutralLight);
      expect(codesOf(diagnostics)).toEqual(expected);
    });
  }

  // The other 36 of 52 corpus documents (malformed/, unresolved/, injection/,
  // and the three generated scale documents) reach theme, layout and render as
  // partial or hostile graphs — the inputs most likely to surface a seam bug —
  // and until now only got `render.test.ts`'s never-throws sweep, which
  // asserts nothing about *which* diagnostics come out the other end.
  const dirtyDocs = listCorpusDocs().filter((doc) => !CLEAN_DOCS.includes(doc));

  it('every non-CLEAN_DOCS corpus document is accounted for above', () => {
    expect(dirtyDocs.length).toBeGreaterThan(0);
    expect(new Set([...CLEAN_DOCS, ...dirtyDocs])).toEqual(new Set(listCorpusDocs()));
  });

  for (const doc of dirtyDocs) {
    it(`${doc}: emits exactly its own code plus its documented downstream extras`, async () => {
      const src = corpusSource(doc);
      const expected = [...ownExpected(src), ...(DOWNSTREAM_EXTRA[doc] ?? [])].sort();
      // `corpus/imports/` documents import their neighbours: the path gives
      // the file-system host (A9); for every other document it changes
      // nothing.
      const { diagnostics } = await runPipeline(src, neutralLight, undefined, undefined, corpusPath(doc));
      expect(codesOf(diagnostics)).toEqual(expected);
    });
  }
});

describe('a theme switch at the pipeline level (MVP acceptance criterion 2, DD-09 §4)', () => {
  // DD-09 §3.3 invariant 3 and the theme package's own cascade.test.ts already
  // prove this at the `styleGraph` level, for one document. The property MVP
  // criterion 2 actually rests on is stronger: that a *real layout run* —
  // premeasure, grid, host fallbacks, quantize — produces byte-identical
  // numbers under both themes, so a live theme toggle never re-lays-out. That
  // can only be checked here, after Stage E and Stage F both exist.
  for (const doc of CLEAN_DOCS) {
    it(`${doc}: neutral-light -> neutral-dark changes paint only`, async () => {
      const src = corpusSource(doc);
      const light = await runPipeline(src, neutralLight);
      const dark = await runPipeline(src, neutralDark);

      expect(dark.styled.geometryHash).toBe(light.styled.geometryHash);
      // For every other CLEAN_DOCS document this also moves for element reasons
      // (some node or edge has a paint property that differs between the built-in
      // themes) — `empty.sgl` is the one case with zero elements, so it is the
      // only one where this assertion actually exercises the `canvas=...` term
      // `styleGraph` folds into `paintHash` (packages/theme/src/cascade.ts, and
      // packages/theme/test/cascade.test.ts's own direct unit test for it).
      expect(dark.styled.paintHash).not.toBe(light.styled.paintHash);

      // The layout engine never sees paint (DD-06 §2's `LayoutInput` carries no
      // colour), so a run under two themes that agree on every geometry token
      // must produce the identical `LayoutResult` — the same numbers, not just
      // an equal hash of them.
      expect(dark.result).toEqual(light.result);

      // The rendered SVG itself is *not* byte-identical (F7, execution plan
      // §2.1): the `<style>` block's tokens, every element's paint class names,
      // and a directed edge's marker id all embed the paint hash, and the
      // canvas background alone guarantees a difference even for `empty.sgl`.
      // Asserting equality here would re-litigate a property this project
      // already found unimplementable — the geometry-level checks above are
      // the real one DD-08 §3 rests on.
      expect(light.rendered.svg).not.toBe(dark.rendered.svg);
    });
  }
});

/**
 * The seam this bug slipped through: `layout-api`'s `fallbacks.test.ts` pins
 * the arrow *reserve* (DD-06 §4.4 shortens the path by `arrowSize`) in
 * isolation, and `render-svg`'s `markers.test.ts` pins the marker's own
 * `refX` in isolation — but nothing ran both through the real pipeline and
 * checked where the rendered arrowhead's *tip* actually lands relative to
 * the target node. This is that check (fix/arrowhead-gap): for every
 * `forward`/`both` edge whose endpoint is a box-anchored shape, it reads the
 * edge's own `d` path and its marker's `refX`/`markerWidth` back out of the
 * *rendered SVG string* — not the `EdgeLayout` the renderer built them from,
 * so a renderer-side bug like this one (the reserve was correct; the
 * marker's anchor was not) actually gets caught — reconstructs the point the
 * marker's own tip lands on, and asserts it sits on the target node's
 * `LayoutResult` frame boundary. Against the pre-fix `refX = start ? 0 : w`
 * this failed on every checked edge, short of the boundary by exactly
 * `arrowSize` (8px) in the direction of travel — confirmed by running this
 * suite against markers.ts before the `refX` fix below.
 */
describe('the arrowhead tip lands on the node boundary (seam test, DD-06 §4.4 x markers.ts refX)', () => {
  const EPS = 0.05; // DD-06 §5 quantizes to 1/64px (0.015625); a small margin above that.

  // `anchor.ts`'s box-anchor family (DD-07 §4): every shape except the three
  // with a non-rectangular boundary. Those don't have an axis-aligned frame
  // edge for a tip to land on, so only rectangular endpoints are checked here.
  function isBoxAnchored(shape: string): boolean {
    return shape !== 'ellipse' && shape !== 'diamond' && shape !== 'hexagon';
  }

  interface Point2 {
    readonly x: number;
    readonly y: number;
  }
  interface Rect2 {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  }

  function onFrameBoundary(p: Point2, frame: Rect2, eps: number): boolean {
    const withinX = p.x >= frame.x - eps && p.x <= frame.x + frame.w + eps;
    const withinY = p.y >= frame.y - eps && p.y <= frame.y + frame.h + eps;
    const onLeft = Math.abs(p.x - frame.x) <= eps && withinY;
    const onRight = Math.abs(p.x - (frame.x + frame.w)) <= eps && withinY;
    const onTop = Math.abs(p.y - frame.y) <= eps && withinX;
    const onBottom = Math.abs(p.y - (frame.y + frame.h)) <= eps && withinX;
    return onLeft || onRight || onTop || onBottom;
  }

  function unit(dx: number, dy: number): Point2 {
    const len = Math.sqrt(dx * dx + dy * dy);
    return len === 0 ? { x: 0, y: 0 } : { x: dx / len, y: dy / len };
  }

  interface Seg {
    readonly cmd: string;
    readonly n: readonly number[];
  }

  /** Parses exactly the `d` grammar `routePath`/`segment` (`../src/index.ts`)
   *  emit: `M x y` then a run of `L`/`Q`/`C`/`A` commands, each followed by
   *  its own space-separated numbers — no other command letters, no commas. */
  function parseD(d: string): readonly Seg[] {
    return [...d.matchAll(/([MLQCA])([^MLQCA]*)/g)].map((m) => {
      const rest = (m[2] ?? '').trim();
      return { cmd: m[1] ?? '', n: rest.length === 0 ? [] : rest.split(/\s+/).map(Number) };
    });
  }

  function endPoint(seg: Seg): Point2 {
    const n = seg.n;
    return { x: n[n.length - 2] ?? 0, y: n[n.length - 1] ?? 0 };
  }

  /** The direction the path is travelling as it *arrives* at `seg`'s own end
   *  point — the tangent `orient="auto"` aims an end/`both`-head marker
   *  along. `from` is the point `seg` starts from. */
  function tangentAtEnd(seg: Seg, from: Point2): Point2 {
    const to = endPoint(seg);
    let px = from.x;
    let py = from.y;
    if (seg.cmd === 'Q') {
      px = seg.n[0] ?? from.x;
      py = seg.n[1] ?? from.y;
    } else if (seg.cmd === 'C') {
      px = seg.n[2] ?? from.x;
      py = seg.n[3] ?? from.y;
    }
    return unit(to.x - px, to.y - py);
  }

  /** The direction the path is travelling as it *leaves* `from` into `seg` —
   *  what a start marker (drawn only for `directed: 'both'`) orients along. */
  function tangentAtStart(seg: Seg, from: Point2): Point2 {
    let cx = seg.n[0] ?? from.x;
    let cy = seg.n[1] ?? from.y;
    if (seg.cmd === 'A') {
      const to = endPoint(seg);
      cx = to.x;
      cy = to.y;
    }
    return unit(cx - from.x, cy - from.y);
  }

  interface MarkerGeom {
    readonly refX: number;
    readonly markerWidth: number;
  }

  /** `markers.ts`'s exact emitted attribute order — id, markerUnits,
   *  markerWidth, markerHeight, refX — so one regex reads every `<marker>`
   *  a render emits without needing to know which theme or arrowhead it is. */
  function parseMarkers(svg: string): ReadonlyMap<string, MarkerGeom> {
    const map = new Map<string, MarkerGeom>();
    const re = /<marker id="([^"]+)" markerUnits="userSpaceOnUse" markerWidth="(-?[\d.]+)" markerHeight="-?[\d.]+" refX="(-?[\d.]+)"/g;
    for (const m of svg.matchAll(re)) {
      const id = m[1];
      const markerWidth = m[2];
      const refX = m[3];
      if (id === undefined || markerWidth === undefined || refX === undefined) continue;
      map.set(id, { markerWidth: Number(markerWidth), refX: Number(refX) });
    }
    return map;
  }

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  interface EdgePath {
    readonly d: string;
    readonly markerEnd: string | null;
    readonly markerStart: string | null;
  }

  /** Reads one edge's own rendered `<path>` back out of the SVG — its `d`
   *  and its `marker-end`/`marker-start` — by the element id `renderEdge`
   *  gives its `<g>` (`edgeElementId`, `../src/security.ts`). */
  function extractEdgePath(svg: string, edgeId: string): EdgePath | null {
    const gid = escapeRegExp(edgeElementId(edgeId));
    const m = new RegExp(`<g id="${gid}"[^>]*>\\s*<path ([^>]*)/>`).exec(svg);
    if (m === null) return null;
    const attrs = m[1] ?? '';
    const dMatch = /\sd="([^"]*)"/.exec(attrs);
    if (dMatch === null || dMatch[1] === undefined) return null;
    const endMatch = /marker-end="url\(#([^)]+)\)"/.exec(attrs);
    const startMatch = /marker-start="url\(#([^)]+)\)"/.exec(attrs);
    return {
      d: dMatch[1],
      markerEnd: endMatch === null ? null : (endMatch[1] ?? null),
      markerStart: startMatch === null ? null : (startMatch[1] ?? null),
    };
  }

  /**
   * `tip = end + dir·(markerWidth − refX)` for an end/`both`-head marker.
   * Mirrored for a start marker: it points backward (away from the
   * direction of travel), and — drawn flipped 180° in `markers.ts` — its
   * own `refX` is already the local distance from the vertex back to its
   * tip, so the mirror both flips the sign (subtract from `start` instead
   * of adding to `end`) and swaps which of `refX`/`markerWidth − refX` is
   * the tip distance.
   */
  function tipFor(edgeD: string, marker: MarkerGeom, atStart: boolean): Point2 | null {
    const segs = parseD(edgeD);
    const first = segs[0];
    if (first === undefined || first.cmd !== 'M' || segs.length < 2) return null;
    const start = { x: first.n[0] ?? 0, y: first.n[1] ?? 0 };

    if (atStart) {
      const seg1 = segs[1];
      if (seg1 === undefined) return null;
      const dir = tangentAtStart(seg1, start);
      const mag = marker.refX;
      return { x: start.x - dir.x * mag, y: start.y - dir.y * mag };
    }

    const last = segs[segs.length - 1];
    if (last === undefined) return null;
    const prevSeg = segs.length >= 3 ? segs[segs.length - 2] : undefined;
    const prev = prevSeg === undefined ? start : endPoint(prevSeg);
    const dir = tangentAtEnd(last, prev);
    const end = endPoint(last);
    const mag = marker.markerWidth - marker.refX;
    return { x: end.x + dir.x * mag, y: end.y + dir.y * mag };
  }

  let totalChecked = 0;

  for (const doc of CLEAN_DOCS) {
    it(`${doc}: every forward/both arrowhead's tip lands on its target node's boundary`, async () => {
      const { rendered, input, result } = await runPipeline(corpusSource(doc), neutralLight);
      const markers = parseMarkers(rendered.svg);

      for (const edge of input.graph.edges) {
        if (edge.hidden || edge.directed === 'none') continue;
        const geom = result.edges[edge.id];
        if (geom === undefined) continue;
        const path = extractEdgePath(rendered.svg, edge.id);
        if (path === null) continue;

        if ((edge.directed === 'forward' || edge.directed === 'both') && path.markerEnd !== null) {
          const toNode = input.graph.nodes[edge.to.node];
          const toFrame = result.nodes[edge.to.node]?.frame;
          const marker = markers.get(path.markerEnd);
          if (toNode !== undefined && toFrame !== undefined && marker !== undefined && isBoxAnchored(toNode.shape)) {
            const tip = tipFor(path.d, marker, false);
            expect(tip, `${doc} ${edge.id}: could not parse an end-marker tip`).not.toBeNull();
            if (tip !== null) {
              expect(
                onFrameBoundary(tip, toFrame, EPS),
                `${doc} ${edge.id}: end tip ${JSON.stringify(tip)} not on target frame ${JSON.stringify(toFrame)}`,
              ).toBe(true);
              totalChecked += 1;
            }
          }
        }

        if (edge.directed === 'both' && path.markerStart !== null) {
          const fromNode = input.graph.nodes[edge.from.node];
          const fromFrame = result.nodes[edge.from.node]?.frame;
          const marker = markers.get(path.markerStart);
          if (fromNode !== undefined && fromFrame !== undefined && marker !== undefined && isBoxAnchored(fromNode.shape)) {
            const tip = tipFor(path.d, marker, true);
            expect(tip, `${doc} ${edge.id}: could not parse a start-marker tip`).not.toBeNull();
            if (tip !== null) {
              expect(
                onFrameBoundary(tip, fromFrame, EPS),
                `${doc} ${edge.id}: start tip ${JSON.stringify(tip)} not on source frame ${JSON.stringify(fromFrame)}`,
              ).toBe(true);
              totalChecked += 1;
            }
          }
        }
      }
    });
  }

  // A no-op sweep (every edge skipped by a guard above) would pass silently
  // and prove nothing — assert the corpus actually exercised real coverage,
  // including both a `both`-directed start marker and a self-loop
  // (`parallel-selfloop.sgl`'s `a -> a`, whose route is the `C`-segment
  // teardrop rather than a straight `L`).
  it('checked at least one forward and one both-directed edge across the corpus', () => {
    expect(totalChecked).toBeGreaterThan(10);
  });
});

describe('wildcards in parent path segments render through the real pipeline (language spec §3, human decision 2026-09-24)', () => {
  const STORES = 'payments: { api: {} }\nstore1: { api: {} apiV2: {} db: {} }\nstore2: { api-edge: {} }\n';

  it('`store*.api* -> payments.api` renders one edge element per expansion, identical to the hand-written edges', async () => {
    const expanded = await runPipeline(`${STORES}store*.api* -> payments.api\n`, neutralLight);
    const byHand = await runPipeline(
      `${STORES}store1.api -> payments.api\nstore1.apiV2 -> payments.api\nstore2.api-edge -> payments.api\n`,
      neutralLight,
    );
    expect(expanded.diagnostics).toEqual([]);
    const edges = expanded.styled.graph.edges;
    expect(edges.map((e) => e.from.node)).toEqual(['store1.api', 'store1.apiV2', 'store2.api-edge']);
    for (const edge of edges) {
      expect(expanded.rendered.svg).toContain(`<g id="${edgeElementId(edge.id)}"`);
      expect(expanded.result.edges[edge.id]).toBeDefined();
    }
    expect((expanded.rendered.svg.match(/class="e-path/g) ?? []).length).toBe(3);
    // Nothing downstream can tell the edges came from a wildcard.
    expect(expanded.rendered.svg).toBe(byHand.rendered.svg);
  });
});
