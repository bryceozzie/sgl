import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ImportAnswer, ImportHost } from '../src/imports.js';
import { stemOf } from './import-host.js';

/**
 * The Node file-system `ImportHost` the corpus runs on (DD-02 §10.8): a
 * document is its absolute file path, and an import path finds the
 * documents in the importer's own directory whose stem matches its stem —
 * the last segment, one openable extension stripped, NFC, case ignored
 * (I1, I2). The app's host also sanitises the stem as Save ▾ does and has
 * tiers and groups (DD-08 §15); a directory has neither. Several matches
 * are ambiguous (`SGL2018`), and the first file name in sorted order is
 * picked, so every run picks the same one.
 *
 * `root` is the document resolved at the top, the directory a lookup
 * without `from` searches; pass it as the linker's `self` too, so a
 * document importing itself is a cycle.
 */
export function fileSystemHost(root: string): ImportHost {
  return {
    lookup(path: string, from: string | undefined): ImportAnswer | undefined {
      const dir = dirname(from ?? root);
      const stem = stemOf(path);
      const matches = readdirSync(dir)
        .filter((name) => /\.(?:sgl\.json|sgl|json|txt)$/i.test(name) && stemOf(name) === stem)
        .sort();
      const name = matches[0];
      if (name === undefined) return undefined;
      const key = join(dir, name);
      return { key, source: readFileSync(key, 'utf8'), candidates: matches.length, name };
    },
  };
}
