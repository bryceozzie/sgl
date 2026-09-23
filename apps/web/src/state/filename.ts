import type { DocumentModel } from '@sgl/core';

/** DD-08 §7's file names, DOM-free. */

/** What Open accepts (`<input accept>` and the check behind it). Longest
 *  first, so `.sgl.json` wins over `.json`. */
export const OPENABLE_EXTENSIONS = ['.sgl.json', '.sgl', '.json', '.txt'] as const;
export type OpenableExtension = (typeof OPENABLE_EXTENSIONS)[number];

export const OPEN_ACCEPT = '.sgl,.sgl.json,.json,.txt';

/** The recognised extension of `fileName`, case-insensitively, or `null`. */
export function openableExtension(fileName: string): OpenableExtension | null {
  const lower = fileName.toLowerCase();
  return OPENABLE_EXTENSIONS.find((ext) => lower.endsWith(ext) && lower.length > ext.length) ?? null;
}

export const FALLBACK_TITLE = 'diagram';

/** DD-08 §7: "`@title` or the first node key or 'diagram'" — unsanitised; the
 *  document record keeps this as its `title`. A blank `@title` falls through,
 *  as if absent. */
export function documentTitle(model: DocumentModel): string {
  const title = model.root.config.title;
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  const first = model.root.children[0]?.key;
  if (first !== undefined && first.trim() !== '') return first;
  return FALLBACK_TITLE;
}

/** Characters no mainstream file system accepts in a name (Windows' set is the
 *  strictest and a superset of the others), plus C0/C1 controls. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
/** Bidi controls (U+202A–U+202E embeddings/overrides, U+2066–U+2069
 *  isolates, U+200E/U+200F marks) — which can make `evil\u202Egpj.svg` read
 *  as `evilsvg.jpg` — and zero-width characters (U+200B–U+200D, U+FEFF):
 *  invisible, and a way to build look-alike names. Removed outright. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/** Windows reserves these device names for the stem before the **first** dot
 *  (`con.backup.sgl` is as reserved as `con.sgl`), ignoring trailing spaces,
 *  whatever the extension: `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`,
 *  and `COM`/`LPT` followed by a digit or a superscript ¹ ² ³. */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?= *(\.|$))/i;
/** In code points, not UTF-16 units, so the cut never splits a surrogate
 *  pair (a lone surrogate is not valid in a file name, nor in UTF-8). */
const MAX_STEM_LENGTH = 120;

/** "Sanitised for filenames": bidi and zero-width characters go, forbidden
 *  characters become `-`, whitespace runs collapse to one space,
 *  leading/trailing dots, dashes and spaces go (a trailing dot is silently
 *  dropped by Windows; a leading one hides the file on Unix), the stem is
 *  capped at 120 code points, and a reserved device name — the part before
 *  the first dot — gets a `_`. Anything left empty is `diagram`. */
export function sanitizeFileStem(title: string): string {
  // Invisibles first (U+FEFF is also `\s`), then whitespace, so a tab or
  // newline (also a control) becomes a space.
  let stem = title.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').replace(FORBIDDEN, '-');
  stem = stem.replace(/^[\s.-]+|[\s.-]+$/g, '');
  const codePoints = Array.from(stem);
  if (codePoints.length > MAX_STEM_LENGTH) stem = codePoints.slice(0, MAX_STEM_LENGTH).join('').replace(/[\s.-]+$/g, '');
  if (stem === '') return FALLBACK_TITLE;
  return stem.replace(RESERVED, '$1_');
}

/** The three Save ▾ items in scope (DD-08 §7; PNG is D6). */
export type SaveKind = 'sgl' | 'json' | 'svg';

/**
 * The default file name for a Save ▾ item. "The extension is remembered on the
 * document for the default save name" (§7): a document opened from `.txt`
 * saves its source as `.txt`, one opened from `.json` saves canonical JSON as
 * `.json`. The remembered extension only applies to the item of the same
 * kind — saving a `.txt` document as canonical JSON still gets `.sgl.json`.
 */
export function saveFileName(kind: SaveKind, title: string, rememberedExtension?: string): string {
  const stem = sanitizeFileStem(title);
  switch (kind) {
    case 'sgl':
      return stem + (rememberedExtension === '.txt' || rememberedExtension === '.sgl' ? rememberedExtension : '.sgl');
    case 'json':
      return stem + (rememberedExtension === '.json' || rememberedExtension === '.sgl.json' ? rememberedExtension : '.sgl.json');
    case 'svg':
      return `${stem}.svg`;
  }
}
