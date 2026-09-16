import type { SourceSpan } from './span.js';

/** The typed AST built over the Lezer CST (DD-01 §3). Every node carries a span. */
export type Ast =
  | Document
  | ConfigEntry
  | NodeDecl
  | EdgeStmt
  | Endpoint
  | PathExpr
  | PathStep
  | Block
  | Value
  | Variable
  | Property;

export interface Document {
  readonly kind: 'Document';
  readonly entries: readonly Entry[];
  readonly span: SourceSpan;
}

export type Entry = ConfigEntry | NodeDecl | EdgeStmt;

export interface ConfigEntry {
  readonly kind: 'ConfigEntry';
  /** `['style','stroke']` for `@style.stroke` — the `@` is dropped. */
  readonly key: readonly string[];
  readonly value: Value;
  readonly keySpan: SourceSpan;
  readonly span: SourceSpan;
}

export interface NodeDecl {
  readonly kind: 'NodeDecl';
  readonly key: string;
  readonly keySpan: SourceSpan;
  /** `Word` is a class reference, not a label (DD-02 §2). */
  readonly value?: Block | StringLit | Word;
  readonly span: SourceSpan;
}

export interface EdgeStmt {
  readonly kind: 'EdgeStmt';
  readonly endpoints: readonly Endpoint[];
  /** `ops.length === endpoints.length - 1` */
  readonly ops: readonly EdgeOp[];
  readonly value?: StringLit | Block;
  readonly span: SourceSpan;
}

export type EdgeOp = '->' | '<-' | '<->' | '--';

export interface Endpoint {
  readonly kind: 'Endpoint';
  readonly path: PathExpr;
  readonly port?: string;
  readonly portSpan?: SourceSpan;
  readonly span: SourceSpan;
}

export interface PathExpr {
  readonly kind: 'PathExpr';
  /** `/absolute` from the document root. */
  readonly root: boolean;
  /** How many leading `../`. */
  readonly parents: number;
  readonly segments: readonly PathStep[];
  readonly span: SourceSpan;
}

/**
 * One dot-separated part of a path.
 *
 * A `Wildcard` step is only meaningful as the last one, but the grammar accepts it
 * anywhere so that `lane1.*.handler` still yields a usable partial tree plus an
 * SGL3004 pointing at the offending step. Keeping the AST faithful to what was
 * written is what lets that diagnostic carry a precise span.
 */
export type PathStep = NameStep | WildcardStep;

export interface NameStep {
  readonly kind: 'Name';
  readonly value: string;
  readonly span: SourceSpan;
}

export interface WildcardStep {
  readonly kind: 'Wildcard';
  /** `*` = direct children; `**` = every descendant, containers included.
   *  Always `'children'` when a glob is present — a glob never crosses a level. */
  readonly depth: 'children' | 'descendants';
  /** Text before the star: `'cam'` in `cam*`. Empty for a bare `*` or `**`. */
  readonly prefix: string;
  /** Text after the star: `'-db'` in `*-db`. Empty unless the star has a tail. */
  readonly suffix: string;
  readonly span: SourceSpan;
}

/**
 * Does a node key match this wildcard step?
 *
 * The length guard is what stops `ca*am` matching `cam`: without it, a prefix and
 * a suffix that overlap in the middle of a short key would both be satisfied by
 * the same characters.
 */
export function matchesWildcard(step: WildcardStep, key: string): boolean {
  return (
    key.length >= step.prefix.length + step.suffix.length &&
    key.startsWith(step.prefix) &&
    key.endsWith(step.suffix)
  );
}

export interface Block {
  readonly kind: 'Block';
  readonly entries: readonly Entry[];
  readonly span: SourceSpan;
}

export type Value = StringLit | NumberLit | BoolLit | NullLit | Word | Variable | ArrayLit | ObjectLit;

/** Escapes are already decoded. */
export interface StringLit { readonly kind: 'String'; readonly value: string; readonly span: SourceSpan }
export interface NumberLit { readonly kind: 'Number'; readonly value: number; readonly span: SourceSpan }
export interface BoolLit { readonly kind: 'Bool'; readonly value: boolean; readonly span: SourceSpan }
export interface NullLit { readonly kind: 'Null'; readonly span: SourceSpan }
/** A bareword enum value: `hexagon`, `down`, `dashed` — or a class reference. */
export interface Word { readonly kind: 'Word'; readonly value: string; readonly span: SourceSpan }
export interface Variable { readonly kind: 'Variable'; readonly name: string; readonly span: SourceSpan }
export interface ArrayLit { readonly kind: 'Array'; readonly items: readonly Value[]; readonly span: SourceSpan }
export interface ObjectLit { readonly kind: 'Object'; readonly props: readonly Property[]; readonly span: SourceSpan }

export interface Property {
  readonly kind: 'Property';
  readonly key: string;
  readonly isConfig: boolean;
  readonly keySpan: SourceSpan;
  readonly value: Value;
  readonly span: SourceSpan;
}
