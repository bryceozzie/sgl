import { effect } from '@preact/signals';
import { setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';
import type { Diagnostic } from '@sgl/core';
import type { Pipeline } from '../state/pipeline.js';
import { createEditorState } from './extensions.js';

function toCmDiagnostic(d: Diagnostic): CmDiagnostic {
  return { from: d.span.from, to: d.span.to, severity: d.severity, message: d.message };
}

export interface EditorProps {
  readonly pipeline: Pipeline;
}

/** CodeMirror 6, driven by `@sgl/core/editor`'s grammar-backed language (DD-08 §4).
 *  Owns the one `EditorView` instance; the pipeline never touches CodeMirror or
 *  the DOM directly (I3). */
export function Editor({ pipeline }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const view = new EditorView({
      state: createEditorState(pipeline.source.peek(), {
        onDocument: (tree, source) => pipeline.setDocument(tree, source),
      }),
      parent: host,
    });

    // DD-08 §4: "setDiagnostics(state, diags.map(toCmDiagnostic)) on every diags
    // change" — severity and span already line up 1:1 with CodeMirror's shape.
    const disposeDiagsEffect = effect(() => {
      const diags = pipeline.diags.value;
      view.dispatch(setDiagnostics(view.state, diags.map(toCmDiagnostic)));
    });

    return () => {
      disposeDiagsEffect();
      view.destroy();
    };
  }, [pipeline]);

  return <div class="editor-host" ref={hostRef} />;
}
