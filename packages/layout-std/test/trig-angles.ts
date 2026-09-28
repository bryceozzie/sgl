/**
 * The angles, in turns, whose `sinTurn`/`cosTurn` bits are pinned in
 * `__goldens__/trig.txt` (DD-12 N44): every 1/64 turn, a few thirds and
 * tenths (not binary fractions), tiny and large turns, and the wedge-middle
 * angles `radial` computes for small fan-outs. Shared by `trig.test.ts`
 * (Node) and `trig.browser.test.ts` (Chromium), which read one golden.
 */
export const TRIG_ANGLES: readonly number[] = [
  ...Array.from({ length: 65 }, (_, i) => i / 64),
  1 / 3,
  2 / 3,
  0.1,
  0.2,
  0.3,
  0.7,
  0.9,
  1 / 6,
  1 / 12,
  1 / 7,
  3 / 14,
  1e-9,
  1e-5,
  0.123456789,
  0.987654321,
  -0.3,
  -1.1,
  2.3,
  17.05,
  1000.2,
  // Fix round 1, item 4: the negative eighth turns; the doubles either side
  // of each eighth turn in [-1, 1]; large turns, to 2^52 and past it.
  ...Array.from({ length: 8 }, (_, k) => -(k + 1) / 8),
  ...Array.from({ length: 17 }, (_, k) => (k - 8) / 8).flatMap((e) => [nextDown(e), nextUp(e)]),
  1e6,
  1e6 + 0.1,
  1e6 + 0.125,
  1e9 + 0.3,
  2 ** 40 + 0.375,
  2 ** 52 - 0.5,
  2 ** 52 - 0.25,
  2 ** 52,
  2 ** 52 + 1,
  2 ** 53,
  -(2 ** 52 + 1),
];

/** The next double above `x` (below, for `nextDown`). */
export function nextUp(x: number): number {
  if (x === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, x > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

export function nextDown(x: number): number {
  return 0 - nextUp(0 - x);
}

/** A double's 64 bits, as 16 hex digits (big-endian). */
export function bitsOf(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
