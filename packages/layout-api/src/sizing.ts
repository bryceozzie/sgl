import type { Insets, LabelId, NodeId, SemanticGraph, Size } from '@sgl/core';
import { contentInsets } from './content-insets.js';
import type { LayoutInput, NodeSizing } from './contract.js';

/**
 * A structural view of `@sgl/theme`'s `ComputedStyle`/`StyledGraph` — just the
 * `geometry` bag every element carries. Declared here rather than imported so
 * `layout-api` stays on `@sgl/core` only (DD-00 §2 rule 2; enforced by
 * `eslint.config.js`), the same reason `ResolvedThemeMetricsView`/`MeasurerView`
 * are structural in `contract.ts`.
 */
export interface GeometryStyle {
  readonly geometry: Readonly<Record<string, number | string | readonly number[]>>;
}

export interface StyledGraphInput {
  readonly graph: SemanticGraph;
  /** Keyed by `NodeId | EdgeId`, exactly as `StyledGraph.styles` is. */
  readonly styles: Readonly<Record<string, GeometryStyle>>;
}

/**
 * Build a `LayoutInput` from a styled graph and every label's measured size
 * (DD-06 §2).
 *
 * DEVIATION: DD-06 §2 writes this as `buildLayoutInput(styled, table)` where
 * `table` is the runKey-keyed `MeasureTable` and the function itself computes
 * `hashRuns(...)` to look a label up. That function lives in `@sgl/measure`
 * (`run-key.ts`) along with the `StyledRun`/`TextStyle` types it needs, and
 * `layout-api` may not depend on `@sgl/measure` any more than on `@sgl/theme`.
 * The join from `LabelSpec.runs` + computed text style -> `MeasureTable` entry is
 * therefore done by the caller (whoever already holds both the `StyledGraph` and
 * the `MeasureTable` — Stage G's pipeline harness, eventually), and this function
 * takes the already-resolved `LabelId -> Size` table instead.
 */
export function buildLayoutInput(
  styled: StyledGraphInput,
  labelSizes: Readonly<Record<LabelId, Size>>,
  scope: NodeId | null = null,
): LayoutInput {
  const sizing: Record<NodeId, NodeSizing> = {};
  for (const id of styled.graph.order) {
    sizing[id] = nodeSizing(styled, id, labelSizes);
  }
  return { graph: styled.graph, scope, sizing, labelSizes };
}

const ZERO_SIZE: Size = { w: 0, h: 0 };

function nodeSizing(
  styled: StyledGraphInput,
  id: NodeId,
  labelSizes: Readonly<Record<LabelId, Size>>,
): NodeSizing {
  const node = styled.graph.nodes[id];
  if (node === undefined) throw new Error(`buildLayoutInput: unknown node '${id}'.`);
  const g = styled.styles[id]?.geometry ?? {};
  const label = node.labelId !== null ? (labelSizes[node.labelId] ?? ZERO_SIZE) : ZERO_SIZE;

  const padding = insetsOf(g['padding']);
  const shapeInset = contentInsets(node.shape, label.w, label.h);
  const contentInset: Insets = addInsets(padding, shapeInset);

  const intrinsic: Size = {
    w: label.w + contentInset[1] + contentInset[3],
    h: label.h + contentInset[0] + contentInset[2],
  };

  let childPadding = contentInset;
  if (node.children.length > 0) {
    const titleGap = numberOf(g['titleGap'], 0);
    const titleHeight = label.h + titleGap;
    childPadding = [contentInset[0] + titleHeight, contentInset[1], contentInset[2], contentInset[3]];
  }

  const min = optionalSize(g['minWidth'], g['minHeight']);
  const max = optionalSize(g['maxWidth'], g['maxHeight']);
  const fixed = optionalSize(g['width'], g['height']);
  const aspectRatio = typeof g['aspectRatio'] === 'number' ? g['aspectRatio'] : undefined;

  return {
    intrinsic,
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
    ...(fixed !== undefined && { fixed }),
    ...(aspectRatio !== undefined && { aspectRatio }),
    contentInset,
    padding: childPadding,
  };
}

function insetsOf(v: unknown): Insets {
  if (Array.isArray(v) && v.length === 4) {
    const [t, r, b, l] = v as readonly unknown[];
    if (isNum(t) && isNum(r) && isNum(b) && isNum(l)) return [t, r, b, l];
  }
  return [0, 0, 0, 0];
}

function addInsets(a: Insets, b: Insets): Insets {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}

function numberOf(v: unknown, fallback: number): number {
  return isNum(v) ? v : fallback;
}

function optionalSize(w: unknown, h: unknown): Partial<Size> | undefined {
  const hasW = isNum(w);
  const hasH = isNum(h);
  if (!hasW && !hasH) return undefined;
  return { ...(hasW && { w }), ...(hasH && { h }) };
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
