import type { Diagnostic, DiagnosticCode, Severity } from './diagnostics.js';
import type { SourceSpan } from './span.js';

/**
 * The layout rows of the diagnostics catalogue (DD-06), and a `diagnostic()`
 * for them alone.
 *
 * They live apart from the rest so the layout worker can build its
 * diagnostics without bundling the whole catalogue: `CATALOGUE`
 * (`diagnostics.ts`) spreads these rows in, and `diagnostic()` builds every
 * code from it, but `@sgl/layout-api` (host, worker runtime, validation,
 * `@layout` checks) emits only `SGL4xxx` and calls `layoutDiagnostic()`, which
 * reads this table only. The worker chunk then carries five rows instead of
 * every message SGL has (about 1.1 kB gzipped, counted in the core-bundle
 * budget); `apps/web/scripts/check-core-chunks.mjs` fails if any other row
 * reaches it. Same rule as `diagnostic()`: a catalogued code, never a
 * hand-written message.
 */

export interface CodeSpec {
  readonly severity: Severity;
  /** Message template; `{placeholders}` are filled by the emitting stage. */
  readonly template: string;
}

type Related = readonly { readonly span: SourceSpan; readonly message: string }[];

export const LAYOUT_CATALOGUE = {
  SGL4001: { severity: 'error', template: 'Layout engine `{id}` did not finish within {ms} ms and was stopped. Showing the previous layout.' },
  SGL4002: { severity: 'error', template: 'Layout engine `{id}` returned invalid geometry ({detail}). Showing the previous layout.' },
  SGL4003: { severity: 'warning', template: '`{node}` extends outside its container after layout.' },
  SGL4010: { severity: 'warning', template: '`@layout.{key}` is not an option of engine `{id}`; ignored.' },
  SGL4011: { severity: 'error', template: 'Layout engine `{id}` failed: {message}.' },
  SGL4020: { severity: 'warning', template: '`{node}` has no `@pin`; `fixed` placed it below the pinned nodes.' },
  SGL4021: { severity: 'warning', template: '`@pin` is not honoured by engine `{id}`; ignored.' },
  SGL4022: { severity: 'info', template: '{count} more layout warnings not shown.' },
} as const satisfies Record<string, CodeSpec>;

export type LayoutDiagnosticCode = keyof typeof LAYOUT_CATALOGUE;

/** Build a diagnostic from a catalogue table, substituting `{placeholders}`.
 *  The one builder behind both `diagnostic()` and `layoutDiagnostic()`. */
export function fromCatalogue<C extends DiagnosticCode>(
  table: Readonly<Record<C, CodeSpec>>,
  code: C,
  span: SourceSpan,
  values: Readonly<Record<string, string | number>> = {},
  related?: Related,
): Diagnostic {
  const spec = table[code];
  const message = spec.template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
  return related === undefined
    ? { code, severity: spec.severity, message, span }
    : { code, severity: spec.severity, message, span, related };
}

/** `diagnostic()` for the layout codes, reading only `LAYOUT_CATALOGUE`. */
export function layoutDiagnostic(
  code: LayoutDiagnosticCode,
  span: SourceSpan,
  values?: Readonly<Record<string, string | number>>,
  related?: Related,
): Diagnostic {
  return fromCatalogue(LAYOUT_CATALOGUE, code, span, values, related);
}
