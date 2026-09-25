import type { ImportAnswer, ImportHost } from '@sgl/core/imports';
import { openableExtension, sanitizeFileStem } from './filename.js';
import type { ImportIndex } from './import-index.js';

/**
 * A9's app host (DD-02 §10.1, DD-08 §15.2), part of the lazy `imports`
 * chunk: how an import path finds a stored document.
 *
 * - **I1, I2.** Only the path's last segment counts; one openable extension
 *   is stripped; the rest is sanitised as Save ▾ sanitises a title, NFC,
 *   lower-cased.
 * - **I3.** A document answers to its file name (`fileName`, from Open or a
 *   share bundle) and to its save name (its title, sanitised).
 * - **I4.** Four tiers, the first non-empty one wins: the importer's group
 *   by file name, then by save name, then the ungrouped documents by file
 *   name, then by save name. Another group's documents are never
 *   candidates (I30).
 * - **I5.** Several in the winning tier: the most recently updated, ties to
 *   the smaller id; `candidates` says how many (`SGL2018`).
 * - **I19.** A path that is not relative finds nothing (the linker has
 *   already refused it, `SGL2025`).
 *
 * It reads the index's `names` and the entries of the tier it picked from,
 * so the resolve calling it depends on exactly those (I24).
 */

/** A name, normalised (I2): sanitised, NFC, lower-cased. */
const normal = (stem: string): string => sanitizeFileStem(stem).normalize('NFC').toLowerCase();

/** The name a file name stands for: one openable extension stripped (I2). */
export const fileName = (name: string): string => normal(name.slice(0, name.length - (openableExtension(name)?.length ?? 0)));

/** The name an import path asks for: its last segment's (I1, I2). */
export const pathName = (path: string): string => fileName(path.split(/[\\/]/).pop() ?? '');

/** The name a document's title gives it: what Save ▾ would name it (I3). */
export const saveName = (title: string): string => normal(title);

/** DD-02 I19: relative paths only. */
export const isRelativePath = (path: string): boolean => path !== '' && !/^[\\/]|^[^\\/]*:/.test(path);

export function createStoreHost(index: ImportIndex): ImportHost {
  return {
    lookup(path: string, from: string | undefined): ImportAnswer | undefined {
      if (!isRelativePath(path)) return undefined;
      const want = pathName(path);
      const names = index.names.value;
      const group = from === undefined ? undefined : names.groupOf.get(from);
      const tiers: [ReadonlyMap<string, readonly string[]>, string | undefined][] = [
        [names.byFile, undefined],
        [names.bySave, undefined],
      ];
      if (group !== undefined) tiers.unshift([names.byFile, group], [names.bySave, group]);
      for (const [map, inGroup] of tiers) {
        const ids = (map.get(want) ?? []).filter((id) => names.groupOf.get(id) === inGroup);
        if (ids.length === 0) continue;
        const entries = ids.flatMap((id) => index.entry(id)?.value ?? []);
        const pick = entries.reduce((best, e) => (e.updatedAt > best.updatedAt || (e.updatedAt === best.updatedAt && e.id < best.id) ? e : best));
        return { key: pick.id, source: pick.source, candidates: ids.length, name: pick.fileName ?? pick.title };
      }
      return undefined;
    },
  };
}
