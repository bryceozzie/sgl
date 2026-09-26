import { describe, expect, it, vi } from 'vitest';
import type { LabelId } from '@sgl/core';
import { CanvasMeasurer, labelRunKey } from '@sgl/measure';
import { labelBox } from '@sgl/text';
import '../src/fonts.css';
import { RUN_FACES } from '../src/io/run-faces.js';
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

  /**
   * The run faces are declared by the lazy chunk (`io/run-faces.ts`), not the
   * boot CSS. `document.fonts.load()` resolves without error for a face that
   * is not declared, so if measurement ran before the chunk registered them it
   * would silently measure fallback metrics and the per-run cache would keep
   * them. Here every run's measured width must equal the width of the real
   * face, loaded independently from the shipped file under a probe name.
   */
  it('the faces are declared before the gate: each run is measured in its real face, not a fallback', async () => {
    const DOC2 = 'a: "**Wavy Bold**"\nb: "*Wavy Italic*"\nc: "`wavy_code()`"\n';
    const measurer = new CanvasMeasurer();
    const h = await createHarness(DOC2, { measurer, loadRichText: async () => (await import('../src/state/rich-text.js')).richText }, { firstRender: false });
    await vi.waitFor(async () => {
      await h.settle();
      expect(h.pipeline.lastGood.value).not.toBeNull();
    }, { timeout: 10_000, interval: 50 });
    const good = h.pipeline.lastGood.value!;
    const probes: [string, string, string, string][] = [
      ['l:a', 'Wavy Bold', 'normal 700', RUN_FACES.find((f) => f.family === 'Inter' && f.weight === 700 && f.style === 'normal')!.url],
      ['l:b', 'Wavy Italic', 'italic 500', RUN_FACES.find((f) => f.family === 'Inter' && f.weight === 500 && f.style === 'italic')!.url],
      ['l:c', 'wavy_code()', 'normal 400', RUN_FACES.find((f) => f.family === 'IBM Plex Mono' && f.weight === 400)!.url],
    ];
    for (const [labelId, text, face, url] of probes) {
      const [style, weight] = face.split(' ') as ['normal' | 'italic', string];
      const probe = new FontFace(`Probe${labelId.slice(2)}`, `url(${url})`, { style, weight });
      await probe.load();
      document.fonts.add(probe);
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
      ctx.font = `${style} ${weight} 13px Probe${labelId.slice(2)}`;
      const real = ctx.measureText(text).width;
      const measured = h.pipeline.table.value[labelRunKey(good.styled, labelId as LabelId)]!.width;
      expect(Math.abs(measured - real), `${labelId} (${face}): measured ${measured}, real face ${real}`).toBeLessThanOrEqual(0.01);
    }
    h.dispose();
  });

  /**
   * DD-11 §19 item 5, execution plan §2.1 F24 (a human decision, not fixed):
   * the renderer places the first baseline at `0.8 × fontSize`, while the
   * measured `TextLayout` carries Inter's real ascent. This pins the size of
   * the difference, so the finding's numbers stay true until it is decided.
   */
  it('F24: the measured ascent is a whole em in Chromium (Inter 0.97 em, rounded to whole px), the rendered one 0.8 em', async () => {
    const measurer = new CanvasMeasurer();
    const h = await createHarness('a: "Node title"\nb\na -> b: "edge"\ng: { @label: "Group", c }\n', { measurer }, { firstRender: false });
    await vi.waitFor(async () => {
      await h.settle();
      expect(h.pipeline.lastGood.value).not.toBeNull();
    }, { timeout: 10_000, interval: 50 });
    const good = h.pipeline.lastGood.value!;
    const rows: string[] = [];
    for (const [id, size] of [['l:a', 13], ['l:g', 12]] as const) {
      const ascent = h.pipeline.table.value[labelRunKey(good.styled, id as LabelId)]!.ascent;
      rows.push(`${id} ${size}px: measured ${ascent.toFixed(3)} (${(ascent / size).toFixed(4)} em), rendered ${(0.8 * size).toFixed(3)}, difference ${(ascent - 0.8 * size).toFixed(3)} px`);
      expect(ascent / size).toBeGreaterThan(0.95);
      expect(ascent / size).toBeLessThanOrEqual(1.05);
    }
    console.log(`[F24] ${rows.join(' | ')}`);
    h.dispose();
  });
});
