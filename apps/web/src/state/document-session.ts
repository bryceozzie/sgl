import { computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import type { Autosave } from './autosave.js';
import { documentTitle } from './filename.js';
import type { Pipeline } from './pipeline.js';
import type { DocumentRecord } from './storage.js';

/** The slice of the pipeline a document record is built from. */
export type SessionPipeline = Pick<Pipeline, 'source' | 'model' | 'engineId' | 'engineOptions' | 'themeId' | 'lastGood'>;

export interface DocumentSession {
  /** The open document as it stands now — DD-08 §9's whole record. */
  readonly record: ReadonlySignal<DocumentRecord>;
  /** DD-08 §7: remembered on Open, for the default save name. */
  setFileExtension(extension: string): void;
  dispose(): void;
}

/**
 * Keeps the open document's record in step with the pipeline and hands every
 * change to autosave (DD-08 §9: "500 ms after the last change (source or
 * settings)"). The record's `engineId`/`themeId` are the *pickers'* values —
 * a document's own `@layout.engine`/`@theme` already lives in its source.
 * `lastGoodSvg` is the canvas's `lastGood.svg`, or the stored one until the
 * first live render replaces it, so a boot that never renders (a document
 * with errors) does not throw the stored picture away.
 */
export function createDocumentSession(pipeline: SessionPipeline, initial: DocumentRecord, autosave: Autosave, now: () => number): DocumentSession {
  const fileExtension = signal<string | undefined>(initial.fileExtension);

  const record = computed<DocumentRecord>(() => {
    const svg = pipeline.lastGood.value?.svg ?? initial.lastGoodSvg;
    const ext = fileExtension.value;
    return {
      id: initial.id,
      title: documentTitle(pipeline.model.value.model),
      source: pipeline.source.value,
      engineId: pipeline.engineId.value,
      engineOptions: pipeline.engineOptions.value,
      themeId: pipeline.themeId.value,
      createdAt: initial.createdAt,
      updatedAt: initial.updatedAt,
      ...(svg !== undefined ? { lastGoodSvg: svg } : {}),
      ...(ext !== undefined ? { fileExtension: ext } : {}),
    };
  });

  let first = true;
  const dispose = effect(() => {
    const current = record.value;
    if (first) {
      first = false;
      // Nothing has changed yet — except a document created this boot, whose
      // placeholder title the pipeline has now computed properly.
      if (current.title === initial.title) return;
    }
    autosave.request({ ...current, updatedAt: now() });
  });

  return {
    record,
    setFileExtension(extension) {
      fileExtension.value = extension;
    },
    dispose,
  };
}
