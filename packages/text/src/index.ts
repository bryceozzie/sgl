/**
 * @sgl/text — text runs and their faces, the measure-table key, and the line
 * models (DD-11 T2, T3).
 *
 * `core, theme ← text ← measure, render-svg`. This entry is on the app's boot path;
 * the word breaker, `layoutWrapped`, is the separate `@sgl/text/wrap` entry, which
 * the app loads lazily (T53).
 */

export * from './faces.js';
export * from './label.js';
export { glyphCount, layoutLines } from './line-model.js';
export * from './run-key.js';
export * from './types.js';
