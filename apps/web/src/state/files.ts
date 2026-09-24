import type { Diagnostic, DocumentModel } from '@sgl/core';
import { toJson } from '@sgl/core/json';
import { openableExtension, saveFileName, type OpenableExtension, type SaveKind } from './filename.js';

/** DD-08 §7, DOM-free: what Open accepts and what each Save ▾ item writes.
 *  The DOM half (the `<input type=file>`, the transient `<a download>`) is
 *  `apps/web/src/io/download.ts` and `toolbar/FileMenu.tsx`. */

/** DD-08 §7 / DD-09 §1.1: files over this are refused with a toast. */
export const MAX_OPEN_BYTES = 2 * 1024 * 1024;

/** The slice of `File` Open needs — `size` is checked *before* `text()`, so a
 *  huge file is never read into memory at all. */
export interface OpenableFile {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}

export type OpenResult =
  | { readonly ok: true; readonly text: string; readonly extension: OpenableExtension }
  | { readonly ok: false; readonly reason: 'too-large' | 'unsupported' | 'unreadable'; readonly message: string };

export async function readOpenedFile(file: OpenableFile): Promise<OpenResult> {
  const extension = openableExtension(file.name);
  if (extension === null) {
    return { ok: false, reason: 'unsupported', message: `Can't open ${file.name}: SGL opens .sgl, .sgl.json, .json and .txt files.` };
  }
  if (file.size > MAX_OPEN_BYTES) {
    return { ok: false, reason: 'too-large', message: `Can't open ${file.name}: it is over 2 MB.` };
  }
  try {
    return { ok: true, text: await file.text(), extension };
  } catch {
    return { ok: false, reason: 'unreadable', message: `Can't open ${file.name}: the file could not be read.` };
  }
}

export interface SaveInputs {
  readonly title: string;
  readonly rememberedExtension?: string;
  readonly source: string;
  readonly model: DocumentModel;
  /** The front end's own diagnostics (parse + resolve): what `toJson(model)`
   *  would silently drop if any of them is an error. */
  readonly modelDiagnostics: readonly Diagnostic[];
  /** `lastGood.svg`, or `null` while nothing has rendered yet. */
  readonly lastGoodSvg: string | null;
}

export interface SaveFile {
  readonly name: string;
  readonly mime: string;
  readonly text: string;
}

export type SaveResult = { readonly ok: true; readonly file: SaveFile } | { readonly ok: false; readonly message: string };

/**
 * One Save ▾ item (DD-08 §7):
 *
 * - **SGL** — `source` verbatim.
 * - **Canonical JSON** — `toJson(model)`. Refused while the document has a
 *   parse or resolve *error*: the model is then partial, and canonical JSON of
 *   it would quietly drop whatever did not parse. The SGL item still saves the
 *   text exactly as it is.
 * - **SVG** — `lastGood.svg` with the default export options (background on,
 *   scale 1), which is `render()`'s own output unchanged (DD-07 §9: the
 *   `.canvas` rect is the background; scale multiplies `width`/`height`).
 *   Refused only before anything has rendered.
 */
export function saveContent(kind: SaveKind, inputs: SaveInputs): SaveResult {
  const name = saveFileName(kind, inputs.title, inputs.rememberedExtension);
  switch (kind) {
    case 'sgl':
      return { ok: true, file: { name, mime: 'text/plain;charset=utf-8', text: inputs.source } };
    case 'json':
      if (inputs.modelDiagnostics.some((d) => d.severity === 'error')) {
        return { ok: false, message: 'Fix the errors first: canonical JSON would drop what does not parse. Save as .sgl keeps the text as is.' };
      }
      return { ok: true, file: { name, mime: 'application/json;charset=utf-8', text: toJson(inputs.model) } };
    case 'svg':
      if (inputs.lastGoodSvg === null) return { ok: false, message: 'Nothing has rendered yet, so there is no SVG to save.' };
      return { ok: true, file: { name, mime: 'image/svg+xml;charset=utf-8', text: inputs.lastGoodSvg } };
  }
}
