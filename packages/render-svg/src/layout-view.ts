/**
 * A structural view of `LayoutResult` (DD-06 §2).
 *
 * `@sgl/render-svg` may import only `@sgl/core` and `@sgl/theme` (DD-00 §2 rule 2),
 * and the engines sit on the other side of the same dependency graph — so the
 * renderer describes the shape of the layout it consumes rather than importing
 * `@sgl/layout-api` for it. Every field here is structurally satisfied by the real
 * `LayoutResult`, which is what makes `render(styled, layout, theme)` accept one
 * with no cast at the call site.
 *
 * Kept deliberately narrow: this is what the renderer *reads*, not a second copy
 * of the contract. `diagnostics` and `layers` are absent because the renderer uses
 * neither — z-order is the fixed layer order of DD-07 §2.
 */

import type { PathSeg, Point, Rect, Vec2 } from '@sgl/core';
import type { RunMarks } from '@sgl/text';

export interface LayoutView {
  /** Diagram-space extents. */
  readonly bounds: Rect;
  readonly nodes: Readonly<Record<string, NodeLayoutView>>;
  readonly edges: Readonly<Record<string, EdgeLayoutView>>;
  readonly labels: readonly LabelPlacementView[];
}

export interface NodeLayoutView {
  /** Absolute, diagram space. */
  readonly frame: Rect;
  /** Container interior for children. Unused by the renderer — shapes are drawn on
   *  `frame` — but named so the structural match is against the real field set. */
  readonly contentFrame?: Rect;
  readonly ports?: Readonly<Record<string, { readonly point: Point; readonly normal: Vec2 }>>;
  readonly z?: number;
}

export interface EdgeLayoutView {
  readonly start: Point;
  readonly end: Point;
  /** From `start`. */
  readonly route: readonly PathSeg[];
  readonly startNormal?: Vec2;
  readonly endNormal?: Vec2;
  readonly clip?: 'none' | 'shape';
  readonly z?: number;
}

export interface LabelPlacementView {
  readonly labelId: string;
  readonly frame: Rect;
  readonly align: 'start' | 'middle' | 'end';
  readonly baseline: 'top' | 'middle' | 'bottom';
  /** Degrees; for along-edge labels. */
  readonly rotation?: number;
  /** Draw a background plate (edge labels). */
  readonly occlusion?: 'plate' | 'none';
  readonly priority?: number;
  // A18 (DD-11 T42) removed the unused `text?: TextLayoutView` field: the
  // measured lines reach `render()` as its fourth argument, the measure table.
}

/** A fragment of a line: its text and marks (DD-11 T23). */
export interface RunView {
  readonly text: string;
  readonly marks?: RunMarks;
}

/** The part of `@sgl/text`'s `TextLayout` the renderer reads: `render()`'s
 *  measure table holds these, and `textBlock` builds one per label. */
export interface TextLayoutView {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly {
    /** Baseline offset from the top of the block. */
    readonly y: number;
    readonly width: number;
    readonly runs: readonly (RunView & { readonly x: number })[];
  }[];
  /** Of the first line, for aligning the block. */
  readonly ascent: number;
}
