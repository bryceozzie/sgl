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
 * Switch to `record`: store it first when `created` (Open, New document),
 * remember it as `lastOpenDocId`, then — in one synchronous step, so no edit
 * can slip between them — flush the current document's pending autosave and
 * load the new one. The flush issues its write at once (`autosave.ts`), so
 * everything typed into the previous document is saved to the previous
 * record, which is otherwise left exactly as it was. A storage failure does
 * not stop the switch (editing continues in memory, DD-08 §9): `ok: false`
 * lets the caller say so.
 */
export async function switchDocument(deps: SwitchDeps, record: DocumentRecord, options: { readonly created: boolean }): Promise<{ readonly ok: boolean }> {
  let ok = true;
  try {
    if (options.created) await deps.store.putDocument(record);
    await deps.store.putSetting('lastOpenDocId', record.id);
  } catch {
    ok = false;
  }
  void deps.autosave.flush();
  deps.load(record);
  return { ok };
}
