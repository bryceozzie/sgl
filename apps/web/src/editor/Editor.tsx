import { effect } from '@preact/signals';
import { setDiagnostics } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';
import type { Pipeline } from '../state/pipeline.js';
import { toCmDiagnostic } from './diagnostics.js';
import { createEditorState } from './extensions.js';

export interface EditorProps {
  readonly pipeline: Pipeline;
  /** Handed the live `EditorView` once it exists, and `null` on unmount — the
   *  pickers (DD-08 §10) and the diagnostics panel (§11) need it to dispatch
   *  transactions and to scroll/select a span, but the pipeline itself never
   *  touches CodeMirror (I3), so this is the one hole in that boundary,
   *  deliberately narrow and owned by the app shell, not the pipeline. */
  readonly onView?: (view: EditorView | null) => void;
}

/** CodeMirror 6, driven by `@sgl/core/editor`'s grammar-backed language (DD-08 §4).
 *  Owns the one `EditorView` instance; the pipeline never touches CodeMirror or
 *  the DOM directly (I3). */
export function Editor({ pipeline, onView }: EditorProps) {
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
    onView?.(view);

    // DD-08 §4: "setDiagnostics(state, diags.map(toCmDiagnostic)) on every diags
    // change" — severity and span already line up 1:1 with CodeMirror's shape.
    const disposeDiagsEffect = effect(() => {
      const diags = pipeline.diags.value;
      view.dispatch(setDiagnostics(view.state, diags.map((d) => toCmDiagnostic(d, view.state.doc.length))));
    });

    return () => {
      disposeDiagsEffect();
      onView?.(null);
      view.destroy();
    };
  }, [pipeline]);

  return <div class="editor-host" ref={hostRef} />;
}
