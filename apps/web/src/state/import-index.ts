import { batch, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { isDocumentRecord } from './boot.js';
import { fileName as fileNameKey, saveName } from './import-host.js';
import type { DocumentRecord, DocumentStore } from './storage.js';

/**
 * A9's stored-document index (DD-08 §15.2, I23, I24), part of the lazy
 * `imports` chunk: an in-memory snapshot of the stored documents that the
 * app's own writes keep current, so an `ImportHost` can answer
 * synchronously inside the pipeline's `resolve`.
 *
 * - `DocumentStore.putDocument` is wrapped, **before** the list is read, and
 *   every write updates its document's entry synchronously, when the write
 *   is issued (autosave, its flush on a switch or on leaving the page, Open,
 *   New document, a share link). An entry written after a list began wins
 *   over the listed record.
 * - `refresh()` reads the store again: the app calls it when the tab
 *   becomes visible, for what other tabs wrote.
 * - Each entry is its own signal, and `names` changes only when a title, a
 *   `fileName`, a group or the set of documents changes, so a resolve that
 *   reads `names` and the entries it matched re-runs for exactly the
 *   documents it imports (I24). `lastGoodSvg` is left out: it is large, and
 *   the record autosave writes carries it as a getter that renders on read.
 */

export interface IndexEntry {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly updatedAt: number;
  readonly fileName?: string;
  readonly group?: string;
}

/** Normalised names to document ids (DD-02 I3), and each document's group. */
export interface IndexNames {
  readonly byFile: ReadonlyMap<string, readonly string[]>;
  readonly bySave: ReadonlyMap<string, readonly string[]>;
  readonly groupOf: ReadonlyMap<string, string | undefined>;
}

export interface ImportIndex {
  /** The document's entry, or `undefined` for one not stored. */
  entry(id: string): ReadonlySignal<IndexEntry> | undefined;
  readonly names: ReadonlySignal<IndexNames>;
  /** Reads the store again (another tab's writes). */
  refresh(): Promise<void>;
}

const pick = (r: DocumentRecord): IndexEntry => ({
  id: r.id,
  title: typeof r.title === 'string' ? r.title : '',
  source: r.source,
  updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  ...(typeof r.fileName === 'string' ? { fileName: r.fileName } : {}),
  ...(typeof r.group === 'string' ? { group: r.group } : {}),
});

const naming = (e: IndexEntry): string => JSON.stringify([e.title, e.fileName, e.group]);

const same = (a: IndexEntry, b: IndexEntry): boolean =>
  a.title === b.title && a.source === b.source && a.updatedAt === b.updatedAt && a.fileName === b.fileName && a.group === b.group;

export async function createImportIndex(store: DocumentStore): Promise<ImportIndex> {
  const entries = new Map<string, { readonly signal: Signal<IndexEntry>; seq: number }>();
  const names = signal<IndexNames>({ byFile: new Map(), bySave: new Map(), groupOf: new Map() });
  /** Writes issued through the wrapper, numbered. */
  let seq = 0;

  function rebuildNames(): void {
    const byFile = new Map<string, string[]>();
    const bySave = new Map<string, string[]>();
    const groupOf = new Map<string, string | undefined>();
    const add = (map: Map<string, string[]>, key: string, id: string): void => void (map.get(key) ?? map.set(key, []).get(key)!).push(id);
    for (const [id, { signal: s }] of entries) {
      const e = s.peek();
      if (e.fileName !== undefined) add(byFile, fileNameKey(e.fileName), id);
      add(bySave, saveName(e.title), id);
      groupOf.set(id, e.group);
    }
    names.value = { byFile, bySave, groupOf };
  }

  /** Takes `record` in; `true` when a name, a group or the set changed. */
  function upsert(record: DocumentRecord, at: number): boolean {
    const next = pick(record);
    const current = entries.get(record.id);
    if (current === undefined) {
      entries.set(record.id, { signal: signal(next), seq: at });
      return true;
    }
    current.seq = Math.max(current.seq, at);
    const prior = current.signal.peek();
    if (same(prior, next)) return false;
    current.signal.value = next;
    return naming(prior) !== naming(next);
  }

  // The wrapper goes on before the list is read (I23).
  const put = store.putDocument.bind(store);
  store.putDocument = (record) => {
    // Not `isDocumentRecord`: it reads `lastGoodSvg`, which autosave's
    // record carries as a getter that renders on read.
    if (typeof record.id === 'string' && typeof record.source === 'string') {
      seq += 1;
      if (upsert(record, seq)) rebuildNames();
    }
    return put(record);
  };

  async function refresh(): Promise<void> {
    const start = seq;
    const listed = await store.listDocuments();
    batch(() => {
      let changed = false;
      const seen = new Set<string>();
      for (const record of listed as readonly unknown[]) {
        if (!isDocumentRecord(record)) continue;
        seen.add(record.id);
        // Written through this tab after the list began: that write is newer.
        if ((entries.get(record.id)?.seq ?? 0) > start) continue;
        if (upsert(record, 0)) changed = true;
      }
      for (const [id, e] of entries) {
        if (!seen.has(id) && e.seq <= start) {
          entries.delete(id);
          changed = true;
        }
      }
      if (changed) rebuildNames();
    });
  }

  await refresh();
  return { entry: (id) => entries.get(id)?.signal, names, refresh };
}
