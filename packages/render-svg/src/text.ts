/**
 * Text emission (DD-07 §5).
 *
 * Lines become positioned `<tspan>`s inside one `<text>`. `dominant-baseline` is
 * never used: it is inconsistent across Inkscape, Safari and resvg, and it is the
 * usual reason exported labels sit two pixels off. The baseline is computed from
 * the block's own `ascent` instead.
 */

import type { RunMarks } from '@sgl/text';
import type { ComputedStyle } from '@sgl/theme';
import type { LabelPlacementView, RunView, TextLayoutView } from './layout-view.js';
import { escapeXml } from './security.js';
import { num, nums } from './num.js';

/** The renderer's own metrics: an estimated advance, and the ascent it has
 *  always drawn with (DD-11 §19 item 5: Inter's measured ascent is larger). */
const FALLBACK_ADVANCE = 0.52;
const FALLBACK_ASCENT = 0.8;

function geometryNumber(style: ComputedStyle, key: string, fallback: number): number {
  const v = style.geometry[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * A label's text block: its lines, placed by the renderer's own vertical model.
 *
 * `lines` holds each line's fragments with their marks: the lines measurement
 * broke, from the measure table, when `render()` is given one (DD-11 T42), and
 * otherwise the label's runs split at `\n`. Only *which* fragments sit on which
 * line comes from measurement. The positions are computed here from `fontSize`
 * and `lineHeight` alone, as they always have been — `0.8 × fontSize` to the
 * first baseline, `fontSize × lineHeight` per line — which keeps every existing
 * render byte-identical (T42; the measured ascent is §19 item 5's decision).
 * The widths are estimates: no emitted attribute reads them.
 */
export function textBlock(lines: readonly (readonly RunView[])[], style: ComputedStyle): TextLayoutView {
  const fontSize = geometryNumber(style, 'fontSize', 13);
  const lineHeight = geometryNumber(style, 'lineHeight', 1.3);
  const letterSpacing = geometryNumber(style, 'letterSpacing', 0);
  const lineHeightPx = fontSize * lineHeight;
  const ascent = fontSize * FALLBACK_ASCENT;

  const laid = lines.map((runs, i) => {
    const glyphs = [...runs.map((r) => r.text).join('')].length;
    const width = glyphs * fontSize * FALLBACK_ADVANCE + Math.max(0, glyphs - 1) * letterSpacing;
    return { y: ascent + i * lineHeightPx, width, runs: runs.map((r) => ({ ...r, x: 0 })) };
  });

  return {
    width: laid.reduce((w, l) => Math.max(w, l.width), 0),
    height: Math.max(lines.length, 1) * lineHeightPx,
    lines: laid,
    ascent,
  };
}

/** A run's marks as bits, in the order their rules are emitted (DD-11 T44):
 *  `em` 1, `code` 2, `strong` 4. 0 for a plain run. */
export function markBits(m: RunMarks | undefined): number {
  return m === undefined ? 0 : (m.em ? 1 : 0) | (m.code ? 2 : 0) | (m.strong ? 4 : 0);
}

/** A marked fragment's `class`: `r-strong`, `r-em`, `r-code`, in that order,
 *  for the marks it carries (T43). */
function runClass(bits: number): string {
  return [bits & 4 && 'r-strong', bits & 1 && 'r-em', bits & 2 && 'r-code'].filter(Boolean).join(' ');
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
  used?: { runs: number },
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
      // A plain fragment is bare text; a marked one is a nested tspan with no
      // position of its own, so the viewer flows the line as one text chunk
      // and `text-anchor` aligns all of it (DD-11 T43). `used` collects the
      // marks drawn, for the run rules (T44).
      let text = '';
      for (const r of line.runs) {
        const bits = markBits(r.marks);
        if (used) used.runs |= bits;
        text += bits ? `<tspan class="${runClass(bits)}">${escapeXml(r.text)}</tspan>` : escapeXml(r.text);
      }
      return `<tspan x="${num(x)}" dy="${num(dy)}">${text}</tspan>`;
    })
    .join('');

  return `<text ${attrs.join(' ')}>${tspans}</text>`;
}
