import type { Document } from './ast.js';
import type { Diagnostic } from './diagnostics.js';
import type { DocumentModel } from './model.js';
import { NotImplemented } from './not-implemented.js';

export interface ResolveResult {
  readonly model: DocumentModel;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Fold the AST into the canonical document model: merge redeclarations, expand
 * shorthands, normalise dotted `@`-keys, linearise classes.
 *
 * Design: DD-02.
 */
export function resolve(ast: Document): ResolveResult {
  void ast;
  throw new NotImplemented('resolve()', 'DD-02');
}

/** Serialise the canonical `.sgl.json` form. Lossless but for comments and formatting. */
export function toJson(model: DocumentModel): string {
  void model;
  throw new NotImplemented('toJson()', 'DD-02 §6');
}

/** `fromJson(text) === resolve(parse(text))` — the grammar accepts JSON as-is. */
export function fromJson(text: string): ResolveResult {
  void text;
  throw new NotImplemented('fromJson()', 'DD-02 §6');
}
