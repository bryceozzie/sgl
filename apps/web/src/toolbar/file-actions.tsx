import type { Ref } from 'preact';
import { downloadFile } from '../io/download.js';
import type { DocumentSession } from '../state/document-session.js';
import type { SaveKind } from '../state/filename.js';
import { readOpenedFile, saveContent, type OpenResult } from '../state/files.js';
import type { Pipeline } from '../state/pipeline.js';
import type { Toasts } from '../state/toasts.js';

/**
 * The work behind DD-08 §2's `Open · Save ▾ · Share` (§7, §8): reading an
 * opened file, writing a Save ▾ item, making a share link, and the Share
 * dialog. A lazy chunk (`files-*.js`, with `state/files.ts` and
 * `state/filename.ts`): none of it is needed to paint the first diagram, so
 * `FileMenu.tsx` and `App.tsx` import it when a control is used. Precached like
 * every other chunk, so it works offline (`e2e/offline.spec.ts`).
 */

export interface FileDeps {
  readonly pipeline: Pipeline;
  readonly session: DocumentSession;
  readonly toasts: Toasts;
}

export interface ShareState {
  readonly link: string;
  readonly long: boolean;
}

/** DD-08 §7's Open: the checks (extension, 2 MB) and the read. */
export function readFile(file: File): Promise<OpenResult> {
  return readOpenedFile(file);
}

/** One Save ▾ item: the file, downloaded, or the reason in a toast. */
export function save(kind: SaveKind, { pipeline, session, toasts }: FileDeps): void {
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

/** The share link for the document as it stands, or `null` (with a toast)
 *  where this browser cannot make one. */
export async function makeShare({ pipeline, toasts }: FileDeps): Promise<ShareState | null> {
  // Its own lazy chunk (F9 fix round 1): a pasted link needs it without Open/Save.
  const { encodeShareFragment, isLongShareLink, shareLink } = await import('../state/share.js');
  const encoded = await encodeShareFragment({
    source: pipeline.source.peek(),
    engineId: pipeline.effectiveEngineId.peek(),
    themeId: pipeline.effectiveThemeId.peek(),
  });
  if (!encoded.ok) {
    // No `CompressionStream` here (an older or locked-down browser): the
    // file is the other way to share (fix round 1, item 11).
    toasts.push("This browser can't make share links. Use Save ▾ → SGL source and share the file instead.", 'error');
    return null;
  }
  const link = shareLink(`${window.location.origin}${window.location.pathname}`, encoded.fragment);
  return { link, long: isLongShareLink(link) };
}

function copy(link: string, toasts: Toasts): void {
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

export interface ShareDialogProps {
  readonly share: ShareState;
  readonly deps: FileDeps;
  readonly linkRef: Ref<HTMLInputElement>;
  readonly onClose: () => void;
  readonly onSave: () => void;
}

/** DD-08 §8's Share dialog. */
export function ShareDialog({ share, deps, linkRef, onClose, onSave }: ShareDialogProps) {
  return (
    <div
      class="share-dialog"
      role="dialog"
      aria-label="Share by link"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onClose();
      }}
    >
      <p class="share-note">The whole diagram is inside this link. Nothing is uploaded anywhere.</p>
      <input
        ref={linkRef}
        class="share-link"
        type="text"
        readOnly
        aria-label="Share link"
        value={share.link}
        onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
      />
      {share.long ? (
        <p class="share-warning" role="alert">
          This link is {share.link.length.toLocaleString('en')} characters long. Some chats and browsers cut long links short, so it may not
          open. Saving the file is safer.
        </p>
      ) : null}
      <div class="share-actions">
        <button type="button" class="share-copy" onClick={() => copy(share.link, deps.toasts)}>
          Copy link
        </button>
        {share.long ? (
          <button type="button" class="share-save" onClick={onSave}>
            Save as a file instead
          </button>
        ) : null}
        <button type="button" class="share-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
