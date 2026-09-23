import { batch, signal } from '@preact/signals';
import type { EditorView } from '@codemirror/view';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { SGL_LANGUAGE_VERSION } from '@sgl/core';
import { BUILT_IN, DEFAULT_THEME_ID } from '@sgl/theme';
import { CanvasMeasurer } from '@sgl/measure';
import { Canvas } from './canvas/Canvas.js';
import { Editor } from './editor/Editor.js';
import { loadDocument } from './editor/extensions.js';
import { DEFAULT_ENGINE_ID, REGISTERED_ENGINES, watchShareLinks, type AppBoot } from './io/app-boot.js';
import { consumeLaunchQueue } from './io/launch-queue.js';
import { registerServiceWorker, type ApplyUpdate } from './io/pwa.js';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel.js';
import { Toasts } from './panels/Toasts.js';
import { createAutosave } from './state/autosave.js';
import { blankRecord, newDocumentId, type BootNotice, type IdSource } from './state/boot.js';
import { createDocumentSession } from './state/document-session.js';
import { switchDocument } from './state/documents.js';
import { createOpenQueue } from './state/open-queue.js';
import { readOpenedFile } from './state/files.js';
import { APP_METRICS } from './state/metrics.js';
import { createPipeline } from './state/pipeline.js';
import type { DocumentRecord } from './state/storage.js';
import { createToasts } from './state/toasts.js';
import type { Cancel } from './state/types.js';
import { createAppWorkerHost } from './state/worker-host.js';
import { DocumentsMenu } from './toolbar/DocumentsMenu.js';
import { EngineOptions } from './toolbar/EngineOptions.js';
import { EnginePicker } from './toolbar/EnginePicker.js';
import { FileMenu } from './toolbar/FileMenu.js';
import { ThemePicker } from './toolbar/ThemePicker.js';

function browserSchedule(fn: () => void, ms: number): Cancel {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** DD-08 §8's wording for a bad link; the rest are this stage's. */
const NOTICE_TOASTS: Readonly<Record<BootNotice, { readonly message: string; readonly kind: 'info' | 'error' }>> = {
  'share-opened': { message: 'Opened the shared diagram as a new document. Your previous document is in Documents.', kind: 'info' },
  'share-invalid': { message: 'This share link is not valid', kind: 'error' },
  'storage-failed': { message: "This browser's storage is unavailable, so changes are kept in this tab only.", kind: 'error' },
  'boot-failed': { message: "Something went wrong opening your documents, so the example is open instead. Changes are kept in this tab only.", kind: 'error' },
};

/**
 * The application shell (DD-08 §2's layout: editor left, canvas right).
 *
 * The default engine is `elk` (ADR-0005; Stage K ended Stage I's interim
 * `grid` default, I1). `boot` (`io/app-boot.ts`) has already chosen the
 * document (§8/§9) and validated its engine and theme against what exists —
 * a stored document keeps its own engine.
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
    // The open document's stored picture, painted until its first live
    // render: at boot (J6), and again after every switch (fix round 2).
    const storedSvg = signal<string | undefined>(boot.record.lastGoodSvg);
    for (const notice of boot.notices) toasts.push(NOTICE_TOASTS[notice].message, NOTICE_TOASTS[notice].kind);
    return { pipeline, toasts, autosave, session, storedSvg };
  }, []);
  const { pipeline, toasts, autosave, session, storedSvg } = app;

  // Preact state, not a pipeline signal (I3: the pipeline never touches
  // CodeMirror or the DOM) — the editor view and the canvas's imperative
  // `fit()` are both DOM handles the pickers/diagnostics/toolbar need.
  const [view, setView] = useState<EditorView | null>(null);
  const [fit, setFit] = useState<(() => void) | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [applyUpdate, setApplyUpdate] = useState<ApplyUpdate | null>(null);

  /** Make `record` the open document (fix round 2): the current one is
   *  flushed first (`switchDocument`), then — in one batch, so neither the
   *  canvas nor autosave sees a half-switched state — the session, the
   *  editor (a fresh undo history: undo never crosses documents) and the
   *  stored picture, and the next render fits. */
  async function openRecord(editor: EditorView, record: DocumentRecord, created: boolean): Promise<boolean> {
    const { ok } = await switchDocument(
      {
        store: boot.store,
        autosave,
        load: (next) => {
          batch(() => {
            storedSvg.value = next.lastGoodSvg;
            pipeline.docId.value = next.id;
            session.switchTo(next, () => loadDocument(editor, next.source));
          });
          setFitRequest((n) => n + 1);
        },
      },
      record,
      { created },
    );
    if (!ok) toasts.push(NOTICE_TOASTS['storage-failed'].message, 'error');
    return ok;
  }

  /** A new record from the pickers as they stand (Open, New document). */
  function newRecord(source: string, fileExtension?: string): DocumentRecord {
    const at = Date.now();
    const record = {
      ...blankRecord(newDocumentId(globalThis.crypto as IdSource | undefined, () => at), source, pipeline.engineId.peek(), pipeline.themeId.peek(), at),
      engineOptions: pipeline.engineOptions.peek(),
    };
    return fileExtension !== undefined ? { ...record, fileExtension } : record;
  }

  /** DD-08 §7's one Open path: toolbar, Ctrl/⌘+O, the launch queue (§12).
   *  Open creates a **new local document** (human decision, 2026-09-23); the
   *  previous one stays as it was, reachable from Documents. An Open read
   *  before the editor exists (the launch queue can deliver that early)
   *  waits in `opens` until it does (fix round 1, item 13). */
  const opens = useMemo(() => createOpenQueue<{ readonly name: string; readonly text: string; readonly extension: string }>(), []);
  useEffect(() => {
    opens.setTarget(
      view === null
        ? null
        : (opened) => {
            void openRecord(view, newRecord(opened.text, opened.extension), true).then(() =>
              toasts.push(`Opened ${opened.name} as a new document. Your previous document is in Documents.`),
            );
          },
    );
  }, [view]);
  const open = (file: File): void => {
    void readOpenedFile(file).then((result) => {
      if (!result.ok) {
        toasts.push(result.message, 'error');
        return;
      }
      opens.deliver({ name: file.name, text: result.text, extension: result.extension });
    });
  };

  /** Documents ▾: a stored record, with the same engine/theme fallback boot
   *  applies (DD-08 §9) — one no longer registered or built in opens with
   *  the default. */
  function selectDocument(record: DocumentRecord): void {
    if (view === null) return;
    const usable: DocumentRecord = {
      ...record,
      engineId: REGISTERED_ENGINES.some((e) => e.id === record.engineId) ? record.engineId : DEFAULT_ENGINE_ID,
      themeId: BUILT_IN[record.themeId] !== undefined ? record.themeId : DEFAULT_THEME_ID,
    };
    void openRecord(view, usable, false);
  }

  /** Documents ▾ → New document: an empty one (the example is only for a
   *  first visit). */
  function newDocument(): void {
    if (view === null) return;
    void openRecord(view, newRecord(''), true);
  }

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
        <DocumentsMenu store={boot.store} session={session} onSelect={selectDocument} onNew={newDocument} />
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
        <EngineOptions pipeline={pipeline} />
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
          storedSvg={storedSvg}
        />
      </div>
      <DiagnosticsPanel pipeline={pipeline} view={view} />
      <Toasts toasts={toasts} />
    </div>
  );
}
