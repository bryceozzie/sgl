import type { DiagnosticCode } from '@sgl/core';
import { neutralDark, neutralLight } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { corpusSource, listCorpusDocs, runPipeline } from './pipeline.js';

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
  // `@style.stroke: $hot`: SGL2009 (a `$variable` isn't substituted yet, Stage
  // B's placeholder), SGL2010 (an unrecognised root `@layout` sub-key), SGL3006
  // x2 (the `Service`/`Store` classes' `round`/... shapes not drawn this
  // version — see corpus/README.md's "A note on checkout.sgl"), SGL5004 ($hot
  // is not a valid colour once kept as literal text).
  'checkout.sgl': ['SGL2009', 'SGL2010', 'SGL3006', 'SGL3006', 'SGL5004'],
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
      const { diagnostics } = await runPipeline(src, neutralLight);
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
