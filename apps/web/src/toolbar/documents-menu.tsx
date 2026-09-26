import { documentList, formatUpdated, type DocumentListEntry } from '../state/documents-list.js';
import type { DocumentRecord } from '../state/storage.js';

export interface DocumentsListProps {
  /** What `DocumentStore.listDocuments()` read when the menu opened. */
  readonly stored: readonly unknown[];
  /** The open document as it stands now. */
  readonly open: DocumentRecord;
  /** When the menu opened, for "5 min ago". */
  readonly now: number;
  /** A stored document other than the open one was picked. */
  readonly onPick: (record: DocumentRecord | null) => void;
  readonly onNew: () => void;
}

/**
 * The inside of Documents ▾ (DD-08 §9, fix round 2): "New document", then
 * every stored document by title and updated time, most recent first, the
 * open one marked. The lazy `documents-menu` chunk (A9 phase 2's first step,
 * F20, DD-02 §10.9): `DocumentsMenu.tsx` keeps the disclosure on the boot
 * path and loads this the first time the menu is opened; precached like
 * every chunk, so it works offline (`e2e/offline.spec.ts`).
 */
export function DocumentsList({ stored, open, now, onPick, onNew }: DocumentsListProps) {
  const entries: readonly DocumentListEntry[] = documentList(stored, open);
  return (
    <div class="menu docs-list">
      <button type="button" class="docs-new" onClick={onNew}>
        New document
      </button>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" class="docs-item" aria-current={entry.current ? 'true' : undefined} onClick={() => onPick(entry.current ? null : entry.record)}>
              <span class="docs-title">{entry.title}</span>
              <span class="docs-time">{entry.current ? 'open now' : formatUpdated(entry.updatedAt, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
