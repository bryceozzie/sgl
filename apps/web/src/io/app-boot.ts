import { elkDescriptor } from '@sgl/layout-elk/descriptor';
import type { LayoutEngine } from '@sgl/layout-api';
import { fixedDescriptor, gridDescriptor, treeDescriptor } from '@sgl/layout-std/descriptor';
import { BUILT_IN, DEFAULT_THEME_ID } from '@sgl/theme';
import EXAMPLE_SOURCE from '../examples/checkout.sgl?raw';
import { bootDocument, fallbackBoot, newDocumentId, type BootResult, type IdSource, type ShareImportDeps } from '../state/boot.js';
import type { SharePayload } from '../state/share.js';
import { lazyChunk } from '../state/lazy.js';
import { createShareLinkQueue } from '../state/share-links.js';
import { createMemoryStore, type DocumentStore } from '../state/storage.js';
import { openIdbStore } from '../state/storage-idb.js';

/** What the app keeps of an engine's descriptor: the picker's, the help
 *  reference's and the `@layout` checks' view of it. Exported so a test can
 *  list a stub engine the way the real ones are listed (fix round 1, item 5). */
export function registeredEngine(e: Pick<LayoutEngine, 'id' | 'name' | 'capabilities' | 'optionsSchema' | 'hintsSchema'>) {
  return {
    id: e.id,
    name: e.name,
    determinism: e.capabilities.determinism,
    // The help reference lists them (DD-13 P4, `reference/build.ts`).
    capabilities: e.capabilities,
    // What SGL4010 checks `@layout` keys against (fix round 1, item 23).
    ...(e.optionsSchema !== undefined && { optionsSchema: e.optionsSchema }),
    ...(e.hintsSchema !== undefined && { hintsSchema: e.hintsSchema }),
    // SGL4021 (DD-12 N6): an engine that does not honour `@pin` warns at it.
    ...(e.capabilities.pins === true && { pins: true }),
  };
}

/** The engines actually registered in `apps/web/src/layout.worker.ts`: `elk`,
 *  `grid`, `fixed` (feat/b5-fixed, DD-12 H9: static, like `grid`) and `tree`
 *  (feat/b5-tree: its layout code is the worker's lazy `std-trees` chunk). Read from the same objects the worker registers — `elk`'s
 *  descriptor entry, which carries everything but `layout()` and so none of
 *  elkjs (Stage K, K1), and `grid`'s, which leaves its packing code to the
 *  worker (F20) — rather than duplicated by hand, so the picker cannot list
 *  something the worker does not actually run. */
export const REGISTERED_ENGINES = [elkDescriptor, gridDescriptor, fixedDescriptor, treeDescriptor].map(registeredEngine);

/** ADR-0005: `elk` is the default engine (Stage K undoes Stage I's interim
 *  `grid` default, decision I1). A stored document keeps its own `engineId`. */
export const DEFAULT_ENGINE_ID = elkDescriptor.id;

export interface AppBoot extends BootResult {
  readonly store: DocumentStore;
}

/**
 * The DOM half of boot (DD-08 §9): open IndexedDB (falling back to memory),
 * pick the document (`state/boot.ts`), and clear a share hash so a reload
 * does not re-import it (§8). Runs before the first render, so the stored
 * `lastGoodSvg` is on screen before fonts or the worker are ready (§5).
 *
 * **Never rejects** (fix round 1, item 8): a storage failure falls back to
 * memory, and anything else that throws gives `bootFallback()` — the example
 * in memory, with a notice — rather than a blank page.
 */
export async function bootApp(): Promise<AppBoot> {
  try {
    return await bootFromStorage();
  } catch (err) {
    console.error('[SGL] boot failed; opening the example in memory.', err);
    return bootFallback();
  }
}

/** The example document on an in-memory store, with the `boot-failed`
 *  notice: what the app mounts when boot cannot complete (`main.tsx`). */
export function bootFallback(): AppBoot {
  return {
    ...fallbackBoot({ exampleSource: EXAMPLE_SOURCE, now: () => Date.now(), defaultEngineId: DEFAULT_ENGINE_ID, defaultThemeId: DEFAULT_THEME_ID }),
    store: createMemoryStore(),
  };
}

async function bootFromStorage(): Promise<AppBoot> {
  let store: DocumentStore;
  let storageFailed = false;
  try {
    store = await openIdbStore();
  } catch (err) {
    console.warn('[SGL] IndexedDB is unavailable; documents will not be kept.', err);
    store = createMemoryStore();
    storageFailed = true;
  }

  const result = await bootDocument({ ...shareImportDeps(store), hash: window.location.hash, exampleSource: EXAMPLE_SOURCE, reopenId: session(REOPEN_KEY) });

  if (result.clearHash) clearHash();

  const notices = storageFailed && !result.notices.includes('storage-failed') ? [...result.notices, 'storage-failed' as const] : result.notices;
  return { ...result, notices, store };
}

/** How a new document gets its id, time, engine and theme (DD-08 §8, §9):
 *  boot's, and a pasted share link's (F13). */
export function shareImportDeps(store: DocumentStore): ShareImportDeps {
  return {
    store,
    // `crypto.randomUUID` only exists in a secure context; plain http on a
    // LAN address has only `getRandomValues` (`newDocumentId`).
    newId: () => newDocumentId(globalThis.crypto as IdSource | undefined, () => Date.now()),
    now: () => Date.now(),
    defaultEngineId: DEFAULT_ENGINE_ID,
    defaultThemeId: DEFAULT_THEME_ID,
    isKnownEngine: (id) => REGISTERED_ENGINES.some((e) => e.id === id),
    isKnownTheme: (id) => BUILT_IN[id] !== undefined,
  };
}

/** `sessionStorage` key: the document this tab had open when it reloaded
 *  for a service-worker update (F12). Per tab and surviving the reload, so
 *  each tab comes back to its own document, not the last opened anywhere. */
const REOPEN_KEY = 'sgl-reopen';

/** Reads and removes `key` from this tab's `sessionStorage`; with `value`,
 *  stores it instead. `undefined` where storage is unavailable. */
function session(key: string, value?: string): string | undefined {
  try {
    if (value !== undefined) {
      sessionStorage.setItem(key, value);
      return value;
    }
    const stored = sessionStorage.getItem(key) ?? undefined;
    sessionStorage.removeItem(key);
    return stored;
  } catch {
    return undefined;
  }
}

/** Before a reload for an update: reopen `docId` after it (F12). */
export function reopenAfterReload(docId: string): void {
  session(REOPEN_KEY, docId);
}

function clearHash(): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

export interface ShareLinkWatch {
  /** A valid link: store its documents and switch to the main one in place
   *  (`importShare`, then Open's switch). Resolves once it is open. */
  readonly open: (payload: SharePayload, share: typeof import('../state/share.js')) => Promise<void>;
  /** An invalid link: DD-08 §8's toast. */
  readonly onInvalid: () => void;
}

/** `share.ts`, a lazy chunk (F9 fix round 1), precached like the rest; a
 *  failed load is reported and retried (`state/lazy.ts`). */
const loadShare = lazyChunk(() => import('../state/share.js'));

/**
 * DD-08 §8's "decode on load", for a link pasted into a tab that already has
 * SGL open: that is a same-document fragment change, which fires `hashchange`
 * and never reloads, so boot would never see it (fix round 1, item 14).
 *
 * A valid link is imported **in place** (F13): `watch.open` stores it with
 * boot's own `importShare` and switches to it as Open does — the open
 * document flushed, a fresh undo history, no reload — so a tab on the
 * in-memory store (IndexedDB unavailable) keeps its documents. One link at a
 * time, the hash cleared before each is imported (`state/share-links.ts`).
 * An invalid link toasts, clears the hash and leaves the open document as
 * it is. Returns the unsubscribe.
 */
export function watchShareLinks(watch: ShareLinkWatch): () => void {
  const onHashChange = createShareLinkQueue({
    hash: () => window.location.hash,
    clearHash,
    decode: async (hash) => (await loadShare()).decodeShareFragment(hash),
    open: async (payload) => watch.open(payload, await loadShare()),
    onInvalid: watch.onInvalid,
  });
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}
