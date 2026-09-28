/**
 * @sgl/layout-std — the in-house engines.
 *
 * `grid` (MVP), `fixed` (B5 branch 2, DD-12 §4) and `tree` (B5 branch 4,
 * DD-12 §8: `treeEngine` loads its layout code, the `std-trees` chunk, on
 * first use; that chunk is not re-exported here, so it stays lazy). ⟶ B5:
 * `radial` (DD-12 §9); `force` is cut from v1.0 (DD-12 H3). The in-house `layered`
 * Sugiyama engine is roadmap, not v1 (ADR-0005).
 */

export * from './descriptor.js';
export * from './fixed.js';
export * from './grid.js';
export * from './lazy.js';
export * from './pack.js';
export * from './ports.js';
