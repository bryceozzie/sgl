import { CanvasMeasurer, canvasIsAvailable } from './canvas-measurer.js';
import { StaticMetricsMeasurer } from './static-measurer.js';
import type { Measurer } from './types.js';

/**
 * The measurer to use when the caller has no opinion.
 *
 * Browser → `CanvasMeasurer`, which is the MVP default per ADR-0003's sequencing
 * amendment: real metrics for the font actually on screen, and cross-environment
 * parity is not yet a property the MVP can exercise.
 *
 * Node, and anywhere else without a canvas → `StaticMetricsMeasurer`, so that
 * tests, golden files and CI can produce a `MeasureTable` at all. Layout (DD-06)
 * and the renderer (DD-07) both take one as input, so without this there is no
 * Node coverage of anything downstream of measurement.
 *
 * The two do not agree numerically and are not meant to. Do not mix their output
 * in one cache or one golden file — pick a measurer per run and stay with it.
 */
export function createDefaultMeasurer(): Measurer {
  return canvasIsAvailable() ? new CanvasMeasurer() : new StaticMetricsMeasurer();
}
