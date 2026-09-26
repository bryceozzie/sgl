import { describe, expect, it, vi } from 'vitest';
import type { LabelId } from '@sgl/core';
import { CanvasMeasurer, labelRunKey } from '@sgl/measure';
import { labelBox } from '@sgl/text';
import '../src/fonts.css';
import { createHarness } from './harness.js';

/**
 * DD-11 T60 (branch 3): `CanvasMeasurer` with A18's faces, in a real browser,
 * through the app's pipeline. `ready()` loads the run faces a document uses
 * (T28), and what the browser then draws matches what was measured: every
 * wrapped line's `getComputedTextLength()` is within 0.5 px of its measured
 * width and at most the wrap width.
 */

const DOC = [
  'a: { @label: "Payments **ledger** reconciliation *service* with `svc_v2` retries", @size: { maxWidth: 160 } }',
  'b: { @label: "*Asynchronous* settlement **and clearing** of `batch_42` files", @size: { maxWidth: 130 } }',
  'a -> b: "*async*"',
].join('\n');

describe('CanvasMeasurer with the run faces (DD-11 T28, T60)', () => {
  it('ready() loads them, and each drawn line is its measured width, within the wrap width', async () => {
    const measurer = new CanvasMeasurer();
    const h = await createHarness(DOC, { measurer, loadRichText: async () => (await import('../src/state/rich-text.js')).richText }, { firstRender: false });
    // Fonts arrive over the network: settle until the picture lands.
    await vi.waitFor(async () => {
      await h.settle();
      expect(h.pipeline.lastGood.value).not.toBeNull();
    }, { timeout: 10_000, interval: 50 });
    const good = h.pipeline.lastGood.value!;
    for (const face of ['700 13px Inter', 'italic 500 13px Inter', 'italic 400 11px Inter', '400 13px "IBM Plex Mono"']) expect(document.fonts.check(face), face).toBe(true);

    const host = document.createElement('div');
    host.innerHTML = good.svg;
    document.body.append(host);
    try {
      let lines = 0;
      for (const id of ['a', 'b']) {
        const labelId = `l:${id}` as LabelId;
        const measured = h.pipeline.table.value[labelRunKey(good.styled, labelId)]!;
        const wrap = labelBox(good.styled, labelId).maxWidth!;
        const drawn = [...host.querySelectorAll(`g[id="n-${id}"] text > tspan`)] as SVGTextContentElement[];
        expect(drawn.length, id).toBe(measured.lines.length);
        expect(drawn.length, id).toBeGreaterThan(1);
        drawn.forEach((tspan, i) => {
          const length = tspan.getComputedTextLength();
          expect(Math.abs(length - measured.lines[i]!.width), `${id} line ${i}: ${tspan.textContent}`).toBeLessThanOrEqual(0.5);
          expect(length, `${id} line ${i}`).toBeLessThanOrEqual(wrap + 0.5);
          lines += 1;
        });
      }
      expect(lines).toBeGreaterThan(4);
    } finally {
      host.remove();
      h.dispose();
    }
  });
});
