import { NotImplemented, type Diagnostic, type SemanticGraph } from '@sgl/core';
import type { LayoutResult } from './contract.js';

/**
 * Validate an engine's output before the renderer is allowed to trust it.
 *
 * NaN/Infinity coordinates, unknown node IDs and missing entries are rejected with
 * SGL4002. A buggy third-party engine must never be able to corrupt the renderer.
 *
 * Design: DD-06 §4.
 */
export function validateResult(result: LayoutResult, graph: SemanticGraph): readonly Diagnostic[] {
  void result;
  void graph;
  throw new NotImplemented('validateResult()', 'DD-06 §4');
}

/** Quantize coordinates to the engine's declared determinism class (ADR-0004),
 *  so a `quantized` engine compares equal across environments. */
export function quantize(result: LayoutResult, places: number): LayoutResult {
  void result;
  void places;
  throw new NotImplemented('quantize()', 'DD-06 §5');
}
