import { isQuotaExceeded, type DocumentRecord, type DocumentStore } from './storage.js';
import type { Cancel, Schedule } from './types.js';

/** DD-08 §9: "Autosave 500 ms after the last change (source or settings) —
 *  `put`, whole record." */
export const AUTOSAVE_DELAY_MS = 500;

export interface AutosaveDeps {
  readonly store: DocumentStore;
  readonly schedule: Schedule;
  readonly delayMs?: number;
  /** `QuotaExceededError`: DD-08 §9's toast. Called once per run of failures —
   *  not again until a save has succeeded — so a user typing into a full disk
   *  is told once, not every 500 ms. */
  readonly onQuotaExceeded: () => void;
  /** Any other write failure, with the same once-per-run rule. */
  readonly onError: (err: unknown) => void;
}

export interface Autosave {
  /** The latest whole record to save; replaces any not yet written, and
   *  restarts the 500 ms timer. */
  request(record: DocumentRecord): void;
  /** Writes a pending record now (page hide, reload for an update): the
   *  store call is issued before this returns. Resolves once every write
   *  issued so far has settled. */
  flush(): Promise<void>;
  dispose(): void;
}

export function createAutosave(deps: AutosaveDeps): Autosave {
  const delay = deps.delayMs ?? AUTOSAVE_DELAY_MS;
  let pending: DocumentRecord | null = null;
  let timer: Cancel | null = null;
  // Timer writes are chained, never concurrent: a slow `put` of an older
  // record can then never land after a newer one and overwrite it. A flush
  // is the exception (see `write(true)`).
  let chain: Promise<void> = Promise.resolve();
  let failing = false;

  async function put(record: DocumentRecord): Promise<void> {
    try {
      await deps.store.putDocument(record);
      failing = false;
    } catch (err) {
      // Editing continues in memory either way: the pipeline never reads
      // back from the store, so a failed write loses nothing on screen.
      if (failing) return;
      failing = true;
      if (isQuotaExceeded(err)) deps.onQuotaExceeded();
      else deps.onError(err);
    }
  }

  /** `now`: issue the store call synchronously, before this returns, instead
   *  of queueing it behind the write in flight. Leaving the page flushes from
   *  the `pagehide`/`visibilitychange` handler, and the document can be torn
   *  down before any promise callback or storage event runs again, so a write
   *  queued behind another would never be issued at all (fix round 1, item
   *  2). That is safe because the store applies writes in the order they are
   *  issued — IndexedDB runs `readwrite` transactions on one store in
   *  creation order (`DocumentStore.putDocument`). */
  function write(now: boolean): Promise<void> {
    const record = pending;
    pending = null;
    if (record === null) return chain;
    if (now) {
      const issued = put(record); // runs synchronously up to the store call
      chain = Promise.all([chain, issued]).then(() => undefined);
    } else {
      chain = chain.then(() => put(record));
    }
    return chain;
  }

  return {
    request(record) {
      pending = record;
      if (timer !== null) timer();
      timer = deps.schedule(() => {
        timer = null;
        void write(false);
      }, delay);
    },
    flush() {
      if (timer !== null) {
        timer();
        timer = null;
      }
      return write(true);
    },
    dispose() {
      if (timer !== null) timer();
      timer = null;
      pending = null;
    },
  };
}
