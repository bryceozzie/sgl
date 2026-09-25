import { describe, expect, it } from 'vitest';
import { createImportIndex } from '../src/state/import-index.js';
import { createStoreHost, pathName, saveName } from '../src/state/import-host.js';
import { createMemoryStore, type DocumentRecord } from '../src/state/storage.js';

/**
 * A9's app host (DD-02 §10.1, DD-08 §15.2): how an import path finds a
 * stored document — I1–I5, I19, and the group isolation of I30.
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

async function hostOver(records: readonly DocumentRecord[]) {
  const store = createMemoryStore({ documents: records });
  const index = await createImportIndex(store);
  return { store, index, host: createStoreHost(index) };
}

describe('names (I1, I2, I3)', () => {
  it.each([
    ['./shared/classes.sgl', 'classes'],
    ['./classes.sgl', 'classes'],
    ['../x/classes.sgl', 'classes'],
    ['classes', 'classes'],
    ['.\\win\\Classes.SGL', 'classes'],
    ['./classes.sgl.json', 'classes'],
    ['./classes.json', 'classes'],
    ['./classes.txt', 'classes'],
    ['./v1.2 classes', 'v1.2 classes'],
    ['./a/b:c.sgl', 'b-c'],
    ['./Ｃｌａｓｓｅｓ.sgl', 'ｃｌａｓｓｅｓ'],
    ['./é.sgl', 'é'],
  ])('%s is the name %j', (path, name) => {
    expect(pathName(path)).toBe(name);
  });

  it('a save name is the title sanitised as Save ▾ does, lower-cased', () => {
    expect(saveName('Shared Classes')).toBe('shared classes');
    expect(saveName('a/b')).toBe('a-b');
    expect(saveName('')).toBe('diagram');
  });
});

describe('lookup (I4, I5)', () => {
  it('a document answers to its file name and to its save name', async () => {
    const { host } = await hostOver([rec('f', { title: 'Something else', fileName: 'classes.sgl' }), rec('t', { title: 'Shared Classes' })]);
    expect(host.lookup('./classes.sgl', 'me')).toMatchObject({ key: 'f', candidates: 1 });
    expect(host.lookup('./Shared Classes.sgl', 'me')).toMatchObject({ key: 't', candidates: 1 });
    expect(host.lookup('./nothing.sgl', 'me')).toBeUndefined();
  });

  it('the file name tier wins over the save name tier', async () => {
    const { host } = await hostOver([rec('by-title', { title: 'classes' }), rec('by-file', { title: 'X', fileName: 'Classes.sgl' })]);
    expect(host.lookup('./classes.sgl', undefined)).toMatchObject({ key: 'by-file', candidates: 1 });
  });

  it('several in the winning tier: the most recently updated, ties to the smaller id, and the count (SGL2018)', async () => {
    const { host } = await hostOver([rec('b', { title: 'lib', updatedAt: 5 }), rec('c', { title: 'lib', updatedAt: 9 }), rec('a', { title: 'lib', updatedAt: 9 })]);
    expect(host.lookup('./lib.sgl', undefined)).toMatchObject({ key: 'a', candidates: 3, source: '// a\n' });
  });

  it('a path that is not relative finds nothing (I19)', async () => {
    const { host } = await hostOver([rec('x', { fileName: 'classes.sgl' })]);
    for (const path of ['/classes.sgl', '\\classes.sgl', '//host/classes.sgl', 'https://x/classes.sgl', 'C:classes.sgl', '']) expect(host.lookup(path, undefined)).toBeUndefined();
  });
});

describe('groups (I4, I30)', () => {
  const records = [
    rec('mine', { title: 'classes', updatedAt: 99 }),
    rec('mine-main', { title: 'main' }),
    rec('bundled', { title: 'Shared', fileName: 'classes.sgl', group: 'g1' }),
    rec('bundled-main', { title: 'main', group: 'g1' }),
    rec('other-bundle', { title: 'classes', fileName: 'classes.sgl', group: 'g2', updatedAt: 1000 }),
    rec('only-ungrouped', { title: 'extra' }),
  ];

  it("a grouped document finds its own group's first, even over a newer ungrouped one", async () => {
    const { host } = await hostOver(records);
    expect(host.lookup('./classes.sgl', 'bundled-main')).toMatchObject({ key: 'bundled', candidates: 1 });
  });

  it('what its group does not have falls through to the ungrouped documents', async () => {
    const { host } = await hostOver(records);
    expect(host.lookup('./extra.sgl', 'bundled-main')).toMatchObject({ key: 'only-ungrouped' });
  });

  it("an ungrouped document never sees any group's documents: a bundle cannot change how your documents resolve", async () => {
    const { host } = await hostOver(records);
    expect(host.lookup('./classes.sgl', 'mine-main')).toMatchObject({ key: 'mine', candidates: 1 });
    expect(host.lookup('./Shared.sgl', 'mine-main')).toBeUndefined();
  });

  it("another group's documents are never candidates", async () => {
    const { host } = await hostOver(records);
    expect(host.lookup('./Shared.sgl', 'other-bundle')).toBeUndefined();
  });
});
