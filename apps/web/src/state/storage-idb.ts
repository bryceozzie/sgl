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
 *  which is where a `QuotaExceededError` surfaces. */
export async function openIdbStore(): Promise<DocumentStore> {
  const db: IDBPDatabase<SglSchema> = await openDB<SglSchema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('documents', { keyPath: 'id' });
      database.createObjectStore('settings', { keyPath: 'key' });
    },
  });
  return {
    getDocument: (id) => db.get('documents', id),
    async putDocument(record) {
      const tx = db.transaction('documents', 'readwrite');
      await Promise.all([tx.store.put(record), tx.done]);
    },
    listDocuments: () => db.getAll('documents'),
    async getSetting(key) {
      return (await db.get('settings', key))?.value;
    },
    async putSetting(key, value) {
      const tx = db.transaction('settings', 'readwrite');
      await Promise.all([tx.store.put({ key, value }), tx.done]);
    },
  };
}
