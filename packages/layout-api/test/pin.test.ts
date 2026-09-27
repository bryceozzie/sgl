import { describe, expect, it } from 'vitest';
import { pinOf } from '../src/pin.js';

/**
 * DD-12 N1, N4: a node's `@pin` as an engine reads it — `{ x, y }`, the
 * frame's top-left relative to the parent's content box. The resolver
 * already drops a malformed pin (SGL2011), so this is the engine's own
 * defence against input that did not come through it: anything but two
 * finite numbers is no pin at all.
 */
describe('pinOf (DD-12 N1, N4)', () => {
  it('reads x and y', () => {
    expect(pinOf({ pin: { x: 10, y: -2.5 } })).toEqual({ x: 10, y: -2.5 });
  });

  it('ignores other sub-keys (SGL2010 kept them)', () => {
    expect(pinOf({ pin: { x: 1, y: 2, z: 3 } })).toEqual({ x: 1, y: 2 });
  });

  it.each([
    ['no pin', {}],
    ['y missing', { pin: { x: 1 } }],
    ['a string', { pin: { x: '1', y: 2 } }],
    ['not finite', { pin: { x: Number.POSITIVE_INFINITY, y: 2 } }],
    ['NaN', { pin: { x: 1, y: Number.NaN } }],
    ['an array', { pin: [1, 2] }],
    ['a number', { pin: 5 }],
    ['null', { pin: null }],
  ])('%s is no pin', (_name, config) => {
    expect(pinOf(config as never)).toBeUndefined();
  });
});
