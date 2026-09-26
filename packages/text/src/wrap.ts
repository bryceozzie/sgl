import { hardLines, layLine, layoutLines, stack, type Fragment } from './line-model.js';
import type { LineModel, MeasureRun, RunMetrics, TextStyle } from './types.js';

/**
 * `layoutWrapped` (DD-11 §7, T32–T38): `@sgl/text/wrap`, the lazy half of the
 * package (T3, T53). With `box.maxWidth` undefined it is `layoutLines`, exactly.
 * With one, each hard line is broken greedily:
 *
 * - **Break opportunities** are runs of U+0020 or U+0009, and U+200B. U+00A0 is
 *   not one (T33).
 * - A **word** is the text between two opportunities, and may span runs, keeping
 *   their boundaries.
 * - A word joins the current line when the line with it still fits
 *   (`width ≤ maxWidth`); otherwise the line ends and the word starts the next.
 * - Whitespace at a **soft break** is dropped, from the end of one line and the
 *   start of the next. Whitespace at the **start or end of a hard line** is kept
 *   and measured: it travels with the first or last word.
 * - A word too wide for a line of its own is split at the last unit boundary that
 *   fits, repeatedly, and a line always gets at least one unit (T37, `breakUnits`).
 *   No hyphen, no UAX #14, no `Intl.Segmenter` (its rules follow each engine's ICU,
 *   so they are not deterministic across environments).
 *
 * Line widths and `x`s come from `layLine`, the same arithmetic `layoutLines` uses,
 * so a label that fits on its lines is laid out exactly as it is unwrapped. The
 * measurer is memoised per call, so each fit test measures only the fragment that
 * grew.
 */

const BREAK = /[ \t\u200b]/;

/**
 * A code point a split may not land before (T37): combining marks, variation
 * selectors, emoji modifiers, and ZWJ, which also glues the code point after it.
 */
const EXTEND: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f], // combining marks
  [0xfe00, 0xfe0f], [0xe0100, 0xe01ef], // variation selectors
  [0x1f3fb, 0x1f3ff], // emoji modifiers
  [0x200d, 0x200d], // ZWJ
];
const extends_ = (cp: number): boolean => EXTEND.some(([from, to]) => cp >= from && cp <= to);

const isRegionalIndicator = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;

/**
 * The units a split may not enter (T37): code points, never split inside a
 * surrogate pair, before an `EXTEND` code point, after a ZWJ, or between the two
 * halves of a regional-indicator pair. Exported for tests.
 */
export function breakUnits(text: string): string[] {
  const units: string[] = [];
  let afterZwj = false;
  let openFlag = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const ri = isRegionalIndicator(cp);
    if (units.length > 0 && (extends_(cp) || afterZwj || (ri && openFlag))) {
      units[units.length - 1] += ch;
      openFlag = false;
    } else {
      units.push(ch);
      openFlag = ri;
    }
    afterZwj = ch === '\u200d';
  }
  return units;
}

/** Text from one fragment of the hard line. */
interface Piece {
  readonly f: number;
  readonly text: string;
}

export const layoutWrapped: LineModel = (measureRun, runs, box) => {
  const maxWidth = box.maxWidth;
  if (maxWidth === undefined) return layoutLines(measureRun, runs, box);
  const measure = memoise(measureRun);
  const laid: ReturnType<typeof layLine>[] = [];
  for (const fragments of hardLines(runs)) {
    const lineOf = (pieces: readonly Piece[]): Fragment[] => {
      const out: Fragment[] = [];
      let last = -1;
      for (const p of pieces) {
        const f = fragments[p.f] as Fragment;
        if (p.f === last) {
          const prev = out[out.length - 1] as Fragment;
          out[out.length - 1] = { ...prev, text: prev.text + p.text };
        } else out.push(f.marks === undefined ? { text: p.text, style: f.style } : { text: p.text, style: f.style, marks: f.marks });
        last = p.f;
      }
      return out;
    };
    const width = (pieces: readonly Piece[]): number => layLine(measure, lineOf(pieces)).width;
    const emit = (pieces: readonly Piece[]): void => void laid.push(layLine(measure, lineOf(pieces)));

    if (fragments.length === 1 && fragments[0]!.text === '') {
      laid.push(layLine(measure, fragments));
      continue;
    }

    // Words and the separators between them. Leading and trailing whitespace is
    // glued to the first and last word, so it is kept and measured (T33).
    const words: Piece[][] = [];
    const seps: Piece[][] = [];
    let current: Piece[] = [];
    let inBreak: boolean | undefined;
    fragments.forEach((frag, f) => {
      for (const part of frag.text.split(/([ \t\u200b]+)/)) {
        if (part === '') continue;
        const brk = BREAK.test(part);
        if (inBreak !== undefined && brk !== inBreak) {
          (inBreak ? seps : words).push(current);
          current = [];
        }
        current.push({ f, text: part });
        inBreak = brk;
      }
    });
    (inBreak ? seps : words).push(current);
    if (words.length === 0) words.push(seps.pop() as Piece[]);
    else {
      const leading = /^[ \t\u200b]/.test(fragments[0]!.text);
      if (leading) words[0] = [...(seps.shift() as Piece[]), ...(words[0] as Piece[])];
      if (seps.length === words.length) words[words.length - 1] = [...(words[words.length - 1] as Piece[]), ...(seps.pop() as Piece[])];
    }

    let line: Piece[] = [];
    words.forEach((word, i) => {
      if (line.length > 0) {
        const candidate = [...line, ...(seps[i - 1] as Piece[]), ...word];
        if (width(candidate) <= maxWidth) {
          line = candidate;
          return;
        }
        emit(line);
      }
      if (width(word) <= maxWidth) {
        line = word;
        return;
      }
      // Too wide for a line of its own: split at unit boundaries (T37).
      line = [];
      for (const unit of unitsOf(word)) {
        const candidate = [...line, ...unit];
        if (line.length > 0 && width(candidate) > maxWidth) {
          emit(line);
          line = unit;
        } else line = candidate;
      }
    });
    emit(line);
  }
  return stack(laid, runs[0]?.style);
};

/** A word's `breakUnits`, each as the pieces it takes from the word's fragments. */
function unitsOf(word: readonly Piece[]): Piece[][] {
  const owner: number[] = [];
  for (const p of word) for (let i = 0; i < p.text.length; i += 1) owner.push(p.f);
  const units: Piece[][] = [];
  let at = 0;
  for (const unit of breakUnits(word.map((p) => p.text).join(''))) {
    const pieces: Piece[] = [];
    for (let i = 0; i < unit.length; i += 1) {
      const f = owner[at + i] as number;
      const last = pieces[pieces.length - 1];
      if (last !== undefined && last.f === f) pieces[pieces.length - 1] = { f, text: last.text + unit[i] };
      else pieces.push({ f, text: unit[i] as string });
    }
    at += unit.length;
    units.push(pieces);
  }
  return units;
}

/** One measurement per distinct text and face within a call. */
function memoise(measureRun: MeasureRun): MeasureRun {
  const byStyle = new Map<TextStyle, Map<string, RunMetrics>>();
  return (text, style) => {
    let m = byStyle.get(style);
    if (m === undefined) byStyle.set(style, (m = new Map()));
    let hit = m.get(text);
    if (hit === undefined) m.set(text, (hit = measureRun(text, style)));
    return hit;
  };
}
