import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Diagnostic, SourceSpan } from '@sgl/core';

/** A span inside a document of `length` characters: whole, non-negative,
 *  `from <= to <= length`. CodeMirror throws a `RangeError` for a position
 *  outside the document, and a diagnostic's span can come from an engine
 *  (DD-12 N20) or from an older text (fix round 1, item 2). */
export function clampSpan(span: SourceSpan, length: number): SourceSpan {
  const at = (v: number): number => Math.min(Math.max(Number.isNaN(v) ? 0 : Math.trunc(v), 0), length);
  const from = at(span.from);
  return { from, to: Math.max(from, at(span.to)) };
}

/** DD-08 §4: "setDiagnostics(state, diags.map(toCmDiagnostic))" — severity and
 *  span already line up 1:1 with CodeMirror's shape, the span clamped to the
 *  document (`length`). Split into its own module (rather than kept private
 *  in `Editor.tsx`) so the mapping is Node-testable without mounting a real
 *  `EditorView`. */
export function toCmDiagnostic(d: Diagnostic, length = Infinity): CmDiagnostic {
  return { ...clampSpan(d.span, length), severity: d.severity, message: d.message };
}
