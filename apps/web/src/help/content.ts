/**
 * The compiled help content (DD-13 P13): what `build/help-content.ts` makes of
 * the Markdown in `apps/web/help/` at build time, and what the help chunks
 * render with Preact, element by element. It is a typed tree, never HTML:
 * nothing is parsed as markup at run time (DD-13 §11).
 *
 * The `virtual:sgl-help-content` module (`build/help-plugin.ts`) default-exports
 * one `HelpContent`. Only the lazy help chunks may import it or this module
 * (`test/reference-boot.test.ts`).
 */

import type { TextRun } from '@sgl/core';

/** The kinds of entry id (DD-13 P3), `<kind>/<name>`. */
export const HELP_KINDS = ['topic', 'key', 'style', 'shape', 'engine', 'option', 'theme', 'token', 'diag'] as const;
export type HelpKind = (typeof HELP_KINDS)[number];

/** A link to another help entry (`[text](#help/<id>)`), checked at build time. */
export interface LinkRun {
  readonly link: string;
  readonly runs: readonly TextRun[];
}

/** Inline text: `parseInline`'s runs (bold, italic, code), or a link. */
export type Run = TextRun | LinkRun;

/** One highlighted piece of code: a `tok-*` class (empty for plain text) and its text. */
export type Token = readonly [cls: string, text: string];

export interface ListItem {
  readonly runs: readonly Run[];
  /** The second level (DD-13 P12: lists are two levels deep). */
  readonly sub?: List;
}

export interface List {
  readonly ordered: boolean;
  readonly items: readonly ListItem[];
}

/** A fenced `sgl` block (DD-13 P11). */
export interface ExampleSpec {
  /** `<entry id>#<n>`: the block's position among the entry's `sgl` blocks, from 1. */
  readonly id: string;
  /** `example`: a whole document, previewed and tested; `snippet`: a fragment, shown only. */
  readonly mode: 'example' | 'snippet';
  readonly title?: string;
  /** A bare engine name; absent means the default engine (DD-13 P27). */
  readonly engine?: string;
  /** Diagnostic codes the example must produce, as a multiset; empty means none. */
  readonly expect: readonly string[];
  /** A string the rendered SVG must contain. */
  readonly contains?: string;
  /** `false` only with an `expect` that explains it (DD-13 P11). */
  readonly preview: boolean;
  readonly source: string;
  readonly tokens: readonly Token[];
}

export type Block =
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3; readonly runs: readonly Run[] }
  | { readonly type: 'paragraph'; readonly runs: readonly Run[] }
  | ({ readonly type: 'list' } & List)
  | { readonly type: 'code'; readonly lang: string; readonly tokens: readonly Token[] }
  | { readonly type: 'table'; readonly head: readonly (readonly Run[])[]; readonly rows: readonly (readonly (readonly Run[])[])[] }
  | { readonly type: 'note'; readonly blocks: readonly Block[] }
  | { readonly type: 'example'; readonly example: ExampleSpec };

/** One hand-written entry: a heading carrying its id, and the body under it (DD-13 P10). */
export interface HelpEntry {
  /** `key/size.maxWidth`. */
  readonly id: string;
  readonly kind: HelpKind;
  /** The id without its kind: `size.maxWidth`. */
  readonly name: string;
  readonly title: string;
  /** The source file, relative to `apps/web/help/`. */
  readonly file: string;
  /** The first paragraph: search results and the drawer's compact view show it. */
  readonly summary: readonly Run[];
  /** The `Aliases:` line: extra search terms. */
  readonly aliases: readonly string[];
  /** The `See also:` line: entry ids. */
  readonly seeAlso: readonly string[];
  /** The `Diagnostics:` line: the codes the key can cause, each proved by an example (DD-13 P16, P19). */
  readonly diagnostics: readonly string[];
  /** The body after the summary and the special lines. */
  readonly blocks: readonly Block[];
}

export interface HelpContent {
  readonly entries: readonly HelpEntry[];
}

/** The plain text of some runs, links included. */
export function runsText(runs: readonly Run[]): string {
  return runs.map((r) => ('link' in r ? runsText(r.runs) : r.text)).join('');
}
