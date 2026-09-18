/**
 * Coordinate formatting.
 *
 * Every emitted number goes through `num`. Two logically identical renders must be
 * byte-identical (DD-00 §3, and the renderer's exit criterion in DD-00 §6), and
 * without a fixed quantum `0.1 + 0.2` and `0.30000000000000004` are the same
 * diagram and different files. Three decimals is far below a device pixel at any
 * sane zoom and still leaves rounded-corner arcs smooth.
 */

export const DECIMALS = 3;
const SCALE = 10 ** DECIMALS;

/** Round to `DECIMALS` places, drop trailing zeros, and normalise `-0` to `0`. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * SCALE) / SCALE;
  // `Object.is(-0, 0)` is false, and `(-0).toString()` is `'0'` in every engine —
  // but `Math.round(-0.0001 * 1000) / 1000` is `-0`, so normalise explicitly
  // rather than rely on it.
  return (rounded === 0 ? 0 : rounded).toString();
}

/** A run of numbers, space separated — path data and transform arguments. */
export function nums(...values: readonly number[]): string {
  return values.map(num).join(' ');
}
