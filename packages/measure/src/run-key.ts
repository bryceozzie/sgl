import { fnv1a64 } from '@sgl/core';
import type { BoxConstraints, StyledRun } from './types.js';

/**
 * The cache key and the `MeasureTable` key (DD-05 §2).
 *
 * `fnv1a64` over `text ␟ family ␟ size ␟ weight ␟ style ␟ lh ␟ ls` per run, runs
 * joined by ␞, then the box constraints.
 *
 * Both sides of the worker boundary compute this: the host keys the pre-measure
 * table with it, and `TableMeasurer` inside the worker looks entries up with it.
 * They must be the same function, which is why it lives here and is exported
 * rather than being inlined into `premeasure`.
 */

/** Between the fields of one run. */
const UNIT = '';
/** Between runs. */
const RECORD = '';
/** Between the run list and the box constraints. DD-05 §2 says "plus maxWidth"
 *  without naming a separator; the group separator is the natural next one up. */
const GROUP = '';

/** MVP calls are always unconstrained (DD-05 §3). Frozen so a caller cannot
 *  accidentally make one call's constraints differ from the next's. */
export const UNCONSTRAINED: BoxConstraints = Object.freeze({});

/**
 * The exact string that is hashed. Exported for tests and for debugging a key
 * mismatch, which is otherwise invisible — a wrong key is just a cache miss.
 */
export function canonicalRunKey(runs: readonly StyledRun[], box: BoxConstraints): string {
  const body = runs
    .map((run) => {
      const s = run.style;
      return [
        run.text,
        s.fontFamily,
        numeral(s.fontSize),
        numeral(s.fontWeight),
        s.fontStyle,
        numeral(s.lineHeight),
        numeral(s.letterSpacing),
      ].join(UNIT);
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
