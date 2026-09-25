import { useRef, useState } from 'preact/hooks';
import type { DocumentSession } from '../state/document-session.js';
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

type ListModule = typeof import('./documents-menu.js');
let listModule: Promise<ListModule> | undefined;

/** The lazy `documents-menu` chunk (the list, `state/documents-list.ts`),
 *  imported once, the first time Documents ▾ is opened. */
function loadList(): Promise<ListModule> {
  listModule ??= import('./documents-menu.js');
  return listModule;
}

interface Listed {
  readonly List: ListModule['DocumentsList'];
  readonly stored: readonly unknown[];
  readonly now: number;
}

/**
 * DD-08 §2's `[≡ docs]`, as the minimal slice of E17 the human decision of
 * 2026-09-23 pulled into Stage J: every stored document, most recently
 * updated first, the open one marked; pick one to switch to it, or start a
 * new one. Delete, rename, search and tabs stay E17 (Stage L). The list is
 * read from storage each time it opens.
 *
 * This is the part the first paint needs: the disclosure. The list inside is
 * the lazy `documents-menu` chunk (A9 phase 2's first step, F20, DD-02
 * §10.9), loaded with the stored documents when the menu opens.
 */
export function DocumentsMenu({ store, session, onSelect, onNew }: DocumentsMenuProps) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const [listed, setListed] = useState<Listed | null>(null);
  const menu = useDisclosure(ref, () => {
    const now = Date.now();
    void Promise.all([loadList(), store.listDocuments().catch(() => [])]).then(([m, stored]) => setListed({ List: m.DocumentsList, stored, now }));
  });

  return (
    <details class="docs-menu" ref={ref} onToggle={menu.onToggle}>
      <summary class="toolbar-button">
        Documents <span aria-hidden="true">▾</span>
      </summary>
      {listed === null ? null : (
        <listed.List
          stored={listed.stored}
          open={session.record.peek()}
          now={listed.now}
          onPick={(record) => {
            menu.close(false);
            if (record !== null) onSelect(record);
          }}
          onNew={() => {
            menu.close(false);
            onNew();
          }}
        />
      )}
    </details>
  );
}
