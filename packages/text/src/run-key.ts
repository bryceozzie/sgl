import { fnv1a64 } from '@sgl/core';
import type { BoxConstraints, StyledRun } from './types.js';

/**
 * The cache key and the `MeasureTable` key (DD-05 §2, DD-11 T29).
 *
 * `fnv1a64` over `text ␟ family ␟ size ␟ weight ␟ style ␟ lh ␟ ls` per run, then,
 * **only for a run with marks**, `␟` and the letters `s`, `e`, `c` it carries, in
 * that order; runs joined by ␞, then ␝ and the box's `maxWidth` (or `*`). A plain
 * run's key is therefore exactly what it was before A18.
 *
 * Every side that keys or reads the table computes it here: `premeasure`, the
 * app's label-size join and the test pipelines, through `labelRunKey`. Moved from
 * `@sgl/measure` (T2) so the renderer, which may not import that package, can
 * use the same function.
 */

/** Between the fields of one run. */
const UNIT = '\x1f';
/** Between runs. */
const RECORD = '\x1e';
/** Between the run list and the box constraints. */
const GROUP = '\x1d';

/** No wrapping. Frozen so a caller cannot make one call's constraints differ from
 *  the next's. */
export const UNCONSTRAINED: BoxConstraints = Object.freeze({});

/**
 * The exact string that is hashed. Exported for tests and for debugging a key
 * mismatch, which is otherwise invisible — a wrong key is just a cache miss.
 */
export function canonicalRunKey(runs: readonly StyledRun[], box: BoxConstraints): string {
  const body = runs
    .map((run) => {
      const s = run.style;
      const m = run.marks;
      const marks = m === undefined ? '' : `${m.strong ? 's' : ''}${m.em ? 'e' : ''}${m.code ? 'c' : ''}`;
      return [run.text, s.fontFamily, numeral(s.fontSize), numeral(s.fontWeight), s.fontStyle, numeral(s.lineHeight), numeral(s.letterSpacing)].join(UNIT) + (marks === '' ? '' : UNIT + marks);
    })
    .join(RECORD);

  return `${body}${GROUP}${box.maxWidth === undefined ? '*' : numeral(box.maxWidth)}`;
}

/** The key. 16 lowercase hex digits. */
export function hashRuns(runs: readonly StyledRun[], box: BoxConstraints): string {
  return fnv1a64(canonicalRunKey(runs, box));
}

/** `-0` and `0` are the same width; without this they would key differently. */
function numeral(n: number): string {
  return Object.is(n, -0) ? '0' : String(n);
}
