import { FALLBACK_TITLE } from './title.js';
import type { ShareCodec } from './share.js';
import type { DocumentRecord, DocumentStore } from './storage.js';

/**
 * Which document the app opens (DD-08 §8, §9), DOM-free:
 *
 * 1. A share link (`#s=…`) opens as a **new** local document — never over the
 *    current one — and the hash is cleared so a reload does not re-import.
 * 2. An invalid share link gives the toast, the hash is cleared too, and boot
 *    carries on as if there were none.
 * 3. Otherwise the document this tab had open before it reloaded for an
 *    update (`reopenId`, F12), else `lastOpenDocId`'s.
 * 4. Otherwise a new document from the example.
 *
 * Storage failing at any step never stops the boot: the document opens in
 * memory and a notice says it will not be kept.
 */

/** `boot-failed`: boot itself threw, and the app mounted on the example in
 *  memory instead (`fallbackBoot`, `main.tsx`). */
export type BootNotice = 'share-opened' | 'share-invalid' | 'storage-failed' | 'boot-failed';

export interface BootDeps {
  readonly store: DocumentStore;
  /** `location.hash`. */
  readonly hash: string;
  readonly exampleSource: string;
  /** `newDocumentId(crypto, Date.now)` in the app (J2). If it throws anyway,
   *  boot falls back to `newDocumentId(undefined, now)`. */
  readonly newId: () => string;
  /** `Date.now()` in the app. */
  readonly now: () => number;
  readonly defaultEngineId: string;
  readonly defaultThemeId: string;
  readonly isKnownEngine: (id: string) => boolean;
  readonly isKnownTheme: (id: string) => boolean;
  readonly codec?: ShareCodec;
  /** The document this tab had open before reloading for a service-worker
   *  update (F12, `io/app-boot.ts`): opened ahead of `lastOpenDocId`, which
   *  another tab may have moved. */
  readonly reopenId?: string | undefined;
}

export interface BootResult {
  readonly record: DocumentRecord;
  /** Created during this boot (from a share link or the example) rather than
   *  read back from storage. */
  readonly created: boolean;
  /** The caller should `history.replaceState` the hash away. */
  readonly clearHash: boolean;
  readonly notices: readonly BootNotice[];
  /** What a share link's imported documents came to (A9, I28, I29). */
  readonly toasts?: readonly { readonly message: string; readonly kind: 'info' | 'error' }[];
}

/** A record read back from IndexedDB is data from an older build, possibly;
 *  anything without the fields the app reads is treated as missing rather
 *  than trusted. */
export function isDocumentRecord(value: unknown): value is DocumentRecord {
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

/** The slice of `Crypto` an id needs; both members optional, because
 *  `randomUUID` exists only in a secure context (plain http on a LAN IP has
 *  `crypto.getRandomValues` but no `crypto.randomUUID`). */
export interface IdSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
}

let idCounter = 0;

/**
 * A new document id (DD-08 §9, J2), and never a throw (fix round 1, item 8):
 * `crypto.randomUUID()` where it exists; else an RFC 4122 v4 UUID built from
 * `crypto.getRandomValues`, which insecure origins still have; else, with no
 * usable crypto at all, the time and a per-run counter — unique enough for
 * one browser's own document list, and no new dependency.
 */
export function newDocumentId(source: IdSource | undefined, now: () => number): string {
  try {
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
  } catch {
    // fall through
  }
  try {
    if (typeof source?.getRandomValues === 'function') {
      const b = source.getRandomValues(new Uint8Array(16));
      b[6] = (b[6]! & 0x0f) | 0x40; // version 4
      b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    // fall through
  }
  idCounter += 1;
  let at = 0;
  try {
    at = now();
  } catch {
    // keep 0: the counter alone still separates ids within this run
  }
  return `doc-${at.toString(36)}-${idCounter.toString(36)}`;
}

export function blankRecord(id: string, source: string, engineId: string, themeId: string, at: number): DocumentRecord {
  return {
    id,
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
}

/**
 * What the app mounts when boot itself throws (fix round 1, item 8;
 * `main.tsx`): the example as a new document, with the `boot-failed`
 * notice. Stores nothing — the caller pairs it with an in-memory store —
 * and cannot throw.
 */
export function fallbackBoot(deps: Pick<BootDeps, 'exampleSource' | 'now' | 'defaultEngineId' | 'defaultThemeId'>): BootResult {
  let at = 0;
  try {
    at = deps.now();
  } catch {
    // keep 0
  }
  const record = blankRecord(newDocumentId(globalThis.crypto as IdSource | undefined, () => at), deps.exampleSource, deps.defaultEngineId, deps.defaultThemeId, at);
  return { record, created: true, clearHash: false, notices: ['boot-failed'] };
}

/** What storing a new document needs: boot's, or the open tab's (F13). */
export type CreateDeps = Pick<BootDeps, 'store' | 'newId' | 'now'>;

/** `deps.newId`, falling back to `newDocumentId` if it throws. */
export function safeId(deps: CreateDeps): string {
  try {
    return deps.newId();
  } catch {
    return newDocumentId(undefined, deps.now);
  }
}

/** A new record, stored; `open` also remembers it as the one to open. A
 *  storage failure is a notice, never a throw. */
export async function create(deps: CreateDeps, notices: BootNotice[], source: string, engineId: string, themeId: string, extra?: Partial<DocumentRecord>, open = true): Promise<DocumentRecord> {
  const record = { ...blankRecord(safeId(deps), source, engineId, themeId, deps.now()), ...extra };
  try {
    await deps.store.putDocument(record);
    if (open) await deps.store.putSetting('lastOpenDocId', record.id);
  } catch {
    notices.push('storage-failed');
  }
  return record;
}

/** What the lazy `share` chunk's `importShare` needs. */
export type ShareImportDeps = CreateDeps & Pick<BootDeps, 'defaultEngineId' | 'defaultThemeId' | 'isKnownEngine' | 'isKnownTheme'>;

/** A link's documents, stored, and the main one to open (`importShare`). */
export type ShareImport = Pick<BootResult, 'record' | 'notices' | 'toasts'>;

export async function bootDocument(deps: BootDeps): Promise<BootResult> {
  const notices: BootNotice[] = [];
  const engineOr = (id: string | undefined): string => (id !== undefined && deps.isKnownEngine(id) ? id : deps.defaultEngineId);
  const themeOr = (id: string | undefined): string => (id !== undefined && deps.isKnownTheme(id) ? id : deps.defaultThemeId);

  // `share.ts` is loaded only for a link that has a payload (F9 fix round 1:
  // it is off the ordinary boot path, and the core bundle has no room for
  // it). A hash without `s=` is `none`, as `decodeShareFragment` says.
  const shareModule = new URLSearchParams(deps.hash.replace(/^#/, '')).has('s') ? await import('./share.js') : undefined;
  const share = shareModule ? await shareModule.decodeShareFragment(deps.hash, deps.codec) : ({ kind: 'none' } as const);
  const clearHash = share.kind !== 'none';
  if (shareModule && share.kind === 'ok') return { ...(await shareModule.importShare(deps, share.payload)), created: true, clearHash };
  if (share.kind === 'invalid') notices.push('share-invalid');

  try {
    // A tab reloading for an update reopens its own document (F12), not the
    // one last opened in any tab.
    for (const id of [deps.reopenId, await deps.store.getSetting('lastOpenDocId')]) {
      const stored: unknown = typeof id === 'string' ? await deps.store.getDocument(id) : undefined;
      if (isDocumentRecord(stored)) {
        const record: DocumentRecord = { ...stored, engineId: engineOr(stored.engineId), themeId: themeOr(stored.themeId) };
        return { record, created: false, clearHash, notices };
      }
    }
  } catch {
    notices.push('storage-failed');
  }

  const record = await create(deps, notices, deps.exampleSource, deps.defaultEngineId, deps.defaultThemeId);
  return { record, created: true, clearHash, notices: [...new Set(notices)] };
}
