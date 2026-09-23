import type { ResolvedThemeMetricsView } from '@sgl/layout-api';

/**
 * `ctx.metrics` (DD-06 §2): "the small set of theme-derived numbers an engine may
 * want for defaults." The design's own worked example gives exact figures
 * (`spacing: { node: 40, rank: 70, edgeLabel: 4 }`, `stroke: {...}`, `arrowSize`)
 * — but `ResolvedTheme` (`packages/theme/src/types.ts`) carries no `metrics`
 * field to derive them *from*, so "theme-derived" describes an aspiration the
 * shipped `ResolvedTheme` type cannot fulfil, not a function this stage could
 * call. `packages/render-svg/test/pipeline.ts`'s `runPipeline` — the one place
 * the whole `source -> RenderResult` pipeline already exists end to end — hits
 * the same gap and resolves it the same way: one constant, matching DD-06 §2's
 * own numbers exactly, independent of `themeId`. Reusing that same constant here
 * (rather than inventing a second one) is a deliberate choice, not an oversight;
 * `packages/theme` is out of this stage's reach (frozen except via `@sgl/core`),
 * so actually wiring per-theme metrics is left as an open gap for whichever stage
 * next touches `ResolvedTheme`.
 */
export const APP_METRICS: ResolvedThemeMetricsView = {
  spacing: { node: 40, rank: 70, edgeLabel: 4 },
  stroke: { node: 1.5, edge: 1.5, container: 1 },
  arrowSize: 8,
};
