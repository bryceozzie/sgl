import type { ConfigEntry, Document as SglDocument, StringLit } from '@sgl/core';

/** A single text replacement, in `EditorView.dispatch({ changes })` shape —
 *  the picker's own change goes through a transaction (DD-08 §4), same as any
 *  other programmatic edit, so undo history survives. */
export interface TextChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

function findTopLevelEntry(ast: SglDocument, keyPath: readonly string[]): ConfigEntry | undefined {
  return ast.entries.find(
    (e): e is ConfigEntry =>
      e.kind === 'ConfigEntry' && e.key.length === keyPath.length && e.key.every((k, i) => k === keyPath[i]),
  );
}

/** For `keyPath = ['layout', 'engine']`, finds the `engine` property inside an
 *  existing top-level `@layout: { ... }` object literal, if both exist —
 *  K2's "edit the value in place when the root already has an `@layout: {
 *  … }` object" case, distinct from `findTopLevelEntry`'s exact-dotted-key
 *  case (`@layout.engine: "..."`) . `undefined` for a 1-segment `keyPath`
 *  (`@theme` is never nested — DD-02 §7's registry types it as a plain
 *  string, not an object) or when the parent entry is not an object literal. */
function findNestedStringProperty(ast: SglDocument, keyPath: readonly string[]): StringLit | undefined {
  if (keyPath.length !== 2) return undefined;
  const parent = findTopLevelEntry(ast, [keyPath[0]!]);
  if (parent === undefined || parent.value.kind !== 'Object') return undefined;
  const prop = parent.value.props.find((p) => p.key === keyPath[1]);
  return prop !== undefined && prop.value.kind === 'String' ? prop.value : undefined;
}

/**
 * DD-08 §10: "editing it writes into the document's root config via a
 * transaction." Builds the minimal text change for setting a root-level
 * string config key (`@theme`, `@layout.engine`) to `value`.
 *
 * Checked in order, each editing the *existing* value's span in place rather
 * than adding a new entry, so the app's own picker action never introduces a
 * duplicate-key diagnostic (K2, execution plan fix round 1) the user did not
 * ask for:
 * 1. An exact top-level dotted entry (`@layout.engine: "..."`).
 * 2. A nested property inside a top-level object entry (`@layout: { engine:
 *    "..." }`), for a 2-segment `keyPath` only (§7's registry has no deeper
 *    nesting for anything a picker writes).
 * 3. Neither exists: a new `@key.path: "value"` line inserted at the very
 *    start of the document.
 */
export function setRootConfigString(ast: SglDocument, keyPath: readonly string[], value: string): TextChange {
  const quoted = JSON.stringify(value);

  const exact = findTopLevelEntry(ast, keyPath);
  if (exact !== undefined && exact.value.kind === 'String') {
    return { from: exact.value.span.from, to: exact.value.span.to, insert: quoted };
  }

  const nested = findNestedStringProperty(ast, keyPath);
  if (nested !== undefined) {
    return { from: nested.span.from, to: nested.span.to, insert: quoted };
  }

  return { from: 0, to: 0, insert: `@${keyPath.join('.')}: ${quoted}\n` };
}
