import type { EditorView } from '@codemirror/view';
import type { Diagnostic } from '@sgl/core';
import { scrollToSpan } from '../editor/editor-actions.js';
import type { Pipeline } from '../state/pipeline.js';

export interface DiagnosticsPanelProps {
  readonly pipeline: Pipeline;
  readonly view: EditorView | null;
  /** HD3: a row's Help opens the drawer at that code's entry. */
  readonly onHelp: (code: string) => void;
}

const SEVERITY_ICON: Readonly<Record<Diagnostic['severity'], string>> = { error: '⛔', warning: '⚠', info: 'ℹ' };

/** DD-08 §11: rows with severity, code and message, sorted by offset; click
 *  scrolls the editor to the span and selects it; collapsed when empty.
 *  HD3 (DD-13): each row's Help opens the drawer at the code's entry. */
export function DiagnosticsPanel({ pipeline, view, onHelp }: DiagnosticsPanelProps) {
  const diags = [...pipeline.diags.value].sort((a, b) => a.span.from - b.span.from);
  if (diags.length === 0) return null;

  return (
    <section class="diagnostics-panel" aria-label="Diagnostics">
      <ul>
        {diags.map((d, i) => (
          <li
            key={`${d.code}-${d.span.from}-${i}`}
            class={`diag diag-${d.severity}`}
            onClick={() => view !== null && scrollToSpan(view, d.span)}
          >
            <span class="diag-icon" aria-hidden="true">
              {SEVERITY_ICON[d.severity]}
            </span>
            <span class="diag-code">{d.code}</span>
            <span class="diag-message">{d.message}</span>
            <button
              type="button"
              class="toolbar-button"
              aria-label={`Help for ${d.code}`}
              onClick={(ev) => {
                ev.stopPropagation();
                onHelp(d.code);
              }}
            >
              Help
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
