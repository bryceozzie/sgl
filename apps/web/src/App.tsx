import type { EditorView } from '@codemirror/view';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { SGL_LANGUAGE_VERSION } from '@sgl/core';
import { CanvasMeasurer } from '@sgl/measure';
import { Canvas } from './canvas/Canvas.js';
import { Editor } from './editor/Editor.js';
import { replaceDocument } from './editor/extensions.js';
import { REGISTERED_ENGINES, watchShareLinks, type AppBoot } from './io/app-boot.js';
import { consumeLaunchQueue } from './io/launch-queue.js';
import { registerServiceWorker, type ApplyUpdate } from './io/pwa.js';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel.js';
import { Toasts } from './panels/Toasts.js';
import { createAutosave } from './state/autosave.js';
import type { BootNotice } from './state/boot.js';
import { createDocumentSession } from './state/document-session.js';
import { createOpenQueue } from './state/open-queue.js';
import { readOpenedFile } from './state/files.js';
import { APP_METRICS } from './state/metrics.js';
import { createPipeline } from './state/pipeline.js';
import { createToasts } from './state/toasts.js';
import type { Cancel } from './state/types.js';
import { createAppWorkerHost } from './state/worker-host.js';
import { EnginePicker } from './toolbar/EnginePicker.js';
import { FileMenu } from './toolbar/FileMenu.js';
import { ThemePicker } from './toolbar/ThemePicker.js';

function browserSchedule(fn: () => void, ms: number): Cancel {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** DD-08 §8's wording for a bad link; the rest are this stage's. */
const NOTICE_TOASTS: Readonly<Record<BootNotice, { readonly message: string; readonly kind: 'info' | 'error' }>> = {
  'share-opened': { message: 'Opened the shared diagram as a new document.', kind: 'info' },
  'share-invalid': { message: 'This share link is not valid', kind: 'error' },
  'storage-failed': { message: "This browser's storage is unavailable, so changes are kept in this tab only.", kind: 'error' },
  'boot-failed': { message: "Something went wrong opening your documents, so the example is open instead. Changes are kept in this tab only.", kind: 'error' },
};

/**
 * The application shell (DD-08 §2's layout: editor left, canvas right).
 *
 * I1: the default engine is whichever engine is actually registered in the
 * worker — `gridEngine.id` (`sgl.grid`) — not `@sgl/layout-api`'s frozen
 * `DEFAULT_ENGINE_ID` (`sgl.elk`, ADR-0005's eventual default), which is not
 * registered until Stage K. `boot` (`io/app-boot.ts`) has already chosen the
 * document (§8/§9) and validated its engine and theme against what exists.
 */
export function App({ boot }: { readonly boot: AppBoot }) {
  const app = useMemo(() => {
    const measurer = new CanvasMeasurer();
    const host = createAppWorkerHost(measurer);
    const pipeline = createPipeline(
      {
        measurer,
        host,
        metrics: APP_METRICS,
        defaultEngineId: boot.record.engineId,
        defaultThemeId: boot.record.themeId,
      },
      boot.record.source,
    );
    pipeline.engineOptions.value = boot.record.engineOptions;
    pipeline.docId.value = boot.record.id;

    const toasts = createToasts(browserSchedule);
    const autosave = createAutosave({
      store: boot.store,
      schedule: browserSchedule,
      onQuotaExceeded: () => toasts.push("This browser's storage is full: changes are kept in this tab only until space is freed.", 'error'),
      onError: (err) => {
        console.warn('[SGL] autosave failed.', err);
        toasts.push("Couldn't save to this browser's storage: changes are kept in this tab only.", 'error');
      },
    });
    const session = createDocumentSession(pipeline, boot.record, autosave, () => Date.now());
    for (const notice of boot.notices) toasts.push(NOTICE_TOASTS[notice].message, NOTICE_TOASTS[notice].kind);
    return { pipeline, toasts, autosave, session };
  }, []);
  const { pipeline, toasts, autosave, session } = app;

  // Preact state, not a pipeline signal (I3: the pipeline never touches
  // CodeMirror or the DOM) — the editor view and the canvas's imperative
  // `fit()` are both DOM handles the pickers/diagnostics/toolbar need.
  const [view, setView] = useState<EditorView | null>(null);
  const [fit, setFit] = useState<(() => void) | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [applyUpdate, setApplyUpdate] = useState<ApplyUpdate | null>(null);

  /** DD-08 §7's one Open path: toolbar, Ctrl/⌘+O, the launch queue (§12).
   *  An Open read before the editor exists (the launch queue can deliver
   *  that early) waits in `opens` until it does (fix round 1, item 13). */
  const opens = useMemo(() => createOpenQueue<{ readonly text: string; readonly extension: string }>(), []);
  useEffect(() => {
    opens.setTarget(
      view === null
        ? null
        : (opened) => {
            // A transaction, not a new EditorState: undo history survives (§4).
            replaceDocument(view, opened.text);
            session.setFileExtension(opened.extension);
            setFitRequest((n) => n + 1);
          },
    );
  }, [view]);
  const open = (file: File): void => {
    void readOpenedFile(file).then((result) => {
      if (!result.ok) {
        toasts.push(result.message, 'error');
        return;
      }
      opens.deliver({ text: result.text, extension: result.extension });
    });
  };

  useEffect(() => {
    // DD-08 §9: "a crash mid-edit loses at most 500 ms" — and leaving the page
    // loses nothing: write the pending record now.
    const flush = (): void => void autosave.flush();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    // A share link pasted into this already-open tab (§8, fix round 1).
    const unwatchShare = watchShareLinks({
      flush: () => autosave.flush(),
      onInvalid: () => toasts.push(NOTICE_TOASTS['share-invalid'].message, NOTICE_TOASTS['share-invalid'].kind),
    });
    registerServiceWorker((apply) => setApplyUpdate(() => apply));
    consumeLaunchQueue(open);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      unwatchShare();
    };
  }, []);

  function reloadForUpdate(): void {
    const apply = applyUpdate;
    if (apply === null) return;
    // The pending edit is written before the new version takes over.
    void autosave.flush().then(apply);
  }

  return (
    <div class="shell">
      <header class="toolbar">
        <h1>SGL</h1>
        <span class="status">language {SGL_LANGUAGE_VERSION}</span>
        {applyUpdate !== null ? (
          <div class="update-chip" role="status">
            Update available —{' '}
            <button type="button" class="update-reload" onClick={reloadForUpdate}>
              reload
            </button>
          </div>
        ) : null}
        <EnginePicker pipeline={pipeline} view={view} registered={REGISTERED_ENGINES} />
        <ThemePicker pipeline={pipeline} view={view} />
        <button type="button" class="toolbar-button toolbar-fit" onClick={() => fit?.()}>
          <span aria-hidden="true">⟳</span> Fit
        </button>
        <FileMenu pipeline={pipeline} session={session} toasts={toasts} onOpen={open} />
      </header>
      <div class="panes">
        <Editor pipeline={pipeline} onView={setView} />
        <Canvas
          pipeline={pipeline}
          onFitReady={(f) => setFit(() => f)}
          fitRequest={fitRequest}
          {...(boot.record.lastGoodSvg !== undefined ? { bootSvg: boot.record.lastGoodSvg } : {})}
        />
      </div>
      <DiagnosticsPanel pipeline={pipeline} view={view} />
      <Toasts toasts={toasts} />
    </div>
  );
}
