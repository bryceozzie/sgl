import { useMemo } from 'preact/hooks';
import { SGL_LANGUAGE_VERSION } from '@sgl/core';
import { CanvasMeasurer } from '@sgl/measure';
import { gridEngine } from '@sgl/layout-std';
import { Canvas } from './canvas/Canvas.js';
import { Editor } from './editor/Editor.js';
import { APP_METRICS } from './state/metrics.js';
import { createPipeline } from './state/pipeline.js';
import { createAppWorkerHost } from './state/worker-host.js';

const EXAMPLE = 'checkout: {\n  web: "Web App"\n  api: "API"\n  web -> api\n}\n';

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

  return (
    <div class="shell">
      <header>
        <h1>SGL</h1>
        <span class="status">language {SGL_LANGUAGE_VERSION}</span>
      </header>
      <div class="panes">
        <Editor pipeline={pipeline} />
        <Canvas pipeline={pipeline} />
      </div>
    </div>
  );
}
