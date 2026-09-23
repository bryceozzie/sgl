import { FALLBACK_TITLE } from './filename.js';
import { decodeShareFragment, NATIVE_SHARE_CODEC, type ShareCodec } from './share.js';
import type { DocumentRecord, DocumentStore } from './storage.js';

/**
 * Which document the app opens (DD-08 §8, §9), DOM-free:
 *
 * 1. A share link (`#s=…`) opens as a **new** local document — never over the
 *    current one — and the hash is cleared so a reload does not re-import.
 * 2. An invalid share link gives the toast, the hash is cleared too, and boot
 *    carries on as if there were none.
 * 3. Otherwise `lastOpenDocId`'s document.
 * 4. Otherwise a new document from the example.
 *
 * Storage failing at any step never stops the boot: the document opens in
 * memory and a notice says it will not be kept.
 */

export type BootNotice = 'share-opened' | 'share-invalid' | 'storage-failed';

export interface BootDeps {
  readonly store: DocumentStore;
  /** `location.hash`. */
  readonly hash: string;
  readonly exampleSource: string;
  /** `crypto.randomUUID()` in the app (J2). */
  readonly newId: () => string;
  /** `Date.now()` in the app. */
  readonly now: () => number;
  readonly defaultEngineId: string;
  readonly defaultThemeId: string;
  readonly isKnownEngine: (id: string) => boolean;
  readonly isKnownTheme: (id: string) => boolean;
  readonly codec?: ShareCodec;
}

export interface BootResult {
  readonly record: DocumentRecord;
  /** Created during this boot (from a share link or the example) rather than
   *  read back from storage. */
  readonly created: boolean;
  /** The caller should `history.replaceState` the hash away. */
  readonly clearHash: boolean;
  readonly notices: readonly BootNotice[];
}

/** A record read back from IndexedDB is data from an older build, possibly;
 *  anything without the fields the app reads is treated as missing rather
 *  than trusted. */
function isDocumentRecord(value: unknown): value is DocumentRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.source === 'string' &&
    typeof r.engineId === 'string' &&
    typeof r.themeId === 'string' &&
    typeof r.engineOptions === 'object' &&
    r.engineOptions !== null &&
    (r.lastGoodSvg === undefined || typeof r.lastGoodSvg === 'string')
  );
}

export async function bootDocument(deps: BootDeps): Promise<BootResult> {
  const notices: BootNotice[] = [];
  const engineOr = (id: string | undefined): string => (id !== undefined && deps.isKnownEngine(id) ? id : deps.defaultEngineId);
  const themeOr = (id: string | undefined): string => (id !== undefined && deps.isKnownTheme(id) ? id : deps.defaultThemeId);

  async function create(source: string, engineId: string, themeId: string): Promise<DocumentRecord> {
    const at = deps.now();
    const record: DocumentRecord = {
      id: deps.newId(),
      // Replaced by the session's first save, from the pipeline's own model
      // (the app never parses on its own, DD-08 §4).
      title: FALLBACK_TITLE,
      source,
      engineId,
      engineOptions: {},
      themeId,
      createdAt: at,
      updatedAt: at,
    };
    try {
      await deps.store.putDocument(record);
      await deps.store.putSetting('lastOpenDocId', record.id);
    } catch {
      notices.push('storage-failed');
    }
    return record;
  }

  const share = await decodeShareFragment(deps.hash, deps.codec ?? NATIVE_SHARE_CODEC);
  const clearHash = share.kind !== 'none';
  if (share.kind === 'ok') {
    const { source, engineId, themeId } = share.payload;
    const record = await create(source, engineOr(engineId), themeOr(themeId));
    return { record, created: true, clearHash, notices: ['share-opened', ...notices] };
  }
  if (share.kind === 'invalid') notices.push('share-invalid');

  try {
    const lastId = await deps.store.getSetting('lastOpenDocId');
    if (typeof lastId === 'string') {
      const stored: unknown = await deps.store.getDocument(lastId);
      if (isDocumentRecord(stored)) {
        const record: DocumentRecord = { ...stored, engineId: engineOr(stored.engineId), themeId: themeOr(stored.themeId) };
        return { record, created: false, clearHash, notices };
      }
    }
  } catch {
    notices.push('storage-failed');
  }

  const record = await create(deps.exampleSource, deps.defaultEngineId, deps.defaultThemeId);
  return { record, created: true, clearHash, notices: [...new Set(notices)] };
}
