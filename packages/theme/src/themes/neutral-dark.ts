import type { ThemeDoc } from '../types.js';

/**
 * Overrides tokens only (DD-04 §7). Because nothing geometric changes, its
 * `geometryHash` for any document equals `neutral-light`'s — the property MVP
 * acceptance criterion 2 tests, and the reason a light/dark toggle lands in one
 * frame rather than reflowing the diagram.
 */
export const neutralDark: ThemeDoc = {
  id: 'neutral-dark',
  name: 'Neutral Dark',
  schemaVersion: 1,
  extends: 'neutral-light',

  tokens: {
    'bg': '#0E131C',
    'surface': '#171E2B',
    'surface.sunken': '#10161F',
    'ink': '#E4E9F1',
    'ink.muted': '#A6B1C2',
    'line': '#4A5768',
    'accent': '#62A8CA',
    'danger': '#E4737E',
  },

  rules: {},
  byShape: {},
  byClass: {},
  canvas: { background: '@bg' },
};
