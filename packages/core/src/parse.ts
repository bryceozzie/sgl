import type { Tree } from '@lezer/common';
import type { Document } from './ast.js';
import { buildAst } from './build-ast.js';
import type { Diagnostic } from './diagnostics.js';
import { parser } from './grammar/sgl.parser.js';

export interface ParseResult {
  /** The Lezer CST, for the editor's incremental path (DD-01 §5). */
  readonly tree: Tree;
  readonly ast: Document;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Parse `.sgl` (or `.sgl.json`, which the grammar accepts unchanged) into a typed
 * AST with spans. Synchronous, pure, error-tolerant: malformed input yields a
 * partial tree plus `SGL1xxx` diagnostics rather than an exception.
 *
 * The editor calls `buildAst` directly on its already-parsed `syntaxTree(state)`
 * to avoid paying for a second parse per keystroke (DD-01 §5); `parse()` is the
 * non-incremental entry point the pipeline, CLI and tests call.
 *
 * Design: DD-01.
 */
export function parse(source: string): ParseResult {
  const tree = parser.parse(source);
  const { value: ast, diagnostics } = buildAst(tree, source);
  return { tree, ast, diagnostics };
}
