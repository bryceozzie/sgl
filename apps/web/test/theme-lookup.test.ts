import { BUILT_IN, DEFAULT_THEME_ID } from '@sgl/theme';
import { describe, expect, it } from 'vitest';
import { shareImportDeps } from '../src/io/app-boot.js';
import { bootDocument } from '../src/state/boot.js';
import { encodeShareFragment } from '../src/state/share.js';
import { createMemoryStore, type DocumentRecord } from '../src/state/storage.js';

/**
 * F31: `BUILT_IN` has no prototype, so a name that is only an `Object`
 * property is not a built-in theme at any lookup: a stored record's theme and
 * a share link's `t=` (the app's real `isKnownTheme`, `shareImportDeps`) open
 * in the default theme, as a document's own `@theme` does (SGL5007). Before,
 * `constructor` counted as known and an `Object` method was resolved as a
 * theme.
 */

const NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];

const record = (themeId: string): DocumentRecord => ({
  id: 'doc-1',
  title: 'doc-1',
  source: 'a\n',
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId,
  createdAt: 10,
  updatedAt: 20,
});

describe('a theme name that is only an Object property is unknown everywhere (F31)', () => {
  it.each(NAMES)('BUILT_IN[%j] is undefined, and isKnownTheme says no', (name) => {
    expect(BUILT_IN[name]).toBeUndefined();
    expect(shareImportDeps(createMemoryStore()).isKnownTheme(name)).toBe(false);
  });

  it('every built-in theme is still known', () => {
    for (const id of Object.keys(BUILT_IN)) expect(shareImportDeps(createMemoryStore()).isKnownTheme(id), id).toBe(true);
  });

  it.each(NAMES)('a stored record whose theme is %j boots in the default theme', async (name) => {
    const store = createMemoryStore();
    await store.putDocument(record(name));
    await store.putSetting('lastOpenDocId', 'doc-1');
    const result = await bootDocument({ ...shareImportDeps(store), hash: '', exampleSource: 'x\n' });
    expect(result.record.id).toBe('doc-1');
    expect(result.record.themeId).toBe(DEFAULT_THEME_ID);
  });

  it.each(NAMES)('a share link with t=%s opens in the default theme', async (name) => {
    const encoded = await encodeShareFragment({ source: 'a\n', engineId: 'sgl.grid', themeId: name });
    if (!encoded.ok) throw new Error('encodeShareFragment failed');
    const result = await bootDocument({ ...shareImportDeps(createMemoryStore()), hash: encoded.fragment, exampleSource: 'x\n' });
    expect(result.notices).toContain('share-opened');
    expect(result.record.themeId).toBe(DEFAULT_THEME_ID);
  });
});
