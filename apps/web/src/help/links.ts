/**
 * Links between help entries (DD-13 P12, P42): `#help/<id>`, the form the
 * content's links are written in and the help page (branch 5) will route.
 * The drawer follows them itself. A name is matched against the id table
 * only, never rendered as markup. DOM-free; part of the lazy `help` chunk.
 */

import type { HelpTable, HelpTableEntry } from './join.js';

const PREFIX = '#help/';

/** `key/size.maxWidth` → `#help/key/size.maxWidth`; each path segment percent-encoded. */
export function helpHref(id: string): string {
  return PREFIX + id.split('/').map(encodeURIComponent).join('/');
}

/** The id a `#help/<id>` href names, percent-decoded; `undefined` for any other href. */
export function idFromHref(href: string): string | undefined {
  if (!href.startsWith(PREFIX) || href.length === PREFIX.length) return undefined;
  try {
    return decodeURIComponent(href.slice(PREFIX.length));
  } catch {
    return undefined;
  }
}

/** The entry an id (or an alias, such as `key/style.fill`) names, if any. */
export function resolveLink(table: HelpTable, id: string): HelpTableEntry | undefined {
  return table.get(id);
}

/**
 * The entries whose `Diagnostics:` line names `code`, in table order (HD3).
 * Until the diagnostics' own entries have prose (help branch 3), a code's
 * entry shows its generated facts and points at these.
 */
export function explainedBy(table: HelpTable, code: string): readonly HelpTableEntry[] {
  return table.entries.filter((e) => e.content?.diagnostics.includes(code) === true);
}
