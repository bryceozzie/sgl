import type { Diagnostic } from './diagnostics.js';
import { fromCatalogue, type CodeSpec } from './layout-diagnostics.js';
import type { SourceSpan } from './span.js';

/**
 * The rows of the diagnostics catalogue only the import linker emits (A9,
 * DD-02 §10.6): part of `@sgl/core/imports`, which the app loads lazily, so
 * they stay off the boot path — the pattern `LAYOUT_CATALOGUE` set (execution
 * plan §1). `DiagnosticCode` still names them, through a type-only import,
 * and the coverage gate reads both tables. The three import codes that can
 * be emitted without a linker (`SGL2017`, `SGL2021`, `SGL2024`) are in
 * `CATALOGUE`. Every one is a warning or info (DD-02 I17).
 */
export const IMPORT_CATALOGUE = {
  SGL2018: { severity: 'warning', template: '`{path}` matches {n} documents; importing `{chosen}`, the most recently updated.' },
  SGL2019: { severity: 'warning', template: '`{path}` imports itself via `{cycle}`; this import was skipped.' },
  SGL2020: { severity: 'warning', template: 'Importing `{path}` would go past {limit}; it was skipped.' },
  SGL2022: { severity: 'warning', template: '`{name}` is already {what}; {outcome}.' },
  SGL2023: { severity: 'info', template: 'Class `{name}` here replaces the one imported from `{path}`.' },
  SGL2025: { severity: 'warning', template: '`{path}` is not a relative path; only your own documents can be imported.' },
  SGL2026: { severity: 'info', template: 'The nodes and edges of `{path}` are not imported; give the import an `as:` name to include them.' },
} as const satisfies Record<string, CodeSpec>;

export type ImportDiagnosticCode = keyof typeof IMPORT_CATALOGUE;

/** `diagnostic()` for the import codes, reading only `IMPORT_CATALOGUE`. */
export function importDiagnostic(code: ImportDiagnosticCode, span: SourceSpan, values?: Readonly<Record<string, string | number>>): Diagnostic {
  return fromCatalogue(IMPORT_CATALOGUE, code, span, values);
}
