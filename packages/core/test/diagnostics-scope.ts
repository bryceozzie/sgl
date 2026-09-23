import { CATALOGUE, type DiagnosticCode } from '../src/diagnostics.js';

/**
 * Which half of the diagnostics-coverage gate (DD-09 §3.4) owns a code.
 *
 * `@sgl/core` imports nothing from the workspace (DD-00 §2 rule 1), so
 * `packages/core/test/diagnostics-coverage.test.ts` cannot itself run a
 * document through `@sgl/theme` or `@sgl/render-svg` to check whether `5xxx`
 * (theme) or `SGL6001` (the renderer's one code) is corpus-reachable — that is
 * `packages/render-svg/test/diagnostics-coverage.test.ts`'s job instead, via
 * the whole pipeline. Every other code is core's, checked via
 * `parse -> resolve -> compile` alone.
 *
 * Defined once, here, so the two gates are a partition of `CATALOGUE` by
 * construction rather than two independently hand-maintained lists that can
 * drift apart — a future `SGL6002` or `SGL5007` would otherwise silently fall
 * through neither gate, or both (the same failure mode Fix 3, execution plan
 * §2, fixed for `CLEAN_DOCS`). `packages/core/test/diagnostics-coverage.test.ts`
 * asserts this is actually a partition; `render-svg`'s gate imports
 * `RENDER_SVG_OWNED_CODES` directly rather than re-deriving the predicate.
 */
export function isRenderSvgOwned(code: DiagnosticCode): boolean {
  return code.startsWith('SGL5') || code === 'SGL6001';
}

export const ALL_DIAGNOSTIC_CODES: readonly DiagnosticCode[] = Object.keys(CATALOGUE) as DiagnosticCode[];
export const CORE_OWNED_CODES: readonly DiagnosticCode[] = ALL_DIAGNOSTIC_CODES.filter((c) => !isRenderSvgOwned(c));
export const RENDER_SVG_OWNED_CODES: readonly DiagnosticCode[] = ALL_DIAGNOSTIC_CODES.filter(isRenderSvgOwned);
