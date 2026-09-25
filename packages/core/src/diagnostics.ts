import type { IMPORT_CATALOGUE } from './imports-catalogue.js';
import { fromCatalogue, LAYOUT_CATALOGUE, type CodeSpec } from './layout-diagnostics.js';
import type { SourceSpan } from './span.js';

/** Codes are allocated per stage and never reused (DD-00 §3):
 *  1xxx syntax · 2xxx resolution · 3xxx semantic · 4xxx layout · 5xxx theme · 6xxx platform.
 *  A9's import rows that only the linker emits live in `IMPORT_CATALOGUE`
 *  (`@sgl/core/imports`, off the boot path, DD-02 §10.6); the type still
 *  names them, through a type-only import. */
export type DiagnosticCode = keyof typeof CATALOGUE | keyof typeof IMPORT_CATALOGUE;

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  /** A complete sentence. Names the thing, says what to do. */
  readonly message: string;
  readonly span: SourceSpan;
  readonly related?: readonly { readonly span: SourceSpan; readonly message: string }[];
}

/** A stage never throws on bad input: it returns the best partial `value` plus
 *  diagnostics (DD-00 §3). Throwing is reserved for violated invariants. */
export interface StageResult<T> {
  readonly value: T;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The single catalogue of every diagnostic SGL can emit. DD-09 §3.4 makes this
 * the coverage gate: every code here must have at least one corpus document that
 * emits it and one that does not, checked by a table test in CI.
 */
export const CATALOGUE = {
  // ---- 1xxx syntax (DD-01) ------------------------------------------------
  SGL1001: { severity: 'error', template: 'Expected `{token}` here.' },
  SGL1002: { severity: 'error', template: 'Unexpected `{text}` — skipped.' },
  SGL1003: { severity: 'error', template: 'Unterminated string.' },
  SGL1004: { severity: 'warning', template: 'Unknown escape `\\{c}` in string; kept as written.' },
  SGL1005: { severity: 'error', template: 'Unterminated block comment.' },

  // ---- 2xxx resolution (DD-02) -------------------------------------------
  SGL2001: { severity: 'error', template: 'Cannot find `{path}` from `{container}`. The edge was skipped.' },
  SGL2002: { severity: 'error', template: 'Unknown class `{name}`. Declare it in `@classes`.' },
  SGL2003: { severity: 'warning', template: '`{node}` has no port `{port}`; the edge attaches to the node instead.' },
  SGL2004: { severity: 'error', template: 'Class `{a}` extends itself via `{cycle}`.' },
  SGL2005: { severity: 'info', template: '`{key}` is declared again here and merged with the earlier declaration.' },
  SGL2006: { severity: 'warning', template: '`@{key}` was `{scalar}` and has been replaced by an object to hold `@{key}.{sub}`.' },
  SGL2007: { severity: 'warning', template: 'Class bodies hold configuration only; `{key}` ignored.' },
  SGL2008: { severity: 'warning', template: 'Edge blocks hold configuration only; `{thing}` ignored.' },
  // SGL2009 ("not substituted in this version") was retired by A8, which
  // substitutes variables. Its number is never reused (DD-00 §3).
  SGL2010: { severity: 'warning', template: 'Unknown configuration key `@{key}`; kept but has no effect in this version.' },
  SGL2011: { severity: 'warning', template: '`@{key}` expects {type}; ignored.' },
  SGL2012: { severity: 'warning', template: '`@{key}` is not valid on {scope}; ignored.' },
  SGL2013: { severity: 'error', template: 'Unknown variable `${name}`; the value was dropped.' },
  SGL2014: { severity: 'error', template: 'Variable `${name}` is not declared before `{user}` in its `@vars` block; the value was dropped.' },
  SGL2015: { severity: 'error', template: 'Variable `${name}` holds {kind}, which cannot be interpolated; the value was dropped.' },
  SGL2016: { severity: 'error', template: '`{text}` would take this document\'s variable expansion past {limit} units; the value was dropped.' },
  // A9 imports (DD-02 §10.6). Every import failure and what it causes is a
  // warning (I17). These three are emitted without the linker too; the rest
  // are `IMPORT_CATALOGUE`'s.
  SGL2017: { severity: 'warning', template: 'Cannot find `{path}` to import; nothing was imported from it.' },
  SGL2021: { severity: 'warning', template: '`{path}` has {n} problems of its own; the first: {first}.' },
  SGL2024: { severity: 'warning', template: '`{name}` may come from `{path}`, which could not be imported; {what} was skipped.' },

  // ---- 3xxx semantic (DD-03) ---------------------------------------------
  SGL3001: { severity: 'warning', template: 'Unknown shape `{name}`; using `rect`.' },
  SGL3002: { severity: 'warning', template: '`{node}` is hidden; {n} edges to it are not drawn.' },
  SGL3003: { severity: 'warning', template: '`{path}` matched no nodes; the edge was skipped.' },
  SGL3004: { severity: 'error', template: '`**` may only be the last part of a path; `{path}` was skipped.' },
  SGL3005: { severity: 'error', template: '`{from} {op} {to}` expands to {n} edges, over the limit of {max}; it was skipped.' },
  SGL3006: { severity: 'info', template: 'Shape `{name}` is not drawn in this version; using `rect`.' },
  SGL3007: { severity: 'warning', template: '`{node}` port `{port}` has side `{side}`; expected north, south, east or west. Using `east`.' },

  // ---- 4xxx layout (DD-06) -----------------------------------------------
  // Kept in `layout-diagnostics.ts`, so the layout worker can bundle these
  // rows without the rest (`layoutDiagnostic()`).
  ...LAYOUT_CATALOGUE,

  // ---- 5xxx theme (DD-04) ------------------------------------------------
  SGL5001: { severity: 'error', template: 'Theme inheritance deeper than 8 (`{chain}`); stopping at `{id}`.' },
  SGL5002: { severity: 'error', template: 'Theme `{id}` extends itself via `{cycle}`.' },
  SGL5003: { severity: 'warning', template: 'Unknown style property `{name}` in {where}; ignored.' },
  SGL5004: { severity: 'warning', template: '`{name}` expects {type}, got `{value}`; ignored.' },
  SGL5005: { severity: 'warning', template: 'Unknown token `@{name}`; using a fallback value.' },
  SGL5006: { severity: 'error', template: 'Token `@{name}` refers to itself via `{cycle}`.' },

  // ---- 6xxx platform (DD-07) ---------------------------------------------
  SGL6001: { severity: 'warning', template: 'Link on `{element}` uses `{scheme}:`, which is not allowed; the link was removed.' },
} as const satisfies Record<string, CodeSpec>;

/** Build a diagnostic from the catalogue, substituting `{placeholders}`. */
export function diagnostic(
  code: keyof typeof CATALOGUE,
  span: SourceSpan,
  values: Readonly<Record<string, string | number>> = {},
  related?: readonly { readonly span: SourceSpan; readonly message: string }[],
): Diagnostic {
  return fromCatalogue(CATALOGUE, code, span, values, related);
}
