/**
 * Text emission (DD-07 §5).
 *
 * Lines become positioned `<tspan>`s inside one `<text>`. `dominant-baseline` is
 * never used: it is inconsistent across Inkscape, Safari and resvg, and it is the
 * usual reason exported labels sit two pixels off. The baseline is computed from
 * the block's own `ascent` instead.
 */

import type { ComputedStyle } from '@sgl/theme';
import type { LabelPlacementView, TextLayoutView } from './layout-view.js';
import { escapeXml } from './security.js';
import { num, nums } from './num.js';

/** Fallback metrics, used only to reconstruct a block when the host supplies none. */
const FALLBACK_ADVANCE = 0.52;
const FALLBACK_ASCENT = 0.8;

function geometryNumber(style: ComputedStyle, key: string, fallback: number): number {
  const v = style.geometry[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Reconstruct a text block from the label's runs and its resolved text geometry.
 *
 * `LayoutResult` (DD-06 §2) carries no `TextLayout` and `render` is not handed the
 * `MeasureTable`, so when a caller cannot supply a measured block there is nothing
 * on the contract to read one from. Rather than refuse to draw the label, rebuild
 * an equivalent block from the same inputs the measurer used.
 *
 * This is a fallback and it is approximate: the line *positions* it produces are
 * exact, because they depend only on `fontSize` and `lineHeight`, but the widths
 * are estimated. Widths only affect `text-anchor: start` offsets within an already
 * placed frame, so the error is bounded and never moves a node.
 */
export function textBlock(
  lines: readonly string[],
  style: ComputedStyle,
  supplied?: TextLayoutView,
): TextLayoutView {
  if (supplied !== undefined) return supplied;

  const fontSize = geometryNumber(style, 'fontSize', 13);
  const lineHeight = geometryNumber(style, 'lineHeight', 1.3);
  const letterSpacing = geometryNumber(style, 'letterSpacing', 0);
  const lineHeightPx = fontSize * lineHeight;
  const ascent = fontSize * FALLBACK_ASCENT;

  const laid = lines.map((text, i) => {
    const glyphs = [...text].length;
    const width = glyphs * fontSize * FALLBACK_ADVANCE + Math.max(0, glyphs - 1) * letterSpacing;
    return { y: ascent + i * lineHeightPx, width, runs: [{ x: 0, text }] };
  });

  return {
    width: laid.reduce((w, l) => Math.max(w, l.width), 0),
    height: Math.max(lines.length, 1) * lineHeightPx,
    lines: laid,
    ascent,
  };
}

/** The x the `<text>` and every `<tspan>` share, from the frame and the alignment. */
function anchorX(placement: LabelPlacementView): number {
  const { frame, align } = placement;
  if (align === 'middle') return frame.x + frame.w / 2;
  if (align === 'end') return frame.x + frame.w;
  return frame.x;
}

/**
 * Emit one `<text>` element.
 *
 * `className` carries the font, which lives in the generated class and never
 * inline (DD-07 §5) — so a paint-only colour change needs no tree rewrite, while a
 * font *size* change is geometry and re-renders anyway.
 */
export function renderText(
  placement: LabelPlacementView,
  block: TextLayoutView,
  className: string,
  extraClass: string,
  ariaHidden: boolean,
): string {
  if (block.lines.length === 0) return '';

  const x = anchorX(placement);
  const y = placement.frame.y + block.ascent;
  const classes = [extraClass, className].filter((c) => c !== '').join(' ');

  const attrs = [
    `class="${escapeXml(classes)}"`,
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `text-anchor="${placement.align}"`,
    // Leading spaces in a line have to survive the round trip.
    'xml:space="preserve"',
  ];

  if (placement.rotation !== undefined && placement.rotation !== 0) {
    const cx = placement.frame.x + placement.frame.w / 2;
    const cy = placement.frame.y + placement.frame.h / 2;
    attrs.push(`transform="rotate(${nums(placement.rotation, cx, cy)})"`);
  }
  if (ariaHidden) attrs.push('aria-hidden="true"');

  let previousY = block.ascent;
  const tspans = block.lines
    .map((line, i) => {
      const dy = i === 0 ? 0 : line.y - previousY;
      previousY = line.y;
      const text = line.runs.map((r) => r.text).join('');
      return `<tspan x="${num(x)}" dy="${num(dy)}">${escapeXml(text)}</tspan>`;
    })
    .join('');

  return `<text ${attrs.join(' ')}>${tspans}</text>`;
}
