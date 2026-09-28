import type { BootResult } from './boot.js';

/**
 * HD6 (DD-13 §14): a first visit opens the Help drawer at the quick start,
 * without moving focus. A first visit is one with no stored document to
 * reopen, so boot made one (`created`): the example, or a share link's
 * document for someone opening SGL through a link for the first time. That help was
 * shown is remembered in `localStorage`, read synchronously at boot, so the
 * app can decide before its first render. Storage that is missing or throws
 * (a private window, blocked site data) is tolerated: the check still
 * answers, and a first visit still gets its help. DOM-free.
 */

export const HELP_SHOWN_KEY = 'sgl-help-shown';

export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether to open help now; if so, it is marked shown. */
export function firstVisitHelp(boot: Pick<BootResult, 'created'>, storage: () => FlagStorage | undefined): boolean {
  if (!boot.created) return false;
  let store: FlagStorage | undefined;
  try {
    store = storage();
    if (store?.getItem(HELP_SHOWN_KEY) != null) return false;
    store?.setItem(HELP_SHOWN_KEY, '1');
  } catch {
    // Not remembered: the next first visit shows it again.
  }
  return true;
}
