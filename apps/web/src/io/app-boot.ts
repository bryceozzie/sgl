import { gridEngine } from '@sgl/layout-std';
import { BUILT_IN, DEFAULT_THEME_ID } from '@sgl/theme';
import EXAMPLE_SOURCE from '../examples/checkout.sgl?raw';
import { bootDocument, type BootResult } from '../state/boot.js';
import { createMemoryStore, type DocumentStore } from '../state/storage.js';
import { openIdbStore } from '../state/storage-idb.js';

/** The engines actually registered in `apps/web/src/layout.worker.ts` — only
 *  `gridEngine` until Stage K adds `elk`. Read from the same object the
 *  worker registers, rather than duplicated by hand, so the picker cannot
 *  list something the worker does not actually run. */
export const REGISTERED_ENGINES = [{ id: gridEngine.id, name: gridEngine.name, determinism: gridEngine.capabilities.determinism }];

/** I1: the app's default engine is whichever engine the worker registers. */
export const DEFAULT_ENGINE_ID = gridEngine.id;

export interface AppBoot extends BootResult {
  readonly store: DocumentStore;
}

/**
 * The DOM half of boot (DD-08 §9): open IndexedDB (falling back to memory),
 * pick the document (`state/boot.ts`), and clear a share hash so a reload
 * does not re-import it (§8). Runs before the first render, so the stored
 * `lastGoodSvg` is on screen before fonts or the worker are ready (§5).
 */
export async function bootApp(): Promise<AppBoot> {
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
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
    defaultEngineId: DEFAULT_ENGINE_ID,
    defaultThemeId: DEFAULT_THEME_ID,
    isKnownEngine: (id) => REGISTERED_ENGINES.some((e) => e.id === id),
    isKnownTheme: (id) => BUILT_IN[id] !== undefined,
  });

  if (result.clearHash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);

  const notices = storageFailed && !result.notices.includes('storage-failed') ? [...result.notices, 'storage-failed' as const] : result.notices;
  return { ...result, notices, store };
}
