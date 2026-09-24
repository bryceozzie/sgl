import type { EdgeId, LabelId, NodeId, SemanticGraph } from '@sgl/core';

export type StyleValue = string | number | boolean | readonly number[];

/** `Partial<Record<propertyName, value | '@token'>>` (DD-04 §3). */
export type StyleSet = Readonly<Record<string, StyleValue>>;

/** A theme document, as authored. Flat tokens plus rules; the registry decides
 *  which resolved properties invalidate layout, not the document's shape. */
export interface ThemeDoc {
  readonly id: string;
  readonly name: string;
  readonly schemaVersion: 1;
  readonly extends: string | null;
  /** Flat, dotted names, any value type. */
  readonly tokens: Readonly<Record<string, StyleValue>>;
  /** Keyed by role: `node`, `node.title`, `container`, `container.title`, `edge`, `edge.label`. */
  readonly rules: Readonly<Record<string, StyleSet>>;
  readonly byShape: Readonly<Record<string, StyleSet>>;
  readonly byClass: Readonly<Record<string, StyleSet>>;
  readonly canvas: { readonly background: string };
  /** DD-04 §4 step 7 (C5): paint properties forced over the whole cascade,
   *  the document's classes and inline `@style` included — how `print` makes
   *  every fill white and every stroke black. Paint only: a geometry property
   *  here is `SGL5003` and dropped, so a theme's metrics never depend on it. */
  readonly force?: StyleSet;
}

/** The same document with inheritance followed, `@token` references resolved and
 *  values normalised (DD-04 §3). No `@` references remain. */
export interface ResolvedTheme {
  readonly id: string;
  readonly rules: Readonly<Record<string, StyleSet>>;
  readonly byShape: Readonly<Record<string, StyleSet>>;
  readonly byClass: Readonly<Record<string, StyleSet>>;
  readonly canvas: { readonly background: string };
  readonly tokens: Readonly<Record<string, StyleValue>>;
  /** DD-04 §4 step 7; present only when the theme forces anything. */
  readonly force?: StyleSet;
}

/** The small set of theme-derived numbers a layout engine may want for defaults
 *  (DD-06 §2). Engines never see a `StyledGraph`. */
export interface ResolvedThemeMetrics {
  readonly spacing: { readonly node: number; readonly rank: number; readonly edgeLabel: number };
  readonly stroke: Readonly<Record<string, number>>;
  readonly arrowSize: number;
}

export interface ComputedStyle {
  readonly geometry: Readonly<Record<string, number | string | readonly number[]>>;
  readonly paint: Readonly<Record<string, number | string | readonly number[]>>;
  /** fnv1a64 over sorted `k=v` of `geometry`. */
  readonly geometryHash: string;
  /** Likewise over `paint`. */
  readonly paintHash: string;
}

export interface StyledGraph {
  readonly graph: SemanticGraph;
  readonly styles: Readonly<Record<NodeId | EdgeId, ComputedStyle>>;
  /** Text properties only. */
  readonly labelStyles: Readonly<Record<LabelId, ComputedStyle>>;
  readonly canvas: { readonly background: string };
  readonly themeId: string;
  /** Hash of every element geometry hash in `graph.order` — one number answering
   *  "does layout need to re-run?". */
  readonly geometryHash: string;
  /** Computed on first read (F9; DD-04 §5): nothing on a theme switch's own
   *  path needs it. */
  readonly paintHash: string;
}
