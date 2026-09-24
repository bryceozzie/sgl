/**
 * The paint-only path (F9 P3/P4, execution plan §2.1; DD-07 §6, §11).
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
 * emitted, its class name, its kind and one element whose style it was made
 * from; the geometry rules verbatim (equal geometry is part of the guard); the
 * layout it was drawn with; and its own SVG string, from which any paint-only
 * result's SVG is derived by replacing the `<style>` text (`withStyleBlock`).
 * `renderPaintOnly` (`index.ts`) uses it.
 */

import type { StyledGraph } from '@sgl/theme';
import type { LayoutView } from './layout-view.js';
import { escapeXml, cssColor } from './security.js';
import { buildStyleBlock, paintDeclarations, type RuleKind } from './style.js';

/** Where a rule's style lives in a `StyledGraph`: an element's own style
 *  (`styles[id]`) or a label's (`labelStyles[id]`). */
export interface StyleRef {
  readonly id: string;
  readonly label: boolean;
}

/** One paint rule of a render: a paint class (`s-`/`t-`/`p-`) made from its
 *  representative's paint, or a marker's own paint (`mf-`/`ms-`) made from
 *  its edge's stroke. */
export interface PaintRule {
  readonly name: string;
  readonly kind: RuleKind | 'marker-fill' | 'marker-stroke';
  readonly ref: StyleRef;
}

/**
 * What a full `render()` keeps so that a later render of the same layout under
 * other paint can be made from it without walking the elements. Opaque to
 * callers (its fields are private, so it serialises as `{}`); its identity
 * also names the element tree it was rendered as: two results with the same
 * plan differ only in their `<style>` text.
 */
export class PaintPlan {
  readonly #layout: LayoutView;
  readonly #svg: string;
  readonly #paint: readonly PaintRule[];
  readonly #fixed: readonly (readonly [string, string])[];

  constructor(layout: LayoutView, svg: string, paint: readonly PaintRule[], fixed: readonly (readonly [string, string])[]) {
    this.#layout = layout;
    this.#svg = svg;
    this.#paint = paint;
    this.#fixed = fixed;
  }

  /** Whether this plan was rendered with exactly this layout object. */
  drewWith(layout: LayoutView): boolean {
    return this.#layout === layout;
  }

  /** The full render's own SVG string. */
  get svg(): string {
    return this.#svg;
  }

  /**
   * The `<style>` text the full render would have emitted under `styled`'s
   * paint, or `null` if `styled` lacks a style one of the rules was made from
   * (a different graph: the caller's guard should already have said so).
   * One style read per paint rule.
   */
  styleBlockFor(styled: StyledGraph): string | null {
    const rules = new Map<string, string>(this.#fixed);
    for (const rule of this.#paint) {
      const style = rule.ref.label ? styled.labelStyles[rule.ref.id as keyof StyledGraph['labelStyles']] : styled.styles[rule.ref.id as keyof StyledGraph['styles']];
      if (style === undefined) return null;
      if (rule.kind === 'marker-fill' || rule.kind === 'marker-stroke') {
        // `ClassTable.markerPaint`: the edge's stroke, `#000000` without one.
        const stroke = style.paint['stroke'];
        const color = cssColor(typeof stroke === 'string' ? stroke : '#000000');
        rules.set(rule.name, rule.kind === 'marker-stroke' ? `stroke:${color}` : `fill:${color}`);
        continue;
      }
      // `ClassTable.classesFor`: a class whose paint has no declarations under
      // this theme keeps its name on the element; only its rule is omitted.
      const declarations = paintDeclarations(style.paint, rule.kind);
      if (declarations.length > 0) rules.set(rule.name, declarations.join(';'));
    }
    const generated = [...rules.keys()].sort().map((name) => `.${name}{${rules.get(name) as string}}`);
    return buildStyleBlock(styled.canvas.background, generated);
  }
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
  const open = svg.indexOf('<style>');
  const close = open < 0 ? -1 : svg.indexOf('</style>', open);
  if (close < 0) throw new Error('withStyleBlock: not a render() output (no <style> element)');
  return svg.slice(0, open + '<style>'.length) + escapeXml(styleBlock) + svg.slice(close);
}
