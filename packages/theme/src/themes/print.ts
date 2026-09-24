import type { ThemeDoc } from '../types.js';

/**
 * C5 (DD-04 §7): for paper and for monochrome output. Every `fill` white,
 * every `stroke` black, every text black, `shadow` off. `neutral-light`'s
 * metrics, so a switch is paint only (F9). Its tokens are white and black,
 * and `force` (DD-04 §4 step 7, paint properties only) carries the same
 * values over the document's own classes and inline `@style`, which a token
 * cannot reach: a colour-coded class loses its colour by design. Dashes, the
 * arrowhead kind and stroke widths stay, so they are what distinguishes
 * elements on paper.
 */
export const print: ThemeDoc = {
  id: 'print',
  name: 'Print',
  schemaVersion: 1,
  extends: 'neutral-light',

  tokens: {
    'bg': '#FFFFFF',
    'surface': '#FFFFFF',
    'surface.sunken': '#FFFFFF',
    'ink': '#000000',
    'ink.muted': '#000000',
    'line': '#000000',
    'accent': '#000000',
    'danger': '#000000',
  },

  rules: {},
  byShape: {},
  byClass: {},
  canvas: { background: '@bg' },
  force: { fill: '@bg', labelPlate: '@bg', stroke: '@ink', color: '@ink', shadow: 'none' },
};
