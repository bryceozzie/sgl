import { useEffect, useRef, useState } from 'preact/hooks';
import type { DocumentSession } from '../state/document-session.js';
import type { Pipeline } from '../state/pipeline.js';
import { OPEN_ACCEPT } from '../state/title.js';
import type { Toasts } from '../state/toasts.js';
import { useDisclosure } from './disclosure.js';
import type { ShareDialog, ShareState } from './file-actions.js';

export interface FileMenuProps {
  readonly pipeline: Pipeline;
  readonly session: DocumentSession;
  readonly toasts: Toasts;
  /** DD-08 §7's Open path — shared with `Ctrl/⌘+O` and the launch queue. */
  readonly onOpen: (file: File) => void;
}

type SaveKind = 'sgl' | 'json' | 'svg';

const SAVE_ITEMS: readonly { readonly kind: SaveKind; readonly label: string }[] = [
  { kind: 'sgl', label: 'SGL source' },
  { kind: 'json', label: 'Canonical JSON' },
  { kind: 'svg', label: 'SVG image' },
];

type FileActions = typeof import('./file-actions.js');
let actions: Promise<FileActions> | undefined;

/** The lazy `files` chunk (`file-actions.tsx` with `state/files.ts` and
 *  `state/filename.ts`), imported once, on first use of Open, Save ▾, Share
 *  or the launch queue. Off the first paint; precached like every chunk, so it
 *  works offline (`e2e/offline.spec.ts`). */
export function loadFileActions(): Promise<FileActions> {
  actions ??= import('./file-actions.js');
  return actions;
}

/** DD-08 §2's `Open · Save ▾ · Share`, with §7's file handling and §8's
 *  share dialog. This is the part the first paint needs: the buttons, the
 *  hidden file input and the `Ctrl/⌘+O` binding, so the picker opens on the
 *  first press, inside the user's gesture, with nothing to load first. What
 *  each control does lives in `file-actions.tsx`, a lazy chunk: Open and
 *  `Ctrl/⌘+O` start loading it as the picker opens (the picked file is read
 *  with it), Save ▾ and Share load it when used. */
export function FileMenu({ pipeline, session, toasts, onOpen }: FileMenuProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const saveMenuRef = useRef<HTMLDetailsElement | null>(null);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const shareLinkRef = useRef<HTMLInputElement | null>(null);
  const [share, setShare] = useState<{ readonly state: ShareState; readonly Dialog: typeof ShareDialog } | null>(null);
  const saveMenu = useDisclosure(saveMenuRef, () => closeShare(false));
  const closeSaveMenu = saveMenu.close;
  const deps = { pipeline, session, toasts };

  // The Share dialog takes focus when it opens (the link, selected, ready to
  // copy), so Escape closes it without tabbing in first.
  const shareOpen = share !== null;
  useEffect(() => {
    if (shareOpen) shareLinkRef.current?.focus();
  }, [shareOpen]);

  /** Closes the Share dialog; `returnFocus` puts focus back on the Share
   *  button (Escape, Close) — not when something else took over (Save ▾). */
  function closeShare(returnFocus: boolean): void {
    setShare(null);
    if (returnFocus) shareButtonRef.current?.focus();
  }

  /** Opens the picker synchronously, while the gesture is still live, and
   *  starts loading what will read the picked file. */
  function pick(): void {
    void loadFileActions();
    inputRef.current?.click();
  }

  // DD-08 §7: Ctrl/⌘+O opens, from anywhere — capture phase, so CodeMirror
  // (which does not bind it) and the browser's own "open file" both lose.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== 'o') return;
      ev.preventDefault();
      pick();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  function onPicked(ev: Event): void {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // so picking the same file again still fires `change`.
    if (file !== undefined) onOpen(file);
  }

  function save(kind: SaveKind): void {
    closeSaveMenu(false);
    void loadFileActions().then((m) => m.save(kind, deps));
  }

  async function openShare(): Promise<void> {
    const m = await loadFileActions();
    const state = await m.makeShare(deps);
    closeSaveMenu(false);
    if (state !== null) setShare({ state, Dialog: m.ShareDialog });
  }

  return (
    <div class="file-menu">
      <button type="button" class="toolbar-button file-open" onClick={pick} title="Open a file (Ctrl/⌘+O)">
        Open
      </button>
      <input ref={inputRef} class="file-input" type="file" accept={OPEN_ACCEPT} hidden onChange={onPicked} />

      <details
        class="save-menu"
        ref={saveMenuRef}
        onToggle={saveMenu.onToggle}
      >
        <summary class="toolbar-button">
          Save <span aria-hidden="true">▾</span>
        </summary>
        <div class="menu">
          {SAVE_ITEMS.map((item) => (
            <button type="button" class={`save-${item.kind}`} key={item.kind} onClick={() => save(item.kind)}>
              {item.label}
            </button>
          ))}
        </div>
      </details>

      <button type="button" class="toolbar-button share-open" ref={shareButtonRef} onClick={() => void openShare()}>
        Share
      </button>

      {share !== null ? (
        <share.Dialog share={share.state} deps={deps} linkRef={shareLinkRef} onClose={() => closeShare(true)} onSave={() => save('sgl')} />
      ) : null}
    </div>
  );
}
