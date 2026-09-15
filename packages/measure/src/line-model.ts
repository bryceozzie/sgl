import type { BoxConstraints, StyledRun, TextLayout, TextStyle } from './types.js';

/**
 * The MVP line model (DD-05 §3), shared by every `Measurer`.
 *
 * A `LabelSpec.runs` array is one run per line (DD-03 splits on `\n`), so each run
 * is one line: no wrapping, no mixed styles on a line. `BoxConstraints.maxWidth` is
 * undefined on every MVP call and is ignored here.
 *
 * ⟶ v1.0 (A18): this becomes a greedy word breaker over runs that honours
 * `maxWidth`. `TextLayout` does not change, so nothing above it does either.
 */

/** What a measurer has to supply per run; everything else is arithmetic. */
export interface RunMetrics {
  /** Advance width of the text, excluding letter spacing. */
  readonly width: number;
  /** Distance from the top of the line box to the baseline. */
  readonly ascent: number;
}

export type MeasureRun = (text: string, style: TextStyle) => RunMetrics;

/**
 * Count code points, not UTF-16 code units.
 *
 * This is the `len` in DD-05 §3's letter-spacing term. Using `String.length` would
 * charge two gaps for one astral character, so `"🚀🚀"` would come out wider than
 * `"ab"` at the same spacing — visible in the corpus, which has emoji node names.
 */
export function glyphCount(text: string): number {
  // Spreading a string iterates code points, not code units.
  return [...text].length;
}

/**
 * DD-05 §3, with one deliberate generalisation.
 *
 * The document writes `y_i = ascent_i + i * lineHeightPx` and `height = n *
 * lineHeightPx`, which assume every line shares one `lineHeight`. That holds for
 * every MVP label — `premeasure` builds all runs of a label from one
 * `ComputedStyle` — but it is not expressible once runs carry their own styles.
 * Accumulating each line's own advance reduces to the document's formula exactly
 * when the styles are uniform, and stays correct when they are not.
 */
export function layoutLines(
  measureRun: MeasureRun,
  runs: readonly StyledRun[],
  box: BoxConstraints,
): TextLayout {
  void box.maxWidth; // MVP: unconstrained. ⟶ v1.0 (A18).

  const lines: {
    y: number;
    width: number;
    runs: readonly { readonly x: number; readonly text: string; readonly style: TextStyle }[];
  }[] = [];

  let width = 0;
  let advanceY = 0;
  let ascent = 0;

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run === undefined) continue;

    const metrics = measureRun(run.text, run.style);
    const gaps = Math.max(0, glyphCount(run.text) - 1);
    const lineWidth = metrics.width + run.style.letterSpacing * gaps;

    lines.push({
      y: advanceY + metrics.ascent,
      width: lineWidth,
      runs: [{ x: 0, text: run.text, style: run.style }],
    });

    if (i === 0) ascent = metrics.ascent;
    if (lineWidth > width) width = lineWidth;
    advanceY += run.style.fontSize * run.style.lineHeight;
  }

  return { width, height: advanceY, lines, ascent };
}
