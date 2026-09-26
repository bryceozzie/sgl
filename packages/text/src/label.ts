import { labelMaxWidth, type LabelId, type TextRun } from '@sgl/core';
import type { ComputedStyle, StyledGraph } from '@sgl/theme';
import { runStyle } from './faces.js';
import { hashRuns, UNCONSTRAINED } from './run-key.js';
import type { BoxConstraints, StyledRun, TextStyle } from './types.js';

/**
 * A label's runs, faces and box, from a `StyledGraph` (DD-11 T2, T25, T29, T35).
 * Moved here from `@sgl/measure`'s `premeasure.ts` so that every consumer of the
 * measure table computes a label's key with one function.
 */

/**
 * Used for any text property the cascade did not produce. Every built-in theme
 * sets all six on `node.title`, `container.title` and `edge.label`, so these are a
 * guard, not a default anyone sees: a missing property must not produce `NaN`
 * widths and a silently empty diagram.
 */
export const DEFAULT_TEXT_STYLE: TextStyle = Object.freeze({
  fontFamily: 'sans-serif',
  fontSize: 12,
  fontWeight: 400,
  fontStyle: 'normal',
  lineHeight: 1.2,
  letterSpacing: 0,
});

/** Project a label's `ComputedStyle` onto the six text properties DD-04's registry
 *  marks `appliesTo: text, affects: geometry`. */
export function textStyleOf(style: ComputedStyle | undefined): TextStyle {
  const g = style?.geometry;
  return {
    fontFamily: asString(g?.['fontFamily'], DEFAULT_TEXT_STYLE.fontFamily),
    fontSize: asNumber(g?.['fontSize'], DEFAULT_TEXT_STYLE.fontSize),
    fontWeight: asNumber(g?.['fontWeight'], DEFAULT_TEXT_STYLE.fontWeight),
    fontStyle: g?.['fontStyle'] === 'italic' ? 'italic' : 'normal',
    lineHeight: asNumber(g?.['lineHeight'], DEFAULT_TEXT_STYLE.lineHeight),
    letterSpacing: asNumber(g?.['letterSpacing'], DEFAULT_TEXT_STYLE.letterSpacing),
  };
}

/** A run's text, concatenated (T22). `\n` is a hard break; the accessibility label
 *  replaces it with a space. */
export function plainText(runs: readonly { readonly text: string }[]): string {
  return runs.map((r) => r.text).join('');
}

/**
 * The `StyledRun[]` for one label: each `TextRun` in its own face (`runStyle`, T25)
 * with its marks. `[]` for an unknown label ID rather than a throw.
 */
export function labelRuns(styled: StyledGraph, labelId: LabelId): readonly StyledRun[] {
  const spec = styled.graph.labels[labelId];
  if (spec === undefined) return [];
  const base = textStyleOf(styled.labelStyles[labelId]);
  return spec.runs.map((run: TextRun) => {
    if (!run.strong && !run.em && !run.code) return { text: run.text, style: base };
    const marks = { ...(run.strong && { strong: true as const }), ...(run.em && { em: true as const }), ...(run.code && { code: true as const }) };
    return { text: run.text, style: runStyle(base, marks), marks };
  });
}

/**
 * The label's box (T29, T35, T36): `{ maxWidth }` for a node title whose node has a
 * finite positive `@size.maxWidth` or `@size.width` (the smaller wins), as the
 * cascade resolved it into `styles[node].geometry`, turned into the widest label
 * that still fits the node by `labelMaxWidth`. With `width` and no `maxWidth` the
 * box keeps words whole (`keepWords`, human decision H1): a word too wide
 * overflows as before A18, and only `maxWidth` asks for words to be split.
 * Otherwise unconstrained: edge labels have no `@size`, so they break only at `\n`.
 */
export function labelBox(styled: StyledGraph, labelId: LabelId): BoxConstraints {
  const owner = styled.graph.labels[labelId]?.owner;
  if (owner?.kind !== 'node') return UNCONSTRAINED;
  const g = styled.styles[owner.id]?.geometry;
  const positive = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : Infinity);
  const max = positive(g?.['maxWidth']);
  const width = Math.min(max, positive(g?.['width']));
  const node = styled.graph.nodes[owner.id];
  if (width === Infinity || node === undefined) return UNCONSTRAINED;
  const maxWidth = labelMaxWidth(node.shape, width, g?.['padding']);
  // Only an author's maxWidth asks for words to be split (human decision H1); a
  // hexagon's width depends on the label's height, which the breaker settles.
  return { maxWidth, ...(max === Infinity && { keepWords: true as const }), ...(node.shape === 'hexagon' && { hexagon: true as const }) };
}

/** The `MeasureTable` key for a label: `hashRuns(labelRuns(…), labelBox(…))`. */
export function labelRunKey(styled: StyledGraph, labelId: LabelId): string {
  return hashRuns(labelRuns(styled, labelId), labelBox(styled, labelId));
}

/** The wrap gate (T53): true when some label has a box, so its measurement needs
 *  `layoutWrapped` (`@sgl/text/wrap`). */
export function needsWrap(styled: StyledGraph): boolean {
  return Object.keys(styled.graph.labels).some((id) => labelBox(styled, id as LabelId).maxWidth !== undefined);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
