import { useRef, useState } from 'preact/hooks';
import type { DocumentSession } from '../state/document-session.js';
import { documentList, formatUpdated, type DocumentListEntry } from '../state/documents.js';
import type { DocumentRecord, DocumentStore } from '../state/storage.js';
import { useDisclosure } from './disclosure.js';

export interface DocumentsMenuProps {
  readonly store: DocumentStore;
  readonly session: DocumentSession;
  /** Switch to a stored document (`state/documents.ts`'s `switchDocument`). */
  readonly onSelect: (record: DocumentRecord) => void;
  /** Start a new, empty document. */
  readonly onNew: () => void;
}

/**
 * DD-08 §2's `[≡ docs]`, as the minimal slice of E17 the human decision of
 * 2026-09-23 pulled into Stage J: every stored document, most recently
 * updated first, the open one marked; pick one to switch to it, or start a
 * new one. Delete, rename, search and tabs stay E17 (Stage L). The list is
 * read from storage each time it opens.
 */
export function DocumentsMenu({ store, session, onSelect, onNew }: DocumentsMenuProps) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const [entries, setEntries] = useState<readonly DocumentListEntry[] | null>(null);
  const [now, setNow] = useState(0);
  const menu = useDisclosure(ref, () => {
    setNow(Date.now());
    void store.listDocuments().then(
      (stored) => setEntries(documentList(stored, session.record.peek())),
      () => setEntries(documentList([], session.record.peek())),
    );
  });

  function pick(entry: DocumentListEntry): void {
    menu.close(false);
    if (!entry.current) onSelect(entry.record);
  }

  return (
    <details class="docs-menu" ref={ref} onToggle={menu.onToggle}>
      <summary class="toolbar-button">
        Documents <span aria-hidden="true">▾</span>
      </summary>
      <div class="menu docs-list">
        <button
          type="button"
          class="docs-new"
          onClick={() => {
            menu.close(false);
            onNew();
          }}
        >
          New document
        </button>
        {entries === null ? null : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.id}>
                <button type="button" class="docs-item" aria-current={entry.current ? 'true' : undefined} onClick={() => pick(entry)}>
                  <span class="docs-title">{entry.title}</span>
                  <span class="docs-time">{entry.current ? 'open now' : formatUpdated(entry.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
