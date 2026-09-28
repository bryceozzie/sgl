/**
 * `radial`'s own trigonometry (DD-12 N44, H8; ADR-0004, amended 2026-09-27),
 * in the lazy `std-trees` chunk. ECMAScript leaves `Math.sin` and `Math.cos`
 * implementation-approximated, so V8, SpiderMonkey and JavaScriptCore can
 * differ in the last bits; `+ - * /` and `Math.round` are specified exactly,
 * and JavaScript never fuses a multiply-add. So these two use nothing else,
 * and give the same bits everywhere, which is what lets `radial` be
 * `bitwise`.
 *
 * Angles are in **turns** (1 = a full circle), so the quadrant reduction is
 * exact: `q = round(4t)` and `t − q/4` lose nothing for the turns a layout
 * uses (a quarter turn is a binary fraction). What is left, `|f| ≤ 1/8`
 * turn (π/4), is scaled to radians once and fed to a Taylor polynomial
 * evaluated by Horner's rule: to x¹⁵ for sine, x¹⁶ for cosine, whose
 * truncation error on |x| ≤ π/4 is below 5e-17 and 2e-18. The measured
 * error against `Math.sin`/`Math.cos` is a few units in the last place
 * (`trig.test.ts`), and the quarter turns are exact.
 *
 * *DD-12 N44 said "degree 13". A degree-13 Taylor polynomial is off by up
 * to 2e-14 at π/4, over §12's 1e-14; a minimax fit of degree 13 would do,
 * but its coefficients would need a fitting tool to check, and Taylor's are
 * `1/n!`. Two more terms cost a few bytes.*
 */

/** 2π, to the nearest double. */
const TAU = 6.283185307179586;

/** sin x for |x| ≤ π/4: x + x·z·(−1/3! + z·(1/5! − …)), z = x². */
function sinPoly(x: number): number {
  const z = x * x;
  return (
    x +
    x *
      z *
      (-1 / 6 +
        z * (1 / 120 + z * (-1 / 5040 + z * (1 / 362880 + z * (-1 / 39916800 + z * (1 / 6227020800 + z * (-1 / 1307674368000)))))))
  );
}

/** cos x for |x| ≤ π/4: 1 + z·(−1/2! + z·(1/4! − …)), z = x². */
function cosPoly(x: number): number {
  const z = x * x;
  return (
    1 +
    z *
      (-1 / 2 +
        z *
          (1 / 24 +
            z * (-1 / 720 + z * (1 / 40320 + z * (-1 / 3628800 + z * (1 / 479001600 + z * (-1 / 87178291200 + z * (1 / 20922789888000))))))))
  );
}

/** `[quadrant 0–3, the rest in radians]` for `t ≥ 0` turns. Only a
 *  non-negative turn is reduced (fix round 1, item 3): `Math.round` rounds a
 *  tie up, so round(4t) at an eighth turn would pick a different quadrant
 *  for `t` and `−t`, and `sinTurn(−t)` would differ from `−sinTurn(t)` in
 *  the last bit. The callers reduce `|t|` and reapply the sign. */
function reduce(t: number): [number, number] {
  const q = Math.round(4 * t);
  return [q % 4, (t - q / 4) * TAU];
}

/** sin 2πt, the same bits on every engine; odd bit for bit. `0 - v` rather
 *  than `-v`, so a half turn is `0`, not `-0`. */
export function sinTurn(t: number): number {
  const [q, x] = reduce(Math.abs(t));
  const s = q === 0 ? sinPoly(x) : q === 1 ? cosPoly(x) : q === 2 ? 0 - sinPoly(x) : 0 - cosPoly(x);
  return t < 0 ? 0 - s : s;
}

/** cos 2πt, the same bits on every engine; even bit for bit. */
export function cosTurn(t: number): number {
  const [q, x] = reduce(Math.abs(t));
  return q === 0 ? cosPoly(x) : q === 1 ? 0 - sinPoly(x) : q === 2 ? 0 - cosPoly(x) : sinPoly(x);
}
