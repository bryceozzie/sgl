/**
 * `StaticMetricsMeasurer` — a deterministic, environment-free `Measurer`.
 *
 * Why this exists
 * ---------------
 * `CanvasMeasurer` needs a 2D canvas, so it cannot run under Node. Layout (DD-06)
 * and the renderer (DD-07) both take a `MeasureTable` as their input, so with only
 * a canvas measurer there is no way to produce that input in a Node test — which
 * costs unit tests, golden files and CI coverage for *everything downstream of
 * measurement*, not just for this package.
 *
 * This measurer sums per-character advance widths from a small table, normalised to
 * em and scaled by `fontSize`. It runs anywhere, needs no fonts loaded, and is
 * byte-reproducible. It is also the shape `FontMetricsMeasurer` takes when it lands
 * with the Worker render API (ADR-0003, and its 2026-09-14 amendment on sequencing),
 * so the pipeline is exercised in the shape it will eventually ship in.
 *
 * What it is not
 * --------------
 * It is **not metrically accurate**. It is fixture-grade. Advances come from the
 * Adobe Core-14 AFM tables for Helvetica, Times-Roman and Courier — real, published,
 * stable numbers, which is what makes them a defensible fixture — but the font
 * actually on screen is not one of those three, there is no kerning, no ligatures
 * and no shaping, and bold is a single scalar rather than a real bold table. Widths
 * are in the right ballpark and wrong in the small. Its job is to make the pipeline
 * testable and reproducible, not to decide what a user sees; `CanvasMeasurer`
 * remains the browser default (DD-05 §4).
 */

import { layoutLines, type MeasureRun, type RunMetrics } from './line-model.js';
import type { BoxConstraints, Measurer, StyledRun, TextLayout, TextStyle } from './types.js';

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** The 95 printable ASCII characters, in code-point order. The width arrays below
 *  are indexed by position in this string, exactly as an AFM `C` sequence is. */
const PRINTABLE_ASCII =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

/** Helvetica, from the Adobe Core-14 AFM. Units are 1/1000 em. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

/** Times-Roman, same source, same units. */
const TIMES = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
  278, 278, 564, 564, 564, 444, 921,
  722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556,
  722, 667, 556, 611, 722, 722, 944, 722, 722, 611,
  333, 278, 333, 469, 500, 333,
  444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500,
  500, 333, 389, 278, 500, 500, 722, 500, 500, 444,
  480, 200, 480, 541,
];

/** Courier is fixed-pitch: every glyph is 600/1000 em. */
const COURIER = PRINTABLE_ASCII.split('').map(() => 600);

export type FontClass = 'sans' | 'serif' | 'mono';

export interface StaticFontMetrics {
  readonly id: FontClass;
  /** Em above the baseline. AFM `Ascender`. */
  readonly ascent: number;
  /** Em below the baseline, positive. AFM `Descender`, negated. */
  readonly descent: number;
  /** Em, used for any character not in `advances`. */
  readonly defaultAdvance: number;
  /** Character → advance in em. */
  readonly advances: Readonly<Record<string, number>>;
}

function emTable(thousandths: readonly number[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < PRINTABLE_ASCII.length; i += 1) {
    const ch = PRINTABLE_ASCII[i];
    const w = thousandths[i];
    if (ch === undefined || w === undefined) break;
    out[ch] = w / 1000;
  }
  return out;
}

/** ADR-0003: an unknown family falls back to the nearest table in the same class.
 *  These three are those classes. */
export const STATIC_METRICS: Readonly<Record<FontClass, StaticFontMetrics>> = {
  // `defaultAdvance` is the table's own `n`, a middling proportional glyph.
  sans: { id: 'sans', ascent: 0.718, descent: 0.207, defaultAdvance: 0.556, advances: emTable(HELVETICA) },
  serif: { id: 'serif', ascent: 0.683, descent: 0.217, defaultAdvance: 0.5, advances: emTable(TIMES) },
  mono: { id: 'mono', ascent: 0.629, descent: 0.157, defaultAdvance: 0.6, advances: emTable(COURIER) },
};

/**
 * Bold is wider, and one scalar is all a fixture needs.
 *
 * Helvetica-Bold's per-glyph advance ratios against Helvetica run from 1.00 (`a`,
 * `e`) to about 1.25 (`i`, `l`), averaging roughly 1.11 over lowercase and 1.05
 * over uppercase. 1.08 sits between them. A real bold table replaces this when
 * `FontMetricsMeasurer` lands.
 */
const BOLD_SCALE = 1.08;
const BOLD_THRESHOLD = 600;

/** Helvetica-Oblique and Courier-Oblique share their roman advances exactly, so
 *  italic costs nothing here. Times-Italic does differ; it is not modelled. */
const ITALIC_SCALE = 1;

// ---------------------------------------------------------------------------
// Family classification
// ---------------------------------------------------------------------------

/**
 * Map a CSS font-family list onto one of the three classes.
 *
 * Order matters: `sans` is tested before `serif` because `"sans-serif"` contains
 * the substring `serif`.
 */
export function fontClassOf(fontFamily: string): FontClass {
  const f = fontFamily.toLowerCase();
  if (/mono|courier|consolas|menlo|fira\s*code|jetbrains/.test(f)) return 'mono';
  if (/sans|helvetica|arial|inter|system-ui|segoe|roboto|ui-sans/.test(f)) return 'sans';
  if (/serif|times|georgia|garamond|cambria/.test(f)) return 'serif';
  return 'sans';
}

export function metricsFor(fontFamily: string): StaticFontMetrics {
  return STATIC_METRICS[fontClassOf(fontFamily)];
}

// ---------------------------------------------------------------------------
// Advances
// ---------------------------------------------------------------------------

/** Ideographs, kana, Hangul syllables, fullwidth forms and emoji occupy a full em.
 *  Coarse, but charging them a Latin `n` makes CJK labels come out half-size, which
 *  the corpus would show immediately. */
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Combining marks and format characters add no advance. */
function isZeroWidth(cp: number): boolean {
  return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff;
}

/** Advance width in px, excluding letter spacing (`layoutLines` adds that). */
export function staticAdvance(text: string, style: TextStyle): number {
  const metrics = metricsFor(style.fontFamily);
  const scale =
    (style.fontWeight >= BOLD_THRESHOLD ? BOLD_SCALE : 1) *
    (style.fontStyle === 'italic' ? ITALIC_SCALE : 1);

  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isZeroWidth(cp)) continue;
    const known = metrics.advances[ch];
    em += known ?? (isFullWidth(cp) ? 1 : metrics.defaultAdvance);
  }

  return em * style.fontSize * scale;
}

/** The `MeasureRun` this measurer hands to the shared line model. Exported because
 *  `CanvasMeasurer` uses it as its no-canvas degrade path. */
export const staticRunMetrics: MeasureRun = (text: string, style: TextStyle): RunMetrics => ({
  width: staticAdvance(text, style),
  ascent: metricsFor(style.fontFamily).ascent * style.fontSize,
});

// ---------------------------------------------------------------------------
// The measurer
// ---------------------------------------------------------------------------

export class StaticMetricsMeasurer implements Measurer {
  layoutRuns(runs: readonly StyledRun[], box: BoxConstraints): TextLayout {
    return layoutLines(staticRunMetrics, runs, box);
  }

  layoutRunsAsync(runs: readonly StyledRun[], box: BoxConstraints): Promise<TextLayout> {
    return Promise.resolve(this.layoutRuns(runs, box));
  }

  /** It can measure anything, so it never misses. */
  has(runs: readonly StyledRun[], box: BoxConstraints): boolean {
    void runs;
    void box;
    return true;
  }
}
