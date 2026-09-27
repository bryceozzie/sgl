import { describe, expect, it } from 'vitest';
import { layoutLines } from '../src/line-model.js';
import { UNCONSTRAINED } from '../src/run-key.js';
import type { MeasureRun, TextStyle } from '../src/types.js';

/**
 * `layoutLines` (DD-11 §7): hard breaks only. Its equivalence to the MVP model over
 * every corpus label is `packages/measure/test/line-model-mvp.test.ts`, beside the
 * static metrics it measures with.
 */

const BASE: TextStyle = { fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, fontStyle: 'normal', lineHeight: 1.3, letterSpacing: 0 };

describe('layoutLines: fragments (DD-11 T31, T32, T34)', () => {
  const stub: MeasureRun = (text, style) => ({ width: [...text].length * (style.fontWeight >= 700 ? 12 : 10), ascent: style.fontStyle === 'italic' ? 9 : 8 });
  const bold: TextStyle = { ...BASE, fontWeight: 700 };
  const italic: TextStyle = { ...BASE, fontStyle: 'italic' };

  it('lays the runs of one line side by side, measured each in its own face, with their marks', () => {
    const layout = layoutLines(stub, [{ text: 'ab ', style: BASE }, { text: 'cd', style: bold, marks: { strong: true } }, { text: 'e', style: BASE }], UNCONSTRAINED);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.runs).toEqual([
      { x: 0, text: 'ab ', style: BASE },
      { x: 30, text: 'cd', style: bold, marks: { strong: true } },
      { x: 54, text: 'e', style: BASE },
    ]);
    expect(layout.width).toBe(64);
  });

  it('adds letter spacing between every two glyphs of the line, across fragments, and into each x', () => {
    const s = { ...BASE, letterSpacing: 2 };
    const layout = layoutLines(stub, [{ text: 'ab', style: s }, { text: 'c', style: { ...s, fontWeight: 700 }, marks: { strong: true } }], UNCONSTRAINED);
    // 20 + 12 advance, and 2 gaps of 2 for 3 glyphs.
    expect(layout.lines[0]!.width).toBe(36);
    expect(layout.lines[0]!.runs[1]!.x).toBe(24);
  });

  it('splits at every \\n, inside a run or between runs, and keeps each line\'s fragments', () => {
    const layout = layoutLines(stub, [{ text: 'a\nb', style: BASE }, { text: 'c\n', style: italic, marks: { em: true } }, { text: 'd', style: BASE }], UNCONSTRAINED);
    expect(layout.lines.map((l) => l.runs.map((r) => r.text))).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(layout.lines[1]!.runs[1]!.marks).toEqual({ em: true });
  });

  it('keeps empty lines and a trailing \\n as empty lines, measured in the style of the run that broke them (T34)', () => {
    const layout = layoutLines(stub, [{ text: 'a', style: BASE }, { text: '\n\n', style: italic, marks: { em: true } }], UNCONSTRAINED);
    expect(layout.lines.map((l) => l.runs)).toEqual([[{ x: 0, text: 'a', style: BASE }], [{ x: 0, text: '', style: italic }], [{ x: 0, text: '', style: italic }]]);
    expect(layout.height).toBeCloseTo(3 * 13 * 1.3, 9);
  });

  it('puts every baseline at the largest ascent of the label below its line box (T31)', () => {
    const layout = layoutLines(stub, [{ text: 'a\n', style: BASE }, { text: 'b', style: italic, marks: { em: true } }], UNCONSTRAINED);
    expect(layout.ascent).toBe(9);
    expect(layout.lines.map((l) => l.y)).toEqual([9, 9 + 13 * 1.3]);
  });

  it('takes the largest ascent even when it comes first, on one line or across lines (fix round 1, item 4: mutant M7)', () => {
    // One line: the italic fragment (ascent 9) before a plain one (8).
    const one = layoutLines(stub, [{ text: 'a', style: italic, marks: { em: true } }, { text: 'b', style: BASE }], UNCONSTRAINED);
    expect(one.ascent).toBe(9);
    expect(one.lines.map((l) => l.y)).toEqual([9]);
    // Two lines: the larger ascent on the first.
    const two = layoutLines(stub, [{ text: 'a\n', style: italic, marks: { em: true } }, { text: 'b', style: BASE }], UNCONSTRAINED);
    expect(two.ascent).toBe(9);
    expect(two.lines.map((l) => l.y)).toEqual([9, 9 + 13 * 1.3]);
  });

  it('throws when handed a maxWidth: the caller must have loaded layoutWrapped (DD-11 §7)', () => {
    expect(() => layoutLines(stub, [{ text: 'a', style: BASE }], { maxWidth: 100 })).toThrow(/layoutWrapped/);
  });

  it('gives no runs no lines', () => {
    expect(layoutLines(stub, [], UNCONSTRAINED)).toEqual({ width: 0, height: 0, lines: [], ascent: 0 });
  });
});
