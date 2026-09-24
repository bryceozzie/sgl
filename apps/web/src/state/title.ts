import type { DocumentModel } from '@sgl/core';

/** The part of DD-08 §7's file naming the boot path needs: a document's title
 *  and what Open accepts. Everything else about files (`filename.ts`,
 *  `files.ts`, the Save ▾ and Share actions) is a lazy chunk loaded when Open,
 *  Save ▾ or Share is used, so it stays off the first paint. */

/** What Open accepts (`<input accept>` and the check behind it). Longest
 *  first, so `.sgl.json` wins over `.json`. */
export const OPENABLE_EXTENSIONS = ['.sgl.json', '.sgl', '.json', '.txt'] as const;
export type OpenableExtension = (typeof OPENABLE_EXTENSIONS)[number];

export const OPEN_ACCEPT = '.sgl,.sgl.json,.json,.txt';

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
