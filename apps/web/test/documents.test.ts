import { describe, expect, it, vi } from 'vitest';
import type { Autosave } from '../src/state/autosave.js';
import { switchDocument } from '../src/state/documents.js';
import { documentList, formatUpdated } from '../src/state/documents-list.js';
import { createMemoryStore, type DocumentRecord } from '../src/state/storage.js';

/** Fix round 2 (human decision 2026-09-23): Open makes a new local document,
 *  and a minimal Documents list reaches every stored one. */

const rec = (id: string, updatedAt: number, extra: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id,
  title: id,
  source: `${id}: "X"\n`,
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-light',
  createdAt: 1,
  updatedAt,
  ...extra,
});

function trackingAutosave(log: string[], flushed: () => Promise<void> = () => Promise.resolve(), saved = () => true): Autosave {
  return {
    request: (r) => void log.push(`request:${r.id}`),
    flush: () => {
      log.push('flush');
      return flushed().then(saved);
    },
    saved,
    dispose: () => undefined,
  };
}

describe('switchDocument', () => {
  it('a new record (Open, New document): stored, remembered, then the current one is flushed and the new one loaded', async () => {
    const previous = rec('old', 10, { source: 'old: "Edited"\n', lastGoodSvg: '<svg id="old"/>' });
    const store = createMemoryStore({ documents: [previous], settings: { lastOpenDocId: 'old' } });
    const log: string[] = [];
    const fresh = rec('new', 20, { source: 'opened: "O"\n', fileExtension: '.txt' });

    const result = await switchDocument({ store, autosave: trackingAutosave(log), load: (r) => log.push(`load:${r.id}`) }, fresh, { created: true });

    expect(result).toEqual({ ok: true, switched: true });
    expect(log).toEqual(['flush', 'flush', 'load:new']); // the flush awaited, then anything typed meanwhile, then the switch
    expect(await store.getDocument('new')).toEqual(fresh);
    expect(await store.getSetting('lastOpenDocId')).toBe('new');
    expect(await store.getDocument('old')).toEqual(previous); // untouched
  });

  it('an existing record (the Documents list): remembered and loaded, not rewritten', async () => {
    const a = rec('a', 10);
    const store = createMemoryStore({ documents: [a, rec('b', 20)], settings: { lastOpenDocId: 'b' } });
    const put = vi.spyOn(store, 'putDocument');
    const log: string[] = [];
    await switchDocument({ store, autosave: trackingAutosave(log), load: (r) => log.push(`load:${r.id}`) }, a, { created: false });
    expect(put).not.toHaveBeenCalled();
    expect(await store.getSetting('lastOpenDocId')).toBe('a');
    expect(log).toEqual(['flush', 'flush', 'load:a']);
  });

  it('storage failing: the switch still happens (in memory), and says so', async () => {
    const store = createMemoryStore();
    store.failPut = () => new Error('no space');
    const log: string[] = [];
    const result = await switchDocument({ store, autosave: trackingAutosave(log), load: (r) => log.push(`load:${r.id}`) }, rec('n', 1), { created: true });
    expect(result).toEqual({ ok: false, switched: true });
    expect(log).toEqual(['flush', 'flush', 'load:n', 'request:n']); // retried through autosave (round 1, item 1)
  });

  it('round 1, item 8: the pre-switch flush is awaited before anything is switched', async () => {
    const store = createMemoryStore({ documents: [rec('old', 1)], settings: { lastOpenDocId: 'old' } });
    const log: string[] = [];
    let settle: () => void = () => undefined;
    let first = true;
    const flushed = () => (first ? ((first = false), new Promise<void>((resolve) => (settle = resolve))) : Promise.resolve());
    const switching = switchDocument({ store, autosave: trackingAutosave(log, flushed), load: (r) => log.push(`load:${r.id}`) }, rec('new', 2), { created: true });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(log).toEqual(['flush']);
    expect(await store.getDocument('new')).toBeUndefined();
    settle();
    await switching;
    expect(log).toEqual(['flush', 'flush', 'load:new']);
  });

  it('round 1, item 8: if the open document could not be saved, nothing is switched', async () => {
    const store = createMemoryStore({ documents: [rec('old', 1)], settings: { lastOpenDocId: 'old' } });
    const log: string[] = [];
    const result = await switchDocument(
      { store, autosave: trackingAutosave(log, undefined, () => false), load: (r) => log.push(`load:${r.id}`) },
      rec('new', 2),
      { created: true },
    );
    expect(result).toEqual({ ok: false, switched: false });
    expect(log).toEqual(['flush']);
    expect(await store.getDocument('new')).toBeUndefined();
    expect(await store.getSetting('lastOpenDocId')).toBe('old');
  });
});

describe('documentList', () => {
  it('every valid stored document, most recently updated first, the open one marked and shown as it is now', () => {
    const live = rec('b', 5, { title: 'B renamed' });
    const list = documentList([rec('a', 10), rec('b', 5), rec('c', 30), { junk: true }], live);
    expect(list.map((d) => [d.id, d.title, d.current])).toEqual([
      ['c', 'c', false],
      ['a', 'a', false],
      ['b', 'B renamed', true],
    ]);
  });

  it('the open document is listed even before its first save', () => {
    const list = documentList([rec('a', 10)], rec('unsaved', 0));
    expect(list.map((d) => d.id)).toEqual(['a', 'unsaved']);
  });

  it('equal times fall back to id order, so the list is stable', () => {
    expect(documentList([rec('b', 1), rec('a', 1)], rec('z', 0)).map((d) => d.id)).toEqual(['a', 'b', 'z']);
  });
});

describe('formatUpdated', () => {
  const now = Date.UTC(2026, 8, 23, 12, 0, 0);
  it.each([
    [now - 10_000, 'just now'],
    [now - 5 * 60_000, '5 min ago'],
    [now - 3 * 3_600_000, '3 h ago'],
    [now - 3 * 86_400_000, '3 days ago'],
    [now + 60_000, 'just now'], // a clock skew is not "in the future"
  ])('%s → %s', (at, text) => {
    expect(formatUpdated(at, now)).toBe(text);
  });

  it('older than a week: the date', () => {
    expect(formatUpdated(Date.UTC(2026, 0, 2, 12), now)).toBe('2026-01-02');
  });
});
