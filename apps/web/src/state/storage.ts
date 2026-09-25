/**
 * DD-08 §9's persistence model, behind an interface so the boot and autosave
 * logic is Node-testable against `createMemoryStore()`; the IndexedDB
 * implementation (`idb`) is `storage-idb.ts`.
 */

/** One `documents` record, exactly DD-08 §9's value shape plus
 *  `fileExtension` — §7's "the extension is remembered on the document for the
 *  default save name" needs somewhere to live, and §9's table predates it. */
export interface DocumentRecord {
  /** `crypto.randomUUID()` (J2; DD-08 §9 originally said nanoid). */
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly engineId: string;
  readonly engineOptions: Readonly<Record<string, unknown>>;
  readonly themeId: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** `lastGood.svg` when it was saved, painted at the next boot before fonts
   *  and the worker are ready (DD-08 §5, §9). */
  readonly lastGoodSvg?: string;
  /** The extension the document was last opened from (§7). */
  readonly fileExtension?: string;
  /** A9 (DD-08 §15.1): the name Open read the file under, or the name a
   *  share link's bundle gave it — one of the two names an import path
   *  matches (DD-02 I3). */
  readonly fileName?: string;
  /** A9 (DD-08 §15.1): shared by the documents one share link created; an
   *  import looks in its own group first, and never in another (DD-02 I4). */
  readonly group?: string;
}

/** DD-08 §9's `settings` keys. Only `lastOpenDocId` is written today: the
 *  split is not draggable yet (DD-08 §2) and the theme is per document. */
export type SettingKey = 'lastOpenDocId' | 'splitRatio' | 'themePreference';

export interface SettingRecord {
  readonly key: SettingKey;
  readonly value: unknown;
}

/** The store is a keyed list from day one (E17's drawer is UI only). */
export interface DocumentStore {
  getDocument(id: string): Promise<DocumentRecord | undefined>;
  /** Writes land in the order they are issued, even when a caller does not
   *  wait for one to settle before issuing the next (autosave's flush on
   *  leaving the page, `autosave.ts`). IndexedDB guarantees it: `readwrite`
   *  transactions over the same store run in creation order. */
  putDocument(record: DocumentRecord): Promise<void>;
  listDocuments(): Promise<readonly DocumentRecord[]>;
  getSetting(key: SettingKey): Promise<unknown>;
  putSetting(key: SettingKey, value: unknown): Promise<void>;
}

/** An in-memory `DocumentStore`: the unit tests' fake, and the app's fallback
 *  when IndexedDB cannot be opened at all (editing continues, nothing
 *  persists). `failPut` lets a test make the next writes throw. */
export function createMemoryStore(seed: { readonly documents?: readonly DocumentRecord[]; readonly settings?: Readonly<Partial<Record<SettingKey, unknown>>> } = {}): DocumentStore & {
  failPut: ((record: DocumentRecord) => unknown) | null;
} {
  const documents = new Map<string, DocumentRecord>((seed.documents ?? []).map((d) => [d.id, d]));
  const settings = new Map<SettingKey, unknown>(Object.entries(seed.settings ?? {}) as [SettingKey, unknown][]);
  const store = {
    failPut: null as ((record: DocumentRecord) => unknown) | null,
    getDocument: async (id: string) => documents.get(id),
    putDocument: async (record: DocumentRecord) => {
      const failure = store.failPut?.(record);
      if (failure !== undefined && failure !== null) throw failure;
      documents.set(record.id, record);
    },
    listDocuments: async () => [...documents.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    getSetting: async (key: SettingKey) => settings.get(key),
    putSetting: async (key: SettingKey, value: unknown) => {
      settings.set(key, value);
    },
  };
  return store;
}

/** DD-08 §9: "Quota/`QuotaExceededError` → toast, editing continues in
 *  memory." Recognised by name (every engine uses it for IndexedDB) or by the
 *  legacy `DOMException` code 22. */
export function isQuotaExceeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22;
}
