import type { Autosave } from './autosave.js';
import { isDocumentRecord } from './boot.js';
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

export interface DocumentListEntry {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly current: boolean;
  readonly record: DocumentRecord;
}

/**
 * The Documents list: every valid stored record (anything else read back is
 * skipped, as boot does), the open document as it is *now* rather than as
 * last saved (and listed even before its first save), most recently updated
 * first, ties by id so the order is stable.
 */
export function documentList(stored: readonly unknown[], open: DocumentRecord): DocumentListEntry[] {
  const records = stored.filter(isDocumentRecord).filter((r) => r.id !== open.id);
  const openStored = stored.filter(isDocumentRecord).find((r) => r.id === open.id);
  const openEntry: DocumentRecord = openStored !== undefined ? { ...open, updatedAt: Math.max(open.updatedAt, openStored.updatedAt) } : open;
  return [...records, openEntry]
    .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, current: r.id === open.id, record: r }))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "3 days ago", else the local date. */
export function formatUpdated(at: number, now: number): string {
  const age = now - at;
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)} day${age < 2 * DAY ? '' : 's'} ago`;
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
