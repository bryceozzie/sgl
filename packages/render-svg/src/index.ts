import { NotImplemented, type Rect } from '@sgl/core';
import type { ResolvedTheme, StyledGraph } from '@sgl/theme';

export * from './shapes.js';

export interface RenderResult {
  readonly svg: string;
  /** Returned separately so the live view can replace only the `<style>` text on a
   *  paint-only change — equal `geometryHash`, different `paintHash` (DD-08 §3). */
  readonly styleBlock: string;
  readonly bounds: Rect;
}

/**
 * A pure string renderer. No DOM, no virtual DOM: the document is regenerated
 * whole, so a virtual DOM buys nothing. The same function serves the live view,
 * export, the CLI and, later, the Worker.
 *
 * Layer order is fixed: containers, edges, nodes, edge labels.
 *
 * Exit criterion (DD-00 §6): byte-identical goldens, an accessibility tree present,
 * and the injection corpus producing no executable content.
 *
 * `layout` is typed structurally rather than imported, because `@sgl/render-svg`
 * must not depend on `@sgl/layout-api` (DD-00 §2 rule 2) — engines and renderer are
 * on opposite sides of the same graph.
 *
 * Design: DD-07.
 */
export function render(
  styled: StyledGraph,
  layout: { readonly bounds: Rect },
  theme: ResolvedTheme,
): RenderResult {
  void styled;
  void layout;
  void theme;
  throw new NotImplemented('render()', 'DD-07');
}

/** Escape a string for a text node or attribute value. Every string that reaches
 *  markup goes through here; link schemes are allowlisted separately (DD-07 §8). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `@link` is restricted to these (language spec §4); anything else is dropped with
 *  SGL6001. */
export const ALLOWED_LINK_SCHEMES: readonly string[] = ['https:', 'mailto:'];
