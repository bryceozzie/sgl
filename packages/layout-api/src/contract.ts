import type {
  Diagnostic,
  EdgeId,
  Insets,
  LabelId,
  NodeId,
  PathSeg,
  Point,
  Rect,
  SemanticGraph,
  Size,
  Vec2,
} from '@sgl/core';

/** A JSON Schema draft-07 document. Kept structural so the contract carries no
 *  dependency on a schema library (06 §5 — Zod internally, JSON Schema emitted). */
export type JSONSchema7 = Readonly<Record<string, unknown>>;

/** The contract version. Engines declare it; the host refuses anything else. */
export const LAYOUT_API_VERSION = 1 as const;

export interface EngineCapabilities {
  /** Can lay out nested compound graphs. */
  readonly containers: boolean;
  readonly edgeRouting: 'straight' | 'orthogonal' | 'spline' | 'custom';
  readonly ports: boolean;
  /** `false` => the host applies default label placement. */
  readonly labelPlacement: boolean;
  /** Can accept a previous result as a hint. */
  readonly incremental: boolean;
  /**
   * Reproducibility class (ADR-0004). Keys the render cache, selects which engines
   * join the cross-environment golden test, and is surfaced in the engine picker.
   */
  readonly determinism: 'bitwise' | 'quantized' | 'best-effort';
}

/**
 * What an engine is.
 *
 * `capabilities` lets the host fill gaps rather than reject an engine: one that
 * only places nodes (`labelPlacement: false`, `edgeRouting: 'straight'`) is
 * perfectly valid, because the host runs default label placement and straight-line
 * routing over its output. This is the main thing that makes writing an engine
 * approachable.
 */
export interface LayoutEngine {
  /** Reverse-DNS, e.g. `'org.example.rack-layout'`. */
  readonly id: string;
  readonly name: string;
  /** semver */
  readonly version: string;
  readonly apiVersion: typeof LAYOUT_API_VERSION;

  readonly capabilities: EngineCapabilities;

  /** Drives validation AND the settings UI. */
  readonly optionsSchema?: JSONSchema7;
  /** Engine-specific `@layout.*` hint keys. Declared so hints get validation,
   *  autocomplete and generated docs instead of being undocumented magic strings. */
  readonly hintsSchema?: JSONSchema7;
  readonly defaults?: Readonly<Record<string, unknown>>;

  layout(input: LayoutInput, ctx: LayoutContext): Promise<LayoutResult>;
}

export interface LayoutInput {
  /** Frozen; the subtree this engine owns. */
  readonly graph: SemanticGraph;
  /** `null` = the whole document. */
  readonly scope: NodeId | null;
  /**
   * Per-node sizing (DD-06 §2), keyed by `NodeId`.
   *
   * DEVIATION from the Architecture §4.2 sketch and DD-06 §2's prose, both of which
   * put `sizing` directly on `GraphNode`: `@sgl/core`'s actual `GraphNode` (frozen
   * by Stage C) carries no geometry at all, so there is nowhere on the node itself
   * to hang it. It travels alongside `graph` instead. See `NodeSizing` and
   * `buildLayoutInput()` (`sizing.ts`).
   */
  readonly sizing: Readonly<Record<NodeId, NodeSizing>>;
  /** Measured size of every label in `graph.labels`, keyed by `LabelId`. Needed by
   *  engines that do their own label-aware packing and by the host's label-placement
   *  and edge-routing fallbacks alike — neither gets a `StyledGraph`, so this is the
   *  only place a label's pixel size is available (DD-06 §2, §4.1). */
  readonly labelSizes: Readonly<Record<LabelId, Size>>;
}

/**
 * `intrinsic`/`min`/`max`/`fixed`/`aspectRatio` are exactly DD-06 §2's recipe.
 *
 * Two insets, not one, because DD-06 §4.1 and §2 use "padding"/"content insets" for
 * two different boxes:
 * - `contentInset` — theme padding plus the shape's own content inset (DD-07 §4),
 *   with **no** title band. This is a leaf's own title box, and it is where a
 *   container's *own* title sits (DD-06 §4.1: "top-left of frame inset by
 *   padding.left, padding.top").
 * - `padding` — `contentInset`, plus for a container the title band on top. This is
 *   where a container's *children* start, so `grid` (DD-06 §7) packs against it.
 *
 * They are equal for a leaf (no title band to add).
 */
export interface NodeSizing {
  readonly intrinsic: Size;
  readonly min?: Partial<Size>;
  readonly max?: Partial<Size>;
  readonly fixed?: Partial<Size>;
  readonly aspectRatio?: number;
  readonly contentInset: Insets;
  readonly padding: Insets;
}

export interface LayoutContext {
  /** Schema-validated against `optionsSchema`. */
  readonly options: Readonly<Record<string, unknown>>;
  /** The small set of theme-derived numbers an engine may want for defaults.
   *  Engines never see a `StyledGraph`. */
  readonly metrics: ResolvedThemeMetricsView;
  /** For labels created during layout. */
  readonly measure: MeasurerView;
  /** SEEDED. `Math.random` is banned (DD-00 §3). */
  readonly random: () => number;
  readonly signal: AbortSignal;
  /** For incremental engines. */
  readonly previous?: LayoutResult;

  log(level: 'info' | 'warn' | 'error', message: string, nodeId?: NodeId): void;

  /**
   * RESERVED in apiVersion 1. Delegates a subtree to another engine (per-container
   * layouts). Published now and implemented later: adding an optional context
   * method is not a breaking change for engines, but declaring it now means engines
   * written against apiVersion 1 stay valid when it lands, with no version bump.
   */
  sublayout(engineId: string, scope: NodeId, options?: object): Promise<LayoutResult>;
}

/** Structural views of `@sgl/theme` and `@sgl/measure`, so the engine contract does
 *  not force an engine to depend on either package. */
export interface ResolvedThemeMetricsView {
  readonly spacing: { readonly node: number; readonly rank: number; readonly edgeLabel: number };
  readonly stroke: Readonly<Record<string, number>>;
  readonly arrowSize: number;
}

export interface MeasurerView {
  layoutRuns(runs: readonly unknown[], box: { readonly maxWidth?: number }): unknown;
}

export interface LayoutResult {
  /** Diagram-space extents. */
  readonly bounds: Rect;
  readonly nodes: Readonly<Record<NodeId, NodeLayout>>;
  readonly edges: Readonly<Record<EdgeId, EdgeLayout>>;
  readonly labels: readonly LabelPlacement[];
  /** Explicit z-order groups. */
  readonly layers?: readonly LayerSpec[];
  readonly diagnostics?: readonly Diagnostic[];
}

export interface NodeLayout {
  /** Absolute, diagram space. */
  readonly frame: Rect;
  /** Container interior for children. */
  readonly contentFrame?: Rect;
  readonly ports?: Readonly<Record<string, { readonly point: Point; readonly normal: Vec2 }>>;
  readonly z?: number;
}

export interface EdgeLayout {
  readonly start: Point;
  readonly end: Point;
  /** From `start`. */
  readonly route: readonly PathSeg[];
  /** Arrowhead orientation at the tail. */
  readonly startNormal?: Vec2;
  /** ...and the head. */
  readonly endNormal?: Vec2;
  /** Trim the route at node boundaries. */
  readonly clip?: 'none' | 'shape';
  readonly z?: number;
}

/**
 * Where "where titles are placed" lives, as required by FR-Y2. Container titles,
 * node titles, edge labels and port labels all flow through this one structure, so
 * an engine can put a container title top-left, centred above, or rotated down the
 * left edge — whatever its design calls for.
 */
export interface LabelPlacement {
  /** References a `LabelSpec` on a node or edge. */
  readonly labelId: LabelId;
  readonly frame: Rect;
  readonly align: 'start' | 'middle' | 'end';
  readonly baseline: 'top' | 'middle' | 'bottom';
  /** Degrees; for along-edge labels. */
  readonly rotation?: number;
  /** Draw a background plate (edge labels). */
  readonly occlusion?: 'plate' | 'none';
  /** Higher survives collision culling. */
  readonly priority?: number;
}

export interface LayerSpec {
  readonly id: string;
  readonly z: number;
}
