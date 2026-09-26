import type { Diagnostic } from './diagnostics.js';
import { fromCatalogue, type CodeSpec } from './layout-diagnostics.js';
import type { SourceSpan } from './span.js';

/**
 * The diagnostics catalogue's A9 import rows (DD-02 §10.6): part of
 * `@sgl/core/imports`, which the app loads lazily and only for a document
 * with `@imports`, and the only code that emits them, so none of them is on
 * the boot path (§10.9) — the pattern `LAYOUT_CATALOGUE` set (execution
 * plan §1). `DiagnosticCode` still names them, through a type-only import,
 * and the coverage gate reads both tables. Every one is a warning or info
 * (DD-02 I17).
 */
// Template values are data only — paths, names, numbers — never English
// phrases (execution plan §1): each limit and each clash has its own row
// (A9 fix round 1).
export const IMPORT_CATALOGUE = {
  SGL2017: { severity: 'warning', template: 'Cannot find `{path}` to import; nothing was imported from it.' },
  SGL2018: { severity: 'warning', template: '`{path}` matches {n} documents; importing `{chosen}`, the most recently updated.' },
  SGL2019: { severity: 'warning', template: '`{path}` imports itself via `{cycle}`; this import was skipped.' },
  SGL2020: { severity: 'warning', template: 'Importing `{path}` would go past {limit} levels of imports; it was skipped.' },
  SGL2021: { severity: 'warning', template: '`{path}` has {n} problems of its own; the first: {first}.' },
  SGL2022: { severity: 'warning', template: '`{name}` is already the name of an earlier import; this import was skipped.' },
  SGL2023: { severity: 'info', template: 'Class `{name}` here replaces the one imported from `{path}`.' },
  SGL2024: { severity: 'warning', template: '`{name}` may come from `{path}`, which could not be imported; it was skipped.' },
  SGL2025: { severity: 'warning', template: '`{path}` is not a relative path; only your own documents can be imported.' },
  SGL2026: { severity: 'info', template: 'The nodes and edges of `{path}` are not imported; give the import an `as:` name to include them.' },
  // SGL2027 is the boot catalogue's: the app could not load this chunk.
  SGL2028: { severity: 'warning', template: 'Importing `{path}` would go past {limit} imported documents; it was skipped.' },
  SGL2029: { severity: 'warning', template: 'Importing `{path}` would go past {limit} characters of imported source; it was skipped.' },
  SGL2030: { severity: 'warning', template: '`@imports` has more than {limit} items; the rest were skipped.' },
  SGL2031: { severity: 'warning', template: '`{name}` is already a node in this document; the nodes and edges of `{path}` were not imported.' },
} as const satisfies Record<string, CodeSpec>;

export type ImportDiagnosticCode = keyof typeof IMPORT_CATALOGUE;

/** `diagnostic()` for the import codes, reading only `IMPORT_CATALOGUE`. */
export function importDiagnostic(code: ImportDiagnosticCode, span: SourceSpan, values?: Readonly<Record<string, string | number>>): Diagnostic {
  return fromCatalogue(IMPORT_CATALOGUE, code, span, values);
}
