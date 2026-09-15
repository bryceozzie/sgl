/**
 * @sgl/layout-std — the in-house engines.
 *
 * MVP ships `grid`. ⟶ v1.0 (B5): `fixed` (first, about a day), `tree`, `radial`,
 * `force` (last — hardest to make deterministic, and the first thing to cut if the
 * schedule bites). The in-house `layered` Sugiyama engine is roadmap, not v1
 * (ADR-0005).
 */

export * from './grid.js';
