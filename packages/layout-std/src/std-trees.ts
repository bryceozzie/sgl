/**
 * The lazy `std-trees` chunk (DD-12 N52, H9): the layout code of `tree` and
 * `radial` (with `radial`'s own trigonometry, `trig.ts`) and the spanning
 * forest they share. Only
 * `lazy.ts`'s dynamic `import()` reaches this module, so a bundler emits it
 * as its own chunk, loaded by the layout worker on the first request for one
 * of these engines, and never part of the boot path
 * (`apps/web/scripts/check-core-chunks.mjs` checks).
 */

export { layoutRadial } from './radial.js';
export { layoutTree } from './tree.js';
