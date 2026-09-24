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
}

export interface EdgeModel {
  /** Relative to the declaring container. */
  readonly from: PathExpr;
  readonly to: PathExpr;
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
