import { isDocumentRecord } from './boot.js';
import type { DocumentRecord } from './storage.js';

/**
 * The Documents ▾ list (fix round 2), DOM-free. Its own module since A9
 * phase 2's first step (F20, DD-02 §10.9): only the lazy `documents-menu`
 * chunk (`toolbar/documents-menu.tsx`) uses it, so it stays off the boot
 * path, while `switchDocument` (`documents.ts`) is on it.
 */

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
