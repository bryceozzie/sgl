import type { EditorView } from '@codemirror/view';
import { useMemo, useState } from 'preact/hooks';
import { SGL_LANGUAGE_VERSION } from '@sgl/core';
import { CanvasMeasurer } from '@sgl/measure';
import { gridEngine } from '@sgl/layout-std';
import { Canvas } from './canvas/Canvas.js';
import { Editor } from './editor/Editor.js';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel.js';
import { APP_METRICS } from './state/metrics.js';
import { createPipeline } from './state/pipeline.js';
import { createAppWorkerHost } from './state/worker-host.js';
import { EnginePicker } from './toolbar/EnginePicker.js';
import { ThemePicker } from './toolbar/ThemePicker.js';

const EXAMPLE = 'checkout: {\n  web: "Web App"\n  api: "API"\n  web -> api\n}\n';

/** The engines actually registered in `apps/web/src/layout.worker.ts` — only
 *  `gridEngine` until Stage K adds `elk`. Read from the same object the
 *  worker registers, rather than duplicated by hand, so the picker cannot
 *  list something the worker does not actually run. */
const REGISTERED_ENGINES = [{ id: gridEngine.id, name: gridEngine.name, determinism: gridEngine.capabilities.determinism }];

/**
 * The application shell (DD-08 §2's layout: editor left, canvas right).
 *
 * I1: the default engine is whichever engine is actually registered in the
 * worker — `gridEngine.id` (`sgl.grid`) — not `@sgl/layout-api`'s frozen
 * `DEFAULT_ENGINE_ID` (`sgl.elk`, ADR-0005's eventual default), which is not
 * registered until Stage K. `apps/web/src/layout.worker.ts` is the single source
 * of truth for what is registered; this constant is read from the same engine
 * object that file registers, so the two cannot drift.
 */
export function App() {
  const pipeline = useMemo(() => {
    const measurer = new CanvasMeasurer();
    const host = createAppWorkerHost(measurer);
    return createPipeline(
      {
        measurer,
        host,
        metrics: APP_METRICS,
        defaultEngineId: gridEngine.id,
      },
      EXAMPLE,
    );
  }, []);

  // Preact state, not a pipeline signal (I3: the pipeline never touches
  // CodeMirror or the DOM) — the editor view and the canvas's imperative
  // `fit()` are both DOM handles the pickers/diagnostics/toolbar need.
  const [view, setView] = useState<EditorView | null>(null);
  const [fit, setFit] = useState<(() => void) | null>(null);

  return (
    <div class="shell">
      <header class="toolbar">
        <h1>SGL</h1>
        <span class="status">language {SGL_LANGUAGE_VERSION}</span>
        <EnginePicker pipeline={pipeline} view={view} registered={REGISTERED_ENGINES} />
        <ThemePicker pipeline={pipeline} view={view} />
        <button type="button" class="toolbar-fit" onClick={() => fit?.()}>
          ⟳ Fit
        </button>
      </header>
      <div class="panes">
        <Editor pipeline={pipeline} onView={setView} />
        <Canvas pipeline={pipeline} onFitReady={(f) => setFit(() => f)} />
      </div>
      <DiagnosticsPanel pipeline={pipeline} view={view} />
    </div>
  );
}
