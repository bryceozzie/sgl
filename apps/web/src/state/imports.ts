import type { Document } from '@sgl/core';
import { compileImports, createImportCache, createImportLinker, resolveImports, type LinkedDocument, type RootImportLinker } from '@sgl/core/imports';
import { createStoreHost, pathName } from './import-host.js';
import { createImportIndex } from './import-index.js';
import type { DocumentStore } from './storage.js';
import type { ImportsRuntime } from './types.js';

/**
 * The lazy `imports` chunk's entry (A9, DD-08 §15): `@sgl/core/imports`,
 * the stored-document index and the host, loaded by the pipeline the first
 * time a document has `@imports` (I25), and precached like every chunk.
 */

/** One document a share link carries (DD-08 §15.3, I26): the name it was
 *  imported by, its title and its source. */
export interface BundledDocument {
  readonly n: string;
  readonly t: string;
  readonly s: string;
}

export interface ShareBundle {
  /** One entry per name the closure reached a document by: a document
   *  imported under two names is carried under both, so each import of it
   *  resolves for the recipient (fix round 1). One name never leads to two
   *  documents in one closure, since every lookup in it stays inside one
   *  group, or among the ungrouped documents (H2). */
  readonly docs: readonly BundledDocument[];
}

export interface AppImportsRuntime extends ImportsRuntime {
  /** The import closure of the last resolve of `self` (I27): breadth
   *  first, only documents that resolved, under every name they were
   *  reached by. */
  bundle(self: string): ShareBundle;
}

/**
 * `store`'s `putDocument` is wrapped before its documents are listed (I23).
 * `visibility` is the document whose `visibilitychange` re-reads the store
 * (another tab's writes); `undefined` in a test. One linker for the open
 * document (`self`, so a document importing itself is a cycle) and one
 * `ImportCache` for as long as the pipeline lives.
 */
export async function createImportsRuntime(store: DocumentStore, visibility: Pick<globalThis.Document, 'addEventListener' | 'visibilityState'> | undefined = globalThis.document): Promise<AppImportsRuntime> {
  const index = await createImportIndex(store);
  const host = createStoreHost(index);
  const cache = createImportCache();
  let linker: { readonly self: string; readonly linker: RootImportLinker } | undefined;
  let last: { readonly self: string; readonly linked: readonly LinkedDocument[] } | undefined;
  visibility?.addEventListener('visibilitychange', () => {
    if (visibility.visibilityState === 'visible') void index.refresh();
  });

  return {
    resolve(ast: Document, self: string) {
      if (linker?.self !== self) linker = { self, linker: createImportLinker(host, { self, cache }) };
      const result = resolveImports(ast, linker.linker);
      last = { self, linked: linker.linker.linked() };
      return result;
    },
    compile: (model) => compileImports(model),
    bundle(self) {
      const children = new Map<string | undefined, LinkedDocument[]>();
      for (const l of last?.self === self ? last.linked : []) (children.get(l.from) ?? children.set(l.from, []).get(l.from)!).push(l);
      const docs: BundledDocument[] = [];
      const names = new Set<string>();
      const seen = new Set([self]);
      const queue = [self];
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        for (const l of children.get(key) ?? []) {
          const n = pathName(l.path);
          const entry = index.entry(l.key)?.peek();
          if (entry !== undefined && !names.has(n)) {
            names.add(n);
            docs.push({ n, t: entry.title, s: entry.source });
          }
          if (seen.has(l.key)) continue;
          seen.add(l.key);
          queue.push(l.key);
        }
      }
      return { docs };
    },
  };
}
