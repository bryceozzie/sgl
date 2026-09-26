import { parse } from '@sgl/core';
import { describe, expect, it } from 'vitest';
import { createImportsRuntime } from '../src/state/imports.js';
import { createMemoryStore, type DocumentRecord } from '../src/state/storage.js';

/**
 * The lazy imports chunk's runtime (DD-08 §15.2, §15.3): what Share bundles
 * (I27: the closure of the last resolve, each document once, breadth first,
 * only those that resolved, and a name that led to two documents), and the
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
      differ: [],
    });
  });

  it('is the last resolve of that document: another document, or none yet, bundles nothing', async () => {
    const runtime = await createImportsRuntime(createMemoryStore({ documents: docs }), undefined);
    expect(runtime.bundle('main')).toEqual({ docs: [], differ: [] });
    runtime.resolve(parse(docs[0]!.source).ast, 'main');
    expect(runtime.bundle('b')).toEqual({ docs: [], differ: [] });
  });

  it('follows the last resolve: an import removed from the text is no longer carried', async () => {
    const runtime = await createImportsRuntime(createMemoryStore({ documents: docs }), undefined);
    runtime.resolve(parse(docs[0]!.source).ast, 'main');
    runtime.resolve(parse('@imports: [{ path: "./c.sgl", as: c }]\n').ast, 'main');
    expect(runtime.bundle('main').docs.map((d) => d.n)).toEqual(['c', 'e', 'd', 'b']);
  });

  it('a name that led to two documents: the first is carried, and the name is reported', async () => {
    // main is in a group with its own `lib`; the ungrouped `x` it also
    // imports finds the ungrouped `lib` (I4). Both are `lib`.
    const store = createMemoryStore({
      documents: [
        rec('main', '@imports: ["./lib.sgl", "./x.sgl"]\n', { group: 'g' }),
        rec('lib1', '@classes: { L: { @shape: round } }\n', { group: 'g', fileName: 'lib.sgl' }),
        rec('x', '@imports: ["./lib.sgl"]\n'),
        rec('lib2', '@classes: { L: { @shape: diamond } }\n', { fileName: 'lib.sgl' }),
      ],
    });
    const runtime = await createImportsRuntime(store, undefined);
    runtime.resolve(parse('@imports: ["./lib.sgl", "./x.sgl"]\n').ast, 'main');
    const { docs: carried, differ } = runtime.bundle('main');
    expect(carried.map((d) => [d.n, d.s])).toEqual([
      ['lib', '@classes: { L: { @shape: round } }\n'],
      ['x', '@imports: ["./lib.sgl"]\n'],
    ]);
    expect(differ).toEqual(['lib']);
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
