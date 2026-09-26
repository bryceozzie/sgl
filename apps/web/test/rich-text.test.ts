import { effect } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asNodeId, type LabelId } from '@sgl/core';
import { labelRunKey, layoutLines, StaticMetricsMeasurer } from '@sgl/measure';
import { layoutWrapped } from '@sgl/text/wrap';
import type { RichText } from '../src/state/types.js';
import { createHarness } from './harness.js';

/**
 * A18's lazy `rich-text` chunk and its two boot-path gates (DD-11 T53), through
 * the real pipeline (`harness.ts`: real stages, `StaticMetricsMeasurer`, real
 * `grid`). The chunk is `src/state/rich-text.ts`; here it is loaded behind a
 * gate the test releases, as the network would.
 */

function lazyRichText() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failNext = false;
  const loadRichText = vi.fn(async (): Promise<RichText> => {
    if (failNext) {
      failNext = false;
      throw new Error('offline, and not cached');
    }
    await gate;
    return (await import('../src/state/rich-text.js')).richText;
  });
  return {
    loadRichText,
    release,
    failOnce() {
      failNext = true;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Wide enough for its padding (neutral-light: 12 each side), narrow enough to
 *  wrap the label: the wrap width is 120 − 24 = 96. */
const WRAPPED = 'a: { @label: "one two three four five six", @size: { maxWidth: 120 } }\nb\na -> b\n';

describe('the rich-text chunk (DD-11 T53)', () => {
  it('a document with no * or ` in a label and no @size.maxWidth or width never loads it, across edits', async () => {
    const lazy = lazyRichText();
    const h = await createHarness('api: { @label: "Payments API" }\nsnake_case_name\napi -> snake_case_name: "writes to"\n', { loadRichText: lazy.loadRichText });
    h.setSource('api: { @label: "Payments API v2", @size: { minWidth: 40, height: 60 } }\nsnake_case_name\napi -> snake_case_name\n');
    await h.settle();
    expect(lazy.loadRichText).not.toHaveBeenCalled();
    expect(h.pipeline.lastGood.value).not.toBeNull();
    h.dispose();
  });

  it('a label to wrap holds measure and layout until the chunk has loaded, then is measured with layoutWrapped', async () => {
    const lazy = lazyRichText();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText }, { firstRender: false });
    const adopted: (number | undefined)[] = [];
    const stop = effect(() => {
      const good = h.pipeline.lastGood.value;
      if (good !== null) adopted.push(good.layout.nodes[asNodeId('a')]?.frame.w);
    });
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    expect(h.pipeline.lastGood.value).toBeNull();
    // Nothing of this document was measured: the stages below compile hold
    // their boot-time fallback, the empty document.
    expect(h.pipeline.table.value).toEqual({});
    expect(h.pipeline.pipelineError.value).toBeNull();

    lazy.release();
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    expect(h.pipeline.lastGood.value).not.toBeNull();
    const styled = h.pipeline.lastGood.value!.styled;
    const measured = h.pipeline.table.value[labelRunKey(styled, 'l:a' as LabelId)]!;
    expect(measured.lines.length).toBeGreaterThan(1);
    expect(measured.width).toBeLessThanOrEqual(96);
    // Never a picture laid out with the unwrapped label.
    expect(adopted.length, JSON.stringify(adopted)).toBeGreaterThan(0);
    expect(adopted.every((w) => w !== undefined && w <= 120)).toBe(true);
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    stop();
    h.dispose();
  });

  it('the measure-table entry and the laid-out node agree end to end (the T2 seam)', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText }, { firstRender: false });
    await h.settle();
    const good = h.pipeline.lastGood.value!;
    const measured = h.pipeline.table.value[labelRunKey(good.styled, 'l:a' as LabelId)]!;
    const placement = good.layout.labels.find((l) => l.labelId === 'l:a')!;
    const frame = good.layout.nodes[asNodeId('a')]!.frame;
    // The label box the layout placed is the wrapped measurement (quantized
    // to 1/64 px), and the node is that box plus its padding: within maxWidth.
    expect(placement.frame.w).toBeCloseTo(measured.width, 1);
    expect(placement.frame.h).toBeCloseTo(measured.height, 1);
    expect(frame.w).toBeCloseTo(Math.max(72, measured.width + 24), 1);
    expect(frame.w).toBeLessThanOrEqual(120);
    expect(frame.h).toBeCloseTo(Math.max(36, measured.height + 16), 1);
    h.dispose();
  });

  it('hands the measurer layoutWrapped once loaded, and loads once however many edits follow', async () => {
    const lazy = lazyRichText();
    const measurer = new (class extends StaticMetricsMeasurer {
      async ready(): Promise<void> {}
    })();
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText, measurer }, { firstRender: false });
    expect(measurer.lineModel).toBe(layoutLines);
    lazy.release();
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    expect(measurer.lineModel).toBe(layoutWrapped);
    h.setSource(WRAPPED.replace('six', 'six seven'));
    await h.settle();
    h.setSource(WRAPPED.replace('six', 'six seven eight'));
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    expect(h.pipeline.lastGood.value!.styled.graph.labels['l:a' as LabelId]!.runs[0]!.text).toContain('eight');
    h.dispose();
  });

  it('markup in a label holds compile until the chunk has loaded, then compiles with the parser (the markup gate)', async () => {
    const lazy = lazyRichText();
    const h = await createHarness('a: "**Payments** `v2`"\nb: "2 * 3"\na -> b\n', { loadRichText: lazy.loadRichText }, { firstRender: false });
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    expect(h.pipeline.lastGood.value).toBeNull();
    lazy.release();
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    const good = h.pipeline.lastGood.value!;
    expect(good.styled.graph.labels['l:a' as LabelId]!.runs).toEqual([{ text: 'Payments', strong: true }, { text: ' ' }, { text: 'v2', code: true }]);
    expect(good.styled.graph.labels['l:b' as LabelId]!.runs).toEqual([{ text: '2 * 3' }]);
    // Until the render branch, the runs are drawn as plain text, markers removed.
    expect(good.svg).toContain('>Payments v2</tspan>');
    expect(good.svg).not.toContain('**');
    h.dispose();
  });

  it('once loaded, a later document is compiled with the parser without holding again', async () => {
    const lazy = lazyRichText();
    lazy.release();
    const h = await createHarness('a: "*x*"\n', { loadRichText: lazy.loadRichText }, { firstRender: false });
    await lazy.loadRichText.mock.results[0]!.value;
    await h.settle();
    h.setSource('a: "**y**"\n');
    await h.settle();
    expect(h.pipeline.lastGood.value!.styled.graph.labels['l:a' as LabelId]!.runs).toEqual([{ text: 'y', strong: true }]);
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('a failed load is not retried in a loop, but on the next change of the document; meanwhile the stages hold', async () => {
    const lazy = lazyRichText();
    lazy.failOnce();
    lazy.release();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = await createHarness(WRAPPED, { loadRichText: lazy.loadRichText }, { firstRender: false });
    await h.settle();
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(1);
    expect(h.pipeline.lastGood.value).toBeNull();
    expect(h.pipeline.pipelineError.value).toBeNull();

    h.setSource(`${WRAPPED}c\n`);
    await h.settle();
    expect(lazy.loadRichText).toHaveBeenCalledTimes(2);
    expect(h.pipeline.lastGood.value).not.toBeNull();
    h.dispose();
  });
});
