import type { PathExpr } from './ast.js';
import type { SourceSpan } from './span.js';

/** The canonical document model (DD-02 §3) — what `.sgl.json` serialises. */
export interface DocumentModel {
  readonly sgl: '1.0';
  /** Key `''` — the document itself. */
  readonly root: ContainerModel;
  readonly classes: Readonly<Record<string, ClassModel>>;
  /** Side table; never serialised. */
  readonly spans: SpanTable;
  /** `@imports` as written (A9, DD-02 §10.5 I31), present only when the
   *  document has one. `toJson` prints it back in the same form. */
  readonly imports?: readonly ImportModel[];
}

/** One `@imports` item (DD-02 §10.2): a string path, or `{ path, as }`. */
export interface ImportModel {
  readonly path: string;
  readonly as?: string;
  readonly form: 'string' | 'object';
  readonly span: SourceSpan;
  /** Set when this import failed: unresolved, refused (not relative), or
   *  skipped for a cycle or a cap. `compile()` reads it (DD-02 I17). */
  readonly failed?: true;
}

/** Where an imported element came from (DD-02 I12): the `@imports` item's
 *  path as written, and its span, which every span inside it is remapped to. */
export interface ImportOrigin {
  readonly path: string;
  readonly span: SourceSpan;
}

export interface ContainerModel {
  /** `''` for root. */
  readonly key: string;
  readonly path: readonly string[];
  /** Resolved `@`-keys, dotted keys merged. */
  readonly config: ConfigBag;
  /** Declaration order; redeclarations merged. */
  readonly children: readonly ContainerModel[];
  /** Edges DECLARED here; endpoints are still unresolved paths. */
  readonly edges: readonly EdgeModel[];
  /** The element's `@`-keys as written, for `toJson` only (DD-02 §3.5, §6):
   *  variable references unsubstituted and `@vars` kept. Present only when
   *  it differs from `config`, i.e. when the element declares `@vars` or a
   *  value uses a variable. Every other consumer reads `config`. */
  readonly authored?: ConfigBag;
  /** A grafted import's container (DD-02 I11, I12): `toJson` leaves it out,
   *  `compile()` folds its elements' diagnostics into one `SGL2021`. */
  readonly origin?: ImportOrigin;
}

export interface EdgeModel {
  /** Relative to the declaring container. */
  readonly from: PathExpr;
  readonly to: PathExpr;
  /** A canonical-JSON `"from"`/`"to"` that is not a path (`"$a"`), kept as
   *  written: `from`/`to` is then empty, compile() reports SGL2001 naming this
   *  text, and toJson() prints it back unchanged. */
  readonly fromText?: string;
  readonly toText?: string;
  readonly fromPort?: string;
  readonly toPort?: string;
  /** `<-` is already swapped into `forward`. */
  readonly directed: 'forward' | 'both' | 'none';
  readonly config: ConfigBag;
  /** Index within the declaring chain, for stable IDs. */
  readonly ordinal: number;
  /** The element's `@`-keys as written, for `toJson` only (DD-02 §3.5, §6):
   *  variable references unsubstituted and `@vars` kept. Present only when
   *  it differs from `config`, i.e. when the element declares `@vars` or a
   *  value uses a variable. Every other consumer reads `config`. */
  readonly authored?: ConfigBag;
}

export interface ClassModel {
  readonly name: string;
  readonly extends: readonly string[];
  /** Only `@`-keys are meaningful in a class body. */
  readonly config: ConfigBag;
  /** The element's `@`-keys as written, for `toJson` only (DD-02 §3.5, §6):
   *  variable references unsubstituted, and `@extends` as written under
   *  `extends`. Present only when a value or `@extends` uses a variable.
   *  Every other consumer reads `config` and `extends`. */
  readonly authored?: ConfigBag;
  /** An imported class (DD-02 I11, I13): `toJson` leaves it out. */
  readonly origin?: ImportOrigin;
}

/** An interface rather than a mapped type, so it can reference `ConfigValue`,
 *  which references it back. */
export interface ConfigBag {
  readonly [key: string]: ConfigValue;
}

export type ConfigValue = string | number | boolean | null | readonly ConfigValue[] | ConfigBag;

/** Key: `'n:payments.api'` | `'e:payments.api#3'` | `'c:Service'`. */
export type SpanTable = ReadonlyMap<string, SourceSpan>;

/** The registry that drives validation and `toJson` emission order (DD-02 §7). */
export interface ConfigKeySpec {
  /** `'label'`, `'style.fill'`, `'layout.*'`. */
  readonly key: string;
  readonly scope: readonly ('root' | 'node' | 'edge' | 'class')[];
  readonly type: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'any';
  readonly enum?: readonly string[];
  readonly order: number;
}
