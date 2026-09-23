import { describe, expect, it } from 'vitest';
import { bootDocument, type BootDeps } from '../src/state/boot.js';
import { encodeShareFragment } from '../src/state/share.js';
import { createMemoryStore, type DocumentRecord, type DocumentStore } from '../src/state/storage.js';

/** DD-08 §8/§9 — which document boot opens. */

const EXAMPLE = 'example: "The example"\n';

const stored = (id: string, source: string, extra: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id,
  title: id,
  source,
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-dark',
  createdAt: 10,
  updatedAt: 20,
  lastGoodSvg: '<svg viewBox="0 0 10 10"/>',
  ...extra,
});

function deps(store: DocumentStore, overrides: Partial<BootDeps> = {}): BootDeps {
  let n = 0;
  return {
    store,
    hash: '',
    exampleSource: EXAMPLE,
    newId: () => `new-${(n += 1)}`,
    now: () => 1000,
    defaultEngineId: 'sgl.grid',
    defaultThemeId: 'neutral-light',
    isKnownEngine: (id) => id === 'sgl.grid',
    isKnownTheme: (id) => id === 'neutral-light' || id === 'neutral-dark',
    ...overrides,
  };
}

describe('boot without a share link', () => {
  it('no lastOpenDocId: creates a document from the example, stores it, and remembers it', async () => {
    const store = createMemoryStore();
    const result = await bootDocument(deps(store));
    expect(result).toMatchObject({ created: true, clearHash: false, notices: [] });
    expect(result.record).toEqual({
      id: 'new-1',
      title: 'diagram',
      source: EXAMPLE,
      engineId: 'sgl.grid',
      engineOptions: {},
      themeId: 'neutral-light',
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(await store.getDocument('new-1')).toEqual(result.record);
    expect(await store.getSetting('lastOpenDocId')).toBe('new-1');
  });

  it('lastOpenDocId set: opens that document as stored, lastGoodSvg included', async () => {
    const doc = stored('doc-a', 'a: "A"\n');
    const store = createMemoryStore({ documents: [doc, stored('doc-b', 'b\n')], settings: { lastOpenDocId: 'doc-a' } });
    const result = await bootDocument(deps(store));
    expect(result).toEqual({ record: doc, created: false, clearHash: false, notices: [] });
    expect(await store.listDocuments()).toHaveLength(2); // nothing created
  });

  it('lastOpenDocId pointing at nothing (or at a malformed record) falls back to the example', async () => {
    const dangling = await bootDocument(deps(createMemoryStore({ settings: { lastOpenDocId: 'gone' } })));
    expect(dangling.record.source).toBe(EXAMPLE);
    const malformed = createMemoryStore({ settings: { lastOpenDocId: 'bad' } });
    await malformed.putDocument({ id: 'bad', source: 42 } as unknown as DocumentRecord);
    expect((await bootDocument(deps(malformed))).record.source).toBe(EXAMPLE);
  });

  it('an engine or theme no longer registered falls back to the default', async () => {
    const store = createMemoryStore({ documents: [stored('d', 'x\n', { engineId: 'sgl.gone', themeId: 'retired' })], settings: { lastOpenDocId: 'd' } });
    const { record } = await bootDocument(deps(store));
    expect(record).toMatchObject({ engineId: 'sgl.grid', themeId: 'neutral-light', source: 'x\n' });
  });

  it('storage failing: the example still opens, in memory, with a notice', async () => {
    const failing: DocumentStore = {
      getDocument: async () => Promise.reject(new Error('no idb')),
      putDocument: async () => Promise.reject(new Error('no idb')),
      listDocuments: async () => Promise.reject(new Error('no idb')),
      getSetting: async () => Promise.reject(new Error('no idb')),
      putSetting: async () => Promise.reject(new Error('no idb')),
    };
    const result = await bootDocument(deps(failing));
    expect(result.record.source).toBe(EXAMPLE);
    expect(result.notices).toEqual(['storage-failed']);
  });
});

describe('boot with a share link', () => {
  it('opens it as a NEW document, keeps the current one, remembers the new one, and clears the hash', async () => {
    const current = stored('doc-a', 'mine: "Mine"\n');
    const store = createMemoryStore({ documents: [current], settings: { lastOpenDocId: 'doc-a' } });
    const fragment = await encodeShareFragment({ source: 'shared: "Shared"\n', engineId: 'sgl.grid', themeId: 'neutral-dark' });

    const result = await bootDocument(deps(store, { hash: `#${fragment}` }));

    expect(result).toMatchObject({ created: true, clearHash: true, notices: ['share-opened'] });
    expect(result.record).toMatchObject({ id: 'new-1', source: 'shared: "Shared"\n', engineId: 'sgl.grid', themeId: 'neutral-dark' });
    expect(await store.getDocument('doc-a')).toEqual(current); // never overwritten
    expect(await store.getDocument('new-1')).toEqual(result.record);
    expect(await store.getSetting('lastOpenDocId')).toBe('new-1');
  });

  it("a link's unknown engine or theme falls back to the default", async () => {
    const fragment = await encodeShareFragment({ source: 'x\n', engineId: 'sgl.elk', themeId: 'sepia' });
    const { record } = await bootDocument(deps(createMemoryStore(), { hash: `#${fragment}` }));
    expect(record).toMatchObject({ engineId: 'sgl.grid', themeId: 'neutral-light' });
  });

  it('an invalid link: notice, hash cleared, and the last document opens', async () => {
    const current = stored('doc-a', 'mine\n');
    const store = createMemoryStore({ documents: [current], settings: { lastOpenDocId: 'doc-a' } });
    const result = await bootDocument(deps(store, { hash: '#s=%%%not-base64' }));
    expect(result).toEqual({ record: current, created: false, clearHash: true, notices: ['share-invalid'] });
  });

  it('an invalid link with no last document: notice, and the example', async () => {
    const result = await bootDocument(deps(createMemoryStore(), { hash: '#s=AAAA' }));
    expect(result.record.source).toBe(EXAMPLE);
    expect(result.notices).toEqual(['share-invalid']);
    expect(result.clearHash).toBe(true);
  });

  it('a share link while storage is failing still opens, in memory', async () => {
    const store = createMemoryStore();
    store.failPut = () => new Error('no space');
    const fragment = await encodeShareFragment({ source: 'shared\n' });
    const result = await bootDocument(deps(store, { hash: `#${fragment}` }));
    expect(result.record.source).toBe('shared\n');
    expect(result.notices).toEqual(['share-opened', 'storage-failed']);
  });
});
