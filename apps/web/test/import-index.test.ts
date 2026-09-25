import { effect } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { createImportIndex } from '../src/state/import-index.js';
import { createMemoryStore, type DocumentRecord, type DocumentStore } from '../src/state/storage.js';

/**
 * A9's stored-document index (DD-08 §15.2, I23, I24): a snapshot the app's
 * own writes keep current, synchronously, from the moment a write is issued.
 */

const rec = (id: string, extra: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id,
  title: id,
  source: `// ${id}\n`,
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-light',
  createdAt: 1,
  updatedAt: 10,
  ...extra,
});

describe('the import index', () => {
  it('holds every stored document, without its picture', async () => {
    const store = createMemoryStore({ documents: [rec('a', { lastGoodSvg: '<svg/>', fileName: 'a.sgl', group: 'g' }), rec('b')] });
    const index = await createImportIndex(store);
    expect(index.entry('a')?.value).toEqual({ id: 'a', title: 'a', source: '// a\n', updatedAt: 10, fileName: 'a.sgl', group: 'g' });
    expect(index.entry('b')?.value).toEqual({ id: 'b', title: 'b', source: '// b\n', updatedAt: 10 });
  });

  it('a write updates its entry synchronously, when it is issued, and never reads a lazy picture', async () => {
    const store = createMemoryStore({ documents: [rec('a')] });
    const index = await createImportIndex(store);
    const written = Object.defineProperty({ ...rec('a', { source: 'x\n', updatedAt: 20 }) }, 'lastGoodSvg', {
      get: () => {
        throw new Error('the index read lastGoodSvg');
      },
      enumerable: false,
    });
    const put = store.putDocument(written);
    expect(index.entry('a')?.value.source).toBe('x\n');
    await put;
    const fresh = store.putDocument(rec('new', { title: 'New one' }));
    expect(index.entry('new')?.value.title).toBe('New one');
    await fresh;
  });

  it('the wrapper is installed before the list is read, and a write issued after the list began wins over the listed record', async () => {
    const base = createMemoryStore({ documents: [rec('a', { source: 'stored\n' })] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: DocumentStore = {
      ...base,
      putDocument: (r) => base.putDocument(r),
      listDocuments: async () => {
        const listed = await base.listDocuments();
        await gate;
        return listed;
      },
    };
    const creating = createImportIndex(store);
    // Issued while the list is in flight: the wrapper is already there.
    const put = store.putDocument(rec('a', { source: 'newer\n', updatedAt: 30 }));
    release();
    const index = await creating;
    await put;
    expect(index.entry('a')?.value.source).toBe('newer\n');
  });

  it('names change only when a name, a group or the set of documents changes (I24)', async () => {
    const store = createMemoryStore({ documents: [rec('a'), rec('b')] });
    const index = await createImportIndex(store);
    let runs = 0;
    const dispose = effect(() => {
      void index.names.value;
      runs += 1;
    });
    await store.putDocument(rec('a', { source: 'edited\n', updatedAt: 11 }));
    expect(runs).toBe(1);
    await store.putDocument(rec('a', { title: 'renamed', updatedAt: 12 }));
    expect(runs).toBe(2);
    await store.putDocument(rec('c'));
    expect(runs).toBe(3);
    await store.putDocument(rec('c', { group: 'g' }));
    expect(runs).toBe(4);
    dispose();
  });

  it('only the written entry changes: an effect on another entry does not re-run (I24)', async () => {
    const store = createMemoryStore({ documents: [rec('a'), rec('b')] });
    const index = await createImportIndex(store);
    let runs = 0;
    const dispose = effect(() => {
      void index.entry('b')?.value;
      runs += 1;
    });
    await store.putDocument(rec('a', { source: 'edited\n', updatedAt: 11 }));
    await store.putDocument(rec('a', { source: 'edited\n', updatedAt: 11 }));
    expect(runs).toBe(1);
    await store.putDocument(rec('b', { source: 'b edited\n', updatedAt: 11 }));
    expect(runs).toBe(2);
    dispose();
  });

  it('refresh reads the store again: what another tab wrote arrives', async () => {
    const base = createMemoryStore({ documents: [rec('a')] });
    const store: DocumentStore = { ...base, putDocument: (r) => base.putDocument(r) };
    const index = await createImportIndex(store);
    // Another tab writes straight to storage, past this tab's wrapper.
    await base.putDocument(rec('a', { source: 'from another tab\n', updatedAt: 50 }));
    await base.putDocument(rec('z', { title: 'Zed' }));
    expect(index.entry('a')?.value.source).toBe('// a\n');
    await index.refresh();
    expect(index.entry('a')?.value.source).toBe('from another tab\n');
    expect(index.entry('z')?.value.title).toBe('Zed');
  });

  it('a record that is not a document record is left out', async () => {
    const store = createMemoryStore();
    await store.putDocument({ id: 'broken' } as unknown as DocumentRecord);
    const index = await createImportIndex(store);
    expect(index.entry('broken')).toBeUndefined();
  });
});
