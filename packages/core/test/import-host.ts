import type { ImportAnswer, ImportHost } from '../src/imports.js';

/**
 * An in-memory `ImportHost` for the core tests (DD-02 §10.8): documents by
 * name, matched by a path's stem — the last segment, one openable
 * extension stripped, case ignored (DD-02 I1, I2; the app's host adds Save
 * ▾'s sanitising and the tiers, DD-08 §15). A document is its own key. A
 * name several documents answer to is ambiguous (`candidates`), and the
 * first in sorted order is picked, so every run picks the same one.
 *
 * `calls` counts lookups, for the cache test.
 */
export interface MemoryHost extends ImportHost {
  calls: number;
  readonly docs: Record<string, string>;
}

export const stemOf = (path: string): string =>
  (path.split(/[\\/]/).pop() ?? '').replace(/\.(?:sgl\.json|sgl|json|txt)$/i, '').normalize('NFC').toLowerCase();

export function memoryHost(docs: Record<string, string>): MemoryHost {
  const host: MemoryHost = {
    calls: 0,
    docs,
    lookup(path: string): ImportAnswer | undefined {
      host.calls += 1;
      const stem = stemOf(path);
      const matches = Object.keys(docs)
        .filter((name) => stemOf(name) === stem)
        .sort();
      const key = matches[0];
      if (key === undefined) return undefined;
      return { key, source: docs[key] as string, candidates: matches.length, name: key };
    },
  };
  return host;
}
