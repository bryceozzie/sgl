/**
 * @sgl/theme — the style-property registry, theme resolution and the cascade.
 *
 * Owns the geometry/paint split: every property declares which half it belongs to,
 * and every element gets one hash per half. Knows nothing about layout coordinates.
 */

export * from './cascade.js';
export * from './registry.js';
export * from './types.js';
export * from './themes/index.js';
