import type { Signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { lazyChunk } from '../state/lazy.js';
import type { Toasts } from '../state/toasts.js';
import type { Pipeline } from '../state/pipeline.js';
import type { DocumentStore } from '../state/storage.js';
import type { AppMeasurer } from '../state/types.js';

/**
 * The Help button and the drawer's mount point (DD-13 §6, §8): the boot
 * path's whole share of help. The drawer itself, the `<aside>` and all it
 * holds, is the lazy `help` chunk (`help/help.tsx`, with `help-*.css`),
 * which loads `help-content` and `reference` itself. There is no keyboard
 * shortcut (HD5): the button is in the tab order.
 *
 * A `help` chunk that cannot be loaded toasts (`state/lazy.ts`), the drawer
 * stays closed, and the next press tries again.
 */

/** What opened the drawer, and where focus goes: the search box (the Help
 *  button), the entry's heading (a diagnostics row's Help), or nowhere (a
 *  first visit, HD6, which opens at the quick start: `focus: 'none'` with no
 *  `id`). Each request is a new object, so two for the same thing are two. */
export interface HelpRequest {
  readonly id?: string;
  readonly focus: 'search' | 'entry' | 'none';
}

/** What the drawer needs from the app. */
export interface HelpDeps {
  readonly measurer: AppMeasurer;
  /** The editor's pipeline: previews follow its effective theme (DD-13 P23). */
  readonly pipeline: Pick<Pipeline, 'effectiveThemeId'>;
  readonly toasts: Toasts;
  /** The stored documents: an example's `@imports` resolve against them, as the editor's do (DD-13 P24). */
  readonly store: DocumentStore;
  /** DD-13 P30: the example as a new document (Open's path), under the preview's engine; resolves to whether it opened. */
  readonly openExample: (source: string, engineId: string) => Promise<boolean>;
}


const loadHelp = lazyChunk(() => import('../help/help.js'));

export function HelpButton({ state }: { readonly state: Signal<HelpRequest | null> }) {
  const open = state.value !== null;
  return (
    <button type="button" class="toolbar-button" aria-expanded={open} aria-controls="help-drawer" onClick={() => (state.value = open ? null : { focus: 'search' })}>
      <span aria-hidden="true">?</span> Help
    </button>
  );
}

export function HelpMount({ state, deps }: { readonly state: Signal<HelpRequest | null>; readonly deps: HelpDeps }) {
  const open = state.value !== null;
  const [help, setHelp] = useState<typeof import('../help/help.js')>();
  useEffect(() => {
    if (open && help === undefined) loadHelp().then(setHelp, () => (state.value = null));
  }, [open]);
  return open && help !== undefined ? <help.HelpDrawer state={state} deps={deps} /> : null;
}
