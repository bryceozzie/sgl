import type { Document } from './ast.js';
import type { Diagnostic } from './diagnostics.js';
import { NotImplemented } from './not-implemented.js';

export interface ParseResult {
  /** The Lezer CST. Typed as `unknown` until the generated parser is wired in —
   *  it becomes `import('@lezer/common').Tree`. */
  readonly tree: unknown;
  readonly ast: Document;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Parse `.sgl` (or `.sgl.json`, which the grammar accepts unchanged) into a typed
 * AST with spans. Synchronous, pure, error-tolerant: malformed input yields a
 * partial tree plus `SGL1xxx` diagnostics rather than an exception.
 *
 * Design: DD-01.
 */
export function parse(source: string): ParseResult {
  void source;
  throw new NotImplemented('parse()', 'DD-01');
}
