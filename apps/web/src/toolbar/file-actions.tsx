import type { Ref } from 'preact';
import { useState } from 'preact/hooks';
import { downloadBlob, downloadFile } from '../io/download.js';
import { withEmbeddedFonts } from '../io/fonts.js';
import { rasterizePng } from '../io/png.js';
import type { DocumentSession } from '../state/document-session.js';
import { saveFileName, type TextSaveKind } from '../state/filename.js';
import { readOpenedFile, saveContent, type OpenResult } from '../state/files.js';
import type { AppImportsRuntime } from '../state/imports.js';
import type { Pipeline } from '../state/pipeline.js';
import { DEFAULT_PNG_SCALE, PNG_SCALES, pngPlan, type PngScale } from '../state/png.js';
import type { Toasts } from '../state/toasts.js';

/**
 * The work behind DD-08 §2's `Open · Save ▾ · Share` (§7, §8): reading an
 * opened file, writing a Save ▾ item, PNG export and Copy SVG/PNG (D6, D7,
 * with `io/png.ts` and `state/png.ts`), making a share link, and the Share
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
  /** How many imported documents the link carries (A9, DD-08 §15.3). */
  readonly imports: number;
  /** Names that led to more than one document (I27): the link carries the
   *  first, so the recipient's copy will differ. */
  readonly differ: readonly string[];
}

/** DD-08 §7's Open: the checks (extension, 2 MB) and the read. */
export function readFile(file: File): Promise<OpenResult> {
  return readOpenedFile(file);
}

/** `lastGood.svg`; before the first live render, the stored one it will
 *  replace (the same document's last good picture); `null` before either. */
function currentSvg({ pipeline, session }: FileDeps): string | null {
  return pipeline.lastGood.peek()?.svg ?? session.record.peek().lastGoodSvg ?? null;
}

const FONT_FAILED = 'the diagram’s font (Inter) could not be loaded, so the file would not look right elsewhere.';

/** One Save ▾ item: the file, downloaded, or the reason in a toast. SVG is
 *  `lastGood.svg` with the Inter faces it uses embedded (D2), so the inputs
 *  are read at the click and the fonts fetched after. */
export async function save(kind: TextSaveKind, deps: FileDeps): Promise<void> {
  const { pipeline, session, toasts } = deps;
  const record = session.record.peek();
  const result = saveContent(kind, {
    title: record.title,
    ...(record.fileExtension !== undefined ? { rememberedExtension: record.fileExtension } : {}),
    source: pipeline.source.peek(),
    model: pipeline.model.peek().model,
    modelDiagnostics: [...pipeline.parsed.peek().diagnostics, ...pipeline.model.peek().diagnostics],
    lastGoodSvg: currentSvg(deps),
  });
  if (!result.ok) {
    toasts.push(result.message, 'error');
    return;
  }
  if (kind !== 'svg') {
    downloadFile(result.file);
    return;
  }
  try {
    downloadFile({ ...result.file, text: await withEmbeddedFonts(result.file.text) });
  } catch {
    toasts.push(`Could not save the SVG: ${FONT_FAILED}`, 'error');
  }
}

const NOTHING_YET = 'Nothing has rendered yet, so there is no picture to save or copy.';

/** Save ▾ → PNG image (D6): `{title}.png` at `scale`, or the reason in a
 *  toast (nothing rendered, over the pixel cap, a failed draw). */
export async function savePng(scale: PngScale, deps: FileDeps): Promise<void> {
  const svg = currentSvg(deps);
  if (svg === null) {
    deps.toasts.push(NOTHING_YET, 'error');
    return;
  }
  const result = await rasterizePng(svg, scale);
  if (result.ok) downloadBlob(result.blob, saveFileName('png', deps.session.record.peek().title));
  else deps.toasts.push(result.message, 'error');
}

/** Copy SVG (D7): the same text Save ▾ SVG saves — `lastGood.svg` with its
 *  Inter faces embedded (D2) — as plain text, which every editor and design
 *  tool accepts. The embedding is asynchronous (the fonts are fetched), so
 *  where the browser has `ClipboardItem` the write starts inside the click
 *  with the text still to come as a promise, as Copy PNG does: Safari
 *  refuses a clipboard write that begins after an `await`. Elsewhere,
 *  `writeText` once the text is ready. */
export function copySvg(deps: FileDeps): void {
  const { toasts } = deps;
  const svg = currentSvg(deps);
  if (svg === null) {
    toasts.push(NOTHING_YET, 'error');
    return;
  }
  let failure: string | null = null;
  const refused = (): void => {
    toasts.push(failure ?? 'Could not copy the SVG: the browser refused access to the clipboard. Save ▾ → SVG image saves it as a file.', 'error');
  };
  const text = withEmbeddedFonts(svg).catch((e: unknown) => {
    failure = `Could not copy the SVG: ${FONT_FAILED}`;
    throw e;
  });
  text.catch(() => undefined); // reported below, once.
  const copied = (): void => {
    toasts.push('SVG copied to the clipboard.');
  };
  // `undefined` outside a secure context, whatever the type says.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard?.write !== undefined && typeof ClipboardItem !== 'undefined') {
    const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
    blob.catch(() => undefined);
    clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(copied, refused);
  } else if (clipboard?.writeText !== undefined) {
    text.then((t) => clipboard.writeText(t)).then(copied, refused);
  } else {
    refused();
  }
}

/** Copy PNG (D7): an `image/png` at the default scale (2×). The clipboard
 *  write starts inside the click, with the image still to come as a promise
 *  — Safari refuses a write that begins after an `await`, once the user
 *  activation it needs is gone. */
export function copyPng(deps: FileDeps): void {
  const { toasts } = deps;
  const svg = currentSvg(deps);
  if (svg === null) {
    toasts.push(NOTHING_YET, 'error');
    return;
  }
  const plan = pngPlan(svg, DEFAULT_PNG_SCALE);
  if (!plan.ok) {
    toasts.push(plan.message, 'error');
    return;
  }
  if ((navigator.clipboard as Clipboard | undefined)?.write === undefined || typeof ClipboardItem === 'undefined') {
    toasts.push('This browser cannot copy images. Save ▾ → PNG image saves it as a file.', 'error');
    return;
  }
  let failure: string | null = null;
  const blob = rasterizePng(svg, DEFAULT_PNG_SCALE).then((r) => {
    if (r.ok) return r.blob;
    failure = r.message;
    throw new Error(r.message);
  });
  blob.catch(() => undefined); // reported below, once, whichever fails first.
  navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
    () => toasts.push('PNG copied to the clipboard.'),
    () => toasts.push(failure ?? 'Could not copy the PNG: the browser refused access to the clipboard. Save ▾ → PNG image saves it as a file.', 'error'),
  );
}

export interface SaveExtrasProps {
  readonly deps: FileDeps;
  /** Closes Save ▾ (`returnFocus` false), as its other items do when used. */
  readonly close: (returnFocus: boolean) => void;
}

// Inline, so the boot stylesheet (which counts toward the 180 kB core
// budget) does not grow for a lazy part of the menu. The buttons take the
// menu's own `.save-menu .menu button` rules.
const FIELDSET = { border: 0, margin: 0, padding: '0 0.6rem 0.3rem', fontSize: '0.72rem', whiteSpace: 'nowrap' } as const;
const LEGEND = { float: 'left', padding: 0, marginRight: '0.4rem', opacity: 0.75 } as const;
const LABEL = { marginRight: '0.4rem' };
const RADIO = { margin: '0 0.15rem 0 0', verticalAlign: '-0.1em' };

/**
 * Save ▾'s picture items past SVG (D6, D7): PNG image with its scale, Copy
 * SVG and Copy PNG. Part of this lazy chunk, rendered into the disclosure once
 * it has loaded (Save ▾ starts loading it when opened), so the boot bundle
 * carries none of it. Still plain controls, no menu roles (DD-08 §7): the
 * scale is a native radio group, a `<fieldset>` ("Scale" on screen, "PNG
 * scale" to assistive technology, which hears it outside the visual row).
 */
export function SaveExtras({ deps, close }: SaveExtrasProps) {
  const [scale, setScale] = useState<PngScale>(DEFAULT_PNG_SCALE);
  return (
    <>
      <button
        type="button"
        class="save-png"
        onClick={() => {
          close(false);
          void savePng(scale, deps);
        }}
      >
        PNG image
      </button>
      <fieldset class="png-scale" style={FIELDSET} aria-label="PNG scale">
        <legend style={LEGEND}>Scale</legend>
        {PNG_SCALES.map((s) => (
          <label key={s} style={LABEL}>
            <input type="radio" name="png-scale" style={RADIO} value={s} checked={s === scale} onChange={() => setScale(s)} />
            {s}×
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        class="copy-svg"
        onClick={() => {
          close(false);
          copySvg(deps);
        }}
      >
        Copy SVG
      </button>
      <button
        type="button"
        class="copy-png"
        onClick={() => {
          close(false);
          copyPng(deps);
        }}
      >
        Copy PNG
      </button>
    </>
  );
}

/** The share link for the document as it stands, or `null` (with a toast)
 *  where this browser cannot make one. */
export async function makeShare({ pipeline, toasts }: FileDeps): Promise<ShareState | null> {
  // Its own lazy chunk (F9 fix round 1): a pasted link needs it without Open/Save.
  const { encodeShareFragment, isLongShareLink, shareLink } = await import('../state/share.js');
  // A9 (I27): a document with imports carries the documents its last
  // resolve imported, as `i=`.
  const runtime = pipeline.imports.peek() as AppImportsRuntime | null;
  const bundle = pipeline.model.peek().model.imports !== undefined ? runtime?.bundle?.(pipeline.docId.peek()) : undefined;
  const encoded = await encodeShareFragment({
    source: pipeline.source.peek(),
    engineId: pipeline.effectiveEngineId.peek(),
    themeId: pipeline.effectiveThemeId.peek(),
    ...(bundle !== undefined ? { imports: bundle.docs } : {}),
  });
  if (!encoded.ok) {
    // No `CompressionStream` here (an older or locked-down browser): the
    // file is the other way to share (fix round 1, item 11).
    toasts.push("This browser can't make share links. Use Save ▾ → SGL source and share the file instead.", 'error');
    return null;
  }
  const link = shareLink(`${window.location.origin}${window.location.pathname}`, encoded.fragment);
  return { link, long: isLongShareLink(link), imports: bundle?.docs.length ?? 0, differ: bundle?.differ ?? [] };
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
      <p class="share-note">
        {share.imports > 0
          ? `The whole diagram is inside this link, with the ${share.imports === 1 ? 'document' : `${share.imports} documents`} it imports. Nothing is uploaded anywhere.`
          : 'The whole diagram is inside this link. Nothing is uploaded anywhere.'}
      </p>
      {share.differ.map((name) => (
        <p class="share-differ" key={name}>
          The import “{name}” led to more than one of your documents. The link carries the first, so the recipient’s copy of it will differ.
        </p>
      ))}
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
          {share.imports > 0 ? ' The file holds this document only, without the documents it imports.' : null}
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
