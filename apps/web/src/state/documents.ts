import type { Autosave } from './autosave.js';
import type { DocumentRecord, DocumentStore } from './storage.js';

/**
 * Moving between local documents (fix round 2; human decision 2026-09-23:
 * Open creates a new local document, and a minimal Documents list — the
 * smallest slice of E17 — reaches every stored one). DOM-free; the editor,
 * pipeline and canvas side of a switch is the caller's `load`.
 */

export interface SwitchDeps {
  readonly store: DocumentStore;
  readonly autosave: Autosave;
  /** Makes `record` the open document (`DocumentSession.switchTo` plus the
   *  canvas), synchronously. */
  readonly load: (record: DocumentRecord) => void;
}

/**
 * Switch to `record`. First the current document's pending autosave is
 * flushed **and awaited** (F12/F13 round 1, item 8): if it could not be
 * saved, nothing is switched (`switched: false`) — the current document
 * stays open, and the caller says why. Then `record` is stored when
 * `created` (Open, New document, a pasted share link whose own store
 * failed), remembered as `lastOpenDocId`, and — in one synchronous step,
 * so no edit can slip between them — anything typed meanwhile is flushed
 * and the new one loaded. The previous record is otherwise left exactly as
 * it was. A failure to store the new one does not stop the switch (editing
 * continues in memory, DD-08 §9): the record is handed to autosave to write
 * again (round 1, item 1, so a reload for an update knows it is unsaved),
 * and `ok: false` lets the caller say so.
 */
export async function switchDocument(
  deps: SwitchDeps,
  record: DocumentRecord,
  options: { readonly created: boolean },
): Promise<{ readonly ok: boolean; readonly switched: boolean }> {
  if (!(await deps.autosave.flush())) return { ok: false, switched: false };
  let ok = true;
  try {
    if (options.created) await deps.store.putDocument(record);
    await deps.store.putSetting('lastOpenDocId', record.id);
  } catch {
    ok = false;
  }
  void deps.autosave.flush();
  deps.load(record);
  if (!ok) deps.autosave.request(record);
  return { ok, switched: true };
}
