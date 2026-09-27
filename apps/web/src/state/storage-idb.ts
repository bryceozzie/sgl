import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocumentRecord, DocumentStore, SettingKey, SettingRecord } from './storage.js';

/** DD-08 §9: IndexedDB `sgl`, version 1, via `idb`. */
export const DB_NAME = 'sgl';
export const DB_VERSION = 1;

interface SglSchema extends DBSchema {
  documents: { key: string; value: DocumentRecord };
  settings: { key: SettingKey; value: SettingRecord };
}

/** Opens (creating on first use) the database and wraps it as a
 *  `DocumentStore`. Rejects when IndexedDB is unavailable; the caller falls
 *  back to `createMemoryStore()`. Every write awaits its transaction's `done`,
 *  which is where a `QuotaExceededError` surfaces.
 *
 *  Every write issues its `put` synchronously and then **commits the
 *  transaction explicitly** (fix round 1, item 2). Left to auto-commit, a
 *  transaction only commits after its request's success event has been
 *  dispatched — a later task. Autosave's flush on `pagehide` issues the put
 *  while the page is being torn down; Chromium never runs that task and
 *  aborts the uncommitted transaction with the document, so an edit made in
 *  the last 500 ms before a reload or tab close was lost every time.
 *  `commit()` hands the transaction to the backend at once. (Engines without
 *  `commit()` — Safari before 15 — keep auto-commit.) */
export async function openIdbStore(): Promise<DocumentStore> {
  const db: IDBPDatabase<SglSchema> = await openDB<SglSchema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('documents', { keyPath: 'id' });
      database.createObjectStore('settings', { keyPath: 'key' });
    },
  });
  return {
    persistent: true,
    getDocument: (id) => db.get('documents', id),
    async putDocument(record) {
      const tx = db.transaction('documents', 'readwrite');
      const put = tx.store.put(record);
      commit(tx);
      await Promise.all([put, tx.done]);
    },
    listDocuments: () => db.getAll('documents'),
    async getSetting(key) {
      return (await db.get('settings', key))?.value;
    },
    async putSetting(key, value) {
      const tx = db.transaction('settings', 'readwrite');
      const put = tx.store.put({ key, value });
      commit(tx);
      await Promise.all([put, tx.done]);
    },
  };
}

/** `IDBTransaction.commit()` where the engine has it (not Safari < 15). */
function commit(tx: { commit?: () => void }): void {
  if (typeof tx.commit === 'function') tx.commit();
}
