import { batch, signal } from '@preact/signals';
import type { EditorView } from '@codemirror/view';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { SGL_LANGUAGE_VERSION } from '@sgl/core';
import { BUILT_IN, DEFAULT_THEME_ID } from '@sgl/theme';
import { CanvasMeasurer } from '@sgl/measure';
import { Canvas } from './canvas/Canvas.js';
import { Editor } from './editor/Editor.js';
import { loadDocument } from './editor/extensions.js';
import { DEFAULT_ENGINE_ID, REGISTERED_ENGINES, reopenAfterReload, shareImportDeps, watchShareLinks, type AppBoot } from './io/app-boot.js';
import { consumeLaunchQueue } from './io/launch-queue.js';
import { followUpdate, registerServiceWorker, type ApplyUpdate, type FollowUpdate } from './io/pwa.js';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel.js';
import { Toasts } from './panels/Toasts.js';
import { createAutosave } from './state/autosave.js';
import { blankRecord, newDocumentId, type BootNotice, type IdSource, type ShareImport } from './state/boot.js';
import { createDocumentSession } from './state/document-session.js';
import { switchDocument } from './state/documents.js';
import { createOpenQueue } from './state/open-queue.js';
import { APP_METRICS } from './state/metrics.js';
import { createPipeline } from './state/pipeline.js';
import type { DocumentRecord } from './state/storage.js';
import { onChunkFailure } from './state/lazy.js';
import { createToasts } from './state/toasts.js';
import type { Cancel } from './state/types.js';
import { createAppWorkerHost } from './state/worker-host.js';
import { DocumentsMenu } from './toolbar/DocumentsMenu.js';
import { EngineOptions } from './toolbar/EngineOptions.js';
import { EnginePicker } from './toolbar/EnginePicker.js';
import { FileMenu, loadFileActions } from './toolbar/FileMenu.js';
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

/** F12/F13 round 1, item 8: a switch refused because the open document
 *  could not be saved first. */
const NOT_SWITCHED = "Couldn't save the open document, so nothing else was opened: save your work (Save ▾).";
/** Round 1, item 2: a lazy chunk that could not be loaded. */
const CHUNK_FAILED = "Part of SGL couldn't be loaded. If you are offline, save your work (Save ▾) and reload when online.";

/** Round 1, item 2: loads what Save ▾ needs (the lazy `file-actions`
 *  chunk) now, while the precache still holds it — for a tab whose work
 *  may exist only in the page, which an update would then leave unable to
 *  save once the new worker drops the old chunk. */
function preloadSave(): void {
  loadFileActions().catch(() => undefined);
}

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
        engineSchemas: (id) => REGISTERED_ENGINES.find((e) => e.id === id),
        // A9 (DD-08 §15): the lazy `imports` chunk, for the first document
        // with `@imports`; it wraps this store's writes (I23).
        loadImports: () => import('./state/imports.js').then((m) => m.createImportsRuntime(boot.store)),
        // A18 (DD-11 T53): the lazy `rich-text` chunk, for the first document
        // with markup in a label or a label to wrap.
        loadRichText: () => import('./state/rich-text.js').then((m) => m.richText),
      },
      boot.record.source,
    );
    pipeline.engineOptions.value = boot.record.engineOptions;
    pipeline.docId.value = boot.record.id;

    const toasts = createToasts(browserSchedule);
    const autosave = createAutosave({
      store: boot.store,
      schedule: browserSchedule,
      onQuotaExceeded: () => {
        preloadSave();
        toasts.push("This browser's storage is full: changes are kept in this tab only until space is freed.", 'error');
      },
      onError: (err) => {
        console.warn('[SGL] autosave failed.', err);
        preloadSave();
        toasts.push("Couldn't save to this browser's storage: changes are kept in this tab only.", 'error');
      },
    });
    onChunkFailure(() => toasts.push(CHUNK_FAILED, 'error'));
    const session = createDocumentSession(pipeline, boot.record, autosave, () => Date.now());
    // The open document's stored picture, painted until its first live
    // render: at boot (J6), and again after every switch (fix round 2).
    const storedSvg = signal<string | undefined>(boot.record.lastGoodSvg);
    for (const notice of boot.notices) toasts.push(NOTICE_TOASTS[notice].message, NOTICE_TOASTS[notice].kind);
    // Round 1, item 1: a record boot could not store is written again by
    // autosave, so until that succeeds the tab knows it holds unsaved work
    // (and an update does not reload it away). Round 1, item 2: a tab whose
    // documents may exist only here loads Save's chunk now, while it is
    // still in the precache, so "save your work" can always be done.
    if (boot.notices.includes('storage-failed')) autosave.request(boot.record);
    if (boot.store.persistent !== true || boot.notices.includes('storage-failed')) preloadSave();
    for (const t of boot.toasts ?? []) toasts.push(t.message, t.kind);
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
    const { ok, switched } = await switchDocument(
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
    // Round 1, item 8: the open document could not be saved, so it stays.
    if (!ok) {
      preloadSave();
      toasts.push(switched ? NOTICE_TOASTS['storage-failed'].message : NOT_SWITCHED, 'error');
    }
    return switched;
  }

  /** A new record from the pickers as they stand (Open, New document). Open
   *  keeps the file's extension (§7) and name (A9, DD-02 I3). */
  function newRecord(source: string, file?: { readonly name: string; readonly extension: string }): DocumentRecord {
    const at = Date.now();
    const record = {
      ...blankRecord(newDocumentId(globalThis.crypto as IdSource | undefined, () => at), source, pipeline.engineId.peek(), pipeline.themeId.peek(), at),
      engineOptions: pipeline.engineOptions.peek(),
    };
    return file ? { ...record, fileExtension: file.extension, fileName: file.name } : record;
  }

  /** DD-08 §7's one Open path: toolbar, Ctrl/⌘+O, the launch queue (§12).
   *  Open creates a **new local document** (human decision, 2026-09-23); the
   *  previous one stays as it was, reachable from Documents. An Open read
   *  before the editor exists (the launch queue can deliver that early)
   *  waits in `opens` until it does (fix round 1, item 13). */
  const opens = useMemo(() => createOpenQueue<{ readonly name: string; readonly text: string; readonly extension: string }>(), []);
  /** A share link pasted into this tab, already stored (`importShare`), to
   *  switch to in place like Open (F13) — held, like an Open, until the
   *  editor exists. */
  const shares = useMemo(() => createOpenQueue<ShareImport & { readonly done: () => void }>(), []);
  useEffect(() => {
    shares.setTarget(
      view === null
        ? null
        : (shared) => {
            // A record the import could not store is stored again by the
            // switch, or handed to autosave (round 1, item 1).
            void openRecord(view, shared.record, shared.notices.includes('storage-failed'))
              .then((switched) => {
                if (!switched) return;
                for (const notice of shared.notices) if (notice !== 'storage-failed') toasts.push(NOTICE_TOASTS[notice].message, NOTICE_TOASTS[notice].kind);
                for (const t of shared.toasts ?? []) toasts.push(t.message, t.kind);
              })
              .finally(shared.done);
          },
    );
    opens.setTarget(
      view === null
        ? null
        : (opened) => {
            void openRecord(view, newRecord(opened.text, opened), true).then(
              (switched) => switched && toasts.push(`Opened ${opened.name} as a new document. Your previous document is in Documents.`),
            );
          },
    );
  }, [view]);
  // The checks and the read are in the lazy `files` chunk (`file-actions.tsx`),
  // loaded here if Open's picker or the launch queue has not loaded it yet.
  const open = (file: File): void => {
    void loadFileActions().then(async ({ readFile }) => {
      const result = await readFile(file);
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
      // Resolves once the link's document is open (or refused), so the
      // next link waits for it (round 1, item 6).
      open: async (payload, share) => {
        const shared = await share.importShare(shareImportDeps(boot.store), payload);
        await new Promise<void>((done) => shares.deliver({ ...shared, done }));
      },
      onInvalid: () => toasts.push(NOTICE_TOASTS['share-invalid'].message, NOTICE_TOASTS['share-invalid'].kind),
    });
    // DD-08 §12. A tab whose documents live only in memory is never offered
    // the update: accepting it reloads the tab (F12).
    registerServiceWorker(
      (apply) => {
        if (boot.store.persistent === true) setApplyUpdate(() => apply);
      },
      (here) => void followUpdate(updateSteps(() => window.location.reload()), here),
    );
    consumeLaunchQueue(open);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      unwatchShare();
    };
  }, []);

  /** An update's reload, here or following another tab (F12): the pending
   *  edit written first, then this tab's document noted so the reload
   *  reopens it; never when that would lose documents. */
  function updateSteps(reload: () => void): FollowUpdate {
    return {
      autosave,
      persistent: boot.store.persistent === true,
      remember: () => reopenAfterReload(session.record.peek().id),
      reload,
      // Once, however many updates arrive (round 1, items 5 and 7).
      stale: (message) => toasts.items.peek().some((t) => t.message === message) || toasts.push(message, 'error'),
    };
  }

  function reloadForUpdate(): void {
    // The new version takes over (and this page reloads) once saved.
    if (applyUpdate !== null) void followUpdate(updateSteps(applyUpdate), true);
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
