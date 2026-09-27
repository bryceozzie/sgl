import { elkDescriptor } from '@sgl/layout-elk/descriptor';
import { gridDescriptor } from '@sgl/layout-std/descriptor';
import { BUILT_IN, DEFAULT_THEME_ID } from '@sgl/theme';
import EXAMPLE_SOURCE from '../examples/checkout.sgl?raw';
import { bootDocument, fallbackBoot, newDocumentId, type BootResult, type IdSource } from '../state/boot.js';
import { createMemoryStore, type DocumentStore } from '../state/storage.js';
import { openIdbStore } from '../state/storage-idb.js';

/** The engines actually registered in `apps/web/src/layout.worker.ts`: `elk`
 *  and `grid`. Read from the same objects the worker registers — `elk`'s
 *  descriptor entry, which carries everything but `layout()` and so none of
 *  elkjs (Stage K, K1), and `grid`'s, which leaves its packing code to the
 *  worker (F20) — rather than duplicated by hand, so the picker cannot list
 *  something the worker does not actually run. */
export const REGISTERED_ENGINES = [elkDescriptor, gridDescriptor].map((e) => ({
  id: e.id,
  name: e.name,
  determinism: e.capabilities.determinism,
  // What SGL4010 checks `@layout` keys against (fix round 1, item 23).
  ...(e.optionsSchema !== undefined && { optionsSchema: e.optionsSchema }),
  ...(e.hintsSchema !== undefined && { hintsSchema: e.hintsSchema }),
  // SGL4021 (DD-12 N6): an engine that does not honour `@pin` warns at it.
  ...(e.capabilities.pins === true && { pins: true }),
}));

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

  const result = await bootDocument({
    store,
    hash: window.location.hash,
    exampleSource: EXAMPLE_SOURCE,
    // `crypto.randomUUID` only exists in a secure context; plain http on a
    // LAN address has only `getRandomValues` (`newDocumentId`).
    newId: () => newDocumentId(globalThis.crypto as IdSource | undefined, () => Date.now()),
    now: () => Date.now(),
    defaultEngineId: DEFAULT_ENGINE_ID,
    defaultThemeId: DEFAULT_THEME_ID,
    isKnownEngine: (id) => REGISTERED_ENGINES.some((e) => e.id === id),
    isKnownTheme: (id) => BUILT_IN[id] !== undefined,
  });

  if (result.clearHash) clearHash();

  const notices = storageFailed && !result.notices.includes('storage-failed') ? [...result.notices, 'storage-failed' as const] : result.notices;
  return { ...result, notices, store };
}

function clearHash(): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

export interface ShareLinkWatch {
  /** Writes the open document's pending autosave now (DD-08 §9). */
  readonly flush: () => Promise<void>;
  /** An invalid link: DD-08 §8's toast. */
  readonly onInvalid: () => void;
}

/**
 * DD-08 §8's "decode on load", for a link pasted into a tab that already has
 * SGL open: that is a same-document fragment change, which fires `hashchange`
 * and never reloads, so boot would never see it (fix round 1, item 14).
 *
 * A valid link is imported **exactly as boot does** — by boot itself: the
 * open document's pending edit is flushed, then the page reloads with the
 * hash still in place, and `bootApp` makes the new local document, toasts
 * and clears the hash. One import path, not two that could drift; the cost
 * is a reload, which a pasted link implies anyway. An invalid link toasts,
 * clears the hash and leaves the open document as it is — no reload.
 * Returns the unsubscribe.
 */
export function watchShareLinks(watch: ShareLinkWatch): () => void {
  let busy = false;
  const onHashChange = (): void => {
    if (busy) return;
    const hash = window.location.hash;
    // `share.ts` is a lazy chunk (F9 fix round 1), precached like the rest.
    void import('../state/share.js').then(({ decodeShareFragment }) => decodeShareFragment(hash)).then(async (share) => {
      if (share.kind === 'none' || window.location.hash !== hash) return;
      if (share.kind === 'invalid') {
        clearHash();
        watch.onInvalid();
        return;
      }
      busy = true;
      try {
        await watch.flush();
      } finally {
        window.location.reload();
      }
    });
  };
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}
