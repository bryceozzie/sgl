/**
 * @sgl/measure — deterministic text measurement.
 *
 * Everything upstream of layout depends on label sizes, so this is the stage that
 * decides whether two environments can produce byte-identical SVG (ADR-0003).
 */

export * from './canvas-measurer.js';
export * from './default-measurer.js';
export * from './line-model.js';
export * from './premeasure.js';
export * from './run-key.js';
export * from './static-measurer.js';
export * from './table-measurer.js';
export * from './types.js';
