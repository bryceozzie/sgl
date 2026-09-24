/**
 * The corpus documents every clean-document suite tests against — the front end
 * through the renderer, one list.
 *
 * Before this file, four packages each hand-maintained their own copy
 * (`packages/core/test/resolve.test.ts`, `compile.test.ts`,
 * `packages/layout-std/test/grid.test.ts`, `packages/render-svg/test/render.test.ts`),
 * and the guard that was supposed to catch drift only checked that the list
 * *contained* two specific entries — so a fixture added to neither `CLEAN_DOCS`
 * nor a known-dirty set (`malformed/`, `unresolved/`, `injection/`, the generated
 * benchmarks) could sit uncovered by three of the four stages indefinitely.
 * `a11y-links.sgl` did exactly that (Stage F review finding). One list, imported
 * by all four, makes that impossible: adding a document here is the only way to
 * cover it anywhere, and `render.test.ts`'s partition assertion is the guard that
 * actually fails when one is missing.
 *
 * Lives under `packages/core/test/` — `@sgl/core` is the bottom of the dependency
 * graph (DD-00 §2) — so `theme`, `layout-std` and `render-svg` test files
 * importing this constant follow the dependency direction rather than inverting
 * it. Not exported from the package (`files: ["dist"]` never picks up `test/`) —
 * a dev-only fixture module, not a shipped export.
 */
export const CLEAN_DOCS: readonly string[] = [
  'empty.sgl',
  'single.sgl',
  'json-form.sgl.json',
  'checkout.sgl',
  'nesting-3.sgl',
  'chains.sgl',
  'parallel-selfloop.sgl',
  'ports.sgl',
  'classes.sgl',
  'containers-edges.sgl',
  'wildcards.sgl',
  'wildcard-globs.sgl',
  'wildcard-paths.sgl',
  'shapes.sgl',
  'unicode.sgl',
  'hidden.sgl',
  'a11y-links.sgl',
  'forty-three-level.sgl',
  'nested-crossing.sgl',
  'variables.sgl',
];
