/**
 * @sgl/layout-api — the contract between a semantic graph and geometry.
 *
 * The engine boundary (ADR-0002): an engine receives a frozen graph with sizes
 * already measured, and returns pure geometry. It never sees a colour, a font as
 * appearance, or an SVG element.
 */

export * from './contract.js';
export * from './fallbacks.js';
export * from './host.js';
export * from './protocol.js';
export * from './registry.js';
export * from './validate.js';
