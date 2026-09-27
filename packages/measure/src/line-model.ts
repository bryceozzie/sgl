/**
 * The line models moved to `@sgl/text` (DD-11 §7): `layoutLines` (hard breaks only,
 * the default of every measurer here) and, in the lazy `@sgl/text/wrap` entry,
 * `layoutWrapped`, which a measurer takes as its `lineModel` option. Re-exported
 * here for callers of the MVP's names.
 */
export { glyphCount, layoutLines } from '@sgl/text';
