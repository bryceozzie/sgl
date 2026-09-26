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
 * - **I4.** Tiers, the first non-empty one wins: by file name, then by
 *   save name, among the importer's own group's documents when it is in
 *   one, and among the ungrouped documents when it is not. Another group's
 *   documents are never candidates (I30), and a grouped document never
 *   imports an ungrouped one (human decision H2, 2026-09-26): what a share
 *   link brought resolves only within what came with it.
 * - **Fix round 1, item 9.** A path whose last segment names nothing
 *   (`./`, `.`, `sub/`, `..`) finds nothing: it is not the save name of an
 *   untitled document.
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

/** The last segment of an import path (I1). */
const lastSegment = (path: string): string => path.split(/[\\/]/).pop() ?? '';

/** The name an import path asks for: its last segment's (I1, I2). */
export const pathName = (path: string): string => fileName(lastSegment(path));

/** The name a document's title gives it: what Save ▾ would name it (I3). */
export const saveName = (title: string): string => normal(title);

/** DD-02 I19: relative paths only. */
export const isRelativePath = (path: string): boolean => path !== '' && !/^[\\/]|^[^\\/]*:/.test(path);

export function createStoreHost(index: ImportIndex): ImportHost {
  return {
    lookup(path: string, from: string | undefined): ImportAnswer | undefined {
      const segment = lastSegment(path);
      if (!isRelativePath(path) || /^\.*$/.test(segment.slice(0, segment.length - (openableExtension(segment)?.length ?? 0)))) return undefined;
      const want = fileName(segment);
      const names = index.names.value;
      const group = from === undefined ? undefined : names.groupOf.get(from);
      for (const map of [names.byFile, names.bySave]) {
        const ids = (map.get(want) ?? []).filter((id) => names.groupOf.get(id) === group);
        if (ids.length === 0) continue;
        const entries = ids.flatMap((id) => index.entry(id)?.value ?? []);
        const pick = entries.reduce((best, e) => (e.updatedAt > best.updatedAt || (e.updatedAt === best.updatedAt && e.id < best.id) ? e : best));
        return { key: pick.id, source: pick.source, candidates: ids.length, name: pick.fileName ?? pick.title };
      }
      return undefined;
    },
  };
}
