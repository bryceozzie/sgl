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
   *  issued so far has settled, including records requested meanwhile,
   *  or once one has failed. Resolves to `saved()` as it stood then: true
   *  when everything reached the store (F12 round 1; read at that moment,
   *  so a render landing a microtask later cannot turn a good flush into a
   *  refused switch or reload — that record is the next write's, and
   *  leaving the page flushes it). */
  flush(): Promise<boolean>;
  /** Nothing is pending or in flight, and the last write reached the store
   *  (true before any write): whether a reload would lose nothing (F12). A
   *  failed record stays pending until a later write succeeds. */
  saved(): boolean;
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
  /** Records taken from `pending`, and the highest number issued so far. */
  let taken = 0;
  let issuedSeq = 0;

  /** Records taken from `pending` whose write has not settled yet, issued
   *  or still queued on the chain (F12 round 1). */
  let outstanding = 0;
  const saved = (): boolean => !failing && pending === null && outstanding === 0;

  async function put(record: DocumentRecord): Promise<void> {
    try {
      await deps.store.putDocument(record);
      failing = false;
    } catch (err) {
      // Editing continues in memory either way: the pipeline never reads
      // back from the store, so a failed write loses nothing on screen.
      // The record waits to be written again by the next flush or edit
      // (F12 round 1: until then, `saved()` is false), unless a newer one
      // has replaced it.
      pending ??= record;
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
    // Each record is numbered when it leaves `pending`. A queued timer write
    // whose number is below one already issued is skipped: a flush may have
    // issued a newer record while it waited on the chain, and issuing it
    // afterwards would overwrite that newer record (fix round 2, R1).
    taken += 1;
    outstanding += 1;
    const seq = taken;
    const issue = (): Promise<void> => {
      const done = (): void => void (outstanding -= 1);
      if (seq < issuedSeq) return Promise.resolve().then(done);
      issuedSeq = seq;
      return put(record).then(done);
    };
    if (now) {
      const issued = issue(); // runs synchronously up to the store call
      chain = Promise.all([chain, issued]).then(() => undefined);
    } else {
      chain = chain.then(issue);
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
    // The first write is issued synchronously (the async body runs up to its
    // first `await`); then anything requested while it ran is written too,
    // until nothing is pending or a write has failed (F12 round 1).
    async flush() {
      do {
        if (timer !== null) {
          timer();
          timer = null;
        }
        await write(true);
      } while ((pending !== null || outstanding > 0) && !failing);
      return saved();
    },
    saved,
    dispose() {
      if (timer !== null) timer();
      timer = null;
      pending = null;
    },
  };
}
