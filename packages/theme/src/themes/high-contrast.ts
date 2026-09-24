import type { ThemeDoc } from '../types.js';

/**
 * C5 (DD-04 §7): black on white, tokens only, so its `geometryHash` for any
 * document equals `neutral-light`'s and a switch is paint only (F9).
 *
 * Every text colour clears WCAG 2.2 AAA (≥ 7:1) on every surface a text can
 * sit on (`bg`, `surface`, `surface.sunken`), and every stroke clears 3:1
 * against them: `ink` and `line` are pure black (21:1 on white), `ink.muted`
 * is a dark grey that is still AAA on the container grey, and the two
 * accents are a deep blue and a deep red dark enough to pass as *text*, not
 * only as strokes, so a class that colours a label with them stays legible.
 * Containers keep a light grey fill so nesting reads without relying on the
 * 1 px outline alone. `packages/render-svg/test/themes-c5.test.ts` checks
 * every pair the rendered corpus actually paints.
 */
export const highContrast: ThemeDoc = {
  id: 'high-contrast',
  name: 'High Contrast',
  schemaVersion: 1,
  extends: 'neutral-light',

  tokens: {
    'bg': '#FFFFFF',
    'surface': '#FFFFFF',
    'surface.sunken': '#EBEBEB',
    'ink': '#000000',
    'ink.muted': '#2E2E2E',
    'line': '#000000',
    'accent': '#0033B8',
    'danger': '#990000',
  },

  rules: {},
  byShape: {},
  byClass: {},
  canvas: { background: '@bg' },
};
