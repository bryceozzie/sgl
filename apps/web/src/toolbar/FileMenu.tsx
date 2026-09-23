import { useEffect, useRef, useState } from 'preact/hooks';
import { downloadFile } from '../io/download.js';
import type { DocumentSession } from '../state/document-session.js';
import { OPEN_ACCEPT, type SaveKind } from '../state/filename.js';
import { saveContent } from '../state/files.js';
import type { Pipeline } from '../state/pipeline.js';
import { encodeShareFragment, isLongShareLink, shareLink } from '../state/share.js';
import type { Toasts } from '../state/toasts.js';

export interface FileMenuProps {
  readonly pipeline: Pipeline;
  readonly session: DocumentSession;
  readonly toasts: Toasts;
  /** DD-08 §7's Open path — shared with `Ctrl/⌘+O` and the launch queue. */
  readonly onOpen: (file: File) => void;
}

const SAVE_ITEMS: readonly { readonly kind: SaveKind; readonly label: string }[] = [
  { kind: 'sgl', label: 'SGL source' },
  { kind: 'json', label: 'Canonical JSON' },
  { kind: 'svg', label: 'SVG image' },
];

interface ShareState {
  readonly link: string;
  readonly long: boolean;
}

/** DD-08 §2's `Open · Save ▾ · Share`, with §7's file handling and §8's
 *  share dialog. The decisions live in `state/files.ts` and `state/share.ts`;
 *  this is the DOM around them. */
export function FileMenu({ pipeline, session, toasts, onOpen }: FileMenuProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const saveMenuRef = useRef<HTMLDetailsElement | null>(null);
  const [share, setShare] = useState<ShareState | null>(null);

  // DD-08 §7: Ctrl/⌘+O opens, from anywhere — capture phase, so CodeMirror
  // (which does not bind it) and the browser's own "open file" both lose.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== 'o') return;
      ev.preventDefault();
      inputRef.current?.click();
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
    if (saveMenuRef.current !== null) saveMenuRef.current.open = false;
    const record = session.record.peek();
    const result = saveContent(kind, {
      title: record.title,
      ...(record.fileExtension !== undefined ? { rememberedExtension: record.fileExtension } : {}),
      source: pipeline.source.peek(),
      model: pipeline.model.peek().model,
      modelDiagnostics: [...pipeline.parsed.peek().diagnostics, ...pipeline.model.peek().diagnostics],
      // `lastGood.svg`; before the first live render, the stored one it will
      // replace (the same document's last good picture).
      lastGoodSvg: pipeline.lastGood.peek()?.svg ?? record.lastGoodSvg ?? null,
    });
    if (result.ok) downloadFile(result.file);
    else toasts.push(result.message, 'error');
  }

  async function openShare(): Promise<void> {
    const fragment = await encodeShareFragment({
      source: pipeline.source.peek(),
      engineId: pipeline.effectiveEngineId.peek(),
      themeId: pipeline.effectiveThemeId.peek(),
    });
    const link = shareLink(`${window.location.origin}${window.location.pathname}`, fragment);
    if (saveMenuRef.current !== null) saveMenuRef.current.open = false;
    setShare({ link, long: isLongShareLink(link) });
  }

  function copy(link: string): void {
    const fallback = (): void => {
      const input = document.querySelector<HTMLInputElement>('.share-link');
      input?.select();
      toasts.push('Could not copy automatically: the link is selected, press Ctrl+C (⌘C) to copy it.', 'error');
    };
    if (navigator.clipboard === undefined) {
      fallback();
      return;
    }
    navigator.clipboard.writeText(link).then(() => toasts.push('Link copied.'), fallback);
  }

  return (
    <div class="file-menu">
      <button type="button" class="toolbar-button file-open" onClick={() => inputRef.current?.click()} title="Open a file (Ctrl/⌘+O)">
        Open
      </button>
      <input ref={inputRef} class="file-input" type="file" accept={OPEN_ACCEPT} hidden onChange={onPicked} />

      <details class="save-menu" ref={saveMenuRef} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setShare(null)}>
        <summary class="toolbar-button">Save ▾</summary>
        <div class="menu" role="menu">
          {SAVE_ITEMS.map((item) => (
            <button type="button" role="menuitem" class={`save-${item.kind}`} key={item.kind} onClick={() => save(item.kind)}>
              {item.label}
            </button>
          ))}
        </div>
      </details>

      <button type="button" class="toolbar-button share-open" onClick={() => void openShare()}>
        Share
      </button>

      {share !== null ? (
        <div class="share-dialog" role="dialog" aria-label="Share by link" onKeyDown={(e) => e.key === 'Escape' && setShare(null)}>
          <p class="share-note">The whole diagram is inside this link. Nothing is uploaded anywhere.</p>
          <input class="share-link" type="text" readOnly value={share.link} onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
          {share.long ? (
            <p class="share-warning" role="alert">
              This link is {share.link.length.toLocaleString('en')} characters long. Some chats and browsers cut long links short, so it may not
              open. Saving the file is safer.
            </p>
          ) : null}
          <div class="share-actions">
            <button type="button" class="share-copy" onClick={() => copy(share.link)}>
              Copy link
            </button>
            {share.long ? (
              <button type="button" class="share-save" onClick={() => save('sgl')}>
                Save as a file instead
              </button>
            ) : null}
            <button type="button" class="share-close" onClick={() => setShare(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
