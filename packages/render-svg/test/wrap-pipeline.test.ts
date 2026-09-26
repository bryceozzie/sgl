import { describe, expect, it } from 'vitest';
import { asNodeId, labelMaxWidth, type LabelId } from '@sgl/core';
import type { LayoutEngine } from '@sgl/layout-api';
import { elkEngine } from '@sgl/layout-elk';
import { gridEngine } from '@sgl/layout-std';
import { labelBox, labelRunKey } from '@sgl/text';
import { runPipeline } from './pipeline.js';

/**
 * Wrapped labels through the whole pipeline, under both engines (DD-11 T35, T39–T41):
 * `compile → styleGraph → premeasure (layoutWrapped) → buildLayoutInput → engine →
 * host fallbacks → quantize → render`. The measure table's entry, the `LayoutInput`'s
 * label size, the engine's node frame and the label placement must all agree: the
 * key function is shared (T2), and a seam that is only unit-tested on each side has
 * hidden bugs in this project before.
 */

const ENGINES: readonly LayoutEngine[] = [gridEngine, elkEngine];
const LONG = 'Payments ledger reconciliation service';
const SHAPES = ['rect', 'round', 'ellipse', 'diamond', 'hexagon', 'cylinder', 'package'];
/** neutral-light's node padding. */
const PADDING = [8, 12, 8, 12];

function source(maxWidth: number): string {
  return `${SHAPES.map((s) => `${s}: { @shape: ${s}, @label: "${LONG}", @size: { maxWidth: ${maxWidth} } }`).join('\n')}\nplain: { @label: "${LONG}" }\nrect -> plain\n`;
}

describe('wrapped labels lay out at their wrapped size (DD-11 T35, T39, T40)', () => {
  for (const engine of ENGINES) {
    it(`${engine.id}: every shape's node stays within maxWidth, and table, input, frame and placement agree`, async () => {
      const maxWidth = 150;
      const { styled, input, result, table } = await runPipeline(source(maxWidth), undefined, engine);
      for (const shape of SHAPES) {
        const id = asNodeId(shape);
        const labelId = `l:${shape}` as LabelId;
        const box = labelBox(styled, labelId);
        expect(box.maxWidth).toBeCloseTo(labelMaxWidth(shape, maxWidth, PADDING), 12);
        const measured = table[labelRunKey(styled, labelId)]!;
        expect(measured, shape).toBeDefined();
        expect(measured.lines.length, shape).toBeGreaterThan(1);
        expect(measured.width, shape).toBeLessThanOrEqual(box.maxWidth!);
        // The engine was handed exactly the measured size…
        expect(input.labelSizes[labelId]).toEqual({ w: measured.width, h: measured.height });
        // …the node it laid out holds it within the author's width…
        expect(result.nodes[id]!.frame.w, `${engine.id} ${shape}`).toBeLessThanOrEqual(maxWidth + 1 / 64);
        expect(input.sizing[id]!.intrinsic.w, shape).toBeLessThanOrEqual(maxWidth + 1e-9);
        // …and the label is placed at that size (quantized to 1/64 px).
        const placement = result.labels.find((l) => l.labelId === labelId)!;
        expect(Math.abs(placement.frame.w - measured.width), shape).toBeLessThanOrEqual(1 / 64);
        // elk places a cylinder's title in a frame taller than the label (its own
        // inset arithmetic, K4, and the same for an unwrapped label); the height
        // it holds is never less than the measured one.
        if (engine === gridEngine) expect(Math.abs(placement.frame.h - measured.height), shape).toBeLessThanOrEqual(1 / 64);
        else expect(placement.frame.h, shape).toBeGreaterThanOrEqual(measured.height - 1 / 64);
      }
      // A node without @size is the MVP: one line, as wide as it needs.
      const plain = table[labelRunKey(styled, 'l:plain' as LabelId)]!;
      expect(plain.lines).toHaveLength(1);
      expect(result.nodes[asNodeId('plain')]!.frame.w).toBeGreaterThan(maxWidth);
    });
  }

  it('a fixed @size.width wraps too, and the narrower of width and maxWidth wins (T36)', async () => {
    const { styled, table } = await runPipeline(`a: { @label: "${LONG}", @size: { width: 124, maxWidth: 400 } }\n`);
    const measured = table[labelRunKey(styled, 'l:a' as LabelId)]!;
    expect(labelBox(styled, 'l:a' as LabelId)).toEqual({ maxWidth: 100 });
    expect(measured.lines.length).toBeGreaterThan(1);
    expect(measured.width).toBeLessThanOrEqual(100);
  });

  it('a fixed @size.width never splits a word: "Checkout" at width 60 and a small diamond\'s "Ok?" stay one line (H1)', async () => {
    const { styled, table } = await runPipeline('a: { @label: "Checkout", @size: { width: 60 } }\nd: { @shape: diamond, @label: "Ok?", @size: { width: 40, height: 40 } }\n');
    for (const id of ['l:a', 'l:d']) expect(table[labelRunKey(styled, id as LabelId)]!.lines, id).toHaveLength(1);
  });

  it('@size.maxWidth still splits an overlong word (T37, H1)', async () => {
    const { styled, table } = await runPipeline('a: { @label: "Supercalifragilisticexpialidocious", @size: { maxWidth: 100 } }\nb: { @label: "Supercalifragilisticexpialidocious", @size: { maxWidth: 100, width: 300 } }\n');
    for (const id of ['l:a', 'l:b']) expect(table[labelRunKey(styled, id as LabelId)]!.lines.length, id).toBeGreaterThan(1);
  });

  it('a container\'s title band grows with its line count, pushing its children down (T40)', async () => {
    for (const engine of ENGINES) {
      const one = await runPipeline('box: { @label: "Title", a }\n', undefined, engine);
      const two = await runPipeline('box: { @label: "Title\\nsecond line", a }\n', undefined, engine);
      const childY = (r: typeof one): number => r.result.nodes[asNodeId('box.a')]!.frame.y - r.result.nodes[asNodeId('box')]!.frame.y;
      expect(childY(two), engine.id).toBeGreaterThan(childY(one));
    }
  });

  it('the renderer draws, until the render branch, only the hard lines of a wrapped label (DD-11 T42 is branch 3)', async () => {
    const { rendered } = await runPipeline(`a: { @label: "${LONG}", @size: { maxWidth: 150 } }\n`);
    // One <tspan> per hard line: the wrapped breaks are measured and laid out, not yet drawn.
    const text = /<g id="n-a"[^]*?<text [^>]*>([^]*?)<\/text>/.exec(rendered.svg)![1]!;
    expect(text.match(/<tspan /g)).toHaveLength(1);
    expect(text).toContain(LONG);
  });
});
