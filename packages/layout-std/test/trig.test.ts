import { describe, expect, it } from 'vitest';
import { cosTurn, sinTurn } from '../src/trig.js';
import { TRIG_ANGLES, bitsOf } from './trig-angles.js';

/**
 * `radial`'s own trigonometry (DD-12 N44, H8; ADR-0004's 2026-09-27
 * amendment): `sinTurn(t)` and `cosTurn(t)` are `sin 2πt` and `cos 2πt`,
 * built from `+ - * /`, `Math.round` and one table-free polynomial, so their
 * results are the same bits on every JavaScript engine. Two things are
 * tested: accuracy against `Math.sin`/`Math.cos` (DD-12 §12 item 3: within
 * 1e-14), and exact bits for a set of angles, pinned in a golden, which
 * `trig.browser.test.ts` checks again inside Chromium.
 */

const TAU = 2 * Math.PI;

describe('sinTurn / cosTurn: accuracy (DD-12 §12 item 3)', () => {
  it('are within 1e-14 of Math.sin / Math.cos over [-3, 3] turns, 240 001 points', () => {
    let worst = 0;
    const n = 40_000;
    for (let i = -3 * n; i <= 3 * n; i += 1) {
      const t = i / n;
      worst = Math.max(worst, Math.abs(sinTurn(t) - Math.sin(TAU * t)), Math.abs(cosTurn(t) - Math.cos(TAU * t)));
    }
    console.warn(`[trig] worst |error| over [-3, 3] turns: ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-14);
  });

  it('are within 1e-14 at irregular points, including a turn\'s edges and tiny angles', () => {
    const points = [1e-300, 1e-12, 1e-6, 0.0001234, 0.1249999999, 0.125, 0.1250000001, 0.3333333333333333, 0.49999999999, 0.7, 0.999999999999, 1 - 2 ** -52];
    for (const t of points) {
      expect(Math.abs(sinTurn(t) - Math.sin(TAU * t)), `sin ${t}`).toBeLessThan(1e-14);
      expect(Math.abs(cosTurn(t) - Math.cos(TAU * t)), `cos ${t}`).toBeLessThan(1e-14);
    }
  });

  it('are exact at the quarter turns, and odd/even as sin and cos are', () => {
    expect([0, 0.25, 0.5, 0.75, 1, -0.25, 2.5].map(sinTurn)).toEqual([0, 1, 0, -1, 0, -1, 0]);
    expect([0, 0.25, 0.5, 0.75, 1, -0.25, 2.5].map(cosTurn)).toEqual([1, 0, -1, 0, 1, 0, -1]);
    // No negative zero at a half turn: it would print as 0 but compare as -0.
    expect(Object.is(sinTurn(0.5), 0)).toBe(true);
    for (const t of [0.01, 0.1, 0.2, 0.3, 0.45]) {
      expect(sinTurn(-t)).toBe(0 - sinTurn(t));
      expect(cosTurn(-t)).toBe(cosTurn(t));
    }
  });

  it('are within one unit in the last place of √½ at the eighth turns', () => {
    const ulp = 2 ** -53;
    for (const t of [0.125, 0.375, 0.625, 0.875]) {
      expect(Math.abs(Math.abs(sinTurn(t)) - Math.SQRT1_2)).toBeLessThanOrEqual(ulp);
      expect(Math.abs(Math.abs(cosTurn(t)) - Math.SQRT1_2)).toBeLessThanOrEqual(ulp);
    }
  });

  it('answer NaN for a non-finite turn', () => {
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(sinTurn(t)).toBeNaN();
      expect(cosTurn(t)).toBeNaN();
    }
  });
});

describe('sinTurn / cosTurn: exact bits (a golden; DD-12 N44)', () => {
  it('match the pinned bit patterns for every angle in TRIG_ANGLES', async () => {
    const rows = TRIG_ANGLES.map((t) => `${t} ${bitsOf(sinTurn(t))} ${bitsOf(cosTurn(t))}`);
    await expect(`${rows.join('\n')}\n`).toMatchFileSnapshot('./__goldens__/trig.txt');
  });
});
