import type { BoxConstraints, LaidRun, MeasureRun, StyledRun, TextLayout, TextLine, TextStyle } from './types.js';

/**
 * `layoutLines` (DD-11 §7): the line model on the boot path. Hard breaks only.
 *
 * It splits the runs at `\n` into hard lines. Each hard line is a list of
 * fragments, one per piece of a run on that line. Runs in the canonical form
 * (DD-11 T21) are maximal, so a fragment is the maximal text on its line with one
 * style and one set of marks.
 *
 * For a plain label (one run, one style) every number is the MVP line model's, to
 * the bit: a one-fragment line is measured whole, exactly as before (T32), and the
 * baselines accumulate the same sums (T31). `line-model.test.ts` checks that over
 * every corpus label.
 */

/** Count code points, not UTF-16 code units: the `len` in DD-05 §3's
 *  letter-spacing term. `String.length` would charge two gaps for one astral
 *  character, so `"🚀🚀"` would come out wider than `"ab"` at the same spacing. */
export function glyphCount(text: string): number {
  return [...text].length;
}

/** One piece of a run on one line. */
export type Fragment = StyledRun;

/**
 * The runs split at `\n`: one fragment list per hard line (T34: empty lines are
 * kept, and a trailing `\n` gives an empty last line). An empty line holds one
 * empty fragment in the style of the run whose `\n` made it, so that it is
 * measured (for its ascent) exactly as the MVP's one-run-per-line model measured
 * an empty line. No runs, no lines.
 */
export function hardLines(runs: readonly StyledRun[]): Fragment[][] {
  const lines: Fragment[][] = [];
  let line: Fragment[] | undefined;
  let lineStyle: TextStyle | undefined;
  const close = (): void => {
    if (line !== undefined) lines.push(line.length === 0 && lineStyle !== undefined ? [{ text: '', style: lineStyle }] : line);
  };
  for (const run of runs) {
    run.text.split('\n').forEach((text, i) => {
      if (i > 0 || line === undefined) {
        close();
        line = [];
        lineStyle = run.style;
      }
      if (text !== '') line.push({ text, style: run.style, ...(run.marks && { marks: run.marks }) });
    });
  }
  close();
  return lines;
}

/**
 * Lay one line's fragments side by side (T32): the width is the sum of the
 * fragments' own widths, each measured whole, plus `letterSpacing × (glyphs − 1)`;
 * each fragment's `x` is the running sum. Returns the line without its `y`, and
 * the largest ascent it measured.
 */
export function layLine(measureRun: MeasureRun, fragments: readonly Fragment[]): { readonly width: number; readonly runs: LaidRun[]; readonly ascent: number } {
  const ls = fragments[0]?.style.letterSpacing ?? 0;
  const runs: LaidRun[] = [];
  let sum = 0;
  let glyphs = 0;
  let ascent = 0;
  for (const f of fragments) {
    const m = measureRun(f.text, f.style);
    runs.push({ x: sum + ls * glyphs, text: f.text, style: f.style, ...(f.marks && { marks: f.marks }) });
    sum += m.width;
    glyphs += glyphCount(f.text);
    if (m.ascent > ascent) ascent = m.ascent;
  }
  return { width: sum + ls * Math.max(0, glyphs - 1), runs, ascent };
}

/**
 * Stack laid lines (T31): one line height for the label, `fontSize × lineHeight`
 * of its first run, and every baseline `A` below its line box's top, where `A` is
 * the largest ascent measured on any line. The sums accumulate line by line, as
 * the MVP's did, so a plain label's `y`s and height are bit-identical.
 */
export function stack(lines: readonly { readonly width: number; readonly runs: LaidRun[]; readonly ascent: number }[], style: TextStyle | undefined): TextLayout {
  let ascent = 0;
  for (const l of lines) if (l.ascent > ascent) ascent = l.ascent;
  const lineHeightPx = style === undefined ? 0 : style.fontSize * style.lineHeight;
  const out: TextLine[] = [];
  let width = 0;
  let advanceY = 0;
  for (const l of lines) {
    out.push({ y: advanceY + ascent, width: l.width, runs: l.runs });
    if (l.width > width) width = l.width;
    advanceY += lineHeightPx;
  }
  return { width, height: advanceY, lines: out, ascent };
}

/**
 * Hard breaks only. **Throws** when handed a defined `maxWidth`: a caller that
 * keys a table entry for a wrapped label must have loaded `layoutWrapped`
 * (`@sgl/text/wrap`, T53), and a forgotten gate should fail loudly rather than
 * store an unwrapped layout under a wrapped key (DD-11 §7).
 */
export function layoutLines(measureRun: MeasureRun, runs: readonly StyledRun[], box: BoxConstraints): TextLayout {
  if (box.maxWidth !== undefined) throw new Error('layoutLines cannot wrap: load layoutWrapped from @sgl/text/wrap (DD-11 T53).');
  return stack(
    hardLines(runs).map((line) => layLine(measureRun, line)),
    runs[0]?.style,
  );
}
