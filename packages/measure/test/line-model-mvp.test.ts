import { describe, expect, it } from 'vitest';
import type { LabelId } from '@sgl/core';
import { labelRuns, layoutLines, UNCONSTRAINED, type MeasureRun, type StyledRun, type TextLayout, type TextStyle } from '@sgl/text';
import { corpusStyledGraph, listCorpusDocs } from '../../theme/test/corpus.js';
import { staticRunMetrics } from '../src/static-measurer.js';

/**
 * `layoutLines` (DD-11 §7): hard breaks only. The first block is T58's proof that
 * the new representation changes nothing downstream: for every corpus label, the
 * new model over the canonical runs (one run, `\n` inside) gives exactly the MVP
 * model's layout over one run per line, to the bit.
 */

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

