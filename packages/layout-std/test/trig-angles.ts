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
];

/** A double's 64 bits, as 16 hex digits (big-endian). */
export function bitsOf(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
