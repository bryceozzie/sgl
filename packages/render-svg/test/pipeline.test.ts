import type { DiagnosticCode } from '@sgl/core';
import { neutralDark, neutralLight } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { CLEAN_DOCS } from '../../core/test/corpus-docs.js';
import { corpusSource, runPipeline } from './pipeline.js';

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

describe('the pipeline, source to SVG: no unexpected diagnostics (Stage G)', () => {
  for (const doc of CLEAN_DOCS) {
    it(`${doc}: emits exactly its audited diagnostic set`, async () => {
      const expected = [...(EXPECTED_DIAGNOSTICS[doc] ?? [])].sort();
      const { diagnostics } = await runPipeline(corpusSource(doc), neutralLight);
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
