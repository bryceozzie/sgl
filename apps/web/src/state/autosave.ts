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
  /** Writes a pending record now (page hide, reload for an update). Resolves
   *  once every write issued so far has settled. */
  flush(): Promise<void>;
  dispose(): void;
}

export function createAutosave(deps: AutosaveDeps): Autosave {
  const delay = deps.delayMs ?? AUTOSAVE_DELAY_MS;
  let pending: DocumentRecord | null = null;
  let timer: Cancel | null = null;
  // Writes are chained, never concurrent: a slow `put` of an older record can
  // then never land after a newer one and overwrite it.
  let chain: Promise<void> = Promise.resolve();
  let failing = false;

  function write(): Promise<void> {
    const record = pending;
    pending = null;
    if (record === null) return chain;
    chain = chain.then(async () => {
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
    });
    return chain;
  }

  return {
    request(record) {
      pending = record;
      if (timer !== null) timer();
      timer = deps.schedule(() => {
        timer = null;
        void write();
      }, delay);
    },
    flush() {
      if (timer !== null) {
        timer();
        timer = null;
      }
      return write();
    },
    dispose() {
      if (timer !== null) timer();
      timer = null;
      pending = null;
    },
  };
}
