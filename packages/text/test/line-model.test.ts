import { describe, expect, it } from 'vitest';
import type { LabelId } from '@sgl/core';
import { corpusStyledGraph, listCorpusDocs } from '../../theme/test/corpus.js';
import { staticRunMetrics } from '../../measure/src/static-measurer.js';
import { layoutLines } from '../src/line-model.js';
import { labelRuns } from '../src/label.js';
import { UNCONSTRAINED } from '../src/run-key.js';
import type { MeasureRun, StyledRun, TextLayout, TextStyle } from '../src/types.js';

/**
 * `layoutLines` (DD-11 §7): hard breaks only. The first block is T58's proof that
 * the new representation changes nothing downstream: for every corpus label, the
 * new model over the canonical runs (one run, `\n` inside) gives exactly the MVP
 * model's layout over one run per line, to the bit.
 */

const BASE: TextStyle = { fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, fontStyle: 'normal', lineHeight: 1.3, letterSpacing: 0 };

/** The MVP line model (`packages/measure/src/line-model.ts` at `33af6e7`), verbatim
 *  but for its types: each run one line. The oracle for the equivalence below. */
function mvpLayoutLines(measureRun: MeasureRun, runs: readonly StyledRun[]): TextLayout {
  const lines: { y: number; width: number; runs: readonly { readonly x: number; readonly text: string; readonly style: TextStyle }[] }[] = [];
  let width = 0;
  let advanceY = 0;
  let ascent = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run === undefined) continue;
    const metrics = measureRun(run.text, run.style);
    const gaps = Math.max(0, [...run.text].length - 1);
    const lineWidth = metrics.width + run.style.letterSpacing * gaps;
    lines.push({ y: advanceY + metrics.ascent, width: lineWidth, runs: [{ x: 0, text: run.text, style: run.style }] });
    if (i === 0) ascent = metrics.ascent;
    if (lineWidth > width) width = lineWidth;
    advanceY += run.style.fontSize * run.style.lineHeight;
  }
  return { width, height: advanceY, lines, ascent };
}

/** A canvas-like measurer: widths with awkward fractions, and a font-level ascent
 *  (as `fontBoundingBoxAscent` is), different per face. */
const canvasLike: MeasureRun = (text, style) => ({
  width: [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) % 7) * 0.1234567 + 3.3, 0) * (style.fontSize / 13),
  ascent: style.fontSize * (style.fontFamily.includes('Mono') ? 0.91 : 0.96875),
});

describe('layoutLines equals the MVP line model on every corpus label (DD-11 T58, T31, T32)', () => {
  const docs = listCorpusDocs();
  it('covers the corpus', () => expect(docs.length).toBeGreaterThan(60));

  for (const measure of [staticRunMetrics, canvasLike]) {
    it(`${measure === staticRunMetrics ? 'static' : 'canvas-like'} metrics, letter spacing 0 and 1.25`, () => {
      let labels = 0;
      for (const doc of docs) {
        const { styled } = corpusStyledGraph(doc);
        for (const labelId of Object.keys(styled.graph.labels).sort() as LabelId[]) {
          for (const ls of [0, 1.25]) {
            const runs = labelRuns(styled, labelId).map((r) => ({ ...r, style: { ...r.style, letterSpacing: ls } }));
            if (runs.some((r) => r.marks !== undefined)) continue; // no corpus label has marks without the parser
            const perLine = runs.map((r) => r.text).join('').split('\n').map((text) => ({ text, style: runs[0]!.style }));
            expect(layoutLines(measure, runs, UNCONSTRAINED), `${doc} ${labelId}`).toStrictEqual(mvpLayoutLines(measure, runs.length === 0 ? [] : perLine));
          }
          labels += 1;
        }
      }
      expect(labels).toBeGreaterThan(300);
    });
  }
});

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

  it('throws when handed a maxWidth: the caller must have loaded layoutWrapped (DD-11 §7)', () => {
    expect(() => layoutLines(stub, [{ text: 'a', style: BASE }], { maxWidth: 100 })).toThrow(/layoutWrapped/);
  });

  it('gives no runs no lines', () => {
    expect(layoutLines(stub, [], UNCONSTRAINED)).toEqual({ width: 0, height: 0, lines: [], ascent: 0 });
  });
});
