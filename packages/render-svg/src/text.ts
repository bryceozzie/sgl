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

/**
 * `placement.align` is typed as `'start' | 'middle' | 'end'`, but that union is a
 * compile-time promise only: a third-party engine's output crosses a runtime
 * boundary (today, a hand-built `LayoutView`; from Stage H onward, JSON over a
 * worker, which erases the union entirely) with no guarantee the value is one of
 * the three. `'middle'` is the fallback for anything else, not `'start'`, because
 * it keeps the text inside the frame the engine gave — `'start'` can overflow the
 * frame to the right, `'middle'` only ever centres within it.
 */
function safeAlign(align: string): 'start' | 'middle' | 'end' {
  return align === 'start' || align === 'middle' || align === 'end' ? align : 'middle';
}

/** The x the `<text>` and every `<tspan>` share, from the frame and the alignment. */
function anchorX(placement: LabelPlacementView): number {
  const { frame } = placement;
  const align = safeAlign(placement.align);
  if (align === 'middle') return frame.x + frame.w / 2;
  if (align === 'end') return frame.x + frame.w;
  return frame.x;
}

/**
 * `placement.baseline` (DD-06 §2), honoured for the first time: `'top'` is the
 * behaviour every render already had (`frame.y + block.ascent`); `'middle'` and
 * `'bottom'` centre or bottom-align the measured block within `frame.h` instead.
 * Latent until now because the host fallbacks (`placeNodeLabel`/`placeEdgeLabel`
 * in `layout-api/fallbacks.ts`) always emit a frame sized exactly to the label,
 * where `top` and `middle` coincide — a third-party engine returning a taller
 * frame with `baseline: 'middle'` was silently top-aligned. An unrecognised value
 * falls back to `'top'`, matching what every existing render already does.
 */
function baselineY(placement: LabelPlacementView, block: TextLayoutView): number {
  const { frame, baseline } = placement;
  if (baseline === 'middle') return frame.y + (frame.h - block.height) / 2 + block.ascent;
  if (baseline === 'bottom') return frame.y + frame.h - block.height + block.ascent;
  return frame.y + block.ascent;
}

/**
 * Emit one `<text>` element.
 *
 * `className` carries the font, which lives in the generated class and never
 * inline (DD-07 §5), so font declarations are not repeated on every element that
 * shares them. The text colour is the `t-{token}` class, named after the
 * label's cascade signature rather than its paint (F7; DD-07 §6), so a colour
 * change is a new declaration inside the same class, never a new class name.
 * Font *size* is geometry and lives in its own `g-{hash}`, which a paint change
 * never touches.
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
  const y = baselineY(placement, block);
  const classes = [extraClass, className].filter((c) => c !== '').join(' ');

  const attrs = [
    `class="${escapeXml(classes)}"`,
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `text-anchor="${safeAlign(placement.align)}"`,
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
