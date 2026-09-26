import { parse } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { createImportsRuntime } from '../src/state/imports.js';
import { createMemoryStore, type DocumentRecord } from '../src/state/storage.js';

/**
 * The lazy imports chunk's runtime (DD-08 §15.2, §15.3): what Share bundles
 * (I27: the closure of the last resolve, each document once, breadth first,
 * only those that resolved, under every name it was reached by), and the
 * index re-read when the tab becomes visible again (I23: another tab's
 * writes).
 */

const rec = (id: string, source: string, extra: Partial<DocumentRecord> = {}): DocumentRecord => ({
  id,
  title: `Title ${id}`,
  source,
  engineId: 'sgl.grid',
  engineOptions: {},
  themeId: 'neutral-light',
  createdAt: 1,
  updatedAt: 10,
  fileName: `${id}.sgl`,
  ...extra,
});

describe("Share's bundle: the import closure of the last resolve (I27)", () => {
  // main imports b and c (and one that is nowhere); b imports d, c imports
  // e, and e imports d and b again (both already carried). Breadth first:
  // b, c, then d, e (depth first would be b, c, e, d).
  const docs = [
    rec('main', '@imports: ["./b.sgl", { path: "./c.sgl", as: c }, "./nowhere.sgl"]\n'),
    rec('b', '@imports: ["./d.sgl"]\n@classes: { B: {} }\n'),
    rec('c', '@imports: ["./e.sgl"]\nnode\n'),
    rec('d', '@classes: { D: {} }\n'),
    rec('e', '@imports: ["./d.sgl", { path: "./b.sgl", as: bb }]\n'),
  ];

  it('each document once, in the order a breadth-first walk first reached it, only those that resolved', async () => {
    const runtime = await createImportsRuntime(createMemoryStore({ documents: docs }), undefined);
    runtime.resolve(parse(docs[0]!.source).ast, 'main');
    expect(runtime.bundle('main')).toEqual({
      docs: [
        { n: 'b', t: 'Title b', s: docs[1]!.source },
        { n: 'c', t: 'Title c', s: docs[2]!.source },
        { n: 'd', t: 'Title d', s: docs[3]!.source },
        { n: 'e', t: 'Title e', s: docs[4]!.source },
      ],
    });
  });

  it('is the last resolve of that document: another document, or none yet, bundles nothing', async () => {
    const runtime = await createImportsRuntime(createMemoryStore({ documents: docs }), undefined);
    expect(runtime.bundle('main')).toEqual({ docs: [] });
    runtime.resolve(parse(docs[0]!.source).ast, 'main');
    expect(runtime.bundle('b')).toEqual({ docs: [] });
  });

  it('follows the last resolve: an import removed from the text is no longer carried', async () => {
    const runtime = await createImportsRuntime(createMemoryStore({ documents: docs }), undefined);
    runtime.resolve(parse(docs[0]!.source).ast, 'main');
    runtime.resolve(parse('@imports: [{ path: "./c.sgl", as: c }]\n').ast, 'main');
    expect(runtime.bundle('main').docs.map((d) => d.n)).toEqual(['c', 'e', 'd', 'b']);
  });

  it('a document reached under two names is carried under each, so every import of it resolves for the recipient (fix round 1, item 7)', async () => {
    // `lib` answers to its file name and to its save name ("Title lib").
    const main = '@imports: ["./lib.sgl", { path: "./Title lib.sgl", as: t }]\nx: L\ny: t.L\n';
    const lib = '@imports: ["./d.sgl"]\n@classes: { L: { @shape: round } }\n';
    const runtime = await createImportsRuntime(createMemoryStore({ documents: [rec('main', main), rec('lib', lib), rec('d', '@classes: { D: {} }\n')] }), undefined);
    runtime.resolve(parse(main).ast, 'main');
    const { docs: carried } = runtime.bundle('main');
    expect(carried.map((d) => [d.n, d.s])).toEqual([
      ['lib', lib],
      ['title lib', lib],
      ['d', '@classes: { D: {} }\n'],
    ]);

    // The recipient's store, as boot writes it (I29): a group of new records.
    const received = createMemoryStore({
      documents: [rec('r-main', main, { group: 'g', fileName: undefined }), ...carried.map((d, i) => rec(`r${i}`, d.s, { title: d.t, fileName: `${d.n}.sgl`, group: 'g' }))],
    });
    const recipient = await createImportsRuntime(received, undefined);
    const { diagnostics } = recipient.resolve(parse(main).ast, 'r-main');
    expect(diagnostics).toEqual([]);
  });

  it('a received document never carries (or finds) the recipient\'s own documents (H2)', async () => {
    const store = createMemoryStore({
      documents: [rec('main', '@imports: ["./notes.sgl"]\n', { group: 'g' }), rec('notes', '@classes: { N: {} }\n')],
    });
    const runtime = await createImportsRuntime(store, undefined);
    const { diagnostics } = runtime.resolve(parse('@imports: ["./notes.sgl"]\n').ast, 'main');
    expect(diagnostics.map((d) => d.code)).toEqual(['SGL2017']);
    expect(runtime.bundle('main')).toEqual({ docs: [] });
  });
});

describe('the index is read again when the tab becomes visible (I23)', () => {
  function fakeVisibility() {
    const listeners: (() => void)[] = [];
    const target = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener(type: string, listener: () => void) {
        if (type === 'visibilitychange') listeners.push(listener);
      },
    };
    return {
      target,
      set(state: DocumentVisibilityState) {
        target.visibilityState = state;
        for (const l of listeners) l();
      },
    };
  }

  it("another tab's write arrives on `visible`, not on `hidden`", async () => {
    const store = createMemoryStore({ documents: [rec('lib', '@classes: { S: { @shape: round } }\n')] });
    // Another tab writes through its own store, not this tab's wrapper.
    const otherTab = store.putDocument.bind(store);
    const visibility = fakeVisibility();
    const runtime = await createImportsRuntime(store, visibility.target as unknown as Parameters<typeof createImportsRuntime>[1]);
    const shape = (): unknown => runtime.resolve(parse('@imports: ["./lib.sgl"]\n').ast, 'main').model.classes['S']?.config.shape;
    expect(shape()).toBe('round');

    await otherTab(rec('lib', '@classes: { S: { @shape: diamond } }\n', { updatedAt: 20 }));
    visibility.set('hidden');
    await new Promise((r) => setTimeout(r, 0));
    expect(shape()).toBe('round');

    visibility.set('visible');
    await expect.poll(shape).toBe('diamond');
  });
});
