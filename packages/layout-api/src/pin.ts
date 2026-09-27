import type { ConfigBag, Point } from '@sgl/core';

/**
 * A node's `@pin` as an engine reads it (DD-12 N1, N2, N4): the top-left of
 * the node's frame, relative to the top-left of its parent's content box (at
 * the root, relative to the other root pins: the host frames the drawing to
 * fit its content). It reaches every engine unchanged in
 * `GraphNode.config.pin`.
 *
 * The resolver already drops a malformed pin (`SGL2011`), so this is only a
 * defence against input that did not come through it: anything but an object
 * with two finite numbers `x` and `y` is no pin at all. Other sub-keys
 * (`SGL2010`, kept) are ignored.
 *
 * Shared by `fixed` (`@sgl/layout-std`) and the conformance suite, whose
 * check 3 exempts two siblings an engine with `pins` placed where their
 * author put them (F28).
 */
export function pinOf(config: ConfigBag): Point | undefined {
  const pin = config['pin'];
  if (typeof pin !== 'object' || pin === null || Array.isArray(pin)) return undefined;
  const { x, y } = pin as ConfigBag;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? { x, y } : undefined;
}
