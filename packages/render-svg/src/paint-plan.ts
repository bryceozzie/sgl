/**
 * The paint-only path (F9 P3/P4, `feat/theme-fast-path`, execution plan §2;
 * DD-07 §6, §11).
 *
 * Since F7 a render's structure — every element, every `class` attribute,
 * every marker id and reference, the `<defs>` text — is a function of the
 * graph, the layout and the geometry of the styles (plus the arrowhead kind),
 * never of a paint value. Paint lives only in the text of the one `<style>`
 * element. So once a document has been rendered in full, the same layout under
 * new paint needs only a new `<style>` text, and that text needs only one style
 * per paint rule: every element that shares a paint class shares its cascade
 * signature, hence its paint (`cascadeSignature`, DD-04 §4).
 *
 * `PaintPlan` is what `render()` keeps for that: for each paint rule it
 * emitted, its class name, its kind and the element whose style it was made
 * from; the layout it was drawn with; and its own SVG string, from which any
 * paint-only result's SVG is derived by replacing the `<style>` text
 * (`withStyleBlock`).
 * `renderPaintOnly` (`index.ts`) uses it.
 */

import type { StyledGraph } from '@sgl/theme';
import type { LayoutView, TextLayoutView } from './layout-view.js';
import { escapeXml } from './security.js';
import { buildStyleBlock, ClassTable, type RuleKind } from './style.js';

/**
 * One paint rule of a render: its kind — a paint class (`shape`/`text`/
 * `plate`, keyed by its cascade signature, made from its element's style, a
 * label's for `text`) or a marker's own paint (`mf` filled, `ms` stroked,
 * keyed by its class name, made from its edge's stroke) — its key, and the
 * id of the element or label its first use came from.
 */
export type PaintRule = readonly [kind: RuleKind | 'mf' | 'ms', key: string, id: string];

/**
 * What a full `render()` keeps so that a later render of the same layout under
 * other paint can be made from it without walking the elements: the layout
 * object it was drawn with, its own SVG string and its paint rules. Its
 * identity also names the element tree it was rendered as: two results with
 * the same plan differ only in their `<style>` text.
 */
export interface PaintPlan {
  readonly layout: LayoutView;
  /** The measure table it was drawn with (DD-11 T42): which fragments sit on
   *  which line. `renderPaintOnly` requires the same object. */
  readonly text: Readonly<Record<string, TextLayoutView>> | undefined;
  readonly svg: string;
  readonly rules: readonly PaintRule[];
  /** The run rules it emitted, as `markBits` (T44): the paint-only path emits
   *  the same ones. */
  readonly runs: number;
}

/**
 * The `<style>` text the full render of `plan` would emit under `styled`'s
 * paint, made by a fresh `ClassTable` fed one style per paint rule — the same
 * names, rules and order `render()` gives, geometry rules included (equal
 * geometry is part of the caller's guard, and elements that share a paint
 * class share their geometry declarations). `null` if `styled` lacks one of
 * those styles (a different graph: the guard should already have said so).
 */
export function paintOnlyStyleBlock(plan: PaintPlan, styled: StyledGraph): string | null {
  const table = new ClassTable();
  table.runs = plan.runs;
  for (const [kind, key, id] of plan.rules) {
    const style = kind === 'text' ? styled.labelStyles[id as keyof StyledGraph['labelStyles']] : styled.styles[id as keyof StyledGraph['styles']];
    if (style === undefined) return null;
    if (kind === 'mf' || kind === 'ms') {
      const stroke = style.paint['stroke'];
      table.markerPaint(key, kind === 'ms', typeof stroke === 'string' ? stroke : '#000000');
    } else if (kind === 'shape') table.shapeClasses(style, key);
    else if (kind === 'text') table.textClasses(style, key);
    else table.plateClasses(style, key);
  }
  return buildStyleBlock(styled.canvas.background, table.emit());
}

/**
 * `svg` with the text of its one `<style>` element replaced by `styleBlock`,
 * escaped exactly as `render()` escapes it. For two renders of the same layout
 * with equal `structureHash`, `withStyleBlock(one.svg, other.styleBlock) ===
 * other.svg` (DD-07 §6: everything outside the `<style>` and `<defs>` texts is
 * the same, and the `<defs>` text is a function of the structure too). The
 * first `<style>` is the one: `render()` writes exactly one, before anything
 * author-controlled, and escapes every `<` inside the text it writes.
 */
export function withStyleBlock(svg: string, styleBlock: string): string {
  const open = svg.indexOf('<style>') + '<style>'.length;
  return svg.slice(0, open) + escapeXml(styleBlock) + svg.slice(svg.indexOf('</style>', open));
}
