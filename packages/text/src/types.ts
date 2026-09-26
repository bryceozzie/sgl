/**
 * The measurement types (DD-05 §2), moved here from `@sgl/measure` by DD-11 T2/T23 so
 * that `premeasure` and, from the render branch on, `render()` can compute the same
 * table key from one package both may import. `@sgl/measure` re-exports every one.
 *
 * T23's only change is the optional `marks`: a strong run whose weight equals its
 * label's base weight has the same `TextStyle` as a plain run, so the renderer needs
 * the marks themselves to tell them apart.
 */

export interface TextStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic';
  /** Multiplier. */
  readonly lineHeight: number;
  readonly letterSpacing: number;
}

/** A run's inline marks (DD-11 T21): the flags of `@sgl/core`'s `TextRun`. A flag
 *  is `true` or absent, never `false`. */
export interface RunMarks {
  readonly strong?: true;
  readonly em?: true;
  readonly code?: true;
}

export interface StyledRun {
  /** May contain `\n`, a hard break (T21). */
  readonly text: string;
  /** Already the run's own face (T25, `runStyle`). */
  readonly style: TextStyle;
  /** Absent on a plain run. */
  readonly marks?: RunMarks;
}

/** `undefined` = unconstrained: nothing wraps (DD-11 T35). `maxWidth` is the
 *  *label's* width, not the node's (`labelBox`). */
export interface BoxConstraints {
  readonly maxWidth?: number;
  /** Break only at spaces: a word wider than `maxWidth` overflows rather than
   *  being split (human decision H1: a fixed `@size.width` without `maxWidth`). */
  readonly keepWords?: true;
  /** A hexagon's title (fix round 1, item 3): `maxWidth` is the width inside the
   *  padding, `A`, and a label `L` wide and `H` tall must keep `L + min(L, H) ≤ A`,
   *  the hexagon's side insets being `min(L, H)/2` each. The breaker narrows its
   *  line width until that holds. */
  readonly hexagon?: true;
}

export interface LaidRun {
  readonly x: number;
  readonly text: string;
  readonly style: TextStyle;
  readonly marks?: RunMarks;
}

export interface TextLine {
  /** Baseline offset from the top of the block. */
  readonly y: number;
  readonly width: number;
  readonly runs: readonly LaidRun[];
}

export interface TextLayout {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly TextLine[];
  /** The label's largest measured ascent: every line's baseline is this far below
   *  the top of its line box (DD-11 T31). */
  readonly ascent: number;
}

/** What a measurer has to supply per run; everything else is arithmetic. */
export interface RunMetrics {
  /** Advance width of the text, excluding letter spacing. */
  readonly width: number;
  /** Distance from the top of the line box to the baseline. */
  readonly ascent: number;
}

export type MeasureRun = (text: string, style: TextStyle) => RunMetrics;

/** A line model (DD-11 §7): `layoutLines` (hard breaks only, on the boot path) or
 *  `layoutWrapped` (`@sgl/text/wrap`, lazy). */
export type LineModel = (measureRun: MeasureRun, runs: readonly StyledRun[], box: BoxConstraints) => TextLayout;
