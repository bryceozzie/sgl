import { describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DELAY_MS, createAutosave } from '../src/state/autosave.js';
import { createMemoryStore, isQuotaExceeded, type DocumentRecord, type DocumentStore } from '../src/state/storage.js';
import { createFakeClock } from './fake-schedule.js';

/** DD-08 §9 — autosave 500 ms after the last change, whole record; a full
 *  quota is a toast and editing carries on. */

const record = (source: string, extra: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id: 'doc-1',
  title: 'd',
  source,
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-light',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

function quotaError(): Error {
  const err = new Error('The quota has been exceeded.');
  err.name = 'QuotaExceededError';
  return err;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('autosave', () => {
  it('writes the whole record once, 500 ms after the last of several changes', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    const put = vi.spyOn(store, 'putDocument');
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });

    autosave.request(record('a'));
    clock.advance(400);
    autosave.request(record('ab'));
    clock.advance(400);
    autosave.request(record('abc', { lastGoodSvg: '<svg/>' }));
    clock.advance(AUTOSAVE_DELAY_MS - 1);
    await settle();
    expect(put).not.toHaveBeenCalled();

    clock.advance(1);
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    expect(await store.getDocument('doc-1')).toEqual(record('abc', { lastGoodSvg: '<svg/>' }));
  });

  it('flush writes a pending record now and cancels the timer', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(record('now'));
    await autosave.flush();
    expect((await store.getDocument('doc-1'))?.source).toBe('now');
    expect(clock.pendingCount()).toBe(0);
    await autosave.flush(); // nothing pending: harmless.
  });

  it('never lets an older write land after a newer one', async () => {
    const clock = createFakeClock();
    const landed: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const slowFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store: DocumentStore = {
      ...createMemoryStore(),
      async putDocument(r) {
        if (r.source === 'old') await slowFirst;
        landed.push(r.source);
      },
    };
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(record('old'));
    clock.advance(AUTOSAVE_DELAY_MS);
    autosave.request(record('new'));
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(landed).toEqual([]);
    releaseFirst();
    await autosave.flush();
    expect(landed).toEqual(['old', 'new']);
  });

  it('flush issues the pending write synchronously, even while an earlier write is still in flight', async () => {
    // Leaving the page (pagehide, visibilitychange → hidden) runs flush from
    // the event handler; the page may be gone before any promise callback or
    // storage event runs, so the write must be issued before flush returns —
    // not queued behind the in-flight one. The store keeps issue order
    // (IndexedDB runs readwrite transactions on one store in creation order).
    const clock = createFakeClock();
    const issued: string[] = [];
    const landed: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const slowFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store: DocumentStore = {
      ...createMemoryStore(),
      async putDocument(r) {
        issued.push(r.source);
        if (r.source === 'old') await slowFirst;
        landed.push(r.source);
      },
    };
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(record('old'));
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    expect(issued).toEqual(['old']);

    autosave.request(record('new'));
    const flushed = autosave.flush();
    expect(issued).toEqual(['old', 'new']); // synchronously, no await in between
    expect(clock.pendingCount()).toBe(0);

    let settled = false;
    void flushed.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false); // flush still waits for the earlier write…
    releaseFirst();
    await flushed; // …and resolves once both have settled.
    expect(landed).toEqual(['new', 'old']); // (this fake store does not keep issue order; IndexedDB does)
  });

  it('a timer write still queued when flush issues a newer one is skipped, never issued after it (fix round 2, R1)', async () => {
    // A is in flight, B (a timer write) is queued behind it, then flush
    // issues C at once. B must not be issued after C: in a store that keeps
    // issue order (IndexedDB), it would overwrite the newer C.
    const clock = createFakeClock();
    const issued: string[] = [];
    let current: string | undefined;
    let releaseA: () => void = () => undefined;
    const slowA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const store: DocumentStore = {
      ...createMemoryStore(),
      async putDocument(r) {
        issued.push(r.source);
        current = r.source; // applied in issue order, as IndexedDB does
        if (r.source === 'A') await slowA;
      },
    };
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(record('A'));
    clock.advance(AUTOSAVE_DELAY_MS);
    await settle();
    autosave.request(record('B'));
    clock.advance(AUTOSAVE_DELAY_MS); // B queued behind A, not yet issued
    await settle();
    expect(issued).toEqual(['A']);
    autosave.request(record('C'));
    const flushed = autosave.flush();
    expect(issued).toEqual(['A', 'C']);
    releaseA();
    await flushed;
    await settle();
    expect(issued).toEqual(['A', 'C']); // B skipped: C is newer
    expect(current).toBe('C');
  });

  it('QuotaExceededError is reported once per run of failures, and editing continues', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    store.failPut = () => quotaError();
    const onQuotaExceeded = vi.fn();
    const onError = vi.fn();
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded, onError });

    autosave.request(record('a'));
    clock.advance(AUTOSAVE_DELAY_MS);
    await autosave.flush();
    autosave.request(record('ab'));
    await autosave.flush();
    expect(onQuotaExceeded).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(await store.getDocument('doc-1')).toBeUndefined();

    // Space frees up: the next write lands, and a later failure is news again.
    store.failPut = null;
    autosave.request(record('abc'));
    await autosave.flush();
    expect((await store.getDocument('doc-1'))?.source).toBe('abc');
    store.failPut = () => quotaError();
    autosave.request(record('abcd'));
    await autosave.flush();
    expect(onQuotaExceeded).toHaveBeenCalledTimes(2);
  });

  it('saved() says whether the last write reached the store (F12: whether a reload would lose anything)', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    expect(autosave.saved()).toBe(true);
    store.failPut = () => new Error('disk');
    autosave.request(record('a'));
    await autosave.flush();
    expect(autosave.saved()).toBe(false);
    store.failPut = null;
    autosave.request(record('ab'));
    await autosave.flush();
    expect(autosave.saved()).toBe(true);
  });

  it('F12 round 1: flush also writes what was typed while it ran, and saved() is false while anything is pending', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    const real = store.putDocument.bind(store);
    let release: () => void = () => undefined;
    let puts = 0;
    store.putDocument = async (r) => {
      puts += 1;
      if (puts === 1) await new Promise<void>((resolve) => (release = resolve)); // the first put hangs
      return real(r);
    };
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(record('a'));
    let flushed = false;
    const flushing = autosave.flush().then(() => (flushed = true));
    expect(autosave.saved()).toBe(false); // a write in flight
    autosave.request(record('ab')); // typed during the flush
    expect(autosave.saved()).toBe(false);
    release();
    await flushing;
    expect(flushed).toBe(true);
    expect(puts).toBe(2); // the edit typed during the flush was written too
    expect((await store.getDocument('doc-1'))?.source).toBe('ab');
    expect(autosave.saved()).toBe(true);
    expect(clock.pendingCount()).toBe(0);
  });

  it('F12 round 1: an edit whose timer fires while a flush waits on a slow write is still part of that flush', async () => {
    // Found by e2e/sw-update.spec.ts (a slow disk): the timer took the edit
    // off `pending` into a queued write, the flush saw nothing pending and
    // resolved "saved", and the page reloaded before the queued write ran.
    const clock = createFakeClock();
    const store = createMemoryStore();
    const real = store.putDocument.bind(store);
    let release: () => void = () => undefined;
    let puts = 0;
    store.putDocument = async (r) => {
      puts += 1;
      if (puts === 1) await new Promise<void>((resolve) => (release = resolve));
      return real(r);
    };
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(record('a'));
    const flushing = autosave.flush();
    autosave.request(record('ab'));
    clock.advance(AUTOSAVE_DELAY_MS); // the edit's own timer write, queued behind the slow one
    release();
    expect(await flushing).toBe(true);
    expect((await store.getDocument('doc-1'))?.source).toBe('ab');
    expect(autosave.saved()).toBe(true);
  });

  it('any other write failure goes to onError', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    const boom = new Error('disk on fire');
    store.failPut = () => boom;
    const onQuotaExceeded = vi.fn();
    const onError = vi.fn();
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded, onError });
    autosave.request(record('a'));
    await autosave.flush();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onQuotaExceeded).not.toHaveBeenCalled();
  });

  it('dispose drops a pending write', async () => {
    const clock = createFakeClock();
    const store = createMemoryStore();
    const autosave = createAutosave({ store, schedule: clock.schedule, onQuotaExceeded: vi.fn(), onError: vi.fn() });
    autosave.request(record('a'));
    autosave.dispose();
    clock.advance(AUTOSAVE_DELAY_MS);
    await autosave.flush();
    expect(await store.getDocument('doc-1')).toBeUndefined();
  });
});

describe('isQuotaExceeded', () => {
  it('by name, including Firefox’s legacy one, or by the legacy code 22', () => {
    expect(isQuotaExceeded(quotaError())).toBe(true);
    expect(isQuotaExceeded({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaExceeded({ name: 'Error', code: 22 })).toBe(true);
    expect(isQuotaExceeded(new Error('nope'))).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
    expect(isQuotaExceeded('QuotaExceededError')).toBe(false);
  });
});
