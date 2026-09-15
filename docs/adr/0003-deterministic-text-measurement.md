# ADR-0003 — Deterministic text measurement

**Status:** Proposed · **Date:** 2026-09-14

## Context

Node sizes derive from label sizes, so text measurement feeds layout, which feeds everything. But:

- `canvas.measureText` differs between browsers, platforms, and even font-hinting settings. Chrome on Windows and Safari on macOS disagree on the same string in the same font.
- A Cloudflare Worker has no canvas and no font rasteriser at all.
- The requirement is byte-identical SVG from browser, CLI, and Worker (NFR-1, NFR-3).

If measurement is platform-dependent, two people rendering the same file get different geometry, cached server renders disagree with live client renders, and golden-file tests are unwritable.

## Options

**A. Canvas everywhere it exists, estimate elsewhere.** Highest fidelity in-browser; server output visibly differs from client output. Fails the requirement outright.

**B. Precomputed font metrics, used everywhere.** Ship glyph advance widths and kerning pairs for the bundled fonts as compact binary tables. Measure by summing advances. Identical in every environment.

**C. Rasterise everywhere via WASM.** Bundle a shaping engine (HarfBuzz) compiled to WASM. Perfectly accurate and consistent, but adds ~500 kB+ and meaningful startup cost to a 180 kB bundle budget.

## Decision

**Option B as the default**, with Option A available as an explicit opt-in.

- `FontMetricsMeasurer` is the default `Measurer` in all environments. Metrics tables for each bundled theme font are generated at build time and shipped as a compact binary asset (~8–20 kB per font, gzipped).
- `CanvasMeasurer` / `OffscreenMeasurer` exist and can be selected per-document for users who need pixel-perfect fidelity with an unusual font and do not care about cross-environment agreement. Choosing it stamps the document so the render cache never mixes the two.
- When a theme references a font with no metrics table, the resolver emits a warning and falls back to the nearest table in the same class (sans/serif/mono), keeping output deterministic but approximate.

## Consequences

- Same file, same SVG, everywhere. Golden-file testing across browser, Node, and Worker becomes possible, and it is the test that keeps the whole determinism promise honest.
- The Cloudflare Worker runs the real pipeline rather than an approximation, so server render, OG images, and CI all reuse browser code.
- Advance-sum measurement ignores complex shaping: ligatures, contextual alternates, and bidi reordering are approximated. Widths may be off by a small percentage for Latin text. Acceptable — node padding absorbs it, and the error is *consistent*, which matters more than being *correct*.
- Complex scripts (Arabic, Devanagari, Thai) will measure poorly. If they become a real requirement, revisit with Option C, scoped to a lazily-loaded shaping module for documents that need it.
- Build tooling must generate metrics tables, and adding a font to a theme is therefore a build-time step for bundled fonts. User-supplied fonts fall back as described above.

## Amendment, 2026-09-14 — sequencing: canvas first, metrics tables with server render

The decision stands, but it was scheduled on the MVP path for a property the MVP cannot exercise.
Cross-environment parity only matters once there is a second environment, and the Worker render
API is phase 3. Building a font-file parsing pipeline, a binary metrics format and kerning support
before then is cost with no observable benefit.

**The MVP defaults to `CanvasMeasurer`**, pre-measuring on the main thread and shipping the table
into the layout worker exactly as designed. `FontMetricsMeasurer` becomes the default when the
Worker render API ships. The `Measurer` interface is identical either way, so nothing above the
measurer changes. Recorded in [06 §4, pitfall 2](../06-feasibility-and-mvp.md).

## Amendment, 2026-09-14 — measurement is run-based

The feature triage made markdown labels (A18) a Must while keeping the ban on `<foreignObject>`
(D9), and added code blocks in nodes (A20) and UML/ER compartment shapes (I4) at Should. A label is
therefore a sequence of differently-styled runs, not a single string, and line breaking is ours to
perform rather than the browser's.

`Measurer` changes accordingly: `measure(text, style)` becomes
`layoutRuns(runs, boxConstraints)` returning line boxes, baselines and per-run offsets. See
[Architecture §6](../03-architecture.md#6-measurement).

Nothing in the decision above changes — precomputed advances still measure each run, and the result
is still identical across environments. But the choice now has a second payoff worth recording:
because we do our own line breaking, **line-break positions are also deterministic**. Had we relied
on the browser to wrap text, identical input would break differently across engines and the
byte-identical-SVG promise would fail at the first two-line label.

