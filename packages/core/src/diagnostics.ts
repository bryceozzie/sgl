import type { SourceSpan } from './span.js';

/** Codes are allocated per stage and never reused (DD-00 §3):
 *  1xxx syntax · 2xxx resolution · 3xxx semantic · 4xxx layout · 5xxx theme · 6xxx platform. */
export type DiagnosticCode = keyof typeof CATALOGUE;

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

interface CodeSpec {
  readonly severity: Severity;
  /** Message template; `{placeholders}` are filled by the emitting stage. */
  readonly template: string;
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
  SGL2009: { severity: 'warning', template: 'Variable `${name}` is not substituted in this version; kept as literal text.' },
  SGL2010: { severity: 'warning', template: 'Unknown configuration key `@{key}`; kept but has no effect in this version.' },
  SGL2011: { severity: 'warning', template: '`@{key}` expects {type}; ignored.' },
  SGL2012: { severity: 'warning', template: '`@{key}` is not valid on {scope}; ignored.' },

  // ---- 3xxx semantic (DD-03) ---------------------------------------------
  SGL3001: { severity: 'warning', template: 'Unknown shape `{name}`; using `rect`.' },
  SGL3002: { severity: 'warning', template: '`{node}` is hidden; {n} edges to it are not drawn.' },
  SGL3003: { severity: 'warning', template: '`{path}` matched no nodes; the edge was skipped.' },
  SGL3004: { severity: 'error', template: 'A wildcard may only be the last part of a path; `{path}` was skipped.' },
  SGL3005: { severity: 'error', template: '`{from} {op} {to}` expands to {n} edges, over the limit of {max}; it was skipped.' },

  // ---- 4xxx layout (DD-06) -----------------------------------------------
  SGL4001: { severity: 'error', template: 'Layout engine `{id}` did not finish within {ms} ms and was stopped. Showing the previous layout.' },
  SGL4002: { severity: 'error', template: 'Layout engine `{id}` returned invalid geometry ({detail}). Showing the previous layout.' },
  SGL4003: { severity: 'warning', template: '`{node}` extends outside its container after layout.' },
  SGL4010: { severity: 'warning', template: '`@layout.{key}` is not an option of engine `{id}`; ignored.' },
  SGL4011: { severity: 'error', template: 'Layout engine `{id}` failed: {message}.' },

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
  code: DiagnosticCode,
  span: SourceSpan,
  values: Readonly<Record<string, string | number>> = {},
  related?: readonly { readonly span: SourceSpan; readonly message: string }[],
): Diagnostic {
  const spec: CodeSpec = CATALOGUE[code];
  const message = spec.template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
  return related === undefined
    ? { code, severity: spec.severity, message, span }
    : { code, severity: spec.severity, message, span, related };
}
