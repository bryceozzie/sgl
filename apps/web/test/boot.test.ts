import { describe, expect, it } from 'vitest';
import { bootDocument, fallbackBoot, newDocumentId, type BootDeps } from '../src/state/boot.js';
import { encodeShareFragment, type SharePayload } from '../src/state/share.js';
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

async function fragmentFor(payload: SharePayload): Promise<string> {
  const result = await encodeShareFragment(payload);
  if (!result.ok) throw new Error('encodeShareFragment failed');
  return result.fragment;
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
    const fragment = await fragmentFor({ source: 'shared: "Shared"\n', engineId: 'sgl.grid', themeId: 'neutral-dark' });

    const result = await bootDocument(deps(store, { hash: `#${fragment}` }));

    expect(result).toMatchObject({ created: true, clearHash: true, notices: ['share-opened'] });
    expect(result.record).toMatchObject({ id: 'new-1', source: 'shared: "Shared"\n', engineId: 'sgl.grid', themeId: 'neutral-dark' });
    expect(await store.getDocument('doc-a')).toEqual(current); // never overwritten
    expect(await store.getDocument('new-1')).toEqual(result.record);
    expect(await store.getSetting('lastOpenDocId')).toBe('new-1');
  });

  it("a link's engine reaches the new record even when it is not the default (fix round 1, item 15)", async () => {
    const store = createMemoryStore();
    const fragment = await fragmentFor({ source: 'shared: "Shared"\n', engineId: 'sgl.grid' });
    const result = await bootDocument(
      deps(store, { hash: fragment, defaultEngineId: 'sgl.elk', isKnownEngine: (id) => id === 'sgl.grid' || id === 'sgl.elk' }),
    );
    expect(result.record.engineId).toBe('sgl.grid');
    expect((await store.getDocument(result.record.id))?.engineId).toBe('sgl.grid');
  });

  it("a link's unknown engine or theme falls back to the default", async () => {
    const fragment = await fragmentFor({ source: 'x\n', engineId: 'sgl.elk', themeId: 'sepia' });
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
    const fragment = await fragmentFor({ source: 'shared\n' });
    const result = await bootDocument(deps(store, { hash: `#${fragment}` }));
    expect(result.record.source).toBe('shared\n');
    expect(result.notices).toEqual(['share-opened', 'storage-failed']);
  });
});

describe('boot never rejects (fix round 1, item 8)', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('an id source that throws (crypto.randomUUID missing on an insecure origin) still boots, with an id', async () => {
    const store = createMemoryStore();
    const result = await bootDocument(
      deps(store, {
        newId: () => {
          throw new TypeError('crypto.randomUUID is not a function');
        },
      }),
    );
    expect(result.record.source).toBe(EXAMPLE);
    expect(result.record.id).toMatch(/\S/);
    expect(await store.getDocument(result.record.id)).toEqual(result.record);
    expect(await store.getSetting('lastOpenDocId')).toBe(result.record.id);
  });

  it('newDocumentId: randomUUID where it exists (secure contexts)', () => {
    expect(newDocumentId({ randomUUID: () => 'from-random-uuid' }, () => 0)).toBe('from-random-uuid');
  });

  it('newDocumentId: a v4 UUID from getRandomValues where randomUUID is absent (plain http on a LAN IP)', () => {
    const insecure = { getRandomValues: <T extends ArrayBufferView | null>(a: T): T => crypto.getRandomValues(a as Uint8Array) as T };
    const a = newDocumentId(insecure, () => 0);
    const b = newDocumentId(insecure, () => 0);
    expect(a).toMatch(UUID_V4);
    expect(b).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  it('newDocumentId: with no usable crypto at all, still a distinct id, and never a throw', () => {
    const broken = {
      randomUUID: () => {
        throw new Error('nope');
      },
      getRandomValues: () => {
        throw new Error('nope');
      },
    };
    const a = newDocumentId(broken, () => 1234);
    const b = newDocumentId(undefined, () => 1234);
    expect(a).toMatch(/\S/);
    expect(a).not.toBe(b);
  });

  it('fallbackBoot: the example document, in no store yet, with a notice — what main.tsx mounts if boot ever rejects', () => {
    const result = fallbackBoot({ exampleSource: EXAMPLE, now: () => 1000, defaultEngineId: 'sgl.grid', defaultThemeId: 'neutral-light' });
    expect(result.record).toMatchObject({ source: EXAMPLE, engineId: 'sgl.grid', themeId: 'neutral-light', engineOptions: {}, createdAt: 1000 });
    expect(result.record.id).toMatch(/\S/);
    expect(result).toMatchObject({ created: true, clearHash: false, notices: ['boot-failed'] });
  });
});

describe('boot with a share link that carries imported documents (A9, DD-08 §15.3: I29)', () => {
  const DOCS = [
    { n: 'classes', t: 'Shared classes', s: '@classes: { Svc: {} }\n' },
    { n: 'aws', t: 'AWS', s: 'lambda\n' },
  ];

  it('stores each as a new document in a new group with the main one, before the main one is remembered', async () => {
    const store = createMemoryStore({ documents: [stored('mine', 'mine\n')], settings: { lastOpenDocId: 'mine' } });
    const order: string[] = [];
    const tracking: DocumentStore = {
      ...store,
      putDocument: async (r) => {
        order.push(`doc:${r.id}`);
        await store.putDocument(r);
      },
      putSetting: async (k, v) => {
        order.push(`${k}:${String(v)}`);
        await store.putSetting(k, v);
      },
    };
    const hash = `#${await fragmentFor({ source: '@imports: ["./classes.sgl"]\napi: Svc\n', engineId: 'sgl.grid', imports: DOCS })}`;
    const result = await bootDocument(deps(tracking, { hash }));

    expect(result.record).toMatchObject({ id: 'new-4', source: '@imports: ["./classes.sgl"]\napi: Svc\n', group: 'new-1', engineId: 'sgl.grid' });
    expect(await store.getDocument('new-2')).toEqual({
      id: 'new-2',
      title: 'Shared classes',
      source: DOCS[0]!.s,
      fileName: 'classes.sgl',
      group: 'new-1',
      engineId: 'sgl.grid',
      engineOptions: {},
      themeId: 'neutral-light',
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(await store.getDocument('new-3')).toMatchObject({ title: 'AWS', fileName: 'aws.sgl', group: 'new-1' });
    expect(order).toEqual(['doc:new-2', 'doc:new-3', 'doc:new-4', 'lastOpenDocId:new-4']);
    expect(await store.getDocument('mine')).toEqual(stored('mine', 'mine\n'));
    expect(result.notices).toEqual([]);
    expect(result.toasts).toEqual([{ message: 'Opened the shared diagram and its 2 imported documents as new documents.', kind: 'info' }]);
  });

  it('opening the same link twice makes a second, separate group', async () => {
    const store = createMemoryStore();
    const hash = `#${await fragmentFor({ source: 'a\n', imports: DOCS })}`;
    let n = 0;
    const first = await bootDocument(deps(store, { hash, newId: () => `a-${(n += 1)}` }));
    const second = await bootDocument(deps(store, { hash, newId: () => `b-${(n += 1)}` }));
    expect(first.record.group).toBeDefined();
    expect(second.record.group).toBeDefined();
    expect(first.record.group).not.toBe(second.record.group);
    expect((await store.listDocuments()).length).toBe(6);
  });

  it('a bad bundle does not stop the main document opening; a toast says the imports could not be read', async () => {
    const store = createMemoryStore();
    const good = await fragmentFor({ source: 'a\n' });
    const result = await bootDocument(deps(store, { hash: `#${good}&i=not-a-deflate-stream` }));
    expect(result.record).toMatchObject({ source: 'a\n' });
    expect(result.record.group).toBeUndefined();
    expect(result.notices).toEqual(['share-opened']);
    expect(result.toasts).toEqual([{ message: 'Opened the shared diagram, but its imported documents could not be read.', kind: 'error' }]);
    expect(await store.listDocuments()).toHaveLength(1);
  });
});
