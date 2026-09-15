import { SGL_LANGUAGE_VERSION } from '@sgl/core';

/**
 * The application shell.
 *
 * ⟶ DD-08 fills this in: the signal graph (§2, §3), the CodeMirror editor with
 * diagnostics and last-good-render (§4, §5), the canvas with pan/zoom and the
 * interaction overlay (§6), open/save and the share link (§7, §8), and the PWA
 * shell (§9). The split here is only the frame those pieces land in.
 */
export function App() {
  return (
    <div class="shell">
      <header>
        <h1>SGL</h1>
        <span class="status">language {SGL_LANGUAGE_VERSION} · skeleton</span>
      </header>
      <div class="panes">
        <section class="pane">
          <h2>Source</h2>
          <p>
            The CodeMirror 6 editor lands here, driven by the same Lezer grammar the
            pipeline parses with — <code>@sgl/core/editor</code>. See DD-08 §4.
          </p>
        </section>
        <section class="pane">
          <h2>Diagram</h2>
          <p>
            The rendered SVG lands here as an <code>innerHTML</code> swap, with the
            interaction overlay as a sibling group outside the rendered tree. See
            DD-07 §2 and DD-08 §6.
          </p>
        </section>
      </div>
    </div>
  );
}
