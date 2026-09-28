import { describe, expect, it } from 'vitest';
import { cosTurn, sinTurn } from '../../src/trig.js';
import { TRIG_ANGLES, bitsOf } from '../trig-angles.js';
// The golden `trig.test.ts` writes and checks in Node.
import golden from '../__goldens__/trig.txt?raw';

/**
 * DD-12 N44 (H8): `sinTurn`/`cosTurn` give the same bits in the browser's
 * JavaScript engine as in Node's, for every angle of the golden. (Chromium
 * here, whose V8 is Node's engine too, so this proves the golden is not
 * Node-only; Firefox and WebKit run it when CI's browser matrix does.)
 */
describe('sinTurn / cosTurn in the browser equal the Node golden, bit for bit', () => {
  it('every angle of TRIG_ANGLES', () => {
    const rows = TRIG_ANGLES.map((t) => `${t} ${bitsOf(sinTurn(t))} ${bitsOf(cosTurn(t))}`);
    expect(`${rows.join('\n')}\n`).toBe(golden);
  });
});
