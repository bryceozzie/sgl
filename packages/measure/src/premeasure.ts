import type { LabelId } from '@sgl/core';
import type { ComputedStyle, StyledGraph } from '@sgl/theme';
import { hashRuns, UNCONSTRAINED } from './run-key.js';
import type { Measurer, MeasureTable, StyledRun, TextLayout, TextStyle } from './types.js';

/**
 * Pre-measure every label in the graph on the main thread (DD-05 §4).
 *
 * The result is a plain object keyed by `hashRuns`, which is what crosses into the
 * layout worker by `structuredClone`. Keying by the runs rather than by label ID is
 * what makes an unchanged label's entry reusable across edits, and what lets two
 * labels with the same text and style share one entry.
 *
 * Exit criterion (DD-00 §6): the table covers 100% of labels in the corpus — zero
 * worker RPC misses.
 */

/**
 * Used for any text property the cascade did not produce.
 *
 * Every built-in theme sets all six on `node.title`, `container.title` and
 * `edge.label`, so these should never be reached in practice. They exist because
 * `premeasure` must not be the stage that breaks: a missing property here would
 * otherwise produce `NaN` widths and a silently empty diagram, which is far worse
 * than a label measured at a plausible default.
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

/**
 * The `StyledRun[]` for one label: its `LabelSpec.runs` (one per line, DD-03) each
 * carrying the label's single computed text style.
 *
 * ⟶ v1.0 (A18): `TextRun.style` (`code`/`strong`/`em`) starts modulating the style
 * here. The MVP ignores it, as DD-03 says it may.
 *
 * Returns `[]` for an unknown label ID rather than throwing — a caller asking about
 * a label that is not in the graph gets an empty answer, not a crash.
 */
export function labelRuns(styled: StyledGraph, labelId: LabelId): readonly StyledRun[] {
  const spec = styled.graph.labels[labelId];
  if (spec === undefined) return [];
  const style = textStyleOf(styled.labelStyles[labelId]);
  return spec.runs.map((run) => ({ text: run.text, style }));
}

/** The `MeasureTable` key for a label. Exported so the layout worker can look an
 *  entry up without rebuilding the runs by hand and drifting out of sync. */
export function labelRunKey(styled: StyledGraph, labelId: LabelId): string {
  return hashRuns(labelRuns(styled, labelId), UNCONSTRAINED);
}

export function premeasure(styled: StyledGraph, measurer: Measurer): MeasureTable {
  const measured = new Map<string, TextLayout>();

  // Sorted: DD-00 §3 bans depending on object-key order, and the insertion order
  // here becomes the table's serialisation order.
  for (const labelId of Object.keys(styled.graph.labels).sort()) {
    const runs = labelRuns(styled, labelId as LabelId);
    const key = hashRuns(runs, UNCONSTRAINED);
    if (measured.has(key)) continue;
    measured.set(key, measurer.layoutRuns(runs, UNCONSTRAINED));
  }

  const table: Record<string, TextLayout> = {};
  for (const [key, layout] of [...measured.entries()].sort(byKey)) {
    table[key] = layout;
  }
  return table;
}

function byKey(a: readonly [string, TextLayout], b: readonly [string, TextLayout]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
