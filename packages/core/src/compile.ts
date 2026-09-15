import type { Diagnostic } from './diagnostics.js';
import type { SemanticGraph, ViewSelector } from './graph.js';
import type { DocumentModel } from './model.js';
import { NotImplemented } from './not-implemented.js';

export interface CompileResult {
  readonly graph: SemanticGraph;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The most edges one wildcard statement may expand to (DD-03 §3.1).
 *
 * A cross product like `a.** -> b.**` is quadratic in a document that is already
 * allowed to hold 2 000 nodes, so the ceiling is a hard stop rather than a
 * suggestion: over it, the statement is skipped with SGL3005 and every other edge
 * survives. Chosen to sit an order of magnitude above any legible diagram.
 */
export const MAX_EDGE_EXPANSION = 1_000;

/**
 * Compile the document model to the semantic graph: expand wildcard endpoints,
 * resolve edge endpoints to node IDs, allocate stable edge IDs, extract labels,
 * resolve shapes.
 *
 * Expansion happens here rather than in `resolve` for two reasons: it needs the
 * node tree, which only exists once the document model is built; and leaving the
 * wildcard intact in the model keeps `.sgl.json` a record of what the author wrote
 * rather than of what it expanded to (DD-02 §6).
 *
 * `view` is reserved for I1 (one model, many views) — see 04 §8.
 *
 * Design: DD-03.
 */
export function compile(model: DocumentModel, view?: ViewSelector): CompileResult {
  void model;
  void view;
  throw new NotImplemented('compile()', 'DD-03');
}
