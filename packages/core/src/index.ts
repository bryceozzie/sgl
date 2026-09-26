/**
 * @sgl/core — the contract every other package obeys.
 *
 * Zero DOM. No workspace dependencies. Runs identically in the browser, in Node
 * and in a Worker (NFR-2), which is what the DD-09 Node test run verifies.
 */

export * from './ast.js';
export * from './build-ast.js';
export * from './compile.js';
export * from './diagnostics.js';
export * from './geometry.js';
export * from './graph.js';
export * from './hash.js';
export * from './ids.js';
export { LAYOUT_CATALOGUE, layoutDiagnostic, type LayoutDiagnosticCode } from './layout-diagnostics.js';
export * from './model.js';
export * from './not-implemented.js';
export * from './parse.js';
export { hasImports, resolve, type ImportSeam, type ResolveResult } from './resolve.js';
export * from './shape-insets.js';
export * from './span.js';
export { SIZE_KEYS } from './config-registry.js';

/** The language version this build implements. Independent of package versions (NFR-6). */
export const SGL_LANGUAGE_VERSION = '1.0' as const;
