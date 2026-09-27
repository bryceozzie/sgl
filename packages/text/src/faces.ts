import type { RunMarks, TextStyle } from './types.js';

/**
 * Run faces (DD-11 T25–T27). Constants of this package in v1.0, not theme tokens:
 * the run classes stay theme-invariant by construction, and no registry row,
 * cascade step or `geometryHash` input is added (T27). A future `font.mono` token
 * would have to enter `geometryHash`, because it changes measurement.
 *
 * The font *files* (Inter 700, Inter italics, IBM Plex Mono 400/700, T26) are the
 * render branch's. Measurement needs only these names: `CanvasMeasurer` measures
 * each face through the `ctx.font` shorthand, and `StaticMetricsMeasurer`
 * classifies `IBM Plex Mono` as `mono` (0.6 em, which Plex's 600-unit advance
 * matches) and applies its bold scalar at 700 (T30).
 */

/** T26: IBM Plex Mono first, then the platforms' own monospace faces. */
export const CODE_FONT_FAMILY = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** T25: `strong` is weight 700 whatever the label's base weight. */
export const STRONG_WEIGHT = 700;

/**
 * A run's face: its label's style with at most three changes (T25).
 *
 * - `strong` → weight 700.
 * - `em` → italic.
 * - `code` → the code family, upright, weight 400, or 700 when also `strong`.
 *
 * `fontSize`, `lineHeight` and `letterSpacing` never change, so every run of a label
 * has one line height (T31). A plain run gets `base` itself back.
 */
export function runStyle(base: TextStyle, marks: RunMarks): TextStyle {
  if (marks.code) return { ...base, fontFamily: CODE_FONT_FAMILY, fontWeight: marks.strong ? STRONG_WEIGHT : 400, fontStyle: 'normal' };
  if (!marks.strong && !marks.em) return base;
  return { ...base, ...(marks.strong && { fontWeight: STRONG_WEIGHT }), ...(marks.em && { fontStyle: 'italic' as const }) };
}
