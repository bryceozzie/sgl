/**
 * @sgl/layout-std — the in-house engines.
 *
 * `grid` (MVP) and `fixed` (B5 branch 2, DD-12 §4). ⟶ B5: `tree` and `radial`
 * (DD-12 §8, §9); `force` is cut from v1.0 (DD-12 H3). The in-house `layered`
 * Sugiyama engine is roadmap, not v1 (ADR-0005).
 */

export * from './descriptor.js';
export * from './fixed.js';
export * from './grid.js';
export * from './pack.js';
export * from './ports.js';
