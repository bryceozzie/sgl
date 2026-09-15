import { NotImplemented } from '@sgl/core';
import type { LayoutInput, LayoutResult } from './contract.js';

/**
 * Host fallbacks — what fills the gaps an engine declares it does not cover.
 *
 * This is what turns `capabilities` from a rejection test into a negotiation, and
 * is the main reason a node-placement-only engine is a legitimate engine.
 *
 * Design: DD-06 §2.
 */

/** Applied when `capabilities.labelPlacement` is false. */
export function placeLabels(input: LayoutInput, result: LayoutResult): LayoutResult {
  void input;
  void result;
  throw new NotImplemented('placeLabels()', 'DD-06 §2');
}

/** Applied when an engine returns no route for an edge. */
export function routeStraight(input: LayoutInput, result: LayoutResult): LayoutResult {
  void input;
  void result;
  throw new NotImplemented('routeStraight()', 'DD-06 §2');
}
