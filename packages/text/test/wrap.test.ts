import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutLines } from '../src/line-model.js';
import { UNCONSTRAINED } from '../src/run-key.js';
import type { MeasureRun, StyledRun, TextLayout, TextStyle } from '../src/types.js';
import { breakUnits, layoutWrapped } from '../src/wrap.js';

/**
 * `layoutWrapped` (DD-11 §7, T32–T38): the greedy breaker, from `@sgl/text/wrap`.
 *
 * Most cases use a stub measurer with fixed advances (10 per code point, 12 in
 * bold, 0 for combining marks and format characters), so every break is
 * checkable by hand.
 */

const BASE: TextStyle = { fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 500, fontStyle: 'normal', lineHeight: 1.5, letterSpacing: 0 };
const BOLD: TextStyle = { ...BASE, fontWeight: 700 };

const ZERO: readonly (readonly [number, number])[] = [[0x300, 0x36f], [0x1ab0, 0x1aff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f], [0xfe00, 0xfe0f], [0x200b, 0x200d], [0xe0100, 0xe01ef], [0x1f3fb, 0x1f3ff]];
const zeroWidth = (ch: string): boolean => ZERO.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b);
const stub: MeasureRun = (text, style) => ({
  width: [...text].reduce((w, ch) => w + (zeroWidth(ch) ? 0 : style.fontWeight >= 700 ? 12 : 10), 0),
  ascent: 8,
});

/** Fractional, face-dependent advances, as real metrics have. */
const fractional: MeasureRun = (text, style) => ({
  width: [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) % 11) * 0.37 + 4.1, 0) * (style.fontWeight >= 700 ? 1.08 : 1),
  ascent: style.fontSize * 0.72,
});
const plain = (text: string, style: TextStyle = BASE): StyledRun => ({ text, style });
const lines = (layout: TextLayout): string[] => layout.lines.map((l) => l.runs.map((r) => r.text).join(''));
const wrap = (runs: readonly StyledRun[], maxWidth: number, m: MeasureRun = stub): TextLayout => layoutWrapped(m, runs, { maxWidth });

describe('layoutWrapped without a maxWidth is layoutLines (DD-11 §7)', () => {
  it('exactly, for any runs', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ text: fc.string({ unit: fc.constantFrom('a', ' ', '\n', '\u00e9', '\u6771', '\t', '\u{1f642}') }), bold: fc.boolean() }), { maxLength: 6 }), (spec) => {
        const runs = spec.map((r) => (r.bold ? { text: r.text, style: BOLD, marks: { strong: true as const } } : plain(r.text)));
        expect(layoutWrapped(stub, runs, UNCONSTRAINED)).toStrictEqual(layoutLines(stub, runs, UNCONSTRAINED));
      }),
    );
  });
});

describe('the greedy breaker (T33)', () => {
  it('adds a word while the line still fits, then starts the next line with it', () => {
    expect(lines(wrap([plain('aa bb cc dd')], 50))).toEqual(['aa bb', 'cc dd']);
    expect(lines(wrap([plain('aa bb cc dd')], 49))).toEqual(['aa', 'bb', 'cc', 'dd']);
    // `width ≤ maxWidth` fits: the boundary is inclusive.
    expect(lines(wrap([plain('aa bb cc')], 80))).toEqual(['aa bb cc']);
  });

  it('a label that fits is exactly its unwrapped layout, only keyed differently', () => {
    const runs = [plain('ab '), { text: 'cd', style: BOLD, marks: { strong: true as const } }];
    expect(wrap(runs, 1000)).toStrictEqual(layoutLines(stub, runs, UNCONSTRAINED));
  });

  it('drops the whitespace at a soft break, from the end of one line and the start of the next', () => {
    const layout = wrap([plain('aa   \t bb')], 30);
    expect(lines(layout)).toEqual(['aa', 'bb']);
    expect(layout.lines.map((l) => l.width)).toEqual([20, 20]);
  });

  it('keeps and measures whitespace at the start and end of a hard line', () => {
    expect(lines(wrap([plain('  aa bb  ')], 50))).toEqual(['  aa', 'bb  ']);
    expect(wrap([plain('  aa bb  ')], 50).lines.map((l) => l.width)).toEqual([40, 40]);
  });

  it('U+200B is a break opportunity and U+00A0 is not', () => {
    expect(lines(wrap([plain('aa\u200bbb')], 30))).toEqual(['aa', 'bb']);
    expect(lines(wrap([plain('aa\u00a0bb cc')], 50))).toEqual(['aa\u00a0bb', 'cc']);
  });

  it('keeps run boundaries: a word may span runs, and every fragment keeps its style, marks and x', () => {
    const runs: StyledRun[] = [plain('xx '), { text: 'yy', style: BOLD, marks: { strong: true } }, plain('z w')];
    const layout = wrap(runs, 60);
    // `yyz` is one word across two runs: it moves as a unit.
    expect(lines(layout)).toEqual(['xx', 'yyz w']);
    expect(layout.lines[1]!.runs).toEqual([
      { x: 0, text: 'yy', style: BOLD, marks: { strong: true } },
      { x: 24, text: 'z w', style: BASE },
    ]);
    expect(layout.lines[1]!.width).toBe(54);
  });

  it('measures each line as the sum of its fragments plus letter spacing (T32)', () => {
    const spaced = { ...BASE, letterSpacing: 2 };
    const layout = wrap([plain('ab cd ef', spaced)], 58);
    // "ab cd" = 50 advance + 4 gaps of 2 = 58: fits exactly; "ab cd ef" would not.
    expect(lines(layout)).toEqual(['ab cd', 'ef']);
    expect(layout.lines.map((l) => l.width)).toEqual([58, 22]);
  });

  it('stacks lines at one line height with the label\'s ascent (T31)', () => {
    const layout = wrap([plain('aa bb cc')], 20);
    expect(layout.lines.map((l) => l.y)).toEqual([8, 23, 38]);
    expect(layout.height).toBe(45);
    expect(layout.width).toBe(20);
  });
});

describe('explicit breaks always break (T34)', () => {
  it('\\n starts a new line whatever the width, and each hard line wraps on its own', () => {
    expect(lines(wrap([plain('a\nbb cc dd')], 50))).toEqual(['a', 'bb cc', 'dd']);
  });
  it('empty lines and a trailing \\n are kept', () => {
    expect(lines(wrap([plain('aa bb\n\ncc\n')], 30))).toEqual(['aa', 'bb', '', 'cc', '']);
  });
});

describe('words that are too long, and text without spaces (T37)', () => {
  it('splits an overlong word at the last boundary that fits, repeatedly, without a hyphen', () => {
    expect(lines(wrap([plain('abcdefgh')], 30))).toEqual(['abc', 'def', 'gh']);
    // The word moves to a line of its own first.
    expect(lines(wrap([plain('xy abcdefgh')], 30))).toEqual(['xy', 'abc', 'def', 'gh']);
  });

  it('gives every line at least one unit, even one wider than the wrap width', () => {
    expect(lines(wrap([plain('abc')], 5))).toEqual(['a', 'b', 'c']);
    expect(lines(wrap([plain('ab cd')], 0))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('CJK without spaces fills each line and breaks between any two ideographs; no kinsoku', () => {
    expect(lines(wrap([plain('\u6771\u4eac\u90fd\u6e2f\u533a\u516d\u672c\u6728\u3002')], 30))).toEqual(['\u6771\u4eac\u90fd', '\u6e2f\u533a\u516d', '\u672c\u6728\u3002']);
    expect(lines(wrap([plain('\u6771\u4eac\u90fd\u6e2f\u533a\u516d\u672c\u6728\u3002')], 40))).toEqual(['\u6771\u4eac\u90fd\u6e2f', '\u533a\u516d\u672c\u6728', '\u3002']);
  });

  it('never splits inside a surrogate pair', () => {
    expect(lines(wrap([plain('\u{1f642}\u{1f642}\u{1f642}')], 15))).toEqual(['\u{1f642}', '\u{1f642}', '\u{1f642}']);
  });

  it('never splits before a combining mark, a variation selector or an emoji modifier', () => {
    expect(lines(wrap([plain('e\u0301e\u0301e\u0301')], 15))).toEqual(['e\u0301', 'e\u0301', 'e\u0301']);
    expect(lines(wrap([plain('\u2764\ufe0f\u2764\ufe0f')], 15))).toEqual(['\u2764\ufe0f', '\u2764\ufe0f']);
    expect(lines(wrap([plain('\u{1f44d}\u{1f3fd}\u{1f44d}\u{1f3fd}')], 15))).toEqual(['\u{1f44d}\u{1f3fd}', '\u{1f44d}\u{1f3fd}']);
    expect(lines(wrap([plain('a\u20dda\u{e0100}b')], 15))).toEqual(['a\u20dd', 'a\u{e0100}', 'b']);
  });

  it('never splits on either side of a ZWJ', () => {
    const dev = '\u{1f469}\u200d\u{1f4bb}';
    expect(lines(wrap([plain(`${dev}${dev}`)], 25))).toEqual([dev, dev]);
  });

  it('never splits between the two halves of a regional-indicator pair', () => {
    const jp = '\u{1f1ef}\u{1f1f5}';
    const fr = '\u{1f1eb}\u{1f1f7}';
    expect(lines(wrap([plain(`${jp}${fr}${jp}`)], 25))).toEqual([jp, fr, jp]);
  });

  it('breakUnits groups code points into the units a split may not enter', () => {
    expect(breakUnits('ab')).toEqual(['a', 'b']);
    expect(breakUnits('e\u0301x')).toEqual(['e\u0301', 'x']);
    expect(breakUnits('\u{1f1ef}\u{1f1f5}\u{1f1eb}')).toEqual(['\u{1f1ef}\u{1f1f5}', '\u{1f1eb}']);
    expect(breakUnits('a\u200db')).toEqual(['a\u200db']);
  });

  it('splits a word that spans runs, keeping each piece\'s style', () => {
    const layout = wrap([plain('ab'), { text: 'cd', style: BOLD, marks: { strong: true } }], 30);
    expect(layout.lines.map((l) => l.runs.map((r) => [r.text, r.marks?.strong ?? false]))).toEqual([
      [['ab', false]],
      [['cd', true]],
    ]);
  });
});

describe('keepWords: a fixed @size.width breaks only at spaces (human decision H1)', () => {
  const keep = (runs: readonly StyledRun[], maxWidth: number): TextLayout => layoutWrapped(stub, runs, { maxWidth, keepWords: true });
  it('an overlong word overflows on a line of its own, never split', () => {
    expect(lines(keep([plain('abcdefgh')], 30))).toEqual(['abcdefgh']);
    expect(lines(keep([plain('aa abcdefgh bb')], 30))).toEqual(['aa', 'abcdefgh', 'bb']);
    expect(lines(keep([plain('\u6771\u4eac\u90fd\u6e2f')], 15))).toEqual(['\u6771\u4eac\u90fd\u6e2f']);
  });
  it('still breaks at spaces', () => {
    expect(lines(keep([plain('aa bb cc dd')], 50))).toEqual(['aa bb', 'cc dd']);
  });
});

describe('the hexagon rule (fix round 1, item 3)', () => {
  // A hexagon's side insets are min(L, H)/2 each (DD-07 §4 solved for the label),
  // so a label L wide and H tall fits a width A when L + min(L, H) <= A. The box
  // carries A and `hexagon`; the breaker starts at max(A/2, A - one line) and
  // narrows until the rule holds, so a one-line label is never over-wrapped.
  const hex = (runs: readonly StyledRun[], maxWidth: number): TextLayout => layoutWrapped(stub, runs, { maxWidth, hexagon: true });
  it('one line fits up to A minus one line height, not A/2', () => {
    // A = 176, one line is 15 high: "Order fulfilment" (160) fits on one line.
    expect(lines(hex([plain('Order fulfilment')], 176))).toEqual(['Order fulfilment']);
    expect(lines(hex([plain('Order fulfilmentX')], 176)).length).toBeGreaterThan(1);
  });
  it('holds for random text and widths, unless a line is one unit', () => {
    const unitArb = fc.constantFrom('a', 'bb', 'ccc', ' ', ' ', '\n');
    fc.assert(
      fc.property(fc.array(unitArb, { maxLength: 40 }).map((a) => a.join('')), fc.integer({ min: 20, max: 400 }), (text, A) => {
        const layout = hex([plain(text)], A);
        const oneUnit = layout.lines.some((l) => breakUnits(l.runs.map((r) => r.text).join('')).length <= 1 && l.width > A / 2);
        if (!oneUnit) expect(layout.width + Math.min(layout.width, layout.height), JSON.stringify(text)).toBeLessThanOrEqual(A + 1e-9);
      }),
    );
  });
});

describe('properties, for random text and widths', () => {
  const unit = fc.constantFrom('a', 'b', 'W', ' ', ' ', '\t', '\u200b', '\u00a0', '\n', '\u6771', '\u{1f642}', 'e\u0301', '\u{1f469}\u200d\u{1f4bb}', '\u{1f1ef}\u{1f1f5}', '-');
  const runsArb = fc.array(fc.record({ text: fc.array(unit, { maxLength: 12 }).map((a) => a.join('')), bold: fc.boolean() }), { minLength: 1, maxLength: 4 }).map((spec) =>
    spec.filter((r) => r.text !== '').map((r) => (r.bold ? { text: r.text, style: BOLD, marks: { strong: true as const } } : plain(r.text))),
  );

  it('every line fits unless it is one unit (T33, T37)', () => {
    fc.assert(
      fc.property(runsArb, fc.integer({ min: 0, max: 120 }), (runs, maxWidth) => {
        for (const line of wrap(runs, maxWidth).lines) {
          const text = line.runs.map((r) => r.text).join('');
          if (breakUnits(text).length > 1) expect(line.width, JSON.stringify(text)).toBeLessThanOrEqual(maxWidth);
        }
      }),
    );
  });

  it('the lines plus the dropped break whitespace rebuild the text, hard line by hard line', () => {
    const escape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fc.assert(
      fc.property(runsArb, fc.integer({ min: 0, max: 120 }), (styled, maxWidth) => {
        // One style, so each hard line's own wrap is the same as its part of the whole.
        const text = styled.map((r) => r.text).join('');
        const all = lines(wrap([plain(text)], maxWidth));
        let i = 0;
        for (const hard of text.split('\n')) {
          // The lines of this hard line are the ones wrapping it alone gives.
          const own = lines(wrap([plain(hard)], maxWidth)).length;
          const mine = all.slice(i, i + own);
          i += own;
          expect(new RegExp(`^${mine.map(escape).join('[ \\t\\u200b]*')}$`, 'u').test(hard), `${JSON.stringify(hard)} -> ${JSON.stringify(mine)}`).toBe(true);
          // What was dropped is only break whitespace, and only at a break.
          expect(mine.join('').length).toBeLessThanOrEqual(hard.length);
        }
        expect(i).toBe(all.length);
      }),
    );
  });

  it('fragments keep each run\'s style and marks, and no fragment is empty on a non-empty line', () => {
    fc.assert(
      fc.property(runsArb, fc.integer({ min: 0, max: 120 }), (runs, maxWidth) => {
        for (const line of wrap(runs, maxWidth).lines) {
          if (line.runs.length > 1) for (const r of line.runs) expect(r.text).not.toBe('');
          for (const r of line.runs) if (r.text !== '') expect(r.style).toBe(r.marks?.strong ? BOLD : BASE);
        }
      }),
    );
  });

  it('is deterministic: two runs over the same input give byte-identical JSON (DD-00 §3)', () => {
    fc.assert(
      fc.property(runsArb, fc.integer({ min: 0, max: 120 }), (runs, maxWidth) => {
        expect(JSON.stringify(layoutWrapped(fractional, runs, { maxWidth }))).toBe(JSON.stringify(layoutWrapped(fractional, runs, { maxWidth })));
      }),
    );
  });
});

describe('the breaker is linear (fix round 1, item 1)', () => {
  // Each fit test used to re-measure the whole line so far and memoise every
  // prefix: 8 000 words took ~10 s at a width that never breaks. A running total
  // per line makes it linear; the drawn line is still measured whole (T32).
  const words = Array.from({ length: 8000 }, (_, i) => `w${i % 97}`).join(' ');
  const glyphs = 'x'.repeat(8000);
  const rich: StyledRun[] = Array.from({ length: 800 }, (_, i) =>
    i % 2 === 0 ? plain(`${'word '.repeat(9)}word `) : { text: `${'bold '.repeat(9)}bold `, style: BOLD, marks: { strong: true } },
  );
  const timed = (runs: readonly StyledRun[], maxWidth: number): number => {
    const t = performance.now();
    layoutWrapped(fractional, runs, { maxWidth });
    return performance.now() - t;
  };
  for (const maxWidth of [1e9, 39990, 120]) {
    it(`8 000 words, 8 000 characters without spaces and 8 000 words in 800 rich runs, each well under 100 ms (maxWidth ${maxWidth})`, () => {
      expect(timed([plain(words)], maxWidth), 'words').toBeLessThan(100);
      expect(timed([plain(glyphs)], maxWidth), 'no spaces').toBeLessThan(100);
      expect(timed(rich, maxWidth), 'rich').toBeLessThan(100);
    });
  }
});
