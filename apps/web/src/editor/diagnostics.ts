import type { Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { Diagnostic } from '@sgl/core';

/** DD-08 §4: "setDiagnostics(state, diags.map(toCmDiagnostic))" — severity and
 *  span already line up 1:1 with CodeMirror's shape. Split into its own module
 *  (rather than kept private in `Editor.tsx`) so the mapping is Node-testable
 *  without mounting a real `EditorView`. */
export function toCmDiagnostic(d: Diagnostic): CmDiagnostic {
  return { from: d.span.from, to: d.span.to, severity: d.severity, message: d.message };
}
