import type { ConfigEntry, Document as SglDocument, ObjectLit, Property } from '@sgl/core';

/** A single text replacement, in `EditorView.dispatch({ changes })` shape —
 *  the picker's own change goes through a transaction (DD-08 §4), same as any
 *  other programmatic edit, so undo history survives. */
export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

function isConfigEntry(entry: SglDocument['entries'][number]): entry is ConfigEntry {
  return entry.kind === 'ConfigEntry';
}

function sameKey(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** The root config entries that currently set `keyPath`, in document order:
 *  an exact entry (`@theme: …`, `@layout.engine: …`) or, for a two-segment
 *  path, the matching property inside a parent object entry
 *  (`@layout: { engine: … }`). The *last* one is the one that wins (DD-02 §2's
 *  redeclaration rule merges later over earlier), so it is the one to edit. */
function valueSpansSetting(ast: SglDocument, keyPath: readonly string[]): { readonly from: number; readonly to: number }[] {
  const spans: { from: number; to: number }[] = [];
  for (const entry of ast.entries) {
    if (!isConfigEntry(entry)) continue;
    if (sameKey(entry.key, keyPath)) {
      spans.push(entry.value.span);
    } else if (keyPath.length === 2 && sameKey(entry.key, [keyPath[0]!]) && entry.value.kind === 'Object') {
      const prop = findLast(entry.value.props, (p) => p.key === keyPath[1]);
      if (prop !== undefined) spans.push(prop.value.span);
    }
  }
  return spans;
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i]!)) return items[i];
  return undefined;
}

/** The last root `@parent: { … }` object entry, for a two-segment path whose
 *  property is not set anywhere yet. */
function parentObject(ast: SglDocument, keyPath: readonly string[]): ObjectLit | undefined {
  if (keyPath.length !== 2) return undefined;
  const entry = findLast(ast.entries.filter(isConfigEntry), (e) => sameKey(e.key, [keyPath[0]!]) && e.value.kind === 'Object');
  return entry?.value.kind === 'Object' ? entry.value : undefined;
}

/** Adds `key: value` as the object's first property, matching its layout: on
 *  its own line (with the existing first property's indentation) in a
 *  multi-line object, `key: value, ` inline in a one-line one, and
 *  `{ key: value }` for an empty `{}`. */
function insertProperty(source: string, object: ObjectLit, key: string, quoted: string): TextChange {
  const first: Property | undefined = object.props[0];
  const open = object.span.from + 1; // just past `{`
  if (first === undefined) return { from: open, to: object.span.to - 1, insert: ` ${key}: ${quoted} ` };
  const gap = source.slice(open, first.span.from);
  const newline = gap.lastIndexOf('\n');
  if (newline === -1) return { from: first.span.from, to: first.span.from, insert: `${key}: ${quoted}, ` };
  const indent = gap.slice(newline + 1);
  return { from: first.span.from, to: first.span.from, insert: `${key}: ${quoted}\n${indent}` };
}

/**
 * DD-08 §10: "editing it writes into the document's root config via a
 * transaction." Builds the minimal text change for setting a root-level
 * string config key (`@theme`, `@layout.engine`) to `value`. The picker's own
 * write must never make the user's document emit a diagnostic or grow a
 * second entry for the same key, so, in order:
 *
 * 1. If an entry already sets the key — exactly (`@layout.engine: …`) or as a
 *    property of the parent object (`@layout: { engine: … }`) — its value span
 *    is replaced in place, whatever the old value's kind (a bareword, a
 *    number). The last such entry wins, so that is the one edited.
 * 2. Else, for a two-segment key with an existing `@parent: { … }` object, the
 *    property is added to that object, keeping one `@layout` entry.
 * 3. Else, and only then, a new `@key.path: "value"` line is inserted at the
 *    start of the document.
 *
 * `source` is the text `ast` was built from (needed only to match an
 * object's own formatting in case 2).
 */
export function setRootConfigString(ast: SglDocument, source: string, keyPath: readonly string[], value: string): TextChange {
  const quoted = JSON.stringify(value);

  const existing = editRootConfigInPlace(ast, keyPath, value);
  if (existing !== null) return existing;

  const parent = parentObject(ast, keyPath);
  if (parent !== undefined) return insertProperty(source, parent, keyPath[1]!, quoted);

  return { from: 0, to: 0, insert: `@${keyPath.join('.')}: ${quoted}\n` };
}

/**
 * Step 1 of `setRootConfigString` alone: the in-place edit of the entry that
 * already sets `keyPath` (the last one, whatever its value's kind), or `null`
 * when nothing in the document sets it. Theme ▾ uses this on its own (P1,
 * human decision 2026-09-24; DD-08 §10): the picker is a view preference and
 * writes into the document only when the document already names a theme.
 */
export function editRootConfigInPlace(ast: SglDocument, keyPath: readonly string[], value: string): TextChange | null {
  const existing = valueSpansSetting(ast, keyPath).at(-1);
  return existing === undefined ? null : { from: existing.from, to: existing.to, insert: JSON.stringify(value) };
}
