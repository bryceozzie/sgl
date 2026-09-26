import type { ConfigBag } from './model.js';
import type { EdgeId, LabelId, NodeId, PortId, ShapeId } from './ids.js';
import type { SourceSpan } from './span.js';

/** The semantic graph — the IR every layout engine sees (DD-03 §2). */
export interface SemanticGraph {
  readonly nodes: Readonly<Record<NodeId, GraphNode>>;
  /** In stable order (DD-03 §5). */
  readonly edges: readonly GraphEdge[];
  /** Top-level nodes, declaration order. */
  readonly rootChildren: readonly NodeId[];
  /** Pre-order traversal, declaration order. */
  readonly order: readonly NodeId[];
  readonly labels: Readonly<Record<LabelId, LabelSpec>>;
  readonly title?: string;
  readonly meta: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly containerCount: number;
  };
}

export interface GraphNode {
  /** `'payments.api'` (DD-03 §2.1). */
  readonly id: NodeId;
  readonly path: readonly string[];
  readonly parent: NodeId | null;
  /** Declaration order; `[]` for leaves. */
  readonly children: readonly NodeId[];
  readonly depth: number;
  /** Resolved from inline > class > default `rect`. */
  readonly shape: ShapeId;
  /** Linearised, low → high precedence. */
  readonly classes: readonly string[];
  /** `null` when `@label` is empty or the node is hidden. */
  readonly labelId: LabelId | null;
  readonly ports: readonly PortSpec[];
  /** The merged `@`-bag from DD-02 (inline only). */
  readonly config: ConfigBag;
  readonly hidden: boolean;
  readonly span: SourceSpan;
}

export interface GraphEdge {
  /** `'e-3f9a…'` (DD-03 §5). */
  readonly id: EdgeId;
  readonly from: GraphEndpoint;
  readonly to: GraphEndpoint;
  readonly directed: 'forward' | 'both' | 'none';
  readonly classes: readonly string[];
  readonly labelId: LabelId | null;
  readonly config: ConfigBag;
  /** The container whose block declared it; `null` = root. */
  readonly declaredIn: NodeId | null;
  /** Effectively hidden: its own `@hidden`, or either endpoint's node is hidden
   *  (DD-03 §6) — mirrors the node rule, not keyed off `SGL3002` (that stays
   *  keyed off hidden *nodes* only). */
  readonly hidden: boolean;
  readonly span: SourceSpan;
}

export interface GraphEndpoint {
  readonly node: NodeId;
  readonly port?: PortId;
}

export interface PortSpec {
  readonly id: PortId;
  readonly side: 'north' | 'south' | 'east' | 'west';
}

export interface LabelSpec {
  /** `'l:payments.api'` | `'l:e-3f9a…'`. */
  readonly id: LabelId;
  readonly owner: { readonly kind: 'node'; readonly id: NodeId } | { readonly kind: 'edge'; readonly id: EdgeId };
  /** `'title'` covers node and container titles. */
  readonly role: 'title' | 'edge';
  /** Canonical (DD-11 T21): maximal runs, none empty, and a hard break is a `\n`
   *  inside `text`, so a plain label is one run. */
  readonly runs: readonly TextRun[];
}

/**
 * One styled run of a label (DD-11 T21). A flag is `true` or absent, never
 * `false`; two neighbouring runs never carry the same three flags. `text` is never
 * empty, and a `code` run never contains `\n` (T8). Replaces the MVP's unused
 * `style?: 'code' | 'strong' | 'em'`, which could not say "bold and italic".
 */
export interface TextRun {
  readonly text: string;
  readonly strong?: true;
  readonly em?: true;
  readonly code?: true;
}

/** ⟶ I1 (one model, many views). `compile` takes it from day one so the signature
 *  never has to change; the MVP ignores anything but the default view. */
export interface ViewSelector {
  readonly id: string;
}
