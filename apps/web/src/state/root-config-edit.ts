import type { ConfigEntry, Document as SglDocument } from '@sgl/core';

/** A single text replacement, in `EditorView.dispatch({ changes })` shape —
 *  the picker's own change goes through a transaction (DD-08 §4), same as any
 *  other programmatic edit, so undo history survives. */
export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

function findTopLevelStringEntry(ast: SglDocument, keyPath: readonly string[]): ConfigEntry | undefined {
  return ast.entries.find(
    (e): e is ConfigEntry =>
      e.kind === 'ConfigEntry' && e.key.length === keyPath.length && e.key.every((k, i) => k === keyPath[i]),
  );
}

/**
 * DD-08 §10: "editing it writes into the document's root config via a
 * transaction." Builds the minimal text change for setting a root-level
 * string config key (`@theme`, `@layout.engine`) to `value`.
 *
 * If a top-level entry with exactly this dotted key already holds a string
 * literal, only its value span is replaced — the smallest possible diff, and
 * it preserves whatever quoting style the author used elsewhere. Otherwise a
 * new `@key.path: "value"` line is inserted at the very start of the
 * document. This does not look inside a `@layout: { engine: ... }` object
 * literal for an existing `engine` property — a document written that way
 * gets a second, dotted `@layout.engine` entry alongside it, which DD-02 §2's
 * redeclaration rule merges (`SGL2005`, info-only) rather than a precise
 * in-object edit. A known simplification, not a correctness gap: the merged
 * result is exactly the value being set, just with one harmless info
 * diagnostic until the author cleans up the duplicate by hand.
 */
export function setRootConfigString(ast: SglDocument, keyPath: readonly string[], value: string): TextChange {
  const quoted = JSON.stringify(value);
  const existing = findTopLevelStringEntry(ast, keyPath);
  if (existing !== undefined && existing.value.kind === 'String') {
    return { from: existing.value.span.from, to: existing.value.span.to, insert: quoted };
  }
  return { from: 0, to: 0, insert: `@${keyPath.join('.')}: ${quoted}\n` };
}
