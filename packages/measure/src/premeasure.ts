import { NotImplemented } from '@sgl/core';
import type { StyledGraph } from '@sgl/theme';
import type { Measurer, MeasureTable } from './types.js';

/**
 * Measure every label in the graph on the main thread and return the table that
 * travels into the layout worker.
 *
 * Exit criterion (DD-00 §6): the table covers 100% of labels in the corpus — zero
 * worker RPC misses.
 *
 * Design: DD-05 §4.
 */
export function premeasure(styled: StyledGraph, measurer: Measurer): MeasureTable {
  void styled;
  void measurer;
  throw new NotImplemented('premeasure()', 'DD-05 §4');
}
