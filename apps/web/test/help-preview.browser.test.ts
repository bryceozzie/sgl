import { effect } from '@preact/signals';
import { CanvasMeasurer } from '@sgl/measure';
import { describe, expect, it } from 'vitest';
import { createPreviewer, type PreviewOutcome } from '../src/help/help-preview.js';
import { REGISTERED_ENGINES } from '../src/io/app-boot.js';
import { APP_METRICS } from '../src/state/metrics.js';
import { createPipeline } from '../src/state/pipeline.js';
import { createAppWorkerHost } from '../src/state/worker-host.js';

/**
 * DD-13 §12 (help branch 4): a preview, through the real `CanvasMeasurer`
 * and a real second layout worker, gives the same SVG as the editor's
 * pipeline on its own worker for the same source, engine and theme.
 */

const SOURCE = 'api: "Payments **API**"\ndb: "Ledger"\napi -> db: "writes"\n';

function mainRender(measurer: CanvasMeasurer, engineId: string, themeId: string): Promise<string> {
  const host = createAppWorkerHost(measurer);
  const pipeline = createPipeline(
    {
      measurer,
      host,
      metrics: APP_METRICS,
      defaultEngineId: engineId,
      defaultThemeId: themeId,
      engineSchemas: (id) => REGISTERED_ENGINES.find((e) => e.id === id),
      loadRichText: () => import('../src/state/rich-text.js').then((m) => m.richText),
    },
    SOURCE,
  );
  return new Promise((resolve) => {
    const stop = effect(() => {
      const good = pipeline.lastGood.value;
      if (good === null) return;
      const svg = good.svg;
      queueMicrotask(() => {
        stop();
        pipeline.dispose();
        host.dispose();
      });
      resolve(svg);
    });
  });
}

describe('a help preview in the browser (DD-13 P24, P25)', () => {
  for (const [engineId, themeId] of [
    ['sgl.elk', 'neutral-light'],
    ['sgl.grid', 'neutral-dark'],
  ] as const) {
    it(`equals the editor pipeline's SVG: ${engineId}, ${themeId}`, async () => {
      const measurer = new CanvasMeasurer();
      const previewer = createPreviewer({
        measurer,
        metrics: APP_METRICS,
        createHost: () => createAppWorkerHost(measurer),
        engineSchemas: (id) => REGISTERED_ENGINES.find((e) => e.id === id),
        loadRichText: () => import('../src/state/rich-text.js').then((m) => m.richText),
      });
      previewer.open();
      const outcome = await new Promise<PreviewOutcome>((done) => previewer.render({ key: 't#1', source: SOURCE, engineId, themeId }, done));
      const editor = await mainRender(measurer, engineId, themeId);
      expect(outcome.svg).not.toBeNull();
      expect(outcome.codes).toEqual([]);
      expect(outcome.svg).toBe(editor);
      expect(previewer.hostAlive()).toBe(true);
    }, 60_000);
  }
});
